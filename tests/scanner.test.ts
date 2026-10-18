import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { db, initDatabase } from "../src/db";
import {
  channelFolderName,
  getPlaylistItems,
  isChannelSource,
  isPlaylistLikeId,
  isShortsTabItem,
  LISTING_BATCH_SIZE,
  parseListingLine,
  scanAndIngest,
  type ListingItem,
} from "../src/scanner";
import { resolvedTools } from "../src/tools";
import { setConfig } from "../src/state";

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

type FakeMode = "ok" | "empty" | "fail" | "hang" | "many" | "channel" | "slow" | "playlists-tab";

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
      // A channel listing as yt-dlp prints it: each tab's entries are named
      // "<Channel> - <Tab>", and the fifth field is the channel's display name.
      // The /playlists tab's entry carries a playlist id, not a video id.
      `if (mode === "channel") console.log([`,
      `  "LearnGandC - Videos|||vid00000001|||Lesson 1|||600|||LearnGandC",`,
      `  "LearnGandC - Videos|||vid00000002|||Lesson 2|||720|||LearnGandC",`,
      `  "LearnGandC - Shorts|||shrt0000001|||Quick tip|||NA|||LearnGandC",`,
      `  "LearnGandC - Live|||live0000001|||Live Q and A|||3600|||LearnGandC",`,
      `  "LearnGandC - Videos|||PLabcdefghijklmnopqrstuvwxyz012345|||A playlist|||NA|||LearnGandC",`,
      `].join("\\n"));`,
      `if (mode === "playlists-tab") console.log("LearnGandC - Playlists|||PLabcdefghijklmnopqrstuvwxyz012345|||Season 1|||NA|||LearnGandC");`,
      // Prints a line every 200ms for about a second: slow, but never silent.
      `if (mode === "slow") { for (let i = 1; i <= 5; i++) { console.log("Slow Channel - Videos|||slow00000" + i + "|||Slow " + i + "|||60|||Slow Channel"); await Bun.sleep(200); } }`,
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

describe("channel listings", () => {
  test("reads the channel name and drops playlist entries", async () => {
    await useScanner("channel");
    const items = await getPlaylistItems("https://www.youtube.com/@LearnGandC", DEFAULT_CONFIG);
    expect(items.map((item) => item.id)).toEqual(["vid00000001", "vid00000002", "shrt0000001", "live0000001"]);
    expect(items.every((item) => item.channel === "LearnGandC")).toBe(true);
    expect(items.map((item) => channelFolderName(item))).toEqual(["LearnGandC", "LearnGandC", "LearnGandC", "LearnGandC"]);
  }, TEST_TIMEOUT_MS);

  test("a channel's /playlists tab yields no videos instead of playlist ids", async () => {
    await useScanner("playlists-tab");
    expect(await getPlaylistItems("https://www.youtube.com/@LearnGandC/playlists", DEFAULT_CONFIG)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test("an idle limit lets a slow but progressing listing finish, while a total limit does not", async () => {
    await useScanner("slow");
    const url = "https://www.youtube.com/@SlowChannel";
    const items = await getPlaylistItems(url, DEFAULT_CONFIG, { timeoutMs: 600, idle: true });
    expect(items).toHaveLength(5);
    await expect(getPlaylistItems(url, DEFAULT_CONFIG, { timeoutMs: 600 })).rejects.toThrow(
      "yt-dlp playlist scan timed out after 600ms",
    );
  }, TEST_TIMEOUT_MS);

  test("an idle listing that stops printing is still stopped", async () => {
    await useScanner("hang");
    await expect(
      getPlaylistItems("https://www.youtube.com/@LearnGandC", DEFAULT_CONFIG, { timeoutMs: 250, idle: true }),
    ).rejects.toThrow("yt-dlp playlist scan timed out after 250ms without new output");
  }, TEST_TIMEOUT_MS);
});

describe("channel helpers", () => {
  test("parseListingLine tolerates a missing channel field and NA values", () => {
    expect(parseListingLine("Mock Playlist|||mockvid001|||First|||125")).toEqual({
      playlist: "Mock Playlist", id: "mockvid001", title: "First", duration: 125,
    });
    expect(parseListingLine("NA|||vid00000001|||Solo|||NA|||NA")).toEqual({
      playlist: "", id: "vid00000001", title: "Solo", duration: Number.NaN,
    });
  });

  test("channelFolderName prefers the channel name and strips a tab suffix otherwise", () => {
    expect(channelFolderName({ id: "a", title: "", playlist: "LearnGandC - Shorts", duration: NaN, channel: "LearnGandC" })).toBe("LearnGandC");
    expect(channelFolderName({ id: "a", title: "", playlist: "LearnGandC - Live", duration: NaN })).toBe("LearnGandC");
    expect(channelFolderName({ id: "a", title: "", playlist: "Plain Playlist", duration: NaN })).toBe("Plain Playlist");
  });

  test("source and entry classification", () => {
    expect(isChannelSource("https://www.youtube.com/@LearnGandC/")).toBe(true);
    expect(isChannelSource("https://www.youtube.com/@LearnGandC/shorts")).toBe(true);
    expect(isChannelSource("https://www.youtube.com/@LearnGandC/playlists")).toBe(false);
    expect(isChannelSource("https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrstuvwxyz012345")).toBe(false);
    expect(isShortsTabItem({ id: "a", title: "", playlist: "LearnGandC - Shorts", duration: NaN })).toBe(true);
    expect(isShortsTabItem({ id: "a", title: "", playlist: "LearnGandC - Videos", duration: NaN })).toBe(false);
    expect(isPlaylistLikeId("vid00000001")).toBe(false);
    expect(isPlaylistLikeId("PLabcdefghijklmnopqrstuvwxyz012345")).toBe(true);
    expect(isPlaylistLikeId("UCabcdefghijklmnopqrstuvw")).toBe(true);
  });
});

describe("channel scans", () => {
  let outputRoot = "";
  beforeEach(async () => {
    initDatabase(":memory:");
    outputRoot = await mkdtemp(join(tmpdir(), "yta-channel-out-"));
  });
  afterEach(async () => {
    setConfig(DEFAULT_CONFIG);
    await removeTempDir(outputRoot);
  });

  test("every tab of a channel lands in one channel folder, and Shorts follow skipShorts", async () => {
    await useScanner("channel");
    const config: Config = { ...DEFAULT_CONFIG, outputRoot, skipShorts: true, downloadShorts: false };
    setConfig(config);
    const result = await scanAndIngest("https://www.youtube.com/@LearnGandC/", config);
    expect(result).toMatchObject({ found: 4, added: 3, skipped: 1 });
    const rows = db.query("SELECT id, folder FROM jobs ORDER BY id").all() as { id: string; folder: string }[];
    expect(rows).toEqual([
      { id: "live0000001", folder: "LearnGandC" },
      { id: "vid00000001", folder: "LearnGandC" },
      { id: "vid00000002", folder: "LearnGandC" },
    ]);
  }, TEST_TIMEOUT_MS);

  test("Shorts are queued when skipShorts is off", async () => {
    await useScanner("channel");
    const config: Config = { ...DEFAULT_CONFIG, outputRoot, skipShorts: false };
    setConfig(config);
    const result = await scanAndIngest("https://www.youtube.com/@LearnGandC", config);
    expect(result).toMatchObject({ found: 4, added: 4, skipped: 0 });
    expect(db.query("SELECT folder FROM jobs WHERE id = 'shrt0000001'").get()).toEqual({ folder: "LearnGandC" });
  }, TEST_TIMEOUT_MS);
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
