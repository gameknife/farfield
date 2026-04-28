import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");

const TauriConfigSchema = z
  .object({
    $schema: z.string().url(),
    productName: z.literal("Farfield"),
    version: z.string().min(1),
    identifier: z.literal("dev.farfield.client"),
    build: z
      .object({
        beforeDevCommand: z.literal("bun run prepare:server-bin && bun run dev:web"),
        beforeBuildCommand: z.literal("bun run prepare:bundle"),
        devUrl: z.literal("http://127.0.0.1:4312"),
        frontendDist: z.literal("../dist/web"),
      })
      .strict(),
    app: z
      .object({
        windows: z
          .array(
            z
              .object({
                label: z.literal("main"),
                title: z.literal("Farfield"),
                width: z.number().int().positive(),
                height: z.number().int().positive(),
                minWidth: z.number().int().positive(),
                minHeight: z.number().int().positive(),
                resizable: z.literal(true),
              })
              .strict(),
          )
          .length(1),
        security: z
          .object({
            csp: z.literal(null),
          })
          .strict(),
      })
      .strict(),
    bundle: z
      .object({
        active: z.literal(true),
        targets: z.tuple([z.literal("nsis"), z.literal("msi")]),
        icon: z.tuple([z.literal("icons/icon.ico")]),
        externalBin: z.tuple([z.literal("binaries/farfield-server")]),
        publisher: z.literal("Farfield"),
        category: z.literal("DeveloperTool"),
        shortDescription: z.literal("Farfield desktop client"),
        longDescription: z.literal("A Tauri desktop wrapper for the Farfield client UI."),
      })
      .strict(),
  })
  .strict();

const configPath = path.join(desktopRoot, "src-tauri", "tauri.conf.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
TauriConfigSchema.parse(config);
