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
import { aria2cPath, ytDlp } from "../tools";
import { checkDiskSpace, notePipelineFailure, notePipelineSuccess, triggerPause } from "../resilience";
import {
  dropSupersededFile,
  findPartialFile,
  recordJobPartial,
  removePartialFiles,
  restoreSupersededFile,
} from "../reconcile";
import { removeFromArchive } from "../archive";
import {
  computeBackoffMs,
  isDownloaderArgsError,
  isFormatAvailabilityError,
  isPermanentDownloadError,
  isTransientDownloadError,
  progressAwareRetryState,
} from "../retry";
import { buildDownloadPlan, effectiveVideoQuality, jobFittedBaseFilename } from "../download-args";
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
import { abortController, activeDownloadJobs, activeProcs, getConfig, isPaused, stats, workerStatuses } from "../state";
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

    const disk = await checkDiskSpace(config.outputRoot, config.minFreeSpaceGB);
    if (!disk.ok) {
      triggerPause(`LOW_DISK_SPACE (${disk.free.toFixed(1)}GB < ${config.minFreeSpaceGB}GB)`);
      await Bun.sleep(10000);
      continue;
    }

    const job = claimDownloadJob(workerId);
    if (!job) {
      await Bun.sleep(500);
      continue;
    }
    activeDownloadJobs.set(id, job.id);

    try {
      await runDownload(id, job, config);
    } catch (err: any) {
      await handleDownloadFailure(id, job, config, err);
    } finally {
      activeDownloadJobs.delete(id);
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
    aria2cAvailable: !!aria2cPath(),
    aria2cBinary: aria2cPath(),
    audioTracks,
  });
  const { baseFilename, timeoutMs } = plan;
  const engineTag = plan.engine === "aria2c" ? `aria2c×${config.connectionsPerDownload}` : "native";
  const audioTag = audioTracks.length > 0 ? `, ${audioTracks.length} audio track(s)` : "";

  updateWorkerLine(id, `⬇️ Starting [${engineTag}${audioTag}]... | ${job.title}`, config);
  const args = [ytDlp(), ...plan.args];

  let timedOut = false;
  const downloadCtl = new AbortController();
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: downloadCtl.signal });
  let downloadTimer: ReturnType<typeof setTimeout> | undefined;
  let finalFilePath = "";
  let lastProgressUpdate = 0;
  let output: [string, string, number];
  try {
    // Keep registration, timer setup, stream construction, and draining in the
    // same protected region: any throw after spawn must stop the child before
    // the worker can release the job claim and retry it.
    activeProcs.set(id, proc);
    downloadTimer = setTimeout(() => {
      timedOut = true;
      downloadCtl.abort();
    }, timeoutMs);

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
          // best_progress is the high-water mark of this job's attempts: it is
          // what lets the retry budget forgive repeated failures at increasing
          // completion percentages (see handleDownloadFailure).
          updateJobProgress(job.id, `dl-${id}`, pctNum, bps, parseFloat(parts[2]) || 0, totalBytes);
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
    output = await Promise.all([stdoutPromise, readProcessOutput(proc.stderr), proc.exited]);
  } finally {
    await cleanupDownloadProcess(id, proc, downloadTimer);
  }
  const [stdoutText, stderrText, code] = output;

  if (isPaused() && !isUserPaused(job.id)) {
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
    if (recordSuccess(job.id, filePath, fileSize)) {
      updateWorkerLine(id, `⏸️ Paused | ${job.title}`, config);
      return;
    }
    // This attempt replaces a previously downloaded file (dashboard retry):
    // the new file is in place, so the stashed backup can finally go. Until
    // this moment the engine never deletes work that has already been done.
    dropSupersededFile(job.id);
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

const DOWNLOAD_PROCESS_CLEANUP_GRACE_MS = 2_000;

/**
 * Stop and reap a spawned downloader on every exit path. SIGINT gives yt-dlp a
 * chance to stop its external downloader (aria2c) cleanly; SIGKILL is the
 * bounded fallback if it does not exit. Tracking is removed even if waiting
 * for the subprocess itself fails.
 */
export async function cleanupDownloadProcess(
  id: number,
  proc: Bun.Subprocess,
  timer?: ReturnType<typeof setTimeout>,
): Promise<void> {
  try {
    if (timer !== undefined) clearTimeout(timer);
    if (proc.exitCode === null) {
      if (!proc.killed) {
        try {
          proc.kill("SIGINT");
        } catch {
          // It may have exited between the exitCode check and kill().
        }
      }

      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let exited: boolean;
      try {
        exited = await Promise.race([
          proc.exited.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => {
            graceTimer = setTimeout(() => resolve(false), DOWNLOAD_PROCESS_CLEANUP_GRACE_MS);
          }),
        ]);
      } finally {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
      }

      if (!exited && proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The subprocess may have exited just before the force-kill.
        }
      }
    }
    await proc.exited;
  } finally {
    activeProcs.delete(id);
  }
}

/**
 * Central failure handler: classifies the error, decides whether the partial
 * file survives, and computes the next state. The guiding rules:
 *
 *   • transient (network/timeout/5xx)  → requeue with exponential backoff
 *   • corrupt/incomplete               → delete the partial and resume (bounded
 *                                        by maxResumeAttempts, then restart)
 *   • live stream in "wait for VOD"    → park as waiting_live
 *   • permanent (private/removed/…)    → fail fast, never auto-requeued
 *   • retry budget spent               → park as failed for the sweep
 */
export async function handleDownloadFailure(id: number, job: Job, config: Config, err: any): Promise<void> {
  if (isUserPaused(job.id)) {
    parkUserPaused(job);
    updateWorkerLine(id, `⏸️ Paused | ${job.title}`, config);
    return;
  }
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

  // Stale multi-audio probe: the selector carried explicit audio format ids
  // from an earlier -J probe, and YouTube renumbers formats over time, so
  // yt-dlp answers "Requested format is not available". That is a selector
  // problem, not a video problem — forget the stored tracks (the next attempt
  // re-probes, and the per-job language selection survives the reset) instead
  // of parking the job permanently. Must run before the permanent-error check,
  // which matches the same message. Still bounded by the no-progress budget.
  if (isFormatAvailabilityError(errMsg) && job.audio_tracks) {
    const current = readProgressState(job.id);
    const retry = progressAwareRetryState(
      current.retryCount,
      current.bestProgress,
      current.progress,
      perVideoCap(config),
    );
    const status = retry.exhausted ? "failed" : "pending";
    db.run(
      `UPDATE jobs SET download_status = ?, retry_count = ?, best_progress = ?,
         audio_tracks = NULL, download_claimed_by = NULL, download_claimed_at = NULL,
         last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, retry.retryCount, retry.bestProgress, errMsg.slice(0, 500), job.id],
    );
    if (retry.exhausted) {
      stats.failed++;
      notePipelineFailure("dl", config);
      logError("download", `${job.id} ${job.title}: stale audio formats kept failing: ${errMsg.slice(0, 300)}`);
      updateWorkerLine(id, `❌ Retry budget spent — waiting for cooldown | ${job.title}`, config);
    } else {
      const backoff = computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
      updateWorkerLine(id, `🎧 Audio formats went stale — re-probing in ${Math.round(backoff / 1000)}s | ${job.title}`, config);
      await Bun.sleep(backoff);
    }
    return;
  }

  // Corrupt/incomplete partial: keep resuming up to maxResumeAttempts, then
  // discard the pair and restart. Every failed attempt still goes through the
  // progress-aware budget so repeated corruptions cannot loop forever.
  if (lower.includes("unable to resume") || lower.includes("incomplete") || lower.includes("corrupt")) {
    const resumeCount = (job.resume_count || 0) + 1;
    const partial =
      job.partial_file_path && existsSync(job.partial_file_path)
        ? job.partial_file_path
        : await findPartialFile(job.output_directory, base);
    const current = readProgressState(job.id);
    const retry = progressAwareRetryState(
      current.retryCount,
      current.bestProgress,
      current.progress,
      perVideoCap(config),
    );
    const restartFromScratch = resumeCount >= Math.max(1, config.maxResumeAttempts) || !partial;
    let partialRemoved = false;

    if (restartFromScratch && partial) {
      // The aria2c control file goes first — stranding it makes aria2c refuse
      // to restart (see removePartialFiles).
      const removal = await removePartialFiles(partial);
      if (removal.fatal) {
        // Keep both files if a process/antivirus holds either one. This is a
        // retryable failure, but its no-progress attempt still spends budget.
        const msg = `partial file locked, cannot restart cleanly (${removal.error}). Close the program holding it — usually an orphaned aria2c/ffmpeg or antivirus scanning the download folder.`;
        const status = retry.exhausted ? "failed" : "pending";
        db.run(
          `UPDATE jobs SET download_status = ?, retry_count = ?, resume_count = ?,
             partial_file_path = ?, best_progress = ?, download_claimed_by = NULL,
             download_claimed_at = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [status, retry.retryCount, resumeCount, partial, retry.bestProgress, msg.slice(0, 500), job.id],
        );
        logError("download", `${job.id} ${job.title}: ${msg}`);
        if (retry.exhausted) {
          stats.failed++;
          notePipelineFailure("dl", config);
          updateWorkerLine(id, `❌ Retry budget spent — waiting for cooldown | ${job.title}`, config);
        } else {
          updateWorkerLine(id, `🔒 Partial locked — will retry | ${job.title}`, config);
          await Bun.sleep(computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds));
        }
        return;
      }
      partialRemoved = true;
    }

    if (retry.exhausted) {
      const keepPartial = partial && !partialRemoved ? partial : null;
      db.run(
        `UPDATE jobs SET download_status = 'failed', retry_count = ?, resume_count = ?,
           partial_file_path = ?, best_progress = ?, download_claimed_by = NULL,
           download_claimed_at = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [
          retry.retryCount,
          restartFromScratch ? 0 : resumeCount,
          keepPartial,
          retry.bestProgress,
          errMsg.slice(0, 500),
          job.id,
        ],
      );
      stats.failed++;
      notePipelineFailure("dl", config);
      logError("download", `${job.id} ${job.title}: ${errMsg.slice(0, 500)}`);
      updateWorkerLine(id, `❌ Retry budget spent — waiting for cooldown | ${job.title}`, config);
      return;
    }

    if (restartFromScratch) {
      db.run(
        `UPDATE jobs SET download_status = 'pending', retry_count = ?, resume_count = 0,
           partial_file_path = NULL, progress = 0, best_progress = ?, speed = 0, eta = 0,
           download_claimed_by = NULL, download_claimed_at = NULL, last_error = ?,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [retry.retryCount, retry.bestProgress, errMsg.slice(0, 500), job.id],
      );
      updateWorkerLine(id, `🗑️ Restarting from scratch | ${job.title}`, config);
      await Bun.sleep(computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds));
      return;
    }

    // Keep and record the partial, count the resume attempt, and try again
    // shortly. Commit the high-water mark only at this failure boundary.
    db.run(
      `UPDATE jobs SET download_status = 'pending', retry_count = ?, resume_count = ?,
         partial_file_path = ?, best_progress = ?, download_claimed_by = NULL,
         download_claimed_at = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [retry.retryCount, resumeCount, partial, retry.bestProgress, errMsg.slice(0, 500), job.id],
    );
    updateWorkerLine(id, `⏳ Resuming (attempt ${resumeCount}/${config.maxResumeAttempts}) | ${job.title}`, config);
    await Bun.sleep(computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds));
    return;
  }

  // --download-archive recorded the id but our copy is gone (deleted by
  // hand, moved, or the folder was cleaned). Scrub the id from the archive
  // so yt-dlp will actually download it on the retry.
  if (lower.includes("output file could not be located")) {
    removeFromArchive(config.archiveFile, job.id);
    const current = readProgressState(job.id);
    const retry = progressAwareRetryState(
      current.retryCount,
      current.bestProgress,
      current.progress,
      perVideoCap(config),
    );
    const status = retry.exhausted ? "failed" : "pending";
    const partial = await findPartialFile(job.output_directory, base);
    db.run(
      `UPDATE jobs SET download_status = ?, retry_count = ?, best_progress = ?,
         partial_file_path = ?, resume_count = 0, download_claimed_by = NULL,
         download_claimed_at = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, retry.retryCount, retry.bestProgress, partial || null, errMsg.slice(0, 500), job.id],
    );
    if (retry.exhausted) {
      stats.failed++;
      notePipelineFailure("dl", config);
      logError("download", `${job.id} ${job.title}: ${errMsg.slice(0, 500)}`);
      updateWorkerLine(id, `❌ Retry budget spent — waiting for cooldown | ${job.title}`, config);
    } else {
      updateWorkerLine(id, `Re-downloading (archive entry scrubbed) | ${job.title}`, config);
      await Bun.sleep(computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds));
    }
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

  // Video-level failures that cannot be fixed by retrying are parked
  // immediately. Keep any partial around for a deliberate manual retry (e.g. a
  // new cookies.txt), but the cooldown sweep will never auto-requeue this row.
  if (isPermanentDownloadError(errMsg)) {
    // A deliberate re-download (dashboard retry on an archived video) stashed
    // the previous file. The re-fetch can never succeed, so put the previous
    // file back instead of leaving the job empty-handed — the archive keeps
    // exactly what it had before the retry.
    if (restoreSupersededFile(job.id, `re-download failed permanently: ${errMsg.slice(0, 300)}`)) {
      logError(
        "download",
        `${job.id} ${job.title}: permanent re-download failure, previous file restored: ${errMsg.slice(0, 300)}`,
      );
      updateWorkerLine(id, `🚫 Re-download failed permanently — previous file restored | ${job.title}`, config);
      return;
    }
    const partial = await findPartialFile(job.output_directory, base);
    db.run(
      `UPDATE jobs SET download_status = 'failed', partial_file_path = ?, download_claimed_by = NULL,
         download_claimed_at = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [partial || null, errMsg.slice(0, 500), job.id],
    );
    stats.failed++;
    logError("download", `${job.id} ${job.title}: permanent failure: ${errMsg.slice(0, 500)}`);
    updateWorkerLine(id, `🚫 Permanent failure | ${job.title}`, config);
    return;
  }

  // Both transient and otherwise-unclassified failures use the same
  // progress-aware budget. A retry only costs budget when this attempt failed
  // without beating the previous attempt's high-water mark.
  const partial = await findPartialFile(job.output_directory, base);
  const current = readProgressState(job.id);
  const retry = progressAwareRetryState(
    current.retryCount,
    current.bestProgress,
    current.progress,
    perVideoCap(config),
  );
  const newStatus = retry.exhausted ? "failed" : "pending";
  db.run(
    `UPDATE jobs SET download_status = ?, retry_count = ?, best_progress = ?, partial_file_path = ?,
       download_claimed_by = NULL, download_claimed_at = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [newStatus, retry.retryCount, retry.bestProgress, partial || null, errMsg.slice(0, 500), job.id],
  );

  if (newStatus === "failed") {
    stats.failed++;
    logError("download", `${job.id} ${job.title}: ${errMsg.slice(0, 500)}`);
    notePipelineFailure("dl", config);
    updateWorkerLine(id, `❌ Retry budget spent — waiting for cooldown | ${job.title}`, config);
    return;
  }

  const backoff = computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
  const message = isTransientDownloadError(errMsg) ? "🌐 Transient error" : "⚠️ Download error";
  updateWorkerLine(id, `${message}, retrying in ${Math.round(backoff / 1000)}s | ${job.title}`, config);
  await Bun.sleep(backoff);
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
  if (effectiveVideoQuality(job, config) === "audio") return null;
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

/**
 * The on-disk base name used for a job's files (no extension) — fitted exactly
 * like `buildDownloadPlan` does, or a lookup for a long title's `.part` misses
 * the file yt-dlp wrote (see `jobFittedBaseFilename`).
 */
function baseNameOf(job: Job): string {
  return jobFittedBaseFilename(job);
}

/** Record progress, keeping best_progress as the high-water mark. */
function updateJobProgress(
  id: string,
  workerId: string,
  pct: number,
  bps: number,
  eta: number,
  totalBytes: number | null,
): void {
  // Keep the current attempt's progress separate from best_progress. The latter
  // is committed only when an attempt fails so failure handling can tell whether
  // this attempt advanced; eagerly taking MAX here would make that comparison
  // always false.
  db.run(
    `UPDATE jobs SET progress = ?, speed = ?, eta = ?, file_size = COALESCE(?, file_size),
       download_claimed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND download_status = 'downloading' AND download_claimed_by = ?`,
    [pct, bps, eta, totalBytes, id, workerId],
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

// `job` is the claim-time snapshot; the DB is authoritative for a later pause request.
function isUserPaused(id: string): boolean {
  const row = db.query("SELECT pause_reason FROM jobs WHERE id = ?").get(id) as { pause_reason: string | null } | null;
  return row?.pause_reason === "user";
}

function parkUserPaused(job: Job): void {
  const result = db.run(
    `UPDATE jobs SET download_status = 'paused', pause_reason = 'user',
       download_claimed_by = NULL, download_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND pause_reason = 'user'`,
    [job.id],
  );
  if (result.changes > 0) recordJobPartial(job);
}

function parkPaused(job: Job): void {
  db.run(
    `UPDATE jobs SET download_status = 'paused', pause_reason = 'interrupted',
       download_claimed_by = NULL, download_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [job.id],
  );
  // Freeze the resume point: the .part is on disk, and without recording it the
  // job is paused with no resumable partial, so the next attempt restarts the
  // video from zero instead of continuing.
  recordJobPartial(job);
}

function resetForRetry(id: string): void {
  db.run(
    `UPDATE jobs SET download_status = 'pending', retry_count = 0,
       download_claimed_by = NULL, download_claimed_at = NULL,
       progress = 0, best_progress = 0, speed = 0, eta = 0, resume_count = 0,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [id],
  );
}

export function recordSuccess(id: string, filePath: string, fileSize: number): boolean {
  const row = db
    .query(
      `UPDATE jobs SET
         download_status = CASE WHEN pause_reason = 'user' THEN 'paused' ELSE 'downloaded' END,
         pause_reason = CASE WHEN pause_reason = 'user' THEN 'user' ELSE NULL END,
         file_path = ?, file_size = ?, partial_file_path = NULL,
         progress = 100, best_progress = 100, last_error = NULL,
         download_claimed_by = NULL, download_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
       RETURNING pause_reason`,
    )
    .get(filePath, fileSize, id) as { pause_reason: string | null } | null;
  return row?.pause_reason === "user";
}

function updateWorkerLine(id: number, text: string, _config: Config): void {
  workerStatuses.set(`DL${id}`, text);
  updateAbsoluteLine(2 + id, `[DL${id}] ${text}`);
}
