// src/engine.ts — engine orchestration (main()).
//
// Startup order matters: config → dependency check → database (with
// migrations and self-healing reconciliation) → scan configured sources →
// start the dashboard, web server, watchers, and the supervised worker pools.

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig, offlineOverrideFromRuntime, webPortOverrideFromRuntime } from "./config";
import { aria2cPath, checkDependencies, validateCookies } from "./tools";
import { initDatabase, pruneJobsForUnconfiguredSources } from "./db";
import {
  acquireEngineLease,
  describeEngineLease,
  releaseEngineLease,
  startEngineLeaseHeartbeat,
} from "./lease";
import { SOURCE_KEYS, sourceIdentity } from "./sources";
import {
  cleanOrphanedFiles,
  cookiesWatch,
  reconcileCrashedJobs,
  reconcileMissingFiles,
  reconcileSupersededFiles,
  reapStaleClaims,
  requeueFailedJobs,
} from "./reconcile";
import { autoscaleTick, autoscaler } from "./autoscale";
import { networkMonitor, triggerPause } from "./resilience";
import { scanAndIngest } from "./scanner";
import { startWebServer } from "./web";
import { initDashboard, renderDashboard } from "./dashboard";
import { startRssPolling } from "./rss";
import { startAutonomousPolling } from "./polling";
import { startRunHistory, heartbeatRunHistory } from "./history";
import { handleShutdown, supervise } from "./lifecycle";
import { startRelocation } from "./relocate";
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
    const detail = reason instanceof Error ? reason.stack || String(reason) : String(reason);
    logError("process", `fatal unhandledRejection: ${detail}`);
    console.error("‼️ Unhandled rejection — stopping safely:", reason);
    void handleShutdown("unhandledRejection", webServer, 1);
  });
  process.on("uncaughtException", (err) => {
    logError("process", `fatal uncaughtException: ${err?.stack || err}`);
    console.error("‼️ Uncaught exception — stopping safely:", err);
    void handleShutdown("uncaughtException", webServer, 1);
  });

  // 1) Load configuration first (dependency search may use ytDlpPath/ffmpegPath
  //    from it), then verify external tools before touching the database.
  let config = await loadConfig();
  // `--offline` / YTA_OFFLINE override the stored setting for THIS run only (no
  // config.json write), so a one-off post-processing pass never changes what
  // the next normal start does. The override happens before setConfig() and
  // before the dependency probe: offline mode relaxes the yt-dlp requirement.
  const offlineOverride = offlineOverrideFromRuntime();
  if (offlineOverride !== null && offlineOverride !== config.offlineMode) {
    config = { ...config, offlineMode: offlineOverride };
    console.log(
      `📴 Offline mode forced for this run by --offline / YTA_OFFLINE: ${offlineOverride ? "ON" : "OFF"} (config.json is left unchanged).`,
    );
  }
  const webPortOverride = webPortOverrideFromRuntime();
  const listenPort = webPortOverride ?? config.webPort;
  if (webPortOverride !== null) {
    console.log(`🌐 Web UI port overridden for this run by --port: ${webPortOverride} (config.json is left unchanged).`);
  }
  setConfig(config);
  await checkDependencies(config);

  // 1b) Report what this run will actually do. Offline mode is announced first
  //     and loudly: with downloads disabled an operator must never be left
  //     wondering why the queue is not moving.
  if (config.offlineMode) {
    console.log("");
    console.log("📴 OFFLINE MODE — no videos will be downloaded.");
    console.log("   Converting files that need conversion, and moving finished files to secondary storage.");
    console.log("   Queued downloads are left untouched and start when offline mode ends.");
    console.log("");
  }

  // 1c) Report which downloader engine the downloads will actually use.
  if (config.offlineMode) {
    console.log("⏸️ Download engine: not used (offline mode)");
  } else if (config.useAria2c && aria2cPath()) {
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

  // 2a) Database-level single-instance gate: take the engine lease BEFORE any
  //     state-mutating sweep. The web port only guards instances that share a
  //     port — two engines with different `webPort` values used to both bind
  //     successfully and then both run startup reconciliation against the same
  //     jobs, each re-queueing the other's in-flight work behind its back.
  //     Whoever holds the lease owns `archive.db`; a live holder means this
  //     process must refuse to start rather than touch a single job row.
  const lease = acquireEngineLease();
  if (!lease.acquired) {
    console.error(
      `\n❌ archive.db is owned by another live engine instance (${describeEngineLease(lease.lease)}).`,
    );
    console.error("   Stop that instance first (autostart task, another terminal, or a still-exiting process).");
    console.error("   The engine lease is database-level: a different web port does NOT make a second instance safe.");
    if (lease.lease?.owner) {
      console.error(
        `   If that engine is gone for good, wait for its lease to expire (${lease.lease.expiresAt} UTC) and start again.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `🔐 Engine lease acquired (fencing ${lease.lease?.fencing}${lease.tookOver ? ", took over an expired lease" : ""}).`,
  );
  // Renew it for the life of the process. Losing it means another engine took
  // over while this one was stalled; pausing stops new claims immediately, and
  // the per-claim tokens fence everything already in flight.
  const stopLeaseHeartbeat = startEngineLeaseHeartbeat({
    onLost: () => {
      logError("lease", "engine lease lost — pausing so this instance stops claiming work");
      triggerPause("ENGINE_LEASE_LOST");
    },
  });

  // 2b) HTTP gate: the port stays the lock for the dashboard and API. It is
  //     acquired second, so a refused start never leaves the port held.
  try {
    webServer = startWebServer(listenPort, config);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE" || String(err?.message || "").includes("in use")) {
      console.error(
        `\n❌ Port ${listenPort} is already in use — another engine instance is running.`,
      );
      console.error("   Stop that instance first (autostart task, another terminal, or a still-exiting process).");
      console.error("   Two instances against one archive.db corrupt each other's job state.");
      stopLeaseHeartbeat();
      releaseEngineLease();
      process.exit(1);
    }
    stopLeaseHeartbeat();
    releaseEngineLease();
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
  // Heal the `.superseded` hand-off before the missing-file sweep: an
  // interrupted stash looks like "downloaded file vanished" to
  // reconcileMissingFiles, which would re-queue a download over a file that is
  // sitting right there as a `.superseded` backup.
  reconcileSupersededFiles();
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
  // without a restart. The watcher only reads local files; validation below is
  // the network request and stays disabled while offline.
  cookiesWatch(config);
  if (config.offlineMode) {
    console.log("🍪 Cookies: not used (offline mode).");
  } else if (config.validateCookiesOnStart && existsSync(config.cookiesFile)) {
    const valid = await validateCookies(config.cookiesFile);
    if (!valid) console.warn("⚠️ Cookies may be invalid or expired.");
    else console.log("✅ Cookies validated.");
  } else if (!existsSync(config.cookiesFile)) {
    console.log(
      `ℹ️ No ${config.cookiesFile} yet — downloads run anonymously. Drop the file in while the engine runs and it is picked up within a minute.`,
    );
  }

  // 3) Load every link from config.json, fetch video details, store in DB.
  //    Scanning is a network round-trip per source, so offline mode skips it
  //    entirely: nothing can be discovered, and the queued jobs are untouched.
  const allLinks = [...config.playlists, ...config.channels, ...config.channelPlaylists];
  if (config.offlineMode) {
    console.log(`📡 Source scan skipped (offline mode) — ${allLinks.length} configured source(s) unchanged.`);
  } else if (allLinks.length > 0) {
    const SCAN_CONCURRENCY = Math.min(4, allLinks.length);
    console.log(`📡 Scanning ${allLinks.length} configured source(s) with concurrency ${SCAN_CONCURRENCY}...`);
    let completedSources = 0;
    const queue = [...allLinks];
    const runScanWorker = async () => {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) break;
        try {
          const r = await scanAndIngest(url, config);
          completedSources++;
          console.log(`📥 ${url} → found ${r.found}, added ${r.added}, skipped ${r.skipped} (${completedSources}/${allLinks.length})`);
        } catch (e: any) {
          completedSources++;
          logError("scan", `${url}: ${e?.message || e}`);
          console.error(`❌ Failed to scan ${url}:`, e?.message || e);
        }
      }
    };
    const workers = Array.from({ length: SCAN_CONCURRENCY }, () => runScanWorker());
    await Promise.all(workers);
  }

  initDashboard(config);
  const uiHost = !config.webBind || config.webBind === "0.0.0.0" ? "127.0.0.1" : config.webBind;
  console.log(
    `Web UI: http://${uiHost}:${listenPort}${config.webToken ? "  (token required)" : ""}${config.webBind === "0.0.0.0" ? "  — listening on ALL interfaces" : ""}`,
  );

  // These services are registered even when the engine starts offline; each
  // reads the live config before doing network work. This is what makes the
  // dashboard's offline toggle reversible without a restart.
  if (config.offlineMode) {
    console.log("📡 RSS watcher and rescans idle until offline mode ends.");
  }
  startRssPolling(config);

  if (config.networkMonitorEnabled) {
    if (config.offlineMode) console.log("🌐 Network monitor idle until offline mode ends.");
    networkMonitor();
  } else {
    console.log("🌐 Network monitor disabled (networkMonitorEnabled=false).");
  }
  setInterval(() => {
    // Fire-and-forget: the tick must never overlap itself, and a failure is
    // already reported by the reaper. The void + catch keeps the interval from
    // surfacing an unhandled rejection if the DB is mid-shutdown.
    void reapStaleClaims(getConfig()).catch(() => {});
  }, 60_000);
  // Dynamic download-slot autoscaling (no-op when autoscaleEnabled=false).
  setInterval(autoscaleTick, 15_000);
  // Failed-job sweep: re-queue transient failures after their cooldown. It also
  // re-queues failed CONVERSIONS, which is exactly what offline mode wants, so
  // the sweep keeps running; download re-queues simply wait for the mode to end.
  setInterval(() => requeueFailedJobs(getConfig()), 60_000);
  // Cookies sweep is local filesystem observation (not a network fetch), so it
  // stays registered through offline mode and is ready if the mode ends live.
  setInterval(() => cookiesWatch(getConfig()), 60_000);
  // Secondary-storage relocation: files that need no conversion still have to
  // reach secondary storage (src/relocate.ts).
  startRelocation();

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

  // Daemon-mode full rescans are armed even when starting offline; the poller
  // checks live offlineMode before every scan and resumes on a later tick.
  if (config.daemonMode) startAutonomousPolling(config);

  setInterval(renderDashboard, 2000);
  console.log(
    config.offlineMode
      ? "🚀 Engine started in OFFLINE MODE. Converting and relocating local files only."
      : "🚀 Engine started. Resilient, autonomous, proxy-free.",
  );
}
