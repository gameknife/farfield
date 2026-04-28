import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const serverEntry = path.join(repoRoot, "apps", "server", "src", "index.ts");
const binariesDir = path.join(desktopRoot, "src-tauri", "binaries");
const binaryBaseName = "farfield-server";

const EnvSchema = z
  .object({
    FARFIELD_SERVER_TARGET_TRIPLE: z.string().min(1).optional(),
  })
  .strict();

const RustcHostSchema = z
  .string()
  .regex(/^host: (?<target>[A-Za-z0-9_.-]+)$/m);

const TargetTripleSchema = z.enum(["x86_64-pc-windows-msvc"]);

const BunCompileTargetByRustTargetSchema = z
  .object({
    "x86_64-pc-windows-msvc": z.literal("bun-windows-x64"),
  })
  .strict();

const env = EnvSchema.parse({
  FARFIELD_SERVER_TARGET_TRIPLE: process.env["FARFIELD_SERVER_TARGET_TRIPLE"],
});

const bunCompileTargetByRustTarget = BunCompileTargetByRustTargetSchema.parse({
  "x86_64-pc-windows-msvc": "bun-windows-x64",
});

function readHostTargetTriple() {
  const result = spawnSync("rustc", ["-Vv"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error("Unable to read rustc host target");
  }

  const stdout = RustcHostSchema.parse(result.stdout);
  const match = /^host: (?<target>[A-Za-z0-9_.-]+)$/m.exec(stdout);
  const target = match?.groups?.target;
  if (!target) {
    throw new Error("rustc host target was not present");
  }
  return target;
}

const targetTriple = env.FARFIELD_SERVER_TARGET_TRIPLE ?? readHostTargetTriple();
const supportedTargetTriple = TargetTripleSchema.parse(targetTriple);
const bunCompileTarget = bunCompileTargetByRustTarget[supportedTargetTriple];

const executableExtension = ".exe";
const outputPath = path.join(
  binariesDir,
  `${binaryBaseName}-${supportedTargetTriple}${executableExtension}`,
);
const bunBinary = process.platform === "win32" ? "bun.exe" : "bun";

mkdirSync(binariesDir, { recursive: true });
rmSync(outputPath, { force: true });

const result = spawnSync(
  bunBinary,
  [
    "build",
    serverEntry,
    "--compile",
    `--target=${bunCompileTarget}`,
    "--outfile",
    outputPath,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  throw new Error("Farfield server binary build failed");
}
