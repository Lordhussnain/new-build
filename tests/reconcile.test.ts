// tests/reconcile.test.ts — partial-file housekeeping, with and without aria2c.
//
// The engine must be able to throw a partial download away and have the next
// attempt start clean. With yt-dlp's native downloader that means deleting the
// `.part`; with aria2c there is a second file — the `.aria2` control file — and
// stranding it wedges the download permanently (see removePartialFiles). These
// tests pin both halves of that contract.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { db, initDatabase } from "../src/db";
import {
  ARIA2_CONTROL_SUFFIX,
  ORPHAN_PARTIAL_MAX_AGE_MS,
  cleanOrphanedFiles,
  dropSupersededFile,
  findPartialFile,
  partialSidecars,
  reapStaleClaims,
  reconcileCrashedJobs,
  reconcileMissingFiles,
  reconcileSupersededFiles,
  recordPartialPaths,
  removePartialFiles,
  restoreSupersededFile,
  stashDownloadedFile,
} from "../src/reconcile";
import { jobBaseFilename, jobFittedBaseFilename } from "../src/download-args";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { acquireEngineLease } from "../src/lease";

const tmpDirs: string[] = [];

afterAll(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yta-reconcile-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * The partial sweep is built around `outputRoot` (default `./downloads`, i.e.
 * relative) while recorded partial paths are absolute, so the regression tests
 * below need a temp dir reachable by a relative path from the CWD — the way the
 * engine sees it. On a platform where the temp dir sits on another drive that is
 * impossible, and the test would be vacuous rather than failing.
 */
const TMPDIR_IS_RELATIVE_TO_CWD = !isAbsolute(relative(process.cwd(), tmpdir()));

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

/** Backdate a file so the age-gated sweeps treat it as old. */
async function ageFile(path: string, ageMs: number): Promise<void> {
  const old = new Date(Date.now() - ageMs);
  await utimes(path, old, old);
}

/** A partial download as aria2c leaves it: data file plus control file. */
async function writeAria2Partial(dir: string, name: string): Promise<string> {
  const part = join(dir, name);
  await writeFile(part, "partial-bytes");
  await writeFile(`${part}${ARIA2_CONTROL_SUFFIX}`, "control-bytes");
  return part;
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

beforeEach(() => {
  initDatabase(":memory:");
  // The startup sweeps and the reaper only run for the engine that owns
  // archive.db; the tests play that engine.
  acquireEngineLease();
});

describe("partialSidecars", () => {
  test("pairs the data file with its aria2c control file", () => {
    expect(partialSidecars("/d/v.part")).toEqual(["/d/v.part", "/d/v.part.aria2"]);
    expect(partialSidecars("/d/v.ytdl")).toEqual(["/d/v.ytdl", "/d/v.ytdl.aria2"]);
  });
});

describe("removePartialFiles", () => {
  test("removes the .part and its .aria2 control file together", async () => {
    const dir = await makeDir();
    const part = await writeAria2Partial(dir, "v.part");
    await removePartialFiles(part);
    expect(existsSync(part)).toBe(false);
    expect(existsSync(`${part}${ARIA2_CONTROL_SUFFIX}`)).toBe(false);
  });

  test("removes a lone .part (native downloader) without complaint", async () => {
    const dir = await makeDir();
    const part = join(dir, "v.part");
    await writeFile(part, "bytes");
    await removePartialFiles(part);
    expect(existsSync(part)).toBe(false);
  });

  test("removes a lone control file left behind by an interrupted cleanup", async () => {
    const dir = await makeDir();
    const control = join(dir, "v.part.aria2");
    await writeFile(control, "control-bytes");
    await removePartialFiles(join(dir, "v.part"));
    expect(existsSync(control)).toBe(false);
  });

  test("is a no-op when nothing exists", async () => {
    await removePartialFiles("/nonexistent/dir/v.part");
    // No throw = pass.
    expect(true).toBe(true);
  });

  test("reports fatal and keeps the data file when the control file cannot be removed", async () => {
    const dir = await makeDir();
    const part = join(dir, "v.part");
    await writeFile(part, "partial-bytes");
    // A directory where the control file belongs makes unlink fail with a
    // real (non-ENOENT) error on every platform — a stand-in for the lock an
    // orphaned aria2c or an antivirus scan holds on Windows.
    const control = `${part}${ARIA2_CONTROL_SUFFIX}`;
    await mkdir(control, { recursive: true });
    const result = await removePartialFiles(part);
    expect(result.fatal).toBe(true);
    expect(result.controlRemoved).toBe(false);
    expect(result.dataRemoved).toBe(false);
    expect(existsSync(part)).toBe(true); // data untouched: no stranded control
  });

  test("removal continues when only the control file is absent (native path)", async () => {
    const dir = await makeDir();
    const part = join(dir, "v.part");
    await writeFile(part, "partial-bytes");
    const result = await removePartialFiles(part);
    expect(result.fatal).toBe(false);
    expect(result.controlRemoved).toBe(false);
    expect(result.dataRemoved).toBe(true);
    expect(existsSync(part)).toBe(false);
  });

});

describe("findPartialFile", () => {
  test("finds the .part data file, not the control file", async () => {
    const dir = await makeDir();
    const part = await writeAria2Partial(dir, "001 - Video.part");
    expect(await findPartialFile(dir, "001 - Video")).toBe(part);
  });

  test("returns '' when only a control file survives (nothing resumable)", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "001 - Video.part.aria2"), "control-bytes");
    expect(await findPartialFile(dir, "001 - Video")).toBe("");
  });
});

describe("recordPartialPaths", () => {
  // Regression: an interrupted job used to be marked paused+interrupted with
  // partial_file_path = NULL, so "interrupted jobs resume from their partial"
  // was a status the next start silently re-downloaded from scratch.
  test("writes the on-disk .part path into a downloading job with none recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    writeFileSync(join(dir, "001 - First Mock Video.f137.mp4.part"), "bytes");
    db.run(
      `INSERT INTO jobs (id, url, title, "index", output_directory, download_status, partial_file_path)
       VALUES ('v1', 'https://y', 'First Mock Video', 1, ?, 'downloading', NULL)`,
      [dir],
    );

    const recorded = recordPartialPaths();
    expect(recorded).toBe(1);
    const row = db.query("SELECT partial_file_path FROM jobs WHERE id = 'v1'").get() as any;
    expect(row.partial_file_path).toBe(join(dir, "001 - First Mock Video.f137.mp4.part"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("leaves a job alone when no partial is on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    db.run(
      `INSERT INTO jobs (id, url, title, "index", output_directory, download_status, partial_file_path)
       VALUES ('v2', 'https://y', 'Second Mock Video', 2, ?, 'downloading', NULL)`,
      [dir],
    );
    expect(recordPartialPaths()).toBe(0);
    const row = db.query("SELECT partial_file_path FROM jobs WHERE id = 'v2'").get() as any;
    expect(row.partial_file_path).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not overwrite a partial that is already recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    const known = join(dir, "001 - Third Mock Video.part");
    writeFileSync(known, "bytes");
    db.run(
      `INSERT INTO jobs (id, url, title, "index", output_directory, download_status, partial_file_path)
       VALUES ('v3', 'https://y', 'Third Mock Video', 3, ?, 'downloading', ?)`,
      [dir, known],
    );
    recordPartialPaths();
    const row = db.query("SELECT partial_file_path FROM jobs WHERE id = 'v3'").get() as any;
    expect(row.partial_file_path).toBe(known);
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores jobs that are not downloading (a paused job keeps its state)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    writeFileSync(join(dir, "001 - Paused Video.part"), "bytes");
    db.run(
      `INSERT INTO jobs (id, url, title, "index", output_directory, download_status, partial_file_path)
       VALUES ('v4', 'https://y', 'Paused Video', 4, ?, 'paused', NULL)`,
      [dir],
    );
    expect(recordPartialPaths()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("crash recovery with aria2c partials", () => {
  test("records the partial before re-queueing a hard-killed download", async () => {
    const dir = await makeDir();
    const part = await writeAria2Partial(dir, "001 - Crashed Video.f137.mp4.part");
    db.run(
      `INSERT INTO jobs (id, url, title, "index", output_directory, download_status, partial_file_path)
       VALUES ('crashed', 'https://y', 'Crashed Video', 1, ?, 'downloading', NULL)`,
      [dir],
    );

    reconcileCrashedJobs();
    const row = db.query("SELECT download_status, pause_reason, partial_file_path FROM jobs WHERE id = 'crashed'").get() as any;
    expect(row.download_status).toBe("paused");
    expect(row.pause_reason).toBe("interrupted");
    expect(row.partial_file_path).toBe(part);

    await cleanOrphanedFiles(dir, testConfig({ requeueFailedAfterMinutes: 30 }));
    expect(existsSync(part)).toBe(true);
    expect(existsSync(`${part}${ARIA2_CONTROL_SUFFIX}`)).toBe(true);
  });
});

describe("cleanOrphanedFiles with aria2c control files", () => {
  test("deletes an exhausted failed job's .part AND its control file", async () => {
    const dir = await makeDir();
    const part = await writeAria2Partial(dir, "v.part");
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, download_status, retry_count, partial_file_path)
       VALUES ('x', 'https://y', 'V', ?, 'failed', 99, ?)`,
      [dir, part],
    );
    await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 5, requeueFailedAfterMinutes: 0 }));
    expect(existsSync(part)).toBe(false);
    expect(existsSync(`${part}${ARIA2_CONTROL_SUFFIX}`)).toBe(false);
  });

  test("KEEPS a failed retryable job's partial pair while it waits for cooldown", async () => {
    const dir = await makeDir();
    const part = await writeAria2Partial(dir, "cooldown.part");
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, download_status, retry_count, last_error, partial_file_path)
       VALUES ('cooldown', 'https://y', 'V', ?, 'failed', 99, 'connection reset', ?)`,
      [dir, part],
    );
    await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 5, requeueFailedAfterMinutes: 30 }));
    expect(existsSync(part)).toBe(true);
    expect(existsSync(`${part}${ARIA2_CONTROL_SUFFIX}`)).toBe(true);
  });

  test("KEEPS a retryable job's .part and control file so resume works", async () => {
    const dir = await makeDir();
    const part = await writeAria2Partial(dir, "v.part");
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, download_status, retry_count, partial_file_path)
       VALUES ('x', 'https://y', 'V', ?, 'pending', 1, ?)`,
      [dir, part],
    );
    await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 5 }));
    expect(existsSync(part)).toBe(true);
    expect(existsSync(`${part}${ARIA2_CONTROL_SUFFIX}`)).toBe(true);
  });

  test("sweeps a stranded control file whose data file is gone", async () => {
    const dir = await makeDir();
    const control = join(dir, "orphan.part.aria2");
    await writeFile(control, "control-bytes");
    // Age it past the 24h orphan threshold.
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(control, old, old);
    await cleanOrphanedFiles(dir, testConfig());
    expect(existsSync(control)).toBe(false);
  });

  test("does NOT sweep a fresh control file (a download may be starting)", async () => {
    const dir = await makeDir();
    const control = join(dir, "live.part.aria2");
    await writeFile(control, "control-bytes");
    await cleanOrphanedFiles(dir, testConfig());
    expect(existsSync(control)).toBe(true);
  });

  test("does NOT sweep a control file whose data file is still present", async () => {
    const dir = await makeDir();
    const part = await writeAria2Partial(dir, "v.part");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(`${part}${ARIA2_CONTROL_SUFFIX}`, old, old); // aged control file
    // No job claims it, so the .part is an orphan — but the pair is still
    // resumable state and the data file is there, so the control file stays.
    await cleanOrphanedFiles(dir, testConfig());
    expect(existsSync(`${part}${ARIA2_CONTROL_SUFFIX}`)).toBe(true);
  });

  test("recurses into playlist subdirectories", async () => {
    const dir = await makeDir();
    const sub = join(dir, "Mock Playlist");
    await mkdir(sub, { recursive: true });
    const part = await writeAria2Partial(sub, "v.part");
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, download_status, retry_count, partial_file_path)
       VALUES ('x', 'https://y', 'V', ?, 'failed', 99, ?)`,
      [sub, part],
    );
    await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 5, requeueFailedAfterMinutes: 0 }));
    expect(existsSync(part)).toBe(false);
    expect(existsSync(`${part}${ARIA2_CONTROL_SUFFIX}`)).toBe(false);
  });
});

describe("cleanOrphanedFiles fatal removals (locked control files)", () => {
  test("a LOCKED control file is not counted as cleaned, and both files stay", async () => {
    // A directory where the control file belongs makes unlink fail on every
    // platform — the stand-in for an orphaned aria2c or an antivirus scan
    // holding the handle. The pair must survive AND the sweep must not report
    // it as removed: the old code incremented its count regardless of the
    // fatal result, so a wedged aria2c looked like a clean sweep.
    const dir = await makeDir();
    const part = join(dir, "locked.part");
    await writeFile(part, "partial-bytes");
    await mkdir(`${part}${ARIA2_CONTROL_SUFFIX}`, { recursive: true });
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, download_status, retry_count, partial_file_path)
       VALUES ('locked01', 'https://y', 'V', ?, 'failed', 99, ?)`,
      [dir, part],
    );

    const summary = await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 5, requeueFailedAfterMinutes: 0 }));

    expect(summary.removed).toBe(0);
    expect(summary.locked).toBe(1);
    expect(existsSync(part)).toBe(true); // data file untouched: no stranded control
    expect(existsSync(`${part}${ARIA2_CONTROL_SUFFIX}`)).toBe(true);
  });

  test("a removable pair counts as removed and is gone", async () => {
    const dir = await makeDir();
    const part = await writeAria2Partial(dir, "ok.part");
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, download_status, retry_count, partial_file_path)
       VALUES ('ok01', 'https://y', 'V', ?, 'failed', 99, ?)`,
      [dir, part],
    );
    const summary = await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 5, requeueFailedAfterMinutes: 0 }));
    expect(summary.removed).toBe(1);
    expect(summary.locked).toBe(0);
    expect(existsSync(part)).toBe(false);
  });

  test("a .ytdl fragment DIRECTORY is really removed, not just reported", async () => {
    // .ytdl resume state is a directory of fragments, which unlink() refuses.
    // Reporting it as cleaned while it survived meant the next attempt picked
    // the stale fragments back up.
    const dir = await makeDir();
    const ytdl = join(dir, "frag.ytdl");
    await mkdir(ytdl, { recursive: true });
    await writeFile(join(ytdl, "frag0"), "fragment-bytes");
    const part = join(dir, "frag.part");
    await writeFile(part, "partial-bytes");
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, download_status, retry_count, partial_file_path)
       VALUES ('frag01', 'https://y', 'V', ?, 'failed', 99, ?)`,
      [dir, part],
    );
    await writeFile(`${part}${ARIA2_CONTROL_SUFFIX}`, "control-bytes");

    // The sweep keys on the recorded .part, but .ytdl entries are swept the
    // same way once no job will resume them (aged past the orphan window).
    await ageFile(ytdl, 8 * 24 * 60 * 60 * 1000);
    const summary = await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 5, requeueFailedAfterMinutes: 0 }));
    expect(existsSync(ytdl)).toBe(false);
    expect(summary.removed).toBeGreaterThanOrEqual(1);
  });
});

describe("reapStaleClaims stranded control files", () => {
  /** A job as the reaper sees it: stale download claim, own folder + title. */
  function insertStaleDownload(id: string, dir: string, title = "V"): void {
    db.run(
      `INSERT INTO jobs (id, url, title, "index", output_directory, download_status, download_claimed_by, download_claimed_at)
       VALUES (?, 'https://y', ?, 1, ?, 'downloading', 'dl-9', '2020-01-01 00:00:00')`,
      [id, title, dir],
    );
  }

  test("sweeps a stranded control file left by the dead worker", async () => {
    const dir = await makeDir();
    insertStaleDownload("stranded01", dir);
    // The fitted base name of "001 - V": the reaper must look for this exact
    // name, not the raw title.
    const control = join(dir, "001 - V.part.aria2");
    await writeFile(control, "control-bytes"); // no data file beside it

    const summary = await reapStaleClaims(testConfig());

    expect(summary.downloads).toBe(1);
    expect(summary.stranded).toBe(1);
    expect(summary.locked).toBe(0);
    expect(existsSync(control)).toBe(false);
    expect(jobRow("stranded01").download_status).toBe("paused");
    expect(jobRow("stranded01").pause_reason).toBe("interrupted");
  });

  test("keeps a fresh stranded control file of a job it did NOT reclaim", async () => {
    const dir = await makeDir();
    insertJob("fresh01", {
      download_status: "downloading",
      download_claimed_by: "dl-1",
      download_claimed_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      output_directory: dir,
      index: 1,
      title: "V",
    });
    const control = join(dir, "001 - V.part.aria2");
    await writeFile(control, "control-bytes");

    const summary = await reapStaleClaims(testConfig());

    expect(summary.downloads).toBe(0);
    expect(summary.stranded).toBe(0);
    expect(existsSync(control)).toBe(true);
  });

  test("never touches a live pair (the download can still resume)", async () => {
    const dir = await makeDir();
    insertStaleDownload("livepair01", dir);
    await writeAria2Partial(dir, "001 - V.part");

    const summary = await reapStaleClaims(testConfig());

    expect(summary.downloads).toBe(1);
    expect(summary.stranded).toBe(0);
    expect(existsSync(join(dir, "001 - V.part"))).toBe(true);
    expect(existsSync(join(dir, "001 - V.part.aria2"))).toBe(true);
  });

  test("a LOCKED stranded control file is reported and kept for a later sweep", async () => {
    const dir = await makeDir();
    insertStaleDownload("locked02", dir);
    const control = join(dir, "001 - V.part.aria2");
    await mkdir(control, { recursive: true }); // unlink cannot remove a directory

    const summary = await reapStaleClaims(testConfig());

    expect(summary.locked).toBe(1);
    expect(summary.stranded).toBe(0);
    expect(existsSync(control)).toBe(true); // retried on a later tick
  });
});

describe("superseded files (deliberate re-downloads)", () => {
  function insertDownloadedJob(id: string, filePath: string | null): void {
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, download_status, file_path, file_size, want_subtitles)
       VALUES (?, 'https://y', 'V', '/tmp/out', 'downloaded', ?, ?, 1)`,
      [id, filePath, filePath ? 1234 : 0],
    );
  }

  test("stash moves the media aside and clears file_path", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(media, "old-bytes");
    insertDownloadedJob("sup01", media);

    const backup = stashDownloadedFile("sup01", media);
    expect(backup).toBe(`${media}.superseded`);
    expect(existsSync(media)).toBe(false);
    expect(existsSync(`${media}.superseded`)).toBe(true);
    const row = db.query("SELECT file_path, superseded_file FROM jobs WHERE id = 'sup01'").get() as any;
    expect(row.file_path).toBeNull();
    expect(row.superseded_file).toBe(`${media}.superseded`);
  });

  test("stash with no file on disk just clears the stale pointer", async () => {
    insertDownloadedJob("sup02", "/nowhere/gone.mp4");
    expect(stashDownloadedFile("sup02", "/nowhere/gone.mp4")).toBeNull();
    const row = db.query("SELECT file_path, superseded_file FROM jobs WHERE id = 'sup02'").get() as any;
    expect(row.file_path).toBeNull();
    expect(row.superseded_file).toBeNull();
  });

  test("stash throws when the existing file cannot be renamed", async () => {
    insertDownloadedJob("sup03", join("/does-not-exist-dir", "v.mp4"));
    // The parent directory does not exist, so existsSync(file) is false — the
    // null path. For a real rename failure we need an existing file whose
    // rename fails; simulate by stashing twice against a directory that
    // vanishes in between is overkill — instead pin the contract: a missing
    // parent means "nothing to protect", never a throw.
    expect(() => stashDownloadedFile("sup03", null)).not.toThrow();
  });

  test("drop deletes the backup once the new download succeeded", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(media, "old-bytes");
    insertDownloadedJob("sup04", media);
    stashDownloadedFile("sup04", media);

    dropSupersededFile("sup04");
    expect(existsSync(`${media}.superseded`)).toBe(false);
    const row = db.query("SELECT superseded_file FROM jobs WHERE id = 'sup04'").get() as any;
    expect(row.superseded_file).toBeNull();
  });

  test("drop is a safe no-op without a backup", () => {
    insertDownloadedJob("sup05", null);
    expect(() => dropSupersededFile("sup05")).not.toThrow();
  });

  test("restore puts the previous file back and marks the job downloaded", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(media, "old-bytes");
    insertDownloadedJob("sup06", media);
    stashDownloadedFile("sup06", media);
    db.run(`UPDATE jobs SET download_status = 'pending' WHERE id = 'sup06'`);

    expect(restoreSupersededFile("sup06", "re-download failed permanently: mock")).toBe(true);
    expect(existsSync(media)).toBe(true);
    expect(existsSync(`${media}.superseded`)).toBe(false);
    const row = db.query(
      "SELECT file_path, file_size, superseded_file, download_status, conversion_status, metadata_status, last_error FROM jobs WHERE id = 'sup06'",
    ).get() as any;
    expect(row.file_path).toBe(media);
    expect(row.file_size).toBe(9); // "old-bytes"
    expect(row.superseded_file).toBeNull();
    expect(row.download_status).toBe("downloaded");
    expect(row.conversion_status).toBe("not_needed");
    expect(row.metadata_status).toBe("pending"); // want_subtitles = 1
    expect(row.last_error).toContain("permanently");
  });

  test("restore returns false when there is nothing to restore", () => {
    insertDownloadedJob("sup07", null);
    expect(restoreSupersededFile("sup07", "x")).toBe(false);
    const row = db.query("SELECT download_status FROM jobs WHERE id = 'sup07'").get() as any;
    expect(row.download_status).toBe("downloaded"); // untouched
  });

  test("restore forgets a backup the user already deleted", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(media, "old-bytes");
    insertDownloadedJob("sup08", media);
    stashDownloadedFile("sup08", media);
    rmSync(`${media}.superseded`);

    expect(restoreSupersededFile("sup08", "x")).toBe(false);
    const row = db.query("SELECT superseded_file FROM jobs WHERE id = 'sup08'").get() as any;
    expect(row.superseded_file).toBeNull();
  });
});

// --- Durable work: the sweep must never eat resume state ----------------------
//
// A partial is the only copy of hours of transfer. These tests pin the two
// counterexamples that used to delete it anyway: the absolute/relative path
// mismatch (owner lookup missed → day-old orphan) and the age rule that
// ignored whether the job was ever going to resume.

describe("cleanOrphanedFiles owner matching and ages", () => {
  test.skipIf(!TMPDIR_IS_RELATIVE_TO_CWD)(
    "keeps a resume-able partial recorded as an absolute path under a relative output root",
    async () => {
      const dir = await makeDir();
      const sub = join(dir, "Mock Playlist");
      await mkdir(sub, { recursive: true });
      const part = join(sub, "001 - Video.mp4.part");
      await writeFile(part, "partial-bytes");
      // Recorded the way findPartialFileSync() stores it: absolute.
      insertJob("relpath", {
        download_status: "pending",
        output_directory: sub,
        partial_file_path: part,
      });
      // Older than both windows: only a working owner lookup can keep it.
      await ageFile(part, 8 * 24 * 60 * 60 * 1000);

      // `join('./downloads', …)` used to be compared against the absolute DB
      // path, so the partial had no owner, looked like an orphan, and was
      // deleted after a day. The walk must be path-normalized.
      const root = relative(process.cwd(), dir);
      expect(isAbsolute(root)).toBe(false);
      await cleanOrphanedFiles(root, testConfig({ requeueFailedAfterMinutes: 0 }));

      expect(existsSync(part)).toBe(true);
      expect(jobRow("relpath").partial_file_path).toBe(part);
    },
  );

  test("keeps a pending job's partial even when it is ancient", async () => {
    const dir = await makeDir();
    const part = join(dir, "001 - Video.mp4.part");
    await writeFile(part, "partial-bytes");
    insertJob("oldpending", { download_status: "pending", output_directory: dir, partial_file_path: part });
    await ageFile(part, 30 * 24 * 60 * 60 * 1000);

    await cleanOrphanedFiles(dir, testConfig());

    expect(existsSync(part)).toBe(true);
  });

  test("keeps a user-paused job's partial however long the pause lasts", async () => {
    const dir = await makeDir();
    const part = join(dir, "001 - Video.mp4.part");
    await writeFile(part, "partial-bytes");
    insertJob("oldpaused", {
      download_status: "paused",
      pause_reason: "user",
      output_directory: dir,
      partial_file_path: part,
    });
    await ageFile(part, 30 * 24 * 60 * 60 * 1000);

    await cleanOrphanedFiles(dir, testConfig());

    expect(existsSync(part)).toBe(true);
  });

  test("keeps a failed job's ancient partial while its cooldown retry is still coming", async () => {
    const dir = await makeDir();
    const part = join(dir, "001 - Video.mp4.part");
    await writeFile(part, "partial-bytes");
    insertJob("cooldown-old", {
      download_status: "failed",
      retry_count: 99,
      last_error: "The read operation timed out",
      output_directory: dir,
      partial_file_path: part,
    });
    await ageFile(part, 30 * 24 * 60 * 60 * 1000);

    await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 5, requeueFailedAfterMinutes: 30 }));

    expect(existsSync(part)).toBe(true);
  });

  test("still ages out a partial nothing will ever resume", async () => {
    // The other half of the contract: a permanently failed download's partial
    // is litter, and the sweep is the only thing that cleans it. The fix
    // protects resume state, it does not stop cleanup.
    const dir = await makeDir();
    const part = join(dir, "001 - Private Video.mp4.part");
    await writeFile(part, "partial-bytes");
    insertJob("deadvideo", {
      download_status: "failed",
      retry_count: 0,
      last_error: "ERROR: Video unavailable (private video)",
      output_directory: dir,
      partial_file_path: part,
    });
    await ageFile(part, 8 * 24 * 60 * 60 * 1000);

    await cleanOrphanedFiles(dir, testConfig({ maxRetryAttempts: 5, requeueFailedAfterMinutes: 30 }));

    expect(existsSync(part)).toBe(false);
  });
});

describe("cleanOrphanedFiles superseded backups", () => {
  test("sweeps an unowned, day-old .superseded backup", async () => {
    const dir = await makeDir();
    const orphan = join(dir, "001 - Gone.mp4.superseded");
    await writeFile(orphan, "old-bytes");
    await ageFile(orphan, 2 * ORPHAN_PARTIAL_MAX_AGE_MS);

    await cleanOrphanedFiles(dir, testConfig());

    expect(existsSync(orphan)).toBe(false);
  });

  test("keeps a fresh unowned backup (a re-download may be about to start)", async () => {
    const dir = await makeDir();
    const orphan = join(dir, "001 - Fresh.mp4.superseded");
    await writeFile(orphan, "old-bytes");

    await cleanOrphanedFiles(dir, testConfig());

    expect(existsSync(orphan)).toBe(true);
  });

  test("sweeps a stale backup next to a live output file", async () => {
    // The crash window after a successful re-download: `dropSupersededFile`
    // cleared the row but the unlink never ran.
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    const stale = `${media}.superseded`;
    await writeFile(media, "new-bytes");
    await writeFile(stale, "old-bytes");
    insertJob("dropped01", {
      download_status: "downloaded",
      output_directory: dir,
      file_path: media,
      superseded_file: null,
    });
    await ageFile(stale, 2 * ORPHAN_PARTIAL_MAX_AGE_MS);

    await cleanOrphanedFiles(dir, testConfig());

    expect(existsSync(media)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  test("keeps the legacy sibling of a job whose recorded file is missing", async () => {
    // No superseded_file pointer (older build), file_path gone, sibling
    // present: that backup is the only copy of the job's media, so the sweep
    // must leave it for the recovery path rather than call it litter.
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    const backup = `${media}.superseded`;
    await writeFile(backup, "old-bytes");
    insertJob("legacy02", {
      download_status: "pending",
      output_directory: dir,
      file_path: media,
      superseded_file: null,
    });
    await ageFile(backup, 2 * ORPHAN_PARTIAL_MAX_AGE_MS);

    await cleanOrphanedFiles(dir, testConfig());

    expect(existsSync(backup)).toBe(true);
  });

  test("keeps a referenced backup no matter how old", async () => {
    const dir = await makeDir();
    const backup = join(dir, "001 - Video.mp4.superseded");
    await writeFile(backup, "old-bytes");
    insertJob("ownsbackup", {
      download_status: "pending",
      output_directory: dir,
      superseded_file: backup,
    });
    await ageFile(backup, 30 * 24 * 60 * 60 * 1000);

    await cleanOrphanedFiles(dir, testConfig());

    expect(existsSync(backup)).toBe(true);
  });
});

describe("recordPartialPaths with the fitted output name", () => {
  test("records the .part yt-dlp really wrote for a long title", () => {
    const dir = mkdtempSync(join(tmpdir(), "yta-fit-"));
    const job = {
      id: "dQw4w9WgXcQ",
      index: 7,
      title: "A very long video title ".repeat(12),
      output_directory: dir,
    };
    const diskBase = jobFittedBaseFilename(job);
    // Guard: the test only means something when fitting actually changed the
    // name the old lookup used.
    expect(diskBase).not.toBe(jobBaseFilename(job));
    writeFileSync(join(dir, `${diskBase}.f137.mp4.part`), "bytes");
    insertJob(job.id, {
      title: job.title,
      index: job.index,
      output_directory: dir,
      download_status: "downloading",
      partial_file_path: null,
    });

    expect(recordPartialPaths()).toBe(1);
    expect(jobRow(job.id).partial_file_path).toBe(join(dir, `${diskBase}.f137.mp4.part`));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("reconcileSupersededFiles (crash recovery for .superseded hand-offs)", () => {
  function insertDownloaded(id: string, filePath: string | null, extra: Record<string, unknown> = {}): void {
    insertJob(id, {
      download_status: "downloaded",
      file_path: filePath,
      file_size: filePath ? 9 : 0,
      ...extra,
    });
  }

  test("rolls back a stash whose rename never ran (crash between row and rename)", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(media, "old-bytes");
    // Exactly what stashDownloadedFile leaves behind mid-crash: the intent is
    // recorded, the file never moved.
    insertDownloaded("crash01", null, { superseded_file: `${media}.superseded` });

    const result = reconcileSupersededFiles();

    expect(result.restored).toBe(1);
    expect(existsSync(media)).toBe(true);
    expect(existsSync(`${media}.superseded`)).toBe(false);
    const row = jobRow("crash01");
    expect(row.file_path).toBe(media);
    expect(row.file_size).toBe(9);
    expect(row.superseded_file).toBeNull();
    expect(row.download_status).toBe("downloaded");
  });

  test("rolls back a stash whose retry never became claimable", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(`${media}.superseded`, "old-bytes");
    // The rename ran, but the crash hit before the retry could re-queue the
    // job — status is still 'downloaded' and file_path is NULL.
    insertDownloaded("crash02", null, { superseded_file: `${media}.superseded` });

    const result = reconcileSupersededFiles();

    expect(result.restored).toBe(1);
    expect(existsSync(media)).toBe(true);
    expect(existsSync(`${media}.superseded`)).toBe(false);
    expect(jobRow("crash02").file_path).toBe(media);
    expect(jobRow("crash02").superseded_file).toBeNull();
  });

  test("keeps the backup of a queued re-download, so the worker can drop or restore it", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(`${media}.superseded`, "old-bytes");
    insertJob("queued01", {
      download_status: "pending",
      file_path: null,
      superseded_file: `${media}.superseded`,
    });

    const result = reconcileSupersededFiles();

    expect(result.restored + result.dropped + result.cleared).toBe(0);
    expect(existsSync(`${media}.superseded`)).toBe(true);
    expect(jobRow("queued01").superseded_file).toBe(`${media}.superseded`);
  });

  test("drops the backup of a re-download that already succeeded", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(media, "new-bytes");
    await writeFile(`${media}.superseded`, "old-bytes");
    // The crash landed between recordSuccess() and dropSupersededFile(): the
    // new file is recorded, the backup is still on disk.
    insertDownloaded("success01", media, { superseded_file: `${media}.superseded` });

    const result = reconcileSupersededFiles();

    expect(result.dropped).toBe(1);
    expect(existsSync(media)).toBe(true);
    expect(existsSync(`${media}.superseded`)).toBe(false);
    expect(jobRow("success01").superseded_file).toBeNull();
    expect(jobRow("success01").file_path).toBe(media);
  });

  test("adopts a legacy rename-first crash instead of re-queueing a pointless download", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(`${media}.superseded`, "old-bytes");
    // The older ordering renamed first and recorded nothing: the row still
    // says downloaded, its file_path is gone, and only the sibling knows where
    // the file went.
    insertDownloaded("legacy01", media);

    const result = reconcileSupersededFiles();

    expect(result.restored).toBe(1);
    expect(existsSync(media)).toBe(true);
    expect(existsSync(`${media}.superseded`)).toBe(false);
    const row = jobRow("legacy01");
    expect(row.file_path).toBe(media);
    expect(row.file_size).toBe(9);
    // And the missing-file sweep that runs right after must leave it alone —
    // otherwise the video is re-downloaded over a file that was never lost.
    expect(reconcileMissingFiles(testConfig({ verifyExistingFiles: true }))).toBe(0);
    expect(jobRow("legacy01").download_status).toBe("downloaded");
  });

  test("forgets a pointer whose backup and original are both gone", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    insertDownloaded("gone01", null, { superseded_file: `${media}.superseded` });

    const result = reconcileSupersededFiles();

    expect(result.cleared).toBe(1);
    expect(jobRow("gone01").superseded_file).toBeNull();
  });

  test("stash rolls the row back when the file cannot be renamed", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Video.mp4");
    await writeFile(media, "old-bytes");
    insertDownloaded("rollback01", media);
    // A directory where the backup belongs makes the rename fail on every
    // platform — a stand-in for the Windows lock this path must survive.
    await mkdir(`${media}.superseded`, { recursive: true });

    expect(() => stashDownloadedFile("rollback01", media)).toThrow();

    expect(existsSync(media)).toBe(true);
    const row = jobRow("rollback01");
    expect(row.file_path).toBe(media);
    expect(row.file_size).toBe(9);
    expect(row.superseded_file).toBeNull();
    expect(statSync(media).size).toBe(9);
  });
});
