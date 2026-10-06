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
// URL is wrong. The download worker fails these immediately (no budget spent),
// and the failed-job sweep never re-queues them.
//
// Deliberately NOT here: credential-shaped errors ("login required", "sign in
// to confirm you're not a bot", cookie errors) and HTTP 403/429. Those can heal
// when cookies.txt appears mid-run or a throttle lifts, so they stay retryable
// and the cookies watcher can point the operator at them.
const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  /video unavailable/i,
  /private video/i,
  /video is private/i,
  /members[- ]only/i,
  /sign in to confirm your age/i,
  /age[- ]restricted/i,
  /inappropriate for some users/i,
  /removed by the uploader/i,
  /video has been removed/i,
  /has been deleted/i,
  /no longer available/i,
  /community guidelines/i,
  /violating.*terms of service/i,
  /requires payment/i,
  /paid content/i,
  /channel does not exist/i,
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
  /blocked it in your country/i,
  /not available in your country/i,
  /(?:not )?available in your country/i,
  /geo restriction/i,
  /video is unavailable in your country/i,
];

/**
 * True when a download error is permanent (the video can never be fetched) and
 * retrying is pointless.
 */
export function isPermanentDownloadError(message: string | null | undefined): boolean {
  if (!message) return false;
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(message));
}

/**
 * True when an error looks transient (network hiccups, throttling, timeouts)
 * and an immediate-ish retry is worthwhile.
 */
export function isTransientDownloadError(message: string): boolean {
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
    m.includes("unknown option") ||
    m.includes("bad option") ||
    m.includes("bad number") ||
    m.includes("invalid option") ||
    m.includes("unexpected option argument") ||
    m.includes("possible values:")
  );
}

/**
 * The evidence one download attempt leaves about forward progress: the latest
 * completion percentage plus the on-disk partial size, each against the best
 * value known when the attempt STARTED (the claimed row's watermarks — not the
 * live row, whose watermarks already include this attempt).
 */
export interface RetryProgressState {
  /** Latest completion percentage reported this attempt. */
  progress: number;
  /** `best_progress` as it was when the attempt was claimed. */
  bestProgress: number;
  /** Current `.part` file size in bytes (0 when there is no partial). */
  bytes: number;
  /** `best_bytes` as it was when the attempt was claimed. */
  bestBytes: number;
}

/**
 * True when the attempt moved the video forward — by percentage OR by bytes.
 *
 * The retry budget only shrinks while a video makes no forward progress: a
 * flaky connection that keeps advancing is forgiven, a video stuck at the same
 * point eventually exhausts its budget. The byte comparison matters when the
 * percentage is unknown (servers that hide the total) or never reported — the
 * partial file growing on disk is still proof of progress.
 */
export function shouldForgiveRetry(s: RetryProgressState): boolean {
  const pct = Number.isFinite(s.progress) ? s.progress : 0;
  const bestPct = Number.isFinite(s.bestProgress) ? s.bestProgress : 0;
  const bytes = Number.isFinite(s.bytes) ? s.bytes : 0;
  const bestBytes = Number.isFinite(s.bestBytes) ? s.bestBytes : 0;
  return pct > bestPct || bytes > bestBytes;
}
