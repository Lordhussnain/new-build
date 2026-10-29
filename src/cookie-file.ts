// src/cookie-file.ts — read and explain Netscape cookies.txt files, and pull the
// useful reason out of yt-dlp's output when a cookie source fails.
//
// Parsing and serialized persistence live below the tool/export layers so manual
// and automatic exports share the same atomic writer without an import cycle.

import { createHash } from "node:crypto";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Cookies that mean "signed in to YouTube/Google". */
export const SESSION_COOKIE_NAMES = ["SID", "__Secure-1PSID", "__Secure-3PSID", "LOGIN_INFO"] as const;

export interface CookieFileDiagnosis {
  /** Lines that are real cookie entries (7 TAB-separated fields). */
  entries: number;
  /** Entries for youtube.com or google.com. */
  siteEntries: number;
  /** A session cookie for those sites is present. */
  signedIn: boolean;
  /** Plain-language reason the file cannot be used, or null when it looks valid. */
  problem: string | null;
}

/** Netscape cookie lines have exactly 7 TAB-separated fields. */
const NETSCAPE_FIELDS = 7;

function onCookieSite(domain: string): boolean {
  return /^(?:[a-z0-9-]+\.)*(?:youtube|google)\.com$/i.test(domain.replace(/^\./, ""));
}

function cookieExpiry(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const expiry = Number(value);
  return Number.isSafeInteger(expiry) ? expiry : null;
}

function cookieFields(raw: string): string[] | null {
  const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
  if (!line.trim() || line.startsWith("#")) return null;
  const fields = line.split("\t");
  return fields.length === NETSCAPE_FIELDS ? fields : null;
}

/** Only live YouTube/Google rows, retaining the HttpOnly prefix verbatim. */
export function filterCookiesText(text: string, nowMs = Date.now()): string {
  const rows = text.split(/\r?\n/).filter(raw => {
    const fields = cookieFields(raw);
    if (!fields || !onCookieSite(fields[0])) return false;
    const expiry = cookieExpiry(fields[4]);
    return expiry !== null && (expiry === 0 || expiry * 1000 > nowMs) && !!fields[6].trim();
  });
  return `# Netscape HTTP Cookie File\n${rows.join("\n")}\n`;
}

/**
 * Parse the text of a cookies.txt file. Never throws.
 *
 * Checked locally, with no network: a signed-in session is a session cookie
 * whose expiry (field 5, seconds; 0 = browser-session cookie) is still ahead.
 */
export function diagnoseCookiesText(text: string, nowMs: number = Date.now()): CookieFileDiagnosis {
  const trimmed = text.trim();
  if (!trimmed) {
    return { entries: 0, siteEntries: 0, signedIn: false, problem: "cookies.txt is empty." };
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return {
      entries: 0,
      siteEntries: 0,
      signedIn: false,
      problem:
        "This is JSON, not a Netscape cookies.txt. Export with a \"Netscape\" / \"cookies.txt\" exporter, or use Save Browser Cookies.",
    };
  }

  let entries = 0;
  let siteEntries = 0;
  let signedIn = false;
  let expiredSession = false;
  for (const raw of text.split(/\r?\n/)) {
    const fields = cookieFields(raw);
    if (!fields) continue;
    entries++;
    if (!onCookieSite(fields[0])) continue;
    siteEntries++;
    if (!(SESSION_COOKIE_NAMES as readonly string[]).includes(fields[5]) || !fields[6].trim()) continue;
    const expires = cookieExpiry(fields[4]);
    if (expires === null) continue;
    if (expires === 0 || expires * 1000 > nowMs) signedIn = true;
    else expiredSession = true;
  }

  let problem: string | null = null;
  if (entries === 0) {
    problem =
      "No cookie lines found. Each cookie must be one line with 7 fields separated by TAB characters (not spaces).";
  } else if (siteEntries === 0) {
    problem = "The file has cookies, but none for youtube.com or google.com.";
  } else if (!signedIn && expiredSession) {
    problem = "The YouTube/Google session cookies have expired. Sign in to YouTube again and export again.";
  } else if (!signedIn) {
    problem = "The file has YouTube/Google cookies, but no session cookie (SID / __Secure-3PSID). Sign in to YouTube and export again.";
  }
  return { entries, siteEntries, signedIn, problem };
}

/**
 * The most useful line from yt-dlp's stderr when it fails. yt-dlp's last line is
 * often a generic "failed to load cookies"; the real cause (a locked Chrome
 * database, a missing profile, DPAPI) is the line before it.
 */
export function ytDlpFailureReason(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:ERROR|WARNING):/.test(line))
    .map((line) => line.replace(/^(?:ERROR|WARNING):\s*/, ""))
    .filter((line) => line && !/^failed to load cookies$/i.test(line));
  if (lines.length === 0) {
    const fallback = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || "no output from yt-dlp";
    return fallback.slice(0, 300);
  }
  const cookieish = lines.filter((line) =>
    /cookie|database|profile|decrypt|dpapi|keyring|copy|locked|permission|could not|not found|unable/i.test(line),
  );
  return (cookieish.at(-1) ?? lines.at(-1)!).slice(0, 300);
}

/** Absolute, case-folded on Windows: caches and write locks use file identity. */
export function cookiePathKey(file: string): string {
  const path = resolve(file);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

const exportLocks = new Map<string, Promise<unknown>>();
const exportsByPath = new Map<string, { hash: string; source: string; exportedAt: string }>();

export function cookieExportMetadata(file: string, hash: string) {
  const record = exportsByPath.get(cookiePathKey(file));
  return record?.hash === hash ? { source: record.source, exportedAt: record.exportedAt } : null;
}

/** Reuse an already-extracted jar; never extract twice just to persist it. */
export async function persistCookieJar(
  browser: string,
  file: string,
  jar: string,
  stillCurrent: () => boolean = () => true,
): Promise<{ ok: boolean; cookies?: number; backup?: string; error?: string }> {
  const key = cookiePathKey(file);
  const previous = exportLocks.get(key) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const text = filterCookiesText(jar);
    const diagnosis = diagnoseCookiesText(text);
    if (diagnosis.problem) return { ok: false, error: `${browser}: ${diagnosis.problem}` };
    if (!file.trim()) return { ok: false, error: "No cookies.txt path is configured (cookiesFile)." };
    const incoming = `${file}.incoming`;
    let backup: string | undefined;
    try {
      if (!stillCurrent()) return { ok: false, error: "Cookie configuration changed during extraction." };
      await writeFile(incoming, text, { encoding: "utf8", mode: 0o600 });
      if (!stillCurrent()) return { ok: false, error: "Cookie configuration changed during extraction." };
      try {
        await copyFile(file, `${file}.bak`);
        backup = `${file}.bak`;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!stillCurrent()) return { ok: false, error: "Cookie configuration changed during extraction." };
      await rename(incoming, file);
      exportsByPath.set(key, {
        hash: createHash("sha256").update(text).digest("hex"),
        source: browser,
        exportedAt: new Date().toISOString(),
      });
      return { ok: true, cookies: diagnosis.siteEntries, backup };
    } catch (error: any) {
      return { ok: false, error: `Could not write ${file}: ${error?.message || error}` };
    } finally {
      await rm(incoming, { force: true }).catch(() => {});
    }
  });
  exportLocks.set(key, write);
  try { return await write; }
  finally { if (exportLocks.get(key) === write) exportLocks.delete(key); }
}
