// Explicit lease-loss recovery must never steal a newer owner or sweep claims
// while old workers or their interrupted subprocess trees may still be active.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { db, initDatabase } from "../src/db";
import { acquireEngineLease, engineFencing, holdsEngineLease, readEngineLease, releaseEngineLease } from "../src/lease";
import { automaticRecoveryTick, resumeEngineManually, triggerPause } from "../src/resilience";
import { cleanOrphanedFiles, reapStaleClaims } from "../src/reconcile";
import { relocateFinishedJobs } from "../src/relocate";
import { startMetadataOnly } from "../src/metadata-only";
import {
  activeConvertJobs,
  activeConvertProcs,
  activeDownloadJobs,
  activeLeaseOperations,
  activeMetadataJobs,
  activeMetadataProcs,
  activeProcs,
  getPauseReason,
  interruptedDownloadJobs,
  isPaused,
  setConfig,
  setPaused,
} from "../src/state";
import { handleRequest } from "../src/web";

beforeEach(() => {
  initDatabase(":memory:");
  acquireEngineLease();
  setConfig({ ...DEFAULT_CONFIG });
  setPaused(false);
});

afterEach(() => {
  activeDownloadJobs.clear();
  activeProcs.clear();
  activeMetadataJobs.clear();
  activeMetadataProcs.clear();
  activeConvertJobs.clear();
  activeConvertProcs.clear();
  interruptedDownloadJobs.clear();
  setPaused(false);
});

function insert(id: string, columns: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = { id, url: `https://example.test/${id}`, title: id, output_directory: "/tmp/out", ...columns };
  db.run(
    `INSERT INTO jobs (${Object.keys(row).map((key) => `"${key}"`).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`,
    Object.values(row) as any[],
  );
}

function job(id: string): any {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id);
}

function expireAndPause(): void {
  db.run("UPDATE engine_lease SET expires_at = datetime('now', '-1 second') WHERE id = 1");
  triggerPause("ENGINE_LEASE_LOST");
}

async function postResume(): Promise<{ status: number; body: any }> {
  const response = await handleRequest(new Request("http://localhost/api/resume", { method: "POST" }), { ...DEFAULT_CONFIG });
  return { status: response.status, body: await response.json() };
}

describe("manual engine-lease recovery", () => {
  test("only an explicit resume reacquires the unchanged expired owner and preserves old claims", async () => {
    insert("interrupted", { download_status: "paused", pause_reason: "interrupted", partial_file_path: "/tmp/keep.part" });
    insert("claimed-paused", { download_status: "paused", pause_reason: "interrupted", download_claimed_by: "dl-1", download_claim_token: "old-dl" });
    insert("conversion", { download_status: "downloaded", conversion_status: "in_progress", conversion_claimed_by: "cv-1", conversion_claim_token: "old-cv" });
    insert("metadata", { download_status: "downloaded", metadata_status: "in_progress", metadata_claimed_by: "md-1", metadata_claim_token: "old-md" });
    const old = readEngineLease()!;
    expireAndPause();
    await automaticRecoveryTick({ now: Number.MAX_SAFE_INTEGER });
    expect(isPaused()).toBe(true);
    expect(holdsEngineLease()).toBe(false);
    expect(engineFencing()).toBe(old.fencing);

    const result = await postResume();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, reacquiredLease: true, unreconciledClaims: 3 });
    expect(result.body.warning).toContain("restart the engine");
    expect(getPauseReason()).toBeNull();
    expect(holdsEngineLease()).toBe(true);
    expect(readEngineLease()?.owner).toBe(old.owner);
    expect(readEngineLease()?.fencing).toBe(old.fencing + 1);
    expect(job("interrupted").download_status).toBe("pending");
    expect(job("interrupted").partial_file_path).toBe("/tmp/keep.part");
    expect(job("claimed-paused").download_status).toBe("paused");
    expect(job("claimed-paused").download_claim_token).toBe("old-dl");
    expect(job("conversion").conversion_status).toBe("in_progress");
    expect(job("conversion").conversion_claim_token).toBe("old-cv");
    expect(job("metadata").metadata_status).toBe("in_progress");
    expect(job("metadata").metadata_claim_token).toBe("old-md");
  });

  test("a live or expired foreign owner is never taken or modified", async () => {
    insert("queued", { download_status: "paused", pause_reason: "interrupted" });
    for (const expiry of ["+5 minutes", "-1 minute"]) {
      const old = readEngineLease()!;
      db.run("UPDATE engine_lease SET owner = 'another-engine', fencing = fencing + 1, expires_at = datetime('now', ?) WHERE id = 1", [expiry]);
      setPaused(true, "ENGINE_LEASE_LOST");
      const foreign = readEngineLease();
      const response = await postResume();
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("lease_changed");
      expect(response.body.error).toContain("Stop all engines");
      expect(readEngineLease()).toEqual(foreign);
      expect(job("queued").download_status).toBe("paused");
      // Restore exactly the local identity only to exercise the second case.
      db.run("UPDATE engine_lease SET owner = ?, fencing = ? WHERE id = 1", [old.owner, old.fencing]);
    }
  });

  test("a changed generation and a released local lease cannot be adopted", () => {
    expireAndPause();
    db.run("UPDATE engine_lease SET fencing = fencing + 1 WHERE id = 1");
    expect(resumeEngineManually()).toMatchObject({ ok: false, code: "lease_changed" });
    expect(isPaused()).toBe(true);
    expect(releaseEngineLease()).toBe(false);
    expect(resumeEngineManually()).toMatchObject({ ok: false, code: "lease_changed" });
  });

  test("all worker and child maps block recovery without changing lease or claims", () => {
    insert("claimed", { download_status: "paused", pause_reason: "interrupted", download_claim_token: "untouched" });
    expireAndPause();
    const old = readEngineLease();
    const maps: Map<number, any>[] = [activeDownloadJobs, activeProcs, activeMetadataJobs, activeMetadataProcs, activeConvertJobs, activeConvertProcs];
    for (const map of maps) {
      map.set(9, "active");
      const result = resumeEngineManually();
      expect(result).toMatchObject({ ok: false, code: "workers_active" });
      expect(readEngineLease()).toEqual(old);
      expect(job("claimed").download_claim_token).toBe("untouched");
      map.delete(9);
    }
    expect(resumeEngineManually().ok).toBe(true);
    expect(job("claimed").download_claim_token).toBe("untouched");
  });

  test("an in-flight stale-claim reaper blocks reacquisition until its file sweep ends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-reaper-resume-"));
    try {
      insert("stale", {
        output_directory: dir, download_status: "downloading", download_claimed_by: "dl-old",
        download_claim_token: "old", download_claimed_at: "2020-01-01 00:00:00", download_heartbeat_at: "2020-01-01 00:00:00",
      });
      const sweep = reapStaleClaims({ ...DEFAULT_CONFIG });
      expect([...activeLeaseOperations.values()]).toContain("stale-claim reaper");
      expireAndPause();
      const old = readEngineLease();
      expect(resumeEngineManually()).toMatchObject({ ok: false, code: "workers_active" });
      expect(readEngineLease()).toEqual(old);
      await sweep;
      expect([...activeLeaseOperations.values()]).not.toContain("stale-claim reaper");
      expect(resumeEngineManually().ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("orphan cleanup and secondary-storage relocation are tracked until they settle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-maintenance-resume-"));
    try {
      const cleanup = cleanOrphanedFiles(dir, { ...DEFAULT_CONFIG });
      const relocation = relocateFinishedJobs({ ...DEFAULT_CONFIG, secondaryStoragePath: "" });
      expect([...activeLeaseOperations.values()]).toContain("orphan-file cleanup");
      expect([...activeLeaseOperations.values()]).toContain("secondary-storage relocation");
      expireAndPause();
      expect(resumeEngineManually()).toMatchObject({ ok: false, code: "workers_active" });
      await Promise.all([cleanup, relocation]);
      expect(activeLeaseOperations.size).toBe(0);
      expect(resumeEngineManually().ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an in-flight dashboard retry cleanup also blocks lease recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-retry-resume-"));
    try {
      const config = { ...DEFAULT_CONFIG, archiveFile: join(dir, "archive.txt") };
      insert("retry", { output_directory: dir, download_status: "failed" });
      const request = handleRequest(new Request("http://localhost/api/jobs/retry/retry", { method: "POST" }), config);
      expect([...activeLeaseOperations.values()]).toContain("job retry cleanup");
      expireAndPause();
      expect(resumeEngineManually()).toMatchObject({ ok: false, code: "workers_active" });
      expect((await request).status).toBe(200);
      expect(activeLeaseOperations.size).toBe(0);
      expect(resumeEngineManually().ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an active metadata-only task also blocks lease recovery", async () => {
    const config = { ...DEFAULT_CONFIG, offlineMode: true };
    setConfig(config);
    startMetadataOnly("https://example.test/video", ["thumbnail"], config);
    await Promise.resolve(); // the queued task has started but not finished
    expect([...activeLeaseOperations.values()]).toContain("metadata-only fetch");
    expireAndPause();
    expect(resumeEngineManually()).toMatchObject({ ok: false, code: "workers_active" });
    await Bun.sleep(0);
    expect(activeLeaseOperations.size).toBe(0);
    expect(resumeEngineManually().ok).toBe(true);
  });

  test.skipIf(process.platform === "win32")("recovery waits for interrupted subprocess-tree escalation even after the parent exits", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    activeProcs.set(9, child);
    try {
      expireAndPause();
      await child.exited;
      activeProcs.delete(9);
      expect(resumeEngineManually()).toMatchObject({ ok: false, code: "workers_active" });
      await Bun.sleep(2_150);
      expect(resumeEngineManually().ok).toBe(true);
      expect(holdsEngineLease()).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      activeProcs.delete(9);
    }
  }, 10_000);

  test.skipIf(process.platform === "win32")("recovery waits for a stubborn downloader descendant after its parent exits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-tree-resume-"));
    const ready = join(dir, "child-ready");
    const childCode = `process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});\n` +
      `await Bun.write(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parentCode = `Bun.spawn([process.execPath, '-e', ${JSON.stringify(childCode)}], { stdout: 'ignore', stderr: 'ignore' });\n` +
      `process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
    const parent = Bun.spawn([process.execPath, "-e", parentCode], { stdout: "ignore", stderr: "ignore" });
    let childPid = 0;
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(ready)).toBe(true);
      childPid = Number(await readFile(ready, "utf8"));
      expect(childPid).toBeGreaterThan(1);
      activeProcs.set(10, parent);
      expireAndPause();
      await parent.exited;
      activeProcs.delete(10);
      await Bun.sleep(250);
      // The descendant ignores the graceful signals; a dead parent is not
      // enough to let a new worker write into the same files.
      expect(() => process.kill(childPid, 0)).not.toThrow();
      expect(resumeEngineManually()).toMatchObject({ ok: false, code: "workers_active" });
      const limit = Date.now() + 5_000;
      let result = resumeEngineManually();
      while (!result.ok && Date.now() < limit) {
        await Bun.sleep(100);
        result = resumeEngineManually();
      }
      expect(result.ok).toBe(true);
    } finally {
      activeProcs.delete(10);
      if (parent.exitCode === null) parent.kill("SIGKILL");
      if (childPid > 1) { try { process.kill(childPid, "SIGKILL"); } catch {} }
      await rm(dir, { recursive: true, force: true });
    }
  }, 12_000);

  test("an unconfirmed Windows process-tree stop requires a restart", async () => {
    // Isolated subprocesses simulate taskkill's exit status without changing
    // this test runner's platform or leaving its conservative latch set.
    const run = async (taskkillExit: number) => {
      const script = `
        import { db, initDatabase } from ${JSON.stringify(join(import.meta.dir, "..", "src", "db.ts"))};
        import { acquireEngineLease, readEngineLease } from ${JSON.stringify(join(import.meta.dir, "..", "src", "lease.ts"))};
        import { interruptChild, resumeEngineManually } from ${JSON.stringify(join(import.meta.dir, "..", "src", "resilience.ts"))};
        import { setPaused } from ${JSON.stringify(join(import.meta.dir, "..", "src", "state.ts"))};
        initDatabase(':memory:'); acquireEngineLease();
        db.run("UPDATE engine_lease SET expires_at = datetime('now', '-1 second') WHERE id = 1");
        setPaused(true, 'ENGINE_LEASE_LOST');
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        Bun.spawnSync = () => ({ exitCode: ${taskkillExit} });
        const child = { pid: 23456, exitCode: null, signalCode: null };
        interruptChild(child); child.exitCode = 0;
        await Bun.sleep(2200);
        const result = resumeEngineManually();
        console.log(JSON.stringify({ result, lease: readEngineLease() }));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      return JSON.parse(out.trim().split("\n").at(-1)!);
    };
    const [confirmed, unconfirmed] = await Promise.all([run(0), run(1)]);
    expect(confirmed.result.ok).toBe(true);
    expect(confirmed.lease.fencing).toBe(2);
    expect(unconfirmed.result).toMatchObject({ ok: false, code: "workers_active" });
    expect(unconfirmed.result.error).toContain("could not confirm");
    expect(unconfirmed.lease.fencing).toBe(1);
  }, 10_000);

  test("a different manual pause does not silently reacquire before lease-loss is reported", async () => {
    insert("paused", { download_status: "paused", pause_reason: "user" });
    setPaused(true, "MANUAL_WEB_UI");
    db.run("UPDATE engine_lease SET expires_at = datetime('now', '-1 second') WHERE id = 1");
    const before = readEngineLease();
    const response = await postResume();
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("lease_missing");
    expect(readEngineLease()).toEqual(before);
    expect(job("paused").download_status).toBe("paused");
    expect(getPauseReason()).toBe("MANUAL_WEB_UI");
  });
});
