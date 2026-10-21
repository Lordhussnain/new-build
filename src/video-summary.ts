// src/video-summary.ts — the title and duration a listing did not tell us.
//
// yt-dlp's `--flat-playlist` is what makes scanning a 1000-video source cheap:
// entries are printed without opening their pages. YouTube's flat entries still
// carry a title and a duration; Bilibili's do not (its list extractors build
// entries with `url_result(url, ie, id)`), so a Bilibili job would otherwise be
// named "video" on disk — every file of a collection identically — and watched
// with the MINIMUM timeout no matter how long it runs, because the duration-aware
// watchdog has no duration to scale with.
//
// Both are fixed with one bounded metadata call per job, before its first
// download attempt: that is the moment the title still decides the file name and
// the duration still decides the watchdog. It never runs for a job that already
// has bytes on disk, because those files were named from the title we have and
// renaming it would orphan the `.part` (and the aria2c control file beside it)
// the resume depends on. A probe that fails is logged and the download proceeds
// with what the listing gave us — the placeholder title is ugly, the video is
// not lost.

import { cookiesArgs, jsRuntimeArgs, ytDlp } from "./tools";

/**
 * The title `parseListingLine` stores for an entry that has none. Also what
 * `sanitizeFileName` falls back to, so a job named exactly this is a job whose
 * real name is still unknown.
 */
export const UNKNOWN_LISTING_TITLE = "video";

/** True when a stored title is the "listing had none" placeholder. */
export function isUnknownListingTitle(title: string | null | undefined): boolean {
  const value = (title ?? "").trim();
  return value === "" || value === UNKNOWN_LISTING_TITLE || value === "NA";
}

/** What one metadata probe answers. Either field may be null (not available). */
export interface VideoSummary {
  title: string | null;
  duration: number | null;
}

/**
 * The separator a `--print` template joins fields with. Defined here rather than
 * imported: `scanner.ts` imports the placeholder title from this module, so
 * importing the scanner's copy back would be a cycle.
 */
const FIELD_SEPARATOR = "|||";

/** The `--print` template of the probe, in the order `parseSummaryLine` reads. */
export const SUMMARY_PRINT_TEMPLATE = `%(title)s${FIELD_SEPARATOR}%(duration)s`;

/**
 * Parse one probe line. A field yt-dlp does not have prints as `NA`, and a
 * duration may be fractional; anything unparsable stays null rather than
 * becoming 0 (which would shorten the watchdog instead of leaving it alone).
 */
export function parseSummaryLine(line: string | null | undefined): VideoSummary {
  const parts = String(line ?? "").split(FIELD_SEPARATOR);
  // Only the LAST field is the duration: a title is free text and may contain
  // the separator itself, and losing the tail of a title to a misparse is worse
  // than an unusual name on disk.
  const rawDuration = parts.length > 1 ? parts[parts.length - 1] : "";
  const rawTitle = parts.length > 1 ? parts.slice(0, -1).join(FIELD_SEPARATOR) : parts[0] ?? "";
  const title = (rawTitle || "").trim();
  const duration = parseFloat((rawDuration || "").trim());
  return {
    title: title && title !== "NA" ? title : null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

export interface SummaryBackfillCandidate {
  title: string | null;
  duration: number | null;
  /** Set once the media is on disk (a rename would orphan it). */
  file_path?: string | null;
  /** Set while a partial exists (the resume is named after the current title). */
  partial_file_path?: string | null;
  /** High-water progress mark: >0 means files were already named. */
  best_progress?: number | null;
}

/**
 * Does this job still need its title/duration probed?
 *
 * Only a job that has NOT started writing files qualifies: once bytes exist they
 * are named after the title we have, and renaming that title would orphan the
 * `.part` file (and the aria2c control file beside it) the next attempt resumes
 * from. A job that already downloaded under the placeholder keeps its name.
 *
 * The listing must have left something out — the placeholder title, or no usable
 * duration. YouTube's flat entries carry both, so this never fires for them;
 * Bilibili's carry neither. A missing duration matters on its own: the download
 * watchdog scales with the video's real length and falls back to the configured
 * MINIMUM without one, which kills a two-hour upload on a slow connection.
 */
export function needsSummaryBackfill(job: SummaryBackfillCandidate): boolean {
  if (job.file_path || job.partial_file_path || (job.best_progress ?? 0) > 0) return false;
  const duration = Number(job.duration);
  const hasDuration = Number.isFinite(duration) && duration > 0;
  return isUnknownListingTitle(job.title) || !hasDuration;
}

/** Pure argv for one summary probe (argv[0] is filled in by the caller). */
export function summaryProbeArgs(
  url: string,
  config: { cookiesFile: string; userAgent?: string },
): string[] {
  return [
    url,
    ...cookiesArgs(config),
    ...jsRuntimeArgs(),
    ...(config.userAgent ? ["--user-agent", config.userAgent] : []),
    // One video, never the anthology/playlist the URL might expand into.
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--print",
    SUMMARY_PRINT_TEMPLATE,
    "--socket-timeout",
    "15",
    "--retries",
    "3",
    "--extractor-retries",
    "3",
  ];
}

/**
 * Hard cap for one probe. It runs inside a claimed download slot, so a wedged
 * network call must surface as a probe failure and let the download start with
 * the placeholder title, not hold the slot.
 */
export const SUMMARY_PROBE_TIMEOUT_MS = 60_000;

/**
 * The watchdog actually used: `SUMMARY_PROBE_TIMEOUT_MS` unless the environment
 * overrides it, so the timeout path can be exercised without a 60-second test
 * (the same test-only escape hatch the audio-track probe has).
 */
function probeTimeoutMs(): number {
  const override = Number(process.env.YTA_SUMMARY_PROBE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : SUMMARY_PROBE_TIMEOUT_MS;
}

export interface ProbeSummaryOptions {
  timeoutMs?: number;
  /** Injectable subprocess boundary for tests. */
  spawn?: (
    args: string[],
    options: { stdout: "pipe"; stderr: "pipe"; signal: AbortSignal },
  ) => Bun.PipedSubprocess;
}

/**
 * Fetch a video's real title and duration. Throws on a non-zero exit, an
 * unparsable answer or a timeout — callers decide what that costs (the download
 * worker logs it and downloads anyway).
 */
export async function probeVideoSummary(
  url: string,
  config: { cookiesFile: string; userAgent?: string },
  opts: ProbeSummaryOptions = {},
): Promise<VideoSummary> {
  const timeoutMs = opts.timeoutMs ?? probeTimeoutMs();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let proc: Bun.PipedSubprocess | null = null;
  let out = "";
  let stderr = "";
  let code = -1;
  try {
    const spawn = opts.spawn ?? ((args, options) => Bun.spawn(args, options));
    proc = spawn([ytDlp(), ...summaryProbeArgs(url, config)], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctl.signal,
    });
    // Both pipes drained concurrently: a chatty yt-dlp that fills the stderr
    // pipe would otherwise deadlock the reader on the other one.
    [out, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (error) {
    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    if (proc) await proc.exited.catch(() => {});
    throw new Error(
      ctl.signal.aborted
        ? `video summary probe timed out after ${timeoutMs}ms`
        : `video summary probe could not start yt-dlp: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (ctl.signal.aborted) throw new Error(`video summary probe timed out after ${timeoutMs}ms`);
  if (code !== 0) {
    const detail = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" ")
      .slice(-300);
    throw new Error(detail || `yt-dlp exited with code ${code}`);
  }
  const line = out.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.includes("|||"));
  if (!line) throw new Error("video summary probe returned no title line");
  return parseSummaryLine(line);
}
