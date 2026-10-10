// src/unconverted-scan.ts — find local video files that are not tracked yet
// and batch-import them into the processing queue with a chosen target format.
//
// This backs the dashboard's "Scan Unconverted Videos" action: an operator who
// dropped raw downloads (or files fetched outside the engine) into the output
// root can sweep the folders once, pick the container they want, and have every
// discovered file queued for conversion — the conversion worker claims jobs
// with `download_status = 'downloaded' AND conversion_status = 'pending'`, so
// an imported row needs no download stage at all, just a file_path.

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "./db";
import type { Config } from "./config";
import { hardenName, sanitizeFolderName } from "./util";

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
 * file, with `targetFormat` pre-selected.
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
    alreadyTracked: 0,
    tooSmall: 0,
    truncated,
  };

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
