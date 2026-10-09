// src/scanner.ts — playlist/channel scanning and job ingestion.
//
// Two sources feed the same ingest path: the full yt-dlp flat-playlist scan
// (slow, authoritative) and the cheap per-channel RSS poller (fast, recent
// uploads only). Both dedupe on the YouTube video id, so the same video found
// by a playlist, a channel, and a watch URL is only ever queued once.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readArchiveIds } from "./archive";
import { db, getNextIndex, isVideoIgnored, isVideoInDb } from "./db";
import { isSourceBlocked, sourceIdentity } from "./sources";
import { cookiesArgs, jsRuntimeArgs, ytDlp } from "./tools";
import { sanitizeFolderName } from "./util";
import { getConfig, stats } from "./state";
import type { Config } from "./config";

export interface ListingItem {
  id: string;
  title: string;
  playlist: string;
  duration: number;
}

/**
 * Canonical form of a video URL: strip tracking/timestamp junk and fold
 * youtu.be short links into watch URLs, so the same video always produces the
 * same stored job URL regardless of how it was discovered.
 */
export function normalizeVideoUrl(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed) return trimmed;
  try {
    const u = new URL(trimmed);
    const shortMatch = u.hostname === "youtu.be" ? u.pathname.slice(1).split("/")[0] : null;
    const v = shortMatch || u.searchParams.get("v");
    if (v && /^[\w-]{6,}$/.test(v)) return `https://www.youtube.com/watch?v=${v}`;
    return trimmed;
  } catch {
    return trimmed;
  }
}

/** Maximum time a flat-playlist listing may keep its pipes and worker occupied. */
export const PLAYLIST_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

/** Fetch a flat listing of a playlist/channel URL via yt-dlp. */
export async function getPlaylistItems(
  url: string,
  config: Config,
  opts: { timeoutMs?: number } = {},
): Promise<ListingItem[]> {
  const args = [
    ytDlp(),
    ...cookiesArgs(config),
    ...jsRuntimeArgs(),
    "--flat-playlist",
    "--print",
    "%(playlist_title)s|||%(id)s|||%(title)s|||%(duration)s",
    url,
  ];
  const ctl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? PLAYLIST_SCAN_TIMEOUT_MS;
  let proc: Bun.Subprocess | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
    // Do not leave a stubborn yt-dlp process or open output pipes behind.
    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  }, timeoutMs);
  let out = "";
  let stderr = "";
  let code = -1;
  try {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: ctl.signal });
    proc = child;
    [out, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } catch (error) {
    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {}
      await proc.exited.catch(() => {});
    }
    if (timedOut) throw new Error(`yt-dlp playlist scan timed out after ${timeoutMs}ms`);
    throw new Error(`Could not start yt-dlp playlist scan: ${error instanceof Error ? error.message : error}`);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error(`yt-dlp playlist scan timed out after ${timeoutMs}ms`);
  if (code !== 0) {
    const detail = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" ")
      .slice(-500);
    throw new Error(`yt-dlp playlist scan failed (exit ${code})${detail ? `: ${detail}` : ""}`);
  }
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const [playlist, id, title, duration] = line.split("|||");
      return {
        title: (title || "video").trim(),
        id: (id || "").trim(),
        playlist: (playlist || "playlist").trim(),
        duration: parseFloat(duration ?? "NaN"),
      };
    })
    .filter((i) => i.id);
}

/**
 * Insert (or skip) a batch of listing items into the jobs table. Shared by the
 * full scanner (yt-dlp flat listing) and the cheap RSS poller.
 */
export async function ingestItems(
  items: ListingItem[],
  config: Config,
  overrideFolderName?: string,
  sourceUrl?: string,
): Promise<{ found: number; added: number; skipped: number }> {
  if (config.offlineMode || getConfig().offlineMode) return { found: 0, added: 0, skipped: 0 };
  if (items.length === 0) return { found: 0, added: 0, skipped: 0 };
  const sourceKey = sourceUrl ? sourceIdentity(sourceUrl) : null;
  const folder = sanitizeFolderName(overrideFolderName || items[0].playlist || "Single Videos");
  const outputDir = join(config.outputRoot, folder);
  await mkdir(outputDir, { recursive: true });
  // A live offline toggle or source delete may have landed while this scan was
  // awaiting directory I/O. Do not enqueue results after either change.
  if (config.offlineMode || getConfig().offlineMode) return { found: 0, added: 0, skipped: 0 };
  if (sourceKey && isSourceBlocked(sourceKey)) {
    return { found: items.length, added: 0, skipped: items.length };
  }
  // Source cleanup can remove a completed job row while yt-dlp keeps its
  // download history. Consult that history once per listing so another
  // playlist cannot re-queue the same completed video ID.
  const archivedIds = readArchiveIds(config.archiveFile);
  const targetFormat = config.videoQuality === "audio" ? "mp3" : (config.targetFormat || "mp4");
  const wantSubs = config.downloadSubtitles ? 1 : 0;
  const wantThumb = config.writeThumbnail ? 1 : 0;
  const wantDesc = config.writeDescription ? 1 : 0;
  const conversionStatus = config.videoQuality === "audio" || targetFormat !== "mp4" ? "pending" : "not_needed";
  // Sidecar metadata (subs/thumbnail/description/info.json) is fetched by the
  // metadata worker after the download completes.
  const metadataStatus = wantSubs || wantThumb || wantDesc || config.writeInfoJson ? "pending" : "not_needed";

  let added = 0;
  let skipped = 0;
  const insertTransaction = db.transaction((batch: ListingItem[]) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO jobs
         (id, url, title, output_directory, target_format, want_subtitles, want_thumbnail, want_description, folder, "index", duration, download_status, conversion_status, metadata_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    const sourceStmt = sourceKey
      ? db.prepare("INSERT OR IGNORE INTO job_sources (source_url, job_id) VALUES (?, ?)")
      : null;
    for (const item of batch) {
      // A dashboard Delete is a durable opt-out, not just a temporary row
      // removal. Keep the video hidden across playlist/RSS scans and restarts
      // until the operator explicitly allows it again.
      if (isVideoIgnored(item.id)) {
        skipped++;
        stats.skipped++;
        continue;
      }
      if (
        config.skipShorts &&
        !config.downloadShorts &&
        Number.isFinite(item.duration) &&
        item.duration > 0 &&
        item.duration < 60
      ) {
        skipped++;
        stats.skipped++;
        continue;
      }
      if (isVideoInDb(item.id)) {
        // Record additional source ownership even though the video job itself
        // is deduplicated globally.
        if (sourceKey) sourceStmt?.run(sourceKey, item.id);
        // A job parked as waiting_live (stream was live at download time) may
        // have ended by now — any fresh listing that still contains it requeues
        // it; the !is_live filter drops it again if it is somehow still live.
        db.run(
          `UPDATE jobs SET download_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND download_status = 'waiting_live'`,
          [item.id],
        );
        skipped++;
        stats.skipped++;
        continue;
      }
      if (archivedIds.has(item.id)) {
        skipped++;
        stats.skipped++;
        continue;
      }
      const index = getNextIndex(folder);
      stmt.run(
        item.id,
        normalizeVideoUrl(`https://www.youtube.com/watch?v=${item.id}`),
        item.title,
        outputDir,
        targetFormat,
        wantSubs,
        wantThumb,
        wantDesc,
        folder,
        index,
        Number.isFinite(item.duration) && item.duration > 0 ? item.duration : null,
        conversionStatus,
        metadataStatus,
      );
      if (sourceKey) sourceStmt?.run(sourceKey, item.id);
      added++;
      stats.totalQueued++;
    }
  });
  insertTransaction(items);
  return { found: items.length, added, skipped };
}

/** Full scan of one playlist/channel URL, then ingest. */
export async function scanAndIngest(
  url: string,
  config: Config,
  overrideFolderName?: string,
): Promise<{ found: number; added: number; skipped: number }> {
  const empty = { found: 0, added: 0, skipped: 0 };
  // The callers check offline mode too, but this boundary is authoritative: the
  // setting can change while a daemon/startup scan is between sources.
  if (config.offlineMode || getConfig().offlineMode || isSourceBlocked(url)) return empty;
  const items = await getPlaylistItems(url, config);
  if (config.offlineMode || getConfig().offlineMode || isSourceBlocked(url)) return empty;
  return ingestItems(items, config, overrideFolderName, url);
}
