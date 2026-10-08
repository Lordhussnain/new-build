// tests/download-args.test.ts — yt-dlp command construction.
//
// Covers downloader-engine selection (aria2c vs native), aria2c connection
// tuning, the bandwidth split across active slots, fragment/chunk/buffer
// tuning, and the per-video watchdog — the full contract the download worker
// relies on, verified without spawning anything.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildAria2cArgs,
  buildDownloadPlan,
  computePerWorkerLimitBytesPerSec,
  jobBaseFilename,
  resolveDownloaderEngine,
} from "../src/download-args";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { DOWNLOAD_SPEED_PROFILES } from "../src/settings";

const cfg = (overrides: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...overrides });

const job = {
  id: "vidABC123",
  url: "https://www.youtube.com/watch?v=vidABC123",
  title: "Some Video",
  index: 7,
  output_directory: "/tmp/downloads/Playlist",
  duration: 600,
};

/** Index of an exact argv pair, e.g. flag(args, "--format"). */
function flag(args: string[], name: string): number {
  return args.indexOf(name);
}
function flagValue(args: string[], name: string): string | undefined {
  const i = flag(args, name);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("resolveDownloaderEngine", () => {
  test("aria2c when enabled and available", () => {
    expect(resolveDownloaderEngine(cfg({ useAria2c: true }), true)).toBe("aria2c");
  });

  test("native when aria2c is missing (graceful fallback)", () => {
    expect(resolveDownloaderEngine(cfg({ useAria2c: true }), false)).toBe("native");
  });

  test("native when disabled in config", () => {
    expect(resolveDownloaderEngine(cfg({ useAria2c: false }), true)).toBe("native");
    expect(resolveDownloaderEngine(cfg({ useAria2c: false }), false)).toBe("native");
  });
});

describe("buildAria2cArgs", () => {
  test("defaults to 16 connections and omits the split size (yt-dlp already uses 1M)", () => {
    expect(buildAria2cArgs(cfg())).toBe("-x 16 -s 16 -j 16");
  });

  test("honours a custom connection count", () => {
    expect(buildAria2cArgs(cfg({ connectionsPerDownload: 8 }))).toBe("-x 8 -s 8 -j 8");
    expect(buildAria2cArgs(cfg({ connectionsPerDownload: 1 }))).toBe("-x 1 -s 1 -j 1");
  });

  test("adds --min-split-size only when it differs from yt-dlp's default", () => {
    expect(buildAria2cArgs(cfg({ minSplitSize: "1M" }))).not.toContain("--min-split-size");
    expect(buildAria2cArgs(cfg({ minSplitSize: "4M" }))).toBe("-x 16 -s 16 -j 16 --min-split-size 4M");
  });

  test("clamps nonsensical values", () => {
    expect(buildAria2cArgs(cfg({ connectionsPerDownload: 0 }))).toBe("-x 1 -s 1 -j 1");
    expect(buildAria2cArgs(cfg({ connectionsPerDownload: -5 }))).toBe("-x 1 -s 1 -j 1");
  });

  test("clamps -x to aria2c's hard cap of 16 while -s/-j keep the setting", () => {
    // aria2c's own help: -x "Possible Values: 1-16". An unclamped value makes
    // it exit 28 before transferring a byte — every download in the batch.
    expect(buildAria2cArgs(cfg({ connectionsPerDownload: 64 }))).toBe("-x 16 -s 64 -j 64");
    expect(buildAria2cArgs(cfg({ connectionsPerDownload: 17 }))).toBe("-x 16 -s 17 -j 17");
    expect(buildAria2cArgs(cfg({ connectionsPerDownload: 16 }))).toBe("-x 16 -s 16 -j 16");
  });
});

describe("computePerWorkerLimitBytesPerSec", () => {
  test("null when no cap is configured", () => {
    expect(computePerWorkerLimitBytesPerSec(cfg({ maxBandwidthKBps: 0 }), 3)).toBeNull();
  });

  test("splits the cap across active slots and returns bytes per second", () => {
    expect(computePerWorkerLimitBytesPerSec(cfg({ maxBandwidthKBps: 3000 }), 3)).toBe(1_024_000);
    expect(computePerWorkerLimitBytesPerSec(cfg({ maxBandwidthKBps: 3000 }), 1)).toBe(3_072_000);
  });

  test("honours small caps rather than flooring each worker to 64 KB/s", () => {
    expect(computePerWorkerLimitBytesPerSec(cfg({ maxBandwidthKBps: 100 }), 10)).toBe(10_240);
    expect(computePerWorkerLimitBytesPerSec(cfg({ maxBandwidthKBps: 1 }), 20)).toBe(51);
  });

  test("never divides by zero", () => {
    expect(computePerWorkerLimitBytesPerSec(cfg({ maxBandwidthKBps: 500 }), 0)).toBe(512_000);
  });
});

describe("jobBaseFilename", () => {
  test("zero-pads the index and sanitizes the title", () => {
    expect(jobBaseFilename({ index: 3, title: "My/Video:Name", id: "x" })).toBe("003 - My Video Name");
    expect(jobBaseFilename({ index: 42, title: "Long", id: "x" })).toBe("042 - Long");
  });
});

describe("buildDownloadPlan", () => {
  const build = (over: Partial<Config> = {}, aria2cAvailable = true, activeSlots = 3) =>
    buildDownloadPlan({ job, config: cfg(over), activeSlots, aria2cAvailable });

  test("uses aria2c with unquoted downloader args when available", () => {
    const plan = build({ connectionsPerDownload: 12 });
    expect(plan.engine).toBe("aria2c");
    expect(flagValue(plan.args, "--downloader")).toBe("aria2c");
    // One argv element: yt-dlp shlex-splits the text after "aria2c:". Inner
    // quotes are a Windows regression — they survive argv, the whole list
    // becomes one token, and aria2c rejects `-x` with exit 28 before
    // transferring a byte (the BAD_DOWNLOADER_ARGS engine pause).
    expect(flagValue(plan.args, "--downloader-args")).toBe("aria2c:-x 12 -s 12 -j 12");
    expect(flagValue(plan.args, "--downloader-args")).not.toContain('"');
    // argv[0] is the yt-dlp path, added by the worker — not part of the plan.
    expect(plan.args[0]).toBe(job.url);
  });

  test("hands yt-dlp the resolved aria2c binary instead of a bare name", () => {
    // Discovery may find aria2c next to the app or in a winget/scoop shim that
    // is not on the child's PATH; yt-dlp must not have to find it again.
    const plan = buildDownloadPlan({
      job,
      config: cfg(),
      activeSlots: 3,
      aria2cAvailable: true,
      aria2cBinary: join("C:\\tools", "aria2c.exe"),
    });
    expect(flagValue(plan.args, "--downloader")).toBe(join("C:\\tools", "aria2c.exe"));
    // The downloader args are unchanged — only the binary reference differs.
    expect(flagValue(plan.args, "--downloader-args")).toBe("aria2c:-x 16 -s 16 -j 16");
  });

  test("falls back to the bare name when no binary was resolved", () => {
    const plan = buildDownloadPlan({
      job,
      config: cfg(),
      activeSlots: 3,
      aria2cAvailable: true,
      aria2cBinary: null,
    });
    expect(flagValue(plan.args, "--downloader")).toBe("aria2c");
  });

  test("omits downloader flags on the native path", () => {
    const plan = build({}, false);
    expect(plan.engine).toBe("native");
    expect(plan.args).not.toContain("--downloader");
    expect(plan.args).not.toContain("--downloader-args");
  });

  test("always passes the core resilient flags", () => {
    const plan = build();
    for (const f of ["--continue", "--no-overwrites", "--newline", "--no-colors", "--no-simulate"]) {
      expect(plan.args).toContain(f);
    }
    expect(flagValue(plan.args, "--progress-template")).toContain("PROGRESS:");
    expect(flagValue(plan.args, "--print")).toBe("after_move:FILEPATH:%(filepath)s");
  });

  test("applies the bandwidth cap per slot as an exact byte rate", () => {
    const plan = build({ maxBandwidthKBps: 3000 }, true, 3);
    expect(plan.perWorkerLimitBytesPerSec).toBe(1_024_000);
    expect(flagValue(plan.args, "--limit-rate")).toBe("1024000");
  });

  test("small bandwidth caps stay below 64 KB/s per slot", () => {
    const plan = build({ maxBandwidthKBps: 100 }, true, 10);
    expect(plan.perWorkerLimitBytesPerSec).toBe(10_240);
    expect(flagValue(plan.args, "--limit-rate")).toBe("10240");
  });

  test("omits --limit-rate when uncapped", () => {
    const plan = build({ maxBandwidthKBps: 0 });
    expect(plan.perWorkerLimitBytesPerSec).toBeNull();
    expect(plan.args).not.toContain("--limit-rate");
  });

  test("passes fragment and retry tuning", () => {
    const plan = build({ concurrentFragments: 6, fragmentRetries: 20 });
    expect(flagValue(plan.args, "--concurrent-fragments")).toBe("6");
    expect(flagValue(plan.args, "--fragment-retries")).toBe("20");
  });

  test("adds chunk size and buffer size only when configured", () => {
    expect(build().args).not.toContain("--http-chunk-size");
    expect(build().args).not.toContain("--buffer-size");
    const plan = build({ httpChunkSize: "10M", bufferSize: "16K" });
    expect(flagValue(plan.args, "--http-chunk-size")).toBe("10M");
    expect(flagValue(plan.args, "--buffer-size")).toBe("16K");
  });

  test("adds a configured User-Agent as a single argv value", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36";
    expect(build().args).not.toContain("--user-agent");
    const plan = build({ userAgent: ua });
    expect(flagValue(plan.args, "--user-agent")).toBe(ua);
  });

  test("maximum-speed preset creates the intended uncapped native invocation", () => {
    const plan = build(DOWNLOAD_SPEED_PROFILES.maximum.values, false);
    expect(plan.engine).toBe("native");
    expect(flagValue(plan.args, "--concurrent-fragments")).toBe("32");
    expect(flagValue(plan.args, "--http-chunk-size")).toBe("10M");
    expect(flagValue(plan.args, "--buffer-size")).toBe("16K");
    expect(flagValue(plan.args, "--user-agent")).toBe(DOWNLOAD_SPEED_PROFILES.maximum.values.userAgent);
    expect(plan.args).not.toContain("--limit-rate");
  });

  test("aggressive IDM speed preset creates the intended multi-connection and fragment invocation", () => {
    const planNative = build(DOWNLOAD_SPEED_PROFILES.aggressive.values, false);
    expect(planNative.engine).toBe("native");
    expect(flagValue(planNative.args, "--concurrent-fragments")).toBe("64");
    expect(flagValue(planNative.args, "--http-chunk-size")).toBe("10M");
    expect(flagValue(planNative.args, "--buffer-size")).toBe("64K");
    expect(flagValue(planNative.args, "--user-agent")).toBe(DOWNLOAD_SPEED_PROFILES.aggressive.values.userAgent);
    expect(planNative.args).not.toContain("--limit-rate");

    const planAria2 = build(DOWNLOAD_SPEED_PROFILES.aggressive.values, true);
    expect(planAria2.engine).toBe("aria2c");
    expect(planAria2.args).toContain("--downloader-args");
    expect(flagValue(planAria2.args, "--downloader-args")).toBe("aria2c:-x 16 -s 32 -j 32 --min-split-size 512K");
  });

  test("adds the download archive and live filter only when enabled", () => {
    expect(flagValue(build().args, "--download-archive")).toBe(DEFAULT_CONFIG.archiveFile);
    expect(build().args).not.toContain("--match-filters");
    const live = build({ archiveFile: "", archiveLiveStreams: true });
    expect(live.args).not.toContain("--download-archive");
    expect(flagValue(live.args, "--match-filters")).toBe("!is_live");
  });

  test("embeds metadata only when enabled", () => {
    expect(build().args).toContain("--embed-thumbnail");
    expect(build({ embedMetadata: false }).args).not.toContain("--embed-thumbnail");
  });

  test("uses the format selector for the configured quality", () => {
    expect(flagValue(build({ videoQuality: "720p" }).args, "--format")).toBe("bv[height<=720]+ba/b[height<=720]");
    expect(flagValue(build({ videoQuality: "audio" }).args, "--format")).toBe("ba/bestaudio");
  });

  test("per-job quality and container overrides take precedence over global settings", () => {
    const highQuality = buildDownloadPlan({
      job: { ...job, target_format: "mkv", video_quality: "4k" },
      config: cfg({ videoQuality: "480p", targetFormat: "mp4" }),
      activeSlots: 2,
      aria2cAvailable: false,
    });
    expect(flagValue(highQuality.args, "--format")).toBe("bv[height<=2160]+ba/b[height<=2160]");
    expect(flagValue(highQuality.args, "--merge-output-format")).toBe("mkv");

    const audioOnly = buildDownloadPlan({
      job: { ...job, target_format: "mp3", video_quality: "audio" },
      config: cfg({ videoQuality: "1080p", targetFormat: "mp4" }),
      activeSlots: 1,
      aria2cAvailable: false,
      audioTracks: [{ formatId: "251-0", language: "en", label: "English", tbr: 160, acodec: "opus", isDefault: true }],
    });
    expect(flagValue(audioOnly.args, "--format")).toBe("ba/bestaudio");
    expect(audioOnly.args).not.toContain("--audio-multistreams");
    expect(audioOnly.args).not.toContain("--merge-output-format");
  });

  test("scales the watchdog with the video duration", () => {
    // The fixture is a 10-minute video: 3×600s + 300s = 35 min, inside the window
    expect(build().timeoutMs).toBe(35 * 60_000);
    // A 20-minute video: 3×1200 + 300 = 65 min — still scaling with duration
    const twenty = buildDownloadPlan({
      job: { ...job, duration: 1200 },
      config: cfg(),
      activeSlots: 3,
      aria2cAvailable: true,
    });
    expect(twenty.timeoutMs).toBe(65 * 60_000);
    const long = buildDownloadPlan({
      job: { ...job, duration: 7200 },
      config: cfg(),
      activeSlots: 3,
      aria2cAvailable: true,
    });
    expect(long.timeoutMs).toBe(180 * 60_000);
    // Unknown duration → the configured minimum
    const unknown = buildDownloadPlan({
      job: { ...job, duration: null },
      config: cfg(),
      activeSlots: 3,
      aria2cAvailable: true,
    });
    expect(unknown.timeoutMs).toBe(15 * 60_000);
  });

  test("writes to the output template derived from the sanitized base name", () => {
    const plan = build();
    expect(plan.baseFilename).toBe("007 - Some Video");
    // join() so the expectation holds on Windows separators too.
    expect(plan.outTemplate).toBe(join(job.output_directory, "007 - Some Video.%(ext)s"));
  });

  test("keeps every argv entry free of newlines (spawn safety)", () => {
    const plan = build({ minSplitSize: "2M" }, true, 4);
    for (const a of plan.args) {
      expect(a).not.toContain("\n");
      expect(a).not.toContain("\r");
    }
  });

  test("omits JS-runtime flags unless a runtime was injected", () => {
    expect(build().args).not.toContain("--js-runtimes");
    expect(build().args).not.toContain("--remote-components");
  });

  test("passes an explicit JS runtime path so yt-dlp does not have to rediscover it", () => {
    const plan = buildDownloadPlan({
      job,
      config: cfg(),
      activeSlots: 3,
      aria2cAvailable: false,
      jsRuntime: { name: "deno", path: join("/opt", "deno") },
    });
    expect(flagValue(plan.args, "--js-runtimes")).toBe(`deno:${join("/opt", "deno")}`);
    expect(flagValue(plan.args, "--remote-components")).toBe("ejs:github");
  });
});

// --- multi-audio tracks -------------------------------------------------------
// YouTube's multi-language audio: selected tracks arrive from the worker and
// must splice into the format selector plus switch yt-dlp into multistream
// MKV mode. A single track is a classic download; the audio-only preset is
// exempt (an mp3 cannot carry several tracks).
describe("buildDownloadPlan with audio tracks", () => {
  const build = (over: Partial<Config> = {}) =>
    buildDownloadPlan({ job, config: cfg(over), activeSlots: 3, aria2cAvailable: true });
  const tracks = [
    { formatId: "251-0", language: "en", label: "English", tbr: 160, acodec: "opus", isDefault: true },
    { formatId: "251-1", language: "es", label: "Spanish", tbr: 150, acodec: "opus", isDefault: false },
  ];
  const buildWithTracks = (over: Partial<Config> = {}) =>
    buildDownloadPlan({ job, config: cfg(over), activeSlots: 3, aria2cAvailable: true, audioTracks: tracks });

  test("splices the track ids into the quality preset", () => {
    expect(flagValue(buildWithTracks({ videoQuality: "1080p" }).args, "--format")).toBe(
      "bv[height<=1080]+251-0+251-1/b[height<=1080]",
    );
  });

  test("enables audio multistreams and the MKV container for 2+ tracks", () => {
    const plan = buildWithTracks();
    expect(plan.args).toContain("--audio-multistreams");
    expect(flagValue(plan.args, "--merge-output-format")).toBe("mkv");
  });

  test("a single selected track pins exactly that track, without multistreams", () => {
    const plan = buildDownloadPlan({
      job,
      config: cfg(),
      activeSlots: 3,
      aria2cAvailable: true,
      audioTracks: [tracks[0]],
    });
    expect(flagValue(plan.args, "--format")).toBe("bv[height<=1080]+251-0/b[height<=1080]");
    expect(plan.args).not.toContain("--audio-multistreams");
    expect(plan.args).not.toContain("--merge-output-format");
  });

  test("no tracks means the untouched preset", () => {
    expect(flagValue(build().args, "--format")).toBe("bv[height<=1080]+ba/b[height<=1080]");
    expect(build().args).not.toContain("--audio-multistreams");
  });

  test("the audio-only preset ignores tracks (mp3 has one stream)", () => {
    const plan = buildWithTracks({ videoQuality: "audio" });
    expect(flagValue(plan.args, "--format")).toBe("ba/bestaudio");
    expect(plan.args).not.toContain("--audio-multistreams");
  });

  test("multistream flags survive alongside the aria2c downloader args", () => {
    const plan = buildWithTracks({ useAria2c: true });
    expect(flagValue(plan.args, "--downloader")).toBe("aria2c");
    expect(plan.args).toContain("--audio-multistreams");
  });
});
