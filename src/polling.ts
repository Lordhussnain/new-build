// src/polling.ts — autonomous full rescans (daemon mode).
//
// The slow safety net behind the cheap RSS watcher: every rescanIntervalHours
// the engine re-lists every configured channel/playlist so videos that never
// appeared in an RSS feed (or were skipped as shorts and later re-evaluated)
// still get picked up. Ingest dedup makes rescans cheap to run often.

import { scanAndIngest } from "./scanner";
import { logError } from "./logger";
import type { Config } from "./config";

export function startAutonomousPolling(config: Config): void {
  if (config.rescanIntervalHours > 0 && (config.channels.length > 0 || config.channelPlaylists.length > 0)) {
    const intervalMs = config.rescanIntervalHours * 60 * 60 * 1000;
    console.log(`🤖 Daemon mode: full rescan every ${config.rescanIntervalHours}h.`);
    setInterval(async () => {
      console.log("🔄 [Daemon] Running full channel rescan...");
      for (const url of [...config.channels, ...config.channelPlaylists]) {
        try {
          await scanAndIngest(url, config);
        } catch (e: any) {
          logError("rescan", `${url}: ${e?.message || e}`);
          console.error(`❌ Rescan failed for ${url}:`, e?.message || e);
        }
      }
    }, intervalMs);
  }
}
