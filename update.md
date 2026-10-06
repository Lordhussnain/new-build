# Improvement Plan — YT Playlist Downloader

Audit date: 2026-10-02 · branch `arena/01a0f7b3-youtube-playlist-downloader-qw` @ `3d2149e`

Scope: 25 modules in `src/` (~5,190 lines), 20 test files (279 tests), `web_ui.html`
(1,869 lines), `update_config.ts` (506 lines).

**Verification gate:** `bun run check` (strict typecheck + all 279 tests, ~130s) after
every phase. Establish the baseline before touching anything.

**Sequencing:** P0 unblocks P1 · P1 is the correctness core that P2's tests target ·
P5 last.

**Decisions taken:** untrack committed secrets going forward (no history rewrite) ·
leave `webToken`'s empty default as-is (document it instead) · verify with the full
`bun run check`.

---

## Phase 0 — Repo hygiene

| # | Task | Action |
| - | --- | --- |
| 0.1 | Untrack the cookie jar | `git rm --cached cookies.txt`; add `cookies.txt`, `*.mp4`, `test_*.mp4`, `*.aria2`, `/get`, `/get.1` to `.gitignore` |
| 0.2 | Untrack `node_modules` | `git rm -r --cached node_modules` (841 files tracked despite `.gitignore:3`); delete the stale `package-lock.json` (`bun.lock` is authoritative) |
| 0.3 | Untrack test media | `git rm --cached test_out.mp4 test_multiaudio.mp4` (96 MB); keep `test_map.mp4` deleted |
| 0.4 | Add `LICENSE` | README promises MIT but no file exists |
| 0.5 | Fix README drift | Fictional config shape (L74-85), broken sentence (L162), table bleed (L243), nonexistent `--config`/`--format` flags (L250-256) |
| 0.6 | Document the new WIP keys | `targetFormat` / `subtitleFormat` appear in no doc |
| 0.7 | Document the auth posture | An empty `webToken` means a fully open API; `webBind: "0.0.0.0"` widens that to the network |
| 0.8 | Update AGENTS.md | `.gitignore` section, hygiene gotchas |

**Follow-up for you:** the committed `cookies.txt` is a live 64 KB Netscape cookie jar
and stays readable in history. Sign out of Google/YouTube in that browser profile.

---

## Phase 1 — Correctness fixes

Six verified bugs. Each is a small diff with a concrete failure mode.

### 1.1 Stale-claim timeout does not follow long download watchdogs — RESOLVED

The original audit description that `download_claimed_at` was never refreshed did not
match this checkout: `updateJobProgress` already heartbeats it in the existing
500 ms-throttled progress `UPDATE`, and `reapStaleClaims` already excludes jobs owned by
live download workers. Those protections prevent an active in-process transfer from
being re-queued while yt-dlp writes.

The remaining gap was the fixed `-20 minutes` stale threshold, which was shorter than
the configured download watchdog (180 minutes by default). The reaper now takes the
current `Config` and uses `-${Math.max(20, config.maxDownloadMinutes)} minutes`; the
shared `STALE_CLAIM_THRESHOLDS(config)` function keeps the dashboard and config manager
in sync. Progress heartbeats and the live-worker exclusion remain in place.

**Tests** (`tests/db.test.ts`, `tests/settings.test.ts`): verify that a claim within a
configured 60-minute window survives, a claim beyond it is reclaimed, the 20-minute
minimum is retained for smaller configured timeouts, and the dashboard reports the same
window.

### 1.2 Job mutation routes bypass active-stage exclusions — RESOLVED

Retry, single/bulk delete, queue purge, and per-job bulk pause previously mutated rows
without checking whether a download, conversion, or metadata worker still owned the
media/sidecars. In particular, retry cleared stage claims and purge could delete paused
rows that still held a download claim.

These routes now use `withIdleJobs()` and an immediate SQLite transaction to reject
active downloads, conversions, metadata work, and lingering download/conversion claims
with HTTP 409 `{ ok: false, error: "Job is currently in progress" }` before changing files or rows.
Bulk operations are all-or-nothing; purge also explicitly deletes only rows with
`download_claimed_by IS NULL` and no active side-stage claim. Both retry route aliases
share the same guard. Startup reconciliation clears orphaned claims from legacy
user-paused rows without changing their held status.

**Tests** (`tests/web-routes.test.ts`, `tests/db.test.ts`): active conversion retry leaves
its archive/file untouched; single delete, mixed bulk delete, bulk pause, and purge
return 409 without mutating active or idle rows. Startup recovery releases an orphaned
user-pause claim while preserving the user pause.

### 1.3 `runDownload` can leave a live downloader on an unexpected failure — RESOLVED

The initial report overstated two paths in this checkout: the output-drain
`Promise.all` already had a `finally`, so an asynchronous `updateJobProgress` throw
rejected the stdout-reader promise and reached cleanup; `existsSync` ran only after
`proc.exited` had completed. However, setup between `Bun.spawn()` and that `try` was
not protected, and cleanup only aborted the signal then waited indefinitely if the
child did not exit.

All post-spawn setup and output handling now share one `try/finally`. The cleanup
clears the watchdog, sends SIGINT so yt-dlp can stop aria2c cleanly, escalates to
SIGKILL after a bounded grace period, awaits `proc.exited`, and removes `activeProcs`
in a nested `finally`. Thus an output/progress callback error cannot release the job
for retry while its downloader is still writing.

**Test** (`tests/download-process.test.ts`): a simulated `SQLITE_BUSY` from the
progress callback rejects the output-drain promise; the regression asserts that cleanup
reaps the child and clears its active-process tracking entry.

### 1.4 The `yt-dlp -U` self-heal can wedge the pool

`src/workers/download.ts:237`: spawned with piped stdout/stderr, **no `AbortController`,
and neither pipe is ever read**. Past the pipe buffer it blocks forever, holding the job
claim with nothing able to kill it.

**Fix:** `AbortController` + 120 s timeout, drain both pipes, register in `activeProcs`
under a reserved key so `killActiveChildren()` reaches it.

### 1.5 Per-job user pause is silently discarded

`web.ts:468` sets `download_status='paused', pause_reason='user'`, but
`handleDownloadFailure` checks only the **global** `isPaused()` (`download.ts:223`) — a
paused job that errors falls into the transient branch and is written back to `pending`;
one that succeeds goes to `downloaded` via `recordSuccess`.

**Fix:** `recordSuccess` and `handleDownloadFailure` (and the converter) honour
`job.pause_reason === 'user'` by parking instead of advancing. Same for
`metadata.ts:115` writing `done` unconditionally after a re-queue.

### 1.6 Silent swallows that hide real failures

| Location | Problem |
| --- | --- |
| `resilience.ts:30-38` | Resume All reports success when the re-queue threw → `logError` |
| `reconcile.ts:554` | An entire sweep fails invisibly → `logError` + surface `sweeps[].error` in `/api/reliability` |
| `convert.ts:177-178` | A failed sidecar copy on the NAS move drops the copy **and** leaves the original → log, and never unlink when the copy failed |
| `lifecycle.ts:61` | The outer `catch {}` around the shutdown persist → `logError` |
| `polling.ts:16` | No in-flight latch (unlike `rss.ts:91`) → add one; and re-read `getConfig()` each tick (gotcha 16) so `rescanIntervalHours` changes apply |

---

## Phase 2 — Performance

Pays off at 10k+ jobs / large archives. Ordered by impact.

### 2.1 `removeFromArchive` rewrites the whole archive per missing row — HIGH

`src/archive.ts:13` does a full `readFileSync` + filter + `writeFileSync` of
`downloaded_videos.txt`. `reconcileMissingFiles` calls it **inside a loop**
(`src/reconcile.ts:131`). 100 missing files on a 500k-line archive ≈ 100 × 20 MB of
synchronous I/O on the startup path.

**Fix:** batch the API — `removeFromArchive(archiveFile, ids: string[])` doing one
read/filter/write, plus `scrubMissingFiles()`. `reconcileMissingFiles` collects every
missing id first, scrubs once, then updates rows.

### 2.2 `existsSync` on every stdout line in the progress loop

`src/workers/download.ts:155-163`: a synchronous `stat` per non-`PROGRESS:` line. On a DASH
stream that is hundreds per video, each blocking the event loop that also serves
`/api/status` and drains stderr.

**Fix:** collect candidate paths into an array and `stat` once after the loop
(`:180-193` already has that fallback). Also hoist `new TextDecoder()` out of the loop
(`:129`) and bound `buffer` growth (`:121`).

### 2.3 Full-table aggregates on every poll

Eight `SUM(CASE …) FROM jobs` scans ×2 per `/api/status` poll (`web.ts:271,313`,
`dashboard.ts:64-77`), plus 7 more queries in `reliabilityHandler` (`web.ts:687-742`) of
which one is an unbounded `.all()`.

**Fix:** new `src/stats.ts` — one snapshot function with a 1 s TTL shared by
`/api/status`, `/api/reliability`, and the TUI, invalidated on state transitions.

### 2.4 `cleanOrphanedFiles` materialises the whole archive tree

`src/reconcile.ts:510` — `readdir(recursive)` loads every path, then makes two full
`stat()` passes. Multi-minute stall with a large resident set before the dashboard starts.

**Fix:** walk lazily; filter on the `.part`/`.aria2` suffix **before** statting; drop the
second pass.

### 2.5 Unbatched sweep transactions

`requeueFailedJobs` (`src/reconcile.ts:241-283`) runs N implicit transactions every 60 s
against a 5 s busy timeout, while its neighbours (`db.ts:159`, `scanner.ts:98`) do batch
correctly. Wrap the loops in one `db.transaction`; same for `reconcileMissingFiles`.

### 2.6 N+1 ingestion

`src/scanner.ts:104-146`: 3 statements per item (`isVideoInDb` SELECT, `getNextIndex`
SELECT + upsert) inside one long-held write transaction — 6,000 statements for a
2,000-video playlist, blocking every other writer.

**Fix:** prefetch the existing-id `Set` and the `next_index` high-water mark once, then
insert only new items.

### 2.7 Missing index + unbounded table

`partial_file_path IS NOT NULL` (`reconcile.ts:501`, `web.ts:690,715`) is unindexed and
runs on every sweep *and* every reliability poll → full scan. Add the index via the
existing migration path. Prune `run_history` (nothing ever deletes from it).

---

## Phase 3 — Hardening

Small, cheap, one-liner-ish each.

| # | Fix |
| --- | --- |
| 3.1 | Clamp `limit`: `/api/history` (`web.ts:609,619` — `limit=-1` ⇒ **no limit**, `?limit=abc` ⇒ `NaN` bound) and `/api/logs` (`:625`). `Math.min(1000, Math.max(1, n \|\| 20))` |
| 3.2 | `/api/scan` (`web.ts:509`): require `http(s)://`, reject `file://` / localhost / private ranges; validate `folder` is a string (`:522` returns 500 today) |
| 3.3 | `decodeURIComponent` throws in `matchRoute` (`web.ts:185`) and the cookie parse (`:41`) ⇒ `/api/jobs/%` is a **500** instead of a 404/401. Catch → 404/401 |
| 3.4 | `scanner.ts:48`: a title containing `\|\|\|` shifts every field and **corrupts the primary key** into a permanently-failing job. Split with a field-count check and validate `id` against `/^[\w-]{6,}$/` before insert; skip + log otherwise |
| 3.5 | Cap sanitized folder/title length — `scanner.ts:86` `mkdir` throws `ENAMETOOLONG`, which aborts the **whole** ingest, not one item |
| 3.6 | `timeoutMs` + `signal` on the 6 remaining untimed `Bun.spawn` sites (`web.ts:433,514`, `scanner.ts:52`, `audio-tracks.ts:184`, `tools.ts:98,112`) — bounds both the DoS surface and the hung-request case |
| 3.7 | `logger.ts:25`: collapse `\n`, strip control chars, redact `--cookies <path>` and token patterns. Multi-line `err.stack` currently corrupts rotation's 400-line accounting and permits fake `[scope]` injection via a crafted title |
| 3.8 | `timingSafeEq` (`web.ts:45`): compare `sha256` digests so the early length return (which leaks the token's exact length) disappears |
| 3.9 | Response headers: CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, and `Cache-Control: no-store` on the `?token=` page (`:129` sets it only on the 401) |
| 3.10 | `update_config.ts:485` — mask `webToken` in `viewConfig` (the prompt at `:336` already does). `update_config.ts:151` — `readResumeState` opens `config.archiveFile` (`downloaded_videos.txt`, a text file) as SQLite; it should open `archive.db`. **This is dead code today** — the manager always prints "(No archive database yet)" |
| 3.11 | Thread the existing `abortController.signal` into all 10 intervals (`engine.ts:96,97,138,140,142,144,162`, `rss.ts:108,109`, `polling.ts:16`, `lifecycle.ts:77`) and clear them on shutdown, so shutdown works without `process.exit` |
| 3.12 | Await/`.catch` the floating `handleShutdown` (`engine.ts:39`) and `networkMonitor` (`:137`) |
| 3.13 | Guard the awaits that sit **outside** the worker try-blocks (`download.ts:53,60`, `convert.ts:72`, `metadata.ts:31`) — all four can throw `SQLITE_BUSY` and kill the loop without releasing the claim |

---

## Phase 4 — Tests + CI

### 4.1 Refactor for testability (unblocks 1.1 / 1.5)

Extract `decideFailureOutcome(ctx)` out of the 142-line `handleDownloadFailure`
(`src/workers/download.ts:222-363`) into a pure function in `src/retry.ts`:

- **input:** `{ error, isPaused, pauseReason, retryCount, maxRetry, resumeCount,
  maxResume, progress, bestProgress, videoLive }`
- **output:** `{ status, pauseReason?, retryDelta?, resumeDelta?, discardPartial?,
  scrubArchive?, tripBreaker? }`

One table test then covers all seven classes in precedence order (signature →
downloader-args → corrupt → archive-scrub → live → transient → permanent/budget).
`workers/download.ts` drops to a thin applier. **AGENTS.md §6 and §11 document this
function by name and must be updated in the same commit.**

### 4.2 Cover the 147 uncovered lines

`lifecycle.ts` (`supervise` restart-on-crash, shutdown ordering, WAL checkpoint),
`history.ts` (heartbeat upsert + prune), `polling.ts` (in-flight latch, config re-read).

### 4.3 Test the untested in-flight WIP

`targetFormat`, `subtitleFormat` and `--convert-subs` (`metadata.ts:74`) have **zero**
coverage. Add: the `mkv`/`webm`/`m4a` remux branches, `findConvertedOutput`'s new
extensions (`convert.test.ts` covers only mp3/mp4/mkv), multi-audio + mkv interaction, and
an `srt` conversion assertion in the mock yt-dlp.

### 4.4 `web.ts`

`reliabilityHandler` (123 lines) and the `/api/status` aggregate; the new 409s; the
`limit` clamps.

### 4.5 Integration scenarios for behaviours with none

Circuit breaker (`TOO_MANY_FAILURES`), network-monitor pause, low-disk pause
(`minFreeSpaceGB`), `daemonMode` + polling, secondary-storage NAS move, `verifyIntegrity`
SHA-256, shorts filtering.

### 4.6 `tools.ts`

The 13-function discovery layer (Windows winget/scoop/choco search) is untested and easy
to regress — table-testable.

### 4.7 CI

`.github/workflows/ci.yml` — `bun install --frozen-lockfile` + `bun run check` on Windows
(the suite compiles its mocks per-platform) and Linux. This is what makes AGENTS.md §12's
definition of done real; `.github/` does not exist today.

### 4.8 Gate the UI + tighten the compiler

Add the `node --check` extraction from AGENTS.md §9.4 as `bun run check:ui`. Enable
`noUncheckedIndexedAccess` (currently `false`) — it will surface real gaps at
`scanner.ts:63`, `download.ts:135`, `settings.ts:281`.

---

## Phase 5 — Features

Ordered by value-per-line — the data model already supports most of these.

| # | Feature | Why it's cheap |
| --- | --- | --- |
| 5.1 | **Per-job format / quality / subtitle override** in the dashboard, plus "retry with override" | `jobs.target_format` is already a per-row column (`scanner.ts:134`); an override is one `UPDATE` + re-queue. Closes README roadmap item |
| 5.2 | **Content-hash dedupe across playlists** | `jobs.integrity` already stores SHA-256. On ingest, a matching hash links/skips instead of re-downloading. Closes roadmap item |
| 5.3 | **Discord / generic webhook notifications** on completion and failure batches | New `webhookUrl` + `notifyOn` keys (schema, defaults, `update_config.ts` prompt, `config.test.ts`); emits from `notePipelineFailure` / `notePipelineSuccess`. Closes roadmap item |
| 5.4 | **Search / filter / sort + virtualisation** on the 500-row job list, keyboard nav | `web_ui.html` only |
| 5.5 | **Retention policies**: prune `run_history`, orphan sidecars, old converted files by age | Reuses the `cleanOrphanedFiles` walk after 2.4 |
| 5.6 | **Download scheduling windows** (pause outside work hours) | New `schedule` key; reuses `triggerPause` / `triggerResume` |
| 5.7 | **Chapters + auto-transcript sidecars**, embedded cover art | `metadata.ts` flag additions; yt-dlp `--embed-chapters` / `--embed-thumbnail` |

---

## Suggested commit boundaries

`0.x` hygiene/docs → `1.1` reaper → `1.2` route 409s → `1.3` child leak → `1.4` `-U`
timeout → `1.5` user pause → `1.6` logging → `2.x` perf (one commit each) → `3.x`
hardening → `4.1` failure-policy refactor → `4.2`-`4.8` tests/CI → `5.1`-`5.7` features.

---

## Open decisions flagged during planning

1. **1.1's claim heartbeat** adds a column write to the 500 ms progress throttle. It
   rides along in the same `UPDATE` (no extra round-trip), but if you would rather not
   touch the hot path, the config-derived threshold alone still fixes the steal.
2. **4.1** moves ~140 lines out of `workers/download.ts`, which AGENTS.md §6 and §11
   document by name — both need updating in the same commit.

---

## Appendix — clean categories (verified, no action needed)

Worth recording so they are not re-litigated:

- **SQL parameterisation** — every interpolated fragment is a module literal or a
  validated config integer (`reconcile.ts:78,231`, `web.ts:246`). No injection path.
- **Route auth coverage** — all 24 `ROUTES` entries dispatch from `handleApi`, behind the
  `isAuthorized` gate at `web.ts:141`.
- **Path traversal** — `sanitizeFolderName` strips `/` and `\`, so a `..` segment cannot
  form; filenames go through `sanitizeFileName` → `fitBaseFilename`.
- **Settings validation** — `applySettings` rejects unknown keys and out-of-range values,
  re-validates the whole merged config through `ConfigSchema.parse`, and mutates nothing
  on rejection.
- **Type escapes** — zero `as unknown as`, zero `@ts-ignore`. The 23 `as any` are almost
  all `db.query(...).get()/.all()` results, which a shared `JobRow` helper would clean up.