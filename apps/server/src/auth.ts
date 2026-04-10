import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const SharedSecretSchema = z
  .string()
  .trim()
  .min(1, "Shared secret is required")
  .max(512, "Shared secret must be at most 512 characters");

const RemoteAuthConfigSchema = z
  .object({
    bindHost: z.string().min(1),
    sharedSecret: z.union([SharedSecretSchema, z.null()]),
  })
  .strict();

export type RemoteAuthConfig = z.infer<typeof RemoteAuthConfigSchema>;

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

  return SharedSecretSchema.safeParse(candidateToken).success
    ? candidateToken.trim()
    : null;
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
    authConfig,
  );
}

export function isAuthorizedRequestContext(
  remoteAddress: string | null | undefined,
  authorizationHeader: string | string[] | undefined,
  authConfig: RemoteAuthConfig,
): boolean {
  if (isLoopbackRemoteAddress(remoteAddress)) {
    return true;
  }

  if (authConfig.sharedSecret === null) {
    return true;
  }

  const requestToken = parseBearerToken(authorizationHeader);
  return requestToken === authConfig.sharedSecret;
}
