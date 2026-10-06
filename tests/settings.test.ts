// tests/settings.test.ts — the dashboard settings API.
//
// The dashboard may tune the downloader, but it must never be able to rewrite
// playlists, credentials, or the network binding. These tests pin the
// allow-list, the validation path (including cross-field refinements), the
// "reject rather than silently ignore" rule for unknown keys, and the
// all-or-nothing behaviour when a patch is invalid.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { activeDownloadJobs, getConfig, setConfig } from "../src/state";
import { db, initDatabase } from "../src/db";
import { EDITABLE_SETTINGS, applySettings, isEditableSetting, readSettings } from "../src/settings";
import { STALE_CLAIM_THRESHOLDS } from "../src/reconcile";
import { handleRequest } from "../src/web";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yta-settings-"));
  tmpDirs.push(dir);
  return dir;
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

beforeEach(() => {
  initDatabase(":memory:"); // /api/reliability queries the jobs table
  setConfig(baseConfig());
});

describe("the editable allow-list", () => {
  test("includes the downloader tuning knobs", () => {
    for (const k of [
      "useAria2c",
      "connectionsPerDownload",
      "minSplitSize",
      "concurrentFragments",
      "fragmentRetries",
      "httpChunkSize",
      "bufferSize",
      "maxBandwidthKBps",
      "autoscaleRampStep",
    ]) {
      expect(isEditableSetting(k)).toBe(true);
    }
  });

  test("excludes credentials, paths, and the network binding", () => {
    for (const k of ["webToken", "webBind", "webPort", "playlists", "channels", "cookiesFile", "archiveFile", "outputRoot", "ytDlpPath"]) {
      expect(isEditableSetting(k)).toBe(false);
    }
  });

  test("every field has a label, a group, and help text", () => {
    for (const f of EDITABLE_SETTINGS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.help.length).toBeGreaterThan(0);
      expect(["downloader", "media", "concurrency", "reliability"]).toContain(f.group);
    }
  });

  test("number fields carry a lower bound, and an upper one where the schema has it", () => {
    for (const f of EDITABLE_SETTINGS.filter((x) => x.type === "number")) {
      expect(f.min).toBeDefined();
      // Some knobs are genuinely unbounded above (e.g. the bandwidth cap), so
      // max is optional — but when present it must not contradict min.
      if (f.max !== undefined) expect(f.max).toBeGreaterThanOrEqual(f.min!);
    }
    // Sanity: the bounded ones really are bounded in the UI.
    const conns = EDITABLE_SETTINGS.find((f) => f.key === "connectionsPerDownload")!;
    expect(conns.min).toBe(1);
    expect(conns.max).toBe(64);
  });
});

describe("readSettings", () => {
  test("returns current values and flags non-defaults", () => {
    const snapshot = readSettings(baseConfig({ connectionsPerDownload: 4 }));
    expect(snapshot.values.connectionsPerDownload).toBe(4);
    expect(snapshot.nonDefault).toContain("connectionsPerDownload");
    expect(snapshot.nonDefault).not.toContain("concurrentFragments");
  });
});

describe("applySettings", () => {
  test("applies a patch, persists it, and makes it live", async () => {
    const dir = await makeConfigDir();
    const cfgPath = join(dir, "config.json");
    const current = baseConfig();
    const result = await applySettings(current, { connectionsPerDownload: 32 }, cfgPath);

    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(["connectionsPerDownload"]);
    expect(getConfig().connectionsPerDownload).toBe(32); // live, no restart needed

    const onDisk = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(onDisk.connectionsPerDownload).toBe(32);
  });

  test("coerces text input into the declared type", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(baseConfig(), { connectionsPerDownload: "8" }, join(dir, "config.json"));
    expect(result.ok).toBe(true);
    expect(getConfig().connectionsPerDownload).toBe(8);
  });

  test("coerces boolean-ish strings", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(baseConfig(), { useAria2c: "false" }, join(dir, "config.json"));
    expect(result.ok).toBe(true);
    expect(getConfig().useAria2c).toBe(false);
  });

  test("coerces list fields from comma-separated strings and arrays", async () => {
    const dir = await makeConfigDir();
    const fromString = await applySettings(
      baseConfig(),
      { audioTrackLanguages: "en, ja , " },
      join(dir, "config.json"),
    );
    expect(fromString.ok).toBe(true);
    expect(getConfig().audioTrackLanguages).toEqual(["en", "ja"]);

    const fromArray = await applySettings(
      baseConfig(),
      { audioTrackLanguages: ["es", "", "hi"] },
      join(dir, "config.json"),
    );
    expect(fromArray.ok).toBe(true);
    expect(getConfig().audioTrackLanguages).toEqual(["es", "hi"]);
  });

  test("the multi-audio mode is a select with the three schema values", async () => {
    const field = EDITABLE_SETTINGS.find((f) => f.key === "multiAudioMode")!;
    expect(field.type).toBe("select");
    expect((field.options || []).map((o) => o.value)).toEqual(["off", "all", "languages"]);
    const dir = await makeConfigDir();
    const result = await applySettings(baseConfig(), { multiAudioMode: "all" }, join(dir, "config.json"));
    expect(result.ok).toBe(true);
    expect(getConfig().multiAudioMode).toBe("all");
    const bad = await applySettings(baseConfig(), { multiAudioMode: "everything" }, join(dir, "config.json"));
    expect(bad.ok).toBe(false);
    expect(getConfig().multiAudioMode).toBe("all"); // unchanged on rejection
  });

  test("reports no change when the value is already current", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(baseConfig(), { concurrentFragments: 16 }, join(dir, "config.json"));
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual([]);
  });

  test("rejects keys outside the allow-list instead of ignoring them", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(
      baseConfig(),
      { connectionsPerDownload: 8, webToken: "hunter2" },
      join(dir, "config.json"),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("webToken");
    expect(result.changed).toEqual([]);
    // Nothing was written and nothing went live.
    expect(getConfig().connectionsPerDownload).toBe(DEFAULT_CONFIG.connectionsPerDownload);
    await expect(readFile(join(dir, "config.json"), "utf8")).rejects.toThrow();
  });

  test("rejects out-of-range numbers", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(baseConfig(), { connectionsPerDownload: 999 }, join(dir, "config.json"));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(getConfig().connectionsPerDownload).toBe(DEFAULT_CONFIG.connectionsPerDownload);
  });

  test("rejects a non-numeric value for a number field", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(baseConfig(), { fragmentRetries: "lots" }, join(dir, "config.json"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Fragment retries");
  });

  test("enforces the cross-field refinement (backoff max >= base)", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(
      baseConfig({ retryBackoffBaseSeconds: 30, retryBackoffMaxSeconds: 900 }),
      { retryBackoffMaxSeconds: 5 },
      join(dir, "config.json"),
    );
    expect(result.ok).toBe(false);
    expect(getConfig().retryBackoffMaxSeconds).toBe(900); // unchanged
  });

  test("enforces the cross-field refinement (maxDownloadMinutes >= downloadTimeoutMinutes)", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(
      baseConfig({ downloadTimeoutMinutes: 15, maxDownloadMinutes: 180 }),
      { maxDownloadMinutes: 2 },
      join(dir, "config.json"),
    );
    expect(result.ok).toBe(false);
    expect(getConfig().maxDownloadMinutes).toBe(180);
  });

  test("enforces the cross-field refinement (minDownloadWorkers <= maxDownloadWorkers)", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(
      baseConfig({ minDownloadWorkers: 1, maxDownloadWorkers: 5 }),
      { minDownloadWorkers: 9 },
      join(dir, "config.json"),
    );
    expect(result.ok).toBe(false);
    expect(getConfig().minDownloadWorkers).toBe(1);
  });

  test("rejects a non-object body", async () => {
    const dir = await makeConfigDir();
    expect((await applySettings(baseConfig(), [] as any, join(dir, "config.json"))).ok).toBe(false);
    expect((await applySettings(baseConfig(), null as any, join(dir, "config.json"))).ok).toBe(false);
    expect((await applySettings(baseConfig(), "nope" as any, join(dir, "config.json"))).ok).toBe(false);
  });

  test("an empty patch is a harmless no-op", async () => {
    const dir = await makeConfigDir();
    const result = await applySettings(baseConfig(), {}, join(dir, "config.json"));
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual([]);
  });
});

describe("GET /api/reliability — resume + self-healing state", () => {
  /** Insert a job row directly for state-machine assertions. */
  function insertJob(id: string, overrides: Record<string, unknown> = {}): void {
    const cols = Object.keys(overrides);
    const row: Record<string, unknown> = {
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: `Video ${id}`,
      output_directory: "/tmp/out",
      ...overrides,
    };
    db.run(
      `INSERT INTO jobs (${["id", "url", "title", "output_directory", ...cols].map((c) => `"${c}"`).join(", ")})
       VALUES (${[...Object.keys(row)].map(() => "?").join(", ")})`,
      Object.values(row) as any,
    );
  }

  test("reports which jobs will resume from a partial", async () => {
    // A partial only counts while the job is still in play — a failed job's
    // partial may be discarded once the resume budget is spent.
    insertJob("a", { download_status: "pending", partial_file_path: "/tmp/a.part" });
    insertJob("b", { download_status: "paused", pause_reason: "interrupted", partial_file_path: "/tmp/b.part" });
    insertJob("c", { download_status: "failed", partial_file_path: "/tmp/c.part" });
    insertJob("d", { download_status: "downloaded", partial_file_path: null });

    const res = await handleRequest(new Request("http://x/api/reliability"), getConfig());
    const body = await res.json();
    expect(body.resume.resumablePartials).toBe(2); // a + b, not the failed one
    expect(body.resume.interrupted).toBe(1); // b
    expect(body.partialFiles.count).toBe(3); // raw count includes the failed job
  });

  test("reports what the stale-claim reaper would reclaim right now", async () => {
    // A recent timestamp keeps a claim alive; a NULL one cannot be proven fresh,
    // which is exactly how the reaper treats it too.
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    insertJob("fresh", { download_status: "downloading", download_claimed_by: "dl-1", download_claimed_at: now });
    insertJob("stale", {
      download_status: "downloading",
      download_claimed_by: "dl-2",
      download_claimed_at: "2000-01-01 00:00:00",
    });
    insertJob("active-but-old", {
      download_status: "downloading",
      download_claimed_by: "dl-3",
      download_claimed_at: "2000-01-01 00:00:00",
    });
    activeDownloadJobs.set(3, "active-but-old");

    try {
      const res = await handleRequest(new Request("http://x/api/reliability"), getConfig());
      const body = await res.json();
      expect(body.resume.staleClaims).toBe(1);
    } finally {
      activeDownloadJobs.delete(3);
    }
  });

  test("describes all four self-healing sweeps with a pending count", async () => {
    const res = await handleRequest(new Request("http://x/api/reliability"), getConfig());
    const body = await res.json();
    const ids = body.sweeps.map((s: any) => s.id);
    expect(ids).toEqual(["crashed", "staleClaims", "missingFiles", "requeueFailed"]);
    for (const s of body.sweeps) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.cadence.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
      // pending is a count, or null when the sweep is too expensive to poll.
      expect(s.pending === null || typeof s.pending === "number").toBe(true);
    }
    // The missing-files sweep stats every recorded file, so it is not counted.
    const missing = body.sweeps.find((s: any) => s.id === "missingFiles");
    expect(missing.pending).toBeNull();
  });

  test("the sweep thresholds match the ones the reaper enforces", async () => {
    // Guards against the dashboard promising recovery the engine never performs.
    expect(STALE_CLAIM_THRESHOLDS.download).toBe("-20 minutes");
    expect(STALE_CLAIM_THRESHOLDS.conversion).toBe("-3 hours");
    expect(STALE_CLAIM_THRESHOLDS.metadata).toBe("-15 minutes");
  });
});

describe("GET /api/settings", () => {
  test("returns the fields and current values", async () => {
    setConfig(baseConfig({ connectionsPerDownload: 12 }));
    const res = await handleRequest(new Request("http://x/api/settings"), getConfig());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fields.length).toBe(EDITABLE_SETTINGS.length);
    expect(body.values.connectionsPerDownload).toBe(12);
  });
});

describe("POST /api/settings", () => {
  test("applies a valid patch and echoes the new snapshot", async () => {
    const dir = await makeConfigDir();
    const cwd = process.cwd();
    process.chdir(dir); // CONFIG_PATH is CWD-relative
    try {
      setConfig(baseConfig());
      const res = await handleRequest(
        new Request("http://x/api/settings", {
          method: "POST",
          body: JSON.stringify({ connectionsPerDownload: 24, maxBandwidthKBps: 5000 }),
        }),
        getConfig(),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.changed.sort()).toEqual(["connectionsPerDownload", "maxBandwidthKBps"]);
      expect(body.values.connectionsPerDownload).toBe(24);
      expect(body.values.maxBandwidthKBps).toBe(5000);
      expect(getConfig().connectionsPerDownload).toBe(24);
    } finally {
      process.chdir(cwd);
    }
  });

  test("rejects a non-editable key with 400", async () => {
    const dir = await makeConfigDir();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      setConfig(baseConfig());
      const res = await handleRequest(
        new Request("http://x/api/settings", {
          method: "POST",
          body: JSON.stringify({ webToken: "nope" }),
        }),
        getConfig(),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("webToken");
      expect(getConfig().webToken).toBe("");
    } finally {
      process.chdir(cwd);
    }
  });

  test("rejects an invalid value with 400 and leaves the config alone", async () => {
    const dir = await makeConfigDir();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      setConfig(baseConfig());
      const res = await handleRequest(
        new Request("http://x/api/settings", {
          method: "POST",
          body: JSON.stringify({ connectionsPerDownload: 5000 }),
        }),
        getConfig(),
      );
      expect(res.status).toBe(400);
      expect(getConfig().connectionsPerDownload).toBe(DEFAULT_CONFIG.connectionsPerDownload);
    } finally {
      process.chdir(cwd);
    }
  });

  test("rejects a malformed body with 400", async () => {
    setConfig(baseConfig());
    const res = await handleRequest(
      new Request("http://x/api/settings", { method: "POST", body: "not json" }),
      getConfig(),
    );
    expect(res.status).toBe(400);
  });

  test("the reliability endpoint reflects the new values, not the startup snapshot", async () => {
    // Regression guard: the web server must read the LIVE config. setConfig()
    // replaces the object, so a server holding the startup reference would keep
    // reporting stale policy knobs after a settings change.
    const dir = await makeConfigDir();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const startup = baseConfig({ connectionsPerDownload: 16, maxResumeAttempts: 5 });
      setConfig(startup);
      await applySettings(startup, { connectionsPerDownload: 40, maxResumeAttempts: 9 }, join(dir, "config.json"));

      const res = await handleRequest(new Request("http://x/api/reliability"), getConfig());
      const body = await res.json();
      expect(body.downloader.connectionsPerDownload).toBe(40);
      expect(body.policy.maxResumeAttempts).toBe(9);
    } finally {
      process.chdir(cwd);
    }
  });

  test("requires the token when one is configured", async () => {
    setConfig(baseConfig({ webToken: "s3cret" }));
    const anon = await handleRequest(new Request("http://x/api/settings"), getConfig());
    expect(anon.status).toBe(401);
    const authed = await handleRequest(
      new Request("http://x/api/settings", { headers: { "X-Web-Token": "s3cret" } }),
      getConfig(),
    );
    expect(authed.status).toBe(200);
  });
});
