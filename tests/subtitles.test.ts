// tests/subtitles.test.ts — subtitle language selection and sidecar naming.

import { describe, expect, test } from "bun:test";
import {
  EMBEDDABLE_SUBTITLE_EXTENSIONS,
  isEmbeddableSubtitleFile,
  iso639_2,
  parseSubtitleLanguage,
  subtitleSelector,
} from "../src/subtitles";

describe("subtitleSelector", () => {
  test('"all" keeps every language but drops live chat', () => {
    expect(subtitleSelector("all")).toBe("all.*,-live_chat");
    expect(subtitleSelector("")).toBe("all.*,-live_chat");
    expect(subtitleSelector("  ")).toBe("all.*,-live_chat");
  });

  test("an explicit list is passed through, live chat excluded", () => {
    expect(subtitleSelector("en,es,ja")).toBe("en,es,ja,-live_chat");
    expect(subtitleSelector("en.*")).toBe("en.*,-live_chat");
  });

  test("an explicit live-chat request is respected", () => {
    expect(subtitleSelector("live_chat")).toBe("live_chat");
    expect(subtitleSelector("all.*,-live_chat")).toBe("all.*,-live_chat");
  });
});

describe("parseSubtitleLanguage", () => {
  test("reads the language tag from yt-dlp's sidecar name", () => {
    expect(parseSubtitleLanguage("001 - Video.en.srt", "001 - Video")).toBe("en");
    expect(parseSubtitleLanguage("001 - Video.zh-Hans.vtt", "001 - Video")).toBe("zh-hans");
    expect(parseSubtitleLanguage("001 - Video.en-orig.srt", "001 - Video")).toBe("en-orig");
    expect(parseSubtitleLanguage("001 - Video.ESP.ass", "001 - Video")).toBe("esp");
  });

  test("a bare sidecar has no language", () => {
    expect(parseSubtitleLanguage("001 - Video.srt", "001 - Video")).toBeNull();
  });

  test("never tags a video with its own title or another base's file", () => {
    // `001 - Video.2.srt` is the 2nd variant of a bare sidecar, not language 2.
    expect(parseSubtitleLanguage("001 - Video.2.srt", "001 - Video")).toBeNull();
    expect(parseSubtitleLanguage("002 - Other.en.srt", "001 - Video")).toBeNull();
  });

  test("only ffmpeg-readable subtitle extensions count", () => {
    expect(EMBEDDABLE_SUBTITLE_EXTENSIONS).toContain(".srt");
    expect(isEmbeddableSubtitleFile("a.en.srt")).toBe(true);
    expect(isEmbeddableSubtitleFile("a.en.lrc")).toBe(false);
    expect(isEmbeddableSubtitleFile("a.info.json")).toBe(false);
    expect(parseSubtitleLanguage("001 - Video.en.lrc", "001 - Video")).toBeNull();
  });
});

describe("iso639_2", () => {
  test("maps two-letter YouTube codes to the tags players display", () => {
    expect(iso639_2("en")).toBe("eng");
    expect(iso639_2("en-US")).toBe("eng");
    expect(iso639_2("en-orig")).toBe("eng");
    expect(iso639_2("ur")).toBe("urd");
    expect(iso639_2("zh-Hans")).toBe("zho");
    expect(iso639_2("iw")).toBe("heb");
  });

  test("three-letter codes pass through, unknown/missing becomes und", () => {
    expect(iso639_2("fil")).toBe("fil");
    expect(iso639_2("und")).toBe("und");
    expect(iso639_2("")).toBe("und");
    expect(iso639_2(null)).toBe("und");
    expect(iso639_2("zz")).toBe("und");
  });
});
