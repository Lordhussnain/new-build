// src/cookies-export.ts — save a browser's YouTube cookies as cookies.txt.
//
// yt-dlp reads a browser's cookie store (`--cookies-from-browser`) and writes its
// cookie jar to a file (`--cookies`) when it exits, so one yt-dlp run with a
// known video (see readBrowserCookieJar in tools.ts) is an export. The export
// only replaces cookies.txt when local expiry/session checks pass. This does not
// verify YouTube accepts the credentials. A failed export never overwrites a
// working file; the previous file is kept as `<cookiesFile>.bak`.

import { COOKIE_BROWSER_NAMES } from "./config";
import { browserCookieFailureReason, diagnoseCookiesText, persistCookieJar } from "./cookie-file";
import { COOKIE_EXPORT_BUDGET_MS, COOKIE_PROBE_TIMEOUT_MS, readBrowserCookieJar } from "./tools";

export interface CookieExportResult {
  ok: boolean;
  browser: string;
  /** The cookies.txt that was written (only when ok). */
  file?: string;
  /** YouTube/Google cookie entries that were exported. */
  cookies?: number;
  /** Previous cookies.txt kept as a backup, when there was one. */
  backup?: string;
  /** Plain-language reason it failed (only when not ok). */
  error?: string;
}

export interface CookieExportOptions {
  /** Override the yt-dlp executable (tests). */
  ytDlp?: string;
  /** Per-browser and whole-sequence time limits. */
  timeoutMs?: number;
  totalTimeoutMs?: number;
  /** Stop publishing/falling back when the live configuration has changed. */
  shouldContinue?: () => boolean;
  /** Optionally fence the final synchronous filesystem renames with the engine lease. */
  publish?: (commit: () => boolean) => boolean;
}

/** Export the cookies of `browser` into `cookiesFile`. Never throws. */
export async function exportBrowserCookies(
  browser: string,
  cookiesFile: string,
  opts: CookieExportOptions = {},
): Promise<CookieExportResult> {
  if (!(COOKIE_BROWSER_NAMES as readonly string[]).includes(browser)) {
    return { ok: false, browser, error: `Unknown browser "${browser}".` };
  }
  if (!cookiesFile.trim()) {
    return { ok: false, browser, error: "No cookies.txt path is configured (cookiesFile)." };
  }

  const shouldContinue = opts.shouldContinue ?? (() => true);
  if (!shouldContinue()) return { ok: false, browser, error: "Cookie configuration changed during extraction." };
  const read = await readBrowserCookieJar(browser, {
    ytDlp: opts.ytDlp, timeoutMs: opts.timeoutMs, shouldContinue,
  });
  if (!shouldContinue()) return { ok: false, browser, error: "Cookie configuration changed during extraction." };
  if (read.timedOut) {
    return { ok: false, browser, error: `Reading ${browser} cookies took too long. Close ${browser} and try again.` };
  }
  if (read.jar === null) {
    // yt-dlp writes the jar on exit; no file means the browser store was never read.
    return { ok: false, browser, error: `Could not read ${browser} cookies: ${browserCookieFailureReason(read.stderr)}` };
  }

  const text = read.jar;
  const diagnosis = diagnoseCookiesText(text);
  if (diagnosis.siteEntries === 0) {
    return {
      ok: false,
      browser,
      error: `${browser} has no YouTube or Google cookies. Sign in to YouTube in ${browser} and try again.`,
    };
  }
  if (!diagnosis.signedIn) {
    return {
      ok: false,
      browser,
      error: `${browser}: ${diagnosis.problem ?? "not signed in to YouTube"}`,
    };
  }

  const result = await persistCookieJar(browser, cookiesFile, text, shouldContinue, opts.publish);
  return { ...result, browser, ...(result.ok ? { file: cookiesFile } : {}) };
}

export interface CookieFallbackExportResult extends CookieExportResult {
  /** Candidates actually attempted, in order, and failures before success. */
  attempted: string[];
  errors: { browser: string; error: string }[];
}

/** Selected default profile first, then each configured default profile once. */
export async function exportBrowserCookiesWithFallback(
  browser: string,
  cookiesFile: string,
  browsers: readonly string[],
  opts: CookieExportOptions = {},
): Promise<CookieFallbackExportResult> {
  const errors: CookieFallbackExportResult["errors"] = [];
  const attempted: string[] = [];
  const deadline = Date.now() + (opts.totalTimeoutMs ?? COOKIE_EXPORT_BUDGET_MS);
  let stopped: string | null = null;
  for (const candidate of new Set([browser, ...browsers])) {
    if (opts.shouldContinue && !opts.shouldContinue()) {
      stopped = "Cookie configuration changed during extraction.";
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { stopped = "Browser fallback time limit reached."; break; }
    attempted.push(candidate);
    const result = await exportBrowserCookies(candidate, cookiesFile, {
      ...opts, timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? COOKIE_PROBE_TIMEOUT_MS, remaining)),
    });
    if (result.ok) return { ...result, attempted, errors };
    errors.push({ browser: candidate, error: result.error ?? "Cookie export failed." });
    if (!cookiesFile.trim()) break;
  }
  const detail = errors.map((item) => `${item.browser}: ${item.error}`).join("; ");
  return { ok: false, browser, attempted, errors, error: [detail, stopped].filter(Boolean).join("; ") };
}
