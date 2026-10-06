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
import { db } from "./db";
import { autoscaler, activeDlSlots } from "./autoscale";
import { activeDownloadJobs, getConfig, getPauseReason, isPaused, workerStatuses } from "./state";
import { scanAndIngest } from "./scanner";
import { parseSourceUrl, saveSource, type SourceUrl } from "./sources";
import { diskUsage, triggerPause, triggerResume } from "./resilience";
import { requeueFailedJobs, STALE_CLAIM_THRESHOLDS } from "./reconcile";
import { buildRunReport } from "./report";
import { isPermanentDownloadError } from "./retry";
import { aria2cPath } from "./tools";
import { applySettings, readSettings } from "./settings";
import { resolveDownloaderEngine } from "./download-args";
import { parseSelectionJson, parseTracksJson, probeAudioTracks } from "./audio-tracks";
import { formatBytesPerSec, formatDuration } from "./util";
import { errorLogPath, logError } from "./logger";
import { withConfigWriteLock, type Config } from "./config";

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
const JOB_COLUMNS = `id, url, title, folder, output_directory, file_path, target_format,
                download_status, conversion_status, metadata_status, pause_reason, metadata_files,
                retry_count, conversion_retry_count, resume_count, best_progress, last_error,
                file_size, progress, speed, eta, duration, partial_file_path,
                audio_tracks, audio_selection`;

/** Audio-track columns are JSON in SQLite; hand the dashboard real values. */
function mapJobRow(r: any) {
  return {
    ...r,
    audio_tracks: parseTracksJson(r.audio_tracks) ?? [],
    audio_selection: parseSelectionJson(r.audio_selection),
  };
}

/** Re-queue a job with fresh budgets (download + any failed side stages). */
function retryJobById(id: string): number {
  // Re-queue download AND any failed metadata/conversion work; preserve
  // conversion_status='not_needed'. Also clears a user pause and resets the
  // per-stage retry budgets so a manual retry always gets a fresh budget.
  return db.run(
    `UPDATE jobs SET
       download_status = 'pending', pause_reason = NULL, progress = 0, retry_count = 0,
       best_progress = 0, resume_count = 0, speed = 0, eta = 0,
       conversion_status = CASE WHEN conversion_status = 'not_needed' THEN 'not_needed' ELSE 'pending' END,
       conversion_retry_count = 0,
       metadata_status = CASE
         WHEN COALESCE(want_subtitles,0) + COALESCE(want_thumbnail,0) + COALESCE(want_description,0) > 0 THEN 'pending'
         ELSE metadata_status END,
       metadata_retry_count = 0,
       last_error = NULL, download_claimed_by = NULL, download_claimed_at = NULL,
       conversion_claimed_by = NULL, conversion_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [id],
  ).changes;
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
  const result = db.run(`DELETE FROM jobs WHERE id IN (${placeholders})`, ids);
  return Response.json({ ok: true, deleted: result.changes });
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
    pattern: "/api/jobs/:id/retry",
    handler: ({ params }) => {
      const changed = retryJobById(params.id);
      if (changed === 0) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
      return Response.json({ ok: true });
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
    methods: ["DELETE"],
    pattern: "/api/jobs/:id",
    handler: ({ params }) => {
      const result = db.run(`DELETE FROM jobs WHERE id = ?`, [params.id]);
      if (result.changes === 0) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
      return Response.json({ ok: true, deleted: result.changes });
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
      const result = db.run(
        `UPDATE jobs SET download_status = 'paused', pause_reason = 'user',
           download_claimed_by = CASE WHEN download_status = 'downloading' THEN download_claimed_by ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${placeholders}) AND download_status IN ('pending', 'downloading', 'paused')`,
        ids,
      );
      return Response.json({ ok: true, paused: result.changes });
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
    handler: ({ params }) => {
      const changed = retryJobById(params.id);
      if (changed === 0) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
      return Response.json({ ok: true });
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
      const result = db.run("DELETE FROM jobs WHERE download_status IN ('pending', 'paused', 'waiting_live', 'failed')");
      return Response.json({ ok: true, deleted: result.changes });
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
  // What the stale-claim reaper would reclaim right now — same thresholds and
  // active-download protection as the sweep itself, so the panel cannot drift.
  const t = STALE_CLAIM_THRESHOLDS;
  const activeJobIds = Array.from(activeDownloadJobs.values());
  const activeJobFilter = activeJobIds.length
    ? `AND id NOT IN (${activeJobIds.map(() => "?").join(", ")})`
    : "";
  const staleClaimsQuery = db.query(
    `SELECT
       (SELECT COUNT(*) FROM jobs WHERE download_status = 'downloading'
          AND (download_claimed_at IS NULL OR download_claimed_at < datetime('now', '${t.download}')) ${activeJobFilter})
     + (SELECT COUNT(*) FROM jobs WHERE conversion_status = 'in_progress'
          AND (conversion_claimed_at IS NULL OR conversion_claimed_at < datetime('now', '${t.conversion}')))
     + (SELECT COUNT(*) FROM jobs WHERE metadata_status = 'in_progress'
          AND updated_at < datetime('now', '${t.metadata}'))
     AS count`,
  );
  const staleClaims = (activeJobIds.length ? staleClaimsQuery.get(...activeJobIds) : staleClaimsQuery.get()) as any;

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
