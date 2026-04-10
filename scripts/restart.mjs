#!/usr/bin/env node

import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const tracesDir = resolve(repoRoot, "traces");
const stdoutLogPath = resolve(tracesDir, "dev-stdout.log");
const stderrLogPath = resolve(tracesDir, "dev-stderr.log");
const bunBinary = process.platform === "win32" ? "bun.exe" : "bun";
const trackedPorts = [4311, 4312];
const trackedProcessNames = new Set(["bun", "bun.exe", "node", "node.exe", "tsx", "tsx.exe", "vite", "vite.exe"]);

function printHelp() {
  process.stdout.write(
    [
      "Usage: bun run restart -- [--remote] [--agents=<ids>]",
      "",
      "Flags:",
      "  --remote                      Bind server and web to 0.0.0.0",
      "  --agents=<ids>                Comma-separated list: codex, opencode, all",
      "  --help                        Show this help message"
    ].join("\n")
  );
  process.stdout.write("\n");
}

function parseArgs(argv) {
  const result = {
    remote: false,
    agents: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--remote") {
      result.remote = true;
      continue;
    }
    if (arg === "--agents") {
      const nextArg = argv[index + 1];
      if (!nextArg || nextArg.startsWith("--")) {
        process.stderr.write("Missing value for --agents\n");
        process.exit(1);
      }
      result.agents = nextArg;
      index += 1;
      continue;
    }
    if (arg.startsWith("--agents=")) {
      result.agents = arg.slice("--agents=".length);
      continue;
    }

    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.exit(1);
  }

  return result;
}

function collectWindowsTargetPids() {
  const command = `
$repoRoot = $env:FARFIELD_REPO_ROOT
$trackedPorts = @(4311, 4312)
$trackedNames = @('bun.exe', 'node.exe', 'tsx.exe', 'vite.exe', 'bun', 'node', 'tsx', 'vite')
$processes = Get-CimInstance Win32_Process
$byId = @{}
foreach ($process in $processes) {
  $byId[[int]$process.ProcessId] = $process
}
$targetIds = [System.Collections.Generic.HashSet[int]]::new()
foreach ($process in $processes) {
  if (-not $process.CommandLine) {
    continue
  }
  if ($process.Name -notin $trackedNames) {
    continue
  }

  $commandLine = $process.CommandLine
  $matchesRepo = $commandLine.Contains($repoRoot)
  $matchesDevCommand = $commandLine.Contains('scripts/dev.mjs') -or $commandLine.Contains('@farfield/server') -or $commandLine.Contains('@farfield/web')
  if (-not ($matchesRepo -or $matchesDevCommand)) {
    continue
  }

  $current = $process
  while ($null -ne $current) {
    $currentId = [int]$current.ProcessId
    $targetIds.Add($currentId) | Out-Null

    $parentId = [int]$current.ParentProcessId
    if ($parentId -le 0) {
      break
    }
    if (-not $byId.ContainsKey($parentId)) {
      break
    }

    $parent = $byId[$parentId]
    if ($parent.Name -notin $trackedNames) {
      break
    }

    $current = $parent
  }
}

foreach ($connection in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $trackedPorts })) {
  $targetIds.Add([int]$connection.OwningProcess) | Out-Null
}

$targetIds | Sort-Object -Descending
`.trim();

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", command],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        FARFIELD_REPO_ROOT: repoRoot
      },
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr || "Failed to inspect Windows processes\n");
    process.exit(result.status ?? 1);
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function collectUnixTargetPids() {
  const result = spawnSync(
    "ps",
    ["-axo", "pid=,ppid=,comm=,command="],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr || "Failed to inspect processes\n");
    process.exit(result.status ?? 1);
  }

  const processes = result.stdout
    .split(/\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        parentPid: Number.parseInt(match[2], 10),
        name: match[3],
        commandLine: match[4]
      };
    })
    .filter((processInfo) => processInfo !== null);

  const byId = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const targetIds = new Set();

  for (const processInfo of processes) {
    if (!trackedProcessNames.has(processInfo.name)) {
      continue;
    }

    const matchesRepo = processInfo.commandLine.includes(repoRoot);
    const matchesDevCommand =
      processInfo.commandLine.includes("scripts/dev.mjs") ||
      processInfo.commandLine.includes("@farfield/server") ||
      processInfo.commandLine.includes("@farfield/web");
    if (!matchesRepo && !matchesDevCommand) {
      continue;
    }

    let current = processInfo;
    while (current) {
      targetIds.add(current.pid);
      const parent = byId.get(current.parentPid);
      if (!parent || !trackedProcessNames.has(parent.name)) {
        break;
      }
      current = parent;
    }
  }

  return [...targetIds].sort((left, right) => right - left);
}

function terminateProcessTree(pid) {
  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: "ignore"
      }
    );
    return result.status === 0;
  }

  const result = spawnSync(
    "kill",
    ["-TERM", String(pid)],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "ignore"
    }
  );

  return result.status === 0;
}

async function wait(ms) {
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function isPortOpen(port) {
  return await new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

async function waitForPorts(ports, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const results = await Promise.all(ports.map((port) => isPortOpen(port)));
    if (results.every(Boolean)) {
      return true;
    }
    await wait(500);
  }

  return false;
}

function buildDevCommand(args) {
  const command = ["run", "dev"];
  const passthroughArgs = [];

  if (args.remote) {
    passthroughArgs.push("--remote");
  }
  if (args.agents.trim().length > 0) {
    passthroughArgs.push(`--agents=${args.agents.trim()}`);
  }
  if (passthroughArgs.length > 0) {
    command.push("--", ...passthroughArgs);
  }

  return command;
}

function ensureLogFiles() {
  mkdirSync(tracesDir, { recursive: true });
  closeSync(openSync(stdoutLogPath, "w"));
  closeSync(openSync(stderrLogPath, "w"));
}

function startDevProcess(command) {
  const stdoutFd = openSync(stdoutLogPath, "a");
  const stderrFd = openSync(stderrLogPath, "a");

  const child = spawn(bunBinary, command, {
    cwd: repoRoot,
    detached: true,
    env: process.env,
    stdio: ["ignore", stdoutFd, stderrFd]
  });

  child.unref();
  return child.pid;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetPids = process.platform === "win32" ? collectWindowsTargetPids() : collectUnixTargetPids();

  for (const pid of targetPids) {
    terminateProcessTree(pid);
  }

  if (targetPids.length > 0) {
    await wait(1000);
  }

  ensureLogFiles();
  const childPid = startDevProcess(buildDevCommand(args));
  const ready = await waitForPorts(trackedPorts, 30000);

  if (!ready) {
    process.stderr.write(
      [
        "Timed out waiting for Farfield dev services to become ready.",
        `stdout: ${stdoutLogPath}`,
        `stderr: ${stderrLogPath}`,
        `launcher pid: ${String(childPid)}`
      ].join("\n")
    );
    process.stderr.write("\n");
    process.exit(1);
  }

  process.stdout.write(
    [
      "Farfield dev services restarted.",
      `stdout: ${stdoutLogPath}`,
      `stderr: ${stderrLogPath}`
    ].join("\n")
  );
  process.stdout.write("\n");
}

await main();
