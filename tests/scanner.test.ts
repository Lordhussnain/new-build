import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { getPlaylistItems } from "../src/scanner";
import { resolvedTools } from "../src/tools";

const originalYtDlp = resolvedTools.ytDlp;
const tempDirs: string[] = [];

afterEach(async () => {
  resolvedTools.ytDlp = originalYtDlp;
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function useScanner(mode: "ok" | "empty" | "fail" | "hang"): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "yta-scanner-"));
  tempDirs.push(dir);
  const win = process.platform === "win32";
  const source = join(dir, win ? "fake-yt-dlp.ts" : "fake-yt-dlp");
  const content = `#!/usr/bin/env bun\nconst mode = ${JSON.stringify(mode)};\nif (mode === "hang") await new Promise(() => {});\nif (mode === "fail") { console.error("ERROR: Failed to extract playlist: scanner test error"); process.exit(7); }\nif (mode === "ok") console.log("Mock Playlist|||scan001|||First Video|||120\\nMock Playlist|||scan002|||Second Video|||NaN");\n`;
  await writeFile(source, content, "utf8");
  if (!win) {
    await chmod(source, 0o755);
    resolvedTools.ytDlp = source;
    return;
  }

  // Bun does not read shebangs on Windows, so compile this fixture into a
  // native executable just like the integration harness does for its mocks.
  const executable = join(dir, "fake-yt-dlp.exe");
  const compiler = Bun.spawn(
    [process.execPath, "build", "--compile", source, "--outfile", executable],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [, stderr, code] = await Promise.all([
    new Response(compiler.stdout).text(),
    new Response(compiler.stderr).text(),
    compiler.exited,
  ]);
  if (code !== 0) throw new Error(`Could not compile scanner fixture: ${stderr}`);
  resolvedTools.ytDlp = executable;
}

describe("getPlaylistItems", () => {
  test("parses successful flat-playlist output", async () => {
    await useScanner("ok");
    const items = await getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG);
    expect(items).toEqual([
      { playlist: "Mock Playlist", id: "scan001", title: "First Video", duration: 120 },
      { playlist: "Mock Playlist", id: "scan002", title: "Second Video", duration: Number.NaN },
    ]);
  });

  test("preserves a valid empty listing", async () => {
    await useScanner("empty");
    expect(await getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG)).toEqual([]);
  });

  test("surfaces yt-dlp failure instead of treating it as an empty playlist", async () => {
    await useScanner("fail");
    await expect(getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG)).rejects.toThrow(
      "yt-dlp playlist scan failed (exit 7): ERROR: Failed to extract playlist: scanner test error",
    );
  });

  test("times out and terminates a hung yt-dlp scan", async () => {
    await useScanner("hang");
    await expect(
      getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG, { timeoutMs: 250 }),
    ).rejects.toThrow("yt-dlp playlist scan timed out after 250ms");
  });
});
