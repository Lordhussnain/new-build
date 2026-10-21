# Bilibili implementation — everything changed on this branch, and every gap

Branch: `arena/112149c4-new-build` (from `1bf68a2` "Improve whole-channel downloads")
Commits:

| Commit | Contents |
| --- | --- |
| `2870c01` | **Add Bilibili videos and playlists as sources** — the whole feature: provider layer, listing/ingest, pre-download title/duration probe, failure classification, probe targeting, UI/API, docs, tests |
| `88303d0` | **Accept bilibili.com's `/en/` language-prefixed pages** — the international layout on the main host (`www.bilibili.com/en/video/BV…`) is stripped to the canonical un-prefixed path |

Diff size: **29 files, +3048 / −205** (of which `src/providers.ts` +685 and
`tests/providers.test.ts` +467 are new files).

Verification: `bun run check` (strict `tsc --noEmit` + the complete suite) is
green — **800 pass / 0 fail / 2 opt-in skips, 6746 expects, 43 files**.

> Scope decision made up front: Bilibili is a **first-class second provider**,
> not a generic "any site" feature. No new config key was added (always on),
> and every YouTube behaviour is preserved and pinned by regression tests.

---

## 1. File-by-file inventory

### New files

| File | What it is |
| --- | --- |
| `src/providers.ts` | The single home for every per-site URL fact (a zero-dependency leaf): provider/host tables, URL shapes (`video` / `playlist` / `channel`), canonicalization per shape, listing-entry-id rules, job-URL resolution precedence, channel-folder fallbacks, and the cookie/network probe host lists. Nothing else in the codebase may grow its own copy (AGENTS.md gotcha 45). |
| `src/video-summary.ts` | The pre-download title/duration probe: `needsSummaryBackfill()` gate, `summaryProbeArgs()` (`--no-playlist --skip-download --print "%(title)s|||%(duration)s"`, socket timeout 15 s, 3 retries), `SUMMARY_PROBE_TIMEOUT_MS = 60 000` (env override `YTA_SUMMARY_PROBE_TIMEOUT_MS`), `probeVideoSummary()` with concurrent drain of both pipes + SIGKILL/reap on timeout, `parseSummaryLine()`, `isUnknownListingTitle()`, `UNKNOWN_LISTING_TITLE = "video"`. |
| `tests/providers.test.ts` | 34 tests / ~200 expects over every URL fact (see §6). |
| `tests/video-summary.test.ts` | 23 tests: parse rules, the backfill gate, probe argv, and the process lifecycle against **real child processes** (chatty stderr must not deadlock, failure wording, watchdog kill, unstartable yt-dlp, injected spawn). |

### Changed engine files

| File | Change |
| --- | --- |
| `src/sources.ts` | `parseSourceUrl()` now guards only length/control-chars/protocol/credentials/port and then dispatches through `classifySourceUrl()`; new `sourceKeyFor()` (channel-ish → `channels`, else `playlists`) and exported `sourceProvider()`; all four user-facing error messages say "YouTube or Bilibili" (`SUPPORTED_SITES`). The `{key, url}` return shape is unchanged (tests compare whole objects). |
| `src/scanner.ts` | Listing `--print` template grew two **trailing** fields — `%(playlist_channel)s`, `%(webpage_url)s`, `%(url)s` (7 fields) — so a yt-dlp answering fewer fields still parses (missing trailing fields are *absent*, never `""`). `field()` treats a literal `NA` as missing. `parseListingLine(line, provider)` filters entry ids per site; `ingestItems()` stores `resolveListingVideoUrl(...)` per job; `scanAndIngest()` applies `channelFolderFallback()` for channel-shaped sources (a Bilibili space names neither channel nor playlist). Re-exports `normalizeVideoUrl` / `isPlaylistLikeId` from providers. |
| `src/workers/download.ts` | `runDownload()` starts with `backfillJobSummary()`: if `needsSummaryBackfill(job)`, one bounded probe; the result is written with a **claim-token CAS** (`updateClaimedJob`, `title = COALESCE(?, title), duration = COALESCE(?, duration)`), the in-memory job is only mutated when `.changes === 1`, and any probe error is logged once (`error.log`) and the download proceeds with the listing's values. Worker line shows `📝 Reading the video's title…` while the probe runs. |
| `src/download-args.ts` | `buildDownloadPlan()` adds **`--no-playlist`**: one job's URL can never expand into a list (an anthology page without `?p=`, or a legacy `watch?v=…&list=…` row, would otherwise download every entry into one output template). |
| `src/retry.ts` | Bilibili wordings classified: permanent — `supporter-only video`, `need to purchase` / `purchase the course`, `may be deleted or geo-restricted`; terminal labels — "Supporter-only video" (`members_only`), paid course (`payment_required`), "Deleted or region-locked" (`unavailable`, ordered **before** the generic geo rule whose wording it also matches); transient — `blocked by server` (412), `rejected by server` (352), `please wait and try later`, `risk control`, `http error 412`. Login gates deliberately stay retryable. |
| `src/rss.ts` | New `isRssWatchable()`; the poller and the interval driver skip non-YouTube channels (there is no Bilibili Atom feed; a space would spend a yt-dlp call per tick resolving an id that can never look like `UC…` and then log the same failure forever). Startup line reports `N YouTube channel(s) … M non-YouTube channel(s) are watched by the full rescan instead.` |
| `src/tools.ts` | `validateCookieArgs(source, probeUrls?)` / `validateCookies(file, probeUrls?)` probe **one URL per site, first success wins**; default stays the historical single YouTube probe (`DEFAULT_COOKIE_PROBE_URL`). `resolveCookieSource()` accepts an injected `probeUrls`. `tools.ts` remains a zero-dependency leaf — it does **not** import providers/state. |
| `src/engine.ts` | Computes `cookieProbeUrls([...playlists, ...channels, ...channelPlaylists])` (`withCookieProbes`) and passes it to all three `resolveCookieSource()` call sites (startup, cookies-watch sweep, periodic re-check). |
| `src/resilience.ts` | `networkProbeList()` = `networkProbeUrls(configured sources)`: configured sites' hosts first, then the other provider's, then the generic endpoints (`1.1.1.1`, google, cloudflare trace). A Bilibili-only archive on a network that cannot reach YouTube is no longer paused by the monitor. |
| `src/db.ts` | Ignore-tombstone URL for rows with an empty `url` uses `fallbackVideoUrl(job.id)` (provider inferred from the id shape) instead of a hardcoded YouTube watch URL. |
| `src/metadata-only.ts` | Sidecar fetch resolves each item's page URL exactly like the scanner (`resolveListingVideoUrl`) instead of building a YouTube watch URL from the id. |
| `src/web.ts` | `GET /api/sources` rows gain additive keys `provider`, `providerLabel`, `shape`; `POST /api/scan/batch` counts videos/playlists/channels by **shape** (not by YouTube URL prefixes) and adds `sources.byProvider`; the all-invalid batch message names both sites. No existing key renamed or removed (AGENTS.md gotcha 41). |
| `src/config.ts`, `src/settings.ts` | Comment/help-text corrections only ("probes the sites you configured first", rate-limit help mentions Bilibili 412 risk control). No schema change — config stays backwards compatible. |
| `update_config.ts` | `isValidPlaylistUrl()` delegates to `classifySourceUrl(...).shape === "playlist"` (CRLF file preserved); skip message and the network-probe prompt name both sites. |
| `web_ui.html` | Title/h1, input placeholders, batch textarea examples (incl. a favlist, a BV video and a space), metadata placeholder, notification texts, audio-probe hints, `formatLastError()` cases for Bilibili risk control / supporter-only / paid course / deleted-or-region-locked, `loadSources()` shows `providerLabel` in each source row ("Bilibili · Playlist · 3 job(s)"), batch result renders the additive `byProvider` stats. |

### Changed test/doc files

| File | Change |
| --- | --- |
| `tests/mocks/yt-dlp` | Provider-aware: 7-field listings (YouTube prints titles/durations; Bilibili prints `NA` for both plus the entry page URL in `%(url)s`), a `--skip-download --print "%(title)s|||%(duration)s"` **summary-probe branch** (`FAKE_SUMMARY_TITLE` / `_DURATION` / `_NA` / `_FAIL` / `_HANG` / `_LOG`), Bilibili ids (`BV…`, `_pN`, bangumi/cheese/audio/intl) for downloads, and archive lines with the extractor prefix (`bilibili <BV…>`). |
| `tests/integration.test.ts` | Two end-to-end scenarios (§6). |
| `tests/scanner.test.ts` | Bilibili parse cases (NA title/duration, `_p2` anthology entry, CDN-stream `%(url)s` stored but untrusted), entry-id filtering per provider, two new fixture modes (`bilibili-list`, `bilibili-space`) and ingest/scan tests (page URLs, placeholder titles, NULL durations, `Bilibili UP <mid>` folder, nested collection dropped). |
| `tests/sources.test.ts` | `/api/sources` contract incl. the new keys and a non-classifiable legacy entry (`provider: null`), mixed YouTube+Bilibili batch counts and per-list persistence offline. |
| `tests/retry.test.ts` | "Bilibili wordings": risk control transient in worker *and* scanner, supporter-only/paid/deleted-or-region-locked terminal with labels, login gates retryable, no Bilibili error ever reads as a YouTube signature/n-challenge failure. |
| `tests/rss.test.ts` | `isRssWatchable`, a Bilibili poll answers 0 without an id resolution or a fetch, a mixed tick fetches only the YouTube feed. |
| `tests/cookie-sources.test.ts` | Probe targeting: default stays YouTube-only, first answer wins (one probe), YouTube-unreachable network keeps good cookies, cookies every site rejects are still rejected, `resolveCookieSource` hands its list through. |
| `README.md` | Intro/features, config example with Bilibili entries, a **"Bilibili sources"** section (accepted-shapes table, titles/durations, cookies, failure classes, RSS), batch-result wording, offline table, requirements note (recent yt-dlp), roadmap tick. |
| `AGENTS.md` | §1/§3 module list, import graph (`providers.ts` leaf, `video-summary.ts → tools`, updated dependent lists), §4 jobs-table (`id`/`url`/`duration` meanings), gotchas **45** (providers is the single source of truth, tools stays a leaf), **46** (the pre-download probe and its gate), **47** (`%(url)s` is context-dependent), §9 test table + mock description, §11 task rows, §12-relevant DoD notes. |

---

## 2. Accepted URL shapes (all entry points: Save & Scan, Batch Links, Metadata Only, `config.json`, `bun run config`)

| Paste | Saved as (shape → config list) | Canonical form kept |
| --- | --- | --- |
| `bilibili.com/video/BV…` / `av…`, `m.bilibili.com/…`, **`bilibili.com/<lang>/video/…`** (`/en/`, `/ja/`, any case), trailing slash | video → `playlists` | `https://www.bilibili.com/video/<id>`; `?p=N` survives when pasted (it selects one anthology part) |
| `/festival/<slug>?bvid=BV…` | video | the plain video URL of `bvid` |
| `b23.tv/<code>` | video | **verbatim** — only yt-dlp can follow the redirect |
| `/bangumi/play/ep<N>`, `/cheese/play/ep<N>`, `/audio/au<N>`, intl `bilibili.tv|biliintl.com/[<lang>/]video/<aid>` | video | canonical page URL (intl keeps its lowercased language segment) |
| `space.bilibili.com/<mid>/favlist?fid=<N>` | playlist | `fid` required (10+ digits allowed) |
| `bilibili.com/list/<sid>`, `/medialist/play/<id>` | playlist | only `sid` + `business` kept, **in pasted order**; `oid`/`bvid`/tracking dropped → one identity per list |
| `/medialist/detail/ml<N>`, `/watchlater` | playlist | canonical |
| `space.bilibili.com/<mid>/lists/<sid>[?type=season|series]`, `/channel/collectiondetail?sid=`, `/channel/seriesdetail?sid=` | playlist | `type` is part of the identity (different extractor) |
| `/bangumi/play/ss<N>`, `/bangumi/media/md<N>`, `/cheese/play/ss<N>`, `/audio/am<N>`, intl `/[<lang>/]media/<id>` | playlist | canonical |
| `space.bilibili.com/<mid>` (+ `/video`, `/upload/video`, `/audio`, `/upload/audio`) | channel → `channels` | tab folded to `/video` / `/audio` |
| intl `/[<lang>/]play/<season>[/<ep>]` | video | canonical `/<lang>/play/…` |
| YouTube (all previous shapes) | unchanged | unchanged |

Rejected (with the "not a valid YouTube or Bilibili …" message): unknown hosts,
`bilibili.com.evil.example`, `live.bilibili.com/…` (live rooms), `t.bilibili.com`
(dynamic posts), `/read/cv…` (articles), space paths that name no tab/list,
nested-list ids inside listings (`{mid}_{sid}`), and a bare `/en`.

---

## 3. How a Bilibili source flows through the engine

1. **Save** — `classifySourceUrl()` canonicalizes; `sourceKeyFor()` picks the
   config list; identity = canonical URL (`sourceIdentity`), so both spellings
   of one video/list dedupe.
2. **Scan** — `--flat-playlist --print <7 fields> <url>`. Bilibili flat entries
   carry **id + `%(url)s` only**: title/duration/channel/webpage_url print `NA`.
   `parseListingLine(line, "bilibili")` stores `title: "video"` (the
   placeholder), `duration: NaN`, `printedUrl` = the entry page URL, and drops
   entry ids that are lists (`{mid}_{sid}`).
3. **Ingest** — job URL = `resolveListingVideoUrl()` precedence: canonical
   `webpage_url` → canonical printed `url` → canonical source URL (+`?p=N` from
   a `_pN` id) → `videoUrlForId(id)` → source. A printed `%(url)s` that is a CDN
   stream (`bilivideo.com`, expiring) is **never** stored as `jobs.url`. Folder =
   listing title, else `channelFolderName`, else `channelFolderFallback`
   (`Bilibili UP <mid>` / `Bilibili UP <mid> Audio`). Duration stores NULL.
4. **Before the first download** — `needsSummaryBackfill()` (placeholder title
   *or* missing duration, and **no** `file_path` / `partial_file_path` /
   `best_progress > 0`) → one bounded probe → CAS write of title + duration →
   the plan is built from the new values (file name, watchdog). A failed probe
   costs only the placeholder name.
5. **Download** — unchanged pipeline + `--no-playlist`; archive records
   `bilibili <id>` (the engine only ever reads the last field of an archive
   line, so any extractor prefix works).
6. **Failures** — classified in Bilibili's own words (§1 retry.ts row); risk
   control retries, gates/paid/deleted park terminally with a readable label,
   login gates stay retryable so a later `cookies.txt` rescues them.

---

## 4. Probe and credential targeting

- **Cookie validation**: `cookieProbeUrls(sources)` = one probe per configured
  provider (configured order), always ending with YouTube. Injected by
  `engine.ts` into `resolveCookieSource({probeUrls})` because `tools.ts` must
  stay a dependency-free leaf. First success wins; a site refusing with
  "login required" does not count.
- **Network monitor**: `networkProbeUrls(sources)` puts configured sites' hosts
  first, then the other provider's, then generic endpoints, ending with
  `https://cloudflare.com/cdn-cgi/trace`.
- **RSS**: YouTube-only by construction; Bilibili spaces are watched by daemon
  rescans (`daemonMode` + `rescanIntervalHours`).

---

## 5. Additive API / UI surface

- `GET /api/sources` → per row: `provider`, `providerLabel`, `shape`
  (`null` / `"unknown"` for entries this UI would not accept).
- `POST /api/scan/batch` → `sources.byProvider` (only sites present in the
  batch); `videos`/`playlists`/`channels` now counted by shape, same values as
  before for YouTube-only batches.
- Dashboard: provider in each saved-source row, per-site batch stats, Bilibili
  wording in the friendly error mapper, both sites named in placeholders and
  notifications.

---

## 6. Test coverage map

| Area | Where |
| --- | --- |
| URL facts (hosts incl. look-alike rejection, every shape, param allowlists, `?p=`, `/en/` prefix, intl, b23 verbatim, id regexes, resolution precedence, folder fallbacks, probe ordering) | `tests/providers.test.ts` (34 tests) |
| Probe parse/gate/argv/process lifecycle | `tests/video-summary.test.ts` (23 tests) |
| Listing parse + ingest + scan of Bilibili sources | `tests/scanner.test.ts` (`bilibili-list`, `bilibili-space` fixture modes) |
| End-to-end: scan → probe → named files → `bilibili <BV…>` archive; exactly one probe per job; `/api/sources` contract | `tests/integration.test.ts` "integration: Bilibili sources" scenario 1 (real engine + provider-aware mock) |
| End-to-end: probe fails (412 wording) → videos still download under placeholder names, 3 `error.log` lines, no probe storm | same file, scenario 2 |
| Failure classification | `tests/retry.test.ts` "Bilibili wordings" |
| RSS skipping | `tests/rss.test.ts` |
| Cookie probe targeting | `tests/cookie-sources.test.ts` |
| API contracts (sources list, mixed batch) | `tests/sources.test.ts` |
| Whole pipeline regressions (YouTube unchanged) | the pre-existing 700+ tests, all green |

Mock knobs for the summary probe: `FAKE_SUMMARY_TITLE`, `FAKE_SUMMARY_DURATION`,
`FAKE_SUMMARY_NA`, `FAKE_SUMMARY_FAIL`, `FAKE_SUMMARY_HANG`, `FAKE_SUMMARY_LOG`.
Test-only watchdog override: `YTA_SUMMARY_PROBE_TIMEOUT_MS`.

---

## 7. Design decisions (and why)

1. **One provider leaf (`providers.ts`)** instead of sprinkling `if (bilibili)`
   through sources/scanner/retry — URL facts are the part that rots, so they
   live in one pure, unit-tested module; AGENTS.md gotcha 45 forbids copies.
2. **`%(webpage_url)s` + `%(url)s` appended LAST** to the listing template: an
   older yt-dlp or a simpler mock still parses, and absent trailing fields stay
   absent (scanner tests compare whole objects).
3. **`NA` means missing**, never a title — otherwise Bilibili files would be
   `001 - NA.mp4` and the backfill gate would never fire.
4. **Backfill before the plan, never after bytes exist**: the title names the
   file and the duration sizes the watchdog *only* at first-attempt time; a
   later rename would orphan the `.part` + `.aria2` the resume depends on.
5. **Missing duration alone triggers the probe** (even with a real title):
   without a duration `computeDownloadTimeoutMs()` returns the configured
   MINIMUM and the watchdog kills long uploads.
6. **`--no-playlist` on every download**: a job is one video; an anthology page
   or a legacy `watch?v=…&list=…` row must not expand into a list.
7. **Risk control is transient, login gates are not terminal**: the first
   retries itself; the second is rescued by dropping in `cookies.txt` (the
   cookies watcher requeues credential-blocked jobs).
8. **No id namespacing**: YouTube 11-char ids and Bilibili `BV…/av…/au…/ep…`
   shapes cannot realistically collide in the global `jobs.id` PK; documented
   instead of adding a migration (AGENTS.md gotcha 44).
9. **Additive API keys only** — the dashboard reads response keys by name
   (gotcha 41), so nothing was renamed or removed.
10. **`tools.ts` stays a leaf**: probe URLs are injected from `engine.ts`
    rather than imported, preserving the acyclic import graph.

---

## 8. Gaps, limitations and unverified areas

### 8.1 Never exercised against the real site (sandbox has no network)

- Every Bilibili behaviour above is pinned against **yt-dlp's documented
  extractor semantics** (`yt_dlp/extractor/bilibili.py`: `_VALID_URL` shapes,
  flat-getter output, archive prefixes, error strings) and a faithful mock.
  Real-world drift (API changes, new risk-control codes, new page layouts) will
  surface as scan/probe failures, not as silent misbehaviour — but it *will*
  surface only in production.
- **yt-dlp version sensitivity**: Bilibili extractors change often. An old
  yt-dlp is the most likely cause of "source lists nothing" or `-412/-352`;
  README says so and points at `yt-dlp -U`. The engine's self-update stays
  limited to YouTube signature failures on purpose.
- **Quality reality**: anonymous Bilibili typically caps below 1080p and some
  videos (the "Login … 30-second preview" class seen on
  `BV1WTnozqEd3`) may refuse anonymous extraction entirely or yield preview-only
  formats. A logged-in `cookies.txt` is the remedy; 4K/HDR additionally needs
  premium. Not testable here.
- Subtitles/thumbnails/descriptions for Bilibili go through yt-dlp's own
  sidecar support (JSON-derived subs converted to VTT/SRT); untested live.
- Bangumi/cheese episodes are mostly login- or purchase-gated: the terminal
  labels exist and are unit-tested, but no live run confirmed the wording
  yt-dlp currently emits for each gate.

### 8.2 Shapes deliberately not supported

- **Live rooms** (`live.bilibili.com/<room>`), **dynamic posts**
  (`t.bilibili.com`), **articles** (`/read/cv…`), blackboard/campaign pages
  without `bvid`: rejected as sources. Recording live streams is a different
  feature (no stable id, no finite duration).
- **`b23.tv` short links** are stored verbatim and classified `video`. If a
  short link happens to point at a *list*, the scan still lists it correctly
  (provider comes from the source URL), but the dashboard counts/labels it as a
  video, and a short link to something unsupported fails at scan time.
- **Hidden-mode collection ids** (`{mid}_{sid}`) never become jobs (they are
  lists); the *source* form for them is `space…/lists/<sid>`.
- **A third provider** (or "any site via GenericIE") is intentionally out of
  scope: printed `webpage_url`s are accepted only when they canonicalize for a
  known provider, and unknown sources keep YouTube-shaped defaults via
  `listingProvider() = providerOfUrl() ?? "youtube"`.

### 8.3 Behavioural edges worth knowing

- **Probe cost**: one extra bounded metadata call per job before its first
  download (a 162-part anthology ⇒ 162 probes, one per part — titles differ per
  part, so caching across parts is impossible). Bounded at 60 s each, skipped
  forever once bytes exist. Legacy YouTube rows with NULL duration also get one
  probe on their next download (self-healing, slight extra cost).
- **Placeholder names are sticky by design**: jobs that already downloaded
  under `"video"` keep their file names; the gate refuses to rename over
  existing bytes/partials.
- **`singleVideo` on an anthology** (`/video/BV…` without `?p=`) cannot reduce
  the listing to one part — the extractor returns all parts; use `?p=N`. The
  checkbox only affects links that carry both a video and a list
  (`watch?v=…&list=…`, `/list/…?bvid=`), as before.
- **`update_config.ts`** (terminal manager) keeps its historical rule that the
  *playlists* list holds lists: a bare video URL (YouTube or Bilibili) is
  rejected there exactly as before; the Web UI remains the way to save single
  videos.
- **One `cookiesFile` for both sites**: for a Bilibili-only config the validity
  probe asks Bilibili first — a cookies.txt holding only YouTube cookies will
  therefore be judged invalid for that config and the engine falls back to
  browsers/anonymous (logged). Mixed configs probe YouTube first.
- **Scan timeouts**: a Bilibili *list* uses the 10-minute total watchdog; a
  *space* (channel-shaped) uses the 30-minute idle watchdog. Very large
  favourites lists are streamed batch-by-batch, so downloads start before the
  listing finishes.
- **Risk control during scans**: 412/352 is transient → up to 3 scan attempts
  with backoff, then that source fails for this run and the daemon rescan
  retries it later. A 162-part batch at full speed is the most likely trigger;
  `sleepInterval`/rate limits mitigate.
- **Archive prefixes**: real yt-dlp writes the extractor key (`bilibili`,
  `BiliBiliBangumi`, `BiliIntl`, …); the engine only reads the *last* field of
  each line, so all of them work — but the mock only emits `youtube`/`bilibili`.
- **CJK titles/folders** are sanitizer-safe (`hardenName` keeps CJK, strips
  illegal chars) and covered at parse level; filename-length budgeting
  (`fitBaseFilename`) applies as everywhere else.

### 8.4 UI / UX gaps

- No provider **icon or filter** in the dashboard queue — provider is visible
  on saved-source rows and batch stats only; job rows do not say which site
  they came from (the URL does).
- No per-site quality presets (Bilibili's 1080p+ / 4K / HDR tiers map onto the
  generic `QUALITY_FORMATS` ladder; a premium-only format answers "Requested
  format is not available" and steps the ladder down).
- The batch-import modal and saved-sources panel show counts/labels, but there
  is no per-provider summary card.

### 8.5 Documentation and process gaps

- README/AGENTS.md and this file are updated; the **TUI** (`dashboard.ts`) has
  no Bilibili-specific wording because none was needed (it renders titles and
  counters only).
- The two integration scenarios use the mock's fixed three BV ids; an e2e run
  of an anthology (`_pN` ids through the *whole* engine) is covered at unit
  level (scanner ingest) but not end-to-end.
- `gh` PR not opened (not requested); branch contains exactly the two commits
  listed above.

---

## 9. Operator notes (quick reference)

- Paste any shape from §2 anywhere; anthologies queue one job per part.
- For HD/login-gated Bilibili: drop a bilibili.com `cookies.txt` next to
  `config.json` — picked up within a minute, no restart.
- Throttling (`412`/`352`/rate limit) shows as "⏳ Bilibili rate control —
  retrying later" in the dashboard and retries automatically; parked rows with
  "Supporter-only video" / "Paid video" / "Deleted or region-locked" will not
  retry on their own.
- Keep yt-dlp recent (`yt-dlp -U`); the JS-runtime requirement remains
  YouTube-only.

*Cross-references: README.md §"Bilibili sources"; AGENTS.md gotchas 45–47 and
§11 task rows; `tests/providers.test.ts` and `tests/video-summary.test.ts` are
the executable specification of everything in §2–§4.*
