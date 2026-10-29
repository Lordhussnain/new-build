// tests/web-idle-timeout.test.ts — a slow request must not be killed at 10s.
//
// Bun.serve() closes a request that has not answered within its `idleTimeout`
// (10 seconds by default) and prints:
//
//   warn: Bun.serve() timed out a request after 10 seconds. Pass `idleTimeout`
//   to configure.
//
// The engine holds several requests open for far longer than that on purpose —
// a playlist scan, a cookie export, a live `yt-dlp -J` audio probe — so the
// server passes an explicit `idleTimeout` and each slow route declares a
// longer deadline of its own. This test drives the REAL server (Bun.serve is
// not stubbed) against a probe that takes 15 seconds to answer: the client must
// receive the tracks, not a reset socket.
//
// Failure mode without the fix: `fetch` rejects with ECONNRESET at ~10-12s,
// which is also when Bun prints the warning an operator sees at Ctrl+C.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { db, initDatabase } from "../src/db";
import { setConfig } from "../src/state";
import { resolvedTools } from "../src/tools";
import { startWebServer } from "../src/web";

/** Longer than Bun's 10s default, short enough to keep the suite quick. */
const PROBE_DELAY_MS = 15_000;
const WIN = process.platform === "win32";

/**
 * Windows can neither read shebangs nor launch an extensionless file, so the
 * stub is compiled into a real executable there (the same rule the integration
 * harness applies to its mocks — AGENTS.md §9.5). Staged under a .ts name
 * first: `bun build --compile` on an extensionless entry silently emits a
 * no-op program.
 */
async function usableStub(dir: string, source: string): Promise<string> {
  if (!WIN) return source;
  const exe = join(dir, "yt-dlp.exe");
  const staged = join(dir, "yt-dlp.ts");
  await copyFile(source, staged);
  const proc = Bun.spawn(
    [process.execPath, "build", "--compile", staged, "--outfile", exe],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 || !existsSync(exe)) throw new Error(`stub compile failed: ${errText}`);
  return exe;
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function insertJob(id: string): void {
  db.run(
    `INSERT INTO jobs (id, url, title, output_directory, target_format) VALUES (?, ?, ?, ?, ?)`,
    [id, `https://www.youtube.com/watch?v=${id}`, `Video ${id}`, "/tmp/out", "mp4"],
  );
}

describe("a request that outlives Bun's 10-second idle timeout", () => {
  let server: ReturnType<typeof startWebServer>;
  let stubDir = "";
  const originalYtDlp = resolvedTools.ytDlp;

  beforeAll(async () => {
    initDatabase(":memory:");
    setConfig(baseConfig());
    insertJob("slow01");
    // A yt-dlp that answers a single-json dump only after PROBE_DELAY_MS. It is
    // a real child process, so the route's deadline is what keeps the socket
    // open — nothing about the probe itself is mocked.
    stubDir = await mkdtemp(join(tmpdir(), "yta-slow-probe-"));
    const stub = join(stubDir, "yt-dlp");
    await writeFile(
      stub,
      `#!${process.execPath}\nawait Bun.sleep(${PROBE_DELAY_MS});\n` +
        `console.log(JSON.stringify({ id: "slowvid", title: "Slow", formats: [\n` +
        `  { format_id: "251-0", vcodec: "none", acodec: "opus", tbr: 160, language: "en",\n` +
        `    audio_track: { id: "en.0", display_name: "English (original)" } } ] }));\n`,
    );
    await chmod(stub, 0o755);
    resolvedTools.ytDlp = await usableStub(stubDir, stub);
    server = startWebServer(0, baseConfig());
  });

  afterAll(async () => {
    server?.stop(true);
    resolvedTools.ytDlp = originalYtDlp;
    if (stubDir) await rm(stubDir, { recursive: true, force: true });
  });

  test(
    "the audio probe answers instead of dying on the idle timeout",
    async () => {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/jobs/slow01/audio-probe`, {
        method: "POST",
      });
      const elapsed = Date.now() - started;
      const body = (await res.json()) as { ok: boolean; tracks?: { language: string }[] };

      // Past 10s and still answered: the socket outlived Bun's default timer.
      expect(elapsed).toBeGreaterThan(11_000);
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.tracks?.map((t) => t.language)).toEqual(["en"]);
    },
    60_000,
  );
});
