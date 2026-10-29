import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, statSync, utimesSync, watch } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diagnoseCookiesText } from "../src/cookie-file";
import * as exportsApi from "../src/cookies-export";
import * as tools from "../src/tools";
import { DEFAULT_CONFIG } from "../src/config";
import { getConfig, setConfig } from "../src/state";

const WIN = process.platform === "win32";
const BUDGET = WIN ? 30_000 : 10_000;
const dir = await mkdtemp(join(tmpdir(), "yta-cookie-fixtures-"));
const modeFile = join(dir, "mode.json");
const callsFile = join(dir, "calls.jsonl");
const row = (domain: string, expiry = "0", value = "fixture-session", name = "SID") =>
  `${domain}\tTRUE\t/\tTRUE\t${expiry}\t${name}\t${value}`;
const valid = `# Netscape HTTP Cookie File\n${row(".youtube.com")}\n`;
let binary = "";
let target = "";
let index = 0;
const originalTool = tools.resolvedTools.ytDlp;
const originalConfig = getConfig();
const config = () => ({ ...DEFAULT_CONFIG, cookiesFile: target, cookieBrowsers: ["chrome", "firefox"] as typeof DEFAULT_CONFIG.cookieBrowsers });
const calls = () => readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
async function mode(value: object) { await writeFile(modeFile, JSON.stringify(value)); }

beforeAll(async () => {
  const script = join(dir, "fixture.ts");
  await writeFile(script, `#!${process.execPath}
import { readFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const browser = args[args.indexOf("--cookies-from-browser") + 1];
const jar = args[args.indexOf("--cookies") + 1];
const modes = JSON.parse(readFileSync(${JSON.stringify(modeFile)}, "utf8"));
const m = modes[browser] ?? {};
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ browser, jar, pid: process.pid, args }) + "\\n");
console.error("fixture-ready");
if (m.flood) {
  const block = "x".repeat(65536);
  for (let i = 0; i < 64; i++) { await Bun.write(Bun.stdout, block); await Bun.write(Bun.stderr, block); }
}
if (m.delay) await Bun.sleep(m.delay);
if (m.jar !== undefined) await Bun.write(jar, m.jar);
if (m.hang) await new Promise(() => setInterval(() => {}, 1000));
console.error("ERROR: " + (m.error ?? "fixture browser unavailable"));
process.exit(m.code ?? 1);
`);
  if (WIN) {
    binary = join(dir, "fixture.exe");
    const build = Bun.spawn([process.execPath, "build", "--compile", script, "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
    const [, stderr, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
    if (code !== 0) throw new Error(stderr);
  } else { binary = script; await chmod(script, 0o755); }
}, BUDGET);
beforeEach(async () => {
  target = join(dir, `cookies-${++index}.txt`);
  await writeFile(callsFile, "");
  await mode({});
  tools.resolvedTools.ytDlp = binary;
  setConfig(originalConfig);
});
afterAll(async () => {
  tools.resolvedTools.ytDlp = originalTool;
  setConfig(originalConfig);
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

for (const domain of ["notyoutube.com", ".notgoogle.com", "youtube.com.evil.test"]) {
  test(`rejects lookalike cookie domain ${domain}`, () => {
    expect(diagnoseCookiesText(row(domain)).signedIn).toBe(false);
  });
}
for (const expiry of ["garbage", "", " ", "NaN", "Infinity", "1e20", "-1", "12.5"]) {
  test(`rejects malformed expiry ${JSON.stringify(expiry)}`, () => {
    expect(diagnoseCookiesText(row(".youtube.com", expiry)).signedIn).toBe(false);
  });
}
test("accepts exact domains and subdomains, but not blank session values", () => {
  for (const domain of ["youtube.com", "m.youtube.com", ".google.com", "accounts.google.com"]) {
    expect(diagnoseCookiesText(row(domain)).signedIn).toBe(true);
    expect(diagnoseCookiesText(row(domain, "0", "   ")).signedIn).toBe(false);
  }
});
test("drains both flooded pipes and bounds diagnostics before reading the jar", async () => {
  await mode({ firefox: { flood: true, jar: valid } });
  const result = await tools.readBrowserCookieJar("firefox", { ytDlp: binary, timeoutMs: 5000 });
  expect(result.timedOut).toBe(false);
  expect(result.jar).toBe(valid);
  expect(result.stderr.length).toBeLessThanOrEqual(16_384);
  expect(result.stderr).toContain("fixture browser unavailable");
  expect(existsSync(dirname(calls()[0].jar))).toBe(false);
}, BUDGET);
test("timeout kills and reaps the child and removes its temporary jar", async () => {
  await mode({ firefox: { jar: valid, hang: true } });
  const result = await tools.readBrowserCookieJar("firefox", { ytDlp: binary, timeoutMs: 1500 });
  expect(result.timedOut).toBe(true);
  const call = calls()[0];
  expect(call).toBeDefined();
  expect(() => process.kill(call.pid, 0)).toThrow();
  expect(existsSync(dirname(call.jar))).toBe(false);
}, BUDGET);
test("low-level reader rejects custom profiles and unknown browsers without spawning", async () => {
  for (const browser of ["firefox:private", "chrome+keyring", "netscape"]) {
    const result = await tools.readBrowserCookieJar(browser, { ytDlp: binary });
    expect(result.jar).toBeNull();
    expect(result.stderr).toContain("Unknown browser");
  }
  expect(calls()).toEqual([]);
});
test("export filters unrelated, expired and malformed rows but preserves HttpOnly and expiry zero", async () => {
  const kept = [row("#HttpOnly_.google.com"), row("m.youtube.com", "0", "pref", "PREF")];
  await mode({ firefox: { jar: [valid.trim(), ...kept, row("notyoutube.com"), row(".youtube.com", "1"), row(".google.com", "bad")].join("\n") } });
  await writeFile(target, valid);
  const result = await exportsApi.exportBrowserCookies("firefox", target, { ytDlp: binary });
  expect(result).toMatchObject({ ok: true, cookies: 3 });
  const text = await readFile(target, "utf8");
  expect(text).toBe(`${valid.trim()}\n${kept.join("\n")}\n`);
  expect(await readFile(`${target}.bak`, "utf8")).toBe(valid);
}, BUDGET);
test("fallback tries selected then unique configured defaults and reports actual browser plus errors", async () => {
  expect(typeof exportsApi.exportBrowserCookiesWithFallback).toBe("function");
  await mode({ firefox: { jar: valid } });
  const result = await exportsApi.exportBrowserCookiesWithFallback("chrome", target, ["chrome", "netscape", "firefox", "firefox"] , { ytDlp: binary });
  expect(result).toMatchObject({ ok: true, browser: "firefox", cookies: 1 });
  expect(result.errors.length).toBeGreaterThan(0);
  expect(calls().map(c => c.browser)).toEqual(["chrome", "firefox"]);
  expect(await readFile(target, "utf8")).toBe(valid);
}, BUDGET);
test("failed fallback retains a previous valid export and leaves no incoming file", async () => {
  expect(typeof exportsApi.exportBrowserCookiesWithFallback).toBe("function");
  await writeFile(target, valid);
  const result = await exportsApi.exportBrowserCookiesWithFallback("chrome", target, ["firefox"], { ytDlp: binary });
  expect(result.ok).toBe(false);
  expect(result.errors).toHaveLength(2);
  expect(await readFile(target, "utf8")).toBe(valid);
  expect((await readdir(dir)).filter(n => n.includes("incoming"))).toEqual([]);
}, BUDGET);
test("automatic resolution exports once per browser, then uses the file without another extraction", async () => {
  await mode({ firefox: { jar: valid } });
  await tools.resolveCookieSource(config(), { force: true, log: () => {} });
  expect(existsSync(target)).toBe(true);
  expect(await readFile(target, "utf8")).toBe(valid);
  expect(calls().map(c => c.browser)).toEqual(["chrome", "firefox"]);
  expect(tools.cookiesArgs(config())).toEqual(["--cookies", `${target}.working`]);
  await tools.resolveCookieSource(config(), { log: () => {} });
  expect(calls()).toHaveLength(2);
}, BUDGET);
test("known invalid file is never sent to yt-dlp when every browser fails; retries are throttled", async () => {
  await writeFile(target, "not a cookie jar");
  await tools.resolveCookieSource(config(), { force: true, log: () => {} });
  expect(tools.cookiesArgs(config())).toEqual([]);
  await tools.resolveCookieSource(config(), { log: () => {} });
  expect(calls()).toHaveLength(2);
}, BUDGET);
test("parallel manual and automatic exports serialize persistence and retain backup", async () => {
  await mode({ chrome: { jar: valid, delay: 50 }, firefox: { jar: valid.replace("fixture-session", "second-session") } });
  await writeFile(target, "invalid");
  const [, manual] = await Promise.all([
    tools.resolveCookieSource(config(), { force: true, log: () => {} }),
    exportsApi.exportBrowserCookies("firefox", target, { ytDlp: binary }),
  ]);
  expect(manual.ok).toBe(true);
  expect(tools.probeCookieFile(target).ok).toBe(true);
  expect(tools.probeCookieFile(`${target}.bak`).ok).toBe(true);
  expect((await readdir(dir)).filter(n => n.includes("incoming"))).toEqual([]);
}, BUDGET);
test("offline resolution does not spawn and live offline toggle discards in-flight extraction", async () => {
  const live = config();
  setConfig(live);
  await tools.resolveCookieSource({ ...live, offlineMode: true }, { force: true });
  expect(calls()).toEqual([]);
  await mode({ chrome: { delay: 100, jar: valid } });
  const resolving = tools.resolveCookieSource(live, { force: true, log: () => {} });
  setConfig({ ...live, offlineMode: true });
  await resolving;
  expect(existsSync(target)).toBe(false);
  expect(calls()).toEqual([]);
}, BUDGET);
test("status is safe metadata; usable fingerprint follows bytes not filesystem timestamps", async () => {
  expect(typeof tools.getCookieStatus).toBe("function");
  expect(typeof tools.usableCookieFingerprint).toBe("function");
  expect(tools.getCookieStatus(config())).toEqual({ present: false, valid: null, source: null, modifiedAt: null, exportedAt: null, cookies: 0 });
  await writeFile(target, valid);
  const initial = tools.getCookieStatus(config());
  expect(initial).toMatchObject({ present: true, valid: true, source: "file", cookies: 1, exportedAt: null });
  expect(initial.modifiedAt).toBe(statSync(target).mtime.toISOString());
  expect(JSON.stringify(initial)).not.toContain("fixture-session");
  const fingerprint = tools.usableCookieFingerprint(config());
  expect(fingerprint).toBeTypeOf("string");
  expect(fingerprint).not.toContain("fixture-session");
  utimesSync(target, new Date(), new Date(Date.now() + 10_000));
  expect(tools.usableCookieFingerprint(config())).toBe(fingerprint);
  await writeFile(target, valid.replace("fixture-session", "changed-session"));
  expect(tools.usableCookieFingerprint(config())).not.toBe(fingerprint);
  await writeFile(target, "invalid");
  expect(tools.usableCookieFingerprint(config())).toBeNull();
  expect(tools.getCookieStatus(config()).valid).toBe(false);
  await mode({ firefox: { jar: valid } });
  await exportsApi.exportBrowserCookies("firefox", target, { ytDlp: binary });
  expect(tools.getCookieStatus(config())).toMatchObject({ source: "firefox", valid: true, cookies: 1 });
  expect(tools.getCookieStatus(config()).exportedAt).toBeTypeOf("string");
}, BUDGET);
test("working-copy cache includes source path even when source sizes and mtimes match", async () => {
  const a = join(dir, "source-a.txt"), b = join(dir, "source-b.txt");
  await writeFile(a, "source A"); await writeFile(b, "source B");
  const date = new Date(1_700_000_000_000);
  utimesSync(a, date, date); utimesSync(b, date, date);
  await writeFile(`${b}.working`, "stale");
  tools.cookieWorkingCopy(a);
  tools.cookieWorkingCopy(b);
  expect(await readFile(`${b}.working`, "utf8")).toBe("source B");
});

test("known invalid bytes remain blocked after a metadata-only rewrite, and a different path is independent", async () => {
  await writeFile(target, "invalid");
  await tools.resolveCookieSource({ ...config(), cookieBrowsers: [] }, { force: true, log: () => {} });
  utimesSync(target, new Date(), new Date(Date.now() + 10_000));
  expect(tools.cookiesArgs(config())).toEqual([]);
  const other = join(dir, "independent.txt");
  await writeFile(other, valid);
  expect(tools.cookiesArgs({ cookiesFile: other })).toEqual(["--cookies", `${other}.working`]);
  await writeFile(target, valid);
  expect(tools.cookiesArgs(config())).toEqual(["--cookies", `${target}.working`]);
});
test("known-invalid non-UTF8 bytes cannot bypass the invalid-file guard", async () => {
  await writeFile(target, Buffer.from([0xff, 0xfe, 0x00]));
  await tools.resolveCookieSource({ ...config(), cookieBrowsers: [] }, { force: true, log: () => {} });
  expect(tools.cookiesArgs(config())).toEqual([]);
});
test("filesystem timestamp at the Unix epoch is still reported as a measured modifiedAt", async () => {
  await writeFile(target, valid);
  utimesSync(target, new Date(0), new Date(0));
  expect(tools.getCookieStatus(config()).modifiedAt).toBe("1970-01-01T00:00:00.000Z");
});
test("a blocked backup write never replaces the previous valid file and cleans incoming", async () => {
  await writeFile(target, valid);
  await Bun.write(join(`${target}.bak`, "blocker"), "fixture");
  await mode({ firefox: { jar: valid.replace("fixture-session", "new-session") } });
  const result = await exportsApi.exportBrowserCookies("firefox", target, { ytDlp: binary });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("Could not write");
  expect(await readFile(target, "utf8")).toBe(valid);
  expect(existsSync(`${target}.incoming`)).toBe(false);
}, BUDGET);
test("spawn failure resolves with a bounded diagnostic rather than throwing", async () => {
  const result = await tools.readBrowserCookieJar("firefox", { ytDlp: join(dir, "missing.exe") });
  expect(result.jar).toBeNull();
  expect(result.timedOut).toBe(false);
  expect(result.stderr.length).toBeLessThanOrEqual(16_384);
});

function firstCall(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error("fixture did not start")); }, 5000);
    const check = () => {
      if (readFileSync(callsFile, "utf8").includes("\n")) { clearTimeout(timer); watcher.close(); resolve(); }
    };
    const watcher = watch(callsFile, check);
    check();
  });
}
for (const change of ["offline", "path"] as const) {
  test(`live ${change} change after the child starts discards its jar and stops fallback`, async () => {
    const live = config();
    setConfig(live);
    await mode({ chrome: { delay: 150, jar: valid } });
    const started = firstCall();
    const resolving = tools.resolveCookieSource(live, { force: true, log: () => {} });
    await started;
    const other = join(dir, `new-path-${index}.txt`);
    setConfig(change === "offline" ? { ...live, offlineMode: true } : { ...live, cookiesFile: other });
    await resolving;
    expect(existsSync(target)).toBe(false);
    expect(existsSync(other)).toBe(false);
    expect(calls().map(c => c.browser)).toEqual(["chrome"]);
    expect(existsSync(dirname(calls()[0].jar))).toBe(false);
  }, BUDGET);
}
test("a pipe read error kills and reaps the child before temporary cleanup", async () => {
  await mode({ firefox: { hang: true } });
  const spawn = Bun.spawn;
  const mocked = spyOn(Bun, "spawn").mockImplementation(((cmd: any, options: any) => {
    const child = spawn(cmd, options) as Bun.PipedSubprocess;
    const broken = child.stderr.pipeThrough(new TransformStream({
      transform() { throw new Error("fixture read failure"); },
    }));
    return new Proxy(child, {
      get(target, name) {
        if (name === "stderr") return broken;
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof Bun.spawn);
  try {
    const result = await tools.readBrowserCookieJar("firefox", { ytDlp: binary, timeoutMs: 5000 });
    expect(result.jar).toBeNull();
    expect(result.stderr).toContain("fixture read failure");
    expect(result.timedOut).toBe(false);
    expect(() => process.kill(calls()[0].pid, 0)).toThrow();
    expect(existsSync(dirname(calls()[0].jar))).toBe(false);
  } finally { mocked.mockRestore(); }
}, BUDGET);
test("simultaneous manual exports all succeed through the shared incoming-file lock", async () => {
  await mode({ firefox: { jar: valid }, chrome: { jar: valid.replace("fixture-session", "other-session") } });
  await writeFile(target, valid);
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) =>
    exportsApi.exportBrowserCookies(n % 2 ? "chrome" : "firefox", target, { ytDlp: binary })));
  expect(results.every(r => r.ok)).toBe(true);
  expect(tools.probeCookieFile(target).ok).toBe(true);
  expect(tools.probeCookieFile(`${target}.bak`).ok).toBe(true);
  expect(existsSync(`${target}.incoming`)).toBe(false);
}, BUDGET);
