// tests/video-summary.test.ts — the title/duration probe a listing left blank.
//
// A Bilibili flat listing carries no titles and no durations, so the download
// worker completes both with one bounded metadata call before it builds its
// plan. These tests pin the pure rules (what parses, when the probe is allowed
// to run, which flags it uses) and then the process lifecycle itself — real
// child processes, so the timeout, the pipe drain and the error wording are
// exercised rather than mocked.

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SUMMARY_PRINT_TEMPLATE,
  SUMMARY_PROBE_TIMEOUT_MS,
  isUnknownListingTitle,
  needsSummaryBackfill,
  parseSummaryLine,
  probeVideoSummary,
  summaryProbeArgs,
} from "../src/video-summary";
import { resolvedTools } from "../src/tools";
import type { ProbeSummaryOptions } from "../src/video-summary";

const BILIBILI_URL = "https://www.bilibili.com/video/BV1x411c7mD";

describe("parseSummaryLine", () => {
  test("reads the two fields the template prints", () => {
    expect(parseSummaryLine("Some Video Title|||125")).toEqual({ title: "Some Video Title", duration: 125 });
    expect(parseSummaryLine("  Padded Title  |||  7320  ")).toEqual({ title: "Padded Title", duration: 7320 });
    // A CJK title is what a Bilibili video actually has; nothing may fold it.
    expect(parseSummaryLine("【合集】某视频 第1集|||865.5")).toEqual({
      title: "【合集】某视频 第1集",
      duration: 865.5,
    });
  });

  test("a field yt-dlp does not have stays null, never 0 or a placeholder", () => {
    expect(parseSummaryLine("NA|||NA")).toEqual({ title: null, duration: null });
    expect(parseSummaryLine("Only A Title|||NA")).toEqual({ title: "Only A Title", duration: null });
    expect(parseSummaryLine("NA|||900")).toEqual({ title: null, duration: 900 });
    expect(parseSummaryLine("Title|||0")).toEqual({ title: "Title", duration: null });
    expect(parseSummaryLine("Title|||-5")).toEqual({ title: "Title", duration: null });
    expect(parseSummaryLine("Title|||not-a-number")).toEqual({ title: "Title", duration: null });
    expect(parseSummaryLine("Title")).toEqual({ title: "Title", duration: null });
    expect(parseSummaryLine("")).toEqual({ title: null, duration: null });
    expect(parseSummaryLine(null)).toEqual({ title: null, duration: null });
    expect(parseSummaryLine(undefined)).toEqual({ title: null, duration: null });
  });

  test("a title that contains the separator keeps its tail", () => {
    expect(parseSummaryLine("Part A|||Part B|||60")).toEqual({ title: "Part A|||Part B", duration: 60 });
  });
});

describe("isUnknownListingTitle", () => {
  test("recognises the placeholder the listing leaves behind", () => {
    expect(isUnknownListingTitle("video")).toBe(true);
    expect(isUnknownListingTitle("  video ")).toBe(true);
    expect(isUnknownListingTitle("NA")).toBe(true);
    expect(isUnknownListingTitle("")).toBe(true);
    expect(isUnknownListingTitle(null)).toBe(true);
    expect(isUnknownListingTitle(undefined)).toBe(true);
  });

  test("a real title is never a placeholder, however short", () => {
    expect(isUnknownListingTitle("Video")).toBe(false);
    expect(isUnknownListingTitle("videos")).toBe(false);
    expect(isUnknownListingTitle("第1集")).toBe(false);
    expect(isUnknownListingTitle("a")).toBe(false);
  });
});

describe("needsSummaryBackfill", () => {
  test("a listing with neither title nor duration needs the probe", () => {
    expect(needsSummaryBackfill({ title: "video", duration: null })).toBe(true);
    expect(needsSummaryBackfill({ title: null, duration: null })).toBe(true);
    expect(needsSummaryBackfill({ title: "NA", duration: 0 })).toBe(true);
  });

  test("a missing duration needs the probe even when the title is real", () => {
    // The download watchdog scales with the video's length and falls back to the
    // configured MINIMUM without one, which kills a long upload mid-transfer.
    expect(needsSummaryBackfill({ title: "A real title", duration: null })).toBe(true);
    expect(needsSummaryBackfill({ title: "A real title", duration: 0 })).toBe(true);
    expect(needsSummaryBackfill({ title: "A real title", duration: Number.NaN })).toBe(true);
  });

  test("a complete listing entry never triggers a probe", () => {
    expect(needsSummaryBackfill({ title: "First Mock Video", duration: 125 })).toBe(false);
    expect(needsSummaryBackfill({ title: "First Mock Video", duration: 0.5 })).toBe(false);
  });

  test("a job that already has bytes on disk is never renamed", () => {
    // Those files were named from the title we have; renaming it now would
    // orphan the .part (and the aria2c control file) the resume depends on.
    expect(needsSummaryBackfill({ title: "video", duration: null, file_path: "/out/001 - video.mp4" })).toBe(false);
    expect(
      needsSummaryBackfill({ title: "video", duration: null, partial_file_path: "/out/001 - video.f137.mp4.part" }),
    ).toBe(false);
    expect(needsSummaryBackfill({ title: "video", duration: null, best_progress: 0.1 })).toBe(false);
    expect(needsSummaryBackfill({ title: "video", duration: null, file_path: "", partial_file_path: null, best_progress: 0 })).toBe(true);
  });
});

describe("summaryProbeArgs", () => {
  test("asks for exactly the two fields, and nothing that writes a file", () => {
    expect(SUMMARY_PRINT_TEMPLATE).toBe("%(title)s|||%(duration)s");
    const args = summaryProbeArgs(BILIBILI_URL, { cookiesFile: "" });
    // The engine puts the URL first everywhere; the mock and real yt-dlp agree.
    expect(args[0]).toBe(BILIBILI_URL);
    expect(args).toContain("--print");
    expect(args[args.indexOf("--print") + 1]).toBe(SUMMARY_PRINT_TEMPLATE);
    expect(args).toContain("--skip-download");
    expect(args).toContain("--no-warnings");
    expect(args).not.toContain("-o");
    expect(args).not.toContain("--output");
    expect(args).not.toContain("--write-info-json");
  });

  test("probes one video, never the anthology or playlist its URL expands into", () => {
    expect(summaryProbeArgs(BILIBILI_URL, { cookiesFile: "" })).toContain("--no-playlist");
  });

  test("bounded retries, so a flaky answer cannot hold a download slot forever", () => {
    const args = summaryProbeArgs(BILIBILI_URL, { cookiesFile: "" });
    expect(args[args.indexOf("--socket-timeout") + 1]).toBe("15");
    expect(args[args.indexOf("--retries") + 1]).toBe("3");
    expect(args[args.indexOf("--extractor-retries") + 1]).toBe("3");
  });

  test("carries the operator's cookies and user agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-summary-cookies-"));
    try {
      const file = join(dir, "cookies.txt");
      await writeFile(file, "# Netscape HTTP Cookie File\n", "utf8");
      const args = summaryProbeArgs(BILIBILI_URL, { cookiesFile: file, userAgent: "Mozilla/5.0 (TestAgent)" });
      expect(args).toContain("--cookies");
      expect(args[args.indexOf("--user-agent") + 1]).toBe("Mozilla/5.0 (TestAgent)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the default watchdog is a minute, and the override exists for tests", () => {
    expect(SUMMARY_PROBE_TIMEOUT_MS).toBe(60_000);
  });
});

describe.skipIf(process.platform === "win32")("probeVideoSummary against a real child process", () => {
  // Each stub is a real subprocess, so the probe's own spawn, pipe drain,
  // watchdog and kill/reap paths are what is under test.
  const original = resolvedTools.ytDlp;
  const stubDirs: string[] = [];

  async function probeStub(name: string, body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `yta-summary-${name}-`));
    stubDirs.push(dir);
    const file = join(dir, "yt-dlp");
    // Absolute interpreter: the stub must not need a working PATH.
    await writeFile(file, `#!${process.execPath}\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  }

  afterAll(async () => {
    resolvedTools.ytDlp = original;
    for (const dir of stubDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("answers the title and duration of one video", async () => {
    resolvedTools.ytDlp = await probeStub("ok", 'console.log("【官方 MV】Never Gonna Give You Up|||212.5");');
    await expect(probeVideoSummary(BILIBILI_URL, { cookiesFile: "" })).resolves.toEqual({
      title: "【官方 MV】Never Gonna Give You Up",
      duration: 212.5,
    });
  });

  test("finds the answer line among yt-dlp's own chatter", async () => {
    resolvedTools.ytDlp = await probeStub(
      "noisy",
      'console.log("[BiliBili] BV1x411c7mD: Downloading webpage");\n' +
        'console.error("WARNING: unable to obtain file timestamps");\n' +
        'console.log("Real Title|||900");\n',
    );
    await expect(probeVideoSummary(BILIBILI_URL, { cookiesFile: "" })).resolves.toEqual({
      title: "Real Title",
      duration: 900,
    });
  });

  test("a video with neither field yields nulls instead of throwing", async () => {
    resolvedTools.ytDlp = await probeStub("na", 'console.log("NA|||NA");');
    await expect(probeVideoSummary(BILIBILI_URL, { cookiesFile: "" })).resolves.toEqual({
      title: null,
      duration: null,
    });
  });

  test("a chatty stderr cannot deadlock the stdout reader", async () => {
    // 400 KB of warnings on one pipe while the answer sits on the other: without
    // draining both concurrently the child would block on a full stderr pipe.
    resolvedTools.ytDlp = await probeStub(
      "chatty",
      'for (let i = 0; i < 8000; i++) console.error("WARNING: chatty downloader diagnostic " + i);\n' +
        'console.log("Title After The Noise|||42");',
    );
    await expect(probeVideoSummary(BILIBILI_URL, { cookiesFile: "" })).resolves.toEqual({
      title: "Title After The Noise",
      duration: 42,
    });
  });

  test("a failure throws with yt-dlp's own wording, so risk control reads as transient", async () => {
    resolvedTools.ytDlp = await probeStub(
      "fail",
      'console.error("ERROR: [BiliBili] Request is blocked by server (412), please wait and try later.");\nprocess.exit(1);',
    );
    await expect(probeVideoSummary(BILIBILI_URL, { cookiesFile: "" })).rejects.toThrow(/blocked by server \(412\)/i);
  });

  test("an answer with no fields at all throws instead of naming the file \"\"", async () => {
    resolvedTools.ytDlp = await probeStub("empty", 'console.log("");');
    await expect(probeVideoSummary(BILIBILI_URL, { cookiesFile: "" })).rejects.toThrow(/no title line/i);
  });

  test("a hung probe is killed at its watchdog, not left holding the slot", async () => {
    resolvedTools.ytDlp = await probeStub("hang", "await new Promise(() => {});");
    const started = Date.now();
    await expect(
      probeVideoSummary(BILIBILI_URL, { cookiesFile: "" }, { timeoutMs: 250 }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a yt-dlp that cannot start is reported as a probe failure, not a crash", async () => {
    resolvedTools.ytDlp = join(tmpdir(), "yta-summary-does-not-exist", "yt-dlp");
    await expect(probeVideoSummary(BILIBILI_URL, { cookiesFile: "" })).rejects.toThrow(/could not start|spawn|ENOENT|no such file/i);
  });

  test("an injected spawn sees the URL first and the flags the plan depends on", async () => {
    resolvedTools.ytDlp = original;
    let seen: string[] = [];
    const spawn = ((args: string[]) => {
      seen = args;
      return Bun.spawn([process.execPath, "-e", 'console.log("Injected Title|||7");'], {
        stdout: "pipe",
        stderr: "pipe",
      }) as unknown as Bun.PipedSubprocess;
    }) as ProbeSummaryOptions["spawn"];
    await expect(probeVideoSummary(BILIBILI_URL, { cookiesFile: "" }, { spawn })).resolves.toEqual({
      title: "Injected Title",
      duration: 7,
    });
    expect(seen[0]).toBe(original);
    expect(seen[1]).toBe(BILIBILI_URL);
    expect(seen).toContain("--no-playlist");
    expect(seen).toContain("--print");
  });
});

