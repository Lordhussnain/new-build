// tests/engine-lease.test.ts — the database-level engine lease.
//
// The web port only keeps two engines apart when they were configured with the
// SAME port. The lease is what actually owns `archive.db`: an owner token, a
// heartbeat with an expiry, and a monotonic fencing number, acquired in one
// short write transaction before any startup sweep. These tests pin the
// semantics the engine relies on:
//
//   • a live owner refuses every other acquisition (including another process);
//   • an expired lease — or one whose owning process is gone — is taken over
//     with `fencing + 1`, so the previous generation is identifiable;
//   • renewal fails once someone else owns it (the signal to stop claiming);
//   • graceful release frees the database for the next start;
//   • the sweeps that rewrite job state refuse to run without the lease.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { db, initDatabase } from "../src/db";
import {
  acquireEngineLease,
  describeEngineLease,
  holdsEngineLease,
  isLeaseExpired,
  leaseOwnerIsDead,
  readEngineLease,
  releaseEngineLease,
  renewEngineLease,
  startEngineLeaseHeartbeat,
} from "../src/lease";
import { reapStaleClaims, reconcileCrashedJobs } from "../src/reconcile";
import { DEFAULT_CONFIG, type Config } from "../src/config";

const FIXTURE = join(import.meta.dir, "fixtures", "claim-worker.ts");

const tmpDirs: string[] = [];

afterAll(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});

async function makeDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yta-lease-"));
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

/** Spawn the out-of-process fixture and collect its machine-readable output. */
function spawnWorker(args: string[]): {
  proc: Subprocess;
  lines: string[];
  waitForLine: (prefix: string, timeoutMs?: number) => Promise<string>;
  done: () => Promise<string[]>;
} {
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
      // process exited — stop reading
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
        await Bun.sleep(25);
      }
      throw new Error(`timed out waiting for "${prefix}"\nOUT: ${lines.join("\n")}\nERR: ${errors.join("")}`);
    },
    done: async () => {
      await proc.exited;
      return lines;
    },
  };
}

/** Overwrite the lease row as if another process owned it. */
function writeForeignLease(opts: {
  owner?: string | null;
  fencing?: number;
  pid?: number | null;
  host?: string | null;
  expiresInSeconds: number;
}): void {
  db.run("DELETE FROM engine_lease WHERE id = 1");
  db.run(
    `INSERT INTO engine_lease (id, owner, fencing, pid, host, acquired_at, heartbeat_at, expires_at)
     VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, datetime('now', ?))`,
    [
      opts.owner ?? null,
      opts.fencing ?? 4,
      opts.pid ?? null,
      opts.host ?? null,
      `${opts.expiresInSeconds >= 0 ? "+" : ""}${opts.expiresInSeconds} seconds`,
    ],
  );
}

beforeEach(async () => {
  // Every test works on its own file-backed database: the lease is shared state
  // between CONNECTIONS, which is exactly what `:memory:` cannot express.
  initDatabase(await makeDb());
});

describe("engine lease: acquisition", () => {
  test("first acquisition takes the free row with fencing 1", () => {
    const result = acquireEngineLease();
    expect(result.acquired).toBe(true);
    expect(result.tookOver).toBe(false);
    expect(result.lease?.fencing).toBe(1);
    expect(result.lease?.owner).toBeTruthy();
    expect(result.lease?.pid).toBe(process.pid);
    expect(holdsEngineLease()).toBe(true);
  });

  test("re-acquiring from the same process renews instead of bumping the fencing", () => {
    const first = acquireEngineLease();
    const second = acquireEngineLease();
    expect(second.acquired).toBe(true);
    expect(second.lease?.owner).toBe(first.lease?.owner);
    expect(second.lease?.fencing).toBe(first.lease?.fencing);
  });

  test("an expired lease is taken over with fencing + 1", () => {
    writeForeignLease({ owner: "other-host:111:abcd1234", fencing: 7, pid: process.pid, host: hostname(), expiresInSeconds: -60 });
    const previous = readEngineLease();
    expect(isLeaseExpired(previous)).toBe(true);

    const result = acquireEngineLease();

    expect(result.acquired).toBe(true);
    expect(result.tookOver).toBe(true);
    expect(result.lease?.fencing).toBe(8);
    expect(holdsEngineLease()).toBe(true);
  });

  test("a lease whose owning process is gone is taken over immediately (hard kill)", () => {
    // The row looks perfectly live (expires in 10 minutes) — but the process
    // that wrote it no longer exists, which is what a SIGKILL leaves behind.
    writeForeignLease({ owner: "crashed:999999:beef", fencing: 3, pid: 999_999, host: hostname(), expiresInSeconds: 600 });
    const previous = readEngineLease();
    expect(isLeaseExpired(previous)).toBe(false);
    expect(leaseOwnerIsDead(previous)).toBe(true);
    expect(describeEngineLease(previous)).toContain("expired");

    const result = acquireEngineLease();

    expect(result.acquired).toBe(true);
    expect(result.tookOver).toBe(true);
    expect(result.lease?.fencing).toBe(4);
  });

  test("a foreign lease on another host is only taken over after it expires", () => {
    // Liveness cannot be probed across machines, so the expiry is the only
    // signal left — the conservative behaviour.
    writeForeignLease({ owner: "elsewhere:5:1234", fencing: 2, pid: 5, host: "some-other-machine", expiresInSeconds: 600 });
    expect(leaseOwnerIsDead(readEngineLease())).toBe(false);
    expect(acquireEngineLease().acquired).toBe(false);
  });

  test("a live owner in another PROCESS refuses acquisition", async () => {
    const path = (db as unknown as { filename: string }).filename;
    const holder = spawnWorker(["lease", path, "1500", "release"]);
    const line = await holder.waitForLine("LEASE");
    const held = JSON.parse(line.slice("LEASE ".length));

    expect(held.acquired).toBe(true);
    expect(held.fencing).toBe(1);

    // A second connection (and a second process) over the same file.
    initDatabase(path);
    const refused = acquireEngineLease();
    expect(refused.acquired).toBe(false);
    expect(refused.lease?.owner).toBe(held.owner);
    expect(refused.lease?.fencing).toBe(1); // untouched: refusals never write
    expect(holdsEngineLease()).toBe(false);

    await holder.done();
    // The holder released on the way out, so the same database is free again.
    const after = acquireEngineLease();
    expect(after.acquired).toBe(true);
    expect(after.lease?.fencing).toBe(2);
  });
});

describe("engine lease: renewal, fencing and release", () => {
  test("renewal extends the expiry and keeps the generation", () => {
    const acquired = acquireEngineLease();
    db.run("UPDATE engine_lease SET expires_at = datetime('now', '+1 seconds') WHERE id = 1");
    expect(renewEngineLease()).toBe(true);
    const renewed = readEngineLease();
    expect(renewed?.owner).toBe(acquired.lease?.owner);
    expect(renewed?.fencing).toBe(acquired.lease?.fencing);
    expect(Date.parse(`${renewed?.expiresAt?.replace(" ", "T")}Z`)).toBeGreaterThan(Date.now());
  });

  test("renewal is refused once another engine owns the lease", () => {
    acquireEngineLease();
    // Someone else took over (we were stalled past the expiry).
    db.run(
      `UPDATE engine_lease SET owner = 'usurper:1:ff', pid = ?, host = ?,
         fencing = fencing + 1, expires_at = datetime('now', '+5 minutes') WHERE id = 1`,
      [process.pid, hostname()],
    );
    expect(renewEngineLease()).toBe(false);
    expect(holdsEngineLease()).toBe(false);
  });

  test("the lease heartbeat reports loss after consecutive failed renewals", async () => {
    acquireEngineLease();
    let lost = 0;
    const stop = startEngineLeaseHeartbeat({ renewMs: 30, onLost: () => lost++ });
    try {
      db.run(
        `UPDATE engine_lease SET owner = 'usurper:1:ff', pid = ?, host = ?,
           fencing = fencing + 1, expires_at = datetime('now', '+5 minutes') WHERE id = 1`,
        [process.pid, hostname()],
      );
      const deadline = Date.now() + 3000;
      while (lost === 0 && Date.now() < deadline) await Bun.sleep(20);
    } finally {
      stop();
    }
    expect(lost).toBe(1);
  });

  test("graceful release frees the row and a clean restart re-acquires it", () => {
    const first = acquireEngineLease();
    expect(releaseEngineLease()).toBe(true);
    const released = readEngineLease();
    expect(released?.owner).toBeNull();
    expect(released?.fencing).toBe(first.lease?.fencing); // the counter survives
    expect(isLeaseExpired(released)).toBe(true);

    const second = acquireEngineLease();
    expect(second.acquired).toBe(true);
    expect(second.tookOver).toBe(false); // a released row is free, not "taken over"
    expect(second.lease?.fencing).toBe((first.lease?.fencing ?? 0) + 1);
  });
});

describe("engine lease: sweeps are gated on ownership", () => {
  test("reapStaleClaims refuses to reap while another live engine owns the database", async () => {
    // We have NOT acquired the lease; a live foreign owner holds it.
    writeForeignLease({ owner: "live-engine:4242:aa", fencing: 1, pid: process.pid, host: hostname(), expiresInSeconds: 600 });
    insertJob("stale-dl", {
      download_status: "downloading",
      download_claimed_by: "dl-9",
      download_claimed_at: "2020-01-01 00:00:00",
      download_claim_token: "tok-stale",
      download_heartbeat_at: "2020-01-01 00:00:00",
    });
    insertJob("stale-cv", {
      download_status: "downloaded",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-9",
      conversion_claimed_at: "2020-01-01 00:00:00",
      conversion_claim_token: "tok-cv",
      conversion_heartbeat_at: "2020-01-01 00:00:00",
    });

    const summary = await reapStaleClaims(testConfig());

    expect(summary).toEqual({ downloads: 0, conversions: 0, metadata: 0, stranded: 0, locked: 0 });
    expect(jobRow("stale-dl").download_status).toBe("downloading");
    expect(jobRow("stale-cv").conversion_status).toBe("in_progress");
  });

  test("startup reconciliation refuses to blanket-reset a live engine's claims", () => {
    writeForeignLease({ owner: "live-engine:4242:aa", fencing: 1, pid: process.pid, host: hostname(), expiresInSeconds: 600 });
    insertJob("inflight", {
      download_status: "downloading",
      download_claimed_by: "dl-1",
      download_claim_token: "tok-live",
      download_heartbeat_at: "2020-01-01 00:00:00",
    });
    insertJob("conv", {
      download_status: "downloaded",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-1",
      conversion_claim_token: "tok-live-cv",
    });

    expect(reconcileCrashedJobs()).toBe(0);
    expect(jobRow("inflight").download_status).toBe("downloading");
    expect(jobRow("inflight").download_claim_token).toBe("tok-live");
    expect(jobRow("conv").conversion_status).toBe("in_progress");
  });

  test("the same sweeps run once this process owns the lease", async () => {
    acquireEngineLease();
    insertJob("stale-dl", {
      download_status: "downloading",
      download_claimed_by: "dl-9",
      download_claimed_at: "2020-01-01 00:00:00",
      download_claim_token: "tok-stale",
      download_heartbeat_at: "2020-01-01 00:00:00",
    });

    const summary = await reapStaleClaims(testConfig());

    expect(summary.downloads).toBe(1);
    const row = jobRow("stale-dl");
    expect(row.download_status).toBe("paused");
    expect(row.pause_reason).toBe("interrupted");
    expect(row.download_claim_token).toBeNull();
  });
});
