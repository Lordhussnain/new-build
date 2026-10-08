import { afterEach, describe, expect, test } from "bun:test";
import { cleanupDownloadProcess } from "../src/workers/download";
import { readProcessOutput } from "../src/download-output";
import { activeProcs } from "../src/state";

const WIN = process.platform === "win32";
const workerId = 987_654;

afterEach(() => {
  activeProcs.delete(workerId);
});

describe("download subprocess cleanup", () => {
  test("a progress callback failure kills and reaps the downloader before removing its tracking entry", async () => {
    const proc = Bun.spawn(
      [process.execPath, "-e", "console.log('PROGRESS'); setInterval(() => {}, 1000)"],
      { stdout: "pipe", stderr: "pipe" },
    );
    activeProcs.set(workerId, proc);
    const timer = setTimeout(() => {}, 60_000);
    const output = Promise.all([
      readProcessOutput(proc.stdout, () => {
        throw new Error("SQLITE_BUSY: simulated progress update failure");
      }),
      readProcessOutput(proc.stderr),
      proc.exited,
    ]);

    await expect(
      (async () => {
        try {
          await output;
        } finally {
          await cleanupDownloadProcess(workerId, proc, timer);
        }
      })(),
    ).rejects.toThrow("SQLITE_BUSY: simulated progress update failure");

    // The point of the assertion is "killed by the cleanup, not exited on its
    // own". POSIX encodes that as 128+SIGINT; Windows has no signal delivery
    // (killProcessTree there is TerminateProcess), where the code comes from
    // the API instead, so only the "not a clean exit" half is portable.
    const exitCode = await proc.exited;
    if (WIN) expect(exitCode).not.toBe(0);
    else expect(exitCode).toBe(130);
    expect(activeProcs.has(workerId)).toBe(false);
  });

  test("force-kills a downloader that ignores the graceful interrupt", async () => {
    const proc = Bun.spawn(
      [process.execPath, "-e", "process.on('SIGINT', () => {}); console.log('READY'); setInterval(() => {}, 1000)"],
      { stdout: "pipe", stderr: "ignore" },
    );
    activeProcs.set(workerId, proc);
    const reader = proc.stdout.getReader();
    try {
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("READY");
    } finally {
      reader.releaseLock();
    }

    await cleanupDownloadProcess(workerId, proc);

    expect(await proc.exited).not.toBe(0);
    expect(activeProcs.has(workerId)).toBe(false);
  });

  // POSIX-only: the fixture is a `bash` job and the proof is `pgrep`, and a
  // caller cannot tell "no orphans left" from "the probe does not exist here"
  // — on Windows the same guarantee comes from taskkill /T in killProcessTree
  // (src/resilience.ts) and is exercised end-to-end by the aria2c integration
  // scenarios. Same reasoning as the mock orphan watchdogs, AGENTS.md gotcha 23.
  test.skipIf(WIN)(
    "kills child processes of the downloader so external tools like aria2c do not continue running",
    async () => {
      // Spawn a parent process that spawns a long-running child process
      const proc = Bun.spawn(["bash", "-c", "sleep 100 & wait"], { stdout: "pipe", stderr: "pipe" });
      activeProcs.set(workerId, proc);
      await Bun.sleep(100);

      const childCheck = Bun.spawnSync(["pgrep", "-P", String(proc.pid)]);
      const childPid = childCheck.stdout.toString().trim();
      expect(childPid.length).toBeGreaterThan(0);

      await cleanupDownloadProcess(workerId, proc);

      expect(await proc.exited).not.toBe(0);
      expect(activeProcs.has(workerId)).toBe(false);

      // Verify the child process was also killed
      await Bun.sleep(100);
      const aliveCheck = Bun.spawnSync(["pgrep", "-f", "^sleep 100"]);
      expect(aliveCheck.stdout.toString().trim()).toBe("");
    },
  );
});
