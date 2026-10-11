// tests/cookie-sources.test.ts — where yt-dlp's cookies come from.
//
// The browser probes spawn the real yt-dlp, so these tests cover the decisions
// that never reach a probe: cookies.txt wins when present, nothing is probed
// when validation is off, and an empty cookieBrowsers list means anonymous.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, parseConfig } from "../src/config";
import { activeBrowserCookieSource, cookiesArgs, resolveCookieSource } from "../src/tools";

const dir = await mkdtemp(join(tmpdir(), "cookie-sources-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const base = { cookiesFile: join(dir, "cookies.txt"), validateCookiesOnStart: true, cookieBrowsers: [] as string[], offlineMode: false };

describe("cookie source config", () => {
  test("defaults to trying firefox, chrome, then brave after cookies.txt", () => {
    expect(DEFAULT_CONFIG.cookieBrowsers).toEqual(["firefox", "chrome", "brave"]);
    expect(parseConfig({}).cookieBrowsers).toEqual(["firefox", "chrome", "brave"]);
  });

  test("rejects unknown browser names", () => {
    expect(() => parseConfig({ cookieBrowsers: ["netscape"] })).toThrow();
  });
});

describe("cookiesArgs before any resolution", () => {
  test("no cookies.txt and nothing resolved means anonymous", () => {
    expect(cookiesArgs(base)).toEqual([]);
  });

  test("a non-empty cookies.txt is used as before", async () => {
    await writeFile(base.cookiesFile, "# Netscape HTTP Cookie File\n");
    expect(cookiesArgs(base)).toEqual(["--cookies", base.cookiesFile]);
  });
});

describe("resolveCookieSource", () => {
  test("validation off: a present cookies.txt is trusted and no browser is probed", async () => {
    const lines: string[] = [];
    await resolveCookieSource(
      { ...base, validateCookiesOnStart: false, cookieBrowsers: ["firefox"] },
      { log: (m) => lines.push(m) },
    );
    expect(lines).toEqual([]);
    expect(activeBrowserCookieSource()).toBeNull();
    expect(cookiesArgs(base)).toEqual(["--cookies", base.cookiesFile]);
  });

  test("offline mode does no probing and leaves the sources untouched", async () => {
    const lines: string[] = [];
    await resolveCookieSource({ ...base, cookiesFile: join(dir, "missing.txt"), offlineMode: true, cookieBrowsers: ["firefox"] }, {
      log: (m) => lines.push(m),
    });
    expect(lines).toEqual([]);
  });

  test("no cookies.txt and no browsers configured: says so and stays anonymous", async () => {
    const lines: string[] = [];
    const noFile = { ...base, cookiesFile: join(dir, "absent.txt"), cookieBrowsers: [] as string[] };
    await resolveCookieSource(noFile, { log: (m) => lines.push(m) });
    expect(lines.join("\n")).toContain("no cookieBrowsers configured");
    expect(activeBrowserCookieSource()).toBeNull();
    expect(cookiesArgs(noFile)).toEqual([]);
  });
});
