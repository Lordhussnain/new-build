import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createArchiveIdCache,
  parseArchiveIdsText,
  readArchiveIds,
  removeArchiveIdText,
  removeFromArchive,
} from "../src/archive";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("archive text compatibility", () => {
  test("extracts the last field with stable first-appearance deduplication", () => {
    const text = [
      "youtube first",
      "extractor\tsecond\r",
      "  youtube   first  ",
      "\u00a0youtube\u2003third\uFEFF",
      "",
      "\u0085",
      "",
    ].join("\n");
    expect(parseArchiveIdsText(text)).toEqual(["first", "second", "third", "\u0085"]);
    expect(parseArchiveIdsText("\uFEFF\u00a0\u2003")).toEqual([]);
  });

  test("removes only an exact last-field match and preserves all other records", () => {
    const text = "youtube keep\r\nyoutube remove\nyoutube prefix-remove\n";
    expect(removeArchiveIdText(text, "remove")).toEqual({
      text: "youtube keep\r\nyoutube prefix-remove\n",
      changed: true,
    });
    expect(removeArchiveIdText(text, "missing")).toEqual({ text, changed: false });
  });

  test("retains the legacy empty-id and trailing-empty-record behavior", () => {
    expect(removeArchiveIdText("youtube keep\n\n", "")).toEqual({
      text: "youtube keep",
      changed: true,
    });
    expect(removeArchiveIdText("", "")).toEqual({ text: "", changed: true });
    expect(removeArchiveIdText("", "nonempty")).toEqual({ text: "", changed: false });
  });
});

describe("archive filesystem boundary", () => {
  test("uses the same pure parser/filter for real files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yta-archive-native-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "archive.txt");
    await writeFile(file, "youtube one\nextractor\ttwo\r\nyoutube three\n", "utf8");
    expect([...readArchiveIds(file)]).toEqual(["one", "two", "three"]);
    expect(removeFromArchive(file, "two")).toBe(true);
    expect(await readFile(file, "utf8")).toBe("youtube one\nyoutube three\n");
    expect(removeFromArchive(file, "missing")).toBe(true);
    expect(await readFile(file, "utf8")).toBe("youtube one\nyoutube three\n");
  });

  test("retains missing-file success and unreadable-file failure contracts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yta-archive-native-"));
    temporaryDirectories.push(directory);
    const missing = join(directory, "missing.txt");
    expect(readArchiveIds(missing)).toEqual(new Set());
    expect(removeFromArchive(missing, "vid001")).toBe(true);
    expect(removeFromArchive(directory, "vid001")).toBe(false);
  });

  test("cache reuses only unchanged snapshots and observes rewrites, appends and scrubs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yta-archive-cache-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "archive.txt");
    await writeFile(file, "youtube one\n", "utf8");
    const cache = createArchiveIdCache(file);

    const first = cache.readIds();
    expect([...first]).toEqual(["one"]);
    expect(cache.readIds()).toBe(first); // Unchanged: no second file parse.

    // Same byte length: freshness must not rely on file size alone.
    await Bun.sleep(20);
    await writeFile(file, "youtube two\n", "utf8");
    const rewritten = cache.readIds();
    expect(rewritten).not.toBe(first);
    expect([...rewritten]).toEqual(["two"]);
    expect(cache.readIds()).toBe(rewritten);

    await writeFile(file, "youtube two\nyoutube three\n", "utf8");
    expect([...cache.readIds()]).toEqual(["two", "three"]);
    expect(removeFromArchive(file, "two")).toBe(true);
    expect([...cache.readIds()]).toEqual(["three"]);

    const beforeInvalidation = cache.readIds();
    cache.invalidate();
    expect(cache.readIds()).not.toBe(beforeInvalidation);
    expect([...cache.readIds()]).toEqual(["three"]);
  });

  test("cache notices a missing archive that appears during a scan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yta-archive-cache-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "archive.txt");
    const cache = createArchiveIdCache(file);
    expect([...cache.readIds()]).toEqual([]);
    await writeFile(file, "youtube appeared\n", "utf8");
    expect([...cache.readIds()]).toEqual(["appeared"]);
  });
});
