// src/sources.ts — validate, classify and remember Web UI source URLs.
// User data belongs in config.json, never in src/config.ts's shipped defaults.

import { CONFIG_PATH, saveConfig, withConfigWriteLock, type Config } from "./config";
import { getConfig, setConfig } from "./state";

export const SOURCE_KEYS = ["playlists", "channels", "channelPlaylists"] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];
export interface SourceUrl {
  url: string;
  key: SourceKey;
}

/** Canonical identities ignore share/tracking params, not playlist/video ids. */
export function parseSourceUrl(input: unknown): SourceUrl {
  if (typeof input !== "string" || !input.trim()) throw new Error("YouTube URL required");
  const text = input.trim();
  if (text.length > 8192 || /[\x00-\x20\x7f]/.test(text)) throw new Error("Invalid YouTube URL");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("Enter a full YouTube URL starting with https://");
  }
  const host = parsed.hostname.toLowerCase();
  const short = host === "youtu.be" || host === "www.youtu.be";
  const youtube = host === "youtube.com" || host.endsWith(".youtube.com");
  if ((!short && !youtube) || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) {
    throw new Error("Enter a YouTube playlist, channel or video URL");
  }

  // A watch/share link with a list id refers to the playlist, not just its
  // currently selected video. Never run it through normalizeVideoUrl(), which
  // deliberately strips the list id when recording individual jobs.
  const list = parsed.searchParams.get("list");
  if (list !== null) {
    if (!/^[\w-]+$/.test(list)) throw new Error("Invalid YouTube playlist id");
    return { key: "playlists", url: `https://www.youtube.com/playlist?list=${list}` };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const video = short
    ? path.slice(1)
    : path === "/watch"
      ? parsed.searchParams.get("v")
      : path.match(/^\/(?:shorts|live|embed)\/([\w-]+)$/)?.[1];
  if (video && /^[\w-]{6,}$/.test(video)) {
    // The existing playlists collection also accepts single-video sources.
    return { key: "playlists", url: `https://www.youtube.com/watch?v=${video}` };
  }
  const channelPath = path.match(/^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)(?:\/(featured|videos|shorts|streams|playlists|live))?$/);
  if (youtube && channelPath) {
    return {
      key: channelPath[1] === "playlists" ? "channelPlaylists" : "channels",
      url: `https://www.youtube.com${path}`,
    };
  }
  throw new Error("Enter a YouTube playlist, channel or video URL");
}

function sameSource(existing: string, source: SourceUrl): boolean {
  try {
    return parseSourceUrl(existing).url === source.url;
  } catch {
    // Legacy/manual config entries must not prevent saving another source.
    return existing.trim() === source.url;
  }
}

/**
 * Persist BEFORE queuing work. The lock is shared with dashboard settings:
 * read the latest config inside it, so concurrent scans/settings cannot drop
 * each other's changes. Nothing becomes live unless the write succeeds.
 */
export async function saveSource(input: unknown, configPath: string = CONFIG_PATH): Promise<SourceUrl & { added: boolean }> {
  const source = parseSourceUrl(input);
  return withConfigWriteLock(async () => {
    const current = getConfig();
    const existingKey = SOURCE_KEYS.find((key) => current[key].some((url) => sameSource(url, source)));
    const key = existingKey || source.key;
    const next: Config = existingKey ? current : { ...current, [key]: [...current[key], source.url] };
    // Also write on duplicate scans: a URL already in the DB is not evidence
    // it is configured, and a config file removed mid-run can be restored.
    await saveConfig(next, configPath);
    setConfig(next);
    return { ...source, key, added: !existingKey };
  });
}
