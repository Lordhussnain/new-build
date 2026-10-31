import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import {
  channelFolderName,
  isShortsTabItem,
  listingEntryKind,
  normalizeVideoUrl,
  parseListingLine,
  parseListingLines,
  prepareIngestPlan,
  type ListingItem,
} from "../src/scanner";

const item = (playlist: string, channel?: string): ListingItem => ({
  id: "vid00000001",
  title: "Title",
  playlist,
  duration: NaN,
  ...(channel !== undefined ? { channel } : {}),
});

const planningConfig = (patch: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG,
  videoQuality: "1080p",
  targetFormat: "mp4",
  downloadSubtitles: false,
  embedSubtitles: false,
  writeThumbnail: false,
  embedThumbnail: false,
  writeDescription: false,
  writeInfoJson: false,
  skipShorts: true,
  downloadShorts: false,
  ...patch,
});

describe("listing batch compatibility", () => {
  test("preserves field defaults, classification, ordering and ignored fields", () => {
    const lines = [
      "  \uFEFF",
      "P|||",
      "P|||UCabcdefghij|||Other channel|||NA",
      " NA |||PLabcdefghij||| Season |||NA||| NA ",
      ["P", " vid00000001 ", "", "", " Channel ", "ignored"].join("|||"),
      "P|||vid00000002|||   ||| 12.5junk |||na",
      "P|||vid00000003",
      "P|||vid00000004|||Explicit|||0x10",
    ];
    expect(parseListingLines(lines)).toEqual([
      {
        playlist: "", id: "PLabcdefghij", title: "Season", duration: NaN, isPlaylist: true,
      },
      {
        playlist: "P", id: "vid00000001", title: "video", duration: NaN, channel: "Channel",
      },
      {
        playlist: "P", id: "vid00000002", title: "", duration: 12.5, channel: "na",
      },
      {
        playlist: "P", id: "vid00000003", title: "video", duration: NaN,
      },
      {
        playlist: "P", id: "vid00000004", title: "Explicit", duration: 0,
      },
    ]);
    expect(parseListingLine("P|||UCabcdefghij|||Other channel|||NA")).toBeNull();
    expect(parseListingLine("\u00a0\u2003\uFEFF")).toBeNull();
  });

  test("keeps non-finite and signed-zero duration behavior in ECMAScript", () => {
    const positive = parseListingLine("P|||vid00000001|||Infinite|||Infinity");
    const negative = parseListingLine("P|||vid00000002|||Negative|||-Infinity");
    const signedZero = parseListingLine("P|||vid00000003|||Zero|||-0");
    expect(positive?.duration).toBe(Infinity);
    expect(negative?.duration).toBe(-Infinity);
    expect(Object.is(signedZero?.duration, -0)).toBe(true);
  });

  test("uses UTF-16 length before case-sensitive id prefixes", () => {
    expect(listingEntryKind("UC123456789")).toBe("video"); // 11 code units
    expect(listingEntryKind("UC1234567890")).toBe("channel");
    expect(listingEntryKind(`UC${"😀".repeat(4)}`)).toBe("video"); // 10 code units, 22 bytes
    expect(listingEntryKind(`UC${"😀".repeat(5)}`)).toBe("channel");
    expect(listingEntryKind("PLabcdefghij")).toBe("playlist");
    expect(listingEntryKind("plabcdefghij")).toBe("video");
  });
});

describe("channel and Shorts suffix compatibility", () => {
  test("matches only the original ECMAScript whitespace and ASCII case rules", () => {
    expect(isShortsTabItem(item("Channel - Shorts"))).toBe(true);
    expect(isShortsTabItem(item("Channel\u00a0-\tSHORTS"))).toBe(true);
    expect(isShortsTabItem(item("Channel - Shorts\n"))).toBe(false);
    expect(isShortsTabItem(item("Channel - Shorts "))).toBe(false);
    expect(isShortsTabItem(item("Channel - ſhorts"))).toBe(false);
    expect(isShortsTabItem(item("Channel\u0085- Shorts"))).toBe(false);
    expect(isShortsTabItem(item("Channel- Shorts"))).toBe(false);
    expect(isShortsTabItem(item("Channel -Shorts"))).toBe(false);
  });

  test("prefers a trimmed channel and otherwise removes only a complete tab suffix", () => {
    expect(channelFolderName(item("Ignored - Live", " Uploads "))).toBe("Uploads");
    expect(channelFolderName(item("Channel - Shorts", "  "))).toBe("Channel");
    expect(channelFolderName(item("Channel - Shorts\n"))).toBe("Channel - Shorts");
    expect(channelFolderName(item("Plain Playlist"))).toBe("Plain Playlist");
    for (const tab of ["Videos", "Shorts", "Live", "Streams", "Playlists", "Home", "Featured", "Posts", "Community", "Releases"]) {
      expect(channelFolderName(item(`Channel\u2003-\u00a0${tab.toUpperCase()}`))).toBe("Channel");
    }
  });
});

describe("video URL and ingest planning compatibility", () => {
  test("canonicalizes watch/share URLs without changing invalid-id behavior", () => {
    expect(normalizeVideoUrl(" HTTPS://YOUTU.BE/AbCdEf12345?t=10 ")).toBe(
      "https://www.youtube.com/watch?v=AbCdEf12345",
    );
    expect(normalizeVideoUrl("https://youtu.be/?v=AbCdEf12345")).toBe(
      "https://www.youtube.com/watch?v=AbCdEf12345",
    );
    expect(normalizeVideoUrl("https://example.test/watch?v=%41%42%43%44%45%46&list=P")).toBe(
      "https://www.youtube.com/watch?v=ABCDEF",
    );
    expect(normalizeVideoUrl("https://youtu.be/bad!?v=AbCdEf12345")).toBe(
      "https://youtu.be/bad!?v=AbCdEf12345",
    );
    expect(normalizeVideoUrl("https://www.youtube.com/watch?v=abcdef%2B")).toBe(
      "https://www.youtube.com/watch?v=abcdef%2B",
    );
    expect(normalizeVideoUrl("not a URL")).toBe("not a URL");
    expect(normalizeVideoUrl("  ")).toBe("");
  });

  test("plans statuses, Shorts, playlist entries and persisted durations by item index", () => {
    const items: ListingItem[] = [
      { id: "short00001", title: "Short", playlist: "P", duration: 59.999 },
      { id: "long000001", title: "Long", playlist: "P", duration: 60 },
      { id: "tabshort01", title: "Tab", playlist: "Channel - Shorts", duration: NaN },
      { id: "unknown001", title: "Unknown", playlist: "Channel - Videos", duration: Infinity },
      { id: "PLabcdefghij", title: "Playlist", playlist: "P", duration: 30, isPlaylist: true },
    ];
    const plan = prepareIngestPlan(items, planningConfig());
    expect(plan.targetFormat).toBe("mp4");
    expect(plan.conversionStatus).toBe("not_needed");
    expect(plan.metadataStatus).toBe("not_needed");
    expect(plan.wantSubtitles).toBe(0);
    expect(plan.wantThumbnail).toBe(0);
    expect(plan.wantDescription).toBe(0);
    expect(plan.items.map(({ short, skipShort, duration, isPlaylist }) => ({ short, skipShort, duration, isPlaylist }))).toEqual([
      { short: true, skipShort: true, duration: 59.999, isPlaylist: false },
      { short: false, skipShort: false, duration: 60, isPlaylist: false },
      { short: true, skipShort: true, duration: null, isPlaylist: false },
      { short: false, skipShort: false, duration: null, isPlaylist: false },
      { short: true, skipShort: true, duration: 30, isPlaylist: true },
    ]);
    expect(plan.items.every((entry, index) => entry.url === `https://www.youtube.com/watch?v=${items[index].id}`)).toBe(true);
  });

  test("retains embedding sidecar requirements and audio/container conversion decisions", () => {
    const plan = prepareIngestPlan([], planningConfig({
      videoQuality: "audio",
      targetFormat: "mkv",
      embedSubtitles: true,
      embedThumbnail: true,
      writeDescription: true,
    }));
    expect(plan).toEqual({
      targetFormat: "mp3",
      wantSubtitles: 1,
      wantThumbnail: 1,
      wantDescription: 1,
      conversionStatus: "pending",
      metadataStatus: "pending",
      items: [],
    });
  });

  test("exotic ids retain the legacy generated-URL normalization exactly", () => {
    const items: ListingItem[] = [
      { id: "abcdef&x=1", title: "Query", playlist: "P", duration: 60 },
      { id: "abc&x=1", title: "Short query", playlist: "P", duration: 60 },
      { id: "%41%42%43%44%45%46", title: "Escaped", playlist: "P", duration: 60 },
      { id: "abcdef+", title: "Plus", playlist: "P", duration: 60 },
    ];
    expect(prepareIngestPlan(items, planningConfig()).items.map((entry) => entry.url)).toEqual([
      "https://www.youtube.com/watch?v=abcdef",
      "https://www.youtube.com/watch?v=abc&x=1",
      "https://www.youtube.com/watch?v=ABCDEF",
      "https://www.youtube.com/watch?v=abcdef+",
    ]);
  });
});
