// src/lease.ts — the database-level engine lease: one engine per `archive.db`.
//
// The web port is the HTTP lock, but it is not an ownership primitive for the
// job database: two engines configured with different `webPort` values bind
// their own ports happily and then both run the startup reconciliation on the
// same rows — each resetting the other's in-flight claims, which looks exactly
// like workers fighting over jobs. The port also says nothing about a *stale*
// engine whose process died without releasing it.
//
// The lease lives in the database, so it is shared by every process that can
// touch the jobs table:
//
//   • acquisition happens in a short SQLite write transaction BEFORE any
//     startup sweep, so a second engine refuses to start instead of
//     re-queueing the live engine's work;
//   • `owner` is a random per-process token — not the port, not the pid alone —
//     so two processes can never mistake each other for themselves;
//   • `expires_at` is renewed by a heartbeat, and an expired lease can be taken
//     over (a crashed engine must not wedge the archive forever);
//   • `fencing` increases monotonically on every acquisition, so "this row was
//     written by the previous generation of the engine" is decidable — the
//     claim tokens in `db.ts` use the same idea per job.
//
// The lease is released on graceful shutdown (so a restart is never blocked by
// a process that exited cleanly); a hard kill simply lets it expire.

import { hostname } from "node:os";
import { db } from "./db";
import { logError } from "./logger";

/** How long an engine lease stays valid without a heartbeat. */
export const ENGINE_LEASE_TTL_MS = 60_000;
/** How often the holder renews it (must be well inside the TTL). */
export const ENGINE_LEASE_RENEW_MS = 20_000;

/** The lease row as stored (times are SQLite UTC `YYYY-MM-DD HH:MM:SS`). */
export interface EngineLease {
  owner: string | null;
  fencing: number;
  /** PID of the owning process (same-host liveness checks), null for legacy rows. */
  pid: number | null;
  /** Hostname the owning process ran on, null for legacy rows. */
  host: string | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
}

export interface LeaseAcquireResult {
  /** True when this process now owns the lease. */
  acquired: boolean;
  /** The lease row after the attempt (the live holder's when refused). */
  lease: EngineLease | null;
  /** True when an expired lease was taken over from a previous owner. */
  tookOver: boolean;
}

/** This process's lease identity; minted once, reused on re-acquire/renew. */
let processOwnerToken: string | null = null;
/** Set while this process holds the lease (owner + generation). */
let currentLease: { owner: string; fencing: number } | null = null;

/** Test-only override for the TTL, read like `YTA_AUDIO_PROBE_TIMEOUT_MS`. */
export function engineLeaseTtlMs(): number {
  const override = Number(process.env.YTA_ENGINE_LEASE_TTL_MS);
  return Number.isFinite(override) && override > 0 ? override : ENGINE_LEASE_TTL_MS;
}

/** The hostname of this machine, defensively (os.hostname can fail in odd sandboxes). */
function currentHost(): string {
  try {
    return hostname();
  } catch {
    return "unknown-host";
  }
}

/** A token that identifies this process among all engines that ever ran here. */
function mintOwnerToken(): string {
  return `${currentHost()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Is `pid` a live process on this machine?
 *
 * `process.kill(pid, 0)` performs the existence check without signalling. EPERM
 * means the process exists but belongs to another user — still alive. Any other
 * error (ESRCH) means it is gone.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/**
 * True when the lease's recorded owner process is provably gone (same host,
 * known pid, no such process).
 *
 * This is what lets a restart after a hard kill take the lease over at once
 * instead of waiting out the TTL — the crash-recovery promise ("kill the
 * engine, start it again, the partial resumes") must not acquire a one-minute
 * pause. A different host cannot be probed, so there only the expiry decides;
 * an unknown pid (a lease row from an older version) is equally conservative.
 */
export function leaseOwnerIsDead(lease: EngineLease | null): boolean {
  if (!lease?.owner || lease.pid == null) return false;
  if (lease.host && lease.host !== currentHost()) return false;
  return !processIsAlive(lease.pid);
}

export function engineLeaseOwner(): string {
  if (!processOwnerToken) processOwnerToken = mintOwnerToken();
  return processOwnerToken;
}

/** SQLite writes UTC timestamps without a zone marker; parse them as UTC. */
function parseSqliteUtc(value: string | null): number {
  if (!value) return 0;
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

/** True when `lease` is free or its heartbeat has lapsed. */
export function isLeaseExpired(lease: EngineLease | null): boolean {
  if (!lease || !lease.owner) return true;
  const expires = parseSqliteUtc(lease.expiresAt);
  if (!expires) return true;
  return expires <= Date.now();
}

function mapLeaseRow(row: any): EngineLease | null {
  if (!row) return null;
  return {
    owner: row.owner ?? null,
    fencing: Number(row.fencing) || 0,
    pid: row.pid == null ? null : Number(row.pid),
    host: row.host ?? null,
    acquiredAt: row.acquired_at ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

/** Read the lease row without changing it. */
export function readEngineLease(): EngineLease | null {
  return mapLeaseRow(
    db
      .query("SELECT owner, fencing, pid, host, acquired_at, heartbeat_at, expires_at FROM engine_lease WHERE id = 1")
      .get(),
  );
}

/** True when an unexpired lease is held by some owner (possibly this process). */
export function hasLiveLeaseOwner(): boolean {
  return !isLeaseExpired(readEngineLease());
}

/** True when THIS process holds the unexpired lease. */
export function holdsEngineLease(): boolean {
  const lease = readEngineLease();
  return !!currentLease && !!lease && lease.owner === currentLease.owner && !isLeaseExpired(lease);
}

/** The fencing generation of this process's lease, or null when it holds none. */
export function engineFencing(): number | null {
  return currentLease?.fencing ?? null;
}

/**
 * Take (or renew) the engine lease in one short immediate transaction.
 *
 * Returns `acquired: false` when another LIVE owner holds it — the caller must
 * then refuse to start, because every startup sweep (crash reconciliation,
 * missing-file re-queue, stale-claim reaping) mutates job rows another engine
 * may be working on. An expired lease is taken over with `fencing + 1`: the
 * previous owner is presumed dead and the fencing number records the new
 * generation.
 */
export function acquireEngineLease(opts: { ttlMs?: number } = {}): LeaseAcquireResult {
  const ttlSeconds = Math.max(1, Math.round((opts.ttlMs ?? engineLeaseTtlMs()) / 1000));
  const owner = engineLeaseOwner();
  const attempt = db.transaction(() => {
    const existing = readEngineLease();
    // Re-acquiring our own lease is a renewal (fencing stays put).
    if (existing && existing.owner === owner) {
      const renewed = renewEngineLease(ttlSeconds * 1000);
      return { acquired: renewed, lease: readEngineLease(), tookOver: false };
    }
    // A live owner that is not us: refuse without writing anything. "Live"
    // means the lease has not expired AND (when we can tell) its process still
    // exists — a hard-killed engine's lease must not block its own restart.
    const ownerGone = leaseOwnerIsDead(existing);
    if (existing && !isLeaseExpired(existing) && !ownerGone) {
      return { acquired: false, lease: existing, tookOver: false };
    }
    const tookOver = !!existing?.owner;
    // The WHERE clause on DO UPDATE is the atomic "only if still expired"
    // guard: if another process slipped in between the read above and here,
    // the update is skipped and nothing is returned.
    const row = db
      .query(
        `INSERT INTO engine_lease (id, owner, fencing, pid, host, acquired_at, heartbeat_at, expires_at)
         VALUES (1, ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, datetime('now', ?))
         ON CONFLICT(id) DO UPDATE SET
           owner = excluded.owner,
           fencing = engine_lease.fencing + 1,
           pid = excluded.pid,
           host = excluded.host,
           acquired_at = CURRENT_TIMESTAMP,
           heartbeat_at = CURRENT_TIMESTAMP,
           expires_at = excluded.expires_at
         WHERE engine_lease.owner IS NULL
            OR engine_lease.expires_at IS NULL
            OR engine_lease.expires_at <= datetime('now')
            -- The previous owner's process is provably gone (hard kill): take
            -- the lease over immediately instead of waiting for the expiry.
            OR (engine_lease.owner IS ? AND ? = 1)
         RETURNING owner, fencing, pid, host, acquired_at, heartbeat_at, expires_at`,
      )
      .get(owner, process.pid, currentHost(), `+${ttlSeconds} seconds`, existing?.owner ?? null, ownerGone ? 1 : 0);
    if (!row) return { acquired: false, lease: readEngineLease(), tookOver: false };
    return { acquired: true, lease: mapLeaseRow(row), tookOver };
  });
  const result = attempt.immediate() as { acquired: boolean; lease: EngineLease | null; tookOver: boolean };

  if (result.acquired && result.lease) {
    currentLease = { owner: result.lease.owner!, fencing: result.lease.fencing };
  } else {
    currentLease = null;
  }
  return { ...result, acquired: result.acquired };
}

/**
 * Extend our lease. Returns false when we are no longer the owner — the caller
 * must then stop behaving like the owner (the heartbeat path pauses the engine).
 */
export function renewEngineLease(ttlMs: number = engineLeaseTtlMs()): boolean {
  const owner = currentLease?.owner ?? engineLeaseOwner();
  const ttlSeconds = Math.max(1, Math.round(ttlMs / 1000));
  const changes = db.run(
    `UPDATE engine_lease
        SET heartbeat_at = CURRENT_TIMESTAMP, expires_at = datetime('now', ?)
      WHERE id = 1 AND owner = ?`,
    [`+${ttlSeconds} seconds`, owner],
  ).changes;
  if (changes === 1 && !currentLease) currentLease = { owner, fencing: readEngineLease()?.fencing ?? 0 };
  return changes === 1;
}

/**
 * Give the lease up on graceful shutdown. The row is kept (owner NULL, expired
 * immediately) so the fencing counter survives across processes; a hard kill
 * needs no release at all — expiry does the same job.
 */
export function releaseEngineLease(): boolean {
  const owner = currentLease?.owner ?? engineLeaseOwner();
  const changes = db.run(
    `UPDATE engine_lease
        SET owner = NULL, heartbeat_at = CURRENT_TIMESTAMP, expires_at = datetime('now')
      WHERE id = 1 AND owner = ?`,
    [owner],
  ).changes;
  currentLease = null;
  return changes === 1;
}

/**
 * Keep the lease renewed for the life of the process.
 *
 * A renewal failure means another engine took over (our event loop was blocked
 * long enough for the lease to expire, e.g. a suspended laptop). Retrying is
 * not a fix: two engines now believe they own the archive. The callback is
 * invoked after the second consecutive miss — the engine pauses and stops
 * claiming work, while every in-flight write is already fenced by its claim
 * token.
 */
export function startEngineLeaseHeartbeat(opts: { renewMs?: number; onLost?: () => void } = {}): () => void {
  const renewMs = Math.max(250, opts.renewMs ?? ENGINE_LEASE_RENEW_MS);
  let missed = 0;
  const timer = setInterval(() => {
    try {
      if (renewEngineLease()) {
        missed = 0;
        return;
      }
      missed++;
      logError("lease", `engine lease renewal failed (miss ${missed}) — another engine may have taken over`);
      if (missed === 2) opts.onLost?.();
    } catch (e: any) {
      logError("lease", String(e?.message || e));
    }
  }, renewMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/** One-line lease description for operator messages and logs. */
export function describeEngineLease(lease: EngineLease | null): string {
  if (!lease) return "no lease row";
  if (!lease.owner) return `free (fencing ${lease.fencing})`;
  const state = isLeaseExpired(lease) || leaseOwnerIsDead(lease) ? "expired" : "live";
  return `owner ${lease.owner}, fencing ${lease.fencing}, expires ${lease.expiresAt} (${state})`;
}
