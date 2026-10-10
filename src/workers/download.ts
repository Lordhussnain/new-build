// src/workers/download.ts — the resilient download worker.
//
// Pulls videos with yt-dlp and records the result in the job database.
// Everything failure-related is designed around one idea: never lose work
// that has already been done. A failed attempt keeps its .part file, the next
// attempt resumes from it with --continue, and the per-video retry budget only
// shrinks while the video is making no forward progress.

import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  claimDownloadJob,
  claimRef,
  db,
  ownsClaim,
  perVideoCap,
  releaseClaimedJob,
  startClaimHeartbeat,
  updateClaimedJob,
  type ClaimRef,
  type Job,
} from "../db";
import { activeDlSlots, autoscaler } from "../autoscale";
import { aria2cPath, jsRuntime, ytDlp } from "../tools";
import { checkDiskSpace, killProcessTree, notePipelineFailure, notePipelineSuccess, triggerPause } from "../resilience";
import {
  dropSupersededFile,
  findPartialFile,
  recordJobPartial,
  removePartialFiles,
  restoreSupersededFile,
} from "../reconcile";
import { removeFromArchive } from "../archive";
import {
  classifyTerminalDownloadError,
  computeBackoffMs,
  formatSwitchMessage,
  formatTerminalErrorMessage,
  GENERIC_TERMINAL_INFO,
  isDiskFullError,
  isDownloaderArgsError,
  isFormatAvailabilityError,
  isNChallengeError,
  isPermanentDownloadError,
  isSignatureChallengeError,
  isTransientDownloadError,
  isUnrecoverableResumeError,
  nextFormatFallback,
  progressAwareRetryState,
  type TerminalErrorInfo,
} from "../retry";
import { buildDownloadPlan, effectiveVideoQuality, jobFittedBaseFilename } from "../download-args";
import { parseAria2cReadout, parseDownloadPath, readProcessOutput } from "../download-output";
import {
  parseSelectionJson,
  parseTracksJson,
  probeAudioTracks,
  selectAudioTracks,
  type AudioTrack,
} from "../audio-tracks";
import { findDownloadedFile, formatBytesPerSec, parseSpeedToBytesPerSec } from "../util";
import { updateWorkerLine } from "../dashboard";
import {
  abortController,
  activeDownloadJobs,
  activeProcs,
  getConfig,
  isJobCancelled,
  isPaused,
  stats,
} from "../state";
import { logError } from "../logger";
import type { Config } from "../config";

export const aliveDownloadWorkers = new Set<number>();

/**
 * The claim this worker holds on `job`, as the CAS primitives expect it.
 *
 * The claim snapshot comes straight from `claimDownloadJob`, so it always
 * carries the token minted for THIS claim — never a worker id that another
 * process could reuse.
 */
function downloadClaim(job: Job): ClaimRef {
  return claimRef("download", job);
}

/**
 * Write a download-state change that only the claim's current owner may make.
 *
 * Every progress/success/failure/release update goes through here (or through
 * `updateClaimedJob` for updates that keep the claim). The WHERE clause carries
 * the claim token, so a worker whose claim was reaped — or taken over by a
 * second engine — gets 0 changed rows and must not touch job state: it returns
 * false and the caller leaves the row to its new owner.
 */
function releaseOwned(
  job: Job,
  what: string,
  setClause: string,
  params: unknown[] = [],
  extraCondition?: string,
): boolean {
  const changes = releaseClaimedJob("download", job.id, downloadClaim(job), setClause, params, extraCondition);
  if (changes === 1) return true;
  // A row that no longer exists was deleted on purpose (dashboard delete /
  // purge / source removal). That is a normal outcome, not a lost race — the
  // job is gone, so there is nothing to write and nothing to warn about.
  const row = db.query("SELECT download_claim_token FROM jobs WHERE id = ?").get(job.id) as
    | { download_claim_token: string | null }
    | null;
  if (row) {
    logError("download", `${job.id} ${job.title}: lost the download claim while ${what} — job state left untouched`);
  }
  return false;
}

export async function downloadWorker(id: number, config: Config): Promise<void> {
  const workerId = `dl-${id}`;
  aliveDownloadWorkers.add(id);
  // Whether this slot's "parked" line is already on screen. Written once per
  // parking, not on every idle poll.
  let parkedShown = false;
  while (!abortController.signal.aborted) {
    // Re-read the config every iteration so settings changed from the dashboard
    // (POST /api/settings) take effect on the next job without a restart. The
    // parameter is only the initial value.
    config = getConfig();
    if (isPaused()) {
      await Bun.sleep(2000);
      continue;
    }
    // Offline mode: NO video is ever downloaded. The loop stays alive (so the
    // dashboard keeps showing its slots, and flipping the switch back takes
    // effect on the next iteration) but it never claims a job — queued
    // downloads are left exactly as they are, and start the moment the mode
    // ends. The guard is also ahead of the disk check: with nothing to
    // download, a full output drive is the converter's business, not a reason
    // to pause the whole engine.
    if (config.offlineMode) {
      updateWorkerLine(id, "📴 Offline mode — downloads disabled", config);
      await Bun.sleep(2000);
      continue;
    }
    // Autoscaling gate: a scaled-down slot's worker idles here instead of
    // claiming work (a job already in flight always runs to completion).
    if (!activeDlSlots.has(id)) {
      if (!parkedShown) {
        // A parked slot shows that it is parked, and drops its stale speed
        // reading so the bandwidth total only counts running transfers.
        updateWorkerLine(id, "⏸️ Parked — slot scaled down", config);
        autoscaler.clearWorker(id);
        parkedShown = true;
      }
      await Bun.sleep(1000);
      continue;
    }
    parkedShown = false;

    const disk = await checkDiskSpace(config.outputRoot, config.minFreeSpaceGB);
    if (!disk.ok) {
      triggerPause(`LOW_DISK_SPACE (${disk.free.toFixed(1)}GB < ${config.minFreeSpaceGB}GB)`);
      await Bun.sleep(10000);
      continue;
    }
    // The disk check is an await: the autoscaler may have parked this slot
    // meanwhile. Re-check here, with no await between this check and the claim,
    // so a parked slot can never take a job.
    if (!activeDlSlots.has(id)) continue;

    const job = claimDownloadJob(workerId);
    if (!job) {
      await Bun.sleep(500);
      continue;
    }
    activeDownloadJobs.set(id, job.id);
    // The claim is a lease: heartbeat it for as long as this worker is on the
    // job, so a long transfer with no progress lines is never mistaken for a
    // dead worker by the reaper (progress updates renew it too).
    //
    // Losing the lease mid-transfer (reaped as stale, or superseded by another
    // engine) also stops the child: a downloader we no longer own must not keep
    // writing into the video's folder — that is how a deleted job used to end
    // up as an untracked file on disk.
    const stopHeartbeat = startClaimHeartbeat("download", job.id, claimRef("download", job), () => {
      logError("download", `${job.id} ${job.title}: download claim lost — the next update will not land`);
      const doomed = activeProcs.get(id);
      if (doomed && doomed.exitCode === null) {
        try {
          killProcessTree(doomed, "SIGINT");
        } catch {}
      }
    });

    try {
      await runDownload(id, job, config);
      stopHeartbeat();
    } catch (err: any) {
      stopHeartbeat();
      await handleDownloadFailure(id, job, config, err);
    } finally {
      stopHeartbeat();
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
    jsRuntime: jsRuntime(),
  });
  const { baseFilename, timeoutMs } = plan;
  const engineTag = plan.engine === "aria2c" ? `aria2c×${plan.connectionsPerDownload}` : "native";
  const audioTag = audioTracks.length > 0 ? `, ${audioTracks.length} audio track(s)` : "";

  // The audio probe above is a network round-trip; the job can be paused,
  // deleted, or purged while it runs. Spawning yt-dlp for a claim we no longer
  // own is exactly how a cancelled job used to keep downloading in the
  // terminal, so ownership is re-checked immediately before the spawn.
  if (isJobCancelled(job.id) || !ownsClaim("download", job.id, downloadClaim(job))) {
    updateWorkerLine(id, `⏹️ Cancelled before starting | ${job.title}`, config);
    return;
  }

  updateWorkerLine(id, `⬇️ Starting [${engineTag}${audioTag}]... | ${job.title}`, config);
  const args = [ytDlp(), ...plan.args];

  let timedOut = false;
  const downloadCtl = new AbortController();
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: downloadCtl.signal });
  let downloadTimer: ReturnType<typeof setTimeout> | undefined;
  let finalFilePath = "";
  let lastProgressUpdate = 0;
  // Stall tracking: the newest downloaded-byte count and when it last grew.
  let lastBytes = -1;
  let lastByteAt = Date.now();
  let postProcessing = false;
  let stalledMs = 0;
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  let output: [string, string, number];
  try {
    // Keep registration, timer setup, stream construction, and draining in the
    // same protected region: any throw after spawn must stop the child before
    // the worker can release the job claim and retry it.
    activeProcs.set(id, proc);
    // The dashboard can delete/purge this job between the check above and this
    // spawn (both are synchronous, but the probe before them is not). Now that
    // the child is registered, verify ownership once more: if the row is gone
    // or the claim moved on, the `finally` below reaps the child and nothing is
    // recorded for a job that no longer exists.
    if (isJobCancelled(job.id) || !ownsClaim("download", job.id, downloadClaim(job))) {
      updateWorkerLine(id, `⏹️ Cancelled at start | ${job.title}`, config);
      return;
    }
    downloadTimer = setTimeout(() => {
      timedOut = true;
      downloadCtl.abort();
    }, timeoutMs);
    stallTimer = setInterval(() => {
      // A pause is a deliberate wait, and post-processing is silent by design:
      // neither counts toward the stall clock.
      if (postProcessing || isPaused() || isUserPaused(job.id)) {
        lastByteAt = Date.now();
        return;
      }
      const idle = Date.now() - lastByteAt;
      if (idle < DOWNLOAD_STALL_MS || downloadCtl.signal.aborted) return;
      stalledMs = idle;
      logError(
        "download",
        `${job.id} ${job.title}: no bytes for ${Math.round(idle / 1000)}s — stopping the transfer to resume from its partial`,
      );
      updateWorkerLine(id, `⚠️ Stalled — restarting from partial | ${job.title}`, config);
      downloadCtl.abort();
    }, STALL_CHECK_MS);

    // Every downloader engine funnels through this one writer: the native
    // engine via yt-dlp's --progress-template, aria2c via its console readout
    // (same stdout — yt-dlp lets the child inherit it and fires no progress
    // hook of its own for an external downloader). One writer keeps the
    // dashboard's progress/speed/ETA columns identical on both paths.
    const reportProgress = (
      pctNum: number,
      bps: number,
      etaNum: number,
      totalBytes: number | null,
      downloadedBytes: number | null,
    ) => {
      if (downloadedBytes !== null && downloadedBytes > lastBytes) {
        lastBytes = downloadedBytes;
        lastByteAt = Date.now();
      }
      if (isUserPaused(job.id)) {
        updateWorkerLine(id, `⏸️ Paused | ${job.title}`, config);
        return;
      }
      if (bps > 0) autoscaler.recordSpeed(id, bps);
      if (Number.isNaN(pctNum) || pctNum < 0 || Date.now() - lastProgressUpdate <= 500) return;
      // Backfill file_size from progress so the global ETA has a total to work with.
      // best_progress is the high-water mark of this job's attempts: it is what
      // lets the retry budget forgive repeated failures at increasing
      // completion percentages (see handleDownloadFailure).
      updateJobProgress(job.id, downloadClaim(job), pctNum, bps, etaNum, totalBytes);
      const speedTxt = bps > 0 ? formatBytesPerSec(bps) : "Calculating...";
      const etaTxt = Number.isFinite(etaNum) && etaNum > 0 ? `, ETA ${Math.round(etaNum)}s` : "";
      updateWorkerLine(id, `⬇️ ${pctNum.toFixed(1)}% @ ${speedTxt}${etaTxt} | ${job.title}`, config);
      lastProgressUpdate = Date.now();
    };

    const stdoutPromise = readProcessOutput(proc.stdout, (line) => {
      if (POST_PROCESSING_LINE.test(line.trim())) postProcessing = true;
      if (line.startsWith("PROGRESS:")) {
        const parts = line.replace("PROGRESS:", "").split("|");
        const sizeNum = parseInt(parts[3], 10);
        const dlNum = parseInt(parts[4], 10);
        let pctNum = parseFloat(parts[0]);
        if (Number.isNaN(pctNum) && dlNum > 0 && sizeNum > 0) pctNum = (dlNum / sizeNum) * 100;
        reportProgress(
          pctNum,
          parseSpeedToBytesPerSec(parts[1]),
          parseFloat(parts[2]) || 0,
          Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : null,
          Number.isFinite(dlNum) && dlNum >= 0 ? dlNum : null,
        );
      } else {
        const path = parseDownloadPath(line);
        if (path) {
          finalFilePath = path;
        } else {
          // Not our FILEPATH record: on the aria2c path this is where the
          // transfer's only live progress signal arrives.
          const readout = parseAria2cReadout(line);
          if (readout) {
            reportProgress(
              readout.percent,
              readout.speedBps,
              readout.etaSeconds,
              readout.totalBytes > 0 ? readout.totalBytes : null,
              readout.downloadedBytes >= 0 ? readout.downloadedBytes : null,
            );
          }
        }
      }
    });

    // Drain both pipes concurrently, with bounded tails for error reporting.
    // A native Bun panic cannot be caught in JS, so no arbitrary stdout string
    // reaches existsSync: only a size/control-checked FILEPATH record below.
    output = await Promise.all([stdoutPromise, readProcessOutput(proc.stderr), proc.exited]);
  } finally {
    if (stallTimer !== undefined) clearInterval(stallTimer);
    await cleanupDownloadProcess(id, proc, downloadTimer);
  }
  const [stdoutText, stderrText, code] = output;

  if (isPaused() && !isUserPaused(job.id)) {
    parkPaused(job);
    updateWorkerLine(id, `⏸️ Paused | ${job.title}`, config);
    return;
  }

  if (timedOut) throw new Error(`Process timed out (${Math.round(timeoutMs / 60000)}m)`);
  if (stalledMs > 0) {
    throw new Error(`Download stalled — no bytes for ${Math.round(stalledMs / 1000)}s; resuming from partial`);
  }

  if (code === 0) {
    let filePath = finalFilePath && existsSync(finalFilePath) ? finalFilePath : "";
    if (!filePath) filePath = await findDownloadedFile(job.output_directory, baseFilename);
    if (!filePath) {
      logError("download", `${job.id} exited 0 but the output file could not be located: ${job.title}`);
      throw new Error("Download finished but output file could not be located");
    }
    const fileSize = (await stat(filePath)).size;
    const recorded = recordSuccess(job, filePath, fileSize);
    if (recorded.lostClaim) {
      updateWorkerLine(id, `⚠️ Claim lost — output belongs to another worker | ${job.title}`, config);
      return;
    }
    if (recorded.stayedPaused) {
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
 * A transfer that moves no bytes for this long is stalled: its child is stopped
 * and the job resumes from its partial. Before this existed, a child that went
 * silent (a hung socket, a fragment the server stopped serving) kept its slot
 * and its claim lease until the total timeout — 15 to 180 minutes — while the
 * dashboard showed the last percentage. The signal is downloaded bytes, not the
 * percentage, so a slow transfer that is still moving is left alone.
 */
export const DOWNLOAD_STALL_MS = 180_000;
const STALL_CHECK_MS = 15_000;
/**
 * yt-dlp lines that mean the transfer has finished and post-processing has
 * started. Those phases are silent for minutes by design, so stall detection
 * stops once one appears.
 */
const POST_PROCESSING_LINE =
  /^\[(?:Merger|ffmpeg|ExtractAudio|EmbedThumbnail|Metadata|Fixup\w*|ModifyChapters|MoveFiles|SponsorBlock|VideoConvertor|VideoRemuxer)\]/;

/**
 * How long the dashboard keeps showing "Format X not available — switched to Y".
 *
 * The fallback itself is instant; this pause exists purely so the one message
 * that explains a silent-looking quality downgrade is actually readable.
 */
const FORMAT_SWITCH_NOTICE_MS = 1_500;

/** Upper bound for yt-dlp's networked self-update command. */
export const YTDLP_UPDATE_TIMEOUT_MS = 120_000;
const YTDLP_UPDATE_COOLDOWN_MS = 60 * 60_000;

export interface YtDlpUpdateResult {
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  detail: string;
}

let lastYtDlpUpdateAttemptAt: number | null = null;
let lastYtDlpUpdateResult: YtDlpUpdateResult | null = null;
let ytDlpUpdateInFlight: Promise<YtDlpUpdateResult> | null = null;
// A successful update can finish before every worker in the same failure burst
// reaches this branch. Let each distinct job consume that success once during
// the cooldown, but do not let one still-broken job reset its retry budget over
// and over against the same stale update result.
const jobsRetriedAfterYtDlpUpdate = new Set<string>();

/**
 * Run `yt-dlp -U` with both pipes drained, bounded diagnostic tails, and a hard
 * timeout. Exposed so the subprocess contract can be tested without running a
 * full download worker.
 */
export async function runYtDlpSelfUpdate(
  opts: { binary?: string; timeoutMs?: number } = {},
): Promise<YtDlpUpdateResult> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? YTDLP_UPDATE_TIMEOUT_MS);
  const ctl = new AbortController();
  let proc: Bun.Subprocess | null = null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
      if (proc && proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
    }, timeoutMs);
    const updater = Bun.spawn([opts.binary || ytDlp(), "-U"], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctl.signal,
    });
    proc = updater;
    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessOutput(updater.stdout),
      readProcessOutput(updater.stderr),
      updater.exited,
    ]);
    const detail = [stderr, stdout]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(-800);
    return { ok: !timedOut && exitCode === 0, timedOut, exitCode, detail };
  } catch (error) {
    const detail = timedOut
      ? `self-update exceeded ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, timedOut, exitCode: proc?.exitCode ?? null, detail: detail.slice(-800) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (proc) await stopYtDlpUpdateProcess(proc);
  }
}

async function stopYtDlpUpdateProcess(proc: Bun.Subprocess): Promise<void> {
  if (proc.exitCode === null) {
    try {
      proc.kill("SIGINT");
    } catch {
      // The process may have exited between the check and the signal.
    }
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let exited = false;
    try {
      exited = await Promise.race([
        proc.exited.then(() => true, () => true),
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
      } catch {}
    }
  }
  await proc.exited.catch(() => {});
}

async function requestSignatureUpdate(
  jobId: string,
): Promise<{ attempted: boolean; result: YtDlpUpdateResult | null }> {
  if (ytDlpUpdateInFlight) {
    const result = await ytDlpUpdateInFlight;
    if (result.ok) jobsRetriedAfterYtDlpUpdate.add(jobId);
    return { attempted: true, result };
  }
  if (
    lastYtDlpUpdateAttemptAt !== null &&
    Date.now() - lastYtDlpUpdateAttemptAt < YTDLP_UPDATE_COOLDOWN_MS
  ) {
    // The update process may be very fast, especially once its executable has
    // been warmed by the dependency probe. A sibling job that reaches this
    // branch just after it exits still gets one retry against the updated
    // binary; a subsequent failure from that same job uses the normal budget.
    if (lastYtDlpUpdateResult?.ok && !jobsRetriedAfterYtDlpUpdate.has(jobId)) {
      jobsRetriedAfterYtDlpUpdate.add(jobId);
      return { attempted: false, result: lastYtDlpUpdateResult };
    }
    return { attempted: false, result: null };
  }
  lastYtDlpUpdateAttemptAt = Date.now();
  lastYtDlpUpdateResult = null;
  jobsRetriedAfterYtDlpUpdate.clear();
  const update = runYtDlpSelfUpdate();
  ytDlpUpdateInFlight = update;
  try {
    const result = await update;
    lastYtDlpUpdateResult = result;
    if (result.ok) jobsRetriedAfterYtDlpUpdate.add(jobId);
    return { attempted: true, result };
  } finally {
    if (ytDlpUpdateInFlight === update) ytDlpUpdateInFlight = null;
  }
}

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
      const children = killProcessTree(proc, "SIGINT");

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

      if (!exited || proc.exitCode === null) {
        killProcessTree(proc, "SIGKILL");
      }
      for (const cpid of children) {
        try {
          process.kill(cpid, "SIGKILL");
        } catch {}
      }
    } else {
      killProcessTree(proc, "SIGKILL");
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
 *   • resume refused (HTTP 416 range,  → DISCARD the partial + control file,
 *     aria2c control-file refusal)         restart from zero: the bytes the
 *                                        resume asks for no longer exist
 *   • corrupt/incomplete               → delete the partial and resume (bounded
 *                                        by maxResumeAttempts, then restart)
 *   • live / not-yet-premiered stream  → park as waiting_live (a rescan picks
 *                                        it up once a VOD exists)
 *   • format not available             → clear stale pinned audio ids, else
 *                                        step DOWN the quality ladder and retry
 *                                        with the new selector; a bottomed-out
 *                                        ladder is terminal
 *   • permanent (private/removed/…)    → terminal skip: one attempt, no error.log
 *                                        line, never auto-requeued
 *   • n-challenge / missing JS runtime → retryable (not a dead video)
 *   • retry budget spent               → park as failed for the sweep
 *   • transient (network/timeout/5xx)  → requeue with exponential backoff
 */
export async function handleDownloadFailure(id: number, job: Job, config: Config, err: any): Promise<void> {
  if (isUserPaused(job.id)) {
    const parked = parkUserPaused(job);
    if (parked) updateWorkerLine(id, `⏸️ Paused | ${job.title}`, config);
    return;
  }
  if (isPaused()) {
    const parked = parkPaused(job);
    if (parked) updateWorkerLine(id, `⏸️ Paused | ${job.title}`, config);
    return;
  }

  let errMsg = String(err?.message || err);
  const lower = errMsg.toLowerCase();
  const base = baseNameOf(job);

  // Storage exhaustion affects every worker, not just this video. Pause the
  // engine immediately, preserve any partial, and require an operator to free
  // space before Resume All rather than spending retry budgets against ENOSPC.
  if (isDiskFullError(errMsg)) {
    triggerPause("LOW_DISK_SPACE (download write failed; free space and Resume All)");
    let partial = job.partial_file_path && existsSync(job.partial_file_path) ? job.partial_file_path : null;
    if (!partial) {
      try {
        partial = await findPartialFile(job.output_directory, base);
      } catch {
        // Keep the state/error record even when the directory itself is unreadable.
      }
    }
    const detail = errMsg.replace(/\s+/g, " ").trim().slice(-300);
    const message = `Storage exhausted during download; free disk space, then resume. yt-dlp: ${detail}`;
    const parked = releaseOwned(
      job,
      "pausing after a disk-full error",
      `download_status = 'paused', pause_reason = 'interrupted', partial_file_path = ?, last_error = ?`,
      [partial || null, message.slice(0, 500)],
    );
    if (!parked) return;
    logError("download", `${job.id} ${job.title}: ${message}`);
    updateWorkerLine(id, `💾 Disk full — engine paused; free space and resume | ${job.title}`, config);
    return;
  }

  // A genuine signature-decipher failure can be repaired by updating yt-dlp.
  // Keep the match narrow and bound/coalesce the update process: generic
  // extractor errors are not fixed by -U, and a broken updater must not reset
  // the video's retry budget or launch once per worker.
  if (isSignatureChallengeError(errMsg) && !isNChallengeError(errMsg)) {
    const update = await requestSignatureUpdate(job.id);
    if (update.result?.ok) {
      if (!resetForRetry(job)) return;
      updateWorkerLine(id, `🔄 yt-dlp updated — retrying | ${job.title}`, config);
      return;
    }
    if (update.attempted && update.result) {
      const outcome = update.result.timedOut
        ? "timed out"
        : `exited with code ${update.result.exitCode ?? "unknown"}`;
      const failure = `yt-dlp auto-update ${outcome}${update.result.detail ? `: ${update.result.detail}` : ""}`;
      errMsg = `${errMsg} (${failure})`;
      logError("download", `${job.id} ${job.title}: ${failure.slice(0, 500)}`);
    }
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

  // Selector-level format problem: the requested FORMAT does not exist for this
  // video — "Requested format is not available". Not a dead video, and not
  // something to keep re-running the identical command for. Two recoveries, in
  // order, and then a terminal skip; this branch must stay before the
  // permanent-error check, which matches the same message text.
  //
  //   1. Pinned multi-audio ids from an earlier `-J` probe went stale (YouTube
  //      renumbers formats) → forget `audio_tracks` so the next attempt
  //      re-probes, keeping the per-job language selection. Bounded by the
  //      no-progress budget, because a re-probe can legitimately pin the same
  //      stale ids again.
  //   2. Otherwise the preset itself has nothing to grab → step down the
  //      quality ladder (4k → … → 480p → highest), persist the lower preset as
  //      this job's `video_quality` override, and retry immediately: the next
  //      attempt is a different command, so there is nothing to wait for. The
  //      ladder is monotonic, so it cannot loop and spends no retry budget.
  //
  // When the ladder is exhausted the video really has no usable formats: park
  // it as terminal (never auto-requeued) with an explicit message instead of
  // looping through cooldown sweeps.
  if (isFormatAvailabilityError(errMsg) && !isNChallengeError(errMsg)) {
    const current = readProgressState(job.id);
    const retry = progressAwareRetryState(
      current.retryCount,
      current.bestProgress,
      current.progress,
      perVideoCap(config),
    );

    // (1) Stale multi-audio probe.
    if (job.audio_tracks && !retry.exhausted) {
      const landed = releaseOwned(
        job,
        "clearing stale audio formats",
        `download_status = 'pending', retry_count = ?, best_progress = ?, audio_tracks = NULL, last_error = ?`,
        [retry.retryCount, retry.bestProgress, errMsg.slice(0, 500)],
      );
      if (!landed) return;
      const backoff = computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
      updateWorkerLine(id, `🎧 Audio formats went stale — re-probing in ${Math.round(backoff / 1000)}s | ${job.title}`, config);
      await Bun.sleep(backoff);
      return;
    }

    // (2) Quality fallback ladder.
    const from = effectiveVideoQuality(job, config);
    const next = nextFormatFallback(from);
    if (next) {
      const message = formatSwitchMessage(from, next);
      // `audio_tracks` goes with the step: the pinned ids were the most likely
      // cause of a selector miss, and the next attempt re-probes them anyway.
      const landed = releaseOwned(
        job,
        "switching to a fallback format",
        `download_status = 'pending', video_quality = ?, audio_tracks = NULL, last_error = ?`,
        [next, message],
      );
      if (!landed) return;
      stats.formatFallbacks++;
      logError(
        "download",
        `${job.id} ${job.title}: ${message} (yt-dlp: ${errMsg.replace(/\s+/g, " ").slice(0, 200)})`,
      );
      updateWorkerLine(id, `🎚️ Format ${from} not available — switched to ${next} | ${job.title}`, config);
      // Hold the line long enough to be read. The recovery is immediate (the
      // next attempt is a different command), so without this pause the
      // announcement would be on screen for the few milliseconds it takes the
      // worker to re-claim the job — and the operator, who is about to receive
      // a lower-quality file than they asked for, is exactly who needs to see it.
      await Bun.sleep(FORMAT_SWITCH_NOTICE_MS);
      return;
    }

    // (3) Ladder exhausted: the video offers no formats this engine can fetch.
    const exhaustedPartial =
      job.partial_file_path && existsSync(job.partial_file_path)
        ? job.partial_file_path
        : await findPartialFile(job.output_directory, base);
    parkTerminal(
      id,
      job,
      config,
      { code: "format_unavailable", label: `No format available (tried down to ${from})` },
      errMsg,
      exhaustedPartial || null,
    );
    return;
  }

  // Unrecoverable resume (the "stuck at 99% forever" bug): an HTTP 416 for the
  // saved partial's range — or aria2c refusing to touch a file whose control
  // state is gone — means the resume can NEVER complete, because the remote
  // stream no longer has the bytes `--continue` is asking for. Retrying with
  // the same partial repeats the failure identically, so this branch discards
  // the pair and restarts the transfer. It must run before the corrupt-resume
  // branch (which spends its budget RESUMING) and before the permanent-error
  // check: a 416 is about OUR partial, not about the video being unfetchable.
  if (isUnrecoverableResumeError(errMsg)) {
    const current = readProgressState(job.id);
    const retry = progressAwareRetryState(
      current.retryCount,
      current.bestProgress,
      current.progress,
      perVideoCap(config),
    );
    const partial =
      job.partial_file_path && existsSync(job.partial_file_path)
        ? job.partial_file_path
        : await findPartialFile(job.output_directory, base);
    // The 99% high-water mark was reached with bytes the server no longer serves.
    // Kept, it turns every later attempt into a "no progress" failure, so a
    // restart clears progress/best_progress in the same statement that re-queues.
    const status = retry.exhausted ? "failed" : "pending";

    if (partial) {
      // Both files, in the one safe order: a `.part` without its `.aria2` (or
      // the reverse) leaves aria2c unable to resume AND unable to restart.
      const removal = await removePartialFiles(partial);
      if (removal.fatal) {
        // Nothing was deleted and aria2c still refuses to restart, so this can
        // only wait for the lock (an orphaned aria2c/ffmpeg, an AV scan) to go
        // away — with its partial still recorded for whoever retries.
        const msg =
          `resume state is unusable (HTTP 416) and its partial is locked (${removal.error}). ` +
          `Close the program holding it — usually an orphaned aria2c/ffmpeg or an antivirus scan on the download folder.`;
        const parked = releaseOwned(
          job,
          "parking a locked 416 partial",
          `download_status = ?, retry_count = ?, best_progress = ?, partial_file_path = ?, last_error = ?`,
          [status, retry.retryCount, retry.bestProgress, partial, msg.slice(0, 500)],
        );
        logError("download", `${job.id} ${job.title}: ${msg}`);
        if (!parked) return;
        if (retry.exhausted) {
          stats.failed++;
          notePipelineFailure("dl", config);
          updateWorkerLine(id, `❌ Retry budget spent — waiting for cooldown | ${job.title}`, config);
        } else {
          updateWorkerLine(id, `🔒 416 partial locked — will retry | ${job.title}`, config);
          await Bun.sleep(computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds));
        }
        return;
      }
    }

    const restarted = releaseOwned(
      job,
      "restarting after an unrecoverable resume",
      `download_status = ?, retry_count = ?, resume_count = 0, partial_file_path = NULL,
       progress = ?, best_progress = ?, speed = 0, eta = 0, last_error = ?`,
      [
        status,
        retry.retryCount,
        retry.exhausted ? retry.bestProgress : 0,
        retry.exhausted ? retry.bestProgress : 0,
        errMsg.slice(0, 500),
      ],
    );
    if (!restarted) return;
    if (retry.exhausted) {
      // Budget spent — but the unusable resume state is gone, so the cooldown
      // sweep's next attempt starts clean instead of straight back into a 416.
      stats.failed++;
      notePipelineFailure("dl", config);
      logError("download", `${job.id} ${job.title}: ${errMsg.slice(0, 300)}`);
      updateWorkerLine(id, `❌ Retry budget spent — partial discarded, cooldown will restart it | ${job.title}`, config);
      return;
    }
    if (partial) {
      // A fresh attempt still has to survive a genuinely broken stream, so the
      // no-progress budget is charged (it forgives again as soon as the restart
      // gets further than the previous attempt did).
      const backoff = computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
      updateWorkerLine(id, `🧹 Resume state unusable (HTTP 416) — restarting from scratch in ${Math.round(backoff / 1000)}s | ${job.title}`, config);
      await Bun.sleep(backoff);
      return;
    }
    // Nothing on disk to resume: a 416 with no partial can only come from stale
    // media-URL state, and the next attempt re-extracts the formats anyway.
    // Nothing was deleted, so no work is lost — the budget just bounds the loop.
    const backoff = computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
    updateWorkerLine(id, `🧹 Resume refused (HTTP 416), nothing to discard — retrying in ${Math.round(backoff / 1000)}s | ${job.title}`, config);
    await Bun.sleep(backoff);
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
        const parked = releaseOwned(
          job,
          "parking a locked partial",
          `download_status = ?, retry_count = ?, resume_count = ?, partial_file_path = ?, best_progress = ?, last_error = ?`,
          [status, retry.retryCount, resumeCount, partial, retry.bestProgress, msg.slice(0, 500)],
        );
        logError("download", `${job.id} ${job.title}: ${msg}`);
        if (!parked) return;
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
      const failed = releaseOwned(
        job,
        "parking an exhausted corrupt resume",
        `download_status = 'failed', retry_count = ?, resume_count = ?, partial_file_path = ?, best_progress = ?, last_error = ?`,
        [
          retry.retryCount,
          restartFromScratch ? 0 : resumeCount,
          keepPartial,
          retry.bestProgress,
          errMsg.slice(0, 500),
        ],
      );
      if (!failed) return;
      stats.failed++;
      notePipelineFailure("dl", config);
      logError("download", `${job.id} ${job.title}: ${errMsg.slice(0, 500)}`);
      updateWorkerLine(id, `❌ Retry budget spent — waiting for cooldown | ${job.title}`, config);
      return;
    }

    if (restartFromScratch) {
      const restarted = releaseOwned(
        job,
        "restarting from scratch",
        `download_status = 'pending', retry_count = ?, resume_count = 0, partial_file_path = NULL,
         progress = 0, best_progress = ?, speed = 0, eta = 0, last_error = ?`,
        [retry.retryCount, retry.bestProgress, errMsg.slice(0, 500)],
      );
      if (!restarted) return;
      updateWorkerLine(id, `🗑️ Restarting from scratch | ${job.title}`, config);
      await Bun.sleep(computeBackoffMs(retry.retryCount, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds));
      return;
    }

    // Keep and record the partial, count the resume attempt, and try again
    // shortly. Commit the high-water mark only at this failure boundary.
    const resumed = releaseOwned(
      job,
      "recording a resume attempt",
      `download_status = 'pending', retry_count = ?, resume_count = ?, partial_file_path = ?, best_progress = ?, last_error = ?`,
      [retry.retryCount, resumeCount, partial, retry.bestProgress, errMsg.slice(0, 500)],
    );
    if (!resumed) return;
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
    const landed = releaseOwned(
      job,
      "re-queueing a missing output file",
      `download_status = ?, retry_count = ?, best_progress = ?, partial_file_path = ?,
       resume_count = 0, last_error = ?`,
      [status, retry.retryCount, retry.bestProgress, partial || null, errMsg.slice(0, 500)],
    );
    if (!landed) return;
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
  // live (or has not started) right now. Park it until the next full rescan or
  // a manual retry — scans flip waiting_live jobs back to pending once a VOD
  // exists. Scheduled premieres/live events answer with "Premieres in 3 hours"
  // / "This live event will begin in …", which used to fall through to the
  // retry budget: the job burned attempts against a video that could not exist
  // yet and spammed error.log until it was parked as failed. They wait here
  // instead, exactly like a live stream.
  if (
    lower.includes("does not pass filter") ||
    lower.includes("is live") ||
    lower.includes("live event") ||
    lower.includes("premieres in") ||
    lower.includes("will begin in")
  ) {
    const parked = releaseOwned(
      job,
      "parking a live stream",
      `download_status = 'waiting_live', last_error = ?`,
      [errMsg.slice(0, 500)],
    );
    if (!parked) return;
    updateWorkerLine(id, `🕒 Live/premiere — waiting for VOD | ${job.title}`, config);
    return;
  }

  // Video-level failures that cannot be fixed by retrying are parked
  // immediately as TERMINAL skips: the cooldown sweep and every requeue path
  // treat the recorded marker as permanent, so a private or deleted video is
  // attempted exactly once. Expected in archival — a playlist of 500 videos
  // normally contains a few dead ones — so this path deliberately does NOT
  // write an error.log line, does not spend retry budget, and does not feed the
  // circuit breaker: it records the reason on the job row and moves on.
  if (isPermanentDownloadError(errMsg)) {
    // A deliberate re-download (dashboard retry on an archived video) stashed
    // the previous file. The re-fetch can never succeed, so put the previous
    // file back instead of leaving the job empty-handed — the archive keeps
    // exactly what it had before the retry. The restore is claim-guarded: a
    // stale worker must not move the previous file over the new owner's work.
    if (restoreSupersededFile(job.id, `re-download failed permanently: ${errMsg.slice(0, 300)}`, downloadClaim(job))) {
      logError(
        "download",
        `${job.id} ${job.title}: permanent re-download failure, previous file restored: ${errMsg.slice(0, 300)}`,
      );
      updateWorkerLine(id, `🚫 Re-download failed permanently — previous file restored | ${job.title}`, config);
      return;
    }
    const partial = await findPartialFile(job.output_directory, base);
    parkTerminal(id, job, config, classifyTerminalDownloadError(errMsg) ?? GENERIC_TERMINAL_INFO, errMsg, partial || null);
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
  const landed = releaseOwned(
    job,
    "re-queueing after a failed attempt",
    `download_status = ?, retry_count = ?, best_progress = ?, partial_file_path = ?, last_error = ?`,
    [newStatus, retry.retryCount, retry.bestProgress, partial || null, errMsg.slice(0, 500)],
  );
  if (!landed) return;

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

/**
 * Park a job that retrying can never fix, as a TERMINAL skip.
 *
 * The reason travels in `last_error` behind `TERMINAL_ERROR_MARKER` (see
 * retry.ts), which is what keeps the cooldown sweep, the dashboard's
 * "Requeue failed" button and `retryableFailed` on `/api/reliability` from
 * resurrecting it — while a human can still read *why* the video is missing
 * and a deliberate `/api/jobs/:id/retry` still works.
 *
 * Deliberately quieter than a failure: one dashboard line and the job row, no
 * `error.log` entry (a private video in a playlist is an expected archival
 * outcome, not an incident to investigate), no retry budget, no circuit-breaker
 * note. `stats.unavailable` counts them so the run report can tell "skipped,
 * cannot exist" apart from "tried and failed".
 */
function parkTerminal(
  id: number,
  job: Job,
  config: Config,
  info: TerminalErrorInfo,
  errMsg: string,
  partial: string | null,
): boolean {
  const message = formatTerminalErrorMessage(info, errMsg);
  const parked = releaseOwned(
    job,
    "parking a terminal failure",
    `download_status = 'failed', partial_file_path = ?, last_error = ?`,
    [partial, message],
  );
  if (!parked) return false;
  stats.failed++;
  stats.unavailable++;
  // Only an unclassified permanent error is worth a line in error.log: the
  // description table knows every expected class, so "not downloadable" means
  // a message shape nobody has seen yet and an operator should look at it.
  if (info.code === GENERIC_TERMINAL_INFO.code) {
    logError("download", `${job.id} ${job.title}: terminal failure (unclassified): ${errMsg.slice(0, 300)}`);
  }
  updateWorkerLine(id, `⛔ Skipped — ${info.label} | ${job.title}`, config);
  return true;
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
    // Claim-checked: the probe runs inside the claimed download slot, so a
    // stolen claim must not have its audio state overwritten by the loser.
    updateClaimedJob("download", job.id, downloadClaim(job), `audio_tracks = ?, updated_at = CURRENT_TIMESTAMP`, [
      JSON.stringify(tracks),
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

/**
 * Record progress, keeping best_progress as the high-water mark.
 *
 * Every progress event also renews the claim's lease: a transfer that is
 * producing output is by definition alive. The update is a claim-token CAS, so
 * a worker whose claim was reaped cannot keep writing progress over the new
 * owner's row (the CAS simply changes 0 rows; progress is high-frequency, so
 * that is not logged here — the outcome paths report the lost claim).
 */
function updateJobProgress(
  id: string,
  claim: ClaimRef,
  pct: number,
  bps: number,
  eta: number,
  totalBytes: number | null,
): void {
  // Keep the current attempt's progress separate from best_progress. The latter
  // is committed only when an attempt fails so failure handling can tell whether
  // this attempt advanced; eagerly taking MAX here would make that comparison
  // always false.
  updateClaimedJob(
    "download",
    id,
    claim,
    `progress = ?, speed = ?, eta = ?, file_size = COALESCE(?, file_size),
     download_heartbeat_at = CURRENT_TIMESTAMP`,
    [pct, bps, eta, totalBytes],
    `download_status = 'downloading'`,
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

function parkUserPaused(job: Job): boolean {
  // Only a still-recorded user pause is parked, and only by the claim's owner:
  // the pause may have been resumed (or the claim reaped) since the worker's
  // snapshot was taken.
  const parked = releaseOwned(
    job,
    "parking a user pause",
    `download_status = 'paused', pause_reason = 'user', best_progress = MAX(COALESCE(best_progress, 0), COALESCE(progress, 0))`,
    [],
    `pause_reason = 'user'`,
  );
  if (parked) recordJobPartial(job);
  return parked;
}

function parkPaused(job: Job): boolean {
  const parked = releaseOwned(
    job,
    "parking an interrupted download",
    `download_status = 'paused', pause_reason = 'interrupted', best_progress = MAX(COALESCE(best_progress, 0), COALESCE(progress, 0))`,
  );
  if (!parked) return false;
  // Freeze the resume point: the .part is on disk, and without recording it the
  // job is paused with no resumable partial, so the next attempt restarts the
  // video from zero instead of continuing.
  recordJobPartial(job);
  return true;
}

function resetForRetry(job: Job): boolean {
  return releaseOwned(
    job,
    "resetting for an immediate retry",
    `download_status = 'pending', retry_count = 0, progress = 0, best_progress = 0,
     speed = 0, eta = 0, resume_count = 0, last_error = NULL`,
  );
}

/** What a completed attempt actually managed to do. */
export interface DownloadSuccessResult {
  /** False when the claim was no longer ours — no state was written. */
  ok: boolean;
  /** True (with `ok`) when the row was user-paused and must stay parked. */
  stayedPaused: boolean;
  /** True when the claim was lost: the caller must not touch the job further. */
  lostClaim: boolean;
}

/**
 * Record the finished media file for `job`.
 *
 * The write is a claim-token CAS, so a stale worker whose claim was reclaimed
 * (or taken over by a second engine process) cannot record its output over the
 * new owner's row — it reports `lostClaim` and walks away.
 */
export function recordSuccess(job: Job, filePath: string, fileSize: number): DownloadSuccessResult {
  const changes = releaseClaimedJob(
    "download",
    job.id,
    downloadClaim(job),
    `download_status = CASE WHEN pause_reason = 'user' THEN 'paused' ELSE 'downloaded' END,
     pause_reason = CASE WHEN pause_reason = 'user' THEN 'user' ELSE NULL END,
     file_path = ?, file_size = ?, partial_file_path = NULL,
     progress = 100, best_progress = 100, last_error = NULL,
     -- A fresh download writes into the output tree, so the media is no longer
     -- in secondary storage: the relocation pass must be allowed to move it
     -- again once conversion finishes (src/relocate.ts).
     relocated_to = NULL`,
    [filePath, fileSize],
  );
  if (changes !== 1) {
    // A deleted row is the expected outcome of a dashboard delete/purge: the
    // file was written on purpose by the (now-cancelled) operation, so only an
    // existing row with a different owner is worth an error line.
    const existing = db.query("SELECT id FROM jobs WHERE id = ?").get(job.id);
    if (existing) {
      logError("download", `${job.id} ${job.title}: lost the download claim before recording success — not recorded`);
    }
    return { ok: false, stayedPaused: false, lostClaim: true };
  }
  const row = db.query("SELECT pause_reason FROM jobs WHERE id = ?").get(job.id) as
    | { pause_reason: string | null }
    | null;
  return { ok: true, stayedPaused: row?.pause_reason === "user", lostClaim: false };
}

