// tests/db.test.ts — job database: claims, migrations, crash recovery, sweeps.
//
// Every test runs against a fresh in-memory database, so the suite is fast and
// leaves no archive.db behind.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  claimConvertJob,
  claimDownloadJob,
  claimMetadataJob,
  db,
  getNextIndex,
  initDatabase,
  isVideoInDb,
  perVideoCap,
} from "../src/db";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { activeDownloadJobs } from "../src/state";
import { ingestItems } from "../src/scanner";
import {
  cleanOrphanedFiles,
  findPartialFile,
  reconcileCrashedJobs,
  reconcileMissingFiles,
  reapStaleClaims,
  requeueFailedJobs,
} from "../src/reconcile";
import { removeFromArchive } from "../src/archive";

function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Insert a job row directly (bypassing the scanner) for state-machine tests. */
function insertJob(id: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: `Video ${id}`,
    output_directory: "/tmp/out",
    target_format: "mp4",
    ...overrides,
  };
  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(", ");
  db.run(
    `INSERT INTO jobs (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
    Object.values(row) as any[],
  );
}

function getJob(id: string): any {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id);
}

function minutesAgo(minutes: number): string {
  return (db.query("SELECT datetime('now', ?) AS timestamp").get(`-${minutes} minutes`) as any).timestamp;
}

beforeEach(() => {
  initDatabase(":memory:");
});

const tmpDirs: string[] = [];
afterAll(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (!d) continue;
    // Windows refuses to remove a directory whose files are still open, and an
    // indexer/AV can hold a freshly written temp file for a moment. Leftover
    // temp litter must not fail the suite, so retry briefly and then give up.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(d, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
  }
});

async function makeTmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "yta-db-"));
  tmpDirs.push(d);
  return d;
}

describe("schema & migrations", () => {
  test("creates all tables", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("jobs");
    expect(tables).toContain("job_sources");
    expect(tables).toContain("playlist_state");
    expect(tables).toContain("run_history");
  });

  test("adds reliability columns to a legacy database", async () => {
    // A file-backed DB is required here: every ":memory:" handle is its own
    // database, so re-initializing would not see the legacy table.
    const dir = await makeTmpDir();
    const dbPath = join(dir, "legacy.db");
    try {
      initDatabase(dbPath);
      // Simulate an old schema: drop the modern table, recreate the legacy one.
      db.run("DROP TABLE jobs");
      db.run(
        `CREATE TABLE jobs (
         id TEXT PRIMARY KEY, url TEXT, title TEXT, output_directory TEXT, target_format TEXT,
         want_subtitles INTEGER DEFAULT 0, want_thumbnail INTEGER DEFAULT 0, want_description INTEGER DEFAULT 0,
         download_status TEXT DEFAULT 'pending', conversion_status TEXT DEFAULT 'pending',
         metadata_status TEXT, metadata_files TEXT, pause_reason TEXT,
         metadata_retry_count INTEGER DEFAULT 0, download_claimed_by TEXT, download_claimed_at TEXT,
         conversion_claimed_by TEXT, conversion_claimed_at TEXT, partial_file_path TEXT,
         retry_count INTEGER DEFAULT 0, last_error TEXT, folder TEXT, "index" INTEGER,
         file_path TEXT, file_size INTEGER DEFAULT 0, integrity TEXT,
         progress REAL DEFAULT 0, speed REAL DEFAULT 0, eta REAL DEFAULT 0,
         created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      );
      db.run(
        "INSERT INTO jobs (id, url, title, want_subtitles) VALUES ('legacy1', 'https://x', 'Legacy', 1)",
      );
      // Re-running initDatabase must migrate, not crash, and preserve the row.
      initDatabase(dbPath);
      const row = getJob("legacy1");
      expect(row).toBeTruthy();
      expect(row.conversion_retry_count).toBe(0);
      expect(row.resume_count).toBe(0);
      expect(row.best_progress).toBe(0);
      // A legacy row with want_subtitles=1 gets metadata_status backfilled.
      expect(row.metadata_status).toBe("pending");
    } finally {
      // This is the only test that leaves a file-backed handle open. It owns
      // that handle, so it closes it — on Windows an open legacy.db (plus its
      // -wal/-shm siblings) locks the temp dir and cleanup fails with EBUSY.
      try {
        db.close();
      } catch {}
      initDatabase(":memory:");
    }
  });

  test("creates the status indexes used by the claim queries", () => {
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'")
      .all()
      .map((r: any) => r.name);
    expect(indexes).toContain("idx_jobs_dl_status");
    expect(indexes).toContain("idx_jobs_cv_status");
    expect(indexes).toContain("idx_jobs_md_status");
  });
});

describe("atomic claims", () => {
  test("two workers never claim the same job", () => {
    insertJob("a");
    insertJob("b");
    const first = claimDownloadJob("dl-1");
    const second = claimDownloadJob("dl-2");
    expect(first?.id).not.toBe(second?.id);
    expect(first?.download_claimed_by).toBe("dl-1");
    expect(second?.download_claimed_by).toBe("dl-2");
  });

  test("claims in creation order", () => {
    insertJob("first");
    insertJob("second");
    insertJob("third");
    const claims = [claimDownloadJob("w"), claimDownloadJob("w"), claimDownloadJob("w")];
    expect(claims.map((c) => c?.id)).toEqual(["first", "second", "third"]);
    expect(claimDownloadJob("w")).toBeNull();
  });

  test("user-paused jobs are held; interrupted jobs auto-resume", () => {
    insertJob("held", { download_status: "paused", pause_reason: "user" });
    insertJob("interrupted", { download_status: "paused", pause_reason: "interrupted" });
    const claimed = claimDownloadJob("w");
    expect(claimed?.id).toBe("interrupted");
    expect(claimed?.pause_reason).toBeNull();
    expect(claimDownloadJob("w")).toBeNull(); // the user-paused job stays held
  });

  test("converter only claims downloads whose metadata is terminal", () => {
    insertJob("no-meta", { download_status: "downloaded", conversion_status: "pending", metadata_status: "pending" });
    insertJob("meta-done", { download_status: "downloaded", conversion_status: "pending", metadata_status: "done" });
    const claimed = claimConvertJob("cv-1");
    expect(claimed?.id).toBe("meta-done");
  });

  test("metadata claim requires a finished download", () => {
    insertJob("pending-dl", { download_status: "pending", metadata_status: "pending" });
    insertJob("done-dl", { download_status: "downloaded", metadata_status: "pending" });
    const claimed = claimMetadataJob("md-1");
    expect(claimed?.id).toBe("done-dl");
    expect(claimed?.metadata_status).toBe("in_progress");
  });
});

describe("reconcileCrashedJobs", () => {
  test("interrupted downloads become auto-resumable; user pauses survive", () => {
    insertJob("inflight", { download_status: "downloading" });
    insertJob("userpaused", {
      download_status: "paused",
      pause_reason: "user",
      download_claimed_by: "dl-stale",
      download_claimed_at: "2020-01-01 00:00:00",
    });
    insertJob("conv", { download_status: "downloaded", conversion_status: "in_progress" });
    insertJob("meta", { download_status: "downloaded", metadata_status: "in_progress" });
    reconcileCrashedJobs();
    expect(getJob("inflight").download_status).toBe("paused");
    expect(getJob("inflight").pause_reason).toBe("interrupted");
    expect(getJob("userpaused").pause_reason).toBe("user");
    expect(getJob("userpaused").download_claimed_by).toBeNull();
    expect(getJob("userpaused").download_claimed_at).toBeNull();
    expect(getJob("conv").conversion_status).toBe("pending");
    expect(getJob("meta").metadata_status).toBe("pending");
    // ...and the interrupted job is immediately claimable again
    expect(claimDownloadJob("w")?.id).toBe("inflight");
  });
});

describe("reapStaleClaims", () => {
  test("does not reclaim a stale-looking download while a worker still owns its claim", () => {
    insertJob("long-download", {
      download_status: "downloading",
      download_claimed_by: "dl-7",
      download_claimed_at: "2020-01-01 00:00:00",
    });
    activeDownloadJobs.set(7, "long-download");
    try {
      reapStaleClaims(testConfig());
      expect(getJob("long-download").download_status).toBe("downloading");
    } finally {
      activeDownloadJobs.delete(7);
    }
  });

  test("re-queues claims older than the watchdog windows", () => {
    insertJob("stale-dl", {
      download_status: "downloading",
      download_claimed_by: "dl-1",
      download_claimed_at: "2020-01-01 00:00:00",
    });
    insertJob("fresh-dl", {
      download_status: "downloading",
      download_claimed_by: "dl-2",
      download_claimed_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    insertJob("stale-cv", {
      download_status: "downloaded",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-1",
      conversion_claimed_at: "2020-01-01 00:00:00",
    });
    reapStaleClaims(testConfig());
    expect(getJob("stale-dl").download_status).toBe("paused");
    expect(getJob("stale-dl").pause_reason).toBe("interrupted");
    expect(getJob("fresh-dl").download_status).toBe("downloading"); // untouched
    expect(getJob("stale-cv").conversion_status).toBe("pending");
  });

  test("uses the configured maximum download time as the stale-claim floor", () => {
    insertJob("within-download-window", {
      download_status: "downloading",
      download_claimed_by: "dl-1",
      download_claimed_at: minutesAgo(25),
    });
    insertJob("past-download-window", {
      download_status: "downloading",
      download_claimed_by: "dl-2",
      download_claimed_at: minutesAgo(61),
    });

    reapStaleClaims(testConfig({ maxDownloadMinutes: 60 }));

    expect(getJob("within-download-window").download_status).toBe("downloading");
    expect(getJob("past-download-window").download_status).toBe("paused");
  });

  test("keeps the 20-minute minimum when maxDownloadMinutes is lower", () => {
    insertJob("inside-minimum", {
      download_status: "downloading",
      download_claimed_by: "dl-1",
      download_claimed_at: minutesAgo(19),
    });
    insertJob("outside-minimum", {
      download_status: "downloading",
      download_claimed_by: "dl-2",
      download_claimed_at: minutesAgo(21),
    });

    reapStaleClaims(testConfig({ downloadTimeoutMinutes: 5, maxDownloadMinutes: 10 }));

    expect(getJob("inside-minimum").download_status).toBe("downloading");
    expect(getJob("outside-minimum").download_status).toBe("paused");
  });
});

describe("reconcileMissingFiles", () => {
  test("re-queues jobs whose file vanished and scrubs the archive", async () => {
    const dir = await makeTmpDir();
    const config = testConfig({ archiveFile: join(dir, "archive.txt"), verifyExistingFiles: true });
    await writeFile(config.archiveFile, "youtube abc123\nyoutube gone999\n");

    const liveFile = join(dir, "live.mp4");
    await writeFile(liveFile, "still here");
    insertJob("abc123", {
      download_status: "downloaded",
      file_path: liveFile,
      conversion_status: "done",
      want_subtitles: 1,
    });
    insertJob("gone999", {
      download_status: "downloaded",
      file_path: join(dir, "missing.mp4"),
      conversion_status: "done",
    });

    const fixed = reconcileMissingFiles(config);
    expect(fixed).toBe(1);
    expect(getJob("abc123").download_status).toBe("downloaded"); // untouched
    const renumbered = getJob("gone999");
    expect(renumbered.download_status).toBe("pending");
    expect(renumbered.file_path).toBeNull();
    expect(renumbered.retry_count).toBe(0);
    expect(renumbered.conversion_status).toBe("pending");
    // The archive entry for the missing file is scrubbed so yt-dlp re-fetches.
    const archive = await Bun.file(config.archiveFile).text();
    expect(archive).not.toContain("gone999");
    expect(archive).toContain("abc123");
  });

  test("leaves jobs alone while their conversion is in progress", async () => {
    // With deleteSourceAfterConvert the converter deletes the recorded source
    // mid-job and records the new path at the end; a startup sweep running in
    // that window must NOT re-queue the download onto the live converter.
    const dir = await makeTmpDir();
    const config = testConfig({ archiveFile: join(dir, "archive.txt"), verifyExistingFiles: true });
    await writeFile(config.archiveFile, "youtube conv111\n");
    insertJob("conv111", {
      download_status: "downloaded",
      file_path: join(dir, "missing.mp4"),
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-1",
    });
    expect(reconcileMissingFiles(config)).toBe(0);
    const job = getJob("conv111");
    expect(job.download_status).toBe("downloaded");
    expect(job.conversion_status).toBe("in_progress");
  });

  test("is a no-op when verifyExistingFiles is disabled", async () => {
    const dir = await makeTmpDir();
    const config = testConfig({ archiveFile: join(dir, "a.txt"), verifyExistingFiles: false });
    insertJob("gone", { download_status: "downloaded", file_path: join(dir, "missing.mp4") });
    expect(reconcileMissingFiles(config)).toBe(0);
    expect(getJob("gone").download_status).toBe("downloaded");
  });
});

describe("requeueFailedJobs", () => {
  test("re-queues transient failures after the cooldown", () => {
    insertJob("flaky", {
      download_status: "failed",
      retry_count: 1,
      last_error: "Unable to download webpage: Connection reset by peer",
      updated_at: "2020-01-01 00:00:00",
    });
    const config = testConfig({ requeueFailedAfterMinutes: 30, maxRetryAttempts: 3, maxFailuresPerVideo: 4 });
    const result = requeueFailedJobs(config);
    expect(result.downloads).toBe(1);
    expect(getJob("flaky").download_status).toBe("pending");
    // Queueing does not spend a retry; failure of the next attempt does.
    expect(getJob("flaky").retry_count).toBe(0);
  });

  test("never re-queues permanent failures, even when cooldown is ignored", () => {
    insertJob("private", {
      download_status: "failed",
      retry_count: 1,
      last_error: "ERROR: [youtube] xyz: Video unavailable",
      updated_at: "2020-01-01 00:00:00",
    });
    insertJob("geo", {
      download_status: "failed",
      retry_count: 1,
      last_error: "This video is geo-restricted in your location",
      updated_at: "2020-01-01 00:00:00",
    });
    const config = testConfig({ requeueFailedAfterMinutes: 30 });
    expect(requeueFailedJobs(config).downloads).toBe(0);
    expect(requeueFailedJobs(config, { ignoreCooldown: true }).downloads).toBe(0);
    expect(getJob("private").download_status).toBe("failed");
    expect(getJob("geo").download_status).toBe("failed");
  });

  test("starts a fresh bounded retry window after a failed job cools down", () => {
    insertJob("spent", {
      download_status: "failed",
      retry_count: 99,
      last_error: "The read operation timed out",
      updated_at: "2020-01-01 00:00:00",
    });
    const config = testConfig({ requeueFailedAfterMinutes: 30, maxRetryAttempts: 3, maxFailuresPerVideo: 4 });
    expect(requeueFailedJobs(config).downloads).toBe(1);
    expect(getJob("spent").download_status).toBe("pending");
    expect(getJob("spent").retry_count).toBe(0);
  });

  test("cooldown requeue retains the aria2c resume pair for the next claim", async () => {
    const dir = await makeTmpDir();
    const part = join(dir, "video.part");
    const control = `${part}.aria2`;
    await writeFile(part, "partial-bytes");
    await writeFile(control, "control-bytes");
    insertJob("resume-after-cooldown", {
      download_status: "failed",
      retry_count: 99,
      partial_file_path: part,
      last_error: "The read operation timed out",
      updated_at: "2020-01-01 00:00:00",
    });

    expect(requeueFailedJobs(testConfig({ requeueFailedAfterMinutes: 30 })).downloads).toBe(1);
    expect(getJob("resume-after-cooldown").retry_count).toBe(0);
    expect(getJob("resume-after-cooldown").partial_file_path).toBe(part);
    expect(existsSync(part)).toBe(true);
    expect(existsSync(control)).toBe(true);
    expect(claimDownloadJob("dl-resume")?.id).toBe("resume-after-cooldown");
  });

  test("skips jobs that have not cooled down yet", () => {
    insertJob("fresh", {
      download_status: "failed",
      retry_count: 0,
      last_error: "The read operation timed out",
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    const config = testConfig({ requeueFailedAfterMinutes: 30 });
    expect(requeueFailedJobs(config).downloads).toBe(0);
    // ignoreCooldown (the web UI button) retries immediately
    expect(requeueFailedJobs(config, { ignoreCooldown: true }).downloads).toBe(1);
  });

  test("re-queues failed conversions and metadata with their own budgets", async () => {
    const dir = await makeTmpDir();
    const media = join(dir, "video.mp4");
    await writeFile(media, "x");
    insertJob("convfail", {
      download_status: "downloaded",
      conversion_status: "failed",
      conversion_retry_count: 0,
      file_path: media,
      updated_at: "2020-01-01 00:00:00",
    });
    insertJob("metafail", {
      download_status: "downloaded",
      metadata_status: "failed",
      metadata_retry_count: 0,
      file_path: media,
      updated_at: "2020-01-01 00:00:00",
    });
    insertJob("metafail-nofile", {
      download_status: "downloaded",
      metadata_status: "failed",
      metadata_retry_count: 0,
      file_path: join(dir, "gone.mp4"),
      updated_at: "2020-01-01 00:00:00",
    });
    const config = testConfig({ requeueFailedAfterMinutes: 30 });
    const result = requeueFailedJobs(config);
    expect(result.conversions).toBe(1);
    expect(result.metadata).toBe(1); // the one whose file still exists
    expect(getJob("convfail").conversion_status).toBe("pending");
    expect(getJob("convfail").conversion_retry_count).toBe(0);
    expect(getJob("metafail").metadata_status).toBe("pending");
    expect(getJob("metafail").metadata_retry_count).toBe(0);
    expect(getJob("metafail-nofile").metadata_status).toBe("failed");
  });

  test("disabled when requeueFailedAfterMinutes is 0 (unless forced)", () => {
    insertJob("flaky", {
      download_status: "failed",
      last_error: "The read operation timed out",
      updated_at: "2020-01-01 00:00:00",
    });
    const config = testConfig({ requeueFailedAfterMinutes: 0 });
    expect(requeueFailedJobs(config).downloads).toBe(0);
    expect(requeueFailedJobs(config, { ignoreCooldown: true }).downloads).toBe(1);
  });
});

describe("findPartialFile & cleanOrphanedFiles", () => {
  test("finds the newest .part / .ytdl entry for a base name", async () => {
    const dir = await makeTmpDir();
    await mkdir(join(dir, "001 - Video.f137.mp4.part"), { recursive: true });
    await writeFile(join(dir, "001 - Video.mp4.part"), "partial");
    await writeFile(join(dir, "002 - Other.mp4.part"), "not ours");
    const found = await findPartialFile(dir, "001 - Video");
    // Either the .part file or the .ytdl fragment dir is acceptable — both are
    // resume points — but it must belong to this video, not another one.
    expect(found.startsWith(join(dir, "001 - Video."))).toBe(true);
    expect(found).not.toContain("002");
    expect(await findPartialFile(dir, "003 - Nothing")).toBe("");
  });

  test("keeps resume-able partials of retryable failed jobs", async () => {
    const dir = await makeTmpDir();
    const part = join(dir, "001 - Video.mp4.part");
    await writeFile(part, "partial");
    insertJob("v1", {
      download_status: "failed",
      retry_count: 1,
      partial_file_path: part,
      last_error: "The read operation timed out",
    });
    await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 3, maxFailuresPerVideo: 4 }));
    expect(existsSync(part)).toBe(true); // budget remains → keep for --continue
  });

  test("deletes partials of failed jobs whose budget is spent", async () => {
    const dir = await makeTmpDir();
    const part = join(dir, "001 - Video.mp4.part");
    await writeFile(part, "partial");
    insertJob("v1", { download_status: "failed", retry_count: 9, partial_file_path: part });
    await cleanOrphanedFiles(
      dir,
      testConfig({ maxRetryAttempts: 3, maxFailuresPerVideo: 4, requeueFailedAfterMinutes: 0 }),
    );
    expect(existsSync(part)).toBe(false);
  });

  test("deletes day-old orphan partials with no owning job", async () => {
    const dir = await makeTmpDir();
    const orphan = join(dir, "999 - Nobody.mp4.part");
    await writeFile(orphan, "orphan");
    // Backdate the file so it looks a day old.
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await Bun.write(orphan, "orphan");
    const { utimes } = await import("node:fs/promises");
    await utimes(orphan, past, past);
    await cleanOrphanedFiles(dir, testConfig());
    expect(existsSync(orphan)).toBe(false);
  });

  test("keeps fresh orphan partials (may be an in-flight download)", async () => {
    const dir = await makeTmpDir();
    const fresh = join(dir, "888 - InFlight.mp4.part");
    await writeFile(fresh, "fresh");
    await cleanOrphanedFiles(dir, testConfig());
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("ingestItems", () => {
  const config = () =>
    testConfig({
      outputRoot: "./downloads",
      skipShorts: true,
      downloadShorts: false,
      videoQuality: "1080p",
      writeInfoJson: true,
    });

  test("inserts new videos with canonical URLs and duration", async () => {
    const r = await ingestItems(
      [
        { id: "vid001", title: "One", playlist: "My Playlist", duration: 120 },
        { id: "vid002", title: "Two", playlist: "My Playlist", duration: 300 },
      ],
      config(),
    );
    expect(r).toEqual({ found: 2, added: 2, skipped: 0 });
    const job = getJob("vid001");
    expect(job.url).toBe("https://www.youtube.com/watch?v=vid001");
    expect(job.duration).toBe(120);
    expect(job.download_status).toBe("pending");
    expect(job.metadata_status).toBe("pending"); // writeInfoJson is on
    expect(job.conversion_status).toBe("not_needed"); // mp4 target
    expect(job["index"]).toBe(1);
    expect(getJob("vid002")["index"]).toBe(2);
  });

  test("dedupes on video id across scans", async () => {
    const c = config();
    await ingestItems([{ id: "vid001", title: "One", playlist: "P", duration: 120 }], c);
    const r = await ingestItems([{ id: "vid001", title: "One", playlist: "P", duration: 120 }], c);
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(1);
    expect(isVideoInDb("vid001")).toBe(true);
  });

  test("skips shorts but keeps long videos", async () => {
    const r = await ingestItems(
      [
        { id: "short1", title: "Short", playlist: "P", duration: 30 },
        { id: "long1", title: "Long", playlist: "P", duration: 600 },
      ],
      config(),
    );
    expect(r.added).toBe(1);
    expect(isVideoInDb("short1")).toBe(false);
    expect(isVideoInDb("long1")).toBe(true);
  });

  test("keeps shorts when downloadShorts is enabled", async () => {
    const c = { ...config(), downloadShorts: true };
    const r = await ingestItems([{ id: "short1", title: "Short", playlist: "P", duration: 30 }], c);
    expect(r.added).toBe(1);
  });

  test("requeues a waiting_live job when it reappears in a listing", async () => {
    const c = config();
    await ingestItems([{ id: "live1", title: "Live", playlist: "P", duration: 600 }], c);
    db.run("UPDATE jobs SET download_status = 'waiting_live' WHERE id = 'live1'");
    const r = await ingestItems([{ id: "live1", title: "Live", playlist: "P", duration: 600 }], c);
    expect(r.added).toBe(0);
    expect(getJob("live1").download_status).toBe("pending");
  });

  test("audio mode queues conversion work and targets mp3", async () => {
    const c = { ...config(), videoQuality: "audio" as const };
    await ingestItems([{ id: "aud1", title: "Audio", playlist: "P", duration: 200 }], c);
    const job = getJob("aud1");
    expect(job.target_format).toBe("mp3");
    expect(job.conversion_status).toBe("pending");
  });

  test("per-folder index numbering is independent", async () => {
    const c = config();
    await ingestItems([{ id: "a1", title: "A", playlist: "Playlist A", duration: 100 }], c);
    await ingestItems([{ id: "b1", title: "B", playlist: "Playlist B", duration: 100 }], c);
    await ingestItems([{ id: "a2", title: "A2", playlist: "Playlist A", duration: 100 }], c);
    expect(getJob("a1")["index"]).toBe(1);
    expect(getJob("b1")["index"]).toBe(1);
    expect(getJob("a2")["index"]).toBe(2);
    expect(getNextIndex("Playlist A")).toBe(3);
  });
});

describe("archive helpers", () => {
  test("removeFromArchive strips only the matching id", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, "archive.txt");
    await writeFile(file, "youtube aaa111\nyoutube bbb222\nyoutube ccc333\n");
    removeFromArchive(file, "bbb222");
    const text = await Bun.file(file).text();
    expect(text).toContain("aaa111");
    expect(text).not.toContain("bbb222");
    expect(text).toContain("ccc333");
  });

  test("removeFromArchive tolerates a missing file", () => {
    expect(() => removeFromArchive("/nonexistent/archive.txt", "x")).not.toThrow();
  });
});

describe("perVideoCap", () => {
  test("is the smaller of the two knobs", () => {
    expect(perVideoCap(testConfig({ maxRetryAttempts: 3, maxFailuresPerVideo: 4 }))).toBe(3);
    expect(perVideoCap(testConfig({ maxRetryAttempts: 5, maxFailuresPerVideo: 2 }))).toBe(2);
  });
});

// The three worker pools share one job row, so their claims must be mutually
// exclusive on the stage that owns the media file. Without this a download can
// start while the converter is mid-job — yt-dlp then writes (and finally
// replaces) the very file being converted, which is what operators see as
// "the file was deleted before conversion finished".
describe("pipeline claim exclusion", () => {
  test("a pending download is still claimed in the normal case", () => {
    insertJob("cx0", { download_status: "pending", conversion_status: "pending", metadata_status: "not_needed" });
    const job = claimDownloadJob("dl-1");
    expect(job?.id).toBe("cx0");
    expect(getJob("cx0").download_status).toBe("downloading");
  });

  test("no download claim while the converter owns the job", () => {
    insertJob("cx1", {
      download_status: "pending",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-1",
    });
    expect(claimDownloadJob("dl-1")).toBeNull();
    expect(getJob("cx1").download_status).toBe("pending");
  });

  test("no download claim while the metadata worker owns the job", () => {
    insertJob("cx2", { download_status: "pending", metadata_status: "in_progress" });
    expect(claimDownloadJob("dl-2")).toBeNull();
    expect(getJob("cx2").download_status).toBe("pending");
  });

  test("an interrupted job waiting on its converter is not re-downloaded", () => {
    // Guards the parenthesised OR: the exclusion must apply to BOTH the
    // pending branch and the paused/interrupted branch, not just the last one.
    insertJob("cx3", {
      download_status: "paused",
      pause_reason: "interrupted",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-3",
    });
    expect(claimDownloadJob("dl-3")).toBeNull();
    expect(getJob("cx3").download_status).toBe("paused");

    // Same shape without a live conversion: still claimable.
    insertJob("cx3b", { download_status: "paused", pause_reason: "interrupted" });
    expect(claimDownloadJob("dl-3")?.id).toBe("cx3b");
  });

  test("a user-paused job is never auto-claimed", () => {
    insertJob("cx3c", { download_status: "paused", pause_reason: "user" });
    expect(claimDownloadJob("dl-4")).toBeNull();
  });

  test("no metadata claim while the converter owns the job", () => {
    insertJob("cx4", {
      download_status: "downloaded",
      metadata_status: "pending",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-4",
    });
    expect(claimMetadataJob("md-1")).toBeNull();
    expect(getJob("cx4").metadata_status).toBe("pending");
  });

  test("metadata after a finished conversion is still claimable", () => {
    // requeueFailedJobs re-queues a failed metadata stage on jobs that already
    // converted — that path must keep working.
    insertJob("cx5", {
      download_status: "downloaded",
      metadata_status: "pending",
      conversion_status: "done",
    });
    expect(claimMetadataJob("md-2")?.id).toBe("cx5");
  });

  test("the converter still claims a finished download", () => {
    insertJob("cx6", {
      download_status: "downloaded",
      conversion_status: "pending",
      metadata_status: "done",
    });
    expect(claimConvertJob("cv-6")?.id).toBe("cx6");
  });
});
