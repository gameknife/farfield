import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  const bundleDir = path.join(
    repoRoot,
    "apps/tauri/src-tauri/target/release/bundle",
  );
  const debBundleDir = path.join(bundleDir, "deb");

  await runCommand(
    "node",
    [path.join(repoRoot, "scripts/prepare-windows-bundled-codex.mjs")],
  );
  await runCommand("bun", ["run", "--filter", "@farfield/web", "build"]);
  await runCommand("bun", ["run", "--filter", "@farfield/tauri", "build:sidecars"]);

  // deb + rpm are reliable on the ubuntu runner. AppImage via tauri's
  // linuxdeploy path is flaky in CI, so we build it as best-effort and
  // also always ship a portable tarball that works on Arch / NixOS / any
  // distro without a native package manager for .deb/.rpm.
  await runCommand(
    "bunx",
    ["tauri", "build", "--bundles", "deb", "rpm", "--ci"],
    {
      cwd: path.join(repoRoot, "apps/tauri"),
    },
  );

  try {
    await runCommand(
      "bunx",
      ["tauri", "build", "--bundles", "appimage", "--ci", "-v"],
      {
        cwd: path.join(repoRoot, "apps/tauri"),
        env: {
          ...process.env,
          APPIMAGE_EXTRACT_AND_RUN: "1",
          NO_STRIP: "true",
        },
      },
    );
  } catch (error) {
    console.warn(
      `AppImage bundling failed (${error.message}); continuing with portable tarball fallback.`,
    );
  }

  // Build a portable tarball straight from the .deb's install tree. That
  // tree mirrors the final /usr layout that gets dropped on a machine when
  // the .deb is installed, so extracting it anywhere on an Arch box yields
  // a runnable app.
  if (existsSync(debBundleDir)) {
    const debDirs = readdirSync(debBundleDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const installRootName = debDirs.find((name) =>
      name.endsWith("_amd64") || name.endsWith("_x86_64"),
    );
    if (!installRootName) {
      console.warn(
        `Could not locate .deb install tree under ${debBundleDir}; skipping portable tarball.`,
      );
    } else {
      const installRoot = path.join(debBundleDir, installRootName, "data");
      if (!existsSync(installRoot)) {
        console.warn(
          `Expected install tree at ${installRoot}; skipping portable tarball.`,
        );
      } else {
        const portableDir = path.join(bundleDir, "portable");
        const portableTopName = `${productName}_${version}_linux-x86_64`;
        const portableTarName = `${portableTopName}.tar.gz`;
        await runCommand("mkdir", ["-p", portableDir]);

        // Copy the deb's data/ tree into a scratch location so the
        // self-contained-ification step doesn't contaminate the source
        // tree that the .deb artifact came from.
        const stagingRoot = path.join(portableDir, "__staging");
        await runCommand("rm", ["-rf", stagingRoot]);
        await runCommand("mkdir", ["-p", stagingRoot]);
        await runCommand("cp", ["-a", `${installRoot}/.`, stagingRoot]);

        // Bundle webkit + transitive shared-library deps + WebKit helper
        // processes + GIO modules into `usr/lib/farfield/`, then rewrite
        // the binary as a launcher that points the runtime at them. This
        // is what makes the tarball work on SteamOS / minimal Arch.
        await runCommand(
          "node",
          [
            path.join(repoRoot, "scripts/bundle-linux-portable.mjs"),
            stagingRoot,
            "usr/bin/farfield_tauri",
            "farfield",
          ],
        );

        // Wrap the (now self-contained) tree under a single top-level
        // directory so extracting the tarball produces
        // `${portableTopName}/usr/bin/farfield_tauri`, runnable via a
        // simple `./usr/bin/farfield_tauri`.
        await runCommand(
          "tar",
          [
            "-czf",
            path.join(portableDir, portableTarName),
            "-C",
            path.dirname(stagingRoot),
            "--transform",
            `s,^__staging,${portableTopName},`,
            "__staging",
          ],
        );
        await runCommand("rm", ["-rf", stagingRoot]);
        console.log(`Portable tarball ready at ${portableDir}/${portableTarName}`);
      }
    }
  }

  console.log(`Desktop bundles are under ${bundleDir}`);
} else {
  await runCommand("bun", ["run", "--filter", "@farfield/tauri", "tauri:build"]);
  console.log(
    `Desktop bundles are under ${path.join(repoRoot, "apps/tauri/src-tauri/target/release/bundle")}`,
  );
}
