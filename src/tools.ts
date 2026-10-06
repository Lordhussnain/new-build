// src/tools.ts — external dependency discovery (yt-dlp / ffmpeg).
//
// Verifies every required tool BEFORE opening the database or scanning links,
// so misconfigured machines fail fast with clear hints. Custom Windows
// installs (exe next to the app, scoop, choco, winget, or an explicit config
// path) all work without touching PATH.

import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";

// aria2c is optional: when present it becomes the multi-connection downloader
// (yt-dlp --downloader aria2c), and when absent the engine transparently uses
// yt-dlp's native downloader. `aria2cPath` stays "" until discovery finds it.
export const resolvedTools = { ytDlp: "yt-dlp", ffmpeg: "ffmpeg", aria2cPath: "" as string | null };
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

/**
 * True when aria2c can actually be handed a transfer right now.
 *
 * A resolved filesystem path that vanished (uninstalled mid-run, unplugged
 * drive) falls back to yt-dlp's native downloader instead of failing every
 * download with "aria2c not found". A bare name already probed on PATH at
 * startup is trusted — re-probing on every download would cost a spawn each.
 */
export function aria2cUsable(): boolean {
  const p = resolvedTools.aria2cPath;
  if (!p) return false;
  if (p.includes("/") || p.includes("\\")) {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Re-run aria2c discovery when no binary is currently known.
 *
 * Operators install aria2c while the engine is already running; without this
 * the engine would stay on the native downloader until the next restart. Only
 * fills a gap — it never replaces or clears an existing resolution — honours
 * the `"none"` opt-out, and returns true when a binary was newly found.
 */
export async function refreshAria2cDiscovery(config: {
  aria2cPath?: string;
  useAria2c?: boolean;
}): Promise<boolean> {
  if (resolvedTools.aria2cPath) return false;
  if ((config.aria2cPath || "").trim().toLowerCase() === "none") return false;
  const found = await resolveTool(config.aria2cPath || "", ["--version"], ["aria2c"], ["aria2c.exe"]);
  if (!found) return false;
  resolvedTools.aria2cPath = found.path;
  console.log(
    `  ✅ aria2c appeared mid-run: ${found.version || "ok"}  [${found.path}] — new downloads will use it`,
  );
  return true;
}
/** The executable yt-dlp should hand transfers to, or "native" for its own. */
export function activeDownloader(): "aria2c" | "native" {
  return resolvedTools.aria2cPath ? "aria2c" : "native";
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

/** `--cookies <file>` when the file exists and is non-empty, else nothing. */
export function cookiesArgs(config: { cookiesFile: string }): string[] {
  const s = cookiesState(config);
  return s.present ? ["--cookies", s.file] : [];
}

export type CookiesChange = "appeared" | "disappeared" | "updated" | null;

let cookiesBaseline: CookiesState | null = null;

/**
 * Compare the cookies file with the last observation and remember this one.
 *
 * `cookiesArgs()` re-stats the file on every yt-dlp invocation, so a
 * cookies.txt dropped in *after* startup is already used by the next attempt —
 * silently. This is the part that makes it observable: the engine polls it
 * (see `reconcile.ts cookiesWatch`) so the operator sees the file being picked
 * up, replaced, or vanishing instead of wondering why age-gated videos
 * suddenly work or suddenly fail.
 */
export function detectCookiesChange(config: {
  cookiesFile: string;
}): { change: CookiesChange; state: CookiesState } {
  const state = cookiesState(config);
  const prev = cookiesBaseline;
  cookiesBaseline = state;
  if (!prev) return { change: null, state }; // first observation = baseline
  if (!prev.present && state.present) return { change: "appeared", state };
  if (prev.present && !state.present) return { change: "disappeared", state };
  if (
    prev.present &&
    state.present &&
    (prev.size !== state.size || prev.mtimeMs !== state.mtimeMs)
  ) {
    return { change: "updated", state };
  }
  return { change: null, state };
}

/** Forget the observed cookies state (tests, and a config path change). */
export function resetCookiesBaseline(): void {
  cookiesBaseline = null;
}

/** Cheap validity probe for a cookies file (one yt-dlp metadata call). */
export async function validateCookies(cookiesFile: string): Promise<boolean> {
  if (!existsSync(cookiesFile)) return false;
  const proc = Bun.spawn(
    [ytDlp(), "--cookies", cookiesFile, "--no-warnings", "--dump-single-json", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return code === 0 && !stderr.toLowerCase().includes("login required");
}

async function probeBinary(bin: string, args: string[]): Promise<{ ok: boolean; version: string }> {
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
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

// Candidate search order: explicit config path → PATH → app folder → folder of
// the compiled exe → common Windows package-manager shims.
function toolCandidates(cfgPath: string, posixNames: string[], winNames: string[]): string[] {
  const cands: string[] = [];
  if (cfgPath && cfgPath.trim()) cands.push(cfgPath.trim());
  const cwd = process.cwd();
  const exeDir = dirname(process.execPath);
  for (const n of posixNames) {
    cands.push(n); // bare name → PATH lookup
    cands.push(join(cwd, n)); // next to config.json / working dir
    cands.push(join(exeDir, n)); // next to the compiled archive.exe
  }
  if (process.platform === "win32") {
    const home = os.homedir();
    const progData = process.env.ProgramData || "C:\\ProgramData";
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
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

async function resolveTool(
  cfgPath: string,
  versionArgs: string[],
  posixNames: string[],
  winNames: string[],
): Promise<{ path: string; version: string } | null> {
  for (const cand of toolCandidates(cfgPath, posixNames, winNames)) {
    const isBare = !cand.includes("/") && !cand.includes("\\");
    if (!isBare && !existsSync(cand)) continue;
    const probe = await probeBinary(cand, versionArgs);
    if (probe.ok) return { path: cand, version: probe.version };
  }
  return null;
}

export async function checkDependencies(config: {
  ytDlpPath: string;
  ffmpegPath: string;
  aria2cPath?: string;
  useAria2c?: boolean;
}): Promise<void> {
  console.log("🔎 Checking dependencies...");
  const missing: string[] = [];
  // The special value "none" skips aria2c discovery entirely — an operator
  // (or the test suite) can force yt-dlp's native downloader even when a
  // real aria2c is installed on this machine.
  const aria2Disabled = (config.aria2cPath || "").trim().toLowerCase() === "none";
  const [ytdlp, ffm, aria2] = await Promise.all([
    resolveTool(config.ytDlpPath, ["--version"], ["yt-dlp"], ["yt-dlp.exe"]),
    resolveTool(config.ffmpegPath, ["-version"], ["ffmpeg"], ["ffmpeg.exe"]),
    // aria2c is probed regardless of the flag so the status line can report
    // why it is (not) being used; a missing binary is never fatal.
    aria2Disabled
      ? Promise.resolve(null)
      : resolveTool(config.aria2cPath || "", ["--version"], ["aria2c"], ["aria2c.exe"]),
  ]);

  if (ytdlp) {
    resolvedTools.ytDlp = ytdlp.path;
    console.log(
      `  ✅ yt-dlp: ${ytdlp.version || "ok"}${ytdlp.path.includes("/") || ytdlp.path.includes("\\") ? `  [${ytdlp.path}]` : "  [PATH]"}`,
    );
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

  if (missing.length > 0) {
    console.error("\n❌ Missing dependencies:");
    for (const m of missing) console.error(`   • ${m}`);
    process.exit(1);
  }
  console.log("✅ All dependencies satisfied.");
}
