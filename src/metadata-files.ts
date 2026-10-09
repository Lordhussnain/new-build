// src/metadata-files.ts — identify metadata sidecars beside a downloaded file.

import { SIDECAR_SUFFIXES } from "./util";

export type MetadataKind = "subtitles" | "thumbnail" | "description" | "infoJson";

export const METADATA_KIND_SUFFIXES: Record<MetadataKind, readonly string[]> = {
  subtitles: [".vtt", ".srt", ".ass", ".lrc", ".ttml", ".srv1", ".srv2", ".srv3"],
  thumbnail: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
  description: [".description"],
  infoJson: [".info.json"],
};

const SIDECAR_SUFFIXES_LOWER = SIDECAR_SUFFIXES.map((suffix) => suffix.toLowerCase());
const METADATA_KINDS = new Set<string>(Object.keys(METADATA_KIND_SUFFIXES));

/** Return sidecar filenames belonging to this media basename (case-insensitive). */
export function findSidecarFiles(
  directoryEntries: readonly string[],
  mediaBase: string,
  mediaFilename: string,
): string[] {
  const prefix = `${mediaBase}.`.toLowerCase();
  const media = mediaFilename.toLowerCase();
  return directoryEntries.filter((filename) => {
    const lower = filename.toLowerCase();
    return (
      lower !== media &&
      lower.startsWith(prefix) &&
      SIDECAR_SUFFIXES_LOWER.some((suffix) => lower.endsWith(suffix))
    );
  });
}

/** Parse the persisted terminal-unavailable list, ignoring malformed/unknown entries. */
export function parseUnavailableMetadataKinds(value: string | null | undefined): MetadataKind[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((kind): kind is MetadataKind => typeof kind === "string" && METADATA_KINDS.has(kind)))];
  } catch {
    return [];
  }
}

/** Does this media file already have at least one sidecar of this kind? */
export function hasMetadataKind(sidecars: readonly string[], kind: MetadataKind): boolean {
  const suffixes = METADATA_KIND_SUFFIXES[kind];
  return sidecars.some((filename) => {
    const lower = filename.toLowerCase();
    return suffixes.some((suffix) => lower.endsWith(suffix));
  });
}

/** Persist successful attempts that returned without a requested sidecar. */
export function updateUnavailableMetadataKinds(
  sidecars: readonly string[],
  previouslyUnavailable: string | null | undefined,
  attempted: readonly MetadataKind[],
): MetadataKind[] {
  const unavailable = new Set(
    parseUnavailableMetadataKinds(previouslyUnavailable).filter((kind) => !hasMetadataKind(sidecars, kind)),
  );
  for (const kind of attempted) {
    if (!hasMetadataKind(sidecars, kind)) unavailable.add(kind);
  }
  return [...unavailable];
}

/** Which requested sidecar kinds are absent and not already known unavailable at the source? */
export function missingMetadataKinds(
  sidecars: readonly string[],
  requested: Partial<Record<MetadataKind, boolean>>,
  unavailable: readonly MetadataKind[] = [],
): MetadataKind[] {
  return (Object.keys(METADATA_KIND_SUFFIXES) as MetadataKind[]).filter(
    (kind) => requested[kind] && !hasMetadataKind(sidecars, kind) && !unavailable.includes(kind),
  );
}
