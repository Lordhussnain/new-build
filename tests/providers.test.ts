// Site support: which URLs are sources, what they mean, and the canonical video
// URL a job is downloaded from. Everything here is pure — no I/O, no yt-dlp.
import { describe, expect, test } from "bun:test";
import {
  canonicalVideoUrl,
  channelFolderFallback,
  classifySourceUrl,
  cookieProbeUrls,
  isListingVideoId,
  listingProvider,
  networkProbeUrls,
  normalizeVideoUrl,
  providerOfHost,
  providerOfUrl,
  providersOfSources,
  resolveListingVideoUrl,
  sourceShape,
  videoUrlForId,
} from "../src/providers";

describe("provider detection", () => {
  test("recognises every host of both sites, including subdomains", () => {
    expect(providerOfHost("www.youtube.com")).toBe("youtube");
    expect(providerOfHost("m.youtube.com")).toBe("youtube");
    expect(providerOfHost("YOUTUBE.COM")).toBe("youtube");
    expect(providerOfHost("youtu.be")).toBe("youtube");
    expect(providerOfHost("www.bilibili.com")).toBe("bilibili");
    expect(providerOfHost("m.bilibili.com")).toBe("bilibili");
    expect(providerOfHost("space.bilibili.com")).toBe("bilibili");
    expect(providerOfHost("b23.tv")).toBe("bilibili");
    expect(providerOfHost("www.bilibili.tv")).toBe("bilibili");
    expect(providerOfHost("biliintl.com")).toBe("bilibili");
  });

  test("a host that merely contains a supported domain is not that site", () => {
    expect(providerOfHost("bilibili.com.evil.example")).toBeNull();
    expect(providerOfHost("notbilibili.com")).toBeNull();
    expect(providerOfHost("youtube.com.evil.example")).toBeNull();
    expect(providerOfHost("vimeo.com")).toBeNull();
    expect(providerOfHost("")).toBeNull();
    expect(providerOfUrl("https://evil.example/bilibili.com/video/BV1xx411c7mD")).toBeNull();
    expect(providerOfUrl("not a url")).toBeNull();
    expect(providerOfUrl("https://www.bilibili.com/video/BV1xx411c7mD")).toBe("bilibili");
  });

  test("the providers in use come out of a source list, in stable order", () => {
    expect(providersOfSources([])).toEqual([]);
    expect(providersOfSources(["https://www.youtube.com/@Teacher"])).toEqual(["youtube"]);
    expect(
      providersOfSources(["https://space.bilibili.com/1/video", "https://youtu.be/AbCdEf12345"]),
    ).toEqual(["youtube", "bilibili"]);
    expect(providersOfSources(["https://vimeo.com/1"])).toEqual([]);
  });

  test("an unknown source keeps the historical YouTube-shaped listing default", () => {
    expect(listingProvider("https://vimeo.com/1")).toBe("youtube");
    expect(listingProvider("")).toBe("youtube");
    expect(listingProvider(null)).toBe("youtube");
    expect(listingProvider("https://www.bilibili.com/video/BV1xx411c7mD")).toBe("bilibili");
  });
});

describe("classifySourceUrl — Bilibili videos", () => {
  test("video pages canonicalize to www.bilibili.com without share tracking", () => {
    for (const url of [
      "https://www.bilibili.com/video/BV1xx411c7mD",
      "  https://bilibili.com/video/BV1xx411c7mD/  ",
      "https://m.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.337.0.0&vd_source=abc",
      "http://www.bilibili.com/video/BV1xx411c7mD?buvid=XU0B&share_from=ugc&share_plat=android",
    ]) {
      expect(classifySourceUrl(url)).toEqual({
        provider: "bilibili",
        shape: "video",
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
      });
    }
  });

  test("an anthology page keeps the page it selects", () => {
    expect(classifySourceUrl("https://www.bilibili.com/video/BV1xx411c7mD?p=4&share_source=COPY")).toEqual({
      provider: "bilibili",
      shape: "video",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=4",
    });
    // A page that is not a positive integer is dropped, not passed through.
    expect(classifySourceUrl("https://www.bilibili.com/video/BV1xx411c7mD?p=0")?.url)
      .toBe("https://www.bilibili.com/video/BV1xx411c7mD");
    expect(classifySourceUrl("https://www.bilibili.com/video/BV1xx411c7mD?p=banana")?.url)
      .toBe("https://www.bilibili.com/video/BV1xx411c7mD");
  });

  test("legacy av ids, festival pages, bangumi, cheese and audio are videos", () => {
    expect(classifySourceUrl("https://www.bilibili.com/video/av170001")?.url)
      .toBe("https://www.bilibili.com/video/av170001");
    expect(classifySourceUrl("https://www.bilibili.com/festival/bh3-7th?bvid=BV1tr4y1f7p2&")?.url)
      .toBe("https://www.bilibili.com/video/BV1tr4y1f7p2");
    expect(classifySourceUrl("https://www.bilibili.com/bangumi/play/ep21495/?spm=x")).toEqual({
      provider: "bilibili", shape: "video", url: "https://www.bilibili.com/bangumi/play/ep21495",
    });
    expect(classifySourceUrl("https://www.bilibili.com/cheese/play/ep229832")?.url)
      .toBe("https://www.bilibili.com/cheese/play/ep229832");
    expect(classifySourceUrl("https://www.bilibili.com/audio/au1234567")?.url)
      .toBe("https://www.bilibili.com/audio/au1234567");
  });

  test("the international layout on the main host is the same source underneath", () => {
    // bilibili.com also serves its pages under a UI-language prefix
    // (`/en/video/BV…`); yt-dlp's BiliBiliIE pattern is the un-prefixed path, so
    // the prefix is presentation and must never become part of a source's
    // identity — pasting either spelling has to land on the same saved source.
    for (const url of [
      "https://www.bilibili.com/en/video/BV1WTnozqEd3/",
      "https://www.bilibili.com/en/video/BV1WTnozqEd3",
      "https://m.bilibili.com/ja/video/BV1WTnozqEd3/",
      "https://www.bilibili.com/EN/video/BV1WTnozqEd3/",
    ]) {
      expect(classifySourceUrl(url, { singleVideo: false })).toEqual({
        provider: "bilibili",
        shape: "video",
        url: "https://www.bilibili.com/video/BV1WTnozqEd3",
      });
    }
    expect(canonicalVideoUrl("https://www.bilibili.com/en/video/BV1WTnozqEd3/")).toBe(
      "https://www.bilibili.com/video/BV1WTnozqEd3",
    );
    // The prefix is dropped for the other shapes too, and `?p=` still wins.
    expect(classifySourceUrl("https://www.bilibili.com/en/bangumi/play/ep21495", { singleVideo: false })).toEqual({
      provider: "bilibili",
      shape: "video",
      url: "https://www.bilibili.com/bangumi/play/ep21495",
    });
    expect(classifySourceUrl("https://www.bilibili.com/en/list/ml999?sid=456&bvid=BV1x411c7mD", { singleVideo: false })).toEqual({
      provider: "bilibili",
      shape: "playlist",
      url: "https://www.bilibili.com/list/ml999?sid=456",
    });
    expect(classifySourceUrl("https://www.bilibili.com/en/video/BV1WTnozqEd3/?p=4", { singleVideo: false })).toEqual({
      provider: "bilibili",
      shape: "video",
      url: "https://www.bilibili.com/video/BV1WTnozqEd3?p=4",
    });
    // A two-letter segment in front of an unknown shape is still not a source,
    // and a bare language root is nothing at all.
    expect(classifySourceUrl("https://www.bilibili.com/en/nonexistent/BV1x411c7mD", { singleVideo: false })).toBeNull();
    expect(classifySourceUrl("https://www.bilibili.com/en", { singleVideo: false })).toBeNull();
  });

  test("a b23.tv share link is kept verbatim — only yt-dlp can follow it", () => {
    expect(classifySourceUrl("https://b23.tv/yZZOjOg")).toEqual({
      provider: "bilibili", shape: "video", url: "https://b23.tv/yZZOjOg",
    });
    expect(classifySourceUrl("b23.tv/yZZOjOg")).toBeNull();
    expect(classifySourceUrl("https://b23.tv/")).toBeNull();
    expect(classifySourceUrl("https://b23.tv/a/b")).toBeNull();
  });

  test("the international site keeps its language segment", () => {
    expect(classifySourceUrl("https://www.bilibili.tv/en/video/2045730385")).toEqual({
      provider: "bilibili", shape: "video", url: "https://www.bilibili.tv/en/video/2045730385",
    });
    expect(classifySourceUrl("https://bilibili.tv/EN/video/2019955076")?.url)
      .toBe("https://www.bilibili.tv/en/video/2019955076");
    // No language segment: yt-dlp accepts it, and "en" is its own default.
    expect(classifySourceUrl("https://www.bilibili.tv/video/2019955076")?.url)
      .toBe("https://www.bilibili.tv/en/video/2019955076");
    expect(classifySourceUrl("https://www.biliintl.com/en/play/34613/341736")?.url)
      .toBe("https://www.bilibili.tv/en/play/34613/341736");
    expect(classifySourceUrl("https://www.bilibili.tv/en/media/34613")).toEqual({
      provider: "bilibili", shape: "playlist", url: "https://www.bilibili.tv/en/media/34613",
    });
  });
});

describe("classifySourceUrl — Bilibili lists and channels", () => {
  test("favourites, collections and series are playlists, with the ids that select them", () => {
    expect(classifySourceUrl("https://space.bilibili.com/84912/favlist?fid=1103407912&ftype=create")).toEqual({
      provider: "bilibili", shape: "playlist", url: "https://space.bilibili.com/84912/favlist?fid=1103407912",
    });
    expect(classifySourceUrl("https://www.bilibili.com/medialist/detail/ml1103407912")?.url)
      .toBe("https://www.bilibili.com/medialist/detail/ml1103407912");
    expect(classifySourceUrl("https://space.bilibili.com/2142762/lists/3662502?type=season&spm=x")).toEqual({
      provider: "bilibili", shape: "playlist", url: "https://space.bilibili.com/2142762/lists/3662502?type=season",
    });
    // type=series is a DIFFERENT list with the same numeric id, so it survives.
    expect(classifySourceUrl("https://space.bilibili.com/1958703906/lists/547718?type=series")?.url)
      .toBe("https://space.bilibili.com/1958703906/lists/547718?type=series");
    expect(classifySourceUrl("https://space.bilibili.com/2142762/channel/collectiondetail?sid=57445")?.url)
      .toBe("https://space.bilibili.com/2142762/channel/collectiondetail?sid=57445");
    expect(classifySourceUrl("https://space.bilibili.com/1958703906/channel/seriesdetail?sid=547718&ctype=0")?.url)
      .toBe("https://space.bilibili.com/1958703906/channel/seriesdetail?sid=547718");
  });

  test("seasons, albums and the watchlater list are playlists", () => {
    expect(classifySourceUrl("https://www.bilibili.com/bangumi/play/ss26801")).toEqual({
      provider: "bilibili", shape: "playlist", url: "https://www.bilibili.com/bangumi/play/ss26801",
    });
    expect(classifySourceUrl("https://www.bilibili.com/bangumi/media/md28238001")?.url)
      .toBe("https://www.bilibili.com/bangumi/media/md28238001");
    expect(classifySourceUrl("https://www.bilibili.com/cheese/play/ss5918")?.url)
      .toBe("https://www.bilibili.com/cheese/play/ss5918");
    expect(classifySourceUrl("https://www.bilibili.com/audio/am12345")?.url)
      .toBe("https://www.bilibili.com/audio/am12345");
    expect(classifySourceUrl("https://www.bilibili.com/watchlater/#/list")).toEqual({
      provider: "bilibili", shape: "playlist", url: "https://www.bilibili.com/watchlater",
    });
  });

  test("a series player keeps only the parameters that choose the list", () => {
    expect(classifySourceUrl("https://www.bilibili.com/list/1958703906?sid=547718")).toEqual({
      provider: "bilibili", shape: "playlist", url: "https://www.bilibili.com/list/1958703906?sid=547718",
    });
    // oid/bvid only name the video the share link opened: dropping them keeps
    // one identity per list instead of one per shared video.
    expect(
      classifySourceUrl("https://www.bilibili.com/list/1958703906?sid=547718&oid=687146339&bvid=BV1DU4y1r7tz")?.url,
    ).toBe("https://www.bilibili.com/list/1958703906?sid=547718");
    expect(classifySourceUrl("https://www.bilibili.com/medialist/play/1958703906?business=space_series&sid=547718")?.url)
      .toBe("https://www.bilibili.com/medialist/play/1958703906?business=space_series&sid=547718");
    // A 10+ digit favourite id is an identifier, not a number: it survives intact.
    expect(classifySourceUrl("https://space.bilibili.com/84912/favlist?fid=3276012345678")?.url)
      .toBe("https://space.bilibili.com/84912/favlist?fid=3276012345678");
  });

  test("singleVideo turns a shared series link into the video it opened", () => {
    const shared = "https://www.bilibili.com/list/1958703906?sid=547718&oid=687146339&bvid=BV1DU4y1r7tz";
    expect(classifySourceUrl(shared, { singleVideo: true })).toEqual({
      provider: "bilibili", shape: "video", url: "https://www.bilibili.com/video/BV1DU4y1r7tz",
    });
    expect(classifySourceUrl("https://www.bilibili.com/medialist/play/1?sid=2&oid=687146339", { singleVideo: true }))
      .toEqual({ provider: "bilibili", shape: "video", url: "https://www.bilibili.com/video/av687146339" });
    // Without the option the list wins, exactly like a YouTube watch?list= link.
    expect(classifySourceUrl(shared)?.shape).toBe("playlist");
  });

  test("an uploader's space is a channel, whichever tab it names", () => {
    for (const path of ["", "/video", "/upload/video", "/audio", "/upload/audio"]) {
      const source = classifySourceUrl(`https://space.bilibili.com/3985676${path}?spm_id_from=x`);
      expect(source?.provider).toBe("bilibili");
      expect(source?.shape).toBe("channel");
      expect(source?.url).toBe(`https://space.bilibili.com/3985676${path === "/upload/video" ? "/video" : path === "/upload/audio" ? "/audio" : path}`);
    }
  });

  test("shapes that are not sources are rejected", () => {
    for (const url of [
      "https://www.bilibili.com/",
      "https://www.bilibili.com/video/",
      "https://www.bilibili.com/video/not-a-bvid",
      "https://space.bilibili.com/",
      "https://space.bilibili.com/84912/favlist",
      "https://space.bilibili.com/2142762/channel/collectiondetail",
      "https://space.bilibili.com/3985676/dynamic",
      "https://www.bilibili.com/v/popular/all",
      "https://www.bilibili.tv/en/media/",
    ]) {
      expect(classifySourceUrl(url)).toBeNull();
    }
    expect(classifySourceUrl(undefined)).toBeNull();
    expect(classifySourceUrl("")).toBeNull();
    expect(classifySourceUrl("bilibili.com/video/BV1xx411c7mD")).toBeNull();
  });
});

describe("classifySourceUrl — YouTube is unchanged", () => {
  test("playlists, channels, tabs and single videos classify as before", () => {
    expect(classifySourceUrl("https://youtube.com/playlist?list=PL_saved&si=tracking")).toEqual({
      provider: "youtube", shape: "playlist", url: "https://www.youtube.com/playlist?list=PL_saved",
    });
    expect(classifySourceUrl("https://youtu.be/AbCdEf12345?list=PL_saved&index=2")).toEqual({
      provider: "youtube", shape: "playlist", url: "https://www.youtube.com/playlist?list=PL_saved",
    });
    expect(classifySourceUrl("https://youtu.be/AbCdEf12345?list=PL_saved&index=2", { singleVideo: true })).toEqual({
      provider: "youtube", shape: "video", url: "https://www.youtube.com/watch?v=AbCdEf12345",
    });
    expect(classifySourceUrl("https://www.youtube.com/shorts/AbCdEf12345")).toEqual({
      provider: "youtube", shape: "video", url: "https://www.youtube.com/watch?v=AbCdEf12345",
    });
    expect(classifySourceUrl("https://m.youtube.com/@Teacher/shorts")).toEqual({
      provider: "youtube", shape: "channel", url: "https://www.youtube.com/@Teacher/shorts",
    });
    expect(classifySourceUrl("https://www.youtube.com/@Teacher/playlists")).toEqual({
      provider: "youtube", shape: "channelPlaylists", url: "https://www.youtube.com/@Teacher/playlists",
    });
    expect(classifySourceUrl("https://www.youtube.com/watch")).toBeNull();
    expect(classifySourceUrl("https://www.youtube.com/")).toBeNull();
  });

  test("a malformed playlist id still throws instead of saving junk", () => {
    expect(() => classifySourceUrl("https://www.youtube.com/playlist?list=%20")).toThrow("Invalid YouTube playlist id");
  });

  test("sourceShape answers without throwing", () => {
    expect(sourceShape("https://www.youtube.com/playlist?list=%20")).toBe("unknown");
    expect(sourceShape("https://www.bilibili.com/video/BV1xx411c7mD")).toBe("video");
    expect(sourceShape("https://space.bilibili.com/1/favlist?fid=2")).toBe("playlist");
    expect(sourceShape("https://space.bilibili.com/1/video")).toBe("channel");
    expect(sourceShape("https://vimeo.com/1")).toBe("unknown");
  });
});

describe("normalizeVideoUrl", () => {
  test("folds share links and tracking into one canonical URL per video", () => {
    expect(normalizeVideoUrl("https://youtu.be/AbCdEf12345?si=share")).toBe("https://www.youtube.com/watch?v=AbCdEf12345");
    expect(normalizeVideoUrl("https://www.youtube.com/watch?v=AbCdEf12345&t=20&list=PL_x")).toBe(
      "https://www.youtube.com/watch?v=AbCdEf12345",
    );
    expect(normalizeVideoUrl("https://m.bilibili.com/video/BV1tvo4BYE2P/?buvid=X&from_spmid=main&p=4")).toBe(
      "https://www.bilibili.com/video/BV1tvo4BYE2P?p=4",
    );
    expect(normalizeVideoUrl("https://www.bilibili.com/bangumi/play/ep678060?spm=x")).toBe(
      "https://www.bilibili.com/bangumi/play/ep678060",
    );
  });

  test("anything that is not a recognised video URL is returned unchanged", () => {
    // The selected format's CDN URL is what %(url)s prints for a full
    // extraction — it must never become a job URL.
    expect(normalizeVideoUrl("https://rr3---sn-xyz.googlevideo.com/videoplayback?id=abc&expire=1")).toBe(
      "https://rr3---sn-xyz.googlevideo.com/videoplayback?id=abc&expire=1",
    );
    expect(normalizeVideoUrl("https://upos-sz-mirror.bilivideo.com/upgcxcode/xx.m4s?deadline=1")).toBe(
      "https://upos-sz-mirror.bilivideo.com/upgcxcode/xx.m4s?deadline=1",
    );
    expect(normalizeVideoUrl("https://www.youtube.com/playlist?list=PL_saved")).toBe(
      "https://www.youtube.com/playlist?list=PL_saved",
    );
    expect(normalizeVideoUrl("https://b23.tv/yZZOjOg")).toBe("https://b23.tv/yZZOjOg");
    expect(normalizeVideoUrl("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(normalizeVideoUrl("   ")).toBe("");
  });
});

describe("listing entry ids", () => {
  test("Bilibili entries that are nested lists never become jobs", () => {
    expect(isListingVideoId("bilibili", "BV1xx411c7mD")).toBe(true);
    expect(isListingVideoId("bilibili", "BV1af4y1H7ga_p2")).toBe(true);
    expect(isListingVideoId("bilibili", "av170001")).toBe(true);
    expect(isListingVideoId("bilibili", "au1234567")).toBe(true);
    expect(isListingVideoId("bilibili", "21495")).toBe(true);
    // A hidden-mode collection inside a space's uploads: "<mid>_<sid>".
    expect(isListingVideoId("bilibili", "3669403_3958082")).toBe(false);
    expect(isListingVideoId("bilibili", "")).toBe(false);
  });

  test("YouTube keeps the historical rule: playlist ids out, everything else in", () => {
    expect(isListingVideoId("youtube", "PLabcdefghijklmnopqrstuvwxyz012345")).toBe(false);
    expect(isListingVideoId("youtube", "UCabcdefghijklmnopqrstuvw")).toBe(false);
    expect(isListingVideoId("youtube", "vid00000001")).toBe(true);
    // Short fixture ids must keep ingesting — the rule is the prefix, not a length.
    expect(isListingVideoId("youtube", "v1")).toBe(true);
  });
});

describe("resolveListingVideoUrl", () => {
  test("a printed page URL wins, a printed stream URL or bare id does not", () => {
    expect(
      resolveListingVideoUrl({
        id: "21495",
        provider: "bilibili",
        sourceUrl: "https://www.bilibili.com/bangumi/play/ss26801",
        webpageUrl: "NA",
        printedUrl: "https://www.bilibili.com/bangumi/play/ep21495?share_tag=x",
      }),
    ).toBe("https://www.bilibili.com/bangumi/play/ep21495");
    // A CDN URL (what %(url)s prints for a fully extracted video) is rejected.
    expect(
      resolveListingVideoUrl({
        id: "21495",
        provider: "bilibili",
        sourceUrl: "https://www.bilibili.com/bangumi/play/ep21495",
        webpageUrl: "https://www.bilibili.com/bangumi/play/ep21495",
        printedUrl: "https://upos-sz-mirror.bilivideo.com/x.m4s?deadline=1",
      }),
    ).toBe("https://www.bilibili.com/bangumi/play/ep21495");
  });

  test("a single-video source is its own fallback, keeping the anthology page", () => {
    expect(
      resolveListingVideoUrl({ id: "BV1af4y1H7ga_p3", provider: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1af4y1H7ga" }),
    ).toBe("https://www.bilibili.com/video/BV1af4y1H7ga?p=3");
    expect(
      resolveListingVideoUrl({ id: "BV1af4y1H7ga_p2", provider: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1af4y1H7ga?p=2" }),
    ).toBe("https://www.bilibili.com/video/BV1af4y1H7ga?p=2");
  });

  test("ids alone rebuild the URL, with the source deciding what a number means", () => {
    expect(resolveListingVideoUrl({ id: "BV1xx411c7mD", provider: "bilibili", sourceUrl: "https://space.bilibili.com/1/favlist?fid=2" }))
      .toBe("https://www.bilibili.com/video/BV1xx411c7mD");
    expect(resolveListingVideoUrl({ id: "21495", provider: "bilibili", sourceUrl: "https://www.bilibili.com/bangumi/play/ss26801" }))
      .toBe("https://www.bilibili.com/bangumi/play/ep21495");
    expect(resolveListingVideoUrl({ id: "229832", provider: "bilibili", sourceUrl: "https://www.bilibili.com/cheese/play/ss5918" }))
      .toBe("https://www.bilibili.com/cheese/play/ep229832");
    // An ambiguous number with no usable context: the source is the last resort
    // rather than a fabricated video URL.
    expect(resolveListingVideoUrl({ id: "21495", provider: "bilibili", sourceUrl: "https://space.bilibili.com/1/video" }))
      .toBe("https://space.bilibili.com/1/video");
  });

  test("YouTube behaviour is exactly what it always was", () => {
    expect(resolveListingVideoUrl({ id: "dQw4w9WgXcQ", provider: "youtube", printedUrl: "dQw4w9WgXcQ" }))
      .toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(
      resolveListingVideoUrl({
        id: "scan001",
        provider: "youtube",
        sourceUrl: "https://www.youtube.com/playlist?list=PL_saved",
        webpageUrl: "NA",
        printedUrl: "NA",
      }),
    ).toBe("https://www.youtube.com/watch?v=scan001");
  });
});

describe("videoUrlForId", () => {
  test("builds each provider's page URL from an id", () => {
    expect(videoUrlForId("youtube", "AbCdEf12345")).toBe("https://www.youtube.com/watch?v=AbCdEf12345");
    expect(videoUrlForId("bilibili", "BV1xx411c7mD")).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
    expect(videoUrlForId("bilibili", "BV1xx411c7mD_p7")).toBe("https://www.bilibili.com/video/BV1xx411c7mD?p=7");
    expect(videoUrlForId("bilibili", "av170001")).toBe("https://www.bilibili.com/video/av170001");
    expect(videoUrlForId("bilibili", "au123")).toBe("https://www.bilibili.com/audio/au123");
    expect(videoUrlForId("bilibili", "21495", "https://www.bilibili.com/bangumi/play/ss26801"))
      .toBe("https://www.bilibili.com/bangumi/play/ep21495");
    expect(videoUrlForId("bilibili", "21495")).toBeNull();
    expect(videoUrlForId("youtube", "")).toBeNull();
  });
});

describe("channelFolderFallback", () => {
  test("a Bilibili space gets its own folder instead of Single Videos", () => {
    expect(channelFolderFallback("https://space.bilibili.com/3985676/video")).toBe("Bilibili UP 3985676");
    expect(channelFolderFallback("https://space.bilibili.com/3985676")).toBe("Bilibili UP 3985676");
    expect(channelFolderFallback("https://space.bilibili.com/313580179/upload/audio")).toBe("Bilibili UP 313580179 Audio");
  });

  test("everything else keeps the historical fallback", () => {
    expect(channelFolderFallback("https://www.youtube.com/@Teacher")).toBe("");
    expect(channelFolderFallback("https://www.bilibili.com/bangumi/play/ss26801")).toBe("");
    expect(channelFolderFallback("")).toBe("");
    expect(channelFolderFallback("not a url")).toBe("");
  });
});

describe("probe hosts follow the sites actually in use", () => {
  test("cookie probes cover every configured provider and always end with YouTube", () => {
    expect(cookieProbeUrls([])).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    expect(cookieProbeUrls(["https://space.bilibili.com/1/video"])).toEqual([
      "https://www.bilibili.com/video/BV1GJ411x7h7",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
    expect(cookieProbeUrls(["https://youtu.be/AbCdEf12345", "https://www.bilibili.com/video/BV1xx411c7mD"])).toEqual([
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.bilibili.com/video/BV1GJ411x7h7",
    ]);
  });

  test("the network monitor probes a configured site first, then the rest", () => {
    const bilibiliFirst = networkProbeUrls(["https://space.bilibili.com/1/video"]);
    expect(bilibiliFirst[0]).toBe("https://www.bilibili.com/favicon.ico");
    expect(bilibiliFirst).toContain("https://www.youtube.com/favicon.ico");
    expect(bilibiliFirst).toContain("https://1.1.1.1");

    const defaultOrder = networkProbeUrls([]);
    expect(defaultOrder[0]).toBe("https://www.youtube.com/favicon.ico");
    expect(defaultOrder[defaultOrder.length - 1]).toBe("https://cloudflare.com/cdn-cgi/trace");
    expect(new Set(defaultOrder).size).toBe(defaultOrder.length);
  });
});
