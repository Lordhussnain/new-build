// tests/convert-storage.test.ts — the secondary-storage move must never lose
// the only copy.
//
// The converter's hand-off to secondary storage is a sequence of destructive
// moves (sidecars first, media last). Two rules keep it safe:
//   1. a source file is deleted only after a copy that reported success — a
//      full secondary disk must leave the file where it is, not delete it;
//   2. ownership is re-checked before EVERY destructive step, because the claim
//      can be stolen at any await in the sequence and the files then belong to
//      the new claim.
//
// Real files and real filesystem errors are used throughout: the failure that
// used to swallow the copy error and delete the source is a filesystem error,
// not a mock.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveToSecondaryStorage } from "../src/workers/convert";

const JOB = { id: "job-1", title: "First Mock Video", folder: "Mock Playlist" };
const MEDIA = "001 - First Mock Video.mp4";
const SIDECAR = "001 - First Mock Video.info.json";
const SECOND_SIDECAR = "001 - First Mock Video.en.vtt";
const UNRELATED = "999 - Someone Else.mp4";

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A download folder with a media file, two sidecars, and an unrelated file. */
async function makeDownloadDir(prefix = "yta-storage-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  await writeFile(join(dir, MEDIA), "media-bytes");
  await writeFile(join(dir, SIDECAR), "sidecar-bytes");
  await writeFile(join(dir, SECOND_SIDECAR), "second-sidecar-bytes");
  await writeFile(join(dir, UNRELATED), "someone-elses-bytes");
  return dir;
}

async function makeSecondaryDir(prefix = "yta-secondary-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * A destination that cannot be written: an existing, NON-EMPTY directory with
 * the destination's name inside a writable parent. Both `rename` (a file over
 * a directory) and `cp` (onto a directory) fail on every platform — the
 * portable stand-in for a full or unwritable secondary disk.
 */
async function blockDestination(destDir: string, name: string): Promise<void> {
  const blocker = join(destDir, name);
  await mkdir(blocker, { recursive: true });
  await writeFile(join(blocker, "keep"), "this directory must not be replaced");
}

describe("moveToSecondaryStorage", () => {
  test("moves the media and its sidecars, leaves unrelated files alone", async () => {
    const src = await makeDownloadDir();
    const secondary = await makeSecondaryDir();

    const result = await moveToSecondaryStorage(JOB, secondary, join(src, MEDIA));

    const destDir = join(secondary, JOB.folder);
    expect(result).toEqual({ path: join(destDir, MEDIA), stopped: false });
    expect(existsSync(result.path)).toBe(true);
    expect(await readFile(result.path, "utf8")).toBe("media-bytes");
    expect(existsSync(join(destDir, SIDECAR))).toBe(true);
    expect(existsSync(join(destDir, SECOND_SIDECAR))).toBe(true);
    expect(existsSync(join(destDir, UNRELATED))).toBe(false);
    // Sources: the moved files are gone, the stranger's file is untouched.
    expect(existsSync(join(src, MEDIA))).toBe(false);
    expect(existsSync(join(src, SIDECAR))).toBe(false);
    expect(existsSync(join(src, UNRELATED))).toBe(true);
  });

  test("a sidecar that cannot be copied keeps its source instead of being deleted", async () => {
    // This is the data-loss regression: the old fallback swallowed the copy
    // failure and unlinked the source anyway, so a blocked sidecar vanished
    // from both sides.
    const src = await makeDownloadDir();
    const secondary = await makeSecondaryDir();
    await mkdir(join(secondary, JOB.folder), { recursive: true });
    await blockDestination(join(secondary, JOB.folder), SIDECAR);

    const result = await moveToSecondaryStorage(JOB, secondary, join(src, MEDIA));

    expect(result.stopped).toBe(false);
    // The blocked sidecar is still in the download folder...
    expect(existsSync(join(src, SIDECAR))).toBe(true);
    expect(await readFile(join(src, SIDECAR), "utf8")).toBe("sidecar-bytes");
    // ...and the rest of the hand-off still completed.
    expect(existsSync(join(src, MEDIA))).toBe(false);
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(join(secondary, JOB.folder, SECOND_SIDECAR))).toBe(true);
  });

  test("a media move that cannot complete throws and leaves the source in place", async () => {
    const src = await makeDownloadDir();
    const secondary = await makeSecondaryDir();
    await mkdir(join(secondary, JOB.folder), { recursive: true });
    await blockDestination(join(secondary, JOB.folder), MEDIA);

    await expect(moveToSecondaryStorage(JOB, secondary, join(src, MEDIA))).rejects.toThrow(
      /secondary-storage move failed/,
    );

    // The only copy of the media is exactly where it was: the job can retry.
    expect(existsSync(join(src, MEDIA))).toBe(true);
    expect(await readFile(join(src, MEDIA), "utf8")).toBe("media-bytes");
  });

  test("stops before the next destructive move when ownership is lost", async () => {
    const src = await makeDownloadDir();
    const secondary = await makeSecondaryDir();
    let checks = 0;
    // Ownership is checked once per destructive step: let the first sidecar
    // through, then steal the claim.
    const canContinue = () => ++checks < 2;

    const result = await moveToSecondaryStorage(JOB, secondary, join(src, MEDIA), canContinue);

    expect(result.stopped).toBe(true);
    expect(result.path).toBe(join(src, MEDIA)); // nothing to record for this claim
    const moved = [SIDECAR, SECOND_SIDECAR, MEDIA].filter((f) => !existsSync(join(src, f)));
    expect(moved).toEqual([SIDECAR]); // exactly the step that was validated
    expect(checks).toBe(2);
  });
});

// --- the cross-device (EXDEV) branch ----------------------------------------
// rename() only works within one filesystem; secondary storage is usually a
// different volume, which is the branch that falls back to copy-then-unlink.
// /dev/shm is a second filesystem on Linux; when the host has no second
// filesystem the branch is exercised through blocked destinations above.
const SHM = "/dev/shm";
const hasSecondDevice =
  process.platform !== "win32" && existsSync(SHM) && statSync(SHM).dev !== statSync(tmpdir()).dev;

describe("moveToSecondaryStorage across devices", () => {
  test.skipIf(!hasSecondDevice)("copies to the other volume and only then drops the source", async () => {
    const src = await makeDownloadDir();
    const secondary = await mkdtemp(join(SHM, "yta-secondary-"));
    tmpDirs.push(secondary);
    try {
      const result = await moveToSecondaryStorage(JOB, secondary, join(src, MEDIA));
      expect(existsSync(result.path)).toBe(true);
      expect(await readFile(result.path, "utf8")).toBe("media-bytes");
      expect(existsSync(join(src, MEDIA))).toBe(false); // deleted after the copy landed
      expect(existsSync(join(secondary, JOB.folder, SIDECAR))).toBe(true);
      expect(existsSync(join(src, SIDECAR))).toBe(false);
    } finally {
      await rm(secondary, { recursive: true, force: true });
    }
  });
});
