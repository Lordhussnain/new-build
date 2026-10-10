// tests/scaling.test.ts — pure scaling policy, transfer budget and TUI text helpers.
//
// These cover the decisions that used to be buried in side effects: how many
// slots a tick chooses, how the aria2c/fragment budget splits across active
// downloads, and how dashboard text is sanitized and cut to terminal width.

import { describe, expect, test } from "bun:test";
import { nextSlotTarget, type SlotTargetInput } from "../src/autoscale";
import { perDownloadTransfers, buildAria2cArgs, CONNECTION_BUDGET } from "../src/download-args";
import { fitToWidth, sanitizeTerminalText } from "../src/dashboard";
import { DEFAULT_CONFIG } from "../src/config";
import { isTransientDownloadError } from "../src/retry";
import { initDatabase, reserveFileIndex, takeReservedFileIndex } from "../src/db";

function input(over: Partial<SlotTargetInput> = {}): SlotTargetInput {
  return {
    current: 1,
    backlog: 0,
    inFlight: 0,
    minWorkers: 1,
    maxWorkers: 10,
    rampStep: 2,
    aggBps: 0,
    capBps: 0,
    now: 1_000_000,
    lastScaleDownAt: 0,
    ...over,
  };
}

describe("nextSlotTarget", () => {
  test("an empty queue with nothing running collapses to the floor", () => {
    expect(nextSlotTarget(input({ current: 6, minWorkers: 2 })).target).toBe(2);
  });

  test("running jobs hold their slots: demand counts in-flight work, not just the backlog", () => {
    // Five downloads running and nothing waiting must keep five slots, not drop
    // to the floor and strand the running transfers' slots as idle.
    expect(nextSlotTarget(input({ current: 5, inFlight: 5, backlog: 0 })).target).toBe(5);
  });

  test("grows by the ramp step under backlog, never past demand or the ceiling", () => {
    expect(nextSlotTarget(input({ current: 1, backlog: 20 })).target).toBe(3);
    expect(nextSlotTarget(input({ current: 1, backlog: 3, rampStep: 10 })).target).toBe(3);
    expect(nextSlotTarget(input({ current: 1, backlog: 20, rampStep: 10, maxWorkers: 4 })).target).toBe(4);
  });

  test("shrinks to demand when the queue is shorter than the current slot count", () => {
    expect(nextSlotTarget(input({ current: 8, backlog: 2, inFlight: 1 })).target).toBe(3);
  });

  test("sheds one slot per tick when bandwidth is above 90% of the cap, and starts the cooldown", () => {
    const r = nextSlotTarget(input({ current: 4, backlog: 10, capBps: 1000, aggBps: 950 }));
    expect(r.target).toBe(3);
    expect(r.bandwidthShed).toBe(true);
  });

  test("does not grow inside the cooldown after a bandwidth shed", () => {
    const now = 1_000_000;
    expect(nextSlotTarget(input({ current: 2, backlog: 10, now, lastScaleDownAt: now - 5_000 })).target).toBe(2);
    expect(nextSlotTarget(input({ current: 2, backlog: 10, now, lastScaleDownAt: now - 31_000 })).target).toBe(4);
  });

  test("does not grow while bandwidth is between 70% and 90% of the cap", () => {
    expect(nextSlotTarget(input({ current: 2, backlog: 10, capBps: 1000, aggBps: 800 })).target).toBe(2);
  });

  test("a raised floor lifts the slot count at once, and the ramp continues from it", () => {
    // Floor 4 from one slot: lifted to 4, then one ramp step (+2) capped by demand 5.
    expect(nextSlotTarget(input({ current: 1, backlog: 5, minWorkers: 4, maxWorkers: 6 })).target).toBe(5);
  });
});

describe("perDownloadTransfers (aria2c connection / fragment budget)", () => {
  test("a single active slot keeps the configured value", () => {
    expect(perDownloadTransfers(64, 1, CONNECTION_BUDGET)).toBe(64);
  });

  test("the Aggressive profile is unchanged up to four slots", () => {
    expect(perDownloadTransfers(32, 4, CONNECTION_BUDGET)).toBe(32);
    expect(perDownloadTransfers(64, 4, 256)).toBe(64);
  });

  test("the share shrinks as slots grow, with a floor of 4", () => {
    expect(perDownloadTransfers(32, 10, CONNECTION_BUDGET)).toBe(12);
    expect(perDownloadTransfers(64, 40, CONNECTION_BUDGET)).toBe(4);
  });

  test("never raises a download above its own configured value", () => {
    expect(perDownloadTransfers(8, 2, CONNECTION_BUDGET)).toBe(8);
  });

  test("buildAria2cArgs with ten slots requests the reduced count", () => {
    const cfg = { ...DEFAULT_CONFIG, connectionsPerDownload: 32 };
    expect(buildAria2cArgs(cfg as any, 10)).toBe("-x 12 -s 12 -j 12");
    expect(buildAria2cArgs(cfg as any)).toBe("-x 16 -s 32 -j 32");
  });
});

describe("TUI text helpers", () => {
  test("sanitize removes escape sequences and control characters", () => {
    // CSI sequences vanish; CR, LF and BEL each become one space.
    expect(sanitizeTerminalText("ok\x1b[2J\x1b[H title\r\nnext\x07")).toBe("ok title  next ");
  });

  test("fitToWidth returns short text unchanged and cuts long text with an ellipsis", () => {
    expect(fitToWidth("short", 20)).toBe("short");
    const cut = fitToWidth("a very long video title indeed", 12);
    expect(cut.endsWith("...")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(12);
  });

  test("fitToWidth counts wide characters as two columns", () => {
    // Each 中 is two columns: six of them is twelve columns.
    expect(fitToWidth("中中中中中中", 12)).toBe("中中中中中中");
    expect(fitToWidth("中中中中中中", 9)).toBe("中中中...");
  });
});

describe("stalled transfers", () => {
  test("a stall is classified as transient, so the job resumes from its partial", () => {
    expect(isTransientDownloadError("Download stalled — no bytes for 180s; resuming from partial")).toBe(true);
  });
});

describe("metadata name reservations", () => {
  test("a video keeps one reserved index, and ingest takes it back once", () => {
    initDatabase(":memory:");
    const first = reserveFileIndex("Folder A", "vid1");
    expect(reserveFileIndex("Folder A", "vid1")).toBe(first);
    expect(takeReservedFileIndex("Folder A", "vid1")).toBe(first);
    expect(takeReservedFileIndex("Folder A", "vid1")).toBeNull();
  });

  test("the next video in the folder gets the following index", () => {
    initDatabase(":memory:");
    const a = reserveFileIndex("Folder B", "v1");
    const b = reserveFileIndex("Folder B", "v2");
    expect(b).toBe(a + 1);
  });
});
