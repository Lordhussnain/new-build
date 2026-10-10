// src/relocate.ts — moving finished media into secondary storage.
//
// The converter already moves a file as the last step of a conversion. That
// covers "downloaded, then converted, then moved in one go" — but not the files
// that need no conversion at all:
//
//   • a file already in the target format (the converter claims it, finds
//     nothing to encode, and finalizes — fine while a download/conversion is
//     still pending, but nothing ever revisits it once it is 'done');
//   • the whole existing archive on the day `secondaryStoragePath` is set;
//   • a conversion that finished before secondary storage was configured;
//   • a run that died between the copy and the database update.
//
// Offline mode is where that gap hurts most: downloads are off, metadata needs
// the network, so conversion and relocation are the only useful work left. This
// pass is that second half — for every finished job whose media is not (yet)
// recorded under the configured secondary storage root: adopt it if it is
// already there, otherwise move it and record where it went.
//
// Why there is no claim token here, unlike every other pipeline stage:
//   • the engine lease guarantees exactly ONE engine owns `archive.db`
//     (src/lease.ts), and this module keeps exactly one pass in flight per
//     process (see `relocationTick`), so no two movers can ever race each other;
//   • every step is idempotent and converges — `isPathInside` recognises a file
//     that already sits under the root, `jobAwaitingRelocation` re-checks the
//     row before each destructive step (sidecars first, media last, the same
//     order the converter uses), and a crash between the copy and the update is
//     healed by the adoption branch below;
//   • the final update compare-and-swaps on the OLD path, so a job that was
//     re-downloaded, retried, or deleted meanwhile is never pointed at a file
//     this pass did not put there.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  countJobsAwaitingRelocation,
  jobAwaitingRelocation,
  listJobsAwaitingRelocation,
  recordRelocatedFile,
  type RelocationRow,
} from "./db";
import { logError } from "./logger";
import { isPathInside } from "./util";
import { moveToSecondaryStorage } from "./workers/convert";
import { holdsEngineLease } from "./lease";
import { getConfig, isPaused } from "./state";
import type { Config } from "./config";

/**
 * How long a job waits after a failed move before it is tried again. Moving to
 * a NAS that is unplugged/full must not retry every 60 seconds forever, and a
 * per-job backoff keeps one bad destination from starving the rest of the
 * queue. In-memory on purpose: a restart is the operator's signal that the
 * destination is worth another try.
 */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

const failureBackoff = new Map<string, { attempts: number; until: number }>();

/** What one pass did (returned for tests and for the startup/tick summary). */
export interface RelocationReport {
  /** Files moved into secondary storage by this pass. */
  moved: number;
  /** Files that were already there — the database path was corrected. */
  adopted: number;
  /** Files already sitting under the configured root (nothing to do). */
  alreadyThere: number;
  /** Candidates skipped this pass (backoff, or the row changed underneath). */
  skipped: number;
  /** Moves that failed — the source file is untouched and the job retries. */
  failed: number;
}

/** How many files are still waiting to move (0 when no secondary storage is set). */
export function relocationPendingCount(config: Pick<Config, "secondaryStoragePath">): number {
  if (!config.secondaryStoragePath) return 0;
  try {
    return countJobsAwaitingRelocation(config.secondaryStoragePath);
  } catch {
    // The database can be mid-shutdown; a status query must never throw.
    return 0;
  }
}

/** Forget the per-job failure backoff (used by tests after a forced failure). */
export function resetRelocationBackoff(): void {
  failureBackoff.clear();
}

/**
 * One relocation pass: every finished job whose media has to reach secondary
 * storage, oldest first, moved one at a time.
 *
 * Sequential on purpose — the pass is I/O bound, and a single mover per
 * database is what removes the need for claim tokens here.
 */
export async function relocateFinishedJobs(config: Config): Promise<RelocationReport> {
  const report: RelocationReport = { moved: 0, adopted: 0, alreadyThere: 0, skipped: 0, failed: 0 };
  const root = (config.secondaryStoragePath || "").trim();
  // No destination configured: nothing "needs" moving, so the pass is a no-op.
  if (!root) return report;

  let candidates: RelocationRow[];
  try {
    candidates = listJobsAwaitingRelocation(root);
  } catch (e: any) {
    logError("relocation", `could not list files awaiting secondary storage: ${e?.message || e}`);
    return report;
  }

  for (const job of candidates) {
    const now = Date.now();
    if ((failureBackoff.get(job.id)?.until ?? 0) > now) {
      report.skipped++;
      continue;
    }
    // Re-check against the live row: the listed snapshot may be stale (the job
    // could have been deleted, re-downloaded, or already relocated).
    if (!jobAwaitingRelocation(job.id, root)) {
      report.skipped++;
      continue;
    }

    let outcome: "moved" | "adopted" | "already" | "skipped" | "failed";
    try {
      outcome = await relocateOne(job, root);
    } catch (e: any) {
      outcome = "failed";
      logError(
        "relocation",
        `${job.id} ${job.title}: could not move to secondary storage (${e?.message || e}) — the file stays where it is`,
      );
    }

    if (outcome === "failed") {
      report.failed++;
      recordFailure(job.id);
    } else {
      failureBackoff.delete(job.id);
      if (outcome === "moved") report.moved++;
      else if (outcome === "adopted") report.adopted++;
      else if (outcome === "already") report.alreadyThere++;
      else report.skipped++;
    }
  }
  return report;
}

/** Move (or adopt) one job's media and its sidecars. */
async function relocateOne(
  job: RelocationRow,
  root: string,
): Promise<"moved" | "adopted" | "already" | "skipped"> {
  const currentPath = job.file_path;

  if (!existsSync(currentPath)) {
    // Crash-window recovery / hand-moved file: the media is not where the
    // database says it is, but the destination of this very move is exactly
    // where it should be. Adopt that file instead of failing on a path that no
    // longer exists — the alternative is a job that can never finish.
    const expected = join(root, job.folder, basename(currentPath));
    if (!existsSync(expected)) {
      // Nothing was moved by us: a genuinely missing file belongs to
      // reconcileMissingFiles / the download stage, not to relocation.
      return "skipped";
    }
    if (recordRelocatedFile(job.id, currentPath, expected, root) === 0) return "skipped";
    logError("relocation", `${job.id} ${job.title}: file already in secondary storage — adopted ${expected}`);
    return "adopted";
  }

  if (isPathInside(currentPath, root)) {
    // Already under the configured root (moved by hand, or by an engine version
    // that predates `relocated_to`): record it and never move it onto itself.
    recordRelocatedFile(job.id, currentPath, currentPath, root);
    return "already";
  }

  // The converter's own move, reused wholesale: sidecars first in a pinned
  // order, media last, `required` — a media file that cannot land in secondary
  // storage throws instead of reporting success against the wrong path. Every
  // destructive step re-checks that this job still wants moving: a job deleted
  // or re-queued mid-move stops the sequence before the next file is touched.
  const moved = await moveToSecondaryStorage(job, root, currentPath, () =>
    jobAwaitingRelocation(job.id, root),
  );
  if (moved.stopped) return "skipped";
  if (moved.path === currentPath) {
    // The move refused to do anything (destination equals source). Record what
    // we know rather than reporting a move that did not happen.
    recordRelocatedFile(job.id, currentPath, currentPath, root);
    return "already";
  }
  if (recordRelocatedFile(job.id, currentPath, moved.path, root) === 0) {
    // The row changed while the bytes moved — a re-download or a dashboard
    // delete took ownership. The files are in secondary storage; the new state
    // is not ours to overwrite.
    return "skipped";
  }
  return "moved";
}

function recordFailure(jobId: string): void {
  const previous = failureBackoff.get(jobId);
  const attempts = (previous?.attempts ?? 0) + 1;
  const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
  failureBackoff.set(jobId, { attempts, until: Date.now() + delay });
}

// One pass at a time: the interval below must never overlap itself, and a
// second mover inside one process is exactly what the claim-free design
// assumes cannot happen.
let passInFlight = false;

/**
 * Interval driver: run a pass unless one is already running, and report the
 * outcome only when it did something worth a log line.
 */
export async function relocationTick(config: Config = getConfig()): Promise<void> {
  if (passInFlight) return;
  // Paused means paused for every stage, this one included — and that includes
  // the pause an engine-lease loss triggers: another engine may own `archive.db`
  // by then, and two movers are exactly what this pass's claim-free design
  // assumes cannot happen.
  if (isPaused() || !holdsEngineLease()) return;
  passInFlight = true;
  try {
    const report = await relocateFinishedJobs(config);
    const changed = report.moved + report.adopted + report.failed;
    if (changed > 0) {
      const remaining = relocationPendingCount(config);
      console.log(
        `📦 Secondary storage: moved ${report.moved}, adopted ${report.adopted}, failed ${report.failed}${remaining > 0 ? `, ${remaining} still pending` : ""}.`,
      );
    }
  } catch (e: any) {
    logError("relocation", `pass failed: ${e?.stack || e?.message || e}`);
  } finally {
    passInFlight = false;
  }
}

/** How long between two passes. Each pass drains the whole queue it can move. */
const RELOCATION_INTERVAL_MS = 60_000;

/**
 * Start the relocation pass: one shortly after startup (there is no reason to
 * wait a minute for files the operator already queued up), then on an interval.
 *
 * The live config is re-read on every tick, so turning secondary storage on
 * from the dashboard is picked up without a restart.
 */
export function startRelocation(): void {
  const config = getConfig();
  if (config.secondaryStoragePath) {
    const pending = relocationPendingCount(config);
    console.log(
      `📦 Secondary storage: ${config.secondaryStoragePath}${pending > 0 ? ` — ${pending} file(s) waiting to move` : " — nothing pending"}`,
    );
  }
  setTimeout(() => void relocationTick(getConfig()), 5_000);
  const timer = setInterval(() => void relocationTick(getConfig()), RELOCATION_INTERVAL_MS);
  // A timer must never keep a shutting-down process alive.
  (timer as unknown as { unref?: () => void }).unref?.();
}
