// src/history.ts — run history rows, heartbeated so hard kills still land.
//
// A row is inserted at startup and refreshed every minute (plus once more on
// shutdown). If the process is killed outright — window close, taskkill /F,
// power loss — the last heartbeat still leaves a usable history entry.

import { db } from "./db";
import { logError } from "./logger";
import { startTime, stats } from "./state";

let runHistoryId: number | null = null;

function fmt(t: number): string {
  return new Date(t).toISOString().replace("T", " ").slice(0, 19);
}

/** Insert a run row at startup. */
export function startRunHistory(): void {
  try {
    const res = db.run(
      `INSERT INTO run_history (started_at, ended_at, duration_seconds, downloaded, skipped, failed, total_queued)
       VALUES (?, ?, ?, 0, 0, 0, 0)`,
      [fmt(startTime), fmt(startTime), 0],
    );
    runHistoryId = Number(res.lastInsertRowid);
  } catch (e: any) {
    logError("history", String(e?.message || e));
  }
}

/** Refresh the current run row with live counters. */
export function heartbeatRunHistory(): void {
  if (runHistoryId == null) return;
  try {
    db.run(
      `UPDATE run_history SET ended_at = ?, duration_seconds = ?, downloaded = ?, skipped = ?, failed = ?, total_queued = ? WHERE id = ?`,
      [
        fmt(Date.now()),
        (Date.now() - startTime) / 1000,
        stats.downloaded,
        stats.skipped,
        stats.failed,
        stats.totalQueued,
        runHistoryId,
      ],
    );
  } catch {}
}
