// src/db.ts — SQLite job database: schema, migrations, atomic job claims.
//
// Every stage transition (claim, complete, fail) goes through here so the
// worker pools stay crash-safe: claims are single atomic UPDATE … RETURNING
// statements, so two workers can never grab the same video.

import { Database } from "bun:sqlite";
import type { Config } from "./config";

export interface Job {
  id: string;
  url: string;
  title: string;
  output_directory: string;
  target_format: string;
  want_subtitles: number;
  want_thumbnail: number;
  want_description: number;
  download_status: string;
  conversion_status: string;
  metadata_status: string;
  pause_reason: string | null;
  metadata_retry_count: number;
  metadata_files: string | null;
  download_claimed_by: string | null;
  download_claimed_at: string | null;
  conversion_claimed_by: string | null;
  conversion_claimed_at: string | null;
  partial_file_path: string | null;
  retry_count: number;
  conversion_retry_count: number;
  resume_count: number;
  best_progress: number;
  last_error: string | null;
  /** JSON array of discovered AudioTracks (null = not probed yet). */
  audio_tracks: string | null;
  /** JSON array of selected language codes (null = follow global mode). */
  audio_selection: string | null;
  /**
   * Backup of the previous media file while a deliberate re-download runs
   * (dashboard "Retry job" on a downloaded video). Deleted once the new
   * download succeeds; restored if the re-download fails permanently.
   */
  superseded_file: string | null;
  folder: string;
  index: number;
  duration: number | null;
  file_path: string | null;
  file_size: number;
  integrity: string | null;
  progress: number;
  speed: number;
  eta: number;
  created_at: string;
  updated_at: string;
}

// Live binding: reassigned by initDatabase(), read by every other module.
export let db: Database;

export type ClaimJobFn = (workerId: string) => Job | null;
export let claimDownloadJob: ClaimJobFn;
export let claimConvertJob: ClaimJobFn;
export let claimMetadataJob: ClaimJobFn;

// Add a column to an existing table if an older database doesn't have it yet.
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function initDatabase(path: string = "archive.db"): void {
  db = new Database(path);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run(
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      url TEXT,
      title TEXT,
      output_directory TEXT,
      target_format TEXT,
      want_subtitles INTEGER DEFAULT 0,
      want_thumbnail INTEGER DEFAULT 0,
      want_description INTEGER DEFAULT 0,
      download_status TEXT DEFAULT 'pending',
      conversion_status TEXT DEFAULT 'pending',
      metadata_status TEXT DEFAULT 'not_needed',
      metadata_files TEXT,
      pause_reason TEXT,
      metadata_retry_count INTEGER DEFAULT 0,
      download_claimed_by TEXT,
      download_claimed_at TEXT,
      conversion_claimed_by TEXT,
      conversion_claimed_at TEXT,
      partial_file_path TEXT,
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      folder TEXT,
      "index" INTEGER,
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      integrity TEXT,
      progress REAL DEFAULT 0,
      speed REAL DEFAULT 0,
      eta REAL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  // Track which configured source discovered each video. Jobs are globally
  // deduplicated by video id, so this many-to-many table lets source removal
  // delete jobs that belong only to that source while preserving shared videos.
  db.run(
    `CREATE TABLE IF NOT EXISTS job_sources (
       source_url TEXT NOT NULL,
       job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
       created_at TEXT DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (source_url, job_id)
     )`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_job_sources_job ON job_sources(job_id)`);
  db.run(
    `CREATE TABLE IF NOT EXISTS playlist_state (
       folder TEXT PRIMARY KEY,
       next_index INTEGER NOT NULL DEFAULT 0
     )`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS run_history (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       started_at TEXT,
       ended_at TEXT,
       duration_seconds REAL,
       downloaded INTEGER,
       skipped INTEGER,
       failed INTEGER,
       total_queued INTEGER
     )`,
  );

  // Schema migrations for databases created by older versions.
  ensureColumn("jobs", "metadata_status", "metadata_status TEXT DEFAULT 'not_needed'");
  ensureColumn("jobs", "metadata_files", "metadata_files TEXT");
  ensureColumn("jobs", "pause_reason", "pause_reason TEXT");
  ensureColumn("jobs", "metadata_retry_count", "metadata_retry_count INTEGER DEFAULT 0");
  // Reliability & resume columns.
  ensureColumn("jobs", "conversion_retry_count", "conversion_retry_count INTEGER DEFAULT 0");
  ensureColumn("jobs", "resume_count", "resume_count INTEGER DEFAULT 0");
  ensureColumn("jobs", "best_progress", "best_progress REAL DEFAULT 0");
  ensureColumn("jobs", "duration", "duration REAL");
  // Multi-audio tracks (YouTube multi-language audio): what the video offers,
  // and which languages the user picked for this specific job.
  ensureColumn("jobs", "audio_tracks", "audio_tracks TEXT");
  ensureColumn("jobs", "audio_selection", "audio_selection TEXT");
  // Re-download safety net: the previous media file, moved aside while a
  // manual retry re-fetches the video (see reconcile.ts superseded helpers).
  ensureColumn("jobs", "superseded_file", "superseded_file TEXT");
  db.run(
    `UPDATE jobs SET metadata_status = CASE
       WHEN COALESCE(want_subtitles,0) + COALESCE(want_thumbnail,0) + COALESCE(want_description,0) > 0 THEN 'pending'
       ELSE 'not_needed' END
     WHERE metadata_status IS NULL OR metadata_status = ''`,
  );

  // Claim queries filter on status and order by created_at — without these
  // indexes every worker polls the whole table on every loop iteration.
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_dl_status ON jobs(download_status, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_cv_status ON jobs(conversion_status, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_md_status ON jobs(metadata_status, created_at)`);

  // Claim transactions MUST be created here, after `db` is initialized.
  // Defining them at module top-level would evaluate `db.transaction` while
  // `db` is still undefined and crash the process on startup.
  //
  // Download claim — atomic so two workers can never grab the same video:
  //   'pending'                  → not started yet
  //   'paused' + interrupted     → resumed automatically after a crash/shutdown
  //   'paused' + 'user'          → held until an explicit Resume
  claimDownloadJob = db.transaction((workerId: string) => {
    const row = db
      .query(
        `UPDATE jobs SET download_status = 'downloading', pause_reason = NULL, download_claimed_by = ?, download_claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id FROM jobs
           WHERE (download_status = 'pending'
              OR (download_status = 'paused' AND COALESCE(pause_reason, '') NOT IN ('user', 'waiting_live')))
             -- Pipeline exclusion: never start a download while another worker
             -- owns this job's media file. The converter deletes/renames the
             -- source mid-job and the metadata worker writes sidecars next to
             -- it, so a yt-dlp writing to the same path is what produced
             -- "file deleted before conversion finished".
             AND COALESCE(conversion_status, '') != 'in_progress'
             AND COALESCE(metadata_status, '') != 'in_progress'
           ORDER BY created_at, rowid LIMIT 1
         )
         RETURNING *`,
      )
      .get(workerId) as Job | null;
    return row;
  });

  // Converter claim — only after download AND metadata work are terminal.
  claimConvertJob = db.transaction((workerId: string) => {
    const row = db
      .query(
        `UPDATE jobs SET conversion_status = 'in_progress', conversion_claimed_by = ?, conversion_claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id FROM jobs
           WHERE download_status = 'downloaded' AND conversion_status = 'pending'
             AND metadata_status IN ('done', 'not_needed', 'failed')
           ORDER BY created_at, rowid LIMIT 1
         )
         RETURNING *`,
      )
      .get(workerId) as Job | null;
    return row;
  });

  // Metadata claim — sidecars (subs/thumbnail/description/info.json) for
  // finished downloads whose flags say metadata is wanted.
  claimMetadataJob = db.transaction((workerId: string) => {
    const row = db
      .query(
        `UPDATE jobs SET metadata_status = 'in_progress', updated_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id FROM jobs
           WHERE download_status = 'downloaded' AND metadata_status = 'pending'
             -- Sidecars are fetched against the media file's path; doing that
             -- while the converter is renaming/moving it lands them in the
             -- wrong place. A job whose conversion already finished ('done')
             -- is still eligible — a failed-then-requeued metadata stage runs
             -- after conversion on purpose.
             AND COALESCE(conversion_status, '') != 'in_progress'
           ORDER BY created_at, rowid LIMIT 1
         )
         RETURNING *`,
      )
      .get(workerId) as Job | null;
    return row;
  });
}

/** Per-video failure cap: the smaller of the two knobs, so both stay honest. */
export function perVideoCap(config: Config): number {
  return Math.min(config.maxRetryAttempts, config.maxFailuresPerVideo);
}

export function isVideoInDb(videoId: string): boolean {
  return !!db.query("SELECT id FROM jobs WHERE id = ?").get(videoId);
}

/** Backfill legacy jobs from a source listing before that source is removed. */
export function associateExistingJobsWithSource(sourceUrl: string, videoIds: Iterable<string>): number {
  const ids = [...new Set([...videoIds].filter(Boolean))];
  if (ids.length === 0) return 0;
  const associate = db.transaction((batch: string[]) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO job_sources (source_url, job_id)
       SELECT ?, id FROM jobs WHERE id = ?`,
    );
    let associated = 0;
    for (const id of batch) associated += stmt.run(sourceUrl, id).changes;
    return associated;
  });
  return associate(ids);
}

export interface SourceJobCleanup {
  /** Jobs that had a recorded association with the removed/stale source. */
  affectedJobs: number;
  /** Jobs deleted because no remaining configured source needs them. */
  deletedJobs: number;
  /** Shared jobs retained for another configured source. */
  retainedJobs: number;
}

/**
 * Remove a source's ownership links and delete its now-unowned jobs. A video
 * still referenced by another configured source remains in the queue.
 */
export function removeSourceJobsFromDatabase(
  sourceUrl: string,
  activeSourceUrls: Iterable<string>,
): SourceJobCleanup {
  const activeSources = new Set(activeSourceUrls);
  const cleanup = db.transaction(() => {
    const rows = db
      .query("SELECT job_id FROM job_sources WHERE source_url = ?")
      .all(sourceUrl) as { job_id: string }[];
    db.run("DELETE FROM job_sources WHERE source_url = ?", [sourceUrl]);
    return cleanupUnownedSourceJobs(new Set(rows.map((row) => row.job_id)), activeSources);
  });
  return cleanup();
}

/**
 * Startup safety net for sources removed by editing config.json directly.
 * Only jobs that were previously source-tracked are candidates; legacy/manual
 * jobs without ownership metadata are left alone rather than guessed at.
 */
export function pruneJobsForUnconfiguredSources(activeSourceUrls: Iterable<string>): SourceJobCleanup {
  const activeSources = new Set(activeSourceUrls);
  const cleanup = db.transaction(() => {
    const links = db.query("SELECT source_url, job_id FROM job_sources").all() as {
      source_url: string;
      job_id: string;
    }[];
    const staleLinks = links.filter((link) => !activeSources.has(link.source_url));
    const affected = new Set(staleLinks.map((link) => link.job_id));
    for (const link of staleLinks) {
      db.run("DELETE FROM job_sources WHERE source_url = ? AND job_id = ?", [link.source_url, link.job_id]);
    }
    return cleanupUnownedSourceJobs(affected, activeSources);
  });
  return cleanup();
}

/** Must be called from inside a transaction. */
function cleanupUnownedSourceJobs(jobIds: Set<string>, activeSources: Set<string>): SourceJobCleanup {
  let deletedJobs = 0;
  let retainedJobs = 0;
  for (const jobId of jobIds) {
    const links = db.query("SELECT source_url FROM job_sources WHERE job_id = ?").all(jobId) as {
      source_url: string;
    }[];
    // Drop stale links too, so a missing/manual config entry cannot keep a
    // deleted source's job alive indefinitely.
    for (const link of links) {
      if (!activeSources.has(link.source_url)) {
        db.run("DELETE FROM job_sources WHERE source_url = ? AND job_id = ?", [link.source_url, jobId]);
      }
    }
    const stillNeeded = db.query("SELECT 1 FROM job_sources WHERE job_id = ? LIMIT 1").get(jobId);
    if (stillNeeded) retainedJobs++;
    else deletedJobs += db.run("DELETE FROM jobs WHERE id = ?", [jobId]).changes;
  }
  return { affectedJobs: jobIds.size, deletedJobs, retainedJobs };
}

export function getNextIndex(folder: string): number {
  const row = db.query("SELECT next_index FROM playlist_state WHERE folder = ?").get(folder) as
    | { next_index: number }
    | null;
  const next = (row?.next_index || 0) + 1;
  db.run(
    `INSERT INTO playlist_state (folder, next_index) VALUES (?, ?)
     ON CONFLICT(folder) DO UPDATE SET next_index = excluded.next_index`,
    [folder, next],
  );
  return next;
}
