import { describe, expect, test } from "bun:test";
import {
  DOWNLOAD_PATH_PREFIX,
  MAX_DOWNLOAD_PATH_LENGTH,
  MAX_OUTPUT_LINE_LENGTH,
  MAX_OUTPUT_TAIL_LENGTH,
  parseAria2cReadout,
  parseDownloadPath,
  readProcessOutput,
} from "../src/download-output";

/** Fixed byte-sized chunks, including splits inside CRLF and UTF-8 sequences. */
function pipe(text: string, chunkSize = 1024): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

describe("parseDownloadPath", () => {
  test("recognizes only an explicitly marked after_move path", () => {
    for (const path of [
      "C:\\Downloads\\Maths & more\\001 - 数学 🧮.mp4",
      "\\\\server\\share\\video.mkv",
      "/downloads/My Playlist/001 - Video.mp4",
      "downloads/001 - Video.mp4",
      " video with spaces .mp4",
    ]) {
      expect(parseDownloadPath(DOWNLOAD_PATH_PREFIX + path)).toBe(path);
      expect(parseDownloadPath(path)).toBeNull();
    }
    for (const log of [
      "PROGRESS:55.5|2.5MiB|6|10485760|5820416",
      "[#abcdef 1MiB/2MiB(50%) CN:16 DL:1MiB ETA:1s]",
      '[Merger] Merged formats into "C:\\Downloads\\video.mp4"',
      "[download] Destination: downloads/video.mp4",
      "log contains FILEPATH:downloads/video.mp4",
    ]) {
      expect(parseDownloadPath(log)).toBeNull();
    }
  });

  test("rejects oversized paths before they can reach Bun's native fs bindings", () => {
    expect(parseDownloadPath(DOWNLOAD_PATH_PREFIX + "x".repeat(MAX_DOWNLOAD_PATH_LENGTH))).not.toBeNull();
    for (const size of [MAX_DOWNLOAD_PATH_LENGTH + 1, 49_151, 57_204, 100_000]) {
      expect(parseDownloadPath(DOWNLOAD_PATH_PREFIX + "x".repeat(size))).toBeNull();
    }
  });

  test("rejects empty paths and control characters, including terminal escapes", () => {
    for (const path of ["", "   ", "\tfile.mp4", "file\0.mp4", "file\r.mp4", "file\n.mp4", "\x1b[0mfile.mp4", "file\x7f.mp4"]) {
      expect(parseDownloadPath(DOWNLOAD_PATH_PREFIX + path)).toBeNull();
    }
  });
});

describe("readProcessOutput", () => {
  test("accepts LF, CRLF, CR-only updates and a final record without a newline", async () => {
    const lines: string[] = [];
    const text = "first\r\nsecond\rthird\n\r\nlast";
    expect(await readProcessOutput(pipe(text, 1), (line) => lines.push(line))).toBe(text);
    expect(lines).toEqual(["first", "second", "third", "last"]);
  });

  test("decodes a Unicode path even when each UTF-8 character is split across reads", async () => {
    const path = "C:\\Downloads\\数学 🧮 हिन्दी.mp4";
    for (const separator of ["\n", "\r\n", "\r", ""]) {
      const paths: string[] = [];
      await readProcessOutput(pipe(DOWNLOAD_PATH_PREFIX + path + separator, 1), (line) => {
        const parsed = parseDownloadPath(line);
        if (parsed) paths.push(parsed);
      });
      expect(paths).toEqual([path]);
    }
  });

  test("never accumulates aria2c's CR-only updates into a huge filename", async () => {
    const progress = "[#abcdef 1MiB/2MiB(50%) CN:16 DL:1MiB ETA:1s]";
    const text = (progress + "\r").repeat(3000) + "\nFILEPATH:video.mp4\n";
    let count = 0;
    let path = "";
    const tail = await readProcessOutput(pipe(text, 137), (line) => {
      expect(line.length).toBeLessThanOrEqual(MAX_OUTPUT_LINE_LENGTH);
      count++;
      path = parseDownloadPath(line) || path;
    });
    expect(count).toBe(3001);
    expect(path).toBe("video.mp4");
    expect(tail).toBe(text.slice(-MAX_OUTPUT_TAIL_LENGTH));
  });

  test("discards an oversized record in full, not a path-looking suffix", async () => {
    const overlong = "x".repeat(60_000) + "FILEPATH:must-not-be-probed.mp4";
    for (const chunkSize of [257, 100_000]) {
      const lines: string[] = [];
      await readProcessOutput(pipe(overlong + "\r\nFILEPATH:valid.mp4", chunkSize), (line) => lines.push(line));
      expect(lines).toEqual(["FILEPATH:valid.mp4"]);
    }
  });

  test("drops oversized unterminated output at EOF but keeps its bounded diagnostic tail", async () => {
    const text = "x".repeat(200_000) + "FILEPATH:must-not-be-probed.mp4";
    const lines: string[] = [];
    const tail = await readProcessOutput(pipe(text), (line) => lines.push(line));
    expect(lines).toEqual([]);
    expect(tail).toBe(text.slice(-MAX_OUTPUT_TAIL_LENGTH));
  });

  test("accepts a record at the line limit and recovers after one above it", async () => {
    const atLimit = "x".repeat(MAX_OUTPUT_LINE_LENGTH);
    const lines: string[] = [];
    await readProcessOutput(pipe(`${atLimit}\n${atLimit}x\nnext\n`), (line) => lines.push(line));
    expect(lines).toEqual([atLimit, "next"]);
  });

  test("bounds stderr while retaining the error needed for retry classification", async () => {
    const text = "diagnostic noise\n".repeat(10_000) + "ERROR: Connection reset by peer\n";
    const tail = await readProcessOutput(pipe(text));
    expect(tail).toBe(text.slice(-MAX_OUTPUT_TAIL_LENGTH));
    expect(tail).toContain("ERROR: Connection reset by peer");
  });

  test("an empty stream has no records or diagnostics", async () => {
    const lines: string[] = [];
    const stream = pipe("");
    expect(await readProcessOutput(stream, (line) => lines.push(line))).toBe("");
    expect(lines).toEqual([]);
    expect(stream.locked).toBe(false);
  });

  test("releases the reader and propagates stream/parser failures", async () => {
    const stream = pipe("line\n");
    await expect(readProcessOutput(stream, () => { throw new Error("parser failed"); })).rejects.toThrow("parser failed");
    expect(stream.locked).toBe(false);
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("pipe failed")); } });
    await expect(readProcessOutput(broken)).rejects.toThrow("pipe failed");
    expect(broken.locked).toBe(false);
  });
});

describe("parseAria2cReadout", () => {
  test("parses the console readout aria2c writes to a non-TTY stdout", () => {
    // The live shape, byte for byte, from aria2's ConsoleStatCalc on a piped
    // stdout: no padding, no colours, newline-terminated.
    expect(parseAria2cReadout("[#208c72 1.4MiB/3.0MiB(48%) CN:16 DL:1.2MiB ETA:2m30s]")).toEqual({
      percent: 48,
      speedBps: 1.2 * 1024 * 1024,
      etaSeconds: 150,
      totalBytes: 3 * 1024 * 1024,
      downloadedBytes: 1.4 * 1024 * 1024,
    });
  });

  test("derives a percentage when aria2 omits one, and keeps raw byte counts", () => {
    // aria2 only prints "(N%)" once it knows the total length. Until then the
    // sizes are still usable — and the raw-byte form (511B, 1023B, long runs)
    // must parse too, since abbrevSize only abbreviates above 1KiB.
    expect(parseAria2cReadout("[#a1b2c3 524288B/10485760B CN:4 DL:671088B ETA:3s]")).toEqual({
      percent: 5,
      speedBps: 671088,
      etaSeconds: 3,
      totalBytes: 10485760,
      downloadedBytes: 524288,
    });
    expect(parseAria2cReadout("[#a1b2c3 1,000B/2.0MiB(0%) CN:1 DL:1,000B ETA:3h]")?.percent).toBe(0);
    expect(parseAria2cReadout("[#a1b2c3 0B/0B CN:1 DL:0B]")).toBeNull();
  });

  test("tolerates the padding and CR a Windows console leaves behind", () => {
    const padded = "  [#abcdef 1.4MiB/3.0MiB(48%) CN:16 DL:1.2MiB ETA:2m30s]     ";
    expect(parseAria2cReadout(padded)?.percent).toBe(48);
  });

  test("reads hours, minutes and seconds out of secfmt", () => {
    expect(parseAria2cReadout("[#abcdef 1GiB/2GiB(50%) CN:16 DL:1GiB ETA:1h5m]")?.etaSeconds).toBe(3900);
    expect(parseAria2cReadout("[#abcdef 1GiB/2GiB(50%) CN:16 DL:1GiB ETA:45s]")?.etaSeconds).toBe(45);
  });

  test("a finished transfer reports 100% with no speed or ETA", () => {
    expect(parseAria2cReadout("[#abcdef 3.0MiB/3.0MiB(100%) CN:16]")).toEqual({
      percent: 100,
      speedBps: 0,
      etaSeconds: 0,
      totalBytes: 3 * 1024 * 1024,
      downloadedBytes: 3 * 1024 * 1024,
    });
  });

  test("rejects everything that is not a single-group readout", () => {
    for (const line of [
      // The compact multi-group form begins with "[DL:", not a group id.
      "[DL:1.2MiB][#208c72 1.4MiB/3.0MiB(48%)][#abcdef 1MiB/2MiB(50%)]",
      // yt-dlp's own channels must never be mistaken for readouts.
      "PROGRESS:55.5|2.5MiB|6|10485760|5820416",
      `${DOWNLOAD_PATH_PREFIX}/downloads/video.mp4`,
      "[download] Destination: /downloads/video.mp4",
      "[youtube] mockvid001: Downloading webpage",
      "",
      "[]",
    ]) {
      expect(parseAria2cReadout(line)).toBeNull();
    }
  });

  test("ignores aria2c's other bracketed records, but not their own readout", () => {
    // The engine gets one record per line, so a mixed line is not expected;
    // what matters is that a readout among aria2's extras still parses.
    expect(parseAria2cReadout("[#abcdef 1.0MiB/2.0MiB(50%) CN:16 DL:1MiB ETA:1s]")?.percent).toBe(50);
    expect(parseAria2cReadout("[FileAlloc:#123456 1.0MiB/2.0MiB(50%)]")).toBeNull();
    expect(parseAria2cReadout("[Checksum:#123456 1.0MiB/2.0MiB(50%)]")).toBeNull();
  });
});
