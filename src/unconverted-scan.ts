// src/unconverted-scan.ts — find local video files that are not tracked yet
// and batch-import them into the processing queue with a chosen target format,
// and re-queue tracked files that finished in some other container.
//
// This backs the dashboard's "Scan Unconverted Videos" action: an operator who
// dropped raw downloads (or files fetched outside the engine) into the output
// root can sweep the folders once, pick the container they want, and have every
// discovered file queued for conversion — the conversion worker claims jobs
// with `download_status = 'downloaded' AND conversion_status = 'pending'`, so
// an imported row needs no download stage at all, just a file_path. The same
// claim contract is what lets the sweep REPAIR an existing archive: a finished
// job whose file is not in the chosen container (e.g. an mkv download when mp4
// was requested — yt-dlp does not promise the container) only needs its
// conversion_status flipped back to 'pending'.

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "./db";
import type { Config } from "./config";
import { hardenName, sanitizeFolderName } from "./util";
import { parseSelectionJson, parseTracksJson, selectAudioTracks } from "./audio-tracks";

/** Containers treated as convertible video sources. Anything else (sidecars,
 * partials, control files, metadata dumps) is not a candidate. */
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts", ".m2ts", ".mts",
  ".flv", ".wmv", ".mpg", ".mpeg", ".mpe", ".3gp", ".3g2", ".ogv", ".vob",
  ".divx", ".m1v", ".m2v", ".rmvb", ".asf", ".dv", ".f4v",
]);

/** Safety rails for the directory walk. */
const MAX_DEPTH = 6;
const MAX_FILES = 5000;
/** Files smaller than this are fragments or placeholders, not media. */
const MIN_FILE_SIZE = 1024;

export interface UnconvertedScanResult {
  /** Absolute root that was scanned. */
  root: string;
  /** Container every imported job is queued to convert to. */
  targetFormat: string;
  /** Every regular file encountered during the walk. */
  filesSeen: number;
  /** Files with a recognised video extension (candidates + tracked). */
  videoFiles: number;
  /** Rows actually inserted (re-runs import nothing new). */
  imported: number;
  /** Tracked, already-finished jobs re-queued because their file is NOT in the target container. */
  requeued: number;
  /** Tracked jobs left alone because they are multi-audio archives (their MKV is retained by design). */
  keptMultiTrack: number;
  /** Video files skipped because the jobs table already tracks their path. */
  alreadyTracked: number;
  /** Video files skipped for being (near-)empty. */
  tooSmall: number;
  /** True when the walk stopped at MAX_FILES. */
  truncated: boolean;
}

/**
 * Stable job id for a local file: `local-` + SHA-1 of the absolute path. The
 * same file always maps to the same id, so re-running the scan is idempotent
 * (INSERT OR IGNORE plus this deterministic key).
 */
export function localFileJobId(absolutePath: string): string {
  return `local-${createHash("sha1").update(resolve(absolutePath)).digest("hex")}`;
}

/** Path comparison key: case-insensitive on Windows (NTFS), exact elsewhere. */
function pathKey(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** Every media/partial/superseded path the jobs table already points at. */
function trackedPaths(): Set<string> {
  const rows = db
    .query("SELECT file_path, partial_file_path, superseded_file FROM jobs")
    .all() as { file_path: string | null; partial_file_path: string | null; superseded_file: string | null }[];
  const tracked = new Set<string>();
  for (const row of rows) {
    for (const p of [row.file_path, row.partial_file_path, row.superseded_file]) {
      if (p) tracked.add(pathKey(p));
    }
  }
  return tracked;
}

/** Containers the tracked-job pass may re-queue: videos plus audio containers. */
const REQUEUEABLE_EXTENSIONS = new Set([
  ...VIDEO_EXTENSIONS,
  ".mp3", ".m4a", ".opus", ".ogg", ".flac", ".wav",
]);

/**
 * How many audio tracks a job's download carries, as far as the cached probe
 * and per-job selection can tell. 1 when nothing is cached — the safe default,
 * since single-track files are the common case.
 */
function effectiveAudioTrackCount(
  row: { audio_tracks: string | null; audio_selection: string | null },
  config: Config,
): number {
  const discovered = parseTracksJson(row.audio_tracks);
  if (!discovered || discovered.length === 0) return 1;
  const selected = selectAudioTracks(
    discovered,
    config.multiAudioMode,
    config.audioTrackLanguages,
    parseSelectionJson(row.audio_selection),
  );
  return Math.max(1, selected.length);
}

/**
 * Re-queue finished jobs whose recorded media is NOT in the requested target
 * container.
 *
 * This is the repair path for an archive that predates the download worker's
 * container check: yt-dlp does not promise the requested container (VP9/Opus
 * presets merge into webm/mkv, and --embed-thumbnail turns a .webm into .mkv),
 * and jobs whose target was mp4 were historically marked `not_needed`, so
 * those files never went through the conversion stage. The sweep flips such a
 * job's conversion_status back to 'pending' — the converter then remuxes the
 * file exactly as it would for a fresh download (video copied, audio to AAC
 * for mp4) — and is idempotent: once converted, the file's container matches
 * and the next sweep skips it.
 *
 * Multi-audio archives are left alone: keeping their MKV when the target is
 * mp4 is the documented behavior (AGENTS.md, multi-audio), matching the
 * download worker's exemption. Scope is the scanned root only — a file the
 * relocation pass already moved into secondary storage is outside it, and
 * re-converting would drag it back into the output tree.
 */
function requeueWrongContainerJobs(
  config: Config,
  targetFormat: string,
  root: string,
  result: UnconvertedScanResult,
): void {
  const rows = db
    .query(
      `SELECT id, file_path, audio_tracks, audio_selection FROM jobs
       WHERE download_status = 'downloaded' AND conversion_status IN ('done', 'not_needed')`,
    )
    .all() as { id: string; file_path: string | null; audio_tracks: string | null; audio_selection: string | null }[];
  for (const row of rows) {
    if (!row.file_path) continue;
    const key = pathKey(row.file_path);
    if (key !== root && !key.startsWith(root + sep)) continue;
    const ext = extname(key).toLowerCase();
    if (!REQUEUEABLE_EXTENSIONS.has(ext)) continue;
    if (ext.replace(/^\./, "") === targetFormat) continue;
    if (!existsSync(row.file_path)) continue; // missing-file sweep owns that repair
    if (effectiveAudioTrackCount(row, config) >= 2) {
      result.keptMultiTrack++;
      continue;
    }
    // The IN-guard keeps a job that flipped to a claimable/failed state since
    // the SELECT from being clobbered mid-sweep.
    const changes = db
      .run(
        `UPDATE jobs SET conversion_status = 'pending', conversion_retry_count = 0,
           last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND conversion_status IN ('done', 'not_needed')`,
        [row.id],
      )
      .changes;
    if (changes === 1) result.requeued++;
  }
}

async function walk(root: string, depth: number, out: string[]): Promise<boolean> {
  if (depth > MAX_DEPTH) return false;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false; // unreadable directory — skip it, keep scanning the rest
  }
  let truncated = false;
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return true;
    const full = join(root, entry.name);
    if (entry.name.startsWith(".")) continue; // hidden files/dirs
    if (entry.isDirectory()) {
      // `.ytdl` directories are yt-dlp fragment state, never a source file.
      if (entry.name.endsWith(".ytdl")) continue;
      if (await walk(full, depth + 1, out)) truncated = true;
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return truncated;
}

/**
 * Scan `rootDir` (default: the configured output root) for video files that
 * are not tracked in the jobs table and insert one conversion-queued job per
 * file, with `targetFormat` pre-selected. Tracked jobs whose finished media is
 * NOT in `targetFormat` are re-queued for conversion as well (their conversion
 * stage re-opens; nothing is re-downloaded).
 *
 * The work is purely local (disk walk + INSERTs) — no network — so it is safe
 * to run while offline mode is on; the conversions themselves are ffmpeg remuxes
 * that also need no network.
 */
export async function scanUnconvertedVideos(
  config: Config,
  targetFormat: string,
  rootDir?: string,
): Promise<UnconvertedScanResult> {
  const root = resolve(rootDir ?? config.outputRoot);
  const tracked = trackedPaths();
  const files: string[] = [];
  const truncated = await walk(root, 0, files);

  const result: UnconvertedScanResult = {
    root,
    targetFormat,
    filesSeen: files.length,
    videoFiles: 0,
    imported: 0,
    requeued: 0,
    keptMultiTrack: 0,
    alreadyTracked: 0,
    tooSmall: 0,
    truncated,
  };

  // Pass 1: tracked jobs already finished in the wrong container get their
  // conversion stage re-opened (see requeueWrongContainerJobs — this is how an
  // archive of mkv/webm downloads requested as mp4 gets repaired in place).
  requeueWrongContainerJobs(config, targetFormat, root, result);

  interface Candidate {
    id: string;
    url: string;
    title: string;
    outputDirectory: string;
    folder: string;
    filePath: string;
    fileSize: number;
  }
  const candidates: Candidate[] = [];

  for (const file of files) {
    if (!VIDEO_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    result.videoFiles++;
    if (tracked.has(pathKey(file))) {
      result.alreadyTracked++;
      continue;
    }
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      continue; // vanished between the walk and the stat
    }
    if (size < MIN_FILE_SIZE) {
      result.tooSmall++;
      continue;
    }
    const outputDirectory = dirname(file);
    // Group label: the first folder below the scanned root ("Unconverted" when
    // the file sits directly in the root).
    const rel = relative(root, outputDirectory);
    const firstSegment = rel && rel !== "." ? rel.split(sep)[0] : "";
    candidates.push({
      id: localFileJobId(file),
      url: pathToFileURL(file).href,
      title: hardenName(basename(file, extname(file))) || "Untitled video",
      outputDirectory,
      folder: sanitizeFolderName(firstSegment || "Unconverted"),
      filePath: file,
      fileSize: size,
    });
  }

  if (candidates.length === 0) return result;

  const insert = db.transaction((batch: Candidate[]) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO jobs
         (id, url, title, output_directory, target_format, want_subtitles, want_thumbnail,
          want_description, folder, file_path, file_size, progress, speed, eta,
          download_status, conversion_status, metadata_status)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 100, 0, 0, 'downloaded', 'pending', 'not_needed')`,
    );
    for (const c of batch) {
      // INSERT OR IGNORE: a concurrent scan or a re-run after a partial batch
      // must never duplicate a file.
      result.imported += stmt.run(
        c.id,
        c.url,
        c.title,
        c.outputDirectory,
        targetFormat,
        c.folder,
        c.filePath,
        c.fileSize,
      ).changes;
    }
  });
  insert(candidates);

  return result;
}
