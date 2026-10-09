// src/polling.ts — autonomous full rescans (daemon mode).
//
// The slow safety net behind the cheap RSS watcher: every rescanIntervalHours
// the engine re-lists every configured channel/playlist so videos that never
// appeared in an RSS feed (or were skipped as shorts and later re-evaluated)
// still get picked up. Ingest dedup makes rescans cheap to run often.

import { scanAndIngest } from "./scanner";
import { logError } from "./logger";
import { getConfig } from "./state";
import type { Config } from "./config";

export function startAutonomousPolling(config: Config): void {
  if (!config.daemonMode || config.rescanIntervalHours <= 0) return;
  const intervalMs = config.rescanIntervalHours * 60 * 60 * 1000;
  console.log(`🤖 Daemon mode: full rescan every ${config.rescanIntervalHours}h.`);
  let inFlight = false;
  // Start even with no sources: the Web UI can add the first one later.
  setInterval(async () => {
    const current = getConfig();
    if (inFlight || current.offlineMode || !current.daemonMode || current.rescanIntervalHours <= 0) return;
    const urls = [...new Set([...current.playlists, ...current.channels, ...current.channelPlaylists])];
    if (urls.length === 0) return;
    inFlight = true;
    try {
      console.log("🔄 [Daemon] Running full source rescan...");
      for (const url of urls) {
        const live = getConfig();
        // Offline mode may have been enabled during the preceding listing. Stop
        // before starting another source; scanAndIngest also checks again
        // before ingesting results from a scan already in flight.
        if (live.offlineMode || !live.daemonMode || live.rescanIntervalHours <= 0) break;
        try {
          await scanAndIngest(url, live);
        } catch (e: any) {
          logError("rescan", `${url}: ${e?.message || e}`);
          console.error(`❌ Rescan failed for ${url}:`, e?.message || e);
        }
      }
    } finally {
      inFlight = false;
    }
  }, intervalMs);
}
