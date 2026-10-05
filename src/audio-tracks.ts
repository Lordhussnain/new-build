// src/audio-tracks.ts — YouTube multi-audio track discovery and selection.
//
// YouTube now ships videos with several audio tracks (the player's "Audio
// track" menu: an original language plus auto-dubbed ones). yt-dlp exposes
// each track as its own audio-only format:
//   • the format id carries the track index (`251-0`, `251-1`, …);
//   • the same track reappears once per quality/codec variant (`251-1`,
//     `249-1`, `140-1`);
//   • Dynamic Range Compression duplicates of every stream end in `-drc`.
//
// This module turns that format soup into a clean track list (best stream per
// track), decides which tracks a job wants (global mode + language filter +
// per-job override), and builds the yt-dlp selector that pulls them all into
// one file (`--audio-multistreams`). Parsing / selection / selector building
// are pure and unit-tested; `probeAudioTracks` is the only function that
// spawns yt-dlp (one `-J` metadata call per job).

import { cookiesArgs, ytDlp } from "./tools";
import type { MultiAudioMode } from "./config";

export interface AudioTrack {
  /** Best yt-dlp format id for this track (e.g. `251-1`). */
  formatId: string;
  /** Language code as reported by yt-dlp (`en`, `es`, `und` when unknown). */
  language: string;
  /** Human label for pickers (yt-dlp's display name when it provides one). */
  label: string;
  /** Total bitrate (kbps) of the chosen stream, when known. */
  tbr: number | null;
  acodec: string | null;
  /** The video's first track — YouTube's "original". */
  isDefault: boolean;
}

const DRC_SUFFIX = /-drc$/i;
const TRACK_INDEX_SUFFIX = /-(\d+)$/;

/** Track index encoded in a YouTube audio format id (`251-2` → 2). */
export function trackIndexOf(formatId: string): number {
  const m = formatId.match(TRACK_INDEX_SUFFIX);
  return m ? parseInt(m[1], 10) : 0;
}

function trackLabel(f: Record<string, unknown>, language: string): string {
  const at = f.audio_track;
  if (typeof at === "string" && at.trim()) return at.trim();
  if (at && typeof at === "object") {
    const o = at as Record<string, unknown>;
    for (const k of ["display_name", "displayName", "name", "id"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return language;
}

/** Best stream first: bitrate, then Opus, then a deterministic tie-break. */
function preferStream(a: AudioTrack, b: AudioTrack): number {
  const ta = a.tbr ?? -1;
  const tb = b.tbr ?? -1;
  if (ta !== tb) return tb - ta;
  const oa = a.acodec?.includes("opus") ? 1 : 0;
  const ob = b.acodec?.includes("opus") ? 1 : 0;
  if (oa !== ob) return ob - oa;
  return a.formatId.localeCompare(b.formatId);
}

/**
 * Parse yt-dlp `-J` output into one entry per audio track.
 *
 * Only audio-only formats count (combined/progressive formats are ignored),
 * `-drc` duplicates are dropped, and quality variants of the same track
 * collapse to their best stream. Tracks come back in video order: the
 * default/original track first, then by track index.
 */
export function extractAudioTracks(info: unknown): AudioTrack[] {
  const formats = (info as { formats?: unknown } | null)?.formats;
  if (!Array.isArray(formats)) return [];

  const groups = new Map<string, AudioTrack[]>();
  for (const raw of formats) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const formatId = typeof f.format_id === "string" ? f.format_id : "";
    if (!formatId) continue;
    const acodec = typeof f.acodec === "string" ? f.acodec : "";
    const vcodec = typeof f.vcodec === "string" ? f.vcodec : "";
    if (!acodec || acodec === "none") continue;
    if (vcodec && vcodec !== "none") continue;
    if (DRC_SUFFIX.test(formatId)) continue;

    const trackIndex = trackIndexOf(formatId);
    const language =
      (typeof f.language === "string" && f.language.trim()) || "und";
    const track: AudioTrack = {
      formatId,
      language,
      label: trackLabel(f, language),
      tbr: typeof f.tbr === "number" && Number.isFinite(f.tbr) ? f.tbr : null,
      acodec,
      isDefault: trackIndex === 0,
    };
    const key = `${language.toLowerCase()}::${trackIndex}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(track);
    else groups.set(key, [track]);
  }

  const tracks: AudioTrack[] = [];
  for (const bucket of groups.values()) {
    bucket.sort(preferStream);
    tracks.push(bucket[0]);
  }
  tracks.sort(
    (a, b) =>
      trackIndexOf(a.formatId) - trackIndexOf(b.formatId) ||
      a.language.localeCompare(b.language),
  );
  return tracks;
}

function normalizeLangs(values?: string[] | null): Set<string> {
  return new Set(
    (values ?? [])
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Which of `tracks` a job should download.
 *
 * A per-job selection (the dashboard's checkbox list of language codes) always
 * wins over the global mode; an empty/absent selection means "follow the
 * global mode". `off` selects nothing — the caller falls back to the classic
 * single-track format selection.
 */
export function selectAudioTracks(
  tracks: AudioTrack[],
  mode: MultiAudioMode,
  wantedLanguages: string[],
  jobSelection?: string[] | null,
): AudioTrack[] {
  const selection = normalizeLangs(jobSelection);
  if (selection.size > 0) {
    return tracks.filter((t) => selection.has(t.language.toLowerCase()));
  }
  if (mode === "all") return [...tracks];
  if (mode === "languages") {
    const wanted = normalizeLangs(wantedLanguages);
    if (wanted.size === 0) return [];
    return tracks.filter((t) => wanted.has(t.language.toLowerCase()));
  }
  return [];
}

/**
 * Splice explicit audio format ids into a QUALITY_FORMATS preset:
 * `bv[height<=1080]+ba/b[height<=1080]` + `[251-0, 251-1]` becomes
 * `bv[height<=1080]+251-0+251-1/b[height<=1080]`. The video side and the
 * fallback of the preset are preserved.
 */
export function multiAudioFormatSelector(
  baseFormat: string,
  tracks: AudioTrack[],
): string {
  const [primary, ...fallbackParts] = baseFormat.split("/");
  const fallback = fallbackParts.join("/");
  const videoSide = primary.split("+")[0];
  const ids = tracks.map((t) => t.formatId).join("+");
  return fallback ? `${videoSide}+${ids}/${fallback}` : `${videoSide}+${ids}`;
}

/**
 * One cheap yt-dlp metadata call listing the video's audio tracks. Throws on
 * any failure — callers decide whether that is fatal (it never is for the
 * download worker: we just fall back to single-audio).
 */
export async function probeAudioTracks(
  url: string,
  config: { cookiesFile: string },
): Promise<AudioTrack[]> {
  const proc = Bun.spawn(
    [
      ytDlp(),
      url,
      ...cookiesArgs(config),
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      "--socket-timeout",
      "15",
      "--retries",
      "3",
      "--extractor-retries",
      "3",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      stderr
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" ") || `yt-dlp exited with code ${code}`,
    );
  }
  let info: unknown;
  try {
    info = JSON.parse(out);
  } catch {
    throw new Error("audio-track probe returned invalid JSON");
  }
  return extractAudioTracks(info);
}

/** Parse the `jobs.audio_tracks` JSON column (null = not probed yet). */
export function parseTracksJson(
  json: string | null | undefined,
): AudioTrack[] | null {
  if (json == null || json === "") return null;
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return null;
    return v.filter(
      (t): t is AudioTrack =>
        !!t && typeof t === "object" && typeof (t as AudioTrack).formatId === "string",
    );
  } catch {
    return null;
  }
}

/** Parse the `jobs.audio_selection` JSON column (null = follow global mode). */
export function parseSelectionJson(
  json: string | null | undefined,
): string[] | null {
  if (json == null || json === "") return null;
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return null;
    return v.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}
