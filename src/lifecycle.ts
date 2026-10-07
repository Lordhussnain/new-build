// src/lifecycle.ts — worker supervision and graceful shutdown.
//
// Worker loops are supervised: a crashed loop restarts after a short backoff
// instead of dying silently. Shutdown is ordered — pause first (in-flight
// yt-dlp processes get SIGINT), then persist an accurate picture of the
// interrupted pipeline so the next start resumes rather than re-downloads.

import { db } from "./db";
import { holdsEngineLease, releaseEngineLease } from "./lease";
import { killActiveChildren, triggerPause } from "./resilience";
import { heartbeatRunHistory } from "./history";
import { logError } from "./logger";
import { resetTerminal } from "./dashboard";
import { abortController, setPaused } from "./state";
import { recordPartialPaths } from "./reconcile";

let isShuttingDown = false;

export async function handleShutdown(sig: string, webServer: { stop: (closeActive?: boolean) => void } | null): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 ${sig} received. Gracefully stopping active downloads...`);
  triggerPause("SHUTDOWN_REQUESTED");
  // Give in-flight yt-dlp processes a moment to flush their .part files and
  // exit cleanly before we abort the worker loops.
  await Bun.sleep(3000);
  abortController.abort();

  // Kill any still-running child processes.
  killActiveChildren();

  try {
    // Freeze the resume state first: every in-flight download's `.part` path is
    // written into its job while the worker loops are already stopped, so the
    // "interrupted jobs resume from their partial" claim is actually true
    // instead of just a status the next start re-downloads from scratch.
    //
    // Only the engine that still owns the lease may rewrite in-flight claims:
    // if another engine took over (our lease lapsed, e.g. a suspended laptop),
    // these rows belong to it now, and a blanket reset would re-queue its work
    // behind its back. The stale workers' own writes are already fenced by
    // their claim tokens.
    if (!holdsEngineLease()) {
      logError("lifecycle", "not persisting interrupted state: the engine lease was lost (another engine owns archive.db)");
    } else {
      recordPartialPaths();
      // Persist an accurate picture of the interrupted pipeline:
      //  - in-flight downloads become 'paused' + 'interrupted' (auto-resumed
      //    and continued from where they left off on the next start)
      //  - in-flight conversions/metadata re-queue to run again on next start
      db.run(
        `UPDATE jobs SET download_status = 'paused', pause_reason = 'interrupted',
           download_claimed_by = NULL, download_claimed_at = NULL,
           download_claim_token = NULL, download_heartbeat_at = NULL,
           updated_at = CURRENT_TIMESTAMP
         WHERE download_status = 'downloading'`,
      );
      db.run(
        `UPDATE jobs SET conversion_status = 'pending',
           conversion_claimed_by = NULL, conversion_claimed_at = NULL,
           conversion_claim_token = NULL, conversion_heartbeat_at = NULL,
           updated_at = CURRENT_TIMESTAMP
         WHERE conversion_status = 'in_progress'`,
      );
      db.run(
        `UPDATE jobs SET metadata_status = 'pending',
           metadata_claimed_by = NULL, metadata_claimed_at = NULL,
           metadata_claim_token = NULL, metadata_heartbeat_at = NULL,
           updated_at = CURRENT_TIMESTAMP
         WHERE metadata_status = 'in_progress'`,
      );
    }
    // Final history flush (row was created at startup + heartbeated since).
    heartbeatRunHistory();
    // Give up the database lease: a clean exit must never block the next
    // start (a hard kill needs no release — the lease simply expires).
    try {
      if (releaseEngineLease()) console.log("🔓 Engine lease released.");
    } catch {}
    // Fold the WAL back into the main database file so archive.db stays
    // self-contained after the process exits.
    try {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
  } catch {}
  webServer?.stop(true);
  resetTerminal();
  process.exit(0);
}

/** Restart crashed worker loops with a short backoff instead of dying silently. */
export function supervise(name: string, fn: () => Promise<void>): void {
  fn()
    .catch((err) => {
      logError("worker", `${name} crashed: ${err?.stack || err}`);
      console.error(`❌ Worker ${name} crashed:`, err?.message || err);
    })
    .finally(() => {
      if (!abortController.signal.aborted) {
        console.log(`♻️ Restarting ${name} in 5s...`);
        setTimeout(() => supervise(name, fn), 5000);
      }
    });
}

// Referenced by the shutdown path to keep the pause flag consistent.
export function markShutdownPause(): void {
  setPaused(true, "SHUTDOWN_REQUESTED");
}
