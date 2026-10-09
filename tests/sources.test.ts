// Web UI sources are durable configuration, not just rows in the job queue.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type Config } from "../src/config";
import { getConfig, setConfig } from "../src/state";
import { associateExistingJobsWithSource, db, initDatabase, pruneJobsForUnconfiguredSources } from "../src/db";
import { ingestItems } from "../src/scanner";
import { parseSourceUrl, removeSource, saveSource } from "../src/sources";
import { handleRequest } from "../src/web";

const dirs: string[] = [];
const baseConfig = (overrides: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...overrides });
const playlist = "https://www.youtube.com/playlist?list=PL_saved";
const overlappingPlaylist = "https://www.youtube.com/playlist?list=PL_overlap";
const channel = "https://www.youtube.com/@Teacher";

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yta-sources-"));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  setConfig(baseConfig());
  initDatabase(":memory:");
});
afterEach(async () => {
  setConfig(baseConfig());
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("parseSourceUrl", () => {
  test("recognizes playlists and preserves the list id on watch/share links", () => {
    for (const url of [
      "  https://youtube.com/playlist?list=PL_saved&si=tracking  ",
      "https://m.youtube.com/watch?v=AbCdEf12345&list=PL_saved&index=2&t=10",
      "https://youtu.be/AbCdEf12345?list=PL_saved#fragment",
    ]) {
      expect(parseSourceUrl(url)).toEqual({ key: "playlists", url: playlist });
    }
  });

  test("recognizes channels without losing tab selection", () => {
    for (const path of ["/@Teacher", "/channel/UCabcdefghijk12345", "/c/Teacher", "/user/Teacher", "/c/playlists", "/user/playlists", "/@Teacher/videos", "/@Teacher/streams", "/@Teacher/shorts"]) {
      expect(parseSourceUrl(`http://m.youtube.com${path}/?si=share#fragment`)).toEqual({
        key: "channels", url: `https://www.youtube.com${path}`,
      });
    }
    expect(parseSourceUrl(channel + "/playlists/")).toEqual({
      key: "channelPlaylists", url: channel + "/playlists",
    });
  });

  test("stores single videos in the existing playlists collection", () => {
    for (const url of [
      "https://youtu.be/AbCdEf12345?si=share",
      "https://www.youtube.com/watch?v=AbCdEf12345&t=20",
      "https://www.youtube.com/shorts/AbCdEf12345",
      "https://www.youtube.com/live/AbCdEf12345",
      "https://www.youtube.com/embed/AbCdEf12345",
    ]) {
      expect(parseSourceUrl(url)).toEqual({ key: "playlists", url: "https://www.youtube.com/watch?v=AbCdEf12345" });
    }
  });

  test("rejects missing, malformed, unsupported and non-YouTube inputs", () => {
    for (const value of [
      undefined, null, {}, [], 123, "", "   ", "not a URL", "https://www.youtube.com/", "https://www.youtube.com/playlist?list=",
      "https://youtube.com.evil.example/@Teacher", "https://notyoutube.com/@Teacher", "https://example.com/playlist?list=PL_saved",
      "file:///tmp/videos", "ftp://youtube.com/@Teacher", "https://user:pass@youtube.com/@Teacher", "https://youtube.com:8080/@Teacher",
      "https://www.you\ntube.com/@Teacher", "https://www.youtube.com/watch", "https://youtu.be/", "https://youtube.com/" + "x".repeat(9000),
    ]) {
      expect(() => parseSourceUrl(value)).toThrow();
    }
  });
});

describe("saveSource", () => {
  test("persists the URL to the correct list and preserves all other settings", async () => {
    const path = join(await makeDir(), "config.json");
    const original = baseConfig({ channels: [channel], outputRoot: "D:/Archive", connectionsPerDownload: 8, cookiesFile: "my-cookies.txt" });
    setConfig(original);
    await saveConfig(original, path);
    expect(await saveSource(playlist, path)).toEqual({ key: "playlists", url: playlist, added: true });
    await saveSource(channel + "/playlists", path);
    const saved = await loadConfig(path);
    expect(saved).toEqual({ ...original, playlists: [playlist], channelPlaylists: [channel + "/playlists"] });
    expect(getConfig()).toEqual(saved);
    expect(original.playlists).toEqual([]); // Never mutate a captured/default array.
    expect(DEFAULT_CONFIG.playlists).toEqual([]);
  });

  test("repeated scans and share-link variants do not create duplicate sources", async () => {
    const path = join(await makeDir(), "config.json");
    await saveSource(playlist, path);
    expect((await saveSource("https://youtube.com/watch?v=AbCdEf12345&list=PL_saved&si=x", path)).added).toBe(false);
    expect((await saveSource(playlist, path)).added).toBe(false);
    expect((await loadConfig(path)).playlists).toEqual([playlist]);
  });

  test("deduplicates across legacy lists without moving or deleting existing entries", async () => {
    const path = join(await makeDir(), "config.json");
    const original = baseConfig({ playlists: ["http://youtube.com/@Teacher/", "legacy-entry"] });
    setConfig(original);
    expect((await saveSource(channel, path)).added).toBe(false);
    const saved = await loadConfig(path);
    expect(saved.playlists).toEqual(original.playlists);
    expect(saved.channels).toEqual([]);
  });

  test("concurrent additions keep every URL, including a duplicate submitted at once", async () => {
    const path = join(await makeDir(), "config.json");
    const urls = [playlist, channel, channel + "/playlists", "https://youtu.be/AbCdEf12345", playlist];
    const results = await Promise.all(urls.map((url) => saveSource(url, path)));
    expect(results.filter((r) => r.added)).toHaveLength(4);
    const saved = await loadConfig(path);
    expect(saved.playlists).toEqual([playlist, "https://www.youtube.com/watch?v=AbCdEf12345"]);
    expect(saved.channels).toEqual([channel]);
    expect(saved.channelPlaylists).toEqual([channel + "/playlists"]);
    expect(getConfig()).toEqual(saved);
  });

  test("does not change live config on write failure, and the next save can succeed", async () => {
    const dir = await makeDir();
    const original = getConfig();
    await expect(saveSource(playlist, join(dir, "missing-parent", "config.json"))).rejects.toThrow();
    expect(getConfig()).toBe(original);
    const path = join(dir, "config.json");
    await saveSource(channel, path);
    expect((await loadConfig(path)).channels).toEqual([channel]);
    expect(getConfig().playlists).toEqual([]);
  });

  test("a concurrent settings request cannot overwrite a newly saved source", async () => {
    const dir = await makeDir();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const staleSnapshot = getConfig();
      const [first, settings, second] = await Promise.all([
        saveSource(playlist),
        handleRequest(new Request("http://x/api/settings", {
          method: "POST", body: JSON.stringify({ connectionsPerDownload: 8 }),
        }), staleSnapshot),
        saveSource(channel),
      ]);
      expect(first.added).toBe(true);
      expect(second.added).toBe(true);
      expect(settings.status).toBe(200);
      const saved = await loadConfig();
      expect(saved.playlists).toEqual([playlist]);
      expect(saved.channels).toEqual([channel]);
      expect(saved.connectionsPerDownload).toBe(8);
      expect(getConfig()).toEqual(saved);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("removeSource", () => {
  test("removes the config entry and only deletes jobs exclusive to that source", async () => {
    const dir = await makeDir();
    const path = join(dir, "config.json");
    const config = baseConfig({ playlists: [playlist], channels: [channel], outputRoot: join(dir, "out") });
    setConfig(config);
    await saveConfig(config, path);

    await ingestItems(
      [
        { id: "owned01", title: "Owned", playlist: "Playlist", duration: 120 },
        { id: "shared01", title: "Shared", playlist: "Playlist", duration: 120 },
      ],
      config,
      undefined,
      playlist,
    );
    await ingestItems(
      [{ id: "shared01", title: "Shared", playlist: "Channel", duration: 120 }],
      config,
      undefined,
      channel,
    );

    const result = await removeSource(playlist, path);
    expect(result).toMatchObject({ removed: true, removedConfigEntries: 1, affectedJobs: 2, deletedJobs: 1, retainedJobs: 1 });
    expect(getConfig().playlists).toEqual([]);
    expect(getConfig().channels).toEqual([channel]);
    expect(await loadConfig(path)).toEqual({ ...config, playlists: [] });
    expect(db.query("SELECT id FROM jobs WHERE id = 'owned01'").get()).toBeNull();
    expect(db.query("SELECT id FROM jobs WHERE id = 'shared01'").get()).toEqual({ id: "shared01" });
    expect(db.query("SELECT COUNT(*) AS n FROM job_sources WHERE source_url = ?").get(playlist)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM job_sources WHERE source_url = ?").get(channel)).toEqual({ n: 1 });
    const staleScan = await ingestItems(
      [{ id: "stale02", title: "Should not return", playlist: "Playlist", duration: 120 }],
      config,
      undefined,
      playlist,
    );
    expect(staleScan.added).toBe(0);
    expect(db.query("SELECT id FROM jobs WHERE id = 'stale02'").get()).toBeNull();
  });

  test("an overlapping playlist does not requeue archived IDs after source cleanup", async () => {
    const dir = await makeDir();
    const path = join(dir, "config.json");
    const archive = join(dir, "downloaded_videos.txt");
    const config = baseConfig({
      playlists: [playlist, overlappingPlaylist],
      outputRoot: join(dir, "out"),
      archiveFile: archive,
    });
    setConfig(config);
    await saveConfig(config, path);

    const firstPlaylist = Array.from({ length: 100 }, (_, i) => ({
      id: `video${String(i).padStart(6, "0")}`,
      title: `Video ${i}`,
      playlist: "First Playlist",
      duration: 120,
    }));
    expect((await ingestItems(firstPlaylist, config, undefined, playlist)).added).toBe(100);
    db.run("UPDATE jobs SET download_status = 'downloaded'");
    await writeFile(archive, `${firstPlaylist.map((item) => `youtube ${item.id}`).join("\n")}\n`, "utf8");

    // Source removal still deletes its exclusive job rows; the yt-dlp archive
    // is the durable record that prevents those completed IDs being queued again.
    const removed = await removeSource(playlist, path);
    expect(removed).toMatchObject({ removed: true, deletedJobs: 100, retainedJobs: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });

    const overlap = firstPlaylist.slice(35, 65).map((item) => ({ ...item, playlist: "Second Playlist" }));
    const rescanned = await ingestItems(overlap, getConfig(), undefined, overlappingPlaylist);
    expect(rescanned).toEqual({ found: 30, added: 0, skipped: 30 });
    expect(db.query("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  test("legacy jobs can be associated before a source is removed", async () => {
    const dir = await makeDir();
    const path = join(dir, "config.json");
    const config = baseConfig({ playlists: [playlist], outputRoot: join(dir, "out") });
    setConfig(config);
    await saveConfig(config, path);
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, target_format, folder)
       VALUES ('legacy02', 'https://www.youtube.com/watch?v=legacy02', 'Legacy', ?, 'mp4', 'Playlist')`,
      [join(dir, "out")],
    );

    expect(associateExistingJobsWithSource(playlist, ["legacy02", "missing02"])).toBe(1);
    const result = await removeSource(playlist, path);
    expect(result.deletedJobs).toBe(1);
    expect(db.query("SELECT id FROM jobs WHERE id = 'legacy02'").get()).toBeNull();
  });

  test("a failed config write leaves live config and database jobs untouched", async () => {
    const dir = await makeDir();
    const config = baseConfig({ playlists: [playlist], outputRoot: join(dir, "out") });
    setConfig(config);
    await ingestItems(
      [{ id: "keep001", title: "Keep", playlist: "Playlist", duration: 120 }],
      config,
      undefined,
      playlist,
    );

    await expect(removeSource(playlist, join(dir, "missing", "config.json"))).rejects.toThrow();
    expect(getConfig()).toBe(config);
    expect(db.query("SELECT id FROM jobs WHERE id = 'keep001'").get()).toEqual({ id: "keep001" });
  });

  test("startup pruning catches config.json removals for tracked sources", async () => {
    const dir = await makeDir();
    const config = baseConfig({ playlists: [playlist], channels: [channel], outputRoot: join(dir, "out") });
    setConfig(config);
    await ingestItems(
      [
        { id: "stale01", title: "Stale", playlist: "Playlist", duration: 120 },
        { id: "keep002", title: "Shared", playlist: "Playlist", duration: 120 },
      ],
      config,
      undefined,
      playlist,
    );
    await ingestItems(
      [{ id: "keep002", title: "Shared", playlist: "Channel", duration: 120 }],
      config,
      undefined,
      channel,
    );

    const result = pruneJobsForUnconfiguredSources([channel]);
    expect(result).toEqual({ affectedJobs: 2, deletedJobs: 1, retainedJobs: 1 });
    expect(db.query("SELECT id FROM jobs WHERE id = 'stale01'").get()).toBeNull();
    expect(db.query("SELECT id FROM jobs WHERE id = 'keep002'").get()).toEqual({ id: "keep002" });
  });
});

describe("GET/DELETE /api/sources", () => {
  test("lists configured sources and removes a source from config and the database", async () => {
    const dir = await makeDir();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const config = baseConfig({ playlists: [playlist], outputRoot: join(dir, "out") });
      setConfig(config);
      await saveConfig(config);
      await ingestItems(
        [{ id: "api001", title: "API video", playlist: "Playlist", duration: 120 }],
        config,
        undefined,
        playlist,
      );

      const listed = await handleRequest(new Request("http://x/api/sources"), getConfig());
      expect((await listed.json()).sources).toEqual([{ key: "playlists", url: playlist, trackedJobs: 1 }]);

      const removed = await handleRequest(new Request("http://x/api/sources", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: playlist }),
      }), getConfig());
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ ok: true, deletedJobs: 1, retainedJobs: 0 });
      expect((await loadConfig()).playlists).toEqual([]);
      expect(db.query("SELECT id FROM jobs WHERE id = 'api001'").get()).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  test("does not run the legacy network lookup when deleting a source offline", async () => {
    const dir = await makeDir();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const config = baseConfig({ playlists: [playlist], offlineMode: true });
      setConfig(config);
      await saveConfig(config);
      const removed = await handleRequest(new Request("http://x/api/sources", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: playlist }),
      }), getConfig());
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ ok: true, legacyLookupSkippedOffline: true });
      expect((await loadConfig()).playlists).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  test("rejects malformed and non-configured source deletions", async () => {
    const invalid = await handleRequest(new Request("http://x/api/sources", {
      method: "DELETE", body: JSON.stringify({ url: "https://example.com" }),
    }), getConfig());
    expect(invalid.status).toBe(400);

    const missing = await handleRequest(new Request("http://x/api/sources", {
      method: "DELETE", body: JSON.stringify({ url: playlist }),
    }), getConfig());
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/scan persistence errors", () => {
  test("rejects invalid input before writing configuration or starting a scan", async () => {
    const dir = await makeDir();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      for (const body of ["not json", "null", JSON.stringify({ url: 123 }), JSON.stringify({ url: "https://example.com" }), JSON.stringify({ url: playlist, folder: [] })]) {
        const response = await handleRequest(new Request("http://x/api/scan", { method: "POST", body }), getConfig());
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ ok: false, saved: false });
      }
      expect(await readdir(dir)).toEqual([]);
      expect(getConfig().playlists).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  test("a save failure is explicit, starts no jobs, and cleans up the temporary config", async () => {
    const dir = await makeDir();
    // A directory at the target path fails reliably, even as root/on Windows.
    await mkdir(join(dir, "config.json"));
    await writeFile(join(dir, "config.json", "keep.txt"), "do not delete");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const original = getConfig();
      const response = await handleRequest(new Request("http://x/api/scan", {
        method: "POST", body: JSON.stringify({ url: playlist }),
      }), original);
      const data = await response.json();
      expect(response.status).toBe(500);
      expect(data).toMatchObject({ ok: false, saved: false });
      expect(data.error).toContain("no scan was started");
      expect(getConfig()).toBe(original);
      expect(db.query("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
      expect(await readdir(dir)).toEqual(["config.json"]);
      expect(await readFile(join(dir, "config.json", "keep.txt"), "utf8")).toBe("do not delete");
    } finally {
      process.chdir(cwd);
    }
  });

  test("unauthenticated requests cannot save sources", async () => {
    const protectedConfig = baseConfig({ webToken: "test-token" });
    setConfig(protectedConfig);
    const response = await handleRequest(new Request("http://x/api/scan", {
      method: "POST", body: JSON.stringify({ url: playlist }),
    }), protectedConfig);
    expect(response.status).toBe(401);
    expect(getConfig().playlists).toEqual([]);
  });
});
