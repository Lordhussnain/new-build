// src/download-args.ts — yt-dlp command construction (pure, unit-tested).
//
// Everything the download worker needs to know about HOW to fetch a video is
// decided here: which downloader engine (aria2c multi-connection vs yt-dlp's
// native downloader), how many connections/fragments to use, how the bandwidth
// cap is split across active slots, and the watchdog timeout for this video.
//
// yt-dlp reference behaviour this encodes (verified against yt-dlp source):
//   • `--downloader aria2c` makes yt-dlp hand the transfer to aria2c with
//     `-x16 -s16 -j16 --min-split-size 1M` by default; extra args arrive as a
//     single `--downloader-args aria2c:…` argv element (yt-dlp shlex-splits
//     the text after `aria2c:` — see the quoting note at the call site).
//   • yt-dlp maps `--limit-rate` to aria2c's `--max-overall-download-limit`,
//     so the global bandwidth cap keeps working on both engines.
//   • aria2c only speaks http/https/ftp — for HLS/live streams yt-dlp silently
//     falls back to its native downloader, so no special-casing is needed.
//   • External downloads still land in yt-dlp's `<name>.part` temp file, so
//     partial-file tracking and `--continue` resume behave identically.

import { join } from "node:path";
import { cookiesArgs, jsRuntimeArgs, type JsRuntime } from "./tools";
import { DOWNLOAD_PATH_PREFIX } from "./download-output";
import { fitBaseFilename, sanitizeFileName } from "./util";
import { computeDownloadTimeoutMs } from "./retry";
import { QUALITY_FORMATS, type Config } from "./config";
import { multiAudioFormatSelector, type AudioTrack } from "./audio-tracks";
import type { Job } from "./db";

export type DownloaderEngine = "aria2c" | "native";

/** Which engine a download should use, given availability and config. */
export function resolveDownloaderEngine(config: Config, aria2cAvailable: boolean): DownloaderEngine {
  return config.useAria2c && aria2cAvailable ? "aria2c" : "native";
}

/** Resolve a job's nullable quality override against the live global setting. */
export function effectiveVideoQuality(job: { video_quality?: string | null }, config: Config): string {
  const override = job.video_quality;
  return override && Object.hasOwn(QUALITY_FORMATS, override) ? override : config.videoQuality;
}

/** Resolve the requested output container, including the audio-only default. */
export function effectiveTargetFormat(
  job: { target_format?: string | null; video_quality?: string | null },
  config: Config,
): string {
  const quality = effectiveVideoQuality(job, config);
  const stored = typeof job.target_format === "string" ? job.target_format.trim().toLowerCase() : "";
  return stored || (quality === "audio" ? "mp3" : (config.targetFormat || "mp4").toLowerCase());
}

/**
 * The value for yt-dlp's `--downloader-args aria2c:…` — one argv element,
 * without inner quotes (see the call site in `buildDownloadPlan` for why).
 *
 * yt-dlp already defaults aria2c to `-x16 -s16 -j16 --min-split-size 1M`, so we
 * only emit what differs from that baseline — fewer moving parts, and an
 * explicit `-k` only when the operator changed the split threshold.
 *
 * aria2c hard-caps `--max-connection-per-server` (`-x`) at **16** — its own
 * help says "Possible Values: 1-16" — and answers anything else with exit 28
 * ("bad/unrecognized option") *before transferring a byte*, printing that
 * help block. Passing an unclamped config value therefore fails every single
 * download in the batch identically, so `-x` is clamped here while `-s`/`-j`
 * (no such cap) keep the configured value: a higher setting still splits the
 * file finer, it just cannot open a 17th connection to one server.
 */
export const ARIA2C_MAX_CONNECTIONS_PER_SERVER = 16;
export const ARIA2C_MIN_SPLIT_SIZE_BYTES = 1048576; // 1M (aria2c rejects anything lower with exit 28)

export function parseAria2cSplitSizeBytes(sizeStr: string): number | null {
  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*([KkMmGg]?)[Bb]?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = match[2].toUpperCase();
  if (unit === "K") return Math.floor(num * 1024);
  if (unit === "M") return Math.floor(num * 1024 * 1024);
  if (unit === "G") return Math.floor(num * 1024 * 1024 * 1024);
  return Math.floor(num);
}

/**
 * Engine-wide budget of parallel connections (aria2c) and fragment requests
 * (native), shared by every active download slot. Each download's own setting
 * is the ceiling for that download; the budget lowers it as slots are added so
 * that N slots never open N × 32 connections at once. At up to 4 slots the
 * Aggressive profile (32 connections, 64 fragments) runs unchanged; past that
 * each download gets its share. These are judgement values, not a YouTube
 * limit: raise them if throughput per slot is too low, lower them if the
 * transfers start failing as the slot count grows.
 */
export const CONNECTION_BUDGET = 128;
export const FRAGMENT_BUDGET = 256;
/** Floor for a per-download share, so a large pool never degenerates to 1. */
export const MIN_TRANSFERS_PER_DOWNLOAD = 4;

/**
 * The transfer count one download may use while `activeSlots` slots run: the
 * configured value, reduced to its share of `budget` but never below the floor
 * and never above the configured value.
 */
export function perDownloadTransfers(configured: number, activeSlots: number, budget: number): number {
  const wanted = Math.max(1, Math.floor(configured));
  const slots = Math.max(1, Math.floor(activeSlots));
  const share = Math.floor(budget / slots);
  return Math.max(1, Math.min(wanted, Math.max(MIN_TRANSFERS_PER_DOWNLOAD, share)));
}

export function buildAria2cArgs(config: Config, activeSlots = 1): string {
  const n = perDownloadTransfers(config.connectionsPerDownload, activeSlots, CONNECTION_BUDGET);
  const x = Math.min(n, ARIA2C_MAX_CONNECTIONS_PER_SERVER);
  const parts = [`-x ${x}`, `-s ${n}`, `-j ${n}`];
  const split = (config.minSplitSize || "").trim();
  const bytes = split ? parseAria2cSplitSizeBytes(split) : null;
  if (split && bytes === null) {
    // Not a size at all ("banana", "5X", "1 MB"): hand the value to aria2c
    // verbatim instead of dropping it. aria2c validates every option before it
    // transfers a byte and answers an unusable `--min-split-size` with exit 28
    // plus the option's help block, which the worker turns into the actionable
    // BAD_DOWNLOADER_ARGS pause — the whole batch stops once, with the reason,
    // instead of looking like a healthy run that quietly ignores the setting.
    // Dropping it here would be a silent coercion: the operator asked for a
    // different split threshold and would never learn their typo was ignored
    // (the same rule the offline switch follows — an unparsable value is
    // surfaced, never guessed at).
    parts.push(`--min-split-size ${split}`);
  } else if (bytes !== null && bytes > ARIA2C_MIN_SPLIT_SIZE_BYTES) {
    // A well-formed size above aria2c's 1M floor: yt-dlp's own default is 1M,
    // so this is the only case that changes anything.
    parts.push(`--min-split-size ${split}`);
  }
  // A well-formed size at or below the floor is deliberately omitted: yt-dlp's
  // default (1M) is the closest satisfiable value and there is no typo to
  // surface, so pausing the run over "512K" would be hostile.
  return parts.join(" ");
}

/**
 * The per-process bandwidth cap in bytes per second.
 *
 * yt-dlp's `--limit-rate` is per process, so the configured cap in KB/s is
 * divided across the currently active download slots and converted to an
 * integer byte rate. Do not impose a per-worker minimum: that silently exceeds
 * small configured caps (e.g. 10 KB/s split across 20 workers must not become
 * 64 KB/s per worker). Returns null when no cap is configured.
 */
export function computePerWorkerLimitBytesPerSec(config: Config, activeSlots: number): number | null {
  if (config.maxBandwidthKBps <= 0) return null;
  const slots = Math.max(1, Math.floor(activeSlots));
  return Math.max(1, Math.floor((config.maxBandwidthKBps * 1024) / slots));
}

/** The on-disk base name for a job's files (no extension). */
export function jobBaseFilename(job: Pick<Job, "index" | "title" | "id">): string {
  return `${String(job.index).padStart(3, "0")} - ${sanitizeFileName(job.title)}`;
}

/**
 * The base name a download ACTUALLY writes: `jobBaseFilename` fitted to the
 * output directory's path budget (see `fitBaseFilename`).
 *
 * Every lookup that hunts for one of a job's files on disk — the partial-path
 * freeze in reconcile.ts, the worker's fallback scans, the recovery sweeps —
 * must use this, not the raw `jobBaseFilename`: for a long title (or a deep
 * output directory) the two differ, and a lookup with the unfitted name
 * silently finds nothing. That mismatch is how a long-titled video's recorded
 * `.part` kept its `partial_file_path` empty and its resume state was later
 * swept as an orphan.
 */
export function jobFittedBaseFilename(
  job: Pick<Job, "id" | "index" | "title" | "output_directory">,
): string {
  return fitBaseFilename(job.output_directory, jobBaseFilename(job), job.id);
}

export interface DownloadPlan {
  engine: DownloaderEngine;
  /** Full argv for the yt-dlp process. */
  args: string[];
  /** Duration-aware watchdog for this specific video. */
  timeoutMs: number;
  /** Applied `--limit-rate` value in bytes/second, or null when uncapped. */
  perWorkerLimitBytesPerSec: number | null;
  /** Connections per download actually requested (aria2c) — after the budget. */
  connectionsPerDownload: number;
  /** Parallel fragments actually requested (native) — after the budget. */
  concurrentFragments: number;
  /** Output template (`…/base.%(ext)s`) and the base name without extension. */
  baseFilename: string;
  outTemplate: string;
}

export interface BuildDownloadPlanOptions {
  job: Pick<Job, "id" | "url" | "title" | "index" | "output_directory" | "duration"> &
    Partial<Pick<Job, "target_format" | "video_quality">>;
  config: Config;
  /** Slots currently allowed to claim work (drives the bandwidth split). */
  activeSlots: number;
  /** Whether aria2c was found on this machine. */
  aria2cAvailable: boolean;
  /**
   * The resolved aria2c executable, when discovery found one. Passed to yt-dlp
   * as `--downloader <path>` rather than the bare name `aria2c`: discovery
   * searches the app folder, the compiled exe's folder and the
   * winget/scoop/chocolatey shim dirs, none of which are guaranteed to be on
   * the child process's PATH — and on Windows a bare name yt-dlp cannot resolve
   * fails the download with "aria2c not found" even though the engine just
   * probed the binary successfully.
   */
  aria2cBinary?: string | null;
  /**
   * Audio tracks selected for this job (multi-audio support). Empty/absent =
   * classic single-track download. Two or more tracks are muxed into one MKV
   * with `--audio-multistreams` so the audio is switchable in any player.
   */
  audioTracks?: AudioTrack[];
  /**
   * JS runtime for YouTube's n-challenge. Production passes whatever
   * `checkDependencies` found; omit/null to skip the flags (unit tests).
   */
  jsRuntime?: JsRuntime | null;
}

/** Build the complete yt-dlp invocation for one download attempt. */
export function buildDownloadPlan(opts: BuildDownloadPlanOptions): DownloadPlan {
  const { job, config, activeSlots, aria2cAvailable } = opts;

  const engine = resolveDownloaderEngine(config, aria2cAvailable);
  const videoQuality = effectiveVideoQuality(job, config);
  const targetFormat = effectiveTargetFormat(job, config);
  const format = QUALITY_FORMATS[videoQuality] || QUALITY_FORMATS["1080p"];
  // Multi-audio: splice the discovered track ids into the quality preset so
  // every wanted language is downloaded (YouTube's "Audio track" menu). The
  // audio-only preset is exempt — an mp3 cannot carry several tracks.
  const audioTracks = videoQuality === "audio" ? [] : opts.audioTracks ?? [];
  const effectiveFormat =
    audioTracks.length > 0 ? multiAudioFormatSelector(format, audioTracks) : format;
  const baseFilename = jobFittedBaseFilename(job);
  const outTemplate = join(job.output_directory, `${baseFilename}.%(ext)s`);
  const fragments = perDownloadTransfers(config.concurrentFragments, activeSlots, FRAGMENT_BUDGET);
  const connections = perDownloadTransfers(config.connectionsPerDownload, activeSlots, CONNECTION_BUDGET);

  const args: string[] = [
    // argv[0] is filled in by the caller (the resolved yt-dlp path).
    job.url,
    ...cookiesArgs(config),
    ...jsRuntimeArgs(opts.jsRuntime ?? null),
    "--format",
    effectiveFormat,
    // Parallel fragments for DASH/HLS (native path). Ignored when aria2c is
    // handling a whole-file transfer, which splits internally instead.
    "--concurrent-fragments",
    String(fragments),
    "-o",
    outTemplate,
    // --newline/--no-colors keep progress lines parseable from a pipe.
    "--progress",
    "--newline",
    "--no-colors",
    "--progress-template",
    "download:PROGRESS:%(progress.percent).1f|%(progress.speed)f|%(progress.eta)f|%(progress.total_bytes)s|%(progress.downloaded_bytes)s",
    // Mark the final path explicitly: other stdout (including aria2c progress)
    // must never be probed as a filesystem path.
    // --print implies --simulate, so --no-simulate is required to actually write files.
    "--print",
    `after_move:${DOWNLOAD_PATH_PREFIX}%(filepath)s`,
    "--no-simulate",
    "--socket-timeout",
    "15",
    "--retries",
    String(Math.max(10, Math.floor(config.maxRetryAttempts * 3))),
    "--retry-sleep",
    "5",
    "--fragment-retries",
    String(Math.max(10, Math.floor(config.fragmentRetries))),
    "--extractor-retries",
    "5",
    // --continue is what makes retries cheap: yt-dlp (or aria2c) picks the
    // existing .part file up instead of starting the transfer over.
    "--continue",
    "--no-overwrites",
  ];

  // Real bandwidth cap. yt-dlp translates --limit-rate into the external
  // downloader's own rate limit, so this works for both engines.
  const perWorkerLimitBytesPerSec = computePerWorkerLimitBytesPerSec(config, activeSlots);
  if (perWorkerLimitBytesPerSec !== null) {
    // A bare yt-dlp RATE is bytes/second. Use an integer so both yt-dlp and its
    // aria2c rate-limit bridge get a precise sub-KB share without suffix rounding.
    args.push("--limit-rate", String(perWorkerLimitBytesPerSec));
  }

  // yt-dlp's own idempotence layer: ids already in the archive file are
  // never re-downloaded, even if a job is re-queued after a DB reset.
  if (config.archiveFile) args.push("--download-archive", config.archiveFile);

  // "Wait for VOD" mode: never grab a stream while it is still live — the
  // job is parked as waiting_live and re-queued by the next full scan.
  if (config.archiveLiveStreams) args.push("--match-filters", "!is_live");

  // Several audio tracks in one file: yt-dlp only keeps more than one audio
  // stream with --audio-multistreams, and MKV is the safe container for every
  // codec/track combination. A single-track MKV override can also be muxed
  // directly; MP4/MP3 are left to the conversion stage so yt-dlp cannot fail
  // on a source codec that the requested container does not support.
  if (audioTracks.length >= 2) args.push("--audio-multistreams");
  if (audioTracks.length >= 2 || targetFormat === "mkv") {
    args.push("--merge-output-format", "mkv");
  }

  // Sidecar files (subs/thumbnail/description/info.json) are fetched by the
  // metadata worker once the download completes; the download phase only
  // enriches the container itself (embedded art/metadata/chapters).
  if (config.embedMetadata) args.push("--embed-thumbnail", "--embed-metadata", "--embed-chapters");

  // Multi-connection downloader. HLS/live streams fall back to the native
  // downloader inside yt-dlp automatically.
  if (engine === "aria2c") {
    // Absolute path when we have one (see aria2cBinary) — never rely on the
    // child's PATH to re-discover a binary we already found.
    args.push("--downloader", opts.aria2cBinary || "aria2c");
    // One argv element, NO inner quotes. The value reaches yt-dlp without a
    // shell, so inner `"` would arrive literally; on Windows the re-quoted
    // command line then makes yt-dlp's shlex treat the whole list as ONE
    // token (`-x` gets `1 -s 1 …` as its value) and aria2c answers with
    // "Bad number" + exit 28 before transferring a byte — the
    // BAD_DOWNLOADER_ARGS pause. Unquoted, the post-`aria2c:` shlex split
    // yields the right argv on Windows and POSIX alike.
    args.push("--downloader-args", `aria2c:${buildAria2cArgs(config, activeSlots)}`);
  }

  // Native-downloader tuning. Range-based chunking can dramatically improve
  // throughput on the native path, but some CDNs misbehave with Range
  // requests — hence opt-in (empty = yt-dlp's default behaviour).
  const chunk = (config.httpChunkSize || "").trim();
  if (chunk) args.push("--http-chunk-size", chunk);
  const buffer = (config.bufferSize || "").trim();
  if (buffer) args.push("--buffer-size", buffer);

  // Optional request identity override. It is an argv value, never interpolated
  // through a shell; the default profile leaves yt-dlp's own User-Agent intact.
  const userAgent = (config.userAgent || "").trim();
  if (userAgent) args.push("--user-agent", userAgent);

  return {
    engine,
    args,
    timeoutMs: computeDownloadTimeoutMs(job.duration, {
      minMinutes: config.downloadTimeoutMinutes,
      maxMinutes: config.maxDownloadMinutes,
    }),
    perWorkerLimitBytesPerSec,
    connectionsPerDownload: connections,
    concurrentFragments: fragments,
    baseFilename,
    outTemplate,
  };
}
