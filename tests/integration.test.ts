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

import { afterAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";

const REPO_ROOT = resolve(import.meta.dir, "..");
const MOCKS = join(REPO_ROOT, "tests", "mocks");
const ENTRY = join(REPO_ROOT, "batch_playlist_downloader.ts");

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

  const proc = Bun.spawn([process.execPath, "run", ENTRY], {
    cwd: dir,
    env: { ...childEnv, ...env },
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
  last_error: string | null;
  file_path: string | null;
  partial_file_path: string | null;
  progress: number;
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
  test("fails fast without spending budget, discards the partial, and is never auto-requeued", async () => {
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
        // Fail fast: a dead video is parked on the first attempt, not retried
        // until the budget burns.
        expect(job.retry_count).toBe(0);
        expect(job.last_error).toContain("Video unavailable");
        expect(job.partial_file_path).toBeNull();
      }

      // The dead partials were discarded with the jobs — nothing to resume, and
      // no litter for the orphan sweep.
      const files = await readdir(join(dir, "downloads", "Mock Playlist"));
      expect(files.filter((f) => f.endsWith(".part"))).toHaveLength(0);

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
        // A single download slot makes the split deterministic, so the
        // recorded cap must equal the configured one verbatim.
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
        const args = await Bun.file(join(dir, "downloads", "Mock Playlist", f)).text();
        expect(args).toContain("-x 8");
        expect(args).toContain("-s 8");
        expect(args).toContain("-j 8");
        expect(args).toContain("--max-overall-download-limit 2048K");
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

      // Every video was retried and completed — without spending retry budget:
      // the failed attempt left resumable bytes on disk, so it was forgiven.
      // (The resumed=yes evidence below proves a retry really happened.)
      for (const job of jobs) {
        expect(job.retry_count).toBe(0);
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
        const args = await Bun.file(join(folder, f)).text();
        expect(args).toContain("resumed=yes");
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
      const args = await Bun.file(argsFile).text();
      expect(args).toContain("--audio-multistreams");
      expect(args).toContain("--merge-output-format mkv");
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
      const retryArgs = await Bun.file(argsFile).text();
      expect(retryArgs).toContain("bv[height<=1080]+251-1/b[height<=1080]");
      expect(retryArgs).not.toContain("--audio-multistreams");

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
      const args = await Bun.file(join(folder, "002 - Second Mock Video.ytdlp-args")).text();
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
      const args = await Bun.file(join(folder, "001 - First Mock Video.ytdlp-args")).text();
      expect(args).toContain("--format bv[height<=1080]+ba/b[height<=1080]");
      expect(args).not.toContain("--audio-multistreams");
      const apiJobs = (await getJobs(engine)) as any[];
      for (const j of apiJobs) expect(j.audio_tracks).toEqual([]); // no probe ran
      const files = await readdir(folder);
      expect(files.filter((f) => f.endsWith(".mp4"))).toHaveLength(3);
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
        const args = await Bun.file(join(folder, f)).text();
        expect(args).toContain("-x 16");
        expect(args).toContain("-s 32");
        expect(args).toContain("-j 32");
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
