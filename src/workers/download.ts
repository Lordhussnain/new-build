// src/workers/download.ts — the resilient download worker.
//
// Pulls videos with yt-dlp and records the result in the job database.
// Everything failure-related is designed around one idea: never lose work
// that has already been done. A failed attempt keeps its .part file, the next
// attempt resumes from it with --continue, and the per-video retry budget only
// shrinks while the video is making no forward progress.

import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { claimDownloadJob, db, perVideoCap, type Job } from "../db";
import { activeDlSlots, autoscaler } from "../autoscale";
import { aria2cPath, aria2cUsable, ytDlp } from "../tools";
import { checkDiskSpace, notePipelineFailure, notePipelineSuccess, triggerPause } from "../resilience";
import { findPartialFile, recordJobPartial, removePartialFiles } from "../reconcile";
import { removeFromArchive } from "../archive";
import {
  computeBackoffMs,
  isDownloaderArgsError,
  isPermanentDownloadError,
  isTransientDownloadError,
  shouldForgiveRetry,
} from "../retry";
import { buildDownloadPlan, jobBaseFilename, validateAria2cSettings } from "../download-args";
import { parseDownloadPath, readProcessOutput } from "../download-output";
import {
  parseSelectionJson,
  parseTracksJson,
  probeAudioTracks,
  selectAudioTracks,
  type AudioTrack,
} from "../audio-tracks";
import { findDownloadedFile, formatBytesPerSec, parseSpeedToBytesPerSec } from "../util";
import { updateAbsoluteLine } from "../dashboard";
import { abortController, activeProcs, getConfig, isPaused, stats, workerStatuses } from "../state";
import { logError } from "../logger";
import type { Config } from "../config";

export const aliveDownloadWorkers = new Set<number>();

export async function downloadWorker(id: number, config: Config): Promise<void> {
  const workerId = `dl-${id}`;
  aliveDownloadWorkers.add(id);
  while (!abortController.signal.aborted) {
    // Re-read the config every iteration so settings changed from the dashboard
    // (POST /api/settings) take effect on the next job without a restart. The
    // parameter is only the initial value.
    config = getConfig();
    if (isPaused()) {
      await Bun.sleep(2000);
      continue;
    }
    // Autoscaling gate: a scaled-down slot's worker idles here instead of
    // claiming work (a job already in flight always runs to completion).
    if (!activeDlSlots.has(id)) {
      await Bun.sleep(1000);
      continue;
    }

    // The claim path runs outside the job try-block: a SQLITE_BUSY throw here
    // must idle the worker, not kill the loop (nothing is claimed yet, so
    // nothing is stranded).
    let disk;
    try {
      disk = await checkDiskSpace(config.outputRoot, config.minFreeSpaceGB);
    } catch (err: any) {
      logError("download", `disk check failed, idling: ${String(err?.message || err).slice(0, 200)}`);
      await Bun.sleep(5000);
      continue;
    }
    if (!disk.ok) {
      triggerPause(`LOW_DISK_SPACE (${disk.free.toFixed(1)}GB < ${config.minFreeSpaceGB}GB)`);
      await Bun.sleep(10000);
      continue;
    }

    let job;
    try {
      job = claimDownloadJob(workerId);
    } catch (err: any) {
      logError("download", `claim failed, idling: ${String(err?.message || err).slice(0, 200)}`);
      await Bun.sleep(5000);
      continue;
    }
    if (!job) {
      await Bun.sleep(500);
      continue;
    }

    try {
      await runDownload(id, job, config);
    } catch (err: any) {
      await handleDownloadFailure(id, job, config, err);
    } finally {
      activeProcs.delete(id);
      autoscaler.clearWorker(id);
    }
  }
  // Loop exited (shutdown): this worker is no longer alive.
  aliveDownloadWorkers.delete(id);
}

/** One download attempt for `job`. Throws on any failure. */
async function runDownload(id: number, job: Job, config: Config): Promise<void> {
  // Multi-audio support: know what the video offers (original + auto-dubbed
  // tracks) and which tracks this job wants, then hand the selection to the
  // plan so every wanted language is downloaded into one switchable file.
  const discovered = await resolveJobAudioTracks(job, config);
  const audioTracks = discovered
    ? selectAudioTracks(
        discovered,
        config.multiAudioMode,
        config.audioTrackLanguages,
        parseSelectionJson(job.audio_selection),
      )
    : [];
  // One plan per attempt: downloader engine, connection/fragment tuning,
  // bandwidth split across the currently active slots, and the watchdog.
  const plan = buildDownloadPlan({
    job,
    config,
    activeSlots: activeDlSlots.size,
    aria2cAvailable: aria2cUsable(),
    aria2cBinary: aria2cPath(),
    audioTracks,
  });
  const { baseFilename, timeoutMs } = plan;
  // A downloader argument aria2c will reject is a global misconfiguration, not
  // a video problem — pause before spawning anything rather than burning this
  // attempt (and its retry budget) to discover it.
  if (plan.engine === "aria2c") {
    const problem = validateAria2cSettings(config);
    if (problem) {
      logError(
        "download",
        `${job.id} ${job.title}: invalid aria2c settings (${problem}) — engine paused, fix the downloader settings and resume`,
      );
      parkPaused(job);
      triggerPause(`BAD_DOWNLOADER_ARGS (${problem})`);
      updateWorkerLine(id, `⚙️ Bad downloader settings — paused | ${job.title}`, config);
      return;
    }
  }
  const engineTag = plan.engine === "aria2c" ? `aria2c×${config.connectionsPerDownload}` : "native";
  const audioTag = audioTracks.length > 0 ? `, ${audioTracks.length} audio track(s)` : "";

  updateWorkerLine(id, `⬇️ Starting [${engineTag}${audioTag}]... | ${job.title}`, config);
  const args = [ytDlp(), ...plan.args];

  let timedOut = false;
  const downloadCtl = new AbortController();
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: downloadCtl.signal });
  activeProcs.set(id, proc);
  const downloadTimer = setTimeout(() => {
    timedOut = true;
    downloadCtl.abort();
  }, timeoutMs);

  let finalFilePath = "";
  let lastProgressUpdate = 0;
  const stdoutPromise = readProcessOutput(proc.stdout, (line) => {
    if (line.startsWith("PROGRESS:")) {
      const parts = line.replace("PROGRESS:", "").split("|");
      const bps = parseSpeedToBytesPerSec(parts[1]);
      if (bps > 0) autoscaler.recordSpeed(id, bps);
      const sizeNum = parseInt(parts[3], 10);
      const dlNum = parseInt(parts[4], 10);
      let pctNum = parseFloat(parts[0]);
      if (Number.isNaN(pctNum) && dlNum > 0 && sizeNum > 0) pctNum = (dlNum / sizeNum) * 100;
      if (!Number.isNaN(pctNum) && pctNum >= 0 && Date.now() - lastProgressUpdate > 500) {
        // Backfill file_size from progress so the global ETA has a total to work with.
        const totalBytes = Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : null;
        // best_progress/best_bytes are the high-water marks of this job's
        // attempts: they let the retry budget forgive repeated failures at
        // increasing completion (see handleDownloadFailure).
        const dlBytes = Number.isFinite(dlNum) && dlNum > 0 ? dlNum : 0;
        updateJobProgress(job.id, pctNum, bps, parseFloat(parts[2]) || 0, totalBytes, dlBytes);
        const speedTxt = bps > 0 ? formatBytesPerSec(bps) : "Calculating...";
        const etaNum = parseFloat(parts[2]);
        const etaTxt = Number.isFinite(etaNum) && etaNum > 0 ? `, ETA ${Math.round(etaNum)}s` : "";
        updateWorkerLine(id, `⬇️ ${pctNum.toFixed(1)}% @ ${speedTxt}${etaTxt} | ${job.title}`, config);
        lastProgressUpdate = Date.now();
      }
    } else {
      const path = parseDownloadPath(line);
      if (path) finalFilePath = path;
    }
  });

  // Drain both pipes concurrently, with bounded tails for error reporting.
  // A native Bun panic cannot be caught in JS, so no arbitrary stdout string
  // reaches existsSync: only a size/control-checked FILEPATH record below.
  let output: [string, string, number];
  try {
    output = await Promise.all([stdoutPromise, readProcessOutput(proc.stderr), proc.exited]);
  } finally {
    clearTimeout(downloadTimer);
    // If a stream/parser failed, don't leave yt-dlp running behind a retry.
    if (proc.exitCode === null) {
      downloadCtl.abort();
      await proc.exited;
    }
    activeProcs.delete(id);
  }
  const [stdoutText, stderrText, code] = output;

  if (isPaused()) {
    parkPaused(job);
    updateWorkerLine(id, `⏸️ Paused | ${job.title}`, config);
    return;
  }

  if (timedOut) throw new Error(`Process timed out (${Math.round(timeoutMs / 60000)}m)`);

  if (code === 0) {
    let filePath = finalFilePath && existsSync(finalFilePath) ? finalFilePath : "";
    if (!filePath) filePath = await findDownloadedFile(job.output_directory, baseFilename);
    if (!filePath) {
      logError("download", `${job.id} exited 0 but the output file could not be located: ${job.title}`);
      throw new Error("Download finished but output file could not be located");
    }
    const fileSize = (await stat(filePath)).size;
    recordSuccess(job.id, filePath, fileSize);
    stats.downloaded++;
    notePipelineSuccess("dl");
    updateWorkerLine(id, `✅ Downloaded | ${job.title}`, config);
  } else {
    // Prefer stderr at the end so stdout progress cannot hide the real error.
    const tail = [stdoutText, stderrText]
      .filter(Boolean)
      .join("\n")
      .split(/[\r\n]+/)
      .filter((l) => l.trim())
      .slice(-4)
      .join(" ");
    throw new Error(tail || `yt-dlp exited with code ${code}`);
  }
}

/**
 * Central failure handler: classifies the error, decides whether the partial
 * file survives, and computes the next state. Precedence order:
 * signature → downloader-args → permanent → corrupt → archive-scrub → live →
 * transient → unknown/budget. The guiding rules:
 *
 *   • transient (network/timeout/5xx)  → requeue with exponential backoff,
 *                                        stamped as next_retry_at so the worker
 *                                        moves on instead of sleeping
 *   • corrupt/incomplete               → keep the partial and resume (bounded
 *                                        by maxResumeAttempts, then restart)
 *   • live stream in "wait for VOD"    → park as waiting_live
 *   • permanent (private/removed/…)    → fail fast: no budget spent, the
 *                                        partial pair is discarded, never
 *                                        auto-requeued, no circuit trip
 *   • unknown errors                   → spend the retry budget with backoff,
 *                                        then park as failed for the sweep
 */
async function handleDownloadFailure(id: number, job: Job, config: Config, err: any): Promise<void> {
  if (isPaused()) {
    parkPaused(job);
    updateWorkerLine(id, `⏸️ Paused | ${job.title}`, config);
    return;
  }

  const errMsg = String(err?.message || err);
  const lower = errMsg.toLowerCase();
  const base = baseNameOf(job);

  // Signature challenge broke (yt-dlp extractor changed) — self-heal by
  // updating yt-dlp, then retry immediately with a clean budget.
  if (lower.includes("signature") || lower.includes("unable to extract")) {
    console.warn("⚠️ Signature challenge failed. Auto-updating yt-dlp...");
    const updateProc = Bun.spawn([ytDlp(), "-U"], { stdout: "pipe", stderr: "pipe" });
    await updateProc.exited;
    resetForRetry(job.id);
    updateWorkerLine(id, `🔄 Auto-updated yt-dlp, retrying... | ${job.title}`, config);
    return;
  }

  // aria2c rejected the command line (exit 28 + the option's help block): a
  // global misconfiguration, not a video problem. Retrying videos cannot fix
  // it — every job would fail identically until the circuit breaker trips —
  // so park this job and pause the engine with an actionable reason.
  if (isDownloaderArgsError(errMsg)) {
    logError(
      "download",
      `${job.id} ${job.title}: aria2c rejected the downloader arguments (exit 28). ` +
        `Check connectionsPerDownload/minSplitSize. ${errMsg.slice(0, 300)}`,
    );
    parkPaused(job);
    triggerPause(`BAD_DOWNLOADER_ARGS (${errMsg.slice(0, 120)})`);
    updateWorkerLine(id, `⚙️ aria2c rejected downloader args — paused | ${job.title}`, config);
    return;
  }

  // Permanent failure: the video is gone or gated and no retry can ever fetch
  // it. Fail fast — spending the retry budget (and the failed-job sweep's
  // attention) on a dead video only delays the videos queued behind it. The
  // partial pair is discarded with it: nothing will ever resume this download.
  // This deliberately does NOT trip the circuit breaker — dead videos are
  // per-video facts, not a systemic outage.
  if (isPermanentDownloadError(errMsg)) {
    const deadPartial =
      job.partial_file_path && existsSync(job.partial_file_path)
        ? job.partial_file_path
        : await findPartialFile(job.output_directory, base);
    if (deadPartial) {
      const removal = await removePartialFiles(deadPartial);
      if (removal.fatal) {
        logError(
          "download",
          `${job.id} ${job.title}: could not discard dead partial (${removal.error}) — left for orphan cleanup`,
        );
      }
    }
    db.run(
      `UPDATE jobs SET download_status = 'failed', partial_file_path = NULL, download_claimed_by = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [errMsg.slice(0, 500), job.id],
    );
    stats.failed++;
    logError("download", `${job.id} ${job.title}: permanent failure, not retrying: ${errMsg.slice(0, 500)}`);
    updateWorkerLine(id, `⛔ Permanent failure (skipped) | ${job.title}`, config);
    return;
  }

  // Corrupt/incomplete partial: delete the .part file so yt-dlp restarts that
  // transfer — but only after the resume budget is spent. Until then we keep
  // the partial and let --continue resume from it.
  if (lower.includes("unable to resume") || lower.includes("incomplete") || lower.includes("corrupt")) {
    const resumeCount = (job.resume_count || 0) + 1;
    const partial =
      job.partial_file_path && existsSync(job.partial_file_path)
        ? job.partial_file_path
        : await findPartialFile(job.output_directory, base);
    if (resumeCount >= Math.max(1, config.maxResumeAttempts) || !partial) {
      // Budget spent (or nothing to resume): throw the partial away and
      // restart this video from scratch. The aria2c control file goes first —
      // stranding it makes aria2c refuse to restart (see removePartialFiles).
      if (partial) {
        const removal = await removePartialFiles(partial);
        if (removal.fatal) {
          // The control file is locked (orphaned aria2c, an antivirus scan).
          // Deleting only the data file now would wedge this video forever,
          // so keep both files, surface exactly what is blocking, and let a
          // later attempt retry once the handle is released.
          const msg = `partial file locked, cannot restart cleanly (${removal.error}). Close the program holding it — usually an orphaned aria2c/ffmpeg or antivirus scanning the download folder.`;
          const lockBackoff = computeBackoffMs(2, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
          db.run(
            `UPDATE jobs SET download_status = 'pending', download_claimed_by = NULL, next_retry_at = ${retryAt(lockBackoff)}, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [msg.slice(0, 500), job.id],
          );
          logError("download", `${job.id} ${job.title}: ${msg}`);
          updateWorkerLine(id, `🔒 Partial locked — will retry | ${job.title}`, config);
          return;
        }
      }
      resetForRetry(job.id, { incrementRetry: true, clearPartial: true });
      updateWorkerLine(id, `🗑️ Restarting from scratch | ${job.title}`, config);
      return;
    }
    // Keep the partial, count the resume attempt, and back off WITHOUT holding
    // this worker: next_retry_at holds the job while the pool drains others.
    const resumeBackoff = computeBackoffMs(resumeCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
    db.run(
      `UPDATE jobs SET download_status = 'pending', resume_count = ?, download_claimed_by = NULL, next_retry_at = ${retryAt(resumeBackoff)}, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [resumeCount, errMsg.slice(0, 500), job.id],
    );
    updateWorkerLine(
      id,
      `⏳ Resuming (attempt ${resumeCount}/${config.maxResumeAttempts}) in ${Math.round(resumeBackoff / 1000)}s | ${job.title}`,
      config,
    );
    return;
  }

  // --download-archive recorded the id but our copy is gone (deleted by
  // hand, moved, or the folder was cleaned). Scrub the id from the archive
  // so yt-dlp will actually download it on the retry.
  if (lower.includes("output file could not be located")) {
    removeFromArchive(config.archiveFile, job.id);
    resetForRetry(job.id, { incrementRetry: true, clearPartial: true });
    updateWorkerLine(id, `Re-downloading (archive entry scrubbed) | ${job.title}`, config);
    return;
  }

  // archiveLiveStreams mode: yt-dlp refused the job because the stream is
  // live right now. Park it until the next full rescan or a manual retry —
  // scans flip waiting_live jobs back to pending once a VOD exists.
  if (lower.includes("does not pass filter") || lower.includes("is live") || lower.includes("live event")) {
    db.run(
      `UPDATE jobs SET download_status = 'waiting_live', download_claimed_by = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [errMsg.slice(0, 500), job.id],
    );
    updateWorkerLine(id, `Live now — waiting for VOD | ${job.title}`, config);
    return;
  }

  // Transient failure: remember where the .part file is so the next attempt
  // can resume from it, then requeue with exponential backoff.
  if (isTransientDownloadError(errMsg)) {
    const partial = await findPartialFile(job.output_directory, base);
    // The retry budget only shrinks while the video makes no forward progress:
    // this attempt's end state is judged against the watermarks from CLAIM time
    // (the live row's watermarks already include this attempt, so comparing
    // against them would never forgive). Bytes back up the percentage for
    // servers that hide the total.
    let partBytes = 0;
    if (partial) {
      try {
        partBytes = (await stat(partial)).size;
      } catch {
        // The partial vanished mid-failure — no byte progress to forgive.
      }
    }
    const { retryCount, bestProgress, progress } = readProgressState(job.id);
    const forgiven = shouldForgiveRetry({
      progress,
      bestProgress: job.best_progress || 0,
      bytes: partBytes,
      bestBytes: job.best_bytes || 0,
    });
    const nextRetry = forgiven ? retryCount : retryCount + 1;
    const backoff = computeBackoffMs(nextRetry, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
    db.run(
      `UPDATE jobs SET download_status = 'pending', retry_count = ?, best_progress = ?, best_bytes = ?,
         partial_file_path = ?, next_retry_at = ${retryAt(backoff)},
         download_claimed_by = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [
        nextRetry,
        Math.max(bestProgress, progress),
        Math.max(job.best_bytes || 0, partBytes),
        partial || null,
        errMsg.slice(0, 500),
        job.id,
      ],
    );
    updateWorkerLine(id, `🌐 Transient error, retrying in ${Math.round(backoff / 1000)}s | ${job.title}`, config);
    return;
  }

  // Unknown error: spend the retry budget with a backoff, then park as failed
  // for the periodic sweep. (Permanent errors fail fast above and never reach
  // the sweep at all.)
  const { retryCount } = readProgressState(job.id);
  const cap = perVideoCap(config);
  const newStatus = retryCount + 1 >= cap ? "failed" : "pending";
  const partial = newStatus === "failed" ? null : await findPartialFile(job.output_directory, base);
  if (newStatus === "failed") {
    db.run(
      `UPDATE jobs SET download_status = 'failed', retry_count = ?, partial_file_path = NULL,
         download_claimed_by = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [retryCount + 1, errMsg.slice(0, 500), job.id],
    );
    stats.failed++;
    logError("download", `${job.id} ${job.title}: ${errMsg.slice(0, 500)}`);
    notePipelineFailure("dl", config);
  } else {
    // Unknown errors used to requeue with no backoff at all: the next claim
    // retried instantly, burning the whole budget in seconds.
    const unknownBackoff = computeBackoffMs(
      retryCount + 1,
      config.retryBackoffBaseSeconds,
      config.retryBackoffMaxSeconds,
    );
    db.run(
      `UPDATE jobs SET download_status = 'pending', retry_count = ?, partial_file_path = ?,
         next_retry_at = ${retryAt(unknownBackoff)}, download_claimed_by = NULL, last_error = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [retryCount + 1, partial || null, errMsg.slice(0, 500), job.id],
    );
  }
  updateWorkerLine(id, `❌ Failed | ${job.title}`, config);
}

/**
 * A `datetime('now', …)` expression scheduling a job's next attempt.
 * Whole seconds — SQLite has no millisecond modifier. The integer is validated
 * here, so the interpolated SQL can never carry user text (same rule as the
 * sweep modifiers in `reconcile.ts`).
 */
function retryAt(backoffMs: number): string {
  const delaySec = Math.max(1, Math.ceil(backoffMs / 1000));
  return `datetime('now', '+${delaySec} seconds')`;
}

// --- small DB helpers --------------------------------------------------------

/**
 * Discover the video's audio tracks once per job (persisted in
 * `jobs.audio_tracks`) so multi-audio selection and the dashboard's track
 * picker know what YouTube offers. Only runs when something will consume the
 * result, and a probe failure never fails the download — we just fall back to
 * the classic single-track plan.
 */
async function resolveJobAudioTracks(job: Job, config: Config): Promise<AudioTrack[] | null> {
  if (config.videoQuality === "audio") return null;
  const known = parseTracksJson(job.audio_tracks);
  if (known) return known;
  const selection = parseSelectionJson(job.audio_selection) || [];
  if (config.multiAudioMode === "off" && selection.length === 0) return null;
  try {
    const tracks = await probeAudioTracks(job.url, config);
    db.run(`UPDATE jobs SET audio_tracks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      JSON.stringify(tracks),
      job.id,
    ]);
    return tracks;
  } catch (err: any) {
    logError(
      "download",
      `${job.id} audio-track probe failed (falling back to single audio): ${String(err?.message || err).slice(0, 200)}`,
    );
    return null;
  }
}

/** The on-disk base name used for a job's files (no extension). */
function baseNameOf(job: Job): string {
  return jobBaseFilename(job);
}

/** Record progress, keeping the high-water marks — and heartbeat the claim. */
function updateJobProgress(
  id: string,
  pct: number,
  bps: number,
  eta: number,
  totalBytes: number | null,
  downloadedBytes: number,
): void {
  db.run(
    `UPDATE jobs SET progress = ?, speed = ?, eta = ?,
       best_progress = MAX(COALESCE(best_progress, 0), ?),
       best_bytes = MAX(COALESCE(best_bytes, 0), ?),
       file_size = COALESCE(?, file_size),
       -- Claim heartbeat, riding the already-throttled progress write: the
       -- stale-claim reaper measures silence, not age, so a healthy long
       -- download is never mistaken for a dead worker.
       download_claimed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [pct, bps, eta, pct, downloadedBytes, totalBytes, id],
  );
}

function readProgressState(id: string): { retryCount: number; bestProgress: number; progress: number } {
  const row = db
    .query("SELECT retry_count, best_progress, progress FROM jobs WHERE id = ?")
    .get(id) as any;
  return {
    retryCount: row?.retry_count || 0,
    bestProgress: row?.best_progress || 0,
    progress: row?.progress || 0,
  };
}

function parkPaused(job: Job): void {
  db.run(
    `UPDATE jobs SET download_status = 'paused', download_claimed_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [job.id],
  );
  // Freeze the resume point: the .part is on disk, and without recording it the
  // job is paused with no resumable partial, so the next attempt restarts the
  // video from zero instead of continuing.
  recordJobPartial(job);
}

function resetForRetry(id: string, opts: { incrementRetry?: boolean; clearPartial?: boolean } = {}): void {
  const clearPartial = opts.clearPartial ? 1 : 0;
  // Restarting from scratch deletes the evidence the watermarks describe — the
  // next attempt must be judged on its own progress, not the thrown-away past.
  const watermarkReset = opts.clearPartial ? `, progress = 0, best_progress = 0, best_bytes = 0` : ``;
  if (opts.incrementRetry) {
    db.run(
      `UPDATE jobs SET download_status = 'pending', retry_count = retry_count + 1, download_claimed_by = NULL, next_retry_at = NULL${watermarkReset},
         partial_file_path = CASE WHEN ? THEN NULL ELSE partial_file_path END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [clearPartial, id],
    );
  } else {
    db.run(
      `UPDATE jobs SET download_status = 'pending', retry_count = 0, download_claimed_by = NULL, next_retry_at = NULL${watermarkReset},
         partial_file_path = CASE WHEN ? THEN NULL ELSE partial_file_path END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [clearPartial, id],
    );
  }
}

function recordSuccess(id: string, filePath: string, fileSize: number): void {
  db.run(
    `UPDATE jobs SET download_status = 'downloaded', file_path = ?, file_size = ?, partial_file_path = NULL,
       progress = 100, download_claimed_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [filePath, fileSize, id],
  );
}

function updateWorkerLine(id: number, text: string, _config: Config): void {
  workerStatuses.set(`DL${id}`, text);
  updateAbsoluteLine(2 + id, `[DL${id}] ${text}`);
}
