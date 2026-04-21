import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const platformLabels = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};

const currentPlatform = platformLabels[process.platform];
if (!currentPlatform) {
  throw new Error(`Unsupported desktop platform: ${process.platform}`);
}

const requestedPlatform = process.argv[2] ?? null;
if (requestedPlatform && requestedPlatform !== currentPlatform) {
  throw new Error(
    `This script must run on ${requestedPlatform}. Current platform is ${currentPlatform}.`,
  );
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
      ...options,
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${command} exited with code ${code ?? "unknown"}`),
      );
    });
  });
}

await runCommand("bun", ["run", "prepare:workspace-dist"]);

if (currentPlatform === "macos") {
  const tauriConfigPath = path.join(
    repoRoot,
    "apps/tauri/src-tauri/tauri.conf.json",
  );
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const productName =
    typeof tauriConfig.productName === "string"
      ? tauriConfig.productName
      : "Farfield";
  const version =
    typeof tauriConfig.version === "string" ? tauriConfig.version : "0.0.0";
  const archLabel =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x64"
        : process.arch;
  const macBundleDir = path.join(
    repoRoot,
    "apps/tauri/src-tauri/target/release/bundle/macos",
  );
  const appBundleName = `${productName}.app`;
  const archiveName = `${productName}_${version}_${archLabel}.app.tar.gz`;

  await runCommand("bun", ["run", "--filter", "@farfield/tauri", "build:sidecars"]);
  await runCommand(
    "bunx",
    ["tauri", "build", "--bundles", "app", "--ci"],
    {
      cwd: path.join(repoRoot, "apps/tauri"),
    },
  );
  await runCommand("tar", ["-czf", archiveName, appBundleName], {
    cwd: macBundleDir,
  });

  console.log(
    `macOS bundles are under ${macBundleDir} and include ${archiveName}`,
  );
} else if (currentPlatform === "linux") {
  await runCommand(
    "node",
    [path.join(repoRoot, "scripts/prepare-windows-bundled-codex.mjs")],
  );
  await runCommand("bun", ["run", "--filter", "@farfield/web", "build"]);
  await runCommand("bun", ["run", "--filter", "@farfield/tauri", "build:sidecars"]);
  await runCommand(
    "bunx",
    ["tauri", "build", "--bundles", "deb", "rpm", "--ci"],
    {
      cwd: path.join(repoRoot, "apps/tauri"),
    },
  );
  console.log(
    `Desktop bundles are under ${path.join(repoRoot, "apps/tauri/src-tauri/target/release/bundle")}`,
  );
} else {
  await runCommand("bun", ["run", "--filter", "@farfield/tauri", "tauri:build"]);
  console.log(
    `Desktop bundles are under ${path.join(repoRoot, "apps/tauri/src-tauri/target/release/bundle")}`,
  );
}
