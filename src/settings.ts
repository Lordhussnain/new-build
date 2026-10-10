// src/settings.ts — the subset of config the dashboard may read and change.
//
// The dashboard is a control surface for the downloader, not a config file
// editor: it must not be able to rewrite playlists, credentials, or the network
// binding. So this module is the single allow-list of editable keys, each with
// the metadata the UI needs to render a correct input (type, range, help text).
//
// Everything the engine can read at runtime is exposed here — the panel is the
// whole of config.json except for
//   • playlists / channels / channelPlaylists — managed by the Sources panel,
//     which understands ownership and per-source job cleanup, and
//   • webToken — a credential; writing it through the API can lock the operator
//     out of the dashboard, so it stays a config.json (or config manager) edit.
//
// Fields flagged `restartRequired` are read by the engine once at startup
// (worker pool sizes, tool discovery, the HTTP listener, watcher intervals), so
// a saved value applies on the next start; everything else is live.

import { CONFIG_PATH, ConfigSchema, DEFAULT_CONFIG, saveConfig, type Config } from "./config";
import { setConfig } from "./state";

export type SettingType = "number" | "boolean" | "text" | "select" | "list";

/** Panel groups, in the order the dashboard renders them. */
export const SETTING_GROUPS = [
  "offline",
  "downloader",
  "media",
  "concurrency",
  "reliability",
  "storage",
  "watching",
  "advanced",
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

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
  group: SettingGroup;
  /** Read once at startup: the saved value applies after a restart. */
  restartRequired?: boolean;
}

/** The quality presets the global `videoQuality` setting accepts. */
const VIDEO_QUALITY_OPTIONS = [
  { value: "highest", label: "Highest available" },
  { value: "4k", label: "4K (up to 2160p)" },
  { value: "1440p", label: "1440p" },
  { value: "1080p", label: "1080p (default)" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
  { value: "audio", label: "Best audio only" },
];

/**
 * Quick presets for the Web UI. Applying a preset stages these existing config
 * keys in the settings editor; the operator can still tune them individually
 * before saving. The Standard profile is the shipped baseline, while Maximum
 * Speed enables the larger native-fragment/chunk/buffer settings and the
 * explicit browser-style User-Agent requested by the operator.
 */
export const DOWNLOAD_SPEED_PROFILES = {
  standard: {
    label: "Standard",
    description: "Balanced defaults: aria2c ×16, 16 native fragments, default chunk/buffer/User-Agent, and no rate cap.",
    values: {
      useAria2c: true,
      connectionsPerDownload: 16,
      minSplitSize: "1M",
      concurrentFragments: 16,
      httpChunkSize: "",
      bufferSize: "",
      userAgent: "",
      maxBandwidthKBps: 0,
    },
  },
  maximum: {
    label: "Maximum speed",
    description: "Uncapped aria2c ×16 plus 32 native fragments, 10M HTTP chunks, a 16K buffer, and the supplied Chrome/120 User-Agent.",
    values: {
      useAria2c: true,
      connectionsPerDownload: 16,
      minSplitSize: "1M",
      concurrentFragments: 32,
      httpChunkSize: "10M",
      bufferSize: "16K",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
      maxBandwidthKBps: 0,
    },
  },
  aggressive: {
    label: "Aggressive (IDM)",
    description: "Ultra-fast IDM-style downloads: aria2c ×32 (split 1M), 64 native fragments, 10M HTTP chunks, 64K buffer, and uncapped bandwidth.",
    values: {
      useAria2c: true,
      connectionsPerDownload: 32,
      minSplitSize: "1M",
      concurrentFragments: 64,
      httpChunkSize: "10M",
      bufferSize: "64K",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
      maxBandwidthKBps: 0,
    },
  },
} satisfies Record<string, { label: string; description: string; values: Partial<Config> }>;

/**
 * The editable knobs, grouped for the settings panel.
 *
 * Ranges mirror the Zod schema so the UI never offers a value the engine would
 * reject — but the schema is still the authority and re-validates on save.
 */
export const EDITABLE_SETTINGS: SettingField[] = [
  // --- offline --------------------------------------------------------------
  {
    key: "offlineMode",
    label: "📴 Offline mode (no downloads)",
    type: "boolean",
    group: "offline",
    help:
      "Stops network work: downloads, scans, RSS requests, sidecar fetches and network probes stay idle while offline. The engine keeps converting and moving finished files; queued downloads wait untouched. Enabled watchers resume automatically when turned off, without a restart. Applies live; also settable with --offline / YTA_OFFLINE=1 for a single run.",
  },
  // --- downloader -----------------------------------------------------------
  {
    key: "videoQuality",
    label: "Video quality",
    type: "select",
    group: "downloader",
    options: VIDEO_QUALITY_OPTIONS,
    help: "Default quality preset for new downloads. Per-video overrides live in each job's detail panel.",
  },
  {
    key: "useAria2c",
    label: "Use aria2c",
    type: "boolean",
    group: "downloader",
    help: "Multi-connection downloads. Falls back to yt-dlp's native downloader when aria2c is not installed, or for HLS/live streams.",
  },
  {
    key: "autoscaleEnabled",
    label: "Automatic download slots",
    type: "boolean",
    group: "downloader",
    help: "Grow the download pool while the queue has backlog and bandwidth headroom, and shrink it when there is nothing to do.",
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
    help: "Smallest file aria2c will split across connections (e.g. 1M). A size at or below 1M is clamped to yt-dlp's 1M default; anything that is not a size (e.g. \"banana\") is handed to aria2c, whose rejection pauses the engine (BAD_DOWNLOADER_ARGS) instead of failing every video.",
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
    key: "userAgent",
    label: "User-Agent override",
    type: "text",
    group: "downloader",
    help: "Optional yt-dlp request User-Agent. Blank uses yt-dlp's default; a custom value may be rejected by some services and cannot guarantee higher throughput.",
  },
  {
    key: "maxBandwidthKBps",
    label: "Bandwidth cap",
    type: "number",
    min: 0,
    unit: "KB/s",
    group: "downloader",
    help: "Per-download rate cap split across active slots. Existing transfers keep their starting rate as slots change, so the aggregate is best-effort during autoscaling. 0 = unlimited.",
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
  {
    key: "downloadSubtitles",
    label: "Download subtitles",
    type: "boolean",
    group: "media",
    help: "Default for new jobs. Existing jobs keep their per-video Sidecar Files choice; change it in the job detail panel, then use Scan Missing Metadata to backfill selected sidecars without re-downloading media.",
  },
  {
    key: "subtitleLanguages",
    label: "Subtitle languages",
    type: "text",
    group: "media",
    help: "Which subtitle languages to fetch: comma-separated codes (en, es, ja — regexes like en.* work), or \"all\" for every available language including auto-generated ones.",
  },
  {
    key: "embedMetadata",
    label: "Embed metadata & chapters",
    type: "boolean",
    group: "media",
    help: "Embed thumbnail, metadata tags, and chapters into the downloaded file (yt-dlp --embed-*).",
  },
  {
    key: "writeThumbnail",
    label: "Save thumbnails",
    type: "boolean",
    group: "media",
    help: "Default for new jobs. Existing jobs keep their per-video Sidecar Files choice; use Scan Missing Metadata to backfill selected sidecars without re-downloading media.",
  },
  {
    key: "writeDescription",
    label: "Save descriptions",
    type: "boolean",
    group: "media",
    help: "Default for new jobs. Existing jobs keep their per-video Sidecar Files choice; use Scan Missing Metadata to backfill selected sidecars without re-downloading media.",
  },
  {
    key: "writeInfoJson",
    label: "Save info.json",
    type: "boolean",
    group: "media",
    help: "Save yt-dlp's full metadata dump as a .info.json sidecar. Scan Missing Metadata checks downloaded jobs against this global setting.",
  },
  {
    key: "skipShorts",
    label: "Skip Shorts",
    type: "boolean",
    group: "media",
    help: "Do not queue YouTube Shorts when scanning (applies to new scans).",
  },
  {
    key: "downloadShorts",
    label: "Download Shorts only",
    type: "boolean",
    group: "media",
    help: "Queue only Shorts when scanning (applies to new scans).",
  },
  {
    key: "archiveLiveStreams",
    label: "Archive live streams",
    type: "boolean",
    group: "media",
    help: "Include currently-live streams: without this, a live video is parked as \"waiting for VOD\" until it ends.",
  },
  {
    key: "verifyIntegrity",
    label: "Verify file integrity",
    type: "boolean",
    group: "media",
    help: "Record a SHA-256 hash of every converted file (shown in the job detail panel).",
  },
  // --- concurrency ----------------------------------------------------------
  {
    key: "maxConcurrentDownloads",
    label: "Initial download slots",
    type: "number",
    min: 1,
    max: 20,
    group: "concurrency",
    help: "Starting slot count, not the autoscaler ceiling. Changing it while running resets the active pool on the next tick. With autoscaling enabled the pool can then grow toward maxDownloadWorkers and shrink to minDownloadWorkers; with it disabled this remains the fixed slot count.",
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
    key: "maxDownloadWorkers",
    label: "Max download workers",
    type: "number",
    min: 1,
    max: 20,
    group: "concurrency",
    restartRequired: true,
    help: "Download worker processes started at launch (autoscaler ceiling). Takes effect after a restart.",
  },
  {
    key: "maxConcurrentConverts",
    label: "Convert workers",
    type: "number",
    min: 1,
    max: 10,
    group: "concurrency",
    restartRequired: true,
    help: "Parallel ffmpeg conversions (worker processes start at launch). Takes effect after a restart.",
  },
  {
    key: "maxMetadataWorkers",
    label: "Metadata workers",
    type: "number",
    min: 1,
    max: 10,
    group: "concurrency",
    restartRequired: true,
    help: "Parallel subtitle/thumbnail/description fetches (worker processes start at launch). Takes effect after a restart.",
  },
  // --- reliability ----------------------------------------------------------
  {
    key: "maxRetryAttempts",
    label: "Max retry attempts",
    type: "number",
    min: 1,
    group: "reliability",
    help: "Per-video retry budget for downloads (no-progress attempts; a retry that advances progress is free).",
  },
  {
    key: "maxFailuresPerVideo",
    label: "Max failures per video",
    type: "number",
    min: 1,
    group: "reliability",
    help: "Hard cap per video across download, conversion, and metadata stages.",
  },
  {
    key: "maxFailures",
    label: "Circuit breaker threshold",
    type: "number",
    min: 1,
    group: "reliability",
    help: "Consecutive pipeline failures (with no success in between) that pause the whole engine — expired cookies or a YouTube outage should not burn the queue one video at a time.",
  },
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
  {
    key: "verifyExistingFiles",
    label: "Verify existing files on start",
    type: "boolean",
    group: "reliability",
    restartRequired: true,
    help: "At startup, re-queue jobs whose downloaded file is missing from disk. Takes effect after a restart.",
  },
  {
    key: "minFreeSpaceGB",
    label: "Minimum free disk space",
    type: "number",
    min: 1,
    unit: "GB",
    group: "reliability",
    help: "Pause the engine instead of filling the disk when free space drops below this.",
  },
  {
    key: "networkMonitorEnabled",
    label: "Network monitor",
    type: "boolean",
    group: "reliability",
    restartRequired: true,
    help: "Probe YouTube periodically and pause the engine after consecutive failures. Takes effect after a restart.",
  },
  // --- storage --------------------------------------------------------------
  {
    key: "outputRoot",
    label: "Output folder",
    type: "text",
    group: "storage",
    help: "Where new downloads are written (relative to the app folder or absolute). Already-queued jobs keep their folder; applies to new scans.",
  },
  {
    key: "secondaryStoragePath",
    label: "Secondary storage",
    type: "text",
    group: "storage",
    help: "Move finished files (media + sidecars) here once conversion succeeds. Blank = keep everything in the output folder.",
  },
  {
    key: "deleteSourceAfterConvert",
    label: "Delete source after convert",
    type: "boolean",
    group: "storage",
    help: "Remove the pre-conversion file once the re-muxed/converted file is recorded. Off keeps both copies.",
  },
  {
    key: "archiveFile",
    label: "yt-dlp archive file",
    type: "text",
    group: "storage",
    help: "yt-dlp --download-archive list of finished video ids; prevents re-downloading after a database reset.",
  },
  {
    key: "cookiesFile",
    label: "Cookies file",
    type: "text",
    group: "storage",
    help: "Netscape cookies.txt used for authenticated downloads. The engine notices the file appearing or changing while it runs.",
  },
  // --- watching -------------------------------------------------------------
  {
    key: "rssEnabled",
    label: "Watch channels (RSS)",
    type: "boolean",
    group: "watching",
    help: "Cheap per-channel RSS polling that picks up new uploads without a full rescan.",
  },
  {
    key: "rssPollIntervalMinutes",
    label: "RSS poll interval",
    type: "number",
    min: 1,
    unit: "min",
    group: "watching",
    restartRequired: true,
    help: "How often channel feeds are checked. Takes effect after a restart.",
  },
  {
    key: "daemonMode",
    label: "Daemon mode",
    type: "boolean",
    group: "watching",
    restartRequired: true,
    help: "Keep running and rescan every source on a schedule instead of exiting when the queue drains. Takes effect after a restart.",
  },
  {
    key: "rescanIntervalHours",
    label: "Full rescan interval",
    type: "number",
    min: 0,
    unit: "h",
    group: "watching",
    restartRequired: true,
    help: "Daemon-mode full rescan cadence (0 disables). Takes effect after a restart.",
  },
  // --- advanced -------------------------------------------------------------
  {
    key: "ytDlpPath",
    label: "yt-dlp path",
    type: "text",
    group: "advanced",
    restartRequired: true,
    help: "Explicit yt-dlp executable (blank = auto-discover on PATH). Takes effect after a restart.",
  },
  {
    key: "ffmpegPath",
    label: "ffmpeg path",
    type: "text",
    group: "advanced",
    restartRequired: true,
    help: "Explicit ffmpeg executable (blank = auto-discover on PATH). Takes effect after a restart.",
  },
  {
    key: "aria2cPath",
    label: "aria2c path",
    type: "text",
    group: "advanced",
    restartRequired: true,
    help: "Explicit aria2c executable, or \"none\" to force the native downloader even when aria2c is installed. Takes effect after a restart.",
  },
  {
    key: "denoPath",
    label: "Deno path",
    type: "text",
    group: "advanced",
    restartRequired: true,
    help: "Explicit Deno executable path (blank = auto-discover on PATH) for yt-dlp's YouTube n-challenge JS runtime (--js-runtimes \"deno:<path>\"). Takes effect after a restart.",
  },
  {
    key: "validateCookiesOnStart",
    label: "Validate cookies on start",
    type: "boolean",
    group: "advanced",
    restartRequired: true,
    help: "Probe cookies.txt at startup and warn when it is expired. Takes effect after a restart.",
  },
  {
    key: "webPort",
    label: "Web UI port",
    type: "number",
    min: 1,
    max: 65535,
    group: "advanced",
    restartRequired: true,
    help: "HTTP port for this dashboard. Takes effect after a restart; `bun run start --port <n>` overrides it for one run without changing config.json.",
  },
  {
    key: "webBind",
    label: "Web UI bind address",
    type: "text",
    group: "advanced",
    restartRequired: true,
    help: "127.0.0.1 = this machine only (default); 0.0.0.0 exposes the dashboard to the network — set a webToken in config.json if you do. Takes effect after a restart.",
  },
];

const EDITABLE_KEYS = new Set<string>(EDITABLE_SETTINGS.map((f) => f.key));

/** Keys the dashboard may write but that only take effect on the next start. */
const RESTART_KEYS = new Set<string>(EDITABLE_SETTINGS.filter((f) => f.restartRequired).map((f) => f.key));

/** Loopback binds keep the dashboard on this machine; anything else is exposed. */
function isNetworkExposed(host: string): boolean {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return false; // empty = the server's loopback default
  return !(h === "localhost" || h === "::1" || h === "[::1]" || h === "127.0.0.1" || h.startsWith("127."));
}

/** True when the dashboard is allowed to read/write this key. */
export function isEditableSetting(key: string): boolean {
  return EDITABLE_KEYS.has(key);
}

/** True when a saved value of this key only applies after an engine restart. */
export function requiresRestart(key: string): boolean {
  return RESTART_KEYS.has(key);
}

export interface SettingsSnapshot {
  fields: SettingField[];
  values: Record<string, unknown>;
  /** Keys that differ from the schema defaults — handy for "reset" affordances. */
  nonDefault: string[];
  /** Presets used by the settings modal's one-click performance selector. */
  speedProfiles: typeof DOWNLOAD_SPEED_PROFILES;
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
  return { fields: EDITABLE_SETTINGS, values, nonDefault, speedProfiles: DOWNLOAD_SPEED_PROFILES };
}

export interface ApplySettingsResult {
  ok: boolean;
  error?: string;
  /** Keys that were actually changed (and are now live). */
  changed: string[];
  /** Changed keys whose value only applies after a restart. */
  restartRequired?: string[];
  config?: Config;
}

/**
 * Parse a boolean the dashboard may send: a real boolean, or one of the
 * unambiguous string forms a form control can produce (`"true"/"false"`,
 * `"1"/"0"`, `"yes"/"no"`, `"on"/"off"`, case- and whitespace-insensitive).
 * Anything else — `"maybe"`, `""`, `null`, `2` — is null, which the caller
 * rejects.
 *
 * The old rule mapped every unrecognised value to `false`, so
 * `{"useAria2c": "maybe"}` reported `ok: true` and a changed key: an invalid
 * value silently switched a setting off.
 */
export function coerceBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return null;
  }
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return null;
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
  // input and 16 from JSON both work. A value that is not a usable
  // representation of the declared type is REJECTED — never coerced to some
  // default: "maybe" is not false, and silently turning it into a change would
  // contradict the all-or-nothing rule the rest of this function enforces.
  const coerced: Record<string, unknown> = {};
  for (const field of EDITABLE_SETTINGS) {
    if (!(field.key in patch)) continue;
    const raw = patch[field.key];
    if (field.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      // `Number("")` is 0 and `Number(" ")` is 0: an empty text input is not a
      // number, it is a missing value.
      if (typeof raw !== "number" && !String(raw ?? "").trim()) {
        return { ok: false, error: `${field.label} must be a number`, changed: [] };
      }
      if (!Number.isFinite(n)) {
        return { ok: false, error: `${field.label} must be a number`, changed: [] };
      }
      coerced[field.key] = n;
    } else if (field.type === "boolean") {
      const parsed = coerceBoolean(raw);
      if (parsed === null) {
        return { ok: false, error: `${field.label} must be true or false`, changed: [] };
      }
      coerced[field.key] = parsed;
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
  const restartRequired = changed.filter((k) => requiresRestart(k));

  // Safety rail: binding the (token-less) dashboard to a network address is
  // how an archive ends up on the LAN for anyone to purge. webToken is
  // deliberately not editable here, so a patch that introduces a non-loopback
  // bind on an unprotected dashboard is refused outright.
  if (changed.includes("webBind") && isNetworkExposed(validated.webBind) && !validated.webToken) {
    return {
      ok: false,
      error:
        "Refusing to bind the dashboard to a network address while webToken is empty — " +
        "set webToken in config.json first (or keep webBind on 127.0.0.1)",
      changed: [],
    };
  }

  try {
    await saveConfig(validated, configPath);
  } catch (e: any) {
    return { ok: false, error: `Could not write config.json: ${e?.message || e}`, changed };
  }

  // Make it live: workers read getConfig() each loop iteration, so this takes
  // effect on the next download without a restart.
  setConfig(validated);
  return { ok: true, changed, restartRequired, config: validated };
}

/** Every config key the panel intentionally does not offer, with the reason. */
export const NON_EDITABLE_SETTINGS: { key: keyof Config; reason: string }[] = [
  { key: "playlists", reason: "managed by the Sources panel" },
  { key: "channels", reason: "managed by the Sources panel" },
  { key: "channelPlaylists", reason: "managed by the Sources panel" },
  { key: "webToken", reason: "credential — edit config.json (or the config manager) to change it" },
];
