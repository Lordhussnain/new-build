// src/metadata-only.ts — fetch sidecar metadata for a video or playlist without
// downloading the videos.
//
// The sidecars (subtitles, thumbnail, description, info.json) are written into
// the folder the videos would use, so a later download lands next to them. No
// job rows are created: this is a one-off background task, shown in the web UI
// until it finishes. Tasks run one at a time so several pasted links do not
// hit YouTube in parallel.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cookiesArgs, jsRuntimeArgs, ytDlp } from "./tools";
import { getPlaylistItems, PLAYLIST_SCAN_TIMEOUT_MS, type ListingItem } from "./scanner";
import { missingSidecarArgs } from "./workers/metadata";
import type { MetadataKind } from "./metadata-files";
import { sanitizeFolderName } from "./util";
import { db, reserveFileIndex } from "./db";
import { jobFittedBaseFilename } from "./download-args";
import { getConfig } from "./state";
import { logError } from "./logger";
import type { Config } from "./config";

export const METADATA_KINDS: MetadataKind[] = ["subtitles", "thumbnail", "description", "infoJson"];

export type MetadataOnlyStatus = "queued" | "listing" | "running" | "done" | "failed";

export interface MetadataOnlyTask {
  id: string;
  url: string;
  kinds: MetadataKind[];
  status: MetadataOnlyStatus;
  folder: string | null;
  total: number;
  done: number;
  failed: number;
  message: string;
  /** The most recent per-video errors (capped). */
  errors: string[];
  createdAt: string;
  finishedAt: string | null;
}

/** Per-video cap: a stuck fetch must not hold the queue forever. */
const ITEM_TIMEOUT_MS = 10 * 60_000;
/** Finished tasks kept for the UI; older ones are dropped. */
const MAX_TASKS = 25;
const MAX_ERRORS = 20;

const tasks = new Map<string, MetadataOnlyTask>();
let queue: Promise<void> = Promise.resolve();
let nextId = 1;

export function listMetadataOnlyTasks(): MetadataOnlyTask[] {
  return [...tasks.values()].reverse();
}

/** Register a task and queue it behind any task already running. */
export function startMetadataOnly(url: string, kinds: MetadataKind[], config: Config): MetadataOnlyTask {
  const task: MetadataOnlyTask = {
    id: `mo-${nextId++}`,
    url,
    kinds: [...kinds],
    status: "queued",
    folder: null,
    total: 0,
    done: 0,
    failed: 0,
    message: "Waiting for the previous task…",
    errors: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  tasks.set(task.id, task);
  trimTasks();
  queue = queue.then(() => runTask(task, config)).catch(() => {});
  return task;
}

function trimTasks(): void {
  if (tasks.size <= MAX_TASKS) return;
  for (const [id, t] of tasks) {
    if (tasks.size <= MAX_TASKS) break;
    if (t.status === "done" || t.status === "failed") tasks.delete(id);
  }
}

function finish(task: MetadataOnlyTask, status: "done" | "failed", message: string): void {
  task.status = status;
  task.message = message;
  task.finishedAt = new Date().toISOString();
}

async function runTask(task: MetadataOnlyTask, config: Config): Promise<void> {
  if (getConfig().offlineMode) {
    finish(task, "failed", "Offline mode is on — metadata fetch skipped");
    return;
  }
  task.status = "listing";
  task.message = "Listing the link…";
  try {
    const items = await getPlaylistItems(task.url, config, { timeoutMs: PLAYLIST_SCAN_TIMEOUT_MS });
    if (items.length === 0) {
      finish(task, "failed", "No videos found at this link (check the URL, network, or cookies)");
      return;
    }
    task.total = items.length;
    const folder = sanitizeFolderName(items[0].playlist || "Single Videos");
    task.folder = folder;
    const outputDir = join(config.outputRoot, folder);
    await mkdir(outputDir, { recursive: true });

    task.status = "running";
    for (const item of items) {
      if (getConfig().offlineMode) {
        finish(task, "failed", `Stopped: offline mode turned on after ${task.done + task.failed} of ${task.total}`);
        return;
      }
      const naming = resolveNaming(item, folder, outputDir);
      const error = await fetchSidecars(item, naming.outputDir, naming.base, config, task.kinds);
      if (error) {
        task.failed++;
        task.errors.push(`${item.title}: ${error}`);
        task.errors = task.errors.slice(-MAX_ERRORS);
      } else {
        task.done++;
      }
      task.message = `${task.done + task.failed} of ${task.total} processed`;
    }
    const suffix = task.failed > 0 ? `; ${task.failed} failed` : "";
    finish(
      task,
      task.done === 0 ? "failed" : "done",
      `Saved metadata for ${task.done} of ${task.total} video(s) to ${folder}${suffix}`,
    );
  } catch (err: any) {
    const message = String(err?.message || err);
    logError("metadata-only", `${task.url}: ${message}`);
    finish(task, "failed", message);
  }
}

/**
 * The directory and base file name the download will use for this video, so
 * the sidecars match it exactly:
 *  - a job already exists → its own directory and name (that is what the
 *    download writes);
 *  - otherwise → the next playlist index, reserved for this video, named the
 *    way ingestItems will name the job.
 */
function resolveNaming(item: ListingItem, folder: string, outputDir: string): { outputDir: string; base: string } {
  const job = db
    .query(`SELECT id, "index", title, output_directory FROM jobs WHERE id = ?`)
    .get(item.id) as { id: string; index: number; title: string; output_directory: string } | null;
  if (job) return { outputDir: job.output_directory, base: jobFittedBaseFilename(job) };
  const index = reserveFileIndex(folder, item.id);
  const base = jobFittedBaseFilename({ id: item.id, index, title: item.title, output_directory: outputDir });
  return { outputDir, base };
}

/** Fetch the requested sidecars for one video. Returns an error string, or null on success. */
async function fetchSidecars(
  item: ListingItem,
  outputDir: string,
  base: string,
  config: Config,
  kinds: MetadataKind[],
): Promise<string | null> {
  const args = [
    ytDlp(),
    `https://www.youtube.com/watch?v=${item.id}`,
    ...cookiesArgs(config),
    ...jsRuntimeArgs(),
    "--skip-download",
    "--no-simulate",
    "-o",
    join(outputDir, `${base}.%(ext)s`),
    "--socket-timeout",
    "15",
    "--retries",
    "5",
    "--newline",
    "--no-colors",
    ...missingSidecarArgs(config, kinds),
  ];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ITEM_TIMEOUT_MS);
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: ctl.signal });
    const [, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (ctl.signal.aborted) return `timed out after ${ITEM_TIMEOUT_MS / 60_000} minutes`;
    if (code !== 0) {
      const tail = stderr
        .split("\n")
        .filter((l) => l.trim())
        .slice(-2)
        .join(" ");
      return tail.slice(0, 300) || `yt-dlp exited with code ${code}`;
    }
    return null;
  } catch (err: any) {
    return String(err?.message || err).slice(0, 300);
  } finally {
    clearTimeout(timer);
  }
}
