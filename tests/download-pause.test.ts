import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { db, initDatabase, type Job } from "../src/db";
import { setPaused } from "../src/state";
import { handleDownloadFailure, recordSuccess } from "../src/workers/download";
import { join } from "node:path";
import { tmpdir } from "node:os";

beforeEach(() => {
  initDatabase(":memory:");
  setPaused(false, null);
});

function insertUserPausedJob(id: string): void {
  db.run(
    `INSERT INTO jobs (id, title, output_directory, "index", download_status, pause_reason, download_claimed_by)
     VALUES (?, ?, ?, 1, 'paused', 'user', 'dl-1')`,
    [id, `Video ${id}`, join(tmpdir(), `yta-pause-missing-${id}`)],
  );
}

function staleJobSnapshot(id: string): Job {
  return {
    id,
    title: `Video ${id}`,
    output_directory: join(tmpdir(), `yta-pause-missing-${id}`),
    index: 1,
    // The worker's claimed Job can predate the user's pause; the persisted row
    // is authoritative when the completion/failure handler runs.
    pause_reason: null,
  } as Job;
}

describe("per-job user pause preservation", () => {
  test("a download failure keeps a persisted user pause instead of re-queueing", async () => {
    const id = "paused-failure";
    insertUserPausedJob(id);

    await handleDownloadFailure(1, staleJobSnapshot(id), DEFAULT_CONFIG, new Error("network reset"));

    const row = db
      .query("SELECT download_status, pause_reason, download_claimed_by FROM jobs WHERE id = ?")
      .get(id) as any;
    expect(row).toEqual({ download_status: "paused", pause_reason: "user", download_claimed_by: null });
  });

  test("successful output is recorded without advancing a user-paused job", () => {
    const id = "paused-success";
    insertUserPausedJob(id);

    const stayedPaused = recordSuccess(id, "/tmp/complete-video.mp4", 1234);

    const row = db
      .query("SELECT download_status, pause_reason, file_path, file_size, partial_file_path, download_claimed_by FROM jobs WHERE id = ?")
      .get(id) as any;
    expect(stayedPaused).toBe(true);
    expect(row).toEqual({
      download_status: "paused",
      pause_reason: "user",
      file_path: "/tmp/complete-video.mp4",
      file_size: 1234,
      partial_file_path: null,
      download_claimed_by: null,
    });
  });
});
