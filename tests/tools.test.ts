// tests/tools.test.ts — aria2c availability: vanished-binary fallback + mid-run discovery.
//
// The engine resolves aria2c once at startup. Two things can change after that:
// the binary vanishes (uninstalled mid-run → fall back to the native
// downloader instead of failing every download) or appears (installed mid-run
// → pick it up without a restart).

import { afterEach, describe, expect, test } from "bun:test";
import { aria2cUsable, refreshAria2cDiscovery, resolvedTools } from "../src/tools";

// resolvedTools is process-global: every test restores whatever it found.
const initialAria2c = resolvedTools.aria2cPath;
afterEach(() => {
  resolvedTools.aria2cPath = initialAria2c;
});

describe("aria2cUsable", () => {
  test("false when no binary was ever resolved", () => {
    resolvedTools.aria2cPath = null;
    expect(aria2cUsable()).toBe(false);
  });

  test("false when the resolved binary vanished mid-run", () => {
    resolvedTools.aria2cPath = "/definitely/not/here/aria2c";
    expect(aria2cUsable()).toBe(false);
  });

  test("true when the resolved binary is still on disk", () => {
    resolvedTools.aria2cPath = process.execPath; // any existing file answers existsSync
    expect(aria2cUsable()).toBe(true);
  });

  test("true for a bare name already probed on PATH", () => {
    resolvedTools.aria2cPath = "aria2c";
    expect(aria2cUsable()).toBe(true);
  });
});

describe("refreshAria2cDiscovery", () => {
  test("is a no-op when a binary is already known", async () => {
    resolvedTools.aria2cPath = "/already/known/aria2c";
    expect(await refreshAria2cDiscovery({})).toBe(false);
    expect(resolvedTools.aria2cPath).toBe("/already/known/aria2c");
  });

  test('honours the "none" opt-out', async () => {
    resolvedTools.aria2cPath = null;
    expect(await refreshAria2cDiscovery({ aria2cPath: "none" })).toBe(false);
    expect(resolvedTools.aria2cPath).toBeNull();
  });

  test("picks up a binary that appears mid-run", async () => {
    // process.execPath answers `--version` with exit 0 on every platform, so
    // it stands in for an aria2c installed after startup.
    resolvedTools.aria2cPath = null;
    expect(await refreshAria2cDiscovery({ aria2cPath: process.execPath })).toBe(true);
    expect(resolvedTools.aria2cPath ?? "<none>").toBe(process.execPath);
    expect(aria2cUsable()).toBe(true);
  });
});
