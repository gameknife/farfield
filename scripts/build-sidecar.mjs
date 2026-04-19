import { spawn } from "node:child_process";
import { dirname, extname, resolve } from "node:path";

const [, , entryArg, outputArg] = process.argv;

if (!entryArg || !outputArg) {
  throw new Error(
    "Usage: node scripts/build-sidecar.mjs <entry-file> <output-path-without-extension>",
  );
}

const entryFile = resolve(process.cwd(), entryArg);
const outputBasePath = resolve(process.cwd(), outputArg);
const outputPath =
  extname(outputBasePath).length > 0
    ? outputBasePath
    : `${outputBasePath}${process.platform === "win32" ? ".exe" : ""}`;

await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(
    "bun",
    ["build", entryFile, "--compile", "--outfile", outputPath],
    {
      cwd: dirname(entryFile),
      stdio: "inherit",
    },
  );

  child.on("error", rejectPromise);
  child.on("exit", (code) => {
    if (code === 0) {
      resolvePromise();
      return;
    }
    rejectPromise(
      new Error(`bun build exited with code ${code ?? "unknown"}`),
    );
  });
});

console.log(`Built sidecar: ${outputPath}`);
