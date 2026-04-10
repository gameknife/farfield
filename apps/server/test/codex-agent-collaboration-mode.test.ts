import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopIpcError } from "@farfield/api";
import type { CollaborationMode } from "@farfield/protocol";
import {
  CodexAgentAdapter,
  type CodexAgentRuntimeState,
} from "../src/agents/adapters/codex-agent.js";

interface SetCollaborationModeCall {
  threadId: string;
  ownerClientId: string;
  collaborationMode: CollaborationMode;
}

type CodexAgentAdapterTestAccess = CodexAgentAdapter & {
  runtimeState: CodexAgentRuntimeState;
  threadOwnerById: Map<string, string>;
  ensureThreadLoaded: (threadId: string) => Promise<void>;
  setThreadOwnerClientId: (threadId: string, ownerClientId: string) => void;
  service: {
    setCollaborationMode: (
      input: SetCollaborationModeCall,
    ) => Promise<void>;
  };
};

const TEST_MODE: CollaborationMode = {
  mode: "plan",
  settings: {
    model: null,
    reasoning_effort: null,
    developer_instructions: null,
  },
};

function createAdapter(): CodexAgentAdapterTestAccess {
  const adapter = new CodexAgentAdapter({
    appExecutable: "codex",
    socketPath: "codex.sock",
    workspaceDir: process.cwd(),
    userAgent: "farfield-test",
    reconnectDelayMs: 10,
  }) as CodexAgentAdapterTestAccess;

  adapter.runtimeState = {
    appReady: true,
    ipcConnected: true,
    ipcInitialized: true,
    codexAvailable: true,
    lastError: null,
  };

  return adapter;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CodexAgentAdapter.setCollaborationMode", () => {
  it("returns and stores the refreshed owner after a no-client retry", async () => {
    const adapter = createAdapter();
    adapter.threadOwnerById.set("thread-1", "owner-stale");

    let ensureCalls = 0;
    adapter.ensureThreadLoaded = vi.fn(async (threadId: string) => {
      ensureCalls += 1;
      if (ensureCalls === 2) {
        adapter.setThreadOwnerClientId(threadId, "owner-fresh");
      }
    });

    const setCollaborationMode = vi
      .fn<(input: SetCollaborationModeCall) => Promise<void>>()
      .mockImplementationOnce(async () => {
        throw new DesktopIpcError(
          "IPC thread-follower-set-collaboration-mode failed: no-client-found",
        );
      })
      .mockResolvedValueOnce(undefined);
    adapter.service.setCollaborationMode = setCollaborationMode;

    const result = await adapter.setCollaborationMode({
      threadId: "thread-1",
      collaborationMode: TEST_MODE,
    });

    expect(result).toEqual({
      ownerClientId: "owner-fresh",
    });
    expect(adapter.threadOwnerById.get("thread-1")).toBe("owner-fresh");
    expect(setCollaborationMode).toHaveBeenCalledTimes(2);
    expect(setCollaborationMode.mock.calls[0]?.[0]?.ownerClientId).toBe(
      "owner-stale",
    );
    expect(setCollaborationMode.mock.calls[1]?.[0]?.ownerClientId).toBe(
      "owner-fresh",
    );
  });

  it("continues as soon as a thread owner is published", async () => {
    vi.useFakeTimers();

    const adapter = createAdapter();
    adapter.ensureThreadLoaded = vi.fn(async (threadId: string) => {
      setTimeout(() => {
        adapter.setThreadOwnerClientId(threadId, "owner-live");
      }, 10);
    });

    const setCollaborationMode = vi
      .fn<(input: SetCollaborationModeCall) => Promise<void>>()
      .mockResolvedValue(undefined);
    adapter.service.setCollaborationMode = setCollaborationMode;

    const pending = adapter.setCollaborationMode({
      threadId: "thread-2",
      collaborationMode: TEST_MODE,
    });

    vi.advanceTimersByTime(10);
    await Promise.resolve();
    await Promise.resolve();

    expect(setCollaborationMode).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toEqual({
      ownerClientId: "owner-live",
    });
    expect(setCollaborationMode.mock.calls[0]?.[0]?.ownerClientId).toBe(
      "owner-live",
    );
  });
});
