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

/**
 * A user-paused job that still holds its download claim (the legacy state a
 * dashboard pause of an in-flight download leaves behind). Since claims now
 * carry a unique token, the row and the worker's claim snapshot must agree on
 * it — the same way a real `claimDownloadJob` snapshot does.
 */
const HELD_TOKEN = "claim-token-paused";

function insertUserPausedJob(id: string): void {
  db.run(
    `INSERT INTO jobs (id, title, output_directory, "index", download_status, pause_reason,
       download_claimed_by, download_claimed_at, download_claim_token, download_heartbeat_at)
     VALUES (?, ?, ?, 1, 'paused', 'user', 'dl-1', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
    [id, `Video ${id}`, join(tmpdir(), `yta-pause-missing-${id}`), HELD_TOKEN],
  );
}

/** The claim snapshot a worker holds for the id above. */
function staleJobSnapshot(id: string): Job {
  return {
    id,
    title: `Video ${id}`,
    output_directory: join(tmpdir(), `yta-pause-missing-${id}`),
    index: 1,
    // The worker's claimed Job can predate the user's pause; the persisted row
    // is authoritative when the completion/failure handler runs.
    pause_reason: null,
    download_claimed_by: "dl-1",
    download_claim_token: HELD_TOKEN,
  } as Job;
}

describe("per-job user pause preservation", () => {
  test("a download failure keeps a persisted user pause instead of re-queueing", async () => {
    const id = "paused-failure";
    insertUserPausedJob(id);

    await handleDownloadFailure(1, staleJobSnapshot(id), DEFAULT_CONFIG, new Error("network reset"));

    const row = db
      .query("SELECT download_status, pause_reason, download_claimed_by, download_claim_token FROM jobs WHERE id = ?")
      .get(id) as any;
    expect(row).toEqual({
      download_status: "paused",
      pause_reason: "user",
      download_claimed_by: null,
      download_claim_token: null,
    });
  });

  test("successful output is recorded without advancing a user-paused job", () => {
    const id = "paused-success";
    insertUserPausedJob(id);

    const recorded = recordSuccess(staleJobSnapshot(id), "/tmp/complete-video.mp4", 1234);

    const row = db
      .query(
        "SELECT download_status, pause_reason, file_path, file_size, partial_file_path, download_claimed_by, download_claim_token FROM jobs WHERE id = ?",
      )
      .get(id) as any;
    expect(recorded.lostClaim).toBe(false);
    expect(recorded.stayedPaused).toBe(true);
    expect(row).toEqual({
      download_status: "paused",
      pause_reason: "user",
      file_path: "/tmp/complete-video.mp4",
      file_size: 1234,
      partial_file_path: null,
      download_claimed_by: null,
      download_claim_token: null,
    });
  });

  test("a worker whose claim was taken over records nothing", () => {
    const id = "claim-taken";
    insertUserPausedJob(id);
    // The reaper re-queued it (claim cleared) and another worker claimed it.
    db.run(
      `UPDATE jobs SET download_status = 'downloading', pause_reason = NULL,
         download_claimed_by = 'dl-2', download_claim_token = 'other-token',
         download_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id],
    );

    const recorded = recordSuccess(staleJobSnapshot(id), "/tmp/stale.mp4", 1);

    expect(recorded.lostClaim).toBe(true);
    const row = db
      .query("SELECT download_status, file_path, download_claimed_by, download_claim_token FROM jobs WHERE id = ?")
      .get(id) as any;
    expect(row.download_status).toBe("downloading");
    expect(row.file_path).toBeNull();
    expect(row.download_claimed_by).toBe("dl-2");
    expect(row.download_claim_token).toBe("other-token");
  });
});
