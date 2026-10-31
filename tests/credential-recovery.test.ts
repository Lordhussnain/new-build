import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as reconcile from "../src/reconcile";
import { DEFAULT_CONFIG } from "../src/config";
import { db, initDatabase } from "../src/db";
import { acquireEngineLease, releaseEngineLease } from "../src/lease";
import { requeueCredentialBlockedJobs } from "../src/reconcile";
import { classifyTerminalDownloadError, formatTerminalErrorMessage, isCredentialBlockedError } from "../src/retry";
import { resetCookiesBaseline, usableCookieFingerprint } from "../src/tools";
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

  test("stored generic login failures recover, but hard terminal reasons win anywhere in the tail", () => {
    const raw = "ERROR: Video unavailable. Login required";
    const info = classifyTerminalDownloadError(raw)!;
    expect(info.code).toBe("unavailable");
    const stored = formatTerminalErrorMessage(info, raw);
    expect(isCredentialBlockedError(stored)).toBe(true);
    expect(stored).toContain("until fresh usable cookies");
    for (const text of [
      "Sign in to confirm your age. Video has been removed by the uploader",
      "Join this channel to get access. This video is not available in your country",
      "[terminal] Age-restricted video — yt-dlp: Video has been removed",
      "[terminal] Video unavailable — yt-dlp: Login required; this video is private",
      "[terminal] Requested format not available — yt-dlp: cookies expired",
    ]) expect(isCredentialBlockedError(text)).toBe(false);
  });

  test("truncated terminal diagnostics retain both hard and credential decisions", () => {
    const longPrefix = "x".repeat(400);
    const blocked = `Video unavailable. ${longPrefix} Login required`;
    const blockedInfo = classifyTerminalDownloadError(blocked)!;
    expect(isCredentialBlockedError(blocked)).toBe(true);
    const blockedRecord = formatTerminalErrorMessage(blockedInfo, blocked);
    expect(blockedRecord).toContain("Sign-in or cookies required");
    expect(isCredentialBlockedError(blockedRecord)).toBe(true);

    const removed = `Sign in to confirm your age. ${longPrefix} Video has been removed`;
    const removedInfo = classifyTerminalDownloadError(removed)!;
    expect(removedInfo.code).toBe("removed");
    const removedRecord = formatTerminalErrorMessage(removedInfo, removed);
    expect(isCredentialBlockedError(removedRecord)).toBe(false);
    expect(removedRecord).toContain("will not be retried automatically");
  });

  test("a claimed failure waits for its claim without repeatedly rescuing an already retried job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-cookie-claims-"));
    const cookiesFile = join(dir, "cookies.txt");
    setConfig({ ...DEFAULT_CONFIG, cookiesFile, cookieBrowsers: [] });
    try {
      failed("ready");
      failed("held", { download_claim_token: "owner" });
      await writeFile(cookiesFile, ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalid\n");
      expect(await reconcile.refreshCookies()).toBe(1);
      expect(row("held").download_status).toBe("failed");
      db.run("UPDATE jobs SET download_status = 'failed', last_error = 'Login required' WHERE id = 'ready'");
      db.run("UPDATE jobs SET download_claim_token = NULL WHERE id = 'held'");
      expect(await reconcile.refreshCookies()).toBe(1);
      expect(row("held").download_status).toBe("pending");
      expect(row("ready").download_status).toBe("failed");
      expect(await reconcile.refreshCookies()).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("a failure from an old in-flight cookie snapshot is rescued after the watcher already saw the refresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-cookie-inflight-"));
    const cookiesFile = join(dir, "cookies.txt");
    setConfig({ ...DEFAULT_CONFIG, cookiesFile, cookieBrowsers: [] });
    try {
      failed("late", { download_status: "downloading", last_error: null });
      await writeFile(cookiesFile, ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\told\n");
      const old = usableCookieFingerprint({ cookiesFile });
      expect(await reconcile.refreshCookies()).toBe(0);
      await writeFile(cookiesFile, ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tnew\n");
      expect(await reconcile.refreshCookies()).toBe(0); // the job is still running
      db.run("UPDATE jobs SET download_status = 'failed', last_error = 'Login required' WHERE id = 'late'");
      reconcile.noteCredentialFailure("late", old);
      expect(await reconcile.refreshCookies()).toBe(1);
      expect(row("late").download_status).toBe("pending");
      // A failure actually made using the new bytes must not loop on every tick.
      db.run("UPDATE jobs SET download_status = 'failed', last_error = 'Login required' WHERE id = 'late'");
      reconcile.noteCredentialFailure("late", usableCookieFingerprint({ cookiesFile }));
      expect(await reconcile.refreshCookies()).toBe(0);
      expect(await reconcile.refreshCookies()).toBe(0);
      expect(row("late").download_status).toBe("failed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("a failure using new bytes before the first observation is not retried with those same bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-cookie-observation-"));
    const cookiesFile = join(dir, "cookies.txt");
    setConfig({ ...DEFAULT_CONFIG, cookiesFile, cookieBrowsers: [] });
    try {
      await writeFile(cookiesFile, ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tnew\n");
      failed("already-tried");
      reconcile.noteCredentialFailure("already-tried", usableCookieFingerprint({ cookiesFile }));
      expect(await reconcile.refreshCookies()).toBe(0);
      expect(row("already-tried").download_status).toBe("failed");
      await writeFile(cookiesFile, ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tnewer\n");
      expect(await reconcile.refreshCookies()).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("an unwritable working copy never exposes the original and delays rescue until it is fixed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-cookie-copy-"));
    const cookiesFile = join(dir, "cookies.txt");
    const config = { ...DEFAULT_CONFIG, cookiesFile, cookieBrowsers: [] };
    setConfig(config);
    const jar = ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalid\n";
    try {
      await writeFile(cookiesFile, jar);
      failed("protected");
      // A nonexistent temp root blocks the private snapshot, without exposing
      // the source jar. The normal temp root on the next tick is usable.
      expect(await reconcile.refreshCookies({ tempRoot: join(dir, "missing-temp-root") })).toBe(0);
      expect(row("protected").download_status).toBe("failed");
      expect(await Bun.file(cookiesFile).text()).toBe(jar);
      expect(await reconcile.refreshCookies()).toBe(1);
      expect(row("protected").download_status).toBe("pending");
      expect(await Bun.file(cookiesFile).text()).toBe(jar);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("a disappeared file that reappears with the same bytes is observed again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-cookie-reappear-"));
    const cookiesFile = join(dir, "cookies.txt");
    const config = { ...DEFAULT_CONFIG, cookiesFile, cookieBrowsers: [] };
    setConfig(config);
    const jar = ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalid\n";
    try {
      resetCookiesBaseline();
      await writeFile(cookiesFile, jar);
      reconcile.cookiesWatch(config);
      failed("again");
      await reconcile.refreshCookies();
      db.run("UPDATE jobs SET download_status = 'failed', last_error = 'Login required' WHERE id = 'again'");
      await rm(cookiesFile);
      expect(reconcile.cookiesWatch(config)).toBe("disappeared");
      await writeFile(cookiesFile, jar);
      expect(reconcile.cookiesWatch(config)).toBe("appeared");
      expect(await reconcile.refreshCookies()).toBe(1);
      expect(row("again").download_status).toBe("pending");
    } finally { resetCookiesBaseline(); await rm(dir, { recursive: true, force: true }); }
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
