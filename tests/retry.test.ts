// tests/retry.test.ts — retry policy: backoff, watchdogs, error classification.

import { describe, expect, test } from "bun:test";
import {
  computeBackoffMs,
  computeDownloadTimeoutMs,
  isDownloaderArgsError,
  isPermanentDownloadError,
  isTransientDownloadError,
  shouldForgiveRetry,
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
    expect(isPermanentDownloadError("ERROR: [youtube] abc: Video unavailable. This video is private")).toBe(true);
    expect(isPermanentDownloadError("ERROR: members-only content")).toBe(true);
    expect(isPermanentDownloadError("Sign in to confirm your age")).toBe(true);
    expect(isPermanentDownloadError("HTTP Error 404: Not Found")).toBe(true);
    expect(isPermanentDownloadError("This video has been removed by the uploader")).toBe(true);
    expect(isPermanentDownloadError("The uploader has not made this video available in your country")).toBe(true);
  });

  test("flags the rest of YouTube's gone/gated vocabulary", () => {
    expect(isPermanentDownloadError("ERROR: [youtube] abc: This video is private")).toBe(true);
    expect(isPermanentDownloadError("This video has been deleted")).toBe(true);
    expect(isPermanentDownloadError("This video is no longer available")).toBe(true);
    expect(isPermanentDownloadError("removed for violating YouTube's Community Guidelines")).toBe(true);
    expect(isPermanentDownloadError("removed for violating YouTube's Terms of Service")).toBe(true);
    expect(isPermanentDownloadError("This video requires payment to watch")).toBe(true);
    expect(isPermanentDownloadError("This channel does not exist")).toBe(true);
  });

  test("does not flag transient errors", () => {
    expect(isPermanentDownloadError("Unable to download webpage: Connection reset by peer")).toBe(false);
    expect(isPermanentDownloadError("HTTP Error 429: Too Many Requests")).toBe(false);
    expect(isPermanentDownloadError("The read operation timed out")).toBe(false);
    expect(isPermanentDownloadError(null)).toBe(false);
    expect(isPermanentDownloadError(undefined)).toBe(false);
    expect(isPermanentDownloadError("")).toBe(false);
  });

  test("keeps credential-shaped errors retryable (cookies can rescue them)", () => {
    // Marking these permanent would break the cookies.txt mid-run rescue: the
    // failed-job sweep skips permanent errors, so fresh cookies could never
    // reach the videos they unblock.
    expect(isPermanentDownloadError("Sign in to confirm you're not a bot")).toBe(false);
    expect(isPermanentDownloadError("ERROR: login required")).toBe(false);
    expect(isPermanentDownloadError("HTTP Error 403: Forbidden")).toBe(false);
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

  test("flags aria2c's other option-validation failures", () => {
    expect(isDownloaderArgsError("aria2c: bad option '--splitt'")).toBe(true);
    expect(isDownloaderArgsError("aria2c: unknown option '--foo'")).toBe(true);
    expect(isDownloaderArgsError("Bad number 'banana' for -k")).toBe(true);
    expect(isDownloaderArgsError("unexpected option argument was given")).toBe(true);
  });

  test("does not flag network, corrupt, or permanent failures", () => {
    expect(isDownloaderArgsError("Unable to download webpage: Connection reset by peer")).toBe(false);
    expect(isDownloaderArgsError("unable to resume download, incomplete or corrupt data")).toBe(false);
    expect(isDownloaderArgsError("This video is private")).toBe(false);
    expect(isDownloaderArgsError(null)).toBe(false);
  });
});

describe("shouldForgiveRetry", () => {
  const base = { progress: 0, bestProgress: 0, bytes: 0, bestBytes: 0 };

  test("forgives when the percentage passed its claim-time best", () => {
    expect(shouldForgiveRetry({ ...base, progress: 42, bestProgress: 10 })).toBe(true);
  });

  test("forgives when the partial grew even though the percentage did not", () => {
    // Servers that hide the total never report a percentage — the partial
    // growing on disk is still proof of forward progress.
    expect(shouldForgiveRetry({ ...base, progress: 0, bestProgress: 0, bytes: 4096, bestBytes: 1024 })).toBe(true);
  });

  test("spends the budget when nothing moved", () => {
    expect(shouldForgiveRetry({ ...base, progress: 42, bestProgress: 42 })).toBe(false);
    expect(shouldForgiveRetry({ ...base, progress: 10, bestProgress: 42 })).toBe(false);
    expect(
      shouldForgiveRetry({ ...base, progress: 42, bestProgress: 42, bytes: 1024, bestBytes: 1024 }),
    ).toBe(false);
  });

  test("is NaN-safe (missing counters never forgive)", () => {
    expect(shouldForgiveRetry({ ...base, progress: NaN, bestProgress: NaN })).toBe(false);
    expect(shouldForgiveRetry({ ...base, bytes: NaN, bestBytes: NaN })).toBe(false);
  });
});
