// tests/util.test.ts — formatting, filename hardening, hashing helpers.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findDownloadedFile,
  fitBaseFilename,
  formatBytes,
  formatBytesPerSec,
  formatDuration,
  hardenName,
  hashFile,
  parseSpeedToBytesPerSec,
  sanitizeFileName,
  sanitizeFolderName,
} from "../src/util";

describe("formatBytes", () => {
  test("human-readable units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512.0 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

describe("formatBytesPerSec", () => {
  test("appends /s and handles zero", () => {
    expect(formatBytesPerSec(0)).toBe("0 B/s");
    expect(formatBytesPerSec(1024)).toBe("1.0 KB/s");
  });
});

describe("parseSpeedToBytesPerSec", () => {
  test("parses yt-dlp speed strings", () => {
    expect(parseSpeedToBytesPerSec("1.5MiB")).toBeCloseTo(1.5 * 1024 * 1024, 0);
    expect(parseSpeedToBytesPerSec("512KiB")).toBeCloseTo(512 * 1024, 0);
    expect(parseSpeedToBytesPerSec("2MiB")).toBeCloseTo(2 * 1024 * 1024, 0);
    expect(parseSpeedToBytesPerSec("100B")).toBe(100);
  });

  test("returns 0 for unusable values", () => {
    expect(parseSpeedToBytesPerSec("")).toBe(0);
    expect(parseSpeedToBytesPerSec("NA")).toBe(0);
    expect(parseSpeedToBytesPerSec("unknown")).toBe(0);
  });
});

describe("formatDuration", () => {
  test("compact human durations", () => {
    expect(formatDuration(0)).toBe("--");
    expect(formatDuration(30)).toBe("30s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(7320)).toBe("2h 2m");
  });
});

describe("hardenName", () => {
  test("replaces control characters with spaces and collapses whitespace", () => {
    expect(hardenName("hello\u0000world")).toBe("hello world");
    expect(hardenName("a\n\nb   c")).toBe("a b c");
    expect(hardenName("tab\there")).toBe("tab here");
  });

  test("removes trailing dots and spaces (illegal on NTFS)", () => {
    expect(hardenName("video...")).toBe("video");
    expect(hardenName("video   ")).toBe("video");
    expect(hardenName("video. . ")).toBe("video");
  });

  test("guards Windows reserved device names", () => {
    expect(hardenName("CON")).toBe("_CON");
    expect(hardenName("nul.txt")).toBe("_nul.txt");
    expect(hardenName("COM1")).toBe("_COM1");
    expect(hardenName("CONSOLE")).toBe("CONSOLE");
  });

  test("returns empty string for empty input", () => {
    expect(hardenName("")).toBe("");
    expect(hardenName("   ")).toBe("");
  });
});

describe("sanitizeFolderName / sanitizeFileName", () => {
  test("replaces illegal characters", () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(sanitizeFolderName("my/playlist:name")).toBe("my playlist name");
  });

  test("falls back to a safe default", () => {
    expect(sanitizeFileName("")).toBe("video");
    expect(sanitizeFolderName("")).toBe("playlist");
  });
});

describe("fitBaseFilename", () => {
  test("leaves short names untouched", () => {
    expect(fitBaseFilename("/tmp", "short name", "vid123")).toBe("short name");
  });

  test("truncates long names and appends the id", () => {
    const long = "x".repeat(400);
    const fitted = fitBaseFilename("/tmp", long, "vid123");
    expect(fitted.length).toBeLessThan(long.length);
    expect(fitted.endsWith("[vid123]")).toBe(true);
  });

  test("stays within the Windows MAX_PATH budget", () => {
    const deepDir = "D:/Downloads/YT/" + "d".repeat(120);
    const fitted = fitBaseFilename(deepDir, "y".repeat(300), "abcdefghijk");
    // 238 - dir - margin, plus the id suffix
    expect(fitted.length).toBeLessThanOrEqual(238 - deepDir.length);
    expect(fitted.endsWith("[abcdefghijk]")).toBe(true);
  });
});

describe("hashFile", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("returns the SHA-256 of the file contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-hash-"));
    dirs.push(dir);
    const file = join(dir, "data.bin");
    await writeFile(file, "hello world");
    const expected = new Bun.SHA256().update("hello world").digest("hex");
    expect(await hashFile(file)).toBe(expected);
  });
});

describe("findDownloadedFile", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("finds the newest media file matching the base name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-find-"));
    dirs.push(dir);
    await writeFile(join(dir, "001 - Video.mp4"), "old");
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(dir, "001 - Video.webm"), "new");
    await writeFile(join(dir, "001 - Video.en.vtt"), "subtitle"); // sidecar, not media
    await writeFile(join(dir, "002 - Other.mp4"), "different video");
    const found = await findDownloadedFile(dir, "001 - Video");
    expect(found).toBe(join(dir, "001 - Video.webm"));
  });

  test("returns empty string when nothing matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-find-"));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    expect(await findDownloadedFile(dir, "nothing")).toBe("");
    // Missing directory must not throw
    expect(await findDownloadedFile(join(dir, "nope"), "x")).toBe("");
  });
});
