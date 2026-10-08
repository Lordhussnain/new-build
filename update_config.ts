// update_config.ts — interactive configuration manager for the engine.
//
// The Zod schema and defaults are imported from src/config.ts so this tool and
// the engine can never disagree about what a valid config looks like.
//
// Run with: bun run update_config.ts   (or: bun run config)

import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { CONFIG_PATH, loadConfigSafe, saveConfig, type Config } from "./src/config";
import { associateExistingJobsWithSource, db, initDatabase, pruneJobsForUnconfiguredSources } from "./src/db";
import { getPlaylistItems } from "./src/scanner";
import { resolvedTools } from "./src/tools";
import { SOURCE_KEYS, sourceIdentity } from "./src/sources";
import { STALE_CLAIM_THRESHOLDS } from "./src/reconcile";
import { describeEngineLease, hasLiveLeaseOwner, holdsEngineLease, readEngineLease } from "./src/lease";

const rl = createInterface({ input: process.stdin, output: process.stdout });

// ---- Prompt Helpers --------------------------------------------------------
async function ask(q: string): Promise<string> {
  return rl.question(q);
}

async function askYesNo(q: string, def: boolean): Promise<boolean> {
  const ans = await ask(`${q} ${def ? "[Y/n]" : "[y/N]"}: `);
  const t = ans.trim().toLowerCase();
  if (t === "") return def;
  return t === "y" || t === "yes";
}

async function askNumber(q: string, current: number, min?: number, max?: number): Promise<number> {
  while (true) {
    const ans = await ask(`${q} [current: ${current}]: `);
    if (ans.trim() === "") return current;
    const n = parseInt(ans, 10);
    if (isNaN(n)) {
      console.log("   ⚠️ Please enter a valid number.");
      continue;
    }
    if (min !== undefined && n < min) {
      console.log(`   ⚠️ Must be >= ${min}.`);
      continue;
    }
    if (max !== undefined && n > max) {
      console.log(`   ⚠️ Must be <= ${max}.`);
      continue;
    }
    return n;
  }
}

async function askChoice(q: string, options: string[], current: string): Promise<string> {
  while (true) {
    console.log(`\n${q} [current: ${current}]`);
    options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
    const ans = await ask("Select number (or Enter to keep): ");
    if (ans.trim() === "") return current;
    const idx = parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
    console.log("   ⚠️ Invalid selection.");
  }
}

async function askMultiLine(prompt: string): Promise<string[]> {
  console.log(`\n${prompt}`);
  console.log("(Paste one or more lines; press Enter on an empty line to finish)\n");
  const links: string[] = [];
  while (true) {
    const line = await ask(" > ");
    if (line.trim() === "") break;
    links.push(...line.split(/[,\n]+/).map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return links;
}

function isValidPlaylistUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.includes("youtube.com") && u.searchParams.has("list");
  } catch {
    return false;
  }
}

// ---- URL List Manager (Playlists / Channels / Channel Playlists) -----------
async function manageUrlList(
  config: Config,
  key: "playlists" | "channels" | "channelPlaylists",
  title: string,
): Promise<Config> {
  while (true) {
    console.clear();
    console.log(`📂 Manage ${title}\n`);
    const list = config[key] || [];
    if (list.length === 0) console.log("  (none configured)\n");
    else list.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));

    console.log("\n  A. Add new");
    console.log("  R. Remove one");
    console.log("  C. Clear all");
    console.log("  B. Back\n");

    const choice = (await ask("Select: ")).trim().toLowerCase();

    if (choice === "a") {
      const newLinks = await askMultiLine(`Enter ${title} URLs/handles:`);
      let added = 0;
      for (const link of newLinks) {
        if (key === "playlists" && !isValidPlaylistUrl(link)) {
          console.log(`   ⚠️ Skipping invalid playlist URL: ${link}`);
          continue;
        }
        if (!list.includes(link)) {
          list.push(link);
          added++;
        }
      }
      console.log(`\n✅ Added ${added} item(s).`);
      await ask("Press Enter to continue...");
    } else if (choice === "r") {
      if (list.length === 0) {
        await ask("Nothing to remove. Press Enter...");
        continue;
      }
      const ans = await ask("Enter number to remove (or 'all'): ");
      if (ans.trim().toLowerCase() === "all") {
        if (await askYesNo("Remove ALL?", false)) config[key] = [];
      } else {
        const i = parseInt(ans, 10) - 1;
        if (i >= 0 && i < list.length) list.splice(i, 1);
        else console.log("   ⚠️ Invalid number.");
      }
      await ask("Press Enter to continue...");
    } else if (choice === "c") {
      if (await askYesNo("Clear ALL?", false)) config[key] = [];
      await ask("Press Enter to continue...");
    } else if (choice === "b") {
      return config;
    }
  }
}

// ---- Live resume state (read-only) ------------------------------------------
/**
 * Read the engine's current resume state straight from the archive database.
 *
 * Read-only and best-effort on purpose: the engine may be running and holding
 * the database, or this may be a fresh install with no database yet. Either
 * way the config manager must stay usable, so every failure returns null and
 * the caller simply omits the live figures.
 */
function readResumeState(config: Config): { resumable: number; interrupted: number } | null {
  try {
    if (!config.archiveFile || !existsSync(config.archiveFile)) return null;
    const ro = new Database(config.archiveFile, { readonly: true });
    try {
      const row = ro
        .query(
          `SELECT
             SUM(CASE WHEN partial_file_path IS NOT NULL
                       AND download_status IN ('pending', 'paused', 'downloading')
                      THEN 1 ELSE 0 END) as resumable,
             SUM(CASE WHEN download_status = 'paused'
                       AND COALESCE(pause_reason, '') = 'interrupted'
                      THEN 1 ELSE 0 END) as interrupted
           FROM jobs`,
        )
        .get() as any;
      return { resumable: row?.resumable || 0, interrupted: row?.interrupted || 0 };
    } finally {
      ro.close();
    }
  } catch {
    return null;
  }
}

// ---- Download Settings -----------------------------------------------------
async function changeDownloadSettings(config: Config): Promise<Config> {
  console.clear();
  console.log("⚙️  Download Settings\n");

  // Offline mode first: it is the one switch that changes what the engine does
  // at all. The dashboard and `--offline` can toggle it too; this is the same
  // `offlineMode` key in config.json.
  console.log("— Offline mode —");
  console.log("   No downloads. The engine only converts files that need conversion and moves");
  console.log("   finished files to secondary storage. Queued downloads wait, untouched.");
  config.offlineMode = await askYesNo("Enable offline mode (no downloads)?", config.offlineMode);
  console.log(
    config.offlineMode
      ? "   📴 Offline mode ON — yt-dlp is not needed; the dashboard can still switch it off live."
      : "   🌐 Normal mode — scanning and downloads enabled.",
  );

  // Quality & Target Format
  config.videoQuality = (await askChoice(
    "Video Quality:",
    ["highest", "1080p", "720p", "480p", "audio"],
    config.videoQuality,
  )) as Config["videoQuality"];

  config.targetFormat = (await askChoice(
    "Target Media Container Format:",
    ["mp4", "mkv", "webm", "mp3", "m4a"],
    config.targetFormat || "mp4",
  )) as Config["targetFormat"];

  config.subtitleFormat = (await askChoice(
    "Subtitle Format:",
    ["srt", "vtt", "ass", "lrc"],
    config.subtitleFormat || "srt",
  )) as Config["subtitleFormat"];

  // Multi-language audio tracks (YouTube's "Audio track" menu)
  console.log("\n— Multi-audio tracks (YouTube multi-language audio) —");
  config.multiAudioMode = (await askChoice(
    "Multi-audio tracks:",
    ["off", "all", "languages"],
    config.multiAudioMode,
  )) as Config["multiAudioMode"];
  if (config.multiAudioMode !== "off") {
    console.log("   Selected tracks are muxed into one MKV — players switch audio like on YouTube.");
    if (config.multiAudioMode === "languages") {
      const langsAns = await ask(
        `   Languages to keep, comma-separated codes e.g. en, ja [current: ${config.audioTrackLanguages.join(", ") || "none"}]: `,
      );
      config.audioTrackLanguages = langsAns
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  // Concurrency
  console.log("\n— Concurrency —");
  config.maxConcurrentDownloads = await askNumber("Starting download workers", config.maxConcurrentDownloads, 1, 20);
  config.maxConcurrentConverts = await askNumber("Concurrent conversion workers", config.maxConcurrentConverts, 1, 10);
  config.maxMetadataWorkers = await askNumber("Metadata workers (subs/thumbs/descriptions)", config.maxMetadataWorkers, 1, 10);

  // Autoscaling
  console.log("\n— Dynamic Autoscaling —");
  config.autoscaleEnabled = await askYesNo("Enable dynamic worker autoscaling?", config.autoscaleEnabled);
  if (config.autoscaleEnabled) {
    config.maxDownloadWorkers = await askNumber("Max download workers (ceiling)", config.maxDownloadWorkers, 1, 20);
    config.minDownloadWorkers = await askNumber(
      "Min download workers (floor)",
      config.minDownloadWorkers,
      1,
      config.maxDownloadWorkers,
    );
  }

  // Bandwidth
  console.log("\n— Bandwidth Throttle —");
  config.maxBandwidthKBps = await askNumber(
    "Max bandwidth in KB/s (0 = unlimited, enforced via yt-dlp --limit-rate)",
    config.maxBandwidthKBps,
    0,
  );
  if (config.maxBandwidthKBps > 0) {
    console.log(`   ≈ ${(config.maxBandwidthKBps / 1024).toFixed(2)} MB/s global cap, split across active slots`);
  }

  // Download performance (aria2c multi-connection + fragment tuning)
  console.log("\n— Download Performance (aria2c / fragments) —");
  config.useAria2c = await askYesNo(
    "Use aria2c for multi-connection downloads? (auto-falls back to yt-dlp native when not installed)",
    config.useAria2c,
  );
  if (config.useAria2c) {
    config.connectionsPerDownload = await askNumber(
      "Connections per download (aria2c -s/-j; -x is clamped to aria2c's cap of 16)",
      config.connectionsPerDownload,
      1,
      64,
    );
    const splitAns = await ask(`   Minimum split size before aria2c splits a file [current: ${config.minSplitSize}]: `);
    if (splitAns.trim() !== "") config.minSplitSize = splitAns.trim();
    console.log(`   yt-dlp maps the bandwidth cap to aria2c's --max-overall-download-limit automatically.`);
  }
  config.concurrentFragments = await askNumber(
    "Concurrent fragments for DASH/HLS (yt-dlp native downloader)",
    config.concurrentFragments,
    1,
    64,
  );
  config.fragmentRetries = await askNumber("Fragment retries", config.fragmentRetries, 1, 50);
  const chunkAns = await ask(
    `   HTTP chunk size for range-based chunked downloads (blank = off, e.g. 10M) [current: ${config.httpChunkSize || "off"}]: `,
  );
  config.httpChunkSize = chunkAns.trim();
  const bufAns = await ask(`   Download buffer size (blank = yt-dlp default 1024, e.g. 16K) [current: ${config.bufferSize || "default"}]: `);
  config.bufferSize = bufAns.trim();
  const userAgentAns = await ask(
    `   User-Agent override (type "default" to use yt-dlp's default) [current: ${config.userAgent || "default"}]: `,
  );
  if (userAgentAns.trim().toLowerCase() === "default") config.userAgent = "";
  else if (userAgentAns.trim()) config.userAgent = userAgentAns.trim();

  // Autoscaling ramp
  console.log("\n— Autoscaling Ramp —");
  config.autoscaleRampStep = await askNumber(
    "Download slots added per autoscale tick while the queue has a backlog",
    config.autoscaleRampStep,
    1,
    10,
  );

  // Failure handling (circuit breaker + backoff)
  console.log("\n— Failure Handling —");
  config.maxRetryAttempts = await askNumber(
    "No-progress retries per video before cooldown requeue",
    config.maxRetryAttempts,
    1,
  );
  config.maxFailuresPerVideo = await askNumber(
    "Max no-progress failures per video per retry window (effective cap = min with retries)",
    config.maxFailuresPerVideo,
    1,
  );
  config.maxFailures = await askNumber(
    "Consecutive failures before the engine auto-pauses (circuit breaker)",
    config.maxFailures,
    1,
  );
  config.retryBackoffBaseSeconds = await askNumber(
    "Retry backoff base delay (seconds, doubles each retry)",
    config.retryBackoffBaseSeconds,
    1,
  );
  config.retryBackoffMaxSeconds = await askNumber(
    "Retry backoff maximum delay (seconds)",
    config.retryBackoffMaxSeconds,
    config.retryBackoffBaseSeconds,
  );

  // Download archive (yt-dlp idempotence)
  const archAns = await ask(`   yt-dlp download-archive file [current: ${config.archiveFile}]: `);
  if (archAns.trim() !== "") config.archiveFile = archAns.trim();

  // Storage Management
  console.log("\n— Storage Management —");
  const rootAns = await ask(
    `   Download root folder (where playlists/channels are created) [current: ${config.outputRoot}]: `,
  );
  if (rootAns.trim() !== "") config.outputRoot = rootAns.trim();
  config.minFreeSpaceGB = await askNumber("Min free space (GB) before pausing", config.minFreeSpaceGB, 1);
  const nasPath = await ask(`   Secondary NAS/Storage path [current: ${config.secondaryStoragePath || "none"}]: `);
  if (nasPath.trim() !== "") config.secondaryStoragePath = nasPath.trim();

  // Web UI & Daemon
  console.log("\n— Web UI & Headless Daemon —");
  config.daemonMode = await askYesNo("Headless daemon mode (run forever, add links later from Web UI)?", config.daemonMode);
  config.webPort = await askNumber("Web UI port", config.webPort, 1, 65535);
  const bindAns = await ask(
    `   Web UI bind address (127.0.0.1 = this PC only, 0.0.0.0 = reachable from LAN) [current: ${config.webBind}]: `,
  );
  if (bindAns.trim() !== "") config.webBind = bindAns.trim();
  const tokenAns = await ask(
    `   Web UI access token (blank keeps current, '-' clears it) [current: ${config.webToken ? "(set)" : "none"}]: `,
  );
  if (tokenAns.trim() === "-") config.webToken = "";
  else if (tokenAns.trim() !== "") config.webToken = tokenAns.trim();
  if (config.webToken && config.webBind === "0.0.0.0") {
    console.log("   ℹ️ UI reachable from the LAN with a token set — good.");
  } else if (config.webBind === "0.0.0.0") {
    console.log("   ⚠️ 0.0.0.0 without a token: anyone on your network can pause/purge jobs.");
  }

  // Channel watching (RSS + rescans)
  console.log("\n— Channel Watching —");
  config.rssEnabled = await askYesNo("Watch channel RSS feeds for new uploads (cheap, ~15 min latency)?", config.rssEnabled);
  if (config.rssEnabled) {
    config.rssPollIntervalMinutes = await askNumber("RSS poll interval (minutes)", config.rssPollIntervalMinutes, 1);
  }
  config.rescanIntervalHours = await askNumber("Full rescan interval (hours, 0 = never)", config.rescanIntervalHours, 0, 24 * 30);

  // Cookies (age-gated / members-only content)
  console.log("\n— Cookies —");
  const cookAns = await ask(
    `   cookies.txt path (Netscape format; blank = none) [current: ${config.cookiesFile || "none"}]: `,
  );
  if (cookAns.trim() === "-") config.cookiesFile = "";
  else if (cookAns.trim() !== "") config.cookiesFile = cookAns.trim();
  config.validateCookiesOnStart = await askYesNo(
    "Validate the cookie file on startup and warn when it is stale?",
    config.validateCookiesOnStart,
  );
  if (config.cookiesFile && !existsSync(config.cookiesFile)) {
    console.log(`   ⚠️ ${config.cookiesFile} does not exist yet — age-gated videos will fail until it does.`);
  }

  console.log("\n— External Tools (Windows-friendly auto-detect) —");
  const ytdlpAns = await ask(
    `   yt-dlp path (blank = auto-detect: PATH / app folder / winget / scoop / choco) [current: ${config.ytDlpPath || "auto"}]: `,
  );
  if (ytdlpAns.trim()) config.ytDlpPath = ytdlpAns.trim();
  const ffAns = await ask(`   ffmpeg path (blank = auto-detect) [current: ${config.ffmpegPath || "auto"}]: `);
  if (ffAns.trim()) config.ffmpegPath = ffAns.trim();
  const ariaAns = await ask(
    `   aria2c path (blank = auto-detect, "none" = force the native downloader) [current: ${config.aria2cPath || "auto"}]: `,
  );
  if (ariaAns.trim()) config.aria2cPath = ariaAns.trim();
  // yt-dlp needs a JS runtime to solve YouTube's n-challenge; the engine
  // auto-discovers Deno, then Node, then Bun when this is blank, and the special
  // value "none" skips Deno entirely. Same contract as aria2cPath above.
  const denoAns = await ask(
    `   Deno path for yt-dlp's JS runtime (blank = auto-detect, "none" = skip Deno) [current: ${config.denoPath || "auto"}]: `,
  );
  if (denoAns.trim()) config.denoPath = denoAns.trim();

  await ask("\n✅ Settings updated. Press Enter to return...");
  return config;
}

// ---- Reliability & Resume Settings ------------------------------------------
async function changeReliabilitySettings(config: Config): Promise<Config> {
  console.clear();
  console.log("🛡️  Reliability & Resume Settings\n");

  console.log("These control what happens when a download is interrupted,\n");
  console.log("fails, or a file disappears. Defaults are sensible for most setups.\n");

  // Live state, so the knobs below are read against what is actually on disk.
  const live = readResumeState(config);
  if (live) {
    console.log(
      `Right now: ${live.resumable} job(s) hold a .part they will resume from` +
        (live.interrupted > 0 ? `, ${live.interrupted} parked as interrupted` : "") +
        ".\n",
    );
  } else {
    console.log("(No archive database yet — nothing to resume.)\n");
  }

  console.log("— Resume —");
  config.maxResumeAttempts = await askNumber(
    "Max resume attempts per video before restarting it from scratch",
    config.maxResumeAttempts,
    0,
  );
  console.log(
    `   Interrupted downloads keep their .part file and continue with yt-dlp --continue;\n   after ${config.maxResumeAttempts} failed resumes the partial is discarded and the video restarts.`,
  );
  if (live && live.resumable > 0) {
    console.log(
      `   Each of the ${live.resumable} partial(s) above may be resumed up to ${config.maxResumeAttempts} time(s).`,
    );
  }

  console.log("\n— Watchdogs —");
  config.downloadTimeoutMinutes = await askNumber(
    "Minimum download timeout (minutes) — scales up with video length automatically",
    config.downloadTimeoutMinutes,
    1,
  );
  config.maxDownloadMinutes = await askNumber(
    "Maximum download timeout (minutes) for very long videos",
    config.maxDownloadMinutes,
    config.downloadTimeoutMinutes,
  );

  console.log("\n— Failed-job sweep —");
  config.requeueFailedAfterMinutes = await askNumber(
    "Re-queue retryable failed jobs after (minutes; 0 = never)",
    config.requeueFailedAfterMinutes,
    0,
  );
  console.log("   Permanent failures (private / removed / age-gated videos) are never re-queued.");

  console.log("\n— Startup checks —");
  config.verifyExistingFiles = await askYesNo(
    "On startup, verify downloaded files still exist and re-queue missing ones?",
    config.verifyExistingFiles,
  );

  console.log("\n— Network monitor —");
  config.networkMonitorEnabled = await askYesNo(
    "Probe YouTube periodically and pause the engine after repeated network failures?",
    config.networkMonitorEnabled,
  );

  console.log("\n— Self-healing sweeps (run by the engine, not configurable here) —");
  console.log(`   • Crashed jobs resume        on startup`);
  const staleClaimThresholds = STALE_CLAIM_THRESHOLDS(config);
  console.log(
    `   • Stale claims reclaimed      every 60s — by lease heartbeat: downloads silent longer than ${staleClaimThresholds.download.replace("-", "")}, conversions ${staleClaimThresholds.conversion.replace("-", "")}, metadata ${staleClaimThresholds.metadata.replace("-", "")}`,
  );
  console.log(`   • Deleted files re-fetched   on startup`);
  console.log(
    `   • Retryable failed jobs      fresh window every 60s after a ${config.requeueFailedAfterMinutes} min cooldown` +
      (config.requeueFailedAfterMinutes === 0 ? " (disabled)" : ""),
  );

  await ask("\n✅ Settings updated. Press Enter to return...");
  return config;
}

// ---- Feature Toggles -------------------------------------------------------
async function changeFeatureToggles(config: Config): Promise<Config> {
  console.clear();
  console.log("🎛️  Feature Toggles\n");

  config.downloadSubtitles = await askYesNo("Download & embed subtitles?", config.downloadSubtitles);
  if (config.downloadSubtitles) {
    const langsAns = await ask(
      `   Subtitle languages — comma-separated codes (e.g. en, es, ja), regexes like en.* work, or "all" for every language [current: ${config.subtitleLanguages}]: `,
    );
    if (langsAns.trim()) config.subtitleLanguages = langsAns.trim();
  }
  config.embedMetadata = await askYesNo("Embed metadata, chapters & thumbnail?", config.embedMetadata);
  config.writeInfoJson = await askYesNo("Write .info.json sidecar files?", config.writeInfoJson);
  config.writeDescription = await askYesNo("Write .description sidecar files?", config.writeDescription);
  config.writeThumbnail = await askYesNo("Write .jpg thumbnail sidecar files?", config.writeThumbnail);
  config.verifyIntegrity = await askYesNo("Verify file integrity (SHA256) after download?", config.verifyIntegrity);
  config.skipShorts = await askYesNo("Skip YouTube Shorts (< 60s)?", config.skipShorts);
  config.downloadShorts = await askYesNo(
    "Download Shorts into their own folder (when not skipped)?",
    config.downloadShorts,
  );
  config.archiveLiveStreams = await askYesNo("Archive Live Streams (wait for VOD)?", config.archiveLiveStreams);
  config.deleteSourceAfterConvert = await askYesNo("Delete source file after conversion?", config.deleteSourceAfterConvert);

  await ask("\n✅ Toggles updated. Press Enter to return...");
  return config;
}

// ---- View Config -----------------------------------------------------------
async function viewConfig(config: Config) {
  console.clear();
  console.log("📄 Current Configuration\n");
  console.log(JSON.stringify(config, null, 2));
  await ask("\nPress Enter to return to menu...");
}

// ---- Main Menu -------------------------------------------------------------
async function mainMenu() {
  let config = await loadConfigSafe(CONFIG_PATH);
  const originalSources = new Map<string, string>();
  for (const key of SOURCE_KEYS) {
    for (const url of config[key]) originalSources.set(sourceIdentity(url), url);
  }

  while (true) {
    console.clear();
    console.log("=======================================");
    console.log("  🎬 Archiver Config Manager          ");
    console.log("=======================================\n");
    console.log("  1. Manage Standard Playlists");
    console.log("  2. Manage Channels (all uploads)");
    console.log("  3. Manage Channel Playlists");
    console.log("  4. Change Download Settings (Quality, Concurrency, Autoscale, Storage, Web UI)");
    console.log("  5. Change Feature Toggles (Subs, Metadata, Shorts, Integrity)");
    console.log("  6. Change Reliability & Resume Settings");
    console.log("  7. View Current Configuration");
    console.log("  8. Save and Exit");
    console.log("  9. Exit without Saving\n");

    const choice = (await ask("Select (1-9): ")).trim();

    switch (choice) {
      case "1":
        config = await manageUrlList(config, "playlists", "Playlists");
        break;
      case "2":
        config = await manageUrlList(config, "channels", "Channels");
        break;
      case "3":
        config = await manageUrlList(config, "channelPlaylists", "Channel Playlists");
        break;
      case "4":
        config = await changeDownloadSettings(config);
        break;
      case "5":
        config = await changeFeatureToggles(config);
        break;
      case "6":
        config = await changeReliabilitySettings(config);
        break;
      case "7":
        await viewConfig(config);
        break;
      case "8":
        let saved = false;
        try {
          await saveConfig(config, CONFIG_PATH);
          saved = true;
          console.log("\n✅ Configuration saved to " + CONFIG_PATH);
        } catch (e: any) {
          console.error("\n❌ Failed to save config:", e.message);
        }
        if (saved && existsSync("archive.db")) {
          try {
            initDatabase("archive.db");
            // A running engine owns archive.db through the engine lease. Deleting
            // jobs for removed sources underneath it could remove a row it is
            // working on (the queue purge's idle guard does not apply here), so
            // the cleanup is skipped and the engine's next start applies it —
            // the same path that catches config.json edited by hand.
            if (hasLiveLeaseOwner() && !holdsEngineLease()) {
              console.log(
                `\n⚠️ An engine is running and owns archive.db (${describeEngineLease(readEngineLease())}).`,
              );
              console.log("   Skipping database job cleanup — the next engine start applies it.");
            } else {
              const activeSources = new Set(
                SOURCE_KEYS.flatMap((key) => config[key].map((url) => sourceIdentity(url))),
              );
              for (const [identity, sourceUrl] of originalSources) {
                if (activeSources.has(identity)) continue;
                const tracked = db
                  .query("SELECT COUNT(*) AS count FROM job_sources WHERE source_url = ?")
                  .get(identity) as { count: number };
                if ((tracked?.count || 0) > 0) continue;
                try {
                  if (config.ytDlpPath.trim()) resolvedTools.ytDlp = config.ytDlpPath.trim();
                  const items = await getPlaylistItems(sourceUrl, config);
                  associateExistingJobsWithSource(identity, items.map((item) => item.id));
                } catch (e: any) {
                  console.warn(`⚠️ Could not backfill old jobs for ${sourceUrl}: ${e?.message || e}`);
                }
              }
              const cleanup = pruneJobsForUnconfiguredSources(activeSources);
              console.log(
                `🗑️ Removed ${cleanup.deletedJobs} database job(s) for sources no longer configured.` +
                  (cleanup.retainedJobs ? ` Kept ${cleanup.retainedJobs} shared job(s).` : ""),
              );
            }
          } catch (e: any) {
            console.error("\n⚠️ Config saved, but database cleanup failed:", e?.message || e);
          } finally {
            try { db?.close(); } catch { /* unopened/already closed */ }
          }
        }
        rl.close();
        return;
      case "9":
        console.log("\n👋 Exited without saving.");
        rl.close();
        return;
      default:
        console.log("   ⚠️ Invalid option.");
        await ask("Press Enter to try again...");
    }
  }
}

mainMenu();
