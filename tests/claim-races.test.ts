// tests/claim-races.test.ts — claim ownership across separate connections and
// separate processes.
//
// The claim statements are single atomic UPDATEs, and that is the whole point:
// a sequential "worker 1 claims, worker 2 claims" test on ONE handle would also
// pass if the implementation were a read-then-write with a lucky interleaving.
// These tests therefore use
//
//   • two connections to the same FILE-BACKED database (each `initDatabase()`
//     call opens a new handle), and
//   • real child processes (`tests/fixtures/claim-worker.ts`) that claim, reap,
//     heartbeat and write through the engine's own code,
//
// and cover the races the reliability story depends on:
//   - simultaneous claims of one job;
//   - a crashed owner reclaimed only after its claim lease expires;
//   - a stale worker whose claim was taken over (its writes must not land);
//   - a long-running, heartbeating conversion that must not be reaped;
//   - two reapers racing the same expired claim (one CAS wins).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  claimConvertJob,
  claimDownloadJob,
  claimMetadataJob,
  db,
  initDatabase,
  releaseClaimedJob,
  updateClaimedJob,
} from "../src/db";
import { acquireEngineLease } from "../src/lease";
import { reapStaleClaim, reapStaleClaims } from "../src/reconcile";
import { DEFAULT_CONFIG, type Config } from "../src/config";

const FIXTURE = join(import.meta.dir, "fixtures", "claim-worker.ts");
const tmpDirs: string[] = [];

/**
 * Budget for the out-of-process tests.
 *
 * The default 5 s is a stopwatch on *spawning*, not on correctness: each test
 * starts two or three real `bun run` processes, and the drain test has them
 * write to one SQLite file several hundred times (three workers × 400 claim
 * attempts over 40 jobs). That costs ~0.7 s here and well over 5 s on a Windows
 * box whose write path runs through a virus scanner — where the drain test used
 * to report a bare "timed out after 5000ms" with none of its own assertions
 * having run. Atomicity is what these tests are for, so give the processes room
 * instead of trimming the work.
 */
const TEST_TIMEOUT = 60_000;

afterAll(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});

async function makeDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yta-race-"));
  tmpDirs.push(dir);
  return join(dir, "archive.db");
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Insert a job row directly, bypassing the scanner. */
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
  db.run(
    `INSERT INTO jobs (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    Object.values(row) as any[],
  );
}

function jobRow(id: string): any {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id);
}

interface FixtureWorker {
  proc: Subprocess;
  lines: string[];
  waitForLine: (prefix: string, timeoutMs?: number) => Promise<string>;
  done: () => Promise<string[]>;
}

/** Spawn the out-of-process fixture and collect its machine-readable lines. */
function spawnWorker(args: string[]): FixtureWorker {
  const proc = Bun.spawn([process.execPath, "run", FIXTURE, ...args], { stdout: "pipe", stderr: "pipe" });
  const lines: string[] = [];
  const errors: string[] = [];
  let pending = "";
  const pump = async (stream: ReadableStream<Uint8Array>, collect: (chunk: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        collect(decoder.decode(value, { stream: true }));
      }
    } catch {
      // process exited
    }
  };
  void pump(proc.stdout, (chunk) => {
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
  });
  void pump(proc.stderr, (chunk) => errors.push(chunk));

  return {
    proc,
    lines,
    waitForLine: async (prefix: string, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = lines.find((l) => l.startsWith(prefix));
        if (found) return found;
        if (proc.exitCode !== null) break;
        await Bun.sleep(20);
      }
      throw new Error(`timed out waiting for "${prefix}"\nOUT: ${lines.join("\n")}\nERR: ${errors.join("")}`);
    },
    done: async () => {
      await proc.exited;
      return lines;
    },
  };
}

/** `CLAIMED <id> <token>` lines → [{ id, token, worker }]. */
function parseClaims(workers: { lines: string[]; workerId: string }[]): { id: string; token: string; worker: string }[] {
  const claims: { id: string; token: string; worker: string }[] = [];
  for (const w of workers) {
    for (const line of w.lines) {
      if (!line.startsWith("CLAIMED ")) continue;
      const [, id, token] = line.split(" ");
      claims.push({ id, token, worker: w.workerId });
    }
  }
  return claims;
}

/** Backdate a claim so its lease has expired (what the reaper acts on). */
function expireClaim(id: string, stage: "download" | "conversion" | "metadata"): void {
  const columns =
    stage === "download"
      ? `download_claimed_at = '2020-01-01 00:00:00', download_heartbeat_at = '2020-01-01 00:00:00'`
      : stage === "conversion"
        ? `conversion_claimed_at = '2020-01-01 00:00:00', conversion_heartbeat_at = '2020-01-01 00:00:00'`
        : `metadata_claimed_at = '2020-01-01 00:00:00', metadata_heartbeat_at = '2020-01-01 00:00:00'`;
  db.run(`UPDATE jobs SET ${columns} WHERE id = ?`, [id]);
}

beforeEach(async () => {
  initDatabase(await makeDbPath());
  // The parent plays the engine: the reaper only runs for the lease owner.
  acquireEngineLease();
});

describe("claims across separate SQLite connections", () => {
  test("a second connection cannot re-claim a job the first connection claimed", () => {
    insertJob("solo");
    const first = claimDownloadJob("dl-a");
    expect(first?.id).toBe("solo");
    expect(first?.download_claim_token).toBeTruthy();

    // A NEW handle on the same file (what a second worker process opens).
    const filename = (db as unknown as { filename: string }).filename;
    initDatabase(filename);

    expect(claimDownloadJob("dl-b")).toBeNull();
    const row = jobRow("solo");
    expect(row.download_claimed_by).toBe("dl-a");
    expect(row.download_claim_token).toBe(first?.download_claim_token);
  });

  test("a metadata claim records its owner, timestamp, token and heartbeat", () => {
    insertJob("meta", { download_status: "downloaded", metadata_status: "pending" });
    const job = claimMetadataJob("md-a");

    expect(job?.metadata_status).toBe("in_progress");
    expect(job?.metadata_claimed_by).toBe("md-a");
    expect(job?.metadata_claimed_at).toBeTruthy();
    expect(job?.metadata_claim_token).toBeTruthy();
    expect(job?.metadata_heartbeat_at).toBeTruthy();
  });
});

describe("claims across separate processes", () => {
  test("simultaneous claims for one job: exactly one process wins", async () => {
    const path = (db as unknown as { filename: string }).filename;
    insertJob("contested");

    const workers = ["p1", "p2", "p3"].map((workerId) => {
      const handle = spawnWorker(["claim-loop", path, workerId, "120", "3"]);
      return { workerId, ...handle };
    });
    for (const w of workers) await w.done();

    const claims = parseClaims(workers);
    const winners = claims.filter((c) => c.id === "contested");
    expect(winners).toHaveLength(1);
    expect(jobRow("contested").download_claim_token).toBe(winners[0].token);
  }, TEST_TIMEOUT);

  test("three processes draining a queue never claim the same job twice", async () => {
    const path = (db as unknown as { filename: string }).filename;
    const total = 40;
    for (let i = 0; i < total; i++) insertJob(`job-${String(i).padStart(3, "0")}`);

    const workers = ["w1", "w2", "w3"].map((workerId) => {
      const handle = spawnWorker(["claim-loop", path, workerId, "400", "1"]);
      return { workerId, ...handle };
    });
    for (const w of workers) await w.done();

    const claims = parseClaims(workers);
    // Every job claimed exactly once...
    expect(claims).toHaveLength(total);
    const ids = claims.map((c) => c.id);
    expect(new Set(ids).size).toBe(total);
    // ...with a unique token per claim, and each token is the one persisted on
    // its row (no worker's claim silently overwrote another's).
    const tokens = claims.map((c) => c.token);
    expect(new Set(tokens).size).toBe(total);
    for (const claim of claims) {
      const row = jobRow(claim.id);
      expect(row.download_status).toBe("downloading");
      expect(row.download_claimed_by).toBe(claim.worker);
      expect(row.download_claim_token).toBe(claim.token);
    }
    expect(claimDownloadJob("late")).toBeNull();
  }, TEST_TIMEOUT);

  test("a crashed owner is reclaimed only after its claim lease expires", async () => {
    const path = (db as unknown as { filename: string }).filename;
    insertJob("crashed");

    // A worker claims the job and dies (no release, no graceful shutdown).
    const worker = spawnWorker(["claim-and-die", path, "dl-crashed"]);
    const [claimLine] = await worker.done();
    const [, claimedId, token] = claimLine.split(" ");
    expect(claimedId).toBe("crashed");

    // Its heartbeat is fresh: the reaper must leave the claim alone.
    let summary = await reapStaleClaims(testConfig());
    expect(summary.downloads).toBe(0);
    expect(jobRow("crashed").download_status).toBe("downloading");
    expect(jobRow("crashed").download_claim_token).toBe(token);

    // The lease lapses (nothing renewed it because the owner is gone).
    expireClaim("crashed", "download");
    summary = await reapStaleClaims(testConfig());

    expect(summary.downloads).toBe(1);
    const row = jobRow("crashed");
    expect(row.download_status).toBe("paused");
    expect(row.pause_reason).toBe("interrupted");
    expect(row.download_claimed_by).toBeNull();
    expect(row.download_claim_token).toBeNull();
    // And the job is immediately claimable again.
    expect(claimDownloadJob("dl-next")?.id).toBe("crashed");
  }, TEST_TIMEOUT);

  test("a stale worker cannot update progress or release after its claim was taken", async () => {
    const path = (db as unknown as { filename: string }).filename;
    insertJob("taken");
    const stale = claimDownloadJob("dl-stale")!;
    const staleToken = stale.download_claim_token!;
    expireClaim("taken", "download");

    // Another process reaps the expired claim and claims the job for itself.
    const taker = spawnWorker(["reap-then-claim", path, "taken", "dl-stale", staleToken, "-20 minutes", "dl-fresh"]);
    const lines = await taker.done();
    expect(lines).toContain("REAP true");
    const claimedLine = lines.find((l) => l.startsWith("CLAIMED "))!;
    const freshToken = claimedLine.split(" ")[2];
    expect(freshToken).not.toBe(staleToken);

    // The stale worker's late writes: a progress update (this process) and a
    // release (the other process) — neither may land.
    expect(
      updateClaimedJob("download", "taken", { by: "dl-stale", token: staleToken }, "progress = 42", [], `download_status = 'downloading'`),
    ).toBe(0);
    expect(releaseClaimedJob("download", "taken", { by: "dl-stale", token: staleToken }, `download_status = 'pending'`)).toBe(0);
    const staleWriter = spawnWorker(["stale-update", path, "taken", "dl-stale", staleToken, "77"]);
    const writerLines = await staleWriter.done();
    expect(writerLines).toContain("UPDATE 0");

    const row = jobRow("taken");
    expect(row.download_status).toBe("downloading");
    expect(row.download_claimed_by).toBe("dl-fresh");
    expect(row.download_claim_token).toBe(freshToken);
    expect(row.progress).toBe(0);
  }, TEST_TIMEOUT);

  test("a long-running, heartbeating conversion is never reaped", async () => {
    const path = (db as unknown as { filename: string }).filename;
    insertJob("long-convert", {
      download_status: "downloaded",
      conversion_status: "pending",
      metadata_status: "done",
      file_path: join(tmpdir(), "yta-race-media.mp4"),
      conversion_claimed_at: "2020-01-01 00:00:00",
      conversion_heartbeat_at: "2020-01-01 00:00:00",
    });

    // A converter that has been running for "hours" and keeps its lease alive.
    const converter = spawnWorker(["convert-heartbeat", path, "cv-live", "1200", "100"]);
    const claimLine = await converter.waitForLine("CLAIMED ");
    const [, id, token] = claimLine.split(" ");
    expect(id).toBe("long-convert");
    expect(token).not.toBe("-");

    await Bun.sleep(350); // let at least two heartbeats land
    const during = await reapStaleClaims(testConfig());
    expect(during.conversions).toBe(0);
    let row = jobRow("long-convert");
    expect(row.conversion_status).toBe("in_progress");
    expect(row.conversion_claim_token).toBe(token);
    expect(row.conversion_heartbeat_at > "2020-01-01 00:00:00").toBe(true);

    await converter.done();

    // The converter is gone and its lease has lapsed: now the reaper acts.
    expireClaim("long-convert", "conversion");
    const after = await reapStaleClaims(testConfig());
    expect(after.conversions).toBe(1);
    row = jobRow("long-convert");
    expect(row.conversion_status).toBe("pending");
    expect(row.conversion_claim_token).toBeNull();
  }, TEST_TIMEOUT);

  test("metadata is reaped on its heartbeat, not on updated_at", async () => {
    insertJob("meta-heartbeat", {
      download_status: "downloaded",
      metadata_status: "pending",
      file_path: join(tmpdir(), "yta-race-meta.mp4"),
    });
    const job = claimMetadataJob("md-1")!;
    expect(job.metadata_claim_token).toBeTruthy();

    // An unrelated writer bumps updated_at long ago — the old stale signal.
    db.run("UPDATE jobs SET updated_at = '2020-01-01 00:00:00' WHERE id = ?", ["meta-heartbeat"]);
    expect((await reapStaleClaims(testConfig())).metadata).toBe(0);
    expect(jobRow("meta-heartbeat").metadata_status).toBe("in_progress");

    // The heartbeat is what matters.
    expireClaim("meta-heartbeat", "metadata");
    expect((await reapStaleClaims(testConfig())).metadata).toBe(1);
    const row = jobRow("meta-heartbeat");
    expect(row.metadata_status).toBe("pending");
    expect(row.metadata_claim_token).toBeNull();
    expect(row.metadata_claimed_at).toBeNull();
  }, TEST_TIMEOUT);

  test("two reapers racing the same expired claim: the first CAS wins", async () => {
    const path = (db as unknown as { filename: string }).filename;
    insertJob("race-reap");
    const job = claimDownloadJob("dl-owner")!;
    const token = job.download_claim_token!;
    expireClaim("race-reap", "download");

    // Reaper 1 (another process) waits, then attempts the CAS with the snapshot
    // it took before this test started reaping.
    const otherReaper = spawnWorker(["reap", path, "race-reap", "dl-owner", token, "-20 minutes", "250"]);
    // Reaper 2 (this process) gets there first.
    expect(reapStaleClaim("download", "race-reap", { by: "dl-owner", token }, "-20 minutes")).toBe(true);

    const lines = await otherReaper.done();
    expect(lines).toContain("REAP false"); // it must NOT reset the job again

    const row = jobRow("race-reap");
    expect(row.download_status).toBe("paused");
    expect(row.pause_reason).toBe("interrupted");
    expect(row.download_claim_token).toBeNull();
  }, TEST_TIMEOUT);

  test("a second reaper's CAS is refused after the claim was re-claimed", async () => {
    const path = (db as unknown as { filename: string }).filename;
    insertJob("race-reclaim");
    const job = claimDownloadJob("dl-old")!;
    const oldToken = job.download_claim_token!;
    expireClaim("race-reclaim", "download");

    // A reaper re-queues it and a fresh worker claims it again.
    const taker = spawnWorker(["reap-then-claim", path, "race-reclaim", "dl-old", oldToken, "-20 minutes", "dl-new"]);
    const lines = await taker.done();
    expect(lines).toContain("REAP true");

    // A reaper still holding the OLD snapshot must not reset the new claim.
    expect(reapStaleClaim("download", "race-reclaim", { by: "dl-old", token: oldToken }, "-20 minutes")).toBe(false);
    const row = jobRow("race-reclaim");
    expect(row.download_status).toBe("downloading");
    expect(row.download_claimed_by).toBe("dl-new");
    expect(row.download_claim_token).toBe(lines.find((l) => l.startsWith("CLAIMED "))!.split(" ")[2]);
  }, TEST_TIMEOUT);
});
