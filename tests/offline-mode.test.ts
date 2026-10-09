// tests/offline-mode.test.ts — offline mode and the relocation pass.
//
// Offline mode is a promise with three parts, and each one is pinned here:
//   1. nothing is downloaded (the run-level switch itself, and the settings),
//   2. files that need conversion are still converted (local CPU work),
//   3. finished files still reach secondary storage — including files that need
//      no conversion at all, which nothing else in the pipeline ever revisits.
//
// The engine-level half of the promise (no download worker claims a job, no
// scan runs, the queue survives untouched) is covered end-to-end in
// tests/integration.test.ts, against the real engine and the mock tools.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  offlineOverrideFromRuntime,
  parseConfig,
  parseOfflineSwitch,
  type Config,
} from "../src/config";
import { db, initDatabase, listJobsAwaitingRelocation, recordRelocatedFile } from "../src/db";
import { getConfig, isPaused, getPauseReason, setConfig, setPaused } from "../src/state";
import { networkMonitor } from "../src/resilience";
import { applySettings, EDITABLE_SETTINGS, readSettings } from "../src/settings";
import { relocateFinishedJobs, relocationPendingCount, resetRelocationBackoff } from "../src/relocate";
import { isPathInside } from "../src/util";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  initDatabase(":memory:");
  resetRelocationBackoff();
});

// ---------------------------------------------------------------------------
// The run-level switch: --offline / YTA_OFFLINE
// ---------------------------------------------------------------------------

describe("offline switch parsing", () => {
  test("a bare flag, and the usual true forms, all mean ON", () => {
    expect(parseOfflineSwitch("")).toBe(true);
    for (const v of ["true", "1", "yes", "on", " TRUE "]) expect(parseOfflineSwitch(v)).toBe(true);
    for (const v of ["false", "0", "no", "off", " OFF "]) expect(parseOfflineSwitch(v)).toBe(false);
  });

  test("an unparsable value is null — never a silent false", () => {
    // Guessing here would be the dangerous direction: a typo must not turn
    // downloads back on for a run the operator believed was offline.
    expect(parseOfflineSwitch("maybe")).toBeNull();
    expect(parseOfflineSwitch("offline")).toBeNull();
  });

  test("--offline, --offline=… and YTA_OFFLINE are all honoured", () => {
    expect(offlineOverrideFromRuntime(["--offline"], {})).toBe(true);
    expect(offlineOverrideFromRuntime(["--webport", "3000", "--offline"], {})).toBe(true);
    expect(offlineOverrideFromRuntime(["--offline=false"], {})).toBe(false);
    expect(offlineOverrideFromRuntime([], { YTA_OFFLINE: "1" })).toBe(true);
    expect(offlineOverrideFromRuntime([], { YTA_OFFLINE: "false" })).toBe(false);
  });

  test("no switch at all defers to the stored setting", () => {
    expect(offlineOverrideFromRuntime(["--daemon"], {})).toBeNull();
    expect(offlineOverrideFromRuntime([], {})).toBeNull();
  });

  test("the command line wins over the environment, last flag wins overall", () => {
    expect(offlineOverrideFromRuntime(["--offline=false"], { YTA_OFFLINE: "1" })).toBe(false);
    expect(offlineOverrideFromRuntime(["--offline", "--offline=false"], {})).toBe(false);
    expect(offlineOverrideFromRuntime(["--offline=false", "--offline"], {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config / settings
// ---------------------------------------------------------------------------

describe("offline mode as a setting", () => {
  test("defaults to off, and parses from config.json", () => {
    expect(DEFAULT_CONFIG.offlineMode).toBe(false);
    expect(parseConfig({ offlineMode: true }).offlineMode).toBe(true);
    // A missing key is backwards compatible: older config files keep working.
    expect(parseConfig({}).offlineMode).toBe(false);
  });

  test("the dashboard exposes it in its own group and can toggle it live", async () => {
    const field = EDITABLE_SETTINGS.find((f) => f.key === "offlineMode");
    expect(field?.type).toBe("boolean");
    expect(field?.group).toBe("offline");
    expect(readSettings(DEFAULT_CONFIG).values.offlineMode).toBe(false);

    const dir = await makeDir("yta-offline-settings-");
    const path = join(dir, "config.json");
    setConfig({ ...DEFAULT_CONFIG, secondaryStoragePath: dir });
    const result = await applySettings(getConfig(), { offlineMode: true }, path);
    expect(result.ok).toBe(true);
    expect(result.changed).toContain("offlineMode");
    // Live immediately (workers re-read getConfig every loop) …
    expect(getConfig().offlineMode).toBe(true);
    // … and persisted, so the next start still knows.
    expect(JSON.parse(await readFile(path, "utf8")).offlineMode).toBe(true);
    setConfig({ ...DEFAULT_CONFIG });
  });

  test("the network monitor stays idle offline and resumes probing after a live toggle", async () => {
    const previousConfig = getConfig();
    const previousPause = { paused: isPaused(), reason: getPauseReason() };
    const controller = new AbortController();
    let probes = 0;
    setPaused(false, null);
    setConfig({ ...DEFAULT_CONFIG, offlineMode: true });
    const monitor = networkMonitor({
      intervalMs: 2,
      signal: controller.signal,
      probe: async () => {
        probes++;
        return true;
      },
    });

    try {
      await Bun.sleep(20);
      expect(probes).toBe(0);
      setConfig({ ...DEFAULT_CONFIG, offlineMode: false });
      await Bun.sleep(20);
      expect(probes).toBeGreaterThan(0);
    } finally {
      controller.abort();
      await monitor;
      setConfig(previousConfig);
      setPaused(previousPause.paused, previousPause.reason);
    }
  });
});

// ---------------------------------------------------------------------------
// isPathInside — the "already in secondary storage" test
// ---------------------------------------------------------------------------

describe("isPathInside", () => {
  test("true for the root itself and for real descendants", () => {
    expect(isPathInside("/data/nas", "/data/nas")).toBe(true);
    expect(isPathInside("/data/nas/Folder/file.mp4", "/data/nas")).toBe(true);
    expect(isPathInside("/data/nas/./Folder/../other/file.mp4", "/data/nas")).toBe(true);
  });

  test("false for siblings sharing a prefix, and for the output tree", () => {
    // The bug a string prefix would have: /data/nas2 is NOT inside /data/nas.
    expect(isPathInside("/data/nas2/file.mp4", "/data/nas")).toBe(false);
    expect(isPathInside("/data/downloads/file.mp4", "/data/nas")).toBe(false);
    expect(isPathInside("/data", "/data/nas")).toBe(false);
  });

  test("empty inputs are never inside anything", () => {
    expect(isPathInside("", "/data/nas")).toBe(false);
    expect(isPathInside("/data/nas/file.mp4", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Relocation
// ---------------------------------------------------------------------------

const JOB_FOLDER = "Mock Playlist";

/** A finished download: media + info.json sidecar in the output tree. */
async function makeFinishedJob(
  id: string,
  opts: {
    media?: string;
    sidecar?: boolean;
    downloadStatus?: string;
    conversionStatus?: string;
    metadataStatus?: string;
  } = {},
): Promise<{ file: string; dir: string; media: string }> {
  const root = await makeDir("yta-offline-dl-");
  const dir = join(root, JOB_FOLDER);
  await mkdir(dir, { recursive: true });
  const media = opts.media ?? "001 - Video.mp4";
  const file = join(dir, media);
  await writeFile(file, "media-bytes");
  if (opts.sidecar !== false) await writeFile(join(dir, `${media.replace(/\.[^.]+$/, "")}.info.json`), "{}");
  db.run(
    `INSERT INTO jobs (id, url, title, output_directory, folder, "index",
       download_status, conversion_status, metadata_status, file_path, file_size, progress, best_progress)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 12, 100, 100)`,
    [
      id,
      `https://www.youtube.com/watch?v=${id}`,
      `Video ${id}`,
      root,
      JOB_FOLDER,
      opts.downloadStatus ?? "downloaded",
      opts.conversionStatus ?? "done",
      opts.metadataStatus ?? "not_needed",
      file,
    ],
  );
  return { file, dir, media };
}

function configWith(secondaryStoragePath: string, overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, secondaryStoragePath, ...overrides };
}

describe("relocateFinishedJobs", () => {
  test("moves a converted file and its sidecar, and records where it went", async () => {
    const secondary = await makeDir("yta-offline-nas-");
    const { file, dir, media } = await makeFinishedJob("reloc-move");

    const report = await relocateFinishedJobs(configWith(secondary));

    expect(report).toMatchObject({ moved: 1, adopted: 0, alreadyThere: 0, failed: 0 });
    const dest = join(secondary, JOB_FOLDER, media);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(secondary, JOB_FOLDER, "001 - Video.info.json"))).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(dir, "001 - Video.info.json"))).toBe(false);
    const row = db.query("SELECT file_path, relocated_to FROM jobs WHERE id = 'reloc-move'").get() as any;
    expect(row.file_path).toBe(dest);
    expect(row.relocated_to).toBe(secondary);
  });

  test("a second pass has nothing left to do (idempotent)", async () => {
    const secondary = await makeDir("yta-offline-nas-");
    await makeFinishedJob("reloc-idem");
    await relocateFinishedJobs(configWith(secondary));

    const again = await relocateFinishedJobs(configWith(secondary));

    expect(again).toMatchObject({ moved: 0, adopted: 0, alreadyThere: 0, skipped: 0, failed: 0 });
    expect(relocationPendingCount(configWith(secondary))).toBe(0);
  });

  test("no secondary storage configured: the pass is a no-op", async () => {
    const { file } = await makeFinishedJob("reloc-none");
    const report = await relocateFinishedJobs({ ...DEFAULT_CONFIG, secondaryStoragePath: "" });
    expect(report).toMatchObject({ moved: 0, skipped: 0, failed: 0 });
    expect(existsSync(file)).toBe(true);
    expect((db.query("SELECT file_path FROM jobs WHERE id = 'reloc-none'").get() as any).file_path).toBe(file);
  });

  test("a file already in secondary storage is adopted, not copied onto itself", async () => {
    // The crash window this heals: the previous run copied the file, then died
    // before recording it — the row still points at the source, which is gone
    // (the move staged the sidecars first and the media last, so both live in
    // secondary storage already). Adopting beats failing forever on a path
    // that no longer exists.
    const secondary = await makeDir("yta-offline-nas-");
    const destDir = join(secondary, JOB_FOLDER);
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, "001 - Video.mp4");
    await writeFile(dest, "already-moved");

    const { file } = await makeFinishedJob("reloc-adopt", { sidecar: false });
    await rm(file);
    const stalePath = join(file); // what the row still records

    const report = await relocateFinishedJobs(configWith(secondary));

    expect(report).toMatchObject({ moved: 0, adopted: 1 });
    const row = db.query("SELECT file_path, relocated_to FROM jobs WHERE id = 'reloc-adopt'").get() as any;
    expect(row.file_path).toBe(dest);
    expect(row.relocated_to).toBe(secondary);
    expect(stalePath).not.toBe(dest);
    expect(await readFile(dest, "utf8")).toBe("already-moved");
  });

  test("a file already under the configured root is only recorded, never moved", async () => {
    // Moved by hand (or by an engine version that predates `relocated_to`):
    // recognising it is what keeps the pass from renaming a file onto itself
    // on every single tick.
    const secondary = await makeDir("yta-offline-nas-");
    const destDir = join(secondary, JOB_FOLDER);
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, "001 - Video.mp4");
    await writeFile(dest, "already-there");
    await makeFinishedJob("reloc-there", { sidecar: false });
    db.run("UPDATE jobs SET file_path = ? WHERE id = 'reloc-there'", [dest]);

    const report = await relocateFinishedJobs(configWith(secondary));

    expect(report).toMatchObject({ moved: 0, adopted: 0, alreadyThere: 1 });
    expect(await readFile(dest, "utf8")).toBe("already-there");
    expect((db.query("SELECT relocated_to FROM jobs WHERE id = 'reloc-there'").get() as any).relocated_to).toBe(
      secondary,
    );
  });

  test("a missing source whose file is not in secondary storage is left alone", async () => {
    // A genuinely missing file belongs to reconcileMissingFiles / the download
    // stage — relocation must not pretend it succeeded.
    const secondary = await makeDir("yta-offline-nas-");
    await makeFinishedJob("reloc-missing");
    db.run("UPDATE jobs SET file_path = ? WHERE id = 'reloc-missing'", [join(secondary, "nope", "gone.mp4")]);

    const report = await relocateFinishedJobs(configWith(secondary));

    expect(report).toMatchObject({ moved: 0, adopted: 0, failed: 0, skipped: 1 });
    expect((db.query("SELECT relocated_to FROM jobs WHERE id = 'reloc-missing'").get() as any).relocated_to).toBeNull();
  });

  test("jobs that are not finished downloads are never candidates", async () => {
    const secondary = await makeDir("yta-offline-nas-");
    // Still downloading, still to convert, mid-sidecar-fetch, or failed: none
    // of them may have their media moved out from under the stage that owns it.
    await makeFinishedJob("reloc-pending", { downloadStatus: "pending" });
    await makeFinishedJob("reloc-needs-convert", { conversionStatus: "pending" });
    await makeFinishedJob("reloc-metadata", { metadataStatus: "in_progress" });
    await makeFinishedJob("reloc-failed-convert", { conversionStatus: "failed" });

    const report = await relocateFinishedJobs(configWith(secondary));

    expect(report).toMatchObject({ moved: 0, adopted: 0, failed: 0 });
    expect(relocationPendingCount(configWith(secondary))).toBe(0);
  });

  test("a move that fails keeps the file where it is and leaves the row retryable", async () => {
    // The destination is an existing, non-empty DIRECTORY with the media's
    // name: both rename and copy fail on every platform — the portable stand-in
    // for an unplugged or full secondary disk.
    const secondary = await makeDir("yta-offline-nas-");
    const { file } = await makeFinishedJob("reloc-blocked");
    await mkdir(join(secondary, JOB_FOLDER, "001 - Video.mp4"), { recursive: true });
    await writeFile(join(secondary, JOB_FOLDER, "001 - Video.mp4", "keep"), "blocked");

    const report = await relocateFinishedJobs(configWith(secondary));

    expect(report.failed).toBe(1);
    expect(existsSync(file)).toBe(true);
    const row = db.query("SELECT file_path, relocated_to FROM jobs WHERE id = 'reloc-blocked'").get() as any;
    expect(row.file_path).toBe(file);
    expect(row.relocated_to).toBeNull();
    expect(relocationPendingCount(configWith(secondary))).toBe(1);
  });

  test("relocation runs in online mode too, not only offline", async () => {
    // Setting secondaryStoragePath on an existing archive is the other half of
    // the same operator need.
    const secondary = await makeDir("yta-offline-nas-");
    await makeFinishedJob("reloc-online");
    const offline: Config = { ...DEFAULT_CONFIG, secondaryStoragePath: secondary, offlineMode: false };

    expect(offline.offlineMode).toBe(false);
    const report = await relocateFinishedJobs(offline);
    expect(report.moved).toBe(1);
  });
});

describe("relocation bookkeeping", () => {
  test("the final update compare-and-swaps on the old path", async () => {
    await makeFinishedJob("reloc-cas");
    // A stale mover (or a row that was re-downloaded meanwhile) presents a path
    // the row no longer has: the update must change nothing.
    expect(recordRelocatedFile("reloc-cas", "/somewhere/else.mp4", "/nas/x.mp4", "/nas")).toBe(0);
    const { file } = await makeFinishedJob("reloc-cas2");
    expect(recordRelocatedFile("reloc-cas2", file, file, "/nas")).toBe(1);
    expect((db.query("SELECT relocated_to FROM jobs WHERE id = 'reloc-cas2'").get() as any).relocated_to).toBe("/nas");
  });

  test("a different secondary root makes every file eligible again", async () => {
    const first = await makeDir("yta-offline-nas1-");
    const second = await makeDir("yta-offline-nas2-");
    await makeFinishedJob("reloc-root");
    await relocateFinishedJobs(configWith(first));
    expect(relocationPendingCount(configWith(first))).toBe(0);

    // The operator points secondary storage somewhere new: the file is listed
    // again (and a stale `relocated_to` never blocks it).
    expect(relocationPendingCount(configWith(second))).toBe(1);
    await relocateFinishedJobs(configWith(second));
    const row = db.query("SELECT file_path, relocated_to FROM jobs WHERE id = 'reloc-root'").get() as any;
    expect(row.relocated_to).toBe(second);
    expect(isPathInside(row.file_path, second)).toBe(true);
  });

  test("candidates are listed oldest first", async () => {
    const secondary = await makeDir("yta-offline-nas-");
    await makeFinishedJob("reloc-order-a");
    db.run("UPDATE jobs SET created_at = datetime('now', '-2 hours') WHERE id = 'reloc-order-a'");
    await makeFinishedJob("reloc-order-b");
    const ids = listJobsAwaitingRelocation(secondary).map((r) => r.id);
    expect(ids).toEqual(["reloc-order-a", "reloc-order-b"]);
  });
});
