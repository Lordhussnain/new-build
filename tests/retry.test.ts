// tests/retry.test.ts — retry policy: backoff, watchdogs, error classification.

import { describe, expect, test } from "bun:test";
import {
  classifyTerminalDownloadError,
  computeBackoffMs,
  computeDownloadTimeoutMs,
  FORMAT_FALLBACK_LADDER,
  formatSwitchMessage,
  formatTerminalErrorMessage,
  isDiskFullError,
  isDownloaderArgsError,
  isFormatAvailabilityError,
  isNChallengeError,
  isPermanentDownloadError,
  isSignatureChallengeError,
  isTerminalErrorMessage,
  isTransientDownloadError,
  isUnrecoverableResumeError,
  nextFormatFallback,
  parseStoredTerminalError,
  progressAwareRetryState,
  TERMINAL_ERROR_MARKER,
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

describe("isNChallengeError", () => {
  // Production stderr tail (last ~4 lines joined). The n-challenge traceback
  // is followed by "Requested format is not available" because missing formats
  // are a *symptom* of the unsolved player JS — that used to park the job as
  // a permanent failure.
  const productionTail =
    "input = NChallengeInput(player_url='https://www.youtube.com/s/player/1b3be681/player_ias.vflset/en_US/base.js', challenges=['Sp9r8zJeVzSHiW5cV']) " +
    "Please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U " +
    "WARNING: [youtube] QFrLzo7YLBA: n challenge solving failed: Some formats may be missing. Ensure you have a supported JavaScript runtime and challenge solver script " +
    "ERROR: [youtube] QFrLzo7YLBA: Requested format is not available";

  test("matches the production n-challenge + missing-formats tail", () => {
    expect(isNChallengeError(productionTail)).toBe(true);
    expect(isTransientDownloadError(productionTail)).toBe(true);
    expect(isFormatAvailabilityError(productionTail)).toBe(true);
    // The format-missing text must NOT win: this video is still downloadable
    // once a JS runtime / updated solver is in place.
    expect(isPermanentDownloadError(productionTail)).toBe(false);
  });

  test("matches the shorter warning-only form", () => {
    expect(
      isNChallengeError(
        "WARNING: [youtube] abc: n challenge solving failed: Some formats may be missing. Ensure you have a supported JavaScript runtime",
      ),
    ).toBe(true);
    expect(isPermanentDownloadError("No supported JavaScript runtime could be found")).toBe(false);
  });

  test("does not match unrelated errors", () => {
    expect(isNChallengeError("ERROR: [youtube] abc: Video unavailable")).toBe(false);
    expect(isNChallengeError("ERROR: Requested format is not available")).toBe(false);
    expect(isNChallengeError(null)).toBe(false);
  });
});

describe("isSignatureChallengeError", () => {
  test("matches signature/nsig decipher failures", () => {
    for (const message of [
      "ERROR: [youtube] abc: Signature extraction failed: Some formats may be missing",
      "WARNING: [youtube] abc: nsig extraction failed: Some formats may be missing",
      "ERROR: unable to extract signature function",
      "ERROR: failed to extract nsig",
      "ERROR: could not find the signature function",
    ]) {
      expect(isSignatureChallengeError(message)).toBe(true);
    }
  });

  test("does not classify generic extractor or n-challenge failures as signature updates", () => {
    expect(isSignatureChallengeError("Unable to extract webpage: Connection reset by peer")).toBe(false);
    expect(isSignatureChallengeError("n challenge solving failed")).toBe(false);
    expect(isSignatureChallengeError(null)).toBe(false);
  });
});

describe("isDiskFullError", () => {
  test("recognizes common POSIX and Windows storage exhaustion messages", () => {
    for (const message of [
      "[Errno 28] No space left on device",
      "write failed: ENOSPC",
      "There is not enough space on the disk",
      "Disk quota exceeded",
      "ERROR_DISK_FULL (WinError 112)",
    ]) {
      expect(isDiskFullError(message)).toBe(true);
      expect(isTransientDownloadError(message)).toBe(false);
    }
  });

  test("does not classify unrelated I/O errors as disk exhaustion", () => {
    expect(isDiskFullError("Permission denied while opening output file")).toBe(false);
    expect(isDiskFullError("Connection reset by peer")).toBe(false);
    expect(isDiskFullError(null)).toBe(false);
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
    expect(isTransientDownloadError("HTTP Error 408: Request Timeout")).toBe(true);
    expect(isTransientDownloadError("Too many requests; rate limit exceeded")).toBe(true);
    expect(isTransientDownloadError("Signature extraction failed")).toBe(true);
    expect(isTransientDownloadError("Download process aborted (SIGABRT)")).toBe(true);
  });

  test("does not flag permanent failures", () => {
    expect(isTransientDownloadError("Video unavailable")).toBe(false);
    expect(isTransientDownloadError("Private video")).toBe(false);
  });

  test("flags n-challenge / missing JS runtime as retryable", () => {
    expect(isTransientDownloadError("n challenge solving failed")).toBe(true);
    expect(isTransientDownloadError("Ensure you have a supported JavaScript runtime")).toBe(true);
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

describe("isUnrecoverableResumeError", () => {
  // The operator-visible failure this class exists for: a video stuck at 99.0%
  // because `--continue` keeps asking the CDN for a range the remote stream no
  // longer has. Retrying the same partial repeats it byte-for-byte forever.
  const YTDLP_416 =
    "ERROR: unable to download video data: HTTP Error 416: Requested range not satisfiable";

  test("matches yt-dlp's 416 range failure verbatim", () => {
    expect(isUnrecoverableResumeError(YTDLP_416)).toBe(true);
    // The same failure with aria2c's warning glued in front (what a real run
    // produces when thumbnail embedding already had to fall back to MKV).
    expect(
      isUnrecoverableResumeError(
        "WARNING: webm doesn't support embedding a thumbnail, mkv will be used " + YTDLP_416,
      ),
    ).toBe(true);
    expect(isUnrecoverableResumeError("HTTP Error 416: Requested Range Not Satisfiable")).toBe(true);
    expect(isUnrecoverableResumeError("DEBUG: downloading ... status code 416")).toBe(true);
  });

  test("matches aria2c refusing to reuse the saved state", () => {
    // --allow-overwrite=false default: nothing resumable AND no restart allowed.
    expect(
      isUnrecoverableResumeError(
        "File 003 - video.f137.mp4.part exists, but a control file(*.aria2) does not exist. " +
          "Download was canceled in order to prevent your file from being truncated to 0.",
      ),
    ).toBe(true);
  });

  test("does not match errors a resume can still fix", () => {
    expect(isUnrecoverableResumeError("ERROR: unable to download video data: <urlopen error timed out>")).toBe(false);
    expect(isUnrecoverableResumeError("ERROR: HTTP Error 503: Service Unavailable")).toBe(false);
    expect(isUnrecoverableResumeError("ERROR: unable to resume download, incomplete or corrupt data")).toBe(false);
    expect(isUnrecoverableResumeError("HTTP Error 416".slice(0, 0))).toBe(false);
    expect(isUnrecoverableResumeError("")).toBe(false);
    expect(isUnrecoverableResumeError(null)).toBe(false);
    expect(isUnrecoverableResumeError(undefined)).toBe(false);
    // "downloading is not supported by remote server": the data is fine, the
    // remedy is to keep --continue and hand the transfer to the native
    // downloader — discarding the partial there would throw away good work.
    expect(
      isUnrecoverableResumeError("cannot continue download: downloading is not supported by remote server"),
    ).toBe(false);
  });

  test("a 416 is about our partial, not about the video — never permanent", () => {
    // If the permanent class matched, the handler would park the job without
    // ever discarding the broken resume state.
    expect(isPermanentDownloadError(YTDLP_416)).toBe(false);
    expect(isTransientDownloadError(YTDLP_416)).toBe(true);
    expect(isDownloaderArgsError(YTDLP_416)).toBe(false);
    expect(isFormatAvailabilityError(YTDLP_416)).toBe(false);
  });
});

describe("permanent-classification gaps that used to loop forever", () => {
  // The wordings YouTube actually emits for videos that can never be
  // downloaded. Every one of these used to slip past the classifier, so the
  // job burned its retry budget, parked as `failed`, and the cooldown sweep
  // re-queued it again — an endless retry loop against a video that does not
  // exist any more (the "showing errors and retrying again" complaint).
  const terminalWordings = [
    "ERROR: [youtube] abc: This video is private",
    "ERROR: [youtube] abc: Video is private",
    "ERROR: [youtube] abc: This video is unavailable",
    "ERROR: [youtube] abc: Video is unavailable",
    "ERROR: [youtube] abc: This video is no longer available",
    "ERROR: [youtube] abc: This content is not available",
    "ERROR: [youtube] abc: This video has been deleted",
    "ERROR: [youtube] abc: This video requires payment to watch",
    "ERROR: [youtube] abc: This video is only available to Music Premium members",
  ];

  test("every wording is both permanent and labelled", () => {
    for (const wording of terminalWordings) {
      expect(isPermanentDownloadError(wording)).toBe(true);
      expect(classifyTerminalDownloadError(wording)).not.toBeNull();
    }
  });

  test("labels the reason an operator needs, most specific rule first", () => {
    expect(classifyTerminalDownloadError("ERROR: [youtube] abc: This video is private")!.code).toBe("private");
    expect(classifyTerminalDownloadError("ERROR: [youtube] abc: This video is unavailable")!.code).toBe(
      "unavailable",
    );
    expect(
      classifyTerminalDownloadError("ERROR: [youtube] abc: Sign in to confirm your age")!.code,
    ).toBe("age_restricted");
    expect(classifyTerminalDownloadError("ERROR: members-only content")!.code).toBe("members_only");
    expect(classifyTerminalDownloadError("ERROR: [youtube] abc: This video has been removed")!.code).toBe("removed");
    expect(classifyTerminalDownloadError("HTTP Error 404: Not Found")!.code).toBe("not_found");
    expect(classifyTerminalDownloadError("ERROR: [youtube] abc: No video formats found")!.code).toBe("no_formats");
    // A region lock also reads as "not available": geo must win, or the
    // operator would never think about cookies/VPN.
    expect(
      classifyTerminalDownloadError("The uploader has not made this video available in your country")!.code,
    ).toBe("geo_blocked");
    expect(classifyTerminalDownloadError("ERROR: Connection reset by peer")).toBeNull();
  });

  test("transient failures are never labelled terminal", () => {
    for (const wording of [
      "Unable to download webpage: Connection reset by peer",
      "HTTP Error 503: Service Unavailable",
      "The read operation timed out",
    ]) {
      expect(classifyTerminalDownloadError(wording)).toBeNull();
      expect(isPermanentDownloadError(wording)).toBe(false);
    }
  });
});

describe("terminal error records", () => {
  const privateMsg = "ERROR: [youtube] abc: This video is private";

  test("a stored terminal message stays permanent even if the tail is gone", () => {
    const stored = formatTerminalErrorMessage({ code: "private", label: "Private video" }, privateMsg);
    expect(isTerminalErrorMessage(stored)).toBe(true);
    expect(isPermanentDownloadError(stored)).toBe(true);
    // …and the marker survives a raw tail that matches nothing on its own.
    const bare = formatTerminalErrorMessage({ code: "other", label: "Video not downloadable" }, "weird failure");
    expect(isPermanentDownloadError(bare)).toBe(true);
  });

  test("the raw yt-dlp tail is kept for diagnosis", () => {
    const stored = formatTerminalErrorMessage({ code: "private", label: "Private video" }, privateMsg);
    expect(stored.startsWith(TERMINAL_ERROR_MARKER)).toBe(true);
    expect(stored).toContain("Private video");
    expect(stored).toContain("This video is private");
    expect(stored.length).toBeLessThanOrEqual(TERMINAL_ERROR_MARKER.length + 400);
  });

  test("label and detail round-trip for the report and the dashboard", () => {
    const stored = formatTerminalErrorMessage({ code: "private", label: "Private video" }, privateMsg);
    const parsed = parseStoredTerminalError(stored);
    expect(parsed).toEqual({ label: "Private video", detail: `skipped, it will not be retried automatically. yt-dlp: ${privateMsg}` });
    expect(parseStoredTerminalError(privateMsg)).toBeNull();
    expect(parseStoredTerminalError(null)).toBeNull();
  });

  test("a switch note is not mistaken for a dead video", () => {
    // The note is stored in `last_error` while the job is still pending. If it
    // read as a permanent error, a later cooldown sweep would refuse to
    // re-queue a perfectly healthy job.
    const note = formatSwitchMessage("1080p", "720p");
    expect(isPermanentDownloadError(note)).toBe(false);
    expect(isTerminalErrorMessage(note)).toBe(false);
    expect(classifyTerminalDownloadError(note)).toBeNull();
    expect(isFormatAvailabilityError(note)).toBe(false);
  });
});

describe("format fallback ladder", () => {
  test("steps down one preset at a time and ends at the permissive rung", () => {
    expect(nextFormatFallback("4k")).toBe("1440p");
    expect(nextFormatFallback("1440p")).toBe("1080p");
    expect(nextFormatFallback("1080p")).toBe("720p");
    expect(nextFormatFallback("720p")).toBe("480p");
    expect(nextFormatFallback("480p")).toBe("highest");
  });

  test("the ladder bottoms out instead of looping", () => {
    // `highest` is `bv+ba/b`: it accepts any stream the extractor found, so a
    // failure there means the video has no usable formats — the worker records
    // a terminal skip rather than retrying forever.
    expect(nextFormatFallback("highest")).toBeNull();
    // Every rung is strictly lower than the previous one: a job can descend
    // the ladder once and never oscillate, which is why stepping costs no
    // retry budget.
    const seen: string[] = [];
    let rung: string | null = FORMAT_FALLBACK_LADDER[0];
    while (rung) {
      seen.push(rung);
      rung = nextFormatFallback(rung);
    }
    expect(seen).toEqual([...FORMAT_FALLBACK_LADDER]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("audio-only and unknown presets have no video fallback", () => {
    // Falling back to a video preset would silently download a video stream
    // for an audio-only request.
    expect(nextFormatFallback("audio")).toBeNull();
    expect(nextFormatFallback("")).toBeNull();
    expect(nextFormatFallback(null)).toBeNull();
    expect(nextFormatFallback("240p")).toBeNull();
  });
});
