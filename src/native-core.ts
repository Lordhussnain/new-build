// src/native-core.ts — optional Rust N-API bridge.
//
// Native calls are synchronous and limited to CPU-only validation, parsing and
// planning jobs. Subprocesses, filesystem work, SQLite and cookie orchestration
// stay in Bun so they never block the event loop behind a native call.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_ABI_VERSION = 4;

export interface NativeCore {
  abiVersion(): number;
  validateConfig(raw: string): string;
  defaultConfig(): string;
  prepareSettings(current: string, patch: string, fields: string): string;
  parseSourceUrl(input: string, singleVideo: boolean): string;
  parseSourceUrls(inputs: string, singleVideo: boolean): string;
  sourceIdentity(input: string): string;
  parseOfflineSwitch(raw: string): string;
  offlineOverride(argv: string, env: string): string;
  lanOverride(argv: string, env: string): string;
  webPortOverride(argv: string): string;
  webTokenOverride(argv: string): string;
  toolCandidates(request: string): string;
  bunInterpreterPath(execPath: string): string;
  extractAudioTracks(info: string): string;
  selectAudioTracks(request: string): string;
  multiAudioFormatSelector(baseFormat: string, tracks: string): string;
  parseDownloadPath(line: string): string;
  parseAria2cReadout(line: string): string;
  nextSlotTarget(input: string): string;
  perDownloadTransfers(configured: number, activeSlots: number, budget: number): string;
  parseAria2cSplitSizeBytes(size: string): string;
  retryClassification(message: string): string;
  formatTerminalErrorMessage(info: string, raw: string): string;
  parseStoredTerminalError(message: string): string;
  nextFormatFallback(current: string): string;
  formatSwitchMessage(from: string, to: string): string;
  computeBackoffMs(attempt: number, baseSeconds: number, maxSeconds: number, random: number): string;
  computeDownloadTimeoutMs(durationSeconds: number, minMinutes: number, maxMinutes: number): string;
  progressAwareRetryState(retryCount: number, bestProgress: number, progress: number, retryCap: number): string;
  claimColumns(stage: string): string;
  claimRef(stage: string, row: string): string;
  claimUpdateSql(stage: string, setClause: string, extraCondition?: string): string;
  claimReleaseSet(stage: string, setClause: string): string;
  perVideoCap(config: string): string;
  leaseExpired(lease: string, expiresAtMs: number, nowMs: number): string;
  holdsLease(lease: string, currentLease: string, expiresAtMs: number, nowMs: number): string;
  leaseAcquisition(lease: string, owner: string, expiresAtMs: number, nowMs: number, ownerGone: boolean): string;
  staleClaimThresholds(maxDownloadMinutes: number): string;
  staleClaimCondition(stage: string, modifier: string, alias: string): string;
  partialSidecars(partialPath: string): string;
  partialCleanupDecision(request: string): string;
  orphanCleanupDecision(ageMs: number, maxAgeMs: number, owned: boolean, belongsToActiveJob: boolean): string;
  requeueCooldownModifier(minutes: number, ignoreCooldown: boolean): string;
  resolveDownloaderEngine(useAria2c: boolean, aria2cAvailable: boolean): string;
  effectiveDownloadFormat(jobQuality: string | null, jobTarget: string | null, configQuality: string, configTarget: string, validQualities: string): string;
  buildAria2cArgs(connectionsPerDownload: number, activeSlots: number, connectionBudget: number, split: string): string;
  computePerWorkerLimitBytesPerSec(maxBandwidthKBps: number, activeSlots: number): string;
  parseListingLines(lines: string): string;
  listingEntryKind(id: string): string;
  channelFolderName(playlist: string, channel?: string): string;
  isShortsTabItem(playlist: string): string;
  normalizeVideoUrl(url: string): string;
  prepareIngestBatch(request: string): string;
  parseArchiveIds(text: string): string;
  removeArchiveId(text: string, videoId: string): string;
}

export const NATIVE_CORE_METHODS = [
  "abiVersion",
  "validateConfig",
  "defaultConfig",
  "prepareSettings",
  "parseSourceUrl",
  "parseSourceUrls",
  "sourceIdentity",
  "parseOfflineSwitch",
  "offlineOverride",
  "lanOverride",
  "webPortOverride",
  "webTokenOverride",
  "toolCandidates",
  "bunInterpreterPath",
  "extractAudioTracks",
  "selectAudioTracks",
  "multiAudioFormatSelector",
  "parseDownloadPath",
  "parseAria2cReadout",
  "nextSlotTarget",
  "perDownloadTransfers",
  "parseAria2cSplitSizeBytes",
  "retryClassification",
  "formatTerminalErrorMessage",
  "parseStoredTerminalError",
  "nextFormatFallback",
  "formatSwitchMessage",
  "computeBackoffMs",
  "computeDownloadTimeoutMs",
  "progressAwareRetryState",
  "claimColumns",
  "claimRef",
  "claimUpdateSql",
  "claimReleaseSet",
  "perVideoCap",
  "leaseExpired",
  "holdsLease",
  "leaseAcquisition",
  "staleClaimThresholds",
  "staleClaimCondition",
  "partialSidecars",
  "partialCleanupDecision",
  "orphanCleanupDecision",
  "requeueCooldownModifier",
  "resolveDownloaderEngine",
  "effectiveDownloadFormat",
  "buildAria2cArgs",
  "computePerWorkerLimitBytesPerSec",
  "parseListingLines",
  "listingEntryKind",
  "channelFolderName",
  "isShortsTabItem",
  "normalizeVideoUrl",
  "prepareIngestBatch",
  "parseArchiveIds",
  "removeArchiveId",
] as const;

export interface NativeIssue {
  code?: string;
  message: string;
  path: (string | number)[];
}

export interface NativeErrorBody {
  code: string;
  message: string;
  path: (string | number)[];
  issues?: NativeIssue[];
}

export type NativeEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: NativeErrorBody };

/** Operational bridge failures stay distinct from rejected user input. */
export class NativeCoreError extends Error {
  code: string;
  path: (string | number)[];
  issues?: NativeIssue[];

  constructor(
    message: string,
    code = "NATIVE_ERROR",
    details: { path?: (string | number)[]; issues?: NativeIssue[] } = {},
  ) {
    super(message);
    this.name = "NativeCoreError";
    this.code = code;
    this.path = details.path ?? [];
    if (details.issues) this.issues = details.issues;
  }
}

export function nativeError(body: NativeErrorBody): NativeCoreError {
  return new NativeCoreError(body.message, body.code, { path: body.path, issues: body.issues });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPath(value: unknown): value is (string | number)[] {
  return Array.isArray(value) && value.every((part) => typeof part === "string" || typeof part === "number");
}

function invalidResponse(detail: string): never {
  throw new NativeCoreError(
    `Rust native core returned an invalid response (${detail})`,
    "NATIVE_INVALID_RESPONSE",
  );
}

/** Validate the wire envelope before any application code trusts its contents. */
export function nativeEnvelope<T>(raw: string): NativeEnvelope<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidResponse("malformed JSON");
  }
  if (!isRecord(parsed)) return invalidResponse("expected an object");
  if (parsed.ok === true) {
    if (!("value" in parsed)) return invalidResponse("missing value");
    return { ok: true, value: parsed.value as T };
  }
  if (parsed.ok !== false || !isRecord(parsed.error)) {
    return invalidResponse("invalid status or error object");
  }
  const error = parsed.error;
  if (
    typeof error.code !== "string" || !error.code ||
    typeof error.message !== "string" ||
    !validPath(error.path)
  ) {
    return invalidResponse("invalid error code, message or path");
  }
  if (error.issues !== undefined) {
    if (!Array.isArray(error.issues) || error.issues.some((issue) =>
      !isRecord(issue) || typeof issue.message !== "string" || !validPath(issue.path) ||
      (issue.code !== undefined && typeof issue.code !== "string")
    )) {
      return invalidResponse("invalid validation issues");
    }
  }
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      path: error.path,
      ...(error.issues ? { issues: error.issues as NativeIssue[] } : {}),
    },
  };
}

/** Unwrap a native response without hiding validation or operational failures. */
export function nativeValue<T>(raw: string): T {
  const response = nativeEnvelope<T>(raw);
  if (!response.ok) throw nativeError(response.error);
  return response.value;
}

export const nativeCoreStatus: {
  available: boolean;
  path: string | null;
  error: string | null;
} = { available: false, path: null, error: null };

function enabledEnvFlag(name: string): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env[name] ?? "");
}

function loadNativeCore(): NativeCore | null {
  const disabled = enabledEnvFlag("YTA_DISABLE_NATIVE");
  const required = enabledEnvFlag("YTA_REQUIRE_NATIVE");
  if (disabled) {
    if (required) {
      throw new NativeCoreError(
        "YTA_REQUIRE_NATIVE and YTA_DISABLE_NATIVE cannot be enabled together",
        "NATIVE_CONFIGURATION",
      );
    }
    return null;
  }

  let require: ReturnType<typeof createRequire> | null = null;
  try {
    require = createRequire(import.meta.url);
  } catch (error: any) {
    nativeCoreStatus.error = `Could not initialize the native loader: ${error?.message || error}`;
  }
  if (!require) {
    if (required) throw new NativeCoreError(nativeCoreStatus.error!, "NATIVE_UNAVAILABLE");
    return null;
  }

  let sourceModule: string | undefined;
  try {
    sourceModule = resolve(dirname(fileURLToPath(import.meta.url)), "../native/yta-core.node");
  } catch (error: any) {
    nativeCoreStatus.error = `Could not locate the source native module: ${error?.message || error}`;
  }
  // An explicit operator-selected binary is authoritative: never replace a bad
  // one with a different module. Automatic lookup is limited to the installed
  // source tree and the executable sidecar, not an attacker-controlled cwd.
  const explicitModule = process.env.YTA_NATIVE_CORE ? resolve(process.env.YTA_NATIVE_CORE) : undefined;
  const candidates: (string | undefined)[] = explicitModule
    ? [explicitModule]
    : [sourceModule, resolve(dirname(process.execPath), "yta-core.node")];
  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) continue;
    tried.add(candidate);
    if (!existsSync(candidate)) continue;
    try {
      const loaded = require(candidate) as NativeCore;
      for (const method of NATIVE_CORE_METHODS) {
        if (typeof loaded[method] !== "function") {
          throw new Error(`missing native method ${method}`);
        }
      }
      const abi = loaded.abiVersion();
      if (abi !== NATIVE_ABI_VERSION) {
        throw new Error(`incompatible ABI ${abi}; expected ${NATIVE_ABI_VERSION}`);
      }
      nativeCoreStatus.path = candidate;
      nativeCoreStatus.error = null;
      return loaded;
    } catch (error: any) {
      nativeCoreStatus.error = `${candidate}: ${error?.message || error}`;
    }
  }
  if (required) {
    throw new NativeCoreError(
      nativeCoreStatus.error ?? "No compatible Rust native core was found",
      "NATIVE_UNAVAILABLE",
    );
  }
  return null;
}

export const nativeCore = loadNativeCore();
nativeCoreStatus.available = nativeCore !== null;
