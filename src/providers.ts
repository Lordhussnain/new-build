// src/providers.ts — everything site-specific about the sources this engine
// accepts: which site a URL belongs to, which of that site's URL shapes mean a
// single video / a list / a channel, and how to build the canonical video URL a
// job is downloaded from.
//
// Leaf module on purpose (zero app imports). `sources.ts` validates and
// canonicalizes operator input with it, `scanner.ts` turns listing entries into
// job URLs with it, and the engine/dashboard ask it which sites are actually in
// use (cookie probes, the network monitor). Adding a site means adding a host
// list plus a classifier branch HERE — nothing else in the engine knows or cares
// which site a job came from, because a job is only ever an id, a canonical URL,
// a title and a folder.
//
// Bilibili facts this encodes (read against yt-dlp's `bilibili.py`):
//   • videos — `/video/BV…` and `/video/av…`; an anthology (multi-part) video
//     adds `?p=N` and yt-dlp reports those entries as `<BV>_p<N>`; a
//     `/festival/<slug>?bvid=…` campaign page is the same video;
//     `/bangumi/play/ep<N>` (anime episode — a NUMERIC id, unlike BV…),
//     `/cheese/play/ep<N>` (paid course episode), `/audio/au<N>` (audio track).
//   • lists — `/bangumi/play/ss<N>` (season), `/bangumi/media/md<N>`,
//     `/cheese/play/ss<N>`, `/audio/am<N>` (album), `/medialist/detail/ml<N>`
//     and `space.bilibili.com/<mid>/favlist?fid=<N>` (favourites),
//     `space.bilibili.com/<mid>/lists/<sid>[?type=season|series]` plus
//     `/channel/collectiondetail?sid=` and `/channel/seriesdetail?sid=`
//     (collections/series), `/list/<mid>?sid=<sid>` and
//     `/medialist/play/<mid>?…` (series players), `/watchlater` (login only).
//   • channels — `space.bilibili.com/<mid>` (all uploads), `…/video`,
//     `…/upload/video`, `…/audio`, `…/upload/audio`.
//   • international (yt-dlp's BiliIntl) — `bilibili.tv` / `biliintl.com` with
//     `/<lang>/video/<aid>`, `/<lang>/play/<season>/<ep>` and `/<lang>/media/<id>`.
//   • `b23.tv/<code>` is a share short link. It cannot be canonicalized without
//     a network round-trip, so it is accepted as-is: yt-dlp's generic extractor
//     follows the redirect and re-dispatches to the right Bilibili extractor.
//   • a FLAT listing of a Bilibili list carries ids and URLs but no titles or
//     durations (yt-dlp builds those entries with `url_result(url, ie, id)`),
//     and a Bilibili space listing carries no playlist title either. Both gaps
//     are covered: `src/video-summary.ts` probes the missing title/duration
//     before a job's first download, and `channelFolderFallback` below names a
//     channel folder when the listing cannot.

/** Every site this engine accepts as a source. */
export type ProviderId = "youtube" | "bilibili";

/** Operator-facing site names (dashboard badges, log lines, reports). */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  youtube: "YouTube",
  bilibili: "Bilibili",
};

/** Stable iteration order: the historical provider first. */
export const PROVIDER_IDS: readonly ProviderId[] = ["youtube", "bilibili"];

/**
 * Registered domains per provider — every subdomain of these counts
 * (`m.bilibili.com`, `space.bilibili.com`, `youtu.be`). Matching is on the
 * hostname only, so `bilibili.com.evil.example` is NOT bilibili.com.
 */
const PROVIDER_HOSTS: Record<ProviderId, readonly string[]> = {
  youtube: ["youtube.com", "youtu.be"],
  // The main site, its share-link shortener, and the international platform.
  bilibili: ["bilibili.com", "b23.tv", "bilibili.tv", "biliintl.com"],
};

/** Which provider owns a hostname, or null for any other site. */
export function providerOfHost(host: string): ProviderId | null {
  const name = (host || "").trim().toLowerCase();
  if (!name) return null;
  for (const provider of PROVIDER_IDS) {
    for (const base of PROVIDER_HOSTS[provider]) {
      if (name === base || name.endsWith(`.${base}`)) return provider;
    }
  }
  return null;
}

/** Which provider a URL belongs to, or null when it is not one of ours. */
export function providerOfUrl(url: string): ProviderId | null {
  try {
    return providerOfHost(new URL(String(url || "").trim()).hostname);
  } catch {
    return null;
  }
}

/** The providers actually present in a set of source URLs, in stable order. */
export function providersOfSources(urls: Iterable<string>): ProviderId[] {
  const found = new Set<ProviderId>();
  for (const url of urls) {
    const provider = providerOfUrl(url);
    if (provider) found.add(provider);
  }
  return PROVIDER_IDS.filter((provider) => found.has(provider));
}

/**
 * The provider a listing belongs to when its source URL is not one of ours.
 *
 * Manual `config.json` entries have always been allowed to point anywhere
 * yt-dlp understands, and they were scanned and ingested with YouTube-shaped
 * assumptions. Keeping that default preserves their behaviour; such a source's
 * job URLs still come from yt-dlp's own printed page URL when this module
 * recognises it.
 */
export function listingProvider(url: string | null | undefined): ProviderId {
  return providerOfUrl(url || "") ?? "youtube";
}

// ---------------------------------------------------------------------------
// URL shapes
// ---------------------------------------------------------------------------

/**
 * What a source URL points at:
 *   `video`            one video (a Bilibili anthology page counts as one)
 *   `playlist`         a list of videos
 *   `channel`          an uploader's uploads (a YouTube tab, a Bilibili space)
 *   `channelPlaylists` a YouTube channel's /playlists tab (lists of lists)
 *   `unknown`          not a source this engine understands
 */
export type SourceShape = "video" | "playlist" | "channel" | "channelPlaylists" | "unknown";

export interface ClassifiedSource {
  provider: ProviderId;
  shape: SourceShape;
  /** Canonical URL: tracking junk removed, host and spelling normalised. */
  url: string;
}

/** A YouTube video id (`watch?v=`, `youtu.be/`, `/shorts/…`) — 6+ url-safe chars. */
const YOUTUBE_VIDEO_ID = /^[\w-]{6,}$/;

/**
 * Bilibili video ids: `BV…` (10-12 alphanumerics after the prefix) and the
 * legacy `av<digits>`, plus the suffixes yt-dlp appends for an anthology page
 * (`<BV>_p2`) or an interactive-video branch (`<BV>_<cid>`).
 */
const BILIBILI_VIDEO_ID = /^(?:[bB][vV][A-Za-z0-9]{6,14}|[aA][vV]\d{1,20})(?:_(?:p\d{1,4}|\d{1,20}))?$/;
/** Bilibili audio-track ids (`/audio/au123`). */
const BILIBILI_AUDIO_ID = /^au\d{1,20}$/;
/** Bangumi/cheese episode ids are plain numbers — no prefix at all. */
const BILIBILI_NUMERIC_ID = /^\d{1,20}$/;
/** b23.tv share codes. */
const BILIBILI_SHARE_CODE = /^[\w-]{4,64}$/;

/**
 * yt-dlp's playlist-id prefixes on YouTube (`PL…`, `UU…`, `UC…`). An entry
 * carrying one of these is a list, never a video, so a channel's /playlists tab
 * ingests nothing instead of queueing playlist ids as videos.
 */
export function isPlaylistLikeId(id: string): boolean {
  return id.length > 11 && /^(?:PL|UU|OL|FL|LL|RD|UC|VL|EL)/.test(id);
}

/**
 * Is `id` a real VIDEO id for this provider — i.e. may it become a job?
 *
 * Bilibili lists can contain nested lists: a "hidden-mode collection" shows up
 * inside a space's uploads as an entry whose id is `<mid>_<sid>`, and queueing
 * one would create a job that can never download. YouTube's equivalent rule is
 * the playlist-id prefix check above, and is applied exactly as before so no
 * listing that used to ingest stops doing so.
 */
export function isListingVideoId(provider: ProviderId, id: string): boolean {
  const value = (id || "").trim();
  if (!value) return false;
  if (provider === "bilibili") {
    return BILIBILI_VIDEO_ID.test(value) || BILIBILI_AUDIO_ID.test(value) || BILIBILI_NUMERIC_ID.test(value);
  }
  return !isPlaylistLikeId(value);
}

/**
 * A positive integer query parameter, kept as its digits. Bilibili's favourite
 * and series ids run to 10+ digits, which is past `Number.MAX_SAFE_INTEGER`
 * territory for the longest of them — they are identifiers, never quantities,
 * so they are validated and copied as text.
 */
function positiveDigitsParam(value: string | null): string | null {
  const digits = (value || "").trim();
  if (!/^\d{1,20}$/.test(digits)) return null;
  return /^0+$/.test(digits) ? null : digits;
}

function isB23Host(host: string): boolean {
  return host === "b23.tv" || host.endsWith(".b23.tv");
}

/**
 * Drop bilibili.com's optional UI-language prefix (`/en/video/BV…`,
 * `/ja/bangumi/play/ep…`): the main host serves the international layout under a
 * two-letter segment, but the page — and yt-dlp's BiliBiliIE pattern — is the
 * un-prefixed one, so the prefix is presentation, never identity. Only a segment
 * followed by another path segment (or nothing) is a candidate, and only known
 * shapes match afterwards, so `/video/…` and every other path is untouched.
 */
function stripBilibiliLangPrefix(path: string): string {
  if (!/^\/[a-zA-Z]{2}(?:\/|$)/.test(path)) return path;
  return path.slice(3) || "/";
}

/** The same URL with that prefix removed, for matching against known shapes. */
function withoutBilibiliLangPrefix(parsed: URL): URL {
  const path = parsed.pathname.replace(/\/+$/, "");
  const bare = stripBilibiliLangPrefix(path);
  if (bare === path) return parsed;
  return new URL(`${parsed.origin}${bare}${parsed.search}`);
}

function isIntlHost(host: string): boolean {
  return (
    host === "bilibili.tv" || host.endsWith(".bilibili.tv") ||
    host === "biliintl.com" || host.endsWith(".biliintl.com")
  );
}

/**
 * The canonical single-video URL for any supported site, or null when `input`
 * is not a video URL (a playlist, a channel, an expired CDN stream link, junk).
 *
 * This is the gate that keeps a printed `%(url)s` — which on a FULLY extracted
 * video is the *selected format's* stream URL, a signed CDN address that expires
 * in hours — out of the jobs table. Only a page URL survives it.
 */
export function canonicalVideoUrl(input: string): string | null {
  const text = String(input ?? "").trim();
  if (!text || text === "NA") return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(parsed.protocol)) return null;
  const provider = providerOfHost(parsed.hostname);
  if (!provider) return null;
  return provider === "youtube" ? canonicalYouTubeVideo(parsed) : canonicalBilibiliVideo(parsed);
}

function canonicalYouTubeVideo(parsed: URL): string | null {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");
  const short = host === "youtu.be" || host === "www.youtu.be";
  const video = short
    ? path.slice(1).split("/")[0]
    : path === "/watch"
      ? parsed.searchParams.get("v")
      : path.match(/^\/(?:shorts|live|embed)\/([\w-]+)$/)?.[1];
  if (!video || !YOUTUBE_VIDEO_ID.test(video)) return null;
  return `https://www.youtube.com/watch?v=${video}`;
}

function canonicalBilibiliVideo(parsed: URL): string | null {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");

  if (isIntlHost(host)) {
    // /<lang>/video/<aid>, /<lang>/play/<season>[/<ep>] — the language segment
    // is optional and case-insensitive in yt-dlp's own pattern.
    const match = path.match(/^(?:\/([a-zA-Z]{2}))?\/(video|play)\/(\d{1,20})(?:\/(\d{1,20}))?$/);
    if (!match) return null;
    const lang = (match[1] || "en").toLowerCase();
    if (match[2] === "video") {
      return match[4] ? null : `https://www.bilibili.tv/${lang}/video/${match[3]}`;
    }
    return match[4]
      ? `https://www.bilibili.tv/${lang}/play/${match[3]}/${match[4]}`
      : `https://www.bilibili.tv/${lang}/play/${match[3]}`;
  }

  // A share short link points at *something* on bilibili.com, but which is only
  // knowable by following it — leave that to yt-dlp and keep the link verbatim.
  if (isB23Host(host)) return null;

  // The international layout on the main host: /en/video/BV… is /video/BV…
  parsed = withoutBilibiliLangPrefix(parsed);
  const barePath = parsed.pathname.replace(/\/+$/, "");

  const video = barePath.match(/^\/video\/([A-Za-z0-9]+)$/);
  if (video && BILIBILI_VIDEO_ID.test(video[1])) {
    // `?p=N` selects one page of an anthology and MUST survive: without it
    // yt-dlp treats the URL as the whole anthology and downloads every page
    // into the same output template.
    const page = positiveDigitsParam(parsed.searchParams.get("p"));
    return `https://www.bilibili.com/video/${video[1]}${page ? `?p=${page}` : ""}`;
  }
  const bvid = parsed.searchParams.get("bvid");
  if (/^\/festival\/[^/]+$/.test(barePath) && bvid && BILIBILI_VIDEO_ID.test(bvid)) {
    // Same video through a campaign page: one identity, the plain video URL.
    return `https://www.bilibili.com/video/${bvid}`;
  }
  const bangumi = barePath.match(/^\/bangumi\/play\/ep(\d{1,20})$/i);
  if (bangumi) return `https://www.bilibili.com/bangumi/play/ep${bangumi[1]}`;
  const cheese = barePath.match(/^\/cheese\/play\/ep(\d{1,20})$/i);
  if (cheese) return `https://www.bilibili.com/cheese/play/ep${cheese[1]}`;
  const audio = barePath.match(/^\/audio\/au(\d{1,20})$/i);
  if (audio) return `https://www.bilibili.com/audio/au${audio[1]}`;
  return null;
}

/**
 * Canonical form of a video URL: tracking/timestamp junk stripped and short
 * links folded into the site's own page URL, so the same video always produces
 * the same stored job URL however it was discovered. Anything that is not a
 * recognised video URL is returned trimmed and unchanged.
 */
export function normalizeVideoUrl(url: string): string {
  const trimmed = String(url || "").trim();
  if (!trimmed) return trimmed;
  return canonicalVideoUrl(trimmed) ?? trimmed;
}

/**
 * The site a bare video id belongs to, for the rows that have no URL to read.
 * Bilibili ids are unmistakable (`BV…`, `av…`, `au…`); everything else keeps
 * the historical YouTube reading, including the numeric-only ids a Bilibili
 * bangumi listing produces — those are only ever resolved with their source.
 */
export function providerOfVideoId(id: string): ProviderId {
  const value = (id || "").trim();
  return BILIBILI_VIDEO_ID.test(value) || BILIBILI_AUDIO_ID.test(value) ? "bilibili" : "youtube";
}

/**
 * The URL to record for a video id when no better URL is known (a legacy row
 * with an empty `url`, an ignore tombstone). Never empty for a non-empty id.
 */
export function fallbackVideoUrl(id: string): string {
  return videoUrlForId(providerOfVideoId(id), id) || String(id || "").trim();
}

/**
 * The canonical URL for a video id when nothing better is known.
 *
 * Numeric Bilibili ids are ambiguous on their own (a bangumi episode, a cheese
 * episode and an international episode are all plain numbers), so `contextUrl`
 * — the source the listing came from — decides. Returns null when the id cannot
 * be turned into a URL at all; the caller then falls back to the source URL.
 */
export function videoUrlForId(
  provider: ProviderId,
  id: string,
  contextUrl?: string | null,
): string | null {
  const value = (id || "").trim();
  if (!value) return null;
  if (provider === "youtube") {
    // No length rule here: a listing that produced the id is the authority on
    // it being a video, and the playlist-id filter already ran.
    return isPlaylistLikeId(value) ? null : `https://www.youtube.com/watch?v=${value}`;
  }
  if (BILIBILI_VIDEO_ID.test(value)) {
    // `<BV>_p3` is yt-dlp's id for page 3 of an anthology; the interactive-video
    // branch id `<BV>_<cid>` has no page form, so the video URL is the best
    // available address for it (yt-dlp then lists that video's branches again).
    const page = value.match(/^([A-Za-z0-9]+)_p(\d{1,4})$/);
    return page
      ? `https://www.bilibili.com/video/${page[1]}?p=${page[2]}`
      : `https://www.bilibili.com/video/${value.split("_")[0]}`;
  }
  if (BILIBILI_AUDIO_ID.test(value)) return `https://www.bilibili.com/audio/${value}`;
  if (BILIBILI_NUMERIC_ID.test(value)) {
    // Only the source can say what a bare number is: a bangumi season lists
    // bangumi episodes, a cheese season lists course episodes, and anything
    // else (a space, a favourites list, an international series) yields BV ids
    // that never reach this branch.
    const path = urlPath(contextUrl);
    if (/^\/cheese\/play\/ss\d+$/i.test(path)) return `https://www.bilibili.com/cheese/play/ep${value}`;
    if (/^\/bangumi\/(?:play\/ss\d+|media\/md\d+)$/i.test(path)) {
      return `https://www.bilibili.com/bangumi/play/ep${value}`;
    }
  }
  return null;
}

/** The pathname (trailing slashes removed) of a URL, or "" when unparsable. */
function urlPath(url: string | null | undefined): string {
  try {
    return new URL(String(url || "").trim()).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * The URL a listing entry becomes a job with.
 *
 * Preference order, each step strictly validated:
 *   1. what yt-dlp printed for the entry — `%(webpage_url)s` on a fully
 *      extracted video, `%(url)s` on a flat entry (for YouTube that is the bare
 *      id, and on a full extraction it is the format's CDN URL, so both are
 *      rejected by `canonicalVideoUrl` unless they really are a page URL);
 *   2. the source URL itself, when the source IS one video (a single-video
 *      scan), adjusted for the anthology page the entry id names;
 *   3. the id, read through the source's shape (bangumi/cheese episodes are
 *      bare numbers).
 */
export function resolveListingVideoUrl(opts: {
  id: string;
  provider: ProviderId;
  sourceUrl?: string | null;
  /** `%(webpage_url)s` from the listing. */
  webpageUrl?: string | null;
  /** `%(url)s` from the listing. */
  printedUrl?: string | null;
}): string {
  for (const candidate of [opts.webpageUrl, opts.printedUrl]) {
    const canonical = canonicalVideoUrl(candidate || "");
    if (canonical) return canonical;
  }
  const source = (opts.sourceUrl || "").trim();
  const sourceVideo = canonicalVideoUrl(source);
  if (sourceVideo) return withAnthologyPage(sourceVideo, opts.id);
  return videoUrlForId(opts.provider, opts.id, source) || source;
}

/**
 * `<BV>_p3` against a source URL that names no page: keep the page, or the
 * download fetches the whole anthology into one output template.
 */
function withAnthologyPage(videoUrl: string, id: string): string {
  const page = (id || "").match(/^[A-Za-z0-9]+_p(\d{1,4})$/);
  if (!page) return videoUrl;
  try {
    const parsed = new URL(videoUrl);
    if (parsed.searchParams.get("p")) return videoUrl;
    parsed.searchParams.set("p", page[1]);
    return parsed.toString();
  } catch {
    return videoUrl;
  }
}

// ---------------------------------------------------------------------------
// Source classification (what the Web UI saves into config.json)
// ---------------------------------------------------------------------------

export interface ClassifySourceOptions {
  /**
   * A link that carries both a video and a list (`watch?v=ID&list=PL…`, or
   * Bilibili's `/list/<mid>?sid=…&bvid=…`) normally means the list. With
   * `singleVideo` the video wins and the list is dropped.
   */
  singleVideo?: boolean;
}

/**
 * Classify and canonicalize one source URL. Returns null for a URL that is not
 * a source this engine understands (the caller decides the message), and THROWS
 * for a malformed id so a typo is reported instead of silently saving a link
 * that can never scan.
 */
export function classifySourceUrl(
  input: unknown,
  opts: ClassifySourceOptions = {},
): ClassifiedSource | null {
  if (typeof input !== "string" || !input.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  const provider = providerOfHost(parsed.hostname);
  if (!provider) return null;
  return provider === "youtube" ? classifyYouTubeSource(parsed, opts) : classifyBilibiliSource(parsed, opts);
}

/** Non-throwing shape lookup, for counting and display. */
export function sourceShape(url: string): SourceShape {
  try {
    return classifySourceUrl(url)?.shape ?? "unknown";
  } catch {
    return "unknown";
  }
}

function classifyYouTubeSource(parsed: URL, opts: ClassifySourceOptions): ClassifiedSource | null {
  const host = parsed.hostname.toLowerCase();
  const short = host === "youtu.be" || host === "www.youtu.be";
  const youtube = host === "youtube.com" || host.endsWith(".youtube.com");
  if (!short && !youtube) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  const video = short
    ? path.slice(1)
    : path === "/watch"
      ? parsed.searchParams.get("v")
      : path.match(/^\/(?:shorts|live|embed)\/([\w-]+)$/)?.[1];
  const hasVideo = Boolean(video && YOUTUBE_VIDEO_ID.test(video));

  // Explicit "single video only": keep the video id and ignore the playlist id.
  if (opts.singleVideo && hasVideo) {
    return { provider: "youtube", shape: "video", url: `https://www.youtube.com/watch?v=${video}` };
  }
  // A watch/share link with a list id refers to the playlist, not just its
  // currently selected video.
  const list = parsed.searchParams.get("list");
  if (list !== null) {
    if (!/^[\w-]+$/.test(list)) throw new Error("Invalid YouTube playlist id");
    return { provider: "youtube", shape: "playlist", url: `https://www.youtube.com/playlist?list=${list}` };
  }
  if (hasVideo) {
    return { provider: "youtube", shape: "video", url: `https://www.youtube.com/watch?v=${video}` };
  }
  const channelPath = path.match(
    /^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)(?:\/(featured|videos|shorts|streams|playlists|live))?$/,
  );
  if (channelPath) {
    return {
      provider: "youtube",
      shape: channelPath[1] === "playlists" ? "channelPlaylists" : "channel",
      url: `https://www.youtube.com${path}`,
    };
  }
  return null;
}

function classifyBilibiliSource(parsed: URL, opts: ClassifySourceOptions): ClassifiedSource | null {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");
  const shape = (shape: SourceShape, url: string): ClassifiedSource => ({ provider: "bilibili", shape, url });

  if (isIntlHost(host)) {
    const langMatch = path.match(/^\/([a-zA-Z]{2})(?:\/|$)/);
    const lang = (langMatch?.[1] || "en").toLowerCase();
    const rest = (langMatch ? path.slice(3) : path) || "/";
    const video = canonicalBilibiliVideo(new URL(`https://www.bilibili.tv/${lang}${rest}${parsed.search}`));
    if (video) return shape("video", video);
    const media = rest.match(/^\/media\/(\d{1,20})$/);
    if (media) return shape("playlist", `https://www.bilibili.tv/${lang}/media/${media[1]}`);
    return null;
  }

  if (isB23Host(host)) {
    // Unresolvable offline; yt-dlp follows the redirect itself. Almost always a
    // single video, so it lands in the same bucket as one.
    const code = path.slice(1);
    if (!BILIBILI_SHARE_CODE.test(code)) return null;
    return shape("video", `https://b23.tv/${code}`);
  }

  // The international layout on the main host is the same source underneath:
  // strip the language prefix once, for the video gate and every list shape.
  parsed = withoutBilibiliLangPrefix(parsed);
  const barePath = parsed.pathname.replace(/\/+$/, "");

  const video = canonicalBilibiliVideo(parsed);
  if (video) return shape("video", video);

  // "Single video only" for the series players, which carry the video id in the
  // query: /list/<mid>?sid=<sid>&oid=<aid>&bvid=<BV…>
  if (opts.singleVideo && /^\/(?:list|medialist\/play)\/[\w-]+$/.test(barePath)) {
    const bvid = parsed.searchParams.get("bvid");
    const oid = parsed.searchParams.get("oid");
    if (bvid && BILIBILI_VIDEO_ID.test(bvid)) return shape("video", `https://www.bilibili.com/video/${bvid}`);
    if (oid && BILIBILI_NUMERIC_ID.test(oid)) return shape("video", `https://www.bilibili.com/video/av${oid}`);
  }

  if (host === "space.bilibili.com") {
    const mid = path.match(/^\/(\d{1,20})(?:$|\/)/)?.[1];
    if (!mid) return null;
    const favlist = /^\/\d{1,20}\/favlist$/.test(path);
    if (favlist) {
      const fid = positiveDigitsParam(parsed.searchParams.get("fid"));
      if (!fid) return null;
      return shape("playlist", `https://space.bilibili.com/${mid}/favlist?fid=${fid}`);
    }
    const list = path.match(/^\/\d{1,20}\/lists\/(\d{1,20})$/);
    if (list) {
      // `type=season` vs `type=series` selects a DIFFERENT extractor (and a
      // different list) for the same numeric id, so it is part of the identity.
      const type = parsed.searchParams.get("type");
      const keepType = type === "season" || type === "series" ? `?type=${type}` : "";
      return shape("playlist", `https://space.bilibili.com/${mid}/lists/${list[1]}${keepType}`);
    }
    const detail = path.match(/^\/\d{1,20}\/channel\/(collectiondetail|seriesdetail)$/);
    if (detail) {
      const sid = positiveDigitsParam(parsed.searchParams.get("sid"));
      if (!sid) return null;
      return shape("playlist", `https://space.bilibili.com/${mid}/channel/${detail[1]}?sid=${sid}`);
    }
    if (/^\/\d{1,20}$/.test(path)) return shape("channel", `https://space.bilibili.com/${mid}`);
    if (/^\/\d{1,20}\/(?:upload\/)?video$/.test(path)) return shape("channel", `https://space.bilibili.com/${mid}/video`);
    if (/^\/\d{1,20}\/(?:upload\/)?audio$/.test(path)) return shape("channel", `https://space.bilibili.com/${mid}/audio`);
    return null;
  }

  // Main-site lists.
  const bangumiSeason = barePath.match(/^\/bangumi\/play\/ss(\d{1,20})$/i);
  if (bangumiSeason) return shape("playlist", `https://www.bilibili.com/bangumi/play/ss${bangumiSeason[1]}`);
  const bangumiMedia = barePath.match(/^\/bangumi\/media\/md(\d{1,20})$/i);
  if (bangumiMedia) return shape("playlist", `https://www.bilibili.com/bangumi/media/md${bangumiMedia[1]}`);
  const cheeseSeason = barePath.match(/^\/cheese\/play\/ss(\d{1,20})$/i);
  if (cheeseSeason) return shape("playlist", `https://www.bilibili.com/cheese/play/ss${cheeseSeason[1]}`);
  const audioAlbum = barePath.match(/^\/audio\/am(\d{1,20})$/i);
  if (audioAlbum) return shape("playlist", `https://www.bilibili.com/audio/am${audioAlbum[1]}`);
  const medialist = barePath.match(/^\/medialist\/detail\/ml(\d{1,20})$/i);
  if (medialist) return shape("playlist", `https://www.bilibili.com/medialist/detail/ml${medialist[1]}`);
  if (/^\/watchlater$/.test(barePath)) return shape("playlist", "https://www.bilibili.com/watchlater");
  if (/^\/(?:list|medialist\/play)\/[\w-]+$/.test(barePath)) {
    // `sid` (and `business`, which tells the player which series it is) decide
    // what is listed; `oid`/`bvid` only point at the video the share link
    // happened to open, so dropping them keeps one identity per list. Kept
    // parameters stay in the order they were pasted.
    const keep = new Set(["sid", "business"]);
    const kept: [string, string][] = [];
    for (const [key, value] of parsed.searchParams) {
      if (keep.has(key.toLowerCase()) && value && !kept.some(([k]) => k === key)) kept.push([key, value]);
    }
    const query = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : "";
    return shape("playlist", `https://www.bilibili.com${barePath}${query}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fallbacks for what a listing does not tell us
// ---------------------------------------------------------------------------

/**
 * The folder a channel's videos go into when the listing carries no channel or
 * playlist name. A Bilibili space listing has neither (yt-dlp builds it with
 * `playlist_result(entries, mid)`), so without this an entire uploader's
 * archive would land in "Single Videos" next to everybody else's.
 */
export function channelFolderFallback(sourceUrl: string | null | undefined): string {
  const source = (sourceUrl || "").trim();
  if (!source) return "";
  try {
    const parsed = new URL(source);
    if (parsed.hostname.toLowerCase() !== "space.bilibili.com") return "";
    const path = parsed.pathname.replace(/\/+$/, "");
    const mid = path.match(/^\/(\d{1,20})(?:\/|$)/)?.[1];
    if (!mid) return "";
    return /\/(?:upload\/)?audio$/.test(path) ? `Bilibili UP ${mid} Audio` : `Bilibili UP ${mid}`;
  } catch {
    return "";
  }
}

/**
 * One public, cookie-free video per provider, used to prove a cookie source is
 * readable. Probing only YouTube would throw away a perfectly good
 * `cookies.txt` for an operator whose network cannot reach YouTube at all —
 * which is exactly the operator a Bilibili archive belongs to.
 */
export const COOKIE_PROBE_URLS: Record<ProviderId, string> = {
  youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  bilibili: "https://www.bilibili.com/video/BV1GJ411x7h7",
};

/**
 * Cookie-probe URLs for a set of configured sources: one per provider in use,
 * in the order they should be tried, always ending with the historical YouTube
 * probe so an empty configuration behaves exactly as it always has.
 */
export function cookieProbeUrls(sources: Iterable<string>): string[] {
  const urls = providersOfSources(sources).map((provider) => COOKIE_PROBE_URLS[provider]);
  if (!urls.includes(COOKIE_PROBE_URLS.youtube)) urls.push(COOKIE_PROBE_URLS.youtube);
  return urls;
}

/**
 * Hosts the network monitor probes, in order. The first reachable host means
 * "online", so the providers actually configured come first: an operator who
 * archives Bilibili from a network that blocks YouTube must not have the engine
 * paused because a YouTube favicon never answered.
 */
export function networkProbeUrls(sources: Iterable<string>): string[] {
  const perProvider: Record<ProviderId, string[]> = {
    youtube: [
      "https://www.youtube.com/favicon.ico",
      "https://youtu.be/favicon.ico",
      "https://manifest.googlevideo.com/favicon.ico",
    ],
    bilibili: ["https://www.bilibili.com/favicon.ico", "https://space.bilibili.com/favicon.ico"],
  };
  const generic = ["https://1.1.1.1", "https://www.google.com/favicon.ico", "https://cloudflare.com/cdn-cgi/trace"];
  const ordered: string[] = [];
  for (const provider of providersOfSources(sources)) ordered.push(...perProvider[provider]);
  // Providers nobody configured still get probed, just after the ones in use.
  for (const provider of PROVIDER_IDS) {
    for (const url of perProvider[provider]) if (!ordered.includes(url)) ordered.push(url);
  }
  return [...ordered, ...generic];
}
