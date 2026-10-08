import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runYtDlpSelfUpdate } from "../src/workers/download";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeUpdater(mode: "ok" | "fail" | "hang"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yta-update-"));
  tempDirs.push(dir);
  const win = process.platform === "win32";
  const source = join(dir, win ? "mock-yt-dlp.ts" : "mock-yt-dlp");
  const script = `#!/usr/bin/env bun\nconst mode = ${JSON.stringify(mode)};\nif (mode === "hang") { process.on("SIGINT", () => {}); await new Promise(() => {}); }\nif (mode === "fail") { console.error("mock self-update failed"); process.exit(7); }\nconsole.log("mock self-update complete");\n`;
  await writeFile(source, script, "utf8");
  if (!win) {
    await chmod(source, 0o755);
    return source;
  }

  // Windows does not launch shebang files, so compile the test fixture just
  // like the integration harness compiles its mock executables.
  const executable = join(dir, "mock-yt-dlp.exe");
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
  return executable;
}

describe("bounded yt-dlp self-update", () => {
  test("drains output and reports success", async () => {
    const binary = await makeUpdater("ok");
    const result = await runYtDlpSelfUpdate({ binary, timeoutMs: 2_000 });
    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.detail).toContain("mock self-update complete");
  });

  test("returns a bounded diagnostic for a failed update", async () => {
    const binary = await makeUpdater("fail");
    const result = await runYtDlpSelfUpdate({ binary, timeoutMs: 2_000 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.detail).toContain("mock self-update failed");
  });

  test("hard-kills and reaps an updater that hangs", async () => {
    const binary = await makeUpdater("hang");
    const started = Date.now();
    const result = await runYtDlpSelfUpdate({ binary, timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
