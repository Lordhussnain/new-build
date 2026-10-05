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
import { activeMetadataProcs, activeProcs, abortController, isPaused, getPauseReason, setPaused } from "./state";
import type { Config } from "./config";

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

export function triggerResume(): void {
  setPaused(false, null);
  try {
    // Re-queue ALL paused jobs (global + user-paused) on an explicit Resume All.
    // In-flight jobs still holding a claim finish naturally in their worker.
    const stmt = db.run(
      `UPDATE jobs SET download_status = 'pending', pause_reason = NULL, download_claimed_by = NULL, updated_at = CURRENT_TIMESTAMP
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

export async function checkInternet(): Promise<boolean> {
  for (const url of NETWORK_PROBES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      await fetch(url, { signal: controller.signal, method: "HEAD", redirect: "follow" });
      clearTimeout(timeout);
      return true;
    } catch {
      // try the next probe
    }
  }
  return false;
}

export async function networkMonitor(): Promise<void> {
  let consecutiveFails = 0;
  console.log("🌐 Network monitor started.");
  while (!abortController.signal.aborted) {
    const isUp = await checkInternet();
    if (!isUp) {
      consecutiveFails++;
      if (consecutiveFails >= 2 && !isPaused()) {
        triggerPause("NETWORK_DISCONNECTED");
        console.log("🌐 Network down detected. Pausing engine gracefully.");
      }
    } else {
      if (consecutiveFails > 0) {
        console.log("🌐 Network restored!");
        consecutiveFails = 0;
        if (getPauseReason() === "NETWORK_DISCONNECTED") triggerResume();
      }
    }
    await Bun.sleep(15000);
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
export async function diskUsage(path: string): Promise<DiskUsage> {
  try {
    const stats = await statfs(path);
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch (e: any) {
    const fallback = await windowsDiskUsage(path);
    if (fallback) return fallback;
    return { freeBytes: -1, totalBytes: -1, error: String(e?.code || e?.message || e) };
  }
}

/** Hard ceiling on the PowerShell probe — a hung shell must never stall a caller. */
const POWERSHELL_TIMEOUT_MS = 8000;
/** A cold PowerShell start costs seconds; /api/status polls on every request. */
const POWERSHELL_MEMO_TTL_MS = 15000;
const driveMemo = new Map<string, { at: number; usage: DiskUsage }>();

/** Get-PSDrive probe for win32; null when it cannot answer. */
async function windowsDiskUsage(path: string): Promise<DiskUsage | null> {
  try {
    if (process.platform !== "win32") return null;
    const root = resolve(path); // e.g. D:\Downloads\YT
    // A path that is not on disk has no volume to measure, and the shell would
    // happily answer for the *drive* it sits under — which would silently mask
    // the "unknown" state the dashboard and the low-disk guard exist to surface.
    // Cheaper than the spawn too, which matters: no statfs means every probe
    // here costs a PowerShell start.
    if (!existsSync(root)) return null;
    const drive = root.slice(0, 1); // "D"
    if (!/^[A-Za-z]$/.test(drive)) return null;
    const key = drive.toUpperCase();
    const memo = driveMemo.get(key);
    if (memo && Date.now() - memo.at < POWERSHELL_MEMO_TTL_MS) return memo.usage;
    const usage = await getPSDriveFreeSpace(drive);
    // Only successful answers are memoized; a failure must stay retryable.
    if (usage) driveMemo.set(key, { at: Date.now(), usage });
    return usage;
  } catch {
    return null;
  }
}

/** One bounded Get-PSDrive round-trip; null on any failure. */
async function getPSDriveFreeSpace(drive: string): Promise<DiskUsage | null> {
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
      }, POWERSHELL_TIMEOUT_MS);
    });
    const reading = Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const result = await Promise.race<[string, number] | null>([reading, timedOut]);
    if (!result) return null; // shell never answered
    const [out, code] = result;
    if (code !== 0) return null;
    const [free, used] = out.trim().split(/\s+/).map((n) => parseFloat(n));
    if (!Number.isFinite(free)) return null;
    return {
      freeBytes: free,
      totalBytes: Number.isFinite(used) ? free + used : -1,
    };
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function checkDiskSpace(
  path: string,
  minGB: number,
): Promise<{ free: number; ok: boolean }> {
  const usage = await diskUsage(path);
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
  for (const [, proc] of activeMetadataProcs) {
    try {
      proc.kill("SIGINT");
    } catch {}
  }
}
