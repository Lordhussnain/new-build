// src/download-stall.ts — progress-based stall detection for one attempt.
//
// yt-dlp can download a large video followed by one or more much smaller audio
// files in the same process. Their counters start over, so a single high-water
// mark for the whole attempt would mistake a moving audio stream for a stall.
// aria2c's human-readable counters are rounded and may not change for minutes
// on a slow connection even though its current DL rate is positive.

/** Bound a rate-only grace period: a stale/incorrect rate must not hang forever. */
export const MAX_QUANTIZED_PROGRESS_GRACE_MS = 15 * 60_000;
const SPEED_SAMPLE_FRESH_MS = 30_000;
const MAX_TRACKED_STREAMS = 256;
const OVERFLOW_STREAM = "\u0000overflow";

interface StreamProgress {
  highWater: number | null;
  speedBps: number;
  resolutionBytes: number;
  sampledAt: number;
}

export interface StallProgressSample {
  /** Includes the download phase and native format id or aria2c group id. */
  stream: string;
  /** A reported byte counter, or null when it is unavailable. */
  downloadedBytes: number | null;
  /** aria2c's current rate and counter resolution; absent for exact counters. */
  speedBps?: number;
  resolutionBytes?: number;
}

export class DownloadStallTracker {
  private lastProgressAt: number;
  private readonly streams = new Map<string, StreamProgress>();

  constructor(now = Date.now()) {
    this.lastProgressAt = now;
  }

  /** Record progress without letting alternating unchanged counters look active. */
  observe(sample: StallProgressSample, now = Date.now()): void {
    // A badly behaved subprocess cannot cause unbounded memory growth by
    // printing arbitrary group IDs. Overflow streams share one high-water mark.
    const key = this.streams.has(sample.stream) || this.streams.size < MAX_TRACKED_STREAMS
      ? sample.stream
      : OVERFLOW_STREAM;
    let state = this.streams.get(key);
    if (!state) {
      state = { highWater: null, speedBps: 0, resolutionBytes: 0, sampledAt: now };
      this.streams.set(key, state);
    }

    const bytes = sample.downloadedBytes;
    if (bytes !== null && Number.isFinite(bytes) && bytes >= 0 &&
        (state.highWater === null || bytes > state.highWater)) {
      state.highWater = bytes;
      this.lastProgressAt = now;
    }
    state.speedBps = Number.isFinite(sample.speedBps) && sample.speedBps! > 0 ? sample.speedBps! : 0;
    state.resolutionBytes = Number.isFinite(sample.resolutionBytes) && sample.resolutionBytes! > 0
      ? sample.resolutionBytes!
      : 0;
    state.sampledAt = now;
  }

  /** Pauses and silent post-processing are deliberately not stall time. */
  resetClock(now = Date.now()): void {
    this.lastProgressAt = now;
  }

  idleMs(now = Date.now()): number {
    return Math.max(0, now - this.lastProgressAt);
  }

  isStalled(stallMs: number, now = Date.now()): boolean {
    const idle = this.idleMs(now);
    if (idle < stallMs) return false;

    for (const state of this.streams.values()) {
      const sampleAge = now - state.sampledAt;
      if (sampleAge < 0 || sampleAge > SPEED_SAMPLE_FRESH_MS ||
          state.speedBps <= 0 || state.resolutionBytes <= 0) continue;

      // At the reported rate a rounded counter may need up to one full
      // quantization step before it visibly grows. Allow twice that time plus
      // one sample interval, but cap the exception even if the rate keeps
      // claiming activity while the byte counter never advances.
      const expectedMs = 2 * state.resolutionBytes * 1000 / state.speedBps + SPEED_SAMPLE_FRESH_MS;
      const graceMs = Math.max(stallMs, Math.min(MAX_QUANTIZED_PROGRESS_GRACE_MS, expectedMs));
      if (idle < graceMs) return false;
    }
    return true;
  }
}
