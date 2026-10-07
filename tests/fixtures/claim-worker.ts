// tests/fixtures/claim-worker.ts — an out-of-process harness for race tests.
//
// The claim/lease guarantees are about SEPARATE SQLite connections and separate
// engine processes: two in-process calls on one handle would pass even if the
// atomicity were faked with a plain read-then-write. This script is spawned as a
// real child process (see tests/claim-races.test.ts), opens the same
// file-backed archive.db through the real engine code, and prints one
// machine-readable line per action:
//
//   CLAIMED <jobId> <claimToken>          a claim this process won
//   REAP <true|false>                     result of a claim-token CAS
//   UPDATE <changes>                      result of a stale claim update
//   RELEASED <true|false>                 result of releasing a claim
//   LOST                                  a heartbeat that no longer matched
//   LEASE <json>                          engine-lease acquisition result
//   DONE                                  the command finished
//
// Usage: bun run tests/fixtures/claim-worker.ts <command> [args…]

import {
  claimConvertJob,
  claimDownloadJob,
  claimRef,
  heartbeatClaim,
  initDatabase,
  releaseClaimedJob,
  updateClaimedJob,
  type Job,
} from "../../src/db";
import { acquireEngineLease, releaseEngineLease } from "../../src/lease";
import { reapStaleClaim } from "../../src/reconcile";
import type { ClaimRef } from "../../src/db";

const [command, ...args] = process.argv.slice(2);

function out(kind: string, payload: unknown = ""): void {
  process.stdout.write(`${kind} ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n`);
}

/** `-` stands for SQL NULL (a legacy claim with no token/owner). */
function nullable(value: string): string | null {
  return value === "-" ? null : value;
}

function claimOf(row: Job | null): ClaimRef {
  return row ? claimRef("download", row) : { by: null, token: null };
}

function reportClaim(row: Job | null): void {
  if (!row) return;
  out("CLAIMED", `${row.id} ${row.download_claim_token ?? "-"}`);
}

async function main(): Promise<void> {
  switch (command) {
    // Claim as fast as possible, up to <attempts> tries, printing every win.
    case "claim-loop": {
      const [dbPath, workerId, attemptsArg, delayArg] = args;
      initDatabase(dbPath);
      const attempts = Number(attemptsArg) || 50;
      const delay = Number(delayArg) || 0;
      for (let i = 0; i < attempts; i++) {
        reportClaim(claimDownloadJob(workerId));
        if (delay > 0) await Bun.sleep(delay);
      }
      break;
    }

    // Claim one job (the next eligible one) and print its token.
    case "claim-one": {
      const [dbPath, workerId] = args;
      initDatabase(dbPath);
      reportClaim(claimDownloadJob(workerId));
      break;
    }

    // Claim a job and exit WITHOUT releasing it — a worker that crashed.
    case "claim-and-die": {
      const [dbPath, workerId] = args;
      initDatabase(dbPath);
      reportClaim(claimDownloadJob(workerId));
      break;
    }

    // Claim a job and hold the claim (optionally releasing it cleanly) so
    // another process can race against it.
    case "claim-and-hold": {
      const [dbPath, workerId, holdArg, releaseArg] = args;
      initDatabase(dbPath);
      const job = claimDownloadJob(workerId);
      reportClaim(job);
      await Bun.sleep(Number(holdArg) || 500);
      if (job && releaseArg === "release") {
        out("RELEASED", releaseClaimedJob("download", job.id, claimOf(job), `download_status = 'pending'`) === 1);
      }
      break;
    }

    // Reap a specific claim after <delayMs>, using the snapshot the caller saw
    // (by/token/modifier) — this is the reaper's compare-and-swap.
    case "reap": {
      const [dbPath, jobId, by, token, modifier, delayArg] = args;
      initDatabase(dbPath);
      await Bun.sleep(Number(delayArg) || 0);
      out("REAP", reapStaleClaim("download", jobId, { by: nullable(by), token: nullable(token) }, modifier));
      break;
    }

    // Reap a stale claim and immediately claim the job again — the "someone
    // else took the job after the claim was reset" scenario.
    case "reap-then-claim": {
      const [dbPath, jobId, by, token, modifier, workerId] = args;
      initDatabase(dbPath);
      out("REAP", reapStaleClaim("download", jobId, { by: nullable(by), token: nullable(token) }, modifier));
      reportClaim(claimDownloadJob(workerId));
      break;
    }

    // A stale worker's late write: the claim it presents is no longer the row's.
    case "stale-update": {
      const [dbPath, jobId, by, token, pct] = args;
      initDatabase(dbPath);
      const changes = updateClaimedJob(
        "download",
        jobId,
        { by: nullable(by), token: nullable(token) },
        `progress = ?`,
        [Number(pct) || 0],
        `download_status = 'downloading'`,
      );
      out("UPDATE", changes);
      break;
    }

    // Claim a conversion and keep its lease alive (heartbeats) for <durationMs>:
    // a long-running stage that must NOT look stale to the reaper.
    case "convert-heartbeat": {
      const [dbPath, workerId, durationArg, intervalArg] = args;
      initDatabase(dbPath);
      const job = claimConvertJob(workerId);
      if (job) out("CLAIMED", `${job.id} ${job.conversion_claim_token ?? "-"}`);
      const duration = Number(durationArg) || 1000;
      const interval = Number(intervalArg) || 150;
      const claim = job ? claimRef("conversion", job) : { by: null, token: null };
      const deadline = Date.now() + duration;
      while (job && Date.now() < deadline) {
        await Bun.sleep(interval);
        if (!heartbeatClaim("conversion", job.id, claim)) out("LOST");
      }
      break;
    }

    // Acquire the database-level engine lease (optionally holding it for a
    // while) and report the result.
    case "lease": {
      const [dbPath, holdArg, releaseArg] = args;
      initDatabase(dbPath);
      const result = acquireEngineLease();
      out("LEASE", {
        acquired: result.acquired,
        fencing: result.lease?.fencing ?? null,
        tookOver: result.tookOver,
        owner: result.lease?.owner ?? null,
      });
      const hold = Number(holdArg) || 0;
      if (hold > 0) await Bun.sleep(hold);
      if (releaseArg === "release") out("RELEASED", releaseEngineLease());
      break;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.exit(2);
  }
  out("DONE");
}

await main();
