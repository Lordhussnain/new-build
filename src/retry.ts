// src/retry.ts — pure retry/resume policy (no I/O, fully unit-tested).

/**
 * Exponential backoff with jitter, in milliseconds.
 *
 * attempt 0 → base, 1 → 2×base, 2 → 4×base … capped at maxSeconds, plus up to
 * 30% random jitter so many workers that failed together don't retry in
 * lockstep. The RNG is injectable to keep tests deterministic.
 */
export function computeBackoffMs(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number,
  rnd: () => number = Math.random,
): number {
  const a = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  const base = Math.max(1, baseSeconds);
  const cap = Math.max(base, maxSeconds);
  const exponential = Math.min(cap, base * 2 ** a);
  const jittered = exponential * (1 + 0.3 * Math.min(1, Math.max(0, rnd())));
  return Math.round(jittered * 1000);
}

/**
 * Per-video download watchdog.
 *
 * A flat 15-minute timeout kills legitimate long downloads (a 2-hour video on
 * a slow connection needs far longer), so the timeout scales with the video's
 * real duration — 3× realtime plus 5 minutes of slack — clamped between the
 * configured minimum and ceiling. Unknown duration → the minimum.
 */
export function computeDownloadTimeoutMs(
  durationSeconds: number | null | undefined,
  opts: { minMinutes: number; maxMinutes: number },
): number {
  const minMs = Math.max(1, opts.minMinutes) * 60_000;
  const maxMs = Math.max(minMs / 60_000, opts.maxMinutes) * 60_000;
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return minMs;
  const scaled = (durationSeconds * 3 + 300) * 1000;
  return Math.max(minMs, Math.min(maxMs, scaled));
}

// Errors that will never succeed on retry — the video is gone, gated, or the
// URL is wrong. Re-queueing these just burns time (and bandwidth), so the
// failed-job sweep and the transient-retry path both skip them.
const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  /video unavailable/i,
  /video is unavailable/i,
  /video (?:is )?no longer available/i,
  /content is (?:not|no longer) available/i,
  /video (?:has been|was) (?:deleted|removed)/i,
  /video (?:is )?not available\b/i,
  /video is private/i,
  /private video/i,
  /premium members/i,
  /requires payment/i,
  /members[- ]only/i,
  /sign in to confirm your age/i,
  /age[- ]restricted/i,
  /age verification required/i,
  /inappropriate for some users/i,
  /removed by the uploader/i,
  /video has been removed/i,
  /has been terminated/i,
  /account associated with this video has been terminated/i,
  /this video does not exist/i,
  /no video formats/i,
  /requested format is not available/i,
  /unsupported url/i,
  /is not a valid url/i,
  /http error 404/i,
  /http error 410/i,
  /copyright/i,
  /blocked it in your (?:country|region|location)/i,
  /not available (?:in|from) your (?:country|region|location)/i,
  /unavailable (?:in|from) your (?:country|region|location)/i,
  /not made this video available in your (?:country|region|location)/i,
  /geo[- ]?restrict(?:ed|ion)/i,
  /geo[- ]?blocked/i,
  /blocked (?:in|from) your (?:country|region|location)/i,
];

/**
 * True when yt-dlp failed YouTube's n-parameter / player JS challenge.
 *
 * That is an environment problem (no JS runtime, missing EJS solver scripts,
 * or an outdated yt-dlp), not a dead video. The same stderr tail often also
 * contains "Requested format is not available" / "Some formats may be missing"
 * because the challenge failure strips formats — those look like the permanent
 * "no video formats" class, so callers MUST check this first (and
 * `isPermanentDownloadError` itself refuses to match when this is set).
 */
export function isNChallengeError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("n challenge") ||
    m.includes("nchallengeinput") ||
    m.includes("javascript runtime") ||
    m.includes("js runtime") ||
    m.includes("challenge solver") ||
    m.includes("remote-components")
  );
}

/**
 * True when a download error is permanent (the video can never be fetched) and
 * retrying is pointless.
 */
export function isPermanentDownloadError(message: string | null | undefined): boolean {
  // Our own durable record wins over everything (including the n-challenge
  // guard below): the terminal path is the ONLY writer of the marker, and it
  // never writes it for an n-challenge failure.
  if (isTerminalErrorMessage(message)) return true;
  if (!message) return false;
  // n-challenge failures are environmental; the format-missing text they leave
  // behind must not park the job forever. This check comes BEFORE the reason
  // table: that table's format rules match the same stderr tail, and a video
  // is still downloadable once a JS runtime / updated solver is in place.
  if (isNChallengeError(message)) return false;
  // Belt and braces: the pattern list below is the historical source of truth,
  // the rule table is what labels the reason. A message either knows how to
  // describe itself or the generic patterns still park it.
  if (classifyTerminalDownloadError(message)) return true;
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(message));
}

/**
 * True when yt-dlp rejected the FORMAT SELECTOR rather than the video itself —
 * the requested format ids do not (or no longer) exist for this video.
 *
 * This matters for multi-audio: the engine pins explicit audio format ids from
 * an earlier `-J` probe into the selector, and YouTube renumbers formats over
 * time. A stale probe then produces "Requested format is not available" — which
 * `isPermanentDownloadError` also matches. Callers must check this FIRST and
 * recover by clearing the stored audio tracks (forcing a fresh probe or a
 * fallback to the classic single-track selector) instead of parking the job
 * permanently: the video itself is perfectly downloadable.
 */
export function isFormatAvailabilityError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("requested format is not available") ||
    m.includes("no matching formats") ||
    m.includes("unable to find a video format")
  );
}

// --- Terminal (skip-and-move-on) failures -----------------------------------
//
// A playlist is full of videos nobody can download: private uploads, deleted
// ones, members-only content, region locks, livestreams that never became VOD.
// They are EXPECTED in archival, not incidents, so the engine must:
//
//   1. classify them once, precisely (what is the reason, in operator words),
//   2. park the job as terminal — the cooldown sweep and every requeue path
//      must keep their hands off it, and
//   3. keep the rest of the playlist moving without spending retry budget,
//      without tripping the circuit breaker, and without an error.log line per
//      dead video (error.log is for things an operator must act on).
//
// The classification is durable, not re-derived: the worker stores the marker
// below in `jobs.last_error`, and `isPermanentDownloadError` trusts the marker
// even if the raw tail was truncated. `requeueFailedJobs`, `/api/failed/requeue`
// and `/api/reliability` all read the same predicate, so a skipped video can
// never be resurrected by a sweep or counted as retryable.

/** Marker prefixing every `jobs.last_error` written by the terminal path. */
export const TERMINAL_ERROR_MARKER = "[terminal]";

export type TerminalErrorCode =
  | "private"
  | "members_only"
  | "age_restricted"
  | "payment_required"
  | "copyright"
  | "terminated"
  | "removed"
  | "geo_blocked"
  | "not_found"
  | "format_unavailable"
  | "no_formats"
  | "unavailable"
  | "other";

export interface TerminalErrorInfo {
  code: TerminalErrorCode;
  /** Short operator-facing reason, e.g. "Private video". */
  label: string;
}

/** Used when a message is permanent but no rule knows how to describe it. */
export const GENERIC_TERMINAL_INFO: TerminalErrorInfo = {
  code: "other",
  label: "Video not downloadable",
};

/**
 * Reason table, most specific first — order is behaviour.
 *
 * "This video is not available in your country" matches both the geo rule and
 * the generic unavailable rule; geo must win, or a VPN/cookies fix would never
 * look like the answer. Private/members/age come before the generic
 * "unavailable" wording for the same reason.
 */
const TERMINAL_ERROR_RULES: ReadonlyArray<{ code: TerminalErrorCode; label: string; pattern: RegExp }> = [
  { code: "private", label: "Private video", pattern: /private video|video is private|video is set to private/i },
  {
    code: "members_only",
    label: "Members-only video",
    pattern: /members[- ]only|member[- ]only|premium members|only available to .*\bmembers?\b/i,
  },
  {
    code: "age_restricted",
    label: "Age-restricted video",
    pattern: /sign in to confirm your age|age[- ]restricted|age verification required|inappropriate for some users/i,
  },
  {
    code: "payment_required",
    label: "Paid video",
    pattern: /requires payment|payment required|available for rent or purchase|rent or buy/i,
  },
  { code: "copyright", label: "Blocked by a copyright claim", pattern: /copyright/i },
  {
    code: "terminated",
    label: "Channel terminated",
    pattern: /has been terminated|terminated the account/i,
  },
  {
    code: "removed",
    label: "Removed by the uploader",
    pattern: /removed by the uploader|video has been removed|been removed for violating|community guidelines|video (?:has been|was) deleted/i,
  },
  {
    code: "geo_blocked",
    label: "Not available in your region",
    pattern:
      /blocked (?:it )?(?:in|from) your (?:country|region|location)|not available (?:in|from) your (?:country|region|location)|unavailable (?:in|from) your (?:country|region|location)|not made this video available in your (?:country|region|location)|geo[- ]?restrict(?:ed|ion)?|geo[- ]?blocked/i,
  },
  {
    code: "not_found",
    label: "Video not found",
    pattern: /http error 404|http error 410|does not exist|is not a valid url|unsupported url/i,
  },
  {
    code: "format_unavailable",
    label: "Requested format not available",
    pattern: /requested format is not available|no matching formats|unable to find a video format/i,
  },
  { code: "no_formats", label: "No downloadable formats", pattern: /no video formats|no formats found/i },
  {
    code: "unavailable",
    label: "Video unavailable",
    pattern:
      /video unavailable|video is unavailable|video (?:is )?(?:not available|no longer available)|no longer available|content is (?:not|no longer) available|this video does not exist/i,
  },
];

/** Classify a raw yt-dlp error tail into a terminal reason, or null. */
export function classifyTerminalDownloadError(message: string | null | undefined): TerminalErrorInfo | null {
  if (!message) return null;
  for (const rule of TERMINAL_ERROR_RULES) {
    if (rule.pattern.test(message)) return { code: rule.code, label: rule.label };
  }
  return null;
}

/** True when `message` is a `jobs.last_error` written by the terminal path. */
export function isTerminalErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") return false;
  return message.trimStart().toLowerCase().startsWith(TERMINAL_ERROR_MARKER);
}

/**
 * Build the durable `jobs.last_error` value for a terminal failure.
 *
 * The raw tail is kept (trimmed and length-capped) so an operator who wonders
 * *why* a video was skipped still sees yt-dlp's own words; the marker and the
 * label in front are what the sweep, the API and the dashboard read.
 */
export function formatTerminalErrorMessage(info: TerminalErrorInfo, raw: string | null | undefined): string {
  const detail = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return `${TERMINAL_ERROR_MARKER} ${info.label} — skipped, it will not be retried automatically.${detail ? ` yt-dlp: ${detail}` : ""}`;
}

/** Split a stored terminal message back into label + detail (for reports/UI). */
export function parseStoredTerminalError(
  message: string | null | undefined,
): { label: string; detail: string } | null {
  if (!isTerminalErrorMessage(message)) return null;
  const rest = String(message).trimStart().slice(TERMINAL_ERROR_MARKER.length).trim();
  const [label, ...detail] = rest.split(" — ");
  return { label: label.trim(), detail: detail.join(" — ").trim() };
}

// --- Format fallback ladder --------------------------------------------------
//
// "Requested format is not available" is a SELECTOR problem, not a dead video:
// the preset the plan asked for has no matching stream. Instead of letting the
// failure burn the retry budget and park the video (the old behaviour) the
// download worker steps the quality override DOWN one rung and immediately
// retries with the new selector.
//
// The ladder is monotonic — every step persists a strictly lower per-job
// `video_quality` override, and nothing ever moves back up — so a job can
// descend it at most once and the recovery needs no retry budget to be bounded.
// The last rung is `highest` (`bv+ba/b`): it accepts any stream the extractor
// found, so a failure there means the video really has no usable formats.
export const FORMAT_FALLBACK_LADDER: readonly string[] = ["4k", "1440p", "1080p", "720p", "480p", "highest"];

/**
 * The next lower quality preset for `current`, or null when there is none.
 *
 * `audio` never falls back to a video preset (that would silently download a
 * video stream for an audio-only request) and an unknown key has no defined
 * position on the ladder — both end the recovery, which the worker records as a
 * terminal format failure.
 */
export function nextFormatFallback(current: string | null | undefined): string | null {
  const key = String(current ?? "")
    .trim()
    .toLowerCase();
  if (!key || key === "audio") return null;
  const index = FORMAT_FALLBACK_LADDER.indexOf(key);
  return index >= 0 && index + 1 < FORMAT_FALLBACK_LADDER.length ? FORMAT_FALLBACK_LADDER[index + 1] : null;
}

/**
 * The message stored on a job whose selector was stepped down.
 *
 * Deliberately NOT a permanent-error shape: the job keeps running, and if it
 * later fails for a real reason every failure path overwrites `last_error`. The
 * wording also avoids the classifier phrases on purpose — a switch note left on
 * a row must never be mistaken for a dead video by the cooldown sweep.
 */
export function formatSwitchMessage(from: string, to: string): string {
  return `Requested quality ${from} is not available for this video — switched to ${to} automatically.`;
}

export interface ProgressAwareRetryState {
  /** Number of no-progress failures in the current retry window. */
  retryCount: number;
  /** Highest progress observed at a failed attempt boundary. */
  bestProgress: number;
  /** Whether this failed attempt advanced past the previous high-water mark. */
  madeProgress: boolean;
  /** Whether the no-progress retry budget is exhausted. */
  exhausted: boolean;
}

/**
 * Charge a retry only when the current attempt did not beat the previous
 * high-water mark. Call this when an attempt fails, not on every progress
 * update: eagerly writing `bestProgress` while the transfer is running would
 * make the failure-time comparison impossible (current progress would always
 * equal the high-water mark).
 */
export function progressAwareRetryState(
  retryCount: number,
  bestProgress: number,
  progress: number,
  retryCap: number,
): ProgressAwareRetryState {
  const count = Math.max(0, Math.floor(Number.isFinite(retryCount) ? retryCount : 0));
  const best = Math.min(100, Math.max(0, Number.isFinite(bestProgress) ? bestProgress : 0));
  const current = Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const madeProgress = current > best;
  const nextCount = madeProgress ? count : count + 1;
  const cap = Math.max(1, Math.floor(Number.isFinite(retryCap) ? retryCap : 1));
  return {
    retryCount: nextCount,
    bestProgress: Math.max(best, current),
    madeProgress,
    exhausted: nextCount >= cap,
  };
}

/**
 * True when an error looks transient (network hiccups, throttling, timeouts)
 * and an immediate-ish retry is worthwhile.
 */
export function isTransientDownloadError(message: string): boolean {
  if (isNChallengeError(message)) return true;
  const m = message.toLowerCase();
  return [
    "unable to download",
    "connection reset",
    "timeout",
    "timed out",
    "network is unreachable",
    "err_connection",
    "temporary failure",
    "could not connect",
    "sigabrt",
    "aborted",
    "http error 429",
    "http error 5",
    "ssl",
    "eof",
    "broken pipe",
    "giving up after",
    "read error",
    "write error",
  ].some((e) => m.includes(e));
}

/**
 * True when the error says the RESUME itself is impossible — the saved `.part`
 * can never be finished, so ONLY discarding it (together with its aria2c
 * control file, via `removePartialFiles`) lets the video download again.
 *
 * Upstream reference: yt-dlp#8313 ("Unable to download video data: HTTP Error
 * 416: Requested range not satisfiable"), closed as config/site behaviour with
 * the maintainer's diagnosis: the error happens when the partial yt-dlp found
 * is "the same size or larger than that of the file on youtube's servers".
 * yt-dlp deliberately does not automate the recovery, so this engine owns it.
 *
 * Three ways to reach that state, all fixed by the same discard:
 *
 *   • YouTube re-encodes / re-slices the format mid-flight (a DASH `f137` /
 *     `f399` stream getting shorter while the transfer is paused), so
 *     `Range: bytes=<size of the .part>-` now starts past the end of the file.
 *   • The same signed URL answers a different Content-Length because the CDN
 *     switched the content for this IP (proxy/geo change) — the shape that got
 *     #8313 labelled `geo-blocked`.
 *   • A pre-existing FINAL file is mistaken for a partial. That is the exact
 *     cause in #8313 (`nopart: True` plus one fixed output template) and it is
 *     structurally impossible here: the plan never passes `--no-part`, and
 *     every job's template is `<index> - <title>` fitted with `[videoId]`, so
 *     no two videos can share a name.
 *
 * Why it must be handled instead of retried: with `--continue` the failure
 * repeats byte-for-byte, and because progress can never beat `best_progress`
 * every attempt is a no-progress failure — the video strands at 99.0% until the
 * budget parks it as `failed`, after which the cooldown sweep re-queues it into
 * the same loop.
 *
 * The same reasoning covers aria2c's refusal to touch the saved state: `File
 * <name> exists, but a control file(*.aria2) does not exist. Download was
 * canceled ...` (its default `--allow-overwrite=false`) — nothing is
 * resume-able and starting over on top of the existing file is refused, so the
 * pair has to go.
 *
 * Deliberately NOT matched: aria2c's "cannot continue download: downloading is
 * not supported by remote server" (a server without `Accept-Ranges`). There the
 * data is fine and the remedy is to keep `--continue` and let the native
 * downloader take over — routing it here would throw away good work.
 */
export function isUnrecoverableResumeError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("requested range not satisfiable") ||
    m.includes("http error 416") ||
    m.includes("status code 416") ||
    m.includes("exists, but a control file(*.aria2) does not exist")
  );
}

/**
 * True when aria2c rejected the command line itself instead of downloading:
 * exit 28 is "bad/unrecognized option was given or unexpected option argument
 * was given", and aria2c prints the offending option's help block (e.g.
 * "Possible Values: 1-16" for `-x`) right before dying.
 *
 * That is a global misconfiguration (a `-x` above aria2c's cap, a malformed
 * `--min-split-size`, …), not a video problem: every download in the batch
 * fails identically in about a second, so retrying videos only burns retry
 * budgets until the circuit breaker trips. The engine pauses itself with an
 * actionable reason instead (see workers/download.ts).
 */
export function isDownloaderArgsError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("exited with code 28") ||
    m.includes("unrecognized option") ||
    m.includes("possible values:")
  );
}
