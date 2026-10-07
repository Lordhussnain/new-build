// tests/disk.test.ts — the shared disk probe.
//
// diskUsage is the single place that touches statfs. Some Bun builds on Windows
// do not implement it, and then *calling* it throws a TypeError synchronously —
// a `.catch()` chained on the call cannot see that, which is how /api/status
// used to 500 instead of degrading. These tests pin the happy path, the
// "no probe could answer" path (reachable on every platform by asking about a
// path that does not exist), and — via the injectable probe — the two fallback
// steps themselves: an unsupported statfs and the PowerShell Get-PSDrive probe.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDiskSpace, diskUsage, driveLetterOf, parsePSDriveOutput } from "../src/resilience";

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

// --- the fallback chain, forced ---------------------------------------------
//
// The statfs → PowerShell → -1/-1 chain is what keeps a Bun build without
// statfs (and a shell that hangs or answers nonsense) from taking /api/status
// down with it. The tests above only touch the host's normal probe, so both
// fallback steps stay unexercised on a healthy machine; these inject the
// failures instead of waiting for a broken Windows box.

describe("driveLetterOf", () => {
  test("reads a Windows drive and rejects paths without one", () => {
    expect(driveLetterOf("D:\\Downloads\\YT")).toBe("D");
    expect(driveLetterOf("c:/videos")).toBe("c");
    expect(driveLetterOf("/tmp/videos")).toBe("");
    expect(driveLetterOf("./downloads")).toBe("");
  });
});

describe("parsePSDriveOutput", () => {
  test("reads Get-PSDrive's free/used pair", () => {
    expect(parsePSDriveOutput("1073741824 2147483648")).toEqual({
      freeBytes: 1073741824,
      totalBytes: 3221225472,
    });
  });

  test("degrades on an error banner, an empty answer, or a missing used value", () => {
    expect(parsePSDriveOutput("Get-PSDrive : Cannot find drive 'D'")).toBeNull();
    expect(parsePSDriveOutput("")).toBeNull();
    expect(parsePSDriveOutput("512")).toEqual({ freeBytes: 512, totalBytes: -1 });
  });
});

describe("diskUsage fallback chain", () => {
  test("a build without statfs degrades to -1/-1 instead of throwing", async () => {
    // `statfs: null` is exactly what an unimplemented Bun build looks like:
    // the call throws synchronously, before any promise exists to catch it.
    const usage = await diskUsage(".", { statfs: null, platform: "linux" });
    expect(usage.freeBytes).toBe(-1);
    expect(usage.totalBytes).toBe(-1);
    expect((usage.error || "").length).toBeGreaterThan(0);
  });

  test("falls back to the PowerShell probe on win32", async () => {
    const usage = await diskUsage("D:\\Downloads", {
      statfs: null,
      platform: "win32",
      pathExists: () => true,
      runPowerShell: async (drive) => {
        expect(drive).toBe("D");
        return "1073741824 2147483648";
      },
    });
    expect(usage).toEqual({ freeBytes: 1073741824, totalBytes: 3221225472 });
    expect(usage.error).toBeUndefined();
  });

  test("a hung PowerShell probe gives up at the timeout instead of stalling", async () => {
    const started = Date.now();
    let hung = false;
    const usage = await diskUsage("E:\\Downloads", {
      statfs: null,
      platform: "win32",
      pathExists: () => true,
      timeoutMs: 30,
      runPowerShell: () => {
        hung = true;
        return new Promise<string | null>(() => {}); // a wedged shell
      },
    });
    expect(hung).toBe(true);
    expect(usage.freeBytes).toBe(-1);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("an unusable PowerShell answer degrades instead of guessing a volume", async () => {
    const usage = await diskUsage("F:\\Downloads", {
      statfs: null,
      platform: "win32",
      pathExists: () => true,
      runPowerShell: async () => "Get-PSDrive : Cannot find drive 'F'",
    });
    expect(usage.freeBytes).toBe(-1);
    expect((usage.error || "").length).toBeGreaterThan(0);
  });

  test("never spawns the shell for a path that is not on disk", async () => {
    let called = false;
    const usage = await diskUsage("G:\\Nope", {
      statfs: null,
      platform: "win32",
      pathExists: () => false,
      runPowerShell: async () => {
        called = true;
        return "1 1";
      },
    });
    expect(called).toBe(false);
    expect(usage.freeBytes).toBe(-1);
  });

  test("checkDiskSpace allows the run through when statfs is missing", async () => {
    const result = await checkDiskSpace(".", 1, { statfs: null, platform: "linux" });
    expect(result).toEqual({ free: -1, ok: true });
  });
});
