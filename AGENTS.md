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
bun run start          # run the engine (reads ./config.json, creates it if absent)
bun run config         # interactive config manager (TTY)
bun run typecheck      # tsc --noEmit
bun test               # full suite: unit + end-to-end (~45s, no network needed)
bun run check          # typecheck + tests
bun run build:win      # cross-compile dist/youtube-archive.exe (Windows)
                         start-archive.bat runs it from dist\ first, then the
                         app folder, then falls back to `bun run`
```

Runtime requirements: `yt-dlp` and `ffmpeg` on `PATH` (or `ytDlpPath` /
`ffmpegPath` in config). `checkDependencies()` probes them **before** the
database opens and exits with install hints if missing.

**Sandbox note:** YouTube is unreachable from this environment. The test suite
therefore runs the real engine against mock binaries (`tests/mocks/`) — see
section 9. Do not "fix" failing integration tests by adding network calls.
**Windows note:** the mocks are shebang scripts, and Windows neither reads
shebangs nor spawns extensionless files, so the integration harness compiles
them into real executables with `bun build --compile` (cached per run, a few
seconds once) and pins every tool path in the engine's config to the mocks —
bare-name PATH discovery could otherwise pick up real yt-dlp/ffmpeg/aria2c
installed on the machine. Two more Windows facts the code already accounts for:
some Bun builds for Windows do not implement `statfs` at all (see gotcha 22 —
go through `diskUsage()`), and Windows does not reparent orphans, so the mocks'
`process.ppid` watchdogs are inert there (see 9.3).

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
  db.ts          SQLite schema, migrations, atomic claim transactions, helpers
  state.ts       shared mutable runtime state (leaf module — imports nothing)
  tools.ts       yt-dlp/ffmpeg/aria2c discovery, cookiesArgs, validateCookies
  download-args.ts PURE yt-dlp command construction (downloader engine, tuning)
  download-output.ts bounded pipe decoding + validated FILEPATH records (no fs calls)
  audio-tracks.ts PURE multi-audio track parsing/selection + the yt-dlp -J probe
  settings.ts    dashboard-editable config allow-list + validate/persist/apply
  retry.ts       PURE retry policy: backoff, watchdog, error classification
  resilience.ts  pause/resume, circuit breaker, network + disk guards (diskUsage = the only statfs caller)
  reconcile.ts   self-healing sweeps (crashes, stale claims, missing files, failed jobs) + partial-file housekeeping
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
resilience.ts → config, db, logger, state       │
reconcile.ts → archive, config, db, download-args, logger, retry, state, tools│
sources.ts → config, state                     │
scanner.ts → config, db, state, tools, util     │
autoscale.ts → db, state                        │
dashboard.ts → autoscale, config, db, state, util│
report.ts → autoscale, db, state, util          │
download-args.ts → audio-tracks, config, db (types), download-output, retry, tools, util    │ (pure)
web.ts → audio-tracks, autoscale, config, db, download-args, logger, reconcile, report, resilience, retry, scanner, sources, state, tools, util
rss.ts → config, logger, scanner, state, tools   │
polling.ts → config, logger, scanner, state     │
history.ts → db, logger, state                  │
lifecycle.ts → dashboard, db, history, logger, resilience, state
workers/* → config, dashboard, db, download-args, download-output, logger, resilience, retry, state, tools, util (+ autoscale/archive/reconcile; download.ts also audio-tracks)
engine.ts → everything (composition root)
```

**Rule:** if you need a new shared behavior, put it in a leaf module and inject
it. Workers must never import `engine.ts`, and `state.ts` must stay
dependency-free — it is the module that breaks every import cycle.

### Startup order (engine.ts `main()`)

1. `loadConfig()` → `setConfig()` (must be first: dependency search uses paths from it)
2. `checkDependencies()` — fails fast with install hints
3. `initDatabase("archive.db")` — schema + migrations + claim transactions
4. `startWebServer()` — **before any sweep: the web port is the single-instance
   lock**. A second instance (autostart task + a manual start) dies here with an
   actionable error instead of re-queueing a live instance's in-flight work.
5. `reconcileCrashedJobs()` → `reconcileMissingFiles()` (the latter skips jobs
   with a conversion in progress — the converter legitimately has those files
   in mid-transition under `deleteSourceAfterConvert`)
6. `startRunHistory()` + heartbeat interval
7. `mkdir(outputRoot)` → `cleanOrphanedFiles()` → `autoscaler.init()`
8. cookie validation (if enabled)
9. scan every configured playlist/channel into the jobs table
10. `initDashboard()`
11. `networkMonitor()`, `reapStaleClaims` (60s), `autoscaleTick` (15s),
    `requeueFailedJobs` (60s), `cookiesWatch` (60s), `startRssPolling()`
12. supervised worker pools (download × N, metadata × N, convert × N)
13. `startAutonomousPolling()` if daemon mode

---

## 4. Data model

### The `jobs` table (one row per video, keyed by YouTube video id)

| Field | Meaning |
| --- | --- |
| `id` | YouTube video id (primary key → natural dedupe) |
| `url` | canonical `https://www.youtube.com/watch?v=<id>` |
| `title`, `folder`, `index` | display name, output folder, `001`-style ordering |
| `output_directory` | absolute-ish path where files land |
| `target_format` | `mp4` or `mp3` |
| `want_subtitles` / `want_thumbnail` / `want_description` | 0/1 sidecar flags |
| `duration` | seconds from the listing (drives the watchdog) |
| `download_status` | `pending` \| `downloading` \| `downloaded` \| `paused` \| `failed` \| `waiting_live` |
| `conversion_status` | `pending` \| `in_progress` \| `done` \| `failed` \| `not_needed` |
| `metadata_status` | `pending` \| `in_progress` \| `done` \| `failed` \| `not_needed` |
| `pause_reason` | `user` \| `interrupted` \| `waiting_live` \| NULL |
| `*_claimed_by` / `*_claimed_at` | worker id + timestamp of the atomic claim |
| `retry_count` | no-progress download failures in the current retry window |
| `conversion_retry_count`, `metadata_retry_count` | per-stage attempt budgets |
| `resume_count` | `--continue` resumes spent for this job |
| `best_progress` | high-water mark of progress % (drives budget forgiveness) |
| `partial_file_path` | the `.part` file to resume from (NULL once complete); always absolute, so it resolves from any cwd |
| `file_path`, `file_size`, `integrity` | final location + SHA-256 |
| `audio_tracks` | JSON array of discovered audio tracks (null = not probed yet) |
| `audio_selection` | JSON array of per-job language codes (null = follow the global multi-audio mode) |
| `superseded_file` | backup path of the previous media file while a deliberate re-download runs (see §7.2) |
| `progress`, `speed`, `eta` | live values for the dashboard |
| `last_error` | last failure message (classified by `retry.ts`) |

Other tables: `playlist_state(folder, next_index)`,
`run_history(id, started_at, ended_at, duration_seconds, downloaded, skipped, failed, total_queued)`.

### State machine

```
ingest ──► pending ──claim──► downloading ──success──► downloaded
              ▲                    │
              │                    ├─ transient ──► pending (keep .part, backoff)
              │                    ├─ corrupt ────► pending (resume_count++, .part kept)
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
| Transient vs permanent errors | `retry.ts isTransientDownloadError / isPermanentDownloadError` | permanent = private/removed/age-gated/geo-blocked/404/410/copyright |
| Bad downloader arguments | `retry.ts isDownloaderArgsError` → pause in `workers/download.ts` | aria2c exit 28 + option help block; parks the job, pauses the engine (`BAD_DOWNLOADER_ARGS`) |
| Retry-budget forgiveness | `workers/download.ts handleDownloadFailure()` + `retry.ts progressAwareRetryState()` | `retry_count` only increments when `progress <= best_progress`; `best_progress` is committed at a failure boundary, not every progress update |
| Resume budget | `workers/download.ts` corrupt branch | `.part` kept until `resume_count >= maxResumeAttempts`, then discarded |
| Partial-file bookkeeping | `workers/download.ts` + `reconcile.ts findPartialFile()` | recorded on failure, cleared on success |
| Partial-path freeze | `reconcile.ts recordJobPartial() / recordPartialPaths()` | records the on-disk `.part` before a job stops being `downloading`, so a paused/interrupted job really resumes instead of restarting |
| Pause bookkeeping | `workers/download.ts parkPaused()` | parks an in-flight job as `paused` **and** freezes its partial path |
| Circuit breaker | `resilience.ts notePipelineFailure()` | N consecutive failures per stage pauses the engine (`TOO_MANY_FAILURES`) |
| Pause / resume | `resilience.ts triggerPause / triggerResume` | SIGINTs child yt-dlp; resume re-queues paused jobs |
| Network monitor | `resilience.ts networkMonitor()` | probes 3 hosts, pauses after 2 consecutive failures |
| Cookies watcher | `reconcile.ts cookiesWatch()` + `tools.ts detectCookiesChange()` | 60s sweep: reports cookies.txt appearing / changing / vanishing mid-run and counts the credential-blocked jobs it may rescue (never auto-requeues them) |
| Disk guard | `resilience.ts diskUsage()` → `checkDiskSpace()` | `diskUsage` is the **only** `statfs` caller: statfs → PowerShell `Get-PSDrive` fallback → `-1/-1` degraded mode (never bricks the engine, never 500s `/api/status`) |
| Crash recovery | `reconcile.ts reconcileCrashedJobs()` | `downloading` → `paused + interrupted` (auto-claimable); also clears orphan claims from legacy user-paused downloads while keeping them held |
| Stale-claim reaper | `reconcile.ts reapStaleClaims(config)` | downloads idle >`max(20 min, maxDownloadMinutes)` (actively owned jobs are protected and progress heartbeats the claim), conversions >3 h, metadata >15 min; thresholds come from `STALE_CLAIM_THRESHOLDS(config)` so the dashboard cannot drift from them |
| Missing-file reconciliation | `reconcile.ts reconcileMissingFiles()` | scrubs the yt-dlp archive + re-queues |
| Failed-job sweep | `reconcile.ts requeueFailedJobs()` | after cooldown, non-permanent failures start a fresh per-video retry window; permanent download errors are skipped; `ignoreCooldown` for the UI button |
| Partial-file cleanup | `reconcile.ts cleanOrphanedFiles()` | keeps resume-able partials, including retryable failures waiting for cooldown; deletes exhausted partials when auto-requeue is disabled and day-old orphans |
| Archive scrubbing | `archive.ts removeFromArchive()` | needed whenever a file disappears, else yt-dlp skips it forever |
| Signature self-heal | `workers/download.ts` | auto-runs `yt-dlp -U` and retries with a clean budget |
| WAL checkpoint | `lifecycle.ts handleShutdown()` | keeps `archive.db` self-contained after exit |

**Adding a new failure class:** extend the classifiers in `retry.ts` (pure,
unit-tested), then handle it in `workers/download.ts handleDownloadFailure()`
in the right precedence order: signature → downloader-args → corrupt →
archive-scrub → live → permanent → transient/other retryable budget.

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
- **Adding a key:** add to `ConfigSchema`, add to `DEFAULT_CONFIG`, add a prompt
  to `update_config.ts` (menu 4 = download settings, menu 6 = reliability), and
  add a test in `tests/config.test.ts`. `tests/config-manager.test.ts` asserts
  every schema key is reachable from the manager, so an un-prompted key fails
  the suite rather than becoming hand-edit-only.
- `update_config.ts` prompts for the download root, cookies, and the Shorts
  toggles, and its reliability screen reads live resume state from the archive
  database (read-only, best-effort — a locked or absent DB must never stop the
  manager) plus the sweep thresholds from `STALE_CLAIM_THRESHOLDS`.

Reliability keys: `maxResumeAttempts`, `retryBackoffBaseSeconds`,
`retryBackoffMaxSeconds`, `requeueFailedAfterMinutes`, `verifyExistingFiles`,
`downloadTimeoutMinutes`, `maxDownloadMinutes`.

Performance keys: `useAria2c`, `connectionsPerDownload`, `minSplitSize`,
`concurrentFragments`, `fragmentRetries`, `httpChunkSize`, `bufferSize`,
`autoscaleRampStep`. See section 7.1 for how they reach yt-dlp.

### 7.1 How downloads actually reach yt-dlp (`src/download-args.ts`)

`buildDownloadPlan({ job, config, activeSlots, aria2cAvailable })` is the single
place that builds the yt-dlp argv. It is pure and unit-tested — add new flags
there, not in the worker. What it emits today:

- `--downloader aria2c --downloader-args aria2c:"-x N -s N -j N"` when aria2c is
  installed and `useAria2c` is true. yt-dlp's own baseline is
  `-x16 -s16 -j16 --min-split-size 1M`, so `minSplitSize` is only emitted when
  it differs from `1M`. The value is shlex-parsed by yt-dlp, so the whole list
  is quoted and passed as ONE argv element.
- `--limit-rate NK` when a cap is configured. yt-dlp maps this onto the external
  downloader's own rate-limit flag (`aria2c --max-overall-download-limit`), so
  the cap works on both engines. The value is the global cap divided by the
  active slot count, floored at 64 KB/s.
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
- `workers/convert.ts countAudioStreams()` keeps files with 2+ audio streams in
  their container (remuxing an MKV to mp4 would drop/re-encode the dubs).

Dashboard: `/api/jobs` returns `audio_tracks` / `audio_selection` as parsed
arrays; `POST /api/jobs/<id>/audio-probe` refreshes the list;
`POST /api/jobs/<id>/audio-tracks` saves (`{tracks:[…]}`) or resets
(`{tracks:null}`) the per-job selection, applied on the next attempt. The job
drawer offers "Save & re-download" for finished videos: save + immediate retry.

#### Re-downloading an archived video (retry = replace)

Retrying a downloaded job — the flow that applies a saved audio selection —
must get past two yt-dlp gates, and the engine does both in `retryJobById`
(web.ts) **before** the job becomes claimable:

1. `removeFromArchive()` scrubs the id from the archive file, otherwise yt-dlp
   answers *"has already been recorded in the archive"* and exits 0 without
   downloading anything (the old silent no-op bug).
2. `stashDownloadedFile()` (reconcile.ts) renames the existing media file to
   `<file>.superseded`, because `--no-overwrites` skips a download whose
   target file still exists. The job's `file_path` is cleared and the backup
   path recorded in `superseded_file`.

The backup is the safety net: the download worker deletes it on success
(`dropSupersededFile`) and — if the re-download fails permanently — restores
it and marks the job downloaded again (`restoreSupersededFile`), so a failed
re-fetch never destroys the previously archived file. A rename failure aborts
the retry with a 500 instead of starting a download yt-dlp would skip.

#### Stale audio formats recover instead of parking the job

`retry.ts isFormatAvailabilityError()` matches yt-dlp's *"Requested format is
not available"* — which `isPermanentDownloadError` ALSO matches. The download
worker checks it FIRST: when a job carried stored `audio_tracks`, YouTube has
most likely renumbered its formats since the probe, so the worker clears
`audio_tracks` (forcing a fresh probe; the per-job language selection
survives) and retries within the normal budget instead of parking the job
permanently. Only jobs with no multi-audio state fall through to the
permanent-error classification.

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

Job retry, delete, queue purge, and per-job pause mutations must check all
pipeline stages and claims inside an immediate SQLite transaction (`withIdleJobs()`
for id-based operations). If any targeted row is downloading, converting, fetching
metadata, or still holds a download/conversion claim, return HTTP 409 with
`{ok:false, error:"job is in progress"}` and make no partial bulk changes.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | dashboard (login page when a token is required) |
| GET · HEAD | `/api/ping` | liveness probe used by the UI |
| GET | `/api/version` | engine/runtime info (`Bun.version`, platform/arch, uptime seconds) |
| GET | `/api/status` | stats, speed, ETA, disk, live worker lines, pause state, `runtime`; `diskSpace.free` reads `"unknown"` when no disk probe could answer |
| GET | `/api/jobs` | up to 500 jobs with status/retry/progress fields, plus parsed `audio_tracks` / `audio_selection` / `metadata_files` and boolean `want_*` sidecar flags |
| GET | `/api/jobs/:id` | one job, read fresh from the DB — the detail drawer fetches this instead of trusting a poll-cycle-old list row |
| POST | `/api/scan` | `{url, folder?}` → validate/canonicalize → save source to `config.json` → scan & ingest; returns `saved`, `source: {url, key, added}`, and counts. Save failure starts no scan; scan failure keeps the saved source. Folder override applies only to this scan |
| POST | `/api/queue/purge` | delete every idle pending / paused / waiting_live / failed job; returns `{ok, deleted}` or 409 if any candidate still holds an active claim |
| POST | `/api/pause` · `/api/resume` | global pause / resume-all |
| POST | `/api/jobs/:id/retry` | re-queue one idle job (all stages, budgets reset); 404 for an unknown id, 409 while any pipeline stage/claim is active. For a downloaded job this is a deliberate re-download: the id is scrubbed from the yt-dlp archive and the existing file stashed as `.superseded` first (§7.2). 500 when the previous file cannot be moved aside |
| POST | `/api/jobs/:id/reset-failures` | zero the per-stage retry counters; 404 for an unknown id |
| POST | `/api/jobs/:id/sidecars` | per-job sidecar toggles: `{subtitles?, thumbnail?, description?}` (booleans). Flipping a flag on for a finished download re-opens the metadata stage so the worker fetches the files against the existing media; flipping off never deletes fetched files. 400 for an empty/non-boolean body |
| POST | `/api/jobs/pause` | bulk user-pause by `{ids: []}`; 409 and no changes if any requested job has an active stage/claim |
| DELETE | `/api/jobs` | bulk delete by `{ids: []}`; 409 and no changes if any requested job has an active stage/claim |
| POST | `/api/jobs/:id/audio-tracks` | per-job audio-track selection: `{tracks:["es",…]}` saves it, `{tracks:null}` returns the job to the global mode |
| POST | `/api/jobs/:id/audio-probe` | runs the yt-dlp `-J` probe for one job, stores + returns its audio tracks |
| DELETE | `/api/jobs/:id` | delete one idle job; 409 while any pipeline stage/claim is active |
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

---

## 9. Testing

### 9.1 Running

```bash
bun test                       # everything (~160s — the integration scenarios dominate)
bun test tests/retry.test.ts   # one file
bun run typecheck              # tsc --noEmit (tsconfig covers *.ts, src/**, tests/**)
bun run check                  # typecheck + full suite (what CI/the definition of done means)
```

310 tests across 22 files. Tests share one process, so any file that touches the
database calls `initDatabase(":memory:")` in `beforeEach` — **the module-level
`db` binding is replaced, which is exactly why it is a live ESM binding**.

### 9.2 What is covered where

| File | Focus |
| --- | --- |
| `tests/retry.test.ts` | backoff math, watchdog scaling, error classification |
| `tests/util.test.ts` | formatters, Windows filename hardening, `fitBaseFilename`, hashing |
| `tests/config.test.ts` | defaults, validation, cross-field refinements, atomic load/save |
| `tests/sources.test.ts` | URL classification, canonicalization, persisted source lists, dedup, concurrent saves/settings, validation/auth/write failures |
| `tests/db.test.ts` | schema + legacy migration, atomic claims, the pipeline claim exclusions, all reconcile/requeue sweeps, ingestion dedupe |
| `tests/cookies.test.ts` | `cookiesArgs`/`cookiesState` on a missing/empty/present file, the appeared/updated/disappeared transitions, and `cookiesWatch`'s credential-blocked count |
| `tests/rss.test.ts` | `parseRssFeed` against a realistic feed (CDATA, missing duration); timer picks up live-added channels after an empty startup |
| `tests/webauth.test.ts` | token extraction, timing-safe compare, authorization |
| `tests/report.test.ts` | run report contents |
| `tests/download-args.test.ts` | downloader-engine selection, aria2c args, bandwidth split, fragment/chunk/buffer flags, watchdog scaling, multi-audio selector/multistream flags |
| `tests/download-output.test.ts` | bounded CR/LF pipe parsing, split UTF-8, oversized-record discard, validated final-path markers |
| `tests/audio-tracks.test.ts` | track parsing (variant collapse, drc drop, ordering), selection policy incl. per-job override, selector splicing, JSON column round-trips |
| `tests/metadata.test.ts` | `subtitleArgs` — `all`/blank keep fetch-everything, explicit language lists pass through verbatim |
| `tests/autoscale.test.ts` | slot ramp step, backlog/ceiling clamps, idle collapse, disabled mode |
| `tests/reconcile.test.ts` | `removePartialFiles` (control-file-first order and its `fatal` result), `partialSidecars`, `findPartialFile`, `cleanOrphanedFiles` control-file handling, and the superseded-file lifecycle (`stash`/`drop`/`restore` for deliberate re-downloads) |
| `tests/convert.test.ts` | `findConvertedOutput` crash-window adoption: adopts a finished mp3/mp4, never the source itself, empty for unrelated sidecars |
| `tests/logger.test.ts` | `errorLogPath()` routes test-run logs to the temp dir, never the operator's `error.log` |
| `tests/disk.test.ts` | `diskUsage()` happy path, the `-1/-1` degraded path, and `checkDiskSpace`'s allow-through when free space is unknown |
| `tests/web-routes.test.ts` | the `ROUTES` table: canonical per-job routes, the legacy aliases, JSON 404/405 + `Allow`, trailing-slash collapse, active-stage 409 guards across retry/delete/pause/purge, retry-as-re-download (archive scrub + `.superseded` stash), and per-job sidecars |
| `tests/settings.test.ts` | the dashboard settings allow-list, type coercion, Zod + cross-field validation, persistence, live-config propagation, and auth |
| `tests/config-manager.test.ts` | every schema key is reachable from `update_config.ts`; the manager reads the sweep thresholds from `STALE_CLAIM_THRESHOLDS` and counts partials with the engine's predicate |
| `tests/dashboard.test.ts` | `formatHeaderLine` counters, and the `Res:n` field appearing only when partials are held |
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
downloads (args + cap verified), the native fallback when aria2c is missing,
aria2c option validation (`-x` above the 16 cap is clamped; a malformed
`--min-split-size` pauses the engine with `BAD_DOWNLOADER_ARGS` instead of
failing the batch), and
four aria2c resume/self-healing scenarios: resume from the control file,
discarding a partial *with* its control file when the resume budget runs out, a
hard kill mid-transfer followed by a resume on restart, and deleted files being
re-fetched.

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
| `FAKE_ARIA2C_BIN` | absolute path of the sibling aria2c mock (set by the integration harness so that hop never depends on PATH) |
| `FAKE_ARIA2C_FAIL_TIMES=N` | fail the first N attempts *inside* aria2c, leaving the `.part` + `.part.aria2` pair |
| `FAKE_ARIA2C_FAIL_MODE` | `transient` \| `corrupt` (which aria2c-side error message to emit) |
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
18. **One instance per `archive.db`.** The web port is the lock and `main()`
    binds it before the sweeps; anything that mutates job state must stay
    after `startWebServer()` in the startup order.
19. **`removePartialFiles` removes the `.aria2` control file FIRST and
    reports a `fatal` result when it is locked** (orphaned aria2c, antivirus).
    Never delete the `.part` after a fatal — that strands the control file and
    wedges aria2c. "Restart from scratch" paths must check `.fatal` and retry
    later instead.
20. **The converter guards every destructive step with
    `stillOwnsConversion`** (source delete, secondary-storage move, the final
    done-update) and updates `file_path` to the converted output BEFORE
    unlinking the source. Deleting first is what made a crash in the
    finalize window look like "file deleted before conversion finished" and
    triggered a full re-download on the next startup sweep.
21. **API routes live in the `ROUTES` table in `web.ts`.** Static action paths
    (`/api/jobs/pause`) must be listed before `:param` routes so a wrong
    method answers 405 instead of binding the segment as an id. Legacy aliases
    (`/api/retry/:id`, `/api/failcount/reset/:id`, `POST /api/jobs/delete`)
    are kept on purpose — older dashboards and scripts bookmark them.
22. **Never call `statfs` directly — go through `resilience.ts diskUsage()`.**
    Some Bun builds for Windows do not implement it, so the import is
    `undefined` and *calling* it throws a `TypeError` **synchronously** — a
    `.catch()` chained on the call cannot see it, and the whole request 500s
    (that is how `/api/status` used to blank the dashboard). `diskUsage()`
    catches the synchronous throw, falls back to PowerShell `Get-PSDrive` on
    win32, and returns `-1/-1` + an `error` string so callers degrade instead
    of failing. `tests/disk.test.ts` is the guard.
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

---

## 11. Common tasks

| Task | Where |
| --- | --- |
| Add a config key | `src/config.ts` (schema + defaults) → `update_config.ts` prompt → test (coverage guard: `tests/config-manager.test.ts`) |
| Add a failure class | `src/retry.ts` classifier → `src/workers/download.ts` handler branch → unit test |
| Add an API endpoint | `src/web.ts` `ROUTES` table (after the auth gate; pattern `:params`, `{ok}` envelope) → `web_ui.html` caller |
| Add a dashboard field | `src/web.ts` response → `web_ui.html` render function |
| Change claim semantics | `src/db.ts` claim transactions + `tests/db.test.ts` atomicity tests |
| Add a sweep | `src/reconcile.ts` (pure-ish, take `Config`) → register interval in `src/engine.ts` |
| Add a worker | `src/workers/<name>.ts` → claim fn in `db.ts` → `supervise()` in `engine.ts` → TUI line in `dashboard.ts` |
| Support a new site/URL shape | `src/sources.ts parseSourceUrl()` (Web UI validation/source identity) + `src/scanner.ts normalizeVideoUrl()` (job URL canonicalization) |
| Probe the OS (disk space, …) | `src/resilience.ts diskUsage()` — statfs + PowerShell fallback + degraded mode in one place; never call `statfs` directly (gotcha 22) |

## 12. Definition of done

- `bun run check` passes (strict typecheck + the full suite — 310 tests across 22 files).
- New pure logic has unit tests; new engine behavior has an integration scenario.
- No new import cycles; `state.ts` stays dependency-free.
- Config changes are backwards compatible (defaults merge + `ensureColumn`).
- `README.md` updated if user-visible behavior or settings changed.
