// tests/convert.test.ts — converter crash-window recovery.
//
// findConvertedOutput is the adoption probe: when a converter finds the source
// gone but a previous attempt already wrote the converted media (crash between
// the encode and the database update), the job is finished from that output
// instead of failing — or worse, re-downloading the whole video.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConvertedOutput } from "../src/workers/convert";

const dirs: string[] = [];
async function makeDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "yta-convert-"));
  dirs.push(d);
  return d;
}

describe("findConvertedOutput", () => {
  test("adopts the mp3 a crashed mp3 encode left behind", async () => {
    const dir = await makeDir();
    const mp3 = join(dir, "001 - Video.mp3");
    await writeFile(mp3, "audio");
    expect(findConvertedOutput(join(dir, "001 - Video.webm"), true)).toBe(mp3);
  });

  test("prefers the mp4 remux; a kept mkv source is its own final container", async () => {
    const dir = await makeDir();
    const mkv = join(dir, "002 - Video.mkv");
    await writeFile(mkv, "mkv");
    // A multi-audio mkv source is already the final container — the probe
    // must not "adopt" it as a conversion of itself.
    expect(findConvertedOutput(mkv, false)).toBe("");
    // A webm source with a finished mp4 remux next to it: the mp4 is adopted.
    await writeFile(join(dir, "002 - Video.mp4"), "mp4");
    expect(findConvertedOutput(join(dir, "002 - Video.webm"), false)).toBe(join(dir, "002 - Video.mp4"));
  });

  test("returns empty when only unrelated files exist", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "003 - Video.info.json"), "{}");
    await writeFile(join(dir, "003 - Video.en.vtt"), "WEBVTT");
    expect(findConvertedOutput(join(dir, "003 - Video.webm"), true)).toBe("");
    expect(findConvertedOutput(join(dir, "003 - Video.webm"), false)).toBe("");
  });

  test("never adopts the source itself as its own output", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "004 - Video.mp3"), "already mp3");
    // An .mp3 source with wantsMp3 has nothing to convert; the probe must not
    // "adopt" the source path as its own output.
    expect(findConvertedOutput(join(dir, "004 - Video.mp3"), true)).toBe("");
  });

  test("handles an empty source path", () => {
    expect(findConvertedOutput("", true)).toBe("");
  });
});
