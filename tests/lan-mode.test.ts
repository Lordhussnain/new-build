// tests/lan-mode.test.ts — the per-run `--lan` / YTA_LAN override.

import { describe, expect, test } from "bun:test";
import { lanOverrideFromRuntime } from "../src/config";

describe("CLI LAN override", () => {
  test("--lan turns LAN access on for this run", () => {
    expect(lanOverrideFromRuntime(["--port", "3000", "--lan"], {})).toBe(true);
    expect(lanOverrideFromRuntime(["--lan=true"], {})).toBe(true);
  });

  test("--lan=false and --no-lan turn it off", () => {
    expect(lanOverrideFromRuntime(["--lan=false"], {})).toBe(false);
    expect(lanOverrideFromRuntime(["--no-lan"], {})).toBe(false);
  });

  test("returns null when absent, so the stored webBind stands", () => {
    expect(lanOverrideFromRuntime(["--port", "3000"], {})).toBeNull();
  });

  test("the last flag wins, and an unparsable value is ignored", () => {
    expect(lanOverrideFromRuntime(["--lan", "--no-lan"], {})).toBe(false);
    expect(lanOverrideFromRuntime(["--lan", "--lan=banana"], {})).toBe(true);
  });

  test("YTA_LAN is used when no flag is given, and the command line wins over it", () => {
    expect(lanOverrideFromRuntime([], { YTA_LAN: "1" })).toBe(true);
    expect(lanOverrideFromRuntime([], { YTA_LAN: "false" })).toBe(false);
    expect(lanOverrideFromRuntime(["--no-lan"], { YTA_LAN: "1" })).toBe(false);
  });
});
