import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopIpcError } from "@farfield/api";
import type { CollaborationMode, IpcFrame, ThreadConversationState } from "@farfield/protocol";
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
  streamEventsByThreadId: Map<string, IpcFrame[]>;
  streamSnapshotByThreadId: Map<string, ThreadConversationState>;
  streamSnapshotOriginByThreadId: Map<
    string,
    "stream" | "readThreadWithTurns" | "readThread"
  >;
  lastKnownOwnerClientId: string | null;
  ensureThreadLoaded: (threadId: string) => Promise<void>;
  resetLiveSessionState: () => void;
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

  it("ignores non-thread stream broadcasts when reducing live state", async () => {
    const adapter = createAdapter();
    const threadId = "thread-live-state";
    const snapshotState: ThreadConversationState = {
      id: threadId,
      turns: [],
      requests: [],
      title: "before",
    };

    adapter.streamSnapshotByThreadId.set(threadId, snapshotState);
    adapter.streamSnapshotOriginByThreadId.set(threadId, "stream");
    adapter.streamEventsByThreadId.set(threadId, [
      {
        type: "broadcast",
        method: "thread-title-changed",
        sourceClientId: "owner-live",
        version: 1,
        params: {
          threadId,
          title: "ignored",
        },
      },
      {
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "owner-live",
        version: 1,
        params: {
          conversationId: threadId,
          type: "thread-stream-state-changed",
          version: 1,
          change: {
            type: "patches",
            patches: [
              {
                op: "replace",
                path: ["title"],
                value: "after",
              },
            ],
          },
        },
      },
    ]);

    const state = await adapter.readLiveState(threadId);

    expect(state.liveStateError).toBeNull();
    expect(state.conversationState?.title).toBe("after");
    expect(state.ownerClientId).toBe("owner-live");
  });

  it("ignores malformed older stream events when a newer snapshot exists", async () => {
    const adapter = createAdapter();
    const threadId = "thread-live-state-with-stale-invalid-event";

    adapter.streamSnapshotByThreadId.set(threadId, {
      id: threadId,
      turns: [],
      requests: [],
      title: "before",
    });
    adapter.streamSnapshotOriginByThreadId.set(threadId, "stream");
    adapter.streamEventsByThreadId.set(threadId, [
      {
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "owner-live",
        version: 1,
        params: {
          conversationId: threadId,
          type: "thread-stream-state-changed",
          version: 1,
          change: {
            type: "patches",
          },
        },
      },
      {
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "owner-live",
        version: 1,
        params: {
          conversationId: threadId,
          type: "thread-stream-state-changed",
          version: 1,
          change: {
            type: "snapshot",
            conversationState: {
              id: threadId,
              turns: [],
              requests: [],
              title: "after-snapshot",
            },
          },
        },
      },
      {
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "owner-live",
        version: 1,
        params: {
          conversationId: threadId,
          type: "thread-stream-state-changed",
          version: 1,
          change: {
            type: "patches",
            patches: [
              {
                op: "replace",
                path: ["title"],
                value: "after-patch",
              },
            ],
          },
        },
      },
    ]);

    const state = await adapter.readLiveState(threadId);

    expect(state.liveStateError).toBeNull();
    expect(state.conversationState?.title).toBe("after-patch");
    expect(state.ownerClientId).toBe("owner-live");
  });

  it("clears stale live session caches when the ipc session resets", async () => {
    const adapter = createAdapter();
    const threadId = "thread-stale-live-session";

    adapter.threadOwnerById.set(threadId, "owner-stale");
    adapter.lastKnownOwnerClientId = "owner-stale";
    adapter.streamSnapshotByThreadId.set(threadId, {
      id: threadId,
      turns: [],
      requests: [],
      title: "stale-title",
    });
    adapter.streamSnapshotOriginByThreadId.set(threadId, "stream");
    adapter.streamEventsByThreadId.set(threadId, [
      {
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "owner-stale",
        version: 1,
        params: {
          conversationId: threadId,
          type: "thread-stream-state-changed",
          version: 1,
          change: {
            type: "patches",
            patches: [
              {
                op: "replace",
                path: ["title"],
                value: "broken",
              },
            ],
          },
        },
      },
    ]);

    adapter.resetLiveSessionState();

    expect(adapter.threadOwnerById.size).toBe(0);
    expect(adapter.streamSnapshotByThreadId.size).toBe(0);
    expect(adapter.streamSnapshotOriginByThreadId.size).toBe(0);
    expect(adapter.streamEventsByThreadId.size).toBe(0);
    expect(adapter.lastKnownOwnerClientId).toBeNull();

    const state = await adapter.readLiveState(threadId);
    expect(state.ownerClientId).toBeNull();
    expect(state.conversationState).toBeNull();
    expect(state.liveStateError).toBeNull();
  });
});
