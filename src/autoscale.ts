// src/autoscale.ts — dynamic download-slot autoscaling.
//
// All maxDownloadWorkers processes are supervised and alive, but only the ones
// whose id is in activeDlSlots may claim jobs. The autoscaler adds/removes slot
// ids — a slot removed mid-download lets its worker finish the current job and
// then idle.

import { db } from "./db";
import { getConfig } from "./state";

export const autoscaler = {
  enabled: true,
  targetWorkers: 3,
  minWorkers: 1,
  maxWorkers: 5,
  maxBandwidthKBps: 0,
  // Slots added per tick while a backlog exists (1 = the original slow ramp).
  rampStep: 2,
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
    this.maxBandwidthKBps = c.maxBandwidthKBps;
    this.rampStep = Math.max(1, Math.floor(c.autoscaleRampStep));
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

export function setActiveSlots(target: number): void {
  const clamped = Math.max(1, Math.min(Math.round(target), 20));
  if (clamped > activeDlSlots.size) {
    for (let i = 1; i <= 20 && activeDlSlots.size < clamped; i++) activeDlSlots.add(i);
  } else if (clamped < activeDlSlots.size) {
    for (let i = 20; i >= 1 && activeDlSlots.size > clamped; i--) activeDlSlots.delete(i);
  }
}

// Autoscale tick (every 15s when autoscaleEnabled): grow toward
// maxDownloadWorkers while the queue has backlog and bandwidth headroom, shed
// slots when the aggregate speed saturates the configured cap, and fall back
// to minDownloadWorkers when there is nothing to do. With autoscaling
// disabled the slot count stays pinned to maxConcurrentDownloads.
export function autoscaleTick(): void {
  const config = getConfig();
  if (!autoscaler.enabled) {
    setActiveSlots(Math.max(autoscaler.minWorkers, Math.min(config.maxConcurrentDownloads, autoscaler.maxWorkers)));
    autoscaler.targetWorkers = activeDlSlots.size;
    return;
  }
  try {
    const q = db
      .query(
        `SELECT SUM(CASE WHEN download_status = 'pending'
              OR (download_status = 'paused' AND COALESCE(pause_reason, '') NOT IN ('user', 'waiting_live'))
            THEN 1 ELSE 0 END) as backlog
         FROM jobs`,
      )
      .get() as any;
    const backlog = q?.backlog || 0;
    const aggBps = autoscaler.getAggregateSpeed();
    const capBps = autoscaler.maxBandwidthKBps * 1024;
    let target = activeDlSlots.size;
    if (backlog === 0) {
      target = autoscaler.minWorkers;
    } else if (capBps > 0 && aggBps > capBps * 0.9 && target > autoscaler.minWorkers) {
      target--; // bandwidth saturated — fewer slots = more headroom each
    } else if (backlog > target && target < autoscaler.maxWorkers && (capBps === 0 || aggBps < capBps * 0.7)) {
      // Waiting jobs + bandwidth headroom: grow by the configured ramp step,
      // but never overshoot either the backlog or the worker ceiling.
      target = Math.min(target + autoscaler.rampStep, backlog, autoscaler.maxWorkers);
    }
    setActiveSlots(target);
    autoscaler.targetWorkers = activeDlSlots.size;
  } catch {}
}
