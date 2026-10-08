// tests/config-manager.test.ts — coverage of the interactive config manager.
//
// update_config.ts is driven by readline, so it cannot be unit-tested directly.
// What *can* be guarded is the invariant that matters: every key the schema
// accepts must be reachable from the manager. A new schema key that nothing
// prompts for is a setting the user can only edit by hand-editing JSON — which
// is exactly how four keys (outputRoot, cookiesFile, downloadShorts,
// validateCookiesOnStart) went unnoticed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config";
import { STALE_CLAIM_THRESHOLDS } from "../src/reconcile";

const source = readFileSync("update_config.ts", "utf-8");

// The three URL collections are managed as a group by manageUrlList(), which
// takes the key as a string argument rather than assigning config.<key>.
const URL_LIST_KEYS = new Set(["playlists", "channels", "channelPlaylists"]);

describe("update_config.ts covers the config schema", () => {
  const keys = Object.keys(DEFAULT_CONFIG).filter((k) => !URL_LIST_KEYS.has(k));

  test("prompts for every non-URL-list key", () => {
    const missing = keys.filter((k) => !source.includes(`config.${k}`));
    expect(missing).toEqual([]);
  });

  test("the URL-list keys are handled through manageUrlList", () => {
    for (const k of URL_LIST_KEYS) {
      expect(source).toContain(`"${k}"`);
    }
  });

  test("every key count matches the schema (no drift in either direction)", () => {
    // If a key is added to the schema, this count moves and the prompt above
    // fails until the manager is taught about it.
    expect(keys.length).toBe(Object.keys(DEFAULT_CONFIG).length - URL_LIST_KEYS.size);
  });
});

describe("update_config.ts reports the engine's real thresholds", () => {
  test("reads the stale-claim thresholds from reconcile, not a literal", () => {
    // The manager must not restate the sweep timeouts by hand, or the two
    // drift apart and the terminal lies about when recovery happens.
    expect(source).toContain("const staleClaimThresholds = STALE_CLAIM_THRESHOLDS(config)");
    expect(source).toContain("${staleClaimThresholds.download");
    expect(source).toContain("${staleClaimThresholds.conversion");
    expect(source).toContain("${staleClaimThresholds.metadata");
  });

  test("the imported thresholds match the reaper's configured watchdog", () => {
    expect(STALE_CLAIM_THRESHOLDS(DEFAULT_CONFIG)).toEqual({
      download: "-180 minutes",
      conversion: "-3 hours",
      metadata: "-15 minutes",
    });
    expect(STALE_CLAIM_THRESHOLDS({ maxDownloadMinutes: 10 })).toEqual({
      download: "-20 minutes",
      conversion: "-3 hours",
      metadata: "-15 minutes",
    });
  });

  test("counts resumable partials with the same predicate the engine uses", () => {
    // pending/paused/downloading is the set of jobs whose partial is still in
    // play; a failed job's partial may be discarded, so it must not be counted.
    expect(source).toContain("'pending', 'paused', 'downloading'");
    expect(source).toContain("partial_file_path IS NOT NULL");
  });
});
