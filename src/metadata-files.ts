// src/metadata-files.ts — identify metadata sidecars beside a downloaded file.

import { NativeCoreError, nativeCore, nativeValue } from "./native-core";
import { SIDECAR_SUFFIXES } from "./util";

export type MetadataKind = "subtitles" | "thumbnail" | "description" | "infoJson";

export const METADATA_KIND_SUFFIXES: Record<MetadataKind, readonly string[]> = {
  subtitles: [".vtt", ".srt", ".ass", ".lrc", ".ttml", ".srv1", ".srv2", ".srv3"],
  thumbnail: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
  description: [".description"],
  infoJson: [".info.json"],
};

const SIDECAR_SUFFIXES_LOWER = SIDECAR_SUFFIXES.map((suffix) => suffix.toLowerCase());
const METADATA_KIND_LIST = Object.keys(METADATA_KIND_SUFFIXES) as MetadataKind[];
const METADATA_KINDS = new Set<string>(METADATA_KIND_LIST);

function invalidNativeMetadataResult(detail: string): never {
  throw new NativeCoreError(
    `Rust native core returned an invalid metadata result (${detail})`,
    "NATIVE_INVALID_RESPONSE",
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return invalidNativeMetadataResult("expected a string array");
  }
  return value;
}

function metadataKindArray(value: unknown): MetadataKind[] {
  const kinds = stringArray(value);
  if (kinds.some((kind) => !METADATA_KINDS.has(kind))) {
    return invalidNativeMetadataResult("unknown metadata kind");
  }
  return kinds as MetadataKind[];
}

function findSidecarFilesTypeScript(
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

/** Return sidecar filenames belonging to this media basename (case-insensitive). */
export function findSidecarFiles(
  directoryEntries: readonly string[],
  mediaBase: string,
  mediaFilename: string,
): string[] {
  if (
    nativeCore && mediaBase.isWellFormed() && mediaFilename.isWellFormed() &&
    directoryEntries.every((filename) => filename.isWellFormed())
  ) {
    return stringArray(nativeValue<unknown>(nativeCore.findSidecarFiles(
      JSON.stringify(directoryEntries),
      mediaBase,
      mediaFilename,
    )));
  }
  return findSidecarFilesTypeScript(directoryEntries, mediaBase, mediaFilename);
}

function parseUnavailableMetadataKindsTypeScript(value: string | null | undefined): MetadataKind[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((kind): kind is MetadataKind => typeof kind === "string" && METADATA_KINDS.has(kind)))];
  } catch {
    return [];
  }
}

// Native storage parsing is used for the canonical arrays this application
// writes. Other JSON (escapes, huge numbers, lone surrogates, inherited oddities)
// stays on JSON.parse so malformed legacy state retains its exact filter behavior.
const CANONICAL_UNAVAILABLE_JSON = /^[ \t\r\n]*\[[ \t\r\n]*(?:"(?:subtitles|thumbnail|description|infoJson)"[ \t\r\n]*(?:,[ \t\r\n]*)?)*\][ \t\r\n]*$/;

/** Parse the persisted terminal-unavailable list, ignoring malformed/unknown entries. */
export function parseUnavailableMetadataKinds(value: string | null | undefined): MetadataKind[] {
  if (!value) return [];
  if (nativeCore && CANONICAL_UNAVAILABLE_JSON.test(value)) {
    return metadataKindArray(nativeValue<unknown>(nativeCore.parseUnavailableMetadataKinds(value)));
  }
  return parseUnavailableMetadataKindsTypeScript(value);
}

function hasMetadataKindTypeScript(sidecars: readonly string[], kind: MetadataKind): boolean {
  const suffixes = METADATA_KIND_SUFFIXES[kind];
  return sidecars.some((filename) => {
    const lower = filename.toLowerCase();
    return suffixes.some((suffix) => lower.endsWith(suffix));
  });
}

/** Does this media file already have at least one sidecar of this kind? */
export function hasMetadataKind(sidecars: readonly string[], kind: MetadataKind): boolean {
  if (
    nativeCore && METADATA_KINDS.has(kind) && sidecars.every((filename) => filename.isWellFormed())
  ) {
    return nativeValue<boolean>(nativeCore.hasMetadataKind(JSON.stringify(sidecars), kind));
  }
  return hasMetadataKindTypeScript(sidecars, kind);
}

function updateUnavailableMetadataKindsTypeScript(
  sidecars: readonly string[],
  previouslyUnavailable: string | null | undefined,
  attempted: readonly MetadataKind[],
): MetadataKind[] {
  const unavailable = new Set(
    parseUnavailableMetadataKindsTypeScript(previouslyUnavailable).filter(
      (kind) => !hasMetadataKindTypeScript(sidecars, kind),
    ),
  );
  for (const kind of attempted) {
    if (!hasMetadataKindTypeScript(sidecars, kind)) unavailable.add(kind);
  }
  return [...unavailable];
}

/** Persist successful attempts that returned without a requested sidecar. */
export function updateUnavailableMetadataKinds(
  sidecars: readonly string[],
  previouslyUnavailable: string | null | undefined,
  attempted: readonly MetadataKind[],
): MetadataKind[] {
  if (
    nativeCore &&
    (!previouslyUnavailable || CANONICAL_UNAVAILABLE_JSON.test(previouslyUnavailable)) &&
    sidecars.every((filename) => filename.isWellFormed()) &&
    attempted.every((kind) => METADATA_KINDS.has(kind))
  ) {
    return metadataKindArray(nativeValue<unknown>(nativeCore.updateUnavailableMetadataKinds(JSON.stringify({
      sidecars,
      previouslyUnavailable,
      attempted,
    }))));
  }
  return updateUnavailableMetadataKindsTypeScript(sidecars, previouslyUnavailable, attempted);
}

function missingMetadataKindsTypeScript(
  sidecars: readonly string[],
  requested: Partial<Record<MetadataKind, boolean>>,
  unavailable: readonly MetadataKind[] = [],
): MetadataKind[] {
  return METADATA_KIND_LIST.filter(
    (kind) => requested[kind] && !hasMetadataKindTypeScript(sidecars, kind) && !unavailable.includes(kind),
  );
}

/** Which requested sidecar kinds are absent and not already known unavailable at the source? */
export function missingMetadataKinds(
  sidecars: readonly string[],
  requested: Partial<Record<MetadataKind, boolean>>,
  unavailable: readonly MetadataKind[] = [],
): MetadataKind[] {
  if (nativeCore) {
    const prototype = Object.getPrototypeOf(requested);
    const ordinaryRequest = prototype === Object.prototype || prototype === null;
    if (
      ordinaryRequest &&
      METADATA_KIND_LIST.every((kind) => requested[kind] === undefined || typeof requested[kind] === "boolean") &&
      sidecars.every((filename) => filename.isWellFormed()) &&
      unavailable.every((kind) => METADATA_KINDS.has(kind))
    ) {
      return metadataKindArray(nativeValue<unknown>(nativeCore.missingMetadataKinds(JSON.stringify({
        sidecars,
        requested,
        unavailable,
      }))));
    }
  }
  return missingMetadataKindsTypeScript(sidecars, requested, unavailable);
}
