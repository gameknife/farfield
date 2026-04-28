import React, { memo, useState } from "react";
import {
  Terminal,
  Search,
  FolderOpen,
  FileText,
  FileSearch,
} from "lucide-react";
import type { UnifiedItem } from "@farfield/unified-surface";
import { summarizeCommandForHeader } from "@/lib/command-action-ui";
import { formatDurationSeconds } from "@/lib/tool-call-ui";
import {
  ToolCallDetailCode,
  ToolCallDetails,
  ToolCallDetailText,
} from "./ToolCallDetails";
import { ToolCallRow } from "./ToolCallRow";

type CommandItem = Extract<UnifiedItem, { type: "commandExecution" }>;

const ACTION_ICONS: Record<string, React.ElementType> = {
  search: Search,
  listFiles: FolderOpen,
  write: FileText,
  read: FileSearch,
  readFile: FileSearch,
  writeFile: FileText,
};

interface CommandBlockProps {
  item: CommandItem;
  isActive: boolean;
}

function CommandBlockComponent({ item, isActive }: CommandBlockProps) {
  const [expanded, setExpanded] = useState(item.status === "inProgress");
  const lastStatusRef = React.useRef(item.status);

  React.useEffect(() => {
    if (item.status === "completed" && lastStatusRef.current === "inProgress") {
      setExpanded(false);
    }
    lastStatusRef.current = item.status;
  }, [item.status]);
  const isCompleted = item.status === "completed";
  const isSuccess = item.exitCode === 0 || item.exitCode == null;
  const output =
    typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  const hasOutput = output.trim().length > 0;
  const headerSegments = summarizeCommandForHeader(item.command, item.commandActions);
  const displayedHeaderSegments = headerSegments.slice(0, 3);
  const hiddenHeaderSegmentsCount = Math.max(headerSegments.length - 3, 0);
  const statusText = isActive ? "running" : isCompleted && !isSuccess ? "failed" : null;
  const firstSegment = displayedHeaderSegments[0];
  const FirstSegmentIcon =
    firstSegment === undefined ? Terminal : ACTION_ICONS[firstSegment.iconKey] ?? Terminal;
  const titleIsRawCommand =
    firstSegment === undefined || firstSegment.iconKey === "unknown";

  return (
    <div className="text-sm">
      <ToolCallRow
        icon={FirstSegmentIcon}
        iconClassName="text-muted-foreground/65"
        title={
          titleIsRawCommand && firstSegment !== undefined ? (
            <code title={firstSegment.tooltip ?? firstSegment.text}>
              {firstSegment.text}
            </code>
          ) : firstSegment === undefined ? (
            <code>{item.command}</code>
          ) : (
            <span title={firstSegment.tooltip ?? firstSegment.text}>
              {firstSegment.text}
            </span>
          )
        }
        titleClassName={titleIsRawCommand ? "font-mono" : ""}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        meta={
          <>
            {statusText && (
              <span className={isActive ? "reasoning-shimmer" : "text-danger/80"}>
                {statusText}
              </span>
            )}
            {item.durationMs != null && (
              <span>{formatDurationSeconds(item.durationMs)}</span>
            )}
          </>
        }
      >
        {hiddenHeaderSegmentsCount > 0 && (
          <div className="text-[10px] leading-4 text-muted-foreground/70">
            +{hiddenHeaderSegmentsCount} more segment
            {hiddenHeaderSegmentsCount === 1 ? "" : "s"}
          </div>
        )}
        <ToolCallDetails>
          <ToolCallDetailCode
            label="Command"
            code={item.command}
            language="bash"
          />
          {hasOutput ? (
            <ToolCallDetailCode
              label="Output"
              code={output}
              language="bash"
              className="max-h-56 overflow-y-auto"
            />
          ) : (
            <ToolCallDetailText>No output</ToolCallDetailText>
          )}
        </ToolCallDetails>
      </ToolCallRow>
    </div>
  );
}

function areCommandBlockPropsEqual(
  prev: CommandBlockProps,
  next: CommandBlockProps,
): boolean {
  return prev.item === next.item && prev.isActive === next.isActive;
}

export const CommandBlock = memo(
  CommandBlockComponent,
  areCommandBlockPropsEqual,
);
