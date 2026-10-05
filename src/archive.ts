// src/archive.ts — yt-dlp --download-archive helpers.
//
// The archive file is yt-dlp's own idempotence layer: one video id per line
// (optionally prefixed by the extractor). When our copy of a file disappears
// we must scrub the id, otherwise yt-dlp will skip the video forever.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Remove a video id from the archive file (the id is the last field of each
 * line) so a lost or moved file can be downloaded again.
 */
export function removeFromArchive(archiveFile: string, videoId: string): void {
  try {
    if (!archiveFile || !existsSync(archiveFile)) return;
    const lines = readFileSync(archiveFile, "utf-8").split("\n");
    const kept = lines.filter((l) => {
      const parts = l.trim().split(/\s+/);
      return parts.length === 0 || parts[parts.length - 1] !== videoId;
    });
    if (kept.length !== lines.length) writeFileSync(archiveFile, kept.join("\n"));
  } catch {
    // Best-effort: a failed scrub is surfaced on the next attempt instead.
  }
}

/** All video ids currently present in the archive file. */
export function readArchiveIds(archiveFile: string): Set<string> {
  const ids = new Set<string>();
  try {
    if (!existsSync(archiveFile)) return ids;
    for (const line of readFileSync(archiveFile, "utf-8").split("\n")) {
      const parts = line.trim().split(/\s+/);
      const id = parts[parts.length - 1];
      if (id) ids.add(id);
    }
  } catch {
    // ignore
  }
  return ids;
}
