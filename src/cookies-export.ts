// src/cookies-export.ts — save a browser's YouTube cookies as cookies.txt.
//
// yt-dlp can read a browser's cookie store (`--cookies-from-browser`) AND write
// its cookie jar to a file (`--cookies`) when it exits. Combining the two turns
// one yt-dlp run into an export. The export is written to a temp file first and
// only replaces cookies.txt when it verifiably contains a signed-in YouTube
// session, so a failed export (browser locked, not signed in) never overwrites
// a working cookies.txt. The previous file is kept as `<cookiesFile>.bak`.

import { existsSync } from "node:fs";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { COOKIE_BROWSER_NAMES } from "./config";
import { diagnoseCookiesText, ytDlpFailureReason } from "./cookie-file";
import { jsRuntimeArgs, ytDlp } from "./tools";

/** Any public video works: yt-dlp only needs to load the browser's cookies. */
export const COOKIE_EXPORT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
/** Upper bound for one export (a browser store can be slow to unlock). */
export const COOKIE_EXPORT_TIMEOUT_MS = 120_000;

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

  const staging = `${cookiesFile}.export-${process.pid}-${Date.now()}.txt`;
  const cleanup = () => rm(staging, { force: true }).catch(() => {});
  const timeoutMs = opts.timeoutMs ?? COOKIE_EXPORT_TIMEOUT_MS;

  let stderr = "";
  let code = -1;
  let timedOut = false;
  try {
    const child = Bun.spawn(
      [
        opts.ytDlp ?? ytDlp(),
        "--cookies-from-browser",
        browser,
        "--cookies",
        staging,
        "--skip-download",
        "--ignore-no-formats-error",
        "--socket-timeout",
        "15",
        "--retries",
        "1",
        ...jsRuntimeArgs(),
        COOKIE_EXPORT_URL,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, timeoutMs);
    try {
      [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error: any) {
    await cleanup();
    return { ok: false, browser, error: `Could not start yt-dlp: ${error?.message || error}` };
  }

  if (timedOut) {
    await cleanup();
    return { ok: false, browser, error: `Reading ${browser} cookies took longer than ${Math.round(timeoutMs / 1000)}s.` };
  }
  if (!existsSync(staging)) {
    // yt-dlp writes the jar on exit; no file means the browser store was never read.
    const reason = ytDlpFailureReason(stderr);
    return { ok: false, browser, error: `Could not read ${browser} cookies: ${reason}` };
  }

  const text = await readFile(staging, "utf8").catch(() => "");
  await cleanup();
  const diagnosis = diagnoseCookiesText(text);
  if (diagnosis.siteEntries === 0) {
    const reason = ytDlpFailureReason(stderr);
    return {
      ok: false,
      browser,
      error: `${browser} has no YouTube or Google cookies. Sign in to YouTube in ${browser} and try again.${reason ? ` (${reason})` : ""}`,
    };
  }
  if (!diagnosis.signedIn) {
    return {
      ok: false,
      browser,
      error: `${browser} is not signed in to YouTube (no session cookie). Sign in to YouTube in ${browser}, then export again.`,
    };
  }

  // Verified: replace cookies.txt atomically, keeping the old file as a backup.
  // Write the staged copy under a second name, then rename it into place.
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
