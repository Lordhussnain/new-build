// tests/autoscale.test.ts — autoscaler slot growth.
//
// The autoscaler owns how many download workers may claim work at once, which
// in turn drives the per-slot bandwidth split. These tests cover the ramp
// behaviour: how fast slots grow under backlog pressure, that they never
// overshoot the backlog or the worker ceiling, and that an idle queue collapses
// to the floor.

import { describe, expect, test, beforeEach } from "bun:test";
import { autoscaler, activeDlSlots, autoscaleTick } from "../src/autoscale";
import { db, initDatabase } from "../src/db";
import { setConfig } from "../src/state";
import { DEFAULT_CONFIG } from "../src/config";

function configWith(overrides: Record<string, unknown> = {}) {
  setConfig({ ...DEFAULT_CONFIG, ...overrides } as any);
}

beforeEach(() => {
  initDatabase(":memory:");
  configWith({
    autoscaleEnabled: true,
    minDownloadWorkers: 1,
    maxDownloadWorkers: 20,
    maxConcurrentDownloads: 20,
    maxBandwidthKBps: 0, // uncapped → the bandwidth guard never interferes
  });
  autoscaler.enabled = true;
  autoscaler.minWorkers = 1;
  autoscaler.maxWorkers = 20;
  autoscaler.maxBandwidthKBps = 0;
  autoscaler.workerSpeeds.clear();
  autoscaler.rampStep = 2;
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
    autoscaler.rampStep = 1;
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(2);
  });

  test("honours a larger ramp step", () => {
    seedBacklog(20);
    autoscaler.rampStep = 5;
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(6);
  });

  test("never grows past the backlog", () => {
    seedBacklog(3);
    autoscaler.rampStep = 10;
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(3); // min(1+10, backlog 3, max 20)
  });

  test("never grows past the worker ceiling", () => {
    seedBacklog(20);
    autoscaler.rampStep = 10;
    autoscaler.maxWorkers = 4;
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(4);
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
    autoscaler.maxBandwidthKBps = 1000; // capBps = 1,024,000
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
    autoscaler.enabled = false; // autoscaler.init() copies the flag into this field
    activeDlSlots.add(1);
    autoscaleTick();
    expect(activeDlSlots.size).toBe(6);
    autoscaler.enabled = true;
  });
});
