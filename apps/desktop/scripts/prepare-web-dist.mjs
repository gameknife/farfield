import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const webDist = path.join(repoRoot, "apps", "web", "dist");
const desktopDist = path.join(desktopRoot, "dist", "web");
const initScriptName = "farfield-desktop-init.js";
const initScriptTag = `    <script src="/${initScriptName}"></script>`;

const BuildEnvSchema = z.object({
  PWA_ENABLED: z.literal("0"),
});

const buildEnv = BuildEnvSchema.parse({
  PWA_ENABLED: "0",
});

const bunBinary = process.platform === "win32" ? "bun.exe" : "bun";
const buildResult = spawnSync(
  bunBinary,
  ["run", "--filter", "@farfield/web", "build"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...buildEnv,
    },
  },
);

if (buildResult.status !== 0) {
  throw new Error("Farfield web build failed");
}

if (path.relative(desktopRoot, desktopDist).startsWith("..")) {
  throw new Error("Refusing to write outside the desktop package");
}

rmSync(desktopDist, { force: true, recursive: true });
mkdirSync(desktopDist, { recursive: true });
cpSync(webDist, desktopDist, { recursive: true });

const initScriptPath = path.join(desktopDist, initScriptName);
writeFileSync(
  initScriptPath,
  [
    "(() => {",
    "  const serverTarget = { version: 1, baseUrl: \"http://127.0.0.1:4311\" };",
    "  window.localStorage.setItem(\"farfield.server-target.v1\", JSON.stringify(serverTarget));",
    "})();",
    "",
  ].join("\n"),
);

const indexPath = path.join(desktopDist, "index.html");
const indexHtml = readFileSync(indexPath, "utf8");
if (indexHtml.includes(initScriptName)) {
  throw new Error("Desktop init script was already injected");
}
if (!indexHtml.includes("</head>")) {
  throw new Error("Desktop web index.html is missing </head>");
}

const nextIndexHtml = indexHtml.replace("</head>", `${initScriptTag}\n  </head>`);
writeFileSync(indexPath, nextIndexHtml);
