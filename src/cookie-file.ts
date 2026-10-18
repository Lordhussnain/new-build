// src/cookie-file.ts — read and explain Netscape cookies.txt files, and pull the
// useful reason out of yt-dlp's output when a cookie source fails.
//
// Pure functions only (no spawning, no config), so both the probe in tools.ts
// and the browser export in cookies-export.ts can use them without an import cycle.

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

/** Parse the text of a cookies.txt file. Never throws. */
export function diagnoseCookiesText(text: string): CookieFileDiagnosis {
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
  for (const raw of text.split(/\r?\n/)) {
    // #HttpOnly_ marks HttpOnly cookies and is still a cookie line.
    const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
    if (!line.trim() || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length !== NETSCAPE_FIELDS) continue;
    entries++;
    const domain = fields[0].trim().toLowerCase();
    const onSite = domain.endsWith("youtube.com") || domain.endsWith("google.com");
    if (!onSite) continue;
    siteEntries++;
    if ((SESSION_COOKIE_NAMES as readonly string[]).includes(fields[5])) signedIn = true;
  }

  let problem: string | null = null;
  if (entries === 0) {
    problem =
      "No cookie lines found. Each cookie must be one line with 7 fields separated by TAB characters (not spaces).";
  } else if (siteEntries === 0) {
    problem = "The file has cookies, but none for youtube.com or google.com.";
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
