// src/archive.ts — yt-dlp --download-archive helpers.
//
// The archive file is yt-dlp's own idempotence layer: one video id per line
// (optionally prefixed by the extractor). When our copy of a file disappears
// we must scrub the id, otherwise yt-dlp will skip the video forever.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { NativeCoreError, nativeCore, nativeValue } from "./native-core";

function invalidNativeArchiveResult(detail: string): never {
  throw new NativeCoreError(
    `Rust native core returned an invalid archive result (${detail})`,
    "NATIVE_INVALID_RESPONSE",
  );
}

function parseArchiveIdsTextTypeScript(text: string): string[] {
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const id = parts[parts.length - 1];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Unique archive ids in first-appearance order; file decoding stays in Bun. */
export function parseArchiveIdsText(text: string): string[] {
  if (nativeCore && text.isWellFormed()) {
    const ids = nativeValue<string[]>(nativeCore.parseArchiveIds(text));
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return invalidNativeArchiveResult("expected a string id array");
    }
    return ids;
  }
  return parseArchiveIdsTextTypeScript(text);
}

export interface ArchiveRemoval {
  text: string;
  /** True exactly when at least one LF-delimited record was removed. */
  changed: boolean;
}

function removeArchiveIdTextTypeScript(text: string, videoId: string): ArchiveRemoval {
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    const parts = line.trim().split(/\s+/);
    return parts.length === 0 || parts[parts.length - 1] !== videoId;
  });
  const changed = kept.length !== lines.length;
  return { text: changed ? kept.join("\n") : text, changed };
}

/** Pure archive filtering with the legacy newline/whitespace semantics. */
export function removeArchiveIdText(text: string, videoId: string): ArchiveRemoval {
  if (nativeCore && text.isWellFormed() && videoId.isWellFormed()) {
    const result = nativeValue<ArchiveRemoval>(nativeCore.removeArchiveId(text, videoId));
    if (!result || typeof result !== "object" || typeof result.text !== "string" ||
      typeof result.changed !== "boolean") {
      return invalidNativeArchiveResult("malformed removal result");
    }
    return result;
  }
  return removeArchiveIdTextTypeScript(text, videoId);
}

/**
 * Remove a video id from the archive file (the id is the last field of each
 * line) so a lost or moved file can be downloaded again. Returns false if the
 * archive cannot be read or rewritten, allowing explicit re-queue routes to
 * leave their ignore tombstone in place.
 */
export function removeFromArchive(archiveFile: string, videoId: string): boolean {
  let text: string;
  try {
    if (!archiveFile || !existsSync(archiveFile)) return true;
    text = readFileSync(archiveFile, "utf-8");
  } catch {
    // Callers that promise an explicit re-queue can leave the ignore in place.
    return false;
  }
  // Keep native failures outside the filesystem compatibility catch: an
  // operational bridge failure must not be mistaken for a missing archive.
  const result = removeArchiveIdText(text, videoId);
  if (result.changed) {
    try {
      writeFileSync(archiveFile, result.text);
    } catch {
      return false;
    }
  }
  return true;
}

interface ArchiveReadResult {
  /** False only for the legacy missing/unreadable-file compatibility path. */
  ok: boolean;
  ids: Set<string>;
}

function readArchiveIdsFresh(archiveFile: string): ArchiveReadResult {
  let text: string;
  try {
    if (!existsSync(archiveFile)) return { ok: true, ids: new Set<string>() };
    text = readFileSync(archiveFile, "utf-8");
  } catch {
    return { ok: false, ids: new Set<string>() };
  }
  return { ok: true, ids: new Set(parseArchiveIdsText(text)) };
}

/** All video ids currently present in the archive file. */
export function readArchiveIds(archiveFile: string): Set<string> {
  return readArchiveIdsFresh(archiveFile).ids;
}

function archiveFileVersion(archiveFile: string): string | null {
  try {
    const stats = statSync(archiveFile, { bigint: true });
    return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.mode].join(":");
  } catch {
    return null;
  }
}

export interface ArchiveIdCache {
  /** A stable snapshot while the file version is unchanged; never a mutable global Set. */
  readIds(): ReadonlySet<string>;
  invalidate(): void;
}

/**
 * Scan-scoped archive cache. A metadata check is deliberately retained on every
 * read: yt-dlp workers append asynchronously and recovery routes can scrub IDs,
 * so blindly caching for a whole scan could requeue or suppress the wrong job.
 */
export function createArchiveIdCache(archiveFile: string): ArchiveIdCache {
  let cachedVersion: string | null = null;
  let cachedIds: Set<string> | null = null;
  const invalidate = () => {
    cachedVersion = null;
    cachedIds = null;
  };
  return {
    readIds() {
      const before = archiveFileVersion(archiveFile);
      if (before !== null && cachedIds !== null && before === cachedVersion) {
        return cachedIds;
      }
      invalidate();
      const result = readArchiveIdsFresh(archiveFile);
      if (!result.ok) return result.ids;
      // Do not cache a file that changed between stat/read/stat. The returned
      // IDs are still the same fresh read the legacy path would have used.
      const after = archiveFileVersion(archiveFile);
      if (before !== null && after === before) {
        cachedVersion = before;
        cachedIds = result.ids;
      }
      return result.ids;
    },
    invalidate,
  };
}

/**
 * Re-append a video id to the archive file, undoing a `removeFromArchive` that
 * ran before a step outside SQLite failed (a rename, say) — the archive is a
 * plain-text file no transaction can roll back, and a scrubbed id would stop
 * the archive-fallback dedupe from suppressing the video after a source
 * cleanup deletes its job row. A duplicate line is harmless (readers use a
 * Set). Returns false when the file cannot be written.
 */
export function appendToArchive(archiveFile: string, videoId: string): boolean {
  try {
    if (!archiveFile) return false;
    const existing = existsSync(archiveFile) ? readFileSync(archiveFile, "utf-8") : "";
    const needsNewline = existing.length > 0 && !existing.endsWith("\n");
    writeFileSync(archiveFile, `${existing}${needsNewline ? "\n" : ""}youtube ${videoId}\n`);
    return true;
  } catch {
    return false;
  }
}
