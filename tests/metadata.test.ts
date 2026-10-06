// tests/metadata.test.ts — the metadata worker's pure helpers.

import { describe, expect, test } from "bun:test";
import { subtitleArgs } from "../src/workers/metadata";

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
