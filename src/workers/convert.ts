// src/workers/convert.ts — the conversion worker.
//
// Runs after a download (and after metadata work is terminal). Transcodes
// audio-only archives to mp3 and remuxes everything else into the target mp4
// container, then optionally moves the file plus its sidecars to a secondary
// storage path and records a SHA-256 integrity hash.

import { cp, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claimConvertJob, db, perVideoCap, type Job } from "../db";
import { computeBackoffMs } from "../retry";
import { SIDECAR_SUFFIXES, hashFile } from "../util";
import { updateAbsoluteLine } from "../dashboard";
import { abortController, getConfig, isPaused, stats, workerStatuses } from "../state";
import { notePipelineFailure, notePipelineSuccess } from "../resilience";
import { logError } from "../logger";
import { ffmpeg } from "../tools";
import type { Config } from "../config";

/** Run ffmpeg with a hard timeout so a wedged encode can never pin a worker. */
export async function runFfmpeg(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const proc = Bun.spawn([ffmpeg(), ...args], { stdout: "ignore", stderr: "pipe", signal: ctl.signal });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr, timedOut: ctl.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many audio streams a media file carries (ffprobe-style via ffmpeg's
 * banner). Used to recognise multi-audio archives, which must keep their
 * container instead of being remuxed to mp4. 0 on any probe failure — the
 * caller then behaves exactly like before multi-audio support.
 */
export async function countAudioStreams(path: string): Promise<number> {
  try {
    const proc = Bun.spawn([ffmpeg(), "-hide_banner", "-i", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const banner = `${out}\n${err}`;
    return (banner.match(/^\s*Stream #\d+:\d+[^\n]*:\s*Audio/gm) || []).length;
  } catch {
    return 0;
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
    try {
      await convertJob(job, config, id);
    } catch (err: any) {
      await handleConvertFailure(job, config, err, id);
    }
  }
}

/**
 * True when this worker still owns the job's conversion claim.
 *
 * Claims can be lost mid-flight: the stale-claim reaper re-queues conversions
 * after its three-hour timeout, and (before the web-port single-instance gate)
 * a second engine instance could reset them at startup.
 * A converter that kept working would then race a second converter on the same
 * files — the loser's source gets deleted under it, which on Windows either
 * fails silently (locked handle) or corrupts the winner's output. Every
 * destructive step (source delete, secondary-storage move, final update)
 * therefore re-checks ownership first and walks away if it was stolen.
 */
function stillOwnsConversion(job: Pick<Job, "id">, workerId: string): boolean {
  const row = db
    .query("SELECT conversion_status, conversion_claimed_by FROM jobs WHERE id = ?")
    .get(job.id) as any;
  return !!row && row.conversion_status === "in_progress" && row.conversion_claimed_by === workerId;
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
async function deleteConvertedSource(
  job: Job,
  config: Config,
  workerId: string,
  sourcePath: string,
): Promise<void> {
  if (!config.deleteSourceAfterConvert) return;
  if (!stillOwnsConversion(job, workerId)) {
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
  workerId: string,
  finalPath: string,
): Promise<void> {
  if (!stillOwnsConversion(job, workerId)) {
    logError("conversion", `${job.id} ${job.title}: conversion claim lost mid-job — not finalizing`);
    return;
  }
  if (config.secondaryStoragePath) {
    const destDir = join(config.secondaryStoragePath, job.folder);
    await mkdir(destDir, { recursive: true });
    const srcDir = dirname(finalPath);
    const srcBase = basename(finalPath).replace(/\.[^.]+$/, "");
    // Move matching sidecar files (subs/thumbs/description/info.json) with
    // the media so everything stays together in the final location.
    const entries = await readdir(srcDir).catch(() => [] as string[]);
    for (const f of entries) {
      if (!f.startsWith(srcBase + ".")) continue;
      if (!SIDECAR_SUFFIXES.some((sfx) => f.endsWith(sfx))) continue;
      const sideSrc = join(srcDir, f);
      const sideDest = join(destDir, f);
      await rename(sideSrc, sideDest).catch(async () => {
        await cp(sideSrc, sideDest, { force: true }).catch(() => {});
        await unlink(sideSrc).catch(() => {});
      });
    }
    const destPath = join(destDir, basename(finalPath));
    await rename(finalPath, destPath).catch(async () => {
      await cp(finalPath, destPath, { force: true });
      await unlink(finalPath);
    });
    finalPath = destPath;
  }
  let integrity: string | null = null;
  if (config.verifyIntegrity) {
    integrity = await hashFile(finalPath);
  }
  // The claim guard in the WHERE clause makes the done-update itself atomic
  // with ownership: if the claim was stolen while hashing, changes is 0 and
  // the thief owns the job now — touch nothing further.
  const claimed = db.run(
    `UPDATE jobs SET conversion_status = 'done', file_path = ?, integrity = ?, conversion_claimed_by = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND conversion_claimed_by = ? AND conversion_status = 'in_progress'`,
    [finalPath, integrity, job.id, workerId],
  );
  if (claimed.changes === 0) {
    logError("conversion", `${job.id} ${job.title}: conversion claim lost before finalize — files left untouched`);
    return;
  }
  stats.converted++;
  notePipelineSuccess("post");
  updateConvertWorkerLine(id, `✅ Done | ${job.title}`, config);
}

async function convertJob(job: Job, config: Config, id: number): Promise<void> {
  const workerId = `cv-${id}`;
  updateConvertWorkerLine(id, `🔄 Converting | ${job.title}`, config);
  const sourcePath = job.file_path!;
  const targetFmt = (job.target_format || config.targetFormat || "mp4").toLowerCase();
  const wantsMp3 = targetFmt === "mp3" || config.videoQuality === "audio";
  if (!sourcePath || !existsSync(sourcePath)) {
    // Crash-window recovery: a previous attempt may have finished the encode
    // and died before recording it. Adopt the finished output instead of
    // failing (or letting anything re-download the video).
    const adopted = findConvertedOutput(sourcePath, wantsMp3, targetFmt);
    if (adopted) {
      logError("conversion", `${job.id} ${job.title}: source missing but already converted — adopting ${adopted}`);
      await finalizeConversion(job, config, id, workerId, adopted);
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
    );
    if (res.code !== 0) {
      throw new Error(
        `FFmpeg mp3 encode ${res.timedOut ? "timed out" : "failed"}: ${res.stderr.split("\n").filter((l) => l.trim()).slice(-2).join(" ")}`,
      );
    }
    finalPath = mp3Path;
    db.run(`UPDATE jobs SET file_path = ? WHERE id = ?`, [finalPath, job.id]);
    await deleteConvertedSource(job, config, workerId, sourcePath);
  } else if (!wantsMp3 && !sourcePath.endsWith(`.${targetFmt}`)) {
    // Multi-audio archives land as MKV holding every selected track. MP4
    // cannot carry them without re-encoding each dub, so a file with more
    // than one audio stream is kept exactly as yt-dlp muxed it.
    const audioStreams = await countAudioStreams(sourcePath);
    if (audioStreams >= 2) {
      updateConvertWorkerLine(id, `🎧 Remuxing ${audioStreams} audio tracks | ${job.title}`, config);
    }
    const targetPath = sourcePath.replace(/\.[^.]+$/, `.${targetFmt}`);
    const ffmpegArgs =
      targetFmt === "mp4"
        ? ["-y", "-i", sourcePath, "-map", "0:v:0?", "-map", "0:a?", "-map_metadata", "0", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", targetPath]
        : ["-y", "-i", sourcePath, "-map", "0:v:0?", "-map", "0:a?", "-map_metadata", "0", "-c:v", "copy", "-c:a", "copy", targetPath];
    const res = await runFfmpeg(ffmpegArgs, 30 * 60 * 1000);
    if (res.code !== 0) {
      throw new Error(
        `FFmpeg remux to .${targetFmt} ${res.timedOut ? "timed out" : "failed"}: ${res.stderr.split("\n").filter((l) => l.trim()).slice(-2).join(" ")}`,
      );
    }
    finalPath = targetPath;
    db.run(`UPDATE jobs SET file_path = ? WHERE id = ?`, [finalPath, job.id]);
    await deleteConvertedSource(job, config, workerId, sourcePath);
  }
  await finalizeConversion(job, config, id, workerId, finalPath);
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
  db.run(
    `UPDATE jobs SET conversion_status = ?, conversion_retry_count = ?, last_error = ?, conversion_claimed_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [newStatus, attempts, errMsg, job.id],
  );
  if (newStatus === "failed") {
    stats.failed++;
    logError("conversion", `${job.id} ${job.title}: ${errMsg}`);
    notePipelineFailure("post", config);
    updateConvertWorkerLine(id, `❌ Failed | ${job.title}`, config);
  } else {
    const backoff = computeBackoffMs(attempts, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
    updateConvertWorkerLine(id, `🔁 Retrying in ${Math.round(backoff / 1000)}s | ${job.title}`, config);
    await Bun.sleep(backoff);
  }
}

function updateConvertWorkerLine(id: number, text: string, config: Config): void {
  workerStatuses.set(`CV${id}`, text);
  updateAbsoluteLine(2 + config.maxDownloadWorkers + id, `[CV${id}] ${text}`);
}
