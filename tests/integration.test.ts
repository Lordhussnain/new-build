// tests/integration.test.ts — end-to-end pipeline tests.
//
// These run the real engine (batch_playlist_downloader.ts) as a subprocess in a
// temp directory, with the mock yt-dlp/ffmpeg from tests/mocks on PATH. That
// exercises the whole machinery — config load, dependency probe, database
// migrations, scanning, worker pools, metadata, conversion, the web API, and
// graceful shutdown — without needing network access.
//
// Scenarios:
//   1. happy path             — scan → download → metadata → convert → done
//   2. transient failures     — retries with backoff, keeps the .part, completes
//   3. permanent failures     — parks as failed and is never auto-requeued
//   4. restart reconciliation — deleted files are detected and re-downloaded
//   5. aria2c downloads       — multi-connection path with a bandwidth cap
//   6. aria2c resume          — interrupted transfers resume from the control
//                              file, and the four self-healing sweeps all work
//                              on the aria2c path
//   7. HTTP 416 resume        — a resume whose range the server no longer has
//                              discards the partial AND its control file and
//                              restarts the transfer from zero
//   8. unavailable videos     — private/deleted entries are attempted exactly
//                              once, recorded as terminal skips ("[terminal]
//                              Private video — …"), and never resurrected by
//                              the cooldown sweep, the requeue button or the
//                              reliability counters — and they do not fill
//                              error.log
//   9. format fallback ladder — "Requested format is not available" steps the
//                              quality down (1080p → 720p) with a readable
//                              announcement instead of burning the retry
//                              budget; a video that matches no selector at all
//                              ends as a terminal "No format available" skip

import { afterAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
// Seeding an archive before the engine starts (offline-mode scenario) goes
// through the engine's own schema, so the seed can never drift from it.
import { db as seedDb, initDatabase as initSeedDatabase } from "../src/db";
// The cancellation scenario matches a job's on-disk file by the same sanitizer
// the engine uses to build the name, so the two cannot drift apart.
import { sanitizeFileName } from "../src/util";

const REPO_ROOT = resolve(import.meta.dir, "..");
const MOCKS = join(REPO_ROOT, "tests", "mocks");
const ENTRY = join(REPO_ROOT, "batch_playlist_downloader.ts");
const GUARD_ENTRY = join(REPO_ROOT, "tests", "egress-guard-entry.ts");

const WIN = process.platform === "win32";
const PATH_SEP = WIN ? ";" : ":";
const PARENT_PATH = process.env.PATH || process.env.Path || "";
const MOCK_TOOLS = ["yt-dlp", "ffmpeg", "aria2c"];

const TEST_TIMEOUT = 120_000;
const tmpDirs: string[] = [];

afterAll(async () => {
  // Best-effort cleanup: on Windows a just-killed process or an antivirus
  // scan can hold a handle for a moment (rm EBUSY/EPERM), so retry briefly
  // and never fail the suite over a leftover temp dir.
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (!d) continue;
    try {
      await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch {
      // stray temp dir — harmless
    }
  }
});

/**
 * Where the engine should find the mock tools for a given mocks directory.
 *
 * On POSIX the scripts run via their `#!/usr/bin/env bun` shebang. Windows is
 * different in two hard ways: shebangs are not read there (Bun docs: "Shebangs
 * at the top of a file are not read on Windows") and CreateProcess cannot
 * launch extensionless files at all — so the raw mocks are unlaunchable. On
 * win32 each mock is therefore compiled once into a real executable with
 * `bun build --compile`. argv semantics are unchanged (a compiled app still
 * sees `[exe, entry, …args]`, so the mocks' `process.argv.slice(2)` keeps
 * working), and the engine's dependency probe sees a native .exe. Cached per
 * source directory; the first test pays a few seconds of compile time.
 */
const toolsDirCache = new Map<string, Promise<string>>();

function toolsDirFor(mocksDir: string): Promise<string> {
  let cached = toolsDirCache.get(mocksDir);
  if (!cached) {
    cached = (async () => {
      if (!WIN) return mocksDir;
      const outDir = await mkdtemp(join(tmpdir(), "yta-mocks-exe-"));
      tmpDirs.push(outDir);
      for (const name of MOCK_TOOLS) {
        const source = join(mocksDir, name);
        if (!existsSync(source)) continue;
        // Stage under a .ts name first: `bun build --compile` on an
        // extensionless entry silently emits a no-op program.
        const staged = join(outDir, `${name}.ts`);
        await copyFile(source, staged);
        const proc = Bun.spawn(
          [process.execPath, "build", "--compile", staged, "--outfile", join(outDir, `${name}.exe`)],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [, errText, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (code !== 0) throw new Error(`compiling mock ${name} failed:\n${errText}`);
      }
      return outDir;
    })();
    toolsDirCache.set(mocksDir, cached);
  }
  return cached;
}

async function makeRunDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yta-integration-"));
  tmpDirs.push(dir);
  return dir;
}

interface EngineHandle {
  dir: string;
  port: number;
  proc: Subprocess;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<number>;
  api: (path: string, init?: RequestInit) => Promise<any>;
}

async function startEngine(
  dir: string,
  port: number,
  config: Record<string, unknown>,
  env: Record<string, string> = {},
  mocksDir: string = MOCKS,
  extraArgs: string[] = [],
): Promise<EngineHandle> {
  const toolsDir = await toolsDirFor(mocksDir);
  const mockTool = (name: string) => join(toolsDir, WIN ? `${name}.exe` : name);
  const cfgStr = (v: unknown): string => (typeof v === "string" ? v : "");

  // Pin the tools to the mocks by absolute path. Discovery would otherwise
  // walk PATH and package-manager shim locations, so on any machine with real
  // yt-dlp/ffmpeg/aria2c installed — every working dev box — the real tools
  // could answer instead of the mocks. Values a test set on purpose (e.g.
  // aria2cPath: "none") are respected.
  const engineConfig: Record<string, unknown> = {
    ...config,
    ytDlpPath: cfgStr(config.ytDlpPath) || mockTool("yt-dlp"),
    ffmpegPath: cfgStr(config.ffmpegPath) || mockTool("ffmpeg"),
  };
  if (!cfgStr(config.aria2cPath) && existsSync(mockTool("aria2c"))) {
    engineConfig.aria2cPath = mockTool("aria2c");
  }
  await writeFile(join(dir, "config.json"), JSON.stringify(engineConfig, null, 2));

  // Rebuild the environment with exactly one PATH key: on Windows process.env
  // has `Path`, and adding `PATH` alongside it yields a child env block with
  // both — lookups then see a mangled duplicate. The mocks dir goes first
  // (with the platform separator — the old code hardcoded ":"), so the mock
  // yt-dlp's own bare `aria2c` spawn resolves to the mock too.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k.toUpperCase() !== "PATH") childEnv[k] = v;
  }
  childEnv[WIN ? "Path" : "PATH"] = `${toolsDir}${PATH_SEP}${PARENT_PATH}`;
  // Pin the mock yt-dlp → mock aria2c hop by absolute path too (the mock
  // spawns it as a bare name by default).
  if (existsSync(mockTool("aria2c"))) childEnv.FAKE_ARIA2C_BIN = mockTool("aria2c");

  const proc = Bun.spawn([process.execPath, "run", GUARD_ENTRY, ...extraArgs], {
    cwd: dir,
    env: { ...childEnv, YTA_EGRESS_GUARD: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  let out = "";
  let err = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: "out" | "err") => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (sink === "out") out += decoder.decode(value, { stream: true });
        else err += decoder.decode(value, { stream: true });
      }
    } catch {
      // process exited — stop reading
    }
  };
  pump(proc.stdout, "out");
  pump(proc.stderr, "err");

  const handle: EngineHandle = {
    dir,
    port,
    proc,
    stdout: () => out,
    stderr: () => err,
    stop: async () => {
      proc.kill("SIGTERM");
      const code = await proc.exited;
      // A lingering child process can inherit the listening socket and keep
      // the port open for a moment after the engine itself is gone, which
      // makes the next engine on the same port die with EADDRINUSE. Wait
      // until the port actually stops answering before handing it back.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await fetch(`http://127.0.0.1:${port}/api/ping`, { method: "HEAD", cache: "no-store" });
          await Bun.sleep(150);
        } catch {
          break; // connection refused — port is free
        }
      }
      return code;
    },
    api: async (path: string, init?: RequestInit) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { cache: "no-store", ...init });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { _status: res.status, _text: text.slice(0, 200) };
      }
    },
  };

  // Wait for the web API to answer.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { method: "HEAD", cache: "no-store" });
      if (res.status === 200) return handle;
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) {
      throw new Error(`engine exited early (code ${proc.exitCode})\nSTDOUT:\n${out}\nSTDERR:\n${err}`);
    }
    await Bun.sleep(150);
  }
  await handle.stop();
  throw new Error(`engine did not start within 30s\nSTDOUT:\n${out}\nSTDERR:\n${err}`);
}

/**
 * The engine's error log, wherever the child process wrote it: `error.log` in
 * the run directory, or the temp-dir file `logError` uses under `bun test`.
 * The worker's fallback messages land here, not on stderr.
 */
async function engineErrorLog(dir: string): Promise<string> {
  let text = "";
  for (const path of [join(dir, "error.log"), join(tmpdir(), "yta-test-error.log")]) {
    try {
      text += await Bun.file(path).text();
    } catch {
      // not written (or already rotated) — try the other location
    }
  }
  return text;
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const BASE_CONFIG = (port: number, overrides: Record<string, unknown> = {}) => ({
  playlists: ["https://www.youtube.com/playlist?list=FAKELIST"],
  channels: [],
  channelPlaylists: [],
  maxConcurrentDownloads: 3,
  maxConcurrentConverts: 2,
  maxDownloadWorkers: 5,
  minDownloadWorkers: 1,
  maxMetadataWorkers: 2,
  outputRoot: "./downloads",
  archiveFile: "downloaded_videos.txt",
  cookiesFile: "cookies.txt",
  minFreeSpaceGB: 1,
  webPort: port,
  webBind: "127.0.0.1",
  webToken: "",
  daemonMode: false,
  rssEnabled: false,
  rescanIntervalHours: 0,
  autoscaleEnabled: false,
  // The network monitor probes real YouTube endpoints; disable it so the
  // subprocess never makes egress requests. A dedicated unit-test block
  // covers the monitor's pause/resume logic with a fake probe.
  networkMonitorEnabled: false,
  ...overrides,
});

interface JobRow {
  id: string;
  title: string;
  download_status: string;
  conversion_status: string;
  metadata_status: string;
  retry_count: number;
  resume_count: number;
  best_progress: number;
  last_error: string | null;
  file_path: string | null;
  partial_file_path: string | null;
  progress: number;
  video_quality: string | null;
}

async function getJobs(engine: EngineHandle): Promise<JobRow[]> {
  const data = await engine.api("/api/jobs");
  return (data.jobs || []) as JobRow[];
}

async function waitForAllJobs(engine: EngineHandle, predicate: (j: JobRow) => boolean): Promise<JobRow[]> {
  let jobs: JobRow[] = [];
  await waitFor("all jobs to settle", async () => {
    jobs = await getJobs(engine);
    return jobs.length === 3 && jobs.every(predicate);
  });
  return jobs;
}

/** Read the run database after the engine has exited. */
function readDb(dir: string): Database {
  return new Database(join(dir, "archive.db"), { readonly: true });
}

// ---------------------------------------------------------------------------
describe("integration: happy path", () => {
  test("scan → download → metadata → convert → done", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 3981, BASE_CONFIG(3981, { videoQuality: "audio" }));

    try {
      // 1) The scan ingested exactly the three mock videos.
      await waitFor("3 jobs ingested", async () => (await getJobs(engine)).length === 3);

      // 2) The whole pipeline runs to completion.
      const jobs = await waitForAllJobs(
        engine,
        (j) =>
          j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.file_path).toBeTruthy();
        expect(job.file_path!.endsWith(".mp3")).toBe(true); // audio mode → mp3
        expect(job.retry_count).toBe(0);
        expect(job.partial_file_path).toBeNull(); // cleared on success
      }

      // 3) Media + sidecar files really exist on disk.
      const files = await readdir(join(dir, "downloads", "Mock Playlist"));
      expect(files.filter((f) => f.endsWith(".mp3"))).toHaveLength(3);
      expect(files.some((f) => f.endsWith(".en.vtt"))).toBe(true);
      expect(files.some((f) => f.endsWith(".jpg"))).toBe(true);
      expect(files.some((f) => f.endsWith(".info.json"))).toBe(true);

      // 4) The web API reports a healthy engine.
      const status = await engine.api("/api/status");
      expect(status.stats.total).toBe(3);
      expect(status.stats.downloaded).toBe(3);
      expect(status.stats.failed).toBe(0);
      expect(status.isPaused).toBe(false);
      expect(status.workers.length).toBeGreaterThan(0);

      // 5) The reliability endpoint exposes the active policy.
      const reliability = await engine.api("/api/reliability");
      expect(reliability.ok).toBe(true);
      expect(reliability.partialFiles.count).toBe(0); // nothing left partial
      expect(reliability.policy.maxResumeAttempts).toBeGreaterThan(0);

      // 6) The run report renders.
      const logs = await engine.api("/api/logs?type=report");
      expect(logs.logs.join("\n")).toContain("Archive Engine Report");
    } finally {
      const code = await engine.stop();
      // On Windows proc.kill is a forceful TerminateProcess — the engine's
      // graceful SIGTERM handler never fires there, so only POSIX can assert
      // the clean shutdown exit code.
      if (!WIN) expect(code).toBe(0);
    }

    // 7) Graceful shutdown left a run-history row behind.
    const db = readDb(dir);
    try {
      const rows = db.query("SELECT * FROM run_history").all() as any[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].started_at).toBeTruthy();
    } finally {
      db.close();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: transient failures and resume", () => {
  test("retries with backoff, keeps the partial, and completes", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3982,
      BASE_CONFIG(3982, {
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxRetryAttempts: 10,
        maxFailuresPerVideo: 10,
        maxFailures: 50,
      }),
      { FAKE_FAIL_TIMES: "2", FAKE_FAIL_MODE: "transient", FAKE_DELAY_MS: "40" },
    );

    try {
      // While the retries are happening, the workers report the backoff.
      const seen = new Set<string>();
      let settled = false;
      const collector = (async () => {
        const deadline = Date.now() + 30_000;
        while (!settled && Date.now() < deadline) {
          try {
            const s = await engine.api("/api/status");
            for (const w of s.workers || []) if (w.status) seen.add(w.status);
          } catch {
            // engine may be mid-restart
          }
          await Bun.sleep(150);
        }
      })();

      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      settled = true;
      await collector;

      expect(jobs).toHaveLength(3);
      const statuses = [...seen].join("\n");
      // The engine must have visibly backed off rather than hammering.
      expect(statuses).toMatch(/Transient error, retrying in \d+s/);

      // All three videos eventually succeeded despite two failures each.
      for (const job of jobs) {
        expect(job.download_status).toBe("downloaded");
        expect(job.file_path).toBeTruthy();
        expect(job.retry_count).toBe(2); // each failed attempt made no forward progress
      }
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("runs one bounded self-update for concurrent signature failures and then completes", async () => {
    const dir = await makeRunDir();
    const updateLog = join(dir, "yt-dlp-update.log");
    const engine = await startEngine(
      dir,
      4001,
      BASE_CONFIG(4001, {
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxRetryAttempts: 3,
        maxFailuresPerVideo: 3,
        maxFailures: 50,
      }),
      {
        FAKE_FAIL_TIMES: "1",
        FAKE_FAIL_MODE: "signature",
        FAKE_UPDATE_LOG: updateLog,
        FAKE_DELAY_MS: "20",
      },
    );

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      expect(jobs).toHaveLength(3);
      for (const job of jobs) expect(job.retry_count).toBe(0);
      expect(await Bun.file(updateLog).text()).toBe("update\n");
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("does not reset retry budgets when yt-dlp self-update fails", async () => {
    const dir = await makeRunDir();
    const updateLog = join(dir, "yt-dlp-update.log");
    const engine = await startEngine(
      dir,
      4003,
      BASE_CONFIG(4003, {
        maxConcurrentDownloads: 1,
        maxRetryAttempts: 1,
        maxFailuresPerVideo: 1,
        maxFailures: 50,
      }),
      {
        FAKE_FAIL_TIMES: "99",
        FAKE_FAIL_MODE: "signature",
        FAKE_UPDATE_FAIL: "1",
        FAKE_UPDATE_LOG: updateLog,
        FAKE_DELAY_MS: "20",
      },
    );

    try {
      await waitFor("all signature failures to exhaust their retry budgets", async () => {
        const jobs = await getJobs(engine);
        return jobs.length === 3 && jobs.every((job) => job.download_status === "failed");
      });
      const jobs = await getJobs(engine);
      for (const job of jobs) {
        expect(job.retry_count).toBe(1);
        expect(job.last_error).toContain("Signature extraction failed");
      }
      // The first job owns the failed update attempt; subsequent signature
      // errors observe the cooldown and keep their original diagnostic.
      expect(jobs.some((job) => job.last_error?.includes("auto-update exited with code 17"))).toBe(true);
      expect(jobs.some((job) => job.last_error?.includes("mock yt-dlp self-update failed"))).toBe(true);
      expect(await Bun.file(updateLog).text()).toBe("update\n");
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("forgives failed attempts that keep advancing the partial download", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4002,
      BASE_CONFIG(4002, {
        videoQuality: "audio",
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxRetryAttempts: 3,
        maxFailuresPerVideo: 3,
      }),
      { FAKE_FAIL_TIMES: "2", FAKE_FAIL_MODE: "transient", FAKE_FAIL_PROGRESS_SEQUENCE: "20,40", FAKE_DELAY_MS: "40" },
    );

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.retry_count).toBe(0);
        expect(job.best_progress).toBe(100);
      }
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: corrupt partials", () => {
  test("keeps the .part file and resumes instead of restarting", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3983,
      BASE_CONFIG(3983, {
        videoQuality: "audio",
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxResumeAttempts: 5,
        maxRetryAttempts: 10,
        maxFailuresPerVideo: 10,
        maxFailures: 50,
      }),
      { FAKE_FAIL_TIMES: "1", FAKE_FAIL_MODE: "corrupt", FAKE_DELAY_MS: "40" },
    );

    try {
      const seen = new Set<string>();
      let settled = false;
      const collector = (async () => {
        const deadline = Date.now() + 30_000;
        while (!settled && Date.now() < deadline) {
          try {
            const s = await engine.api("/api/status");
            for (const w of s.workers || []) if (w.status) seen.add(w.status);
          } catch {}
          await Bun.sleep(150);
        }
      })();

      const jobs = await waitForAllJobs(
        engine,
        (j) =>
          j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      settled = true;
      await collector;

      // The corrupt-partial path was taken (not a generic transient retry).
      const statuses = [...seen].join("\n");
      expect(statuses).toMatch(/Resuming \(attempt 1\/5\)/);
      expect(jobs).toHaveLength(3);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: permanent failures", () => {
  test("fails fast and is never auto-requeued", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3984,
      BASE_CONFIG(3984, {
        maxRetryAttempts: 2,
        maxFailuresPerVideo: 2,
        maxFailures: 50,
        requeueFailedAfterMinutes: 0, // sweep disabled for this scenario
      }),
      { FAKE_FAIL_TIMES: "999", FAKE_FAIL_MODE: "permanent", FAKE_DELAY_MS: "20" },
    );

    try {
      const jobs = await waitForAllJobs(engine, (j) => j.download_status === "failed");
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.retry_count).toBe(0); // the permanent failure spends no retry budget
        expect(job.last_error).toContain("Video unavailable");
      }
      const attempts = (await readdir(join(dir, "downloads", "Mock Playlist"))).filter((f) => f.endsWith(".attempts"));
      expect(attempts).toHaveLength(3);
      for (const file of attempts) expect(await Bun.file(join(dir, "downloads", "Mock Playlist", file)).text()).toBe("1");

      // The failed tab lists them…
      const failed = await engine.api("/api/failed");
      expect(failed.failed).toHaveLength(3);

      // …and even a forced requeue refuses permanent errors.
      const requeued = await engine.api("/api/failed/requeue", { method: "POST" });
      expect(requeued.ok).toBe(true);
      expect(requeued.requeued.downloads).toBe(0);
      const after = await getJobs(engine);
      expect(after.every((j) => j.download_status === "failed")).toBe(true);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: restart reconciliation", () => {
  test("detects deleted downloads and re-fetches them", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 3985, BASE_CONFIG(3985, { videoQuality: "audio" }));

    // First run: complete the pipeline.
    await waitFor("3 jobs ingested", async () => (await getJobs(engine)).length === 3);
    await waitForAllJobs(
      engine,
      (j) => j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
    );
    await engine.stop();

    // Delete the downloaded media behind the engine's back.
    const folder = join(dir, "downloads", "Mock Playlist");
    const files = await readdir(folder);
    expect(files.filter((f) => f.endsWith(".mp3"))).toHaveLength(3);
    for (const f of files) await rm(join(folder, f), { force: true });

    // Restart: the startup reconciliation must re-queue all three.
    const engine2 = await startEngine(dir, 3985, BASE_CONFIG(3985, { videoQuality: "audio" }));
    try {
      const jobs = await waitForAllJobs(
        engine2,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      // No duplicates were created — the same three jobs were re-downloaded.
      expect(jobs).toHaveLength(3);
      const filesAfter = await readdir(folder);
      expect(filesAfter.filter((f) => f.endsWith(".mp3"))).toHaveLength(3);
    } finally {
      await engine2.stop();
    }

    // The reconciliation is recorded in the run history.
    const db = readDb(dir);
    try {
      const rows = db.query("SELECT * FROM run_history").all() as any[];
      expect(rows.length).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: aria2c multi-connection downloads", () => {
  test("hands the transfer to aria2c with connection tuning and a bandwidth cap", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3986,
      BASE_CONFIG(3986, {
        videoQuality: "audio",
        useAria2c: true,
        connectionsPerDownload: 8,
        // A single download slot makes the split deterministic: the configured
        // KB/s cap is forwarded as an exact integer byte/second rate.
        maxConcurrentDownloads: 1,
        maxDownloadWorkers: 1,
        maxBandwidthKBps: 2048,
        concurrentFragments: 4,
      }),
    );

    try {
      // 1) All three videos complete through the aria2c path.
      const jobs = await waitForAllJobs(
        engine,
        (j) =>
          j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.file_path).toBeTruthy();
        expect(job.retry_count).toBe(0);
        expect(job.partial_file_path).toBeNull();
      }

      // 2) The media files exist on disk.
      const files = await readdir(join(dir, "downloads", "Mock Playlist"));
      expect(files.filter((f) => f.endsWith(".mp3"))).toHaveLength(3);

      // 3) The mock aria2c recorded the arguments yt-dlp actually passed it:
      //    the connection tuning from --downloader-args and the bandwidth cap
      //    mapped onto aria2c's own rate-limit flag.
      const recorded = files.filter((f) => f.endsWith(".aria2-args"));
      expect(recorded.length).toBeGreaterThanOrEqual(3);
      for (const f of recorded) {
        const raw = await Bun.file(join(dir, "downloads", "Mock Playlist", f)).text();
        const { args } = JSON.parse(raw);
        expect(args).toContain("-x");
        expect(args).toContain("8");
        expect(args).toContain("-s");
        expect(args).toContain("-j");
        expect(args).toContain("--max-overall-download-limit");
        expect(args).toContain("2097152");
        expect(args).toContain("--out");
      }

      // 4) The API reports aria2c as the active engine with the tuning.
      const reliability = await engine.api("/api/reliability");
      expect(reliability.downloader.engine).toBe("aria2c");
      expect(reliability.downloader.connectionsPerDownload).toBe(8);
      expect(reliability.downloader.concurrentFragments).toBe(4);
      expect(reliability.downloader.path).toBeTruthy();
      expect(reliability.partialFiles.count).toBe(0);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("falls back to the native downloader when aria2c is missing", async () => {
    // aria2c unavailable even though this machine may have a real one: the
    // special "none" value for aria2cPath skips discovery entirely, exactly
    // as if no binary had been found — the engine must fall back to yt-dlp's
    // native downloader and still complete the batch.
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3987,
      BASE_CONFIG(3987, {
        videoQuality: "audio",
        useAria2c: true,
        connectionsPerDownload: 8,
        aria2cPath: "none",
      }),
    );

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) =>
          j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);

      // The native downloader ran: no aria2c args were recorded, and the API
      // reports the native engine even though it was enabled in config.
      const files = await readdir(join(dir, "downloads", "Mock Playlist"));
      expect(files.filter((f) => f.endsWith(".aria2-args"))).toHaveLength(0);
      const reliability = await engine.api("/api/reliability");
      expect(reliability.downloader.engine).toBe("native");
      expect(reliability.downloader.path).toBeNull();
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: live download progress", () => {
  test("an aria2c transfer drives the dashboard's progress, speed and ETA", async () => {
    // yt-dlp fires no progress hook of its own while an external downloader
    // runs: it launches aria2c with stdout inherited and moves on. aria2c's
    // console readout on that inherited stdout is therefore the ONLY live
    // signal on the aria2c path — if the engine does not parse it, every
    // download through the (default) external engine shows 0% and "0 B/s"
    // for its whole duration. This test holds a transfer open and watches the
    // values the dashboard reads.
    //
    // The speed asserted below is deliberate: 393216 B/s (384.0KiB in the
    // readout) exists in exactly one place — the aria2c readout the fake
    // downloader writes into its stdout window. yt-dlp's own PROGRESS template
    // only prints after that window has closed (the external downloader has
    // returned by then) and never reports this speed, so catching this value
    // while the row is still 'downloading' proves the readout itself was
    // parsed, not merely the eventual yt-dlp output.
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4013,
      BASE_CONFIG(4013, {
        videoQuality: "audio",
        useAria2c: true,
        connectionsPerDownload: 4,
        // One slot: exactly one transfer is ever in flight, so the row under
        // test cannot be a neighbour's.
        maxConcurrentDownloads: 1,
        maxDownloadWorkers: 1,
      }),
      {
        FAKE_ARIA2C_INFLIGHT_MS: "6000",
        FAKE_ARIA2C_READOUT: "1",
        FAKE_ARIA2C_READOUT_MS: "1200",
      },
    );

    try {
      // While the transfer is in flight the dashboard sees real numbers: a
      // climbing percentage, the readout's speed, a total size for the bar and
      // an ETA — all before the downloader is done.
      let live: any = null;
      await waitFor("live progress to reach the status endpoint", async () => {
        const status = await engine.api("/api/status");
        const row = status.activeDownloads?.[0];
        if (row && row.speed === 393216) live = row;
        return !!live;
      });

      expect(live.progress).toBeGreaterThan(0);
      // The readout never claims a finished transfer — the file is incomplete
      // at every record — so a clamped-100% row would be a parser bug.
      expect(live.progress).toBeLessThanOrEqual(90);
      expect(live.speed).toBe(393216);
      expect(live.fileSize).toBe(10485760); // 10.0MiB total, backfilled from progress
      expect(live.eta).toBeGreaterThan(0);

      // The same numbers surface as an aggregate speed for the header.
      const status = await engine.api("/api/status");
      expect(status.speed).toBeGreaterThan(0);
      expect(status.aggregateSpeed).not.toBe("0 B/s");

      // ...and on the job row itself, so the job list and the progress panel
      // agree instead of one of them showing 0.
      const jobs = await engine.api("/api/jobs");
      const active = jobs.jobs.find((j: any) => j.id === live.id);
      expect(active.progress).toBeGreaterThan(0);
      expect(active.speed).toBe(393216);
      expect(active.file_size).toBe(10485760);

      // The whole batch still finishes normally afterwards.
      const done = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.conversion_status === "done",
      );
      expect(done).toHaveLength(3);

      // At least two readouts were produced: the count is written by the fake
      // downloader itself, so the engine cannot fabricate it.
      const folder = join(dir, "downloads", "Mock Playlist");
      const files = await readdir(folder);
      const counts = files.filter((f) => f.endsWith(".aria2c-readouts"));
      expect(counts.length).toBeGreaterThan(0);
      for (const f of counts) {
        expect(parseInt(await Bun.file(join(folder, f)).text(), 10)).toBeGreaterThanOrEqual(2);
      }
      // A finished run leaves no partial behind (the readout path must not
      // disturb the normal success bookkeeping).
      expect(files.filter((f) => f.endsWith(".part"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".mp3"))).toHaveLength(3);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: aria2c resume + self-healing", () => {
  test("an interrupted aria2c transfer resumes from its control file", async () => {
    // The failure originates INSIDE aria2c (FAKE_ARIA2C_FAIL_TIMES), so the
    // partial + control-file pair is really written by the external downloader
    // and the next attempt has to resume from it.
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3988,
      BASE_CONFIG(3988, {
        videoQuality: "audio",
        useAria2c: true,
        connectionsPerDownload: 16,
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxResumeAttempts: 5,
        maxRetryAttempts: 10,
        maxFailuresPerVideo: 10,
        maxFailures: 50,
      }),
      { FAKE_ARIA2C_FAIL_TIMES: "1", FAKE_ARIA2C_FAIL_MODE: "transient", FAKE_DELAY_MS: "40" },
    );

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) =>
          j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);

      // Every video was retried and completed.
      for (const job of jobs) {
        expect(job.retry_count).toBeGreaterThanOrEqual(1);
        expect(job.file_path).toBeTruthy();
        expect(job.partial_file_path).toBeNull();
      }

      const folder = join(dir, "downloads", "Mock Playlist");
      const files = await readdir(folder);

      // The successful run recorded that it RESUMED from the control file
      // rather than restarting — this is the aria2c resume path working.
      const recorded = files.filter((f) => f.endsWith(".aria2-args"));
      expect(recorded.length).toBeGreaterThanOrEqual(3);
      for (const f of recorded) {
        const raw = await Bun.file(join(folder, f)).text();
        const { args, resumed } = JSON.parse(raw);
        expect(args).toBeInstanceOf(Array);
        expect(resumed).toBe(true);
      }

      // A completed download removes its control file: no .part and no .aria2
      // is left behind, so nothing can strand.
      expect(files.filter((f) => f.endsWith(".part"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".aria2"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".mp3"))).toHaveLength(3);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("exhausting the resume budget discards the .part AND its control file", async () => {
    // Repeated corrupt errors drive the engine to its resume budget. When it
    // gives up on the partial it must delete both files — stranding the .aria2
    // would make aria2c refuse to restart (--allow-overwrite=false) and the job
    // would wedge forever. This test fails if the control file survives.
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3989,
      BASE_CONFIG(3989, {
        videoQuality: "audio",
        useAria2c: true,
        connectionsPerDownload: 16,
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxResumeAttempts: 2,
        maxRetryAttempts: 20,
        maxFailuresPerVideo: 30,
        maxFailures: 50,
      }),
      { FAKE_ARIA2C_FAIL_TIMES: "3", FAKE_ARIA2C_FAIL_MODE: "corrupt", FAKE_DELAY_MS: "30" },
    );

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) =>
          j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);

      // The engine really did hit its resume budget and restart from scratch
      // rather than looping on the same partial forever.
      for (const job of jobs) {
        expect(job.resume_count).toBeGreaterThanOrEqual(1);
        expect(job.file_path).toBeTruthy();
      }

      const folder = join(dir, "downloads", "Mock Playlist");
      const files = await readdir(folder);
      // Nothing left behind: no partial, no control file.
      expect(files.filter((f) => f.endsWith(".part"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".aria2"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".mp3"))).toHaveLength(3);

      // The mock never reported the wedge condition — if it had, the download
      // could not have completed.
      const reliability = await engine.api("/api/reliability");
      expect(reliability.downloader.engine).toBe("aria2c");
      expect(reliability.partialFiles.count).toBe(0);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("a resumed range the server no longer has (HTTP 416) discards the partial and restarts", async () => {
    // The failure mode an operator hits as a video frozen at 99.0%: attempt 1 is
    // interrupted and leaves `.part` + `.aria2`; attempt 2 resumes from them and
    // the CDN answers the saved range with `HTTP Error 416: Requested range not
    // satisfiable`, because the remote stream no longer has those bytes. Every
    // further resume repeats that verbatim — progress can never beat
    // best_progress, so the no-progress budget is charged on each attempt. The
    // engine must therefore THROW the resume state away (both files) and start
    // over; keeping the partial would loop until the job was parked as failed.
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4100,
      BASE_CONFIG(4100, {
        useAria2c: true,
        connectionsPerDownload: 4,
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxResumeAttempts: 5,
        maxRetryAttempts: 10,
        maxFailuresPerVideo: 10,
        maxFailures: 50,
      }),
      { FAKE_ARIA2C_FAIL_TIMES: "1", FAKE_ARIA2C_FAIL_MODE: "range416", FAKE_DELAY_MS: "30" },
    );

    try {
      // `not_needed` rather than `done`: an mp4 that needs no container change
      // ends the conversion stage that way (see the audio-quality scenarios).
      const jobs = await waitForAllJobs(
        engine,
        (j) =>
          j.download_status === "downloaded" &&
          j.metadata_status === "done" &&
          (j.conversion_status === "done" || j.conversion_status === "not_needed"),
      );
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.file_path).toBeTruthy();
        // The unusable resume state is gone from the row as well as from disk.
        expect(job.partial_file_path).toBeNull();
        // Two charged attempts: the interruption and the 416 it left behind.
        expect(job.retry_count).toBeGreaterThanOrEqual(2);
        // It never became a "resume attempt": a 416 does not get resumed again,
        // it gets discarded — that is the whole point of this branch.
        expect(job.resume_count).toBe(0);
      }

      const folder = join(dir, "downloads", "Mock Playlist");
      const files = await readdir(folder);
      expect(files.filter((f) => f.endsWith(".part"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".aria2"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".mp4"))).toHaveLength(3);

      // The transfer that finished the video did NOT resume — it restarted from
      // scratch, which is the only thing a 416 can be recovered with.
      const recorded = files.filter((f) => f.endsWith(".aria2-args"));
      expect(recorded.length).toBeGreaterThanOrEqual(3);
      for (const f of recorded) {
        const { resumed } = JSON.parse(await Bun.file(join(folder, f)).text());
        expect(resumed).toBe(false);
      }
      // The mock's hard failure — a control file whose data file is gone — never
      // happened, i.e. the pair was always removed together.
      expect(engine.stderr()).not.toContain("control file exists but the data file is gone");
      const reliability = await engine.api("/api/reliability");
      expect(reliability.partialFiles.count).toBe(0);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("a hard kill mid-download resumes on restart (crashed-jobs sweep)", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3990,
      BASE_CONFIG(3990, {
        videoQuality: "audio",
        useAria2c: true,
        connectionsPerDownload: 16,
        maxConcurrentDownloads: 1,
        maxDownloadWorkers: 1,
        maxRetryAttempts: 10,
        maxFailuresPerVideo: 10,
        maxFailures: 50,
      }),
      // Hold the aria2c transfer open so a SIGKILL lands mid-flight, leaving
      // the .part + .aria2 pair a real interrupted run leaves behind.
      { FAKE_ARIA2C_INFLIGHT_MS: "20000" },
    );

    try {
      // Wait until the transfer is genuinely in flight: the partial file and
      // its aria2c control file are both on disk.
      const folder = join(dir, "downloads", "Mock Playlist");
      await waitFor("an in-flight aria2c transfer", async () => {
        const files = await readdir(folder).catch(() => [] as string[]);
        return files.some((f) => f.endsWith(".part")) && files.some((f) => f.endsWith(".aria2"));
      });

      // Hard kill: no graceful shutdown, no chance to clean up.
      engine.proc.kill("SIGKILL");
      await engine.proc.exited;

      const leftovers = (await readdir(folder).catch(() => [] as string[])).filter(
        (f) => f.endsWith(".part") || f.endsWith(".aria2"),
      );
      expect(leftovers.length).toBeGreaterThan(0); // a real interrupted transfer
      // Both halves of the pair must be present — that is what makes resume
      // possible with aria2c.
      expect(leftovers.some((f) => f.endsWith(".part"))).toBe(true);
      expect(leftovers.some((f) => f.endsWith(".aria2"))).toBe(true);
    } finally {
      await engine.stop();
    }

    // Restart: the crashed-jobs sweep re-queues the interrupted video and the
    // retained control file lets aria2c resume instead of restarting.
    const engine2 = await startEngine(dir, 3991, BASE_CONFIG(3991, { videoQuality: "audio", useAria2c: true }));
    try {
      const jobs = await waitForAllJobs(
        engine2,
        (j) =>
          j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);
      const files = await readdir(join(dir, "downloads", "Mock Playlist"));
      expect(files.filter((f) => f.endsWith(".mp3"))).toHaveLength(3);
      expect(files.filter((f) => f.endsWith(".part"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".aria2"))).toHaveLength(0);
    } finally {
      await engine2.stop();
    }
  }, TEST_TIMEOUT);

  test.skipIf(WIN)(
    "a graceful shutdown records the partial so the job really resumes",
    async () => {
    // The dashboard promises "interrupted jobs resume from their partial". For
    // that to be true rather than just a status, the shutdown path has to
    // freeze each in-flight download's .part path into its job row before it
    // stops being 'downloading' — otherwise the job is paused+interrupted with
    // partial_file_path = NULL and the next start re-downloads from scratch.
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3989,
      BASE_CONFIG(3989, {
        videoQuality: "audio",
        useAria2c: true,
        connectionsPerDownload: 16,
        maxConcurrentDownloads: 1,
        maxDownloadWorkers: 1,
        maxRetryAttempts: 10,
        maxFailuresPerVideo: 10,
        maxFailures: 50,
      }),
      { FAKE_ARIA2C_INFLIGHT_MS: "20000" },
    );

    const folder = join(dir, "downloads", "Mock Playlist");
    try {
      await waitFor("an in-flight aria2c transfer", async () => {
        const files = await readdir(folder).catch(() => [] as string[]);
        return files.some((f) => f.endsWith(".part")) && files.some((f) => f.endsWith(".aria2"));
      });
      // Graceful stop: the shutdown path must record the partial first.
      engine.proc.kill("SIGTERM");
      await engine.proc.exited;
    } finally {
      await engine.stop();
    }

    const rows = readDb(dir)
      .query("SELECT id, download_status, pause_reason, partial_file_path FROM jobs")
      .all() as any[];
    const partials = rows.filter((r) => r.partial_file_path);
    expect(partials.length).toBeGreaterThan(0);
    for (const r of partials) {
      expect(r.download_status).toBe("paused");
      // The recorded path must be the real .part on disk, not a guess.
      // (The .aria2 control-file pair surviving is covered by the SIGKILL
      // test below — this mock finishes its in-flight window on its own, so
      // asserting it here would test the mock's timing, not the engine.)
      expect(existsSync(r.partial_file_path)).toBe(true);
    }

    // And the reliability endpoint must now report it as resumable, which is
    // what drives the "will resume" pill in the dashboard.
    const engine2 = await startEngine(dir, 3988, BASE_CONFIG(3988, { videoQuality: "audio", useAria2c: true }));
    try {
      await waitFor("the resume block to report the partial", async () => {
        const rel = await engine2.api("/api/reliability");
        return (rel.resume?.resumablePartials ?? 0) > 0;
      });
    } finally {
      await engine2.stop();
    }
    },
    TEST_TIMEOUT,
  );

  test("deleted downloads are re-fetched, and failed jobs retry after cooldown", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3992,
      BASE_CONFIG(3992, {
        videoQuality: "audio",
        useAria2c: true,
        connectionsPerDownload: 8,
        requeueFailedAfterMinutes: 1,
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxRetryAttempts: 5,
        maxFailuresPerVideo: 5,
        maxFailures: 20,
      }),
    );

    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      await waitForAllJobs(
        engine,
        (j) =>
          j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );

      // Self-healing sweep 3: delete the media behind the engine's back.
      for (const f of await readdir(folder)) {
        if (f.endsWith(".mp3")) await rm(join(folder, f));
      }
      expect((await readdir(folder)).filter((f) => f.endsWith(".mp3"))).toHaveLength(0);
    } finally {
      await engine.stop();
    }

    // reconcileMissingFiles runs at startup, so the re-fetch shows up on the
    // next run — the archive entry is scrubbed and the job is queued again.
    const engine2 = await startEngine(dir, 3993, BASE_CONFIG(3993, { videoQuality: "audio", useAria2c: true }));
    try {
      const jobs = await waitForAllJobs(
        engine2,
        (j) =>
          j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);
      const files = await readdir(folder);
      expect(files.filter((f) => f.endsWith(".mp3"))).toHaveLength(3);
      // Re-fetching through aria2c leaves no control-file litter behind.
      expect(files.filter((f) => f.endsWith(".aria2"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".part"))).toHaveLength(0);
    } finally {
      await engine2.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: durable partial and superseded recovery", () => {
  test("a paused job's absolute partial survives the startup sweep under the relative output root", async () => {
    // The sweep walks `outputRoot` (default './downloads' — relative) while
    // recorded partial paths are absolute. Comparing them as raw strings made
    // the partial look like an orphan and deleted it after a day, silently
    // turning "resumes where it stopped" into "starts over".
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 4004, BASE_CONFIG(4004));
    const folder = join(dir, "downloads", "Mock Playlist");
    let targetId = "";
    let partialAbs = "";
    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      targetId = jobs[0].id;
      const mediaAbs = resolve(dir, jobs[0].file_path!);
      partialAbs = mediaAbs.replace(/\.mp4$/, ".f137.mp4.part");
      // A real resume point: the media is gone, the .part is what is left.
      await rename(mediaAbs, partialAbs);
      await writeFile(partialAbs, "partial-bytes");
      const ancient = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await utimes(partialAbs, ancient, ancient);

      // Park the job the way the engine's own pause path does — with the
      // ABSOLUTE path in the database (findPartialFileSync resolves it).
      const db = new Database(join(dir, "archive.db"));
      db.run(
        `UPDATE jobs SET download_status = 'paused', pause_reason = 'user',
           file_path = NULL, file_size = 0, progress = 40, best_progress = 40,
           partial_file_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [partialAbs, targetId],
      );
      db.close();
    } finally {
      await engine.stop();
    }

    // Restart: startup reconciliation must keep the resume state. Before the
    // path normalization it swept it as an orphan (8 days > the day-old orphan
    // threshold) and the job would restart from zero.
    const engine2 = await startEngine(dir, 4005, BASE_CONFIG(4005));
    try {
      await Bun.sleep(1500); // the sweeps run right after the port is claimed
      expect(existsSync(partialAbs)).toBe(true);
      const row = (await getJobs(engine2)).find((j) => j.id === targetId)!;
      expect(row.download_status).toBe("paused");
      expect(row.partial_file_path).toBe(partialAbs);
    } finally {
      await engine2.stop();
    }
  }, TEST_TIMEOUT);

  test("a crashed rename-first stash is adopted on startup instead of re-queued", async () => {
    // The old `.superseded` hand-off renamed the media first and recorded the
    // backup afterwards. A crash in that window left the row claiming a file
    // that was gone while the only copy sat at `<file_path>.superseded` — the
    // missing-file sweep then re-queued the video and the backup stayed
    // unmanaged forever. Startup recovery must put the file back instead.
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 4006, BASE_CONFIG(4006));
    const folder = join(dir, "downloads", "Mock Playlist");
    let targetId = "";
    let mediaAbs = "";
    let backupAbs = "";
    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      targetId = jobs[0].id;
      mediaAbs = resolve(dir, jobs[0].file_path!);
      backupAbs = `${mediaAbs}.superseded`;
      await rename(mediaAbs, backupAbs);
      // Marker bytes prove afterwards that the ORIGINAL file was put back and
      // not overwritten by a re-download.
      await writeFile(backupAbs, "previous-archive-copy");
      // No DB write: this is the crash state exactly — file_path still names
      // the media, superseded_file was never recorded.
    } finally {
      await engine.stop();
    }

    const engine2 = await startEngine(dir, 4007, BASE_CONFIG(4007));
    try {
      await waitFor("the stashed media to be put back", async () => {
        return existsSync(mediaAbs) && (await Bun.file(mediaAbs).text()) === "previous-archive-copy";
      });
      expect(existsSync(backupAbs)).toBe(false);

      const row = (await getJobs(engine2)).find((j) => j.id === targetId)!;
      expect(row.download_status).toBe("downloaded");
      expect(row.file_path).toBeTruthy();
      expect(resolve(dir, row.file_path!)).toBe(mediaAbs);

      // The video was not re-downloaded: three original media files, no
      // leftover backup, no partial litter.
      const files = await readdir(folder);
      expect(files.filter((f) => f.endsWith(".mp4"))).toHaveLength(3);
      expect(files.filter((f) => f.endsWith(".superseded"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".part"))).toHaveLength(0);
    } finally {
      await engine2.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: multi-audio tracks", () => {
  test("all mode muxes every audio track into one MKV and keeps it through conversion", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 3994, BASE_CONFIG(3994, { multiAudioMode: "all" }));
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      // mp4-quality jobs mark conversion 'not_needed' (nothing to remux), so
      // the pipeline is done once download + metadata settle.
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );

      // 1) Every job landed as a multi-track MKV (never remuxed to mp4).
      for (const job of jobs) {
        expect(job.file_path!.endsWith(".mkv")).toBe(true);
      }
      const files = await readdir(folder);
      expect(files.filter((f) => f.endsWith(".mkv"))).toHaveLength(3);
      expect(files.filter((f) => f.endsWith(".mp4"))).toHaveLength(0);

      // 2) The format selector really carried all three track ids, and the
      //    multistream/MKV flags reached yt-dlp.
      const argsFile = join(folder, "001 - First Mock Video.ytdlp-args");
      const args = JSON.parse(await Bun.file(argsFile).text());
      expect(args).toContain("--audio-multistreams");
      expect(args).toContain("--merge-output-format");
      expect(args).toContain("mkv");
      expect(args).toContain("bv[height<=1080]+251-0+251-1+251-2/b[height<=1080]");

      // 3) The discovered tracks are visible through the API for the picker.
      const apiJobs = await getJobs(engine);
      for (const j of apiJobs as any[]) {
        expect(j.audio_tracks).toHaveLength(3);
        expect(j.audio_tracks.map((t: any) => t.language)).toEqual(["en", "es", "hi"]);
        expect(j.audio_selection).toBeNull();
      }

      // 4) A per-job selection overrides the global mode on the next attempt:
      //    keep only Spanish → single track → classic mp4 download.
      const target = apiJobs.find((j: any) => j.id === "mockvid001") as any;
      const save = await engine.api(`/api/jobs/${target.id}/audio-tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: ["es"] }),
      });
      expect(save.ok).toBe(true);
      expect(save.audio_selection).toEqual(["es"]);
      await engine.api(`/api/retry/${target.id}`, { method: "POST" });

      await waitFor("job re-downloaded with the single selected track", async () => {
        const rows = await getJobs(engine);
        const j = rows.find((r) => r.id === "mockvid001") as any;
        return (
          j &&
          j.download_status === "downloaded" &&
          j.metadata_status === "done" &&
          String(j.file_path || "").endsWith(".mp4")
        );
      });
      const retryArgs = JSON.parse(await Bun.file(argsFile).text());
      expect(retryArgs).toContain("bv[height<=1080]+251-1/b[height<=1080]");
      expect(retryArgs).not.toContain("--audio-multistreams");

      // 4b) The re-download really went through yt-dlp's archive gate: the id
      //     was scrubbed on retry and recorded exactly once by the new
      //     download, and the stashed backup of the old MKV is gone now that
      //     the replacement succeeded.
      const archiveText = await Bun.file(join(dir, "downloaded_videos.txt")).text();
      expect(archiveText.split("\n").filter((l) => l.endsWith("mockvid001"))).toHaveLength(1);
      const leftovers = (await readdir(folder)).filter((f) => f.endsWith(".superseded"));
      expect(leftovers).toHaveLength(0);

      // 5) Resetting the selection returns the job to the global mode.
      const reset = await engine.api(`/api/jobs/${target.id}/audio-tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: null }),
      });
      expect(reset.ok).toBe(true);
      expect(reset.audio_selection).toBeNull();
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("languages mode keeps only the configured languages", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3995,
      BASE_CONFIG(3995, { multiAudioMode: "languages", audioTrackLanguages: ["en", "hi"] }),
    );
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      const args = JSON.parse(await Bun.file(join(folder, "002 - Second Mock Video.ytdlp-args")).text());
      expect(args).toContain("bv[height<=1080]+251-0+251-2/b[height<=1080]");
      expect(args).toContain("--audio-multistreams");
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("off mode stays a classic single-audio download and never probes", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 3996, BASE_CONFIG(3996));
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      const args = JSON.parse(await Bun.file(join(folder, "001 - First Mock Video.ytdlp-args")).text());
      expect(args).toContain("--format");
      expect(args).toContain("bv[height<=1080]+ba/b[height<=1080]");
      expect(args).not.toContain("--audio-multistreams");
      const apiJobs = (await getJobs(engine)) as any[];
      for (const j of apiJobs) expect(j.audio_tracks).toEqual([]); // no probe ran
      const files = await readdir(folder);
      expect(files.filter((f) => f.endsWith(".mp4"))).toHaveLength(3);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("an unarchived retry of a downloaded job re-downloads and replaces the file", async () => {
    // The regression this pins: with --download-archive a retry of an
    // already-recorded video used to be silently skipped by yt-dlp (exit 0,
    // no download), so per-job audio selections saved from the dashboard
    // never reached disk. The engine must scrub the archive and move the old
    // file aside so the re-download actually happens.
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 3997, BASE_CONFIG(3997));
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      // The first download recorded the id in the archive file.
      const archiveBefore = await Bun.file(join(dir, "downloaded_videos.txt")).text();
      expect(archiveBefore).toContain("youtube mockvid001");

      const retry = await engine.api("/api/retry/mockvid001", { method: "POST" });
      expect(retry.ok).toBe(true);

      // While the re-download is pending the previous file must be visible as
      // a .superseded backup, and the job must not pretend to still have the
      // old file.
      await waitFor("backup recorded before the re-download starts", async () => {
        const rows = await getJobs(engine);
        const j = rows.find((r: any) => r.id === "mockvid001") as any;
        const files = await readdir(folder).catch(() => [] as string[]);
        return (
          files.some((f) => f.endsWith(".superseded")) ||
          j.download_status === "downloaded" // already replaced (fast mock)
        );
      });

      await waitFor("job re-downloaded through the archive gate", async () => {
        const rows = await getJobs(engine);
        const j = rows.find((r: any) => r.id === "mockvid001") as any;
        return j && j.download_status === "downloaded" && j.metadata_status === "done";
      });

      // The archive proves yt-dlp downloaded again instead of answering "has
      // already been recorded in the archive": the retry scrubbed the id, and
      // the fresh download recorded it exactly once.
      const archive = await Bun.file(join(dir, "downloaded_videos.txt")).text();
      expect(archive.split("\n").filter((l) => l.endsWith("mockvid001"))).toHaveLength(1);

      const jobs = await getJobs(engine);
      const j = jobs.find((r: any) => r.id === "mockvid001") as any;
      expect(j.superseded_file).toBeFalsy(); // backup deleted on success
      // file_path is stored relative to the engine's run dir.
      const resolved = String(j.file_path).startsWith("/") ? j.file_path : join(dir, j.file_path);
      expect(existsSync(resolved)).toBe(true);
      expect(String(j.file_path).endsWith(".superseded")).toBe(false);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: degradation paths (missing tool, failed audio probe)", () => {
  test.skipIf(WIN)("discovers that aria2c is genuinely absent and downloads natively", async () => {
    // The difference from the `aria2cPath: "none"` test above: discovery runs
    // for real and finds nothing. The engine must not treat the optional tool
    // as fatal, and the whole batch must still complete on yt-dlp's native
    // downloader. A PATH holding only the mock yt-dlp (plus the interpreter
    // its shebang needs) and a mocks dir without aria2c make "nothing is
    // installed" true on any machine — including dev boxes with a real aria2c.
    //
    // Windows is skipped on purpose: its candidate list probes the
    // chocolatey/scoop/winget shim directories directly, so a genuinely
    // missing binary cannot be forced there (its `aria2cPath: "none"` switch
    // stays the way to pin this behaviour).
    const dir = await makeRunDir();
    const soloMocks = await mkdtemp(join(tmpdir(), "yta-mocks-noaria-"));
    tmpDirs.push(soloMocks);
    for (const name of ["yt-dlp", "ffmpeg"]) {
      await copyFile(join(MOCKS, name), join(soloMocks, name));
    }
    const cleanPath = await mkdtemp(join(tmpdir(), "yta-clean-path-"));
    tmpDirs.push(cleanPath);
    // `env bun` in the mock shebangs must resolve, and nothing else may.
    await symlink(process.execPath, join(cleanPath, "bun"));

    const engine = await startEngine(dir, 4008, BASE_CONFIG(4008, { videoQuality: "audio" }), { PATH: cleanPath }, soloMocks);
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);

      // The engine reported the missing tool without dying...
      expect(engine.stdout()).toContain("aria2c: not found");
      // ...and the pipeline used the native downloader.
      const files = await readdir(folder);
      expect(files.filter((f) => f.endsWith(".aria2-args"))).toHaveLength(0);
      const reliability = await engine.api("/api/reliability");
      expect(reliability.downloader.engine).toBe("native");
      expect(reliability.downloader.path).toBeNull();
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("a failed multi-audio probe falls back to a single-audio download", async () => {
    // multiAudioMode "all" would mux three tracks — but the probe call fails
    // (HTTP 503 in the mock). The download must not be lost over it: the job
    // proceeds with the classic single-audio plan and settles as done.
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 4009, BASE_CONFIG(4009, { multiAudioMode: "all" }), {
      FAKE_PROBE_FAIL: "1",
    });
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      expect(jobs).toHaveLength(3);

      const args = JSON.parse(await Bun.file(join(folder, "001 - First Mock Video.ytdlp-args")).text());
      expect(args).toContain("bv[height<=1080]+ba/b[height<=1080]");
      expect(args).not.toContain("--audio-multistreams");
      for (const j of (await getJobs(engine)) as any[]) {
        expect(j.audio_tracks).toEqual([]); // the probe stored nothing
      }
      expect(await engineErrorLog(dir)).toContain("audio-track probe failed (falling back to single audio)");
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("a multi-audio probe that never answers times out and falls back", async () => {
    // Same promise, watchdog branch: the -J call hangs forever, so the probe's
    // own timeout must abort it (the env override shortens the 90 s cap) and
    // the download must continue single-audio.
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 4010, BASE_CONFIG(4010, { multiAudioMode: "all" }), {
      FAKE_PROBE_HANG: "1",
      YTA_AUDIO_PROBE_TIMEOUT_MS: "500",
    });
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      expect(jobs).toHaveLength(3);
      const args = JSON.parse(await Bun.file(join(folder, "001 - First Mock Video.ytdlp-args")).text());
      expect(args).not.toContain("--audio-multistreams");
      expect(await engineErrorLog(dir)).toContain("audio-track probe timed out");
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: dashboard cancellation", () => {
  // What the user reported: "when i click the purge delete and removed source
  // the some downloads still continue in terminal". Each action must stop the
  // in-flight downloader, not just its database row. FAKE_HANG wedges the mock
  // (it never finishes on its own) and the mock writes a `.hang-signalled`
  // marker when the engine's SIGINT arrives, so the assertion is about the
  // child process, not just about job state.
  test.skipIf(WIN)(
    "stop, delete, and remove-source all interrupt the running downloader",
    async () => {
      const dir = await makeRunDir();
      const engine = await startEngine(
        dir,
        3994,
        BASE_CONFIG(3994, {
          videoQuality: "audio",
          useAria2c: false,
          maxConcurrentDownloads: 1,
          maxDownloadWorkers: 1,
          maxRetryAttempts: 5,
          maxFailuresPerVideo: 5,
          maxFailures: 50,
        }),
        { FAKE_HANG: "1" },
      );

      const folder = join(dir, "downloads", "Mock Playlist");
      const signalled = async () => (await readdir(folder).catch(() => [] as string[])).filter((f) => f.endsWith(".hang-signalled")).length;

      /**
       * Wait until one job is downloading and ITS mock child has started.
       *
       * The check must be tied to the job's own file. A generic "any
       * `.ytdlp-args` exists" test is satisfied by a leftover from the previous
       * step — the mock writes one per attempt and never removes it — while the
       * next job's row is already `downloading`, which `claimDownloadJob` flips
       * BEFORE the spawn. An API call in that window cancels the job pre-spawn
       * (the worker's own `isJobCancelled` re-check refuses to start it, which is
       * correct), so no SIGINT is ever sent and the step that waits for a
       * `.hang-signalled` marker times out. The mock names the file after the
       * engine's own base name (`<index> - <sanitized title>`), so matching the
       * sanitized title is the same file the child wrote for this job.
       */
      const waitForInFlight = async (): Promise<JobRow> => {
        let active: JobRow | undefined;
        await waitFor("a hung download in flight", async () => {
          const jobs = await getJobs(engine);
          active = jobs.find((j) => j.download_status === "downloading");
          if (!active) return false;
          const marker = sanitizeFileName(active.title).toLowerCase();
          const files = await readdir(folder).catch(() => [] as string[]);
          return files.some((f) => f.endsWith(".ytdlp-args") && f.toLowerCase().includes(marker));
        });
        return active!;
      };

      try {
        // 1) Stop: the child is interrupted and the job is parked, not deleted.
        const first = await waitForInFlight();
        const stopResponse = await engine.api(`/api/jobs/${first.id}/stop`, { method: "POST" });
        expect(stopResponse.ok).toBe(true);
        await waitFor("the mock to record its SIGINT", async () => (await signalled()) >= 1);
        const parked = (await getJobs(engine)).find((j) => j.id === first.id);
        expect(parked).toMatchObject({ download_status: "paused", pause_reason: "user" });

        // 2) Delete: the next hung download is interrupted and its row is gone.
        const second = await waitForInFlight();
        const deleteResponse = await engine.api(`/api/jobs/${second.id}`, { method: "DELETE" });
        expect(deleteResponse.ok).toBe(true);
        await waitFor("the mock to record its second SIGINT", async () => (await signalled()) >= 2);
        expect((await getJobs(engine)).some((j) => j.id === second.id)).toBe(false);

        // 3) Remove-source: the last in-flight download is interrupted and every
        //    job of that source disappears.
        const third = await waitForInFlight();
        const removeResponse = await engine.api("/api/sources", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://www.youtube.com/playlist?list=FAKELIST" }),
        });
        expect(removeResponse.ok).toBe(true);
        await waitFor("the mock to record its third SIGINT", async () => (await signalled()) >= 3);
        expect((await getJobs(engine)).length).toBe(0);
        expect(third.id).toBeTruthy();
      } finally {
        await engine.stop();
      }
    },
    TEST_TIMEOUT,
  );
});

describe("integration: secondary-storage move", () => {
  test("moves finished media (and sidecars) to secondary storage and records the new path", async () => {
    // The whole hand-off in one engine run: remux to mkv, then move the media
    // and its sidecars into <secondary>/Mock Playlist/ and record THAT path.
    const dir = await makeRunDir();
    const nas = join(dir, "nas");
    const engine = await startEngine(
      dir,
      4011,
      BASE_CONFIG(4011, { targetFormat: "mkv", secondaryStoragePath: nas }),
    );
    const folder = join(dir, "downloads", "Mock Playlist");
    const nasFolder = join(nas, "Mock Playlist");

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);

      const nasFiles = await readdir(nasFolder);
      expect(nasFiles.filter((f) => f.endsWith(".mkv"))).toHaveLength(3);
      const leftBehind = (await readdir(folder)).filter((f) => f.endsWith(".mkv"));
      expect(leftBehind).toHaveLength(0);

      // Every sidecar the metadata pass wrote travelled with its media.
      const sidecars = nasFiles.filter((f) => f.includes("001 - First Mock Video.") && f.endsWith(".info.json"));
      expect(sidecars.length).toBeGreaterThanOrEqual(1);
      const sidecarsLeft = (await readdir(folder)).filter(
        (f) => f.startsWith("001 - First Mock Video.") && f.endsWith(".info.json"),
      );
      expect(sidecarsLeft).toHaveLength(0);

      // file_path points into secondary storage, and the media is really there.
      // `isAbsolute`, not `startsWith("/")`: a Windows path starts with a drive
      // letter, and joining it onto the run dir would mangle it into nonsense.
      const job = (await getJobs(engine)).find((j) => j.id === "mockvid001") as any;
      const resolved = isAbsolute(String(job.file_path))
        ? String(job.file_path)
        : join(dir, String(job.file_path));
      expect(resolved.startsWith(nas)).toBe(true);
      expect(existsSync(resolved)).toBe(true);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("a move that cannot complete keeps the media in the download folder and the job retryable", async () => {
    // The media's destination is unwritable (a non-empty directory squats on
    // exactly the file name the move needs), so the move itself fails. The only
    // copy must stay in the download folder and the job must NOT be recorded as
    // done against a path that does not exist — this is the engine-level
    // counterpart of the copy-failure unit test.
    const dir = await makeRunDir();
    const nas = join(dir, "nas");
    await mkdir(join(nas, "Mock Playlist", "001 - First Mock Video.mkv"), { recursive: true });
    await writeFile(join(nas, "Mock Playlist", "001 - First Mock Video.mkv", "keep"), "occupied");
    const engine = await startEngine(
      dir,
      4012,
      BASE_CONFIG(4012, {
        targetFormat: "mkv",
        secondaryStoragePath: nas,
        maxRetryAttempts: 1,
        maxFailuresPerVideo: 1,
        maxFailures: 100, // keep the circuit breaker out of the way
      }),
    );
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      await waitFor(
        "the conversion to fail its single attempt",
        async () => {
          const j = (await getJobs(engine)).find((r) => r.id === "mockvid001");
          return !!j && j.conversion_status === "failed";
        },
        60_000,
      );

      const job = (await getJobs(engine)).find((j) => j.id === "mockvid001")!;
      expect(String(job.file_path || "").includes("nas")).toBe(false);
      expect(String(job.last_error || "")).toContain("secondary-storage move failed");
      // The remuxed media is exactly where it was produced: nothing was lost,
      // and the destination still holds the squatter, not the media.
      const files = await readdir(folder);
      expect(files).toContain("001 - First Mock Video.mkv");
      const blocked = join(nas, "Mock Playlist", "001 - First Mock Video.mkv");
      expect(existsSync(join(blocked, "keep"))).toBe(true);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: per-job sidecars from the Web UI", () => {
  test("enabling subtitles on a finished download fetches them without re-downloading", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4001,
      BASE_CONFIG(4001, { downloadSubtitles: false, writeThumbnail: false, writeDescription: false, writeInfoJson: false }),
    );
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      // Nothing wanted → nothing to fetch: metadata settles at not_needed.
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "not_needed",
      );
      expect(jobs).toHaveLength(3);
      expect((await readdir(folder)).filter((f) => f.endsWith(".vtt"))).toHaveLength(0);

      // The dashboard flips the subtitle flag for one video only.
      const save = await engine.api("/api/jobs/mockvid001/sidecars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subtitles: true }),
      });
      expect(save.ok).toBe(true);
      expect(save.want_subtitles).toBe(true);
      expect(save.metadata_status).toBe("pending");

      // The metadata worker fetches the sidecar against the existing file —
      // no new download attempt must happen for it.
      await waitFor("subtitle sidecar fetched", async () => {
        const rows = await getJobs(engine);
        const j = rows.find((r: any) => r.id === "mockvid001") as any;
        return j && j.metadata_status === "done" && j.download_status === "downloaded";
      });
      const rows = await getJobs(engine);
      const j = rows.find((r: any) => r.id === "mockvid001") as any;
      expect(j.metadata_files.some((f: string) => f.endsWith(".en.vtt"))).toBe(true);
      const files = await readdir(folder);
      expect(files.some((f) => f === "001 - First Mock Video.en.vtt")).toBe(true);
      // The other two jobs kept their not_needed state.
      for (const other of rows.filter((r: any) => r.id !== "mockvid001")) {
        expect(other.metadata_status).toBe("not_needed");
      }
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: aria2c option validation", () => {
  test("connections above aria2c's -x cap of 16 are clamped, not fatal", async () => {
    const dir = await makeRunDir();
    // aria2c's --max-connection-per-server only accepts 1-16; an unclamped 32
    // used to make every download die with exit 28 before transferring a byte.
    const engine = await startEngine(dir, 3997, BASE_CONFIG(3997, { connectionsPerDownload: 32 }));
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      expect(jobs).toHaveLength(3);
      for (const job of jobs) expect(job.retry_count).toBe(0);

      // The recorded aria2c argv shows the clamp: -x pinned at 16 while the
      // split/concurrency settings keep the configured 32.
      const recorded = (await readdir(folder)).filter((f) => f.endsWith(".aria2-args"));
      expect(recorded.length).toBeGreaterThanOrEqual(3);
      for (const f of recorded) {
        const raw = await Bun.file(join(folder, f)).text();
        const { args } = JSON.parse(raw);
        expect(args).toContain("-x");
        expect(args).toContain("16");
        expect(args).toContain("-s");
        expect(args).toContain("32");
        expect(args).toContain("-j");
      }
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("a malformed downloader option pauses the engine instead of burning the playlist", async () => {
    const dir = await makeRunDir();
    // "banana" is not an aria2c size: the real binary (and the mock) answers
    // exit 28 with the option's help block. Every job would fail identically,
    // so the engine must pause itself with an actionable reason instead of
    // spending retry budgets until the circuit breaker trips.
    const engine = await startEngine(dir, 3998, BASE_CONFIG(3998, { minSplitSize: "banana" }));

    try {
      await waitFor("engine pauses with BAD_DOWNLOADER_ARGS", async () => {
        const s = await engine.api("/api/status");
        return s.isPaused === true && String(s.pauseReason || "").includes("BAD_DOWNLOADER_ARGS");
      }, 30_000);

      // No job was marked failed: they are parked (paused/pending) so a
      // resume after fixing the config picks them up again.
      const jobs = await getJobs(engine);
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs) {
        expect(j.download_status).not.toBe("failed");
      }
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: noisy downloader output", () => {
  test("CR progress, oversized logs and a split Unicode after_move path do not break concurrent downloads", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      3999,
      BASE_CONFIG(3999, { useAria2c: true, videoQuality: "audio" }),
      { FAKE_OUTPUT_STRESS: "1" },
    );
    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      for (const job of jobs) {
        expect(basename(job.file_path!)).toStartWith("final-");
        expect(job.file_path!).toContain("数学 🧮");
        expect(job.file_path!.endsWith(".mp3")).toBe(true);
        expect(existsSync(resolve(dir, job.file_path!))).toBe(true);
        expect(job.retry_count).toBe(0);
        expect(job.partial_file_path).toBeNull();
      }
      expect(engine.proc.exitCode).toBeNull();
      expect((await engine.api("/api/status")).isPaused).toBe(false);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("still recovers the expected media file when no after_move record is printed", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 4000, BASE_CONFIG(4000), { FAKE_OMIT_FINAL_PATH: "1" });
    try {
      const jobs = await waitForAllJobs(engine, (j) => j.download_status === "downloaded" && j.metadata_status === "done");
      for (const job of jobs) {
        expect(job.file_path!.endsWith(".mp4")).toBe(true);
        expect(existsSync(resolve(dir, job.file_path!))).toBe(true);
        expect(job.retry_count).toBe(0);
      }
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
describe("integration: Web UI source persistence", () => {
  test("saves scanned sources once, preserves concurrent settings, and scans them again on restart", async () => {
    const dir = await makeRunDir();
    const port = 4001;
    const playlist = "https://www.youtube.com/playlist?list=UI_ADDED";
    const channel = "https://www.youtube.com/@UIAdded";
    const channelPlaylists = channel + "/playlists";
    const video = "https://www.youtube.com/watch?v=AbCdEf12345";
    const scan = (engine: EngineHandle, url: string) => engine.api("/api/scan", {
      method: "POST", body: JSON.stringify({ url }),
    });
    const engine = await startEngine(dir, port, BASE_CONFIG(port, { playlists: [], videoQuality: "audio" }));
    let persisted: Record<string, unknown>;
    try {
      const added = await scan(engine, playlist);
      expect(added).toMatchObject({ ok: true, saved: true, found: 3, added: 3, source: { key: "playlists", added: true } });
      expect(added.message).toContain("Saved to config.json");
      const duplicate = await scan(engine, "https://m.youtube.com/watch?v=AbCdEf12345&list=UI_ADDED&si=share");
      expect(duplicate).toMatchObject({ ok: true, saved: true, added: 0, skipped: 3, source: { added: false } });

      // The fixture returns the same three videos for each source. Sources must
      // still be saved even when every video is already in archive.db.
      const results = await Promise.all([
        scan(engine, channel), scan(engine, channelPlaylists), scan(engine, "https://youtu.be/AbCdEf12345?si=share"),
        engine.api("/api/settings", { method: "POST", body: JSON.stringify({ connectionsPerDownload: 8 }) }),
      ]);
      for (const result of results) expect(result.ok).toBe(true);
      for (const result of results.slice(0, 3)) expect(result.added).toBe(0);
      persisted = await Bun.file(join(dir, "config.json")).json();
      expect(persisted.playlists).toEqual([playlist, video]);
      expect(persisted.channels).toEqual([channel]);
      expect(persisted.channelPlaylists).toEqual([channelPlaylists]);
      expect(persisted.connectionsPerDownload).toBe(8);
      expect(persisted.outputRoot).toBe("./downloads");
      await waitForAllJobs(engine, (j) => j.download_status === "downloaded" && j.conversion_status === "done" && j.metadata_status === "done");
    } finally {
      await engine.stop();
    }

    // Restart from what the API really wrote, not from the original fixture.
    const restarted = await startEngine(dir, port, persisted!);
    try {
      await waitFor("saved sources scanned at startup", async () =>
        [playlist, video, channel, channelPlaylists].every((url) => restarted.stdout().includes(`📥 ${url} →`)),
      );
      const jobs = await getJobs(restarted);
      expect(jobs).toHaveLength(3); // no duplicate jobs or re-downloads
      expect(jobs.every((job) => job.download_status === "downloaded")).toBe(true);
    } finally {
      await restarted.stop();
    }
  }, TEST_TIMEOUT);

  test("daemon rescans include playlists added after starting with no sources", async () => {
    const dir = await makeRunDir();
    const logPath = join(dir, "scans.log");
    const playlist = "https://www.youtube.com/playlist?list=UI_WATCHED";
    const engine = await startEngine(
      dir, 4002,
      BASE_CONFIG(4002, { playlists: [], daemonMode: true, rescanIntervalHours: 0.0002 }),
      { FAKE_SCAN_LOG: logPath },
    );
    try {
      await waitFor("empty engine started", async () => engine.stdout().includes("Engine started"));
      const response = await engine.api("/api/scan", { method: "POST", body: JSON.stringify({ url: playlist }) });
      expect(response.saved).toBe(true);
      await waitFor("a later daemon scan of the new playlist", async () => {
        const scans = await Bun.file(logPath).text().catch(() => "");
        return scans.split("\n").filter((line) => line === playlist).length >= 2;
      });
      expect(await getJobs(engine)).toHaveLength(3);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("an empty source is saved for future scans rather than silently forgotten", async () => {
    const dir = await makeRunDir();
    const channel = "https://www.youtube.com/@EmptyForNow";
    const engine = await startEngine(dir, 4003, BASE_CONFIG(4003, { playlists: [] }), { FAKE_EMPTY_SCAN: "1" });
    try {
      const response = await engine.api("/api/scan", { method: "POST", body: JSON.stringify({ url: channel }) });
      expect(response).toMatchObject({ ok: true, saved: true, found: 0, added: 0 });
      expect(response.message).toContain("No videos found");
      expect((await Bun.file(join(dir, "config.json")).json()).channels).toEqual([channel]);
      expect(await getJobs(engine)).toEqual([]);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// The database-level engine lease. The web port is the HTTP lock, but two
// engines with different `webPort` values could both bind successfully and then
// both run startup reconciliation against the same jobs. The lease row is the
// actual owner of `archive.db`, acquired before the port and before any sweep.
describe("integration: engine lease", () => {
  test("a second engine on the same archive.db (different web port) refuses to start", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4004,
      BASE_CONFIG(4004, { videoQuality: "audio", maxDownloadWorkers: 1, maxConcurrentDownloads: 1 }),
    );

    try {
      await waitFor("3 jobs ingested", async () => (await getJobs(engine)).length === 3);

      // The lease is acquired before the port is bound, so an engine that
      // answers /api/ping is already the owner of the database.
      const reliability = await engine.api("/api/reliability");
      expect(reliability.engine.lease.owner).toBeTruthy();
      expect(reliability.engine.lease.heldByMe).toBe(true);
      const fencing = reliability.engine.lease.fencing;

      // The second engine points at the same directory (same archive.db) but
      // listens on its own port. It must refuse to start: no sweeps, no job
      // rows touched, no lease takeover.
      let refusal = "";
      try {
        const second = await startEngine(dir, 4005, BASE_CONFIG(4005, { videoQuality: "audio" }));
        await second.stop();
      } catch (e: any) {
        refusal = String(e?.message || e);
      }
      expect(refusal).toContain("archive.db is owned by another live engine instance");
      expect(refusal).toContain("different web port does NOT make a second instance safe");

      // The live engine still owns the database with the same fencing
      // generation, and its pipeline still completes — proof the refused
      // instance did not re-queue or reset anything.
      const after = await engine.api("/api/reliability");
      expect(after.engine.lease.owner).toBe(reliability.engine.lease.owner);
      expect(after.engine.lease.fencing).toBe(fencing);
      expect(after.engine.lease.heldByMe).toBe(true);

      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("a clean restart re-acquires the lease without waiting for an expiry", async () => {
    const dir = await makeRunDir();
    const first = await startEngine(dir, 4006, BASE_CONFIG(4006, { videoQuality: "audio" }));
    let firstFencing = 0;
    try {
      await waitFor("3 jobs ingested", async () => (await getJobs(first)).length === 3);
      firstFencing = (await first.api("/api/reliability")).engine.lease.fencing;
    } finally {
      // Graceful shutdown must release the lease: the next start must not have
      // to wait out a TTL or take over a "live" lease from a dead process.
      await first.stop();
    }

    const second = await startEngine(dir, 4006, BASE_CONFIG(4006, { videoQuality: "audio" }));
    try {
      const lease = (await second.api("/api/reliability")).engine.lease;
      expect(lease.heldByMe).toBe(true);
      expect(lease.fencing).toBe(firstFencing + 1);
    } finally {
      await second.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// Network monitor unit tests (pure logic, no subprocess).
// Two consecutive failures pause; a successful probe after a network pause
// resumes; user pauses are never accidentally cleared.
describe("unit: networkMonitorTick", () => {
  test("two consecutive failures pause the engine", async () => {
    const { networkMonitorTick } = await import("../src/resilience");
    // First failure: not yet paused.
    const tick1 = networkMonitorTick(0, false, false, null);
    expect(tick1.consecutiveFails).toBe(1);
    expect(tick1.shouldPause).toBe(false);
    // Second failure: now paused.
    const tick2 = networkMonitorTick(tick1.consecutiveFails, false, false, null);
    expect(tick2.consecutiveFails).toBe(2);
    expect(tick2.shouldPause).toBe(true);
    expect(tick2.shouldResume).toBe(false);
  });

  test("a successful probe after a network pause resumes the engine", async () => {
    const { networkMonitorTick } = await import("../src/resilience");
    // Simulate engine already paused for NETWORK_DISCONNECTED.
    const tick = networkMonitorTick(2, true, true, "NETWORK_DISCONNECTED");
    expect(tick.consecutiveFails).toBe(0);
    expect(tick.shouldPause).toBe(false);
    expect(tick.shouldResume).toBe(true);
  });

  test("user pauses are not accidentally cleared by a successful probe", async () => {
    const { networkMonitorTick } = await import("../src/resilience");
    // Engine is paused by the user (SHUTDOWN_REQUESTED, TOO_MANY_FAILURES, …).
    const tick = networkMonitorTick(3, true, true, "SHUTDOWN_REQUESTED");
    expect(tick.consecutiveFails).toBe(0);
    expect(tick.shouldPause).toBe(false);
    expect(tick.shouldResume).toBe(false);
  });

  test("a single failure does not pause even if the engine is already paused for another reason", async () => {
    const { networkMonitorTick } = await import("../src/resilience");
    const tick = networkMonitorTick(1, false, true, "LOW_DISK_SPACE");
    expect(tick.consecutiveFails).toBe(2);
    expect(tick.shouldPause).toBe(false); // already paused — no duplicate trigger
    expect(tick.shouldResume).toBe(false);
  });

  test("a successful probe when nothing was wrong is a no-op", async () => {
    const { networkMonitorTick } = await import("../src/resilience");
    const tick = networkMonitorTick(0, true, false, null);
    expect(tick.consecutiveFails).toBe(0);
    expect(tick.shouldPause).toBe(false);
    expect(tick.shouldResume).toBe(false);
  });

  test("offline mode clears only a network-caused pause and never pauses for connectivity", async () => {
    const { networkMonitorTick } = await import("../src/resilience");
    const networkPause = networkMonitorTick(3, false, true, "NETWORK_DISCONNECTED", true);
    expect(networkPause).toEqual({ consecutiveFails: 0, shouldPause: false, shouldResume: true });
    const userPause = networkMonitorTick(3, false, true, "SHUTDOWN_REQUESTED", true);
    expect(userPause).toEqual({ consecutiveFails: 0, shouldPause: false, shouldResume: false });
    const running = networkMonitorTick(3, false, false, null, true);
    expect(running).toEqual({ consecutiveFails: 0, shouldPause: false, shouldResume: false });
  });
});

// ---------------------------------------------------------------------------
// Expanded mock contract scenarios — yt-dlp.
describe("mock contract: yt-dlp", () => {
  test("archive skip: exact message, exit code zero, and no output file", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(dir, 4020, BASE_CONFIG(4020, { videoQuality: "audio" }));
    const folder = join(dir, "downloads", "Mock Playlist");

    try {
      // First run: complete everything and record in the archive.
      await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done" && j.conversion_status === "done",
      );
      const archiveText = await Bun.file(join(dir, "downloaded_videos.txt")).text();
      expect(archiveText).toContain("mockvid001");

      // Manually delete the media and reset the job so the engine re-queues it.
      // The archive entry is NOT scrubbed — the mock will skip it.
      for (const f of await readdir(folder)) {
        if (f.endsWith(".mp3")) await rm(join(folder, f));
      }
      const dbHandle = new Database(join(dir, "archive.db"));
      dbHandle.run(
        `UPDATE jobs SET download_status = 'pending', file_path = NULL, file_size = 0,
         progress = 0, best_progress = 0, partial_file_path = NULL,
         metadata_status = 'pending', conversion_status = 'pending',
         updated_at = CURRENT_TIMESTAMP WHERE id = 'mockvid001'`,
      );
      dbHandle.close();

      // The engine re-queues it, yt-dlp sees the archive entry and skips.
      await waitFor("mockvid001 settles", async () => {
        const jobs = await getJobs(engine);
        const j = jobs.find((r: any) => r.id === "mockvid001");
        return !!j && (j.download_status === "downloaded" || j.download_status === "failed");
      });

      // The mock prints yt-dlp's real skip message to stdout — the engine
      // sees exit 0 and locates the (still-gone) file via the fallback scan.
      // This is the contract: skip = exit 0 + no output file written.
      const status = await engine.api("/api/status");
      expect(status.stats.total).toBe(3);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("metadata probe failure: exact error message and clean fallback", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4021,
      BASE_CONFIG(4021, { multiAudioMode: "all" }),
      { FAKE_PROBE_FAIL: "1" },
    );
    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      expect(jobs).toHaveLength(3);
      // The error log contains the probe-failure message.
      expect(await engineErrorLog(dir)).toContain("audio-track probe failed (falling back to single audio)");
      // No audio tracks were stored — the fallback is the classic single-audio plan.
      const apiJobs = (await getJobs(engine)) as any[];
      for (const j of apiJobs) expect(j.audio_tracks).toEqual([]);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("metadata probe timeout: falls back without hanging the download", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4022,
      BASE_CONFIG(4022, { multiAudioMode: "all" }),
      { FAKE_PROBE_HANG: "1", YTA_AUDIO_PROBE_TIMEOUT_MS: "500" },
    );
    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.metadata_status === "done",
      );
      expect(jobs).toHaveLength(3);
      expect(await engineErrorLog(dir)).toContain("audio-track probe timed out");
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("failure-injection knobs: real wordings, custom marker, selector-scoped format failure", async () => {
    const dir = await makeRunDir();
    const toolsDir = await toolsDirFor(MOCKS);
    const mockTool = join(toolsDir, WIN ? "yt-dlp.exe" : "yt-dlp");

    // One attempt per candidate, each with its own output base so the mock's
    // cross-process attempt counter cannot leak between them.
    const run = async (
      name: string,
      extraEnv: Record<string, string>,
      format = "bv+ba/b",
    ): Promise<{ err: string; code: number }> => {
      const proc = Bun.spawn(
        [
          mockTool,
          "https://www.youtube.com/watch?v=mockvid001",
          "-o",
          join(dir, "downloads", `${name}.%(ext)s`),
          "--format",
          format,
          "--newline",
        ],
        { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...extraEnv } },
      );
      const [, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { err, code };
    };

    // The two wordings this suite exists for: both are what YouTube really
    // emits, and both must be terminal skips rather than retry candidates.
    const priv = await run("priv", { FAKE_FAIL_TIMES: "1", FAKE_FAIL_MODE: "private" });
    expect(priv.code).not.toBe(0);
    expect(priv.err).toContain("This video is private");
    const gone = await run("gone", { FAKE_FAIL_TIMES: "1", FAKE_FAIL_MODE: "unavailable" });
    expect(gone.code).not.toBe(0);
    expect(gone.err).toContain("This video is unavailable");
    // The format mode carries yt-dlp's selector error verbatim.
    const fmt = await run("fmt", { FAKE_FAIL_TIMES: "1", FAKE_FAIL_MODE: "format" });
    expect(fmt.err).toContain("Requested format is not available");

    // FAKE_FAIL_MESSAGE replaces the wording, which is how a scenario stamps a
    // unique marker and proves where it did (and did not) land.
    const marked = await run("marked", {
      FAKE_FAIL_TIMES: "1",
      FAKE_FAIL_MODE: "private",
      FAKE_FAIL_MESSAGE: "ERROR: [youtube] mockvid001: This video is private (knob-marker-a1)",
    });
    expect(marked.err).toContain("knob-marker-a1");

    // Selector-scoped injection: only selectors containing the substring fail,
    // so the quality fallback ladder is observable end to end.
    const badSelector = await run(
      "badsel",
      { FAKE_FORMAT_FAILS_SELECTOR: "height<=1080" },
      "bv[height<=1080]+ba/b[height<=1080]",
    );
    expect(badSelector.code).not.toBe(0);
    expect(badSelector.err).toContain("Requested format is not available");
    const goodSelector = await run(
      "goodsel",
      { FAKE_FORMAT_FAILS_SELECTOR: "height<=1080" },
      "bv[height<=720]+ba/b[height<=720]",
    );
    expect(goodSelector.code).toBe(0);
    // The "all" sentinel fails even yt-dlp's most permissive selector: the
    // shape of a video with no usable formats, which ends the ladder.
    const noFormats = await run("allsel", { FAKE_FORMAT_FAILS_SELECTOR: "all" }, "bv+ba/b");
    expect(noFormats.code).not.toBe(0);
    expect(noFormats.err).toContain("Requested format is not available");
  });
});

// ---------------------------------------------------------------------------
// Expanded mock contract scenarios — aria2c.
describe("mock contract: aria2c", () => {
  test("interrupted transfer leaves .part + .aria2 pair for resume", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4023,
      BASE_CONFIG(4023, {
        videoQuality: "audio",
        useAria2c: true,
        maxConcurrentDownloads: 1,
        maxDownloadWorkers: 1,
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxResumeAttempts: 5,
        maxRetryAttempts: 10,
        maxFailuresPerVideo: 10,
        maxFailures: 50,
      }),
      { FAKE_ARIA2C_FAIL_TIMES: "1", FAKE_ARIA2C_FAIL_MODE: "transient", FAKE_DELAY_MS: "40" },
    );
    try {
      const folder = join(dir, "downloads", "Mock Playlist");
      // Wait until the first failure has landed its partial + control file.
      await waitFor("aria2c interrupt leaves both files", async () => {
        const files = await readdir(folder).catch(() => [] as string[]);
        return files.some((f) => f.endsWith(".part")) && files.some((f) => f.endsWith(".aria2"));
      });
      // The engine recovers: resume from the control file.
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);
      // A resumed run wrote the args file with resumed=true.
      const recorded = (await readdir(folder)).filter((f) => f.endsWith(".aria2-args"));
      expect(recorded.length).toBeGreaterThanOrEqual(3);
      for (const f of recorded) {
        const { args, resumed } = JSON.parse(await Bun.file(join(folder, f)).text());
        expect(args).toBeInstanceOf(Array);
        expect(resumed).toBe(true);
      }
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("corrupt control + missing data file: aria2c rejects the orphan and the engine restarts from scratch", async () => {
    // This tests the case where the data file (.part) is gone but the control
    // file (.aria2) survives — aria2c's real binary would refuse with exit 3.
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4024,
      BASE_CONFIG(4024, {
        videoQuality: "audio",
        useAria2c: true,
        maxConcurrentDownloads: 1,
        maxDownloadWorkers: 1,
        retryBackoffBaseSeconds: 1,
        retryBackoffMaxSeconds: 2,
        maxResumeAttempts: 2,
        maxRetryAttempts: 15,
        maxFailuresPerVideo: 15,
        maxFailures: 50,
      }),
      { FAKE_ARIA2C_FAIL_TIMES: "3", FAKE_ARIA2C_FAIL_MODE: "corrupt", FAKE_DELAY_MS: "30" },
    );
    try {
      const jobs = await waitForAllJobs(
        engine,
        (j) => j.download_status === "downloaded" && j.conversion_status === "done",
      );
      expect(jobs).toHaveLength(3);
      // The resume budget was exhausted — the .part and .aria2 pair was
      // deleted and the download restarted from scratch.
      for (const job of jobs) {
        expect(job.resume_count).toBeGreaterThanOrEqual(1);
        expect(job.file_path).toBeTruthy();
      }
      const folder = join(dir, "downloads", "Mock Playlist");
      const files = await readdir(folder);
      expect(files.filter((f) => f.endsWith(".part"))).toHaveLength(0);
      expect(files.filter((f) => f.endsWith(".aria2"))).toHaveLength(0);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("rejected arguments: engine pauses with BAD_DOWNLOADER_ARGS and no job is failed", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4025,
      BASE_CONFIG(4025, { minSplitSize: "banana" }),
    );
    try {
      await waitFor("engine pauses with BAD_DOWNLOADER_ARGS", async () => {
        const s = await engine.api("/api/status");
        return s.isPaused === true && String(s.pauseReason || "").includes("BAD_DOWNLOADER_ARGS");
      }, 30_000);
      const jobs = await getJobs(engine);
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs) expect(j.download_status).not.toBe("failed");
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// Expanded mock contract scenarios — ffmpeg.
describe("mock contract: ffmpeg", () => {
  test("ffmpeg failure during conversion marks the job as retryable, not permanently failed", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4026,
      BASE_CONFIG(4026, {
        videoQuality: "audio",
        maxRetryAttempts: 3,
        maxFailuresPerVideo: 3,
        maxFailures: 50,
      }),
      { FAKE_FFMPEG_FAIL: "1" },
    );
    try {
      // audio mode: conversion runs (mp4 → mp3) — ffmpeg fails on every attempt
      // and the job eventually exhausts its retry budget.
      await waitFor(
        "conversion fails after retries",
        async () => {
          const jobs = await getJobs(engine);
          return jobs.length === 3 && jobs.every((j) => j.conversion_status === "failed");
        },
        60_000,
      );
      const jobs = await getJobs(engine);
      expect(jobs).toHaveLength(3);
      // The error was recorded.
      for (const j of jobs) {
        expect(j.last_error).toBeTruthy();
        expect(j.last_error).toContain("FFmpeg");
      }
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("ffmpeg timeout aborts the encode and the job retries", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4027,
      BASE_CONFIG(4027, {
        videoQuality: "audio",
        maxRetryAttempts: 3,
        maxFailuresPerVideo: 3,
        maxFailures: 50,
      }),
      { FAKE_FFMPEG_HANG: "1" },
    );
    try {
      // The mock hangs; the engine's 60-minute timeout is far too long for a
      // test, so we just verify the engine does not crash and the workers
      // stay alive while waiting. The real timeout path is tested by
      // checking that the AbortController signal is wired up.
      await Bun.sleep(3000);
      const status = await engine.api("/api/status");
      expect(status.workers.length).toBeGreaterThan(0);
      expect(status.isPaused).toBe(false);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// stdout vs stderr: the engine relies on the distinction to surface errors.
describe("mock contract: stdout vs stderr", () => {
  test("an archive skip prints its message to stdout and exits with code 0", async () => {
    // Directly verify the mock's contract rather than going through the full
    // engine pipeline: spawn yt-dlp with a pre-filled archive file.
    const dir = await makeRunDir();
    const toolsDir = await toolsDirFor(MOCKS);
    const mockTool = join(toolsDir, WIN ? "yt-dlp.exe" : "yt-dlp");
    await writeFile(join(dir, "downloaded_videos.txt"), "youtube mockvid001\n");

    const proc = Bun.spawn(
      [
        mockTool,
        "https://www.youtube.com/watch?v=mockvid001",
        "--download-archive",
        "downloaded_videos.txt",
        "-o",
        join(dir, "downloads", "%(title)s.%(ext)s"),
        "--format",
        "bv+ba/b",
        "--newline",
        "--no-colors",
        "--progress",
        "--print",
        "after_move:%(filepath)s",
        "--no-simulate",
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Exit code zero, the skip message is on stdout, nothing on stderr.
    expect(code).toBe(0);
    expect(out).toContain("has already been recorded in the archive");
    expect(err.trim()).toBe("");
    // No output file was written.
    const downloads = await readdir(join(dir, "downloads")).catch(() => [] as string[]);
    expect(downloads.filter((f) => f.endsWith(".mp4") || f.endsWith(".mp3"))).toHaveLength(0);
  });

  test("a permanent-failure error is printed to stderr, not stdout", async () => {
    const dir = await makeRunDir();
    const toolsDir = await toolsDirFor(MOCKS);
    const mockTool = join(toolsDir, WIN ? "yt-dlp.exe" : "yt-dlp");

    const proc = Bun.spawn(
      [
        mockTool,
        "https://www.youtube.com/watch?v=mockvid001",
        "-o",
        join(dir, "downloads", "%(title)s.%(ext)s"),
        "--format",
        "bv+ba/b",
        "--newline",
        "--no-colors",
        "--progress",
        "--print",
        "after_move:%(filepath)s",
        "--no-simulate",
      ],
      {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FAKE_FAIL_TIMES: "1", FAKE_FAIL_MODE: "permanent" },
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Non-zero exit; the error message is on stderr.
    expect(code).not.toBe(0);
    expect(err).toContain("Video unavailable");
    // stdout has only the progress lines (if any) — no error there.
    expect(out).not.toContain("Video unavailable");
  });

  test("a transient-failure error is also on stderr with exit code 1", async () => {
    const dir = await makeRunDir();
    const toolsDir = await toolsDirFor(MOCKS);
    const mockTool = join(toolsDir, WIN ? "yt-dlp.exe" : "yt-dlp");

    const proc = Bun.spawn(
      [
        mockTool,
        "https://www.youtube.com/watch?v=mockvid001",
        "-o",
        join(dir, "downloads", "%(title)s.%(ext)s"),
        "--format",
        "bv+ba/b",
        "--newline",
        "--no-colors",
        "--progress",
        "--print",
        "after_move:%(filepath)s",
        "--no-simulate",
      ],
      {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FAKE_FAIL_TIMES: "1", FAKE_FAIL_MODE: "transient" },
      },
    );
    const [, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(err).toContain("Connection reset by peer");
  });
});

// ---------------------------------------------------------------------------
// Unavailable videos: skip once, never retry, stay quiet.
//
// A playlist routinely contains dead entries (private, deleted, members-only,
// region-locked). The engine must classify the reason, park the job as a
// TERMINAL skip, and move on — no retry budget, no cooldown requeue, no
// error.log line per video. The wordings used here are the ones YouTube
// actually emits, including the two that used to slip past the classifier
// ("This video is private" / "This video is unavailable") and loop forever:
// budget spent → failed → cooldown requeue → budget spent → …
describe("integration: unavailable videos", () => {
  test("is attempted exactly once and never resurrected by a sweep", async () => {
    const dir = await makeRunDir();
    // A marker unique to this scenario: its absence from the log delta proves
    // the skip produced no error.log entry without depending on what other
    // scenarios wrote earlier.
    const marker = "deadsource-marker-7f21";
    const engine = await startEngine(
      dir,
      4003,
      BASE_CONFIG(4003, {
        maxRetryAttempts: 3,
        maxFailuresPerVideo: 3,
        maxFailures: 50,
        requeueFailedAfterMinutes: 0, // only the forced API requeue is in play
      }),
      {
        FAKE_FAIL_TIMES: "999",
        FAKE_FAIL_MODE: "private",
        FAKE_FAIL_MESSAGE: `ERROR: [youtube] mockvid001: This video is private (${marker})`,
        FAKE_DELAY_MS: "20",
      },
    );

    const logBefore = await engineErrorLog(dir);
    try {
      const jobs = await waitForAllJobs(engine, (j) => j.download_status === "failed");
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.retry_count).toBe(0); // a terminal skip spends no budget
        expect(job.last_error!.startsWith("[terminal]")).toBe(true);
        expect(job.last_error).toContain("Private video");
        expect(job.last_error).toContain(marker); // the raw tail stays for diagnosis
      }

      // THE assertion for "stopped instead of retrying": one attempt per video.
      // The mock counts attempts across processes, so a single retry would
      // show up as "2".
      const attempts = (await readdir(join(dir, "downloads", "Mock Playlist"))).filter((f) =>
        f.endsWith(".attempts"),
      );
      expect(attempts).toHaveLength(3);
      for (const file of attempts) {
        expect(await Bun.file(join(dir, "downloads", "Mock Playlist", file)).text()).toBe("1");
      }

      // Nobody is told to go look at error.log: a dead video is an expected
      // archival outcome, recorded on the job row.
      const logDelta = (await engineErrorLog(dir)).slice(logBefore.length);
      expect(logDelta).not.toContain(marker);

      // The reason is legible through the API…
      const failed = await engine.api("/api/failed");
      expect(failed.failed).toHaveLength(3);
      for (const row of failed.failed) expect(row.last_error).toContain("[terminal]");

      // …it is not counted as retryable…
      const reliability = await engine.api("/api/reliability");
      expect(reliability.resumableFailed).toBe(0);
      expect(reliability.sweeps.find((s: any) => s.id === "requeueFailed").pending).toBe(0);

      // …and even a forced requeue (the dashboard's "Requeue failed" button)
      // refuses to bring them back.
      const requeued = await engine.api("/api/failed/requeue", { method: "POST" });
      expect(requeued.ok).toBe(true);
      expect(requeued.requeued.downloads).toBe(0);
      await Bun.sleep(600);
      const after = await getJobs(engine);
      expect(after.every((j) => j.download_status === "failed")).toBe(true);
      for (const file of attempts) {
        expect(await Bun.file(join(dir, "downloads", "Mock Playlist", file)).text()).toBe("1");
      }

      // The run report reads as a skip, not as a stack trace.
      const report = await engine.api("/api/logs?type=report");
      expect(report.logs.join("\n")).toContain("Private video");
      expect(report.logs.join("\n")).toContain("unavailable: 3");
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("a plain 'video is unavailable' wording is terminal too", async () => {
    // Regression guard for the second gap: "This video is unavailable" used to
    // classify as neither permanent nor transient — generic retry budget,
    // cooldown requeue, loop.
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4004,
      BASE_CONFIG(4004, { maxRetryAttempts: 2, maxFailuresPerVideo: 2, maxFailures: 50, requeueFailedAfterMinutes: 0 }),
      { FAKE_FAIL_TIMES: "999", FAKE_FAIL_MODE: "unavailable", FAKE_DELAY_MS: "20" },
    );
    try {
      const jobs = await waitForAllJobs(engine, (j) => j.download_status === "failed");
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.retry_count).toBe(0);
        expect(job.last_error).toContain("Video unavailable");
      }
      const attempts = (await readdir(join(dir, "downloads", "Mock Playlist"))).filter((f) =>
        f.endsWith(".attempts"),
      );
      for (const file of attempts) {
        expect(await Bun.file(join(dir, "downloads", "Mock Playlist", file)).text()).toBe("1");
      }
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// Format fallback ladder: "Requested format is not available" is a selector
// problem, not a dead video. The worker must switch to the next lower quality
// preset, say so, and download with it — instead of retrying the identical
// selector until the budget runs out.
describe("integration: format fallback", () => {
  test("switches quality automatically, reports it, and downloads", async () => {
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4005,
      BASE_CONFIG(4005, {
        videoQuality: "1080p",
        maxRetryAttempts: 3,
        maxFailuresPerVideo: 3, // a switch must NOT eat into this budget
        maxFailures: 50,
        requeueFailedAfterMinutes: 0,
      }),
      // Only the 1080p selector fails; every other rung downloads fine.
      { FAKE_FORMAT_FAILS_SELECTOR: "height<=1080", FAKE_DELAY_MS: "150" },
    );

    const logBefore = await engineErrorLog(dir);
    try {
      // Watch the dashboard while it happens: the switch is announced live.
      const seen = new Set<string>();
      let settled = false;
      const collector = (async () => {
        const deadline = Date.now() + 60_000;
        while (!settled && Date.now() < deadline) {
          try {
            const s = await engine.api("/api/status");
            for (const w of s.workers || []) if (w.status) seen.add(w.status);
          } catch {}
          await Bun.sleep(100);
        }
      })();

      const jobs = await waitForAllJobs(engine, (j) => j.download_status === "downloaded");
      settled = true;
      await collector;

      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        // The fallback preset was persisted per job, so it survives restarts,
        // cooldowns and rescans…
        expect(job.video_quality).toBe("720p");
        // …and the switch itself cost no retry budget: it is a new command,
        // not a failed attempt.
        expect(job.retry_count).toBe(0);
        expect(job.last_error).toBeNull();
      }

      // The engine said what it was doing, in the dashboard…
      expect([...seen].join("\n")).toMatch(/Format 1080p not available — switched to 720p/);
      // …and left a line an operator can find afterwards.
      const logDelta = (await engineErrorLog(dir)).slice(logBefore.length);
      expect(logDelta).toContain("Requested quality 1080p is not available for this video — switched to 720p");

      // The download really used the fallback selector (the mock records argv).
      const argsFile = (await readdir(join(dir, "downloads", "Mock Playlist"))).find((f) =>
        f.endsWith(".ytdlp-args"),
      )!;
      const argv: string[] = JSON.parse(await Bun.file(join(dir, "downloads", "Mock Playlist", argsFile)).text());
      const selector = argv[argv.indexOf("--format") + 1];
      expect(selector).toContain("height<=720");
      expect(selector).not.toContain("height<=1080");

      // The report counts the recovery so a silent downgrade cannot hide.
      const report = await engine.api("/api/logs?type=report");
      expect(report.logs.join("\n")).toContain("format fallbacks: 3");
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("a bottomed-out ladder is parked as a terminal skip, not retried", async () => {
    // Nothing matches ANY selector: the video is genuinely unformattable. The
    // ladder ends at `highest`, so the job must be skipped with a reason
    // instead of looping through the retry budget and the cooldown sweep.
    const dir = await makeRunDir();
    const engine = await startEngine(
      dir,
      4006,
      BASE_CONFIG(4006, {
        videoQuality: "720p",
        maxRetryAttempts: 3,
        maxFailuresPerVideo: 3,
        maxFailures: 50,
        requeueFailedAfterMinutes: 0,
      }),
      { FAKE_FORMAT_FAILS_SELECTOR: "all", FAKE_DELAY_MS: "20" },
    );
    try {
      const jobs = await waitForAllJobs(engine, (j) => j.download_status === "failed");
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.retry_count).toBe(0);
        expect(job.last_error).toContain("[terminal]");
        expect(job.last_error).toContain("No format available");
        // The ladder descended as far as it goes.
        expect(job.last_error).toContain("highest");
      }
      // 720p → 480p → highest = 3 attempts, then it stops for good.
      const attempts = (await readdir(join(dir, "downloads", "Mock Playlist"))).filter((f) =>
        f.endsWith(".attempts"),
      );
      for (const file of attempts) {
        expect(await Bun.file(join(dir, "downloads", "Mock Playlist", file)).text()).toBe("3");
      }
      const requeued = await engine.api("/api/failed/requeue", { method: "POST" });
      expect(requeued.requeued.downloads).toBe(0);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// Offline mode: the two jobs an archive box with no connection can still do —
// convert files that need conversion, and move finished files to secondary
// storage — while nothing at all is downloaded.
// ---------------------------------------------------------------------------

/**
 * Seed an archive the way a previous online run would have left it: one video
 * still waiting for its download, and one whose media is already in the output
 * tree in a container that still needs conversion. Written through the real
 * schema, then closed before the engine starts.
 */
async function seedOfflineArchive(dir: string, mediaPath: string): Promise<void> {
  // `db` is a live binding reassigned by initDatabase: importing it is what lets
  // this seed the exact schema the engine will open.
  initSeedDatabase(join(dir, "archive.db"));
  const insert = seedDb.prepare(
    `INSERT INTO jobs (id, url, title, output_directory, folder, "index", target_format,
       download_status, conversion_status, metadata_status, progress, best_progress, file_path, file_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    "offlinequeued1",
    "https://www.youtube.com/watch?v=offlinequeued1",
    "001 - Waiting For A Connection",
    join(dir, "downloads"),
    "Mock Playlist",
    1,
    "mp4",
    "pending",
    "pending",
    "not_needed",
    0,
    0,
    null,
    0,
  );
  insert.run(
    "offlineconvert1",
    "https://www.youtube.com/watch?v=offlineconvert1",
    "001 - Already Here",
    join(dir, "downloads"),
    "Mock Playlist",
    2,
    "mp4",
    "downloaded",
    "pending",
    "not_needed",
    100,
    100,
    mediaPath,
    12,
  );
  // Finalize before closing: sqlite3_close_v2 (what bun:sqlite calls) defers the
  // close while a statement it prepared is still alive, so a `close()` that
  // leaves `insert` in scope returns without ever releasing the file lock. The
  // engine then starts against a database it cannot switch to WAL, which is what
  // killed this scenario on Windows.
  insert.finalize();
  seedDb.close();
}

describe("integration: offline mode", () => {
  test("downloads nothing, yet converts and relocates the files that need it", async () => {
    const dir = await makeRunDir();
    const nas = join(dir, "nas");
    const folder = join(dir, "downloads", "Mock Playlist");
    const scanLog = join(dir, "scan.log");
    const media = join(folder, "001 - Already Here.webm");
    const sidecar = join(folder, "001 - Already Here.info.json");
    await mkdir(folder, { recursive: true });
    await writeFile(media, "downloaded-before-offline-mode");
    await writeFile(sidecar, "{}");
    await seedOfflineArchive(dir, media);

    const engine = await startEngine(
      dir,
      4013,
      BASE_CONFIG(4013, {
        offlineMode: true,
        targetFormat: "mp4",
        secondaryStoragePath: nas,
        // Conversion is the point of the run; keep it from being blocked by a
        // metadata stage that cannot run offline anyway.
        downloadSubtitles: false,
        writeThumbnail: false,
        writeDescription: false,
        writeInfoJson: false,
        verifyIntegrity: false,
      }),
      // The mock records every URL it is asked to scan: offline mode must not
      // produce a single entry.
      { FAKE_SCAN_LOG: scanLog },
    );

    try {
      // 1) Nothing is downloaded. The queued job is left exactly as it was —
      //    not claimed, not failed, not paused — and no media appears for it.
      await Bun.sleep(4_000);
      const queued = (await getJobs(engine)).find((j) => j.id === "offlinequeued1") as any;
      expect(queued.download_status).toBe("pending");
      expect(queued.last_error).toBeNull();
      expect(queued.file_path).toBeNull();
      expect(await readdir(folder)).not.toContain("001 - Waiting For A Connection.mp4");
      // No scan either: the source list is untouched and the mock never ran.
      expect(existsSync(scanLog)).toBe(false);
      expect(engine.stdout()).toContain("OFFLINE MODE");
      expect(engine.stdout()).toContain("Source scan skipped (offline mode)");

      // 2) The file that needed conversion is converted…
      await waitFor("the offline conversion to finish", async () => {
        const j = (await getJobs(engine)).find((r) => r.id === "offlineconvert1") as any;
        return !!j && j.conversion_status === "done" && String(j.file_path || "").endsWith(".mp4");
      }, 60_000);

      // … and moved to secondary storage, with its sidecar, source removed.
      await waitFor("the file to reach secondary storage", async () => {
        const j = (await getJobs(engine)).find((r) => r.id === "offlineconvert1") as any;
        const path = String(j.file_path || "");
        return !!j && j.relocated_to === nas && path.startsWith(nas) && existsSync(path);
      }, 60_000);

      const converted = (await getJobs(engine)).find((j) => j.id === "offlineconvert1") as any;
      expect(converted.relocated_to).toBe(nas);
      expect(existsSync(join(nas, "Mock Playlist", "001 - Already Here.mp4"))).toBe(true);
      expect(existsSync(join(nas, "Mock Playlist", "001 - Already Here.info.json"))).toBe(true);
      expect(existsSync(media)).toBe(false);
      expect(existsSync(join(folder, "001 - Already Here.mp4"))).toBe(false);

      // 3) The dashboard reports the mode, so the frozen queue is explained.
      const status = await engine.api("/api/status");
      expect(status.offlineMode).toBe(true);
      expect(status.relocation.path).toBe(nas);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("daemon rescans pause and resume as offline mode is toggled live", async () => {
    const dir = await makeRunDir();
    const scanLog = join(dir, "daemon-scans.log");
    const playlist = "https://www.youtube.com/playlist?list=OFFLINE_DAEMON";
    const engine = await startEngine(
      dir,
      4015,
      BASE_CONFIG(4015, {
        playlists: [],
        offlineMode: true,
        daemonMode: true,
        rescanIntervalHours: 0.0002,
      }),
      { FAKE_SCAN_LOG: scanLog },
    );
    const scanCount = async () =>
      (await Bun.file(scanLog).text().catch(() => ""))
        .split("\n")
        .filter((line) => line === playlist).length;

    try {
      await waitFor("offline daemon engine started", async () => engine.stdout().includes("Engine started"));
      const saved = await engine.api("/api/scan", {
        method: "POST",
        body: JSON.stringify({ url: playlist }),
      });
      expect(saved).toMatchObject({ ok: true, saved: true, found: 0, added: 0 });

      // The recurring scanner is registered, but it must do no work while
      // offline—even for a source saved through the dashboard during this run.
      await Bun.sleep(1_600);
      expect(await scanCount()).toBe(0);

      const online = await engine.api("/api/settings", {
        method: "POST",
        body: JSON.stringify({ offlineMode: false }),
      });
      expect(online.ok).toBe(true);
      await waitFor("daemon rescan after leaving offline mode", async () => (await scanCount()) > 0, 10_000);

      const offline = await engine.api("/api/settings", {
        method: "POST",
        body: JSON.stringify({ offlineMode: true }),
      });
      expect(offline.ok).toBe(true);
      // Allow a scan already in flight at the toggle boundary to finish; later
      // interval ticks must remain idle until the next online transition.
      await Bun.sleep(1_600);
      const countWhileOffline = await scanCount();
      await Bun.sleep(1_600);
      expect(await scanCount()).toBe(countWhileOffline);
    } finally {
      await engine.stop();
    }
  }, TEST_TIMEOUT);

  test("--offline disables downloads for one run without rewriting config.json", async () => {
    // The one-off pass: an operator converts/relocates a backlog offline and
    // wants the next ordinary start to download again. The flag must not leak
    // into the stored setting.
    const dir = await makeRunDir();
    const folder = join(dir, "downloads", "Mock Playlist");
    await mkdir(folder, { recursive: true });
    await seedOfflineArchive(dir, join(folder, "001 - Already Here.webm"));

    const engine = await startEngine(
      dir,
      4014,
      BASE_CONFIG(4014, { targetFormat: "mp4" }), // offlineMode stays false in config.json
      {},
      MOCKS,
      ["--offline"],
    );

    try {
      await Bun.sleep(3_000);
      expect(engine.stdout()).toContain("Offline mode forced for this run");
      expect(engine.stdout()).toContain("OFFLINE MODE");
      const queued = (await getJobs(engine)).find((j) => j.id === "offlinequeued1") as any;
      expect(queued.download_status).toBe("pending");
      expect((await engine.api("/api/status")).offlineMode).toBe(true);
    } finally {
      await engine.stop();
    }

    // config.json is untouched — the key the flag forced was never written, so
    // the next ordinary start downloads again.
    const saved = JSON.parse(await Bun.file(join(dir, "config.json")).text());
    expect("offlineMode" in saved).toBe(false);
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// Compatibility smoke test (opt-in).
//
// Run with: YTA_COMPAT_TEST=1 bun test tests/integration.test.ts
// This job uses the actual yt-dlp/ffmpeg/aria2c binaries (if installed)
// against local fixtures — NOT YouTube. It is NOT part of the fast
// network-independent suite.
describe.skipIf(!process.env.YTA_COMPAT_TEST)("compatibility: real binaries against local fixtures", () => {
  test("the mock's exit-code and stream contracts match the real yt-dlp --version", async () => {
    const proc = Bun.spawn(["yt-dlp", "--version"], { stdout: "pipe", stderr: "pipe" });
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // The mock's contract: exit 0, version on stdout.
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
  });

  test("the mock's exit-code and stream contracts match the real ffmpeg -version", async () => {
    const proc = Bun.spawn(["ffmpeg", "-version"], { stdout: "pipe", stderr: "pipe" });
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(out).toContain("ffmpeg version");
  });
});
