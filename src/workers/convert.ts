// src/workers/convert.ts — the conversion worker.
//
// Runs after a download (and after metadata work is terminal). Transcodes
// audio-only archives to mp3 and remuxes everything else into the target mp4
// container, then optionally moves the file plus its sidecars to a secondary
// storage path and records a SHA-256 integrity hash.

import { cp, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  claimConvertJob,
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
import { computeBackoffMs } from "../retry";
import { SIDECAR_SUFFIXES, hashFile } from "../util";
import { updateAbsoluteLine } from "../dashboard";
import {
  abortController,
  activeConvertJobs,
  activeConvertProcs,
  getConfig,
  isPaused,
  stats,
  workerStatuses,
} from "../state";
import { notePipelineFailure, notePipelineSuccess } from "../resilience";
import { logError } from "../logger";
import { ffmpeg } from "../tools";
import { effectiveTargetFormat } from "../download-args";
import type { Config } from "../config";

/**
 * Run ffmpeg with a hard timeout so a wedged encode can never pin a worker.
 *
 * `workerId` (when given) registers the child in `activeConvertProcs`, which is
 * what lets the dashboard interrupt an in-flight encode: without it a job
 * deleted mid-conversion left ffmpeg running in the terminal until it finished.
 */
export async function runFfmpeg(
  args: string[],
  timeoutMs: number,
  workerId?: number,
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const proc = Bun.spawn([ffmpeg(), ...args], { stdout: "ignore", stderr: "pipe", signal: ctl.signal });
    if (workerId !== undefined) activeConvertProcs.set(workerId, proc);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr, timedOut: ctl.signal.aborted };
  } finally {
    clearTimeout(timer);
    if (workerId !== undefined) activeConvertProcs.delete(workerId);
  }
}

/**
 * How many audio streams a media file carries (ffprobe-style via ffmpeg's
 * banner). Used to recognise multi-audio archives, which must keep their
 * container instead of being remuxed to mp4. 0 on any probe failure — the
 * caller then behaves exactly like before multi-audio support.
 */
export async function countAudioStreams(path: string, workerId?: number): Promise<number> {
  try {
    const proc = Bun.spawn([ffmpeg(), "-hide_banner", "-i", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (workerId !== undefined) activeConvertProcs.set(workerId, proc);
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const banner = `${out}\n${err}`;
    return (banner.match(/^\s*Stream #\d+:\d+[^\n]*:\s*Audio/gm) || []).length;
  } catch {
    return 0;
  } finally {
    if (workerId !== undefined) activeConvertProcs.delete(workerId);
  }
}

export async function converterWorker(id: number, config: Config): Promise<void> {
  const workerId = `cv-${id}`;
  while (!abortController.signal.aborted) {
    // Re-read the config every iteration so settings changed from the dashboard
    // (POST /api/settings) take effect on the next job without a restart. The
    // parameter is only the initial value.
    config = getConfig();
    if (isPaused()) {
      await Bun.sleep(2000);
      continue;
    }
    const job = claimConvertJob(workerId);
    if (!job) {
      await Bun.sleep(2000);
      continue;
    }
    // A conversion can run for hours (ffmpeg) and emits nothing the reaper can
    // see, so the claim's lease is renewed here. Without this heartbeat the
    // fixed stale window was the only signal, and a live long encode looked
    // exactly like a dead worker.
    const stopHeartbeat = startClaimHeartbeat("conversion", job.id, claimRef("conversion", job), () => {
      logError("conversion", `${job.id} ${job.title}: conversion claim lost — the encode will not be recorded`);
      const doomed = activeConvertProcs.get(id);
      if (doomed && doomed.exitCode === null) {
        try {
          doomed.kill("SIGINT");
        } catch {}
      }
    });
    activeConvertJobs.set(id, job.id);
    try {
      await convertJob(job, config, id);
    } catch (err: any) {
      await handleConvertFailure(job, config, err, id);
    } finally {
      activeConvertJobs.delete(id);
      activeConvertProcs.delete(id);
      stopHeartbeat();
    }
  }
}

/**
 * True when this worker still owns the job's conversion claim.
 *
 * Claims can be lost mid-flight: the stale-claim reaper re-queues conversions
 * whose lease expired, and a second engine process could reset them at startup
 * if this one's lease lapsed. A converter that kept working would then race a
 * second converter on the same files — the loser's source gets deleted under
 * it, which on Windows either fails silently (locked handle) or corrupts the
 * winner's output. Every destructive step (source delete, secondary-storage
 * move, final update) therefore re-checks ownership first and walks away if it
 * was stolen.
 *
 * Ownership is identified by the claim TOKEN, not the worker id: `cv-1` exists
 * in every engine process, so a stale worker's id can look exactly like the new
 * owner's.
 */
function stillOwnsConversion(job: Job): boolean {
  return ownsClaim("conversion", job.id, claimRef("conversion", job));
}

/**
 * The converted output a previous attempt may have left behind: same base name
 * as the (now missing) source, with the target extension — or .mkv, which the
 * multi-audio path intentionally keeps. Empty string when nothing is there.
 *
 * This is the crash-window recovery: an attempt that died after the encode but
 * before the database update used to leave file_path pointing at a deleted
 * source, and the job was then failed (or worse, re-downloaded) even though
 * the finished media was sitting right there.
 */
export function findConvertedOutput(sourcePath: string, wantsMp3: boolean, targetFmt: string = "mp4"): string {
  if (!sourcePath) return "";
  const base = sourcePath.replace(/\.[^.]+$/, "");
  const ext = wantsMp3 ? "mp3" : targetFmt;
  const candidates = Array.from(new Set([`${base}.${ext}`, `${base}.mp4`, `${base}.mkv`, `${base}.webm`, `${base}.mp3`, `${base}.m4a`]));
  for (const c of candidates) {
    if (c !== sourcePath && existsSync(c)) return c;
  }
  return "";
}

/** Delete the pre-conversion source — but never out from under a stolen claim. */
async function deleteConvertedSource(job: Job, config: Config, sourcePath: string): Promise<void> {
  if (!config.deleteSourceAfterConvert) return;
  if (!stillOwnsConversion(job)) {
    logError("conversion", `${job.id} ${job.title}: conversion claim lost mid-job — keeping the source file`);
    return;
  }
  try {
    await unlink(sourcePath);
  } catch (e: any) {
    // Loud, not silent: on Windows this is usually a lock held by an
    // antivirus scan or an orphaned ffmpeg. A lingering source is harmless
    // (file_path already points at the converted output), but the operator
    // should see WHY it lingers instead of finding mystery duplicates.
    logError(
      "conversion",
      `${job.id} ${job.title}: could not delete converted source ${sourcePath}: ${e?.code || e?.message || e}`,
    );
  }
}

/** Secondary-storage move, integrity hash, and the final done update. */
async function finalizeConversion(
  job: Job,
  config: Config,
  id: number,
  finalPath: string,
): Promise<void> {
  if (!stillOwnsConversion(job)) {
    logError("conversion", `${job.id} ${job.title}: conversion claim lost mid-job — not finalizing`);
    return;
  }
  if (config.secondaryStoragePath) {
    const moved = await moveToSecondaryStorage(job, config.secondaryStoragePath, finalPath, () =>
      stillOwnsConversion(job),
    );
    if (moved.stopped) {
      // Ownership is gone: the thief owns these files now, so nothing else is
      // touched (not even the DB row, whose WHERE clause would refuse it).
      logError("conversion", `${job.id} ${job.title}: conversion claim lost mid-move — files left where they are`);
      return;
    }
    finalPath = moved.path;
  }
  let integrity: string | null = null;
  if (config.verifyIntegrity) {
    integrity = await hashFile(finalPath);
  }
  // The claim-token CAS makes the done-update itself atomic with ownership: if
  // the claim was stolen while hashing, changes is 0 and the thief owns the job
  // now — touch nothing further.
  const claimed = releaseClaimedJob(
    "conversion",
    job.id,
    claimRef("conversion", job),
    `conversion_status = 'done', file_path = ?, integrity = ?`,
    [finalPath, integrity],
    `conversion_status = 'in_progress'`,
  );
  if (claimed === 0) {
    logError("conversion", `${job.id} ${job.title}: conversion claim lost before finalize — files left untouched`);
    return;
  }
  stats.converted++;
  notePipelineSuccess("post");
  updateConvertWorkerLine(id, `✅ Done | ${job.title}`, config);
}

/**
 * Move a finished conversion — media plus matching sidecars — into secondary
 * storage, preserving the folder layout. Returns the media's new path.
 *
 * Every destructive step re-checks ownership through `canContinue`: the claim
 * can be stolen at any await in this sequence, and after that the files belong
 * to the new claim (AGENTS.md invariant 20). A stopped move reports back so the
 * caller can bail out; a sidecar that cannot move is a warning, while the media
 * itself is `required` — if it cannot land in secondary storage the job must
 * fail and retry rather than be marked done against the wrong path. The source
 * is only ever deleted after a copy that reported success (see `moveFile`).
 *
 * Exported for the tests: the failure modes here are exactly the ones that must
 * never lose data, and they are impossible to trigger through the full engine
 * without contriving a broken secondary disk.
 */
export async function moveToSecondaryStorage(
  job: Pick<Job, "id" | "title" | "folder">,
  secondaryStoragePath: string,
  finalPath: string,
  canContinue: () => boolean = () => true,
): Promise<{ path: string; stopped: boolean }> {
  const destDir = join(secondaryStoragePath, job.folder);
  await mkdir(destDir, { recursive: true });
  const srcDir = dirname(finalPath);
  const srcBase = basename(finalPath).replace(/\.[^.]+$/, "");
  // Move matching sidecar files (subs/thumbs/description/info.json) with
  // the media so everything stays together in the final location.
  //
  // The order is pinned, because `readdir` is not: NTFS hands back names in
  // sorted order, ext4/APFS in hash order, so the same folder walks these
  // destructive steps differently on different machines — and a move that is
  // stopped mid-sequence (ownership lost) must stop at the same place
  // everywhere. The video's OWN sidecars (`<base><suffix>`, e.g.
  // `.info.json`) go first in a fixed suffix order — with an identical base,
  // name order IS suffix order — followed by the language-tagged derivatives
  // (`<base>.<lang>.vtt`) in name order.
  const entries = await readdir(srcDir).catch(() => [] as string[]);
  const isOwnSidecar = (f: string) => SIDECAR_SUFFIXES.some((sfx) => f === srcBase + sfx);
  const sidecars = entries
    .filter((f) => f.startsWith(srcBase + ".") && SIDECAR_SUFFIXES.some((sfx) => f.endsWith(sfx)))
    .sort((a, b) => {
      const [ownA, ownB] = [isOwnSidecar(a), isOwnSidecar(b)];
      if (ownA !== ownB) return ownA ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  for (const f of sidecars) {
    if (!canContinue()) return { path: finalPath, stopped: true };
    await moveFile(join(srcDir, f), join(destDir, f), job);
  }
  if (!canContinue()) return { path: finalPath, stopped: true };
  const destPath = join(destDir, basename(finalPath));
  await moveFile(finalPath, destPath, job, { required: true });
  return { path: destPath, stopped: false };
}

/**
 * Move one file to secondary storage without ever destroying the only copy.
 *
 * `rename` is tried first (same volume: atomic, and the source is gone the
 * moment it succeeds). Across volumes it fails with EXDEV and the copy is the
 * only option — and THAT is where the old code was dangerous: it swallowed a
 * copy failure and then unlinked the source anyway, so a full secondary disk
 * silently deleted a sidecar that had nowhere else to live. Now the source is
 * removed only after a copy that reported success; a failed copy keeps BOTH
 * files and is logged loudly (a duplicate is recoverable, a lost file is not).
 *
 * Returns false when the move did not happen. `required` turns that into a
 * thrown error — the media itself must land in secondary storage or the job
 * must stay retryable, while a sidecar is worth only a warning.
 */
async function moveFile(
  src: string,
  dest: string,
  job: Pick<Job, "id" | "title">,
  opts: { required?: boolean } = {},
): Promise<boolean> {
  try {
    await rename(src, dest);
    return true;
  } catch {
    // EXDEV when secondary storage is another volume (the expected case);
    // anything else (a locked destination) has no better answer than the
    // checked copy below, which keeps the source on failure.
    return moveFileCopy(src, dest, job, opts);
  }
}

async function moveFileCopy(
  src: string,
  dest: string,
  job: Pick<Job, "id" | "title">,
  opts: { required?: boolean },
): Promise<boolean> {
  try {
    // `force` overwrites a half-written destination from an earlier crash.
    await cp(src, dest, { force: true });
  } catch (e: any) {
    logError(
      "conversion",
      `${job.id} ${job.title}: could not move ${src} to secondary storage (${e?.code || e?.message || e}) — keeping BOTH copies`,
    );
    if (opts.required) {
      throw new Error(`secondary-storage move failed for ${src}: ${e?.code || e?.message || e}`);
    }
    return false;
  }
  // Only now is the source redundant.
  try {
    await unlink(src);
  } catch (e: any) {
    logError(
      "conversion",
      `${job.id} ${job.title}: moved ${src} to secondary storage but could not remove the source (${e?.code || e?.message || e}) — duplicate left in place`,
    );
  }
  return true;
}

async function convertJob(job: Job, config: Config, id: number): Promise<void> {
  updateConvertWorkerLine(id, `🔄 Converting | ${job.title}`, config);
  const sourcePath = job.file_path!;
  const targetFmt = effectiveTargetFormat(job, config);
  const wantsMp3 = targetFmt === "mp3";
  if (!sourcePath || !existsSync(sourcePath)) {
    // Crash-window recovery: a previous attempt may have finished the encode
    // and died before recording it. Adopt the finished output instead of
    // failing (or letting anything re-download the video).
    const adopted = findConvertedOutput(sourcePath, wantsMp3, targetFmt);
    if (adopted) {
      logError("conversion", `${job.id} ${job.title}: source missing but already converted — adopting ${adopted}`);
      await finalizeConversion(job, config, id, adopted);
      return;
    }
    throw new Error(`Source file missing: ${sourcePath || "(null)"}`);
  }
  let finalPath = sourcePath;
  if (wantsMp3 && !sourcePath.endsWith(".mp3")) {
    // Audio archive: encode to the target .mp3 instead of leaving the
    // source container (webm/m4a) untouched.
    const mp3Path = sourcePath.replace(/\.[^.]+$/, ".mp3");
    const res = await runFfmpeg(
      ["-y", "-i", sourcePath, "-vn", "-map", "0:a:0", "-c:a", "libmp3lame", "-q:a", "2", mp3Path],
      60 * 60 * 1000,
      id,
    );
    if (res.code !== 0) {
      throw new Error(
        `FFmpeg mp3 encode ${res.timedOut ? "timed out" : "failed"}: ${res.stderr.split("\n").filter((l) => l.trim()).slice(-2).join(" ")}`,
      );
    }
    finalPath = mp3Path;
    // Claim-checked: a stale worker must not point the row at a file the new
    // owner is not converting.
    updateClaimedJob("conversion", job.id, claimRef("conversion", job), `file_path = ?`, [finalPath]);
    await deleteConvertedSource(job, config, sourcePath);
  } else if (!wantsMp3 && !sourcePath.endsWith(`.${targetFmt}`)) {
    // Multi-audio archives land as MKV holding every selected track. MP4
    // cannot carry them without re-encoding each dub, so a file with more
    // than one audio stream is kept exactly as yt-dlp muxed it.
    const audioStreams = await countAudioStreams(sourcePath, id);
    if (audioStreams >= 2) {
      updateConvertWorkerLine(id, `🎧 Remuxing ${audioStreams} audio tracks | ${job.title}`, config);
    }
    const targetPath = sourcePath.replace(/\.[^.]+$/, `.${targetFmt}`);
    const ffmpegArgs =
      targetFmt === "mp4"
        ? ["-y", "-i", sourcePath, "-map", "0:v:0?", "-map", "0:a?", "-map_metadata", "0", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", targetPath]
        : ["-y", "-i", sourcePath, "-map", "0:v:0?", "-map", "0:a?", "-map_metadata", "0", "-c:v", "copy", "-c:a", "copy", targetPath];
    const res = await runFfmpeg(ffmpegArgs, 30 * 60 * 1000, id);
    if (res.code !== 0) {
      throw new Error(
        `FFmpeg remux to .${targetFmt} ${res.timedOut ? "timed out" : "failed"}: ${res.stderr.split("\n").filter((l) => l.trim()).slice(-2).join(" ")}`,
      );
    }
    finalPath = targetPath;
    // Claim-checked: a stale worker must not point the row at a file the new
    // owner is not converting.
    updateClaimedJob("conversion", job.id, claimRef("conversion", job), `file_path = ?`, [finalPath]);
    await deleteConvertedSource(job, config, sourcePath);
  }
  await finalizeConversion(job, config, id, finalPath);
}

/**
 * Conversion failures are usually transient (a wedged ffmpeg, a full disk), so
 * they get their own retry budget with exponential backoff before the job is
 * parked as failed for the periodic sweep.
 */
async function handleConvertFailure(job: Job, config: Config, err: any, id: number): Promise<void> {
  const errMsg = String(err?.message || err).slice(0, 500);
  const attempts = (job.conversion_retry_count || 0) + 1;
  const cap = perVideoCap(config);
  const newStatus = attempts >= cap ? "failed" : "pending";
  // CAS on the claim token: losing the claim means the outcome belongs to the
  // new owner, so this worker changes nothing and reports nothing.
  const landed = releaseClaimedJob(
    "conversion",
    job.id,
    claimRef("conversion", job),
    `conversion_status = ?, conversion_retry_count = ?, last_error = ?`,
    [newStatus, attempts, errMsg],
  );
  if (landed !== 1) {
    // A row that is gone was deleted on purpose (dashboard delete / purge /
    // source removal) — nothing to record, nothing to warn about.
    if (db.query("SELECT id FROM jobs WHERE id = ?").get(job.id)) {
      logError("conversion", `${job.id} ${job.title}: conversion claim lost before recording the failure`);
    }
    return;
  }
  if (newStatus === "failed") {
    stats.failed++;
    logError("conversion", `${job.id} ${job.title}: ${errMsg}`);
    notePipelineFailure("post", config);
    updateConvertWorkerLine(id, `❌ Failed | ${job.title}`, config);
  } else {
    // The job was released back to the queue above, so any free converter may
    // pick it up; this worker only pauses briefly to avoid hammering a broken
    // ffmpeg. The full exponential backoff is applied by the failed-job sweep
    // once the per-video budget is spent (see requeueFailedJobs) — sleeping the
    // whole backoff here just parked a worker slot for minutes on end and made
    // the dashboard look frozen.
    const backoff = Math.min(computeBackoffMs(attempts, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds), 5_000);
    updateConvertWorkerLine(id, `🔁 Retrying in ${Math.max(1, Math.round(backoff / 1000))}s | ${job.title}`, config);
    await Bun.sleep(backoff);
  }
}

function updateConvertWorkerLine(id: number, text: string, config: Config): void {
  workerStatuses.set(`CV${id}`, text);
  updateAbsoluteLine(2 + config.maxDownloadWorkers + id, `[CV${id}] ${text}`);
}
