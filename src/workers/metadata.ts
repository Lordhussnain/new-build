// src/workers/metadata.ts — the sidecar metadata worker.
//
// Fetches subtitles, thumbnails, descriptions, and info.json for finished
// downloads (a second, cheap yt-dlp pass with --skip-download) and records
// which sidecar files landed next to the media file.

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  claimMetadataJob,
  claimRef,
  db,
  perVideoCap,
  releaseClaimedJob,
  startClaimHeartbeat,
  type ClaimRef,
  type Job,
} from "../db";
import { cookiesArgs, jsRuntimeArgs, ytDlp } from "../tools";
import { computeBackoffMs, isPermanentDownloadError } from "../retry";
import {
  findSidecarFiles,
  missingMetadataKinds,
  parseUnavailableMetadataKinds,
  updateUnavailableMetadataKinds,
  type MetadataKind,
} from "../metadata-files";
import { updateAbsoluteLine } from "../dashboard";
import {
  abortController,
  activeMetadataJobs,
  activeMetadataProcs,
  getConfig,
  isPaused,
  stats,
  workerStatuses,
} from "../state";
import { notePipelineFailure, notePipelineSuccess } from "../resilience";
import { logError } from "../logger";
import type { Config } from "../config";

/**
 * The yt-dlp subtitle flags for one metadata pass (pure, unit-tested).
 *
 * `subtitleLanguages` is the operator's --sub-langs value: "all" (or blank)
 * keeps the legacy behaviour of fetching every language including
 * auto-generated captions (`all.*`); anything else is passed through as a
 * comma-separated list of codes/regexes (e.g. "en,es,ja" or "en.*").
 */
export function subtitleArgs(config: {
  subtitleLanguages: string;
  subtitleFormat: string;
}): string[] {
  const langs = (config.subtitleLanguages || "").trim();
  const selector = !langs || langs.toLowerCase() === "all" ? "all.*" : langs;
  return ["--write-subs", "--write-auto-subs", "--sub-langs", selector, "--convert-subs", config.subtitleFormat || "srt"];
}

/** Only ask yt-dlp for sidecar types confirmed missing on disk. */
export function missingSidecarArgs(
  config: Pick<Config, "subtitleLanguages" | "subtitleFormat">,
  missing: readonly MetadataKind[],
): string[] {
  const args: string[] = [];
  if (missing.includes("subtitles")) args.push(...subtitleArgs(config));
  if (missing.includes("thumbnail")) args.push("--write-thumbnail", "--convert-thumbnails", "jpg");
  if (missing.includes("description")) args.push("--write-description");
  if (missing.includes("infoJson")) args.push("--write-info-json");
  return args;
}

/** The claim this worker holds on `job`, identified by its unique token. */
function metadataClaim(job: Job): ClaimRef {
  return claimRef("metadata", job);
}

function recordMetadataSuccess(
  job: Job,
  config: Config,
  id: number,
  sidecars: string[],
  alreadyPresent = false,
  attemptedKinds: readonly MetadataKind[] = [],
): void {
  // yt-dlp can exit successfully when a source has no requested captions or
  // thumbnail. Remember those terminal absences so a later library scan does
  // not repeatedly hammer the same unavailable metadata endpoint.
  const unavailableList = updateUnavailableMetadataKinds(sidecars, job.metadata_unavailable, attemptedKinds);
  const landed = releaseClaimedJob(
    "metadata",
    job.id,
    metadataClaim(job),
    `metadata_status = 'done', metadata_files = ?, metadata_unavailable = ?`,
    [JSON.stringify(sidecars), JSON.stringify(unavailableList)],
  );
  if (landed !== 1) {
    // Gone row = deliberate deletion; an existing row with a different owner is
    // the race worth reporting.
    if (db.query("SELECT id FROM jobs WHERE id = ?").get(job.id)) {
      logError("metadata", `${job.id} ${job.title}: metadata claim lost before recording the sidecars`);
    }
    return;
  }
  stats.metadata++;
  notePipelineSuccess("post");
  updateMetadataWorkerLine(
    id,
    `${alreadyPresent ? "✅ Metadata check complete" : "✅ Metadata done"} (${sidecars.length} file(s)) | ${job.title}`,
    config,
  );
}

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
    // Offline mode: every sidecar (subtitles, thumbnail, description,
    // info.json) is a network fetch, so the pass is skipped entirely. Jobs keep
    // whatever metadata_status they have — 'pending' ones are fetched, unchanged,
    // the next time the engine runs online.
    //
    // Note the deliberate asymmetry with conversion: a job whose metadata is
    // still pending stays out of the converter's reach (its claim requires
    // metadata to be terminal), which is the ordering the operator asked for —
    // offline mode finishes files that only need local work, and leaves the
    // rest of the pipeline exactly as it found it.
    if (config.offlineMode) {
      updateMetadataWorkerLine(id, "📴 Offline mode — sidecars need network", config);
      await Bun.sleep(3000);
      continue;
    }
    const job = claimMetadataJob(workerId);
    if (!job) {
      await Bun.sleep(2000);
      continue;
    }
    // The metadata pass spawns yt-dlp for up to ten minutes and used to give
    // the reaper nothing but `updated_at` to look at. The claim lease (owner,
    // token, heartbeat) is renewed here so a live fetch is never re-queued and
    // a stale worker can never write over the new owner.
    const stopHeartbeat = startClaimHeartbeat("metadata", job.id, claimRef("metadata", job), () => {
      logError("metadata", `${job.id} ${job.title}: metadata claim lost — the sidecar pass will not be recorded`);
      // Same rule as downloads: a claim we no longer own must not keep a
      // network fetch running against the video's folder.
      const doomed = activeMetadataProcs.get(id);
      if (doomed && doomed.exitCode === null) {
        try {
          doomed.kill("SIGINT");
        } catch {}
      }
    });
    activeMetadataJobs.set(id, job.id);
    try {
      await runMetadataJob(job, config, id);
    } catch (err: any) {
      await handleMetadataFailure(job, config, err, id);
    } finally {
      activeMetadataJobs.delete(id);
      activeMetadataProcs.delete(id);
      stopHeartbeat();
    }
  }
}

async function stopMetadataProcess(proc: Bun.Subprocess): Promise<void> {
  if (proc.exitCode === null) {
    try {
      proc.kill("SIGINT");
    } catch {
      // It may have exited between the check and the signal.
    }
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let exited: boolean;
    try {
      exited = await Promise.race([
        proc.exited.then(() => true, () => true),
        new Promise<boolean>((resolve) => {
          graceTimer = setTimeout(() => resolve(false), 2_000);
        }),
      ]);
    } finally {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    }
    if (!exited && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The child may have exited just before the force-kill.
      }
    }
  }
  await proc.exited.catch(() => {});
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
  const mediaFilename = basename(job.file_path);
  const entriesBefore = await readdir(mediaDir).catch(() => [] as string[]);
  const existingSidecars = findSidecarFiles(entriesBefore, mediaBase, mediaFilename);
  const missing = missingMetadataKinds(
    existingSidecars,
    {
      subtitles: Boolean(job.want_subtitles),
      thumbnail: Boolean(job.want_thumbnail),
      description: Boolean(job.want_description),
      infoJson: config.writeInfoJson,
    },
    parseUnavailableMetadataKinds(job.metadata_unavailable),
  );
  if (missing.length === 0) {
    if (isPaused()) {
      releaseClaimedJob("metadata", job.id, metadataClaim(job), `metadata_status = 'pending'`);
      return;
    }
    recordMetadataSuccess(job, config, id, existingSidecars, true);
    return;
  }

  const args = [
    ytDlp(),
    job.url,
    ...cookiesArgs(config),
    ...jsRuntimeArgs(),
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
  args.push(...missingSidecarArgs(config, missing));

  const ctl = new AbortController();
  let proc: Bun.Subprocess | null = null;
  const timer = setTimeout(() => {
    ctl.abort();
    // Abort normally terminates the child. Force-kill as a bounded fallback so
    // a tool that ignores SIGTERM cannot pin this worker forever.
    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  }, 10 * 60 * 1000);
  let stdoutText = "";
  let stderrText = "";
  let code = -1;
  try {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: ctl.signal });
    proc = child;
    activeMetadataProcs.set(id, child);
    // Drain both pipes concurrently to avoid deadlock.
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    [stdoutText, stderrText, code] = await Promise.all([stdoutPromise, stderrPromise, child.exited]);
  } finally {
    clearTimeout(timer);
    activeMetadataProcs.delete(id);
    // If pipe setup/reading fails before proc.exited settles, do not leave an
    // untracked yt-dlp child running against a job whose claim will be released.
    if (proc) await stopMetadataProcess(proc);
  }

  if (isPaused()) {
    releaseClaimedJob("metadata", job.id, metadataClaim(job), `metadata_status = 'pending'`);
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
  const sidecars = findSidecarFiles(entries, mediaBase, mediaFilename);
  recordMetadataSuccess(job, config, id, sidecars, false, missing);
}

/** Metadata failures retry with exponential backoff up to the per-video cap. */
async function handleMetadataFailure(job: Job, config: Config, err: any, id: number): Promise<void> {
  const errMsg = String(err?.message || err).slice(0, 500);
  if (isPaused()) {
    releaseClaimedJob("metadata", job.id, metadataClaim(job), `metadata_status = 'pending'`);
    return;
  }
  const attempts = (job.metadata_retry_count || 0) + 1;
  const permanentSourceError = isPermanentDownloadError(errMsg);
  const cap = perVideoCap(config);
  const newStatus = permanentSourceError || attempts >= cap ? "failed" : "pending";
  // CAS on the claim token: a worker that lost its claim leaves the outcome to
  // the new owner instead of overwriting it.
  const landed = releaseClaimedJob(
    "metadata",
    job.id,
    metadataClaim(job),
    `metadata_status = ?, metadata_retry_count = ?, last_error = ?`,
    [newStatus, attempts, errMsg],
  );
  if (landed !== 1) {
    if (db.query("SELECT id FROM jobs WHERE id = ?").get(job.id)) {
      logError("metadata", `${job.id} ${job.title}: metadata claim lost before recording the failure`);
    }
    return;
  }
  if (newStatus === "failed") {
    stats.failed++;
    if (permanentSourceError) {
      // A private, removed, or otherwise permanently unavailable source is not
      // a metadata-service outage. Park it without burning the retry budget or
      // tripping the post-processing circuit breaker.
      notePipelineSuccess("post");
      updateMetadataWorkerLine(id, `⚠️ Metadata unavailable at source | ${job.title}`, config);
    } else {
      logError("metadata", `${job.id} ${job.title}: ${errMsg}`);
      notePipelineFailure("post", config);
      updateMetadataWorkerLine(id, `❌ Metadata failed | ${job.title}`, config);
    }
  } else {
    // Bounded like the converter: the job is already re-queued for any free
    // worker, so this delay only avoids hammering a failing endpoint. The
    // failed-job sweep applies the real cooldown once the budget is spent.
    const backoff = Math.min(computeBackoffMs(attempts, config.retryBackoffBaseSeconds, config.retryBackoffMaxSeconds), 5_000);
    updateMetadataWorkerLine(id, `🔁 Retrying in ${Math.max(1, Math.round(backoff / 1000))}s | ${job.title}`, config);
    await Bun.sleep(backoff);
  }
}

function updateMetadataWorkerLine(id: number, text: string, config: Config): void {
  workerStatuses.set(`MD${id}`, text);
  updateAbsoluteLine(2 + config.maxDownloadWorkers + config.maxConcurrentConverts + id, `[MD${id}] ${text}`);
}
