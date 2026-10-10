// src/autoscale.ts — dynamic download-slot autoscaling.
//
// Every download worker process that exists is supervised and alive, but only
// the ones whose id is in activeDlSlots may claim jobs. The autoscaler adds and
// removes slot ids. A slot removed mid-download lets its worker finish the
// current job, then park. Nothing is ever killed by a scale-down.
//
// The decision is made by nextSlotTarget(), a pure function, so the policy can
// be tested without a database, timers, or a process.

import { db } from "./db";
import { getConfig } from "./state";

/** Largest slot id the engine will ever use (the schema's maxDownloadWorkers). */
export const MAX_SLOT_ID = 20;

export const autoscaler = {
  enabled: true,
  targetWorkers: 3,
  /** Last configured initial/fixed slot count, used to apply live setting edits. */
  initialWorkers: 3,
  minWorkers: 1,
  maxWorkers: 5,
  /**
   * How many download worker processes exist. The engine keeps this equal to
   * the pool it has supervised and grows it live when the ceiling is raised
   * (see engine.ts growDownloadPool). The ceiling is always clamped to it, so
   * a slot never exists without a process to run it.
   */
  poolSize: 5,
  maxBandwidthKBps: 0,
  // Slots added per tick while a backlog exists (1 = the original slow ramp).
  rampStep: 2,
  /** Timestamp of the last bandwidth-driven scale-down, used for hysteresis. */
  lastScaleDownAt: 0,
  workerSpeeds: new Map<number, number>(),
  init(c: {
    autoscaleEnabled: boolean;
    minDownloadWorkers: number;
    maxDownloadWorkers: number;
    maxConcurrentDownloads: number;
    maxBandwidthKBps: number;
    autoscaleRampStep: number;
  }) {
    this.enabled = c.autoscaleEnabled;
    this.minWorkers = c.minDownloadWorkers;
    this.maxWorkers = c.maxDownloadWorkers;
    this.poolSize = c.maxDownloadWorkers;
    this.maxBandwidthKBps = c.maxBandwidthKBps;
    this.rampStep = Math.max(1, Math.floor(c.autoscaleRampStep));
    this.initialWorkers = c.maxConcurrentDownloads;
    this.targetWorkers = Math.max(this.minWorkers, Math.min(c.maxConcurrentDownloads, this.maxWorkers));
    setActiveSlots(this.targetWorkers);
  },
  recordSpeed(id: number, bps: number) {
    this.workerSpeeds.set(id, bps);
  },
  clearWorker(id: number) {
    this.workerSpeeds.delete(id);
  },
  getAggregateSpeed(): number {
    let s = 0;
    for (const v of this.workerSpeeds.values()) s += v;
    return s;
  },
};

export const activeDlSlots = new Set<number>();

/** Make the active set exactly `target` slots (clamped to 1..MAX_SLOT_ID). */
export function setActiveSlots(target: number): void {
  const clamped = Math.max(1, Math.min(Math.round(target), MAX_SLOT_ID));
  if (clamped > activeDlSlots.size) {
    for (let i = 1; i <= MAX_SLOT_ID && activeDlSlots.size < clamped; i++) activeDlSlots.add(i);
  } else if (clamped < activeDlSlots.size) {
    for (let i = MAX_SLOT_ID; i >= 1 && activeDlSlots.size > clamped; i--) activeDlSlots.delete(i);
  }
}

export interface SlotTargetInput {
  /** Slots active right now. */
  current: number;
  /** Pending jobs waiting for a slot. */
  backlog: number;
  /** Jobs already downloading. Each holds a slot until it finishes. */
  inFlight: number;
  minWorkers: number;
  /** Ceiling, already clamped to the spawned pool by the caller. */
  maxWorkers: number;
  rampStep: number;
  aggBps: number;
  /** Configured bandwidth cap in bytes/second; 0 = uncapped. */
  capBps: number;
  now: number;
  lastScaleDownAt: number;
  /** Cooldown after a bandwidth shed before slots may grow again. */
  cooldownMs?: number;
}

export interface SlotTargetResult {
  target: number;
  /** True when this decision shed a slot for bandwidth (starts the cooldown). */
  bandwidthShed: boolean;
}

/**
 * Pure slot policy, one step per autoscale tick.
 *
 *  - Demand = jobs already downloading + jobs waiting. A running job holds its
 *    slot, so it counts; otherwise the slot of a finishing job would look idle.
 *  - No demand: collapse to the floor.
 *  - Bandwidth above 90% of the cap: shed one slot per tick (and start the
 *    growth cooldown).
 *  - Demand below the current count: shrink to demand. Idle slots park.
 *  - Backlog, bandwidth below 70% of the cap, and out of cooldown: grow by the
 *    ramp step, never past demand or the ceiling.
 *
 * A changed floor or ceiling is enforced immediately in every branch.
 */
export function nextSlotTarget(input: SlotTargetInput): SlotTargetResult {
  const floor = Math.max(1, input.minWorkers);
  const ceiling = Math.max(floor, input.maxWorkers);
  const demand = Math.max(0, input.inFlight) + Math.max(0, input.backlog);
  const cooldownMs = input.cooldownMs ?? 30_000;
  let target = Math.min(ceiling, Math.max(floor, input.current));

  if (demand === 0) return { target: floor, bandwidthShed: false };

  if (input.capBps > 0 && input.aggBps > input.capBps * 0.9 && target > floor) {
    return { target: target - 1, bandwidthShed: true };
  }

  const wanted = Math.max(floor, Math.min(ceiling, demand));
  if (target > wanted) return { target: wanted, bandwidthShed: false };

  const headroom = input.capBps === 0 || input.aggBps < input.capBps * 0.7;
  const cooled = input.now - input.lastScaleDownAt > cooldownMs;
  if (input.backlog > 0 && target < ceiling && headroom && cooled) {
    target = Math.min(target + Math.max(1, input.rampStep), demand, ceiling);
  }
  return { target, bandwidthShed: false };
}

/**
 * Autoscale tick (every 15s when autoscaleEnabled). Reads the live config so
 * dashboard edits (toggle, initial slots, floor, ceiling, ramp step) apply on
 * the next tick. The ceiling is clamped to the spawned pool.
 */
export function autoscaleTick(): void {
  const config = getConfig();
  const minWorkers = Math.max(1, Math.min(MAX_SLOT_ID, Math.floor(config.minDownloadWorkers)));
  const maxWorkers = Math.max(minWorkers, Math.min(MAX_SLOT_ID, autoscaler.poolSize, Math.floor(config.maxDownloadWorkers)));
  autoscaler.minWorkers = minWorkers;
  autoscaler.maxWorkers = maxWorkers;
  autoscaler.rampStep = Math.max(1, Math.floor(config.autoscaleRampStep));
  autoscaler.enabled = config.autoscaleEnabled;
  const initialChanged = config.maxConcurrentDownloads !== autoscaler.initialWorkers;
  autoscaler.initialWorkers = config.maxConcurrentDownloads;
  const initialSlots = Math.max(minWorkers, Math.min(config.maxConcurrentDownloads, maxWorkers));
  if (!autoscaler.enabled) {
    setActiveSlots(initialSlots);
    autoscaler.targetWorkers = activeDlSlots.size;
    return;
  }
  if (initialChanged) setActiveSlots(initialSlots);
  try {
    const q = db
      .query(
        `SELECT
           SUM(CASE WHEN download_status = 'pending'
                 OR (download_status = 'paused' AND COALESCE(pause_reason, '') NOT IN ('user', 'waiting_live'))
               THEN 1 ELSE 0 END) AS backlog,
           SUM(CASE WHEN download_status = 'downloading' THEN 1 ELSE 0 END) AS inflight
         FROM jobs`,
      )
      .get() as { backlog: number | null; inflight: number | null } | null;
    const now = Date.now();
    const result = nextSlotTarget({
      current: activeDlSlots.size,
      backlog: q?.backlog || 0,
      inFlight: q?.inflight || 0,
      minWorkers,
      maxWorkers,
      rampStep: autoscaler.rampStep,
      aggBps: autoscaler.getAggregateSpeed(),
      capBps: config.maxBandwidthKBps * 1024,
      now,
      lastScaleDownAt: autoscaler.lastScaleDownAt,
    });
    if (result.bandwidthShed) autoscaler.lastScaleDownAt = now;
    setActiveSlots(result.target);
    autoscaler.targetWorkers = activeDlSlots.size;
  } catch {}
}
