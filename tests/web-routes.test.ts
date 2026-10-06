// tests/web-routes.test.ts — the API route table: canonical per-job paths,
// legacy aliases, and the JSON 404/405 contract.
//
// handleRequest is exercised directly against an in-memory database, the same
// way tests/settings.test.ts drives the settings endpoints.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { setConfig } from "../src/state";
import { db, initDatabase } from "../src/db";
import { triggerPause, triggerResume } from "../src/resilience";
import { handleRequest } from "../src/web";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

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

function getJob(id: string): any {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id);
}

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);
const api = (path: string, init?: RequestInit) => handleRequest(req(path, init), baseConfig());

async function expectInProgress(response: Response): Promise<void> {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, error: "Job is currently in progress" });
}

beforeEach(() => {
  initDatabase(":memory:");
  setConfig(baseConfig());
});

afterEach(() => {
  // pause/resume tests flip global engine state — always restore "running".
  if (triggerPauseTestOnlyWasUsed) triggerResume();
});
let triggerPauseTestOnlyWasUsed = false;

describe("the route table", () => {
  test("GET /api/jobs/:id returns one job with parsed audio columns", async () => {
    insertJob("route01", { audio_tracks: JSON.stringify([{ formatId: "251", language: "en" }]) });
    const res = await api("/api/jobs/route01");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.job.id).toBe("route01");
    expect(Array.isArray(data.job.audio_tracks)).toBe(true);
    expect(data.job.audio_tracks[0].formatId).toBe("251");
  });

  test("GET /api/jobs/:id answers 404 as JSON for an unknown id", async () => {
    const res = await api("/api/jobs/nope999");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("not found");
  });

  test("POST /api/jobs/:id/retry re-queues a failed job with fresh budgets", async () => {
    insertJob("route02", { download_status: "failed", retry_count: 9, last_error: "boom" });
    const res = await api("/api/jobs/route02/retry", { method: "POST" });
    expect(res.status).toBe(200);
    const job = getJob("route02");
    expect(job.download_status).toBe("pending");
    expect(job.retry_count).toBe(0);
    expect(job.last_error).toBeNull();
  });

  test("the legacy POST /api/retry/:id alias still works", async () => {
    insertJob("route03", { download_status: "failed", retry_count: 3 });
    const res = await api("/api/retry/route03", { method: "POST" });
    expect((await res.json()).ok).toBe(true);
    expect(getJob("route03").download_status).toBe("pending");
  });

  test("POST /api/jobs/:id/reset-failures clears the counters; unknown id is a JSON 404", async () => {
    insertJob("route04", { retry_count: 5, conversion_retry_count: 2, metadata_retry_count: 1, last_error: "x" });
    const bad = await api("/api/jobs/nope999/reset-failures", { method: "POST" });
    expect(bad.status).toBe(404);
    const res = await api("/api/jobs/route04/reset-failures", { method: "POST" });
    expect((await res.json()).ok).toBe(true);
    const job = getJob("route04");
    expect(job.retry_count).toBe(0);
    expect(job.conversion_retry_count).toBe(0);
    expect(job.metadata_retry_count).toBe(0);
  });

  test("DELETE /api/jobs with an id list is the canonical bulk delete", async () => {
    insertJob("route05");
    insertJob("route06");
    const res = await api("/api/jobs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["route05", "route06"] }),
    });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(2);
    expect(getJob("route05")).toBeFalsy();
  });

  test("the legacy POST /api/jobs/delete alias still works", async () => {
    insertJob("route07");
    const res = await api("/api/jobs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["route07"] }),
    });
    expect((await res.json()).deleted).toBe(1);
  });

  test("unknown API paths answer a JSON 404, not plain text", async () => {
    const res = await api("/api/definitely/not/a/route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  test("a known path with the wrong method answers 405 with an Allow header", async () => {
    const res = await api("/api/pause", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
    const data = await res.json();
    expect(data.ok).toBe(false);

    // A static action path is never mistaken for an :id route.
    const res2 = await api("/api/jobs/pause", { method: "GET" });
    expect(res2.status).toBe(405);
  });

  test("trailing slashes collapse: /api/jobs/ is /api/jobs", async () => {
    const res = await api("/api/jobs/");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.jobs)).toBe(true);
  });

  test("pause/resume share the {ok, success, paused} envelope", async () => {
    triggerPauseTestOnlyWasUsed = true;
    const pause = await api("/api/pause", { method: "POST" });
    const pauseData = await pause.json();
    expect(pauseData).toMatchObject({ ok: true, success: true, paused: true });

    const resume = await api("/api/resume", { method: "POST" });
    const resumeData = await resume.json();
    expect(resumeData).toMatchObject({ ok: true, success: true, paused: false });
    triggerPauseTestOnlyWasUsed = false;
  });

  test("GET /api/version reports the runtime", async () => {
    const res = await api("/api/version");
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.name).toBe("youtube-playlist-downloader");
    expect(data.runtime.bun).toBeTruthy();
    expect(typeof data.uptimeSeconds).toBe("number");
  });

  test("GET /api/status carries ok and runtime alongside the existing fields", async () => {
    const res = await api("/api/status");
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.stats.total).toBe(0);
    expect(data.runtime.platform).toBe(process.platform);
    expect(Array.isArray(data.workers)).toBe(true);
  });
});

describe("job mutations reject active pipeline claims", () => {
  test("retry refuses a live conversion before touching the archive or media file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-active-retry-"));
    const archive = join(dir, "archive.txt");
    const media = join(dir, "video.mp4");
    await writeFile(archive, "youtube busyretry\n");
    await writeFile(media, "existing media");
    insertJob("busyretry", {
      download_status: "downloaded",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-1",
      metadata_status: "done",
      file_path: media,
      superseded_file: null,
      retry_count: 4,
    });

    const response = await apiWith("/api/jobs/busyretry/retry", cfgWith({ archiveFile: archive }), {
      method: "POST",
    });
    await expectInProgress(response);

    const job = getJob("busyretry");
    expect(job).toMatchObject({
      download_status: "downloaded",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-1",
      retry_count: 4,
      file_path: media,
      superseded_file: null,
    });
    expect(existsSync(media)).toBe(true);
    expect(existsSync(`${media}.superseded`)).toBe(false);
    expect(await readFile(archive, "utf-8")).toBe("youtube busyretry\n");
  });

  test("single delete refuses an active metadata stage", async () => {
    insertJob("busydelete", { download_status: "downloaded", metadata_status: "in_progress" });

    const response = await api("/api/jobs/busydelete", { method: "DELETE" });
    await expectInProgress(response);
    expect(getJob("busydelete")).toMatchObject({
      download_status: "downloaded",
      metadata_status: "in_progress",
    });
  });

  test("bulk delete is all-or-nothing when one requested job is downloading", async () => {
    insertJob("bulk-active", {
      download_status: "downloading",
      download_claimed_by: "dl-1",
    });
    insertJob("bulk-idle", { download_status: "pending" });

    const response = await api("/api/jobs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["bulk-active", "bulk-idle"] }),
    });
    await expectInProgress(response);
    expect(getJob("bulk-active")).toMatchObject({ download_status: "downloading", download_claimed_by: "dl-1" });
    expect(getJob("bulk-idle")).toMatchObject({ download_status: "pending" });
  });

  test("bulk pause leaves every requested row unchanged if one stage is active", async () => {
    insertJob("pause-active", {
      download_status: "downloaded",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-2",
    });
    insertJob("pause-idle", { download_status: "pending" });

    const response = await api("/api/jobs/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["pause-active", "pause-idle"] }),
    });
    await expectInProgress(response);
    expect(getJob("pause-active")).toMatchObject({
      download_status: "downloaded",
      conversion_status: "in_progress",
      conversion_claimed_by: "cv-2",
    });
    expect(getJob("pause-idle")).toMatchObject({ download_status: "pending" });
  });

  test("single-job pause refuses a currently downloading row and leaves it unchanged", async () => {
    insertJob("pause-downloading", {
      download_status: "downloading",
      download_claimed_by: "dl-1",
      pause_reason: null,
    });

    const response = await api("/api/jobs/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["pause-downloading"] }),
    });
    await expectInProgress(response);
    expect(getJob("pause-downloading")).toMatchObject({
      download_status: "downloading",
      pause_reason: null,
      download_claimed_by: "dl-1",
    });
  });

  test("purge refuses a paused row that still holds a download claim", async () => {
    insertJob("purge-active", {
      download_status: "paused",
      pause_reason: "user",
      download_claimed_by: "dl-3",
    });
    insertJob("purge-idle", { download_status: "pending" });

    const response = await api("/api/queue/purge", { method: "POST" });
    await expectInProgress(response);
    expect(getJob("purge-active")).toMatchObject({
      download_status: "paused",
      download_claimed_by: "dl-3",
    });
    expect(getJob("purge-idle")).toMatchObject({ download_status: "pending" });
  });
});

// --- Deliberate re-downloads and per-job sidecars -----------------------------
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const cfgWith = (overrides: Partial<Config>): Config => ({ ...DEFAULT_CONFIG, ...overrides });
const apiWith = (path: string, config: Config, init?: RequestInit) => handleRequest(req(path, init), config);

describe("retry as a deliberate re-download", () => {
  test("scrubs the yt-dlp archive and stashes the existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-webretry-"));
    const archive = join(dir, "downloaded_videos.txt");
    await writeFile(archive, "youtube other01\nyoutube redl01\n");
    const media = join(dir, "001 - Video.mp4");
    await writeFile(media, "old-bytes");
    insertJob("redl01", { download_status: "downloaded", file_path: media, file_size: 9 });
    const config = cfgWith({ archiveFile: archive });

    const res = await apiWith("/api/jobs/redl01/retry", config, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // The id left the archive so yt-dlp will actually download it again…
    const lines = (await readFile(archive, "utf-8")).split("\n").filter(Boolean);
    expect(lines).toEqual(["youtube other01"]);
    // …and the previous file is kept as a backup instead of being deleted.
    expect(existsSync(media)).toBe(false);
    expect(existsSync(`${media}.superseded`)).toBe(true);
    const job = getJob("redl01");
    expect(job.download_status).toBe("pending");
    expect(job.file_path).toBeNull();
    expect(job.superseded_file).toBe(`${media}.superseded`);
  });

  test("the legacy alias applies the same re-download contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-webretry-"));
    const archive = join(dir, "downloaded_videos.txt");
    await writeFile(archive, "youtube redl02\n");
    insertJob("redl02", { download_status: "downloaded" });
    const config = cfgWith({ archiveFile: archive });

    const res = await apiWith("/api/retry/redl02", config, { method: "POST" });
    expect((await res.json()).ok).toBe(true);
    expect((await readFile(archive, "utf-8")).trim()).toBe("");
  });
});

describe("POST /api/jobs/:id/sidecars", () => {
  test("toggles flags and re-opens the metadata stage for a downloaded job", async () => {
    insertJob("side01", {
      download_status: "downloaded",
      metadata_status: "not_needed",
      want_subtitles: 0,
      want_thumbnail: 0,
      want_description: 0,
    });
    const res = await api("/api/jobs/side01/sidecars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtitles: true }),
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, want_subtitles: true, metadata_status: "pending" });
    const job = getJob("side01");
    expect(job.want_subtitles).toBe(1);
    expect(job.metadata_status).toBe("pending");
  });

  test("turning every flag off leaves a terminal metadata stage alone", async () => {
    insertJob("side02", {
      download_status: "downloaded",
      metadata_status: "done",
      want_subtitles: 1,
      want_thumbnail: 1,
      want_description: 0,
    });
    const res = await api("/api/jobs/side02/sidecars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtitles: false, thumbnail: false }),
    });
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, want_subtitles: false, want_thumbnail: false, metadata_status: "done" });
  });

  test("rejects empty bodies and non-boolean flags", async () => {
    insertJob("side03", { download_status: "downloaded" });
    const empty = await api("/api/jobs/side03/sidecars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    const bad = await api("/api/jobs/side03/sidecars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtitles: "yes" }),
    });
    expect(bad.status).toBe(400);
  });

  test("unknown job is a JSON 404", async () => {
    const res = await api("/api/jobs/nope/sidecars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtitles: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe("job payloads", () => {
  test("GET /api/jobs/:id parses metadata_files and boolean sidecar flags", async () => {
    insertJob("shape01", {
      download_status: "downloaded",
      want_subtitles: 1,
      want_thumbnail: 0,
      want_description: 1,
      metadata_files: JSON.stringify(["001.en.srt", "001.jpg"]),
    });
    const res = await api("/api/jobs/shape01");
    const data = await res.json();
    expect(data.job.metadata_files).toEqual(["001.en.srt", "001.jpg"]);
    expect(data.job.want_subtitles).toBe(true);
    expect(data.job.want_thumbnail).toBe(false);
    expect(data.job.want_description).toBe(true);
    expect(data.job.superseded_file).toBeNull();
  });
});
