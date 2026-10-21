// tests/media-embed.test.ts — the ffmpeg contract that muxes subtitle tracks
// and cover art into the finished media file.
//
// These are the arguments that fix the two failures this module exists for:
// subtitle tracks were never added, and the cover art yt-dlp had embedded was
// dropped by the old `-map 0:v:0 -map 0:a` remux.

import { describe, expect, test } from "bun:test";
import {
  EMPTY_MEDIA_PROBE,
  buildMp3Args,
  buildRemuxArgs,
  coverNeedsJpeg,
  coverToJpegArgs,
  parseMediaStreamProbe,
  subtitleCodecFor,
  supportsCoverArt,
  type MediaStreamProbe,
} from "../src/media-embed";

/** Index of an exact argv pair, e.g. flag(args, "-c:s"). */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function pairs(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === name) out.push(args[i + 1]);
  return out;
}

const probe = (over: Partial<MediaStreamProbe> = {}): MediaStreamProbe => ({ ...EMPTY_MEDIA_PROBE, ...over });

describe("parseMediaStreamProbe", () => {
  test("counts real video/audio/subtitle tracks and MKV attachments", () => {
    const banner = [
      "Input #0, matroska,webm, from 'video.mkv':",
      "  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 1920x1080, 25 fps",
      "  Stream #0:1: Audio: opus, 48000 Hz, stereo, fltp",
      "  Stream #0:2: Audio: opus, 48000 Hz, stereo, fltp",
      "  Stream #0:3(eng): Subtitle: subrip (srt)",
      "  Stream #0:4(spa): Subtitle: ass",
      "  Stream #0:5: Attachment: cover.jpg",
    ].join("\n");
    expect(parseMediaStreamProbe(banner)).toEqual({
      videoStreams: 1,
      audioStreams: 2,
      subtitleStreams: 2,
      attachmentStreams: 1,
      hasAttachedPicture: false,
      hasCoverAttachment: true,
    });
  });

  test("an attached picture is art, not a second video stream", () => {
    const banner = [
      "  Stream #0:0: Video: h264, yuv420p, 1920x1080",
      "  Stream #0:1: Audio: aac, 48000 Hz, stereo",
      "  Stream #0:2: Video: mjpeg (Baseline), yuvj420p(pc), 320x180 (attached pic)",
    ].join("\n");
    const parsed = parseMediaStreamProbe(banner);
    expect(parsed.videoStreams).toBe(1);
    expect(parsed.hasAttachedPicture).toBe(true);
  });

  test("an unreadable banner is an empty probe, never a crash", () => {
    expect(parseMediaStreamProbe("video.mp4: No such file or directory")).toEqual(EMPTY_MEDIA_PROBE);
  });
});

describe("container capabilities", () => {
  test("mp4 gets mov_text, mkv copies, webm gets webvtt", () => {
    expect(subtitleCodecFor("mp4")).toBe("mov_text");
    expect(subtitleCodecFor("mkv")).toBe("copy");
    expect(subtitleCodecFor("webm")).toBe("webvtt");
    expect(subtitleCodecFor("mp3")).toBeNull();
  });

  test("webm cannot carry cover art", () => {
    expect(supportsCoverArt("mp4")).toBe(true);
    expect(supportsCoverArt("mkv")).toBe(true);
    expect(supportsCoverArt("mp3")).toBe(true);
    expect(supportsCoverArt("webm")).toBe(false);
  });
});

describe("buildRemuxArgs", () => {
  test("adds subtitle sidecars and cover art while remuxing mkv → mp4", () => {
    const args = buildRemuxArgs({
      sourcePath: "in.mkv",
      outputPath: "out.mp4",
      container: "mp4",
      probe: probe({ videoStreams: 1, audioStreams: 2 }),
      subtitles: [
        { path: "001.en.srt", language: "en" },
        { path: "001.es.srt", language: "es" },
      ],
      coverPath: "001.jpg",
    });

    // Source streams (cover excluded: the sidecar replaces it).
    expect(pairs(args, "-map")).toEqual(["0:V?", "0:a?", "3:v", "1:s:0", "2:s:0"]);
    expect(flagValue(args, "-c:v")).toBe("copy");
    expect(flagValue(args, "-c:a")).toBe("aac");
    expect(flagValue(args, "-c:s")).toBe("mov_text");
    expect(args).toContain("-movflags");
    // Language tags in ISO 639-2, which is what players display.
    expect(args).toContain("-metadata:s:s:0");
    expect(args).toContain("language=eng");
    expect(args).toContain("language=spa");
    // The cover is the second output video stream (after the real video).
    expect(args).toContain("-disposition:v:1");
    expect(args).toContain("attached_pic");
    expect(args.at(-1)).toBe("out.mp4");
  });

  test("a sidecar set is authoritative: existing subtitle tracks are replaced", () => {
    const args = buildRemuxArgs({
      sourcePath: "in.mp4",
      outputPath: "out.mp4",
      container: "mp4",
      probe: probe({ videoStreams: 1, subtitleStreams: 2 }),
      subtitles: [{ path: "001.en.srt", language: "en" }],
      coverPath: null,
    });
    // No `0:s?`: the file's own tracks would duplicate the sidecar language.
    expect(pairs(args, "-map")).toEqual(["0:v?", "0:a?", "1:s:0"]);
  });

  test("without subtitles the source's own tracks are preserved", () => {
    const args = buildRemuxArgs({
      sourcePath: "in.mkv",
      outputPath: "out.mp4",
      container: "mp4",
      probe: probe({ videoStreams: 1, subtitleStreams: 1 }),
      subtitles: [],
      coverPath: null,
    });
    expect(pairs(args, "-map")).toEqual(["0:v?", "0:a?", "0:s?"]);
    expect(flagValue(args, "-c:s")).toBe("mov_text");
  });

  test("keeps the source's attached picture when no new cover is supplied", () => {
    const args = buildRemuxArgs({
      sourcePath: "in.mp4",
      outputPath: "out.mp4",
      container: "mp4",
      probe: probe({ videoStreams: 1, hasAttachedPicture: true }),
      subtitles: [],
      coverPath: null,
    });
    expect(pairs(args, "-map")).toEqual(["0:v?", "0:a?"]);
    expect(args).not.toContain("-disposition:v:1");
  });

  test("MKV attachments travel with an mkv → mkv remux", () => {
    const args = buildRemuxArgs({
      sourcePath: "in.mkv",
      outputPath: "out.mkv",
      container: "mkv",
      probe: probe({ videoStreams: 1, attachmentStreams: 1, hasCoverAttachment: true }),
      subtitles: [],
      coverPath: null,
    });
    expect(pairs(args, "-map")).toEqual(["0:v?", "0:a?", "0:t?"]);
    expect(flagValue(args, "-c:s")).toBeUndefined();
  });

  test("webm drops cover art it cannot store, and converts subtitles to webvtt", () => {
    const args = buildRemuxArgs({
      sourcePath: "in.mkv",
      outputPath: "out.webm",
      container: "webm",
      probe: probe({ videoStreams: 1, hasAttachedPicture: true }),
      subtitles: [{ path: "001.en.vtt", language: "en" }],
      coverPath: "001.jpg",
    });
    expect(pairs(args, "-map")).toEqual(["0:V?", "0:a?", "1:s:0"]);
    expect(flagValue(args, "-c:s")).toBe("webvtt");
    expect(args).not.toContain("-disposition:v:1");
  });
});

describe("buildMp3Args", () => {
  test("carries a sidecar cover instead of discarding it with -vn", () => {
    const args = buildMp3Args({
      sourcePath: "in.webm",
      outputPath: "out.mp3",
      probe: probe({ audioStreams: 1 }),
      coverPath: "001.jpg",
    });
    expect(args).toContain("-i");
    expect(pairs(args, "-map")).toEqual(["0:a:0", "1:v"]);
    expect(flagValue(args, "-c:a")).toBe("libmp3lame");
    expect(args).toContain("-disposition:v:0");
    expect(args).toContain("attached_pic");
    expect(args).not.toContain("-vn");
  });

  test("keeps an attached picture the source already has", () => {
    const args = buildMp3Args({
      sourcePath: "in.m4a",
      outputPath: "out.mp3",
      probe: probe({ audioStreams: 1, hasAttachedPicture: true }),
      coverPath: null,
    });
    expect(pairs(args, "-map")).toEqual(["0:a:0", "0:v:0?"]);
    expect(args).toContain("-c:v");
  });

  test("no cover input when there is neither a sidecar nor source art", () => {
    const args = buildMp3Args({
      sourcePath: "in.webm",
      outputPath: "out.mp3",
      probe: probe({ audioStreams: 1 }),
      coverPath: null,
    });
    expect(pairs(args, "-map")).toEqual(["0:a:0"]);
    expect(args).not.toContain("-c:v");
  });
});

describe("cover normalisation", () => {
  test("jpeg is used as-is, other formats are converted to a single mjpeg frame", () => {
    expect(coverNeedsJpeg("001.jpg")).toBe(false);
    expect(coverNeedsJpeg("001.JPEG")).toBe(false);
    expect(coverNeedsJpeg("001.webp")).toBe(true);
    expect(coverNeedsJpeg("001.png")).toBe(true);
    expect(coverToJpegArgs("001.webp", "cover.jpg")).toEqual([
      "-y",
      "-i",
      "001.webp",
      "-frames:v",
      "1",
      "-c:v",
      "mjpeg",
      "-q:v",
      "2",
      "cover.jpg",
    ]);
  });
});
