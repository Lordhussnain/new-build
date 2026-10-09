// tests/metadata.test.ts — pure helpers for the metadata worker.

import { describe, expect, test } from "bun:test";
import {
  findSidecarFiles,
  missingMetadataKinds,
  parseUnavailableMetadataKinds,
  updateUnavailableMetadataKinds,
} from "../src/metadata-files";
import { missingSidecarArgs, subtitleArgs } from "../src/workers/metadata";

describe("subtitleArgs", () => {
  test('"all" keeps the legacy fetch-everything behaviour', () => {
    expect(subtitleArgs({ subtitleLanguages: "all", subtitleFormat: "srt" })).toEqual([
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "all.*",
      "--convert-subs",
      "srt",
    ]);
  });

  test("blank falls back to every language", () => {
    expect(subtitleArgs({ subtitleLanguages: "  ", subtitleFormat: "vtt" })[3]).toBe("all.*");
  });

  test("an explicit list is passed through verbatim", () => {
    const args = subtitleArgs({ subtitleLanguages: "en, es , ja", subtitleFormat: "ass" });
    expect(args).toEqual([
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "en, es , ja",
      "--convert-subs",
      "ass",
    ]);
  });

  test("missing subtitle format defaults to srt", () => {
    const args = subtitleArgs({ subtitleLanguages: "en", subtitleFormat: "" });
    expect(args[args.length - 1]).toBe("srt");
  });
});

describe("missingSidecarArgs", () => {
  test("asks yt-dlp only for the metadata types that are missing", () => {
    expect(
      missingSidecarArgs(
        { subtitleLanguages: "en,es", subtitleFormat: "vtt" },
        ["thumbnail", "infoJson"],
      ),
    ).toEqual(["--write-thumbnail", "--convert-thumbnails", "jpg", "--write-info-json"]);
  });

  test("returns no network-write flags when every requested sidecar already exists", () => {
    expect(missingSidecarArgs({ subtitleLanguages: "all", subtitleFormat: "srt" }, [])).toEqual([]);
  });
});

describe("metadata sidecar discovery", () => {
  test("matches sidecars case-insensitively without matching another basename or the media file", () => {
    expect(
      findSidecarFiles(
        ["001.en.SRT", "001.INFO.JSON", "001.jpg", "0012.jpg", "002.jpg", "001.MP4"],
        "001",
        "001.mp4",
      ),
    ).toEqual(["001.en.SRT", "001.INFO.JSON", "001.jpg"]);
  });

  test("does not retry sidecar types already marked unavailable at the source", () => {
    expect(
      missingMetadataKinds(
        ["001.en.srt"],
        { subtitles: true, thumbnail: true, description: true, infoJson: true },
        ["thumbnail"],
      ),
    ).toEqual(["description", "infoJson"]);
  });

  test("ignores malformed, duplicate, and unknown unavailable metadata entries", () => {
    expect(parseUnavailableMetadataKinds('["thumbnail","unknown","thumbnail",1]')).toEqual(["thumbnail"]);
    expect(parseUnavailableMetadataKinds("not-json")).toEqual([]);
  });

  test("records successful but empty source results without carrying stale markers for files now present", () => {
    expect(
      updateUnavailableMetadataKinds(
        ["001.jpg"],
        '["thumbnail","subtitles"]',
        ["thumbnail", "description"],
      ),
    ).toEqual(["subtitles", "description"]);
  });
});
