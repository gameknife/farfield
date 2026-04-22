import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

const explicitKeystorePath = firstNonEmpty(process.env.ANDROID_KEYSTORE_PATH);
const keystorePath = explicitKeystorePath ?? defaultDebugKeystorePath;
const usingReleaseKeystore = explicitKeystorePath !== null;
const keyAlias = usingReleaseKeystore
  ? firstNonEmpty(process.env.ANDROID_KEY_ALIAS) ?? "androiddebugkey"
  : "androiddebugkey";
const keystorePassword = usingReleaseKeystore
  ? firstNonEmpty(process.env.ANDROID_KEYSTORE_PASSWORD) ?? "android"
  : "android";
const keyPassword = usingReleaseKeystore
  ? firstNonEmpty(process.env.ANDROID_KEY_PASSWORD) ?? keystorePassword
  : "android";
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

await runCommand("bun", ["run", "prepare:workspace-dist"]);
await runCommand("bun", ["run", "--filter", "@farfield/tauri", "build:sidecars"]);

const androidGenDir = path.join(
  repoRoot,
  "apps/tauri/src-tauri/gen/android",
);
if (!existsSync(androidGenDir)) {
  await runCommand(
    "bunx",
    ["tauri", "android", "init"],
    {
      cwd: path.join(repoRoot, "apps/tauri"),
      env: {
        ...process.env,
        ANDROID_HOME: sdkRoot,
        ANDROID_SDK_ROOT: sdkRoot,
      },
    },
  );
}

// Tauri's default build.gradle.kts sets usesCleartextTraffic="false" for
// release builds, which breaks HTTP (ip:port) network calls from the APK.
// Force every manifestPlaceholders usesCleartextTraffic entry to "true"
// so release APKs can talk to plain-HTTP endpoints.
const gradleKtsPath = path.join(androidGenDir, "app/build.gradle.kts");
if (existsSync(gradleKtsPath)) {
  const original = readFileSync(gradleKtsPath, "utf8");
  const patched = original.replace(
    /(manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*)"false"/g,
    '$1"true"',
  );
  if (patched !== original) {
    writeFileSync(gradleKtsPath, patched);
    console.log(
      "Patched build.gradle.kts: usesCleartextTraffic=true everywhere",
    );
  } else {
    console.log(
      "build.gradle.kts already has usesCleartextTraffic=true (or pattern did not match)",
    );
  }
}

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

async function signWith({ ks, alias, storePass, keyPass }) {
  await runCommand(apksignerPath, [
    "sign",
    "--ks",
    ks,
    "--ks-key-alias",
    alias,
    "--ks-pass",
    `pass:${storePass}`,
    "--key-pass",
    `pass:${keyPass}`,
    "--out",
    signedApkPath,
    unsignedApkPath,
  ]);
}

try {
  await signWith({
    ks: keystorePath,
    alias: keyAlias,
    storePass: keystorePassword,
    keyPass: keyPassword,
  });
} catch (error) {
  if (!usingReleaseKeystore) {
    throw error;
  }
  console.warn(
    `Release signing failed (${error.message}). Falling back to a freshly generated debug keystore so the APK is still installable. Fix ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD secrets to re-enable release signing.`,
  );

  if (!existsSync(defaultDebugKeystorePath)) {
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

  await signWith({
    ks: defaultDebugKeystorePath,
    alias: "androiddebugkey",
    storePass: "android",
    keyPass: "android",
  });
}

await runCommand(apksignerPath, ["verify", "--print-certs", signedApkPath]);

console.log(`Signed APK ready at ${signedApkPath}`);
