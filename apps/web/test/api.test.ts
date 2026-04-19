import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConnectionConfig,
  getEffectiveServerConnection,
  getNativeBootstrap,
  saveConnectionConfig,
  setNativeBootstrap,
} from "../src/lib/api";

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

describe("native connection config", () => {
  beforeEach(() => {
    localStorageBacking.clear();
    clearConnectionConfig();
    setNativeBootstrap(null);
  });

  it("persists remote client targets through the native shell bridge", async () => {
    setNativeBootstrap({
      connection: {
        version: 1,
        mode: "host",
        serverBaseUrl: "http://127.0.0.1:4311",
        sharedSecret: "local-secret",
      },
      runtime: {
        activeMode: "host",
        hostSupported: true,
        nativeAppUrl: "tauri://localhost/index.html",
        resolvedBindAddress: "0.0.0.0:4311",
        server4311Status: {
          state: "running",
          message: null,
        },
        web4312Status: {
          state: "running",
          message: null,
        },
      },
    });

    const saveNativeConnection = vi.fn(async (connection) => connection);

    const nextConnection = await saveConnectionConfig({
      baseUrl: "http://192.168.1.25:4311/",
      sharedSecret: "remote-secret",
      saveNativeConnection,
    });

    expect(saveNativeConnection).toHaveBeenCalledWith({
      version: 1,
      mode: "remoteClient",
      serverBaseUrl: "http://192.168.1.25:4311",
      sharedSecret: "remote-secret",
    });
    expect(nextConnection).toEqual({
      mode: "remoteClient",
      baseUrl: "http://192.168.1.25:4311",
      sharedSecret: "remote-secret",
      hasSavedTarget: true,
    });
    expect(getEffectiveServerConnection()).toEqual(nextConnection);
    expect(getNativeBootstrap()).toEqual({
      connection: {
        version: 1,
        mode: "remoteClient",
        serverBaseUrl: "http://192.168.1.25:4311",
        sharedSecret: "remote-secret",
      },
      runtime: {
        activeMode: "remoteClient",
        hostSupported: true,
        nativeAppUrl: "tauri://localhost/index.html",
        resolvedBindAddress: "0.0.0.0:4311",
        server4311Status: {
          state: "running",
          message: null,
        },
        web4312Status: {
          state: "running",
          message: null,
        },
      },
    });
  });
});
