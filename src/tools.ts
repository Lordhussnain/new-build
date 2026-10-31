// src/tools.ts — external dependency discovery (yt-dlp / ffmpeg).
//
// Verifies every required tool BEFORE opening the database or scanning links,
// so misconfigured machines fail fast with clear hints. Custom Windows
// installs (exe next to the app, scoop, choco, winget, or an explicit config
// path) all work without touching PATH.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { browserCookieFailureReason, cookieExportMetadata, cookiePathKey, decodeCookieBytes, diagnoseCookiesText, filterCookiesText, normalizeCookiesText, persistCookieJar, ytDlpFailureReason } from "./cookie-file";
import { COOKIE_BROWSER_NAMES } from "./config";
import { getConfig } from "./state";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import os from "node:os";

// aria2c is optional: when present it becomes the multi-connection downloader
// (yt-dlp --downloader aria2c), and when absent the engine transparently uses
// yt-dlp's native downloader. `aria2cPath` stays "" until discovery finds it.
export type JsRuntimeName = "deno" | "node" | "bun" | "quickjs";
export interface JsRuntime {
  name: JsRuntimeName;
  /** Absolute or PATH-resolvable executable yt-dlp should invoke. */
  path: string;
}

export const resolvedTools = {
  ytDlp: "yt-dlp",
  ffmpeg: "ffmpeg",
  aria2cPath: "" as string | null,
  jsRuntime: null as JsRuntime | null,
};
export function ytDlp(): string {
  return resolvedTools.ytDlp;
}
export function ffmpeg(): string {
  return resolvedTools.ffmpeg;
}
/** Resolved aria2c path, or null when it is unavailable. */
export function aria2cPath(): string | null {
  return resolvedTools.aria2cPath;
}
/** The executable yt-dlp should hand transfers to, or "native" for its own. */
export function activeDownloader(): "aria2c" | "native" {
  return resolvedTools.aria2cPath ? "aria2c" : "native";
}
/** JS runtime discovered for YouTube's n-challenge, or null. */
export function jsRuntime(): JsRuntime | null {
  return resolvedTools.jsRuntime;
}

/**
 * yt-dlp flags that enable the YouTube n-challenge solver.
 *
 * Deno is yt-dlp's default and is enabled automatically when it is on PATH,
 * but discovery often finds the binary next to the app / in a package-manager
 * shim that the child process will not see — so we always pass an explicit
 * `runtime:path`. `--remote-components ejs:github` lets pip/third-party
 * installs fetch the EJS solver scripts when they are not bundled; official
 * yt-dlp binaries already ship them and ignore the fetch.
 */
export function jsRuntimeArgs(runtime: JsRuntime | null = resolvedTools.jsRuntime): string[] {
  if (!runtime) return [];
  const path = (runtime.path || "").trim();
  if (!path) return [];
  return ["--js-runtimes", `${runtime.name}:${path}`, "--remote-components", "ejs:github"];
}

/**
 * When this process *is* the bun interpreter (not a compiled archive.exe),
 * yt-dlp can use it as a last-resort JS runtime. Compiled binaries keep
 * `process.versions.bun` but `execPath` is not a JS runtime.
 */
export function bunInterpreterPath(execPath: string = process.execPath): string | null {
  const base = basename(execPath).replace(/\.exe$/i, "").toLowerCase();
  return base === "bun" ? execPath : null;
}

export interface CookiesState {
  /** The configured path, used verbatim in argv (relative paths still work). */
  file: string;
  /** Exists AND non-empty — a 0-byte cookies.txt is not usable cookies. */
  present: boolean;
  size: number;
  mtimeMs: number;
}

/** Snapshot of the cookies file right now. Never throws. */
export function cookiesState(config: { cookiesFile: string }): CookiesState {
  const file = config.cookiesFile || "";
  try {
    const s = statSync(file);
    return { file, present: s.isFile() && s.size > 0, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return { file, present: false, size: 0, mtimeMs: 0 };
  }
}

export interface CookieStatus {
  present: boolean;
  valid: boolean | null;
  source: string | null;
  modifiedAt: string | null;
  exportedAt: string | null;
  cookies: number;
}

/** Local-only metadata. Never returns cookie values or invents an export time. */
export function getCookieStatus(config: { cookiesFile: string }): CookieStatus {
  const state = cookiesState(config);
  const status: CookieStatus = {
    present: state.present, valid: null, source: null,
    modifiedAt: state.present || state.mtimeMs !== 0 ? new Date(state.mtimeMs).toISOString() : null,
    exportedAt: null, cookies: 0,
  };
  if (!state.present) return status;
  try {
    const bytes = readFileSync(state.file);
    let text: string;
    try { text = decodeCookieBytes(bytes); }
    catch { return { ...status, valid: false, source: "file" }; }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const metadata = cookieExportMetadata(state.file, hash);
    return {
      ...status, valid: diagnoseCookiesText(text).problem === null,
      source: metadata?.source ?? "file", exportedAt: metadata?.exportedAt ?? null,
      cookies: diagnoseCookiesText(filterCookiesText(text)).siteEntries,
    };
  } catch { return status; }
}

/** A usable file's identity and BYTES hash; mtime-only changes are not credentials. */
export function usableCookieFingerprint(config: { cookiesFile: string }): string | null {
  if (!config.cookiesFile) return null;
  try {
    const bytes = readFileSync(config.cookiesFile);
    if (diagnoseCookiesText(decodeCookieBytes(bytes)).problem !== null) return null;
    return `${cookiePathKey(config.cookiesFile)}:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch { return null; }
}

/** Minimum delay before repeating a failed browser fallback for the same configuration. */
export const COOKIE_SOURCE_RECHECK_MS = 30 * 60_000;

// Negative validation belongs to a particular source's bytes, not every path.
const invalidCookieFiles = new Map<string, string>();
let browserCookieSource: string | null = null;
const browserCheckedAt = new Map<string, number>();
const resolving = new Map<string, Promise<void>>();
const loggedCookieDiagnosis = new Map<string, string>();

export interface CookieInvocation {
  /** Private yt-dlp argv for exactly one child. */
  args: string[];
  /** Identity of the usable source bytes captured for this attempt. */
  fingerprint: string | null;
  /** Call after the child has exited, including error/timeout paths. */
  cleanup: () => void;
}

const workingCopyWarnings = new Set<string>();

/**
 * yt-dlp reads AND rewrites its --cookies file. Every invocation therefore
 * gets its own private snapshot, never the operator's export or a shared jar:
 * an older child exiting after a refresh must not overwrite newer credentials.
 * The caller owns the snapshot and removes it after the child is reaped.
 */
export function createCookieInvocation(
  config: { cookiesFile: string },
  opts: { tempRoot?: string } = {},
): CookieInvocation {
  const empty = (): CookieInvocation => ({ args: [], fingerprint: null, cleanup: () => {} });
  const s = cookiesState(config);
  if (!s.present) return empty();
  const key = cookiePathKey(s.file);
  let dir: string | null = null;
  try {
    const bytes = readFileSync(s.file);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const text = decodeCookieBytes(bytes);
    const diagnosis = diagnoseCookiesText(text);
    const invalidHash = invalidCookieFiles.get(key);
    if (invalidHash) {
      if (hash === invalidHash || diagnosis.problem !== null) {
        invalidCookieFiles.set(key, hash);
        return empty();
      }
      invalidCookieFiles.delete(key);
    }
    dir = mkdtempSync(join(opts.tempRoot ?? os.tmpdir(), "yta-cookie-run-"));
    const working = join(dir, "cookies.txt");
    // A normalized private copy also repairs a missing header or an incorrect
    // domain flag; either would otherwise make yt-dlp reject the entire jar.
    writeFileSync(working, normalizeCookiesText(text), { mode: 0o600, flag: "wx" });
    workingCopyWarnings.delete(key);
    const ownedDir = dir;
    return {
      args: ["--cookies", working],
      fingerprint: diagnosis.problem === null ? `${key}:${hash}` : null,
      cleanup: () => {
        try { rmSync(ownedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
        catch (error: any) {
          console.warn(`⚠️ Could not remove a private cookie working directory (${error?.code || error?.message || error}).`);
        }
      },
    };
  } catch (error: any) {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
    if (!workingCopyWarnings.has(key)) {
      console.warn(`⚠️ Could not create the private cookie working copy (${error?.code || error?.message || error}); downloads will not use this file.`);
      workingCopyWarnings.add(key);
    }
    return empty();
  }
}

/** The browser currently supplying cookies, or null. For logs and the dashboard. */
export function activeBrowserCookieSource(): string | null {
  return browserCookieSource;
}

export type CookiesChange = "appeared" | "disappeared" | "updated" | null;

/**
 * What the cookies watcher remembers between polls: identity of the file plus a
 * SHA-256 of its bytes.
 *
 * `size`/`mtimeMs` alone are NOT a content signal. A browser extension that
 * re-exports cookies.txt on its own timer (or a cloud-sync client / an
 * antivirus touch) rewrites the file with byte-identical content, and a
 * metadata-only rewrite can even keep the size. Judged on mtime that reads as a
 * fresh credential set on EVERY poll — one "cookies.txt updated" line per minute
 * in `error.log`, forever, which buries the failures the log exists to show.
 */
export interface CookiesWatchState {
  /** The configured path, used verbatim in messages (relative paths work). */
  file: string;
  /** Exists AND non-empty — a 0-byte cookies.txt is not usable cookies. */
  present: boolean;
  size: number;
  mtimeMs: number;
  /** SHA-256 of the content, or null when it could not be read (locked file). */
  hash: string | null;
}

/**
 * Watcher-side snapshot. Never throws.
 *
 * `cookiesState()` stays a cheap stat. The watcher hashes the file on its
 * periodic poll to distinguish new bytes from a timestamp-only touch; each
 * subprocess independently reads and hashes its private invocation snapshot.
 */
export function cookiesWatchState(
  config: { cookiesFile: string },
  onUnreadable?: (msg: string) => void,
): CookiesWatchState {
  const base = cookiesState(config);
  let hash: string | null = null;
  if (base.present) {
    try {
      hash = createHash("sha256").update(readFileSync(base.file)).digest("hex");
    } catch (e: any) {
      // Locked (a browser mid-export) or vanished between the stat and the read.
      // A missing hash is never treated as a content change; the caller may log
      // that the check was skipped.
      onUnreadable?.(`cookies.txt could not be read for the change check (${e?.code || e?.message || e})`);
    }
  }
  return { file: base.file, present: base.present, size: base.size, mtimeMs: base.mtimeMs, hash };
}

let cookiesBaseline: CookiesWatchState | null = null;

/**
 * Compare the cookies file with the last observation and remember this one.
 *
 * `createCookieInvocation()` reads the file on every yt-dlp invocation, so a
 * cookies.txt dropped in *after* startup is already used by the next attempt —
 * silently. This is the part that makes it observable: the engine polls it
 * (see `reconcile.ts cookiesWatch`) so the operator sees the file being picked
 * up, replaced, or vanishing instead of wondering why age-gated videos
 * suddenly work or suddenly fail.
 *
 * `updated` means the BYTES changed. A re-export of identical content is not a
 * credential change and must not be reported as one.
 */
export function detectCookiesChange(config: {
  cookiesFile: string;
  onUnreadable?: (msg: string) => void;
}): { change: CookiesChange; state: CookiesWatchState } {
  const state = cookiesWatchState(config, config.onUnreadable);
  const prev = cookiesBaseline;
  cookiesBaseline = state;
  if (!prev) return { change: null, state }; // first observation = baseline
  if (!prev.present && state.present) return { change: "appeared", state };
  if (prev.present && !state.present) return { change: "disappeared", state };
  if (prev.present && state.present && prev.hash !== null && state.hash !== null) {
    return { change: prev.hash !== state.hash ? "updated" : null, state };
  }
  // Hashing was impossible for one of the two observations: fall back to the
  // size signal (mtime alone is exactly what false-positives) so an unreadable
  // file never turns the watcher off completely.
  if (prev.present && state.present && prev.size !== state.size) {
    return { change: "updated", state };
  }
  return { change: null, state };
}

/** Forget the observed cookies state (tests, and a config path change). */
export function resetCookiesBaseline(): void {
  cookiesBaseline = null;
}

/**
 * Cheap validity probe for any yt-dlp cookie source (one metadata call):
 * `["--cookies", file]` or `["--cookies-from-browser", "firefox"]`.
 * A browser that cannot be read (not installed, database locked, no profile)
 * makes yt-dlp exit non-zero, which counts as "not usable".
 */
/**
 * Upper bound for one cookie probe. Startup waits for the probes, so a yt-dlp
 * that hangs (a stalled network, a browser database that never unlocks) must
 * not stall the engine: the probe is killed and counts as "not usable".
 */
export const COOKIE_PROBE_TIMEOUT_MS = 120_000;
/** Bound a whole browser fallback sequence as well as each individual child. */
export const COOKIE_EXPORT_BUDGET_MS = 4 * 60_000;

/**
 * A real video used only to make yt-dlp load a browser's cookies and write the
 * jar on exit. `--skip-download --playlist-items 0` means nothing is downloaded.
 * The video is fetched (about 30 seconds), which is the proven command for this
 * export. If the video is ever removed, change this constant.
 */
export const COOKIE_JAR_URL = "https://www.youtube.com/watch?v=Are3UkcYytw";

/** Result of reading one browser's cookie store into a Netscape jar. */
export interface BrowserCookieJar {
  /** The jar text, or null when yt-dlp wrote no file (the store was never read). */
  jar: string | null;
  stderr: string;
  timedOut: boolean;
}

const COOKIE_DIAGNOSTIC_LIMIT = 16_384;

/** Drain without accumulating stdout or unbounded stderr in memory. */
async function drainCookiePipe(reader: ReadableStreamDefaultReader<Uint8Array>, keep: number): Promise<string> {
  const decoder = new TextDecoder();
  let tail = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (keep) tail = (tail + decoder.decode(value, { stream: true })).slice(-keep);
    }
    return keep ? (tail + decoder.decode()).slice(-keep) : "";
  } finally { reader.releaseLock(); }
}

/** Read only an allowlisted browser's default profile into a temporary jar. */
export async function readBrowserCookieJar(
  browser: string,
  opts: { ytDlp?: string; timeoutMs?: number; shouldContinue?: () => boolean } = {},
): Promise<BrowserCookieJar> {
  if (!(COOKIE_BROWSER_NAMES as readonly string[]).includes(browser)) {
    return { jar: null, stderr: `Unknown browser "${browser}".`, timedOut: false };
  }
  let dir: string | undefined;
  let child: Bun.PipedSubprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pipes: Promise<unknown>[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let timedOut = false;
  const kill = () => {
    if (!child) return;
    // The POSIX child leads its own process group, so even an orphaned
    // descendant holding a pipe open cannot outlive the extraction deadline.
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    } else if (child.exitCode === null) {
      try { Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/t", "/f"]); } catch {}
    }
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  };
  const cancelReaders = () => { for (const reader of readers) void reader.cancel().catch(() => {}); };
  try {
    dir = await mkdtemp(join(os.tmpdir(), "yta-cookies-"));
    if (opts.shouldContinue && !opts.shouldContinue()) {
      return { jar: null, stderr: "Cookie configuration changed before extraction.", timedOut: false };
    }
    const jarPath = join(dir, "jar.txt");
    child = Bun.spawn([
      opts.ytDlp ?? ytDlp(), "--cookies-from-browser", browser, "--cookies", jarPath,
      "--skip-download", "--playlist-items", "0", COOKIE_JAR_URL,
    ], { stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" });
    const stdoutReader = child.stdout.getReader();
    const stderrReader = child.stderr.getReader();
    readers.push(stdoutReader, stderrReader);
    const stderrRead = drainCookiePipe(stderrReader, COOKIE_DIAGNOSTIC_LIMIT);
    pipes = [drainCookiePipe(stdoutReader, 0), stderrRead];
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => { timedOut = true; kill(); cancelReaders(); resolve(null); }, opts.timeoutMs ?? COOKIE_PROBE_TIMEOUT_MS);
    });
    const result = await Promise.race([Promise.all([pipes[0], stderrRead, child.exited]), timeout]);
    if (result === null) return { jar: null, stderr: "", timedOut: true };
    const [, stderr] = result;
    // A failed video lookup may still leave a valid exported jar. Trust the
    // local diagnosis, not the video exit status; a timeout is always a failure.
    const jar = timedOut ? null : await readFile(jarPath).then(decodeCookieBytes).catch(() => null);
    return { jar, stderr, timedOut };
  } catch (error: any) {
    kill();
    return { jar: null, stderr: `could not read browser cookies: ${error?.message || error}`.slice(0, COOKIE_DIAGNOSTIC_LIMIT), timedOut };
  } finally {
    clearTimeout(timer);
    if (child) {
      kill();
      cancelReaders();
      await child.exited.catch(() => {});
      await Promise.allSettled(pipes);
    }
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

/**
 * Is `browser` signed in to YouTube? Reads its cookie store with yt-dlp (about
 * 30 seconds, mostly the video fetch) and checks for a live session cookie.
 */
export async function probeBrowserCookies(browser: string): Promise<CookieProbe> {
  const read = await readBrowserCookieJar(browser);
  if (read.timedOut) {
    return { ok: false, reason: `reading ${browser} cookies did not finish within ${COOKIE_PROBE_TIMEOUT_MS / 1000}s; retried at the next cookie check` };
  }
  if (read.jar === null) {
    return { ok: false, reason: `could not read ${browser} cookies: ${browserCookieFailureReason(read.stderr)}` };
  }
  const diagnosis = diagnoseCookiesText(read.jar);
  if (diagnosis.problem !== null) return { ok: false, reason: diagnosis.problem };
  return { ok: true, reason: "" };
}

/** Is cookies.txt a signed-in YouTube export? Local check, no network. */
export function probeCookieFile(file: string): CookieProbe {
  const problem = diagnoseCookiesText(readCookiesTextSafely(file)).problem;
  return problem === null ? { ok: true, reason: "" } : { ok: false, reason: problem };
}

/** Outcome of one cookie probe, with the reason it failed (empty when ok). */
export interface CookieProbe {
  ok: boolean;
  reason: string;
}

export async function probeCookieArgs(source: string[]): Promise<CookieProbe> {
  let child: Bun.PipedSubprocess;
  try {
    child = Bun.spawn(
      [
        ytDlp(),
        ...source,
        ...jsRuntimeArgs(),
        "--no-warnings",
        "--dump-single-json",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  } catch (error: any) {
    return { ok: false, reason: `could not start yt-dlp: ${error?.message || error}` };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already exited
      }
      resolve("timeout");
    }, COOKIE_PROBE_TIMEOUT_MS);
  });
  try {
    const finished = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([, stderr, code]) => ({ stderr, code }));
    const result = await Promise.race([finished, timedOut]);
    if (result === "timeout") {
      return {
        ok: false,
        reason: `yt-dlp did not answer within ${COOKIE_PROBE_TIMEOUT_MS / 1000}s (a slow first run, a busy network, or a browser store still being read). It is retried at the next cookie check.`,
      };
    }
    if (result.stderr.toLowerCase().includes("login required")) {
      return { ok: false, reason: "YouTube asked for a login, so these cookies were not accepted" };
    }
    if (result.code === 0) return { ok: true, reason: "" };
    return { ok: false, reason: ytDlpFailureReason(result.stderr) };
  } catch (error: any) {
    return { ok: false, reason: `yt-dlp probe failed: ${error?.message || error}` };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { try { child.kill("SIGKILL"); } catch {} }
    await child.exited.catch(() => {});
  }
}

/** Boolean form of probeCookieArgs(), for callers that do not need the reason. */
export async function validateCookieArgs(source: string[]): Promise<boolean> {
  return (await probeCookieArgs(source)).ok;
}

/** Cookies file text for diagnosis; an unreadable file gives an empty string. */
export function readCookiesTextSafely(file: string): string {
  try {
    return decodeCookieBytes(readFileSync(file));
  } catch {
    return "";
  }
}

/** Cheap validity probe for a cookies file (one yt-dlp metadata call). */
export async function validateCookies(cookiesFile: string): Promise<boolean> {
  const cookie = createCookieInvocation({ cookiesFile });
  if (!cookie.args.length) return false;
  try { return await validateCookieArgs(cookie.args); }
  finally { cookie.cleanup(); }
}

interface CookieSourceConfig {
  cookiesFile: string;
  validateCookiesOnStart: boolean;
  cookieBrowsers: readonly string[];
  offlineMode: boolean;
}
interface CookieResolveOptions {
  force?: boolean;
  /** Recovery checks diagnose even when startup validation was disabled. */
  diagnoseFile?: boolean;
  log?: (msg: string) => void;
  ytDlp?: string;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  /** Additional caller guard (e.g. engine lease / shutdown). */
  shouldContinue?: () => boolean;
  /** Fence final publication under the engine's SQLite lease lock. */
  publish?: (commit: () => boolean) => boolean;
}

function cookieConfigKey(config: CookieSourceConfig): string {
  return JSON.stringify([cookiePathKey(config.cookiesFile), config.validateCookiesOnStart, [...new Set(config.cookieBrowsers)]]);
}

/** Locally validate the file, otherwise extract and persist each browser at most
 * once. Rechecks are throttled per configuration, not globally across paths.
 */
export function resolveCookieSource(
  config: CookieSourceConfig,
  opts: CookieResolveOptions = {},
): Promise<void> {
  if (config.offlineMode) return Promise.resolve();
  const key = cookieConfigKey(config);
  const pending = resolving.get(key);
  if (pending) return pending;
  const initialLive = getConfig();
  const stillCurrent = () => {
    if (config.offlineMode || cookieConfigKey(config) !== key || (opts.shouldContinue && !opts.shouldContinue())) return false;
    const live = getConfig();
    // Standalone callers may intentionally pass a config without installing it
    // in state. Once live config changes, however, never publish stale results.
    return live === initialLive && config !== initialLive ||
      (!live.offlineMode && cookieConfigKey(live) === key);
  };
  const work = doResolve(config, opts, key, stillCurrent).finally(() => {
    if (resolving.get(key) === work) resolving.delete(key);
  });
  resolving.set(key, work);
  return work;
}

async function doResolve(
  config: CookieSourceConfig,
  opts: CookieResolveOptions,
  key: string,
  stillCurrent: () => boolean,
): Promise<void> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const s = cookiesState(config);
  const path = cookiePathKey(s.file);
  browserCookieSource = null;
  if (s.present) {
    if (!config.validateCookiesOnStart && !opts.diagnoseFile) {
      invalidCookieFiles.delete(path);
      return;
    }
    const text = readCookiesTextSafely(s.file);
    const diagnosis = diagnoseCookiesText(text);
    const hash = createHash("sha256").update(text).digest("hex");
    const observation = `${hash}:${diagnosis.problem ?? "valid"}`;
    if (loggedCookieDiagnosis.get(path) !== observation) {
      log(diagnosis.problem === null
        ? "cookies.txt has a signed-in YouTube session (checked locally)."
        : `cookies.txt is invalid or expired: ${diagnosis.problem}`);
      loggedCookieDiagnosis.set(path, observation);
    }
    if (diagnosis.problem === null) {
      invalidCookieFiles.delete(path);
      const source = getCookieStatus(config).source;
      browserCookieSource = source !== "file" ? source : null;
      return;
    }
    invalidCookieFiles.set(path, hash);
  }
  if (!opts.force && Date.now() - (browserCheckedAt.get(key) ?? 0) < COOKIE_SOURCE_RECHECK_MS) return;
  if (!stillCurrent()) return;
  browserCheckedAt.set(key, Date.now());

  // An operator (or a manual export) can replace the file while yt-dlp is
  // reading the browser. Automatic recovery must not overwrite that newer jar.
  const before = cookiesWatchState(config);
  if (before.present && before.hash === null) {
    log("cookies.txt is unreadable; leaving it untouched until the next check.");
    return;
  }
  const fileUnchanged = () => {
    const current = cookiesWatchState(config);
    return current.present === before.present && (!current.present || (current.hash !== null && current.hash === before.hash));
  };
  const mayPublish = () => stillCurrent() && fileUnchanged();
  const deadline = Date.now() + (opts.totalTimeoutMs ?? COOKIE_EXPORT_BUDGET_MS);
  const tried: string[] = [];
  for (const browser of new Set(config.cookieBrowsers)) {
    if (!mayPublish()) { browserCheckedAt.delete(key); return; }
    if (!config.cookiesFile.trim()) {
      tried.push("No cookies.txt path is configured (cookiesFile).");
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { tried.push("Browser fallback time limit reached."); break; }
    const read = await readBrowserCookieJar(browser, {
      ytDlp: opts.ytDlp,
      timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? COOKIE_PROBE_TIMEOUT_MS, remaining)),
      shouldContinue: mayPublish,
    });
    if (!mayPublish()) { browserCheckedAt.delete(key); return; }
    const problem = read.timedOut ? `reading ${browser} cookies timed out` :
      read.jar === null ? browserCookieFailureReason(read.stderr) : diagnoseCookiesText(read.jar).problem;
    if (problem !== null) {
      tried.push(`${browser} — ${problem}`);
      continue;
    }
    const saved = await persistCookieJar(browser, config.cookiesFile, read.jar!, mayPublish, opts.publish);
    // A successful rename changes the file by design, so don't re-test the old
    // file fingerprint until after handling success.
    if (saved.ok) {
      invalidCookieFiles.delete(path);
      browserCookieSource = browser;
      for (const line of tried) log(`   browser ${line}`);
      log(`Saved ${saved.cookies} YouTube/Google cookies from ${browser} to cookies.txt.`);
      return;
    }
    if (!mayPublish()) { browserCheckedAt.delete(key); return; }
    tried.push(`${browser} — ${saved.error}`);
  }
  if (tried.length === 0) {
    log(`No ${config.cookiesFile} and no cookieBrowsers configured — downloads run anonymously.`);
  } else {
    for (const line of tried) log(`   browser ${line}`);
    log("No usable cookies — downloads run anonymously. Drop a valid cookies.txt in while the engine runs.");
  }
}

/**
 * Injectable view of the machine, for the discovery search below.
 *
 * The search itself is the thing that decides "aria2c is not installed", and
 * that decision is unreachable in a test on a box that has aria2c (the bare
 * name resolves through the real PATH, and on Windows the package-manager shim
 * folders are probed whether or not PATH has it). Production passes nothing;
 * tests pin the search space so a genuinely missing binary can be discovered
 * deterministically — the fallback the engine promises.
 */
export interface ToolSearchEnv {
  /** Stand-in for the app folder (`process.cwd()`). */
  cwd?: string;
  /** Stand-in for the folder holding the running executable. */
  exeDir?: string;
  platform?: NodeJS.Platform;
  /** Explicit deno path configured by the operator. */
  denoPath?: string;
  /**
   * Environment for the probe's child process (PATH included).
   *
   * When set, this environment IS the search space: with no PATH in it, the
   * bare-name candidates are skipped instead of spawned. Bun/Windows resolves a
   * bare name through the *invoking* process's PATH (CreateProcess semantics),
   * so an injected empty environment would otherwise still "find" a binary that
   * is installed on the machine — and the "nothing is installed" case this
   * switch exists for would be untestable there.
   */
  env?: Record<string, string | undefined>;
  /** Existence gate for absolute candidates. */
  exists?: (path: string) => boolean;
  /**
   * Last-resort bun interpreter (production: `bunInterpreterPath()`). Tests
   * omit this so an empty search space really finds nothing.
   */
  bunInterpreter?: string | null;
}

async function probeBinary(
  bin: string,
  args: string[],
  search: ToolSearchEnv = {},
): Promise<{ ok: boolean; version: string }> {
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      ...(search.env ? { env: search.env } : {}),
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const firstLine = (out || err || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l) || "";
    return { ok: code === 0, version: firstLine.slice(0, 80) };
  } catch {
    return { ok: false, version: "" };
  }
}

/**
 * Can a bare-name candidate still be resolved through PATH?
 *
 * Production passes no `env`, so the child inherits the real PATH and the
 * answer is always yes. An injected `env`, though, has to be able to mean
 * "there is no PATH here" — see `ToolSearchEnv.env` for why the OS alone cannot
 * be trusted to enforce that on Windows.
 */
function pathLookupAvailable(search: ToolSearchEnv): boolean {
  if (!search.env) return true;
  const pathKey = Object.keys(search.env).find((k) => k.toLowerCase() === "path");
  return !!pathKey && !!(search.env[pathKey] ?? "").trim();
}

// Candidate search order: explicit config path → PATH → app folder → folder of
// the compiled exe → common Windows package-manager shims.
function toolCandidates(
  cfgPath: string,
  posixNames: string[],
  winNames: string[],
  search: ToolSearchEnv = {},
): string[] {
  const cands: string[] = [];
  if (cfgPath && cfgPath.trim()) cands.push(cfgPath.trim());
  const cwd = search.cwd ?? process.cwd();
  const exeDir = search.exeDir ?? dirname(process.execPath);
  const bareNameWorks = pathLookupAvailable(search);
  for (const n of posixNames) {
    if (bareNameWorks) cands.push(n); // bare name → PATH lookup
    cands.push(join(cwd, n)); // next to config.json / working dir
    cands.push(join(exeDir, n)); // next to the compiled archive.exe
  }
  if ((search.platform ?? process.platform) === "win32") {
    const home = os.homedir();
    const env = search.env ?? process.env;
    const progData = env.ProgramData || "C:\\ProgramData";
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
    for (const n of winNames) {
      cands.push(
        join(cwd, n),
        join(exeDir, n),
        join(progData, "chocolatey", "bin", n),
        join(home, "scoop", "shims", n),
        join(localAppData, "Microsoft", "WinGet", "Links", n),
      );
    }
  }
  const seen = new Set<string>();
  return cands.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

/**
 * Walk the candidate list and return the first one that runs, or null.
 *
 * Exported (with `search`) so the "no candidate works" outcome — the one that
 * turns aria2c into yt-dlp's native downloader — can be tested against a real,
 * empty search space instead of being simulated with the `"none"` switch.
 */
export async function resolveTool(
  cfgPath: string,
  versionArgs: string[],
  posixNames: string[],
  winNames: string[],
  search: ToolSearchEnv = {},
): Promise<{ path: string; version: string } | null> {
  const exists = search.exists ?? existsSync;
  for (const cand of toolCandidates(cfgPath, posixNames, winNames, search)) {
    const isBare = !cand.includes("/") && !cand.includes("\\");
    if (!isBare && !exists(cand)) continue;
    const probe = await probeBinary(cand, versionArgs, search);
    if (probe.ok) return { path: cand, version: probe.version };
  }
  return null;
}

const JS_RUNTIMES: { name: JsRuntimeName; posix: string[]; win: string[] }[] = [
  { name: "deno", posix: ["deno"], win: ["deno.exe"] },
  { name: "node", posix: ["node"], win: ["node.exe"] },
  { name: "bun", posix: ["bun"], win: ["bun.exe"] },
  { name: "quickjs", posix: ["qjs"], win: ["qjs.exe"] },
];

/**
 * Find a JS runtime yt-dlp can use to solve YouTube's n-challenge.
 *
 * Preference matches yt-dlp's own: Deno (sandboxed, default) → Node → Bun →
 * QuickJS. A missing runtime is never fatal — the engine still starts — but
 * every YouTube download will then fail the n-challenge until one appears.
 * An operator can specify an explicit Deno executable via `denoPath`.
 */
export async function resolveJsRuntime(search: ToolSearchEnv = {}): Promise<JsRuntime | null> {
  const customDeno = (search.denoPath || "").trim().replace(/^["']|["']$/g, "");
  const denoDisabled = customDeno.toLowerCase() === "none";
  if (customDeno && !denoDisabled) {
    const found = await resolveTool(customDeno, ["--version"], ["deno"], ["deno.exe"], search);
    if (found) return { name: "deno", path: found.path };
  }

  for (const rt of JS_RUNTIMES) {
    if (rt.name === "deno" && denoDisabled) continue;
    const found = await resolveTool("", ["--version"], rt.posix, rt.win, search);
    if (found) return { name: rt.name, path: found.path };
  }
  const bun = (search.bunInterpreter ?? null) || null;
  if (bun && bun.trim()) return { name: "bun", path: bun.trim() };
  return null;
}

export async function checkDependencies(
  config: {
    ytDlpPath: string;
    ffmpegPath: string;
    aria2cPath?: string;
    useAria2c?: boolean;
    /**
     * Offline mode never spawns yt-dlp (no scanning, no downloads, no sidecar
     * fetches), so a missing yt-dlp is a note there — not the fatal install
     * hint it is for a normal run. ffmpeg stays required: conversion is the
     * whole point of an offline pass.
     */
    offlineMode?: boolean;
    denoPath?: string;
  },
  search: ToolSearchEnv = {},
): Promise<void> {
  console.log("🔎 Checking dependencies...");
  const missing: string[] = [];
  // The special value "none" skips aria2c discovery entirely — an operator
  // (or the test suite) can force yt-dlp's native downloader even when a
  // real aria2c is installed on this machine.
  const aria2Disabled = (config.aria2cPath || "").trim().toLowerCase() === "none";
  const [ytdlp, ffm, aria2] = await Promise.all([
    resolveTool(config.ytDlpPath, ["--version"], ["yt-dlp"], ["yt-dlp.exe"], search),
    resolveTool(config.ffmpegPath, ["-version"], ["ffmpeg"], ["ffmpeg.exe"], search),
    // aria2c is probed regardless of the flag so the status line can report
    // why it is (not) being used; a missing binary is never fatal.
    aria2Disabled
      ? Promise.resolve(null)
      : resolveTool(config.aria2cPath || "", ["--version"], ["aria2c"], ["aria2c.exe"], search),
  ]);
  const jsRt = await resolveJsRuntime({
    ...search,
    denoPath: search.denoPath ?? config.denoPath,
    bunInterpreter: search.bunInterpreter ?? bunInterpreterPath(),
  });

  if (ytdlp) {
    resolvedTools.ytDlp = ytdlp.path;
    console.log(
      `  ✅ yt-dlp: ${ytdlp.version || "ok"}${ytdlp.path.includes("/") || ytdlp.path.includes("\\") ? `  [${ytdlp.path}]` : "  [PATH]"}`,
    );
  } else if (config.offlineMode) {
    console.log("  ⚪ yt-dlp: not found — offline mode only converts and moves existing files");
  } else {
    console.error("  ❌ yt-dlp: not found (PATH, app folder, winget/scoop/chocolatey, ytDlpPath)");
    missing.push(
      `yt-dlp — Install: winget install yt-dlp  |  scoop install yt-dlp  |  pipx install yt-dlp  |  or set "ytDlpPath" in config.json`,
    );
  }
  if (ffm) {
    resolvedTools.ffmpeg = ffm.path;
    console.log(
      `  ✅ ffmpeg: ${ffm.version || "ok"}${ffm.path.includes("/") || ffm.path.includes("\\") ? `  [${ffm.path}]` : "  [PATH]"}`,
    );
  } else {
    console.error("  ❌ ffmpeg: not found (PATH, app folder, winget/scoop/chocolatey, ffmpegPath)");
    missing.push(
      `ffmpeg — Install: winget install Gyan.FFmpeg  |  scoop install ffmpeg  |  choco install ffmpeg  |  or set "ffmpegPath" in config.json`,
    );
  }

  resolvedTools.aria2cPath = aria2 ? aria2.path : null;
  if (aria2Disabled) {
    console.log(`  ⚪ aria2c: disabled (aria2cPath = "none") — using yt-dlp's native downloader`);
  } else if (aria2) {
    if (config.useAria2c === false) {
      console.log(`  ⚪ aria2c: ${aria2.version || "ok"}  [disabled in config — using yt-dlp's native downloader]`);
    } else {
      console.log(
        `  ✅ aria2c: ${aria2.version || "ok"}${aria2.path.includes("/") || aria2.path.includes("\\") ? `  [${aria2.path}]` : "  [PATH]"}  [multi-connection downloads enabled]`,
      );
    }
  } else if (config.useAria2c !== false) {
    console.log(
      "  ⚪ aria2c: not found — using yt-dlp's native downloader (install it for multi-connection speed: winget install aria2.aria2 | scoop install aria2 | choco install aria2)",
    );
  }

  resolvedTools.jsRuntime = jsRt;
  if (jsRt) {
    const where = jsRt.path.includes("/") || jsRt.path.includes("\\") ? `  [${jsRt.path}]` : "  [PATH]";
    console.log(`  ✅ JS runtime: ${jsRt.name}${where}  [YouTube n-challenge solver]`);
  } else {
    console.log(
      "  ⚪ JS runtime: not found — YouTube downloads need Deno (recommended), Node.js ≥ 22, or Bun to solve the n-challenge. See https://github.com/yt-dlp/yt-dlp/wiki/EJS",
    );
  }
  if (config.denoPath && config.denoPath.trim() && config.denoPath.trim().toLowerCase() !== "none") {
    if (!jsRt || jsRt.name !== "deno") {
      console.warn(`  ⚠️ Deno: not found or invalid at "${config.denoPath}" — falling back to other runtimes or none`);
    }
  }

  if (missing.length > 0) {
    console.error("\n❌ Missing dependencies:");
    for (const m of missing) console.error(`   • ${m}`);
    process.exit(1);
  }
  console.log("✅ All dependencies satisfied.");
}
