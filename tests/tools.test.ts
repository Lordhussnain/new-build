// tests/tools.test.ts — dependency discovery (the "missing aria2c" path).
//
// aria2c is optional: discovery finds it when it is there, and when it is not
// the engine transparently uses yt-dlp's native downloader. The integration
// suite pins the fallback through the documented `aria2cPath: "none"` switch,
// which skips discovery entirely — so a bug in the search itself (an exception
// instead of "not found", a candidate list that never ends) would go unnoticed.
// These tests run the real candidate walk against a real, empty search space.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { bunInterpreterPath, jsRuntimeArgs, resolveJsRuntime, resolveTool } from "../src/tools";

const WIN = process.platform === "win32";

const tmpDirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * A stand-in for the aria2c binary: prints a version and exits 0.
 *
 * The shebang points at this test runner's own interpreter, so the shim runs
 * with whatever PATH the test injects — `#!/usr/bin/env bun` would need `bun`
 * on that PATH, which is exactly what a "missing binary" search must not have.
 */
async function writeVersionShim(dir: string, name: string, version: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, `#!${process.execPath}\nconsole.log("${version}");\n`);
  await chmod(file, 0o755);
  return file;
}

/** An empty environment: not even a bare name can resolve through PATH. */
const NO_ENV = {};

describe("resolveTool: aria2c discovery when nothing is installed", () => {
  test("returns null — the native-downloader fallback — instead of throwing", async () => {
    const empty = await makeDir("yta-tools-empty-");
    const found = await resolveTool("", ["--version"], ["aria2c"], ["aria2c.exe"], {
      cwd: empty,
      exeDir: empty,
      platform: "linux", // no Windows package-manager shims to probe
      env: NO_ENV, // an empty PATH: the bare-name candidate cannot resolve
    });
    expect(found).toBeNull();
  });

  test.skipIf(WIN)("a configured path that does not exist does not hide a discovery elsewhere", async () => {
    const dir = await makeDir("yta-tools-fallback-");
    await writeVersionShim(dir, "aria2c", "1.36.0");
    const found = await resolveTool(
      join(dir, "deleted", "aria2c"),
      ["--version"],
      ["aria2c"],
      ["aria2c.exe"],
      { cwd: dir, exeDir: dir, platform: "linux", env: { ...process.env, PATH: dir } },
    );
    // The stale config path is skipped and the PATH candidate answers.
    expect(found?.path).toBe("aria2c");
    expect(found?.version).toContain("1.36");
  });
});

describe("resolveTool: aria2c discovery when it is installed", () => {
  test.skipIf(WIN)("finds the binary through the PATH candidate and reports its version", async () => {
    const dir = await makeDir("yta-tools-found-");
    await writeVersionShim(dir, "aria2c", "1.37.0");
    const found = await resolveTool("", ["--version"], ["aria2c"], ["aria2c.exe"], {
      cwd: dir,
      exeDir: dir,
      platform: "linux",
      // A PATH holding only the shim dir: the bare-name lookup must find it.
      env: { PATH: dir },
    });
    expect(found?.path).toBe("aria2c");
    expect(found?.version).toContain("1.37");
  });

  test.skipIf(WIN)("an explicit config path wins over discovery", async () => {
    const shimDir = await makeDir("yta-tools-shim-");
    const cfgDir = await makeDir("yta-tools-cfg-");
    await writeVersionShim(shimDir, "aria2c", "0.0.1");
    const configured = await writeVersionShim(cfgDir, "aria2c-custom", "9.9.9");
    const found = await resolveTool(configured, ["--version"], ["aria2c"], ["aria2c.exe"], {
      cwd: shimDir,
      exeDir: shimDir,
      platform: "linux",
      env: { ...process.env, PATH: shimDir },
    });
    expect(found?.path).toBe(configured);
    expect(found?.version).toContain("9.9.9");
  });

  test.skipIf(WIN)("a binary that fails its version probe is not usable", async () => {
    const dir = await makeDir("yta-tools-broken-");
    const broken = join(dir, "aria2c");
    // Exits non-zero, the way a half-installed or incompatible build does.
    await writeFile(broken, `#!${process.execPath}\nconsole.error("bad option");\nprocess.exit(28);\n`);
    await chmod(broken, 0o755);

    const found = await resolveTool(broken, ["--version"], ["aria2c"], ["aria2c.exe"], {
      cwd: dir,
      exeDir: dir,
      platform: "linux",
      env: { ...process.env, PATH: dir },
    });
    expect(found).toBeNull();
  });
});

describe("jsRuntimeArgs", () => {
  test("is empty without a runtime so unit tests stay flag-free", () => {
    expect(jsRuntimeArgs(null)).toEqual([]);
    expect(jsRuntimeArgs({ name: "deno", path: "" })).toEqual([]);
  });

  test("passes an explicit runtime:path plus EJS github fetch", () => {
    expect(jsRuntimeArgs({ name: "node", path: "/usr/bin/node" })).toEqual([
      "--js-runtimes",
      "node:/usr/bin/node",
      "--remote-components",
      "ejs:github",
    ]);
  });
});

describe("bunInterpreterPath", () => {
  test("accepts the bun interpreter and rejects a compiled exe", () => {
    expect(bunInterpreterPath("/usr/local/bin/bun")).toBe("/usr/local/bin/bun");
    expect(bunInterpreterPath("C:/Users/me/bun.exe")).toBe("C:/Users/me/bun.exe");
    expect(bunInterpreterPath("C:/app/youtube-archive.exe")).toBeNull();
    expect(bunInterpreterPath("/opt/youtube-archive")).toBeNull();
  });
});

describe("resolveJsRuntime: empty search space", () => {
  test("returns null when nothing is installed and no bun fallback is offered", async () => {
    const empty = await makeDir("yta-jsrt-empty-");
    const found = await resolveJsRuntime({
      cwd: empty,
      exeDir: empty,
      platform: "linux",
      env: NO_ENV,
    });
    expect(found).toBeNull();
  });

  test("uses the injected bun interpreter as last resort", async () => {
    const empty = await makeDir("yta-jsrt-bun-");
    const found = await resolveJsRuntime({
      cwd: empty,
      exeDir: empty,
      platform: "linux",
      env: NO_ENV,
      bunInterpreter: "/opt/bun",
    });
    expect(found).toEqual({ name: "bun", path: "/opt/bun" });
  });

  test.skipIf(WIN)("uses explicitly configured denoPath when provided", async () => {
    const dir = await makeDir("yta-jsrt-custom-deno-");
    const customDeno = await writeVersionShim(dir, "my-deno", "deno 2.1.0");
    const found = await resolveJsRuntime({
      cwd: dir,
      exeDir: dir,
      platform: "linux",
      env: { PATH: dir },
      denoPath: customDeno,
    });
    expect(found).toEqual({ name: "deno", path: customDeno });
    expect(jsRuntimeArgs(found)).toEqual([
      "--js-runtimes",
      `deno:${customDeno}`,
      "--remote-components",
      "ejs:github",
    ]);
  });

  test("skips deno when denoPath is 'none'", async () => {
    const empty = await makeDir("yta-jsrt-none-");
    const found = await resolveJsRuntime({
      cwd: empty,
      exeDir: empty,
      platform: "linux",
      env: NO_ENV,
      denoPath: "none",
      bunInterpreter: "/opt/bun",
    });
    expect(found).toEqual({ name: "bun", path: "/opt/bun" });
  });
});

afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
