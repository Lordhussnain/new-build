import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { EDITABLE_SETTINGS } from "../src/settings";
import {
  NATIVE_ABI_VERSION,
  NATIVE_CORE_METHODS,
  NativeCoreError,
  nativeCore,
  nativeCoreStatus,
  nativeEnvelope,
  nativeValue,
} from "../src/native-core";

const unavailable = nativeCore === null;

describe("Rust native core", () => {
  test("the bridge reports its availability consistently", () => {
    expect(nativeCoreStatus.available).toBe(nativeCore !== null);
  });

  test("required native mode fails fast for a missing explicit binary", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", 'await import("./src/native-core.ts")'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        YTA_REQUIRE_NATIVE: "1",
        YTA_DISABLE_NATIVE: "0",
        YTA_NATIVE_CORE: join(tmpdir(), "yta-core-intentionally-missing.node"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("No compatible Rust native core");
  });

  test("Rust N-API exports and ABI version exactly match the TypeScript bridge", () => {
    const rust = readFileSync("native/src/lib.rs", "utf8");
    const exported = [...rust.matchAll(/#\[napi\(js_name = "(\w+)"\)\]/g)].map((match) => match[1]);
    expect(exported).toEqual([...NATIVE_CORE_METHODS]);
    const abi = Number(rust.match(/YTA_CORE_ABI_VERSION:\s*u32\s*=\s*(\d+)/)?.[1]);
    expect(abi).toBe(NATIVE_ABI_VERSION);
  });

  test("every Rust module and export has an explicit TypeScript connection", () => {
    const rust = readFileSync("native/src/lib.rs", "utf8");
    for (const file of readdirSync("native/src")) {
      if (!file.endsWith(".rs") || file === "lib.rs") continue;
      expect(rust).toContain(`mod ${file.slice(0, -3)};`);
    }

    const sourceFiles: string[] = [];
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (entry.name.endsWith(".ts")) sourceFiles.push(path);
      }
    };
    collect("src");
    const production = sourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const method of NATIVE_CORE_METHODS) {
      if (method === "defaultConfig") {
        // Defaults intentionally remain TypeScript-owned; this export is a
        // direct native parity contract rather than a runtime dependency.
        expect(readFileSync("tests/native-core.test.ts", "utf8")).toContain("nativeCore!.defaultConfig()");
      } else {
        const call = method === "abiVersion" ? "loaded.abiVersion()" : `nativeCore.${method}`;
        expect(production).toContain(call);
      }
    }
  });

  test("Rust config wire names cover every TypeScript default in schema order", () => {
    // This guard runs even before the native binary is built. In particular,
    // Serde's automatic camelCase would spell KBps/GB differently from the
    // existing config.json API unless the explicit renames stay in place.
    const rust = readFileSync("native/src/config.rs", "utf8");
    const body = rust.match(/pub struct Config \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const keys: string[] = [];
    let explicitName: string | null = null;
    for (const line of body.split("\n")) {
      const rename = line.match(/#\[serde\(rename = "(\w+)"\)\]/);
      if (rename) {
        explicitName = rename[1];
        continue;
      }
      const field = line.match(/^\s*pub (\w+):/);
      if (!field) continue;
      const parts = field[1].split("_");
      keys.push(explicitName ?? (parts[0] + parts.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join("")));
      explicitName = null;
    }
    expect(keys).toEqual(Object.keys(DEFAULT_CONFIG));
  });

  test("the wire envelope preserves legitimate null values", () => {
    expect(nativeValue<null>('{"ok":true,"value":null}')).toBeNull();
  });

  test("malformed native responses are rejected instead of reaching application code", () => {
    for (const raw of [
      "not json",
      "null",
      '{"ok":true}',
      '{"ok":"yes","value":1}',
      '{"ok":false,"error":{"message":"missing code and path"}}',
      '{"ok":false,"error":{"code":"X","message":"bad path","path":{}}}',
    ]) {
      expect(() => nativeEnvelope(raw)).toThrow(NativeCoreError);
    }
  });

  test("native failures retain their operational code and validation details", () => {
    let caught: unknown;
    try {
      nativeValue(JSON.stringify({
        ok: false,
        error: {
          code: "NATIVE_PANIC",
          message: "native failed",
          path: ["webPort"],
          issues: [{ message: "invalid", path: ["webPort"] }],
        },
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NativeCoreError);
    expect((caught as NativeCoreError).code).toBe("NATIVE_PANIC");
    expect((caught as NativeCoreError).path).toEqual(["webPort"]);
    expect((caught as NativeCoreError).issues?.[0].message).toBe("invalid");
  });

  test.skipIf(unavailable)("Rust defaults stay in parity with the TypeScript compatibility defaults", () => {
    expect(nativeValue<Config>(nativeCore!.defaultConfig())).toEqual(DEFAULT_CONFIG);
  });

  test.skipIf(unavailable)("native settings preparation coerces and validates a complete config", () => {
    const prepared = nativeValue<{ config: Config; coerced: Record<string, unknown> }>(
      nativeCore!.prepareSettings(
        JSON.stringify(DEFAULT_CONFIG),
        JSON.stringify({ connectionsPerDownload: "12", useAria2c: "off" }),
        JSON.stringify(EDITABLE_SETTINGS.map(({ key, label, type }) => ({ key, label, type }))),
      ),
    );
    expect(prepared.config.connectionsPerDownload).toBe(12);
    expect(prepared.config.useAria2c).toBe(false);
    expect(Object.keys(prepared.coerced)).toEqual(["useAria2c", "connectionsPerDownload"]);
  });

  test.skipIf(unavailable)("native batch source parsing preserves input order and errors", () => {
    const outcomes = nativeValue<{ source?: { key: string; url: string }; error?: string }[]>(
      nativeCore!.parseSourceUrls(JSON.stringify([
        "https://youtu.be/AbCdEf12345",
        "not a url",
        "https://www.youtube.com/@Teacher/playlists",
      ]), false),
    );
    expect(outcomes[0].source?.url).toBe("https://www.youtube.com/watch?v=AbCdEf12345");
    expect(outcomes[1].error).toBeTruthy();
    expect(outcomes[2].source?.key).toBe("channelPlaylists");
  });

  test.skipIf(unavailable)("native audio processing preserves track selection and format construction", () => {
    const info = {
      formats: [
        { format_id: "251-0", vcodec: "none", acodec: "opus", tbr: 160, language: "en" },
        { format_id: "249-0", vcodec: "none", acodec: "opus", tbr: 70, language: "en" },
        { format_id: "251-0-drc", vcodec: "none", acodec: "opus", tbr: 160, language: "en" },
        { format_id: "251-1", vcodec: "none", acodec: "opus", tbr: 150, language: "es" },
        { format_id: "18", vcodec: "avc1", acodec: "mp4a", tbr: 500 },
      ],
    };
    const tracks = nativeValue<any[]>(nativeCore!.extractAudioTracks(JSON.stringify(info)));
    expect(tracks.map((track) => track.formatId)).toEqual(["251-0", "251-1"]);
    const selected = nativeValue<any[]>(nativeCore!.selectAudioTracks(JSON.stringify({
      tracks,
      mode: "off",
      wantedLanguages: [],
      jobSelection: [" ES "],
    })));
    expect(selected.map((track) => track.language)).toEqual(["es"]);
    expect(nativeValue<string>(nativeCore!.multiAudioFormatSelector(
      "bv[height<=1080]+ba/b[height<=1080]",
      JSON.stringify(tracks),
    ))).toBe("bv[height<=1080]+251-0+251-1/b[height<=1080]");
  });

  test.skipIf(unavailable)("native output parsers retain path and aria2c readout contracts", () => {
    expect(nativeValue<string | null>(nativeCore!.parseDownloadPath("FILEPATH:数学 🧮.mp4"))).toBe("数学 🧮.mp4");
    expect(nativeValue<string | null>(nativeCore!.parseDownloadPath("log FILEPATH:video.mp4"))).toBeNull();
    const readout = nativeValue<any>(nativeCore!.parseAria2cReadout(
      "[#208c72 1.4MiB/3.0MiB(48%) CN:16 DL:1.2MiB ETA:2m30s]",
    ));
    expect(readout).toEqual({
      percent: 48,
      speedBps: 1.2 * 1024 * 1024,
      etaSeconds: 150,
      totalBytes: 3 * 1024 * 1024,
      downloadedBytes: 1.4 * 1024 * 1024,
    });
  });

  test.skipIf(unavailable)("native scaling policy preserves slot and transfer budgets", () => {
    const decision = nativeValue<any>(nativeCore!.nextSlotTarget(JSON.stringify({
      current: 4,
      backlog: 10,
      inFlight: 0,
      minWorkers: 1,
      maxWorkers: 10,
      rampStep: 2,
      aggBps: 950,
      capBps: 1000,
      now: 1_000_000,
      lastScaleDownAt: 0,
    })));
    expect(decision).toEqual({ target: 3, bandwidthShed: true });
    expect(nativeValue<number>(nativeCore!.perDownloadTransfers(32, 10, 128))).toBe(12);
    expect(nativeValue<number | null>(nativeCore!.parseAria2cSplitSizeBytes("1.5M"))).toBe(1_572_864);
    expect(nativeValue<number | null>(nativeCore!.parseAria2cSplitSizeBytes("1 MB"))).toBe(1_048_576);
  });

  test.skipIf(unavailable)("native retry policy preserves terminal precedence and progress budgets", () => {
    const challenge = nativeValue<any>(nativeCore!.retryClassification(
      "NChallengeInput: n challenge failed; Requested format is not available",
    ));
    expect(challenge.nChallenge).toBe(true);
    expect(challenge.permanent).toBe(false);
    expect(challenge.formatAvailability).toBe(true);
    expect(challenge.transient).toBe(true);
    const hard = nativeValue<any>(nativeCore!.retryClassification("Private video. Login required"));
    expect(hard.terminal.code).toBe("private");
    expect(hard.permanent).toBe(true);
    expect(hard.credentialBlocked).toBe(false);
    expect(nativeValue<string>(nativeCore!.formatTerminalErrorMessage(
      JSON.stringify({ code: "private", label: "Private video" }),
      "ERROR: This video is private",
    ))).toContain("[terminal] Private video");
    expect(nativeValue<string | null>(nativeCore!.nextFormatFallback("480p"))).toBe("highest");
    expect(nativeValue<any>(nativeCore!.progressAwareRetryState(2, 20, 35, 4))).toEqual({
      retryCount: 2,
      bestProgress: 35,
      madeProgress: true,
      exhausted: false,
    });
    expect(nativeValue<number>(nativeCore!.computeBackoffMs(2, 30, 900, 0))).toBe(120_000);
    expect(nativeValue<number>(nativeCore!.computeDownloadTimeoutMs(1800, 15, 180))).toBe(5_700_000);
  });

  test.skipIf(unavailable)("native reliability planning preserves claim fencing and cleanup decisions", () => {
    expect(nativeValue<any>(nativeCore!.claimColumns("download"))).toEqual({
      status: "download_status",
      claimedStatus: "downloading",
      by: "download_claimed_by",
      at: "download_claimed_at",
      token: "download_claim_token",
      heartbeat: "download_heartbeat_at",
    });
    expect(nativeValue<any>(nativeCore!.claimRef("download", JSON.stringify({
      download_claimed_by: "dl-1",
      download_claim_token: "token",
    })))).toEqual({ by: "dl-1", token: "token" });
    expect(nativeValue<string>(nativeCore!.claimUpdateSql("download", "download_status = 'paused'", "download_heartbeat_at IS NULL"))).toBe(
      "UPDATE jobs SET download_status = 'paused' WHERE id = ? AND download_claim_token IS ? AND download_claimed_by IS ? AND (download_heartbeat_at IS NULL)",
    );
    expect(nativeValue<number>(nativeCore!.perVideoCap(JSON.stringify({ maxRetryAttempts: 7, maxFailuresPerVideo: 4 })))).toBe(4);
    const lease = JSON.stringify({ owner: "owner-a", fencing: 4 });
    const current = JSON.stringify({ owner: "owner-a", fencing: 4 });
    expect(nativeValue<boolean>(nativeCore!.leaseExpired(lease, 5000, 4000))).toBe(false);
    expect(nativeValue<boolean>(nativeCore!.holdsLease(lease, current, 5000, 4000))).toBe(true);
    expect(nativeValue<any>(nativeCore!.leaseAcquisition(lease, "owner-b", 5000, 4000, false)).decision).toBe("refuse");
    expect(nativeValue<any>(nativeCore!.staleClaimThresholds(45)).download).toBe("-45 minutes");
    expect(nativeValue<string[]>(nativeCore!.partialSidecars("video.part"))).toEqual(["video.part", "video.part.aria2"]);
    expect(nativeValue<any>(nativeCore!.partialCleanupDecision(JSON.stringify({
      status: "failed",
      retries: 4,
      lastError: "Private video",
      ageMs: 0,
      cap: 4,
      hasConfig: false,
      requeueFailedAfterMinutes: 0,
      partialMaxAgeMs: 604800000,
    }))).remove).toBe(true);
  });

  test.skipIf(unavailable)("native download argument planning preserves engine and aria2c defaults", () => {
    expect(nativeValue<string>(nativeCore!.resolveDownloaderEngine(true, false))).toBe("native");
    expect(nativeValue<any>(nativeCore!.effectiveDownloadFormat("bogus", null, "audio", "mp4", JSON.stringify(["audio", "1080p"])))).toEqual({
      quality: "audio",
      targetFormat: "mp3",
    });
    expect(nativeValue<string>(nativeCore!.buildAria2cArgs(32, 1, 128, "512K"))).toBe("-x 16 -s 32 -j 32");
    expect(nativeValue<string>(nativeCore!.buildAria2cArgs(32, 1, 128, "banana"))).toBe("-x 16 -s 32 -j 32 --min-split-size banana");
    expect(nativeValue<number | null>(nativeCore!.computePerWorkerLimitBytesPerSec(100, 4))).toBe(25_600);
  });
});
