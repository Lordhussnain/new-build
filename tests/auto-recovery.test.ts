import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { db, initDatabase } from "../src/db";
import { acquireEngineLease, releaseEngineLease } from "../src/lease";
import * as resilience from "../src/resilience";
import { getConfig, getPauseReason, isPaused, setConfig, setPaused } from "../src/state";

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
    db.run("UPDATE jobs SET metadata_status = 'in_progress' WHERE id = 'metadata'");
    resilience.triggerPause("NETWORK_DISCONNECTED");
    expect(resilience.resumeAutomatically("NETWORK_DISCONNECTED")).toBe(true);
    expect(row("user").download_status).toBe("paused");
    expect(row("interrupted").download_status).toBe("pending");
    expect(row("claimed").download_claim_token).toBe("still-owned");
    expect(row("claimed").download_status).toBe("paused");
    expect(row("metadata").download_status).toBe("paused");
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

  test("a lost lease prevents network and circuit recovery", async () => {
    expect(typeof resilience.automaticRecoveryTick).toBe("function");
    resilience.notePipelineFailure("dl", getConfig(), 0);
    releaseEngineLease();
    await resilience.automaticRecoveryTick({ now: 600_000 });
    expect(isPaused()).toBe(true);
    setPaused(true, "NETWORK_DISCONNECTED");
    expect(resilience.resumeAutomatically("NETWORK_DISCONNECTED")).toBe(false);
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
    resilience.triggerPause("LOW_DISK_SPACE (0 GB)");
    await resilience.automaticRecoveryTick({ diskProbe: async () => {
      setConfig({ ...getConfig(), outputRoot: "/different-volume" });
      return { free: 100, ok: true };
    } });
    expect(isPaused()).toBe(true);
  });

  test("bad downloader arguments resume only after downloader settings change", async () => {
    expect(typeof resilience.automaticRecoveryTick).toBe("function");
    resilience.triggerPause("BAD_DOWNLOADER_ARGS (invalid split)");
    await resilience.automaticRecoveryTick();
    expect(isPaused()).toBe(true);
    setConfig({ ...getConfig(), theme: "light" } as any);
    await resilience.automaticRecoveryTick();
    expect(isPaused()).toBe(true);
    setConfig({ ...getConfig(), minSplitSize: "8M" });
    await resilience.automaticRecoveryTick();
    expect(isPaused()).toBe(false);
    resilience.triggerPause("BAD_DOWNLOADER_ARGS (still invalid)");
    await resilience.automaticRecoveryTick();
    expect(isPaused()).toBe(true);
  });
});
