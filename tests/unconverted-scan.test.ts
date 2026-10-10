// tests/unconverted-scan.test.ts — the "Scan Unconverted Videos" import:
// local video files not yet tracked are batch-imported into the conversion
// queue with the chosen target format pre-selected.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { db, initDatabase, claimConvertJob } from "../src/db";
import { localFileJobId, scanUnconvertedVideos } from "../src/unconverted-scan";

let root: string;
let config: Config;

function write(name: string, size = 4096): string {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 7));
  return path;
}

beforeEach(() => {
  initDatabase(":memory:");
  root = mkdtempSync(join(tmpdir(), "unconverted-scan-"));
  config = { ...DEFAULT_CONFIG, outputRoot: root };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scanUnconvertedVideos", () => {
  test("imports untracked video files as conversion-queued jobs with the chosen format", async () => {
    write("a.mkv");
    write("b.mp4");
    write(join("sub", "g.webm"));

    const result = await scanUnconvertedVideos(config, "mkv");

    expect(result.imported).toBe(3);
    expect(result.alreadyTracked).toBe(0);
    expect(result.videoFiles).toBe(3);
    expect(result.targetFormat).toBe("mkv");

    const rows = db.query("SELECT * FROM jobs ORDER BY file_path").all() as any[];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      // Imported jobs skip the download stage entirely and are claimable by
      // the conversion worker with the chosen format pre-selected.
      expect(row.id.startsWith("local-")).toBe(true);
      expect(row.url.startsWith("file://")).toBe(true);
      expect(row.download_status).toBe("downloaded");
      expect(row.conversion_status).toBe("pending");
      expect(row.metadata_status).toBe("not_needed");
      expect(row.target_format).toBe("mkv");
      expect(row.progress).toBe(100);
      expect(row.file_size).toBe(4096);
      expect(row.want_subtitles).toBe(0);
      expect(row.want_thumbnail).toBe(0);
      expect(row.want_description).toBe(0);
    }
    // Title/folder come from the file location.
    const a = rows.find((r) => r.file_path.endsWith("a.mkv"));
    expect(a.title).toBe("a");
    expect(a.folder).toBe("Unconverted");
    const g = rows.find((r) => r.file_path.endsWith("g.webm"));
    expect(g.folder).toBe("sub");
  });

  test("an imported job is immediately claimable by the conversion worker", async () => {
    write("clip.avi");
    await scanUnconvertedVideos(config, "mp4");

    const claimed = claimConvertJob("cv-test") as any;
    expect(claimed).toBeTruthy();
    expect(claimed.file_path.endsWith("clip.avi")).toBe(true);
    expect(claimed.conversion_status).toBe("in_progress");
  });

  test("skips tracked files, sidecars, partials and non-video files", async () => {
    const tracked = write("tracked.mp4");
    db.run("INSERT INTO jobs (id, url, title, output_directory, file_path, download_status) VALUES (?, ?, ?, ?, ?, 'downloaded')", [
      "existing1",
      "https://www.youtube.com/watch?v=existing1",
      "Tracked",
      root,
      tracked,
    ]);
    write("a.mkv");
    write("notes.txt"); // not a video
    write("subs.vtt"); // sidecar
    write("info.json"); // metadata dump
    write("half.part"); // partial data
    write("half.part.aria2"); // partial control file
    write("old.superseded"); // superseded backup
    write("tiny.mp4", 10); // near-empty

    const result = await scanUnconvertedVideos(config, "mp4");

    expect(result.imported).toBe(1);
    expect(result.alreadyTracked).toBe(1);
    expect(result.tooSmall).toBe(1);
    // a.mkv + tracked.mp4 + tiny.mp4 are the only video-extension files.
    expect(result.videoFiles).toBe(3);
    const rows = db.query("SELECT file_path FROM jobs").all() as any[];
    expect(rows.length).toBe(2); // the pre-existing row + the one import
  });

  test("re-running the scan imports nothing new (idempotent ids)", async () => {
    const path = write("a.mkv");
    const first = await scanUnconvertedVideos(config, "mp4");
    expect(first.imported).toBe(1);

    const second = await scanUnconvertedVideos(config, "mp4");
    expect(second.imported).toBe(0);
    expect(second.alreadyTracked).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM jobs").get() as any).toEqual({ n: 1 });
    // Same file → same deterministic id.
    expect(localFileJobId(path)).toBe(localFileJobId(path));
  });

  test("a caller-supplied root overrides the configured output root", async () => {
    const other = mkdtempSync(join(tmpdir(), "unconverted-scan-other-"));
    try {
      writeFileSync(join(other, "elsewhere.mov"), Buffer.alloc(4096, 7));
      write("ignored.mkv");
      const result = await scanUnconvertedVideos(config, "mp4", other);
      expect(result.imported).toBe(1);
      expect(result.root).toBe(other);
      const rows = db.query("SELECT file_path FROM jobs").all() as any[];
      expect(rows[0].file_path).toBe(join(other, "elsewhere.mov"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("does not recurse into .ytdl fragment directories", async () => {
    write("real.mkv");
    const fragDir = join(root, "frag.ytdl");
    mkdirSync(fragDir);
    writeFileSync(join(fragDir, "frag001.mp4"), Buffer.alloc(4096, 7));

    const result = await scanUnconvertedVideos(config, "mp4");
    expect(result.imported).toBe(1);
    expect(result.videoFiles).toBe(1);
  });
});
