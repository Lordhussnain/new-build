// tests/cookies.test.ts — cookies.txt is watched for the whole run, not just at
// startup.
//
// Operators export cookies.txt from the browser *after* the engine is already
// running, and replace it when it expires. `cookiesArgs()` re-stats the file on
// every yt-dlp invocation so the next attempt uses it either way; the sweep is
// what makes that visible and what tells the operator how many parked jobs the
// new cookies may rescue.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { cookiesArgs, cookiesState, detectCookiesChange, resetCookiesBaseline } from "../src/tools";
import { cookiesWatch } from "../src/reconcile";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { db, initDatabase } from "../src/db";

const dirs: string[] = [];
let cookiesFile = "";

function cfg(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, cookiesFile, ...overrides };
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "yta-cookies-"));
  dirs.push(dir);
  cookiesFile = join(dir, "cookies.txt");
  resetCookiesBaseline();
  initDatabase(":memory:");
});

afterEach(async () => {
  resetCookiesBaseline();
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe("cookiesArgs", () => {
  test("omits --cookies when the file is missing", () => {
    expect(cookiesArgs(cfg())).toEqual([]);
  });

  test("omits --cookies when the file is empty", async () => {
    await writeFile(cookiesFile, "");
    expect(cookiesArgs(cfg())).toEqual([]);
  });

  test("passes the file once it has content", async () => {
    await writeFile(cookiesFile, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx\n");
    expect(cookiesArgs(cfg())).toEqual(["--cookies", cookiesFile]);
  });
});

describe("cookiesState", () => {
  test("reports a missing file without throwing", () => {
    const s = cookiesState(cfg());
    expect(s.present).toBe(false);
    expect(s.size).toBe(0);
    expect(s.file).toBe(cookiesFile);
  });

  test("treats an empty file as absent", async () => {
    await writeFile(cookiesFile, "");
    expect(cookiesState(cfg()).present).toBe(false);
  });
});

describe("detectCookiesChange", () => {
  test("the first observation is the baseline, not a change", async () => {
    await writeFile(cookiesFile, "cookies");
    expect(detectCookiesChange(cfg()).change).toBeNull();
  });

  test("missing → present is 'appeared'", () => {
    expect(detectCookiesChange(cfg()).change).toBeNull();
    // Synchronous write: the next poll must see it, exactly as the engine's
    // 60s interval would.
    writeFileSync(cookiesFile, "# Netscape HTTP Cookie File\nSID\tx");
    expect(detectCookiesChange(cfg()).change).toBe("appeared");
    // Reported once, then quiet.
    expect(detectCookiesChange(cfg()).change).toBeNull();
  });

  test("a content change is 'updated', and no change is null", async () => {
    await writeFile(cookiesFile, "first");
    expect(detectCookiesChange(cfg()).change).toBeNull();
    expect(detectCookiesChange(cfg()).change).toBeNull();

    await writeFile(cookiesFile, "second, longer");
    // mtime granularity can hide a same-millisecond rewrite; the size differs.
    expect(detectCookiesChange(cfg()).change).toBe("updated");
  });

  test("a rewrite of the SAME bytes is not an update", async () => {
    // What the operator hit: a browser extension re-exports cookies.txt on its
    // own timer. The content never changes, the mtime changes on every write,
    // and the old mtime-based signal printed one "cookies.txt updated" line per
    // poll — 1440 lines a day, which is what rotated error.log and buried the
    // real failures.
    const same = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx\n";
    writeFileSync(cookiesFile, same);
    expect(detectCookiesChange(cfg()).change).toBeNull();
    for (let i = 0; i < 5; i++) {
      writeFileSync(cookiesFile, same);
      utimesSync(cookiesFile, new Date(), new Date(Date.now() + 1000 * (i + 1)));
      expect(detectCookiesChange(cfg()).change).toBeNull();
    }
    // Same size, different bytes: still a real change, and it is reported.
    const swapped = same.replace("\tSID\tx", "\tSID\ty");
    expect(swapped.length).toBe(same.length);
    writeFileSync(cookiesFile, swapped);
    expect(detectCookiesChange(cfg()).change).toBe("updated");
  });

  test("a 0-byte cookies.txt stays 'absent' and only real content registers", async () => {
    // An empty file yields no hash (nothing to hash), so the watcher is running
    // on presence/size here — and it must stay quiet: touching an empty file is
    // never an update, and neither is a metadata-only rewrite.
    await writeFile(cookiesFile, "");
    expect(detectCookiesChange(cfg()).change).toBeNull(); // baseline: absent (0 bytes)
    for (let i = 0; i < 3; i++) {
      writeFileSync(cookiesFile, "");
      utimesSync(cookiesFile, new Date(), new Date(Date.now() + 1000 * (i + 1)));
      expect(detectCookiesChange(cfg()).change).toBeNull();
    }
    await writeFile(cookiesFile, "aaaa");
    expect(detectCookiesChange(cfg()).change).toBe("appeared");
    await writeFile(cookiesFile, "bbbb"); // hashable both sides: a real change
    expect(detectCookiesChange(cfg()).change).toBe("updated");
    unlinkSync(cookiesFile);
    expect(detectCookiesChange(cfg()).change).toBe("disappeared");
    writeFileSync(cookiesFile, ""); // an empty file is still 'absent' cookies
    expect(detectCookiesChange(cfg()).change).toBeNull();
  });

  test("present → missing is 'disappeared'", async () => {
    await writeFile(cookiesFile, "cookies");
    expect(detectCookiesChange(cfg()).change).toBeNull();
    unlinkSync(cookiesFile);
    expect(detectCookiesChange(cfg()).change).toBe("disappeared");
    // Stays quiet once it has been reported.
    expect(detectCookiesChange(cfg()).change).toBeNull();
  });
});

describe("cookiesWatch", () => {
  function insertFailed(id: string, lastError: string | null): void {
    db.run(
      `INSERT INTO jobs (id, url, title, output_directory, target_format, download_status, last_error)
       VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
      [id, `https://www.youtube.com/watch?v=${id}`, `Video ${id}`, "/tmp/out", "mp4", lastError],
    );
  }

  test("reports 'appeared' and counts the jobs the cookies may rescue", async () => {
    insertFailed("ck1", "ERROR: [youtube] Login required");
    insertFailed("ck2", "ERROR: [youtube] Sign in to confirm your age");
    insertFailed("ck3", "ERROR: HTTP 500 while downloading");

    expect(cookiesWatch(cfg())).toBeNull(); // baseline: no file yet

    await writeFile(cookiesFile, "# Netscape HTTP Cookie File\nSID\tx");
    const change = cookiesWatch(cfg());
    expect(change).toBe("appeared");

    // The credential-shaped failures are the ones a cookie fixes; the plain
    // HTTP error is not counted.
    const blocked = (
      db
        .query(
          `SELECT COUNT(*) AS n FROM jobs
            WHERE download_status = 'failed'
              AND (lower(COALESCE(last_error,'')) LIKE '%login%'
                OR lower(COALESCE(last_error,'')) LIKE '%sign in%'
                OR lower(COALESCE(last_error,'')) LIKE '%age%'
                OR lower(COALESCE(last_error,'')) LIKE '%cookie%')`,
        )
        .get() as any
    ).n;
    expect(blocked).toBe(2);

    // Permanent failures are never auto-requeued — cookies arriving must not
    // silently resurrect them.
    expect((db.query(`SELECT download_status FROM jobs WHERE id = 'ck1'`).get() as any).download_status).toBe(
      "failed",
    );
  });

  test("reports 'disappeared' when the file is removed mid-run", async () => {
    await writeFile(cookiesFile, "cookies");
    expect(cookiesWatch(cfg())).toBeNull();
    unlinkSync(cookiesFile);
    expect(cookiesWatch(cfg())).toBe("disappeared");
    // And downloads now run anonymously.
    expect(cookiesArgs(cfg())).toEqual([]);
  });

  test("is quiet while nothing changes", async () => {
    await writeFile(cookiesFile, "cookies");
    expect(cookiesWatch(cfg())).toBeNull();
    expect(cookiesWatch(cfg())).toBeNull();
    expect(cookiesWatch(cfg())).toBeNull();
  });
});
