# AGENTS.md

Operator manual for coding agents working on **YT Playlist Downloader** — a
batch YouTube playlist/channel archival engine built on Bun + TypeScript.

Everything an agent needs to navigate, modify, and safely test this codebase is
below. Read sections 1–4 before making changes; section 10 (Gotchas) before
touching the database, workers, or config.

---

## 1. What this software is

A long-running **archival engine**: you give it YouTube playlist/channel URLs,
it downloads every video, fetches sidecar metadata (subtitles, thumbnails,
descriptions, info.json), converts to a target container, and keeps going
forever — watching RSS feeds for new uploads and rescanning on a schedule.

It is designed to survive **crashes, hard kills, network drops, full disks, and
files deleted behind its back**. Every state transition is persisted in SQLite,
so a restart continues where the last run stopped rather than starting over.
That principle — *never throw away work that has already been done* — is the
single most important thing to understand before changing failure-handling code.

| Layer | Technology |
| --- | --- |
| Runtime | Bun ≥ 1.0 (uses `bun:sqlite`, `Bun.spawn`, `Bun.serve`) |
| Language | TypeScript, ESM, strict mode |
| Job store | SQLite (`archive.db`, WAL mode) |
| Media tools | `yt-dlp` (extraction), `ffmpeg` (transcode/remux) |
| Frontend | Single-file vanilla-JS dashboard (`web_ui.html`) |
| Config | Zod-validated `config.json` |

---

## 2. Quick start

```bash
bun install            # zod (+ dev: typescript, @types/bun)
# Alternative reproducible dependency install when using npm:
npm ci                  # installs from package-lock.json; Bun is still the runtime
bun run start          # run the engine (reads ./config.json, creates it if absent)
bun run config         # interactive config manager (TTY)
bun run typecheck      # tsc --noEmit
bun test               # full suite: unit + end-to-end (mocked tools; no network needed)
bun run check          # typecheck + tests
bun run build:win      # cross-compile dist/youtube-archive.exe (Windows)
                         start-archive.bat runs it from dist\ first, then the
                         app folder, then falls back to `bun run`
```

Runtime requirements: `yt-dlp` and `ffmpeg` on `PATH` (or `ytDlpPath` /
`ffmpegPath` in config). `checkDependencies()` probes them **before** the
database opens and exits with install hints if missing. YouTube's n-challenge
also needs a JS runtime (Deno recommended, then Node, then Bun); a missing
runtime is a warning, not a startup failure, and n-challenge errors are
retryable rather than permanent.

**Sandbox note:** YouTube is unreachable from this environment. The test suite
therefore runs the real engine against mock binaries (`tests/mocks/`) — see
section 9. Do not "fix" failing integration tests by adding network calls.
**Windows note:** the mocks are shebang scripts, and Windows neither reads
shebangs nor spawns extensionless files, so the integration harness compiles
them into real executables with `bun build --compile` (cached per run, a few
seconds once) and pins every tool path in the engine's config to the mocks —
bare-name PATH discovery could otherwise pick up real yt-dlp/ffmpeg/aria2c
installed on the machine. Three more Windows facts the code already accounts for:
some Bun builds for Windows do not implement `statfs` at all (see gotcha 22 —
go through `diskUsage()`), and Windows does not reparent orphans, so the mocks'
`process.ppid` watchdogs are inert there (see 9.3). A third one matters for the
unit tests: a bare executable name is resolved by the OS through the *invoking*
process's PATH, so spawning `["aria2c"]` with an injected `env` that has no PATH
still finds an installed aria2c. `resolveTool` therefore treats an injected
`ToolSearchEnv.env` as the whole search space and skips the bare-name candidates
when it carries no PATH — that is what makes "nothing is installed" testable on
Windows (`tests/tools.test.ts`), instead of passing only on a machine that
happens not to have the binary.

### Local data, secrets, and generated files

Runtime files are operator data, not source. Never stage or commit `config.json`
(it can contain private source URLs and `webToken`), `cookies.txt` (account
credentials), `archive.db` and its `-wal`/`-shm` files, `downloaded_videos.txt`,
error/report logs, downloaded media, `.part`/`.aria2` partials, `dist/`, or
`node_modules/`. Tests should use temporary working directories and the checked-in
mock fixtures. When adding new runtime outputs, add appropriate `.gitignore`
rules without hiding source or test fixtures; inspect `git status --short` before
finishing a change.

---

## 3. Architecture

```
batch_playlist_downloader.ts   entry point → src/engine.ts main()
update_config.ts               config manager → imports src/config.ts (shared schema)
web_ui.html                    dashboard frontend, served by src/web.ts
config.json                    user config (created from defaults on first run)
archive.db                     SQLite job store (+ -wal/-shm while running)
error.log                      rotating error log
src/
  config.ts      Zod schema, DEFAULT_CONFIG, load/loadSafe/save (atomic), live-write lock, QUALITY_FORMATS
  db.ts          SQLite schema, migrations, atomic claim transactions, claim leases (token/heartbeat/CAS), helpers
  lease.ts       database-level engine lease (owner token, expiry, monotonic fencing) — one engine per archive.db
  state.ts       shared mutable runtime state (leaf module — imports nothing)
  tools.ts       yt-dlp/ffmpeg/aria2c/JS-runtime discovery, cookiesArgs, jsRuntimeArgs, validateCookies
  download-args.ts PURE yt-dlp command construction (downloader engine, tuning)
  download-output.ts bounded pipe decoding + validated FILEPATH records (no fs calls)
  audio-tracks.ts PURE multi-audio track parsing/selection + the yt-dlp -J probe
  settings.ts    dashboard-editable config allow-list + validate/persist/apply
  retry.ts       PURE retry policy: backoff, watchdog, error classification
  resilience.ts  pause/resume, circuit breaker, network + disk guards (diskUsage = the only statfs caller)
  reconcile.ts   self-healing sweeps (crashes, stale claims, missing files, failed jobs) + partial-file housekeeping
  relocate.ts    secondary-storage relocation pass (finished files that need no conversion still move)
  sources.ts     Web UI URL validation/canonicalization + durable source-list additions
  scanner.ts     playlist/channel listing + deduplicated ingestion
  autoscale.ts   dynamic download-slot management
  workers/
    download.ts  yt-dlp download loop + all failure classification
    metadata.ts  sidecar fetching loop
    convert.ts   ffmpeg transcode/remux + secondary-storage move loop
  rss.ts         cheap per-channel RSS watcher (parseRssFeed is pure)
  polling.ts     daemon-mode full rescans
  dashboard.ts   TUI rendering
  report.ts      human-readable run report
  web.ts         Bun.serve dashboard + JSON API (route table) + token auth
  history.ts     heartbeated run_history rows
  lifecycle.ts   worker supervision + graceful shutdown
  engine.ts      orchestration (main): wires everything together
tests/           bun test suite (see section 9)
```

### Import graph (acyclic — keep it that way)

```
state.ts → config defaults/types ──────────────┐ (shared runtime-state leaf)
config.ts, util.ts, logger.ts, retry.ts,
archive.ts, tools.ts, download-output.ts         │ (leaf modules, zero deps)
audio-tracks.ts → config (types), tools          │ (pure parsing/selection + -J probe)
db.ts → config                                  │
lease.ts → db, logger                           │ (the engine lease; db must never import it)
resilience.ts → config, db, logger, state       │
reconcile.ts → archive, config, db, download-args, lease, logger, retry, state, tools│
relocate.ts → config, db, lease, logger, state, util, workers/convert    │ (relocation pass)
sources.ts → config, state                     │
scanner.ts → config, db, state, tools, util     │
autoscale.ts → db, state                        │
dashboard.ts → autoscale, config, db, state, util│
report.ts → autoscale, db, state, util          │
download-args.ts → audio-tracks, config, db (types), download-output, retry, tools, util    │ (pure)
web.ts → audio-tracks, autoscale, config, db, download-args, lease, logger, reconcile, report, resilience, retry, scanner, sources, state, tools, util
rss.ts → config, logger, scanner, state, tools   │
polling.ts → config, logger, scanner, state     │
history.ts → db, logger, state                  │
lifecycle.ts → dashboard, db, history, lease, logger, resilience, state
workers/* → config, dashboard, db, download-args, download-output, logger, resilience, retry, state, tools, util (+ autoscale/archive/reconcile; download.ts also audio-tracks)
engine.ts → everything (composition root)
```

**Rule:** if you need a new shared behavior, put it in a leaf module and inject
it. Workers must never import `engine.ts`, and `state.ts` must stay
dependency-free — it is the module that breaks every import cycle.

### Startup order (engine.ts `main()`)

1. `loadConfig()` → `setConfig()` (must be first: dependency search uses paths from it).
   `--offline` / `YTA_OFFLINE` override `offlineMode` in memory **here** (never
   written to config.json), so a one-off offline pass does not change the next
   normal start — and the dependency probe below sees it.
2. `checkDependencies()` — fails fast with install hints. In offline mode a
   missing yt-dlp is a note, not a failure (nothing spawns it); **ffmpeg stays
   required** — conversion is the point of an offline pass
3. `initDatabase("archive.db")` — schema + migrations + claim transactions
4. `acquireEngineLease()` — **before any sweep: the database-level single-instance
   lock**. A live owner (another process, whatever its web port) makes this
   process exit 1 without touching a job row; an expired lease — or one whose
   owning process is provably gone — is taken over with `fencing + 1`.
   `startEngineLeaseHeartbeat()` renews it for the rest of the run; a lost lease
   pauses the engine (`ENGINE_LEASE_LOST`).
5. `startWebServer()` — the HTTP lock, acquired second so a refused start never
   holds the port. A second instance (autostart task + a manual start) dies here
   with an actionable error instead of re-queueing a live instance's work.
6. `reconcileCrashedJobs()` → `reconcileSupersededFiles()` →
   `reconcileMissingFiles()` (the superseded sweep MUST run before the
   missing-file sweep: an interrupted `.superseded` stash looks like a deleted
   file to it, and the video would be re-queued over a backup that is sitting
   right there; the missing-file sweep itself skips jobs with a conversion in
   progress — the converter legitimately has those files in mid-transition
   under `deleteSourceAfterConvert`; every one of these sweeps refuses to run
   without the engine lease)
7. `startRunHistory()` + heartbeat interval
8. `mkdir(outputRoot)` → `cleanOrphanedFiles()` → `autoscaler.init()`
9. cookie validation (if enabled)
10. scan every configured playlist/channel into the jobs table (skipped in offline mode)
11. `initDashboard()`
12. `networkMonitor()` (off in offline mode), `reapStaleClaims` (60s, lease-gated),
    `autoscaleTick` (15s), `requeueFailedJobs` (60s), `cookiesWatch` (60s, off in
    offline mode), `startRssPolling()` (off in offline mode), `startRelocation()`
    (one pass +5s, then every 60s)
13. supervised worker pools (download × N, metadata × N, convert × N — the download
    and metadata loops stay idle in offline mode; workers are always started, so a
    live settings toggle takes effect without a restart)
14. `startAutonomousPolling()` if daemon mode (off in offline mode)

---

## 4. Data model

### The `jobs` table (one row per video, keyed by YouTube video id)

| Field | Meaning |
| --- | --- |
| `id` | YouTube video id (primary key → natural dedupe) |
| `url` | canonical `https://www.youtube.com/watch?v=<id>` |
| `title`, `folder`, `index` | display name, output folder, `001`-style ordering |
| `output_directory` | absolute-ish path where files land |
| `target_format` | `mp4` \| `mkv` \| `webm` \| `mp3` \| `m4a`; editable per job (NULL follows the live global format) |
| `video_quality` | nullable per-job override (`highest`, `4k`, `1440p`, `1080p`, `720p`, `480p`, `audio`); NULL follows global quality |
| `want_subtitles` / `want_thumbnail` / `want_description` | 0/1 sidecar flags |
| `duration` | seconds from the listing (drives the watchdog) |
| `download_status` | `pending` \| `downloading` \| `downloaded` \| `paused` \| `failed` \| `waiting_live` |
| `conversion_status` | `pending` \| `in_progress` \| `done` \| `failed` \| `not_needed` |
| `metadata_status` | `pending` \| `in_progress` \| `done` \| `failed` \| `not_needed` |
| `pause_reason` | `user` \| `interrupted` \| `waiting_live` \| NULL |
| `*_claimed_by` / `*_claimed_at` | worker id + timestamp of the atomic claim (display/diagnostics; ownership is the token) |
| `*_claim_token` | random UUID minted by the claim — the claim's real identity, since worker ids (`dl-1`) repeat across processes. Every progress/success/failure/release update is a CAS on it |
| `*_heartbeat_at` | last lease renewal for that stage's claim. Downloads renew it on every progress line and on a timer; conversion/metadata renew on an interval (`startClaimHeartbeat`, default 30 s, test override `YTA_CLAIM_HEARTBEAT_MS`). The reaper's staleness window is measured from `COALESCE(heartbeat, claimed_at)`, never from `updated_at` |
| `retry_count` | no-progress download failures in the current retry window |
| `conversion_retry_count`, `metadata_retry_count` | per-stage attempt budgets |
| `resume_count` | `--continue` resumes spent for this job |
| `best_progress` | high-water mark of progress % (drives budget forgiveness) |
| `partial_file_path` | the `.part` file to resume from (NULL once complete); always absolute, so it resolves from any cwd |
| `file_path`, `file_size`, `integrity` | final location + SHA-256 |
| `audio_tracks` | JSON array of discovered audio tracks (null = not probed yet) |
| `audio_selection` | JSON array of per-job language codes (null = follow the global multi-audio mode) |
| `superseded_file` | backup path of the previous media file while a deliberate re-download runs (see §7.2) |
| `relocated_to` | the secondary-storage ROOT this job's media was moved under (NULL = still in the output tree). A root, not a boolean, so pointing `secondaryStoragePath` somewhere new re-offers every file; written by `finalizeConversion` (conversion move), `relocateFinishedJobs` (relocation/adoption) and cleared by `recordSuccess` (a fresh download lands in the output tree) |
| `progress`, `speed`, `eta` | live values for the dashboard |
| `last_error` | last failure message (classified by `retry.ts`) |

Other tables: `playlist_state(folder, next_index)`,
`run_history(id, started_at, ended_at, duration_seconds, downloaded, skipped, failed, total_queued)`,
and `engine_lease` — the database-level single-instance row (`id = 1`):

| Field | Meaning |
| --- | --- |
| `owner` | random per-process token (`host:pid:random`), NULL when free/released |
| `fencing` | monotonic generation counter, incremented on every acquisition/takeover |
| `pid`, `host` | the owning process, so a restart can prove a crashed owner is gone and take over at once |
| `acquired_at` / `heartbeat_at` / `expires_at` | acquisition time, last renewal, and the expiry used by refusal/takeover |

Acquisition is one immediate transaction (`src/lease.ts`): it refuses a live
foreign owner without writing anything, and otherwise takes the row over with
`fencing + 1` (`INSERT … ON CONFLICT DO UPDATE … WHERE owner IS NULL OR
expires_at <= now OR the owner process is gone RETURNING …`). `owner` is
released on graceful shutdown (the row is kept, so fencing survives); a hard
kill is handled by the PID check or, failing that, the expiry.

### State machine

```
ingest ──► pending ──claim──► downloading ──success──► downloaded
              ▲                    │
              │                    ├─ transient ──► pending (keep .part, backoff)
              │                    ├─ corrupt ────► pending (resume_count++, .part kept)
              │                    ├─ resume refused (416 range / aria2c control file)
              │                    │                ► pending, .part + .aria2 DISCARDED (restart)
              │                    ├─ permanent ──► failed immediately (never auto-requeued)
              │                    ├─ live ───────► waiting_live (requeued by next scan)
              │                    └─ shutdown ───► paused + interrupted (auto-resume)
              └── sweep (cooldown) ── retryable failed → pending + fresh retry window

downloaded ──► metadata worker ──► metadata: pending → in_progress → done | failed
downloaded ──► convert worker ──► conversion: pending → in_progress → done | failed
                                      (skipped when conversion_status = 'not_needed')
```

**Claims are the concurrency primitive.** Each stage claims work with a single
atomic `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *` inside a
`db.transaction`. Two workers can never grab the same job. Never add a
read-then-write claim sequence.

**A claim is a lease, and the token is its identity.** The claim mints a random
`*_claim_token` (worker ids like `dl-1` repeat across processes and mean
nothing for ownership) and stamps `*_heartbeat_at`; the worker renews it while
the stage runs. Every later write — progress, success, failure, release — goes
through `updateClaimedJob` / `releaseClaimedJob` (`db.ts`), which append
`AND <stage>_claim_token IS ? AND <stage>_claimed_by IS ?` and return the
changed-row count:

- **1** → the update landed;
- **0** → the claim was reaped, released, or taken over — the worker must not
  change job state (it logs and walks away). Do not write a bare
  `UPDATE jobs … WHERE id = ?` in a worker for anything that depends on owning
  the job.

The reaper uses the same primitive, with the lease-expiry predicate as an extra
condition (`reapStaleClaim`), so it cannot reset a job whose claim was renewed
or already reclaimed by someone else. `ownsClaim` is the read-only form, used
before destructive filesystem steps (the converter's source delete, the
secondary-storage move, the `.superseded` restore).

Conversion claims additionally require `metadata_status IN ('done','not_needed','failed')`
— the converter waits for metadata to be *terminal*, not necessarily successful.

---

## 5. The worker loops

All three workers follow the same shape:

```ts
while (!abortController.signal.aborted) {
  if (isPaused()) { await Bun.sleep(2000); continue; }
  const job = claimXJob(workerId);
  if (!job) { await Bun.sleep(pollMs); continue; }
  try { await doWork(job, config); }
  catch (err) { await handleFailure(job, config, err); }
  finally { /* cleanup: unregister proc, autoscaler speed */ }
}
```

- **downloadWorker** — gates on `activeDlSlots.has(id)` (autoscaling) and
  `checkDiskSpace()` before claiming. Spawns yt-dlp with `--continue`,
  `--no-overwrites`, `--download-archive`, parses `PROGRESS:` lines from the
  progress template into the DB, and captures the final path from
  `--print after_move:FILEPATH:%(filepath)s` (validated before any filesystem call).
- **metadataWorker** — second yt-dlp pass with `--skip-download`, writes
  sidecars next to the media file using the same basename, records the file
  list in `metadata_files`.
- **converterWorker** — ffmpeg mp3 transcode or mp4 remux (`-c:v copy`), then
  optionally moves the media file **and its sidecars** to
  `secondaryStoragePath/<folder>/`, then hashes it.

Workers are supervised (`lifecycle.ts supervise()`): a crashed loop is logged
and restarted after 5s. Never let a worker loop exit on error.

**The three claims are mutually exclusive on the stage that owns the media
file** (`db.ts`, gotcha 24). A download is never claimed while
`conversion_status` or `metadata_status` is `in_progress`, and metadata is
never claimed while `conversion_status` is `in_progress`. All three pools share
one job row and one file on disk, so without those exclusions a re-queued
download starts yt-dlp writing to the very path the converter is reading — the
"file deleted before conversion finished" race. `conversion_status = 'done'`
stays claimable by the metadata worker on purpose: `requeueFailedJobs()`
re-queues a failed sidecar pass on an already-converted job.

---

## 6. Reliability policies — where each lives

| Policy | Location | Notes |
| --- | --- | --- |
| Exponential backoff + jitter | `retry.ts computeBackoffMs()` | base × 2^attempt, capped, +0–30% jitter; RNG injectable for tests |
| Download watchdog | `retry.ts computeDownloadTimeoutMs()` | 3× duration + 5 min, clamped to config min/max; unknown duration → min |
| Transient vs permanent errors | `retry.ts isTransientDownloadError / isPermanentDownloadError` | permanent = private/removed/unavailable/members-only/age-gated/paid/geo-blocked/404/410/copyright. The classifier also *labels* the reason (`classifyTerminalDownloadError` → `Private video`, `Video unavailable`, `Not available in your region`, …) for the dashboard, `last_error`, `/api/failed` and the run report |
| Terminal skips stay skipped | `retry.ts TERMINAL_ERROR_MARKER` + `workers/download.ts parkTerminal()` | A permanent failure is written as `[terminal] <label> — skipped, it will not be retried automatically. yt-dlp: <tail>`, so the reason survives a truncated tail and every requeue path (`requeueFailedJobs`, `POST /api/failed/requeue`, `/api/reliability`'s `resumableFailed`, the orphan-partial sweep) reads the same predicate. The raw tail is kept for diagnosis; the skip writes **no** `error.log` line and spends no retry budget (a playlist full of dead videos must not trip the circuit breaker). Only an unclassified permanent message still logs |
| Format fallback ladder | `retry.ts nextFormatFallback()` + `workers/download.ts` format branch | `Requested format is not available` → clear a stale pinned audio probe if there is one, else persist the next lower `video_quality` override (`4k → 1440p → 1080p → 720p → 480p → highest`) and retry immediately with a readable message. The ladder is **monotonic**, so it cannot loop and needs no retry budget; `highest` is `bv+ba/b` (any stream), so failing there is a genuine terminal `No format available` skip. `audio` never falls back to a video preset |
| Bad downloader arguments | `retry.ts isDownloaderArgsError` → pause in `workers/download.ts` | aria2c exit 28 + option help block; parks the job, pauses the engine (`BAD_DOWNLOADER_ARGS`) |
| Retry-budget forgiveness | `workers/download.ts handleDownloadFailure()` + `retry.ts progressAwareRetryState()` | `retry_count` only increments when `progress <= best_progress`; `best_progress` is committed at a failure boundary, not every progress update |
| Resume budget | `workers/download.ts` corrupt branch | `.part` kept until `resume_count >= maxResumeAttempts`, then discarded |
| Unrecoverable resume (HTTP 416) | `retry.ts isUnrecoverableResumeError` → `workers/download.ts` | `--continue` asks the CDN for a range the remote stream no longer has — the "stuck at 99.0%" loop. Resuming can never finish, so the `.part` AND its `.aria2` go through `removePartialFiles`, `progress`/`best_progress` are zeroed, and the job restarts from scratch |
| Claim-lost reporting | `db.ts startClaimHeartbeat()` | `onLost` fires AT MOST ONCE per claim: the worker releases its own claim in the statement that records the outcome and then sleeps for the backoff, so a per-tick report printed "download claim lost" every 30 s per retrying video and buried error.log |
| Partial-file bookkeeping | `workers/download.ts` + `reconcile.ts findPartialFile()` | recorded on failure, cleared on success |
| Partial-path freeze | `reconcile.ts recordJobPartial() / recordPartialPaths()` | records the on-disk `.part` before a job stops being `downloading`, so a paused/interrupted job really resumes instead of restarting |
| Pause bookkeeping | `workers/download.ts parkPaused()` | parks an in-flight job as `paused` **and** freezes its partial path |
| Circuit breaker | `resilience.ts notePipelineFailure()` | N consecutive failures per stage pauses the engine (`TOO_MANY_FAILURES`) |
| Pause / resume | `resilience.ts triggerPause / triggerResume` | SIGINTs child yt-dlp; resume re-queues paused jobs and clears their claim columns. Parking an in-flight download keeps its claim (owner+token) so the worker's own release still matches |
| Network monitor | `resilience.ts networkMonitor()` | probes 3 hosts, pauses after 2 consecutive failures |
| Cookies watcher | `reconcile.ts cookiesWatch()` + `tools.ts detectCookiesChange()` | 60s sweep: reports cookies.txt appearing / changing / vanishing mid-run and counts the credential-blocked jobs it may rescue (never auto-requeues them) |
| Disk guard | `resilience.ts diskUsage()` → `checkDiskSpace()` | `diskUsage` is the **only** `statfs` caller: statfs → PowerShell `Get-PSDrive` fallback → `-1/-1` degraded mode (never bricks the engine, never 500s `/api/status`) |
| Crash recovery | `reconcile.ts reconcileCrashedJobs()` | `downloading` → `paused + interrupted` (auto-claimable); also clears orphan claims from legacy user-paused downloads while keeping them held. **Refuses to run without the engine lease** — this sweep resets every in-flight claim, so it may only touch a database its own process owns. Clearing each row's claim token is what fences the previous engine's stale workers out |
| Stale-claim reaper | `reconcile.ts reapStaleClaims(config)` | Lease-gated (only the engine holding the engine lease reaps) and **heartbeat-based**: downloads silent >`max(20 min, maxDownloadMinutes)` (actively owned jobs are additionally protected in-process, and progress renews the heartbeat), conversions silent >3 h, metadata silent >15 min — `staleClaimCondition()` is the single predicate, shared with the dashboard's stale-claims panel so the two cannot drift. Each reclaim is `reapStaleClaim()`, a CAS on `(token, owner, status, expired-heartbeat)`: a worker that renewed its heartbeat, or a second reaper that got there first, makes the update match 0 rows and the job is left alone. Also sweeps the stranded `.aria2` control files of the jobs it actually reclaimed this tick (a dead worker's pair whose data file is gone would wedge the next attempt) through the same `removePartialFiles` contract: a locked control file is reported and retried on the next tick, never forced |
| Missing-file reconciliation | `reconcile.ts reconcileMissingFiles()` | scrubs the yt-dlp archive + re-queues |
| Failed-job sweep | `reconcile.ts requeueFailedJobs()` | after cooldown, non-permanent failures start a fresh per-video retry window; permanent download errors are skipped; `ignoreCooldown` for the UI button |
| Partial-file cleanup | `reconcile.ts cleanOrphanedFiles()` | keeps every resume-able partial — `pending`/`downloading`/`paused`/`waiting_live` owners and retryable failures waiting for cooldown are **never** aged out; deletes exhausted partials when auto-requeue is disabled, partials nothing will resume once they are a week old (`PARTIAL_MAX_AGE_MS`), day-old orphans (`ORPHAN_PARTIAL_MAX_AGE_MS`) and unowned `.superseded` backups. Recorded paths and walked paths are compared through `pathKey()` (absolute + case-folded), because the DB stores absolute paths while the walk is relative to `outputRoot`. Returns `{removed, locked}`: a partial whose control file is locked keeps BOTH files, is counted as `locked`, logged, and retried by a later sweep — never counted as removed |
| Offline mode | `config.ts offlineMode` + `offlineOverrideFromRuntime()` → loop guards in `workers/download.ts`, `workers/metadata.ts` | No download, no scan, no RSS, no sidecar fetch, no cookie validation, no network monitor: every one of those is a network round-trip. The download and metadata loops idle (workers are still started, so flipping the setting live works), queued jobs keep their status and `.part` files, and conversion + relocation keep running. Conversion deliberately keeps its ordering rule (`claimConvertJob` still requires terminal metadata), so a job waiting on sidecars waits — the mode finishes local work, it does not reorder the pipeline. `--offline`/`YTA_OFFLINE` set it for one run only; the stored setting is untouched |
| Secondary-storage relocation | `relocate.ts relocateFinishedJobs()` (driven by `startRelocation()`) | Moves finished media (sidecars first, `moveToSecondaryStorage`) whose conversion is already `done`/`not_needed`, adopts a file a crashed run copied but never recorded, and re-offers every file when `secondaryStoragePath` changes (that is what `relocated_to` stores — the ROOT, not a boolean). Claim-free by design: one engine per `archive.db` (lease) + one pass in flight per process + idempotent steps + a CAS on the old path. It never moves a job that is downloading/converting/mid-sidecar, a file already under the root, or a job deleted mid-move |
| Superseded-file recovery | `reconcile.ts reconcileSupersededFiles()` | startup heal of the deliberate-re-download hand-off: rolls back a stash whose rename never ran (`file_path` not yet recorded), restores a backup whose retry never became claimable, drops a backup whose re-download already finished, and adopts a legacy rename-first backup instead of letting the missing-file sweep re-queue the video |
| Archive scrubbing | `archive.ts removeFromArchive()` | needed whenever a file disappears, else yt-dlp skips it forever |
| Signature self-heal | `workers/download.ts` | auto-runs `yt-dlp -U` and retries with a clean budget |
| Engine lease release | `lease.ts releaseEngineLease()` (from `lifecycle.ts handleShutdown()`) | owner → NULL with an immediate expiry, so a clean restart never waits for a TTL; the row (and its fencing counter) is kept |
| WAL checkpoint | `lifecycle.ts handleShutdown()` | keeps `archive.db` self-contained after exit |

**Adding a new failure class:** extend the classifiers in `retry.ts` (pure,
unit-tested), then handle it in `workers/download.ts handleDownloadFailure()`
in the right precedence order: signature → downloader-args → format availability
(stale audio probe → quality fallback ladder → terminal) →
**unrecoverable resume (416)** → corrupt → archive-scrub → live/premiere →
permanent (terminal skip) → transient/other retryable budget.

**The order is the design.** A broader classifier placed first swallows the
narrower one: a 416 must precede the corrupt-resume branch (which would spend its
budget resuming the very partial that cannot be resumed) and the permanent class
(which would park the job while keeping the broken resume state on disk).
The same rule binds the two **format-availability** halves: `isFormatAvailabilityError`
matches text (`Requested format is not available`) that `isPermanentDownloadError`
also matches, so the format branch must run first — otherwise a stale selector
would park a perfectly downloadable video forever. Inside it, the stale-audio
clear must run before the quality ladder (re-probing is cheaper and fixes the
common cause), and the ladder before the terminal skip.

**Terminal means terminal, but only for the sweeps.** `parkTerminal` writes the
marker; a human can still re-queue the job deliberately
(`POST /api/jobs/:id/retry` clears `last_error`). Do not add a "helpful"
auto-requeue for these rows — the original complaint this class exists for is a
playlist that retried its dead videos forever and filled `error.log` doing it.

The **downloader-args** class (`retry.ts isDownloaderArgsError`, aria2c exit 28
+ the option's help block) is a global misconfiguration, not a video problem:
the handler parks the job and `triggerPause("BAD_DOWNLOADER_ARGS …")` so one
bad knob cannot burn every retry budget in the playlist before the circuit
breaker trips.

---

## 7. Configuration

- **Single source of truth:** `src/config.ts` (`ConfigSchema` + `DEFAULT_CONFIG`).
  The engine and `update_config.ts` both import it — never re-declare the schema.
- `loadConfig()` (engine) exits the process on invalid config;
  `loadConfigSafe()` (manager) falls back to defaults.
- Partial configs are merged over `DEFAULT_CONFIG`, so new keys are always
  backwards compatible with existing `config.json` files.
- Cross-field rules are enforced with `.refine()`: backoff max ≥ base,
  maxDownloadMinutes ≥ downloadTimeoutMinutes, minDownloadWorkers ≤ maxDownloadWorkers.
- **Adding a key:** add it to `ConfigSchema` and `DEFAULT_CONFIG`, add a prompt
to the relevant `update_config.ts` menu (4 = download, 5 = feature toggles,
6 = reliability), and add a test in `tests/config.test.ts`.
`tests/config-manager.test.ts` asserts every schema key is reachable from the
manager, so an un-prompted key fails the suite rather than becoming
hand-edit-only.
- The config manager prompts for the download root, cookies, and feature
toggles. Its reliability menu should use `STALE_CLAIM_THRESHOLDS` for sweep
values. If changing its resume-state display, ensure it opens `archive.db`:
`config.archiveFile` is yt-dlp's plain-text history file, not the SQLite job
database.

Offline key: `offlineMode` (boolean, default false) — no downloads at all; the
engine only converts files that need conversion and moves finished files to
secondary storage, leaving queued jobs untouched. It is the one setting whose
runtime override (`--offline` / `YTA_OFFLINE=1`, parsed by
`offlineOverrideFromRuntime()`) is applied to the in-memory config only, before
`checkDependencies()`; `config.json` is never rewritten by it. In offline mode a
missing yt-dlp is a note instead of a fatal install hint, `ffmpeg` remains
required, and the relocation pass (below) keeps the archive tidy.

Relocation key: `secondaryStoragePath` pairs with the jobs table's
`relocated_to` column — the secondary-storage root each file was moved under.
NULL means "still in the output tree".

Reliability keys: `maxResumeAttempts`, `retryBackoffBaseSeconds`,
`retryBackoffMaxSeconds`, `requeueFailedAfterMinutes`, `verifyExistingFiles`,
`downloadTimeoutMinutes`, `maxDownloadMinutes`.

Performance/concurrency keys: `useAria2c`, `connectionsPerDownload`,
`minSplitSize`, `concurrentFragments`, `fragmentRetries`, `httpChunkSize`,
`bufferSize`, `autoscaleEnabled`, `maxConcurrentDownloads`,
`minDownloadWorkers`, `maxDownloadWorkers`, `autoscaleRampStep`, and
`maxBandwidthKBps`. See section 7.1 for downloader flags and the distinction
between initial/fixed slots and the autoscaler floor/ceiling.

### 7.1 How downloads actually reach yt-dlp (`src/download-args.ts`)

`buildDownloadPlan({ job, config, activeSlots, aria2cAvailable })` is the single
place that builds the yt-dlp argv. It is pure and unit-tested — add new flags
there, not in the worker. What it emits today:

- `--downloader aria2c --downloader-args aria2c:-x N -s N -j N` when aria2c is
  installed and `useAria2c` is true. The complete `aria2c:...` value is passed as
  ONE argv element with no inner quotes; yt-dlp shlex-parses the text after the
  prefix. yt-dlp's own baseline is `-x16 -s16 -j16 --min-split-size 1M`, so
  `minSplitSize` is emitted whenever it differs from `1M` — and *also* when it is
  not a size at all, because a value aria2c rejects must reach aria2c and surface
  as the `BAD_DOWNLOADER_ARGS` pause instead of being dropped silently.
- `--limit-rate N` as an integer byte/second value when a cap is configured.
  The configured KB/s cap is divided by the current active slot count and
  converted to bytes/second; there is no per-worker minimum (a minimum would
  violate small caps). yt-dlp maps this onto the external downloader's rate
  limit (`aria2c --max-overall-download-limit`). Because active downloads keep
  the rate they started with, the aggregate is best-effort during autoscaling;
  new download attempts use the latest slot count.
- Native tuning (`--concurrent-fragments`, `--fragment-retries`, and the opt-in
  `--http-chunk-size` / `--buffer-size`) applies to DASH/HLS fragments and the
  fallback path.

Facts worth knowing before you touch it:

- **aria2c only serves http/https/ftp.** For HLS, DASH-segment, and live streams
  yt-dlp silently falls back to its native downloader — the engine does not need
  to special-case those protocols.
- **aria2c hard-caps `-x/--max-connection-per-server` at 16** ("Possible Values:
  1-16" in its help). A higher value makes it exit 28 — *bad/unrecognized
  option* — before transferring a byte, so `buildAria2cArgs` clamps `-x` to
  `ARIA2C_MAX_CONNECTIONS_PER_SERVER` while `-s`/`-j` keep the configured value.
  Any other rejected option (e.g. a malformed `minSplitSize`) surfaces as the
  `isDownloaderArgsError` class and pauses the engine instead of failing the
  whole batch video by video.
- **External downloads still land in yt-dlp's `<name>.part` temp file**, so
  `partial_file_path` tracking and `--continue` resume behave identically. This
  is why enabling aria2c does not regress resume.
- `aria2c` is discovered in `tools.ts` (`resolvedTools.aria2cPath`, `null` when
  absent) and is **optional** — a missing binary warns at startup and never
  exits. `checkDependencies` takes the aria2c keys as optional config fields.

### 7.2 Multi-audio tracks (YouTube multi-language audio)

YouTube serves some videos with several audio tracks (original + auto-dubbed);
yt-dlp exposes each as an audio-only format whose id carries the track index
(`251-0`, `251-1`, …), repeats it per quality variant, and appends `-drc` to
Dynamic Range Compression duplicates. `src/audio-tracks.ts` owns this:

- `extractAudioTracks(info)` collapses a `-J` dump to one entry per track (best
  stream by bitrate/codec, drc and progressive formats dropped).
- `selectAudioTracks(tracks, mode, languages, jobSelection)` implements the
  policy: per-job selection (JSON in `jobs.audio_selection`, set from the
  dashboard) wins over the global `multiAudioMode` (`off` | `all` |
  `languages` + `audioTrackLanguages`).
- `multiAudioFormatSelector(base, tracks)` splices the track ids into the
  QUALITY_FORMATS preset; `buildDownloadPlan` then adds `--audio-multistreams
  --merge-output-format mkv` for 2+ tracks. One track = a normal merge with
  that track pinned; `videoQuality: "audio"` never multi-streams.
- `probeAudioTracks(url, config)` is the single `-J` call, hard-capped at
  `PROBE_TIMEOUT_MS` (it runs inside a download slot and behind a dashboard
  button, so it must surface a timeout instead of hanging). The download
  worker runs it once per job (only when a mode/selection will consume it),
  caches the result in `jobs.audio_tracks`, and a probe failure logs and
  falls back to single audio — it never fails a download.
- The default MP4 path marks a multi-track download as `not_needed`, so yt-dlp's
  MKV is retained. If a per-job/global target format explicitly requests
  conversion, `workers/convert.ts` maps every audio stream; MP4 re-encodes each
  stream as AAC. `countAudioStreams()` drives that choice/logging — it does not
  bypass a requested container conversion.

Dashboard: `/api/jobs` returns `audio_tracks` / `audio_selection` as parsed
arrays; `POST /api/jobs/<id>/audio-probe` refreshes the list;
`POST /api/jobs/<id>/audio-tracks` saves (`{tracks:[…]}`) or resets
(`{tracks:null}`) the per-job selection, applied on the next attempt. The
`POST /api/jobs/<id>/override` route edits target format / quality / audio
language overrides; `{retry:true}` saves and re-queues in one idle-job
transaction (so a downloaded file is archived/stashed before workers can claim
it). The job drawer offers one-click save & re-download.

#### Re-downloading an archived video (retry = replace)

Retrying a downloaded job — the flow that applies a saved audio selection —
must get past two yt-dlp gates, and the engine does both in `retryJobById`
(web.ts) **before** the job becomes claimable:

1. `removeFromArchive()` scrubs the id from the archive file, otherwise yt-dlp
   answers *"has already been recorded in the archive"* and exits 0 without
   downloading anything (the old silent no-op bug).
2. `stashDownloadedFile()` (reconcile.ts) moves the existing media file to
   `<file>.superseded`, because `--no-overwrites` skips a download whose
   target file still exists. The job's `file_path` is cleared and the backup
   path recorded in `superseded_file` — **the row is written before the
   rename**, so a crash between the two steps leaves recoverable state instead
   of a file nothing points at. If the rename itself fails the row is put back
   and the retry aborts with a 500 instead of starting a download yt-dlp would
   skip.

The backup is the safety net: the download worker deletes it on success
(`dropSupersededFile`) and — if the re-download fails permanently — restores
it and marks the job downloaded again (`restoreSupersededFile`), so a failed
re-fetch never destroys the previously archived file. Every crash window of
the hand-off is healed by `reconcileSupersededFiles()` at the next startup:
an interrupted rename is rolled back (the file never moved, so the row
re-claims it), a backup whose retry never became claimable is restored, a
backup whose replacement already succeeded is deleted, and a legacy
rename-first backup (`file_path` gone, `<file_path>.superseded` present, no
pointer recorded) is adopted back into place — otherwise
`reconcileMissingFiles` would re-queue the video and the old file would stay
unmanaged.

#### Unavailable formats recover instead of parking the job

`retry.ts isFormatAvailabilityError()` matches yt-dlp's *"Requested format is
not available"* — which `isPermanentDownloadError` ALSO matches. The download
worker checks it FIRST, in two steps:

1. **Stale multi-audio probe.** When a job carried stored `audio_tracks`,
   YouTube has most likely renumbered its formats since the probe, so the
   worker clears `audio_tracks` (forcing a fresh probe; the per-job language
   selection survives) and retries within the normal no-progress budget — a
   re-probe can pin the same stale ids again, so this half does need a bound.
2. **Quality fallback ladder.** With no stale probe to blame, the preset itself
   matched nothing: the worker persists the next lower `video_quality` override
   and retries immediately (no backoff — the next attempt is a different
   command), announcing it in the dashboard for `FORMAT_SWITCH_NOTICE_MS` so the
   downgrade is visible, logging one line, and counting `stats.formatFallbacks`.
   The ladder (`FORMAT_FALLBACK_LADDER`) is strictly descending and ends at
   `highest` (`bv+ba/b`, i.e. "any stream the extractor found"), so it cannot
   loop and spends no retry budget — see the table in section 6.

Both steps run before the permanent classification. Only a job whose ladder is
exhausted falls through to a terminal skip, labelled
`No format available (tried down to <preset>)`.

#### Control files: never delete a `.part` without its `.aria2`

aria2c writes a *control file* beside every in-progress download
(`<name>.part.aria2`) holding which pieces arrived. Two rules follow, and both
are load-bearing:

1. **Resume depends on the pair.** An interrupted transfer leaves
   `<name>.part` + `<name>.part.aria2`; the next attempt resumes from them. This
   is why enabling aria2c does not weaken the resume/reliability behaviour.
2. **Discarding a partial must delete both.** aria2c defaults to
   `--allow-overwrite=false`, whose documented behaviour is *"if a file already
   exists but the corresponding control file doesn't exist, then aria2 will not
   re-download the file."* A stranded control file therefore makes aria2c unable
   to resume (the data is gone) *and* unwilling to restart — the job retries
   forever. Exit status 10 (*"piece length was different from one in .aria2
   control file"*) is the other way this bites.

Always go through `removePartialFiles(path)` (`src/reconcile.ts`), never a bare
`unlink()`. It removes the data file and the control file together, and
`cleanOrphanedFiles()` also sweeps control files whose data file has vanished.
`findPartialFile()` deliberately matches only the data file — a control file on
its own is litter, not resumable state.

---

## 8. Web API (`src/web.ts`)

Auth: every request (UI + API) is gated when `webToken` is set — via cookie
(`yta_token`, HttpOnly after sign-in), `Authorization: Bearer`, `X-Web-Token`,
or `?token=`. Comparison is timing-safe. Default bind is `127.0.0.1`.

Routing is a `ROUTES` table of `{methods, pattern, handler}` with `:param`
segments — not an if-chain. The contract every route shares: a
`{ ok: true|false, … }` envelope, a **JSON** 404 for an unknown API path, and a
**JSON** 405 (+ `Allow`) for a known path with the wrong method. Trailing
slashes collapse (`/api/jobs/` is `/api/jobs`). Static action paths are listed
*before* `:param` routes so a wrong method answers 405 instead of binding the
segment as an id (gotcha 21).

Job retry and per-job override must check all pipeline stages and claims inside
an immediate SQLite transaction (`withIdleJobs()`
for id-based operations). If any targeted row is downloading, converting, fetching
metadata, or still holds a download/conversion claim, return HTTP 409 with
`{ ok: false, error: "Job is currently in progress" }` and make no partial bulk changes.
The cancel-flavoured routes are the deliberate exception: `POST /api/jobs/pause`,
`POST /api/jobs/:id/stop`, `DELETE /api/jobs/:id`, `DELETE /api/jobs` and
`POST /api/queue/purge` park or remove rows that are active *and interrupt their
children* (park first, then signal, so the worker releases its own claim through
its token and the `.part` stays resumable). Refusing those rows would make each
button useless for exactly the job the operator is clicking it about.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | dashboard (login page when a token is required) |
| GET · HEAD | `/api/ping` | liveness probe used by the UI |
| GET | `/api/version` | engine/runtime info (`Bun.version`, platform/arch, uptime seconds) |
| GET | `/api/status` | stats, speed, ETA, disk, live worker lines, pause state, `runtime`; `diskSpace.free` reads `"unknown"` when no disk probe could answer |
| GET | `/api/jobs` | `{ ok, jobs }` — up to 500 jobs with status/retry/progress fields (`JOB_COLUMNS` in `web.ts` is the single source of truth for what the dashboard may read: per-stage retry counters, `best_progress`, `partial_file_path`, `relocated_to`, the `created_at` / `updated_at` stamps the drawer and the history tab show), plus parsed `audio_tracks` / `audio_selection` / `metadata_files` and boolean `want_*` sidecar flags |
| GET | `/api/jobs/:id` | one job, read fresh from the DB — the detail drawer fetches this instead of trusting a poll-cycle-old list row |
| POST | `/api/scan` | `{url, folder?}` → validate/canonicalize → save source to `config.json` → scan & ingest; returns `saved`, `source: {url, key, added}`, and counts. Save failure starts no scan; scan failure keeps the saved source. Folder override applies only to this scan |
| POST | `/api/queue/purge` | delete every idle pending / paused / waiting_live / failed job **and the rows that are downloading right now**, interrupting those children first so nothing keeps writing after the button; returns `{ok, deleted, stopped}` |
| POST | `/api/pause` · `/api/resume` | global pause / resume-all |
| POST | `/api/jobs/:id/retry` | re-queue one idle job (all stages, budgets reset); 404 for an unknown id, 409 while any pipeline stage/claim is active. For a downloaded job this is a deliberate re-download: the id is scrubbed from the yt-dlp archive and the existing file stashed as `.superseded` first (§7.2). 500 when the previous file cannot be moved aside |
| POST | `/api/jobs/:id/override` | partial `{targetFormat?, videoQuality?, audioTracks?}` edit; nullable values reset to global behavior. Optional `retry:true` applies the override and queues a deliberate re-download atomically (or retries current settings when sent alone); 400 invalid payload, 404 unknown id, 409 active pipeline stage |
| POST | `/api/jobs/:id/reset-failures` | zero the per-stage retry counters; 404 for an unknown id |
| POST | `/api/jobs/:id/sidecars` | per-job sidecar toggles: `{subtitles?, thumbnail?, description?}` (booleans). Flipping a flag on for a finished download re-opens the metadata stage so the worker fetches the files against the existing media; flipping off never deletes fetched files. 400 for an empty/non-boolean body |
| POST | `/api/jobs/pause` | bulk user-pause by `{ids: []}`: parks each row with `pause_reason = 'user'` and interrupts its transfer, keeping a mid-download claim so the `.part` still resumes; 400 when no ids are given |
| DELETE | `/api/jobs` | bulk delete by `{ids: []}`, cancelling active children the same way; `{ok, deleted, stopped}` |
| POST | `/api/jobs/:id/audio-tracks` | per-job audio-track selection: `{tracks:["es",…]}` saves it, `{tracks:null}` returns the job to the global mode |
| POST | `/api/jobs/:id/audio-probe` | runs the yt-dlp `-J` probe for one job, stores + returns its audio tracks |
| DELETE | `/api/jobs/:id` | delete one job, cancelling its in-flight child first so no yt-dlp keeps writing into a file nothing tracks; 404 for an unknown id, `{ok, deleted, stopped}` otherwise |
| POST | `/api/retry/:id` · `/api/failcount/reset/:id` · `/api/jobs/delete` | **legacy aliases** of the canonical routes above — kept on purpose for older dashboards and scripts |
| GET | `/api/failed` | failed jobs |
| POST | `/api/failed/requeue` | force-requeue eligible failed jobs (cooldown ignored, permanent errors still skipped) |
| GET | `/api/reliability` | pause state, kept partials, retryable count, active policy, active downloader engine (`downloader.engine` / `.path` / `.connectionsPerDownload` / `.concurrentFragments` / `.maxBandwidthKBps` / `.autoscaleRampStep`), plus a `resume` block (`resumablePartials` / `interrupted` / `staleClaims`) and a `sweeps` array (`id` / `label` / `cadence` / `detail` / `pending`; `missingFiles.pending` is `null` because that sweep stats every file) |
| GET | `/api/settings` | the dashboard-editable keys: `{fields, values, nonDefault}` where each field carries its label/type/range/help so the UI renders generically |
| POST | `/api/settings` | apply a partial patch. Validates the **whole** config against `ConfigSchema` (so cross-field refinements hold), persists to `config.json`, and `setConfig()`s it live. Rejects (400) any key outside the allow-list, an out-of-range value, or a malformed body — and changes nothing when it rejects |
| GET | `/api/history?limit=20` | run history rows |
| GET | `/api/logs?type=error\|report&limit=100` | error.log or the run report |

Frontend is plain JS in `web_ui.html` — no build step. After editing it,
re-extract the inline `<script>` and syntax-check it (see section 9.4).

The page has no types and no imports, so **the key names it reads are the
contract** — see gotcha 41 and `tests/web-ui-contract.test.ts`, which executes
the real inline script over a stub DOM against `handleRequest` and asserts the
job table renders. Every list endpoint answers with an envelope
(`{ ok, jobs }`, `{ ok, sources }`, `{ ok, logs }`), never a bare array.

---

## 9. Testing

### 9.1 Running

```bash
bun test                       # everything (unit + end-to-end; uses mock tools)
bun test tests/retry.test.ts   # one file
bun run typecheck              # tsc --noEmit (tsconfig covers *.ts, src/**, tests/**)
bun run check                  # typecheck + full suite (what CI/the definition of done means)
```

The suite is organized under `tests/` and covers both pure helpers and complete
engine runs. Database tests initialize an isolated in-memory database in their
setup; `db` is an exported live ESM binding because `initDatabase()` replaces it.

### 9.2 What is covered where

| File | Focus |
| --- | --- |
| `tests/retry.test.ts` | backoff math, watchdog scaling, error classification, the terminal reason table + `[terminal]` record round-trip (including the wordings that used to loop: `This video is private`, `This video is unavailable`), and the format fallback ladder (strictly descending, bottoms out at `highest`, `audio`/unknown never fall back) |
| `tests/util.test.ts` | formatters, Windows filename hardening, `fitBaseFilename`, hashing |
| `tests/config.test.ts` | defaults, validation, cross-field refinements, atomic load/save |
| `tests/sources.test.ts` | URL classification, canonicalization, persisted source lists, dedup, concurrent saves/settings, validation/auth/write failures |
| `tests/db.test.ts` | schema + legacy migration, atomic claims, the pipeline claim exclusions, all reconcile/requeue sweeps, ingestion dedupe |
| `tests/engine-lease.test.ts` | the database-level engine lease: acquisition/refusal, takeover of an expired lease and of one whose owning process is gone, renewal failure after a takeover, the heartbeat's lost-lease signal, release + clean restart (fencing survives), and that the startup/reaper sweeps refuse to run without the lease. Uses file-backed databases and a real second process (`tests/fixtures/claim-worker.ts`) |
| `tests/claim-races.test.ts` | claim ownership across SEPARATE connections and PROCESSES: two handles cannot claim the same job twice, three processes draining 40 jobs never double-claim (unique token per row), a crashed owner reclaimed only after its lease lapses, a stale worker's progress/release refused after its claim was taken, a long-running heartbeating conversion never reaped (and reaped once the heartbeat stops), metadata reaped on its heartbeat rather than `updated_at`, and two reapers racing one expired claim where exactly one CAS wins |
| `tests/cookies.test.ts` | `cookiesArgs`/`cookiesState` on a missing/empty/present file, the appeared/updated/disappeared transitions, and `cookiesWatch`'s credential-blocked count |
| `tests/rss.test.ts` | `parseRssFeed` against a realistic feed (CDATA, missing duration); timer picks up live-added channels after an empty startup |
| `tests/webauth.test.ts` | token extraction, timing-safe compare, authorization |
| `tests/report.test.ts` | run report contents |
| `tests/download-args.test.ts` | downloader-engine selection, aria2c args, bandwidth split, fragment/chunk/buffer flags, watchdog scaling, multi-audio selector/multistream flags |
| `tests/download-output.test.ts` | bounded CR/LF pipe parsing, split UTF-8, oversized-record discard, validated final-path markers |
| `tests/download-process.test.ts` | a progress-callback failure kills/reaps the downloader and clears active process tracking |
| `tests/download-pause.test.ts` | user pause state survives download failure and successful file recording |
| `tests/download-resume-416.test.ts` | the unrecoverable-resume branch: an HTTP 416 (or aria2c's control-file refusal) discards the `.part` WITH its `.aria2`, zeroes progress/best_progress and re-queues for a fresh transfer; the budget still bounds it; a lost claim writes nothing over the new owner's row; a plain corrupt error still KEEPS the partial |
| `tests/audio-tracks.test.ts` | track parsing (variant collapse, drc drop, ordering), selection policy incl. per-job override, selector splicing, JSON column round-trips, and `probeAudioTracks` failures against a real child process (non-zero exit, unparsable JSON, and the abort at the timeout — every path the worker's single-audio fallback depends on) |
| `tests/metadata.test.ts` | `subtitleArgs` — `all`/blank keep fetch-everything, explicit language lists pass through verbatim |
| `tests/autoscale.test.ts` | slot ramp step, backlog/ceiling clamps, idle collapse, disabled mode |
| `tests/reconcile.test.ts` | `removePartialFiles` (control-file-first order, its `fatal` result, and `.ytdl` fragment DIRECTORY removal), `partialSidecars`, `findPartialFile`, the reaper's stranded-control-file sweep (swept, live pair kept, non-reclaimed job untouched, locked retry), `cleanOrphanedFiles` control-file handling and honest `{removed, locked}` counting plus the durable-work guarantees (relative `outputRoot` vs absolute recorded path via `pathKey`, resumable statuses never aged out, terminal partials and unowned `.superseded` backups swept, the fitted base name `recordPartialPaths` must search), and the superseded-file lifecycle (`stash`/`drop`/`restore` + every `reconcileSupersededFiles` crash state) |
| `tests/convert.test.ts` | `findConvertedOutput` crash-window adoption: adopts a finished mp3/mp4, never the source itself, empty for unrelated sidecars |
| `tests/convert-storage.test.ts` | `moveToSecondaryStorage` safety: media + sidecars land in `secondaryStoragePath/<folder>/` and the sources go with them, a sidecar that cannot be copied keeps its source, an impossible media move throws and leaves the only copy in place, ownership loss stops the sequence at the next destructive step, and the cross-device copy path (EXDEV) deletes the source only after the copy lands |
| `tests/tools.test.ts` | `resolveTool` discovery against a real injected search space: NOTHING installed answers null (the native-downloader fallback), PATH discovery finds a shim, an explicit config path wins, a stale config path does not hide a PATH candidate, and a binary whose version probe fails is not usable |
| `tests/logger.test.ts` | `errorLogPath()` routes test-run logs to the temp dir, never the operator's `error.log` |
| `tests/disk.test.ts` | `diskUsage()` happy path, the `-1/-1` degraded path, and `checkDiskSpace`'s allow-through when free space is unknown — plus the forced fallback chain through `DiskProbeOptions` (a build without statfs, the win32 PowerShell probe, a hung shell timing out, an unusable shell answer, and the no-spawn rule for a path that is not on disk), with `driveLetterOf`/`parsePSDriveOutput` pinned directly |
| `tests/web-routes.test.ts` | the `ROUTES` table: canonical per-job routes, the legacy aliases, JSON 404/405 + `Allow`, trailing-slash collapse, active-stage 409 guards across retry/delete/pause/purge, retry-as-re-download (archive scrub + `.superseded` stash), per-job format/quality/audio overrides, and sidecars |
| `tests/settings.test.ts` | the dashboard settings allow-list, type coercion (including every accepted boolean spelling and the rejection of `"maybe"`/empty — an invalid value must never coerce to `false`), Zod + cross-field validation, persistence, live-config propagation, and auth |
| `tests/config-manager.test.ts` | every schema key is reachable from `update_config.ts`; the manager reads the sweep thresholds from `STALE_CLAIM_THRESHOLDS` and counts partials with the engine's predicate |
| `tests/offline-mode.test.ts` | the run-level switch (`--offline`/`YTA_OFFLINE`, last flag wins, argv beats env, unparsable ≠ false), the settings round-trip (live + persisted), `isPathInside` (siblings sharing a prefix are NOT inside), and `relocateFinishedJobs`: move + sidecar + recorded path, idempotence, no-op without `secondaryStoragePath`, crash-window adoption, "already under the root", a non-candidate table (downloading / needs conversion / mid-metadata / failed), a failed move that keeps the only copy, and the stale-path CAS |
| `tests/dashboard.test.ts` | `formatHeaderLine` counters, and the `Res:n` field appearing only when partials are held |
| `tests/web-ui-contract.test.ts` | the dashboard page vs the API it calls: every `/api/…` path `web_ui.html` fetches must resolve, and the real inline `<script>` (run over a stub DOM against `handleRequest`) must render one row per job with no `undefined` on a card (gotcha 41) |
| `tests/integration.test.ts` | **end-to-end engine runs** (see 9.3) |

### 9.3 End-to-end tests with mock tools

`tests/mocks/yt-dlp`, `tests/mocks/ffmpeg`, and `tests/mocks/aria2c` are Bun
scripts that implement just enough of each CLI for the engine to run its full
pipeline. The mock yt-dlp honours `--downloader aria2c` by spawning the mock
aria2c and recording the argv it received to `<out>.aria2-args`, which is how
the aria2c integration test proves the connection tuning and the bandwidth cap
actually reach the downloader. The integration
test prepends `tests/mocks` to `PATH`, writes a `config.json` into a temp dir,
and spawns the real `batch_playlist_downloader.ts`, then drives it over HTTP
(`/api/status`, `/api/jobs`, `/api/reliability`) and asserts final job states.

Scenarios: happy path (scan → download → metadata → convert), transient-failure
retries with backoff, corrupt-partial resume, permanent failures (never
requeued), restart reconciliation after deleting files, aria2c multi-connection
downloads (args + cap verified), the native fallback when aria2c is missing in
TWO ways — the documented `aria2cPath: "none"` switch, and (POSIX) a real
dependency probe over a PATH that holds nothing but the mock yt-dlp, proving
discovery itself answers "not installed" instead of failing the run — the
multi-audio probe falling back to a single-audio download both when `-J` fails
and when it hangs (the timeout is shortened with
`YTA_AUDIO_PROBE_TIMEOUT_MS`, a test-only override read by
`src/audio-tracks.ts`), the secondary-storage hand-off (media + sidecars land
under `<secondaryStoragePath>/<folder>/` and `file_path` records the new
location; a move whose destination is blocked keeps the only copy in the
download folder, fails the conversion, and stores the move error in
`last_error`),
aria2c option validation (`-x` above the 16 cap is clamped; a malformed
`--min-split-size` pauses the engine with `BAD_DOWNLOADER_ARGS` instead of
failing the batch), and
four aria2c resume/self-healing scenarios: resume from the control file,
discarding a partial *with* its control file when the resume budget runs out, a
hard kill mid-transfer followed by a resume on restart, and deleted files being
re-fetched — plus the HTTP 416 scenario, where the mock aria2c answers a RESUME
only (never a fresh transfer) with `HTTP Error 416: Requested range not
satisfiable`; the run must end downloaded, with the `.part` + `.aria2` pair gone
and `resumed=false` in the mock's argv record, proving the engine restarted from
scratch instead of looping on the stale resume state. Two more scenarios pin the durable-work guarantees end to end: a
paused job's ABSOLUTE `partial_file_path` survives the startup sweep while
`outputRoot` is the default RELATIVE `./downloads` (the counterexample that
used to delete a day-old "orphan" that was the job's only resume state), and a
crashed rename-first stash (`file_path` gone, `<file_path>.superseded` present)
is adopted back on startup — the media's marker bytes prove it was restored,
not re-downloaded. The error-handling classes have their own end-to-end
scenarios: **unavailable videos** (`FAKE_FAIL_MODE=private|unavailable`,
optionally with a unique `FAKE_FAIL_MESSAGE` marker) must be attempted exactly
once — the mock's `.attempts` counter is the proof — with `[terminal]` in
`last_error`, no marker in the `error.log` delta, `resumableFailed: 0` on
`/api/reliability`, an unchanged `.attempts` after a forced
`POST /api/failed/requeue`, and a report that reads `⛔ Private video`; and the
**format fallback ladder** (`FAKE_FORMAT_FAILS_SELECTOR='height<=1080'`, or the
sentinel `all` for a video with no usable formats) must step the persisted
`video_quality` override down, announce it in the dashboard (the 1.5 s notice
pause is what makes it observable), record it in `error.log`, download with the
fallback selector recorded in the mock's `.ytdlp-args`, and — with `all` — stop
after three attempts (720p → 480p → highest) as a terminal `No format
available` skip instead of retrying.

The mock aria2c reproduces the real control-file lifecycle (interrupted →
`.part` + `.aria2`; resume → `resumed=yes`; success → control file removed) and
**fails hard if it is handed a control file whose data file is missing** — that
is the wedged state the engine must never create, so a regression in
`removePartialFiles` fails the suite rather than hanging a download. Like the
real binary it also validates option values: `-x` outside 1-16 or a
`--min-split-size` that is not a size dies with exit 28 and the option's help
block, which is how the clamp and the `BAD_DOWNLOADER_ARGS` pause are tested.
Injection:
`FAKE_ARIA2C_FAIL_TIMES` / `FAKE_ARIA2C_FAIL_MODE` (failure originates inside the
external downloader, independently of the yt-dlp mock's own `FAKE_FAIL_TIMES`)
and `FAKE_ARIA2C_INFLIGHT_MS` (hold a transfer open so a kill can interrupt it).
The yt-dlp mock kills its aria2c child when its own parent dies, so a hard-killed
engine leaves a realistic interrupted state instead of an orphan finishing the
download.

**That watchdog is POSIX-only.** Both mocks detect the death by polling
`process.ppid`, which changes only because POSIX reparents orphans to PID 1.
Windows keeps the original parent-PID value, so on win32 neither watcher ever
fires and an orphaned mock runs to completion — the crash-recovery scenario
("a hard kill mid-download resumes on restart") is only meaningful on POSIX. To
make it work on Windows, kill the whole process tree from the harness
(`taskkill /PID <pid> /T /F`) instead of relying on `process.ppid`.

The mock yt-dlp also speaks multi-audio: `--dump-single-json` answers with a
three-track format list (en original + es/hi dubs, quality variants and `-drc`
duplicates included, exactly the soup `extractAudioTracks` must clean), and a
download carrying `--audio-multistreams` writes `<base>.mkv` instead of
`<base>.mp4` while recording its whole argv to `<base>.ytdlp-args` — that file
is how the integration test proves the format selector and the multistream/MKV
flags really reached yt-dlp. The mock ffmpeg answers the stream probe
(`ffmpeg -hide_banner -i <file>`, no output arg) with a two-audio-stream banner
for `.mkv` inputs and one otherwise, which is what `countAudioStreams()` sees.

The mock also honours `--download-archive` the way real yt-dlp does: an id
already recorded is skipped with yt-dlp's exact *"has already been recorded in
the archive"* message and exit 0 (no file, no progress), and a successful
download appends `youtube <id>`. This fidelity is load-bearing — it is what
makes the deliberate-re-download contract (§7.2) observable in tests: without
scrubbing the archive, the retry integration test would hang on a silent skip.

Mock controls (environment variables):

| Variable | Effect |
| --- | --- |
| `FAKE_FAIL_TIMES=N` | fail the first N download attempts, leaving a `.part` file behind |
| `FAKE_FAIL_MODE` | `transient` \| `permanent` \| `corrupt` (which error message to emit) |
| `FAKE_DELAY_MS` | artificial per-attempt delay |
| `FAKE_OUTPUT_STRESS=1` | CR-only progress + oversized stdout/stderr, renamed Unicode final file with split UTF-8 and no trailing newline |
| `FAKE_OMIT_FINAL_PATH=1` | no after_move output, so the engine must find the expected media in the job folder |
| `FAKE_SCAN_LOG=path` | append every scanned URL, proving live daemon rescans and persisted startup sources |
| `FAKE_EMPTY_SCAN=1` | a valid source with no videos, proving source persistence does not depend on jobs added |
| `FAKE_HANG=1` | never exit (watchdog testing) |
| `FAKE_PROBE_FAIL=1` \| `=json` | make the `-J` audio-track probe fail (HTTP error / unparsable output) so the single-audio fallback runs end to end |
| `FAKE_PROBE_HANG=1` | make `-J` never answer, so the probe watchdog fires (pair with `YTA_AUDIO_PROBE_TIMEOUT_MS` to keep the test short) |
| `FAKE_ARIA2C_BIN` | absolute path of the sibling aria2c mock (set by the integration harness so that hop never depends on PATH) |
| `FAKE_ARIA2C_FAIL_TIMES=N` | fail the first N attempts *inside* aria2c, leaving the `.part` + `.part.aria2` pair |
| `FAKE_ARIA2C_FAIL_MODE` | `transient` \| `corrupt` \| `range416` (which aria2c-side error message to emit; `range416` bites ONLY when the run resumes from a control file — the "stuck at 99%" state) |
| `FAKE_ARIA2C_INFLIGHT_MS=N` | hold a transfer open N ms so a hard kill lands mid-flight, with partial + control file on disk |

**When adding an engine behavior, add an integration scenario rather than
mocking internals** — the mocks are the contract boundary.

### 9.4 Editing `web_ui.html`

```bash
python3 - <<'PY'
import re
html = open('web_ui.html').read()
open('/tmp/inline.js','w').write('\n;\n'.join(re.findall(r'<script>(.*?)</script>', html, re.S)))
PY
node --check /tmp/inline.js   # syntax gate before committing UI changes
```

---

## 10. Gotchas (read before changing things)

1. **ESM live bindings.** `db` is `export let db` reassigned by `initDatabase()`.
   Importers see the new value because bindings are live — but you can never
   assign to an imported binding. Route mutations through setter functions
   (`state.ts` does this: `setPaused`, `setConfig`, `setTty`).
2. **Claim transactions must be created inside `initDatabase()`.** Defining
   `db.transaction(...)` at module top level evaluates `db` while it is still
   `undefined` and crashes startup. This is load-bearing; don't "clean it up".
3. **Everything is CWD-relative.** `archive.db`, `config.json`, `error.log`,
   `downloaded_videos.txt`, and `web_ui.html` are resolved from `process.cwd()`.
   Tests therefore run the engine in a temp dir; the compiled exe expects
   `web_ui.html` next to it.
4. **Windows path rules are enforced everywhere.** `hardenName()` strips
   control chars, trailing dots/spaces, reserved device names (`CON`, `NUL`,
   `COM1`…); `fitBaseFilename()` keeps paths under MAX_PATH (260) by truncating
   and appending `[videoId]`. Any new filename construction must go through
   these helpers.
5. **`partial_file_path` must always point at a real `.part` file or NULL.**
   Storing a completed path there makes the corrupt-handler delete good files
   (that was a real bug). Keep it in sync: set on failure, NULL on success.
6. **Never re-queue permanent errors.** `isPermanentDownloadError()` gates the
   sweep; bypassing it causes infinite retry loops against dead videos.
   YouTube **n-challenge** failures (`n challenge solving failed`, missing JS
   runtime) are *not* permanent even when the same stderr also says
   `Requested format is not available` — that text is a symptom of the unsolved
   player JS. `isNChallengeError()` wins (and is checked before the reason
   table, but *after* the `[terminal]` marker: only the terminal path writes
   that, and it never writes it for an n-challenge failure). Widening the
   patterns is cheap; **narrowing** them is how the retry loop comes back — every
   wording that fails to classify falls into the transient budget, parks as
   `failed`, and is re-queued by the cooldown sweep forever.
7. **`bun:sqlite` specifics.** `MAX(a,b)` is the scalar two-arg form; use
   `COALESCE` before it. `datetime('now', '-N minutes')` modifiers must be
   built from validated integers, never user text. Open read-only handles
   (`new Database(path, { readonly: true })`) when inspecting a live DB.
8. **Progress updates are throttled to 500ms** and go straight to SQLite —
   keep DB writes inside the progress loop cheap.
9. **Don't add blocking work to the worker claim path.** Long operations belong
   inside the try-block after a claim, or the whole pool stalls.
10. **TUI vs piped output.** `dashboard.ts` no-ops when `isTty()` is false;
    log lines must remain parseable when stdout is a pipe (integration tests
    rely on this).
11. **Backwards compatibility.** Existing users have `archive.db` files from
    older versions. New columns go through `ensureColumn()`; never assume a
    fresh schema. The legacy-migration test in `tests/db.test.ts` is the guard.
12. **`--downloader-args` value is one argv element.** The engine builds
    `aria2c:-x 16 -s 16 -j 16` as a single string and yt-dlp shlex-splits the
    text after `aria2c:` itself. **No inner quotes** — they survive argv on
    Windows, the whole list becomes one shlex token, and aria2c rejects `-x`
    with exit 28 before transferring a byte (the BAD_DOWNLOADER_ARGS pause).
    Splitting it into separate argv entries breaks parsing too (the mock
    yt-dlp in `tests/mocks/` strips the `aria2c:` prefix — keep that in sync
    if you change the format).
14. **Never `unlink()` a partial directly.** With aria2c a partial is two files
    (`.part` + `.part.aria2`); use `removePartialFiles()` or the next attempt
    wedges forever. `tests/reconcile.test.ts` and the "exhausting the resume
    budget" integration scenario both fail if this regresses — the latter was
    verified to fail against the old single-file unlink.
15. **The web server must read the live config.** `startWebServer()` captures a
    `Config` reference, and `setConfig()` *replaces* the object rather than
    mutating it — so passing the captured reference into `handleRequest()` makes
    every endpoint report stale values after a settings change. The fetch
    handler passes `getConfig()`; keep it that way. The "reliability endpoint
    reflects the new values" test in `tests/settings.test.ts` is the guard.
16. **Workers re-read the config each loop iteration** (`config = getConfig()`
    at the top of the while loop). That one line is what makes dashboard
    settings changes take effect without a restart — the parameter is only the
    initial value. Don't "optimise" it away by hoisting the read.
17. **New yt-dlp flags belong in `buildDownloadPlan`.** The download worker
    passes the URL first and the plan's args after it, so the mock's URL
    detection (`argv[0]`) depends on that ordering.
18. **One instance per `archive.db` — the LEASE is the lock.** `main()` takes
    the engine lease (`src/lease.ts`) right after `initDatabase()` and before
    the port and before every sweep: a live foreign owner (a different
    `webPort` proves nothing) means exit 1 with no job row touched. Anything
    that mutates job state must stay after `acquireEngineLease()` in the
    startup order, and every sweep that rewrites claims must be gated on
    `holdsEngineLease()` (`reconcileCrashedJobs`, `reapStaleClaims` and the
    shutdown reset all are). A crashed owner is taken over immediately when its
    PID is provably gone, otherwise once the lease expires; every takeover
    increments `fencing`.
19. **`removePartialFiles` removes the `.aria2` control file FIRST and
    reports a `fatal` result when it is locked** (orphaned aria2c, antivirus).
    Never delete the `.part` after a fatal — that strands the control file and
    wedges aria2c. "Restart from scratch" paths must check `.fatal` and retry
    later instead: that is EVERY cleanup path, not just the corrupt-partial
    handler. `cleanOrphanedFiles` counts only real removals (`{removed, locked}`
    — a locked pair must never be reported as cleaned while it is still on
    disk) and `reapStaleClaims` sweeps the stranded control files of reclaimed
    downloads through the same function, reporting locks for the next tick.
    Also note a `.ytdl` resume point is a *directory* of fragments: a bare
    `unlink` fails on it (EISDIR), so removal recurses and reports honestly.
20. **The converter guards every destructive step with
    `stillOwnsConversion`** (source delete, EACH move inside
    `moveToSecondaryStorage`, the final done-update) and updates `file_path`
    to the converted output BEFORE unlinking the source. Deleting first is what
    made a crash in the finalize window look like "file deleted before
    conversion finished" and triggered a full re-download on the next startup
    sweep. The secondary-storage move is copy-then-unlink, never
    unlink-after-a-swallowed-error: a failed copy keeps BOTH copies (a
    duplicate is recoverable, a lost file is not) and a media move that cannot
    complete throws so the job retries instead of being marked done against a
    path that does not exist. The sidecar order inside that move is PINNED
    (the video's own `<base><suffix>` files first, then the language-tagged
    derivatives): `readdir` order is filesystem-defined (NTFS sorts names,
    ext4 hashes them), and a stopped move must stop at the same step on every
    machine — `tests/convert-storage.test.ts` asserts exactly which file moved
    before ownership was lost.
21. **API routes live in the `ROUTES` table in `web.ts`.** Static action paths
    (`/api/jobs/pause`) must be listed before `:param` routes so a wrong
    method answers 405 instead of binding the segment as an id. Legacy aliases
    (`/api/retry/:id`, `/api/failcount/reset/:id`, `POST /api/jobs/delete`)
    are kept on purpose — older dashboards and scripts bookmark them.
22. **Never call `statfs` directly — go through `resilience.ts diskUsage()`.**
    The statfs-missing / PowerShell / `-1/-1` chain is testable through the
    `DiskProbeOptions` argument (`statfs: null`, `platform`, `pathExists`,
    `runPowerShell`, `timeoutMs`) — do not remove it, or the degraded branches
    become unreachable off a broken Windows box. Some Bun builds for Windows do
    not implement statfs, so the import is
    `undefined` and *calling* it throws a `TypeError` **synchronously** — a
    `.catch()` chained on the call cannot see it, and the whole request 500s
    (that is how `/api/status` used to blank the dashboard). `diskUsage()`
    catches the synchronous throw, falls back to PowerShell `Get-PSDrive` on
    win32, and returns `-1/-1` + an `error` string so callers degrade instead
    of failing. `tests/disk.test.ts` is the guard. A related rule: `driveLetterOf`
    answers only for an explicit `X:` prefix and must never `resolve()` first —
    on Windows that would turn every relative path (and every POSIX-style
    `/tmp/...`) into the current drive's letter, i.e. a guessed volume reported
    as a measured one. `windowsDiskUsage` resolves a drive-less path against the
    run directory itself when it needs the letter.
23. **The mocks' orphan watchdogs do not work on Windows** (`process.ppid`
    never changes there). See 9.3 — crash-recovery scenarios that depend on an
    orphan abandoning its transfer are POSIX-only until the harness kills the
    process tree itself.
24. **Keep the three claim queries mutually exclusive.** `claimDownloadJob`
    excludes jobs whose `conversion_status` or `metadata_status` is
    `in_progress`; `claimMetadataJob` excludes `conversion_status =
    'in_progress'`. One job row, one file on disk, three pools — a download
    claimed mid-conversion writes over the file being converted. Note the
    parenthesised `OR` in the download claim: an exclusion added *outside* the
    parens binds only to the paused branch. `tests/db.test.ts` "pipeline claim
    exclusion" is the guard.
25. **yt-dlp gets the resolved aria2c *path*, not the bare name.** Discovery
    searches the app folder, the compiled exe's folder and the
    winget/scoop/chocolatey shims — none of which are guaranteed to be on the
    child process's PATH, so `--downloader aria2c` can fail with "aria2c not
    found" on a machine where the engine just probed the binary successfully.
    `buildDownloadPlan` emits `--downloader <aria2cBinary>`; the mock yt-dlp
    matches the basename, so keep that regex if you change the flag.
26. **Never pass arbitrary subprocess output to filesystem APIs.** Bun 1.3.14
    on Windows can panic in `existsSync` → `toWPathMaybeDir` on an oversized
    string (native panic, not catchable JS). `download-output.ts` splits CR as
    well as LF, drops oversized records in full, preserves split UTF-8, and
    retains only bounded diagnostic tails. Only explicit `FILEPATH:` records
    passing its length/control-character checks may be probed; directory
    fallback still recovers the expected media if the marker is missing.
27. **Source lists are runtime data in `config.json`, not TypeScript defaults.**
    `/api/scan` validates and saves the source via `sources.ts saveSource()`
    BEFORE scanning; an empty scan or zero new jobs must not lose the URL.
    Source saves and `/api/settings` share `withConfigWriteLock()`; read the
    latest `getConfig()` INSIDE that lock and publish only after a successful
    atomic save. Never hold the lock over the slow yt-dlp scan. RSS/daemon
    timers read live sources each tick and start even with empty lists; full
    rescans include `playlists` as well as both channel lists. Optional scan
    folder overrides remain per-job/per-scan, not source-level configuration.
28. **Compare on-disk paths with `reconcile.ts pathKey()`, never with `===`.**
    The DB stores `partial_file_path`/`superseded_file` as absolute `resolve()`d
    paths, while `cleanOrphanedFiles` builds its paths from
    `readdir(outputRoot)` — relative whenever `outputRoot` is the default
    `./downloads`. A raw string compare silently misses, and a tracked partial
    gets deleted as a day-old "orphan". `pathKey` resolves and case-folds on
    Windows; build the walk paths with `resolve(rootDir, file)` too.
29. **A partial is only aged out when nothing will resume it.** The day/week
    thresholds (`ORPHAN_PARTIAL_MAX_AGE_MS`/`PARTIAL_MAX_AGE_MS`) must skip
    `pending`/`downloading`/`paused`/`waiting_live` owners and cooldown-waiting
    failures — the sweep exists to clear litter, not to throw away hours of
    transfer because an operator paused a job for a month.
30. **`stashDownloadedFile` writes the DB row BEFORE the rename.** Never
    restore the old rename-first order: a crash in that window leaves the media
    at `<file>.superseded` with no row pointing at it, and
    `reconcileSupersededFiles()` (startup, right before
    `reconcileMissingFiles`) can then only recover it through the legacy
    sibling probe. Any lookup for a job's file on disk must also use
    `jobFittedBaseFilename()` — `fitBaseFilename` truncation means the raw
    title is not the name on disk.
31. **Every claim write is a CAS on the claim token — never a bare
    `WHERE id = ?`.** Worker ids repeat across processes, so only
    `*_claim_token` identifies the claim: use `updateClaimedJob` /
    `releaseClaimedJob` (they append `AND <stage>_claim_token IS ? AND
    <stage>_claimed_by IS ?`) and check the changed-row count — **1** means the
    update landed, **0** means ownership was lost and the worker must not touch
    job state (no status change, no `stats.*`, no failure counters). The same
    applies to updates that keep the claim (progress, audio probe) and to the
    reaper (`reapStaleClaim` adds the expired-heartbeat predicate so a renewed
    claim survives the race). `*_claimed_by`/`*_claimed_at` are display/legacy
    data; `reconcileCrashedJobs` clears all four columns per stage, and that is
    what fences a previous engine's stranded workers out.
32. **Staleness is measured from the claim's HEARTBEAT — not `updated_at`, and
    not the claim's start time.** A conversion or metadata pass renews its lease
    on an interval while it runs, so a three-hour encode is not "stale"; a dead
    worker stops renewing and ages out on schedule. Never write a stale-claim
    query with its own timestamp logic — use `staleClaimCondition(stage,
    modifier)` (`reconcile.ts`); the reaper and the `/api/reliability` panel
    share it. Keep the heartbeat interval well inside the stage's window
    (`startClaimHeartbeat`, default 30 s, `YTA_CLAIM_HEARTBEAT_MS` as the
    test-only override; the tightest window is metadata's 15 min).
33. **A claim is released in the same statement that records the outcome — so the
    heartbeat outlives it by design.** `releaseOwned` (failure paths),
    `recordSuccess` and the pause parks all clear the claim, and the worker then
    keeps sleeping for the backoff inside the try-block, so the timer ticks
    against a dead lease on purpose. That is why `startClaimHeartbeat`'s `onLost`
    is **one-shot**: a per-tick report printed "download claim lost — the next
    update will not land" every 30 s for every retrying video (four stuck videos
    ≈ 100 alarming lines an hour) and pushed real errors out of error.log's
    retained tail. Keep the one-shot when adding a stage, and never write job
    state from an `onLost` callback: the lease is gone, so the row belongs to
    somebody else.
34. **Job ids are untrusted when rendered into `web_ui.html`.** Keep ids in
    escaped `data-job-id`/`data-id` attributes and read them with `dataset` from
    static inline handlers; never interpolate an id into JavaScript source or
    an HTML attribute unescaped. Encode ids with `encodeURIComponent()` in URL
    paths. `matchRoute()` must treat malformed percent-escapes as a 404, not a
    thrown request-handler error.
35. **Cookie-authenticated mutations need same-origin checks.** `isSameOriginMutation`
    rejects cross-origin `Origin` and `Sec-Fetch-Site: cross-site` for POST/PUT/
    PATCH/DELETE before every route, but deliberately permits requests with no
    Origin and no cross-site Fetch Metadata signal so CLI/scripts keep working.
    The browser login exchanges the secret with same-origin POST `/api/auth`; do
    not put tokens in URLs. `?token=` is
    retained only for compatibility. Keep `tests/webauth.test.ts` and
    `tests/web-routes.test.ts` aligned with this policy.
36. **A successful empty scan is not a failed scan.** `getPlaylistItems()` returns
    `[]` only when yt-dlp exits 0 with no entries; nonzero exits include bounded
    stderr context and throw, and a flat scan is killed after its timeout. This
    distinction keeps `/api/scan` from reporting a network/auth/tool failure as
    "No videos found". Drain both child pipes concurrently and reap timed-out
    subprocesses.
37. **Fatal process events must end in nonzero shutdown.** `unhandledRejection`
    and `uncaughtException` log the fatal detail, call `handleShutdown(..., 1)`,
    stop workers/processes, preserve resumable state only while holding the
    engine lease, and finally exit nonzero. Keep cleanup in `finally`; the
    signal path still exits 0 on a clean shutdown.
38. **Use process timeouts and cleanup on every external-tool path.** The metadata
    stage drains stdout/stderr concurrently and kills/reaps a child if reading
    fails or the 10-minute watchdog fires; a child must not outlive a released
    claim. Preserve those bounded-process guarantees when adding a new stage.
39. **Offline mode gates at CLAIM time, never by rewriting job state.**
    `workers/download.ts` and `workers/metadata.ts` return to idle BEFORE
    `claimDownloadJob`/`claimMetadataJob` — no status is written, so a queued job
    resumes exactly where it stood when the mode ends. Never "solve" offline mode
    by pausing, skipping or failing the queue (that is work the operator cannot
    get back), and never let a new network call bypass the guard: scans, RSS,
    rescans, cookie validation, the network monitor and the audio-track probe all
    check `config.offlineMode` too.
40. **The relocation pass has no claim token because it must not need one.**
    Three things make that safe, and all three are load-bearing: the engine lease
    (one engine per `archive.db`), `passInFlight` in `relocate.ts` (one pass per
    process — `relocationTick` also refuses to run while paused or without the
    lease), and stepwise idempotence (`isPathInside` → nothing to do;
    `jobAwaitingRelocation()` re-checked before EVERY destructive step; the final
    update CAS'd on the old `file_path`). Anything that adds a second mover — a
    worker pool, an unguarded interval, a bypass that skips the re-check — breaks
    the assumption and can double-copy onto one destination. Anything that resets
    `file_path` to a file in the output tree (a re-download: see `recordSuccess`)
    must clear `relocated_to` in the same statement, or the pass will never
    revisit it.
41. **The dashboard reads response keys by name, so a key rename is a UI
    regression.** `web_ui.html` cannot import anything from `src/web.ts`, and a
    miss on a key name is silent by shape: `data.stats.completed` is
    `undefined`, not an error. What is *not* silent is a container: handing the
    `{ ok, jobs }` envelope to a function that expects the array throws inside
    the poll cycle, `fetchStatus`'s `catch` logs one line to a browser console
    nobody watches, and the job table stays empty while the engine keeps
    downloading — "no jobs in the Web UI" with a healthy terminal. So: unwrap
    the envelope at the boundary (one `loadJobs()`, not four call sites), map
    `jobStatus` onto the columns the DB really writes (`downloaded`,
    `waiting_live`, `in_progress` — not `done`), and treat `/api/status` as
    stats + top-level fields (speed, ETA, workers, disk, `isPaused`) with
    `/api/reliability` as its own request. `tests/web-ui-contract.test.ts` runs
    the page's real script against `handleRequest` and fails on a blank table,
    an `undefined` card, or a `/api/…` path the route table no longer has;
    keep it green when adding a dashboard field.

---

## 11. Common tasks

| Task | Where |
| --- | --- |
| Add a config key | `src/config.ts` (schema + defaults) → `update_config.ts` prompt → test (coverage guard: `tests/config-manager.test.ts`) |
| Add a failure class | `src/retry.ts` classifier → `src/workers/download.ts` handler branch → unit test |
| Add an API endpoint | `src/web.ts` `ROUTES` table (after the auth gate; pattern `:params`, `{ok}` envelope) → `web_ui.html` caller |
| Add a dashboard field | `src/web.ts` response → `web_ui.html` render function |
| Change claim semantics | `src/db.ts` claim transactions + claim-lease primitives (`updateClaimedJob` / `releaseClaimedJob` / `heartbeatClaim`) → `tests/db.test.ts` (atomicity) + `tests/claim-races.test.ts` (two connections / two processes) |
| Change engine ownership | `src/lease.ts` (acquisition/renewal/release/fencing) → `tests/engine-lease.test.ts` → the same-database integration scenario in `tests/integration.test.ts` |
| Add a sweep | `src/reconcile.ts` (pure-ish, take `Config`) → register interval in `src/engine.ts` |
| Change offline mode | `src/config.ts` (`offlineMode` + `offlineOverrideFromRuntime`) → guards in `src/engine.ts` / `workers/download.ts` / `workers/metadata.ts` → `tests/offline-mode.test.ts` + the offline scenario in `tests/integration.test.ts` |
| Change relocation | `src/relocate.ts` (+ the `RELOCATION_WHERE` predicate and `relocated_to` in `src/db.ts`, written by `workers/convert.ts finalizeConversion` and `workers/download.ts recordSuccess`) → `tests/offline-mode.test.ts` |
| Add a worker | `src/workers/<name>.ts` → claim fn in `db.ts` → `supervise()` in `engine.ts` → TUI line in `dashboard.ts` |
| Support a new site/URL shape | `src/sources.ts parseSourceUrl()` (Web UI validation/source identity) + `src/scanner.ts normalizeVideoUrl()` (job URL canonicalization) |
| Probe the OS (disk space, …) | `src/resilience.ts diskUsage()` — statfs + PowerShell fallback + degraded mode in one place; never call `statfs` directly (gotcha 22) |

## 12. Definition of done

- `bun run check` passes (strict typecheck + the complete test suite under `tests/`).
- New pure logic has unit tests; new engine behavior has an integration scenario.
- No new import cycles; `state.ts` stays dependency-free.
- Config changes are backwards compatible (defaults merge + `ensureColumn`).
- `README.md` updated if user-visible behavior or settings changed.
