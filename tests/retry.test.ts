// tests/retry.test.ts — retry policy: backoff, watchdogs, error classification.

import { describe, expect, test } from "bun:test";
import {
  computeBackoffMs,
  computeDownloadTimeoutMs,
  isDownloaderArgsError,
  isFormatAvailabilityError,
  isPermanentDownloadError,
  isTransientDownloadError,
  progressAwareRetryState,
} from "../src/retry";

describe("computeBackoffMs", () => {
  test("grows exponentially from the base", () => {
    const noJitter = () => 0;
    expect(computeBackoffMs(0, 30, 900, noJitter)).toBe(30_000);
    expect(computeBackoffMs(1, 30, 900, noJitter)).toBe(60_000);
    expect(computeBackoffMs(2, 30, 900, noJitter)).toBe(120_000);
    expect(computeBackoffMs(3, 30, 900, noJitter)).toBe(240_000);
  });

  test("is capped at maxSeconds", () => {
    const noJitter = () => 0;
    expect(computeBackoffMs(10, 30, 900, noJitter)).toBe(900_000);
    expect(computeBackoffMs(20, 30, 300, noJitter)).toBe(300_000);
  });

  test("jitter stays within +0..30% of the capped value", () => {
    for (const attempt of [0, 1, 2, 5]) {
      const base = computeBackoffMs(attempt, 10, 1000, () => 0);
      const maxJittered = computeBackoffMs(attempt, 10, 1000, () => 1);
      expect(maxJittered).toBeGreaterThanOrEqual(base);
      expect(maxJittered).toBeLessThanOrEqual(base * 1.3);
    }
  });

  test("is deterministic for an injected RNG", () => {
    expect(computeBackoffMs(2, 30, 900, () => 0.5)).toBe(computeBackoffMs(2, 30, 900, () => 0.5));
  });

  test("treats negative/NaN attempts as the first attempt", () => {
    const noJitter = () => 0;
    expect(computeBackoffMs(-5, 30, 900, noJitter)).toBe(30_000);
    expect(computeBackoffMs(NaN, 30, 900, noJitter)).toBe(30_000);
  });

  test("never returns a non-positive delay", () => {
    for (let i = 0; i < 50; i++) {
      expect(computeBackoffMs(i, 1, 5)).toBeGreaterThan(0);
    }
  });
});

describe("computeDownloadTimeoutMs", () => {
  const opts = { minMinutes: 15, maxMinutes: 180 };

  test("unknown duration → the configured minimum", () => {
    expect(computeDownloadTimeoutMs(null, opts)).toBe(15 * 60_000);
    expect(computeDownloadTimeoutMs(undefined, opts)).toBe(15 * 60_000);
    expect(computeDownloadTimeoutMs(0, opts)).toBe(15 * 60_000);
    expect(computeDownloadTimeoutMs(NaN, opts)).toBe(15 * 60_000);
  });

  test("short videos get the minimum, not less", () => {
    // 3×60s + 300s = 480s < 15 min → clamped up to the minimum
    expect(computeDownloadTimeoutMs(60, opts)).toBe(15 * 60_000);
  });

  test("long videos scale with duration", () => {
    // 3×3600 + 300 = 11100s = 185 min → clamped to the 180 min ceiling
    expect(computeDownloadTimeoutMs(3600, opts)).toBe(180 * 60_000);
    // 3×1800 + 300 = 5700s = 95 min → inside the range
    expect(computeDownloadTimeoutMs(1800, opts)).toBe(95 * 60_000);
  });

  test("a 2-hour video on a slow link is not killed at 15 minutes", () => {
    const twoHour = computeDownloadTimeoutMs(7200, { minMinutes: 15, maxMinutes: 240 });
    expect(twoHour).toBeGreaterThan(15 * 60_000);
  });
});

describe("isPermanentDownloadError", () => {
  test("flags unrecoverable errors", () => {
    expect(isPermanentDownloadError("ERROR: [youtube] abc: Video unavailable")).toBe(true);
    expect(isPermanentDownloadError("Private video. Sign in if you've been granted access")).toBe(true);
    expect(isPermanentDownloadError("ERROR: members-only content")).toBe(true);
    expect(isPermanentDownloadError("Sign in to confirm your age")).toBe(true);
    expect(isPermanentDownloadError("HTTP Error 404: Not Found")).toBe(true);
    expect(isPermanentDownloadError("This video has been removed by the uploader")).toBe(true);
    expect(isPermanentDownloadError("The uploader has not made this video available in your country")).toBe(true);
    expect(isPermanentDownloadError("This video is not available from your location")).toBe(true);
    expect(isPermanentDownloadError("This video is geo-restricted")).toBe(true);
    expect(isPermanentDownloadError("This video is age restricted")).toBe(true);
  });

  test("does not flag transient errors", () => {
    expect(isPermanentDownloadError("Unable to download webpage: Connection reset by peer")).toBe(false);
    expect(isPermanentDownloadError("HTTP Error 429: Too Many Requests")).toBe(false);
    expect(isPermanentDownloadError("The read operation timed out")).toBe(false);
    expect(isPermanentDownloadError(null)).toBe(false);
    expect(isPermanentDownloadError(undefined)).toBe(false);
    expect(isPermanentDownloadError("")).toBe(false);
  });
});

describe("progressAwareRetryState", () => {
  test("does not spend the retry budget when progress advances", () => {
    expect(progressAwareRetryState(2, 20, 35, 4)).toEqual({
      retryCount: 2,
      bestProgress: 35,
      madeProgress: true,
      exhausted: false,
    });
  });

  test("spends one retry when there is no forward progress", () => {
    expect(progressAwareRetryState(2, 35, 35, 3)).toEqual({
      retryCount: 3,
      bestProgress: 35,
      madeProgress: false,
      exhausted: true,
    });
  });

  test("treats a lower resumed percentage as no forward progress", () => {
    const state = progressAwareRetryState(0, 35, 20, 3);
    expect(state.retryCount).toBe(1);
    expect(state.bestProgress).toBe(35);
    expect(state.madeProgress).toBe(false);
  });

  test("sanitizes invalid state, clamps percentages, and keeps the cap at least one", () => {
    expect(progressAwareRetryState(NaN, NaN, NaN, 0)).toEqual({
      retryCount: 1,
      bestProgress: 0,
      madeProgress: false,
      exhausted: true,
    });
    expect(progressAwareRetryState(0, 99, 150, 4)).toMatchObject({
      retryCount: 0,
      bestProgress: 100,
      madeProgress: true,
      exhausted: false,
    });
  });
});

describe("isTransientDownloadError", () => {
  test("flags network-ish failures", () => {
    expect(isTransientDownloadError("Unable to download webpage: Connection reset by peer")).toBe(true);
    expect(isTransientDownloadError("The read operation timed out")).toBe(true);
    expect(isTransientDownloadError("HTTP Error 429: Too Many Requests")).toBe(true);
    expect(isTransientDownloadError("HTTP Error 503: Service Unavailable")).toBe(true);
    expect(isTransientDownloadError("network is unreachable")).toBe(true);
  });

  test("does not flag permanent failures", () => {
    expect(isTransientDownloadError("Video unavailable")).toBe(false);
    expect(isTransientDownloadError("Private video")).toBe(false);
  });
});

describe("isDownloaderArgsError", () => {
  test("flags aria2c exit 28 and its option help block", () => {
    // The exact shape of the production failure: aria2c prints the offending
    // option's help, then yt-dlp reports the exit code.
    expect(
      isDownloaderArgsError(
        "Possible Values: 1-16\nDefault: 1\nTags: #basic, #http, #ftp ERROR: aria2c exited with code 28",
      ),
    ).toBe(true);
    expect(isDownloaderArgsError("ERROR: aria2c exited with code 28")).toBe(true);
    expect(isDownloaderArgsError("aria2c: unrecognized option '--splitt'")).toBe(true);
  });

  test("does not flag network, corrupt, or permanent failures", () => {
    expect(isDownloaderArgsError("Unable to download webpage: Connection reset by peer")).toBe(false);
    expect(isDownloaderArgsError("unable to resume download, incomplete or corrupt data")).toBe(false);
    expect(isDownloaderArgsError("This video is private")).toBe(false);
    expect(isDownloaderArgsError(null)).toBe(false);
  });
});

describe("isFormatAvailabilityError", () => {
  test("matches selector-level format errors", () => {
    expect(isFormatAvailabilityError("ERROR: Requested format is not available for use on this video")).toBe(true);
    expect(isFormatAvailabilityError("no matching formats found")).toBe(true);
    expect(isFormatAvailabilityError("Unable to find a video format matching the request")).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isFormatAvailabilityError("Connection reset by peer")).toBe(false);
    expect(isFormatAvailabilityError("Video unavailable. This video is private")).toBe(false);
    expect(isFormatAvailabilityError("")).toBe(false);
    expect(isFormatAvailabilityError(null)).toBe(false);
  });

  test("stale-format recovery must run before the permanent classification", () => {
    // Both classifiers match the same yt-dlp message; the download worker is
    // required to check isFormatAvailabilityError FIRST so a stale multi-audio
    // probe re-probes instead of parking the job permanently.
    const msg = "ERROR: Requested format is not available";
    expect(isFormatAvailabilityError(msg)).toBe(true);
    expect(isPermanentDownloadError(msg)).toBe(true);
  });
});
