// src/cookies-export.ts — save a browser's YouTube cookies as cookies.txt.
//
// yt-dlp reads a browser's cookie store (`--cookies-from-browser`) and writes its
// cookie jar to a file (`--cookies`) when it exits, so one yt-dlp run with a
// known video (see readBrowserCookieJar in tools.ts) is an export. The export
// only replaces cookies.txt when the jar verifiably contains a signed-in YouTube
// session, so a failed export never overwrites a working file. The previous file
// is kept as `<cookiesFile>.bak`.

import { COOKIE_BROWSER_NAMES } from "./config";
import { diagnoseCookiesText, persistCookieJar, ytDlpFailureReason } from "./cookie-file";
import { readBrowserCookieJar } from "./tools";

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
  timeoutMs?: number;
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

  const read = await readBrowserCookieJar(browser, { ytDlp: opts.ytDlp, timeoutMs: opts.timeoutMs });
  if (read.timedOut) {
    return { ok: false, browser, error: `Reading ${browser} cookies took too long. Close ${browser} and try again.` };
  }
  if (read.jar === null) {
    // yt-dlp writes the jar on exit; no file means the browser store was never read.
    return { ok: false, browser, error: `Could not read ${browser} cookies: ${ytDlpFailureReason(read.stderr)}` };
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

  const result = await persistCookieJar(browser, cookiesFile, text);
  return { ...result, browser, ...(result.ok ? { file: cookiesFile } : {}) };
}

export interface CookieFallbackExportResult extends CookieExportResult {
  /** Failed candidates, including failures before a successful fallback. */
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
  for (const candidate of new Set([browser, ...browsers])) {
    const result = await exportBrowserCookies(candidate, cookiesFile, opts);
    if (result.ok) return { ...result, errors };
    errors.push({ browser: candidate, error: result.error ?? "Cookie export failed." });
    if (!cookiesFile.trim()) break;
  }
  return { ok: false, browser, errors, error: errors.map(item => `${item.browser}: ${item.error}`).join("; ") };
}
