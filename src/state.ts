// src/state.ts — mutable runtime state shared across the engine.
//
// This module deliberately depends on nothing but types: it is the leaf that
// every other module can import without creating cycles. ESM exports are
// read-only bindings, so mutations go through the setters below.

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
