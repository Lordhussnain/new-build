// src/engine.ts — engine orchestration (main()).
//
// Startup order matters: config → dependency check → database (with
// migrations and self-healing reconciliation) → scan configured sources →
// start the dashboard, web server, watchers, and the supervised worker pools.

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig } from "./config";
import { aria2cPath, checkDependencies, validateCookies } from "./tools";
import { initDatabase, pruneJobsForUnconfiguredSources } from "./db";
import { SOURCE_KEYS, sourceIdentity } from "./sources";
import {
  cleanOrphanedFiles,
  cookiesWatch,
  reconcileCrashedJobs,
  reconcileMissingFiles,
  reapStaleClaims,
  requeueFailedJobs,
} from "./reconcile";
import { autoscaleTick, autoscaler } from "./autoscale";
import { networkMonitor } from "./resilience";
import { scanAndIngest } from "./scanner";
import { startWebServer } from "./web";
import { initDashboard, renderDashboard } from "./dashboard";
import { startRssPolling } from "./rss";
import { startAutonomousPolling } from "./polling";
import { startRunHistory, heartbeatRunHistory } from "./history";
import { handleShutdown, supervise } from "./lifecycle";
import { downloadWorker } from "./workers/download";
import { metadataWorker } from "./workers/metadata";
import { converterWorker } from "./workers/convert";
import { logError } from "./logger";
import { getConfig, setConfig } from "./state";

// The web server handle, assigned in main() and stopped during shutdown.
let webServer: { stop: (closeActive?: boolean) => void } | null = null;

export async function main(): Promise<void> {
  process.on("SIGINT", () => handleShutdown("SIGINT", webServer));
  process.on("SIGTERM", () => handleShutdown("SIGTERM", webServer));
  // Windows: Ctrl+Break / console close events surface as SIGBREAK.
  process.on("SIGBREAK", () => handleShutdown("SIGBREAK", webServer));
  process.on("unhandledRejection", (reason) => {
    logError("process", `unhandledRejection: ${reason instanceof Error ? reason.stack || String(reason) : String(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    logError("process", `uncaughtException: ${err?.stack || err}`);
    console.error("‼️ Uncaught exception (engine continues):", err);
  });

  // 1) Load configuration first (dependency search may use ytDlpPath/ffmpegPath
  //    from it), then verify external tools before touching the database.
  const config = await loadConfig();
  setConfig(config);
  await checkDependencies(config);

  // 1b) Report which downloader engine the downloads will actually use.
  if (config.useAria2c && aria2cPath()) {
    console.log(
      `🚀 Download engine: aria2c (${config.connectionsPerDownload} connections/download, ${config.maxBandwidthKBps > 0 ? `cap ${config.maxBandwidthKBps} KB/s split across slots` : "uncapped"})`,
    );
  } else if (config.useAria2c && !aria2cPath()) {
    console.log("🚀 Download engine: yt-dlp native (aria2c not installed — install it for multi-connection speed)");
  } else {
    console.log("🚀 Download engine: yt-dlp native (aria2c disabled in config)");
  }

  // 2) Open/migrate the central database, then self-heal anything the last
  //    run left behind (crash, hard kill, files moved behind our back).
  initDatabase("archive.db");

  // Single-instance gate: bind the web port BEFORE any state-mutating sweep.
  // A second instance (autostart task + a manual start, two terminals) used to
  // run reconcileCrashedJobs/reconcileMissingFiles first — re-queueing the
  // live instance's in-flight work behind its back, which looked like workers
  // fighting each other — and only then die on the busy port. The port is now
  // the lock: whoever holds it owns the job database.
  try {
    webServer = startWebServer(config.webPort, config);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE" || String(err?.message || "").includes("in use")) {
      console.error(
        `\n❌ Port ${config.webPort} is already in use — another engine instance is running.`,
      );
      console.error("   Stop that instance first (autostart task, another terminal, or a still-exiting process).");
      console.error("   Two instances against one archive.db corrupt each other's job state.");
      process.exit(1);
    }
    throw err;
  }

  // The source manager deletes jobs immediately; this also catches a playlist
  // removed by directly editing config.json while the engine was stopped.
  const activeSourceUrls = new Set(
    SOURCE_KEYS.flatMap((key) => config[key].map((url) => sourceIdentity(url))),
  );
  const staleSourceJobs = pruneJobsForUnconfiguredSources(activeSourceUrls);
  if (staleSourceJobs.deletedJobs > 0) {
    console.log(`🗑️ Removed ${staleSourceJobs.deletedJobs} job(s) for sources no longer in config.json.`);
  }

  reconcileCrashedJobs();
  reconcileMissingFiles(config);
  // Run history: row created now, heartbeated so hard kills still leave data.
  startRunHistory();
  setTimeout(heartbeatRunHistory, 10_000);
  setInterval(heartbeatRunHistory, 60_000);
  // Ensure the output root exists — otherwise statfs fails, the disk check
  // reports 0 GB free, and the engine falsely pauses with LOW_DISK_SPACE.
  await mkdir(config.outputRoot, { recursive: true });
  // Keep resume-able partials, drop the ones that can never complete.
  await cleanOrphanedFiles(config.outputRoot, config);
  autoscaler.init(config);

  // Establish the cookies baseline, then keep watching for the whole run: a
  // cookies.txt exported from the browser *after* startup must be picked up
  // without a restart (cookiesWatch runs on an interval below).
  cookiesWatch(config);
  if (config.validateCookiesOnStart && existsSync(config.cookiesFile)) {
    const valid = await validateCookies(config.cookiesFile);
    if (!valid) console.warn("⚠️ Cookies may be invalid or expired.");
    else console.log("✅ Cookies validated.");
  } else if (!existsSync(config.cookiesFile)) {
    console.log(
      `ℹ️ No ${config.cookiesFile} yet — downloads run anonymously. Drop the file in while the engine runs and it is picked up within a minute.`,
    );
  }

  // 3) Load every link from config.json, fetch video details, store in DB.
  const allLinks = [...config.playlists, ...config.channels, ...config.channelPlaylists];
  for (const url of allLinks) {
    try {
      const r = await scanAndIngest(url, config);
      console.log(`📥 ${url} → found ${r.found}, added ${r.added}, skipped ${r.skipped}`);
    } catch (e: any) {
      logError("scan", `${url}: ${e?.message || e}`);
      console.error(`❌ Failed to scan ${url}:`, e?.message || e);
    }
  }

  initDashboard(config);
  const uiHost = !config.webBind || config.webBind === "0.0.0.0" ? "127.0.0.1" : config.webBind;
  console.log(
    `Web UI: http://${uiHost}:${config.webPort}${config.webToken ? "  (token required)" : ""}${config.webBind === "0.0.0.0" ? "  — listening on ALL interfaces" : ""}`,
  );

  networkMonitor();
  setInterval(reapStaleClaims, 60_000);
  // Dynamic download-slot autoscaling (no-op when autoscaleEnabled=false).
  setInterval(autoscaleTick, 15_000);
  // Failed-job sweep: re-queue transient failures after their cooldown.
  setInterval(() => requeueFailedJobs(getConfig()), 60_000);
  // Cookies sweep: notice cookies.txt appearing / changing / vanishing mid-run.
  setInterval(() => cookiesWatch(getConfig()), 60_000);
  // Cheap new-upload watcher (no-op when rssEnabled=false or no channels).
  startRssPolling(config);

  // 4) Pipeline workers (each supervised — crashed loops restart automatically):
  //    download → metadata → converter, all driven by job status in the DB.
  for (let i = 1; i <= config.maxDownloadWorkers; i++) {
    supervise(`download-worker-${i}`, () => downloadWorker(i, config));
  }
  for (let i = 1; i <= config.maxMetadataWorkers; i++) {
    supervise(`metadata-worker-${i}`, () => metadataWorker(i, config));
  }
  for (let i = 1; i <= config.maxConcurrentConverts; i++) {
    supervise(`converter-worker-${i}`, () => converterWorker(i, config));
  }

  if (config.daemonMode) startAutonomousPolling(config);

  setInterval(renderDashboard, 2000);
  console.log("🚀 Engine started. Resilient, autonomous, proxy-free.");
}
