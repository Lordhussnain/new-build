import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { claimDownloadJob, db, initDatabase } from "../src/db";
import { getPauseReason, isPaused, setPaused } from "../src/state";
import { handleDownloadFailure } from "../src/workers/download";

let tempDir = "";

beforeEach(async () => {
  initDatabase(":memory:");
  setPaused(false, null);
  tempDir = await mkdtemp(join(tmpdir(), "yta-disk-full-"));
});

afterEach(async () => {
  setPaused(false, null);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("download disk-exhaustion handling", () => {
  test("pauses globally, parks the claimed job, and preserves its partial without spending retries", async () => {
    const partial = join(tempDir, "001 - Disk video [diskfull1].f137.mp4.part");
    await writeFile(partial, "resumable bytes");
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, "index", download_status,
         partial_file_path, retry_count, progress, best_progress)
       VALUES ('diskfull1', 'https://www.youtube.com/watch?v=diskfull1', 'Disk video', ?, 1,
         'pending', ?, 0, 42, 42)`,
      [tempDir, partial],
    );
    const job = claimDownloadJob("dl-1");
    expect(job).toBeTruthy();

    await handleDownloadFailure(
      1,
      job!,
      DEFAULT_CONFIG,
      new Error("ERROR: unable to write video data: [Errno 28] No space left on device"),
    );

    const row = db
      .query("SELECT download_status, pause_reason, retry_count, partial_file_path, last_error FROM jobs WHERE id = ?")
      .get("diskfull1") as any;
    expect(row.download_status).toBe("paused");
    expect(row.pause_reason).toBe("interrupted");
    expect(row.retry_count).toBe(0);
    expect(row.partial_file_path).toBe(partial);
    expect(row.last_error).toContain("Storage exhausted");
    expect(row.last_error).toContain("No space left on device");
    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toContain("LOW_DISK_SPACE");
  });
});
