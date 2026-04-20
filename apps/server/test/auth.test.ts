import { describe, expect, it } from "vitest";
import {
  isAuthorizedRequestContext,
  isLoopbackRemoteAddress,
  parseBearerToken,
  parseSharedSecretHeader,
  resolveRemoteAuthConfig,
} from "../src/auth.js";

describe("remote auth", () => {
  it("does not require a shared secret for loopback-only binds", () => {
    const config = resolveRemoteAuthConfig("127.0.0.1", undefined);
    expect(config.sharedSecret).toBeNull();
  });

  it("generates a shared secret for non-loopback binds", () => {
    const config = resolveRemoteAuthConfig("0.0.0.0", undefined);
    expect(config.sharedSecret).not.toBeNull();
    expect(config.sharedSecret?.length ?? 0).toBeGreaterThan(0);
  });

  it("parses bearer authorization headers", () => {
    expect(parseBearerToken("Bearer abc123")).toBe("abc123");
    expect(parseBearerToken("Bearer ０１２３４５")).toBe("012345");
    expect(parseBearerToken("Bearer 0 1\u200B2\u200C3 4 5")).toBe("012345");
    expect(parseBearerToken("Basic abc123")).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
  });

  it("parses the Farfield shared secret header", () => {
    expect(parseSharedSecretHeader("０１２３４５")).toBe("012345");
    expect(parseSharedSecretHeader("0 1\u200B2\u200C3 4 5")).toBe("012345");
    expect(parseSharedSecretHeader(undefined)).toBeNull();
  });

  it("recognizes loopback addresses", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("192.168.1.15")).toBe(false);
  });

  it("allows loopback requests without a token", () => {
    const config = resolveRemoteAuthConfig("0.0.0.0", "secret-1");
    expect(
      isAuthorizedRequestContext("127.0.0.1", undefined, undefined, config),
    ).toBe(true);
  });

  it("rejects non-loopback requests without the correct token", () => {
    const config = resolveRemoteAuthConfig("0.0.0.0", "secret-1");
    expect(
      isAuthorizedRequestContext("192.168.1.15", undefined, undefined, config),
    ).toBe(false);
    expect(
      isAuthorizedRequestContext("192.168.1.15", "Bearer wrong", undefined, config),
    ).toBe(false);
    expect(
      isAuthorizedRequestContext(
        "192.168.1.15",
        undefined,
        "secret-1",
        config,
      ),
    ).toBe(true);
    expect(
      isAuthorizedRequestContext(
        "192.168.1.15",
        "Bearer secret-1",
        undefined,
        config,
      ),
    ).toBe(true);
    expect(
      isAuthorizedRequestContext(
        "192.168.1.15",
        undefined,
        "wrong",
        config,
      ),
    ).toBe(false);
  });
});
