// tests/disk.test.ts — the shared disk probe.
//
// diskUsage is the single place that touches statfs. Some Bun builds on Windows
// do not implement it, and then *calling* it throws a TypeError synchronously —
// a `.catch()` chained on the call cannot see that, which is how /api/status
// used to 500 instead of degrading. These tests pin both the happy path and the
// "no probe could answer" path, which is reachable on every platform by asking
// about a path that does not exist.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDiskSpace, diskUsage } from "../src/resilience";

describe("diskUsage", () => {
  test("reports free and total bytes for a real path", async () => {
    const usage = await diskUsage(".");
    expect(usage.freeBytes).toBeGreaterThan(0);
    expect(usage.totalBytes).toBeGreaterThanOrEqual(usage.freeBytes);
    expect(usage.error).toBeUndefined();
  });

  test("degrades to -1 instead of throwing when no probe can answer", async () => {
    // A path that does not exist: statfs rejects, and the PowerShell fallback
    // refuses to answer for a drive that has nothing on it to measure — so
    // this is the "unknown" branch on every platform, not just POSIX.
    const missing = join(tmpdir(), "yta-no-such-volume-probe");
    const usage = await diskUsage(missing);
    expect(usage.freeBytes).toBe(-1);
    expect(usage.totalBytes).toBe(-1);
    expect(typeof usage.error).toBe("string");
    expect((usage.error as string).length).toBeGreaterThan(0);
  });

  test("handles a relative path without rejecting", async () => {
    const usage = await diskUsage("./");
    expect(usage.freeBytes).toBeGreaterThan(0);
  });
});

describe("checkDiskSpace", () => {
  test("measures free space against the minimum", async () => {
    const ok = await checkDiskSpace(".", 1);
    expect(ok.free).toBeGreaterThan(1);
    expect(ok.ok).toBe(true);

    // An impossible minimum on any real volume.
    const notOk = await checkDiskSpace(".", 10_000_000);
    expect(notOk.ok).toBe(false);
  });

  test("allows the run through when free space cannot be determined", async () => {
    // Degraded mode must never brick the engine over a failed probe: free is
    // reported as -1 and ok stays true so yt-dlp can surface a real disk error.
    const missing = join(tmpdir(), "yta-no-such-volume-probe-2");
    const result = await checkDiskSpace(missing, 1);
    expect(result.free).toBe(-1);
    expect(result.ok).toBe(true);
  });
});
