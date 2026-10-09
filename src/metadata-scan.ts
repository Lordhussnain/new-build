// src/metadata-scan.ts — find downloaded jobs whose requested metadata sidecars are missing.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { db } from "./db";
import type { Config } from "./config";
import {
  findSidecarFiles,
  missingMetadataKinds,
  parseUnavailableMetadataKinds,
} from "./metadata-files";
import { getConfig } from "./state";

interface DownloadedJob {
  id: string;
  file_path: string | null;
  download_status: string;
  conversion_status: string;
  metadata_status: string;
  metadata_unavailable: string | null;
  want_subtitles: number | null;
  want_thumbnail: number | null;
  want_description: number | null;
}

interface RequestedMetadata {
  subtitles: boolean;
  thumbnail: boolean;
  description: boolean;
  infoJson: boolean;
}

interface ScanCandidate {
  id: string;
  requested: RequestedMetadata;
}

interface CompletedCandidate extends ScanCandidate {
  sidecars: string[];
}

export interface MetadataScanResult {
  /** Downloaded database jobs examined (not the dashboard's 500-row page). */
  scanned: number;
  /** Jobs newly queued for one or more missing metadata sidecars. */
  queued: number;
  /** Jobs already pending metadata work. */
  alreadyQueued: number;
  /** Jobs whose metadata or conversion stage was already running. */
  alreadyRunning: number;
  /** Jobs whose requested metadata files are already present. */
  complete: number;
  /** Jobs with requested sidecars previously confirmed unavailable at the source. */
  sourceUnavailable: number;
  /** Jobs left failed instead of resetting their exhausted metadata retry budget. */
  failed: number;
  /** Downloaded jobs without a recorded media file on disk. */
  missingMedia: number;
  /** Jobs skipped because their output directory could not be read. */
  unreadableDirectories: number;
  /** Jobs with no metadata types enabled by the job or current settings. */
  noMetadataRequested: number;
  /** Jobs removed or changed while the scan was inspecting the filesystem. */
  changedDuringScan: number;
  /** True when offline mode began before queue updates were written. */
  abortedOffline: boolean;
}

function emptyResult(scanned = 0): MetadataScanResult {
  return {
    scanned,
    queued: 0,
    alreadyQueued: 0,
    alreadyRunning: 0,
    complete: 0,
    sourceUnavailable: 0,
    failed: 0,
    missingMedia: 0,
    unreadableDirectories: 0,
    noMetadataRequested: 0,
    changedDuringScan: 0,
    abortedOffline: false,
  };
}

function requestedMetadata(job: DownloadedJob, config: Config): RequestedMetadata {
  return {
    // The per-job flags capture the operator's metadata choices when the job
    // was added (and any later dashboard override); do not silently undo an
    // explicit per-video opt-out using today's global defaults.
    subtitles: job.want_subtitles === null ? config.downloadSubtitles : Boolean(job.want_subtitles),
    thumbnail: job.want_thumbnail === null ? config.writeThumbnail : Boolean(job.want_thumbnail),
    description: job.want_description === null ? config.writeDescription : Boolean(job.want_description),
    infoJson: config.writeInfoJson,
  };
}

function anyRequested(requested: RequestedMetadata): boolean {
  return requested.subtitles || requested.thumbnail || requested.description || requested.infoJson;
}

const WANT_FLAGS_SQL = `
  want_subtitles = CASE WHEN ? THEN 1 ELSE COALESCE(want_subtitles, 0) END,
  want_thumbnail = CASE WHEN ? THEN 1 ELSE COALESCE(want_thumbnail, 0) END,
  want_description = CASE WHEN ? THEN 1 ELSE COALESCE(want_description, 0) END`;

function requestedValues(requested: RequestedMetadata): [number, number, number] {
  return [Number(requested.subtitles), Number(requested.thumbnail), Number(requested.description)];
}

/**
 * Inspect every completed database job on disk and queue only those missing a
 * sidecar type requested by that job or by the current global metadata settings.
 * This does not scan arbitrary files outside archive.db because those files do
 * not necessarily have a recoverable YouTube URL.
 */
export async function scanDownloadedMetadata(config: Config): Promise<MetadataScanResult> {
  const jobs = db
    .query(
      `SELECT id, file_path, download_status, conversion_status, metadata_status,
              metadata_unavailable, want_subtitles, want_thumbnail, want_description
         FROM jobs
        WHERE download_status = 'downloaded'
        ORDER BY created_at, rowid`,
    )
    .all() as DownloadedJob[];
  const result = emptyResult(jobs.length);
  if (config.offlineMode || getConfig().offlineMode) {
    result.abortedOffline = true;
    return result;
  }
  if (jobs.length === 0) return result;

  // Many playlist jobs share an output directory; read it once per scan.
  const directoryCache = new Map<string, Promise<string[] | null>>();
  const entriesFor = (directory: string): Promise<string[] | null> => {
    let entries = directoryCache.get(directory);
    if (!entries) {
      entries = readdir(directory).catch(() => null);
      directoryCache.set(directory, entries);
    }
    return entries;
  };

  const toQueue: ScanCandidate[] = [];
  const alreadyComplete: CompletedCandidate[] = [];

  for (const job of jobs) {
    if (job.metadata_status === "in_progress" || job.conversion_status === "in_progress") {
      result.alreadyRunning++;
      continue;
    }
    if (!job.file_path || !existsSync(job.file_path)) {
      result.missingMedia++;
      continue;
    }

    const requested = requestedMetadata(job, config);
    if (!anyRequested(requested)) {
      result.noMetadataRequested++;
      continue;
    }

    const directory = dirname(job.file_path);
    const entries = await entriesFor(directory);
    if (!entries) {
      result.unreadableDirectories++;
      continue;
    }
    const mediaFilename = basename(job.file_path);
    const mediaBase = mediaFilename.replace(/\.[^.]+$/, "");
    const sidecars = findSidecarFiles(entries, mediaBase, mediaFilename);
    const unavailable = parseUnavailableMetadataKinds(job.metadata_unavailable);
    const missing = missingMetadataKinds(sidecars, requested);
    const retryableMissing = missingMetadataKinds(sidecars, requested, unavailable);
    if (missing.length > 0 && job.metadata_status === "failed") {
      // A bulk scan must not reset an exhausted retry budget. The per-job
      // sidecar control is the explicit retry action for a failed metadata pass.
      result.failed++;
      continue;
    }
    if (retryableMissing.length > 0) {
      toQueue.push({ id: job.id, requested });
    } else if (missing.length > 0) {
      if (job.metadata_status === "pending") result.alreadyQueued++;
      else result.sourceUnavailable++;
    } else if (job.metadata_status === "pending") {
      result.alreadyQueued++;
    } else {
      alreadyComplete.push({ id: job.id, requested, sidecars });
    }
  }

  // A live offline toggle during directory inspection must not rewrite queue
  // state. The metadata worker will remain idle until the operator comes online.
  if (config.offlineMode || getConfig().offlineMode) {
    result.abortedOffline = true;
    return result;
  }

  const updateQueue = db.transaction((candidates: ScanCandidate[], complete: CompletedCandidate[]) => {
    const select = db.query(
      `SELECT download_status, conversion_status, metadata_status FROM jobs WHERE id = ?`,
    );
    const queue = db.prepare(
      `UPDATE jobs SET ${WANT_FLAGS_SQL},
         metadata_status = 'pending',
         metadata_retry_count = CASE WHEN metadata_status = 'pending' THEN COALESCE(metadata_retry_count, 0) ELSE 0 END,
         metadata_claimed_by = NULL, metadata_claimed_at = NULL,
         metadata_claim_token = NULL, metadata_heartbeat_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );
    const markComplete = db.prepare(
      `UPDATE jobs SET ${WANT_FLAGS_SQL}, metadata_status = 'done', metadata_files = ?,
         metadata_unavailable = '[]', metadata_retry_count = 0,
         metadata_claimed_by = NULL, metadata_claimed_at = NULL,
         metadata_claim_token = NULL, metadata_heartbeat_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );

    for (const candidate of candidates) {
      const current = select.get(candidate.id) as
        | { download_status: string; conversion_status: string; metadata_status: string }
        | null;
      if (!current || current.download_status !== "downloaded") {
        result.changedDuringScan++;
        continue;
      }
      if (current.metadata_status === "in_progress" || current.conversion_status === "in_progress") {
        result.alreadyRunning++;
        continue;
      }
      if (current.metadata_status === "failed") {
        result.failed++;
        continue;
      }
      if (current.metadata_status === "pending") result.alreadyQueued++;
      else result.queued++;
      queue.run(...requestedValues(candidate.requested), candidate.id);
    }

    for (const candidate of complete) {
      const current = select.get(candidate.id) as
        | { download_status: string; conversion_status: string; metadata_status: string }
        | null;
      if (!current || current.download_status !== "downloaded") {
        result.changedDuringScan++;
        continue;
      }
      if (current.metadata_status === "in_progress" || current.conversion_status === "in_progress") {
        result.alreadyRunning++;
        continue;
      }
      if (current.metadata_status === "pending") {
        result.alreadyQueued++;
        continue;
      }
      const update = markComplete.run(
        ...requestedValues(candidate.requested),
        JSON.stringify(candidate.sidecars),
        candidate.id,
      );
      if (update.changes === 1) result.complete++;
    }
  });
  updateQueue(toQueue, alreadyComplete);
  return result;
}
