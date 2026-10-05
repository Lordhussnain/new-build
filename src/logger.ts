// src/logger.ts — append-only error log with size-based rotation.

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 1_000_000;

/**
 * The file `logError` appends to.
 *
 * Production: `error.log` next to the engine (cwd-relative, like archive.db
 * and config.json). Under `bun test` — which sets NODE_ENV=test — the path
 * moves into the OS temp dir instead. Unit tests drive logError directly via
 * the reconcile sweeps and retry-classification fixtures, and those recovery
 * messages ("reclaimed stale claims…", "gone999: file gone…") used to land in
 * the operator's real error.log when the suite ran from the repo root, reading
 * as engine faults. The dashboard's /api/logs endpoint reads through this
 * function too, so viewer and writer always agree.
 */
export function errorLogPath(): string {
  return process.env.NODE_ENV === "test" ? join(tmpdir(), "yta-test-error.log") : "error.log";
}

export function logError(scope: string, message: string): void {
  try {
    const path = errorLogPath();
    appendFileSync(path, `[${new Date().toISOString()}] [${scope}] ${message}\n`);
    // Keep the log bounded: when it grows past ~1MB, keep only the last 400 lines.
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      const lines = readFileSync(path, "utf-8").split("\n");
      writeFileSync(path, lines.slice(-400).join("\n"));
    }
  } catch {
    // Logging must never take the engine down.
  }
}
