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
let shutdownExitCode = 0;

/**
 * Stop accepting HTTP requests, keeping in-flight responses alive.
 *
 * Called first in the shutdown sequence: the dashboard polls /api/status every
 * few seconds, and a poll that arrives while the database is being checkpointed
 * would otherwise sit unanswered until process.exit() killed the socket
 * mid-response — the half-served request Bun reports as an idle timeout with
 * "Bun.serve() timed out a request after 10 seconds. Pass `idleTimeout` to
 * configure." `stop(false)` closes the listener and lets outstanding responses
 * finish; the final `stop(true)` in the shutdown path still force-closes
 * whatever is left, and Bun treats a second `stop()` on a closed listener as a
 * no-op.
 *
 * Failures are logged, never raised: the shutdown must not turn a clean Ctrl+C
 * into a non-zero exit because the port was already released.
 */
export function stopAcceptingRequests(
  webServer: { stop: (closeActive?: boolean) => void } | null,
): void {
  if (!webServer) return;
  try {
    webServer.stop(false);
  } catch (error) {
    logError(
      "lifecycle",
      `could not close the web listener: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export async function handleShutdown(
  sig: string,
  webServer: { stop: (closeActive?: boolean) => void } | null,
  exitCode: number = 0,
): Promise<void> {
  if (isShuttingDown) {
    // A fatal exception may arrive while an ordinary signal shutdown is in
    // progress. Preserve the failure status without starting cleanup twice.
    if (exitCode !== 0) shutdownExitCode = exitCode;
    return;
  }
  isShuttingDown = true;
  shutdownExitCode = exitCode;
  console.log(`\n🛑 ${sig} received. Gracefully stopping active downloads...`);
  // Close the listener before anything long-running starts (see the helper).
  stopAcceptingRequests(webServer);
  try {
    triggerPause("SHUTDOWN_REQUESTED");
    // Give in-flight yt-dlp processes a moment to flush their .part files and
    // exit cleanly before we abort the worker loops.
    await Bun.sleep(3000);
  } catch (error) {
    shutdownExitCode = shutdownExitCode || 1;
    logError("lifecycle", `could not pause cleanly during shutdown: ${error instanceof Error ? error.message : error}`);
  } finally {
    try {
      abortController.abort();
    } catch (error) {
      shutdownExitCode = shutdownExitCode || 1;
      logError("lifecycle", `could not abort worker loops: ${error instanceof Error ? error.message : error}`);
    }
    try {
      // Kill any still-running child processes.
      killActiveChildren();
    } catch (error) {
      shutdownExitCode = shutdownExitCode || 1;
      logError("lifecycle", `could not stop child processes: ${error instanceof Error ? error.message : error}`);
    }

    try {
      // Freeze resume state after worker loops stop. Only the current lease
      // owner may rewrite claims; a takeover means those rows belong elsewhere.
      if (!holdsEngineLease()) {
        logError("lifecycle", "not persisting interrupted state: the engine lease was lost (another engine owns archive.db)");
      } else {
        recordPartialPaths();
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
    } catch (error) {
      shutdownExitCode = shutdownExitCode || 1;
      logError("lifecycle", `could not persist interrupted state: ${error instanceof Error ? error.stack || error.message : error}`);
    }

    try {
      heartbeatRunHistory();
    } catch (error) {
      shutdownExitCode = shutdownExitCode || 1;
      logError("lifecycle", `could not flush run history: ${error instanceof Error ? error.message : error}`);
    }
    try {
      if (releaseEngineLease()) console.log("🔓 Engine lease released.");
    } catch (error) {
      shutdownExitCode = shutdownExitCode || 1;
      logError("lifecycle", `could not release engine lease: ${error instanceof Error ? error.message : error}`);
    }
    try {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      shutdownExitCode = shutdownExitCode || 1;
      logError("lifecycle", `WAL checkpoint failed: ${error instanceof Error ? error.message : error}`);
    }
    try {
      webServer?.stop(true);
    } catch (error) {
      shutdownExitCode = shutdownExitCode || 1;
      logError("lifecycle", `could not stop web server: ${error instanceof Error ? error.message : error}`);
    }
    try {
      resetTerminal();
    } catch (error) {
      shutdownExitCode = shutdownExitCode || 1;
      logError("lifecycle", `could not reset terminal: ${error instanceof Error ? error.message : error}`);
    }
    process.exit(shutdownExitCode);
  }
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
