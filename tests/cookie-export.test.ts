// tests/cookie-export.test.ts — cookies.txt parsing, diagnosis, and browser export.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseCookiesText, ytDlpFailureReason } from "../src/cookie-file";
import { exportBrowserCookies } from "../src/cookies-export";
import { COOKIE_JAR_URL, probeBrowserCookies, probeCookieFile, resolvedTools } from "../src/tools";

const WIN = process.platform === "win32";
const dir = await mkdtemp(join(tmpdir(), "cookie-export-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const tab = (...fields: string[]) => fields.join("\t");
const SIGNED_IN = [
  "# Netscape HTTP Cookie File",
  tab(".youtube.com", "TRUE", "/", "TRUE", "1900000000", "SID", "sid-value"),
  tab(".youtube.com", "TRUE", "/", "TRUE", "1900000000", "PREF", "tz=Asia.Karachi"),
  tab("#HttpOnly_.google.com", "TRUE", "/", "TRUE", "1900000000", "__Secure-3PSID", "x"),
  "",
].join("\n");
const ANONYMOUS = ["# Netscape HTTP Cookie File", tab(".youtube.com", "TRUE", "/", "FALSE", "0", "PREF", "f1=50000000")].join("\n");

describe("diagnoseCookiesText", () => {
  test("a signed-in Netscape export is valid and counts its YouTube/Google entries", () => {
    expect(diagnoseCookiesText(SIGNED_IN)).toEqual({ entries: 3, siteEntries: 3, signedIn: true, problem: null });
  });

  test("JSON exports are explained, not mistaken for an expired file", () => {
    const diagnosis = diagnoseCookiesText('[{"domain": ".youtube.com", "name": "SID"}]');
    expect(diagnosis.problem).toContain("This is JSON, not a Netscape cookies.txt");
  });

  test("space-separated lines (a copy-paste from a table) are reported as a format problem", () => {
    const spaces = "# Netscape HTTP Cookie File\n.youtube.com TRUE / TRUE 1900000000 SID sid-value\n";
    expect(diagnoseCookiesText(spaces).problem).toContain("7 fields separated by TAB");
  });

  test("an empty file says so", () => {
    expect(diagnoseCookiesText("   \n").problem).toBe("cookies.txt is empty.");
  });

  test("cookies for other sites are not YouTube cookies", () => {
    const other = tab(".example.com", "TRUE", "/", "FALSE", "0", "SID", "x");
    expect(diagnoseCookiesText(other).problem).toContain("none for youtube.com or google.com");
  });

  test("a YouTube export without a session cookie says it is signed out", () => {
    const diagnosis = diagnoseCookiesText(ANONYMOUS);
    expect(diagnosis.siteEntries).toBe(1);
    expect(diagnosis.signedIn).toBe(false);
    expect(diagnosis.problem).toContain("no session cookie");
  });
});

describe("session expiry (checked locally)", () => {
  const now = Date.UTC(2026, 9, 21);
  const session = (expires: string) => ["# Netscape HTTP Cookie File", tab(".youtube.com", "TRUE", "/", "TRUE", expires, "SID", "x")].join("\n");

  test("a session cookie that expires in the future counts as signed in", () => {
    const future = String(Math.floor(now / 1000) + 86400);
    expect(diagnoseCookiesText(session(future), now).signedIn).toBe(true);
  });

  test("a browser-session cookie (expiry 0) counts as signed in", () => {
    expect(diagnoseCookiesText(session("0"), now).signedIn).toBe(true);
  });

  test("an expired session cookie is reported as expired, not as missing", () => {
    const past = String(Math.floor(now / 1000) - 86400);
    const diagnosis = diagnoseCookiesText(session(past), now);
    expect(diagnosis.signedIn).toBe(false);
    expect(diagnosis.problem).toContain("have expired");
  });
});

describe("probeCookieFile", () => {
  test("a signed-in file is ok without any network call", async () => {
    const file = join(dir, "probe-ok.txt");
    await writeFile(file, SIGNED_IN);
    expect(probeCookieFile(file)).toEqual({ ok: true, reason: "" });
  });

  test("a missing file reports why", () => {
    expect(probeCookieFile(join(dir, "nope.txt")).reason).toBe("cookies.txt is empty.");
  });
});

describe("probeBrowserCookies", () => {
  test.skipIf(WIN)("a browser whose jar has a live session is ok; one with no session is not", async () => {
    const signedIn = await fakeYtDlp("probe-in", `await Bun.write(argValue("--cookies"), ${JSON.stringify(SIGNED_IN)}); process.exit(1);`);
    const signedOut = await fakeYtDlp("probe-out", `await Bun.write(argValue("--cookies"), ${JSON.stringify(ANONYMOUS)}); process.exit(1);`);
    const original = resolvedTools.ytDlp;
    try {
      resolvedTools.ytDlp = signedIn;
      expect(await probeBrowserCookies("firefox")).toEqual({ ok: true, reason: "" });
      resolvedTools.ytDlp = signedOut;
      expect((await probeBrowserCookies("firefox")).ok).toBe(false);
    } finally {
      resolvedTools.ytDlp = original;
    }
  });

  test.skipIf(WIN)("a browser store that cannot be read reports yt-dlp's reason", async () => {
    const original = resolvedTools.ytDlp;
    try {
      resolvedTools.ytDlp = await fakeYtDlp("probe-locked", `console.error("ERROR: Could not copy Chrome cookie database"); process.exit(1);`);
      expect(await probeBrowserCookies("chrome")).toEqual({
        ok: false,
        reason: "could not read chrome cookies: Could not copy Chrome cookie database",
      });
    } finally {
      resolvedTools.ytDlp = original;
    }
  });
});

describe("the export command", () => {
  test.skipIf(WIN)("runs the verified command: browser cookies to a jar, nothing downloaded, one playlist item", async () => {
    const argsFile = join(dir, "export-args.json");
    const fake = await fakeYtDlp(
      "export-args",
      `await Bun.write(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); await Bun.write(argValue("--cookies"), ${JSON.stringify(SIGNED_IN)});`,
    );
    const original = resolvedTools.ytDlp;
    try {
      resolvedTools.ytDlp = fake;
      const result = await exportBrowserCookies("firefox", join(dir, "export-cookies.txt"));
      expect(result.ok).toBe(true);
    } finally {
      resolvedTools.ytDlp = original;
    }
    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    expect(args.slice(0, 4)).toEqual(["--cookies-from-browser", "firefox", "--cookies", args[3]]);
    expect(args.slice(4)).toEqual(["--skip-download", "--playlist-items", "0", COOKIE_JAR_URL]);
    expect(COOKIE_JAR_URL).toBe("https://www.youtube.com/watch?v=Are3UkcYytw");
  });
});

describe("ytDlpFailureReason", () => {
  test("prefers the real cause over yt-dlp's generic last line", () => {
    const stderr = [
      "[Cookies] Extracting cookies from chrome",
      "ERROR: Could not copy Chrome cookie database. See  https://example.invalid for more info",
      "ERROR: failed to load cookies",
    ].join("\n");
    expect(ytDlpFailureReason(stderr)).toBe("Could not copy Chrome cookie database. See  https://example.invalid for more info");
  });

  test("falls back to the last line when there is no ERROR/WARNING prefix", () => {
    expect(ytDlpFailureReason("something odd happened\n")).toBe("something odd happened");
    expect(ytDlpFailureReason("")).toBe("no output from yt-dlp");
  });
});

describe("exportBrowserCookies", () => {
  test("rejects unknown browsers and a missing path without starting yt-dlp", async () => {
    expect((await exportBrowserCookies("netscape", join(dir, "a.txt"))).error).toContain("Unknown browser");
    expect((await exportBrowserCookies("firefox", "  ")).error).toContain("No cookies.txt path");
  });

  test.skipIf(WIN)("a signed-in browser replaces cookies.txt and keeps the old file as .bak", async () => {
    const target = join(dir, "signed-in", "cookies.txt");
    await Bun.write(join(dir, "signed-in", ".keep"), "");
    await writeFile(target, "# old export\n");
    const fake = await fakeYtDlp("signed-in", `await Bun.write(argValue("--cookies"), ${JSON.stringify(SIGNED_IN)});`);
    const result = await exportBrowserCookies("firefox", target, { ytDlp: fake });
    expect(result).toMatchObject({ ok: true, browser: "firefox", cookies: 3, file: target });
    expect(await readFile(target, "utf8")).toBe(SIGNED_IN);
    expect(await readFile(`${target}.bak`, "utf8")).toBe("# old export\n");
    expect((await readdir(join(dir, "signed-in"))).filter((name) => name.includes("export-") || name.includes("incoming"))).toEqual([]);
  });

  test.skipIf(WIN)("a signed-out browser never overwrites a working cookies.txt", async () => {
    const target = join(dir, "signed-out", "cookies.txt");
    await Bun.write(join(dir, "signed-out", ".keep"), "");
    await writeFile(target, SIGNED_IN);
    const fake = await fakeYtDlp("signed-out", `await Bun.write(argValue("--cookies"), ${JSON.stringify(ANONYMOUS)});`);
    const result = await exportBrowserCookies("firefox", target, { ytDlp: fake });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no session cookie");
    expect(await readFile(target, "utf8")).toBe(SIGNED_IN);
  });

  test.skipIf(WIN)("a browser store that cannot be read reports yt-dlp's real reason", async () => {
    const target = join(dir, "locked", "cookies.txt");
    await Bun.write(join(dir, "locked", ".keep"), "");
    const fake = await fakeYtDlp(
      "locked",
      `console.error("ERROR: Could not copy Chrome cookie database. Close Chrome and try again"); console.error("ERROR: failed to load cookies"); process.exit(1);`,
    );
    const result = await exportBrowserCookies("chrome", target, { ytDlp: fake });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Could not read chrome cookies: Could not copy Chrome cookie database. Close Chrome and try again");
    expect(await readdir(join(dir, "locked"))).toEqual([".keep"]);
  });

  test.skipIf(WIN)("a missing YouTube cookie set is reported before anything is written", async () => {
    const target = join(dir, "no-site", "cookies.txt");
    await Bun.write(join(dir, "no-site", ".keep"), "");
    const fake = await fakeYtDlp("no-site", `await Bun.write(argValue("--cookies"), "# Netscape HTTP Cookie File\\n");`);
    const result = await exportBrowserCookies("firefox", target, { ytDlp: fake });
    expect(result.error).toContain("has no YouTube or Google cookies");
  });
});

/** A tiny executable that stands in for yt-dlp: `body` runs with `argValue()` available. */
async function fakeYtDlp(name: string, body: string): Promise<string> {
  const path = join(dir, `fake-${name}.ts`);
  const script = [
    "#!/usr/bin/env bun",
    "const argValue = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : ''; };",
    body,
    "process.exit(0);",
  ].join("\n");
  await writeFile(path, script + "\n", "utf8");
  await chmod(path, 0o755);
  return path;
}
