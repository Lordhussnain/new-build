import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { claimDownloadJob, db, initDatabase } from "../src/db";
import { acquireEngineLease, releaseEngineLease } from "../src/lease";
import { reconcileCrashedJobs } from "../src/reconcile";
import * as resilience from "../src/resilience";
import { getConfig, getPauseReason, isPaused, markJobCancelled, setConfig, setPaused } from "../src/state";

beforeEach(() => {
  initDatabase(":memory:");
  acquireEngineLease();
  setConfig({ ...DEFAULT_CONFIG, maxFailures: 1 });
  resilience.triggerResume();
  resilience.notePipelineSuccess("dl");
});

afterEach(() => {
  setPaused(false);
  setConfig({ ...DEFAULT_CONFIG });
});

function parked(id: string, reason: string, claim: string | null = null): void {
  db.run(`INSERT INTO jobs (id, url, title, output_directory, download_status, pause_reason, download_claim_token)
    VALUES (?, 'https://example.test/video', ?, '/tmp/out', 'paused', ?, ?)`, [id, id, reason, claim]);
}

function row(id: string): any {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id);
}

describe("automatic pause recovery", () => {
  test("circuit waits ten minutes, doubles repeated trips, and resets after a download succeeds", async () => {
    expect(typeof resilience.automaticRecoveryTick).toBe("function");
    let now = 1_000;
    for (const delay of [600_000, 1_200_000, 2_400_000, 4_800_000, 9_600_000, 19_200_000, 21_600_000, 21_600_000]) {
      resilience.notePipelineFailure("dl", getConfig(), now);
      expect(isPaused()).toBe(true);
      expect(resilience.recoveryStatus().retryAt).toBe(new Date(now + delay).toISOString());
      await resilience.automaticRecoveryTick({ now: now + delay - 1 });
      expect(isPaused()).toBe(true);
      await resilience.automaticRecoveryTick({ now: now + delay });
      expect(isPaused()).toBe(false);
      now += delay + 1;
    }
    resilience.notePipelineSuccess("dl");
    resilience.notePipelineFailure("dl", getConfig(), now);
    await resilience.automaticRecoveryTick({ now: now + 600_000 });
    expect(isPaused()).toBe(false);
  });

  test("network recovery leaves user-paused and claimed jobs unchanged", () => {
    expect(typeof resilience.resumeAutomatically).toBe("function");
    parked("user", "user");
    parked("interrupted", "interrupted");
    parked("claimed", "interrupted", "still-owned");
    parked("metadata", "interrupted");
    parked("cancelled-auto-resume", "interrupted");
    markJobCancelled("cancelled-auto-resume");
    db.run("UPDATE jobs SET metadata_status = 'in_progress' WHERE id = 'metadata'");
    resilience.triggerPause("NETWORK_DISCONNECTED");
    expect(resilience.resumeAutomatically("NETWORK_DISCONNECTED")).toBe(true);
    expect(row("user").download_status).toBe("paused");
    expect(row("interrupted").download_status).toBe("pending");
    expect(row("claimed").download_claim_token).toBe("still-owned");
    expect(row("claimed").download_status).toBe("paused");
    expect(row("metadata").download_status).toBe("paused");
    expect(row("cancelled-auto-resume").download_status).toBe("paused");
  });

  test("a resumed engine waits for existing claims before taking interrupted jobs", () => {
    parked("download-claimed", "interrupted", "download-token");
    parked("metadata-claimed", "interrupted");
    db.run(`UPDATE jobs SET metadata_claimed_by = 'meta', metadata_claim_token = 'metadata-token'
      WHERE id = 'metadata-claimed'`);
    setPaused(true, "NETWORK_DISCONNECTED");
    expect(resilience.resumeAutomatically("NETWORK_DISCONNECTED")).toBe(true);
    expect(claimDownloadJob("next-worker")).toBeNull();
    expect(row("download-claimed").download_claim_token).toBe("download-token");
    db.run(`UPDATE jobs SET download_claim_token = NULL WHERE id = 'download-claimed'`);
    expect(claimDownloadJob("next-worker")?.id).toBe("download-claimed");
    expect(claimDownloadJob("next-worker")).toBeNull();
    db.run(`UPDATE jobs SET metadata_claimed_by = NULL, metadata_claim_token = NULL WHERE id = 'metadata-claimed'`);
    expect(claimDownloadJob("next-worker")?.id).toBe("metadata-claimed");
  });

  test("startup clears a paused row's orphaned download claim from the previous engine", () => {
    parked("orphaned", "interrupted", "old-token");
    expect(claimDownloadJob("next-worker")).toBeNull();
    reconcileCrashedJobs();
    expect(row("orphaned").download_claim_token).toBeNull();
    expect(claimDownloadJob("next-worker")?.id).toBe("orphaned");
  });

  test("user, shutdown and lease-loss pauses are never cleared by automatic recovery or failures", async () => {
    expect(typeof resilience.automaticRecoveryTick).toBe("function");
    for (const reason of ["USER_PAUSED", "ENGINE_LEASE_LOST", "SHUTDOWN_REQUESTED"]) {
      setPaused(true, reason);
      resilience.notePipelineFailure("dl", getConfig());
      await resilience.automaticRecoveryTick({ now: Number.MAX_SAFE_INTEGER });
      expect(resilience.resumeAutomatically(reason)).toBe(false);
      expect(getPauseReason()).toBe(reason);
    }
  });

  test("manual Resume All cannot mutate jobs when the lease is already gone", () => {
    parked("held-without-lease", "user");
    resilience.triggerPause("MANUAL_WEB_UI");
    releaseEngineLease(); // heartbeat has not yet changed the pause reason
    expect(resilience.triggerResume()).toBe(false);
    expect(getPauseReason()).toBe("MANUAL_WEB_UI");
    expect(row("held-without-lease").download_status).toBe("paused");
  });

  test("a lost lease prevents network and circuit recovery", async () => {
    expect(typeof resilience.automaticRecoveryTick).toBe("function");
    resilience.notePipelineFailure("dl", getConfig(), 0);
    releaseEngineLease();
    await resilience.automaticRecoveryTick({ now: 600_000 });
    expect(isPaused()).toBe(true);
    setPaused(true, "NETWORK_DISCONNECTED");
    expect(resilience.resumeAutomatically("NETWORK_DISCONNECTED")).toBe(false);
  });

  test("network recovery retries after an initially unavailable lease", async () => {
    resilience.triggerPause("NETWORK_DISCONNECTED");
    releaseEngineLease();
    const controller = new AbortController();
    let probes = 0;
    const monitor = resilience.networkMonitor({ intervalMs: 5, signal: controller.signal, probe: async () => { probes++; return true; } });
    try {
      while (probes < 2) await Bun.sleep(5);
      expect(isPaused()).toBe(true);
      const beforeReacquiring = probes;
      acquireEngineLease();
      const deadline = Date.now() + 1000;
      while (isPaused() && Date.now() < deadline) await Bun.sleep(5);
      expect(isPaused()).toBe(false);
      expect(probes).toBeGreaterThan(beforeReacquiring);
    } finally { controller.abort(); await monitor; }
  });

  test("a thrown connectivity probe does not kill network recovery", async () => {
    const controller = new AbortController();
    let probes = 0;
    let sawNetworkPause = false;
    const monitor = resilience.networkMonitor({ intervalMs: 5, signal: controller.signal, probe: async () => {
      probes++;
      if (probes <= 2) throw new Error("temporary probe failure");
      sawNetworkPause ||= getPauseReason() === "NETWORK_DISCONNECTED";
      return true;
    } });
    try {
      const deadline = Date.now() + 1000;
      while ((probes < 3 || isPaused()) && Date.now() < deadline) await Bun.sleep(5);
      expect(probes).toBeGreaterThanOrEqual(3);
      expect(sawNetworkPause).toBe(true);
      expect(isPaused()).toBe(false);
    } finally { controller.abort(); await monitor; }
  });

  test("disk recovery requires a measured healthy disk", async () => {
    expect(typeof resilience.automaticRecoveryTick).toBe("function");
    resilience.triggerPause("LOW_DISK_SPACE (0 GB)");
    for (const disk of [{ free: 0, ok: false }, { free: -1, ok: true }]) {
      await resilience.automaticRecoveryTick({ diskProbe: async () => disk });
      expect(isPaused()).toBe(true);
    }
    await resilience.automaticRecoveryTick({ diskProbe: async () => ({ free: 100, ok: true }) });
    expect(isPaused()).toBe(false);
  });

  test("an awaited disk check cannot override a new user pause or a changed disk target", async () => {
    expect(typeof resilience.automaticRecoveryTick).toBe("function");
    resilience.triggerPause("LOW_DISK_SPACE (0 GB)");
    await resilience.automaticRecoveryTick({ diskProbe: async () => {
      setPaused(true, "USER_PAUSED");
      return { free: 100, ok: true };
    } });
    expect(getPauseReason()).toBe("USER_PAUSED");
    setPaused(false);
    resilience.triggerPause("LOW_DISK_SPACE (0 GB)");
    await resilience.automaticRecoveryTick({ diskProbe: async () => {
      setConfig({ ...getConfig(), outputRoot: "/different-volume" });
      return { free: 100, ok: true };
    } });
    expect(isPaused()).toBe(true);
  });

  test("bad downloader arguments resume only after downloader settings change", async () => {
    expect(typeof resilience.automaticRecoveryTick).toBe("function");
    parked("rejected", "interrupted");
    parked("manual", "user");
    resilience.triggerPause("BAD_DOWNLOADER_ARGS (invalid split)");
    await resilience.automaticRecoveryTick();
    expect(isPaused()).toBe(true);
    setConfig({ ...getConfig(), theme: "light" } as any);
    await resilience.automaticRecoveryTick();
    expect(isPaused()).toBe(true);
    setConfig({ ...getConfig(), minSplitSize: "8M" });
    await resilience.automaticRecoveryTick();
    expect(isPaused()).toBe(false);
    expect(row("rejected").download_status).toBe("pending");
    expect(row("manual").download_status).toBe("paused");
    resilience.triggerPause("BAD_DOWNLOADER_ARGS (still invalid)");
    await resilience.automaticRecoveryTick();
    expect(isPaused()).toBe(true);
  });

  test("a stale automatic pause cannot overwrite a manual pause or lease loss", async () => {
    resilience.triggerPause("MANUAL_WEB_UI");
    resilience.triggerPause("LOW_DISK_SPACE (old observation)");
    resilience.triggerPause("BAD_DOWNLOADER_ARGS (old observation)");
    expect(getPauseReason()).toBe("MANUAL_WEB_UI");
    await resilience.automaticRecoveryTick({ diskProbe: async () => ({ free: 100, ok: true }) });
    expect(getPauseReason()).toBe("MANUAL_WEB_UI");
    resilience.triggerPause("ENGINE_LEASE_LOST");
    resilience.triggerPause("MANUAL_WEB_UI");
    resilience.triggerPause("NETWORK_DISCONNECTED");
    expect(getPauseReason()).toBe("ENGINE_LEASE_LOST");
    releaseEngineLease();
    expect(resilience.triggerResume()).toBe(false);
    expect(getPauseReason()).toBe("ENGINE_LEASE_LOST");
  });

  test("a manual pause supersedes an automatic one and stays manual", async () => {
    resilience.triggerPause("LOW_DISK_SPACE (0 GB)");
    resilience.triggerPause("MANUAL_WEB_UI");
    await resilience.automaticRecoveryTick({ diskProbe: async () => ({ free: 100, ok: true }) });
    expect(getPauseReason()).toBe("MANUAL_WEB_UI");
  });

  test("a rejected child is compared with the settings it actually used", async () => {
    const used = { ...getConfig(), minSplitSize: "banana" };
    setConfig({ ...used, minSplitSize: "8M" }); // changed while that child was running
    parked("old-child", "interrupted");
    resilience.triggerPause("BAD_DOWNLOADER_ARGS (old child)", { downloaderConfig: used });
    await resilience.automaticRecoveryTick();
    expect(isPaused()).toBe(false);
    expect(row("old-child").download_status).toBe("pending");
  });

  test("write failures need observed free-space growth, not just a healthy statfs result", async () => {
    resilience.triggerPause("LOW_DISK_SPACE (download write failed)", { diskPath: "/quota", diskWriteFailure: true });
    resilience.recordDiskSpaceAtFailure("/quota", 100);
    await resilience.automaticRecoveryTick({ diskProbe: async () => ({ free: 100, ok: true }) });
    expect(isPaused()).toBe(true);
    await resilience.automaticRecoveryTick({ diskProbe: async () => ({ free: -1, ok: true }) });
    expect(isPaused()).toBe(true);
    await resilience.automaticRecoveryTick({ diskProbe: async () => ({ free: 101, ok: true }) });
    expect(isPaused()).toBe(false);
  });

  test("disk recovery probes the volume which actually failed, even after the root changes", async () => {
    resilience.triggerPause("LOW_DISK_SPACE (write failed)", { diskPath: "/old-volume/folder" });
    setConfig({ ...getConfig(), outputRoot: "/new-volume" });
    const paths: string[] = [];
    await resilience.automaticRecoveryTick({ diskProbe: async (path) => {
      paths.push(path);
      return { free: 0, ok: false };
    } });
    expect(paths).toEqual(["/old-volume/folder"]);
    expect(isPaused()).toBe(true);
    await resilience.automaticRecoveryTick({ diskProbe: async () => {
      releaseEngineLease();
      return { free: 100, ok: true };
    } });
    expect(isPaused()).toBe(true);
  });
});
