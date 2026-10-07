// src/web.ts — dashboard web server + JSON API.
//
// Security model: loopback-only by default (webBind), and every request — UI
// and API — is gated behind the optional shared-secret token (cookie,
// Authorization: Bearer, X-Web-Token header, or ?token= query param), with
// timing-safe comparison. The destructive routes (purge, delete) are behind
// the same gate.

import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import os from "node:os";
import { associateExistingJobsWithSource, db } from "./db";
import { autoscaler, activeDlSlots } from "./autoscale";
import { activeDownloadJobs, getConfig, getPauseReason, isPaused, workerStatuses } from "./state";
import { getPlaylistItems, scanAndIngest } from "./scanner";
import { parseSourceUrl, removeSource, saveSource, SOURCE_KEYS, sourceIdentity, type SourceUrl } from "./sources";
import { diskUsage, triggerPause, triggerResume } from "./resilience";
import { removeFromArchive } from "./archive";
import { requeueFailedJobs, stashDownloadedFile, staleClaimCondition, STALE_CLAIM_THRESHOLDS } from "./reconcile";
import { holdsEngineLease, isLeaseExpired, readEngineLease } from "./lease";
import { buildRunReport } from "./report";
import { isPermanentDownloadError } from "./retry";
import { aria2cPath } from "./tools";
import { applySettings, readSettings } from "./settings";
import { effectiveTargetFormat, effectiveVideoQuality, resolveDownloaderEngine } from "./download-args";
import { parseSelectionJson, parseTracksJson, probeAudioTracks } from "./audio-tracks";
import { formatBytesPerSec, formatDuration } from "./util";
import { errorLogPath, logError } from "./logger";
import { QUALITY_FORMATS, withConfigWriteLock, type Config } from "./config";

// --- Web UI auth (optional shared-secret token) ------------------------------
// When webToken is set, every request must present it — as a cookie (set after
// the first successful sign-in), an Authorization: Bearer header, an
// X-Web-Token header, or a ?token= query parameter. Comparison is timing-safe.
export function extractWebToken(req: Request, url: URL): string | null {
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const header = req.headers.get("x-web-token");
  if (header) return header.trim();
  const query = url.searchParams.get("token");
  if (query) return query.trim();
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)yta_token=([^;]+)/);
  if (match) return decodeURIComponent(match[1]).trim();
  return null;
}

export function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function isAuthorized(req: Request, url: URL, config: Config): boolean {
  if (!config.webToken) return true;
  const presented = extractWebToken(req, url);
  return !!presented && timingSafeEq(presented, config.webToken);
}

// Minimal sign-in page: submits the token as ?token=..., the server validates
// it, sets an HttpOnly cookie, and serves the real UI — so the stock dashboard
// JS (plain fetch, no token logic) keeps working unchanged.
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Archive — Sign in</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1e293b; padding: 2rem; border-radius: 12px; width: min(360px, 90vw); box-shadow: 0 10px 40px rgba(0,0,0,.4); }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .8rem; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 1rem; }
  button { margin-top: .8rem; width: 100%; padding: .6rem; border: 0; border-radius: 8px; background: #3b82f6; color: white; font-size: 1rem; cursor: pointer; }
  .err { color: #f87171; font-size: .85rem; margin-top: .6rem; min-height: 1.2em; }
</style></head>
<body><div class="card">
  <h1>Archive Web UI — sign in</h1>
  <form onsubmit="return go()">
    <input id="token" type="password" placeholder="Access token" autofocus>
    <button type="submit">Sign in</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
  function go() {
    const t = document.getElementById('token').value.trim();
    if (!t) return false;
    location.href = '/?token=' + encodeURIComponent(t);
    return false;
  }
  if (new URLSearchParams(location.search).has('token')) {
    document.getElementById('err').textContent = 'Invalid token — try again.';
  }
</script>
</body></html>`;

export function startWebServer(port: number, config: Config) {
  return Bun.serve({
    // LAN-safe default: listen on loopback unless webBind is explicitly set
    // (e.g. 0.0.0.0 to reach the UI from other devices on the LAN).
    port,
    hostname: config.webBind || "127.0.0.1",
    async fetch(req) {
      // Every request is wrapped: a handler crash returns JSON 500 instead of
      // hanging the socket, and the error lands in error.log.
      try {
        // Read the live config, not the one captured at startup: settings
        // changed from the dashboard (POST /api/settings) must be reflected by
        // every endpoint immediately, and setConfig() replaces the object.
        return await handleRequest(req, getConfig());
      } catch (e: any) {
        logError("http", `${req.method} ${new URL(req.url).pathname}: ${e?.stack || e}`);
        return Response.json({ ok: false, error: "Internal server error" }, { status: 500 });
      }
    },
  });
}

export async function handleRequest(req: Request, config: Config): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/") {
    const queryToken = url.searchParams.get("token");
    if (config.webToken && !isAuthorized(req, url, config)) {
      // Missing/wrong token → the sign-in page (401 so browsers don't treat it
      // as the real app). A *valid* query token falls through, gets served the
      // app, and receives an HttpOnly cookie for subsequent requests.
      return new Response(LOGIN_PAGE, {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (existsSync("./web_ui.html")) {
      const headers: Record<string, string> = { "Content-Type": "text/html" };
      if (config.webToken && queryToken) {
        headers["Set-Cookie"] = `yta_token=${encodeURIComponent(queryToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;
      }
      return new Response(Bun.file("./web_ui.html"), { headers });
    }
    return new Response("web_ui.html not found. Please create it.", { status: 500 });
  }

  // Every API route (status, scan, pause/resume, purge, delete, ...) is gated
  // behind the token too — purge/delete are destructive.
  if (!isAuthorized(req, url, config)) {
    return Response.json({ ok: false, error: "Unauthorized — token required" }, { status: 401 });
  }

  // Collapse trailing slashes so /api/jobs/ and /api/jobs are the same route
  // (the root "/" is handled above).
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return handleApi(req, config, url, pathname);
}

// --- API routing --------------------------------------------------------------
// A route table instead of an if-chain: patterns support `:param` segments,
// every response shares the `{ok, ...}` envelope, unknown API paths get a JSON
// 404, and a known path with the wrong method gets a JSON 405 (+ Allow).
//
// Legacy action paths stay alive as aliases of the canonical per-job routes so
// existing bookmarks, scripts, and older dashboards keep working:
//   POST /api/retry/:id             → POST /api/jobs/:id/retry
//   POST /api/failcount/reset/:id   → POST /api/jobs/:id/reset-failures
//   POST /api/jobs/delete {ids}     → DELETE /api/jobs {ids}

type RouteParams = Record<string, string>;
type RouteHandler = (ctx: {
  req: Request;
  config: Config;
  url: URL;
  params: RouteParams;
}) => Response | Promise<Response>;

interface Route {
  methods: string[];
  pattern: string;
  handler: RouteHandler;
}

/** Match a `/api/…/:param` pattern against path segments; null = no match. */
function matchRoute(pattern: string, segments: string[]): RouteParams | null {
  const parts = pattern.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith(":")) {
      if (!segments[i]) return null; // never bind an empty param
      params[p.slice(1)] = decodeURIComponent(segments[i]);
    } else if (p !== segments[i]) {
      return null;
    }
  }
  return params;
}

// The jobs list and the single-job endpoint must return identical shapes.
const JOB_COLUMNS = `id, url, title, folder, output_directory, file_path, target_format, video_quality,
                download_status, conversion_status, metadata_status, pause_reason, metadata_files,
                retry_count, conversion_retry_count, resume_count, best_progress, last_error,
                file_size, progress, speed, eta, duration, partial_file_path,
                audio_tracks, audio_selection, superseded_file,
                want_subtitles, want_thumbnail, want_description`;

/** JSON-valued columns in SQLite; hand the dashboard real arrays/nulls. */
function mapJobRow(r: any) {
  let metadataFiles: string[] = [];
  try {
    const v = JSON.parse(r.metadata_files);
    if (Array.isArray(v)) metadataFiles = v.filter((x: unknown) => typeof x === "string");
  } catch {
    // null / missing / legacy — treat as no sidecars recorded
  }
  return {
    ...r,
    audio_tracks: parseTracksJson(r.audio_tracks) ?? [],
    audio_selection: parseSelectionJson(r.audio_selection),
    metadata_files: metadataFiles,
    want_subtitles: !!r.want_subtitles,
    want_thumbnail: !!r.want_thumbnail,
    want_description: !!r.want_description,
  };
}

// A job is "in progress" (never safe to mutate from the dashboard) when any
// stage is running or any claim lease is still attached. Claims are identified
// by their token as well as the worker id, so a row whose status was flipped
// without releasing its claim cannot slip past the guard.
const ACTIVE_JOB_PREDICATE = `
  COALESCE(download_status, '') = 'downloading'
  OR download_claimed_by IS NOT NULL
  OR download_claim_token IS NOT NULL
  OR COALESCE(conversion_status, '') = 'in_progress'
  OR conversion_claimed_by IS NOT NULL
  OR conversion_claim_token IS NOT NULL
  OR COALESCE(metadata_status, '') = 'in_progress'
  OR metadata_claim_token IS NOT NULL
`;

const PURGE_QUEUE_PREDICATE = "download_status IN ('pending', 'paused', 'waiting_live', 'failed')";

type IdleJobResult<T> = { ok: true; value: T } | { ok: false };

/** Run a synchronous job mutation only while none of its rows has a live stage claim. */
function withIdleJobs<T>(ids: string[], operation: () => T): IdleJobResult<T> {
  const placeholders = ids.map(() => "?").join(",");
  const transaction = db.transaction(() => {
    const active = db
      .query(`SELECT id FROM jobs WHERE id IN (${placeholders}) AND (${ACTIVE_JOB_PREDICATE}) LIMIT 1`)
      .get(...ids);
    if (active) return { ok: false as const };
    return { ok: true as const, value: operation() };
  });
  return transaction.immediate();
}

function jobInProgressResponse(): Response {
  return Response.json({ ok: false, error: "Job is currently in progress" }, { status: 409 });
}

interface JobOverride {
  targetFormat?: string | null;
  videoQuality?: string | null;
  /** Language codes from the track picker; null restores the global audio mode. */
  audioTracks?: string[] | null;
}

const JOB_TARGET_FORMATS = new Set(["mp4", "mkv", "webm", "mp3", "m4a"]);

function parseJobOverride(body: unknown): { ok: true; value: JobOverride } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "A JSON object with at least one override is required" };
  }
  const raw = body as Record<string, unknown>;
  const allowed = new Set(["targetFormat", "videoQuality", "audioTracks", "retry"]);
  const unexpected = Object.keys(raw).find((key) => !allowed.has(key));
  if (unexpected) return { ok: false, error: `Unknown override field: ${unexpected}` };
  const value: JobOverride = {};
  let provided = false;

  if (Object.hasOwn(raw, "targetFormat")) {
    provided = true;
    if (raw.targetFormat !== null && (typeof raw.targetFormat !== "string" || !JOB_TARGET_FORMATS.has(raw.targetFormat))) {
      return { ok: false, error: "targetFormat must be mp4, mkv, webm, mp3, m4a, or null" };
    }
    value.targetFormat = raw.targetFormat as string | null;
  }
  if (Object.hasOwn(raw, "videoQuality")) {
    provided = true;
    if (raw.videoQuality !== null && (typeof raw.videoQuality !== "string" || !Object.hasOwn(QUALITY_FORMATS, raw.videoQuality))) {
      return { ok: false, error: `videoQuality must be one of ${Object.keys(QUALITY_FORMATS).join(", ")} or null` };
    }
    value.videoQuality = raw.videoQuality as string | null;
  }
  if (Object.hasOwn(raw, "audioTracks")) {
    provided = true;
    if (raw.audioTracks !== null && !Array.isArray(raw.audioTracks)) {
      return { ok: false, error: "audioTracks must be an array of language codes or null" };
    }
    if (Array.isArray(raw.audioTracks)) {
      if (raw.audioTracks.length > 40 || raw.audioTracks.some((track) =>
        typeof track !== "string" || !track.trim() || track.trim().length > 32
      )) {
        return { ok: false, error: "audioTracks must contain up to 40 non-empty language codes (32 characters max)" };
      }
      const languages = [...new Set(raw.audioTracks.map((track) => (track as string).trim()))];
      value.audioTracks = languages.length ? languages : null;
    } else {
      value.audioTracks = null;
    }
  }

  if (raw.retry !== undefined && typeof raw.retry !== "boolean") {
    return { ok: false, error: "retry must be a boolean" };
  }
  if (!provided && raw.retry !== true) {
    return { ok: false, error: "Provide at least one of: targetFormat, videoQuality, audioTracks" };
  }
  return { ok: true, value };
}

/** Apply a validated override inside the surrounding SQLite transaction. */
function persistJobOverride(id: string, override: JobOverride): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (Object.hasOwn(override, "targetFormat")) {
    sets.push("target_format = ?");
    values.push(override.targetFormat ?? null);
  }
  if (Object.hasOwn(override, "videoQuality")) {
    sets.push("video_quality = ?");
    values.push(override.videoQuality ?? null);
  }
  if (Object.hasOwn(override, "audioTracks")) {
    sets.push("audio_selection = ?");
    values.push(override.audioTracks?.length ? JSON.stringify(override.audioTracks) : null);
  }
  if (sets.length === 0) return;
  db.run(`UPDATE jobs SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...values, id]);
}

/**
 * Re-queue a job with fresh budgets (download + any failed side stages).
 *
 * A retry of an already-downloaded video is a DELIBERATE re-fetch — the usual
 * reason is a new multi-audio track selection from the dashboard — so two
 * extra steps make the re-download actually happen:
 *   • the video id is scrubbed from the yt-dlp archive file, otherwise yt-dlp
 *     answers "has already been recorded in the archive" and exits 0 without
 *     downloading anything;
 *   • the existing media file is moved aside (.superseded), otherwise
 *     `--no-overwrites` skips the download the same way. The backup is
 *     deleted when the new download succeeds and restored if it fails
 *     permanently (see reconcile.ts).
 * Active download, conversion, and metadata claims return "in-progress" before
 * the archive or any media file is touched.
 */
function retryJobById(id: string, config: Config, override?: JobOverride): number | "in-progress" {
  const result = withIdleJobs([id], () => {
    const existing = db.query("SELECT id, target_format, video_quality FROM jobs WHERE id = ?").get(id) as
      | { id: string; target_format: string | null; video_quality: string | null }
      | null;
    if (!existing) return 0;
    if (override) persistJobOverride(id, override);

    const row = db.query("SELECT id, file_path, target_format, video_quality, conversion_status FROM jobs WHERE id = ?").get(id) as {
      id: string;
      file_path: string | null;
      target_format: string | null;
      video_quality: string | null;
      conversion_status: string;
    } | null;
    if (!row) return 0;
    removeFromArchive(config.archiveFile, id);
    // Move the previous file aside BEFORE the job becomes claimable: a worker
    // that grabs it while the old file still exists would get a yt-dlp skip
    // (`--no-overwrites`) instead of a real download. Throws when the file
    // cannot be renamed — the route then answers 500 instead of starting a
    // download that would silently no-op.
    stashDownloadedFile(id, row.file_path);

    // A per-job format/quality change must pass through conversion even when
    // the previous download needed no post-processing. Otherwise an audio-only
    // or container override could leave a file in yt-dlp's source container.
    const formatOrQualityChanged = !!override && (
      (Object.hasOwn(override, "targetFormat") && override.targetFormat !== existing.target_format) ||
      (Object.hasOwn(override, "videoQuality") && override.videoQuality !== existing.video_quality)
    );
    const needsConversion =
      formatOrQualityChanged || effectiveTargetFormat(row, config) !== "mp4" || effectiveVideoQuality(row, config) === "audio";
    const conversionStatus = !needsConversion && row.conversion_status === "not_needed" ? "not_needed" : "pending";

    // Re-queue download AND any failed side stages. Also clears a user pause and
    // resets the per-stage retry budgets so a manual retry always gets a fresh budget.
    return db.run(
      `UPDATE jobs SET
         download_status = 'pending', pause_reason = NULL, progress = 0, retry_count = 0,
         best_progress = 0, resume_count = 0, speed = 0, eta = 0,
         conversion_status = ?, conversion_retry_count = 0,
         metadata_status = CASE
           WHEN COALESCE(want_subtitles,0) + COALESCE(want_thumbnail,0) + COALESCE(want_description,0) > 0 THEN 'pending'
           ELSE metadata_status END,
         metadata_retry_count = 0,
         last_error = NULL,
         download_claimed_by = NULL, download_claimed_at = NULL,
         download_claim_token = NULL, download_heartbeat_at = NULL,
         conversion_claimed_by = NULL, conversion_claimed_at = NULL,
         conversion_claim_token = NULL, conversion_heartbeat_at = NULL,
         metadata_claimed_by = NULL, metadata_claimed_at = NULL,
         metadata_claim_token = NULL, metadata_heartbeat_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND NOT (${ACTIVE_JOB_PREDICATE})`,
      [conversionStatus, id],
    ).changes;
  });
  return result.ok ? result.value : "in-progress";
}

/** Save per-job settings without queuing a download. */
function saveJobOverrideById(id: string, config: Config, override: JobOverride): number | "in-progress" {
  const result = withIdleJobs([id], () => {
    const row = db.query("SELECT id, download_status, target_format, video_quality FROM jobs WHERE id = ?").get(id) as
      | { id: string; download_status: string; target_format: string | null; video_quality: string | null }
      | null;
    if (!row) return 0;
    persistJobOverride(id, override);
    const fresh = db.query("SELECT target_format, video_quality FROM jobs WHERE id = ?").get(id) as {
      target_format: string | null;
      video_quality: string | null;
    };
    const formatOrQualityChanged =
      (Object.hasOwn(override, "targetFormat") && override.targetFormat !== row.target_format) ||
      (Object.hasOwn(override, "videoQuality") && override.videoQuality !== row.video_quality);
    const needsConversion =
      formatOrQualityChanged || effectiveTargetFormat(fresh, config) !== "mp4" || effectiveVideoQuality(fresh, config) === "audio";
    // A queued job will use the new container on its next fetch. Leave an
    // already-downloaded job alone unless retry=true (which stashes/re-fetches
    // it atomically), but make sure queued work gets its post-download remux.
    if (row.download_status !== "downloaded" && needsConversion) {
      db.run(
        `UPDATE jobs SET conversion_status = 'pending', conversion_retry_count = 0,
           conversion_claimed_by = NULL, conversion_claimed_at = NULL,
           conversion_claim_token = NULL, conversion_heartbeat_at = NULL,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id],
      );
    }
    return 1;
  });
  return result.ok ? result.value : "in-progress";
}

/** Clear every per-stage failure counter for one job. */
function resetFailCounters(id: string): number {
  if (!id) return 0;
  return db.run(
    `UPDATE jobs SET retry_count = 0, metadata_retry_count = 0, conversion_retry_count = 0, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [id],
  ).changes;
}

/** Delete a set of jobs by id (bulk action from the dashboard). */
async function deleteJobsBulk(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((x: any) => typeof x === "string" && x.length > 0).slice(0, 500)
    : [];
  if (ids.length === 0) return Response.json({ ok: false, error: "No job ids provided" }, { status: 400 });
  const placeholders = ids.map(() => "?").join(",");
  const result = withIdleJobs(ids, () => db.run(`DELETE FROM jobs WHERE id IN (${placeholders})`, ids).changes);
  if (!result.ok) return jobInProgressResponse();
  return Response.json({ ok: true, deleted: result.value });
}

const ROUTES: Route[] = [
  {
    methods: ["GET", "HEAD"],
    pattern: "/api/ping",
    handler: () => new Response(null, { status: 200 }),
  },
  {
    methods: ["GET"],
    pattern: "/api/version",
    handler: (_ctx) =>
      Response.json({
        ok: true,
        name: "youtube-playlist-downloader",
        runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
        uptimeSeconds: Math.round(process.uptime()),
      }),
  },
  {
    methods: ["GET"],
    pattern: "/api/status",
    handler: async ({ config }) => {
      const statsData = db
        .query(
          `SELECT
          SUM(CASE WHEN download_status IN ('pending', 'paused', 'downloading') THEN 1 ELSE 0 END) as queued,
          SUM(CASE WHEN download_status = 'downloading' THEN 1 ELSE 0 END) as downloading,
          SUM(CASE WHEN download_status = 'downloaded' THEN 1 ELSE 0 END) as downloaded,
          SUM(CASE WHEN download_status = 'failed' OR conversion_status = 'failed' OR metadata_status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN metadata_status IN ('pending', 'in_progress') THEN 1 ELSE 0 END) as metadata_pending,
          SUM(CASE WHEN conversion_status IN ('pending', 'in_progress') THEN 1 ELSE 0 END) as converting,
          SUM(CASE WHEN download_status = 'waiting_live' THEN 1 ELSE 0 END) as waiting_live,
          COUNT(*) as total
        FROM jobs`,
        )
        .get() as any;
      const workers: { id: string; type: string; status: string }[] = [];
      for (let i = 1; i <= config.maxDownloadWorkers; i++) {
        workers.push({ id: `DL${i}`, type: "download", status: workerStatuses.get(`DL${i}`) || "Idle" });
      }
      for (let i = 1; i <= config.maxConcurrentConverts; i++) {
        workers.push({ id: `CV${i}`, type: "convert", status: workerStatuses.get(`CV${i}`) || "Idle" });
      }
      for (let i = 1; i <= config.maxMetadataWorkers; i++) {
        workers.push({ id: `MD${i}`, type: "metadata", status: workerStatuses.get(`MD${i}`) || "Idle" });
      }

      // Goes through the shared probe: on Windows Bun builds without statfs a
      // direct call throws synchronously and would 500 this whole endpoint.
      const disk = await diskUsage(config.outputRoot);
      const known = disk.freeBytes >= 0;
      const freeGB = known ? (disk.freeBytes / 1024 ** 3).toFixed(1) : "--";
      const totalGB = disk.totalBytes > 0 ? (disk.totalBytes / 1024 ** 3).toFixed(1) : "--";
      const diskPercent =
        known && disk.totalBytes > 0 ? ((disk.freeBytes / disk.totalBytes) * 100).toFixed(0) : "0";
      const diskLabel = known ? `${freeGB} GB / ${totalGB} GB` : "unknown";

      const memUsage = process.memoryUsage();
      const ramUsedGB = (memUsage.rss / 1024 ** 3).toFixed(2);
      const ramTotalGB = (os.totalmem() / 1024 ** 3).toFixed(2);
      const ramPercent = ((memUsage.rss / os.totalmem()) * 100).toFixed(0);
      const uptime = formatDuration(process.uptime());

      const avgSpeed = autoscaler.getAggregateSpeed();
      const remaining = db
        .query(
          `SELECT SUM(file_size * (1 - COALESCE(progress, 0) / 100)) as remaining FROM jobs WHERE download_status = 'downloading'`,
        )
        .get() as any;
      const secondsRemaining = avgSpeed > 0 && remaining.remaining ? remaining.remaining / avgSpeed : 0;
      const globalETA = secondsRemaining > 0 ? formatDuration(secondsRemaining) : "--";

      return Response.json({
        ok: true,
        stats: {
          totalQueued: statsData.queued || 0,
          downloading: statsData.downloading || 0,
          downloaded: statsData.downloaded || 0,
          failed: statsData.failed || 0,
          metadataPending: statsData.metadata_pending || 0,
          converting: statsData.converting || 0,
          waitingLive: statsData.waiting_live || 0,
          total: statsData.total || 0,
        },
        queuePosition: statsData.queued || 0,
        speed: avgSpeed,
        aggregateSpeed: formatBytesPerSec(avgSpeed),
        activeWorkers: activeDlSlots.size,
        targetWorkers: autoscaler.targetWorkers,
        workers,
        isPaused: isPaused(),
        pauseReason: getPauseReason(),
        diskSpace: { free: diskLabel, percent: parseFloat(diskPercent) },
        system: {
          cpu: "--",
          cpuPercent: 0,
          ram: `${ramUsedGB} GB / ${ramTotalGB} GB`,
          ramPercent: parseFloat(ramPercent),
        },
        runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
        uptime,
        globalETA,
      });
    },
  },
  {
    methods: ["GET"],
    pattern: "/api/jobs",
    handler: () => {
      const rows = db.query(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY created_at DESC LIMIT 500`).all() as any[];
      return Response.json({ ok: true, jobs: rows.map(mapJobRow) });
    },
  },
  {
    methods: ["GET"],
    pattern: "/api/jobs/:id",
    handler: ({ params }) => {
      const row = db.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(params.id) as any;
      if (!row) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
      return Response.json({ ok: true, job: mapJobRow(row) });
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/jobs/:id/override",
    handler: async ({ req, params, config }) => {
      const body = await req.json().catch(() => null);
      const parsed = parseJobOverride(body);
      if (!parsed.ok) return Response.json({ ok: false, error: parsed.error }, { status: 400 });
      const retry = (body as Record<string, unknown>).retry === true;

      try {
        const changed = retry
          ? retryJobById(params.id, config, parsed.value)
          : saveJobOverrideById(params.id, config, parsed.value);
        if (changed === "in-progress") return jobInProgressResponse();
        if (changed === 0) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
        const saved = db.query("SELECT target_format, video_quality, audio_selection FROM jobs WHERE id = ?").get(params.id) as any;
        return Response.json({
          ok: true,
          queued: retry,
          targetFormat: saved.target_format,
          videoQuality: saved.video_quality,
          audioTracks: parseSelectionJson(saved.audio_selection),
        });
      } catch (e: any) {
        return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
      }
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/jobs/:id/retry",
    handler: ({ params, config }) => {
      try {
        const changed = retryJobById(params.id, config);
        if (changed === "in-progress") return jobInProgressResponse();
        if (changed === 0) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
      }
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/jobs/:id/reset-failures",
    handler: ({ params }) => {
      const changed = resetFailCounters(params.id);
      if (changed === 0) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
      return Response.json({ ok: true });
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/jobs/:id/audio-tracks",
    handler: async ({ req, params }) => {
      // Per-job audio-track picker (YouTube multi-language audio): save which
      // languages the next download attempt should keep. `tracks: null` resets
      // the job to the global multi-audio mode. Takes effect on the next
      // attempt — use Retry job to fetch an already-downloaded video again.
      const id = params.id;
      const row = db.query("SELECT id FROM jobs WHERE id = ?").get(id);
      if (!row) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
      const body = await req.json().catch(() => ({}));
      const raw = body?.tracks;
      if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
        return Response.json(
          { ok: false, error: "tracks must be an array of language codes or null" },
          { status: 400 },
        );
      }
      const cleaned = Array.isArray(raw)
        ? raw
            .filter((t: any) => typeof t === "string" && t.trim())
            .map((t: string) => t.trim().slice(0, 32))
            .slice(0, 40)
        : null;
      db.run(`UPDATE jobs SET audio_selection = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
        cleaned ? JSON.stringify(cleaned) : null,
        id,
      ]);
      return Response.json({ ok: true, audio_selection: cleaned });
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/jobs/:id/audio-probe",
    handler: async ({ req, config, params }) => {
      // Discover (or refresh) the audio tracks YouTube offers for one job —
      // the dashboard's track picker needs the list before a download has run.
      const id = params.id;
      const job = db.query("SELECT id, url FROM jobs WHERE id = ?").get(id) as
        | { id: string; url: string }
        | null;
      if (!job) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
      try {
        const tracks = await probeAudioTracks(job.url, config);
        db.run(`UPDATE jobs SET audio_tracks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
          JSON.stringify(tracks),
          id,
        ]);
        return Response.json({ ok: true, tracks });
      } catch (e: any) {
        return Response.json(
          { ok: false, error: String(e?.message || e).slice(0, 300) },
          { status: 502 },
        );
      }
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/jobs/:id/sidecars",
    handler: async ({ req, params }) => {
      // Per-job sidecar toggles (subtitles / thumbnail / description) from the
      // dashboard. Normally fixed at ingest time from the global config, but a
      // downloaded job can still ask for its sidecars: flipping a flag on
      // re-queues the metadata stage, which fetches against the existing media
      // file. Flipping a flag off never deletes files that were already fetched.
      const id = params.id;
      const row = db
        .query("SELECT id, download_status, metadata_status FROM jobs WHERE id = ?")
        .get(id) as { id: string; download_status: string; metadata_status: string } | null;
      if (!row) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
      const body = await req.json().catch(() => ({}));
      const flags: { column: string; key: string }[] = [
        { column: "want_subtitles", key: "subtitles" },
        { column: "want_thumbnail", key: "thumbnail" },
        { column: "want_description", key: "description" },
      ];
      const sets: string[] = [];
      const values: (number | string)[] = [];
      for (const f of flags) {
        const v = (body as Record<string, unknown>)[f.key];
        if (v === undefined) continue;
        if (typeof v !== "boolean") {
          return Response.json(
            { ok: false, error: `${f.key} must be a boolean` },
            { status: 400 },
          );
        }
        sets.push(`${f.column} = ?`);
        values.push(v ? 1 : 0);
      }
      if (sets.length === 0) {
        return Response.json(
          { ok: false, error: "Provide at least one of: subtitles, thumbnail, description" },
          { status: 400 },
        );
      }
      values.push(id);
      db.run(`UPDATE jobs SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, values);
      // Newly wanted sidecars for a finished download: re-open the metadata
      // stage so the worker fetches them now (unless it is already running).
      if (row.download_status === "downloaded" && !["pending", "in_progress"].includes(row.metadata_status)) {
        db.run(
          `UPDATE jobs SET metadata_status = CASE
             WHEN COALESCE(want_subtitles,0) + COALESCE(want_thumbnail,0) + COALESCE(want_description,0) > 0
               THEN 'pending' ELSE metadata_status END,
             metadata_retry_count = 0,
             metadata_claimed_by = NULL, metadata_claimed_at = NULL,
             metadata_claim_token = NULL, metadata_heartbeat_at = NULL,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [id],
        );
      }
      const fresh = db
        .query("SELECT want_subtitles, want_thumbnail, want_description, metadata_status FROM jobs WHERE id = ?")
        .get(id) as any;
      return Response.json({
        ok: true,
        want_subtitles: !!fresh.want_subtitles,
        want_thumbnail: !!fresh.want_thumbnail,
        want_description: !!fresh.want_description,
        metadata_status: fresh.metadata_status,
      });
    },
  },
  {
    methods: ["DELETE"],
    pattern: "/api/jobs/:id",
    handler: ({ params }) => {
      const result = withIdleJobs([params.id], () => db.run(`DELETE FROM jobs WHERE id = ?`, [params.id]).changes);
      if (!result.ok) return jobInProgressResponse();
      if (result.value === 0) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
      return Response.json({ ok: true, deleted: result.value });
    },
  },
  // Static action paths must be listed before the :id routes so GET on them
  // answers 405 (method not allowed) instead of being read as an id.
  {
    methods: ["POST"],
    pattern: "/api/jobs/pause",
    handler: async ({ req }) => {
      const body = await req.json().catch(() => ({}));
      const ids = Array.isArray(body?.ids)
        ? body.ids.filter((x: any) => typeof x === "string" && x.length > 0).slice(0, 500)
        : [];
      if (ids.length === 0) return Response.json({ ok: false, error: "No job ids provided" }, { status: 400 });
      const placeholders = ids.map(() => "?").join(",");
      // A job that is mid-download keeps its claim (owner + token + heartbeat)
      // while being parked: the worker is still running yt-dlp and will see
      // `pause_reason = 'user'` when it finishes, then release the claim itself
      // through its own token. Everything else is parked with the claim cleared.
      const result = withIdleJobs(ids, () =>
        db.run(
          `UPDATE jobs SET download_status = 'paused', pause_reason = 'user',
             download_claimed_by = CASE WHEN download_status = 'downloading' THEN download_claimed_by ELSE NULL END,
             download_claimed_at = CASE WHEN download_status = 'downloading' THEN download_claimed_at ELSE NULL END,
             download_claim_token = CASE WHEN download_status = 'downloading' THEN download_claim_token ELSE NULL END,
             download_heartbeat_at = CASE WHEN download_status = 'downloading' THEN download_heartbeat_at ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP
           WHERE id IN (${placeholders}) AND download_status IN ('pending', 'downloading', 'paused')`,
          ids,
        ).changes,
      );
      if (!result.ok) return jobInProgressResponse();
      return Response.json({ ok: true, paused: result.value });
    },
  },
  {
    methods: ["POST", "DELETE"],
    pattern: "/api/jobs/delete",
    handler: ({ req }) => deleteJobsBulk(req),
  },
  {
    methods: ["DELETE"],
    pattern: "/api/jobs",
    handler: ({ req }) => deleteJobsBulk(req),
  },
  // Legacy aliases (kept for older dashboards/scripts).
  {
    methods: ["POST"],
    pattern: "/api/retry/:id",
    handler: ({ params, config }) => {
      try {
        const changed = retryJobById(params.id, config);
        if (changed === "in-progress") return jobInProgressResponse();
        if (changed === 0) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
      }
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/failcount/reset/:id",
    handler: ({ params }) => {
      resetFailCounters(params.id);
      return Response.json({ ok: true });
    },
  },
  {
    methods: ["GET", "DELETE"],
    pattern: "/api/sources",
    handler: async ({ req, config }) => {
      if (req.method === "GET") {
        const seen = new Set<string>();
        const sources = SOURCE_KEYS.flatMap((key) =>
          config[key].flatMap((sourceUrl) => {
            const identity = sourceIdentity(sourceUrl);
            if (seen.has(identity)) return [];
            seen.add(identity);
            const row = db
              .query("SELECT COUNT(*) AS count FROM job_sources WHERE source_url = ?")
              .get(identity) as { count: number };
            return [{ key, url: sourceUrl, trackedJobs: row?.count || 0 }];
          }),
        );
        return Response.json({ ok: true, sources });
      }

      const body = await req.json().catch(() => null);
      if (!body || typeof body.url !== "string") {
        return Response.json({ ok: false, error: "A source URL is required" }, { status: 400 });
      }
      let source: SourceUrl;
      try {
        source = parseSourceUrl(body.url);
      } catch (error: any) {
        return Response.json({ ok: false, error: error?.message || "Invalid source URL" }, { status: 400 });
      }
      const identity = sourceIdentity(source.url);
      const configured = SOURCE_KEYS.some((key) => config[key].some((url) => sourceIdentity(url) === identity));
      if (!configured) {
        return Response.json({ ok: false, error: "Saved source not found" }, { status: 404 });
      }
      let legacyJobsLinked = 0;
      const tracked = db
        .query("SELECT COUNT(*) AS count FROM job_sources WHERE source_url = ?")
        .get(identity) as { count: number };
      // Older databases have jobs but no ownership table entries. When there
      // are no known links, list the source once and backfill matching job ids
      // so this first removal also cleans pre-upgrade queue rows.
      if ((tracked?.count || 0) === 0) {
        try {
          const items = await getPlaylistItems(source.url, config);
          legacyJobsLinked = associateExistingJobsWithSource(identity, items.map((item) => item.id));
        } catch (error: any) {
          logError("source-delete", `Legacy job lookup for ${source.url}: ${error?.message || error}`);
        }
      }
      try {
        const result = await removeSource(source.url);
        if (!result.removed) {
          return Response.json({ ok: false, error: "Saved source not found" }, { status: 404 });
        }
        return Response.json({
          ok: true,
          source: { url: result.url, key: result.key },
          removedConfigEntries: result.removedConfigEntries,
          affectedJobs: result.affectedJobs,
          legacyJobsLinked,
          deletedJobs: result.deletedJobs,
          retainedJobs: result.retainedJobs,
          message: `Removed source from config.json and deleted ${result.deletedJobs} job(s).`,
        });
      } catch (error: any) {
        logError("config", `Removing source ${source.url}: ${error?.message || error}`);
        return Response.json({
          ok: false,
          error: `Could not completely remove this source: ${error?.message || error}`,
        }, { status: 500 });
      }
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/scan",
    handler: async ({ req }) => {
      const body = await req.json().catch(() => null);
      let source: SourceUrl;
      try {
        source = parseSourceUrl(body?.url);
        if (body.folder !== undefined && typeof body.folder !== "string") throw new Error("Folder must be a string");
      } catch (e: any) {
        return Response.json({ ok: false, saved: false, error: e.message }, { status: 400 });
      }

      let savedSource: SourceUrl & { added: boolean };
      try {
        // Save first: a failed config write must not silently start a one-off
        // download, and a slow/failed scan must not lose the user's source.
        savedSource = await saveSource(source.url);
      } catch (e: any) {
        logError("config", `Saving source ${source.url}: ${e?.message || e}`);
        return Response.json({
          ok: false, saved: false,
          error: `Could not save URL to config.json; no scan was started. ${e?.message || e}`,
        }, { status: 500 });
      }
      try {
        const result = await scanAndIngest(source.url, getConfig(), body.folder?.trim() || undefined);
        const summary = result.found === 0
          ? `No videos found at ${source.url} (check the URL, network, or cookies)`
          : `Scanned ${result.found} video(s): ${result.added} added, ${result.skipped} skipped`;
        const message = `Saved to config.json (${savedSource.key}). ${summary}`;
        return Response.json({ ok: true, saved: true, source: savedSource, message, ...result });
      } catch (e: any) {
        logError("scan", `${source.url}: ${e?.message || e}`);
        return Response.json({
          ok: false, saved: true, source: savedSource,
          error: `URL saved to config.json, but the scan failed: ${e?.message || e}`,
        }, { status: 500 });
      }
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/queue/purge",
    handler: () => {
      const transaction = db.transaction(() => {
        const active = db
          .query(`SELECT id FROM jobs WHERE ${PURGE_QUEUE_PREDICATE} AND (${ACTIVE_JOB_PREDICATE}) LIMIT 1`)
          .get();
        if (active) return { ok: false as const };
        const result = db.run(
          `DELETE FROM jobs WHERE ${PURGE_QUEUE_PREDICATE}
             AND download_claimed_by IS NULL AND download_claim_token IS NULL
             AND conversion_claimed_by IS NULL AND conversion_claim_token IS NULL
             AND COALESCE(conversion_status, '') != 'in_progress'
             AND COALESCE(metadata_status, '') != 'in_progress'
             AND metadata_claim_token IS NULL`,
        );
        return { ok: true as const, deleted: result.changes };
      });
      const result = transaction.immediate();
      if (!result.ok) return jobInProgressResponse();
      return Response.json({ ok: true, deleted: result.deleted });
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/pause",
    handler: () => {
      triggerPause("MANUAL_WEB_UI");
      return Response.json({ ok: true, success: true, paused: true });
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/resume",
    handler: () => {
      triggerResume();
      return Response.json({ ok: true, success: true, paused: false });
    },
  },
  {
    methods: ["GET"],
    pattern: "/api/failed",
    handler: () => {
      const rows = db
        .query(
          `SELECT id, title, folder, output_directory, retry_count, conversion_retry_count, metadata_retry_count,
                  download_status, conversion_status, metadata_status, last_error
           FROM jobs
           WHERE download_status = 'failed' OR conversion_status = 'failed' OR metadata_status = 'failed'
           LIMIT 100`,
        )
        .all();
      return Response.json({ ok: true, failed: rows });
    },
  },
  {
    methods: ["POST"],
    pattern: "/api/failed/requeue",
    handler: ({ config }) => {
      // Re-queue retryable failed stages immediately, ignoring cooldown and
      // starting fresh windows; permanent downloads stay parked.
      const result = requeueFailedJobs(config, { ignoreCooldown: true });
      return Response.json({ ok: true, requeued: result });
    },
  },
  {
    methods: ["GET"],
    pattern: "/api/settings",
    handler: ({ config }) => Response.json({ ok: true, ...readSettings(config) }),
  },
  {
    methods: ["POST"],
    pattern: "/api/settings",
    handler: async ({ req }) => {
      let patch: unknown;
      try {
        patch = await req.json();
      } catch {
        return Response.json({ ok: false, error: "Expected a JSON body" }, { status: 400 });
      }
      const result = await withConfigWriteLock(() => applySettings(getConfig(), patch as Record<string, unknown>));
      if (!result.ok) {
        return Response.json({ ok: false, error: result.error }, { status: 400 });
      }
      // Echo back the fresh snapshot so the panel can re-render from the
      // server's view of the world rather than what it thinks it sent.
      return Response.json({
        ok: true,
        changed: result.changed,
        ...readSettings(result.config ?? getConfig()),
      });
    },
  },
  { methods: ["GET"], pattern: "/api/reliability", handler: ({ config }) => reliabilityHandler(config) },
  {
    methods: ["GET"],
    pattern: "/api/history",
    handler: ({ url }) => {
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      const rows = db.query("SELECT * FROM run_history ORDER BY ended_at DESC LIMIT ?").all(limit);
      return Response.json({ ok: true, history: rows });
    },
  },
  {
    methods: ["GET"],
    pattern: "/api/logs",
    handler: ({ url }) => {
      const logType = url.searchParams.get("type") || "error";
      const limit = parseInt(url.searchParams.get("limit") || "100", 10);
      let logs: string[] = [];
      try {
        if (logType === "report") {
          logs = buildRunReport();
        } else if (existsSync(errorLogPath())) {
          logs = readFileSync(errorLogPath(), "utf-8")
            .split("\n")
            .filter((l) => l.trim())
            .slice(-limit);
        } else {
          logs = ["No logs available"];
        }
      } catch (e: any) {
        logs = [`Error: ${e.message}`];
      }
      return Response.json({ ok: true, logs, type: logType });
    },
  },
];

/** Dispatch an API request through the route table. */
async function handleApi(req: Request, config: Config, url: URL, pathname: string): Promise<Response> {
  const segments = pathname.split("/").filter(Boolean);
  // A static path (/api/jobs/pause) that exists with a different method is a
  // 405 — it must never fall through to a :param route and be read as an id.
  // Several routes may share one pattern (/api/settings GET + POST), so the
  // verdict is per pattern: 405 only when NO route with that exact pattern
  // accepts this method.
  const exactAllow = new Set<string>();
  let exactPath = false;
  let exactAccepted = false;
  for (const route of ROUTES) {
    if (route.pattern.includes(":")) continue;
    if (!matchRoute(route.pattern, segments)) continue;
    exactPath = true;
    for (const m of route.methods) exactAllow.add(m);
    if (route.methods.includes(req.method)) exactAccepted = true;
  }
  if (exactPath && !exactAccepted) {
    return methodNotAllowed(req.method, pathname, [...exactAllow]);
  }

  const allow = new Set<string>();
  for (const route of ROUTES) {
    const params = matchRoute(route.pattern, segments);
    if (!params) continue;
    if (!route.methods.includes(req.method)) {
      for (const m of route.methods) allow.add(m);
      continue;
    }
    return await route.handler({ req, config, url, params });
  }
  if (allow.size > 0) {
    return methodNotAllowed(req.method, pathname, [...allow]);
  }
  return Response.json({ ok: false, error: `Unknown API path: ${pathname}` }, { status: 404 });
}

function methodNotAllowed(method: string, pathname: string, allow: string[]): Response {
  return Response.json(
    { ok: false, error: `Method ${method} not allowed for ${pathname}` },
    { status: 405, headers: { Allow: allow.sort().join(", ") } },
  );
}

// --- Larger handlers, kept out of the table for readability -------------------

function reliabilityHandler(config: Config): Response {
  const partials = db
    .query(
      `SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as bytes FROM jobs WHERE partial_file_path IS NOT NULL`,
    )
    .get() as any;
  // Same eligibility rules as the sweep itself: all failed downloads except
  // permanent video-level errors get another retry window after cooldown.
  // Uses the shared classifier so the dashboard and sweep cannot disagree.
  const failedDownloads = db
    .query(
      `SELECT last_error FROM jobs WHERE download_status = 'failed'`,
    )
    .all() as any[];
  const resumableFailed = failedDownloads.filter(
    (r) => !isPermanentDownloadError(r.last_error),
  ).length;
  const waitingLive = db
    .query(`SELECT COUNT(*) as count FROM jobs WHERE download_status = 'waiting_live'`)
    .get() as any;

  // --- Resume + self-healing state ---------------------------------------
  // What will actually pick up where it left off. A partial only matters
  // while its job is still in play: a failed job's partial may be discarded
  // once the resume budget is spent, so it is not counted here.
  const resumablePartials = db
    .query(
      `SELECT COUNT(*) as count FROM jobs
        WHERE partial_file_path IS NOT NULL
          AND download_status IN ('pending', 'paused', 'downloading')`,
    )
    .get() as any;
  // Crashed jobs: parked as paused/interrupted so they are re-claimed and
  // resume from their partial rather than restarting.
  const interrupted = db
    .query(
      `SELECT COUNT(*) as count FROM jobs
        WHERE download_status = 'paused' AND pause_reason = 'interrupted'`,
    )
    .get() as any;
  // What the stale-claim reaper would reclaim right now — same thresholds,
  // same lease-expiry predicate (heartbeat-based) and same active-download
  // protection as the sweep itself, so the panel cannot drift.
  const t = STALE_CLAIM_THRESHOLDS(config);
  const activeJobIds = Array.from(activeDownloadJobs.values());
  const activeJobFilter = activeJobIds.length
    ? `AND id NOT IN (${activeJobIds.map(() => "?").join(", ")})`
    : "";
  const staleClaimsQuery = db.query(
    `SELECT
       (SELECT COUNT(*) FROM jobs WHERE download_status = 'downloading'
          AND ${staleClaimCondition("download", t.download)} ${activeJobFilter})
     + (SELECT COUNT(*) FROM jobs WHERE conversion_status = 'in_progress'
          AND ${staleClaimCondition("conversion", t.conversion)})
     + (SELECT COUNT(*) FROM jobs WHERE metadata_status = 'in_progress'
          AND ${staleClaimCondition("metadata", t.metadata)})
     AS count`,
  );
  const staleClaims = (activeJobIds.length ? staleClaimsQuery.get(...activeJobIds) : staleClaimsQuery.get()) as any;
  // Which engine owns archive.db right now. Two engines with different web
  // ports used to look fine here; the lease is what actually decides ownership.
  const lease = readEngineLease();

  // The four self-healing sweeps, with what each currently has in scope.
  // `pending: null` means "not counted here" — the missing-files sweep has to
  // stat every recorded file, which is far too expensive to run per poll.
  const sweeps = [
    {
      id: "crashed",
      label: "Crashed jobs resume",
      cadence: "startup",
      detail: "Jobs interrupted mid-flight are re-queued and resume from their partial.",
      pending: interrupted?.count || 0,
    },
    {
      id: "staleClaims",
      label: "Stale claims reclaimed",
      cadence: "every 60s",
      detail: "Inactive download claims are re-queued after a timeout; live worker-owned jobs are protected.",
      pending: staleClaims?.count || 0,
    },
    {
      id: "missingFiles",
      label: "Deleted files re-fetched",
      cadence: "startup",
      detail: "Files recorded as downloaded but no longer on disk are queued again.",
      pending: null,
    },
    {
      id: "requeueFailed",
      label: "Failed jobs retried",
      cadence: "every 60s",
      detail: "Failed jobs retry after a cooldown; permanent failures never do.",
      pending: resumableFailed,
    },
  ];

  return Response.json({
    ok: true,
    paused: isPaused(),
    pauseReason: getPauseReason(),
    partialFiles: { count: partials?.count || 0, bytes: partials?.bytes || 0 },
    resumableFailed,
    waitingLive: waitingLive?.count || 0,
    resume: {
      resumablePartials: resumablePartials?.count || 0,
      interrupted: interrupted?.count || 0,
      staleClaims: staleClaims?.count || 0,
    },
    sweeps,
    engine: {
      // The database-level lease: owner token, generation, expiry. `heldByMe`
      // is false on the dashboard of an engine that lost the lease (or never
      // acquired it — it would not reach this endpoint in that case).
      lease: {
        owner: lease?.owner ?? null,
        fencing: lease?.fencing ?? 0,
        acquiredAt: lease?.acquiredAt ?? null,
        heartbeatAt: lease?.heartbeatAt ?? null,
        expiresAt: lease?.expiresAt ?? null,
        expired: isLeaseExpired(lease),
        heldByMe: holdsEngineLease(),
      },
    },
    policy: {
      maxResumeAttempts: config.maxResumeAttempts,
      retryBackoffBaseSeconds: config.retryBackoffBaseSeconds,
      retryBackoffMaxSeconds: config.retryBackoffMaxSeconds,
      requeueFailedAfterMinutes: config.requeueFailedAfterMinutes,
      verifyExistingFiles: config.verifyExistingFiles,
      downloadTimeoutMinutes: config.downloadTimeoutMinutes,
      maxDownloadMinutes: config.maxDownloadMinutes,
    },
    downloader: {
      engine: resolveDownloaderEngine(config, !!aria2cPath()),
      path: aria2cPath(),
      connectionsPerDownload: config.connectionsPerDownload,
      concurrentFragments: config.concurrentFragments,
      maxBandwidthKBps: config.maxBandwidthKBps,
      autoscaleRampStep: config.autoscaleRampStep,
    },
  });
}
