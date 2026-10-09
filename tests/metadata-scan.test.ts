// tests/metadata-scan.test.ts — bulk repair for missing metadata sidecars.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { db, initDatabase } from "../src/db";
import { scanDownloadedMetadata } from "../src/metadata-scan";
import { setConfig } from "../src/state";
import { handleRequest } from "../src/web";

const dirs: string[] = [];

function config(overrides: Partial<Config> = {}): Config {
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
  const columns = Object.keys(row);
  db.run(
    `INSERT INTO jobs (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    Object.values(row) as any[],
  );
}

function getJob(id: string): any {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id);
}

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yta-metadata-scan-"));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  initDatabase(":memory:");
  setConfig(config());
});

afterAll(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("scanDownloadedMetadata", () => {
  test("queues only downloaded videos with missing enabled sidecars", async () => {
    const dir = await makeDir();
    const output = join(dir, "downloads");
    await mkdir(output, { recursive: true });
    const current = config({ outputRoot: output });
    setConfig(current);

    const completeMedia = join(output, "001 - Complete.mp4");
    const missingMedia = join(output, "002 - Missing.mp4");
    const pendingMedia = join(output, "003 - Already queued.mp4");
    const missingFilePath = join(output, "004 - Gone.mp4");
    const queuedButNotDownloadedMedia = join(output, "005 - Pending download.mp4");
    const unavailableMedia = join(output, "006 - Source unavailable.mp4");
    const failedMedia = join(output, "007 - Failed metadata.mp4");
    for (const media of [completeMedia, missingMedia, pendingMedia, queuedButNotDownloadedMedia, unavailableMedia, failedMedia]) {
      await writeFile(media, "media");
    }
    for (const sidecar of [
      "001 - Complete.en.srt",
      "001 - Complete.jpg",
      "001 - Complete.description",
      "001 - Complete.info.json",
      "002 - Missing.info.json",
      "006 - Source unavailable.info.json",
    ]) {
      await writeFile(join(output, sidecar), "sidecar");
    }

    insertJob("meta-complete", {
      download_status: "downloaded",
      metadata_status: "done",
      want_subtitles: 1,
      want_thumbnail: 1,
      want_description: 1,
      file_path: completeMedia,
    });
    insertJob("meta-missing", {
      download_status: "downloaded",
      metadata_status: "done",
      metadata_retry_count: 4,
      want_subtitles: 1,
      want_thumbnail: 1,
      want_description: 1,
      file_path: missingMedia,
    });
    insertJob("meta-pending", {
      download_status: "downloaded",
      metadata_status: "pending",
      metadata_retry_count: 2,
      want_subtitles: 1,
      want_thumbnail: 1,
      want_description: 1,
      file_path: pendingMedia,
    });
    insertJob("meta-gone", {
      download_status: "downloaded",
      metadata_status: "done",
      want_subtitles: 1,
      want_thumbnail: 1,
      want_description: 1,
      file_path: missingFilePath,
    });
    insertJob("meta-source-unavailable", {
      download_status: "downloaded",
      metadata_status: "done",
      metadata_unavailable: JSON.stringify(["subtitles"]),
      want_subtitles: 1,
      file_path: unavailableMedia,
    });
    insertJob("meta-failed", {
      download_status: "downloaded",
      metadata_status: "failed",
      metadata_retry_count: 4,
      want_subtitles: 1,
      want_thumbnail: 1,
      want_description: 1,
      file_path: failedMedia,
    });
    insertJob("meta-not-downloaded", {
      download_status: "pending",
      metadata_status: "not_needed",
      file_path: queuedButNotDownloadedMedia,
    });

    const result = await scanDownloadedMetadata(current);
    expect(result).toEqual({
      scanned: 6,
      queued: 1,
      alreadyQueued: 1,
      alreadyRunning: 0,
      complete: 1,
      sourceUnavailable: 1,
      failed: 1,
      missingMedia: 1,
      unreadableDirectories: 0,
      noMetadataRequested: 0,
      changedDuringScan: 0,
      abortedOffline: false,
    });
    expect(getJob("meta-complete")).toMatchObject({
      metadata_status: "done",
      metadata_unavailable: "[]",
      want_subtitles: 1,
      want_thumbnail: 1,
      want_description: 1,
    });
    expect(JSON.parse(getJob("meta-complete").metadata_files).sort()).toEqual(
      [
        "001 - Complete.en.srt",
        "001 - Complete.jpg",
        "001 - Complete.description",
        "001 - Complete.info.json",
      ].sort(),
    );
    expect(getJob("meta-missing")).toMatchObject({
      metadata_status: "pending",
      metadata_retry_count: 0,
      want_subtitles: 1,
      want_thumbnail: 1,
      want_description: 1,
    });
    expect(getJob("meta-pending")).toMatchObject({ metadata_status: "pending", metadata_retry_count: 2 });
    expect(getJob("meta-source-unavailable").metadata_status).toBe("done");
    expect(getJob("meta-failed")).toMatchObject({ metadata_status: "failed", metadata_retry_count: 4 });
    expect(getJob("meta-not-downloaded").metadata_status).toBe("not_needed");
  });

  test("respects per-video sidecar opt-outs when global sidecar defaults are enabled", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Opted out.mp4");
    await writeFile(media, "media");
    const current = config({ downloadSubtitles: true, writeThumbnail: true, writeDescription: true, writeInfoJson: false });
    setConfig(current);
    insertJob("meta-opted-out", {
      download_status: "downloaded",
      metadata_status: "not_needed",
      want_subtitles: 0,
      want_thumbnail: 0,
      want_description: 0,
      file_path: media,
    });

    const result = await scanDownloadedMetadata(current);
    expect(result.noMetadataRequested).toBe(1);
    expect(result.queued).toBe(0);
    expect(getJob("meta-opted-out").metadata_status).toBe("not_needed");
  });

  test("offline mode leaves metadata states untouched", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - Offline.mp4");
    await writeFile(media, "media");
    const offline = config({ offlineMode: true, outputRoot: dir });
    setConfig(offline);
    insertJob("meta-offline", { download_status: "downloaded", metadata_status: "done", file_path: media });

    const result = await scanDownloadedMetadata(offline);
    expect(result.abortedOffline).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.queued).toBe(0);
    expect(getJob("meta-offline").metadata_status).toBe("done");

    const response = await handleRequest(
      new Request("http://localhost/api/metadata/scan", { method: "POST" }),
      offline,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("offline");
  });

  test("POST /api/metadata/scan exposes the bulk scan and queues missing metadata", async () => {
    const dir = await makeDir();
    const media = join(dir, "001 - API.mp4");
    await writeFile(media, "media");
    const current = config({ outputRoot: dir });
    setConfig(current);
    insertJob("meta-api", { download_status: "downloaded", metadata_status: "not_needed", file_path: media });

    const response = await handleRequest(
      new Request("http://localhost/api/metadata/scan", { method: "POST" }),
      current,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, scanned: 1, queued: 1, alreadyQueued: 0 });
    expect(getJob("meta-api").metadata_status).toBe("pending");
  });
});
