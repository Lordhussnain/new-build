// tests/egress-guard-entry.ts — engine entry point with optional egress guard.
//
// When YTA_EGRESS_GUARD=1 is set, `fetch` is replaced with a version that
// rejects any request to a non-local host. This makes the integration test
// suite fail fast if a future feature quietly re-introduces internet
// dependence — the exact kind of regression the mocks are designed to catch.
//
// Spawned by the integration test harness instead of the bare engine entry.
//
// NOTE: the guard MUST be set up before the engine imports run, so the
// engine entry is loaded via dynamic import() (static imports are hoisted
// and would execute before this module's top-level code).

if (process.env.YTA_EGRESS_GUARD === "1") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(input: any, init?: any) {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const host = new URL(url).hostname;
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]";
    if (!isLocal) {
      throw new Error(`[egress-guard] blocked non-local fetch to ${host} — set YTA_EGRESS_GUARD=0 to allow`);
    }
    return originalFetch.call(this, input, init);
  };
}

// Dynamic import: runs after the guard is installed, not before.
await import("../batch_playlist_downloader.ts");