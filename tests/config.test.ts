// tests/config.test.ts — shared config schema: defaults, validation, loading.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigSafe,
  parseConfig,
  saveConfig,
  CONFIG_PATH,
} from "../src/config";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function tmpConfigFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yta-config-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  await writeFile(path, contents);
  return path;
}

describe("DEFAULT_CONFIG", () => {
  test("is valid against the schema", () => {
    expect(() => ConfigSchema.parse(DEFAULT_CONFIG)).not.toThrow();
  });

  test("ships reliability and format defaults", () => {
    expect(DEFAULT_CONFIG.maxResumeAttempts).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.retryBackoffBaseSeconds).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.requeueFailedAfterMinutes).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.verifyExistingFiles).toBe(true);
    expect(DEFAULT_CONFIG.downloadTimeoutMinutes).toBeLessThanOrEqual(DEFAULT_CONFIG.maxDownloadMinutes);
    expect(DEFAULT_CONFIG.targetFormat).toBe("mp4");
    expect(DEFAULT_CONFIG.subtitleFormat).toBe("srt");
  });
});

describe("parseConfig", () => {
  test("fills missing keys from defaults", () => {
    const parsed = parseConfig({ webPort: 8080 });
    expect(parsed.webPort).toBe(8080);
    expect(parsed.maxConcurrentDownloads).toBe(DEFAULT_CONFIG.maxConcurrentDownloads);
    expect(parsed.targetFormat).toBe("mp4");
    expect(parsed.subtitleFormat).toBe("srt");
  });

  test("rejects out-of-range values", () => {
    expect(() => parseConfig({ webPort: 99999 })).toThrow();
    expect(() => parseConfig({ videoQuality: "4k" })).toThrow();
    expect(() => parseConfig({ targetFormat: "avi" })).toThrow();
    expect(() => parseConfig({ subtitleFormat: "txt" })).toThrow();
    expect(() => parseConfig({ maxConcurrentDownloads: 0 })).toThrow();
  });

  test("rejects contradictory backoff/window settings", () => {
    expect(() => parseConfig({ retryBackoffBaseSeconds: 600, retryBackoffMaxSeconds: 60 })).toThrow();
    expect(() => parseConfig({ downloadTimeoutMinutes: 120, maxDownloadMinutes: 30 })).toThrow();
    expect(() => parseConfig({ minDownloadWorkers: 8, maxDownloadWorkers: 4 })).toThrow();
  });
});

describe("loadConfig (engine)", () => {
  test("creates a default config when the file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    const config = await loadConfig(path);
    expect(config).toEqual(DEFAULT_CONFIG);
    // ...and the file now exists on disk
    const again = await loadConfig(path);
    expect(again).toEqual(DEFAULT_CONFIG);
  });

  test("parses an existing config", async () => {
    const path = await tmpConfigFile(JSON.stringify({ webPort: 4321, playlists: ["https://x"] }));
    const config = await loadConfig(path);
    expect(config.webPort).toBe(4321);
    expect(config.playlists).toEqual(["https://x"]);
  });
});

describe("loadConfigSafe (config manager)", () => {
  test("falls back to defaults on invalid JSON", async () => {
    const path = await tmpConfigFile("{ not json");
    const config = await loadConfigSafe(path);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("falls back to defaults on schema violations", async () => {
    const path = await tmpConfigFile(JSON.stringify({ webPort: -1 }));
    const config = await loadConfigSafe(path);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("returns defaults for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-config-"));
    dirs.push(dir);
    const config = await loadConfigSafe(join(dir, "nope.json"));
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

describe("saveConfig", () => {
  test("round-trips through the schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    const config = { ...DEFAULT_CONFIG, webPort: 5555, maxResumeAttempts: 2 };
    await saveConfig(config, path);
    const loaded = await loadConfigSafe(path);
    expect(loaded.webPort).toBe(5555);
    expect(loaded.maxResumeAttempts).toBe(2);
  });

  test("rejects an invalid config before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yta-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    await expect(saveConfig({ ...DEFAULT_CONFIG, webPort: 0 }, path)).rejects.toThrow();
  });
});

describe("CONFIG_PATH", () => {
  test("points at the repo-root config.json", () => {
    expect(CONFIG_PATH).toBe("./config.json");
  });
});
