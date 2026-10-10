import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runYtDlpSelfUpdate } from "../src/workers/download";

const WIN = process.platform === "win32";

/**
 * Same shape as tests/scanner.test.ts: one fixture for the whole file, because
 * compiling and — on Windows — launching a freshly written .exe is slower than
 * anything these tests measure, so doing it per test used to burn Bun's
 * five-second default and fail for reasons that had nothing to do with the
 * updater. The mode comes from a file because `bun test` snapshots
 * `process.env` at startup and a variable set later never reaches a child.
 */
const TEST_TIMEOUT_MS = WIN ? 90_000 : 10_000;

/**
 * How long a *cooperative* fixture may take before the run counts as timed
 * out. It is a backstop for a broken fixture, not the behaviour under test —
 * and on Windows the first launch of a compiled executable can spend tens of
 * seconds in Defender. The hard-kill test below keeps a tight bound, because
 * there the timeout is the thing being asserted.
 */
const COOPERATIVE_BOUND_MS = WIN ? 60_000 : 2_000;

type FakeMode = "ok" | "fail" | "hang";

let fixtureDir = "";
let updater = "";

async function setMode(mode: FakeMode): Promise<void> {
  await writeFile(join(fixtureDir, "mode.txt"), mode, "utf8");
}

/**
 * Remove the temp dir, retrying while Windows still holds it: the hard-kill test
 * leaves a process that was SIGKILLed seconds ago, and its directory is not
 * releasable until the handle closes. A leftover temp dir is noise, not a
 * failure, so the last error is swallowed instead of raised between tests.
 */
async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") break;
      await Bun.sleep(200);
    }
  }
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "yta-update-"));
  await writeFile(join(fixtureDir, "mode.txt"), "ok", "utf8");
  const source = join(fixtureDir, WIN ? "mock-yt-dlp.ts" : "mock-yt-dlp");
  await writeFile(
    source,
    [
      "#!/usr/bin/env bun",
      `import { readFileSync } from "node:fs";`,
      `const mode = readFileSync(${JSON.stringify(join(fixtureDir, "mode.txt"))}, "utf8").trim();`,
      `if (mode === "hang") { process.on("SIGINT", () => {}); await new Promise(() => {}); }`,
      `if (mode === "fail") { console.error("mock self-update failed"); process.exit(7); }`,
      `console.log("mock self-update complete");`,
    ].join("\n") + "\n",
    "utf8",
  );

  if (!WIN) {
    await chmod(source, 0o755);
    updater = source;
    return;
  }

  // Windows does not launch shebang files, so compile the test fixture just
  // like the integration harness compiles its mock executables.
  const executable = join(fixtureDir, "mock-yt-dlp.exe");
  const compiler = Bun.spawn(
    [process.execPath, "build", "--compile", source, "--outfile", executable],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [, stderr, code] = await Promise.all([
    new Response(compiler.stdout).text(),
    new Response(compiler.stderr).text(),
    compiler.exited,
  ]);
  if (code !== 0) throw new Error(`Could not compile yt-dlp updater fixture: ${stderr}`);
  updater = executable;
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (fixtureDir) await removeTempDir(fixtureDir);
});

describe("bounded yt-dlp self-update", () => {
  test(
    "drains output and reports success",
    async () => {
      await setMode("ok");
      const result = await runYtDlpSelfUpdate({ binary: updater, timeoutMs: COOPERATIVE_BOUND_MS });
      expect(result.ok).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.detail).toContain("mock self-update complete");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "returns a bounded diagnostic for a failed update",
    async () => {
      await setMode("fail");
      const result = await runYtDlpSelfUpdate({ binary: updater, timeoutMs: COOPERATIVE_BOUND_MS });
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(7);
      expect(result.detail).toContain("mock self-update failed");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "hard-kills and reaps an updater that hangs",
    async () => {
      await setMode("hang");
      const started = Date.now();
      const result = await runYtDlpSelfUpdate({ binary: updater, timeoutMs: 200 });
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      // The bound the updater enforces is 200ms; the room around it is the
      // process launch and the reaping of a killed .exe, both slower on Windows.
      expect(Date.now() - started).toBeLessThan(WIN ? 10_000 : 3_000);
    },
    TEST_TIMEOUT_MS,
  );
});
