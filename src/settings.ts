// src/settings.ts — the subset of config the dashboard may read and change.
//
// The dashboard is a control surface for the downloader, not a config file
// editor: it must not be able to rewrite playlists, credentials, or the network
// binding. So this module is the single allow-list of editable keys, each with
// the metadata the UI needs to render a correct input (type, range, help text).
//
// Anything not listed here is invisible and immutable through the API — a
// request naming an unlisted key is rejected rather than silently dropped, so
// the UI and the engine can never disagree about what is tunable.

import { CONFIG_PATH, ConfigSchema, DEFAULT_CONFIG, saveConfig, type Config } from "./config";
import { setConfig } from "./state";

export type SettingType = "number" | "boolean" | "text" | "select" | "list";

export interface SettingField {
  key: keyof Config;
  label: string;
  type: SettingType;
  help: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  /** Rough unit hint for the UI (KB/s, minutes, …). */
  unit?: string;
  group: "downloader" | "media" | "concurrency" | "reliability";
}

/**
 * The editable knobs, grouped for the settings panel.
 *
 * Ranges mirror the Zod schema so the UI never offers a value the engine would
 * reject — but the schema is still the authority and re-validates on save.
 */
export const EDITABLE_SETTINGS: SettingField[] = [
  // --- downloader -----------------------------------------------------------
  {
    key: "useAria2c",
    label: "Use aria2c",
    type: "boolean",
    group: "downloader",
    help: "Multi-connection downloads. Falls back to yt-dlp's native downloader when aria2c is not installed, or for HLS/live streams.",
  },
  {
    key: "connectionsPerDownload",
    label: "Connections per download",
    type: "number",
    min: 1,
    max: 64,
    group: "downloader",
    help: "aria2c -s/-j split granularity. aria2c hard-caps per-server connections (-x) at 16 and the engine clamps it; higher values still split the file finer.",
  },
  {
    key: "minSplitSize",
    label: "Minimum split size",
    type: "text",
    group: "downloader",
    help: "Smallest file aria2c will split across connections (e.g. 1M). Must be an aria2c size like 512K or 1M — a value aria2c rejects pauses the engine (BAD_DOWNLOADER_ARGS) instead of failing every video.",
  },
  {
    key: "concurrentFragments",
    label: "Concurrent fragments",
    type: "number",
    min: 1,
    max: 64,
    group: "downloader",
    help: "Parallel DASH/HLS fragments for yt-dlp's native downloader.",
  },
  {
    key: "fragmentRetries",
    label: "Fragment retries",
    type: "number",
    min: 1,
    max: 50,
    group: "downloader",
    help: "Retries per fragment before the download fails.",
  },
  {
    key: "httpChunkSize",
    label: "HTTP chunk size",
    type: "text",
    group: "downloader",
    help: "Range-based chunking on the native path (e.g. 10M). Blank = off; some CDNs mishandle Range requests.",
  },
  {
    key: "bufferSize",
    label: "Download buffer size",
    type: "text",
    group: "downloader",
    help: "yt-dlp socket buffer (e.g. 16K). Blank = yt-dlp's default.",
  },
  {
    key: "maxBandwidthKBps",
    label: "Bandwidth cap",
    type: "number",
    min: 0,
    unit: "KB/s",
    group: "downloader",
    help: "Global cap, split across active download slots. 0 = unlimited.",
  },
  {
    key: "autoscaleRampStep",
    label: "Autoscale ramp step",
    type: "number",
    min: 1,
    max: 10,
    group: "downloader",
    help: "Download slots added per autoscale tick while the queue has backlog.",
  },
  // --- media ----------------------------------------------------------------
  {
    key: "targetFormat",
    label: "Target media format",
    type: "select",
    group: "media",
    options: [
      { value: "mp4", label: "MP4 (.mp4)" },
      { value: "mkv", label: "MKV (.mkv)" },
      { value: "webm", label: "WebM (.webm)" },
      { value: "mp3", label: "MP3 (.mp3)" },
      { value: "m4a", label: "M4A (.m4a)" },
    ],
    help: "Default media container format for downloaded videos and audio.",
  },
  {
    key: "subtitleFormat",
    label: "Subtitle format",
    type: "select",
    group: "media",
    options: [
      { value: "srt", label: "SRT (.srt)" },
      { value: "vtt", label: "VTT (.vtt)" },
      { value: "ass", label: "ASS (.ass)" },
      { value: "lrc", label: "LRC (.lrc)" },
    ],
    help: "File format for downloaded subtitles (converted by yt-dlp).",
  },
  {
    key: "multiAudioMode",
    label: "Multi-audio tracks",
    type: "select",
    group: "media",
    options: [
      { value: "off", label: "Off — single audio track" },
      { value: "all", label: "All tracks — every audio language" },
      { value: "languages", label: "Selected languages only" },
    ],
    help: "YouTube multi-language audio (the player's \"Audio track\" menu): mux every audio track into one MKV so the audio is switchable in any player, or restrict to the language list below. Per-video selection lives in each job's detail panel.",
  },
  {
    key: "audioTrackLanguages",
    label: "Audio track languages",
    type: "list",
    group: "media",
    help: "Comma-separated language codes kept when Multi-audio tracks is \"Selected languages only\" (e.g. en, ja, es). Empty = just the default track.",
  },
  // --- concurrency ----------------------------------------------------------
  {
    key: "maxConcurrentDownloads",
    label: "Download workers",
    type: "number",
    min: 1,
    max: 20,
    group: "concurrency",
    help: "Slots allowed to claim downloads. Autoscaling tunes within this ceiling.",
  },
  {
    key: "maxDownloadWorkers",
    label: "Max download workers",
    type: "number",
    min: 1,
    max: 20,
    group: "concurrency",
    help: "Autoscaler ceiling.",
  },
  {
    key: "minDownloadWorkers",
    label: "Min download workers",
    type: "number",
    min: 1,
    max: 20,
    group: "concurrency",
    help: "Autoscaler floor — slots kept alive even with an empty queue.",
  },
  {
    key: "maxConcurrentConverts",
    label: "Convert workers",
    type: "number",
    min: 1,
    max: 10,
    group: "concurrency",
    help: "Parallel ffmpeg conversions.",
  },
  {
    key: "maxMetadataWorkers",
    label: "Metadata workers",
    type: "number",
    min: 1,
    max: 10,
    group: "concurrency",
    help: "Parallel subtitle/thumbnail/description fetches.",
  },
  // --- reliability ----------------------------------------------------------
  {
    key: "maxResumeAttempts",
    label: "Max resume attempts",
    type: "number",
    min: 1,
    max: 20,
    group: "reliability",
    help: "How many times one video may resume from its partial before it restarts from scratch.",
  },
  {
    key: "retryBackoffBaseSeconds",
    label: "Backoff base",
    type: "number",
    min: 1,
    unit: "s",
    group: "reliability",
    help: "Base delay for retryable download failures; backoff grows with no-progress retries.",
  },
  {
    key: "retryBackoffMaxSeconds",
    label: "Backoff max",
    type: "number",
    min: 1,
    unit: "s",
    group: "reliability",
    help: "Ceiling for the exponential delay between no-progress retries.",
  },
  {
    key: "requeueFailedAfterMinutes",
    label: "Requeue failed after",
    type: "number",
    min: 0,
    unit: "min",
    group: "reliability",
    help: "Cooldown before failed jobs start a fresh retry window. 0 disables the sweep. Permanent download failures are never re-queued.",
  },
  {
    key: "downloadTimeoutMinutes",
    label: "Download timeout (min)",
    type: "number",
    min: 1,
    unit: "min",
    group: "reliability",
    help: "Minimum per-video timeout. The effective timeout scales with the video's real duration.",
  },
  {
    key: "maxDownloadMinutes",
    label: "Download timeout (max)",
    type: "number",
    min: 1,
    unit: "min",
    group: "reliability",
    help: "Ceiling for the duration-aware timeout.",
  },
];

const EDITABLE_KEYS = new Set<string>(EDITABLE_SETTINGS.map((f) => f.key));

/** True when the dashboard is allowed to read/write this key. */
export function isEditableSetting(key: string): boolean {
  return EDITABLE_KEYS.has(key);
}

export interface SettingsSnapshot {
  fields: SettingField[];
  values: Record<string, unknown>;
  /** Keys that differ from the schema defaults — handy for "reset" affordances. */
  nonDefault: string[];
}

/** Current values plus the descriptors the UI needs to render them. */
export function readSettings(config: Config): SettingsSnapshot {
  const values: Record<string, unknown> = {};
  const nonDefault: string[] = [];
  for (const field of EDITABLE_SETTINGS) {
    values[field.key] = config[field.key];
    if (JSON.stringify(config[field.key]) !== JSON.stringify(DEFAULT_CONFIG[field.key])) {
      nonDefault.push(field.key);
    }
  }
  return { fields: EDITABLE_SETTINGS, values, nonDefault };
}

export interface ApplySettingsResult {
  ok: boolean;
  error?: string;
  /** Keys that were actually changed (and are now live). */
  changed: string[];
  config?: Config;
}

/**
 * Apply a partial settings patch: validate the merged config, persist it, and
 * make it live for the running engine.
 *
 * Validation happens against the whole config, not just the patch, so the
 * cross-field refinements (backoff max ≥ base, maxDownloadMinutes ≥
 * downloadTimeoutMinutes, minDownloadWorkers ≤ maxDownloadWorkers) still hold.
 * A rejected patch changes nothing — neither the file nor the live config.
 */
export async function applySettings(
  current: Config,
  patch: Record<string, unknown>,
  configPath: string = CONFIG_PATH,
): Promise<ApplySettingsResult> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "Expected a JSON object of settings", changed: [] };
  }

  // Reject anything outside the allow-list rather than ignoring it silently.
  const unknown = Object.keys(patch).filter((k) => !isEditableSetting(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Not editable from the dashboard: ${unknown.join(", ")}`,
      changed: [],
    };
  }

  // Coerce to the field's declared type before validating, so "16" from a text
  // input and 16 from JSON both work.
  const coerced: Record<string, unknown> = {};
  for (const field of EDITABLE_SETTINGS) {
    if (!(field.key in patch)) continue;
    const raw = patch[field.key];
    if (field.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) {
        return { ok: false, error: `${field.label} must be a number`, changed: [] };
      }
      coerced[field.key] = n;
    } else if (field.type === "boolean") {
      coerced[field.key] =
        typeof raw === "boolean" ? raw : ["true", "1", "yes", "on"].includes(String(raw).toLowerCase());
    } else if (field.type === "list") {
      // A string of comma-separated values ("en, ja") or a real array both
      // normalize to a clean string array.
      const items = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
      const cleaned = items
        .filter((x: any) => typeof x === "string" && x.trim())
        .map((x: string) => x.trim());
      coerced[field.key] = cleaned;
    } else {
      coerced[field.key] = typeof raw === "string" ? raw.trim() : String(raw);
    }
  }

  const merged = { ...current, ...coerced };

  let validated: Config;
  try {
    validated = ConfigSchema.parse(merged);
  } catch (e: any) {
    const issue = e?.issues?.[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${issue?.message || "invalid configuration"}`, changed: [] };
  }

  const changed = Object.keys(coerced).filter(
    (k) => JSON.stringify((current as any)[k]) !== JSON.stringify((validated as any)[k]),
  );

  try {
    await saveConfig(validated, configPath);
  } catch (e: any) {
    return { ok: false, error: `Could not write config.json: ${e?.message || e}`, changed };
  }

  // Make it live: workers read getConfig() each loop iteration, so this takes
  // effect on the next download without a restart.
  setConfig(validated);
  return { ok: true, changed, config: validated };
}
