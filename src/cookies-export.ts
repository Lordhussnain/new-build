// src/cookies-export.ts — save a browser's YouTube cookies as cookies.txt.
//
// yt-dlp reads a browser's cookie store (`--cookies-from-browser`) and writes its
// cookie jar to a file (`--cookies`) when it exits, so one quick yt-dlp run is an
// export (see readBrowserCookieJar in tools.ts: no video is fetched). The export
// only replaces cookies.txt when the jar verifiably contains a signed-in YouTube
// session, so a failed export never overwrites a working file. The previous file
// is kept as `<cookiesFile>.bak`.

import { existsSync } from "node:fs";
import { copyFile, rm, writeFile, rename } from "node:fs/promises";
import { COOKIE_BROWSER_NAMES } from "./config";
import { diagnoseCookiesText, ytDlpFailureReason } from "./cookie-file";
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

  // Verified: replace cookies.txt atomically, keeping the old file as a backup.
  const incoming = `${cookiesFile}.incoming`;
  let backup: string | undefined;
  try {
    await writeFile(incoming, text, "utf8");
    if (existsSync(cookiesFile)) {
      backup = `${cookiesFile}.bak`;
      await copyFile(cookiesFile, backup);
    }
    await rename(incoming, cookiesFile);
  } catch (error: any) {
    await rm(incoming, { force: true }).catch(() => {});
    return { ok: false, browser, error: `Could not write ${cookiesFile}: ${error?.message || error}` };
  }
  return { ok: true, browser, file: cookiesFile, cookies: diagnosis.siteEntries, backup };
}
