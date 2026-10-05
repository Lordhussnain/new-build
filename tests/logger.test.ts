// tests/logger.test.ts — the error log must stay out of the repo under tests.
//
// Regression guard: logError used to append to cwd-relative `error.log`
// unconditionally, so a plain `bun test` at the repo root dropped fixture
// recovery lines ("reclaimed stale claims…", "gone999: file gone…") into the
// same file the production engine uses — they read as engine faults in the
// operator's log.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorLogPath, logError } from "../src/logger";

describe("errorLogPath", () => {
  test("routes test-run logs to the temp dir, never the repo's error.log", () => {
    // bun test sets NODE_ENV=test; the operator's error.log is cwd-relative.
    const path = errorLogPath();
    expect(path).not.toBe("error.log");
    expect(path.startsWith(join(tmpdir(), ""))).toBe(true);
    expect(path.endsWith("error.log")).toBe(true);
  });

  test("logError appends timestamped, scoped lines to the routed file", () => {
    logError("logger-test", "routing probe");
    const path = errorLogPath();
    expect(existsSync(path)).toBe(true);
    const line = readFileSync(path, "utf-8")
      .split("\n")
      .find((l) => l.includes("[logger-test] routing probe"));
    expect(line).toBeTruthy();
    // ISO timestamp prefix, same shape every scope writes.
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });
});
