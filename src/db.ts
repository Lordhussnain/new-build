// src/db.ts — SQLite job database: schema, migrations, atomic job claims.
//
// Every stage transition (claim, complete, fail) goes through here so the
// worker pools stay crash-safe: claims are single atomic UPDATE … RETURNING
// statements, so two workers can never grab the same video.
//
// A claim is a LEASE, not just a status flag: alongside the human-readable
// worker id and timestamp it carries
//   • a random CLAIM TOKEN — worker ids like `dl-1` repeat across processes, so
//     a stale worker could otherwise look like the new owner; the token is
//     unique per claim and every later update must present it, and
//   • a HEARTBEAT timestamp — the reaper reclaims only when the lease has
//     actually expired (no heartbeat within the stage's window), so a live
//     long-running stage is never mistaken for a dead one.
// Ownership-changing updates go through `updateClaimedJob`/`releaseClaimedJob`
// (compare-and-swap on token + owner); a worker that lost its claim changes no
// job state. See also `src/lease.ts` for the engine-wide (database-level)
// lease that keeps two engine processes out of one `archive.db`.

import { Database } from "bun:sqlite";
import type { Config } from "./config";
import { clearJobCancelled } from "./state";

export interface Job {
  id: string;
  url: string;
  title: string;
  output_directory: string;
  target_format: string | null;
  /** Per-job quality override; null means use the current global setting. */
  video_quality: string | null;
  want_subtitles: number;
  want_thumbnail: number;
  want_description: number;
  download_status: string;
  conversion_status: string;
  metadata_status: string;
  pause_reason: string | null;
  metadata_retry_count: number;
  metadata_files: string | null;
  /** JSON array of sidecar types confirmed unavailable after a successful fetch. */
  metadata_unavailable: string | null;
  download_claimed_by: string | null;
  download_claimed_at: string | null;
  /** Unique token for the current download claim (required by every claim update). */
  download_claim_token: string | null;
  /** Last heartbeat of the download claim's lease (progress updates renew it). */
  download_heartbeat_at: string | null;
  conversion_claimed_by: string | null;
  conversion_claimed_at: string | null;
  /** Unique token for the current conversion claim. */
  conversion_claim_token: string | null;
  /** Last heartbeat of the conversion claim's lease. */
  conversion_heartbeat_at: string | null;
  metadata_claimed_by: string | null;
  metadata_claimed_at: string | null;
  /** Unique token for the current metadata claim. */
  metadata_claim_token: string | null;
  /** Last heartbeat of the metadata claim's lease. */
  metadata_heartbeat_at: string | null;
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
  /**
   * The secondary-storage ROOT this job's media was moved under, or null while
   * it still lives in the output tree. Compared against the configured
   * `secondaryStoragePath`, so changing that path makes every file relocated
   * elsewhere eligible again (see src/relocate.ts).
   */
  relocated_to: string | null;
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

// Switching a database into WAL needs an exclusive lock, so it can fail with
// SQLITE_BUSY while a leftover connection still holds the file: an engine that
// died without releasing its lease (src/lease.ts), the seeding script of a test
// run, or — on Windows — a file handle that outlives close() by a few hundred
// milliseconds. A momentary lock is waited out rather than obeyed by skipping
// the switch: the journal mode is load-bearing, it is what lets the claiming
// workers and the Web UI read and write the same archive at the same time.
const WAL_SWITCH_ATTEMPTS = 3;
const WAL_SWITCH_BACKOFF_MS = 100;

export function initDatabase(path: string = "archive.db"): void {
  db = new Database(path);
  // Order matters: the busy timeout has to exist before the first statement
  // that can block. With the previous order the WAL switch ran with SQLite's
  // default zero timeout, so a momentary lock aborted startup instantly.
  db.run("PRAGMA busy_timeout = 5000;");
  for (let attempt = 0; ; attempt++) {
    try {
      db.run("PRAGMA journal_mode = WAL;");
      break;
    } catch (error) {
      if (attempt >= WAL_SWITCH_ATTEMPTS - 1) throw error;
      Bun.sleepSync(WAL_SWITCH_BACKOFF_MS * (attempt + 1));
    }
  }
  db.run("PRAGMA foreign_keys = ON;");
  db.run(
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      url TEXT,
      title TEXT,
      output_directory TEXT,
      target_format TEXT,
      video_quality TEXT,
      want_subtitles INTEGER DEFAULT 0,
      want_thumbnail INTEGER DEFAULT 0,
      want_description INTEGER DEFAULT 0,
      download_status TEXT DEFAULT 'pending',
      conversion_status TEXT DEFAULT 'pending',
      metadata_status TEXT DEFAULT 'not_needed',
      metadata_files TEXT,
      metadata_unavailable TEXT,
      pause_reason TEXT,
      metadata_retry_count INTEGER DEFAULT 0,
      metadata_claimed_by TEXT,
      metadata_claimed_at TEXT,
      metadata_claim_token TEXT,
      metadata_heartbeat_at TEXT,
      download_claimed_by TEXT,
      download_claimed_at TEXT,
      download_claim_token TEXT,
      download_heartbeat_at TEXT,
      conversion_claimed_by TEXT,
      conversion_claimed_at TEXT,
      conversion_claim_token TEXT,
      conversion_heartbeat_at TEXT,
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
  // Explicitly deleted jobs stay suppressed when a playlist is scanned again.
  // This table is independent of jobs/job_sources so the tombstone survives
  // row deletion and process restarts until the user explicitly allows it again.
  db.run(
    `CREATE TABLE IF NOT EXISTS ignored_videos (
       video_id TEXT PRIMARY KEY,
       url TEXT NOT NULL,
       title TEXT NOT NULL,
       source_urls TEXT NOT NULL DEFAULT '[]',
       ignored_at TEXT DEFAULT CURRENT_TIMESTAMP
     )`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_ignored_videos_time ON ignored_videos(ignored_at)`);
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
  // Database-level engine lease: exactly one engine process may own `archive.db`.
  //
  // The web port is still the HTTP lock, but it is not an ownership primitive for
  // the database: two engines with different `webPort` values used to bind their
  // own ports and then both run the startup reconciliation on the same jobs,
  // each resetting the other's in-flight claims. The lease row is the
  // authoritative owner: `owner` is a random per-process token, `expires_at` is
  // renewed by a heartbeat, and `fencing` increases monotonically on every
  // acquisition so a stale holder can be told apart from the current one.
  db.run(
    `CREATE TABLE IF NOT EXISTS engine_lease (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       owner TEXT,
       fencing INTEGER NOT NULL DEFAULT 0,
       pid INTEGER,
       host TEXT,
       acquired_at TEXT,
       heartbeat_at TEXT,
       expires_at TEXT
     )`,
  );

  // Schema migrations for databases created by older versions.
  ensureColumn("jobs", "metadata_status", "metadata_status TEXT DEFAULT 'not_needed'");
  ensureColumn("jobs", "video_quality", "video_quality TEXT");
  ensureColumn("jobs", "metadata_files", "metadata_files TEXT");
  ensureColumn("jobs", "metadata_unavailable", "metadata_unavailable TEXT");
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
  // Secondary-storage relocation: the secondary-storage ROOT the finished media
  // was moved under (NULL = still in the output tree, or never moved). Storing
  // the root rather than a boolean keeps the pass honest when the operator
  // points `secondaryStoragePath` at a different location: every job whose
  // `relocated_to` differs from the current root becomes eligible again, and
  // jobs already sitting under the configured root are never moved onto
  // themselves (see src/relocate.ts).
  ensureColumn("jobs", "relocated_to", "relocated_to TEXT");
  // Claim leases: a random token plus a heartbeat timestamp per stage. Rows
  // claimed by an older engine version have neither (token/claimed_by NULL),
  // which the CAS updates treat as a legacy claim — the reaper may still take
  // it over once its `*_claimed_at` ages out.
  ensureColumn("jobs", "metadata_claimed_by", "metadata_claimed_by TEXT");
  ensureColumn("jobs", "metadata_claimed_at", "metadata_claimed_at TEXT");
  ensureColumn("jobs", "metadata_claim_token", "metadata_claim_token TEXT");
  ensureColumn("jobs", "metadata_heartbeat_at", "metadata_heartbeat_at TEXT");
  ensureColumn("jobs", "download_claim_token", "download_claim_token TEXT");
  ensureColumn("jobs", "download_heartbeat_at", "download_heartbeat_at TEXT");
  ensureColumn("jobs", "conversion_claim_token", "conversion_claim_token TEXT");
  ensureColumn("jobs", "conversion_heartbeat_at", "conversion_heartbeat_at TEXT");
  // The lease records which process (and host) owns the database, so a restart
  // after a hard kill can take over immediately instead of waiting out the TTL.
  ensureColumn("engine_lease", "pid", "pid INTEGER");
  ensureColumn("engine_lease", "host", "host TEXT");
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
        `UPDATE jobs SET download_status = 'downloading', pause_reason = NULL,
           download_claimed_by = ?, download_claimed_at = CURRENT_TIMESTAMP,
           download_claim_token = ?, download_heartbeat_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
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
      .get(workerId, newClaimToken()) as Job | null;
    // A fresh claim means the video is wanted again (e.g. its source was
    // re-added after a delete): any leftover cancellation mark from a previous
    // life of this job id must not block the new download.
    if (row) clearJobCancelled(row.id);
    return row;
  });

  // Converter claim — only after download AND metadata work are terminal.
  claimConvertJob = db.transaction((workerId: string) => {
    const row = db
      .query(
        `UPDATE jobs SET conversion_status = 'in_progress',
           conversion_claimed_by = ?, conversion_claimed_at = CURRENT_TIMESTAMP,
           conversion_claim_token = ?, conversion_heartbeat_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id FROM jobs
           WHERE download_status = 'downloaded' AND conversion_status = 'pending'
             AND metadata_status IN ('done', 'not_needed', 'failed')
           ORDER BY created_at, rowid LIMIT 1
         )
         RETURNING *`,
      )
      .get(workerId, newClaimToken()) as Job | null;
    return row;
  });

  // Metadata claim — sidecars (subs/thumbnail/description/info.json) for
  // finished downloads whose flags say metadata is wanted. The claim records
  // its owner, timestamp, token and heartbeat like the other two stages: the
  // reaper needs a lease to compare against, and the worker needs a token to
  // present on every later update.
  claimMetadataJob = db.transaction((workerId: string) => {
    const row = db
      .query(
        `UPDATE jobs SET metadata_status = 'in_progress',
           metadata_claimed_by = ?, metadata_claimed_at = CURRENT_TIMESTAMP,
           metadata_claim_token = ?, metadata_heartbeat_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
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
      .get(workerId, newClaimToken()) as Job | null;
    return row;
  });
}

// ---------------------------------------------------------------------------
// Claim leases: tokens, compare-and-swap updates, heartbeats
// ---------------------------------------------------------------------------

/** The three independently claimable pipeline stages. */
export type ClaimStage = "download" | "conversion" | "metadata";

interface ClaimColumns {
  /** Stage status column (`downloading` for downloads, `in_progress` otherwise). */
  status: string;
  /** Status value that means "this stage is claimed right now". */
  claimedStatus: string;
  /** Human-readable owner (worker id) column. */
  by: string;
  /** Claim timestamp column. */
  at: string;
  /** Random per-claim token column. */
  token: string;
  /** Lease heartbeat column, renewed while the stage runs. */
  heartbeat: string;
}

const CLAIM_COLUMNS: Record<ClaimStage, ClaimColumns> = {
  download: {
    status: "download_status",
    claimedStatus: "downloading",
    by: "download_claimed_by",
    at: "download_claimed_at",
    token: "download_claim_token",
    heartbeat: "download_heartbeat_at",
  },
  conversion: {
    status: "conversion_status",
    claimedStatus: "in_progress",
    by: "conversion_claimed_by",
    at: "conversion_claimed_at",
    token: "conversion_claim_token",
    heartbeat: "conversion_heartbeat_at",
  },
  metadata: {
    status: "metadata_status",
    claimedStatus: "in_progress",
    by: "metadata_claimed_by",
    at: "metadata_claimed_at",
    token: "metadata_claim_token",
    heartbeat: "metadata_heartbeat_at",
  },
};

/** Column names for one stage's claim — the single source of truth. */
export function claimColumns(stage: ClaimStage): ClaimColumns {
  return CLAIM_COLUMNS[stage];
}

/** A claim's identity: what a CAS update matches against. */
export interface ClaimRef {
  by: string | null;
  token: string | null;
}

/**
 * The claim coordinates of a row, for passing to `updateClaimedJob`.
 *
 * `null`/`null` (no token, no owner) is the legacy claim written by an engine
 * version that predated tokens; it is still updatable, and the reaper may take
 * it over once its `*_claimed_at` ages out — exactly like before.
 */
export function claimRef(stage: ClaimStage, row: Record<string, unknown> | Job): ClaimRef {
  const c = CLAIM_COLUMNS[stage];
  const r = row as Record<string, unknown>;
  return {
    by: (r[c.by] as string | null | undefined) ?? null,
    token: (r[c.token] as string | null | undefined) ?? null,
  };
}

/**
 * A fresh, unique claim token.
 *
 * Worker ids (`dl-1`, `cv-2`) are positional and repeat across processes: a
 * worker restarted in a second engine process looks like the first one. The
 * token is what actually identifies a claim, so a stale worker's late update
 * cannot be mistaken for the live owner's.
 */
export function newClaimToken(): string {
  return crypto.randomUUID();
}

/** How often a claimed stage renews its lease (test override: YTA_CLAIM_HEARTBEAT_MS). */
export function claimHeartbeatMs(): number {
  const override = Number(process.env.YTA_CLAIM_HEARTBEAT_MS);
  return Number.isFinite(override) && override > 0 ? override : 30_000;
}

/**
 * Compare-and-swap an update on a claimed job.
 *
 * The row is touched only when `claim` still identifies its live claim, so a
 * worker (or reaper) whose claim was reaped, released, or taken over by another
 * process cannot change job state: it gets 0 changed rows and must walk away.
 * The caller checks the result — `1` means the update landed.
 *
 * `extraCondition` is appended to the WHERE clause for callers that need an
 * additional precondition (e.g. reaping only a lease that has actually
 * expired, or a user pause that is still recorded).
 */
export function updateClaimedJob(
  stage: ClaimStage,
  jobId: string,
  claim: ClaimRef,
  setClause: string,
  params: unknown[] = [],
  extraCondition?: string,
): number {
  const c = CLAIM_COLUMNS[stage];
  const extra = extraCondition ? ` AND (${extraCondition})` : "";
  return db.run(
    `UPDATE jobs SET ${setClause} WHERE id = ? AND ${c.token} IS ? AND ${c.by} IS ?${extra}`,
    [...params, jobId, claim.token, claim.by] as any,
  ).changes;
}

/**
 * The release flavour of `updateClaimedJob`: the matched claim is cleared in
 * the same statement that writes the new state, so a job is never left with a
 * status that says "finished" while a claim still points at a worker that is
 * gone (or worse, while a *new* owner's claim is overwritten).
 */
export function releaseClaimedJob(
  stage: ClaimStage,
  jobId: string,
  claim: ClaimRef,
  setClause: string,
  params: unknown[] = [],
  extraCondition?: string,
): number {
  const c = CLAIM_COLUMNS[stage];
  const release = [
    `${c.by} = NULL`,
    `${c.at} = NULL`,
    `${c.token} = NULL`,
    `${c.heartbeat} = NULL`,
    "updated_at = CURRENT_TIMESTAMP",
  ].join(", ");
  const set = [setClause, release].filter((s) => s && s.trim().length > 0).join(", ");
  return updateClaimedJob(stage, jobId, claim, set, params, extraCondition);
}

/**
 * Renew a claim's lease. Returns false when the claim is no longer ours, which
 * the worker's heartbeat callback reports — the ownership checks and CAS
 * updates then keep it from touching anything the new owner controls.
 */
export function heartbeatClaim(stage: ClaimStage, jobId: string, claim: ClaimRef): boolean {
  const c = CLAIM_COLUMNS[stage];
  return (
    db.run(
      `UPDATE jobs SET ${c.heartbeat} = CURRENT_TIMESTAMP
        WHERE id = ? AND ${c.token} IS ? AND ${c.by} IS ? AND ${c.status} = ?`,
      [jobId, claim.token, claim.by, c.claimedStatus] as any,
    ).changes === 1
  );
}

/** Is this claim still the live owner of the stage on this row? */
export function ownsClaim(stage: ClaimStage, jobId: string, claim: ClaimRef): boolean {
  const c = CLAIM_COLUMNS[stage];
  return !!db
    .query(
      `SELECT 1 FROM jobs
        WHERE id = ? AND ${c.token} IS ? AND ${c.by} IS ? AND ${c.status} = ? LIMIT 1`,
    )
    .get(jobId, claim.token, claim.by, c.claimedStatus);
}

/**
 * Keep a claim's lease alive while its stage runs, so the reaper can tell a
 * long conversion or metadata fetch apart from a dead worker.
 *
 * Returns the stop function — every caller must stop it when the stage ends,
 * including on failure, or the heartbeat would keep renewing a claim whose
 * outcome was already written.
 *
 * `onLost` fires AT MOST ONCE. A worker releases its own claim in the same
 * statement that records the outcome (retry re-queue, park-as-failed, success),
 * and then usually sleeps for the backoff *inside* the try-block — so the timer
 * outlives the claim by design and every later tick would find a dead lease.
 * Reporting that per tick printed one alarming
 * "download claim lost — the next update will not land" line every heartbeat
 * interval per retrying video, which buried the real error in error.log while
 * saying nothing the release had not already recorded.
 */
export function startClaimHeartbeat(
  stage: ClaimStage,
  jobId: string,
  claim: ClaimRef,
  onLost?: () => void,
  intervalMs: number = claimHeartbeatMs(),
): () => void {
  let lostReported = false;
  const timer = setInterval(() => {
    try {
      if (heartbeatClaim(stage, jobId, claim)) return;
    } catch {
      // The database can be mid-shutdown; the CAS updates are the real guard.
      return;
    }
    if (lostReported || !onLost) return;
    lostReported = true;
    // A lost lease is never renewed again: firing the callback on every later
    // tick would only repeat a fact the release already recorded.
    onLost();
  }, Math.max(250, intervalMs));
  // A heartbeat must never keep a shutting-down process alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/** Per-video failure cap: the smaller of the two knobs, so both stay honest. */
export function perVideoCap(config: Config): number {
  return Math.min(config.maxRetryAttempts, config.maxFailuresPerVideo);
}

export function isVideoInDb(videoId: string): boolean {
  return !!db.query("SELECT id FROM jobs WHERE id = ?").get(videoId);
}

export function isVideoIgnored(videoId: string): boolean {
  return !!db.query("SELECT 1 FROM ignored_videos WHERE video_id = ? LIMIT 1").get(videoId);
}

export interface IgnoredVideo {
  video_id: string;
  url: string;
  title: string;
  source_urls: string[];
  ignored_at: string;
}

/**
 * Atomically remember explicitly deleted videos and remove their queue rows.
 * Source ownership is copied before the FK cascade removes job_sources. The
 * ignored tombstones then outlive both the job rows and engine restarts.
 */
export function deleteJobsAndIgnore(ids: Iterable<string>): { deleted: number; ignored: number } {
  const uniqueIds = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (uniqueIds.length === 0) return { deleted: 0, ignored: 0 };
  const placeholders = uniqueIds.map(() => "?").join(",");
  const deleteAndIgnore = db.transaction((batch: string[]) => {
    const jobs = db
      .query(`SELECT id, url, title FROM jobs WHERE id IN (${placeholders})`)
      .all(...batch) as { id: string; url: string | null; title: string | null }[];
    if (jobs.length === 0) return { deleted: 0, ignored: 0 };

    const sourceQuery = db.prepare("SELECT source_url FROM job_sources WHERE job_id = ? ORDER BY source_url");
    const ignore = db.prepare(
      `INSERT INTO ignored_videos (video_id, url, title, source_urls, ignored_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(video_id) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         source_urls = excluded.source_urls,
         ignored_at = CURRENT_TIMESTAMP`,
    );
    for (const job of jobs) {
      const sources = sourceQuery.all(job.id) as { source_url: string }[];
      ignore.run(
        job.id,
        job.url || `https://www.youtube.com/watch?v=${job.id}`,
        job.title || job.id,
        JSON.stringify(sources.map((source) => source.source_url)),
      );
    }
    db.run(`DELETE FROM jobs WHERE id IN (${placeholders})`, batch);
    // SQLite may include cascaded job_sources rows in `changes`; count the
    // selected job rows instead so the API reports videos, not FK side effects.
    return { deleted: jobs.length, ignored: jobs.length };
  });
  return deleteAndIgnore(uniqueIds);
}

export function listIgnoredVideos(limit = 500): IgnoredVideo[] {
  const cappedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = db
    .query(
      `SELECT video_id, url, title, source_urls, ignored_at
         FROM ignored_videos ORDER BY ignored_at DESC, video_id LIMIT ?`,
    )
    .all(cappedLimit) as {
      video_id: string;
      url: string;
      title: string;
      source_urls: string;
      ignored_at: string;
    }[];
  return rows.map((row) => {
    let sourceUrls: string[] = [];
    try {
      const parsed = JSON.parse(row.source_urls);
      if (Array.isArray(parsed)) sourceUrls = parsed.filter((url): url is string => typeof url === "string");
    } catch {
      // A malformed legacy value must not break the ignored-jobs panel.
    }
    return { ...row, source_urls: sourceUrls };
  });
}

/** Remove a tombstone so future playlist scans may enqueue the video again. */
export function allowIgnoredVideo(videoId: string): number {
  return db.run("DELETE FROM ignored_videos WHERE video_id = ?", [videoId]).changes;
}

// ---------------------------------------------------------------------------
// Secondary-storage relocation
// ---------------------------------------------------------------------------
//
// A job's finished media can be in the output tree even though no conversion
// will ever claim it again: it was converted by an earlier version, its
// conversion finished before secondary storage was configured, or the engine
// crashed between the copy and the database update. These helpers are the
// single source of truth for "does this file still need to move?".
//
// `relocated_to` stores the secondary-storage ROOT (not a boolean), so a job
// relocated to the old root becomes eligible again when the operator points
// `secondaryStoragePath` somewhere new — while a file that already sits under
// the configured root is never moved onto itself.

/** One relocation candidate, as the pass needs it. */
export interface RelocationRow {
  id: string;
  title: string;
  folder: string;
  file_path: string;
  relocated_to: string | null;
}

/**
 * The SQL predicate behind every relocation check: a finished, converted
 * download whose media is not (yet) recorded under the given root.
 *
 * `metadata_status = 'in_progress'` is excluded on purpose — the sidecar pass
 * writes files next to the media, and moving it out from under that writer
 * would leave the sidecars behind in the output tree.
 */
const RELOCATION_WHERE = `
  download_status = 'downloaded'
  AND file_path IS NOT NULL AND file_path != ''
  AND conversion_status IN ('done', 'not_needed')
  AND COALESCE(metadata_status, 'not_needed') != 'in_progress'
  AND (relocated_to IS NULL OR relocated_to != ?)`;

/** Every job whose media still has to reach secondary storage, oldest first. */
export function listJobsAwaitingRelocation(secondaryStoragePath: string): RelocationRow[] {
  return db
    .query(
      `SELECT id, title, folder, file_path, relocated_to FROM jobs
        WHERE ${RELOCATION_WHERE}
        ORDER BY created_at, rowid`,
    )
    .all(secondaryStoragePath) as RelocationRow[];
}

/** How many files are still waiting to move (dashboard / startup status). */
export function countJobsAwaitingRelocation(secondaryStoragePath: string): number {
  const row = db
    .query(`SELECT COUNT(*) as n FROM jobs WHERE ${RELOCATION_WHERE}`)
    .get(secondaryStoragePath) as { n: number } | null;
  return row?.n ?? 0;
}

/** Does this one job still need its file relocated? (re-checked mid-move) */
export function jobAwaitingRelocation(jobId: string, secondaryStoragePath: string): boolean {
  return !!db
    .query(`SELECT 1 FROM jobs WHERE id = ? AND ${RELOCATION_WHERE} LIMIT 1`)
    .get(jobId, secondaryStoragePath);
}

/**
 * Record where a job's media now lives. Compare-and-swaps on the OLD path so a
 * job whose `file_path` changed meanwhile (re-downloaded, manually retried,
 * deleted) is never pointed at a file this pass did not put there.
 *
 * Used both for the move and for crash-window adoption: a file that already
 * sits in secondary storage because the previous run died between the copy and
 * this update is adopted with the same call.
 *
 * Returns the number of rows changed (0 = somebody else owns this row now).
 */
export function recordRelocatedFile(
  jobId: string,
  previousPath: string,
  newPath: string,
  relocatedTo: string,
): number {
  return db.run(
    `UPDATE jobs SET file_path = ?, relocated_to = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND file_path = ?`,
    [newPath, relocatedTo, jobId, previousPath],
  ).changes;
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
