import { describe, expect, test } from "bun:test";
import { DownloadStallTracker, MAX_QUANTIZED_PROGRESS_GRACE_MS } from "../src/download-stall";
import { parseAria2cReadout } from "../src/download-output";
import { isTransientDownloadError } from "../src/retry";

const STALL_MS = 180_000;

describe("download stall tracking", () => {
  test("a silent child still stalls at the deadline", () => {
    const tracker = new DownloadStallTracker(0);
    expect(tracker.isStalled(STALL_MS, STALL_MS - 1)).toBe(false);
    expect(tracker.isStalled(STALL_MS, STALL_MS)).toBe(true);
    expect(isTransientDownloadError("Download stalled — no reported byte progress for 180s; retrying with any available partial"))
      .toBe(true);
  });

  test("a smaller audio stream can keep progressing below the video's high-water mark", () => {
    const tracker = new DownloadStallTracker(0);
    tracker.observe({ stream: "native:1:video.f137", downloadedBytes: 900_000_000 }, 0);
    for (let i = 1; i <= 8; i++) {
      const now = i * 45_000;
      tracker.observe({ stream: "native:2:audio.f140", downloadedBytes: i * 1000 }, now);
      expect(tracker.isStalled(STALL_MS, now)).toBe(false);
      expect(tracker.idleMs(now)).toBe(0);
    }
    expect(tracker.isStalled(STALL_MS, 8 * 45_000 + STALL_MS)).toBe(true);
  });

  test("alternating unchanged streams and falling counters do not fake progress", () => {
    const tracker = new DownloadStallTracker(0);
    tracker.observe({ stream: "video", downloadedBytes: 100 }, 0);
    tracker.observe({ stream: "audio", downloadedBytes: 10 }, 0);
    for (let now = 20_000; now <= STALL_MS; now += 20_000) {
      tracker.observe({ stream: "video", downloadedBytes: 100 }, now);
      tracker.observe({ stream: "audio", downloadedBytes: now === 40_000 ? 1 : 10 }, now);
    }
    expect(tracker.idleMs(STALL_MS)).toBe(STALL_MS);
    expect(tracker.isStalled(STALL_MS, STALL_MS)).toBe(true);
  });

  test("a new destination generation can restart the same format or group id", () => {
    const tracker = new DownloadStallTracker(0);
    tracker.observe({ stream: "native:1:same-format", downloadedBytes: 100 }, 0);
    tracker.observe({ stream: "native:2:same-format", downloadedBytes: 1 }, 170_000);
    tracker.observe({ stream: "native:2:same-format", downloadedBytes: 2 }, 200_000);
    expect(tracker.idleMs(200_000)).toBe(0);
    expect(tracker.isStalled(STALL_MS, 200_000)).toBe(false);
  });

  test("slow aria2c rates get a bounded grace for a rounded byte counter", () => {
    const parsed = parseAria2cReadout("[#a1b2c3 1.0GiB/2.0GiB(50%) CN:4 DL:1KiB]")!;
    const tracker = new DownloadStallTracker(0);
    const sample = {
      stream: `aria:1:${parsed.groupId}`,
      downloadedBytes: parsed.downloadedBytes,
      speedBps: parsed.speedBps,
      resolutionBytes: parsed.downloadedResolutionBytes,
    };
    tracker.observe(sample, 0);
    tracker.observe(sample, STALL_MS);
    expect(tracker.isStalled(STALL_MS, STALL_MS)).toBe(false);
    tracker.observe(sample, MAX_QUANTIZED_PROGRESS_GRACE_MS - 1);
    expect(tracker.isStalled(STALL_MS, MAX_QUANTIZED_PROGRESS_GRACE_MS - 1)).toBe(false);
    tracker.observe(sample, MAX_QUANTIZED_PROGRESS_GRACE_MS);
    expect(tracker.isStalled(STALL_MS, MAX_QUANTIZED_PROGRESS_GRACE_MS)).toBe(true);
  });

  test("stale, zero, or implausibly high reported rates cannot keep a stuck transfer alive", () => {
    const rounded = { stream: "aria", downloadedBytes: 100, speedBps: 1, resolutionBytes: 1_000_000 };
    const stale = new DownloadStallTracker(0);
    stale.observe(rounded, 0);
    expect(stale.isStalled(STALL_MS, STALL_MS)).toBe(true);

    const zero = new DownloadStallTracker(0);
    zero.observe(rounded, 0);
    zero.observe({ ...rounded, speedBps: 0 }, STALL_MS);
    expect(zero.isStalled(STALL_MS, STALL_MS)).toBe(true);

    const fast = new DownloadStallTracker(0);
    fast.observe({ ...rounded, speedBps: 1_000_000 }, 0);
    fast.observe({ ...rounded, speedBps: 1_000_000 }, STALL_MS);
    expect(fast.isStalled(STALL_MS, STALL_MS)).toBe(true);
  });

  test("pause clock resets and invalid counters do not count as progress", () => {
    const tracker = new DownloadStallTracker(0);
    tracker.observe({ stream: "unknown", downloadedBytes: null }, 50_000);
    tracker.observe({ stream: "bad", downloadedBytes: NaN }, 80_000);
    tracker.observe({ stream: "bad", downloadedBytes: -1 }, 90_000);
    expect(tracker.isStalled(STALL_MS, STALL_MS)).toBe(true);
    tracker.resetClock(200_000);
    expect(tracker.isStalled(STALL_MS, 200_000 + STALL_MS - 1)).toBe(false);
    expect(tracker.isStalled(STALL_MS, 200_000 + STALL_MS)).toBe(true);
    expect(tracker.idleMs(199_000)).toBe(0);
  });

  test("many group ids are bounded without losing an existing stream's progress", () => {
    const tracker = new DownloadStallTracker(0);
    for (let i = 0; i < 300; i++) tracker.observe({ stream: `group-${i}`, downloadedBytes: 10 }, 0);
    tracker.observe({ stream: "group-0", downloadedBytes: 11 }, 170_000);
    expect(tracker.idleMs(170_000)).toBe(0);
    for (let i = 0; i < 300; i++) tracker.observe({ stream: `group-${i}`, downloadedBytes: i === 0 ? 11 : 10 }, 350_000);
    expect(tracker.isStalled(STALL_MS, 350_000)).toBe(true);
  });
});
