import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sdkRoot =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  path.join(os.homedir(), "Library", "Android", "sdk");
const defaultDebugKeystorePath = path.join(
  os.homedir(),
  ".android",
  "debug.keystore",
);
const explicitKeystorePath = process.env.ANDROID_KEYSTORE_PATH ?? null;
const keystorePath = explicitKeystorePath ?? defaultDebugKeystorePath;
const keyAlias = process.env.ANDROID_KEY_ALIAS ?? "androiddebugkey";
const keystorePassword = process.env.ANDROID_KEYSTORE_PASSWORD ?? "android";
const keyPassword = process.env.ANDROID_KEY_PASSWORD ?? keystorePassword;
const unsignedApkPath = path.join(
  repoRoot,
  "apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk",
);
const signedApkPath = path.resolve(
  repoRoot,
  process.env.ANDROID_SIGNED_APK_PATH ??
    "apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-debugsigned.apk",
);

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

if (!existsSync(sdkRoot)) {
  throw new Error(`Android SDK not found at ${sdkRoot}`);
}

if (!existsSync(keystorePath)) {
  if (explicitKeystorePath) {
    throw new Error(`Android keystore not found at ${keystorePath}`);
  }

  mkdirSync(path.dirname(defaultDebugKeystorePath), { recursive: true });
  await runCommand("keytool", [
    "-genkeypair",
    "-v",
    "-keystore",
    defaultDebugKeystorePath,
    "-storepass",
    "android",
    "-alias",
    "androiddebugkey",
    "-keypass",
    "android",
    "-dname",
    "CN=Android Debug,O=Android,C=US",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
  ]);
}

const buildToolsRoot = path.join(sdkRoot, "build-tools");
if (!existsSync(buildToolsRoot)) {
  throw new Error(`Android build-tools not found at ${buildToolsRoot}`);
}

const buildToolsVersions = readdirSync(buildToolsRoot).sort((left, right) =>
  left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  }),
);
const latestBuildToolsVersion =
  buildToolsVersions[buildToolsVersions.length - 1] ?? null;
if (latestBuildToolsVersion === null) {
  throw new Error(`No Android build-tools versions found in ${buildToolsRoot}`);
}

const apksignerPath = path.join(
  buildToolsRoot,
  latestBuildToolsVersion,
  "apksigner",
);
if (!existsSync(apksignerPath)) {
  throw new Error(`apksigner not found at ${apksignerPath}`);
}

await runCommand("bun", ["run", "--filter", "@farfield/tauri", "build:sidecars"]);

await runCommand(
  "bunx",
  ["tauri", "android", "build", "--apk", "--ci"],
  {
    cwd: path.join(repoRoot, "apps/tauri"),
    env: {
      ...process.env,
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
    },
  },
);

if (!existsSync(unsignedApkPath)) {
  throw new Error(`Unsigned APK not found at ${unsignedApkPath}`);
}

await runCommand(apksignerPath, [
  "sign",
  "--ks",
  keystorePath,
  "--ks-key-alias",
  keyAlias,
  "--ks-pass",
  `pass:${keystorePassword}`,
  "--key-pass",
  `pass:${keyPassword}`,
  "--out",
  signedApkPath,
  unsignedApkPath,
]);

await runCommand(apksignerPath, ["verify", "--print-certs", signedApkPath]);

console.log(`Signed APK ready at ${signedApkPath}`);
