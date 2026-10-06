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
  totalQueued: number;
  metadata: number;
  converted: number;
}

export const stats: Stats = {
  downloaded: 0,
  skipped: 0,
  failed: 0,
  totalQueued: 0,
  metadata: 0,
  converted: 0,
};

export const workerStatuses = new Map<string, string>();

// Child processes, so a pause/shutdown can interrupt in-flight work.
export const activeProcs = new Map<number, Bun.Subprocess>();
// Logical download claims held through probing, child execution, and result handling.
export const activeDownloadJobs = new Map<number, string>();
export const activeMetadataProcs = new Map<number, Bun.Subprocess>();

export const abortController = new AbortController();
export const startTime = Date.now();

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
