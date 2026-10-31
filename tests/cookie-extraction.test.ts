import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, statSync, utimesSync, watch } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diagnoseCookiesText } from "../src/cookie-file";
import * as exportsApi from "../src/cookies-export";
import * as tools from "../src/tools";
import { DEFAULT_CONFIG } from "../src/config";
import { db, initDatabase } from "../src/db";
import { acquireEngineLease, releaseEngineLease } from "../src/lease";
import { refreshCookies } from "../src/reconcile";
import { handleRequest } from "../src/web";
import { getConfig, setConfig, setPaused } from "../src/state";

const WIN = process.platform === "win32";
const BUDGET = WIN ? 30_000 : 10_000;
const dir = await mkdtemp(join(tmpdir(), "yta-cookie-fixtures-"));
const modeFile = join(dir, "mode.json");
const callsFile = join(dir, "calls.jsonl");
const row = (domain: string, expiry = "0", value = "fixture-session", name = "SID") =>
  `${domain}\t${domain.replace(/^#HttpOnly_/, "").startsWith(".") ? "TRUE" : "FALSE"}\t/\tTRUE\t${expiry}\t${name}\t${value}`;
const valid = `# Netscape HTTP Cookie File\n${row(".youtube.com")}\n`;
let binary = "";
let target = "";
let index = 0;
const originalTool = tools.resolvedTools.ytDlp;
const originalConfig = getConfig();
const config = () => ({ ...DEFAULT_CONFIG, cookiesFile: target, cookieBrowsers: ["chrome", "firefox"] as typeof DEFAULT_CONFIG.cookieBrowsers });
const calls = () => readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
async function mode(value: object) { await writeFile(modeFile, JSON.stringify(value)); }
function hasCookie(config: { cookiesFile: string }): boolean {
  const cookie = tools.createCookieInvocation(config);
  try { return cookie.args.length > 0; }
  finally { cookie.cleanup(); }
}

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
if (m.orphan) {
  const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "inherit", stderr: "inherit" });
  appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ descendant: descendant.pid }) + "\\n");
  process.exit(0);
}
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
for (const expiry of ["garbage", " ", "NaN", "Infinity", "1e20", "-1", "12.5"]) {
  test(`rejects malformed expiry ${JSON.stringify(expiry)}`, () => {
    expect(diagnoseCookiesText(row(".youtube.com", expiry)).signedIn).toBe(false);
  });
}
test("an empty expiry is a browser-session cookie, but an empty session value is not authentication", () => {
  expect(diagnoseCookiesText(row(".youtube.com", "")).signedIn).toBe(true);
  expect(diagnoseCookiesText(row(".youtube.com", "", "")).signedIn).toBe(false);
});
test("a session row with control characters cannot validate a jar that will be filtered out", () => {
  expect(diagnoseCookiesText(row(".youtube.com", "0", "secret\u0000bad")).signedIn).toBe(false);
  expect(diagnoseCookiesText(row(".youtube.com", "0", "secret\rbad")).signedIn).toBe(false);
});

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
test.skipIf(WIN)("an orphaned descendant holding the browser pipes cannot defeat the deadline", async () => {
  await mode({ firefox: { orphan: true } });
  const started = Date.now();
  const result = await tools.readBrowserCookieJar("firefox", { ytDlp: binary, timeoutMs: 300 });
  const allCalls = calls();
  const descendant = allCalls.find(c => c.descendant)?.descendant as number | undefined;
  try {
    expect(descendant).toBeDefined();
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(existsSync(dirname(allCalls[0].jar))).toBe(false);
  } finally {
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
  }
}, BUDGET);

test("low-level reader rejects custom profiles and unknown browsers without spawning", async () => {
  for (const browser of ["firefox:private", "chrome+keyring", "netscape"]) {
    const result = await tools.readBrowserCookieJar(browser, { ytDlp: binary });
    expect(result.jar).toBeNull();
    expect(result.stderr).toContain("Unknown browser");
  }
  expect(calls()).toEqual([]);
});
test("export prunes expired rows and retains HttpOnly, session and empty-value cookies", async () => {
  const kept = [row("#HttpOnly_.google.com"), row("m.youtube.com", "0", "pref", "PREF"),
    row(".youtube.com", "0", "", "EMPTY")];
  await mode({ firefox: { jar: [valid.trim(), ...kept, row("notyoutube.com"), row(".youtube.com", "1"), row(".google.com", "bad")].join("\n") } });
  await writeFile(target, valid);
  const result = await exportsApi.exportBrowserCookies("firefox", target, { ytDlp: binary });
  expect(result).toMatchObject({ ok: true, cookies: 4 });
  const text = await readFile(target, "utf8");
  expect(text).toBe(`${valid.trim()}\n${kept.join("\n")}\n`);
  expect(await readFile(`${target}.bak`, "utf8")).toBe(valid);
}, BUDGET);
test("fallback tries selected then unique configured defaults and reports actual browser plus errors", async () => {
  expect(typeof exportsApi.exportBrowserCookiesWithFallback).toBe("function");
  await mode({ firefox: { jar: valid } });
  const result = await exportsApi.exportBrowserCookiesWithFallback("chrome", target, ["chrome", "netscape", "firefox", "firefox"] , { ytDlp: binary });
  expect(result).toMatchObject({ ok: true, browser: "firefox", cookies: 1, attempted: ["chrome", "netscape", "firefox"] });
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
  expect(hasCookie(config())).toBe(true);
  await tools.resolveCookieSource(config(), { log: () => {} });
  expect(calls()).toHaveLength(2);
}, BUDGET);
test("known invalid file is never sent to yt-dlp when every browser fails; retries are throttled", async () => {
  await writeFile(target, "not a cookie jar");
  await tools.resolveCookieSource(config(), { force: true, log: () => {} });
  expect(hasCookie(config())).toBe(false);
  await tools.resolveCookieSource(config(), { log: () => {} });
  expect(calls()).toHaveLength(2);
}, BUDGET);
test("a newer manual export wins over an in-flight automatic extraction and backs up the old file", async () => {
  await mode({ chrome: { jar: valid, delay: 150 }, firefox: { jar: valid.replace("fixture-session", "second-session") } });
  await writeFile(target, "invalid");
  const started = firstCall();
  const automatic = tools.resolveCookieSource(config(), { force: true, log: () => {} });
  await started;
  const manual = await exportsApi.exportBrowserCookies("firefox", target, { ytDlp: binary });
  await automatic;
  expect(manual.ok).toBe(true);
  expect(await readFile(target, "utf8")).toBe(valid.replace("fixture-session", "second-session"));
  expect(await readFile(`${target}.bak`, "utf8")).toBe("invalid");
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
test("private snapshots use the correct source even when sizes and timestamps match", async () => {
  const a = join(dir, "source-a.txt"), b = join(dir, "source-b.txt");
  const jarA = valid.replace("fixture-session", "session-A");
  const jarB = valid.replace("fixture-session", "session-B");
  await writeFile(a, jarA); await writeFile(b, jarB);
  const date = new Date(1_700_000_000_000);
  utimesSync(a, date, date); utimesSync(b, date, date);
  const first = tools.createCookieInvocation({ cookiesFile: a });
  const second = tools.createCookieInvocation({ cookiesFile: b });
  try {
    expect(await readFile(first.args[1], "utf8")).toBe(jarA);
    expect(await readFile(second.args[1], "utf8")).toBe(jarB);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  } finally { first.cleanup(); second.cleanup(); }
});

test("known invalid bytes remain blocked after a metadata-only rewrite, and a different path is independent", async () => {
  await writeFile(target, "invalid");
  await tools.resolveCookieSource({ ...config(), cookieBrowsers: [] }, { force: true, log: () => {} });
  utimesSync(target, new Date(), new Date(Date.now() + 10_000));
  expect(hasCookie(config())).toBe(false);
  const other = join(dir, "independent.txt");
  await writeFile(other, valid);
  expect(hasCookie({ cookiesFile: other })).toBe(true);
  await writeFile(target, valid);
  expect(hasCookie(config())).toBe(true);
});
test("invalid UTF-8 is rejected even when a plausible session row is present", async () => {
  await writeFile(target, Buffer.concat([Buffer.from(valid), Buffer.from([0xff, 0xfe])]));
  expect(tools.getCookieStatus(config()).valid).toBe(false);
  expect(tools.usableCookieFingerprint(config())).toBeNull();
  expect(hasCookie(config())).toBe(false);
  await tools.resolveCookieSource({ ...config(), cookieBrowsers: [] }, { force: true, log: () => {} });
  expect(hasCookie(config())).toBe(false);
}, BUDGET);

test("known-invalid non-UTF8 bytes cannot bypass the invalid-file guard", async () => {
  await writeFile(target, Buffer.from([0xff, 0xfe, 0x00]));
  await tools.resolveCookieSource({ ...config(), cookieBrowsers: [] }, { force: true, log: () => {} });
  expect(hasCookie(config())).toBe(false);
});
test("filesystem timestamp at the Unix epoch is still reported as a measured modifiedAt", async () => {
  await writeFile(target, valid);
  utimesSync(target, new Date(0), new Date(0));
  expect(tools.getCookieStatus(config()).modifiedAt).toBe("1970-01-01T00:00:00.000Z");
});
test.skipIf(WIN)("export never follows fixed incoming or backup symlinks", async () => {
  await writeFile(target, valid);
  await chmod(target, 0o644);
  const victim = join(dir, `victim-${index}`);
  await writeFile(victim, "do not overwrite");
  await symlink(victim, `${target}.incoming`);
  await symlink(victim, `${target}.bak`);
  await mode({ firefox: { jar: valid.replace("fixture-session", "fresh-session") } });
  const result = await exportsApi.exportBrowserCookies("firefox", target, { ytDlp: binary });
  expect(result.ok).toBe(true);
  expect(await readFile(victim, "utf8")).toBe("do not overwrite");
  expect(await readFile(`${target}.bak`, "utf8")).toBe(valid);
  expect((await lstat(`${target}.bak`)).isSymbolicLink()).toBe(false);
  expect((await lstat(`${target}.bak`)).mode & 0o777).toBe(0o600);
  expect((await lstat(target)).mode & 0o777).toBe(0o600);
  expect((await lstat(`${target}.incoming`)).isSymbolicLink()).toBe(true);
  expect((await readdir(dir)).some(name => name.startsWith(`.${target.split("/").pop()}.tmp-`))).toBe(false);
}, BUDGET);

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
test("browser extraction diagnostics never echo cookie values from stderr", async () => {
  const secret = "fixture-secret-never-log";
  await mode({ chrome: { error: `Could not copy cookie database; SID=${secret}` } });
  const result = await exportsApi.exportBrowserCookies("chrome", target, { ytDlp: binary });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("cookie database");
  expect(JSON.stringify(result)).not.toContain(secret);
  const messages: string[] = [];
  await tools.resolveCookieSource({ ...config(), cookieBrowsers: ["chrome"] }, {
    force: true, log: (message) => messages.push(message),
  });
  expect(messages.join(" ")).not.toContain(secret);
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
test("automatic extraction never replaces a file the user changes while the browser is being read", async () => {
  const live = config();
  setConfig(live);
  await writeFile(target, "invalid");
  await mode({ chrome: { delay: 150, jar: valid } });
  const started = firstCall();
  const automatic = tools.resolveCookieSource(live, { force: true, log: () => {} });
  await started;
  const external = valid.replace("fixture-session", "external-session");
  await writeFile(target, external);
  await automatic;
  expect(await readFile(target, "utf8")).toBe(external);
  expect(existsSync(`${target}.bak`)).toBe(false);
  expect(calls().map(c => c.browser)).toEqual(["chrome"]);
}, BUDGET);

test("a fallback sequence has a whole-sequence deadline, not just individual child deadlines", async () => {
  await mode({ chrome: { hang: true }, firefox: { hang: true } });
  const started = Date.now();
  const result = await exportsApi.exportBrowserCookiesWithFallback("chrome", target, ["firefox"], {
    ytDlp: binary, timeoutMs: 150, totalTimeoutMs: 250,
  });
  expect(result.ok).toBe(false);
  expect(result.attempted.length).toBeGreaterThan(0);
  expect(result.attempted.length).toBeLessThanOrEqual(2);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(existsSync(target)).toBe(false);
}, BUDGET);

test("disabling startup validation does not disable later expiry self-healing", async () => {
  initDatabase(":memory:");
  acquireEngineLease();
  setPaused(false);
  const live = { ...config(), validateCookiesOnStart: false };
  setConfig(live);
  const expired = `# Netscape HTTP Cookie File\n${row(".youtube.com", "1")}\n`;
  await writeFile(target, expired);
  await mode({ chrome: { jar: valid } });
  try {
    await refreshCookies({ startup: true });
    expect(calls()).toHaveLength(0);
    expect(await readFile(target, "utf8")).toBe(expired);
    await refreshCookies();
    expect(await readFile(target, "utf8")).toBe(valid);
    expect(await readFile(`${target}.bak`, "utf8")).toBe(expired);
    expect(calls().map(c => c.browser)).toEqual(["chrome"]);
  } finally { releaseEngineLease(); }
}, BUDGET);

test("losing the engine lease during automatic extraction leaves the target untouched", async () => {
  initDatabase(":memory:");
  acquireEngineLease();
  setPaused(false);
  const live = config();
  setConfig(live);
  await mode({ chrome: { delay: 150, jar: valid }, firefox: { jar: valid } });
  const started = firstCall();
  const automatic = refreshCookies();
  await started;
  releaseEngineLease();
  await automatic;
  expect(existsSync(target)).toBe(false);
  expect(calls().map(c => c.browser)).toEqual(["chrome"]);
}, BUDGET);

test("manual export API reports fallback attempts, rescues credentials and exposes safe local status", async () => {
  initDatabase(":memory:");
  acquireEngineLease();
  setPaused(false);
  const live = config();
  setConfig(live);
  await writeFile(target, "old-cookie-file");
  await mode({ firefox: { jar: valid } });
  db.run(`INSERT INTO jobs (id, url, title, output_directory, download_status, last_error, retry_count)
    VALUES ('age', 'https://example.test', 'age', '/tmp', 'failed', 'Sign in to confirm your age', 9)`);
  db.run(`INSERT INTO jobs (id, url, title, output_directory, download_status, last_error)
    VALUES ('private', 'https://example.test', 'private', '/tmp', 'failed', 'Private video. Login required')`);
  try {
    const res = await handleRequest(new Request("http://localhost/api/cookies/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser: "chrome" }),
    }), live);
    const result = await res.json();
    expect(res.status).toBe(200);
    expect(result).toMatchObject({ ok: true, saved: true, browser: "firefox", attempted: ["chrome", "firefox"] });
    expect(result.errors[0].browser).toBe("chrome");
    expect(result.message).toContain("from firefox");
    expect(await readFile(`${target}.bak`, "utf8")).toBe("old-cookie-file");
    expect(db.query("SELECT download_status, retry_count FROM jobs WHERE id = 'age'").get()).toEqual({ download_status: "pending", retry_count: 0 });
    expect((db.query("SELECT download_status FROM jobs WHERE id = 'private'").get() as any).download_status).toBe("failed");
    const status = await (await handleRequest(new Request("http://localhost/api/status"), live)).json();
    expect(status.cookies).toMatchObject({ present: true, valid: true, source: "firefox", cookies: 1 });
    expect(JSON.stringify(status)).not.toContain("fixture-session");
    const reliability = await (await handleRequest(new Request("http://localhost/api/reliability"), live)).json();
    expect(reliability.credentialBlocked).toBe(0);
    expect(reliability.cookies.source).toBe("firefox");
  } finally { releaseEngineLease(); }
}, BUDGET);

test("manual export is rejected before reading a browser when no lease is held", async () => {
  initDatabase(":memory:");
  setPaused(false);
  const live = config();
  setConfig(live);
  await mode({ chrome: { jar: valid } });
  const response = await handleRequest(new Request("http://localhost/api/cookies/export", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser: "chrome" }),
  }), live);
  expect(response.status).toBe(409);
  expect(calls()).toEqual([]);
  expect(existsSync(target)).toBe(false);
}, BUDGET);

test("an export begun under an old lease generation cannot publish after reacquisition", async () => {
  initDatabase(":memory:");
  acquireEngineLease();
  setPaused(false);
  const live = config();
  setConfig(live);
  await mode({ chrome: { delay: 150, jar: valid } });
  const started = firstCall();
  const pending = handleRequest(new Request("http://localhost/api/cookies/export", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser: "chrome" }),
  }), live);
  try {
    await started;
    releaseEngineLease();
    acquireEngineLease();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(existsSync(target)).toBe(false);
  } finally { releaseEngineLease(); }
}, BUDGET);

test("manual export does not publish after its engine lease is lost", async () => {
  initDatabase(":memory:");
  acquireEngineLease();
  setPaused(false);
  const live = config();
  setConfig(live);
  await mode({ chrome: { delay: 150, jar: valid }, firefox: { jar: valid } });
  const started = firstCall();
  const pending = handleRequest(new Request("http://localhost/api/cookies/export", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser: "chrome" }),
  }), live);
  await started;
  releaseEngineLease();
  const response = await pending;
  expect(response.status).toBe(409);
  expect(existsSync(target)).toBe(false);
  expect(calls().map(c => c.browser)).toEqual(["chrome"]);
}, BUDGET);

for (const change of ["offline", "path"] as const) {
  test(`manual API export cancels publication and fallback if ${change} changes in flight`, async () => {
    initDatabase(":memory:");
    acquireEngineLease();
    setPaused(false);
    const live = config();
    setConfig(live);
    await writeFile(target, "previous file");
    await mode({ chrome: { delay: 150, jar: valid }, firefox: { jar: valid } });
    const started = firstCall();
    const request = handleRequest(new Request("http://localhost/api/cookies/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser: "chrome" }),
    }), live);
    try {
      await started;
      setConfig(change === "offline" ? { ...live, offlineMode: true } : { ...live, cookiesFile: `${target}.new` });
      const res = await request;
      expect(res.status).toBe(409);
      expect(await readFile(target, "utf8")).toBe("previous file");
      expect(calls().map(c => c.browser)).toEqual(["chrome"]);
      expect(existsSync(`${target}.bak`)).toBe(false);
    } finally { releaseEngineLease(); }
  }, BUDGET);
}

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
