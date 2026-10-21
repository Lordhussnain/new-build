// src/media-embed.ts — the container-aware ffmpeg arguments that mux subtitle
// tracks and cover art into a finished media file.
//
// Why this exists: yt-dlp's `--embed-subs` / `--embed-thumbnail` act on the
// file yt-dlp just wrote. This engine then remuxes that file into the requested
// container, and the old remux mapped only `0:v:0` + `0:a`, so every embedded
// subtitle track was dropped and so was the cover art (an MKV thumbnail is an
// *attachment* or an attached-pic stream, neither of which a plain video/audio
// map carries). Embedding is therefore done HERE, in one deterministic pass,
// with `-c copy` for video — no re-encode, no dependency on postprocessor order.
//
// Pure module (no spawning): the converter probes the source with ffmpeg and
// passes the parsed stream list in, so the argument contract is unit-testable.

import { iso639_2 } from "./subtitles";

export interface MediaStreamProbe {
  /** Video streams that are NOT attached pictures (the real picture). */
  videoStreams: number;
  audioStreams: number;
  subtitleStreams: number;
  /** Matroska attachments (fonts, cover.jpg). */
  attachmentStreams: number;
  /** A cover-art video stream (`disposition:attached_pic`, mp4/mkv/mp3). */
  hasAttachedPicture: boolean;
  /** A Matroska attachment named cover.* — how yt-dlp embeds into MKV. */
  hasCoverAttachment: boolean;
}

export const EMPTY_MEDIA_PROBE: MediaStreamProbe = {
  videoStreams: 0,
  audioStreams: 0,
  subtitleStreams: 0,
  attachmentStreams: 0,
  hasAttachedPicture: false,
  hasCoverAttachment: false,
};

/**
 * Parse the stream list from ffmpeg's `-i` banner.
 *
 * Real lines look like:
 *   Stream #0:2(eng): Subtitle: subrip (srt)
 *   Stream #0:3: Video: mjpeg (Baseline), 320x180 (attached pic)
 *   Stream #0:4: Attachment: cover.jpg
 */
export function parseMediaStreamProbe(banner: string): MediaStreamProbe {
  const probe: MediaStreamProbe = { ...EMPTY_MEDIA_PROBE };
  const streamLine = /^\s*Stream #\d+:\d+(?:\([^)]*\))?:\s*(Video|Audio|Subtitle|Attachment|Data):/i;
  for (const line of banner.split(/\r?\n/)) {
    const match = line.match(streamLine);
    if (!match) continue;
    switch (match[1].toLowerCase()) {
      case "video":
        if (/\(attached pic\)/i.test(line)) probe.hasAttachedPicture = true;
        else probe.videoStreams++;
        break;
      case "audio":
        probe.audioStreams++;
        break;
      case "subtitle":
        probe.subtitleStreams++;
        break;
      case "attachment":
        probe.attachmentStreams++;
        if (/attachment:\s*cover\b/i.test(line)) probe.hasCoverAttachment = true;
        break;
    }
  }
  return probe;
}

/** Containers that can carry subtitle tracks, and the codec ffmpeg needs. */
export function subtitleCodecFor(container: string): string | null {
  switch (container) {
    case "mp4":
      return "mov_text";
    case "webm":
      return "webvtt";
    case "mkv":
      return "copy";
    default:
      return null;
  }
}

/** Containers that can carry cover art. WebM cannot. */
export function supportsCoverArt(container: string): boolean {
  return container === "mp4" || container === "mkv" || container === "m4a" || container === "mp3";
}

export interface SubtitleEmbedInput {
  path: string;
  language: string | null;
}

export interface RemuxInput {
  sourcePath: string;
  /** Temp destination: the caller renames it into place only on success. */
  outputPath: string;
  container: string;
  probe: MediaStreamProbe;
  /** Sidecar subtitle files to mux in. An empty list keeps what the source has. */
  subtitles: readonly SubtitleEmbedInput[];
  /** Normalised `.jpg` cover art, or null to keep whatever the source has. */
  coverPath: string | null;
}

/**
 * The full ffmpeg argv (without the binary) for the post-download remux:
 * target container, embedded subtitle sidecars, cover art, chapters and tags.
 *
 * Stream rules:
 *  - a sidecar subtitle set is authoritative — existing subtitle tracks are
 *    dropped and re-added, so a retried embed can never duplicate languages;
 *  - a sidecar cover replaces the source's art; otherwise the source's cover
 *    (attached-pic stream or MKV attachment) is carried over;
 *  - video and audio are stream-copied (mp4 audio becomes AAC, as before).
 */
export function buildRemuxArgs(input: RemuxInput): string[] {
  const { sourcePath, outputPath, container, probe, coverPath } = input;
  const subtitleCodec = subtitleCodecFor(container);
  const subtitleInputs = subtitleCodec ? input.subtitles : [];

  const args = ["-y", "-i", sourcePath];
  for (const sub of subtitleInputs) args.push("-i", sub.path);
  const coverInput = 1 + subtitleInputs.length;
  const addCover = Boolean(coverPath) && supportsCoverArt(container);
  if (addCover) args.push("-i", coverPath!);

  // Keep the source's own subtitles only when no sidecar set replaces them.
  const keepSourceSubtitles = subtitleInputs.length === 0 && probe.subtitleStreams > 0;
  // A cover the target cannot store would make ffmpeg fail (WebM), so it is
  // dropped there instead of being mapped.
  const keepSourceCover =
    !addCover && (supportsCoverArt(container) || !probe.hasAttachedPicture);

  args.push("-map", keepSourceCover ? "0:v?" : "0:V?");
  args.push("-map", "0:a?");
  if (keepSourceSubtitles) args.push("-map", "0:s?");
  // MKV attachments (fonts, embedded cover) survive only when no fresh cover
  // replaces the embedded one.
  if (container === "mkv" && !addCover && probe.attachmentStreams > 0) {
    args.push("-map", "0:t?");
  }
  if (addCover) {
    args.push("-map", `${coverInput}:v`);
    args.push("-disposition:v:" + probe.videoStreams, "attached_pic");
  }
  subtitleInputs.forEach((_, index) => {
    args.push("-map", `${1 + index}:s:0`);
  });
  subtitleInputs.forEach((sub, index) => {
    const language = iso639_2(sub.language);
    if (language !== "und") args.push(`-metadata:s:s:${index}`, `language=${language}`);
  });

  args.push("-c:v", "copy");
  args.push("-c:a", container === "mp4" ? "aac" : "copy");
  if (subtitleCodec && (keepSourceSubtitles || subtitleInputs.length > 0)) {
    args.push("-c:s", subtitleCodec);
  }
  args.push("-map_metadata", "0", "-map_chapters", "0");
  if (container === "mp4") args.push("-movflags", "+faststart");
  args.push(outputPath);
  return args;
}

export interface Mp3Input {
  sourcePath: string;
  outputPath: string;
  probe: MediaStreamProbe;
  /** Normalised `.jpg` cover art, or null to keep the source's own. */
  coverPath: string | null;
}

/**
 * MP3 transcode argv. The old command used `-vn`, which silently threw away
 * the cover art yt-dlp had embedded; the cover is now carried (or added) as
 * the ID3 attached picture.
 */
export function buildMp3Args(input: Mp3Input): string[] {
  const { sourcePath, outputPath, probe, coverPath } = input;
  const args = ["-y", "-i", sourcePath, "-map", "0:a:0"];
  if (coverPath) {
    args.push("-i", coverPath, "-map", "1:v");
  } else if (probe.hasAttachedPicture) {
    args.push("-map", "0:v:0?");
  }
  if (coverPath || probe.hasAttachedPicture) {
    args.push("-c:v", "copy", "-disposition:v:0", "attached_pic");
  }
  args.push(
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    "-map_metadata",
    "0",
    "-id3v2_version",
    "3",
    outputPath,
  );
  return args;
}

/** ffmpeg needs a JPEG/PNG for cover art in every container we write. */
export function coverNeedsJpeg(coverPath: string): boolean {
  return !/\.(?:jpe?g)$/i.test(coverPath);
}

/** argv (without the binary) that normalises any image to a single JPEG frame. */
export function coverToJpegArgs(sourcePath: string, outputPath: string): string[] {
  return ["-y", "-i", sourcePath, "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", outputPath];
}
