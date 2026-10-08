// tests/settings.test.ts — the dashboard settings API.
//
// The dashboard may tune the downloader, but it must never be able to rewrite
// playlists, credentials, or the network binding. These tests pin the
// allow-list, the validation path (including cross-field refinements), the
// "reject rather than silently ignore" rule for unknown keys, and the
// all-or-nothing behaviour when a patch is invalid.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { activeDownloadJobs, getConfig, setConfig } from "../src/state";
import { db, initDatabase } from "../src/db";
import {
  DOWNLOAD_SPEED_PROFILES,
  EDITABLE_SETTINGS,
  NON_EDITABLE_SETTINGS,
  SETTING_GROUPS,
  applySettings,
  isEditableSetting,
  readSettings,
  requiresRestart,
} from "../src/settings";
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
      "userAgent",
      "maxBandwidthKBps",
      "autoscaleRampStep",
    ]) {
      expect(isEditableSetting(k)).toBe(true);
    }
  });

  test("excludes only credentials and the URL lists, and says why for each", () => {
    // The panel is the whole of config.json except the keys that genuinely
    // cannot be a form field: the token (a credential) and the source lists
    // (managed by the Sources panel, which also knows how to clean up jobs).
    const deliberatelyOut = ["webToken", "playlists", "channels", "channelPlaylists"];
    for (const k of deliberatelyOut) {
      expect(isEditableSetting(k)).toBe(false);
      // Every exclusion carries a reason, so the panel can explain itself.
      expect(NON_EDITABLE_SETTINGS.find((s) => s.key === k)?.reason.length).toBeGreaterThan(0);
    }
  });

  test("covers every config key: editable, or deliberately excluded with a reason", () => {
    // Regression guard for "there is not all options in the WebUI": a new
    // config key must be either rendered by the panel or explicitly excluded
    // — it can never be silently missing from both.
    const excluded = new Set<string>(NON_EDITABLE_SETTINGS.map((s) => s.key as string));
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(isEditableSetting(key) || excluded.has(key)).toBe(true);
    }
    // And the excluded list must only name real config keys.
    for (const entry of NON_EDITABLE_SETTINGS) {
      expect(Object.hasOwn(DEFAULT_CONFIG, entry.key)).toBe(true);
      expect(isEditableSetting(entry.key as string)).toBe(false);
    }
  });

  test("every field has a label, a group, and help text", () => {
    for (const f of EDITABLE_SETTINGS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.help.length).toBeGreaterThan(0);
      expect(SETTING_GROUPS as readonly string[]).toContain(f.group);
    }
  });

  test("describes maxConcurrentDownloads as the initial slot count, not an autoscale ceiling", () => {
    const field = EDITABLE_SETTINGS.find((f) => f.key === "maxConcurrentDownloads")!;
    expect(field.label).toContain("Initial");
    expect(field.help).toContain("not the autoscaler ceiling");
    expect(field.help).toContain("maxDownloadWorkers");
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

  test("settings read by the engine only at startup are marked restartRequired", () => {
    // The panel must be able to tell an operator that a change needs a restart
    // instead of implying it is live.
    for (const key of ["ytDlpPath", "ffmpegPath", "aria2cPath", "denoPath", "maxDownloadWorkers", "webPort", "daemonMode"]) {
      expect(requiresRestart(key)).toBe(true);
    }
    for (const key of [
      "useAria2c",
      "connectionsPerDownload",
      "videoQuality",
      "autoscaleEnabled",
      "maxConcurrentDownloads",
      "minDownloadWorkers",
      "maxBandwidthKBps",
    ]) {
      expect(requiresRestart(key)).toBe(false);
    }
  });
});

describe("readSettings", () => {
  test("returns current values and flags non-defaults", () => {
    const snapshot = readSettings(baseConfig({ connectionsPerDownload: 4 }));
    expect(snapshot.values.connectionsPerDownload).toBe(4);
    expect(snapshot.nonDefault).toContain("connectionsPerDownload");
    expect(snapshot.nonDefault).not.toContain("concurrentFragments");
    expect(snapshot.speedProfiles).toEqual(DOWNLOAD_SPEED_PROFILES);
  });

  test("defines standard and maximum-speed presets from the existing tuning knobs", () => {
    expect(DOWNLOAD_SPEED_PROFILES.standard.values).toMatchObject({
      useAria2c: true,
      connectionsPerDownload: 16,
      minSplitSize: "1M",
      concurrentFragments: 16,
      httpChunkSize: "",
      bufferSize: "",
      userAgent: "",
      maxBandwidthKBps: 0,
    });
    expect(DOWNLOAD_SPEED_PROFILES.maximum.values).toMatchObject({
      useAria2c: true,
      connectionsPerDownload: 16,
      minSplitSize: "1M",
      concurrentFragments: 32,
      httpChunkSize: "10M",
      bufferSize: "16K",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
      maxBandwidthKBps: 0,
    });
    expect(DOWNLOAD_SPEED_PROFILES.aggressive.values).toMatchObject({
      useAria2c: true,
      connectionsPerDownload: 32,
      minSplitSize: "1M",
      concurrentFragments: 64,
      httpChunkSize: "10M",
      bufferSize: "64K",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
      maxBandwidthKBps: 0,
    });
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
    // Every unambiguous spelling a form control can produce is accepted.
    for (const [raw, expected] of [
      ["TRUE", true],
      ["1", true],
      ["yes", true],
      [" on ", true],
      ["0", false],
      ["no", false],
      ["off", false],
      [true, true],
    ] as [unknown, boolean][]) {
      const ok = await applySettings(baseConfig(), { useAria2c: raw }, join(dir, "config.json"));
      expect(ok.ok).toBe(true);
      expect(getConfig().useAria2c).toBe(expected);
    }
  });

  test("rejects an invalid boolean instead of coercing it to false", async () => {
    // "maybe" is not false. The old coercion mapped any unrecognised string to
    // false and reported success — an invalid value silently switched a
    // setting off, which is exactly what "invalid key/value rejects, change
    // nothing" promises never happens.
    const dir = await makeConfigDir();
    const cfgPath = join(dir, "config.json");
    const before = baseConfig({ useAria2c: true });

    for (const raw of ["maybe", "", "  ", null, 2, {}, ["true"]]) {
      const result = await applySettings(before, { useAria2c: raw }, cfgPath);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("true or false");
      expect(result.changed).toEqual([]);
      // Nothing was written and nothing went live.
      expect(existsSync(cfgPath)).toBe(false);
      expect(getConfig().useAria2c).toBe(true);
    }
  });

  test("rejects an empty or non-numeric number instead of coercing it to 0", async () => {
    const dir = await makeConfigDir();
    const cfgPath = join(dir, "config.json");
    for (const raw of ["", "   ", "many", null]) {
      const result = await applySettings(baseConfig(), { maxBandwidthKBps: raw }, cfgPath);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("must be a number");
      expect(result.changed).toEqual([]);
      expect(existsSync(cfgPath)).toBe(false);
    }
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

  test("refuses to expose a token-less dashboard on a network address", async () => {
    // Binding to the LAN is allowed (webBind is editable) — but not while the
    // dashboard has no token, which would let anyone on the network purge jobs.
    const dir = await makeConfigDir();
    const cfgPath = join(dir, "config.json");
    const denied = await applySettings(baseConfig({ webBind: "127.0.0.1" }), { webBind: "0.0.0.0" }, cfgPath);
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("webToken");
    expect(getConfig().webBind).toBe("127.0.0.1");
    expect(existsSync(cfgPath)).toBe(false);

    // With a token set (hand-edited in config.json, as documented) the same
    // change goes through.
    const allowed = await applySettings(
      baseConfig({ webBind: "127.0.0.1", webToken: "s3cret" }),
      { webBind: "0.0.0.0" },
      cfgPath,
    );
    expect(allowed.ok).toBe(true);
    expect(getConfig().webBind).toBe("0.0.0.0");
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
    insertJob("within-configured-window", {
      download_status: "downloading",
      download_claimed_by: "dl-4",
      download_claimed_at: (db.query("SELECT datetime('now', '-25 minutes') AS timestamp").get() as any).timestamp,
    });
    insertJob("active-but-old", {
      download_status: "downloading",
      download_claimed_by: "dl-3",
      download_claimed_at: "2000-01-01 00:00:00",
    });
    activeDownloadJobs.set(3, "active-but-old");

    try {
      const res = await handleRequest(
        new Request("http://x/api/reliability"),
        baseConfig({ maxDownloadMinutes: 60 }),
      );
      const body = await res.json();
      expect(body.resume.staleClaims).toBe(1);
    } finally {
      activeDownloadJobs.delete(3);
    }
  });

  test("describes every self-healing sweep with a pending count", async () => {
    const res = await handleRequest(new Request("http://x/api/reliability"), getConfig());
    const body = await res.json();
    const ids = body.sweeps.map((s: any) => s.id);
    // The four resume/retry sweeps, plus the secondary-storage relocation pass
    // (offline mode's other half: files that need no conversion still move).
    expect(ids).toEqual(["crashed", "staleClaims", "missingFiles", "requeueFailed", "relocate"]);
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
    const defaults = STALE_CLAIM_THRESHOLDS(baseConfig());
    expect(defaults.download).toBe("-180 minutes");
    expect(defaults.conversion).toBe("-3 hours");
    expect(defaults.metadata).toBe("-15 minutes");
    expect(STALE_CLAIM_THRESHOLDS(baseConfig({ maxDownloadMinutes: 45 })).download).toBe("-45 minutes");
    expect(
      STALE_CLAIM_THRESHOLDS(baseConfig({ downloadTimeoutMinutes: 5, maxDownloadMinutes: 10 })).download,
    ).toBe("-20 minutes");
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
    expect(body.speedProfiles).toEqual(DOWNLOAD_SPEED_PROFILES);
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
          body: JSON.stringify({ connectionsPerDownload: 24, maxBandwidthKBps: 5000, userAgent: "Mozilla/5.0 test" }),
        }),
        getConfig(),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.changed.sort()).toEqual(["connectionsPerDownload", "maxBandwidthKBps", "userAgent"]);
      expect(body.values.connectionsPerDownload).toBe(24);
      expect(body.values.maxBandwidthKBps).toBe(5000);
      expect(body.values.userAgent).toBe("Mozilla/5.0 test");
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
