// src/report.ts — the human-readable run report (shown in the web UI's
// "Logs → Run report" tab).

import { db } from "./db";
import { autoscaler, activeDlSlots } from "./autoscale";
import { formatBytesPerSec, formatDuration } from "./util";
import { getPauseReason, isPaused, stats } from "./state";
import { parseStoredTerminalError } from "./retry";

export function buildRunReport(): string[] {
  try {
    const totals = db
      .query(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN download_status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN download_status = 'paused' THEN 1 ELSE 0 END) as paused,
          SUM(CASE WHEN download_status = 'downloading' THEN 1 ELSE 0 END) as downloading,
          SUM(CASE WHEN download_status = 'downloaded' THEN 1 ELSE 0 END) as downloaded,
          SUM(CASE WHEN download_status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN conversion_status = 'pending' THEN 1 ELSE 0 END) as conv_pending,
          SUM(CASE WHEN conversion_status = 'in_progress' THEN 1 ELSE 0 END) as conv_active,
          SUM(CASE WHEN conversion_status = 'done' THEN 1 ELSE 0 END) as conv_done,
          SUM(CASE WHEN conversion_status = 'failed' THEN 1 ELSE 0 END) as conv_failed,
          SUM(CASE WHEN metadata_status = 'pending' THEN 1 ELSE 0 END) as meta_pending,
          SUM(CASE WHEN metadata_status = 'in_progress' THEN 1 ELSE 0 END) as meta_active,
          SUM(CASE WHEN metadata_status = 'done' THEN 1 ELSE 0 END) as meta_done,
          SUM(CASE WHEN metadata_status = 'failed' THEN 1 ELSE 0 END) as meta_failed,
          SUM(CASE WHEN download_status = 'waiting_live' THEN 1 ELSE 0 END) as waiting_live
        FROM jobs`,
      )
      .get() as any;
    const failures = db
      .query(
        `SELECT id, title, retry_count, conversion_retry_count, metadata_retry_count, last_error FROM jobs
         WHERE download_status = 'failed' OR conversion_status = 'failed' OR metadata_status = 'failed'
         ORDER BY updated_at DESC LIMIT 10`,
      )
      .all() as any[];
    const lines: string[] = [];
    lines.push(`=== Archive Engine Report — ${new Date().toISOString()} ===`);
    lines.push(
      `Uptime: ${formatDuration(process.uptime())} | Engine: ${isPaused() ? `PAUSED (${getPauseReason() || "unknown"})` : "RUNNING"}`,
    );
    lines.push(
      `Download slots: ${activeDlSlots.size} (autoscale ${autoscaler.enabled ? "on" : "off"}) | Busy: ${totals.downloading || 0} | Speed: ${formatBytesPerSec(autoscaler.getAggregateSpeed())}`,
    );
    lines.push(
      `Jobs — total: ${totals.total || 0}, pending: ${totals.pending || 0}, paused: ${totals.paused || 0}, downloading: ${totals.downloading || 0}, downloaded: ${totals.downloaded || 0}, failed: ${totals.failed || 0}, waiting for VOD: ${totals.waiting_live || 0}`,
    );
    lines.push(
      `Conversion — pending: ${totals.conv_pending || 0}, in progress: ${totals.conv_active || 0}, done: ${totals.conv_done || 0}, failed: ${totals.conv_failed || 0}`,
    );
    lines.push(
      `Metadata — pending: ${totals.meta_pending || 0}, in progress: ${totals.meta_active || 0}, done: ${totals.meta_done || 0}, failed: ${totals.meta_failed || 0}`,
    );
    lines.push(
      `This run — queued: ${stats.totalQueued}, downloaded: ${stats.downloaded}, skipped: ${stats.skipped}, failed: ${stats.failed} (of which unavailable: ${stats.unavailable}), format fallbacks: ${stats.formatFallbacks}, metadata: ${stats.metadata}, converted: ${stats.converted}`,
    );
    if (failures.length > 0) {
      lines.push("");
      lines.push("Recent failures:");
      for (const f of failures) {
        // Terminal skips read as what they are — a reason, not a stack trace.
        // Everything else keeps the full message: it is actionable.
        const terminal = parseStoredTerminalError(f.last_error);
        lines.push(
          terminal
            ? `  ⛔ [${f.id}] ${f.title} — ${terminal.label} (skipped, never auto-retried)`
            : `  ✗ [${f.id}] ${f.title} (retries: ${f.retry_count || 0}) — ${f.last_error || "no error recorded"}`,
        );
      }
    } else {
      lines.push("");
      lines.push("No failed jobs. All clear. ✅");
    }
    return lines;
  } catch (e: any) {
    return [`Failed to build report: ${e?.message || e}`];
  }
}
