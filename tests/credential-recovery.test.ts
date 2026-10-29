import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as reconcile from "../src/reconcile";
import { DEFAULT_CONFIG } from "../src/config";
import { db, initDatabase } from "../src/db";
import { acquireEngineLease, releaseEngineLease } from "../src/lease";
import { requeueCredentialBlockedJobs } from "../src/reconcile";
import { isCredentialBlockedError } from "../src/retry";
import { markJobCancelled, setConfig, setPaused } from "../src/state";

beforeEach(() => {
  initDatabase(":memory:");
  acquireEngineLease();
  setConfig({ ...DEFAULT_CONFIG });
  setPaused(false);
});
afterEach(() => setPaused(false));

function failed(id: string, changes: Record<string, unknown> = {}): void {
  const fields = {
    id, url: "https://example.test/video", title: id, output_directory: "/tmp/out",
    download_status: "failed", last_error: "Login required", retry_count: 99,
    resume_count: 99, progress: 42, best_progress: 42, partial_file_path: "/tmp/keep.part",
    ...changes,
  };
  db.run(`INSERT INTO jobs (${Object.keys(fields).map(key => `"${key}"`).join(",")}) VALUES (${Object.keys(fields).map(() => "?").join(",")})`, Object.values(fields) as any[]);
}
function row(id: string): any { return db.query("SELECT * FROM jobs WHERE id = ?").get(id); }

describe("credential recovery", () => {
  test("changed usable bytes trigger one rescue, but touching or invalid cookies do not", async () => {
    expect(typeof reconcile.refreshCookies).toBe("function");
    const dir = await mkdtemp(join(tmpdir(), "yta-cookie-recovery-"));
    const cookiesFile = join(dir, "cookies.txt");
    const config = { ...DEFAULT_CONFIG, cookiesFile, cookieBrowsers: [] };
    setConfig(config);
    const jar = (value: string) => `.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t${value}\n`;
    try {
      failed("fresh");
      await writeFile(cookiesFile, "invalid");
      await reconcile.refreshCookies();
      expect(row("fresh").download_status).toBe("failed");
      await writeFile(cookiesFile, jar("first"));
      await reconcile.refreshCookies();
      expect(row("fresh").download_status).toBe("pending");
      db.run("UPDATE jobs SET download_status = 'failed', last_error = 'Login required' WHERE id = 'fresh'");
      await utimes(cookiesFile, new Date(), new Date());
      await reconcile.refreshCookies();
      expect(row("fresh").download_status).toBe("failed");
      await writeFile(cookiesFile, jar("second"));
      setPaused(true, "USER_PAUSED");
      await reconcile.refreshCookies();
      expect(row("fresh").download_status).toBe("failed");
      setPaused(false);
      await reconcile.refreshCookies();
      expect(row("fresh").download_status).toBe("pending");
    } finally {
      await rm(dir, { recursive: true, force: true });
      setConfig({ ...DEFAULT_CONFIG });
    }
  });

  test("credential context rescues unavailable wording without rescuing private or deleted videos", () => {
    for (const text of ["Video unavailable. Login required", "cookies are expired", "Sign in to confirm your age", "Join this channel to get access", "[terminal] Age-restricted video — skipped"]) {
      expect(isCredentialBlockedError(text)).toBe(true);
    }
    for (const text of ["Private video. Sign in to view", "Video has been removed. Login required", "[terminal] Video not found — cookies expired", "not available in your country", "Connection reset", null]) {
      expect(isCredentialBlockedError(text)).toBe(false);
    }
  });

  test("rescues every eligible job with fresh budgets while preserving partial progress", () => {
    for (let i = 0; i < 150; i++) failed(`blocked-${i}`);
    failed("dead", { last_error: "Private video" });
    expect(requeueCredentialBlockedJobs(DEFAULT_CONFIG)).toBe(150);
    expect(row("blocked-0")).toMatchObject({ download_status: "pending", retry_count: 0, resume_count: 0, last_error: null, progress: 42, best_progress: 42, partial_file_path: "/tmp/keep.part" });
    expect(row("dead").download_status).toBe("failed");
    expect(requeueCredentialBlockedJobs(DEFAULT_CONFIG)).toBe(0);
  });

  test("active claims, user-held jobs and cancelled jobs remain untouched", () => {
    const holds = [
      { download_claim_token: "download-owner" }, { download_claimed_by: "DL1" },
      { metadata_claim_token: "metadata-owner" }, { metadata_claimed_by: "MD1" },
      { conversion_claim_token: "convert-owner" }, { conversion_claimed_by: "CV1" },
      { metadata_status: "in_progress" }, { conversion_status: "in_progress" },
      { pause_reason: "user" }, { download_status: "paused", pause_reason: "user" },
    ];
    holds.forEach((hold, i) => failed(`held-${i}`, hold));
    failed("cancelled-credential-job");
    markJobCancelled("cancelled-credential-job");
    expect(requeueCredentialBlockedJobs(DEFAULT_CONFIG)).toBe(0);
    holds.forEach((_, i) => expect(row(`held-${i}`).retry_count).toBe(99));
  });

  test("offline, paused and lease-less engines cannot requeue jobs", () => {
    failed("blocked");
    expect(requeueCredentialBlockedJobs({ ...DEFAULT_CONFIG, offlineMode: true })).toBe(0);
    setPaused(true, "USER_PAUSED");
    expect(requeueCredentialBlockedJobs(DEFAULT_CONFIG)).toBe(0);
    setPaused(false);
    releaseEngineLease();
    expect(requeueCredentialBlockedJobs(DEFAULT_CONFIG)).toBe(0);
    expect(row("blocked").retry_count).toBe(99);
  });
});
