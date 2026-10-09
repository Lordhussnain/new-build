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

import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { readdir, rm, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  claimColumns,
  db,
  ownsClaim,
  perVideoCap,
  releaseClaimedJob,
  type ClaimRef,
  type ClaimStage,
  type Job,
} from "./db";
import { removeFromArchive } from "./archive";
import { logError } from "./logger";
import { detectCookiesChange, type CookiesChange } from "./tools";
import { isPermanentDownloadError } from "./retry";
import { jobFittedBaseFilename } from "./download-args";
import { activeDownloadJobs } from "./state";
import { holdsEngineLease, readEngineLease, describeEngineLease } from "./lease";
import type { Config } from "./config";

/**
 * Interrupted mid-download jobs become 'paused' + 'interrupted' so they are
 * visible as paused AND automatically re-claimed (resuming where they left
 * off via yt-dlp --continue). User-paused jobs stay held; orphan claims left
 * by older per-job pause requests are cleared without resuming those jobs.
 */
export function reconcileCrashedJobs(): number {
  // The engine lease gates this sweep: it resets EVERY in-flight claim, so it
  // may only run while this process owns `archive.db`. A second engine that
  // skipped the lease would re-queue the live engine's work behind its back —
  // exactly what the port lock prevented for equal-port instances, and never
  // prevented for different-port ones.
  if (!holdsEngineLease()) {
    logError(
      "reconcile",
      `refusing to reconcile crashed jobs: this process does not hold the engine lease (${describeEngineLease(readEngineLease())})`,
    );
    return 0;
  }
  // Persist the on-disk resume point before flipping the status. This is also
  // needed at startup after a hard kill, where the normal shutdown hook never
  // had a chance to run its partial-path freeze.
  const recorded = recordPartialPaths();
  // The claims reset here all belong to the PREVIOUS engine generation: the
  // lease was free or expired when this process took it (bumping `fencing`), so
  // these tokens cannot belong to a live owner of this database. Clearing the
  // token and heartbeat is what fences a stale worker out — its late updates no
  // longer match the row, and the CAS helpers refuse them.
  const stmt = db.run(
    `UPDATE jobs SET
       download_status = CASE WHEN download_status = 'downloading' THEN 'paused' ELSE download_status END,
       pause_reason = CASE WHEN download_status = 'downloading' OR (download_status = 'paused' AND pause_reason IS NULL) THEN 'interrupted' ELSE pause_reason END,
       conversion_status = CASE WHEN conversion_status = 'in_progress' THEN 'pending' ELSE conversion_status END,
       metadata_status = CASE WHEN metadata_status = 'in_progress' THEN 'pending' ELSE metadata_status END,
       download_claimed_by = NULL, download_claimed_at = NULL,
       download_claim_token = NULL, download_heartbeat_at = NULL,
       conversion_claimed_by = NULL, conversion_claimed_at = NULL,
       conversion_claim_token = NULL, conversion_heartbeat_at = NULL,
       metadata_claimed_by = NULL, metadata_claimed_at = NULL,
       metadata_claim_token = NULL, metadata_heartbeat_at = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE download_status = 'downloading'
        OR (download_status = 'paused' AND pause_reason IS NULL)
        OR (download_status = 'paused' AND pause_reason = 'user' AND download_claimed_by IS NOT NULL)
        OR conversion_status = 'in_progress'
        OR metadata_status = 'in_progress'`,
  );
  if (stmt.changes > 0) {
    console.log(
      `🔄 Reconciled ${stmt.changes} interrupted/stale-claim job(s) (${recorded} partial(s) recorded) — interrupted jobs will resume automatically.`,
    );
  }
  return stmt.changes;
}

/**
 * How long a claim's lease may stay un-renewed before `reapStaleClaims` treats
 * its owner as dead and re-queues the job. The download window is never shorter
 * than either the 20-minute baseline or the configured maximum download
 * timeout. Exported so the dashboard and config manager report the exact
 * thresholds enforced by the sweep.
 *
 * These are LEASE-EXPIRY windows: they are measured from the claim's last
 * heartbeat, not from the moment the work started. A download renews its lease
 * on every progress line, and conversion/metadata renew theirs on an interval
 * (`startClaimHeartbeat`), so a live long-running stage never looks stale no
 * matter how long it runs.
 */
export function STALE_CLAIM_THRESHOLDS(config: Pick<Config, "maxDownloadMinutes">) {
  return {
    download: `-${Math.max(20, config.maxDownloadMinutes)} minutes`,
    conversion: "-3 hours",
    metadata: "-15 minutes",
  };
}

/**
 * The one predicate that decides whether a stage's claim lease has expired.
 *
 * `modifier` is a SQLite datetime modifier built from validated numbers (the
 * same strings `STALE_CLAIM_THRESHOLDS` hands to the dashboard). A claim with
 * no heartbeat yet (legacy rows claimed before heartbeats existed, or a test
 * fixture) falls back to its claim timestamp.
 *
 * The sweep AND the dashboard's stale-claims count both go through this, so the
 * panel cannot drift from what the reaper actually does.
 */
export function staleClaimCondition(stage: ClaimStage, modifier: string, alias = ""): string {
  const c = claimColumns(stage);
  const heartbeat = `COALESCE(${alias}${c.heartbeat}, ${alias}${c.at})`;
  return `(${heartbeat} IS NULL OR ${heartbeat} < datetime('now', '${modifier}'))`;
}

/**
 * Reclaim ONE stale claim with a compare-and-swap on the claim token, the way
 * the owner last looked.
 *
 * This is what keeps two reapers (or a reaper racing a live worker's renewal)
 * from double-resetting a job: the update lands only if the row still carries
 * exactly the claim that was seen AND that claim's lease is still expired at
 * update time. A worker that renewed its heartbeat, or a second reaper that
 * already re-queued the job, makes this return false and the caller leaves the
 * row alone.
 *
 * Exported for the tests: the cross-connection races are only observable when
 * the CAS can be driven independently of the sweep loop.
 */
export function reapStaleClaim(
  stage: ClaimStage,
  jobId: string,
  claim: ClaimRef,
  modifier: string,
): boolean {
  const c = claimColumns(stage);
  const setClause =
    stage === "download"
      ? `download_status = 'paused', pause_reason = 'interrupted'`
      : `${c.status} = 'pending'`;
  const extra = `${c.status} = '${c.claimedStatus}' AND ${staleClaimCondition(stage, modifier)}`;
  return releaseClaimedJob(stage, jobId, claim, setClause, [], extra) === 1;
}

/**
 * Periodic safety net: if a worker process/thread dies mid-job the claim can
 * be left behind. A download claim past the config-aware stale threshold is
 * reclaimed only when no worker still owns that job; progress events heartbeat
 * the claim timestamp. Conversion and metadata claims past their thresholds
 * are re-queued.
 */
export interface ReapSummary {
  downloads: number;
  conversions: number;
  metadata: number;
  /** Stranded control files left by dead download workers, swept this tick. */
  stranded: number;
  /** Stranded control files that could not be swept (locked) — retried later. */
  locked: number;
}

export async function reapStaleClaims(config: Config): Promise<ReapSummary> {
  const thresholds = STALE_CLAIM_THRESHOLDS(config);
  const reaped: ReapSummary = { downloads: 0, conversions: 0, metadata: 0, stranded: 0, locked: 0 };
  // Lease-aware: only the engine that owns `archive.db` may reclaim claims. A
  // process without the lease would be guessing about rows it does not own.
  if (!holdsEngineLease()) {
    logError(
      "reaper",
      `skipped: this process does not hold the engine lease (${describeEngineLease(readEngineLease())})`,
    );
    return reaped;
  }
  try {
    // Freeze each in-flight download's `.part` path while the job is still
    // 'downloading' (that is this function's own filter) — otherwise the
    // reclaimed job resumes without a partial and restarts from scratch.
    const recorded = recordPartialPaths();
    const activeJobIds = Array.from(activeDownloadJobs.values());
    const activeJobFilter = activeJobIds.length
      ? `AND id NOT IN (${activeJobIds.map(() => "?").join(", ")})`
      : "";
    // Snapshot the claims about to be reclaimed, TOKEN INCLUDED, so each
    // reclaim below is a CAS against exactly this claim. If the owner renews
    // its lease (or another reaper/worker gets there first) between this SELECT
    // and the UPDATE, the CAS matches nothing and the row is left alone.
    const dlCols = claimColumns("download");
    const staleDownloads = db
      .query(
        `SELECT id, "index", title, output_directory,
                ${dlCols.by} AS claim_by, ${dlCols.token} AS claim_token
           FROM jobs
          WHERE ${dlCols.status} = '${dlCols.claimedStatus}'
            AND ${staleClaimCondition("download", thresholds.download)} ${activeJobFilter}`,
      )
      .all(...activeJobIds) as {
      id: string;
      index: number;
      title: string;
      output_directory: string;
      claim_by: string | null;
      claim_token: string | null;
    }[];
    for (const row of staleDownloads) {
      const claim: ClaimRef = { by: row.claim_by, token: row.claim_token };
      if (!reapStaleClaim("download", row.id, claim, thresholds.download)) continue;
      reaped.downloads++;
      // A reclaimed download whose worker died can leave half a resume pair:
      // the `.aria2` control file with no data file beside it. The next attempt
      // hands that control file to aria2c, which can neither resume (the data
      // is gone) nor start over — the job wedges. Only jobs this tick actually
      // reclaimed are swept, so the stranded files of a live claim stay put. A
      // locked control file is reported and left alone, exactly like the
      // corrupt-partial path: retry on the next tick rather than risk
      // stranding.
      const found = await sweepStrandedControlFiles(row);
      reaped.stranded += found.removed;
      reaped.locked += found.locked;
    }

    const cvCols = claimColumns("conversion");
    const staleConversions = db
      .query(
        `SELECT id, ${cvCols.by} AS claim_by, ${cvCols.token} AS claim_token
           FROM jobs
          WHERE ${cvCols.status} = '${cvCols.claimedStatus}'
            AND ${staleClaimCondition("conversion", thresholds.conversion)}`,
      )
      .all() as { id: string; claim_by: string | null; claim_token: string | null }[];
    for (const row of staleConversions) {
      if (reapStaleClaim("conversion", row.id, { by: row.claim_by, token: row.claim_token }, thresholds.conversion)) {
        reaped.conversions++;
      }
    }

    const mdCols = claimColumns("metadata");
    const staleMetadata = db
      .query(
        `SELECT id, ${mdCols.by} AS claim_by, ${mdCols.token} AS claim_token
           FROM jobs
          WHERE ${mdCols.status} = '${mdCols.claimedStatus}'
            AND ${staleClaimCondition("metadata", thresholds.metadata)}`,
      )
      .all() as { id: string; claim_by: string | null; claim_token: string | null }[];
    for (const row of staleMetadata) {
      if (reapStaleClaim("metadata", row.id, { by: row.claim_by, token: row.claim_token }, thresholds.metadata)) {
        reaped.metadata++;
      }
    }

    const total = reaped.downloads + reaped.conversions + reaped.metadata;
    if (total > 0 || reaped.stranded > 0) {
      console.log(
        `🧟 Reclaimed ${reaped.downloads} stale download(s) (${recorded} partial path(s) recorded, ${reaped.stranded} stranded control file(s) swept), ${reaped.conversions} conversion(s), ${reaped.metadata} metadata job(s).`,
      );
      logError(
        "reaper",
        `reclaimed stale claims: downloads=${reaped.downloads} conversions=${reaped.conversions} metadata=${reaped.metadata}`,
      );
    }
    if (reaped.locked > 0) {
      logError(
        "reaper",
        `${reaped.locked} stranded aria2c control file(s) are locked — kept both files; the next sweep retries`,
      );
    }
  } catch (e: any) {
    logError("reaper", String(e?.message || e));
  }
  return reaped;
}

/**
 * Sweep the stranded half of a reclaimed job's resume pair: an `.aria2` control
 * file whose data file is gone. Returns what happened, so the caller can report
 * a lock and retry later instead of pretending it cleaned something.
 *
 * Never touches a job whose pair is intact — that is live resume state.
 */
export async function sweepStrandedControlFiles(
  job: Pick<Job, "id" | "index" | "title" | "output_directory">,
): Promise<{ removed: number; locked: number }> {
  const result = { removed: 0, locked: 0 };
  const dir = job.output_directory || ".";
  const base = jobFittedBaseFilename(job);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }
  for (const f of entries) {
    if (!f.endsWith(ARIA2_CONTROL_SUFFIX)) continue;
    if (!f.startsWith(base + ".")) continue;
    const controlPath = join(dir, f);
    const dataPath = controlPath.slice(0, -ARIA2_CONTROL_SUFFIX.length);
    if (existsSync(dataPath)) continue; // the pair is intact: resumable state
    // Control file first, data file (already gone) after — the pairing rule.
    const removal = await removePartialFiles(dataPath);
    if (removal.fatal) {
      result.locked++;
      logError(
        "reaper",
        `stranded control file ${controlPath} is locked (${removal.error || "not removable"}) — kept for now, will retry`,
      );
      continue;
    }
    if (removal.controlRemoved) result.removed++;
  }
  return result;
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
           metadata_unavailable = '[]',
           download_claimed_by = NULL, download_claimed_at = NULL,
           download_claim_token = NULL, download_heartbeat_at = NULL,
           conversion_claimed_by = NULL, conversion_claimed_at = NULL,
           conversion_claim_token = NULL, conversion_heartbeat_at = NULL,
           metadata_claimed_by = NULL, metadata_claimed_at = NULL,
           metadata_claim_token = NULL, metadata_heartbeat_at = NULL,
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
 *
 * "Changed" means the CONTENT changed (see `detectCookiesChange`). An extension
 * that re-exports the same bytes on a timer used to log an update every poll —
 * 1440 `error.log` lines a day, which is also what rotated the ~1MB log every
 * few hours and pushed the real failures out of its retained tail.
 */
export function cookiesWatch(config: Config): CookiesChange {
  const { change, state } = detectCookiesChange({
    cookiesFile: config.cookiesFile,
    onUnreadable: (msg) => logError("cookies", msg),
  });
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
           download_claimed_by = NULL, download_claimed_at = NULL,
           download_claim_token = NULL, download_heartbeat_at = NULL,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
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
           conversion_claimed_by = NULL, conversion_claimed_at = NULL,
           conversion_claim_token = NULL, conversion_heartbeat_at = NULL,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [row.id],
      );
      result.conversions++;
    }

    // --- Metadata -------------------------------------------------------------
    const failedMetadata = db
      .query(
        `SELECT id, file_path, last_error FROM jobs
         WHERE metadata_status = 'failed' ${modifier}`,
      )
      .all() as any[];
    for (const row of failedMetadata) {
      // Without the media file or after a permanent source error the metadata
      // fetch cannot succeed. Leave those rows terminal; the per-job sidecar
      // control is the explicit retry path if the operator wants to try again.
      if (!row.file_path || !existsSync(row.file_path) || isPermanentDownloadError(row.last_error)) continue;
      db.run(
        `UPDATE jobs SET metadata_status = 'pending', metadata_retry_count = 0,
           metadata_claimed_by = NULL, metadata_claimed_at = NULL,
           metadata_claim_token = NULL, metadata_heartbeat_at = NULL,
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
  const control = await removeOne(controlPath, { strict: true });
  if (!control.ok) {
    // Locked or otherwise undeletable — do NOT touch the data file.
    return { controlRemoved: false, dataRemoved: false, fatal: true, error: control.error };
  }
  const data = await removeOne(partialPath);
  // Data file locked (or a fragment directory that would not budge) but the
  // control file gone: the next attempt restarts from scratch — annoying, not
  // fatal. The `removed` flag is what tells the caller whether the file is
  // really gone, so a partial that survived is never reported as cleaned.
  return { controlRemoved: control.removed, dataRemoved: data.removed, fatal: false };
}

/**
 * Delete one path, reporting whether anything was actually removed.
 *
 * The control file is removed strictly: it is always a plain file, so any
 * failure to unlink it (EISDIR included) is treated as "locked" and aborts the
 * whole removal, leaving the pair intact for a later retry.
 *
 * The data path is handled more tolerantly, because `.ytdl` resume points are
 * *fragment directories*: `unlink()` refuses them on every platform
 * (EISDIR/EPERM), so a caller that only ever unlinked would silently keep them
 * — and would report the partial as cleaned while the stale fragments were
 * still there for the next attempt to pick up.
 */
async function removeOne(path: string, opts: { strict?: boolean } = {}): Promise<{ removed: boolean; ok: boolean; error?: string }> {
  try {
    await unlink(path);
    return { removed: true, ok: true };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { removed: false, ok: true }; // already gone
    if (!opts.strict) {
      try {
        const s = await stat(path);
        if (s.isDirectory()) {
          await rm(path, { recursive: true, force: true });
          return { removed: true, ok: true };
        }
      } catch {
        return { removed: false, ok: true }; // vanished between unlink and stat
      }
    }
    return { removed: false, ok: false, error: `${path}: ${e?.code || e?.message || e}` };
  }
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
 * The data-file paths of a job's STRANDED aria2c control files: `<base>.<ext>.part.aria2`
 * whose `.part` is gone. `findPartialFile` cannot see these (it matches only the
 * data file), but aria2c treats them exactly like a live pair and refuses to
 * resume or restart while one is present — so a restart-from-scratch path must
 * pass each returned path through `removePartialFiles`, control file first.
 */
export async function findStrandedPartials(dir: string, baseFilename: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    const out: string[] = [];
    for (const f of files) {
      if (!f.startsWith(baseFilename + ".")) continue;
      if (!f.endsWith(`.part${ARIA2_CONTROL_SUFFIX}`)) continue;
      const dataPath = resolve(dir, f.slice(0, -ARIA2_CONTROL_SUFFIX.length));
      if (!existsSync(dataPath)) out.push(dataPath);
    }
    return out;
  } catch {
    return [];
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
 * being "downloading", including legacy user-paused rows that still hold a
 * download claim.
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
       WHERE (download_status = 'downloading'
          OR (download_status = 'paused' AND pause_reason = 'user' AND download_claimed_by IS NOT NULL))
         AND partial_file_path IS NULL`,
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
  // The fitted name, not the raw title: that is the file yt-dlp actually wrote
  // (see jobFittedBaseFilename). Searching with the unfitted name finds
  // nothing for a long title, so no partial path is recorded and the on-disk
  // resume state later looks like an orphan to the sweep.
  const partial = findPartialFileSync(job.output_directory || ".", jobFittedBaseFilename(job));
  if (partial) {
    db.run(`UPDATE jobs SET partial_file_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      partial,
      job.id,
    ]);
  }
  return partial;
}

/**
 * Key for comparing a recorded path against a path built from a directory
 * walk.
 *
 * The two sides come from different places and are not textually equal even
 * when they name the same file: `findPartialFile(Sync)` stores an absolute,
 * `resolve()`d path, while `cleanOrphanedFiles` builds its paths by joining the
 * configured `outputRoot` (`./downloads` by default — relative) with the
 * entries of a recursive `readdir`. Resolving both sides to an absolute path
 * kills that mismatch, and case-folding on Windows (a case-insensitive
 * filesystem) keeps a recorded `C:\Downloads` matching a walked
 * `c:\downloads`.
 */
export function pathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** Age after which an unowned orphan partial is swept, and the same for `.superseded` backups. */
export const ORPHAN_PARTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Age after which a partial nothing will ever resume is considered litter.
 * Only ever applied to non-resumable owners: a partial belonging to a job that
 * is going to be claimed again is never aged out (see the sweep below).
 */
export const PARTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Statuses whose partial the pipeline will still resume, so the sweep must
 * keep it no matter how old it is:
 *   • `pending` / `downloading` — the next claim continues from it
 *   • `paused`                  — the operator holds the job; resuming later
 *     must continue where it stopped, even after weeks
 *   • `waiting_live`            — parked until the stream becomes a VOD
 */
const RESUMABLE_PARTIAL_STATUSES = new Set(["pending", "downloading", "paused", "waiting_live"]);

/**
 * Housekeeping for leftover partial downloads at startup:
 *   • a .part belonging to a FAILED job whose immediate retry window is spent
 *     is deleted when cooldown requeue is disabled; a partial no job will
 *     resume (terminal failure, forgotten row) is deleted once it is a week old
 *   • orphan .part files with no matching job (DB reset, manual cleanup) are
 *     deleted once they are a day old
 *   • orphan `.superseded` backups with no matching job are deleted once they
 *     are a day old — a backup the DB does not reference can never be restored,
 *     so it is a stale duplicate next to a job that re-downloaded over it
 *   • everything else — including in-flight downloads from a previous run and
 *     resume-able partials of failed jobs waiting for cooldown — is kept so
 *     `--continue` can pick up exactly where the download stopped
 *
 * Deleting a partial also deletes its aria2c control file, and control files
 * whose data file is gone are swept on their own — a stranded `.aria2` makes
 * aria2c refuse to restart the transfer (see `removePartialFiles`).
 */
export async function cleanOrphanedFiles(
  rootDir: string,
  config?: Config,
): Promise<{ removed: number; locked: number }> {
  const summary = { removed: 0, locked: 0 };
  try {
    const cap = config ? perVideoCap(config) : 0;
    const rows = db
      .query("SELECT partial_file_path, download_status, retry_count, last_error FROM jobs WHERE partial_file_path IS NOT NULL")
      .all() as any[];
    const owners = new Map<string, { status: string; retries: number; lastError: string | null }>();
    for (const r of rows) {
      if (r.partial_file_path) {
        // Absolute + case-folded: the walk below yields paths relative to a
        // possibly-relative outputRoot, and a raw string compare would miss.
        owners.set(pathKey(r.partial_file_path), {
          status: r.download_status,
          retries: r.retry_count || 0,
          lastError: r.last_error || null,
        });
      }
    }
    // Backups some job still owns (including in-flight re-downloads). The
    // sibling form covers legacy rows only: an older build renamed the file
    // aside before recording the backup, so the sole association left is
    // `<file_path>.superseded` — and only while that `file_path` is itself
    // missing. A sibling next to a live output file is a leftover from a
    // completed re-download and may be swept.
    const supersededOwners = new Set<string>();
    const supersededRows = db
      .query("SELECT superseded_file, file_path FROM jobs WHERE superseded_file IS NOT NULL OR file_path IS NOT NULL")
      .all() as any[];
    for (const r of supersededRows) {
      if (r.superseded_file) supersededOwners.add(pathKey(r.superseded_file));
      if (r.file_path && !existsSync(r.file_path)) {
        supersededOwners.add(pathKey(`${r.file_path}${SUPERSEDED_SUFFIX}`));
      }
    }

    const files = await readdir(rootDir, { recursive: true });
    let removed = 0;
    for (const file of files) {
      const isPartial = file.endsWith(".part") || file.endsWith(".ytdl");
      const isSuperseded = file.endsWith(SUPERSEDED_SUFFIX);
      if (!isPartial && !isSuperseded) continue;
      // `resolve`, not `join`: recursive readdir entries are relative to
      // rootDir, so joining a relative root yields a relative path that never
      // matches the absolute path recorded in the database.
      const fullPath = resolve(rootDir, file);
      const s = await stat(fullPath).catch(() => null);
      if (!s) continue;
      const ageMs = Date.now() - s.mtimeMs;
      if (isSuperseded) {
        if (!supersededOwners.has(pathKey(fullPath)) && ageMs > ORPHAN_PARTIAL_MAX_AGE_MS) {
          await unlink(fullPath).catch(() => {});
          removed++;
        }
        continue;
      }
      const owner = owners.get(pathKey(fullPath));
      if (owner) {
        const waitingForCooldownRetry =
          owner.status === "failed" &&
          !!config &&
          config.requeueFailedAfterMinutes > 0 &&
          !isPermanentDownloadError(owner.lastError);
        const exhausted = owner.status === "failed" && cap > 0 && owner.retries >= cap && !waitingForCooldownRetry;
        // Only partials no attempt will ever resume are aged out. A paused or
        // pending job's resume state must survive indefinitely — deleting it
        // because a week passed silently throws away the download progress the
        // job exists to continue from.
        const abandoned = !RESUMABLE_PARTIAL_STATUSES.has(owner.status) && !waitingForCooldownRetry;
        const ancient = abandoned && ageMs > PARTIAL_MAX_AGE_MS;
        if (exhausted || ancient) {
          // Take the aria2c control file with it, or the next attempt wedges.
          if (await removePartialAndReport(fullPath, summary)) removed++;
        }
      } else if (ageMs > ORPHAN_PARTIAL_MAX_AGE_MS) {
        // Orphan: no job claims it — safe to clean once it is clearly stale.
        if (await removePartialAndReport(fullPath, summary)) removed++;
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
      const fullPath = resolve(rootDir, file);
      const s2 = await stat(fullPath).catch(() => null);
      if (!s2) continue;
      // Young enough that a download may just have started writing it.
      if (Date.now() - s2.mtimeMs < ORPHAN_PARTIAL_MAX_AGE_MS) continue;
      // Its data file is still there — this is live resume state, keep it.
      const dataPath = fullPath.slice(0, -ARIA2_CONTROL_SUFFIX.length);
      if (existsSync(dataPath)) continue;
      // Through the one pair-removal contract (control file first, strict), not
      // a bare unlink: the data path is already gone, so this removes only the
      // control file, and a lock is reported as one rather than counted removed.
      const removal = await removePartialFiles(dataPath);
      if (removal.fatal) {
        // Locked (an orphaned aria2c, an antivirus scan). Litter that will
        // not move is not a failure of the engine, but it must not be
        // reported as removed either — the next startup sweep retries it.
        summary.locked++;
        logError(
          "reconcile",
          `stranded control file ${fullPath} is locked (${removal.error || "unknown"}) — left in place, will retry on the next sweep`,
        );
      } else if (removal.controlRemoved) {
        removed++;
      }
    }

    summary.removed = removed;
    if (removed > 0 || summary.locked > 0) {
      console.log(
        `🧹 Cleaned ${removed} stale partial/backup file(s).` +
          (summary.locked > 0 ? ` ${summary.locked} locked file(s) left for a later sweep.` : ""),
      );
    }
  } catch (e: any) {
    logError("reconcile", String(e?.message || e));
  }
  return summary;
}

/**
 * Remove a stale partial and say whether the DATA file is really gone.
 *
 * `removePartialFiles` refuses to touch the data file while the control file
 * cannot be removed (that pairing is what keeps aria2c restartable), and it
 * reports that refusal as `.fatal`. Counting it as a removal anyway is how the
 * sweep's "🧹 Cleaned N stale partial file(s)" line lied about locked files
 * that were still on disk — and how a wedged aria2c could go unnoticed. A
 * locked pair keeps BOTH files and is retried by the next sweep (the startup
 * sweep for a manual lock, the reaper for a stranded control file).
 */
async function removePartialAndReport(
  partialPath: string,
  summary: { removed: number; locked: number },
): Promise<boolean> {
  const result = await removePartialFiles(partialPath);
  if (result.fatal) {
    summary.locked++;
    logError(
      "reconcile",
      `partial ${partialPath} is locked (${result.error || "control file not removable"}) — kept both files, will retry later`,
    );
    return false;
  }
  if (!result.dataRemoved) {
    // Control gone, data still there (locked file, or a directory that would
    // not budge). aria2c can restart now — that was the point of the deletion —
    // but the file itself is still on disk, so it is not "cleaned".
    summary.locked++;
    logError("reconcile", `partial ${partialPath} could not be deleted — the next attempt restarts instead of resuming`);
    return false;
  }
  return true;
}

// --- Superseded media files (deliberate re-downloads) ------------------------
// Retrying an already-downloaded job from the dashboard — the usual case being
// a new multi-audio track selection that needs a fresh download — must not
// delete the existing file up front: the re-download can still fail, and the
// engine's core rule is to never throw away work that has already been done.
// Instead the old media file is renamed aside (`.superseded`), which also
// frees the output path: yt-dlp refuses to re-download while the target file
// exists (`--no-overwrites`) and `--download-archive` must be scrubbed by the
// caller. The new download deletes the backup on success
// (`dropSupersededFile`); a permanent re-download failure restores it
// (`restoreSupersededFile`).
//
// The hand-off is ordered so a crash at ANY point is recoverable: the DB row
// is rewritten first (backup recorded, `file_path` cleared) and only then is
// the file renamed. The in-between state — a recorded backup whose file was
// never moved — is rolled back by `reconcileSupersededFiles()` at the next
// startup, so the media can never end up sitting at `<path>.superseded` with
// no row that knows about it.

export const SUPERSEDED_SUFFIX = ".superseded";

/**
 * Move a downloaded job's media file aside so a re-download gets a free
 * output path. Clears `file_path` (it no longer exists) and records the
 * backup in `superseded_file` BEFORE the rename, so the database and the
 * filesystem can never disagree about where the file went. Returns the backup
 * path, or null when the job had no file on disk to protect. Throws when an
 * existing file cannot be renamed — the caller should refuse the retry rather
 * than start a download that yt-dlp will skip against the still-present file,
 * and the row is put back so the job still looks downloaded.
 */
export function stashDownloadedFile(jobId: string, filePath: string | null): string | null {
  if (!filePath) return null;
  const backup = `${filePath}${SUPERSEDED_SUFFIX}`;
  if (!existsSync(filePath)) {
    // The original is already gone. If a backup for the same path survives
    // (a previous stash whose caller never got to record it — see
    // reconcileSupersededFiles), adopt it: the file is still worth protecting.
    if (existsSync(backup)) {
      db.run(
        `UPDATE jobs SET file_path = NULL, file_size = 0, superseded_file = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [backup, jobId],
      );
      return backup;
    }
    // DB says downloaded but the file is already gone — nothing to protect.
    db.run(
      `UPDATE jobs SET file_path = NULL, file_size = 0, superseded_file = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [jobId],
    );
    return null;
  }
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {}
  // Record the intent BEFORE the filesystem rename. If the process dies
  // between the two steps the database still knows where the file went, and
  // `reconcileSupersededFiles` completes or rolls back the hand-off at the
  // next startup. The reverse order (rename first, record after) is the bug
  // this replaces: a crash in that window left the media at
  // `<path>.superseded` with no row pointing at it, so the re-queue looked
  // exactly like a deleted download and the backup was never managed again.
  db.run(
    `UPDATE jobs SET file_path = NULL, file_size = 0, superseded_file = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [backup, jobId],
  );
  try {
    renameSync(filePath, backup);
  } catch (err: any) {
    // Put the row back exactly as it was: the caller aborts the retry (500),
    // so the job must still look downloaded with its file in place.
    db.run(
      `UPDATE jobs SET file_path = ?, file_size = ?, superseded_file = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [filePath, size, jobId],
    );
    throw new Error(`could not move the previous file aside (${filePath}): ${err?.message || err}`);
  }
  return backup;
}

/**
 * The re-download succeeded — the backup of the previous file is no longer
 * needed. Safe to call for jobs without a backup (no-op).
 */
export function dropSupersededFile(jobId: string): void {
  const row = db.query("SELECT superseded_file FROM jobs WHERE id = ?").get(jobId) as
    | { superseded_file: string | null }
    | null;
  const backup = row?.superseded_file || null;
  db.run(`UPDATE jobs SET superseded_file = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [jobId]);
  if (!backup) return;
  try {
    unlinkSync(backup);
  } catch {
    // Leftover backup is litter, not an error — the new file is in place.
  }
}

/**
 * The re-download failed permanently — put the previous file back and mark
 * the job downloaded again, so the operator keeps exactly what was archived
 * before the retry. Returns false when there was nothing to restore.
 *
 * `claim` is the download claim the caller still believes it holds (the worker
 * passes its claim; the startup sweeps pass none). When given, ownership is
 * verified BEFORE the file is moved and the row update is a CAS on the claim
 * token, so a worker whose claim was reclaimed cannot restore an old file over
 * the new owner's work.
 */
export function restoreSupersededFile(jobId: string, reason: string, claim?: ClaimRef): boolean {
  if (claim && !ownsClaim("download", jobId, claim)) {
    logError("reconcile", `${jobId}: refusing to restore the superseded backup — the download claim was lost`);
    return false;
  }
  const row = db
    .query(
      `SELECT superseded_file, COALESCE(want_subtitles,0) + COALESCE(want_thumbnail,0) + COALESCE(want_description,0) AS wants
       FROM jobs WHERE id = ?`,
    )
    .get(jobId) as { superseded_file: string | null; wants: number } | null;
  const backup = row?.superseded_file || null;
  if (!row || !backup || !backup.endsWith(SUPERSEDED_SUFFIX)) return false;
  if (!existsSync(backup)) {
    db.run(`UPDATE jobs SET superseded_file = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [jobId]);
    return false;
  }
  const original = backup.slice(0, -SUPERSEDED_SUFFIX.length);
  try {
    renameSync(backup, original);
  } catch (err: any) {
    logError("reconcile", `${jobId} could not restore superseded file ${backup}: ${err?.message || err}`);
    return false;
  }
  let size = 0;
  try {
    size = statSync(original).size;
  } catch {}
  // The restored file is the previous pipeline OUTPUT (already converted and
  // in its final location), so conversion is not needed again; sidecars are
  // re-fetched lazily if any are wanted.
  const setClause = `file_path = ?, file_size = ?, superseded_file = NULL,
       download_status = 'downloaded', progress = 100, best_progress = 100,
       partial_file_path = NULL, retry_count = 0, resume_count = 0,
       conversion_status = 'not_needed',
       metadata_status = CASE WHEN ? > 0 THEN 'pending' ELSE 'not_needed' END,
       last_error = ?`;
  const params = [original, size, row.wants, reason] as unknown[];
  if (claim) {
    if (releaseClaimedJob("download", jobId, claim, setClause, params) !== 1) {
      logError("reconcile", `${jobId}: superseded backup restored but the download claim was lost before recording it`);
      return false;
    }
    return true;
  }
  db.run(
    `UPDATE jobs SET ${setClause},
       download_claimed_by = NULL, download_claimed_at = NULL,
       download_claim_token = NULL, download_heartbeat_at = NULL,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...params, jobId] as any,
  );
  return true;
}

/** What `reconcileSupersededFiles` did at startup. */
export interface SupersededReconcileResult {
  /** Interrupted stashes rolled back: the media is back at its output path. */
  restored: number;
  /** Backups deleted because the re-download they guarded already finished. */
  dropped: number;
  /** Stale `superseded_file` pointers forgotten (nothing left to protect). */
  cleared: number;
}

/**
 * Startup recovery for the `.superseded` hand-off.
 *
 * `stashDownloadedFile` records the backup in the DB before it renames the
 * file, so a crash can leave exactly one recoverable in-between state:
 *
 *   • `superseded_file` set, backup NOT on disk, original still in place —
 *     the rename never ran (or a `renameSync` rollback raced a crash). The row
 *     is put back to "downloaded with its file", so the job is never re-queued
 *     against a file that vanished from the DB's point of view and the old
 *     media is not left unmanaged.
 *
 * Two further states are healed so no backup is ever stranded:
 *
 *   • `superseded_file` set, backup on disk, but the backup belongs to a job
 *     that is still "downloaded" and has no current file — the retry never
 *     became claimable (the crash landed between the stash and the status
 *     update). Rolling the file back restores the exact pre-click state; the
 *     operator can retry again, and nothing re-downloads behind their back.
 *   • `superseded_file` set, backup on disk, and `file_path` already points at
 *     an existing file — the re-download succeeded but the crash hit between
 *     `recordSuccess()` and `dropSupersededFile()`. The new file is the
 *     archive's copy; the backup is deleted.
 *
 * The older, rename-first ordering could also leave the opposite signature —
 * no `superseded_file` recorded, `file_path` pointing at a file that is not
 * there, sitting next to its `.superseded` sibling. Those rows are adopted:
 * the backup is put back where `file_path` says it belongs, so a previous
 * build's crash window cannot turn into a pointless re-download (or a file
 * that is never managed again).
 *
 * Runs before `reconcileMissingFiles`, which would otherwise read the missing
 * `file_path` as "deleted by hand" and re-queue the video.
 */
export function reconcileSupersededFiles(): SupersededReconcileResult {
  const result: SupersededReconcileResult = { restored: 0, dropped: 0, cleared: 0 };
  try {
    const rows = db
      .query(
        `SELECT id, file_path, superseded_file, download_status FROM jobs
          WHERE superseded_file IS NOT NULL OR file_path IS NOT NULL`,
      )
      .all() as any[];
    for (const row of rows) {
      const backup: string | null = row.superseded_file || null;
      const currentFile: string | null = row.file_path && existsSync(row.file_path) ? row.file_path : null;

      if (backup && backup.endsWith(SUPERSEDED_SUFFIX)) {
        const original = backup.slice(0, -SUPERSEDED_SUFFIX.length);
        if (existsSync(backup)) {
          if (currentFile) {
            // The re-download finished; only the backup's deletion was lost.
            db.run(`UPDATE jobs SET superseded_file = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
            try {
              unlinkSync(backup);
            } catch {}
            result.dropped++;
          } else if (row.download_status === "downloaded") {
            // The retry was never queued: the job still claims to be finished
            // but its file is the backup. Put it back — the pre-click state.
            if (restoreStashedMedia(row.id, backup, original)) result.restored++;
          }
          // Otherwise the queued/in-flight re-download owns the backup: keep.
          continue;
        }
        if (!currentFile && existsSync(original)) {
          // The intent was recorded but the rename never ran (or a
          // renameSync rollback raced the crash): the file is exactly where
          // the pre-stash row expects it. Put the row back — no filesystem
          // work, nothing to rename.
          rollBackStash(row.id, original);
          result.restored++;
          continue;
        }
        // Nothing on disk to protect any more (backup deleted by hand, or the
        // whole file is gone) — forget the pointer; `reconcileMissingFiles`
        // and the sweep own the rest.
        db.run(`UPDATE jobs SET superseded_file = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
        result.cleared++;
        continue;
      }

      // Legacy rename-first crash window: no pointer was recorded, the DB's
      // file_path names a file that is not there, and the `.superseded` sibling
      // is what the interrupted retry left behind.
      if (!backup && row.file_path && !currentFile) {
        const legacyBackup = `${row.file_path}${SUPERSEDED_SUFFIX}`;
        if (existsSync(legacyBackup) && row.download_status === "downloaded") {
          if (restoreStashedMedia(row.id, legacyBackup, row.file_path)) result.restored++;
        }
      }
    }
    if (result.restored + result.dropped + result.cleared > 0) {
      console.log(
        `🧷 Superseded-file recovery: ${result.restored} restored, ${result.dropped} backup(s) dropped, ${result.cleared} stale pointer(s) cleared.`,
      );
    }
  } catch (e: any) {
    logError("reconcile", `superseded recovery: ${e?.message || e}`);
  }
  return result;
}

/**
 * Forget the interrupted stash in the database only: the media never left its
 * output path, so re-point `file_path` at it and drop the backup pointer.
 */
function rollBackStash(jobId: string, original: string): void {
  let size = 0;
  try {
    size = statSync(original).size;
  } catch {}
  db.run(
    `UPDATE jobs SET file_path = ?, file_size = ?, superseded_file = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [original, size, jobId],
  );
}

/**
 * Move a `.superseded` backup back to `original` and make the job row describe
 * it again (downloaded, file present, no backup). Used when a re-download
 * never got off the ground, so the archive keeps exactly what it had. Returns
 * false (and logs) when the rename fails — the backup is then left for the
 * next startup and the orphan sweep will not touch it, because the row still
 * references it.
 */
function restoreStashedMedia(jobId: string, backup: string, original: string): boolean {
  // Never clobber a file that appeared at the output path in the meantime.
  if (existsSync(original)) {
    db.run(`UPDATE jobs SET superseded_file = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [jobId]);
    logError(
      "reconcile",
      `${jobId}: both ${original} and its backup ${backup} exist — keeping the output file and forgetting the backup`,
    );
    return false;
  }
  try {
    renameSync(backup, original);
  } catch (err: any) {
    logError("reconcile", `${jobId} could not restore ${backup}: ${err?.message || err}`);
    return false;
  }
  rollBackStash(jobId, original);
  return true;
}
