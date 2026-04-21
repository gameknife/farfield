import type { UnifiedItem } from "@farfield/unified-surface";

const TOOL_BLOCK_TYPES: readonly UnifiedItem["type"][] = [
  "commandExecution",
  "fileChange",
  "webSearch",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "remoteTaskCreated",
  "forkedFromConversation",
  "unknown",
];

export function isToolBlockType(
  type: UnifiedItem["type"] | undefined,
): boolean {
  return type !== undefined && TOOL_BLOCK_TYPES.includes(type);
}

export function toolBlockSpacingClass(
  previousItemType: UnifiedItem["type"] | undefined,
  nextItemType: UnifiedItem["type"] | undefined,
): string {
  const previousIsTool = isToolBlockType(previousItemType);
  const nextIsTool = isToolBlockType(nextItemType);
  if (previousIsTool && nextIsTool) return "my-1";
  if (previousIsTool) return "mt-1 mb-2";
  if (nextIsTool) return "mt-2 mb-1";
  return "my-2";
}
