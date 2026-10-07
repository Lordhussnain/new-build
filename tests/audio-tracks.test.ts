// tests/audio-tracks.test.ts — YouTube multi-audio track parsing/selection.
//
// The format soup yt-dlp reports for a multi-language video (quality variants
// per track, -drc duplicates, track-indexed ids) must collapse into one clean
// entry per audio track, and the selection rules (global mode, language list,
// per-job override) must behave exactly as the download worker and the
// dashboard's picker expect.

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAudioTracks } from "../src/audio-tracks";
import { resolvedTools } from "../src/tools";
import {
  extractAudioTracks,
  multiAudioFormatSelector,
  parseSelectionJson,
  parseTracksJson,
  selectAudioTracks,
  trackIndexOf,
} from "../src/audio-tracks";

// A realistic slice of a YouTube -J dump: 3 tracks × 2 quality variants, plus
// DRC duplicates and a progressive format that must be ignored.
const INFO = {
  formats: [
    { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", tbr: 500 },
    { format_id: "137", vcodec: "avc1.640028", acodec: "none", tbr: 2500 },
    { format_id: "251-0", vcodec: "none", acodec: "opus", tbr: 160, language: "en", audio_track: { id: "en.0", display_name: "English (original)" } },
    { format_id: "249-0", vcodec: "none", acodec: "opus", tbr: 70, language: "en", audio_track: { id: "en.0", display_name: "English (original)" } },
    { format_id: "140-0", vcodec: "none", acodec: "mp4a.40.2", tbr: 130, language: "en" },
    { format_id: "251-0-drc", vcodec: "none", acodec: "opus", tbr: 160, language: "en" },
    { format_id: "251-1", vcodec: "none", acodec: "opus", tbr: 150, language: "es", audio_track: { id: "es.1", display_name: "Spanish (auto-dubbed)" } },
    { format_id: "249-1", vcodec: "none", acodec: "opus", tbr: 65, language: "es" },
    { format_id: "251-2", vcodec: "none", acodec: "opus", tbr: 140, language: "hi", audio_track: { id: "hi.2", display_name: "Hindi (auto-dubbed)" } },
  ],
};

describe("trackIndexOf", () => {
  test("reads the track index from the format id", () => {
    expect(trackIndexOf("251-0")).toBe(0);
    expect(trackIndexOf("251-2")).toBe(2);
    expect(trackIndexOf("251")).toBe(0); // single-audio video: no suffix
  });
});

describe("extractAudioTracks", () => {
  test("collapses quality variants and drops drc duplicates and video formats", () => {
    const tracks = extractAudioTracks(INFO);
    expect(tracks.map((t) => t.formatId)).toEqual(["251-0", "251-1", "251-2"]);
  });

  test("keeps the best stream per track (bitrate, then opus)", () => {
    const tracks = extractAudioTracks(INFO);
    expect(tracks[0].tbr).toBe(160);
    expect(tracks[0].acodec).toBe("opus");
  });

  test("carries language, label, and the original/default flag", () => {
    const tracks = extractAudioTracks(INFO);
    expect(tracks[0]).toMatchObject({ language: "en", label: "English (original)", isDefault: true });
    expect(tracks[1]).toMatchObject({ language: "es", label: "Spanish (auto-dubbed)", isDefault: false });
  });

  test("a single-audio video yields exactly one track", () => {
    const tracks = extractAudioTracks({
      formats: [
        { format_id: "137", vcodec: "avc1", acodec: "none" },
        { format_id: "251", vcodec: "none", acodec: "opus", tbr: 160, language: "en" },
      ],
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0].isDefault).toBe(true);
  });

  test("tolerates garbage input", () => {
    expect(extractAudioTracks(null)).toEqual([]);
    expect(extractAudioTracks({})).toEqual([]);
    expect(extractAudioTracks({ formats: "nope" })).toEqual([]);
  });
});

describe("selectAudioTracks", () => {
  const tracks = extractAudioTracks(INFO);

  test("off selects nothing", () => {
    expect(selectAudioTracks(tracks, "off", [])).toEqual([]);
  });

  test("all keeps every track in video order", () => {
    expect(selectAudioTracks(tracks, "all", []).map((t) => t.language)).toEqual(["en", "es", "hi"]);
  });

  test("languages filters case-insensitively and trims", () => {
    const sel = selectAudioTracks(tracks, "languages", [" EN ", "hi"]);
    expect(sel.map((t) => t.language)).toEqual(["en", "hi"]);
  });

  test("languages with an empty list selects nothing (never a silent full dump)", () => {
    expect(selectAudioTracks(tracks, "languages", [])).toEqual([]);
  });

  test("a per-job selection overrides the global mode, including off", () => {
    const sel = selectAudioTracks(tracks, "off", [], ["es"]);
    expect(sel.map((t) => t.language)).toEqual(["es"]);
  });

  test("unknown languages in a selection simply match nothing", () => {
    expect(selectAudioTracks(tracks, "languages", ["xx"])).toEqual([]);
  });
});

describe("multiAudioFormatSelector", () => {
  const tracks = extractAudioTracks(INFO);

  test("splices track ids into the quality preset, preserving video side and fallback", () => {
    expect(multiAudioFormatSelector("bv[height<=1080]+ba/b[height<=1080]", tracks)).toBe(
      "bv[height<=1080]+251-0+251-1+251-2/b[height<=1080]",
    );
  });

  test("works on presets without a fallback", () => {
    expect(multiAudioFormatSelector("bv+ba", tracks.slice(0, 2))).toBe("bv+251-0+251-1");
  });
});

describe("JSON column round-trips", () => {
  test("tracks survive a save/parse cycle; garbage yields null", () => {
    const tracks = extractAudioTracks(INFO);
    expect(parseTracksJson(JSON.stringify(tracks))).toEqual(tracks);
    expect(parseTracksJson(null)).toBeNull();
    expect(parseTracksJson("")).toBeNull();
    expect(parseTracksJson("{broken")).toBeNull();
    expect(parseTracksJson("42")).toBeNull();
  });

  test("selections survive a save/parse cycle; garbage yields null", () => {
    expect(parseSelectionJson(JSON.stringify(["en", "hi"]))).toEqual(["en", "hi"]);
    expect(parseSelectionJson(null)).toBeNull();
    expect(parseSelectionJson("nope")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("probeAudioTracks failures (the single-audio fallback)", () => {
  // The download worker catches ALL of these and continues with the classic
  // single-track plan. Each stub is a real child process so the probe's own
  // spawn/timeout/parse handling is exercised, not a mocked return value.
  const original = resolvedTools.ytDlp;
  const stubDirs: string[] = [];

  async function probeStub(name: string, body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `yta-probe-${name}-`));
    stubDirs.push(dir);
    const file = join(dir, "yt-dlp");
    // Absolute interpreter: the stub must not need a working PATH.
    await writeFile(file, `#!${process.execPath}\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  }

  afterAll(async () => {
    resolvedTools.ytDlp = original;
    for (const dir of stubDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("a failed -J call throws so the worker can fall back to single audio", async () => {
    resolvedTools.ytDlp = await probeStub(
      "fail",
      'console.error("ERROR: Unable to download webpage: HTTP Error 503: Service Unavailable");\nprocess.exit(1);',
    );
    await expect(
      probeAudioTracks("https://www.youtube.com/watch?v=mockvid001", { cookiesFile: "" }),
    ).rejects.toThrow(/503|exited with code/i);
  });

  test("unparsable -J output throws instead of silently reporting zero tracks", async () => {
    resolvedTools.ytDlp = await probeStub("badjson", 'console.log("not-json-at-all");');
    await expect(
      probeAudioTracks("https://www.youtube.com/watch?v=mockvid001", { cookiesFile: "" }),
    ).rejects.toThrow(/invalid JSON/i);
  });

  test("a hung probe is aborted at the timeout, not left hanging", async () => {
    resolvedTools.ytDlp = await probeStub("hang", "await new Promise(() => {});");
    const started = Date.now();
    await expect(
      probeAudioTracks("https://www.youtube.com/watch?v=mockvid001", { cookiesFile: "" }, { timeoutMs: 250 }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
