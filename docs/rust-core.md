# Rust native core

CPU-only validation, parsing and policy hot paths are implemented in
`native/src/` and loaded through N-API by `src/native-core.ts`. The public
TypeScript APIs have not changed.

| Area | Rust implementation | TypeScript responsibility |
| --- | --- | --- |
| `src/config.ts` | Complete config deserialization, ranges, enums, User-Agent checks, cross-field rules, CLI/environment overrides | Defaults and Zod compatibility schema, async load/save, atomic replacement |
| `src/settings.ts` | Allow-list enforcement, form-value coercion, merged-config validation | Field metadata/UI, network-exposure guard, persistence, live state |
| `src/sources.ts` | URL validation/canonicalization, single-video handling, identities, batch parsing | Config write lock, source tombstones, SQLite cleanup |
| `src/tools.ts` | Tool candidate generation/de-duplication and Bun interpreter detection | Async executable probes, dependency reporting, cookies and subprocesses |
| `src/audio-tracks.ts` | Audio-only stream filtering, best-track selection, language overrides and multi-audio format construction | yt-dlp probing, subprocess timeout/cancellation, database JSON storage |
| `src/download-output.ts` | Explicit output-path validation and aria2c progress-readout parsing | Streaming UTF-8 decoding, bounded diagnostic tails and pipe lifecycle |
| `src/autoscale.ts`, `src/download-args.ts` | Slot-target decisions, connection/fragment budgets, split-size parsing, engine selection, effective quality/container overrides, aria2c argument planning and bandwidth shares | Live worker state, SQLite demand queries, filename/path fitting and complete argv construction |
| `src/retry.ts` | Backoff/jitter, duration watchdogs, progress-aware retry budgets, transient/permanent/credential/resume classification, terminal records and format-fallback policy | Worker orchestration, timers, database writes and error-report presentation |
| `src/db.ts` | Claim column descriptors, claim references, CAS UPDATE SQL, release SET clauses and per-video retry-cap selection | Bun SQLite execution, transactions, bindings, heartbeats and all schema mutations |
| `src/lease.ts` | Lease expiry, owner/fencing checks and acquire/renew/refuse/take-over decisions | Same-host PID probes, SQLite immediate transactions, renewal SQL and heartbeat timers |
| `src/reconcile.ts` | Stale-claim thresholds/predicates, cooldown modifiers, partial sidecar paths and orphan/partial cleanup decisions | Filesystem walks/removal, resume-path discovery, SQLite sweeps and superseded-file recovery |
| `src/scanner.ts` | Batched listing-field parsing, video/playlist/channel classification, channel/Shorts suffixes, compatible YouTube URL normalization, Shorts decisions and pure ingest-plan values | Streaming UTF-8 decoding, ECMAScript `parseFloat`, yt-dlp execution, source expansion, archive/dedupe lookups, index allocation and SQLite transactions |
| `src/archive.ts` | One-pass unique ID extraction in stable order and exact archive-record removal/filtering | UTF-8 file decoding, existence checks, reads/writes/appends and the returned `Set` |

The native functions are synchronous and CPU-only. Batch APIs amortize the N-API
boundary over listing lines and ingest items. Network requests, `yt-dlp`/`ffmpeg`,
filesystem operations, and SQLite stay in Bun; moving those behind blocking
N-API calls would make the application less responsive. Listing durations retain
JavaScript `parseFloat` semantics, and unusual URLs/IDs use explicit TypeScript
compatibility paths instead of risking parser differences.

## TypeScript connection audit

`native/src/lib.rs` is the single N-API boundary and `src/native-core.ts` is the
single TypeScript loader/bridge. The bridge currently checks **56 exports at ABI
4** before a binary can be used. `tests/native-core.test.ts` also checks that
every Rust module is registered and every export has an explicit TypeScript
consumer. `abiVersion` is consumed by the loader itself. `defaultConfig` is a
direct parity contract only: shipped defaults intentionally remain owned by
`src/config.ts`, so there is no hidden second defaults path at runtime.

## Build

Install [Rust](https://rustup.rs/) (stable) and Bun, then run:

```bash
bun install
bun run build:native   # native/yta-core.node
bun run check         # TypeScript + compatibility tests
cargo test --manifest-path native/Cargo.toml
```

`build:win`, `build:win:config`, and `build:win:all` build the native core
automatically. They also copy `yta-core.node` into `dist/`; keep this file beside
the generated `.exe` files when distributing them. It is a native library, not
embedded in Bun's compiled executable. On non-Windows build hosts these commands
select `x86_64-pc-windows-msvc`; install that Rust target and a compatible MSVC
linker, or build on Windows, rather than accidentally packaging a host-native
library.

## Development fallback

If `native/yta-core.node` has not been built, the existing TypeScript/Zod
implementations remain available so `bun run start` and `bun test` still work.
Use the native build when benchmarking or producing a release.

- `YTA_DISABLE_NATIVE=1` forces the TypeScript path for parity testing.
- `YTA_REQUIRE_NATIVE=1` fails startup instead of falling back when no compatible
  native module is available (useful for release/performance verification).
- `YTA_NATIVE_CORE=/absolute/path/to/yta-core.node` loads a specific trusted binary.
- `nativeCoreStatus` in `src/native-core.ts` reports whether native code loaded.

The loader checks every required export and an ABI version before using a
binary. Responses must match a strict JSON envelope with explicit error codes.
Rust panics are contained at the N-API boundary and reported as operational
`NativeCoreError` failures, never as invalid user input. A native validation
error is **not** treated as a missing module and never silently falls back to
different validation rules.

## Performance expectations

Rust can reduce CPU time and allocation for large metadata/source/listing batches,
archive parsing, repeated validation and output parsing. It does not make YouTube transfers or
ffmpeg conversion inherently faster: those workloads are dominated by the
network and external processes. Small N-API calls also have a boundary cost, so
benchmark representative workloads before claiming an end-to-end speedup.
