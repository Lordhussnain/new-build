// tests/cookie-sources.test.ts — cookie-source decisions and per-child isolation.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, parseConfig } from "../src/config";
import { activeBrowserCookieSource, createCookieInvocation, resolveCookieSource } from "../src/tools";

const dir = await mkdtemp(join(tmpdir(), "cookie-sources-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const base = { cookiesFile: join(dir, "cookies.txt"), validateCookiesOnStart: true, cookieBrowsers: [] as string[], offlineMode: false };
const jar = (value: string) => `# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t${value}\n`;

function hasCookie(config: { cookiesFile: string }): boolean {
  const cookie = createCookieInvocation(config);
  try { return cookie.args.length > 0; }
  finally { cookie.cleanup(); }
}

describe("cookie source config", () => {
  test("defaults to trying firefox, chrome, then brave after cookies.txt", () => {
    expect(DEFAULT_CONFIG.cookieBrowsers).toEqual(["firefox", "chrome", "brave"]);
    expect(parseConfig({}).cookieBrowsers).toEqual(["firefox", "chrome", "brave"]);
  });
  test("rejects unknown browser names", () => {
    expect(() => parseConfig({ cookieBrowsers: ["netscape"] })).toThrow();
  });
});

describe("cookie invocations before resolution", () => {
  test("no cookies.txt means anonymous", () => expect(hasCookie(base)).toBe(false));
  test("a non-empty cookies.txt is used as before", async () => {
    await writeFile(base.cookiesFile, "# Netscape HTTP Cookie File\n");
    expect(hasCookie(base)).toBe(true);
  });
});

describe("resolveCookieSource", () => {
  test("validation off: a present cookies.txt is trusted and no browser is probed", async () => {
    const lines: string[] = [];
    await resolveCookieSource({ ...base, validateCookiesOnStart: false, cookieBrowsers: ["firefox"] }, { log: (m) => lines.push(m) });
    expect(lines).toEqual([]);
    expect(activeBrowserCookieSource()).toBeNull();
    expect(hasCookie(base)).toBe(true);
  });
  test("offline mode does no probing and leaves sources untouched", async () => {
    const lines: string[] = [];
    await resolveCookieSource({ ...base, cookiesFile: join(dir, "missing.txt"), offlineMode: true, cookieBrowsers: ["firefox"] }, { log: (m) => lines.push(m) });
    expect(lines).toEqual([]);
  });
  test("no cookies.txt and no browsers configured: says so and stays anonymous", async () => {
    const lines: string[] = [];
    const noFile = { ...base, cookiesFile: join(dir, "absent.txt"), cookieBrowsers: [] as string[] };
    await resolveCookieSource(noFile, { log: (m) => lines.push(m) });
    expect(lines.join("\n")).toContain("no cookieBrowsers configured");
    expect(activeBrowserCookieSource()).toBeNull();
    expect(hasCookie(noFile)).toBe(false);
  });
});

describe("private cookie snapshots", () => {
  test("overlapping children cannot overwrite a newer export or each other's snapshots", async () => {
    const file = join(dir, "export.txt");
    await writeFile(file, jar("old"));
    const old = createCookieInvocation({ cookiesFile: file });
    await writeFile(file, jar("new"));
    const fresh = createCookieInvocation({ cookiesFile: file });
    try {
      expect(old.args[0]).toBe("--cookies");
      expect(old.args[1]).not.toBe(file);
      expect(fresh.args[1]).not.toBe(old.args[1]);
      expect(old.fingerprint).not.toBe(fresh.fingerprint);
      // Simulate the older yt-dlp dumping its stale jar after the new one starts.
      await writeFile(old.args[1], jar("stale-dump"));
      expect(await readFile(fresh.args[1], "utf8")).toBe(jar("new"));
      expect(await readFile(file, "utf8")).toBe(jar("new"));
    } finally { old.cleanup(); fresh.cleanup(); }
    expect(existsSync(old.args[1])).toBe(false);
    expect(existsSync(fresh.args[1])).toBe(false);
  });

  test("a failed private-copy creation never exposes or changes the export", async () => {
    const file = join(dir, "private.txt");
    await writeFile(file, jar("secret"));
    const session = createCookieInvocation({ cookiesFile: file }, { tempRoot: join(dir, "missing-directory") });
    expect(session.args).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(jar("secret"));
    session.cleanup();
  });
});
