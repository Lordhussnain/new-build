// Build the optional Rust N-API core and/or package it beside compiled apps.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeDir = resolve(root, "native");
const packageOnly = process.argv.includes("--package");
const windowsTarget = process.argv.includes("--windows");
const rustTarget = windowsTarget && process.platform !== "win32"
  ? "x86_64-pc-windows-msvc"
  : null;
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(root, process.env.CARGO_TARGET_DIR)
  : resolve(nativeDir, "target");

const libraryName = windowsTarget || process.platform === "win32"
  ? "yta_core.dll"
  : process.platform === "darwin"
    ? "libyta_core.dylib"
    : "libyta_core.so";
const builtLibrary = resolve(targetDir, rustTarget ?? "", "release", libraryName);
const nativeModule = resolve(nativeDir, "yta-core.node");

if (!packageOnly) {
  console.log(`🦀 Building the Rust validation/environment core (release${rustTarget ? `, ${rustTarget}` : ""})…`);
  const cargoArgs = ["build", "--release", "--manifest-path", resolve(nativeDir, "Cargo.toml")];
  if (rustTarget) cargoArgs.push("--target", rustTarget);
  const result = spawnSync(
    process.env.CARGO || "cargo",
    cargoArgs,
    { cwd: root, stdio: "inherit" },
  );
  if (result.error?.code === "ENOENT") {
    console.error("Rust/Cargo was not found. Install Rust from https://rustup.rs/ and try again.");
    process.exit(1);
  }
  if (result.error || result.status !== 0) {
    console.error(result.error?.message || `Cargo exited with status ${result.status}.`);
    process.exit(result.status || 1);
  }
  if (!existsSync(builtLibrary)) {
    console.error(`Cargo completed but the expected library was not found: ${builtLibrary}`);
    process.exit(1);
  }
  copyFileSync(builtLibrary, nativeModule);
  console.log(`✅ Native core: ${nativeModule}`);
}

if (packageOnly) {
  if (!existsSync(nativeModule)) {
    console.error("native/yta-core.node is missing; run `bun run build:native` first.");
    process.exit(1);
  }
  const dist = resolve(root, "dist");
  mkdirSync(dist, { recursive: true });
  copyFileSync(nativeModule, resolve(dist, "yta-core.node"));
  console.log("✅ Packaged dist/yta-core.node beside the compiled executable(s).");
}
