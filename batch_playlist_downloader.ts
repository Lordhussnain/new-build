// batch_playlist_downloader.ts — engine entry point.
//
// The implementation lives in ./src (config, db, workers, web UI, …); this
// file stays at the repo root so the familiar commands keep working:
//
//   bun run start
//   bun run build:win      → dist/youtube-archive.exe
//
// Run with: bun run batch_playlist_downloader.ts

import { main } from "./src/engine";
import { logError } from "./src/logger";

main().catch((err) => {
  logError("startup", `main() failed: ${err?.stack || err}`);
  console.error("❌ Fatal startup error:", err);
  process.exit(1);
});
