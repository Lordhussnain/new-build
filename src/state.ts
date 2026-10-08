// src/state.ts — mutable runtime state shared across the engine.
//
// This is a shared leaf module (it imports config defaults/types only) so
// workers and recovery code can coordinate state without creating cycles. ESM
// exports are read-only bindings, so mutations go through setters below.

import { DEFAULT_CONFIG, type Config } from "./config";

export interface Stats {
  downloaded: number;
  skipped: number;
  failed: number;
  /**
   * Terminal skips: videos that can never be downloaded (private, deleted,
   * members-only, region-locked, no usable formats). A subset of `failed` —
   * they are counted there too because they were not archived — but kept
   * separate so the run report can distinguish "this video does not exist any
   * more" from "this video failed and may still recover".
   */
  unavailable: number;
  /** Downloads whose selector was stepped down the quality ladder. */
  formatFallbacks: number;
  totalQueued: number;
  metadata: number;
  converted: number;
}

export const stats: Stats = {
  downloaded: 0,
  skipped: 0,
  failed: 0,
  unavailable: 0,
  formatFallbacks: 0,
  totalQueued: 0,
  metadata: 0,
  converted: 0,
};

export const workerStatuses = new Map<string, string>();

// Child processes, so a pause/shutdown can interrupt in-flight work.
export const activeProcs = new Map<number, Bun.Subprocess>();
// Logical download claims held through probing, child execution, and result handling.
export const activeDownloadJobs = new Map<number, string>();
// Conversion and metadata stages register their child processes the same way,
// keyed by worker id. The job maps (worker id → job id) are what let the
// dashboard's Stop / Delete / Purge actions find the process that belongs to a
// job and interrupt it — without them a deleted job's yt-dlp/ffmpeg keeps
// running in the terminal and finishes into a file nobody tracks.
export const activeConvertProcs = new Map<number, Bun.Subprocess>();
export const activeConvertJobs = new Map<number, string>();
export const activeMetadataProcs = new Map<number, Bun.Subprocess>();
export const activeMetadataJobs = new Map<number, string>();

export const abortController = new AbortController();
export const startTime = Date.now();

// Jobs the dashboard has deleted while they were still in flight. A worker
// that has not spawned its downloader yet (it may be waiting on the multi-audio
// probe, a network round-trip) must treat this as "do not start": the row it
// was about to write into may already be gone, and the old behaviour left a
// yt-dlp running in the terminal for a job nobody tracks any more.
//
// Marks are short-lived and cleared the moment a fresh claim is minted for the
// same video id, so re-adding a removed source later is never blocked by a
// stale entry from a previous life of that video.
const cancelledJobs = new Map<string, number>();
const CANCEL_MARK_TTL_MS = 10 * 60_000;
export function markJobCancelled(id: string, ttlMs: number = CANCEL_MARK_TTL_MS): void {
  cancelledJobs.set(id, Date.now() + ttlMs);
}
export function isJobCancelled(id: string): boolean {
  const expiresAt = cancelledJobs.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt < Date.now()) {
    cancelledJobs.delete(id);
    return false;
  }
  return true;
}
export function clearJobCancelled(id: string): void {
  cancelledJobs.delete(id);
}

let globalIsPaused = false;
let pauseReason: string | null = null;
let isTTY = process.stdout.isTTY;
let globalConfig: Config = { ...DEFAULT_CONFIG };

export function isPaused(): boolean {
  return globalIsPaused;
}
export function getPauseReason(): string | null {
  return pauseReason;
}
export function setPaused(value: boolean, reason: string | null = null): void {
  globalIsPaused = value;
  pauseReason = reason;
}
export function isTty(): boolean {
  return isTTY;
}
export function setTty(value: boolean): void {
  isTTY = value;
}
export function getConfig(): Config {
  return globalConfig;
}
export function setConfig(config: Config): void {
  globalConfig = config;
}
