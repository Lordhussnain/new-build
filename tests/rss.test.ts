// tests/rss.test.ts — channel RSS feed parsing.

import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { db, initDatabase } from "../src/db";
import { getConfig, setConfig } from "../src/state";
import { parseRssFeed, startRssPolling } from "../src/rss";

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890abcdefghij"/>
  <id>yt:channel:UC1234567890abcdefghij</id>
  <channelId>UC1234567890abcdefghij</channelId>
  <title>Mock Channel</title>
  <author><name>Mock Channel</name><uri>https://www.youtube.com/channel/UC1234567890abcdefghij</uri></author>
  <published>2026-09-20T10:00:00+00:00</published>
  <entry>
    <id>yt:video:aaaaaaaaaaa</id>
    <yt:videoId>aaaaaaaaaaa</yt:videoId>
    <yt:channelId>UC1234567890abcdefghij</yt:channelId>
    <title>First Video &amp; &lt;Intro&gt;</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=aaaaaaaaaaa"/>
    <published>2026-09-25T12:00:00+00:00</published>
    <updated>2026-09-25T12:00:00+00:00</updated>
    <media:group>
      <media:title>First Video &amp; &lt;Intro&gt;</media:title>
      <media:content url="https://www.youtube.com/v/aaaaaaaaaaa?version=3" type="application/x-shockwave-flash" width="640" height="480" duration="365"/>
      <media:thumbnail url="https://i1.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg" width="480" height="360"/>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:bbbbbbbbbbb</id>
    <yt:videoId>bbbbbbbbbbb</yt:videoId>
    <yt:channelId>UC1234567890abcdefghij</yt:channelId>
    <title>Second Video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=bbbbbbbbbbb"/>
    <published>2026-09-24T12:00:00+00:00</published>
    <updated>2026-09-24T12:00:00+00:00</updated>
    <media:group>
      <media:title>Second Video</media:title>
      <media:content url="https://www.youtube.com/v/bbbbbbbbbbb?version=3" type="application/x-shockwave-flash" duration="45"/>
      <media:thumbnail url="https://i1.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg"/>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:ccccccccccc</id>
    <yt:videoId>ccccccccccc</yt:videoId>
    <yt:channelId>UC1234567890abcdefghij</yt:channelId>
    <title>No Duration Video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=ccccccccccc"/>
    <published>2026-09-23T12:00:00+00:00</published>
  </entry>
</feed>`;

describe("parseRssFeed", () => {
  test("extracts the feed title and every entry", () => {
    const { feedTitle, items } = parseRssFeed(SAMPLE_FEED);
    expect(feedTitle).toBe("Mock Channel");
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.id)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);
  });

  test("extracts titles and durations when present", () => {
    const { items } = parseRssFeed(SAMPLE_FEED);
    expect(items[0].title).toBe("First Video &amp; &lt;Intro&gt;"); // raw feed text, as yt-dlp sees it
    expect(items[0].duration).toBe(365);
    expect(items[1].duration).toBe(45);
    // Missing media:duration → NaN, which bypasses the shorts filter.
    expect(Number.isNaN(items[2].duration)).toBe(true);
  });

  test("falls back to the video id when a title is missing", () => {
    const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Chan</title>
      <entry><yt:videoId>zzzzzzzzzzz</yt:videoId></entry></feed>`;
    const { items } = parseRssFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("zzzzzzzzzzz");
  });

  test("handles CDATA titles", () => {
    const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title><![CDATA[CDATA Channel]]></title>
      <entry><yt:videoId>yyyyyyyyyyy</yt:videoId><title><![CDATA[A CDATA Title]]></title></entry></feed>`;
    const { feedTitle, items } = parseRssFeed(xml);
    expect(feedTitle).toBe("CDATA Channel");
    expect(items[0].title).toBe("A CDATA Title");
  });

  test("returns empty results for an empty or malformed feed", () => {
    expect(parseRssFeed("").items).toEqual([]);
    expect(parseRssFeed("<html>404</html>").items).toEqual([]);
    expect(parseRssFeed("<feed><title>Only Title</title></feed>").items).toEqual([]);
  });
});


describe("RSS polling after Web UI source changes", () => {
  test("starts with no channels and reads live channels on the next scheduled tick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-rss-live-"));
    initDatabase(":memory:");
    const initial = { ...DEFAULT_CONFIG, outputRoot: dir, channels: [], rssEnabled: true, skipShorts: false };
    setConfig(initial);
    const ticks: Array<() => Promise<void>> = [];
    // Control the timer boundary instead of waiting a real minute; fetch, too,
    // is a boundary fixture. The real RSS parser, ingestion and DB still run.
    const captureTick = (fn: unknown) => {
      ticks.push(fn as () => Promise<void>);
      return 0;
    };
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(captureTick as unknown as typeof setTimeout);
    const interval = spyOn(globalThis, "setInterval").mockImplementation(captureTick as unknown as typeof setInterval);
    const fetchFeed = spyOn(globalThis, "fetch").mockResolvedValue(new Response(SAMPLE_FEED));
    try {
      startRssPolling(initial);
      expect(ticks).toHaveLength(2);
      setConfig({ ...initial, channels: ["https://www.youtube.com/channel/UC1234567890abcdefghij"] });
      await ticks[0]();
      expect(fetchFeed).toHaveBeenCalledTimes(1);
      expect(db.query("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 3 });
      // Disabling it live must also be respected by the already-created timer.
      setConfig({ ...getConfig(), rssEnabled: false });
      await ticks[1]();
      expect(fetchFeed).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
      interval.mockRestore();
      fetchFeed.mockRestore();
      setConfig({ ...DEFAULT_CONFIG });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
