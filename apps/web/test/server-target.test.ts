import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredServerTarget,
  parseSharedSecret,
  readStoredServerTarget,
  saveServerTarget,
} from "../src/lib/server-target";

const localStorageBacking = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string): string | null => {
    return localStorageBacking.get(key) ?? null;
  }),
  setItem: vi.fn((key: string, value: string): void => {
    localStorageBacking.set(key, value);
  }),
  removeItem: vi.fn((key: string): void => {
    localStorageBacking.delete(key);
  }),
  clear: vi.fn((): void => {
    localStorageBacking.clear();
  }),
  key: vi.fn((index: number): string | null => {
    const keys = [...localStorageBacking.keys()];
    return keys[index] ?? null;
  }),
  get length(): number {
    return localStorageBacking.size;
  },
});

describe("server target storage", () => {
  beforeEach(() => {
    localStorageBacking.clear();
  });

  it("round-trips a stored server target with shared secret", () => {
    saveServerTarget({
      baseUrl: "http://192.168.1.20:4311/",
      sharedSecret: "secret-1",
    });

    expect(readStoredServerTarget()).toEqual({
      version: 2,
      baseUrl: "http://192.168.1.20:4311",
      sharedSecret: "secret-1",
    });
  });

  it("reads legacy targets and upgrades them with a null shared secret", () => {
    window.localStorage.setItem(
      "farfield.server-target.v2",
      JSON.stringify({
        version: 1,
        baseUrl: "http://192.168.1.21:4311",
      }),
    );

    expect(readStoredServerTarget()).toEqual({
      version: 2,
      baseUrl: "http://192.168.1.21:4311",
      sharedSecret: null,
    });
  });

  it("rejects an empty shared secret", () => {
    expect(() => parseSharedSecret("   ")).toThrowError(/Shared secret is required/);
  });

  it("clears the stored target", () => {
    saveServerTarget({
      baseUrl: "http://192.168.1.22:4311",
      sharedSecret: "secret-2",
    });

    clearStoredServerTarget();

    expect(readStoredServerTarget()).toBeNull();
  });
});
