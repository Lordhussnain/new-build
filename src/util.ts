// src/util.ts — pure formatting / filename / hashing helpers.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

// Media container/codec extensions the engine can produce or move around.
export const MEDIA_EXTENSIONS = new Set([
  "mp4", "mkv", "webm", "mov", "flv", "avi", "ts", "m4v",
  "mp3", "m4a", "opus", "ogg", "flac", "wav", "aac", "ac3", "eac3", "3gp", "amr",
]);

// Sidecar suffixes that belong next to a media file and must travel with it.
export const SIDECAR_SUFFIXES = [
  ".vtt", ".srt", ".ass", ".lrc", ".ttml", ".srv1", ".srv2", ".srv3",
  ".description", ".info.json", ".jpg", ".jpeg", ".png", ".webp", ".gif",
];

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatBytesPerSec(bps: number): string {
  if (!bps || bps <= 0) return "0 B/s";
  return formatBytes(bps) + "/s";
}

/** Parse a yt-dlp speed string ("1.5MiB", "512KiB", "NA") into bytes/second. */
export function parseSpeedToBytesPerSec(speedStr: string): number {
  if (!speedStr || speedStr.trim() === "" || speedStr.toLowerCase() === "na") return 0;
  const match = speedStr.match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase().replace("ib", "b");
  const multipliers: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return val * (multipliers[unit] || 1);
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Windows forbids these device names anywhere in a path (CON, NUL, COM1…).
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

// Strip characters Windows rejects, trailing dots/spaces (invisible in
// Explorer but illegal on NTFS), and guard reserved device names.
export function hardenName(name: string): string {
  let n = name.replace(/[\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
  n = n.replace(/[. ]+$/g, "");
  if (!n) return "";
  const stem = n.split(".")[0];
  if (WINDOWS_RESERVED.test(stem)) n = `_${n}`;
  return n;
}

export function sanitizeFolderName(name: string): string {
  return hardenName(name.replace(/[\/:*?"<>|]/g, " ").trim()) || "playlist";
}

export function sanitizeFileName(name: string): string {
  return hardenName(name.replace(/[\\/:*?"<>|]/g, " ").trim()) || "video";
}

// Keep generated filenames well under Windows' MAX_PATH (260) once the
// directory and sidecar suffixes (.en.vtt, .info.json …) are added. Long
// titles are truncated and made unique with the video id.
export function fitBaseFilename(dir: string, base: string, uniqueId: string): string {
  const SIDE_MARGIN = 20; // ".%(ext)s" + language/extension suffixes + slack
  const budget = 238 - dir.length - SIDE_MARGIN;
  if (base.length <= budget) return base;
  const idPart = ` [${uniqueId}]`;
  const keep = Math.max(8, budget - idPart.length);
  return base.slice(0, keep).trimEnd() + idPart;
}

/** Streaming SHA-256 of a file (used for post-download integrity records). */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Is `childPath` inside `rootPath` (or the same path)?
 *
 * Both sides are resolved first, so `D:/NAS/file.mp4` and `D:\NAS\file.mp4`
 * compare equal, and the case-insensitive comparison Windows needs is applied
 * there too (NTFS may hand back either spelling for one file). Used by the
 * relocation pass to recognise a file that already lives in secondary storage
 * rather than moving it onto itself.
 *
 * `relative` — not a string prefix — is what makes this correct for siblings
 * that merely share a prefix: `/data/downloads2/x.mp4` is NOT inside
 * `/data/downloads`.
 */
export function isPathInside(childPath: string, rootPath: string): boolean {
  if (!childPath || !rootPath) return false;
  const normalize = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const child = normalize(childPath);
  const root = normalize(rootPath);
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Fallback used when yt-dlp's `--print after_move:filepath` output was not
 * captured: locate the media file we expect from the output template (the
 * newest matching file with a known media extension).
 */
export async function findDownloadedFile(dir: string, baseFilename: string): Promise<string> {
  try {
    const files = await readdir(dir);
    const matches: { path: string; mtime: number }[] = [];
    for (const f of files) {
      if (!f.startsWith(baseFilename + ".")) continue;
      const ext = f.split(".").pop()?.toLowerCase() || "";
      if (!MEDIA_EXTENSIONS.has(ext)) continue;
      const s = await stat(join(dir, f)).catch(() => null);
      if (s?.isFile()) matches.push({ path: join(dir, f), mtime: s.mtimeMs });
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0]?.path || "";
  } catch {
    return "";
  }
}
