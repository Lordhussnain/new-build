# YT Playlist Downloader

Batch YouTube playlist downloader and converter, built with Bun + TypeScript.
Feed it a list of playlist or video links and it handles fetching, format
selection, subtitle/thumbnail/description extraction, and conversion — with
a terminal UI and a web dashboard to watch it all happen.

## Features

- **Batch downloads** from a list of YouTube playlist or video URLs defined in `config.json`
- **Concurrent worker pools** for downloading, metadata fetching, and format conversion, all driven by job state in a central SQLite database
- **aria2c multi-connection downloads** — files split across up to 64 streams (16 by default) with automatic fallback to yt-dlp's native downloader when aria2c is not installed or for HLS/live streams. aria2c's own per-server connection cap (16) is clamped automatically, and a downloader argument aria2c rejects (exit 28) pauses the engine with a `BAD_DOWNLOADER_ARGS` reason instead of failing every video in the batch
- **Dashboard download-speed profiles & Turbo IDM** — one-click **Standard**, **Maximum speed**, and **Aggressive (IDM)** presets stage aria2c, fragment, chunk, buffer, User-Agent, and bandwidth settings in Downloader Settings, plus a 1-click **⚡ Turbo IDM** toggle right in the main dashboard controls (or press <kbd>t</kbd>). Aggressive (IDM) mode uses 32 connections per download (split threshold 512K), 64 native DASH/HLS fragments, 10M HTTP chunks, a 64K socket buffer, and uncapped bandwidth for maximum network utilization like Internet Download Manager. Every setting remains individually tunable.
- **Bandwidth-aware scaling** — an optional per-download rate limit is divided across active download slots; the autoscaler grows the pool while the queue has backlog and reported bandwidth headroom. Because yt-dlp limits each process independently, a slot change does not retune transfers already running, so the aggregate is best-effort during scale changes
- **Resilient by design** — interrupted downloads keep their `.part` file and resume exactly where they stopped; the retry budget only shrinks while a video makes no forward progress
- **A resume that can never finish is discarded, not retried** — when the saved partial no longer matches what the server will serve (`HTTP Error 416: Requested range not satisfiable`, or aria2c refusing a file whose control state is gone), resuming repeats the failure forever and the video sits at 99.0%. The engine deletes the `.part` **and** its `.aria2` control file, resets progress, and restarts that video from zero
- **Automatic retries** with exponential backoff + jitter on transient failures (network drops, throttling, timeouts)
- **Signature-extraction failures self-heal once** — only yt-dlp's signature/nsig decipher errors trigger `yt-dlp -U`; updater output is bounded, it has a hard timeout, concurrent requests share one update, and a failed update leaves the normal retry budget intact
- **Disk-full failures pause the engine** — ENOSPC and common Windows/POSIX “disk full” errors preserve the partial and pause all workers for operator action instead of burning retries against an unwritable drive
- **Unavailable videos are skipped, not retried** — private, deleted, members-only, age-gated, paid or geo-blocked videos are attempted **once**, classified with a plain-language reason (`Private video`, `Video unavailable`, `Not available in your region`, …), and parked as a terminal skip: no retry budget, no cooldown requeue, no `error.log` line per dead video, and no circuit-breaker trip for a whole playlist of them. The rest of the playlist keeps downloading, and the reason stays readable in the dashboard, the Failed tab, `/api/failed` and the run report
- **An unavailable format is switched, not retried** — when yt-dlp answers `Requested format is not available`, the engine steps the quality down one rung (`4k → 1440p → 1080p → 720p → 480p → highest`), persists it as that job's quality override, and says so: `🎚️ Format 1080p not available — switched to 720p`. The ladder only ever moves down, so it cannot loop, and a stale multi-audio probe is cleared and re-probed first. Only a job that fails at every rung — a video with no usable formats — is parked, with `No format available` recorded as its reason
- **Self-healing sweeps** — crashed jobs resume, stale claims are reclaimed, deleted downloads are re-fetched, and failed jobs are retried after a cooldown. With aria2c these sweeps resume from the download's `.aria2` control file, and a discarded partial always takes its control file with it
- **Resume state is protected, not aged away** — the startup sweep only deletes a `.part` once nothing will resume it: a `pending`, `paused`, or `waiting_live` job keeps its partial as long as the job exists, and a crash in the deliberate-re-download hand-off (`.superseded`) is rolled back or finished at the next start instead of leaving the old file unmanaged
- **Single-instance safety: one engine per `archive.db`** — a database-level engine lease (owner token + expiring heartbeat + monotonic fencing number) is taken before the startup sweeps, so a second engine pointed at the same database refuses to start with an actionable message even if it uses a different `webPort` — it can never re-queue the running instance's in-flight work. The lease is renewed while the engine runs, released on a clean exit, taken over automatically after a crash, and shown on the reliability panel
- **Claims are leases, not names** — every job claim carries a unique token and a heartbeat: download progress renews a download's lease, conversion and metadata stages heartbeat on an interval, and every progress, success, failure and release update must present that token (compare-and-swap). A worker that lost its claim — reaped after its lease lapsed, or superseded by a restarted engine — changes no job state instead of overwriting the new owner's
- **Locked work is never destroyed to make progress** — if a restart-from-scratch hits a partial file locked by another program (orphaned aria2c/ffmpeg, antivirus), the video is retried later with that exact reason in `last_error` instead of being wedged. The same rule holds for every sweep: a locked resume pair is kept intact and reported, never counted as cleaned, and a stranded `.aria2` control file left by a dead worker is swept before the reclaimed job retries — a control file whose data is gone makes aria2c neither resume nor restart
- **Duration-aware watchdog** — long videos are not killed by a flat 15-minute timeout
- **Disk space precheck** before starting a batch
- **Graceful shutdown** — safely stops in-flight downloads on exit
- **Terminal UI (TUI)** with live progress across all workers
- Correct format selection across VP9/AV1 containers (fixes yt-dlp/ffmpeg mismatches)
- **Multi-audio tracks** — YouTube's multi-language audio (the player's *Audio track* menu: original + auto-dubbed tracks). Keep every track, or just the languages you want, muxed into one MKV whose audio is switchable in any player — plus a per-video track picker in the dashboard
- Compatible with authenticated downloads (`--cookies`) and YouTube's n-challenge (a JS runtime — Deno, Node, or Bun — is discovered at startup and passed to yt-dlp)
- **cookies.txt is watched while the engine runs** — export it from your browser after startup (or replace it when it expires) and the next download attempt uses it; the engine logs the switch and tells you how many credential-blocked jobs it may rescue
- **Offline mode** — one switch (`offlineMode`, the dashboard's 📴 toggle, `--offline`, or `YTA_OFFLINE=1`) stops every download, scan, RSS watch and sidecar fetch, and leaves the engine doing the work that needs no network: converting files that still need conversion and moving finished files to secondary storage. Queued downloads wait untouched and start when the mode ends
- **Files that need no conversion still reach secondary storage** — a relocation pass moves finished media (sidecars included) whose conversion is already done, adopts a file a crashed run copied but never recorded, and re-relocates everything when `secondaryStoragePath` points somewhere new. It never copies a file onto itself and never overwrites a job that was re-downloaded meanwhile
- **Web dashboard** with live job status, bulk actions, failed-job recovery, a reliability panel, per-job detail, and an in-browser settings editor for the downloader

## Tech Stack

- [Bun](https://bun.sh) + TypeScript — runtime and application logic
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — video and metadata extraction
- [aria2c](https://aria2.github.io/) — optional multi-connection downloading
- [ffmpeg](https://ffmpeg.org) — format conversion

## Requirements

- Bun ≥ 1.0
- `yt-dlp` and `ffmpeg` available on `PATH` (or configured explicitly)
- [aria2c](https://aria2.github.io/) **optional** — enables multi-connection downloads; without it the engine uses yt-dlp's native downloader
- A JavaScript runtime for YouTube's n-challenge: [Deno](https://deno.com) (recommended; yt-dlp's default), Node.js ≥ 22, or Bun. The engine discovers one at startup and passes `--js-runtimes` to every yt-dlp call. Without a runtime, YouTube downloads fail with "n challenge solving failed" — that is retried, never parked as a permanent video error. See [yt-dlp EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
- Tested on Windows 11

Dependencies are checked automatically on startup; the app exits with a clear
error if anything required is missing. A missing aria2c or JS runtime is
reported as a warning and never blocks startup.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit + end-to-end suite (mocked yt-dlp/ffmpeg, no network needed)
bun run check       # both
```

The checked-in `package-lock.json` also supports reproducible npm dependency
installation with `npm ci`; Bun is still required to run the app and test suite.
Runtime data (`config.json`, `cookies.txt`, `archive.db`, logs, and the default
`downloads/` tree) is ignored by Git. Review `.gitignore` before adding any new
runtime output path.

The end-to-end tests (`tests/integration.test.ts`) run the real engine against
the mock binaries in `tests/mocks/`, covering the happy path, transient-failure
retries, corrupt-partial resume, permanent failures, and restart reconciliation.

## Installation

```bash
git clone https://github.com/Lordhussnain/new-build.git
cd new-build
bun install
```

## Configuration

Your saved sources and settings live in **`config.json` in the app's working
folder**, next to `archive.db`. `src/config.ts` only defines the schema and
shipped defaults; the Web UI does not edit TypeScript source files.

For example (omitted keys use their defaults):

```json
{
  "playlists": ["https://www.youtube.com/playlist?list=..."],
  "channels": ["https://www.youtube.com/@SomeChannel"],
  "channelPlaylists": ["https://www.youtube.com/@SomeChannel/playlists"],
  "offlineMode": false,
  "outputRoot": "D:/Downloads/YT",
  "targetFormat": "mp4",
  "downloadSubtitles": true,
  "writeThumbnail": true,
  "writeDescription": false
}
```

Keep `config.json` private: it can contain source URLs and a `webToken`.
`cookies.txt` contains authentication credentials and must also stay local; do
not commit either file.

### Offline mode (no downloads)

`offlineMode: true` turns the engine into a local post-processor: **nothing is
downloaded**, and the only work left is the work that needs no network.

| Stage | Offline mode |
| --- | --- |
| Scans, RSS watching, daemon rescans | **off** — nothing touches YouTube |
| Downloads (yt-dlp / aria2c) | **off** — queued jobs stay `pending`, unclaimed, with their `.part` files intact |
| Metadata sidecars (subs/thumbnail/description/info.json) | **off** — every sidecar is a network fetch; `pending` stays `pending` |
| Conversion (ffmpeg) | **on** — files that still need conversion are converted |
| Secondary-storage move | **on** — finished files are moved, sidecars included |
| Cookie validation, network monitor | **off** — a disconnected network must not pause the run |

Queued downloads are *left exactly as they are*: they are not skipped, failed,
or paused, so turning offline mode off resumes the queue where it stood. The
file that gets converted or moved is finished for real — a converted file is
recorded, and a moved file's new path is recorded, both with the same
crash-safe updates a normal run uses.

Turn it on from the dashboard (**⚙️ Settings → 📴 Offline mode**, applied live,
no restart), from `config.json`, from `bun run config`, or for a single run
without touching `config.json`:

```bash
bun run start --offline        # this run only; config.json is not modified
bun run start --offline=false  # override a machine-wide YTA_OFFLINE=1
YTA_OFFLINE=1 bun run start    # same as --offline (scheduled tasks, shortcuts)
```

The dashboard shows a blue **📴 Offline mode** banner while it is on, with how
many finished files are still waiting to move to secondary storage, and the
Reliability panel lists that relocation pass like the other sweeps.

### Adding sources from the Web UI

**Save & Scan** saves the pasted URL to the appropriate list in `config.json`
**before** scanning/queuing videos in `archive.db`. Playlist links go in
`playlists`, channel links in `channels`, and a channel's `/playlists` tab in
`channelPlaylists`. Single-video links also use the existing `playlists` list.
Share/tracking parameters are removed; a watch link with `list=` keeps the
playlist, not just the currently selected video. Repeated scans do not append
duplicate sources or duplicate jobs, even if all videos were already queued.

- The response confirms **Saved to config.json**; a failed write is shown as
  an error and does not start a scan. Writes replace the file atomically, and
  concurrent source/settings updates cannot overwrite each other.
- An empty/temporarily unavailable source stays saved for future scans. A valid
  empty listing is distinct from a yt-dlp failure: nonzero exits and scans that
  exceed the 10-minute watchdog are shown as scan failures, not reported as
  "No videos found." If scanning fails after saving, the UI says the source was
  saved separately from the scan failure.
- Saved sources are scanned again at startup. With `daemonMode: true` and
  `rescanIntervalHours > 0`, full rescans include **all three lists**, including
  playlists added while running. Enabled RSS polling also picks up new channel
  entries without a restart, even if the engine started with no channels.
- The optional folder override is for **this scan**; it is recorded on the
  queued jobs, not stored as a source-level override in the config.
- Links submitted with an older version were one-off scans. Paste those source
  links once more to save them; you do **not** need to delete existing jobs or
  downloads. To completely remove a saved source, use **Saved sources → Remove**
  in the dashboard. It removes the URL from `config.json` and deletes its
  source-owned job rows from `archive.db`; jobs still referenced by another
  configured source are retained. Already-downloaded media files and the
  yt-dlp download-history file are not deleted. The `bun run config` manager
  performs the same cleanup when saving removed sources (stop the engine before
  using the terminal manager). Purging the queue alone does not remove sources
  from future scans.

### Reliability settings

```json
{
  "maxResumeAttempts": 5,
  "retryBackoffBaseSeconds": 30,
  "retryBackoffMaxSeconds": 900,
  "requeueFailedAfterMinutes": 30,
  "verifyExistingFiles": true,
  "downloadTimeoutMinutes": 15,
  "maxDownloadMinutes": 180
}
```

| Key | Meaning |
| --- | --- |
| `maxResumeAttempts` | How many times one video may resume from its `.part` file before the partial is discarded and the download restarts from scratch |
| `retryBackoffBaseSeconds` / `retryBackoffMaxSeconds` | Exponential backoff window (with jitter) for transient failures — base doubles per no-progress retry, capped at the max |
| `requeueFailedAfterMinutes` | Cooldown before failed jobs start a fresh retry window (`0` disables the sweep). Permanent download failures are never re-queued |
| `verifyExistingFiles` | On startup, verify that files recorded as downloaded still exist; missing ones are scrubbed from the yt-dlp archive and queued again |
| `downloadTimeoutMinutes` | Minimum per-video download timeout |
| `maxDownloadMinutes` | Ceiling for the timeout. The effective timeout scales with the video's real duration (3× realtime + 5 min) between the two |

Edit these interactively with `bun run config` → **Change Reliability & Resume**.

### Video quality and output format

| Key | Default | Options | What it controls |
| --- | --- | --- | --- |
| `videoQuality` | `"1080p"` | `highest`, `4k`, `1440p`, `1080p`, `720p`, `480p`, `audio` | Selects the stream quality. `audio` downloads audio only and produces MP3 output. |
| `targetFormat` | `"mp4"` | `mp4`, `mkv`, `webm`, `mp3`, `m4a` | Final media container for newly queued jobs. The selected value is stored on each job; changing it does not rewrite existing jobs or files. |

Use `bun run config` → **Change Download Settings** or the dashboard's global
Settings editor to change the defaults. The per-video detail drawer can override
both values for an individual job. Multi-audio jobs on the default MP4 path
remain MKV so their tracks stay switchable; see the multi-audio section below
for explicit format overrides.

### Download performance settings

| Key | Default | What it does |
| --- | --- | --- |
| `useAria2c` | `true` | Download through aria2c for multi-connection transfers. Falls back to yt-dlp's native downloader when the binary is missing, or for HLS/live streams which aria2c cannot serve. |
| `aria2cPath` | `""` | Where aria2c lives; blank auto-detects (PATH, app folder, winget/scoop/choco). Set to `"none"` to force-disable aria2c even when installed — the engine then always uses yt-dlp's native downloader. |
| `connectionsPerDownload` | `16` | aria2c `-s`/`-j` — how finely a file is split (1–64). aria2c hard-caps per-server connections (`-x`) at 16; the engine clamps it, so values above 16 split finer without opening impossible connections. |
| `minSplitSize` | `"1M"` | Smallest file size aria2c will split into multiple connections. Must be an aria2c size (`512K`, `1M`, …) — a value aria2c rejects pauses the engine (`BAD_DOWNLOADER_ARGS`) rather than failing every download. |
| `concurrentFragments` | `16` | Parallel DASH/HLS fragments for yt-dlp's native downloader. |
| `fragmentRetries` | `10` | Retries per fragment before a download fails. |
| `httpChunkSize` | `""` | Range-based chunked downloading on the native path (e.g. `"10M"`). Off by default — some CDNs mishandle `Range` requests. |
| `bufferSize` | `""` | yt-dlp socket buffer size (e.g. `"16K"`); blank uses yt-dlp's default. |
| `userAgent` | `""` | Optional single-line User-Agent passed to yt-dlp. Blank keeps yt-dlp's own default. |
| `autoscaleEnabled` | `true` | Grow the download pool toward `maxDownloadWorkers` while work is queued; shrink to `minDownloadWorkers` when idle. |
| `maxConcurrentDownloads` | `3` | Initial slot count when autoscaling is enabled; changing it while running resets the active pool on the next tick. When autoscaling is disabled it is the fixed slot count. It is not the autoscaler ceiling. |
| `minDownloadWorkers` / `maxDownloadWorkers` | `1` / `5` | Autoscaler floor and ceiling. `maxDownloadWorkers` is the ceiling; raising it above the already-started worker pool requires a restart, while lowering the ceiling applies live. |
| `autoscaleRampStep` | `2` | Download slots added per autoscale tick while the queue has backlog. |
| `maxBandwidthKBps` | `0` | Per-download yt-dlp rate limit, divided across active slots and forwarded to aria2c. `0` = unlimited. Downloads already running keep the share they started with, so autoscaling can temporarily make the aggregate rate exceed the configured cap; new attempts use the current slot count. |

The dashboard's **Standard**, **Maximum speed**, and **Aggressive (IDM)** buttons
apply these values as quick presets (along with the **⚡ Turbo IDM** button in the
main controls); settings remain individually editable. Standard restores the
shipped downloader defaults. Maximum speed selects aria2c with 16 connections,
32 native fragments, 10M HTTP chunks, a 16K buffer, and no rate cap. Aggressive (IDM)
pushes connections to 32 (with 512K split threshold), 64 native fragments, 10M HTTP chunks,
a 64K socket buffer, no rate cap, and the browser User-Agent. If you customize one of
those values, the UI marks the profile as **Custom**. A User-Agent override is only a
request header and does not guarantee that a service will change its throttling behavior.

### Multi-audio tracks (YouTube multi-language audio)

YouTube now ships many videos with several audio tracks — the original language
plus auto-dubbed ones, exactly what the player's **Audio track** menu lists.
The engine can download them the same way:

| Key | Default | What it does |
| --- | --- | --- |
| `multiAudioMode` | `"off"` | `off` = classic single-track download. `all` = keep every audio track the video offers. `languages` = keep only the codes in `audioTrackLanguages`. |
| `audioTrackLanguages` | `[]` | Language codes kept in `languages` mode (e.g. `["en", "ja"]`). |

How it works: before a download the worker asks yt-dlp which audio tracks the
video offers (one cheap metadata pass, cached per job), picks the best stream of
each wanted track (DRC duplicates are ignored), and hands the selection to
yt-dlp as `bv…+<track1>+<track2>… --audio-multistreams --merge-output-format mkv`.
The default result is one MKV whose audio tracks you switch in VLC/mpv/Plex
just like on YouTube. The normal MP4 path skips post-conversion for a multi-track
download, leaving that MKV intact. If you explicitly request another per-job or
global output format, the converter maps every audio stream; MP4 output re-encodes
each stream to AAC, while unsupported target codecs may still make conversion
fail. A single selected track merges like a classic download. `videoQuality:
"audio"` (MP3) always stays single-track.

Per-video override: open a job in the dashboard and use the **Audio tracks**
section — *Find audio tracks* lists what YouTube offers (original + dubs, with
language and bitrate), checkboxes pick what the next attempt keeps, and *Use
global setting* returns the job to the mode above. For a video that is already
downloaded, **Save & re-download** applies the selection immediately: the
engine scrubs the video from the yt-dlp download archive, moves the old file
aside (`.superseded`), and downloads again with the new tracks. The previous
file is kept until the new download succeeds and is restored automatically if
the re-download fails permanently — a retry never destroys what is already
archived. The hand-off is crash-safe: the backup is recorded in the database
before the file is moved, and if the engine dies mid-retry the next startup
either finishes the move or puts the file back — it never re-queues the video
while the old file sits unmanaged. If YouTube renumbers its formats after a probe, the engine detects
the stale format ids, re-probes, and retries instead of parking the job.

### Subtitles & sidecar files

| Key | Default | What it does |
| --- | --- | --- |
| `downloadSubtitles` | `true` | Fetch subtitle files for newly added videos. |
| `subtitleLanguages` | `"all"` | Which subtitle languages to fetch: comma-separated codes (`"en, es, ja"` — regexes like `en.*` work), or `"all"` for every available language including auto-generated captions. |
| `subtitleFormat` | `"srt"` | Container for the fetched subtitles (converted by yt-dlp). |
| `writeThumbnail` / `writeDescription` / `writeInfoJson` | `true` | Thumbnail / description / info.json sidecars for newly added videos. |

Per-video control: every job's detail drawer has a **Sidecar files** section
(subtitles / thumbnail / description). Flipping a flag on an
already-downloaded video fetches the files right away against the existing
media — no re-download; flipping one off never deletes files already fetched.

### Tuning from the dashboard

The **⚙️ Settings** button opens an editor for offline mode, the downloader,
media format, concurrency, storage, and reliability settings. Changes are validated against the same
Zod schema the engine uses, atomically saved to `config.json`, and applied to the
running engine; workers pick them up without a restart. The editor is limited to
an explicit allow-list: source URLs, cookie credentials, the web token, and the
network binding cannot be changed from the browser. Requests naming settings
outside the allow-list are rejected rather than silently ignored.

Click any job row for its detail view (file paths, sizes, duration, retry/resume
counts, the kept partial and its aria2c control file, and the last error).
Keyboard: <kbd>/</kbd> search, <kbd>s</kbd> settings, <kbd>p</kbd> pause/resume,
<kbd>r</kbd> refresh, <kbd>Esc</kbd> close.

### The reliability panel

The panel is a live read of what the engine is actually doing about failures,
not a static list of settings:

- **Downloader** — engine in use, connections per download, concurrent
  fragments, the bandwidth cap, and the autoscale ramp step.
- **Will resume** — jobs that still hold a `.part` file and are therefore still
  in play (`pending`, `paused`, or `downloading`). Their job rows carry a
  `⏸️ partial · will resume` pill whose tooltip shows the `.part` path and its
  `.aria2` control file.
- **Interrupted** — jobs parked as `paused` + `interrupted`, i.e. the ones the
  crashed-jobs sweep will re-claim and continue rather than restart.
- **Stale claims** — what the reaper would reclaim right now, measured from
  each claim's last *heartbeat* (not from when the work started, and not from
  `updated_at`): downloads silent for longer than
  `max(20 min, maxDownloadMinutes)`, conversions silent over 3 h, and metadata
  claims silent over 15 min. A long-running conversion or metadata pass renews
  its claim on an interval, so it never looks stale. The panel and reaper share
  `STALE_CLAIM_THRESHOLDS(config)` and the same expired-heartbeat predicate, so
  the displayed window follows the live watchdog setting and cannot drift from
  the sweep.
- **Engine lease** — the owner token, fencing generation and expiry of the
  database-level lock, and whether the dashboard's own process holds it.
- **Self-healing sweeps** — each sweep with its cadence and a pending count:
  crashed jobs, stale claims, deleted files, failed jobs, and the
  secondary-storage relocation pass (`every 60s`, the count of finished files
  still waiting to move). Deleted-files is `startup`-only and stats every
  recorded file, so its count is reported as unknown rather than guessed.

Every count comes from `GET /api/reliability`, which reads the live config (not
a startup snapshot) and the job table.

### Web dashboard & API

The dashboard (`web_ui.html`, served at `/`) shows live stats, a workers strip
(what each DL/MD/CV worker is doing right now), the reliability panel, a
sortable/filterable job table, a per-job detail drawer, failed-job and run-history
tabs, and the log viewer. It polls only while the tab is visible.

API responses use `{ ok: true|false, … }`; unknown API paths are a JSON 404,
and a known path with the wrong method is a JSON 405 (+ `Allow`). When
`webToken` is set, every route except the sign-in exchange requires the token
(cookie, `Authorization: Bearer`, `X-Web-Token`, or the legacy `?token=` path).
Browser mutations are checked against `Origin`/Fetch Metadata; cross-origin
POST/PUT/PATCH/DELETE requests are rejected even when auth is off. Requests with
neither `Origin` nor a cross-site Fetch Metadata header remain supported for
CLI/API clients.

| Method & path | What it does |
| --- | --- |
| `POST /api/auth` | `{ "token" }` → validate the sign-in secret and set an `HttpOnly` cookie (same-origin only; 404 when token auth is not configured). |
| `GET /api/ping` | Liveness probe (also answers `HEAD`). |
| `GET /api/version` | Engine/runtime info (Bun version, platform, uptime). |
| `GET /api/status` | Stats, aggregate speed, workers, pause state, disk/RAM, ETA. |
| `GET /api/jobs` | The 500 newest jobs. |
| `GET /api/jobs/:id` | One job, fresh from the DB (what the detail drawer shows). |
| `POST /api/jobs/:id/retry` | Re-queue with fresh budgets (alias: `POST /api/retry/:id`). For a downloaded job this is a real re-download: the id is scrubbed from the yt-dlp archive and the old file stashed as `.superseded` first (restored if the re-download fails permanently). |
| `POST /api/jobs/:id/reset-failures` | Clear the per-stage failure counters (alias: `POST /api/failcount/reset/:id`). |
| `POST /api/jobs/:id/audio-tracks` | Save the per-video audio-track selection (`tracks: null` resets). |
| `POST /api/jobs/:id/audio-probe` | Discover the audio tracks YouTube offers for this video. |
| `POST /api/jobs/:id/sidecars` | Toggle per-video sidecars (`{subtitles?, thumbnail?, description?}`); enabling one on a finished download fetches it immediately. |
| `DELETE /api/jobs/:id` | Delete one job row. |
| `POST /api/jobs/pause` | Bulk user-pause `{ "ids": [...] }`. |
| `DELETE /api/jobs` | Bulk delete `{ "ids": [...] }` (alias: `POST /api/jobs/delete`). |
| `GET /api/sources` | List configured source URLs and their tracked database-job counts. |
| `DELETE /api/sources` | `{ "url" }` → remove the source from `config.json` and delete jobs owned only by it; jobs shared with other configured sources remain. |
| `POST /api/scan` | `{ "url", "folder?" }` → save the source to `config.json`, then scan/add jobs. Returns `saved`, `source: {url, key, added}`, and `found`/`added`/`skipped`. |
| `POST /api/queue/purge` | Delete all pending/paused/waiting/failed jobs. |
| `POST /api/pause` · `POST /api/resume` | Pause/resume the whole engine. |
| `GET /api/failed` · `POST /api/failed/requeue` | Failed jobs; requeue all eligible (ignores cooldown). |
| `GET`/`POST /api/settings` | Dashboard-editable settings snapshot / validated patch. |
| `GET /api/reliability` | Resume + self-healing snapshot (see above). |
| `GET /api/history?limit=` · `GET /api/logs?type=error\|report&limit=` | Run history; logs. |

The terminal UI carries the same signal: the header line gains a `Res:n` field
whenever jobs are holding a partial they will resume from, so a paused engine
reports its resume state without needing the browser open.

**How resume works with aria2c.** aria2c keeps a *control file* next to every
in-progress download (`<name>.part.aria2`) recording which pieces have arrived.
An interrupted transfer leaves both files, and the next attempt resumes from
them — so enabling aria2c does not weaken resume. When the engine decides a
partial is unusable it deletes the `.part` **and** its control file: aria2c
defaults to `--allow-overwrite=false`, under which a control file whose data is
gone makes it neither resume nor restart, wedging the job permanently.

Resume is dropped automatically in exactly one case, because resuming there is
pointless: the server no longer has the bytes the saved partial asks for
(`HTTP Error 416: Requested range not satisfiable`). YouTube re-slices a format
while a download is in flight, so the resume request lands past the end of the
remote stream — and every retry with the same partial fails identically.

Edit downloader and media settings with `bun run config` → **Change Download
Settings** or from the dashboard's **⚙️ Settings** editor. Reliability and resume
settings are under **Change Reliability & Resume** in the terminal config manager.

## Usage

```bash
bun run start
```

The engine reads `./config.json` from its working directory; it does not
support command-line config or format overrides. Edit settings with the
interactive `bun run config` manager or, while the engine is running, the
allowed options in the dashboard Settings panel.

The TUI shows live status for every video across all active workers. The web
dashboard (`http://127.0.0.1:3000` by default) adds bulk actions, the failed-job
tab, run history, and a live reliability panel.

## Architecture

```
batch_playlist_downloader.ts     entry point (bun run start / build:win)
update_config.ts                 interactive config manager (shares src/config.ts)
web_ui.html                      dashboard frontend (served by src/web.ts)
src/
  config.ts        Zod schema + defaults + load/save (single source of truth)
  db.ts            SQLite schema, migrations, atomic job claims + claim leases (tokens, heartbeats)
  lease.ts         database-level engine lease (owner, expiry, fencing) — one engine per archive.db
  state.ts         shared mutable runtime state (pause, stats, workers)
  tools.ts         yt-dlp/ffmpeg/aria2c/JS-runtime discovery + cookies helpers
  download-args.ts pure yt-dlp command construction (downloader engine, tuning)
  download-output.ts bounded subprocess output parsing and final-path validation
  audio-tracks.ts  multi-audio track discovery, selection, and format probing
  settings.ts      allow-listed dashboard settings validation and live apply
  sources.ts       source URL validation, canonicalization, and persistence
  retry.ts         pure retry policy: backoff, watchdogs, error classification
  resilience.ts    pause/resume, circuit breaker, network + disk guards
  reconcile.ts     self-healing sweeps (crashes, stale claims, missing files, failed jobs)
  scanner.ts       playlist/channel scanning + deduplicated ingestion
  workers/         download, metadata, and conversion worker loops
  autoscale.ts     dynamic download-slot autoscaling
  rss.ts           cheap per-channel RSS new-upload watcher
  polling.ts       daemon-mode full rescans
  dashboard.ts     TUI
  report.ts        human-readable run report
  web.ts           dashboard server + JSON API + token auth
  history.ts       heartbeated run history
  lifecycle.ts     worker supervision + graceful shutdown
  engine.ts        orchestration (main)
tests/             bun test suite (unit + end-to-end with mocked tools)
```

## How It Works

1. **Startup** — load config, verify dependencies, open/migrate the database,
   take the engine lease (a live foreign owner means this process exits without
   touching a single job row), bind the web port, then self-heal: reconcile
   crashed jobs, recover interrupted `.superseded` hand-offs, re-queue jobs
   whose files vanished, clean up unusable partials and stale backups
2. **Scan** — every configured playlist/channel is listed (yt-dlp flat scan or
   cheap RSS polling) and deduplicated into the jobs table by video id
3. **Download workers** — pull videos into the configured output directory
   through aria2c (multi-connection) when available, otherwise yt-dlp's native
   downloader. Failures keep the `.part` file and retry with exponential
   backoff; the retry budget only shrinks while the video makes no forward
   progress. If a retry window is exhausted, a later cooldown sweep opens a
   fresh window and continues from the retained partial. Two classes are
   deliberately exempt from that loop: a video that will never download
   (private / deleted / members-only / region-locked) is skipped after one
   attempt with its reason recorded, and a selector that matches nothing steps
   the quality down the fallback ladder instead of re-running the same command
   — both are described in `jobs.last_error` and never auto-requeued.
4. **Metadata workers** — fetch subtitles, thumbnails, and descriptions per video, based on config flags
5. **Converter workers** — convert completed downloads into the target format,
   optionally moving them (with sidecars) to a secondary storage path. The move
   is copy-then-remove: if the destination copy fails (full disk, unwritable
   share, cross-volume copy error) both copies are kept and the job is retried,
   so a broken secondary store can never delete the only copy
6. **Sweeps** — every minute: reclaim claims whose lease heartbeat has lapsed
   (download progress renews a download's lease; conversion and metadata stages
   heartbeat on an interval), re-queue cooled-down transient failures, renew the
   engine lease, heartbeat the run history. Each reclaim is a compare-and-swap
   on the claim token, so a reaper can never reset a job that was renewed or
   already reclaimed by someone else

## Security & operations

- **Loopback-only Web UI by default** — `webBind` defaults to `127.0.0.1`, so the
  dashboard (including pause, purge, and delete controls) is not reachable from
  your LAN. Set `"webBind": "0.0.0.0"` only when you deliberately want network
  access.
- **Authentication is off by default** — an empty `webToken` means the UI and
  API accept requests without a login. Before binding to `0.0.0.0`, set a strong,
  private token; without one, anyone who can reach the port can control the
  queue. With a token configured, requests must present it via the login cookie,
  `Authorization: Bearer`, `X-Web-Token`, or the legacy `?token=` compatibility
  path. The sign-in page exchanges the token with a same-origin POST and sets an
  `HttpOnly` cookie; it does not place the secret in the URL. Avoid the query
  path for manual use because URLs can be retained in browser history and logs.
  Token comparisons are timing-safe.
- **Browser mutations are same-origin checked** — cross-origin POST/PUT/PATCH/
  DELETE requests are rejected using `Origin` and Fetch Metadata headers, which
  protects the unauthenticated loopback default from ordinary cross-site request
  forgery. Non-browser API clients without an `Origin` header still work; use a
  token whenever the server is reachable beyond your own machine.
- **HTTP is not encrypted** — the built-in server does not provide TLS. Do not
  expose it on an untrusted network; use a trusted LAN or put it behind a TLS
  reverse proxy.
- **Keep operational data private** — do not commit `config.json`, `cookies.txt`,
  the SQLite database, download archive, logs, or downloaded media. In
  particular, `cookies.txt` can grant access to your YouTube account.
- **Per-download bandwidth shaping** — `maxBandwidthKBps` maps to yt-dlp
  `--limit-rate` as an integer byte/second share divided across active slots.
  It is a best-effort aggregate during autoscaling because existing yt-dlp
  processes keep the rate set when they started.
- **Worker autoscaling** — with `autoscaleEnabled` the engine grows download
  slots toward `maxDownloadWorkers` while a backlog exists and bandwidth
  headroom remains, sheds slots when the cap saturates, and returns to
  `minDownloadWorkers` when idle.
- **One engine per `archive.db`, enforced in the database** — starting the
  engine against a database that another live engine owns refuses to start
  (exit code 1, with the current owner and expiry in the message) instead of
  running the self-healing sweeps against work that is already in flight. A
  crashed engine's lease is taken over automatically — immediately when its
  process is provably gone on the same host, otherwise once the lease expires —
  and each takeover increments a fencing number, so "written by the previous
  engine" is always decidable. The web port still acts as the HTTP lock; it is
  simply no longer the only thing keeping two engines apart.
- **Cheap new-upload watching** — `rssEnabled` polls each channel's RSS feed
  every `rssPollIntervalMinutes` (one HTTP GET per channel, ~15 min latency)
  instead of waiting for a full rescan.
- **Circuit breaker** — after `maxFailures` consecutive pipeline failures
  (dead cookies overnight, a YouTube outage) the engine pauses itself with
  `TOO_MANY_FAILURES` instead of burning through the queue. Resume from the
  UI when you're ready. Per-video, the effective retry cap is
  `min(maxRetryAttempts, maxFailuresPerVideo)` within each retry window; an
  eligible failure starts a fresh window after the configured cooldown.
- **yt-dlp download archive** — `archiveFile` is passed to
  `--download-archive` as a second idempotence layer; if a downloaded file
  disappears (moved/deleted by hand) the archive entry is scrubbed and the
  video is fetched again on the next attempt.
- **Startup file reconciliation** — with `verifyExistingFiles` (default on) the
  engine checks that every file it recorded as downloaded still exists on
  disk; anything missing is scrubbed from the archive and re-queued instead of
  being silently skipped forever.
- **Wait for VOD** — with `archiveLiveStreams` enabled, currently-live
  streams are never grabbed mid-broadcast: the job parks as
  `waiting for VOD` and is re-queued by the next scan/RSS pass once the
  stream has ended.

## Roadmap

- [x] Central SQLite job database — persist per-video status (`pending` →
      `downloading` → `downloaded` → `converted`) so downloads survive
      crashes and restarts, and workers claim jobs atomically instead of
      relying on in-memory state
- [x] Resume interrupted downloads from exactly where they left off
      (`.part` files kept, `--continue`, bounded resume budget)
- [x] Fully independent, parallel metadata and conversion pipelines
- [x] Unavailable videos skipped after one attempt (reason recorded, never
      auto-requeued) and unavailable formats switched automatically down the
      quality ladder instead of retried
- [x] Modular architecture with a unit + end-to-end test suite
- [ ] Deduplicate identical videos across playlists by content hash
- [ ] Per-link quality/format overrides in the web dashboard
- [ ] Desktop notifications (Discord/webhook) on completion and failures

## Windows 11

The engine is fully supported on Windows 11. Recommended setup:

**Quick start (no runtime install):**

```powershell
# 1. Build the standalone exe (requires Bun once, on any machine)
bun run build:win          # → dist\youtube-archive.exe

# 2. Double-click:
start-archive.bat
```

`start-archive.bat` sets UTF-8 codepage, puts the app folder first on `PATH`
(so a local `yt-dlp.exe` / `ffmpeg.exe` sitting next to the app is picked up
automatically), and prefers the compiled exe over a source checkout. It looks
for the exe in `dist\youtube-archive.exe` first and in the app folder second,
so copying it out of `dist\` is optional — either layout works. If neither
the exe nor Bun is available it says so and names the build command.

**Dependency auto-detection** — at startup the engine searches, in order:

1. `ytDlpPath` / `ffmpegPath` in `config.json` (set them via `bun run config`)
2. `PATH`
3. The app folder (next to `archive.exe` / `config.json`)
4. Winget, Scoop, and Chocolatey shims

**Start automatically at logon:**

```powershell
powershell -ExecutionPolicy Bypass -File .\install-task.ps1
# to remove later:
powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Uninstall
```

**Windows-specific safeguards built in:**

- Filenames are stripped of reserved device names (`CON`, `NUL`, `COM1`…),
  trailing dots/spaces, and illegal characters `/\:*?"<>|`
- Long titles are truncated so paths stay under `MAX_PATH` (260) — no registry
  tweak required
- Run history is heartbeated every minute, so even `taskkill /F` or a window
  close still leaves a usable history row
- Interrupted downloads are marked `paused (resume)` and continue from the
  `.part` file on next start
- If `statfs` is unavailable, free space falls back to PowerShell
  (`Get-PSDrive`); if that also fails the engine runs in degraded mode
  instead of pausing forever

### A video sits at 99% with `HTTP Error 416: Requested range not satisfiable`

The symptom is a job that never advances: `Progress` and `Best progress` both
stuck at 99.0%, `Resumes` 0, `Retries` climbing, `Last error` reading
`ERROR: unable to download video data: HTTP Error 416: Requested range not
satisfiable`, and a `.part` + `.part.aria2` pair sitting in the job's folder.
The saved partial is bigger than (or exactly as big as) what the CDN will now
serve for that format — YouTube re-encoded or re-sliced it mid-download — so the
range the resume asks for does not exist. No retry, backoff, re-probe or cookie
refresh can fix that: only throwing the partial away can.

That is yt-dlp's documented behaviour, not something it will recover from for
you: in [yt-dlp#8313][i416] a maintainer describes precisely this — the error
fires when "the partial download that yt-dlp detects has a filesize that is
either the same size or larger than that of the file on youtube's servers" — and
closes it as a caller problem (there, `nopart` made an already-*complete* file
look resumable). This engine always keeps `.part` naming and names every video
`<index> - <title> [videoId]`, so a mismatch can only mean the remote stream
changed; a fresh transfer is the whole remedy, and the engine now starts one by
itself.

Current builds do this themselves: a 416 discards the `.part` together with its
aria2c control file, zeroes the progress and the high-water mark (which would
otherwise mark every later attempt "no progress"), and re-queues the video for a
fresh transfer. If you are on an older build, do it by hand:

1. Stop the engine (or pause it) so no aria2c/yt-dlp still holds the files.
2. Delete that video's `*.part` and `*.part.aria2` in its download folder.
   Always both — a leftover control file makes aria2c refuse to restart.
3. Press **Retry** on the job (or just start the engine again). The video
   downloads from zero; the archive entry is untouched, so nothing else is
   re-fetched.

The same reasoning covers the `error.log` noise an operator may have learned to
ignore: the claim-lost line ("download claim lost — the next update will not
land") used to be printed once per heartbeat for every video in a retry backoff,
which is a hundred-plus lines an hour. It is reported once per claim now, so a
line there means something actually happened.

### Bun crashes with `panic: index out of bounds` on Windows

This is a native Bun runtime crash, not a normal yt-dlp/aria2c download error;
JavaScript `try/catch` and worker supervision cannot recover inside that process.
A reported Bun 1.3.14 trace points to `existsSync` → `toWPathMaybeDir` (Windows
path conversion). The old downloader treated arbitrary stdout as possible paths;
aria2c's carriage-return progress updates could accumulate into a huge string.

The downloader now uses an explicit `FILEPATH:` after-move record, rejects
oversized/control-character paths **before** filesystem calls, handles CR/LF
and split UTF-8 safely, and bounds both stdout/stderr diagnostics. If the final
record is absent, it still looks for the expected media file in the job folder.

**Recovery:**

1. Stop any remaining yt-dlp/aria2c/ffmpeg processes belonging to the crashed
   run before restarting (a hard crash can leave child processes alive).
2. Update this checkout to include the output-parser fix, then update Bun and
   restart **from the same app folder**:

   ```powershell
   bun upgrade
   bun --version
   bun run start
   ```

   If you use a standalone exe, rebuild/replace it too: upgrading the system
   Bun does not update the runtime embedded in an already compiled exe, and
   `start-archive.bat` prefers that exe over the source checkout.
3. Keep `archive.db` (including any `-wal`/`-shm` files), the download archive,
   and the downloads folder. Do **not** delete `.part` or `.part.aria2` files:
   startup reconciliation re-queues interrupted jobs and resumes available
   partials. There is no need to reset the queue or lower the connection count
   for this parser fix.

[i416]: https://github.com/yt-dlp/yt-dlp/issues/8313

If it still crashes on an updated runtime and checkout, save the new crash-report
link and report it to Bun with the runtime version and reproduction steps.

## License

This repository does not currently include a `LICENSE` file, so no license is
declared. Add a license before redistributing the project.
