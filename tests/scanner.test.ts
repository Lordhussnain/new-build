import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { getPlaylistItems, LISTING_BATCH_SIZE, type ListingItem } from "../src/scanner";
import { resolvedTools } from "../src/tools";

const WIN = process.platform === "win32";

/**
 * Every test here launches a real process, and on Windows it is the launch —
 * not the code under test — that takes seconds: a freshly written .exe has to be
 * released by its writer and scanned by Defender before CreateProcess will run
 * it. So the fixture is compiled once for the whole file instead of once per
 * test, and each test's budget is sized for a launch rather than left at Bun's
 * five-second default, which the suite used to blow through on Windows and then
 * report `exit 143` — the harness' own SIGTERM to the dangling fixture, not
 * something yt-dlp did.
 */
const TEST_TIMEOUT_MS = WIN ? 30_000 : 10_000;

type FakeMode = "ok" | "empty" | "fail" | "hang" | "many";

const originalYtDlp = resolvedTools.ytDlp;
let fixtureDir = "";
let fakeYtDlp = "";

/**
 * Which listing the fake yt-dlp prints, read from a file rather than the
 * environment: `bun test` snapshots `process.env` at startup, so a variable set
 * later by a test never reaches a child it spawns — on any platform.
 */
async function useScanner(mode: FakeMode): Promise<void> {
  await writeFile(join(fixtureDir, "mode.txt"), mode, "utf8");
  resolvedTools.ytDlp = fakeYtDlp;
}

/**
 * Remove the temp dir, retrying while Windows still holds it. A child that was
 * just killed can keep its working directory (or the executable) open for a
 * moment, and `rm` in that window fails with EPERM. A dir that survives is noise
 * in the OS temp folder, not a broken test, so the last failure is left
 * unreported instead of surfacing as an error between tests.
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
  fixtureDir = await mkdtemp(join(tmpdir(), "yta-scanner-"));
  await writeFile(
    join(fixtureDir, "mode.txt"),
    "empty",
    "utf8",
  );
  const source = join(fixtureDir, WIN ? "fake-yt-dlp.ts" : "fake-yt-dlp");
  await writeFile(
    source,
    [
      "#!/usr/bin/env bun",
      `import { readFileSync } from "node:fs";`,
      `const mode = readFileSync(${JSON.stringify(join(fixtureDir, "mode.txt"))}, "utf8").trim();`,
      `if (mode === "hang") await new Promise(() => {});`,
      `if (mode === "fail") { console.error("ERROR: Failed to extract playlist: scanner test error"); process.exit(7); }`,
      `if (mode === "many") { const rows = []; for (let i = 1; i <= 120; i++) rows.push("Mock Playlist|||many" + String(i).padStart(3, "0") + "|||Video " + i + "|||60"); console.log(rows.join("\\n")); }`,
      `if (mode === "ok") console.log("Mock Playlist|||scan001|||First Video|||120\\nMock Playlist|||scan002|||Second Video|||NaN");`,
    ].join("\n") + "\n",
    "utf8",
  );

  if (!WIN) {
    await chmod(source, 0o755);
    fakeYtDlp = source;
  } else {
    // Bun does not read shebangs on Windows, so compile the fixture into a
    // native executable just like the integration harness does for its mocks.
    const executable = join(fixtureDir, "fake-yt-dlp.exe");
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
    fakeYtDlp = executable;
  }
}, TEST_TIMEOUT_MS);

afterEach(() => {
  // resolvedTools is module state the whole test process shares, so the override
  // is dropped as soon as a test is done with it — otherwise the next test file in
  // the run would spawn this fixture by accident.
  resolvedTools.ytDlp = originalYtDlp;
});

afterAll(async () => {
  resolvedTools.ytDlp = originalYtDlp;
  if (fixtureDir) await removeTempDir(fixtureDir);
});

describe("getPlaylistItems", () => {
  test(
    "parses successful flat-playlist output",
    async () => {
      await useScanner("ok");
      const items = await getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG);
      expect(items).toEqual([
        { playlist: "Mock Playlist", id: "scan001", title: "First Video", duration: 120 },
        { playlist: "Mock Playlist", id: "scan002", title: "Second Video", duration: Number.NaN },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "preserves a valid empty listing",
    async () => {
      await useScanner("empty");
      expect(await getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "surfaces yt-dlp failure instead of treating it as an empty playlist",
    async () => {
      await useScanner("fail");
      await expect(getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG)).rejects.toThrow(
        "yt-dlp playlist scan failed (exit 7): ERROR: Failed to extract playlist: scanner test error",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "times out and terminates a hung yt-dlp scan",
    async () => {
      await useScanner("hang");
      await expect(
        getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG, { timeoutMs: 250 }),
      ).rejects.toThrow("yt-dlp playlist scan timed out after 250ms");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "hands items to onItems in bounded batches while still returning the full list in order",
    async () => {
      await useScanner("many");
      const batches: ListingItem[][] = [];
      const items = await getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG, {
        onItems: (batch) => {
          batches.push(batch);
        },
      });
      expect(items).toHaveLength(120);
      expect(items[0]?.id).toBe("many001");
      expect(items[119]?.id).toBe("many120");
      expect(batches.length).toBeGreaterThanOrEqual(3);
      expect(batches.every((batch) => batch.length > 0 && batch.length <= LISTING_BATCH_SIZE)).toBe(true);
      expect(batches.flat()).toEqual(items);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rethrows a failure from onItems unchanged instead of reporting it as a yt-dlp failure",
    async () => {
      await useScanner("many");
      await expect(
        getPlaylistItems("https://www.youtube.com/playlist?list=abc", DEFAULT_CONFIG, {
          onItems: () => {
            throw new Error("sink boom");
          },
        }),
      ).rejects.toThrow("sink boom");
    },
    TEST_TIMEOUT_MS,
  );
});
