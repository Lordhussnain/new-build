// src/rss.ts — cheap new-upload watcher via per-channel RSS feeds.
//
// Polling YouTube's per-channel RSS feed costs one plain HTTP GET per channel
// (no yt-dlp spawn) and surfaces new uploads within ~rssPollIntervalMinutes —
// far cheaper than a full flat-playlist rescan, which remains the slow safety
// net via rescanIntervalHours. New video ids go through the same ingestItems
// dedup as every other source.

import { cookiesArgs, ytDlp } from "./tools";
import { ingestItems, type ListingItem } from "./scanner";
import { logError } from "./logger";
import { getConfig } from "./state";
import type { Config } from "./config";

const channelIdCache = new Map<string, string>();

export async function resolveChannelId(channelUrl: string, config: Config): Promise<string | null> {
  // /channel/UC... URLs carry the id directly — no yt-dlp call needed.
  const direct = channelUrl.match(/channel\/(UC[\w-]{10,})/);
  if (direct) return direct[1];
  const cached = channelIdCache.get(channelUrl);
  if (cached) return cached;
  try {
    // @handle / custom URLs: resolve once via yt-dlp, then cache for the run.
    const proc = Bun.spawn(
      [ytDlp(), ...cookiesArgs(config), "--flat-playlist", "--playlist-end", "1", "--print", "%(channel_id)s", channelUrl],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return null;
    const id = out
      .split("\n")
      .map((s) => s.trim())
      .find((s) => /^UC[\w-]{10,}$/.test(s));
    if (id) channelIdCache.set(channelUrl, id);
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Parse a YouTube channel RSS feed into listing items. Pure (no I/O) so it can
 * be unit-tested against a captured feed.
 */
export function parseRssFeed(xml: string): { feedTitle: string; items: ListingItem[] } {
  // The feed-level title is the first <title> before any <entry>.
  const feedTitle =
    xml
      .match(/<feed[^>]*>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]
      ?.trim() || "RSS Channel";
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const items: ListingItem[] = [];
  for (const entry of entries) {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!id) continue;
    const title =
      entry
        .match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]
        ?.trim() || id;
    // media:duration is best-effort; a missing duration (NaN) simply bypasses
    // the shorts filter — the metadata worker records the real value later.
    const duration = parseFloat(entry.match(/<media:content[^>]*duration="(\d+)"/)?.[1] ?? "NaN");
    items.push({ id, title, playlist: feedTitle, duration });
  }
  return { feedTitle, items };
}

export async function pollChannelRss(channelUrl: string, config: Config): Promise<number> {
  const channelId = await resolveChannelId(channelUrl, config);
  if (!channelId) throw new Error(`could not resolve channel id for ${channelUrl}`);
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(feedUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status} for ${channelUrl}`);
  const xml = await res.text();
  const { items } = parseRssFeed(xml);
  const result = await ingestItems(items, config);
  return result.added;
}

export function startRssPolling(config: Config): void {
  // Start even without channels; a later Web UI save can add the first one.
  if (!config.rssEnabled) return;
  const intervalMs = Math.max(1, config.rssPollIntervalMinutes) * 60_000;
  console.log(`RSS polling enabled: ${config.channels.length} channel(s), every ${config.rssPollIntervalMinutes} min.`);
  // First pass shortly after startup (ingest dedup makes it harmless), then
  // once per configured interval. The in-flight guard keeps a slow poll (dead
  // network, stuck yt-dlp) from overlapping with the next tick.
  let inFlight = false;
  const tick = async () => {
    const current = getConfig();
    if (inFlight || !current.rssEnabled) return;
    inFlight = true;
    try {
      for (const channel of current.channels) {
        try {
          const added = await pollChannelRss(channel, current);
          if (added > 0) console.log(`RSS: ${added} new video(s) from ${channel}`);
        } catch (e: any) {
          logError("rss", `${channel}: ${e?.message || e}`);
        }
      }
    } finally {
      inFlight = false;
    }
  };
  setTimeout(tick, Math.min(intervalMs, 2 * 60_000));
  setInterval(tick, intervalMs);
}
