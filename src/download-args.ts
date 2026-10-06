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
import { cookiesArgs } from "./tools";
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

export function buildAria2cArgs(config: Config): string {
  const n = Math.max(1, Math.floor(config.connectionsPerDownload));
  const x = Math.min(n, ARIA2C_MAX_CONNECTIONS_PER_SERVER);
  const parts = [`-x ${x}`, `-s ${n}`, `-j ${n}`];
  const split = (config.minSplitSize || "").trim();
  if (split && split !== "1M") parts.push(`--min-split-size ${split}`);
  return parts.join(" ");
}

/**
 * The per-process bandwidth cap in KB/s.
 *
 * yt-dlp's `--limit-rate` is per process, so the configured global cap is
 * divided across the slots that are actually allowed to claim work. Floored at
 * 64 KB/s so a large worker count can never throttle a stream to a trickle.
 * Returns null when no cap is configured.
 */
export function computePerWorkerLimitKBps(config: Config, activeSlots: number): number | null {
  if (config.maxBandwidthKBps <= 0) return null;
  const slots = Math.max(1, Math.floor(activeSlots));
  return Math.max(64, Math.floor(config.maxBandwidthKBps / slots));
}

/** The on-disk base name for a job's files (no extension). */
export function jobBaseFilename(job: Pick<Job, "index" | "title" | "id">): string {
  return `${String(job.index).padStart(3, "0")} - ${sanitizeFileName(job.title)}`;
}

export interface DownloadPlan {
  engine: DownloaderEngine;
  /** Full argv for the yt-dlp process. */
  args: string[];
  /** Duration-aware watchdog for this specific video. */
  timeoutMs: number;
  /** Applied `--limit-rate` value in KB/s, or null when uncapped. */
  perWorkerLimitKBps: number | null;
  /** Output template (`…/base.%(ext)s`) and the base name without extension. */
  baseFilename: string;
  outTemplate: string;
}

export interface BuildDownloadPlanOptions {
  job: Pick<Job, "id" | "url" | "title" | "index" | "output_directory" | "duration">;
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
}

/** Build the complete yt-dlp invocation for one download attempt. */
export function buildDownloadPlan(opts: BuildDownloadPlanOptions): DownloadPlan {
  const { job, config, activeSlots, aria2cAvailable } = opts;

  const engine = resolveDownloaderEngine(config, aria2cAvailable);
  const format = QUALITY_FORMATS[config.videoQuality] || QUALITY_FORMATS["1080p"];
  // Multi-audio: splice the discovered track ids into the quality preset so
  // every wanted language is downloaded (YouTube's "Audio track" menu). The
  // audio-only preset is exempt — an mp3 cannot carry several tracks.
  const audioTracks = config.videoQuality === "audio" ? [] : opts.audioTracks ?? [];
  const effectiveFormat =
    audioTracks.length > 0 ? multiAudioFormatSelector(format, audioTracks) : format;
  const baseFilename = fitBaseFilename(
    job.output_directory,
    jobBaseFilename(job),
    job.id,
  );
  const outTemplate = join(job.output_directory, `${baseFilename}.%(ext)s`);

  const args: string[] = [
    // argv[0] is filled in by the caller (the resolved yt-dlp path).
    job.url,
    ...cookiesArgs(config),
    "--format",
    effectiveFormat,
    // Parallel fragments for DASH/HLS (native path). Ignored when aria2c is
    // handling a whole-file transfer, which splits internally instead.
    "--concurrent-fragments",
    String(Math.max(1, Math.floor(config.concurrentFragments))),
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
    "10",
    "--retry-sleep",
    "5",
    "--fragment-retries",
    String(Math.max(1, Math.floor(config.fragmentRetries))),
    "--extractor-retries",
    "5",
    // --continue is what makes retries cheap: yt-dlp (or aria2c) picks the
    // existing .part file up instead of starting the transfer over.
    "--continue",
    "--no-overwrites",
  ];

  // Real bandwidth cap. yt-dlp translates --limit-rate into the external
  // downloader's own rate limit, so this works for both engines.
  const perWorkerLimitKBps = computePerWorkerLimitKBps(config, activeSlots);
  if (perWorkerLimitKBps) {
    args.push("--limit-rate", `${perWorkerLimitKBps}K`);
  }

  // yt-dlp's own idempotence layer: ids already in the archive file are
  // never re-downloaded, even if a job is re-queued after a DB reset.
  if (config.archiveFile) args.push("--download-archive", config.archiveFile);

  // "Wait for VOD" mode: never grab a stream while it is still live — the
  // job is parked as waiting_live and re-queued by the next full scan.
  if (config.archiveLiveStreams) args.push("--match-filters", "!is_live");

  // Several audio tracks in one file: yt-dlp only keeps more than one audio
  // stream with --audio-multistreams, and MKV is the container that holds any
  // codec/track combination (with per-track language metadata). One selected
  // track merges exactly like a classic download.
  if (audioTracks.length >= 2) {
    args.push("--audio-multistreams");
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
    args.push("--downloader-args", `aria2c:${buildAria2cArgs(config)}`);
  }

  // Native-downloader tuning. Range-based chunking can dramatically improve
  // throughput on the native path, but some CDNs misbehave with Range
  // requests — hence opt-in (empty = yt-dlp's default behaviour).
  const chunk = (config.httpChunkSize || "").trim();
  if (chunk) args.push("--http-chunk-size", chunk);
  const buffer = (config.bufferSize || "").trim();
  if (buffer) args.push("--buffer-size", buffer);

  return {
    engine,
    args,
    timeoutMs: computeDownloadTimeoutMs(job.duration, {
      minMinutes: config.downloadTimeoutMinutes,
      maxMinutes: config.maxDownloadMinutes,
    }),
    perWorkerLimitKBps,
    baseFilename,
    outTemplate,
  };
}
