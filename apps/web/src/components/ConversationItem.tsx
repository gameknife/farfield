import { memo } from "react";
import {
  GitBranch,
  Image as ImageIcon,
  Search,
  SquarePen,
  Users,
  Wrench,
} from "lucide-react";
import type { UnifiedItem, UnifiedItemKind } from "@farfield/unified-surface";
import { formatDurationSeconds } from "@/lib/tool-call-ui";
import { ReasoningBlock } from "./ReasoningBlock";
import { CommandBlock } from "./CommandBlock";
import { DiffBlock } from "./DiffBlock";
import { MarkdownText } from "./MarkdownText";
import { McpToolBlock } from "./McpToolBlock";
import { ToolCallRow } from "./ToolCallRow";

type UserMessageLikeItem = Extract<
  UnifiedItem,
  { type: "userMessage" | "steeringUserMessage" }
>;

interface Props {
  item: UnifiedItem;
  isLast: boolean;
  turnIsInProgress: boolean;
  onSelectThread: (threadId: string) => void;
  previousItemType?: UnifiedItem["type"] | undefined;
  nextItemType?: UnifiedItem["type"] | undefined;
}

const TOOL_BLOCK_TYPES: readonly UnifiedItem["type"][] = [
  "commandExecution",
  "fileChange",
  "webSearch",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "imageView",
  "enteredReviewMode",
  "exitedReviewMode",
  "remoteTaskCreated",
  "modelChanged",
  "forkedFromConversation",
];

function isToolBlockType(type: UnifiedItem["type"] | undefined): boolean {
  return type !== undefined && TOOL_BLOCK_TYPES.includes(type);
}

function toolBlockSpacingClass(
  previousItemType: UnifiedItem["type"] | undefined,
  nextItemType: UnifiedItem["type"] | undefined,
): string {
  return "";
}

function readTextContent(content: UserMessageLikeItem["content"]): string {
  return content
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
          return "[Image attached]";
        case "localImage":
          return `[Local image] ${part.path}`;
        case "skill":
          return `[Skill] ${part.name}`;
        case "mention":
          return `[Mention] ${part.name}`;
        default:
          return "";
      }
    })
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

function trimInjectedBrowserContext(text: string): string {
  const marker = "## My request for Codex:";
  const trimmedStart = text.trimStart();
  const hasInjectedBrowserContext =
    trimmedStart.startsWith("# In app browser:") ||
    trimmedStart.startsWith("# Diff comments:");
  if (!hasInjectedBrowserContext) {
    return text;
  }

  const markerIndex = trimmedStart.indexOf(marker);
  if (markerIndex < 0) {
    return text;
  }

  const requestText = trimmedStart.slice(markerIndex + marker.length);
  const imageBoilerplateIndex = requestText.indexOf("The next image shows");
  return (
    imageBoilerplateIndex >= 0
      ? requestText.slice(0, imageBoilerplateIndex)
      : requestText
  ).trim();
}

function toolStatusText(status: string): React.JSX.Element | null {
  if (status === "inProgress") {
    return <span className="reasoning-shimmer">running</span>;
  }

  if (status === "failed") {
    return <span className="text-danger/80">failed</span>;
  }

  return null;
}

interface RendererContext {
  isActive: boolean;
  toolSpacing: string;
  onSelectThread: (threadId: string) => void;
}

type ItemRendererMap = {
  [K in UnifiedItemKind]: (
    args: RendererContext & { item: Extract<UnifiedItem, { type: K }> },
  ) => React.JSX.Element | null;
};

const ITEM_RENDERERS = {
  userMessage: ({ item }) => {
    const text = trimInjectedBrowserContext(readTextContent(item.content));
    if (!text) {
      return null;
    }

    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground leading-relaxed">
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </div>
      </div>
    );
  },

  steeringUserMessage: ({ item }) => {
    const text = trimInjectedBrowserContext(readTextContent(item.content));
    if (!text) {
      return null;
    }

    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground leading-relaxed">
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </div>
      </div>
    );
  },

  agentMessage: ({ item }) => {
    if (!item.text) {
      return null;
    }

    return <MarkdownText text={item.text} />;
  },

  error: ({ item }) => (
    <div className="my-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-red-300 mb-2">
        Error
      </div>
      <div className="text-sm text-red-100 whitespace-pre-wrap break-words leading-relaxed">
        {item.message}
      </div>
    </div>
  ),

  reasoning: ({ item, isActive }) => {
    const summary = item.summary ?? [];
    if (summary.length === 0 && !item.text) {
      return null;
    }

    return (
      <ReasoningBlock
        summary={summary.length > 0 ? summary : ["Thinking…"]}
        text={item.text}
        isActive={isActive}
      />
    );
  },

  plan: ({ item }) => (
    <div className="my-4 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
        Plan
      </div>
      <div className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
        {item.text}
      </div>
    </div>
  ),

  todoList: ({ item }) => (
    <div className="my-4 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
        Checklist
      </div>
      {item.explanation && (
        <div className="mb-2 text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
          {item.explanation}
        </div>
      )}
      <ul className="space-y-1">
        {item.plan.map((entry, index) => (
          <li
            key={`${entry.step}-${String(index)}`}
            className="text-sm text-foreground/90 flex items-start gap-2"
          >
            <span className="mt-[2px] text-muted-foreground">
              {entry.status === "completed" ? "x" : "o"}
            </span>
            <span className="whitespace-pre-wrap break-words">
              {entry.step}
            </span>
          </li>
        ))}
      </ul>
    </div>
  ),

  planImplementation: ({ item }) => (
    <div className="my-4 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
        Plan Implementation
      </div>
      <div className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
        {item.planContent}
      </div>
    </div>
  ),

  userInputResponse: ({ item }) => {
    const answersText = Object.values(item.answers)
      .map((answers) => answers.join(", "))
      .join("\n");

    if (!answersText) {
      return null;
    }

    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl border border-border bg-muted/30 px-4 py-2.5">
          <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider font-medium">
            Response
          </div>
          <div className="text-sm text-foreground whitespace-pre-wrap">
            {answersText}
          </div>
        </div>
      </div>
    );
  },

  commandExecution: ({ item, isActive, toolSpacing }) => (
    <div className={toolSpacing}>
      <CommandBlock item={item} isActive={isActive} />
    </div>
  ),

  fileChange: ({ item, toolSpacing }) => (
    <div className={toolSpacing}>
      <DiffBlock changes={item.changes} />
    </div>
  ),

  contextCompaction: (_args) => (
    <div className="flex items-center my-6">
      <div className="flex-1 border-t border-dashed border-border/80"></div>
      <div className="mx-4 text-[10px] uppercase tracking-widest text-muted-foreground/50 font-medium">
        Compacted
      </div>
      <div className="flex-1 border-t border-dashed border-border/80"></div>
    </div>
  ),

  webSearch: ({ item, toolSpacing }) => (
    <ToolCallRow
      icon={Search}
      iconClassName="text-blue-400"
      title="Web search"
      className={toolSpacing}
    >
      <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words">
        {item.query}
      </div>
    </ToolCallRow>
  ),

  mcpToolCall: ({ item, toolSpacing }) => (
    <McpToolBlock item={item} className={toolSpacing} />
  ),

  dynamicToolCall: ({ item, toolSpacing }) => {
    const argumentsText = JSON.stringify(item.arguments);
    const statusText = toolStatusText(item.status);
    return (
      <ToolCallRow
        icon={Wrench}
        iconClassName="text-amber-400"
        title={item.tool}
        className={toolSpacing}
        meta={
          <span className="flex items-center gap-1.5">
            {statusText}
            {item.durationMs != null && (
              <span>
                {formatDurationSeconds(item.durationMs)}
              </span>
            )}
          </span>
        }
      >
        {item.success !== undefined && item.success !== null && (
          <div className="text-[11px] text-muted-foreground">
            success: {item.success ? "yes" : "no"}
          </div>
        )}
        {item.contentItems && item.contentItems.length > 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            Output parts: {item.contentItems.length}
          </div>
        )}
        <div className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
          {argumentsText}
        </div>
      </ToolCallRow>
    );
  },

  collabAgentToolCall: ({ item, toolSpacing }) => (
    <ToolCallRow
      icon={Users}
      iconClassName="text-violet-400"
      title={item.tool}
      className={toolSpacing}
      meta={toolStatusText(item.status)}
    >
      <div className="text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
        sender: {item.senderThreadId}
      </div>
      <div className="text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
        receivers: {item.receiverThreadIds.join(", ") || "none"}
      </div>
      {item.prompt && (
        <div className="mt-2 text-xs text-foreground/80 whitespace-pre-wrap break-words">
          {item.prompt}
        </div>
      )}
    </ToolCallRow>
  ),

  imageView: ({ item, toolSpacing }) => (
    <ToolCallRow
      icon={ImageIcon}
      iconClassName="text-blue-400"
      title="Viewed image"
      className={toolSpacing}
    >
      Viewed image: {item.path}
    </ToolCallRow>
  ),

  enteredReviewMode: ({ item, toolSpacing }) => (
    <ToolCallRow
      icon={SquarePen}
      iconClassName="text-blue-400"
      title="Entered review mode"
      className={toolSpacing}
    >
      Entered review mode: {item.review}
    </ToolCallRow>
  ),

  exitedReviewMode: ({ item, toolSpacing }) => (
    <ToolCallRow
      icon={SquarePen}
      iconClassName="text-blue-400"
      title="Exited review mode"
      className={toolSpacing}
    >
      Exited review mode: {item.review}
    </ToolCallRow>
  ),

  remoteTaskCreated: ({ item, toolSpacing }) => (
    <ToolCallRow
      icon={Wrench}
      iconClassName="text-amber-400"
      title="Remote task"
      className={toolSpacing}
    >
      <div className="text-xs text-foreground/90 whitespace-pre-wrap break-all">
        Created task: {item.taskId}
      </div>
    </ToolCallRow>
  ),

  modelChanged: ({ toolSpacing }) => (
    <ToolCallRow
      icon={Wrench}
      iconClassName="text-amber-400"
      title="Model changed"
      className={toolSpacing}
    />
  ),

  forkedFromConversation: ({ item, onSelectThread, toolSpacing }) => (
    <ToolCallRow
      icon={GitBranch}
      iconClassName="text-muted-foreground/65"
      title="Forked from"
      className={toolSpacing}
    >
      <div className="flex items-center gap-1.5">
        <GitBranch size={13} className="text-muted-foreground/80 shrink-0" />
        <a
          href={`/threads/${encodeURIComponent(item.sourceConversationId)}`}
          className="font-medium text-foreground hover:underline truncate"
          onClick={(event) => {
            event.preventDefault();
            onSelectThread(item.sourceConversationId);
          }}
        >
          {item.sourceConversationTitle?.trim() || "Untitled thread"}
        </a>
      </div>
    </ToolCallRow>
  ),

  steered: (_args) => null,
} satisfies ItemRendererMap;

function assertNever(value: never): never {
  throw new Error(`Unhandled item kind: ${String(value)}`);
}

function renderItem(
  item: UnifiedItem,
  context: RendererContext,
): React.JSX.Element | null {
  switch (item.type) {
    case "userMessage":
      return ITEM_RENDERERS.userMessage({ item, ...context });
    case "steeringUserMessage":
      return ITEM_RENDERERS.steeringUserMessage({ item, ...context });
    case "agentMessage":
      return ITEM_RENDERERS.agentMessage({ item, ...context });
    case "error":
      return ITEM_RENDERERS.error({ item, ...context });
    case "reasoning":
      return ITEM_RENDERERS.reasoning({ item, ...context });
    case "plan":
      return ITEM_RENDERERS.plan({ item, ...context });
    case "todoList":
      return ITEM_RENDERERS.todoList({ item, ...context });
    case "planImplementation":
      return ITEM_RENDERERS.planImplementation({ item, ...context });
    case "userInputResponse":
      return ITEM_RENDERERS.userInputResponse({ item, ...context });
    case "commandExecution":
      return ITEM_RENDERERS.commandExecution({ item, ...context });
    case "fileChange":
      return ITEM_RENDERERS.fileChange({ item, ...context });
    case "contextCompaction":
      return ITEM_RENDERERS.contextCompaction({ item, ...context });
    case "webSearch":
      return ITEM_RENDERERS.webSearch({ item, ...context });
    case "mcpToolCall":
      return ITEM_RENDERERS.mcpToolCall({ item, ...context });
    case "dynamicToolCall":
      return ITEM_RENDERERS.dynamicToolCall({ item, ...context });
    case "collabAgentToolCall":
      return ITEM_RENDERERS.collabAgentToolCall({ item, ...context });
    case "imageView":
      return ITEM_RENDERERS.imageView({ item, ...context });
    case "enteredReviewMode":
      return ITEM_RENDERERS.enteredReviewMode({ item, ...context });
    case "exitedReviewMode":
      return ITEM_RENDERERS.exitedReviewMode({ item, ...context });
    case "remoteTaskCreated":
      return ITEM_RENDERERS.remoteTaskCreated({ item, ...context });
    case "modelChanged":
      return ITEM_RENDERERS.modelChanged({ item, ...context });
    case "forkedFromConversation":
      return ITEM_RENDERERS.forkedFromConversation({ item, ...context });
    case "steered":
      return null;
    default:
      return assertNever(item);
  }
}

function ConversationItemComponent({
  item,
  isLast,
  turnIsInProgress,
  onSelectThread,
  previousItemType,
  nextItemType,
}: Props) {
  const isActive = isLast && turnIsInProgress;
  const toolSpacing = toolBlockSpacingClass(previousItemType, nextItemType);

  return renderItem(item, {
    isActive,
    toolSpacing,
    onSelectThread,
  });
}

function areConversationItemPropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.item === next.item &&
    prev.isLast === next.isLast &&
    prev.turnIsInProgress === next.turnIsInProgress &&
    prev.onSelectThread === next.onSelectThread &&
    prev.previousItemType === next.previousItemType &&
    prev.nextItemType === next.nextItemType
  );
}

export const ConversationItem = memo(
  ConversationItemComponent,
  areConversationItemPropsEqual,
);
