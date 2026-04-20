import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";

function normalizeSharedSecret(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{White_Space}\p{Cf}]+/gu, "");
}

const SharedSecretSchema = z
  .string()
  .transform(normalizeSharedSecret)
  .pipe(
    z
      .string()
      .min(1, "Shared secret is required")
      .max(512, "Shared secret must be at most 512 characters"),
  );

const RemoteAuthConfigSchema = z
  .object({
    bindHost: z.string().min(1),
    sharedSecret: z.union([SharedSecretSchema, z.null()]),
  })
  .strict();

export type RemoteAuthConfig = z.infer<typeof RemoteAuthConfigSchema>;

export const SHARED_SECRET_HEADER_NAME = "x-farfield-shared-secret";

function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function isLoopbackRemoteAddress(address: string | null | undefined): boolean {
  if (address === undefined || address === null) {
    return false;
  }

  const normalized =
    address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;

  return normalized === "127.0.0.1" || normalized === "::1";
}

export function parseBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | null {
  if (Array.isArray(authorizationHeader)) {
    return null;
  }

  if (typeof authorizationHeader !== "string") {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/u);
  if (!match) {
    return null;
  }

  const candidateToken = match[1];
  if (candidateToken === undefined) {
    return null;
  }

  const parsedToken = SharedSecretSchema.safeParse(candidateToken);
  return parsedToken.success ? parsedToken.data : null;
}

export function parseSharedSecretHeader(
  sharedSecretHeader: string | string[] | undefined,
): string | null {
  if (Array.isArray(sharedSecretHeader)) {
    return null;
  }

  if (typeof sharedSecretHeader !== "string") {
    return null;
  }

  const parsedSecret = SharedSecretSchema.safeParse(sharedSecretHeader);
  return parsedSecret.success ? parsedSecret.data : null;
}

export function resolveRemoteAuthConfig(
  bindHost: string,
  configuredSharedSecret: string | undefined,
): RemoteAuthConfig {
  const parsedConfiguredSharedSecret =
    configuredSharedSecret === undefined
      ? null
      : SharedSecretSchema.parse(configuredSharedSecret);

  const sharedSecret =
    parsedConfiguredSharedSecret ??
    (isLoopbackBindHost(bindHost)
      ? null
      : randomBytes(24).toString("base64url"));

  return RemoteAuthConfigSchema.parse({
    bindHost,
    sharedSecret,
  });
}

export function isRequestAuthorized(
  req: IncomingMessage,
  authConfig: RemoteAuthConfig,
): boolean {
  return isAuthorizedRequestContext(
    req.socket.remoteAddress,
    req.headers.authorization,
    req.headers[SHARED_SECRET_HEADER_NAME],
    authConfig,
  );
}

export function isAuthorizedRequestContext(
  remoteAddress: string | null | undefined,
  authorizationHeader: string | string[] | undefined,
  sharedSecretHeader: string | string[] | undefined,
  authConfig: RemoteAuthConfig,
): boolean {
  if (isLoopbackRemoteAddress(remoteAddress)) {
    return true;
  }

  if (authConfig.sharedSecret === null) {
    return true;
  }

  const requestToken =
    parseSharedSecretHeader(sharedSecretHeader) ??
    parseBearerToken(authorizationHeader);
  return requestToken === authConfig.sharedSecret;
}
