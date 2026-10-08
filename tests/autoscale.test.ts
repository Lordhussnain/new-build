// tests/autoscale.test.ts — autoscaler slot growth.
//
// The autoscaler owns how many download workers may claim work at once, which
// in turn drives the per-slot bandwidth split. These tests cover the ramp
// behaviour: how fast slots grow under backlog pressure, that they never
// overshoot the backlog or the worker ceiling, and that an idle queue collapses
// to the floor.
//
// autoscaleTick() reads the LIVE config on every tick, because the dashboard's
// settings panel must be able to change the ramp step, the worker floor and the
// autoscale toggle without a restart. So these tests drive it the way the
// dashboard does — through setConfig — and `autoscaler.poolSize` stands in for
// the number of worker processes the supervisor started.

import { describe, expect, test, beforeEach } from "bun:test";
import { autoscaler, activeDlSlots, autoscaleTick } from "../src/autoscale";
import { db, initDatabase } from "../src/db";
import { setConfig } from "../src/state";
import { DEFAULT_CONFIG } from "../src/config";

// The tick reads the live config, so every test starts from this baseline and
// overrides only the key under test. Merging with DEFAULT_CONFIG alone would
// silently reset `maxDownloadWorkers` to its default (5) and cap the ramp.
const CONFIG_BASE = {
  autoscaleEnabled: true,
  minDownloadWorkers: 1,
  maxDownloadWorkers: 20,
  maxConcurrentDownloads: 20,
  maxBandwidthKBps: 0, // uncapped → the bandwidth guard never interferes
};

function configWith(overrides: Record<string, unknown> = {}) {
  setConfig({ ...DEFAULT_CONFIG, ...CONFIG_BASE, ...overrides } as any);
}

beforeEach(() => {
  initDatabase(":memory:");
  configWith();
  autoscaler.enabled = true;
  autoscaler.initialWorkers = 20;
  autoscaler.minWorkers = 1;
  autoscaler.maxWorkers = 20;
  autoscaler.maxBandwidthKBps = 0;
  autoscaler.workerSpeeds.clear();
  autoscaler.rampStep = 2;
  // The supervised pool: slots can never exceed it, no matter what the live
  // config says (a raised maxDownloadWorkers applies after a restart).
  autoscaler.poolSize = 20;
  activeDlSlots.clear();
});

/** Seed `n` pending download jobs so the autoscaler sees a backlog. */
function seedBacklog(n: number): void {
  const stmt = db.prepare(
    `INSERT INTO jobs (id, url, title, "index", folder, output_directory, download_status)
     VALUES (?, ?, ?, ?, 'Mock Playlist', '/tmp', 'pending')`,
  );
  for (let i = 0; i < n; i++) stmt.run(`seed${i}`, `https://example.test/${i}`, `Video ${i}`, i);
}

describe("autoscaleTick", () => {
  test("grows by the configured ramp step while there is backlog", () => {
    seedBacklog(20);
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(3); // 1 + rampStep(2)
  });

  test("honours a ramp step of 1 (the original slow ramp)", () => {
    seedBacklog(20);
    configWith({ autoscaleRampStep: 1 });
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(2);
  });

  test("a ramp step saved from the dashboard applies on the next tick", () => {
    seedBacklog(20);
    activeDlSlots.add(1);
    // Settings panel → POST /api/settings → setConfig, and one tick later the
    // new ramp step is in force: no restart, no field poking.
    configWith({ autoscaleRampStep: 4 });
    autoscaleTick();
    expect(activeDlSlots.size).toBe(5); // 1 + the freshly saved step
    configWith({ autoscaleRampStep: 3 });
    autoscaleTick();
    expect(activeDlSlots.size).toBe(8);
  });

  test("honours a larger ramp step", () => {
    seedBacklog(20);
    configWith({ autoscaleRampStep: 5 });
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(6);
  });

  test("maxConcurrentDownloads is a starting point, not the autoscaler ceiling", () => {
    seedBacklog(20);
    configWith({ maxConcurrentDownloads: 4 });
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(6); // reset to 4, then ramp toward maxDownloadWorkers
    expect(activeDlSlots.size).toBeGreaterThan(4);
  });

  test("applies a changed autoscaler floor and lowered ceiling on the next tick", () => {
    seedBacklog(20);
    configWith({ minDownloadWorkers: 4, maxDownloadWorkers: 6, maxBandwidthKBps: 1000 });
    autoscaler.poolSize = 20;
    autoscaler.workerSpeeds.set(1, 1_000_000); // cap is saturated; no growth above the floor
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(4);

    configWith({ minDownloadWorkers: 1, maxDownloadWorkers: 2, maxBandwidthKBps: 0 });
    autoscaleTick();
    expect(activeDlSlots.size).toBe(2); // live ceiling clamps the active count
  });

  test("never grows past the backlog", () => {
    seedBacklog(3);
    configWith({ autoscaleRampStep: 10 });
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(3); // min(1+10, backlog 3, max 20)
  });

  test("never grows past the worker ceiling", () => {
    seedBacklog(20);
    configWith({ autoscaleRampStep: 10, maxDownloadWorkers: 4 });
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(4);
  });

  test("the ceiling is clamped to the supervised pool, so a raise needs a restart", () => {
    seedBacklog(20);
    // The dashboard can save maxDownloadWorkers 12, but only 6 worker
    // processes exist in this run: the extra slots would have nobody to claim.
    autoscaler.poolSize = 6;
    configWith({ autoscaleRampStep: 10, maxDownloadWorkers: 12, minDownloadWorkers: 1 });
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(6);
    autoscaler.poolSize = 20;
  });

  test("collapses to the floor when the queue is empty", () => {
    seedBacklog(0);
    activeDlSlots.add(1);
    activeDlSlots.add(2);
    activeDlSlots.add(3);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(1); // minWorkers
  });

  test("does not grow when the bandwidth cap is saturated", () => {
    seedBacklog(20);
    configWith({ maxBandwidthKBps: 1000 }); // capBps = 1,024,000
    // Register three workers reporting a combined 95% of the cap.
    autoscaler.workerSpeeds.set(1, 350_000);
    autoscaler.workerSpeeds.set(2, 350_000);
    autoscaler.workerSpeeds.set(3, 273_000);
    activeDlSlots.add(1);
    activeDlSlots.add(2);
    activeDlSlots.add(3);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(2); // sheds one slot
  });

  test("stays pinned to maxConcurrentDownloads when autoscaling is disabled", () => {
    seedBacklog(20);
    configWith({ autoscaleEnabled: false, maxConcurrentDownloads: 6, maxDownloadWorkers: 20 });
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(6);
  });
});
