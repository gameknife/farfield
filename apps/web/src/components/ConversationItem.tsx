import { memo } from "react";
import { GitBranch } from "lucide-react";
import {
  JsonValueSchema,
  type JsonValue,
  type UnifiedItem,
  type UnifiedItemKind,
} from "@farfield/unified-surface";
import { z } from "zod";
import { ReasoningBlock } from "./ReasoningBlock";
import { CommandBlock } from "./CommandBlock";
import { DiffBlock } from "./DiffBlock";
import { MarkdownText } from "./MarkdownText";
import { WebSearchBlock } from "./WebSearchBlock";
import { toolBlockSpacingClass } from "./conversation-tool-layout";
import { ExpandableToolBlock } from "./ExpandableToolBlock";
import { CodeSnippet } from "./CodeSnippet";

type UserMessageLikeItem = Extract<
  UnifiedItem,
  { type: "userMessage" | "steeringUserMessage" }
>;
type MessageContentPart = UserMessageLikeItem["content"][number];

const DataImageUrlSchema = z
  .string()
  .regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/);

const ImageMimeTypeSchema = z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/);

const Base64ImagePayloadSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/=\s]+$/)
  .refine((value) => value.replaceAll(/\s+/g, "").length >= 64);

const DirectImageGenerationImageSchema = z.union([
  DataImageUrlSchema.transform((value) => value),
  Base64ImagePayloadSchema.transform(
    (value) => `data:image/png;base64,${value.replaceAll(/\s+/g, "")}`,
  ),
  z
    .object({
      imageBase64: Base64ImagePayloadSchema,
    })
    .passthrough()
    .transform(
      (value) =>
        `data:image/png;base64,${value.imageBase64.replaceAll(/\s+/g, "")}`,
    ),
  z
    .object({
      b64_json: Base64ImagePayloadSchema,
    })
    .passthrough()
    .transform(
      (value) => `data:image/png;base64,${value.b64_json.replaceAll(/\s+/g, "")}`,
    ),
  z
    .object({
      mimeType: ImageMimeTypeSchema,
      data: Base64ImagePayloadSchema,
    })
    .passthrough()
    .transform(
      (value) =>
        `data:${value.mimeType};base64,${value.data.replaceAll(/\s+/g, "")}`,
    ),
  z
    .object({
      mimeType: ImageMimeTypeSchema,
      base64: Base64ImagePayloadSchema,
    })
    .passthrough()
    .transform(
      (value) =>
        `data:${value.mimeType};base64,${value.base64.replaceAll(/\s+/g, "")}`,
    ),
  z
    .object({
      mimeType: ImageMimeTypeSchema,
      imageBase64: Base64ImagePayloadSchema,
    })
    .passthrough()
    .transform(
      (value) =>
        `data:${value.mimeType};base64,${value.imageBase64.replaceAll(/\s+/g, "")}`,
    ),
  z
    .object({
      imageUrl: DataImageUrlSchema,
    })
    .passthrough()
    .transform((value) => value.imageUrl),
  z
    .object({
      url: DataImageUrlSchema,
    })
    .passthrough()
    .transform((value) => value.url),
]);

const ImageGenerationResultSchema: z.ZodType<
  string[],
  z.ZodTypeDef,
  JsonValue
> = z.lazy(() =>
  JsonValueSchema.pipe(
    z.union([
      DirectImageGenerationImageSchema.transform((value) => [value]),
      z
        .object({
          image: ImageGenerationResultSchema,
        })
        .passthrough()
        .transform((value) => value.image),
      z
        .object({
          images: z.array(ImageGenerationResultSchema),
        })
        .passthrough()
        .transform((value) => value.images.flat()),
      z
        .object({
          texture: ImageGenerationResultSchema,
        })
        .passthrough()
        .transform((value) => value.texture),
      z
        .object({
          textures: z.array(ImageGenerationResultSchema),
        })
        .passthrough()
        .transform((value) => value.textures.flat()),
      z
        .object({
          result: ImageGenerationResultSchema,
        })
        .passthrough()
        .transform((value) => value.result),
      z
        .object({
          output: ImageGenerationResultSchema,
        })
        .passthrough()
        .transform((value) => value.output),
      z
        .object({
          content: z.array(ImageGenerationResultSchema),
        })
        .passthrough()
        .transform((value) => value.content.flat()),
      z
        .object({
          artifacts: z.array(ImageGenerationResultSchema),
        })
        .passthrough()
        .transform((value) => value.artifacts.flat()),
      z
        .object({
          data: ImageGenerationResultSchema,
        })
        .passthrough()
        .transform((value) => value.data),
      z
        .array(ImageGenerationResultSchema)
        .transform((value) => value.flat()),
    ]),
  ),
);

interface Props {
  item: UnifiedItem;
  isLast: boolean;
  turnIsInProgress: boolean;
  onSelectThread: (threadId: string) => void;
  previousItemType?: UnifiedItem["type"] | undefined;
  nextItemType?: UnifiedItem["type"] | undefined;
}

function renderImagePreview(src: string, alt: string): React.JSX.Element {
  return (
    <img
      src={src}
      alt={alt}
      className="max-h-80 w-auto max-w-full rounded-xl border border-border bg-background/50 object-contain shadow-sm"
    />
  );
}

function isInlineDataImageUrl(value: string): boolean {
  return DataImageUrlSchema.safeParse(value).success;
}

function extractImageGenerationResultImages(
  value: JsonValue | null | undefined,
): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  const parsed = ImageGenerationResultSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }

  return [...new Set(parsed.data)];
}

function renderMessagePart(
  part: MessageContentPart,
  key: string,
): React.JSX.Element {
  switch (part.type) {
    case "text":
      return <MarkdownText key={key} text={part.text} />;
    case "image":
      return (
        <div key={key} className="space-y-2">
          {renderImagePreview(part.url, "Attached image")}
          {!isInlineDataImageUrl(part.url) && (
            <div className="font-mono text-[11px] text-muted-foreground break-all">
              {part.url}
            </div>
          )}
        </div>
      );
    case "localImage":
      return (
        <div key={key} className="space-y-2">
          {renderImagePreview(part.path, "Attached local image")}
          <div className="font-mono text-[11px] text-muted-foreground break-all">
            {part.path}
          </div>
        </div>
      );
    case "skill":
      return (
        <div
          key={key}
          className="inline-flex max-w-full items-center rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-foreground"
        >
          <span className="mr-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            Skill
          </span>
          <span className="truncate">{part.name}</span>
        </div>
      );
    case "mention":
      return (
        <div
          key={key}
          className="inline-flex max-w-full items-center rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-foreground"
        >
          <span className="mr-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            Mention
          </span>
          <span className="truncate">{part.name}</span>
        </div>
      );
    default:
      return assertNever(part);
  }
}

function renderUserMessageBubble(
  content: UserMessageLikeItem["content"],
): React.JSX.Element | null {
  if (content.length === 0) {
    return null;
  }

  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] space-y-3 rounded-2xl bg-muted px-4 py-3 text-sm text-foreground leading-relaxed">
        {content.map((part, index) =>
          renderMessagePart(part, `${part.type}-${String(index)}`),
        )}
      </div>
    </div>
  );
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
    return renderUserMessageBubble(item.content);
  },

  steeringUserMessage: ({ item }) => {
    return renderUserMessageBubble(item.content);
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
    <WebSearchBlock item={item} className={toolSpacing} />
  ),

  mcpToolCall: ({ item, toolSpacing }) => {
    const argumentsText = JSON.stringify(item.arguments, null, 2);
    const resultText =
      item.result?.content && item.result.content.length > 0
        ? JSON.stringify(item.result.content, null, 2)
        : null;
    return (
      <ExpandableToolBlock
        className={toolSpacing}
        title="MCP tool"
        summary={`${item.server}/${item.tool} (${item.status})`}
        defaultExpanded={item.status === "inProgress"}
        isActive={item.status === "inProgress"}
        durationMs={item.durationMs}
        statusTone={
          item.status === "failed"
            ? "danger"
            : item.status === "completed"
              ? "success"
              : "neutral"
        }
        body={
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Arguments
              </div>
              <CodeSnippet code={argumentsText} language="json" />
            </div>
            {resultText && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Result
                </div>
                <CodeSnippet code={resultText} language="json" />
              </div>
            )}
            {item.error?.message && (
              <div className="text-xs text-danger whitespace-pre-wrap break-words">
                {item.error.message}
              </div>
            )}
          </div>
        }
      />
    );
  },

  imageGeneration: ({ item, toolSpacing }) => {
    const resultImages = extractImageGenerationResultImages(item.result);
    const resultText =
      item.result !== undefined && item.result !== null && resultImages.length === 0
        ? JSON.stringify(item.result, null, 2)
        : null;

    return (
      <ExpandableToolBlock
        className={toolSpacing}
        title="Image generation"
        summary={item.status}
        defaultExpanded={item.status === "generating"}
        isActive={item.status === "generating"}
        statusTone={
          item.status === "completed"
            ? "success"
            : item.status === "failed"
              ? "danger"
              : "neutral"
        }
        body={
          <div className="space-y-3">
            {item.revisedPrompt && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Revised Prompt
                </div>
                <div className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
                  {item.revisedPrompt}
                </div>
              </div>
            )}
            {resultImages.length > 0 && (
              <div className="space-y-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Images
                </div>
                {resultImages.map((imageSrc, index) => (
                  <div
                    key={`image-generation-${String(index)}`}
                    className="space-y-2"
                  >
                    {renderImagePreview(
                      imageSrc,
                      `Generated image ${String(index + 1)}`,
                    )}
                  </div>
                ))}
              </div>
            )}
            {resultText && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Result
                </div>
                <CodeSnippet code={resultText} language="json" />
              </div>
            )}
          </div>
        }
      />
    );
  },

  dynamicToolCall: ({ item, toolSpacing }) => {
    const argumentsText = JSON.stringify(item.arguments, null, 2);
    const contentItemsText = item.contentItems
      ? JSON.stringify(item.contentItems, null, 2)
      : null;
    return (
      <ExpandableToolBlock
        className={toolSpacing}
        title="Dynamic tool"
        summary={`${item.tool} (${item.status})`}
        defaultExpanded={item.status === "inProgress"}
        isActive={item.status === "inProgress"}
        durationMs={item.durationMs}
        statusTone={
          item.status === "failed"
            ? "danger"
            : item.status === "completed"
              ? "success"
              : "neutral"
        }
        body={
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Arguments
              </div>
              <CodeSnippet code={argumentsText} language="json" />
            </div>
            {contentItemsText && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Content Items
                </div>
                {item.contentItems && item.contentItems.length > 0 && (
                  <div className="mb-3 space-y-3">
                    {item.contentItems.map((contentItem, index) =>
                      contentItem.type === "inputText" ? (
                        <div
                          key={`dynamic-content-${String(index)}`}
                          className="rounded-lg border border-border bg-background/40 px-3 py-2 text-xs text-foreground whitespace-pre-wrap break-words"
                        >
                          {contentItem.text}
                        </div>
                      ) : (
                        <div
                          key={`dynamic-content-${String(index)}`}
                          className="space-y-2"
                        >
                          {renderImagePreview(
                            contentItem.imageUrl,
                            "Dynamic tool image",
                          )}
                          <div className="font-mono text-[11px] text-muted-foreground break-all">
                            {contentItem.imageUrl}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                )}
                <CodeSnippet code={contentItemsText} language="json" />
              </div>
            )}
            {item.success != null && (
              <div className="text-xs text-muted-foreground">
                success: {String(item.success)}
              </div>
            )}
          </div>
        }
      />
    );
  },

  collabAgentToolCall: ({ item, toolSpacing }) => (
    <ExpandableToolBlock
      className={toolSpacing}
      title="Collab tool"
      summary={`${item.tool} (${item.status})`}
      defaultExpanded={item.status === "inProgress"}
      isActive={item.status === "inProgress"}
      statusTone={
        item.status === "failed"
          ? "danger"
          : item.status === "completed"
            ? "success"
            : "neutral"
      }
      body={
        <div className="space-y-3">
          <div className="text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
            sender: {item.senderThreadId}
          </div>
          <div className="text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
            receivers: {item.receiverThreadIds.join(", ") || "none"}
          </div>
          {item.prompt && (
            <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words">
              {item.prompt}
            </div>
          )}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Agent States
            </div>
            <CodeSnippet
              code={JSON.stringify(item.agentsStates, null, 2)}
              language="json"
            />
          </div>
        </div>
      }
    />
  ),

  imageView: ({ item, toolSpacing }) => (
    <ExpandableToolBlock
      className={toolSpacing}
      title="Image view"
      summary={item.path}
      body={
        <div className="space-y-3">
          {renderImagePreview(item.path, "Viewed image")}
          <div className="font-mono text-[11px] text-muted-foreground break-all">
            {item.path}
          </div>
        </div>
      }
    />
  ),

  enteredReviewMode: ({ item, toolSpacing }) => (
    <ExpandableToolBlock
      className={toolSpacing}
      title="Review mode"
      summary={`Entered review mode: ${item.review}`}
      body={
        <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
          Review session: {item.review}
        </div>
      }
    />
  ),

  exitedReviewMode: ({ item, toolSpacing }) => (
    <ExpandableToolBlock
      className={toolSpacing}
      title="Review mode"
      summary={`Exited review mode: ${item.review}`}
      body={
        <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
          Review session: {item.review}
        </div>
      }
    />
  ),

  remoteTaskCreated: ({ item, toolSpacing }) => (
    <div
      className={`${toolSpacing} rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground`}
    >
      <div className="text-[10px] text-muted-foreground font-mono mb-1 uppercase tracking-wider">
        Remote task
      </div>
      <div className="text-xs text-foreground/90 whitespace-pre-wrap break-all">
        Created task: {item.taskId}
      </div>
    </div>
  ),

  modelChanged: (_args) => (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      Model changed
    </div>
  ),

  forkedFromConversation: ({ item, onSelectThread, toolSpacing }) => (
    <div
      className={`${toolSpacing} rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground`}
    >
      <div className="text-[10px] text-muted-foreground font-mono mb-1 uppercase tracking-wider">
        Forked from
      </div>
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
    </div>
  ),

  unknown: ({ item, toolSpacing }) => (
    <ExpandableToolBlock
      className={toolSpacing}
      title="Unknown item"
      summary={`original type: ${item.originalType}`}
      body={
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            Farfield does not have a dedicated renderer for this thread item yet.
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Payload
            </div>
            <CodeSnippet
              code={JSON.stringify(item.payload, null, 2)}
              language="json"
            />
          </div>
        </div>
      }
    />
  ),
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
    case "imageGeneration":
      return ITEM_RENDERERS.imageGeneration({ item, ...context });
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
    case "unknown":
      return ITEM_RENDERERS.unknown({ item, ...context });
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
