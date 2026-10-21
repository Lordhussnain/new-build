// src/scanner.ts — playlist/channel scanning and job ingestion.
//
// Two sources feed the same ingest path: the full yt-dlp flat-playlist scan
// (slow, authoritative) and the cheap per-channel RSS poller (fast, recent
// uploads only). Both dedupe on the video id, so the same video found by a
// playlist, a channel, and a watch URL is only ever queued once.
//
// Nothing here knows what a YouTube or a Bilibili URL looks like: src/providers.ts
// answers which site a source belongs to, which listing ids are videos, and the
// canonical page URL an entry becomes a job with.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readArchiveIds } from "./archive";
import { db, getNextIndex, isVideoIgnored, isVideoInDb, takeReservedFileIndex } from "./db";
import {
  channelFolderFallback,
  isListingVideoId,
  listingProvider,
  normalizeVideoUrl,
  resolveListingVideoUrl,
  type ProviderId,
} from "./providers";
import { isSourceBlocked, parseSourceUrl, sourceIdentity } from "./sources";
import { cookiesArgs, jsRuntimeArgs, ytDlp } from "./tools";
import { UNKNOWN_LISTING_TITLE } from "./video-summary";
import { sanitizeFolderName } from "./util";
import { getConfig, stats } from "./state";
import { logError } from "./logger";
import type { Config } from "./config";

export { normalizeVideoUrl };

export interface ListingItem {
  id: string;
  title: string;
  playlist: string;
  duration: number;
  /**
   * The entry's own page URL, when yt-dlp printed one (`%(webpage_url)s` on a
   * fully extracted video, `%(url)s` on a flat entry). Optional and untrusted:
   * a flat YouTube entry prints its bare id there and a full extraction prints
   * the selected format's expiring CDN URL, so `resolveListingVideoUrl` only
   * accepts it when it validates as a page URL of a supported site.
   */
  webpageUrl?: string;
  /** The raw `%(url)s` field, kept separate for the same validation. */
  printedUrl?: string;
  /**
   * The uploading channel's display name (yt-dlp `playlist_channel`). Set for
   * channel listings, where `playlist` is the tab title ("Name - Shorts").
   */
  channel?: string;
}

/** Trailing tab name yt-dlp appends to a channel tab's title: "Name - Videos". */
const CHANNEL_TAB_SUFFIX = /\s+-\s+(?:Videos|Shorts|Live|Streams|Playlists|Home|Featured|Posts|Community|Releases)$/i;

/**
 * The one folder every video of a channel is saved into, whichever tab it came
 * from (uploads, Shorts, live). yt-dlp names each tab "<Channel> - Videos",
 * "<Channel> - Shorts", … — without this, one channel would be split across
 * several folders, and the RSS watcher (which only sees the channel name) would
 * create yet another one.
 */
export function channelFolderName(item: ListingItem): string {
  const channel = item.channel?.trim();
  if (channel) return channel;
  return (item.playlist || "").replace(CHANNEL_TAB_SUFFIX, "").trim();
}

/** True for a channel source (@handle, /channel/, /c/, /user/), any tab. */
export function isChannelSource(url: string): boolean {
  try {
    return parseSourceUrl(url).key === "channels";
  } catch {
    return false;
  }
}

/** Items listed from a channel's Shorts tab (they report no duration). */
export function isShortsTabItem(item: ListingItem): boolean {
  return /\s+-\s+Shorts$/i.test(item.playlist || "");
}

/**
 * yt-dlp lists a channel's /playlists tab, or a playlist that appears inside a
 * tab, as an entry whose id is a playlist/channel id (PL…, UU…, UC…), not a
 * video id. Those are not videos and must never become jobs. Bilibili's
 * equivalent (a nested collection inside a space's uploads) is handled by the
 * same provider-aware check in `parseListingLine`.
 */
export { isPlaylistLikeId } from "./providers";

/** Field separator of the listing `--print` template: never valid in a URL. */
const FIELD_SEPARATOR = "|||";

/**
 * What one listing line asks yt-dlp for, in the order `parseListingLine` reads
 * it. `webpage_url`/`url` come last so a yt-dlp that answers fewer fields (an
 * older build, or the test mock) still parses: missing trailing fields are
 * simply absent, and the job URL falls back to the source and the id.
 */
export const LISTING_PRINT_TEMPLATE = [
  "%(playlist_title)s",
  "%(id)s",
  "%(title)s",
  "%(duration)s",
  "%(playlist_channel)s",
  "%(webpage_url)s",
  "%(url)s",
].join(FIELD_SEPARATOR);

/** Maximum time a flat-playlist listing may keep its pipes and worker occupied. */
export const PLAYLIST_SCAN_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Channel listings get an inactivity limit instead of a total one: a channel
 * with thousands of uploads legitimately runs far longer than 10 minutes, but
 * yt-dlp keeps printing (or fetching) as it goes. A listing is only stopped
 * after this long without any output.
 */
export const CHANNEL_SCAN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How many times a transient scan failure retries before giving up. */
export const SCAN_MAX_RETRIES = 3;
/** Base backoff (ms) for transient scan failures — doubles each retry. */
export const SCAN_BACKOFF_BASE_MS = 5_000;

/** True when a scan error is likely transient (network hiccup) rather than permanent. */
export function isScanErrorTransient(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("connection") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("network") ||
    m.includes("http error 5") ||
    m.includes("too many requests") ||
    m.includes("rate limit") ||
    // Bilibili risk control: a listing that answers 412 / -352 / "please wait
    // and try later" is throttled, not gone, so the retry budget applies.
    m.includes("blocked by server") ||
    m.includes("rejected by server") ||
    m.includes("please wait and try later") ||
    m.includes("risk control") ||
    m.includes("http error 412") ||
    m.includes("service unavailable") ||
    m.includes("read error") ||
    m.includes("ssl") ||
    m.includes("eof")
  );
}

/** Items per ingest batch while a listing is still running. */
export const LISTING_BATCH_SIZE = 50;

export interface PlaylistListingOptions {
  /** Total limit (or, with `idle`, the limit between outputs). */
  timeoutMs?: number;
  /** Use an inactivity limit that resets on every line of output. */
  idle?: boolean;
  /**
   * Called with each batch of items as yt-dlp prints them, while the listing is
   * still running. Ingesting here lets downloads start before the rest of a
   * large playlist has been listed. A rejection aborts the listing and is
   * rethrown unchanged.
   */
  onItems?: (items: ListingItem[]) => Promise<void> | void;
}

/** A yt-dlp `--print` field that the entry does not have. */
function field(value: string | undefined): string {
  const trimmed = (value || "").trim();
  return trimmed === "NA" ? "" : trimmed;
}

/**
 * Parse one `--print` line; null for blank lines, entries without an id, and
 * entries that are lists rather than videos.
 *
 * `provider` decides which ids count as videos — YouTube's playlist-id prefixes
 * versus Bilibili's `<mid>_<sid>` collection rows. It defaults to YouTube so a
 * caller that has no source URL keeps the historical behaviour.
 */
export function parseListingLine(line: string, provider: ProviderId = "youtube"): ListingItem | null {
  if (!line.trim()) return null;
  const [playlist, id, title, duration, channel, webpageUrl, printedUrl] = line.split(FIELD_SEPARATOR);
  const item: ListingItem = {
    // yt-dlp prints NA for a field the entry does not have, and a Bilibili flat
    // listing has no titles at all. The placeholder is what
    // `needsSummaryBackfill` looks for before the first download.
    title: field(title) || UNKNOWN_LISTING_TITLE,
    id: (id || "").trim(),
    // A single video has no playlist title, so it stays empty and the folder
    // falls back to "Single Videos" (the same fallback ingest and Metadata Only
    // use).
    playlist: field(playlist),
    duration: parseFloat(duration ?? "NaN"),
  };
  const uploader = field(channel);
  if (uploader) item.channel = uploader;
  const page = field(webpageUrl);
  if (page) item.webpageUrl = page;
  const printed = field(printedUrl);
  if (printed) item.printedUrl = printed;
  if (!isListingVideoId(provider, item.id)) return null;
  return item.id ? item : null;
}

/** Read yt-dlp's stdout incrementally, emitting batches of parsed items. */
async function streamListing(
  stream: ReadableStream<Uint8Array>,
  items: ListingItem[],
  onItems: PlaylistListingOptions["onItems"],
  onSinkError: (error: unknown) => void,
  onActivity: () => void = () => {},
  provider: ProviderId = "youtube",
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let batch: ListingItem[] = [];
  const take = (line: string) => {
    const item = parseListingLine(line, provider);
    if (item) {
      items.push(item);
      batch.push(item);
    }
  };
  const emit = async () => {
    if (batch.length === 0 || !onItems) {
      batch = [];
      return;
    }
    const ready = batch;
    batch = [];
    try {
      await onItems(ready);
    } catch (error) {
      onSinkError(error);
      throw error;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onActivity();
    carry += decoder.decode(value, { stream: true });
    let newline = carry.indexOf("\n");
    while (newline !== -1) {
      take(carry.slice(0, newline));
      carry = carry.slice(newline + 1);
      if (batch.length >= LISTING_BATCH_SIZE) await emit();
      newline = carry.indexOf("\n");
    }
  }
  carry += decoder.decode();
  take(carry);
  await emit();
}

/**
 * Fetch a flat listing of a playlist/channel URL via yt-dlp. Returns every item
 * (the legacy full-array contract); pass `onItems` to receive items while the
 * listing is still running.
 */
export async function getPlaylistItems(
  url: string,
  config: Config,
  opts: PlaylistListingOptions = {},
): Promise<ListingItem[]> {
  const args = [
    ytDlp(),
    ...cookiesArgs(config),
    ...jsRuntimeArgs(),
    "--flat-playlist",
    // --ignore-errors: do NOT abort the scan when a video in the playlist is
    // private, unavailable, or otherwise unfetchable.  Without this flag yt-dlp
    // stops at the first dead entry and the rest of the playlist is silently
    // lost — catastrophic for a 1000-video playlist that has a handful of
    // private uploads. The failure is still visible on individual job rows.
    "--ignore-errors",
    "--print",
    LISTING_PRINT_TEMPLATE,
    url,
  ];
  // Which site is being listed decides which entry ids are videos, and how a
  // missing one is turned back into a page URL at ingest.
  const provider = listingProvider(url);
  const ctl = new AbortController();
  const limitMs = opts.timeoutMs ?? (opts.idle ? CHANNEL_SCAN_IDLE_TIMEOUT_MS : PLAYLIST_SCAN_TIMEOUT_MS);
  let proc: Bun.Subprocess | null = null;
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    ctl.abort();
    // Do not leave a stubborn yt-dlp process or open output pipes behind.
    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  };
  let timer = setTimeout(expire, limitMs);
  // Idle mode re-arms the limit on every chunk of output, so only a stall stops it.
  const onActivity = () => {
    if (!opts.idle) return;
    clearTimeout(timer);
    timer = setTimeout(expire, limitMs);
  };
  const items: ListingItem[] = [];
  let stderr = "";
  let code = -1;
  // A failure in the consumer (e.g. a database error while ingesting a batch)
  // is not a yt-dlp failure; keep it intact instead of wrapping it as a spawn error.
  let sinkFailed = false;
  let sinkError: unknown;
  const timeoutMessage = opts.idle
    ? `yt-dlp playlist scan timed out after ${limitMs}ms without new output`
    : `yt-dlp playlist scan timed out after ${limitMs}ms`;
  try {
    // PYTHONUNBUFFERED: yt-dlp is Python, and a piped Python process otherwise
    // holds its output in an 8 KB block, delaying the first batches.
    const child = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctl.signal,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    proc = child;
    [, stderr, code] = await Promise.all([
      streamListing(child.stdout, items, opts.onItems, (error) => {
        sinkFailed = true;
        sinkError = error;
      }, onActivity, provider),
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
    if (sinkFailed) throw sinkError;
    if (timedOut) throw new Error(timeoutMessage);
    throw new Error(`Could not start yt-dlp playlist scan: ${error instanceof Error ? error.message : error}`);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error(timeoutMessage);
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
  return items;
}

/**
 * Insert (or skip) a batch of listing items into the jobs table. Shared by the
 * full scanner (yt-dlp flat listing) and the cheap RSS poller.
 *
 * Large playlists (1000+ videos) are chunked into bounded transactions to avoid
 * holding a single enormous write lock and to give the WAL a chance to sync.
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
  // Which site this listing came from decides how an entry id becomes a job
  // URL. A listing ingested without a source (a caller that already knows what
  // it queued) keeps the historical YouTube-shaped answer.
  const provider = listingProvider(sourceKey || sourceUrl);
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

  // Chunk large playlists into bounded transactions (500 items each) to avoid
  // holding a single huge write lock. For a 10,000-item playlist this is the
  // difference between a 10-second stall and a series of fast micro-commits.
  const CHUNK_SIZE = 500;
  const insertChunk = db.transaction((batch: ListingItem[]) => {
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
      // A Shorts-tab entry carries no duration, so the tab itself marks it.
      const short = Number.isFinite(item.duration) && item.duration > 0
        ? item.duration < 60
        : isShortsTabItem(item);
      if (config.skipShorts && !config.downloadShorts && short) {
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
      // A video whose sidecars were fetched first keeps the index they were named with.
      const index = takeReservedFileIndex(folder, item.id) ?? getNextIndex(folder);
      stmt.run(
        item.id,
        // The page URL this video is downloaded from: what yt-dlp printed for
        // the entry when that validates as a page URL, else the source (a
        // single-video scan) or the id read through the source's shape.
        resolveListingVideoUrl({
          id: item.id,
          provider,
          sourceUrl: sourceKey || sourceUrl,
          webpageUrl: item.webpageUrl,
          printedUrl: item.printedUrl,
        }),
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

  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    insertChunk(items.slice(i, i + CHUNK_SIZE));
  }

  return { found: items.length, added, skipped };
}

/** Full scan of one playlist/channel URL, then ingest.
 *
 * Videos are ingested batch by batch while yt-dlp is still listing the source,
 * so the download workers start on the first videos of a large playlist at once.
 * Batches are idempotent (already-known videos are skipped), so a retried
 * attempt never queues a video twice.
 *
 * Transient network errors are retried with exponential backoff (up to
 * SCAN_MAX_RETRIES attempts) so a single HTTP hiccup doesn't permanently
 * drop an entire source during startup when managing 1000+ playlists.
 */
export async function scanAndIngest(
  url: string,
  config: Config,
  overrideFolderName?: string,
): Promise<{ found: number; added: number; skipped: number }> {
  const totals = { found: 0, added: 0, skipped: 0 };
  // The callers check offline mode too, but this boundary is authoritative: the
  // setting can change while a daemon/startup scan is between sources.
  if (config.offlineMode || getConfig().offlineMode || isSourceBlocked(url)) return totals;

  // A channel's tabs all share one folder, named after the channel. Resolved
  // from the first batch, since every item in a channel listing carries it.
  const channel = isChannelSource(url);
  let channelFolder: string | undefined;

  const ingestBatch = async (items: ListingItem[]) => {
    // Re-check per batch: offline mode or a source removal can land mid-listing.
    if (config.offlineMode || getConfig().offlineMode || isSourceBlocked(url)) return;
    let folder = overrideFolderName;
    if (!folder && channel && items.length > 0) {
      // A listing that names neither a channel nor a playlist (a Bilibili space
      // is built by yt-dlp with only the uploader's numeric id) still gets one
      // folder of its own instead of sharing "Single Videos" with everything.
      channelFolder ??= channelFolderName(items[0]) || channelFolderFallback(url) || undefined;
      folder = channelFolder;
    }
    const result = await ingestItems(items, config, folder, url);
    totals.found += result.found;
    totals.added += result.added;
    totals.skipped += result.skipped;
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= SCAN_MAX_RETRIES; attempt++) {
    try {
      await getPlaylistItems(url, config, { onItems: ingestBatch, idle: channel });
      return totals;
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || err);
      // Permanent errors (bad URL, auth required, source removed) should not
      // be retried — only transient network failures get the retry budget.
      if (!isScanErrorTransient(msg) || attempt >= SCAN_MAX_RETRIES) break;
      const backoffMs = SCAN_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      logError(
        "scanner",
        `${url}: transient scan error on attempt ${attempt}/${SCAN_MAX_RETRIES}, retrying in ${Math.round(backoffMs / 1000)}s: ${msg.slice(0, 200)}`,
      );
      await Bun.sleep(backoffMs);
      // Re-check after the sleep: the engine may have gone offline.
      if (config.offlineMode || getConfig().offlineMode || isSourceBlocked(url)) return totals;
    }
  }
  throw lastErr;
}

export interface SourceScanOutcome {
  url: string;
  found: number;
  added: number;
  skipped: number;
  error?: string;
}

/**
 * Scan several saved sources with a bounded worker pool (the same shape as the
 * startup scan). Each source is independent: one failing source is recorded in
 * its outcome and never stops the rest. Used for batch imports, which run after
 * the HTTP response so a long list cannot hold the request open.
 */
export async function scanSourcesBatch(
  urls: string[],
  config: Config,
  folderOverride?: string,
  concurrency = 4,
): Promise<SourceScanOutcome[]> {
  const outcomes: SourceScanOutcome[] = [];
  const queue = [...urls];
  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;
      try {
        const result = await scanAndIngest(url, config, folderOverride);
        outcomes.push({ url, ...result });
      } catch (err: any) {
        const error = String(err?.message || err);
        logError("scan", `${url}: ${error}`);
        outcomes.push({ url, found: 0, added: 0, skipped: 0, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return outcomes;
}
