// tests/report.test.ts — the run report shown in the web UI.

import { beforeEach, describe, expect, test } from "bun:test";
import { buildRunReport } from "../src/report";
import { initDatabase, db } from "../src/db";
import { stats } from "../src/state";

function insertJob(id: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: `Video ${id}`,
    output_directory: "/tmp/out",
    target_format: "mp4",
    ...overrides,
  };
  const cols = Object.keys(row);
  db.run(
    `INSERT INTO jobs (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    Object.values(row) as any[],
  );
}

beforeEach(() => {
  initDatabase(":memory:");
});

describe("buildRunReport", () => {
  test("summarizes an empty database", () => {
    const lines = buildRunReport();
    expect(lines.some((l) => l.includes("=== Archive Engine Report"))).toBe(true);
    expect(lines.some((l) => l.includes("total: 0"))).toBe(true);
    expect(lines.some((l) => l.includes("No failed jobs"))).toBe(true);
  });

  test("counts every pipeline stage", () => {
    insertJob("a", { download_status: "pending" });
    insertJob("b", { download_status: "downloaded", metadata_status: "done", conversion_status: "not_needed" });
    insertJob("c", { download_status: "failed", last_error: "Video unavailable", retry_count: 3 });
    insertJob("d", { download_status: "waiting_live" });
    const lines = buildRunReport().join("\n");
    expect(lines).toContain("pending: 1");
    expect(lines).toContain("downloaded: 1");
    expect(lines).toContain("failed: 1");
    expect(lines).toContain("waiting for VOD: 1");
    expect(lines).toContain("Video unavailable");
  });

  test("renders a terminal skip as a reason, not as a stack trace", () => {
    // The engine stores "[terminal] <label> — skipped … yt-dlp: <tail>". The
    // report is the operator-facing history, so it shows the label and states
    // plainly that nothing will retry it — the raw tail stays in the job row.
    insertJob("skip1", {
      download_status: "failed",
      last_error:
        "[terminal] Private video — skipped, it will not be retried automatically. yt-dlp: ERROR: [youtube] skip1: This video is private",
      retry_count: 0,
    });
    const lines = buildRunReport().join("\n");
    expect(lines).toContain("⛔ [skip1] Video skip1 — Private video (skipped, never auto-retried)");
    expect(lines).not.toContain("This video is private");
  });

  test("counts terminal skips apart from recoverable failures", () => {
    // `stats` is the per-run ledger (the DB aggregate above keeps its own
    // numbers): skips are reported inside `failed` — the video was not
    // archived — and separately, so "this one is gone" never reads like
    // "this one broke".
    insertJob("recoverable", { download_status: "failed", last_error: "Connection reset by peer", retry_count: 2 });
    const before = { failed: stats.failed, unavailable: stats.unavailable, formatFallbacks: stats.formatFallbacks };
    stats.failed = 3;
    stats.unavailable = 2;
    stats.formatFallbacks = 1;
    try {
      const lines = buildRunReport().join("\n");
      expect(lines).toContain("failed: 3 (of which unavailable: 2)");
      expect(lines).toContain("format fallbacks: 1");
    } finally {
      Object.assign(stats, before);
    }
  });

  test("always returns lines, even on a broken database", () => {
    // Simulate a closed database — the report must degrade, not throw.
    const lines = buildRunReport();
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });
});
