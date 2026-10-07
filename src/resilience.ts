// src/resilience.ts — pause/resume, circuit breaker, network monitor, disk guard.
//
// The engine pauses (rather than dies) whenever something systemic goes
// wrong: the network drops, the disk fills, cookies expire overnight. Every
// in-flight yt-dlp is interrupted, its job is parked as
// paused+interrupted, and the job resumes from its .part file on the next
// attempt — nothing already downloaded is thrown away.

import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "./db";
import { logError } from "./logger";
import {
  activeConvertJobs,
  activeConvertProcs,
  activeDownloadJobs,
  activeMetadataJobs,
  activeMetadataProcs,
  activeProcs,
  abortController,
  isPaused,
  getPauseReason,
  setPaused,
} from "./state";
import type { Config } from "./config";

/**
 * How long an interrupted child gets to exit on SIGINT before SIGKILL. yt-dlp
 * needs the grace period to stop its own aria2c child cleanly; ffmpeg usually
 * dies immediately, and a wedged one must never pin a worker.
 */
const KILL_GRACE_MS = 2_000;

/** SIGINT a child, escalating to SIGKILL after the grace period. */
function interruptChild(proc: Bun.Subprocess | undefined): boolean {
  if (!proc || proc.exitCode !== null) return false;
  try {
    proc.kill("SIGINT");
  } catch {
    return true; // it exited between the checks; treat as handled
  }
  const timer = setTimeout(() => {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {}
  }, KILL_GRACE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return true;
}

export function triggerPause(reason: string): void {
  if (isPaused() && getPauseReason() === reason) return;
  setPaused(true, reason);
  console.log(`⏸️ Triggering pause: ${reason}`);
  for (const [, proc] of activeProcs.entries()) {
    try {
      proc.kill("SIGINT");
    } catch {}
  }
}

export interface CancelledStages {
  /** Jobs whose in-flight download process was interrupted. */
  downloads: string[];
  /** Jobs whose in-flight ffmpeg conversion was interrupted. */
  conversions: string[];
  /** Jobs whose in-flight sidecar fetch was interrupted. */
  metadata: string[];
}

function stagesFor(predicate: (jobId: string) => boolean): CancelledStages {
  const result: CancelledStages = { downloads: [], conversions: [], metadata: [] };
  for (const [workerId, jobId] of activeDownloadJobs) {
    if (!predicate(jobId)) continue;
    result.downloads.push(jobId);
    interruptChild(activeProcs.get(workerId));
  }
  for (const [workerId, jobId] of activeConvertJobs) {
    if (!predicate(jobId)) continue;
    result.conversions.push(jobId);
    interruptChild(activeConvertProcs.get(workerId));
  }
  for (const [workerId, jobId] of activeMetadataJobs) {
    if (!predicate(jobId)) continue;
    result.metadata.push(jobId);
    interruptChild(activeMetadataProcs.get(workerId));
  }
  return result;
}

/**
 * Interrupt every in-flight child (yt-dlp download, ffmpeg conversion, sidecar
 * fetch) that belongs to one of `jobIds`.
 *
 * This is what makes a dashboard Delete / Purge / Remove-source actually stop
 * the work: without it the job row disappears but the child process keeps
 * downloading in the terminal and writes a media file nobody tracks. The kill
 * is deliberately fire-and-forget — the workers reap their own children and
 * their claim-guarded updates decide what, if anything, is recorded.
 */
export function cancelActiveStages(jobIds: Iterable<string>): CancelledStages {
  const wanted = new Set(jobIds);
  if (wanted.size === 0) return { downloads: [], conversions: [], metadata: [] };
  return stagesFor((jobId) => wanted.has(jobId));
}

/** Interrupt every in-flight child regardless of job (shutdown / pause-all). */
export function cancelAllActiveStages(): CancelledStages {
  return stagesFor(() => true);
}

export function triggerResume(): void {
  setPaused(false, null);
  try {
    // Re-queue ALL paused jobs (global + user-paused) on an explicit Resume All.
    // In-flight jobs still holding a claim finish naturally in their worker —
    // the claim's owner and token are left exactly as they are, so the worker's
    // own release still matches.
    const stmt = db.run(
      `UPDATE jobs SET download_status = 'pending', pause_reason = NULL,
         download_claimed_by = NULL, download_claimed_at = NULL,
         download_claim_token = NULL, download_heartbeat_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE download_status = 'paused' AND download_claimed_by IS NULL`,
    );
    if (stmt.changes > 0) console.log(`▶️ Re-queued ${stmt.changes} paused job(s).`);
  } catch {}
  // A human resumed the engine — give the failure circuit a clean slate.
  failureCircuit.dl = 0;
  failureCircuit.post = 0;
}

// --- Circuit breaker ---------------------------------------------------------
// maxFailures is a consecutive-failure tripwire per pipeline stage: a run of
// hard failures with no successes in between (expired cookies overnight, a
// YouTube outage, a broken ffmpeg) pauses the whole engine instead of letting
// it burn through the queue one video at a time.
const failureCircuit = { dl: 0, post: 0 };

export function notePipelineSuccess(stage: "dl" | "post"): void {
  if (stage === "dl") failureCircuit.dl = 0;
  else failureCircuit.post = 0;
}

export function notePipelineFailure(stage: "dl" | "post", config: Config): void {
  if (stage === "dl") failureCircuit.dl++;
  else failureCircuit.post++;
  const worst = Math.max(failureCircuit.dl, failureCircuit.post);
  if (worst >= config.maxFailures) {
    const detail = `TOO_MANY_FAILURES (${failureCircuit.dl} consecutive download / ${failureCircuit.post} consecutive post-processing failures, limit ${config.maxFailures})`;
    failureCircuit.dl = 0;
    failureCircuit.post = 0;
    logError("circuit", `pausing engine: ${detail}`);
    triggerPause(detail);
  }
}

// --- Network monitor ---------------------------------------------------------
// Tried in order: the first reachable host means "online". Multiple endpoints
// keep the monitor honest on networks that block one host but not another.
const NETWORK_PROBES = [
  "https://www.youtube.com/favicon.ico",
  "https://youtu.be/favicon.ico",
  "https://manifest.googlevideo.com/favicon.ico",
];

export type NetworkProbe = () => Promise<boolean>;

export async function defaultNetworkProbe(): Promise<boolean> {
  for (const url of NETWORK_PROBES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        await fetch(url, { signal: controller.signal, method: "HEAD", redirect: "follow" });
      } finally {
        clearTimeout(timeout);
      }
      return true;
    } catch {
      // try the next probe
    }
  }
  return false;
}

export async function checkInternet(probe?: NetworkProbe): Promise<boolean> {
  return (probe ?? defaultNetworkProbe)();
}

export interface NetworkMonitorDecision {
  /** Consecutive failure count after this tick. */
  consecutiveFails: number;
  /** Whether the engine should be paused (network down). */
  shouldPause: boolean;
  /** Whether a network-caused pause should be resumed. */
  shouldResume: boolean;
}

/**
 * Pure decision logic for one network-monitor tick.
 *
 * Separated from the async loop so it is unit-testable without timers or the
 * shared `abortController`.
 */
export function networkMonitorTick(
  consecutiveFails: number,
  isUp: boolean,
  currentlyPaused: boolean,
  currentPauseReason: string | null,
): NetworkMonitorDecision {
  if (!isUp) {
    const next = consecutiveFails + 1;
    return {
      consecutiveFails: next,
      shouldPause: next >= 2 && !currentlyPaused,
      shouldResume: false,
    };
  }
  return {
    consecutiveFails: 0,
    shouldPause: false,
    shouldResume: consecutiveFails > 0 && currentPauseReason === "NETWORK_DISCONNECTED",
  };
}

export interface NetworkMonitorOptions {
  /** Injectable probe (default: real fetch against YouTube endpoints). */
  probe?: NetworkProbe;
  /** Milliseconds between probes (default: 15 000). */
  intervalMs?: number;
}

/**
 * Continuously monitor network reachability.
 *
 * Two consecutive failures pause the engine; a successful probe after a
 * network-caused pause resumes it. User pauses are never cleared by the
 * monitor (only "NETWORK_DISCONNECTED" is eligible for auto-resume).
 */
export async function networkMonitor(opts: NetworkMonitorOptions = {}): Promise<void> {
  const probe = opts.probe ?? defaultNetworkProbe;
  const intervalMs = opts.intervalMs ?? 15_000;
  let consecutiveFails = 0;
  console.log("🌐 Network monitor started.");
  while (!abortController.signal.aborted) {
    const isUp = await checkInternet(probe);
    const decision = networkMonitorTick(consecutiveFails, isUp, isPaused(), getPauseReason());
    consecutiveFails = decision.consecutiveFails;
    if (decision.shouldPause) {
      triggerPause("NETWORK_DISCONNECTED");
      console.log("🌐 Network down detected. Pausing engine gracefully.");
    }
    if (decision.shouldResume) {
      console.log("🌐 Network restored!");
      triggerResume();
    }
    await Bun.sleep(intervalMs);
  }
}

// --- Disk space guard --------------------------------------------------------
let diskCheckWarned = false;

/** Volume sizes in bytes, or -1 when no probe could determine them. */
export interface DiskUsage {
  freeBytes: number;
  totalBytes: number;
  /** Why every probe failed, when they all did (for the error log). */
  error?: string;
}

/**
 * Injection points for the disk-probe fallback chain. Production callers pass
 * nothing; the tests use them to force each step of the chain (a build with no
 * `statfs`, a Windows host, a shell that hangs or answers nonsense) on any
 * machine — the unsupported-`statfs` and PowerShell branches are otherwise
 * unreachable off a broken Windows box.
 */
export interface DiskProbeOptions {
  /** statfs implementation. `null` = this Bun build has none (calling it throws). */
  statfs?: typeof statfs | null;
  /** Platform gate for the PowerShell fallback. */
  platform?: NodeJS.Platform;
  /** Existence gate for the fallback's "nothing on disk to measure" rule. */
  pathExists?: (path: string) => boolean;
  /** The bounded PowerShell round-trip; resolves to the shell's stdout, or null. */
  runPowerShell?: (drive: string) => Promise<string | null>;
  /** Ceiling for the PowerShell round-trip. */
  timeoutMs?: number;
}

/**
 * Free + total bytes for the volume holding `path`.
 *
 * statfs first (one syscall, no child process). Some Bun builds on Windows do
 * not implement it at all — then `statfs` is `undefined` and *calling* it
 * throws a TypeError synchronously, which a `.catch()` chained on the call can
 * never see. That is why every caller goes through here rather than calling
 * statfs directly: this function's `try` catches the synchronous throw too,
 * and falls back to PowerShell's Get-PSDrive on win32.
 *
 * Returns -1/-1 rather than throwing when no probe works, so a machine without
 * a usable disk probe degrades (no low-disk guard, dashboard shows "unknown")
 * instead of failing whatever asked. A path that does not exist always lands
 * here, on every platform: the shell fallback deliberately refuses to answer
 * for a drive when there is nothing on it to measure.
 */
export async function diskUsage(path: string, opts: DiskProbeOptions = {}): Promise<DiskUsage> {
  const statfsFn = opts.statfs === undefined ? statfs : opts.statfs;
  try {
    // Exactly what an unimplemented Bun build does: the call itself throws a
    // TypeError, before any promise exists to catch.
    if (!statfsFn) throw new TypeError("statfs is not a function");
    const stats = await statfsFn(path);
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch (e: any) {
    const fallback = await windowsDiskUsage(path, opts);
    if (fallback) return fallback;
    return { freeBytes: -1, totalBytes: -1, error: String(e?.code || e?.message || e) };
  }
}

/** Hard ceiling on the PowerShell probe — a hung shell must never stall a caller. */
const POWERSHELL_TIMEOUT_MS = 8000;
/** A cold PowerShell start costs seconds; /api/status polls on every request. */
const POWERSHELL_MEMO_TTL_MS = 15000;
const driveMemo = new Map<string, { at: number; usage: DiskUsage }>();

/**
 * The drive letter a path lives on, or "" when it has none.
 *
 * `X:…` is recognised before `resolve()` so the helper is testable off Windows
 * (where resolving a `D:\…` string against a POSIX cwd would mangle it); on
 * win32 `resolve()` returns the drive path unchanged, so behaviour is
 * identical there.
 */
export function driveLetterOf(path: string): string {
  const root = /^[A-Za-z]:/.test(path) ? path : resolve(path); // e.g. D:\Downloads\YT
  const drive = root.slice(0, 1);
  return /^[A-Za-z]$/.test(drive) ? drive : "";
}

/** Get-PSDrive probe for win32; null when it cannot answer. */
async function windowsDiskUsage(path: string, opts: DiskProbeOptions = {}): Promise<DiskUsage | null> {
  try {
    if ((opts.platform ?? process.platform) !== "win32") return null;
    const exists = opts.pathExists ?? existsSync;
    // A path that is not on disk has no volume to measure, and the shell would
    // happily answer for the *drive* it sits under — which would silently mask
    // the "unknown" state the dashboard and the low-disk guard exist to surface.
    // Cheaper than the spawn too, which matters: no statfs means every probe
    // here costs a PowerShell start.
    if (!exists(path)) return null;
    const drive = driveLetterOf(path);
    if (!drive) return null;
    const key = drive.toUpperCase();
    const memo = driveMemo.get(key);
    if (memo && Date.now() - memo.at < POWERSHELL_MEMO_TTL_MS) return memo.usage;
    const usage = await getPSDriveFreeSpace(drive, opts);
    // Only successful answers are memoized; a failure must stay retryable.
    if (usage) driveMemo.set(key, { at: Date.now(), usage });
    return usage;
  } catch {
    return null;
  }
}

/** One bounded Get-PSDrive round-trip; null on any failure. */
async function getPSDriveFreeSpace(drive: string, opts: DiskProbeOptions = {}): Promise<DiskUsage | null> {
  const timeoutMs = opts.timeoutMs ?? POWERSHELL_TIMEOUT_MS;
  // The outer race bounds the *injected* probe too (and any implementation
  // that ignores its signal), so a hung shell can never stall a caller even if
  // the child-process timeout below is bypassed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutGuard = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(null), timeoutMs);
  });
  try {
    const work = opts.runPowerShell ? opts.runPowerShell(drive) : runPSDriveProbe(drive, timeoutMs);
    const out = await Promise.race<string | null>([work, timeoutGuard]);
    if (out === null) return null;
    return parsePSDriveOutput(out);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Parse Get-PSDrive's `"<free> <used>"` line. Exported for tests: the shell's
 * output shapes (bytes, an error banner, an empty string) are the part that
 * decides degraded vs measured, and they are impossible to produce on demand
 * from a real shell.
 */
export function parsePSDriveOutput(out: string): DiskUsage | null {
  const [free, used] = out.trim().split(/\s+/).map((n) => parseFloat(n));
  if (!Number.isFinite(free)) return null;
  return {
    freeBytes: free,
    totalBytes: Number.isFinite(used) ? free + used : -1,
  };
}

/** Spawn `powershell … Get-PSDrive`, hard-killed at `timeoutMs`; stdout or null. */
async function runPSDriveProbe(drive: string, timeoutMs: number): Promise<string | null> {
  const proc = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$d = Get-PSDrive -Name '${drive}'; "$($d.Free) $($d.Used)"`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<null>((resolveTimeout) => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        resolveTimeout(null);
      }, timeoutMs);
    });
    const reading = Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const result = await Promise.race<[string, number] | null>([reading, timedOut]);
    if (!result) return null; // shell never answered
    const [out, code] = result;
    return code === 0 ? out : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function checkDiskSpace(
  path: string,
  minGB: number,
  opts: DiskProbeOptions = {},
): Promise<{ free: number; ok: boolean }> {
  const usage = await diskUsage(path, opts);
  if (usage.freeBytes < 0) {
    // Degraded mode: never permanently brick the engine over a failed probe —
    // log once and allow (yt-dlp will still surface a real disk-full error).
    if (!diskCheckWarned) {
      diskCheckWarned = true;
      console.warn("⚠️ Could not determine free disk space — continuing without the low-disk guard.");
      logError(
        "disk",
        `statfs/PowerShell probe failed for ${path} (${usage.error || "unknown"}); low-disk guard disabled for this run`,
      );
    }
    return { free: -1, ok: true };
  }
  const freeGB = usage.freeBytes / 1024 ** 3;
  return { free: freeGB, ok: freeGB > minGB };
}

// --- Child-process bookkeeping ----------------------------------------------
// Kill in-flight children on shutdown; called by the lifecycle module.
export function killActiveChildren(): void {
  for (const [, proc] of activeProcs) {
    try {
      proc.kill("SIGINT");
    } catch {}
  }
  for (const [, proc] of activeConvertProcs) {
    try {
      proc.kill("SIGINT");
    } catch {}
  }
  for (const [, proc] of activeMetadataProcs) {
    try {
      proc.kill("SIGINT");
    } catch {}
  }
}
