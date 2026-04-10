export function resolveThreadOwnerClientId(
  threadOwnerById: Map<string, string>,
  threadId: string,
  override?: string,
): string | null {
  const mapped = threadOwnerById.get(threadId);
  if (mapped && mapped.trim()) {
    return mapped.trim();
  }

  if (override && override.trim()) {
    return override.trim();
  }

  return null;
}

export function resolveOwnerClientId(
  threadOwnerById: Map<string, string>,
  threadId: string,
  override?: string,
  globalOwnerClientId?: string,
): string {
  const threadOwnerClientId = resolveThreadOwnerClientId(
    threadOwnerById,
    threadId,
    override,
  );
  if (threadOwnerClientId) {
    return threadOwnerClientId;
  }

  if (globalOwnerClientId && globalOwnerClientId.trim()) {
    return globalOwnerClientId.trim();
  }

  throw new Error(
    "No owner client id is known for this thread yet. Wait for the desktop app to publish a thread event.",
  );
}
