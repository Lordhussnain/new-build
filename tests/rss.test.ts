// tests/rss.test.ts — channel RSS feed parsing.

import { describe, expect, test } from "bun:test";
import { parseRssFeed } from "../src/rss";

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
