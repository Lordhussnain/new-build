// src/tools.ts — external dependency discovery (yt-dlp / ffmpeg).
//
// Verifies every required tool BEFORE opening the database or scanning links,
// so misconfigured machines fail fast with clear hints. Custom Windows
// installs (exe next to the app, scoop, choco, winget, or an explicit config
// path) all work without touching PATH.

import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { diagnoseCookiesText, ytDlpFailureReason } from "./cookie-file";
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
    return { file, present: s.size > 0, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return { file, present: false, size: 0, mtimeMs: 0 };
  }
}

/** How often browser cookies are re-probe (and the file re-validated) while running. */
export const COOKIE_SOURCE_RECHECK_MS = 30 * 60_000;

/**
 * Cookie source resolved by `resolveCookieSource()`.
 *
 *   • `fileCookieValid`: result of the last cookies.txt probe (null = not probed).
 *   • `browserCookieSource`: the first browser in `cookieBrowsers` whose cookies
 *     passed the probe, or null when none did.
 */
let fileCookieValid: boolean | null = null;
let browserCookieSource: string | null = null;
let browserCheckedAt = 0;
let resolving: Promise<void> | null = null;

/**
 * yt-dlp does not only READ `--cookies FILE`: on exit it dumps its cookie jar
 * back into that file (its help says "read cookies from and dump cookie jar
 * in"). Every engine run that pointed yt-dlp at the operator's export therefore
 * rewrote it, which the watcher then reported as "cookies.txt updated" every
 * minute, and which overwrote the browser export itself.
 *
 * So yt-dlp is given a private working copy, `<cookiesFile>.working`, that the
 * engine refreshes from the export whenever the export changes. The export is
 * only ever read.
 */
export function cookieWorkingCopyPath(cookiesFile: string): string {
  return `${cookiesFile}.working`;
}

let workingCopySource: { mtimeMs: number; size: number } | null = null;

/**
 * Path to hand yt-dlp for the cookies file. Re-copies the export when it is
 * new or has changed since the last copy. Falls back to the export itself if
 * the copy cannot be made, so the old behaviour is the worst case.
 */
export function cookieWorkingCopy(cookiesFile: string): string {
  const working = cookieWorkingCopyPath(cookiesFile);
  try {
    const src = statSync(cookiesFile);
    const same =
      existsSync(working) &&
      workingCopySource !== null &&
      workingCopySource.mtimeMs === src.mtimeMs &&
      workingCopySource.size === src.size;
    if (!same) {
      copyFileSync(cookiesFile, working);
      workingCopySource = { mtimeMs: src.mtimeMs, size: src.size };
    }
    return working;
  } catch {
    return cookiesFile;
  }
}

/**
 * The cookie arguments for a yt-dlp call. Order of preference:
 *   1. cookies.txt, when it exists and has not failed validation;
 *   2. the browser that was resolved from `cookieBrowsers`;
 *   3. cookies.txt even though it failed validation (the old behaviour);
 *   4. nothing (anonymous).
 * Stays synchronous and cheap: it only reads cached state and stats the file.
 */
export function cookiesArgs(config: { cookiesFile: string }): string[] {
  const s = cookiesState(config);
  if (s.present && fileCookieValid !== false) return ["--cookies", cookieWorkingCopy(s.file)];
  if (browserCookieSource) return ["--cookies-from-browser", browserCookieSource];
  return s.present ? ["--cookies", cookieWorkingCopy(s.file)] : [];
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
 * The read is deliberately NOT inside `cookiesState()`: that one runs on the hot
 * path (`cookiesArgs()` before every yt-dlp invocation) and stays a single stat.
 * A cookies.txt is a few KB of text and the watcher runs once a minute, so
 * hashing it here is affordable — and it is the only way to tell a real
 * credential change from a touch of the same bytes.
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
 * `cookiesArgs()` re-stats the file on every yt-dlp invocation, so a
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

/** Read `browser`'s cookies with yt-dlp into a temp jar. Never throws. */
export async function readBrowserCookieJar(
  browser: string,
  opts: { ytDlp?: string; timeoutMs?: number } = {},
): Promise<BrowserCookieJar> {
  const dir = await mkdtemp(join(os.tmpdir(), "yta-cookies-"));
  const jarPath = join(dir, "jar.txt");
  try {
    let child: Bun.PipedSubprocess;
    try {
      child = Bun.spawn(
        [
          opts.ytDlp ?? ytDlp(),
          "--cookies-from-browser",
          browser,
          "--cookies",
          jarPath,
          "--skip-download",
          "--playlist-items",
          "0",
          COOKIE_JAR_URL,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    } catch (error: any) {
      return { jar: null, stderr: `could not start yt-dlp: ${error?.message || error}`, timedOut: false };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, opts.timeoutMs ?? COOKIE_PROBE_TIMEOUT_MS);
    let stderr = "";
    try {
      [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    } finally {
      clearTimeout(timer);
    }
    const jar = await readFile(jarPath, "utf8").catch(() => null);
    return { jar, stderr, timedOut };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
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
    return { ok: false, reason: `could not read ${browser} cookies: ${ytDlpFailureReason(read.stderr)}` };
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
  }
}

/** Boolean form of probeCookieArgs(), for callers that do not need the reason. */
export async function validateCookieArgs(source: string[]): Promise<boolean> {
  return (await probeCookieArgs(source)).ok;
}

/** Cookies file text for diagnosis; an unreadable file gives an empty string. */
export function readCookiesTextSafely(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Cheap validity probe for a cookies file (one yt-dlp metadata call). */
export async function validateCookies(cookiesFile: string): Promise<boolean> {
  if (!existsSync(cookiesFile)) return false;
  return validateCookieArgs(["--cookies", cookieWorkingCopy(cookiesFile)]);
}

/**
 * Decide where cookies come from for this run, and remember the answer:
 *
 *   1. cookies.txt, if present and (when validateCookiesOnStart) it passes the probe;
 *   2. otherwise the first browser in `cookieBrowsers` whose cookies pass the probe;
 *   3. otherwise anonymous downloads.
 *
 * Browser probes are re-run at most every COOKIE_SOURCE_RECHECK_MS unless `force`
 * is set (the engine forces a re-run when cookies.txt appears, changes or goes).
 * Offline mode does no network work, so nothing is probed then.
 */
export function resolveCookieSource(
  config: {
    cookiesFile: string;
    validateCookiesOnStart: boolean;
    cookieBrowsers: string[];
    offlineMode: boolean;
  },
  opts: { force?: boolean; log?: (msg: string) => void } = {},
): Promise<void> {
  if (config.offlineMode) return Promise.resolve();
  if (resolving) return resolving;
  resolving = doResolve(config, opts).finally(() => {
    resolving = null;
  });
  return resolving;
}

async function doResolve(
  config: { cookiesFile: string; validateCookiesOnStart: boolean; cookieBrowsers: string[] },
  opts: { force?: boolean; log?: (msg: string) => void },
): Promise<void> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const s = cookiesState(config);

  if (s.present && config.validateCookiesOnStart) {
    const probe = probeCookieFile(s.file);
    fileCookieValid = probe.ok;
    if (fileCookieValid) {
      browserCookieSource = null;
      log("✅ cookies.txt has a signed-in YouTube session (checked locally).");
      return;
    }
    // Say WHY, so a bad export is fixable: a format problem, a signed-out
    // browser, or an expired session look different in the log.
    log("⚠️ cookies.txt is invalid or expired — trying browser cookies.");
    log(`   cookies.txt: ${probe.reason}`);
  } else if (s.present) {
    // Validation switched off: trust the file as before, never probe browsers.
    fileCookieValid = null;
    browserCookieSource = null;
    return;
  } else {
    fileCookieValid = null;
  }

  if (!opts.force && Date.now() - browserCheckedAt < COOKIE_SOURCE_RECHECK_MS) return;
  browserCheckedAt = Date.now();

  const tried: string[] = [];
  for (const browser of config.cookieBrowsers) {
    const probe = await probeBrowserCookies(browser);
    if (probe.ok) {
      browserCookieSource = browser;
      log(`🍪 Using cookies from ${browser} (${s.present ? "cookies.txt invalid" : "no cookies.txt"}).`);
      return;
    }
    tried.push(`${browser} — ${probe.reason}`);
  }
  browserCookieSource = null;
  if (tried.length === 0) {
    log(
      `ℹ️ No ${config.cookiesFile} and no cookieBrowsers configured — downloads run anonymously. Drop the file in while the engine runs and it is picked up within a minute.`,
    );
  } else {
    for (const line of tried) log(`   browser ${line}`);
    log(
      `ℹ️ No usable cookies (cookies.txt missing or rejected; browsers tried: ${config.cookieBrowsers.join(", ")}) — downloads run anonymously. Drop cookies.txt in while the engine runs and it is picked up within a minute.`,
    );
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
