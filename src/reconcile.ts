// src/reconcile.ts — startup & periodic self-healing for the job database.
//
// Four sweeps keep the pipeline honest across crashes, hard kills, and files
// moved or deleted behind the engine's back:
//
//   reconcileCrashedJobs   — jobs interrupted mid-flight resume automatically
//   reapStaleClaims        — claims orphaned by a dead worker are re-queued
//   reconcileMissingFiles  — "downloaded" files that vanished are re-queued
//                            (and scrubbed from the yt-dlp archive)
//   requeueFailedJobs      — failed jobs are retried after a cooldown, with
//                            permanent errors (private/removed videos) skipped

import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { db, perVideoCap, type Job } from "./db";
import { removeFromArchive } from "./archive";
import { logError } from "./logger";
import { detectCookiesChange, type CookiesChange } from "./tools";
import { isPermanentDownloadError } from "./retry";
import { jobBaseFilename } from "./download-args";
import { activeDownloadJobs } from "./state";
import type { Config } from "./config";

/**
 * Interrupted mid-download jobs become 'paused' + 'interrupted' so they are
 * visible as paused AND automatically re-claimed (resuming where they left
 * off via yt-dlp --continue). User-paused jobs stay held.
 */
export function reconcileCrashedJobs(): void {
  // Persist the on-disk resume point before flipping the status. This is also
  // needed at startup after a hard kill, where the normal shutdown hook never
  // had a chance to run its partial-path freeze.
  const recorded = recordPartialPaths();
  const stmt = db.run(
    `UPDATE jobs SET
       download_status = CASE WHEN download_status = 'downloading' THEN 'paused' ELSE download_status END,
       pause_reason = CASE WHEN download_status = 'downloading' OR (download_status = 'paused' AND pause_reason IS NULL) THEN 'interrupted' ELSE pause_reason END,
       conversion_status = CASE WHEN conversion_status = 'in_progress' THEN 'pending' ELSE conversion_status END,
       metadata_status = CASE WHEN metadata_status = 'in_progress' THEN 'pending' ELSE metadata_status END,
       download_claimed_by = NULL, download_claimed_at = NULL,
       conversion_claimed_by = NULL, conversion_claimed_at = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE download_status = 'downloading'
        OR (download_status = 'paused' AND pause_reason IS NULL)
        OR conversion_status = 'in_progress'
        OR metadata_status = 'in_progress'`,
  );
  if (stmt.changes > 0) {
    console.log(
      `🔄 Reconciled ${stmt.changes} interrupted job(s) (${recorded} partial(s) recorded) — paused/interrupted jobs will resume automatically.`,
    );
  }
}

/**
 * How long a claim may sit untouched before `reapStaleClaims` treats its owner
 * as dead and re-queues the job. Exported so the dashboard's sweep status
 * reports exactly the same thresholds the sweep itself enforces — if these
 * drift, the UI would promise recovery the engine never performs.
 */
export const STALE_CLAIM_THRESHOLDS = {
  download: "-20 minutes",
  conversion: "-3 hours",
  metadata: "-15 minutes",
} as const;

/**
 * Periodic safety net: if a worker process/thread dies mid-job the claim can
 * be left behind. A download claim past `STALE_CLAIM_THRESHOLDS.download` is
 * reclaimed only when no worker still owns that job; progress events heartbeat
 * the claim timestamp. Conversion and metadata claims past their thresholds
 * are re-queued.
 */
export function reapStaleClaims(): void {
  try {
    // Freeze each in-flight download's `.part` path while the job is still
    // 'downloading' (that is this function's own filter) — otherwise the
    // reclaimed job resumes without a partial and restarts from scratch.
    const recorded = recordPartialPaths();
    const activeJobIds = Array.from(activeDownloadJobs.values());
    const activeJobFilter = activeJobIds.length
      ? `AND id NOT IN (${activeJobIds.map(() => "?").join(", ")})`
      : "";
    const dlQuery =
      `UPDATE jobs SET download_status = 'paused', pause_reason = 'interrupted',
         download_claimed_by = NULL, download_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE download_status = 'downloading'
         AND (download_claimed_at IS NULL OR download_claimed_at < datetime('now', '${STALE_CLAIM_THRESHOLDS.download}')) ${activeJobFilter}`;
    const dl = activeJobIds.length ? db.run(dlQuery, activeJobIds) : db.run(dlQuery);
    const cv = db.run(
      `UPDATE jobs SET conversion_status = 'pending', conversion_claimed_by = NULL,
         conversion_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE conversion_status = 'in_progress'
         AND (conversion_claimed_at IS NULL OR conversion_claimed_at < datetime('now', '${STALE_CLAIM_THRESHOLDS.conversion}'))`,
    );
    const md = db.run(
      `UPDATE jobs SET metadata_status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE metadata_status = 'in_progress' AND updated_at < datetime('now', '${STALE_CLAIM_THRESHOLDS.metadata}')`,
    );
    const total = dl.changes + cv.changes + md.changes;
    if (total > 0) {
      console.log(
        `🧟 Reclaimed ${dl.changes} stale download(s) (${recorded} partial path(s) recorded), ${cv.changes} conversion(s), ${md.changes} metadata job(s).`,
      );
      logError("reaper", `reclaimed stale claims: downloads=${dl.changes} conversions=${cv.changes} metadata=${md.changes}`);
    }
  } catch (e: any) {
    logError("reaper", String(e?.message || e));
  }
}

/**
 * Startup reconciliation: the database says a video is downloaded, but the
 * file is not on disk any more (moved, renamed, or deleted by hand). Scrub the
 * id from the yt-dlp archive and re-queue the job so the next run fetches it
 * again — otherwise the archive entry would make yt-dlp skip it forever.
 *
 * Jobs whose conversion is in progress are skipped: with
 * `deleteSourceAfterConvert` the converter legitimately has the media in
 * mid-transition (the old source path is already gone while the new one is
 * not recorded yet), and re-queueing the download onto a live converter is
 * exactly the "file deleted before conversion finished" race.
 *
 * Returns the number of jobs re-queued.
 */
export function reconcileMissingFiles(config: Config): number {
  if (!config.verifyExistingFiles) return 0;
  let fixed = 0;
  try {
    const rows = db
      .query(
        `SELECT id, file_path, download_status, conversion_status, metadata_status,
                want_subtitles, want_thumbnail, want_description
         FROM jobs
         WHERE file_path IS NOT NULL
           AND conversion_status != 'in_progress'
           AND (download_status = 'downloaded' OR conversion_status = 'done')`,
      )
      .all() as any[];
    for (const row of rows) {
      if (row.file_path && existsSync(row.file_path)) continue;
      removeFromArchive(config.archiveFile, row.id);
      db.run(
        `UPDATE jobs SET
           download_status = 'pending', pause_reason = NULL,
           retry_count = 0, resume_count = 0, best_progress = 0, progress = 0,
           file_path = NULL, file_size = 0, integrity = NULL, partial_file_path = NULL,
           conversion_status = CASE WHEN conversion_status = 'not_needed' THEN 'not_needed' ELSE 'pending' END,
           metadata_status = CASE
             WHEN COALESCE(want_subtitles,0) + COALESCE(want_thumbnail,0) + COALESCE(want_description,0) > 0 THEN 'pending'
             ELSE metadata_status END,
           download_claimed_by = NULL, conversion_claimed_by = NULL,
           last_error = 'file missing on startup — re-queued',
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.id],
      );
      fixed++;
      logError("reconcile", `${row.id}: file gone (${row.file_path}) — re-queued`);
    }
    if (fixed > 0) {
      console.log(`🔍 Startup check: ${fixed} downloaded file(s) missing — re-queued for download.`);
    }
  } catch (e: any) {
    logError("reconcile", String(e?.message || e));
  }
  return fixed;
}

/**
 * Sweep: keep watching `cookiesFile` for the whole run.
 *
 * Cookies are not a startup-only concern. Operators export cookies.txt from the
 * browser *after* the engine is already running (or replace it when it expires),
 * and the download attempts must start using it without a restart. Returns the
 * transition so tests can assert on it; null means nothing changed.
 */
export function cookiesWatch(config: Config): CookiesChange {
  const { change, state } = detectCookiesChange(config);
  if (!change) return null;
  if (change === "appeared" || change === "updated") {
    // Jobs parked by a credential-shaped permanent error are the ones this
    // unblocks. They are NOT auto-requeued — permanent failures never are —
    // but the operator is told exactly how many the new cookies may rescue.
    const blocked =
      (
        db
          .query(
            `SELECT COUNT(*) AS n FROM jobs
              WHERE download_status = 'failed'
                AND (lower(COALESCE(last_error, '')) LIKE '%login%'
                  OR lower(COALESCE(last_error, '')) LIKE '%sign in%'
                  OR lower(COALESCE(last_error, '')) LIKE '%age%'
                  OR lower(COALESCE(last_error, '')) LIKE '%cookie%')`,
          )
          .get() as any
      )?.n || 0;
    console.log(
      `🍪 cookies.txt ${change === "appeared" ? "found" : "changed"} (${state.size} bytes) — the next download attempt will use it.`,
    );
    if (blocked > 0) {
      console.log(
        `   ${blocked} failed job(s) look credential-related — use each job's manual Retry action to spend the new cookies on it.`,
      );
    }
    logError(
      "cookies",
      `cookies.txt ${change} (${state.size} bytes) at ${state.file}; ${blocked} job(s) parked with a credential-style error`,
    );
  } else {
    console.warn(
      "⚠️ cookies.txt disappeared — continuing without cookies; age-gated/private/member-only videos will now fail.",
    );
    logError("cookies", `cookies.txt disappeared (${state.file}) — continuing without cookies`);
  }
  return change;
}

export interface RequeueResult {
  downloads: number;
  conversions: number;
  metadata: number;
}

/**
 * Re-queue failed jobs once they have cooled down for
 * `requeueFailedAfterMinutes`. Permanent download failures (private, removed,
 * age-gated, geo-blocked, dead URLs) are never retried. A cooldown starts a
 * fresh retry window for each stage; the worker's per-video cap still bounds
 * each burst of immediate retries, while a later sweep can recover from a
 * longer outage without operator intervention.
 *
 * Pass `ignoreCooldown: true` (used by the "Requeue all failed" web button) to
 * retry every eligible job immediately.
 */
export function requeueFailedJobs(config: Config, opts: { ignoreCooldown?: boolean } = {}): RequeueResult {
  const result: RequeueResult = { downloads: 0, conversions: 0, metadata: 0 };
  const ignoreCooldown = !!opts.ignoreCooldown;
  if (!ignoreCooldown && config.requeueFailedAfterMinutes <= 0) return result;
  // SQLite modifier built only from a validated integer — never user text.
  // With ignoreCooldown there is no age filter at all (a `-0 minutes` modifier
  // would still exclude rows whose updated_at falls in the current second).
  const modifier = ignoreCooldown ? "" : `AND updated_at < datetime('now', '-${Math.floor(config.requeueFailedAfterMinutes)} minutes')`;

  try {
    // --- Downloads -----------------------------------------------------------
    const failedDownloads = db
      .query(
        `SELECT id, last_error FROM jobs
         WHERE download_status = 'failed' ${modifier}`,
      )
      .all() as any[];
    for (const row of failedDownloads) {
      if (isPermanentDownloadError(row.last_error)) continue;
      // Scheduling a retry is not itself a failed attempt. Reset the current
      // no-progress budget here; the next worker outcome is what spends it.
      db.run(
        `UPDATE jobs SET download_status = 'pending', retry_count = 0, pause_reason = NULL,
           download_claimed_by = NULL, download_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [row.id],
      );
      result.downloads++;
    }

    // --- Conversions -----------------------------------------------------------
    const failedConversions = db
      .query(
        `SELECT id FROM jobs
         WHERE conversion_status = 'failed' ${modifier}`,
      )
      .all() as any[];
    for (const row of failedConversions) {
      db.run(
        `UPDATE jobs SET conversion_status = 'pending', conversion_retry_count = 0,
           conversion_claimed_by = NULL, conversion_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [row.id],
      );
      result.conversions++;
    }

    // --- Metadata -------------------------------------------------------------
    const failedMetadata = db
      .query(
        `SELECT id, file_path FROM jobs
         WHERE metadata_status = 'failed' ${modifier}`,
      )
      .all() as any[];
    for (const row of failedMetadata) {
      // Without the media file the metadata fetch can never succeed.
      if (!row.file_path || !existsSync(row.file_path)) continue;
      db.run(
        `UPDATE jobs SET metadata_status = 'pending', metadata_retry_count = 0,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [row.id],
      );
      result.metadata++;
    }

    const total = result.downloads + result.conversions + result.metadata;
    if (total > 0) {
      console.log(
        `♻️ Re-queued ${result.downloads} download(s), ${result.conversions} conversion(s), ${result.metadata} metadata job(s) after cooldown.`,
      );
    }
  } catch (e: any) {
    logError("requeue", String(e?.message || e));
  }
  return result;
}

/**
 * Suffix aria2c appends to a partial file to store its resume state.
 *
 * aria2 keeps a *control file* next to every in-progress download — "its
 * filename is the filename of downloading file with .aria2 appended" — holding
 * which pieces arrived and how far the transfer got. yt-dlp's native
 * downloader has no equivalent, so this only exists when `useAria2c` picked
 * aria2c as the downloader.
 */
export const ARIA2_CONTROL_SUFFIX = ".aria2";

/** A partial download plus every sidecar that must travel with it. */
export function partialSidecars(partialPath: string): string[] {
  return [partialPath, `${partialPath}${ARIA2_CONTROL_SUFFIX}`];
}

/** What `removePartialFiles` actually managed to do. */
export interface PartialRemovalResult {
  /** The `.aria2` control file no longer exists. */
  controlRemoved: boolean;
  /** The `.part` data file no longer exists. */
  dataRemoved: boolean;
  /**
   * True when removal had to abort because the control file is locked (still
   * held open by another process). Neither file may have been touched:
   * deleting the data file in this state would strand the control file and
   * wedge aria2c permanently (see above).
   */
  fatal: boolean;
  /** The path and reason of the failure, when fatal. */
  error?: string;
}

/**
 * Delete a partial download and everything that belongs to it.
 *
 * The pairing is load-bearing, not tidiness. aria2c defaults to
 * `--allow-overwrite=false`, whose documented behaviour is: *"if a file
 * already exists but the corresponding control file doesn't exist, then aria2
 * will not re-download the file."* So deleting the `.part` while stranding the
 * `.aria2` leaves aria2c holding a control file for data that is gone — it can
 * neither resume nor restart, and the job wedges and retries forever. (Exit
 * status 10, *"piece length was different from one in .aria2 control file"*,
 * is the other way this bites.)
 *
 * The control file is therefore removed FIRST, and a locked control file
 * aborts the whole removal: on Windows an orphaned aria2c or an antivirus scan
 * can hold the handle for a while, and blindly unlinking in either order can
 * produce exactly the stranded-control-file state above. The order also bounds
 * the damage of a half-finished cleanup: data-without-control merely restarts
 * the transfer, control-without-data wedges it. Callers that must restart a
 * transfer from scratch should check `.fatal` and retry later instead.
 */
export async function removePartialFiles(partialPath: string): Promise<PartialRemovalResult> {
  const controlPath = `${partialPath}${ARIA2_CONTROL_SUFFIX}`;
  let controlRemoved = false;
  try {
    await unlink(controlPath);
    controlRemoved = true;
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      // Locked or otherwise undeletable — do NOT touch the data file.
      return {
        controlRemoved,
        dataRemoved: false,
        fatal: true,
        error: `${controlPath}: ${e?.code || e?.message || e}`,
      };
    }
  }
  let dataRemoved = false;
  try {
    await unlink(partialPath);
    dataRemoved = true;
  } catch {
    // Data file locked but control gone: the next attempt restarts from
    // scratch — annoying, not fatal.
  }
  return { controlRemoved, dataRemoved, fatal: false };
}

/**
 * Locate the in-progress download for a base filename: the `.part` file
 * (progressive and DASH both land here) or the `.ytdl` fragment directory.
 * Returns the newest match, or "" when there is nothing to resume.
 *
 * Note this deliberately matches only the data file: an aria2c control file on
 * its own is not resumable state, it is litter (see `removePartialFiles`).
 */
export async function findPartialFile(dir: string, baseFilename: string): Promise<string> {
  try {
    const files = await readdir(dir);
    const matches: { path: string; mtime: number }[] = [];
    for (const f of files) {
      if (!f.startsWith(baseFilename + ".")) continue;
      if (!f.endsWith(".part") && !f.endsWith(".ytdl")) continue;
      const s = await stat(join(dir, f)).catch(() => null);
      if (s) matches.push({ path: join(dir, f), mtime: s.mtimeMs });
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    // Absolute: the engine, the dashboard, and any post-mortem reader all need
    // to resolve this regardless of their own working directory.
    return matches[0] ? resolve(matches[0].path) : "";
  } catch {
    return "";
  }
}

/**
 * Synchronous sibling of `findPartialFile`, for paths that cannot await
 * (the shutdown handler and the worker's pause path run outside any async
 * context).
 */
export function findPartialFileSync(dir: string, baseFilename: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return "";
  }
  let best = "";
  let bestMtime = -1;
  for (const f of entries) {
    if (!f.startsWith(baseFilename + ".")) continue;
    if (!f.endsWith(".part") && !f.endsWith(".ytdl")) continue;
    const full = join(dir, f);
    let mtime: number;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = full;
    }
  }
  return best ? resolve(best) : "";
}

/**
 * Remember where each in-flight download's `.part` lives before the job stops
 * being "downloading".
 *
 * Without this, a graceful shutdown or a reaped stale claim leaves the job
 * paused+interrupted with `partial_file_path = NULL` even though the partial is
 * sitting right there on disk. The next attempt then restarts the video from
 * scratch, and the dashboard reports no resumable partial — the resume the
 * sweep promises never actually happens. Synchronous so it can run from the
 * shutdown path and from `reapStaleClaims` before the status is flipped.
 */
export function recordPartialPaths(): number {
  const rows = db
    .query(
      `SELECT id, "index", title, output_directory, partial_file_path FROM jobs
       WHERE download_status = 'downloading' AND partial_file_path IS NULL`,
    )
    .all() as any[];
  let recorded = 0;
  for (const r of rows) {
    if (recordJobPartial(r)) recorded++;
  }
  return recorded;
}

/**
 * Record a single job's on-disk partial, if it has one. Returns the path, or
 * "" when there is nothing to resume.
 *
 * Used by the bulk sweep above and by the download worker's pause path, which
 * parks an in-flight job as 'paused' — without this the partial on disk is
 * orphaned from the job and the next attempt restarts the video from zero.
 */
export function recordJobPartial(
  job: Pick<Job, "id" | "index" | "title" | "output_directory">,
): string {
  const partial = findPartialFileSync(job.output_directory || ".", jobBaseFilename(job));
  if (partial) {
    db.run(`UPDATE jobs SET partial_file_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      partial,
      job.id,
    ]);
  }
  return partial;
}

/**
 * Housekeeping for leftover partial downloads at startup:
 *   • a .part belonging to a FAILED job whose immediate retry window is spent
 *     is deleted when cooldown requeue is disabled; any partial older than a
 *     week is deleted
 *   • orphan .part files with no matching job (DB reset, manual cleanup) are
 *     deleted once they are a day old
 *   • everything else — including in-flight downloads from a previous run and
 *     resume-able partials of failed jobs waiting for cooldown — is kept so
 *     `--continue` can pick up exactly where the download stopped
 *
 * Deleting a partial also deletes its aria2c control file, and control files
 * whose data file is gone are swept on their own — a stranded `.aria2` makes
 * aria2c refuse to restart the transfer (see `removePartialFiles`).
 */
export async function cleanOrphanedFiles(rootDir: string, config?: Config): Promise<void> {
  try {
    const cap = config ? perVideoCap(config) : 0;
    const rows = db
      .query("SELECT partial_file_path, download_status, retry_count, last_error FROM jobs WHERE partial_file_path IS NOT NULL")
      .all() as any[];
    const owners = new Map<string, { status: string; retries: number; lastError: string | null }>();
    for (const r of rows) {
      if (r.partial_file_path) {
        owners.set(r.partial_file_path, {
          status: r.download_status,
          retries: r.retry_count || 0,
          lastError: r.last_error || null,
        });
      }
    }

    const files = await readdir(rootDir, { recursive: true });
    let removed = 0;
    for (const file of files) {
      if (!file.endsWith(".part") && !file.endsWith(".ytdl")) continue;
      const fullPath = join(rootDir, file);
      const s = await stat(fullPath).catch(() => null);
      if (!s) continue;
      const ageMs = Date.now() - s.mtimeMs;
      const owner = owners.get(fullPath);
      if (owner) {
        const waitingForCooldownRetry =
          owner.status === "failed" &&
          !!config &&
          config.requeueFailedAfterMinutes > 0 &&
          !isPermanentDownloadError(owner.lastError);
        const exhausted = owner.status === "failed" && cap > 0 && owner.retries >= cap && !waitingForCooldownRetry;
        const ancient = ageMs > 7 * 24 * 60 * 60 * 1000;
        if (exhausted || ancient) {
          // Take the aria2c control file with it, or the next attempt wedges.
          await removePartialFiles(fullPath);
          removed++;
        }
      } else if (ageMs > 24 * 60 * 60 * 1000) {
        // Orphan: no job claims it — safe to clean once it is clearly stale.
        await removePartialFiles(fullPath);
        removed++;
      }
    }

    // Control files whose data file is gone (hand-deleted .part, an interrupted
    // cleanup, a partial removed by an older build). Note a stranded control
    // file is still named "<name>.part.aria2" — the suffix alone says nothing,
    // so the data-file check below is what decides. Pure litter now, and
    // actively harmful: aria2c sees a control file, cannot resume, and with
    // --allow-overwrite=false will not start over.
    for (const file of files) {
      if (!file.endsWith(ARIA2_CONTROL_SUFFIX)) continue;
      const fullPath = join(rootDir, file);
      const s2 = await stat(fullPath).catch(() => null);
      if (!s2) continue;
      // Young enough that a download may just have started writing it.
      if (Date.now() - s2.mtimeMs < 24 * 60 * 60 * 1000) continue;
      // Its data file is still there — this is live resume state, keep it.
      if (existsSync(fullPath.slice(0, -ARIA2_CONTROL_SUFFIX.length))) continue;
      await unlink(fullPath).catch(() => {});
      removed++;
    }

    if (removed > 0) console.log(`🧹 Cleaned ${removed} stale partial file(s).`);
  } catch {}
}
