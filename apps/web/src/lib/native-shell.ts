import { z } from "zod";

const SharedSecretSchema = z
  .string()
  .trim()
  .min(1, "Shared secret is required")
  .max(512, "Shared secret must be at most 512 characters");

const ServerBaseUrlSchema = z
  .string()
  .trim()
  .url()
  .transform((value) => value.replace(/\/$/, ""));

const NativeHostConnectionConfigSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("host"),
    serverBaseUrl: z.literal("http://127.0.0.1:4311"),
    sharedSecret: SharedSecretSchema,
  })
  .strict();

const NativeRemoteClientConnectionConfigSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("remoteClient"),
    serverBaseUrl: ServerBaseUrlSchema,
    sharedSecret: SharedSecretSchema,
  })
  .strict();

const NativeRuntimeServiceStatusSchema = z
  .object({
    state: z.enum(["stopped", "starting", "running", "error"]),
    message: z.union([z.string(), z.null()]),
  })
  .strict();

export const NativeConnectionConfigSchema = z.union([
  NativeHostConnectionConfigSchema,
  NativeRemoteClientConnectionConfigSchema,
]);

export const NativeRuntimeStatusSchema = z
  .object({
    activeMode: z.enum(["host", "remoteClient"]),
    hostSupported: z.boolean(),
    resolvedBindAddress: z.string(),
    server4311Status: NativeRuntimeServiceStatusSchema,
    web4312Status: NativeRuntimeServiceStatusSchema,
  })
  .strict();

export const NativeBootstrapSchema = z
  .object({
    connection: NativeConnectionConfigSchema,
    runtime: NativeRuntimeStatusSchema,
  })
  .strict();

export type NativeConnectionConfig = z.infer<
  typeof NativeConnectionConfigSchema
>;
export type NativeRuntimeStatus = z.infer<typeof NativeRuntimeStatusSchema>;
export type NativeBootstrap = z.infer<typeof NativeBootstrapSchema>;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: object;
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

async function invokeTauriCommand<Result>(
  command: string,
  args?: Record<string, string | number | boolean | null>,
): Promise<Result | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const module = await import("@tauri-apps/api/core");
  return module.invoke<Result>(command, args);
}

export async function loadNativeBootstrap(): Promise<NativeBootstrap | null> {
  const result = await invokeTauriCommand<NativeBootstrap>("farfield_get_bootstrap");
  if (result === null) {
    return null;
  }
  return NativeBootstrapSchema.parse(result);
}

export async function saveNativeConnectionConfig(
  connection: NativeConnectionConfig,
): Promise<NativeConnectionConfig | null> {
  const result = await invokeTauriCommand<NativeConnectionConfig>(
    "farfield_set_connection_config",
    {
      configJson: JSON.stringify(NativeConnectionConfigSchema.parse(connection)),
    },
  );

  if (result === null) {
    return null;
  }

  return NativeConnectionConfigSchema.parse(result);
}

export async function getNativeRuntimeStatus(): Promise<NativeRuntimeStatus | null> {
  const result = await invokeTauriCommand<NativeRuntimeStatus>("farfield_get_runtime_status");
  if (result === null) {
    return null;
  }
  return NativeRuntimeStatusSchema.parse(result);
}
