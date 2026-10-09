// tests/download-resume-416.test.ts — the "stuck at 99% forever" recovery.
//
// An HTTP 416 for the saved partial's range (and aria2c's refusal to reuse a
// file whose control state is gone) means the RESUME can never complete: the
// bytes `--continue` asks for no longer exist on the server. Retrying with the
// same `.part` repeats the failure byte-for-byte, so the only recovery is to
// discard the partial pair and restart the transfer.
//
// These tests drive `handleDownloadFailure` directly — the classification, the
// on-disk removal (including the `.aria2` control file) and the exact job state
// the next attempt will see.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { claimDownloadJob, db, initDatabase, type Job } from "../src/db";
import { setPaused } from "../src/state";
import { handleDownloadFailure } from "../src/workers/download";
import { jobBaseFilename } from "../src/download-args";

const HTTP_416 =
  "ERROR: unable to download video data: HTTP Error 416: Requested range not satisfiable";
const ARIA2C_NO_CONTROL =
  "ERROR: aria2c exited with code 3: File 003 - video.mp4.part exists, but a control file(*.aria2) " +
  "does not exist. Download was canceled in order to prevent your file from being truncated to 0.";

const dirs: string[] = [];
let workerId = 1;

function testConfig(overrides: Partial<Config> = {}): Config {
  // Jitter on top of a 1s base keeps the handler's backoff sleep real but tiny.
  return { ...DEFAULT_CONFIG, retryBackoffBaseSeconds: 1, retryBackoffMaxSeconds: 1, ...overrides };
}

/**
 * A job in exactly the state a failed 99% download leaves behind: claimed and
 * `downloading`, its `.part` (+ aria2c control file) written by the worker's
 * own bookkeeping, progress and high-water mark equal (so nothing this attempt
 * did counts as forward motion).
 */
async function claimStuckJob(
  id: string,
  opts: { withPartial: boolean; partialInDb?: boolean; progress?: number } = { withPartial: true },
): Promise<{ job: Job; config: Config; part: string; control: string }> {
  const dir = await mkdtemp(join(tmpdir(), "yta-416-"));
  dirs.push(dir);
  const part = join(dir, `${jobBaseFilename({ index: 3, title: "video", id })}.f137.mp4.part`);
  const control = `${part}.aria2`;
  if (opts.withPartial) {
    await writeFile(part, "x".repeat(4096));
    await writeFile(control, "mock-control-file");
  }
  // Inserted as `pending` and then claimed for real, so the worker's snapshot
  // carries the live claim token exactly like production does.
  db.run(
    `INSERT INTO jobs (id, url, title, output_directory, "index", download_status, progress, best_progress,
       retry_count, resume_count, file_size, partial_file_path)
     VALUES (?, ?, ?, ?, 3, 'pending', ?, ?, 0, 0, 46137344, ?)`,
    [
      id,
      `https://www.youtube.com/watch?v=${id}`,
      "video",
      dir,
      opts.progress ?? 99,
      opts.progress ?? 99,
      opts.withPartial && opts.partialInDb !== false ? part : null,
    ],
  );
  const job = claimDownloadJob(`dl-${workerId++}`)!;
  if (opts.withPartial && opts.partialInDb === false) {
    db.run(`UPDATE jobs SET partial_file_path = NULL WHERE id = ?`, [id]);
  }
  return { job, config: testConfig(), part, control };
}

beforeEach(() => {
  initDatabase(":memory:");
  setPaused(false, null);
});

async function cleanupDirs(): Promise<void> {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true }).catch(() => {});
  }
}

describe("HTTP 416 / unrecoverable resume", () => {
  test("discards the .part WITH its aria2c control file and restarts the job", async () => {
    const id = "416-restart";
    const { job, config, part, control } = await claimStuckJob(id);
    try {
      await handleDownloadFailure(1, job, config, new Error(HTTP_416));

      // Both files: a stranded `.aria2` leaves aria2c unable to resume AND
      // unable to restart (--allow-overwrite=false), which wedges the job.
      expect(existsSync(part)).toBe(false);
      expect(existsSync(control)).toBe(false);

      const row = db
        .query(
          `SELECT download_status, retry_count, resume_count, partial_file_path, progress, best_progress,
                  speed, eta, last_error FROM jobs WHERE id = ?`,
        )
        .get(id) as any;
      // Re-queued for a fresh transfer, with the stale high-water mark gone:
      // 99% was reached with bytes the server no longer serves, and keeping it
      // would make every later attempt a "no progress" failure.
      expect(row.download_status).toBe("pending");
      expect(row.partial_file_path).toBeNull();
      expect(row.resume_count).toBe(0);
      expect(row.progress).toBe(0);
      expect(row.best_progress).toBe(0);
      expect(row.speed).toBe(0);
      expect(row.eta).toBe(0);
      expect(row.retry_count).toBe(1);
      expect(row.last_error).toContain("HTTP Error 416");
      // And it is claimable again right away.
      expect(claimDownloadJob("dl-next")?.id).toBe(id);
    } finally {
      await cleanupDirs();
    }
  });

  test("the recorded partial path is what gets discarded", async () => {
    // `partial_file_path` is authoritative when the file really is there — the
    // directory scan is only a fallback, and a fitted long-title name would not
    // match a scan built from the raw title.
    const id = "416-recorded";
    const { job, config, part, control } = await claimStuckJob(id);
    try {
      await handleDownloadFailure(2, job, config, new Error(HTTP_416));
      expect(existsSync(part)).toBe(false);
      expect(existsSync(control)).toBe(false);
      expect((db.query("SELECT partial_file_path FROM jobs WHERE id = ?").get(id) as any).partial_file_path).toBeNull();
    } finally {
      await cleanupDirs();
    }
  });

  test("aria2c's control-file refusal takes the same path", async () => {
    const id = "416-aria2c";
    const { job, config, part, control } = await claimStuckJob(id);
    try {
      await handleDownloadFailure(3, job, config, new Error(ARIA2C_NO_CONTROL));
      expect(existsSync(part)).toBe(false);
      expect(existsSync(control)).toBe(false);
      expect((db.query("SELECT download_status FROM jobs WHERE id = ?").get(id) as any).download_status).toBe(
        "pending",
      );
    } finally {
      await cleanupDirs();
    }
  });

  test("spends at most the no-progress budget, but never parks a broken partial", async () => {
    // Cap of 1: this attempt exhausts the budget and parks the job for the
    // cooldown sweep — after throwing the unusable resume state away, so the
    // retried video starts clean instead of failing 416 again.
    const id = "416-exhausted";
    const { job, config, part, control } = await claimStuckJob(id);
    try {
      await handleDownloadFailure(
        4,
        job,
        { ...config, maxRetryAttempts: 1, maxFailuresPerVideo: 1 },
        new Error(HTTP_416),
      );
      expect(existsSync(part)).toBe(false);
      expect(existsSync(control)).toBe(false);
      const row = db.query("SELECT download_status, partial_file_path FROM jobs WHERE id = ?").get(id) as any;
      expect(row.download_status).toBe("failed");
      expect(row.partial_file_path).toBeNull();
    } finally {
      await cleanupDirs();
    }
  });

  test("a 416 with nothing on disk just re-queues (no deletion, no wedge)", async () => {
    const id = "416-no-partial";
    const { job, config, part } = await claimStuckJob(id, { withPartial: false });
    try {
      await handleDownloadFailure(5, job, config, new Error(HTTP_416));
      expect(existsSync(part)).toBe(false);
      const row = db
        .query("SELECT download_status, retry_count, partial_file_path, last_error FROM jobs WHERE id = ?")
        .get(id) as any;
      expect(row.download_status).toBe("pending");
      expect(row.retry_count).toBe(1);
      expect(row.partial_file_path).toBeNull();
      expect(row.last_error).toContain("416");
    } finally {
      await cleanupDirs();
    }
  });

  test("a 416 with only a stranded control file sweeps it (no control-without-data wedge)", async () => {
    const id = "416-stranded-control";
    const { job, config, part, control } = await claimStuckJob(id, { withPartial: false });
    try {
      // A hand-deleted or AV-truncated .part leaves its .aria2 behind: aria2c
      // would refuse both to resume and to restart, so the 416 branch must not
      // hand the job back with that litter still in place.
      await writeFile(control, "mock-control-file");
      await handleDownloadFailure(5, job, config, new Error(HTTP_416));
      expect(existsSync(part)).toBe(false);
      expect(existsSync(control)).toBe(false);
    } finally {
      await cleanupDirs();
    }
  });

  test("a corrupt-resume with only a stranded control file sweeps it before restarting", async () => {
    const id = "corrupt-stranded-control";
    const { job, config, part, control } = await claimStuckJob(id, { withPartial: false });
    try {
      await writeFile(control, "mock-control-file");
      await handleDownloadFailure(
        5,
        job,
        config,
        new Error("ERROR: unable to resume: the server truncated the response"),
      );
      expect(existsSync(part)).toBe(false);
      expect(existsSync(control)).toBe(false);
    } finally {
      await cleanupDirs();
    }
  });

  test("a corrupt-resume error KEEPS the partial (the 416 branch is not a catch-all)", async () => {
    // The neighbouring class must not change: an "unable to resume / corrupt"
    // tail gets bounded resume attempts before the partial is discarded.
    const id = "corrupt-keeps-partial";
    const { job, config, part, control } = await claimStuckJob(id);
    try {
      await handleDownloadFailure(6, job, config, new Error("ERROR: unable to resume download, incomplete or corrupt data"));
      expect(existsSync(part)).toBe(true);
      expect(existsSync(control)).toBe(true);
      const row = db.query("SELECT download_status, resume_count, partial_file_path FROM jobs WHERE id = ?").get(id) as any;
      expect(row.download_status).toBe("pending");
      expect(row.resume_count).toBe(1);
      expect(row.partial_file_path).toBe(part);
    } finally {
      await cleanupDirs();
    }
  });

  test("a lost claim writes nothing over the new owner's row", async () => {
    const id = "416-lost-claim";
    const { job, config, part, control } = await claimStuckJob(id);
    try {
      // Another engine took the job over while this worker was transferring.
      db.run(`UPDATE jobs SET download_claim_token = 'other' WHERE id = ?`, [id]);
      await handleDownloadFailure(7, job, config, new Error(HTTP_416));
      // The unusable resume state is still discarded — that is exactly what the
      // new owner needs, and the file is not job state the CAS guards.
      expect(existsSync(part)).toBe(false);
      expect(existsSync(control)).toBe(false);
      // But the ROW is left to its owner: no status flip, no progress reset, no
      // error text overwriting a live download.
      const row = db
        .query("SELECT download_status, progress, best_progress, last_error, download_claim_token FROM jobs WHERE id = ?")
        .get(id) as any;
      expect(row.download_status).toBe("downloading");
      expect(row.progress).toBe(99);
      expect(row.best_progress).toBe(99);
      expect(row.last_error).toBeNull();
      expect(row.download_claim_token).toBe("other");
    } finally {
      await cleanupDirs();
    }
  });

});
