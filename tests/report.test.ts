// tests/report.test.ts — the run report shown in the web UI.

import { beforeEach, describe, expect, test } from "bun:test";
import { buildRunReport } from "../src/report";
import { initDatabase, db } from "../src/db";

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

  test("always returns lines, even on a broken database", () => {
    // Simulate a closed database — the report must degrade, not throw.
    const lines = buildRunReport();
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });
});
