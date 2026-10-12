// tests/lan-mode.test.ts — the per-run `--lan` / YTA_LAN override.

import { describe, expect, test } from "bun:test";
import { effectiveWebToken, lanOverrideFromRuntime, setRuntimeWebToken, webTokenOverrideFromRuntime } from "../src/config";

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

describe("CLI web token", () => {
  test("--webtoken takes the value that follows it, with or without =", () => {
    expect(webTokenOverrideFromRuntime(["--port", "3000", "--lan", "--webtoken", "789654"])).toBe("789654");
    expect(webTokenOverrideFromRuntime(["--webtoken=789654"])).toBe("789654");
  });

  test("keeps the case of the token and trims surrounding spaces", () => {
    expect(webTokenOverrideFromRuntime(["--webtoken", "  AbC-123  "])).toBe("AbC-123");
  });

  test("returns null when absent and the last value wins", () => {
    expect(webTokenOverrideFromRuntime(["--lan"])).toBeNull();
    expect(webTokenOverrideFromRuntime(["--webtoken", "one", "--webtoken=two"])).toBe("two");
  });

  test("a missing or blank value is an error, never silently ignored", () => {
    expect(() => webTokenOverrideFromRuntime(["--webtoken"])).toThrow("--webtoken");
    expect(() => webTokenOverrideFromRuntime(["--webtoken", "--lan"])).toThrow("--webtoken");
    expect(() => webTokenOverrideFromRuntime(["--webtoken="])).toThrow("--webtoken");
    expect(() => webTokenOverrideFromRuntime(["--webtoken", "   "])).toThrow("--webtoken");
  });

  test("the run token overrides config.json without changing it", () => {
    try {
      expect(effectiveWebToken({ webToken: "from-config" })).toBe("from-config");
      setRuntimeWebToken("789654");
      expect(effectiveWebToken({ webToken: "from-config" })).toBe("789654");
      expect(effectiveWebToken({ webToken: "" })).toBe("789654");
    } finally {
      setRuntimeWebToken(null);
    }
  });
});

describe("web UI auth uses the run token", () => {
  test("a request must present the CLI token when it is set", async () => {
    const { isAuthorized } = await import("../src/web");
    try {
      setRuntimeWebToken("789654");
      const cfg = { webToken: "" } as any;
      const url = new URL("http://127.0.0.1:3000/api/status");
      expect(isAuthorized(new Request(url, { headers: { "X-Web-Token": "789654" } }), url, cfg)).toBe(true);
      expect(isAuthorized(new Request(url, { headers: { "X-Web-Token": "wrong" } }), url, cfg)).toBe(false);
      expect(isAuthorized(new Request(url), url, cfg)).toBe(false);
    } finally {
      setRuntimeWebToken(null);
    }
  });
});
