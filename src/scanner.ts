// src/scanner.ts — playlist/channel scanning and job ingestion.
//
// Two sources feed the same ingest path: the full yt-dlp flat-playlist scan
// (slow, authoritative) and the cheap per-channel RSS poller (fast, recent
// uploads only). Both dedupe on the YouTube video id, so the same video found
// by a playlist, a channel, and a watch URL is only ever queued once.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readArchiveIds } from "./archive";
import { db, getNextIndex, isVideoIgnored, isVideoInDb, takeReservedFileIndex } from "./db";
import { isSourceBlocked, parseSourceUrl, sourceIdentity } from "./sources";
import { createCookieInvocation, jsRuntimeArgs, ytDlp } from "./tools";
import { sanitizeFolderName } from "./util";
import { getConfig, stats } from "./state";
import { logError } from "./logger";
import type { Config } from "./config";
import { NativeCoreError, nativeCore, nativeValue } from "./native-core";

export interface ListingItem {
  id: string;
  title: string;
  playlist: string;
  duration: number;
  /**
   * The uploading channel's display name (yt-dlp `playlist_channel`). Set for
   * channel listings, where `playlist` is the tab title ("Name - Shorts").
   */
  channel?: string;
  /**
   * A playlist entry inside the listing (a channel's /playlists tab), not a
   * video. `id` is the playlist id and `title` its name. These are expanded into
   * their own scans, never queued as videos.
   */
  isPlaylist?: boolean;
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
function channelFolderNameTypeScript(item: ListingItem): string {
  const channel = item.channel?.trim();
  if (channel) return channel;
  return (item.playlist || "").replace(CHANNEL_TAB_SUFFIX, "").trim();
}

export function channelFolderName(item: ListingItem): string {
  const playlist = item.playlist || "";
  if (nativeCore && playlist.isWellFormed() && (item.channel == null || item.channel.isWellFormed())) {
    return nativeValue<string>(nativeCore.channelFolderName(playlist, item.channel ?? undefined));
  }
  return channelFolderNameTypeScript(item);
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
function isShortsTabItemTypeScript(item: ListingItem): boolean {
  return /\s+-\s+Shorts$/i.test(item.playlist || "");
}

export function isShortsTabItem(item: ListingItem): boolean {
  const playlist = item.playlist || "";
  if (nativeCore && playlist.isWellFormed()) {
    return nativeValue<boolean>(nativeCore.isShortsTabItem(playlist));
  }
  return isShortsTabItemTypeScript(item);
}

/**
 * What a listing entry's id names. yt-dlp lists a channel's /playlists tab as
 * playlist ids (PL…, UU…), not 11-character video ids. A playlist entry is
 * expanded into its own scan; a channel entry (UC…) is not downloadable this way.
 */
export type ListingEntryKind = "video" | "playlist" | "channel";

function listingEntryKindTypeScript(id: string): ListingEntryKind {
  if (id.length <= 11) return "video";
  if (/^UC/.test(id)) return "channel";
  if (/^(?:PL|UU|OL|FL|LL|RD|VL|EL)/.test(id)) return "playlist";
  return "video";
}

export function listingEntryKind(id: string): ListingEntryKind {
  if (nativeCore && id.isWellFormed()) {
    return nativeValue<ListingEntryKind>(nativeCore.listingEntryKind(id));
  }
  return listingEntryKindTypeScript(id);
}

/** A channel URL's root (no tab), so its playlists can be scanned too. */
export function isChannelRootUrl(url: string): boolean {
  try {
    const parsed = parseSourceUrl(url);
    return parsed.key === "channels" && !/\/(?:videos|shorts|streams|live|featured)$/.test(parsed.url);
  } catch {
    return false;
  }
}

/**
 * Canonical form of a video URL: strip tracking/timestamp junk and fold
 * youtu.be short links into watch URLs, so the same video always produces the
 * same stored job URL regardless of how it was discovered.
 */
function normalizeVideoUrlTypeScript(url: string): string {
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

export function normalizeVideoUrl(url: string): string {
  const trimmed = (url || "").trim();
  // Limit the native parser to ordinary YouTube HTTP(S) URLs. Exotic hosts,
  // credentials, backslashes, Unicode and whitespace retain ECMAScript URL
  // handling rather than letting a parser detail change a stored job URL.
  const compatible = nativeCore !== null &&
    /^https?:\/\/(?:youtu\.be|(?:www\.|m\.)?youtube\.com)(?::(?:80|443))?\/[\x21-\x7E]*$/i
      .test(trimmed) && !trimmed.includes("\\");
  if (nativeCore && compatible) {
    return nativeValue<string>(nativeCore.normalizeVideoUrl(trimmed));
  }
  return normalizeVideoUrlTypeScript(url);
}

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

function invalidNativeResult(detail: string): never {
  throw new NativeCoreError(
    `Rust native core returned an invalid scanner result (${detail})`,
    "NATIVE_INVALID_RESPONSE",
  );
}

function parseListingLineTypeScript(line: string): ListingItem | null {
  if (!line.trim()) return null;
  const [playlist, id, title, duration, channel] = line.split("|||");
  const item: ListingItem = {
    title: (title || "video").trim(),
    id: (id || "").trim(),
    // yt-dlp prints NA for a field the video does not have. A single video has
    // no playlist title, so it stays empty and the folder falls back to
    // "Single Videos" (the same fallback ingest and Metadata Only use).
    playlist: (playlist || "").trim() === "NA" ? "" : (playlist || "").trim(),
    duration: parseFloat(duration ?? "NaN"),
  };
  const uploader = (channel || "").trim();
  if (uploader && uploader !== "NA") item.channel = uploader;
  if (!item.id) return null;
  const kind = listingEntryKindTypeScript(item.id);
  if (kind === "channel") return null;
  if (kind === "playlist") item.isPlaylist = true;
  return item;
}

interface NativeListingLineItem {
  title: string;
  id: string;
  playlist: string;
  /** Raw field: only ECMAScript parseFloat defines the public numeric value. */
  durationText: string;
  channel?: string;
  isPlaylist?: boolean;
}

/**
 * Parse a batch of `--print` lines, dropping blank/channel entries while
 * retaining the order of every accepted video/playlist item.
 */
export function parseListingLines(lines: string[]): ListingItem[] {
  if (nativeCore && lines.every((line) => line.isWellFormed())) {
    const parsed = nativeValue<NativeListingLineItem[]>(nativeCore.parseListingLines(JSON.stringify(lines)));
    if (!Array.isArray(parsed) || parsed.some((item) =>
      !item || typeof item.title !== "string" || typeof item.id !== "string" ||
      typeof item.playlist !== "string" || typeof item.durationText !== "string" ||
      (item.channel !== undefined && typeof item.channel !== "string") ||
      (item.isPlaylist !== undefined && typeof item.isPlaylist !== "boolean")
    )) {
      return invalidNativeResult("malformed listing batch");
    }
    return parsed.map((raw) => {
      const item: ListingItem = {
        title: raw.title,
        id: raw.id,
        playlist: raw.playlist,
        // Do not replace this with a Rust float parser: parseFloat accepts a
        // numeric prefix and can produce NaN/Infinity, which JSON cannot carry.
        duration: parseFloat(raw.durationText),
      };
      if (raw.channel !== undefined) item.channel = raw.channel;
      if (raw.isPlaylist) item.isPlaylist = true;
      return item;
    });
  }
  return lines
    .map(parseListingLineTypeScript)
    .filter((item): item is ListingItem => item !== null);
}

/** Parse one `--print` line; null for blank lines and entries without an id. */
export function parseListingLine(line: string): ListingItem | null {
  return parseListingLines([line])[0] ?? null;
}

/** Read yt-dlp's stdout incrementally, emitting batches of parsed items. */
async function streamListing(
  stream: ReadableStream<Uint8Array>,
  items: ListingItem[],
  onItems: PlaylistListingOptions["onItems"],
  onSinkError: (error: unknown) => void,
  onActivity: () => void = () => {},
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let batch: ListingItem[] = [];
  let pendingLines: string[] = [];
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
  // Amortize the native boundary over raw lines, but retain the public
  // 50-VALID-item onItems batches (blank and channel lines never counted).
  const parsePending = async (force = false) => {
    if (pendingLines.length === 0 || (!force && pendingLines.length < LISTING_BATCH_SIZE)) return;
    const lines = pendingLines;
    pendingLines = [];
    for (const item of parseListingLines(lines)) {
      items.push(item);
      batch.push(item);
      if (batch.length >= LISTING_BATCH_SIZE) await emit();
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onActivity();
    carry += decoder.decode(value, { stream: true });
    let newline = carry.indexOf("\n");
    while (newline !== -1) {
      pendingLines.push(carry.slice(0, newline));
      carry = carry.slice(newline + 1);
      await parsePending();
      newline = carry.indexOf("\n");
    }
  }
  carry += decoder.decode();
  pendingLines.push(carry);
  await parsePending(true);
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
  const cookie = createCookieInvocation(config);
  const args = [
    ytDlp(),
    ...cookie.args,
    ...jsRuntimeArgs(),
    "--flat-playlist",
    // --ignore-errors: do NOT abort the scan when a video in the playlist is
    // private, unavailable, or otherwise unfetchable.  Without this flag yt-dlp
    // stops at the first dead entry and the rest of the playlist is silently
    // lost — catastrophic for a 1000-video playlist that has a handful of
    // private uploads. The failure is still visible on individual job rows.
    "--ignore-errors",
    "--print",
    "%(playlist_title)s|||%(id)s|||%(title)s|||%(duration)s|||%(playlist_channel)s",
    url,
  ];
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
      }, onActivity),
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
    cookie.cleanup();
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

export interface IngestItemPlan {
  /** Playlist entries are expanded by the scanner, never inserted as videos. */
  isPlaylist: boolean;
  short: boolean;
  skipShort: boolean;
  url: string;
  /** Only a finite, positive duration is persisted. */
  duration: number | null;
}

export interface IngestPlan {
  targetFormat: string;
  wantSubtitles: 0 | 1;
  wantThumbnail: 0 | 1;
  wantDescription: 0 | 1;
  conversionStatus: "pending" | "not_needed";
  metadataStatus: "pending" | "not_needed";
  items: IngestItemPlan[];
}

function prepareIngestPlanTypeScript(items: ListingItem[], config: Config): IngestPlan {
  const targetFormat = config.videoQuality === "audio" ? "mp3" : (config.targetFormat || "mp4");
  // Embedding needs the sidecar file even when the operator turned the
  // corresponding "save sidecars" switch off.
  const wantSubtitles = config.downloadSubtitles || config.embedSubtitles ? 1 : 0;
  const wantThumbnail = config.writeThumbnail || config.embedThumbnail ? 1 : 0;
  const wantDescription = config.writeDescription ? 1 : 0;
  const embedWanted = config.embedSubtitles || config.embedThumbnail;
  const conversionStatus =
    config.videoQuality === "audio" || targetFormat !== "mp4" || embedWanted ? "pending" : "not_needed";
  const metadataStatus = wantSubtitles || wantThumbnail || wantDescription || config.writeInfoJson
    ? "pending"
    : "not_needed";
  return {
    targetFormat,
    wantSubtitles,
    wantThumbnail,
    wantDescription,
    conversionStatus,
    metadataStatus,
    items: items.map((item) => {
      const short = Number.isFinite(item.duration) && item.duration > 0
        ? item.duration < 60
        : isShortsTabItemTypeScript(item);
      return {
        isPlaylist: Boolean(item.isPlaylist),
        short,
        skipShort: config.skipShorts && !config.downloadShorts && short,
        url: normalizeVideoUrlTypeScript(`https://www.youtube.com/watch?v=${item.id}`),
        duration: Number.isFinite(item.duration) && item.duration > 0 ? item.duration : null,
      };
    }),
  };
}

/** Prepare every pure ingest decision without touching SQLite or the archive. */
export function prepareIngestPlan(items: ListingItem[], config: Config): IngestPlan {
  // For ordinary YouTube ids the generated watch URL is already canonical.
  // Exotic ids keep the full ECMAScript URL path, including query/percent rules.
  const compatible = nativeCore !== null && config.videoQuality.isWellFormed() && config.targetFormat.isWellFormed() &&
    items.every((item) => /^[A-Za-z0-9_-]+$/.test(item.id) && item.playlist.isWellFormed());
  if (nativeCore && compatible) {
    const prepared = nativeValue<IngestPlan>(nativeCore.prepareIngestBatch(JSON.stringify({
      items: items.map((item) => ({
        id: item.id,
        playlist: item.playlist,
        duration: Number.isFinite(item.duration) ? item.duration : null,
        isPlaylist: Boolean(item.isPlaylist),
      })),
      videoQuality: config.videoQuality,
      targetFormat: config.targetFormat,
      downloadSubtitles: config.downloadSubtitles,
      embedSubtitles: config.embedSubtitles,
      writeThumbnail: config.writeThumbnail,
      embedThumbnail: config.embedThumbnail,
      writeDescription: config.writeDescription,
      writeInfoJson: config.writeInfoJson,
      skipShorts: config.skipShorts,
      downloadShorts: config.downloadShorts,
    })));
    if (!prepared || typeof prepared !== "object" || !Array.isArray(prepared.items) ||
      prepared.items.length !== items.length || typeof prepared.targetFormat !== "string" ||
      ![0, 1].includes(prepared.wantSubtitles) || ![0, 1].includes(prepared.wantThumbnail) ||
      ![0, 1].includes(prepared.wantDescription) ||
      !["pending", "not_needed"].includes(prepared.conversionStatus) ||
      !["pending", "not_needed"].includes(prepared.metadataStatus) ||
      prepared.items.some((plan) => !plan || typeof plan.isPlaylist !== "boolean" ||
        typeof plan.short !== "boolean" || typeof plan.skipShort !== "boolean" ||
        typeof plan.url !== "string" ||
        !(plan.duration === null || (typeof plan.duration === "number" && Number.isFinite(plan.duration))))
    ) {
      return invalidNativeResult("malformed or misaligned ingest plan");
    }
    return prepared;
  }
  return prepareIngestPlanTypeScript(items, config);
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
  const ingestPlan = prepareIngestPlan(items, config);
  const {
    targetFormat,
    wantSubtitles: wantSubs,
    wantThumbnail: wantThumb,
    wantDescription: wantDesc,
    conversionStatus,
    metadataStatus,
  } = ingestPlan;

  let added = 0;
  let skipped = 0;

  // Chunk large playlists into bounded transactions (500 items each) to avoid
  // holding a single huge write lock. For a 10,000-item playlist this is the
  // difference between a 10-second stall and a series of fast micro-commits.
  const CHUNK_SIZE = 500;
  const insertChunk = db.transaction((batch: { item: ListingItem; plan: IngestItemPlan }[]) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO jobs
         (id, url, title, output_directory, target_format, want_subtitles, want_thumbnail, want_description, folder, "index", duration, download_status, conversion_status, metadata_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    const sourceStmt = sourceKey
      ? db.prepare("INSERT OR IGNORE INTO job_sources (source_url, job_id) VALUES (?, ?)")
      : null;
    for (const { item, plan } of batch) {
      // A dashboard Delete is a durable opt-out, not just a temporary row
      // removal. Keep the video hidden across playlist/RSS scans and restarts
      // until the operator explicitly allows it again.
      if (isVideoIgnored(item.id)) {
        skipped++;
        stats.skipped++;
        continue;
      }
      // The planner retains the historical rule: a Shorts-tab entry with no
      // finite positive duration is marked by the tab itself.
      if (plan.skipShort) {
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
        plan.url,
        item.title,
        outputDir,
        targetFormat,
        wantSubs,
        wantThumb,
        wantDesc,
        folder,
        index,
        plan.duration,
        conversionStatus,
        metadataStatus,
      );
      if (sourceKey) sourceStmt?.run(sourceKey, item.id);
      added++;
      stats.totalQueued++;
    }
  });

  // Playlist entries are expanded by scanAndIngest, never queued as videos.
  // Zipping by index keeps every side-effect check in the original item order.
  const videos = items
    .map((item, index) => ({ item, plan: ingestPlan.items[index] }))
    .filter(({ plan }) => !plan.isPlaylist);
  for (let i = 0; i < videos.length; i += CHUNK_SIZE) {
    insertChunk(videos.slice(i, i + CHUNK_SIZE));
  }

  return { found: items.length, added, skipped };
}

export interface ScanTotals {
  found: number;
  added: number;
  skipped: number;
  /** Playlists a channel (or /playlists tab) listed and that were scanned. */
  playlists?: number;
}

/** Options for one listing URL. */
interface ListingScanOptions {
  /** Folder for every video of this listing; otherwise derived from the listing. */
  folder?: string;
  /** Configured source the jobs belong to (the channel, for its playlists). */
  owner: string;
}

/**
 * Scan one listing URL and ingest its videos under `owner`. Playlist entries
 * found in the listing are returned, not queued, so the caller can expand them.
 */
async function scanListing(
  listingUrl: string,
  config: Config,
  opts: ListingScanOptions,
): Promise<{ totals: ScanTotals; playlists: ListingItem[] }> {
  const totals: ScanTotals = { found: 0, added: 0, skipped: 0 };
  const playlists: ListingItem[] = [];
  const channel = isChannelSource(opts.owner);
  // A channel's tabs all share one folder, named after the channel. Resolved
  // from the first batch, since every item in a channel listing carries it.
  let channelFolder: string | undefined;
  const blocked = () => config.offlineMode || getConfig().offlineMode || isSourceBlocked(opts.owner);

  const ingestBatch = async (items: ListingItem[]) => {
    // Re-check per batch: offline mode or a source removal can land mid-listing.
    if (blocked()) return;
    const videos = items.filter((item) => !item.isPlaylist);
    playlists.push(...items.filter((item) => item.isPlaylist));
    if (videos.length === 0) return;
    let folder = opts.folder;
    if (!folder && channel) {
      channelFolder ??= channelFolderName(videos[0]) || undefined;
      folder = channelFolder;
    }
    const result = await ingestItems(videos, config, folder, opts.owner);
    totals.found += result.found;
    totals.added += result.added;
    totals.skipped += result.skipped;
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= SCAN_MAX_RETRIES; attempt++) {
    try {
      await getPlaylistItems(listingUrl, config, { onItems: ingestBatch, idle: channel });
      return { totals, playlists };
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || err);
      // Permanent errors (bad URL, auth required, source removed) should not
      // be retried — only transient network failures get the retry budget.
      if (!isScanErrorTransient(msg) || attempt >= SCAN_MAX_RETRIES) break;
      const backoffMs = SCAN_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      logError(
        "scanner",
        `${listingUrl}: transient scan error on attempt ${attempt}/${SCAN_MAX_RETRIES}, retrying in ${Math.round(backoffMs / 1000)}s: ${msg.slice(0, 200)}`,
      );
      await Bun.sleep(backoffMs);
      // Re-check after the sleep: the engine may have gone offline.
      if (blocked()) return { totals, playlists };
    }
  }
  throw lastErr;
}

/**
 * Scan each playlist entry into its own folder named after the playlist, owned
 * by `owner`. One failing playlist (private, removed, …) is logged and never
 * stops the rest.
 */
async function expandPlaylists(entries: ListingItem[], config: Config, owner: string): Promise<ScanTotals> {
  const totals: ScanTotals = { found: 0, added: 0, skipped: 0, playlists: 0 };
  const seen = new Set<string>();
  for (const entry of entries) {
    if (config.offlineMode || getConfig().offlineMode || isSourceBlocked(owner)) break;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const url = `https://www.youtube.com/playlist?list=${entry.id}`;
    try {
      const { totals: part } = await scanListing(url, config, {
        folder: entry.title || undefined,
        owner,
      });
      totals.found += part.found;
      totals.added += part.added;
      totals.skipped += part.skipped;
      totals.playlists = (totals.playlists ?? 0) + 1;
    } catch (err: any) {
      logError("scan", `${url} (playlist of ${owner}): ${String(err?.message || err)}`);
    }
  }
  return totals;
}

/**
 * Full scan of one saved source, then ingest.
 *
 * - A playlist: its videos.
 * - A channel (`@handle`, `/channel/…`, …): all its uploads, live streams and
 *   Shorts into one channel folder, then every playlist on its /playlists tab,
 *   each into a folder named after that playlist.
 * - A channel's /playlists tab: every playlist on it.
 *
 * Videos are ingested batch by batch while yt-dlp is still listing the source.
 * Batches are idempotent (already-known videos are skipped), so a retried
 * attempt never queues a video twice. Transient network errors are retried
 * with exponential backoff (up to SCAN_MAX_RETRIES attempts).
 */
export async function scanAndIngest(url: string, config: Config, overrideFolderName?: string): Promise<ScanTotals> {
  // The callers check offline mode too, but this boundary is authoritative: the
  // setting can change while a daemon/startup scan is between sources.
  if (config.offlineMode || getConfig().offlineMode || isSourceBlocked(url)) {
    return { found: 0, added: 0, skipped: 0 };
  }
  const { totals, playlists } = await scanListing(url, config, { folder: overrideFolderName, owner: url });
  const expanded = [...playlists];
  // A channel root also owns its /playlists tab. A channel with no playlists
  // tab is normal, so a failure there is logged and never fails the scan.
  if (isChannelRootUrl(url)) {
    const tabUrl = `${url.replace(/\/+$/, "")}/playlists`;
    try {
      const tab = await scanListing(tabUrl, config, { owner: url });
      expanded.push(...tab.playlists);
    } catch (err: any) {
      logError("scan", `${tabUrl}: ${String(err?.message || err)}`);
    }
  }
  if (expanded.length === 0) return totals;
  const more = await expandPlaylists(expanded, config, url);
  return {
    found: totals.found + more.found,
    added: totals.added + more.added,
    skipped: totals.skipped + more.skipped,
    playlists: more.playlists,
  };
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
