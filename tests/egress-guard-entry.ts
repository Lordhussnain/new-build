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

// `export {}` marks this file as a module (required for the top-level await
// below). It imports nothing, so nothing can be hoisted ahead of the guard.
export {};

if (process.env.YTA_EGRESS_GUARD === "1") {
  const originalFetch = globalThis.fetch;

  const isLocalHost = (host: string): boolean =>
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]";

  const assertLocal = (what: string, host: string): void => {
    if (!isLocalHost(host)) {
      throw new Error(`[egress-guard] blocked non-local ${what} to ${host} — set YTA_EGRESS_GUARD=0 to allow`);
    }
  };

  // Bun's fetch carries a non-standard `preconnect()` (DNS/TCP warm-up), so
  // the replacement is assembled with Object.assign to satisfy `typeof
  // fetch`. preconnect is guarded too — it also opens network connections.
  globalThis.fetch = Object.assign(
    async function guardedFetch(this: typeof globalThis, input: any, init?: any): Promise<Response> {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      assertLocal("fetch", new URL(url).hostname);
      return originalFetch.call(this, input, init);
    },
    {
      preconnect(url: string | URL, options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean }): void {
        assertLocal("preconnect", new URL(url).hostname);
        originalFetch.preconnect(url, options);
      },
    },
  );
}

// Dynamic import: runs after the guard is installed, not before.
await import("../batch_playlist_downloader");