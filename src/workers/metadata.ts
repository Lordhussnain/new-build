// src/workers/metadata.ts — the sidecar metadata worker.
//
// Fetches subtitles, thumbnails, descriptions, and info.json for finished
// downloads (a second, cheap yt-dlp pass with --skip-download) and records
// which sidecar files landed next to the media file.

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claimMetadataJob, db, perVideoCap, type Job } from "../db";
import { cookiesArgs, ytDlp } from "../tools";
import { computeBackoffMs } from "../retry";
import { SIDECAR_SUFFIXES } from "../util";
import { updateAbsoluteLine } from "../dashboard";
import { abortController, activeMetadataProcs, getConfig, isPaused, stats, workerStatuses } from "../state";
import { notePipelineFailure, notePipelineSuccess } from "../resilience";
import { logError } from "../logger";
import type { Config } from "../config";

export async function metadataWorker(id: number, config: Config): Promise<void> {
  const workerId = `md-${id}`;
  while (!abortController.signal.aborted) {
    // Re-read the config every iteration so settings changed from the dashboard
    // (POST /api/settings) take effect on the next job without a restart. The
    // parameter is only the initial value.
    config = getConfig();
    if (isPaused()) {
      await Bun.sleep(2000);
      continue;
    }
    const job = claimMetadataJob(workerId);
    if (!job) {
      await Bun.sleep(2000);
      continue;
    }
    try {
      await runMetadataJob(job, config, id);
    } catch (err: any) {
      await handleMetadataFailure(job, config, err, id);
    }
  }
}

async function runMetadataJob(job: Job, config: Config, id: number): Promise<void> {
  updateMetadataWorkerLine(id, `📎 Metadata | ${job.title}`, config);

  if (!job.file_path || !existsSync(job.file_path)) {
    throw new Error("Downloaded file missing — cannot fetch metadata");
  }

  // Write sidecars next to the downloaded file using the same basename.
  const mediaDir = dirname(job.file_path);
  const mediaBase = basename(job.file_path).replace(/\.[^.]+$/, "");
  const outTemplate = join(mediaDir, `${mediaBase}.%(ext)s`);

  const args = [
    ytDlp(),
    job.url,
    ...cookiesArgs(config),
    "--skip-download",
    "--no-simulate",
    "-o",
    outTemplate,
    "--socket-timeout",
    "15",
    "--retries",
    "5",
    "--extractor-retries",
    "3",
    "--newline",
    "--no-colors",
  ];
  if (job.want_subtitles) {
    args.push("--write-subs", "--write-auto-subs", "--sub-langs", "all.*", "--convert-subs", config.subtitleFormat || "srt");
  }
  if (job.want_thumbnail) args.push("--write-thumbnail", "--convert-thumbnails", "jpg");
  if (job.want_description) args.push("--write-description");
  if (config.writeInfoJson) args.push("--write-info-json");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10 * 60 * 1000);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: ctl.signal });
  activeMetadataProcs.set(id, proc);
  // Drain both pipes concurrently to avoid deadlock.
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text();
  const [stdoutText, stderrText, code] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  clearTimeout(timer);
  activeMetadataProcs.delete(id);

  if (isPaused()) {
    db.run(`UPDATE jobs SET metadata_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [job.id]);
    return;
  }
  if (ctl.signal.aborted) throw new Error("Metadata fetch timed out (10m)");
  if (code !== 0) {
    const tail = [stderrText, stdoutText]
      .filter(Boolean)
      .join("\n")
      .split("\n")
      .filter((l) => l.trim())
      .slice(-3)
      .join(" ");
    throw new Error(tail || `yt-dlp exited with code ${code}`);
  }

  // Record which sidecar files now exist next to the media file.
  const entries = await readdir(mediaDir).catch(() => [] as string[]);
  const sidecars = entries.filter(
    (f) =>
      f.startsWith(mediaBase + ".") &&
      SIDECAR_SUFFIXES.some((sfx) => f.endsWith(sfx)) &&
      f !== basename(job.file_path!),
  );
  db.run(
    `UPDATE jobs SET metadata_status = 'done', metadata_files = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify(sidecars), job.id],
  );
  stats.metadata++;
  notePipelineSuccess("post");
  updateMetadataWorkerLine(id, `✅ Metadata done (${sidecars.length} file(s)) | ${job.title}`, config);
}

/** Metadata failures retry with exponential backoff up to the per-video cap. */
async function handleMetadataFailure(job: Job, config: Config, err: any, id: number): Promise<void> {
  const errMsg = String(err?.message || err).slice(0, 500);
  if (isPaused()) {
    db.run(`UPDATE jobs SET metadata_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [job.id]);
    return;
  }
  const attempts = (job.metadata_retry_count || 0) + 1;
  const cap = perVideoCap(config);
  const newStatus = attempts >= cap ? "failed" : "pending";
  db.run(
    `UPDATE jobs SET metadata_status = ?, metadata_retry_count = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [newStatus, attempts, errMsg, job.id],
  );
  if (newStatus === "failed") {
    stats.failed++;
    logError("metadata", `${job.id} ${job.title}: ${errMsg}`);
    notePipelineFailure("post", config);
    updateMetadataWorkerLine(id, `❌ Metadata failed | ${job.title}`, config);
  } else {
    const backoff = computeBackoffMs(attempts, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds);
    updateMetadataWorkerLine(id, `🔁 Retrying in ${Math.round(backoff / 1000)}s | ${job.title}`, config);
    await Bun.sleep(backoff);
  }
}

function updateMetadataWorkerLine(id: number, text: string, config: Config): void {
  workerStatuses.set(`MD${id}`, text);
  updateAbsoluteLine(2 + config.maxDownloadWorkers + config.maxConcurrentConverts + id, `[MD${id}] ${text}`);
}
