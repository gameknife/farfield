import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  process.exit(0);
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundledCodexOutputPath = path.join(
  repoRoot,
  "apps",
  "tauri",
  "src-tauri",
  "binaries",
  "codex.exe",
);
const shouldBundleCodex =
  process.env["FARFIELD_BUNDLE_CODEX"] === "1" ||
  process.env["FARFIELD_BUNDLE_CODEX"] === "true";

function ensureExistingExecutablePath(candidatePath, label) {
  const resolvedPath = path.resolve(candidatePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`${label} does not exist: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`${label} is not a file: ${resolvedPath}`);
  }

  if (path.extname(resolvedPath).toLowerCase() !== ".exe") {
    throw new Error(`${label} must point to codex.exe: ${resolvedPath}`);
  }

  return resolvedPath;
}

function isWindowsAppsPath(candidatePath) {
  return candidatePath.toLowerCase().includes("\\windowsapps\\");
}

function verifyCodexExecutable(candidatePath) {
  const result = spawnSync(candidatePath, ["--version"], {
    encoding: "utf8",
    env: process.env,
  });

  if (result.error) {
    const message =
      result.error instanceof Error ? result.error.message : String(result.error);
    throw new Error(`Failed to execute codex.exe at ${candidatePath}: ${message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    const detail = stderr.length > 0 ? stderr : stdout;
    throw new Error(
      detail.length > 0
        ? `codex.exe verification failed: ${detail}`
        : `codex.exe verification failed with exit code ${result.status}`,
    );
  }
}

function resolveCodexSourcePath() {
  const explicitPath = process.env["CODEX_CLI_PATH"];
  if (typeof explicitPath === "string" && explicitPath.trim().length > 0) {
    const resolvedExplicitPath = ensureExistingExecutablePath(
      explicitPath.trim(),
      "CODEX_CLI_PATH",
    );
    if (!isWindowsAppsPath(resolvedExplicitPath)) {
      verifyCodexExecutable(resolvedExplicitPath);
    }
    return resolvedExplicitPath;
  }

  const whereResult = spawnSync("where.exe", ["codex.exe"], {
    encoding: "utf8",
    env: process.env,
  });

  if (whereResult.error) {
    const message =
      whereResult.error instanceof Error
        ? whereResult.error.message
        : String(whereResult.error);
    throw new Error(`Failed to resolve codex.exe with where.exe: ${message}`);
  }

  if (whereResult.status !== 0) {
    throw new Error(
      [
        "Could not find codex.exe while preparing the Windows desktop bundle.",
        "Install Codex CLI with a real codex.exe or set CODEX_CLI_PATH to it before building.",
      ].join("\n"),
    );
  }

  const candidates = whereResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const candidate of candidates) {
    try {
      const resolvedCandidate = ensureExistingExecutablePath(
        candidate,
        "Resolved codex.exe",
      );
      if (!isWindowsAppsPath(resolvedCandidate)) {
        verifyCodexExecutable(resolvedCandidate);
      }
      return resolvedCandidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    [
      "Resolved codex.exe entries were not suitable for bundling.",
      "Set CODEX_CLI_PATH to the real codex.exe installation path before building.",
    ].join("\n"),
  );
}

if (!shouldBundleCodex) {
  if (fs.existsSync(bundledCodexOutputPath)) {
    fs.rmSync(bundledCodexOutputPath, { force: true });
  }
  process.stdout.write(
    [
      "Skipping bundled Windows codex.exe.",
      "Set FARFIELD_BUNDLE_CODEX=1 to include codex.exe in the installer.",
    ].join(" "),
  );
  process.stdout.write("\n");
  process.exit(0);
}

const sourceCodexPath = resolveCodexSourcePath();
fs.mkdirSync(path.dirname(bundledCodexOutputPath), { recursive: true });
fs.copyFileSync(sourceCodexPath, bundledCodexOutputPath);
verifyCodexExecutable(bundledCodexOutputPath);

process.stdout.write(
  `Bundled Windows codex.exe from ${sourceCodexPath} to ${bundledCodexOutputPath}\n`,
);
