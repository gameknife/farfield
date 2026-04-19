import { memo, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, FileSearch, Globe, Loader2 } from "lucide-react";
import type { UnifiedItem } from "@farfield/unified-surface";
import { Button } from "@/components/ui/button";
import { CommandBlock } from "./CommandBlock";
import { WebSearchBlock } from "./WebSearchBlock";
import { toolBlockSpacingClass } from "./conversation-tool-layout";

export type ExplorationGroupItem = Extract<
  UnifiedItem,
  { type: "commandExecution" | "webSearch" }
>;

interface ExplorationGroupBlockProps {
  items: ExplorationGroupItem[];
  isActive: boolean;
  previousItemType: UnifiedItem["type"] | undefined;
  nextItemType: UnifiedItem["type"] | undefined;
}

interface ExplorationSummary {
  codeSearches: number;
  fileReads: number;
  webSearches: number;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeExplorationItems(
  items: readonly ExplorationGroupItem[],
): ExplorationSummary {
  let codeSearches = 0;
  let fileReads = 0;
  let webSearches = 0;

  for (const item of items) {
    if (item.type === "webSearch") {
      webSearches += 1;
      continue;
    }

    for (const action of item.commandActions ?? []) {
      switch (action.type) {
        case "search":
          codeSearches += 1;
          break;
        case "read":
        case "readFile":
        case "listFiles":
          fileReads += 1;
          break;
      }
    }
  }

  return {
    codeSearches,
    fileReads,
    webSearches,
  };
}

function buildSummaryLabels(summary: ExplorationSummary): string[] {
  const labels: string[] = [];

  if (summary.codeSearches > 0) {
    labels.push(
      pluralize(summary.codeSearches, "code search", "code searches"),
    );
  }

  if (summary.fileReads > 0) {
    labels.push(pluralize(summary.fileReads, "file read", "file reads"));
  }

  if (summary.webSearches > 0) {
    labels.push(pluralize(summary.webSearches, "web search", "web searches"));
  }

  return labels;
}

function ExplorationGroupBlockComponent({
  items,
  isActive,
  previousItemType,
  nextItemType,
}: ExplorationGroupBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const toolSpacing = toolBlockSpacingClass(previousItemType, nextItemType);
  const summary = useMemo(() => summarizeExplorationItems(items), [items]);
  const summaryLabels = useMemo(() => buildSummaryLabels(summary), [summary]);

  return (
    <div className={toolSpacing}>
      <div className="rounded-xl border border-border overflow-hidden text-sm">
        <Button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          variant="ghost"
          className="h-auto w-full grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-none bg-muted/35 px-3 py-2.5 text-left transition-colors hover:bg-muted/55"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <FileSearch size={11} className="shrink-0" />
              <span>Exploration</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {summaryLabels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/75 px-2 py-0.5 text-[11px] text-foreground/85"
                >
                  {label.includes("web") ? (
                    <Globe size={10} className="text-muted-foreground/70" />
                  ) : (
                    <FileSearch
                      size={10}
                      className="text-muted-foreground/70"
                    />
                  )}
                  <span>{label}</span>
                </span>
              ))}
              {summaryLabels.length === 0 && (
                <span className="inline-flex rounded-full border border-border/70 bg-background/75 px-2 py-0.5 text-[11px] text-foreground/85">
                  {pluralize(items.length, "step", "steps")}
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {isActive && (
              <Loader2 size={12} className="animate-spin text-muted-foreground" />
            )}
            <ChevronRight
              size={13}
              className={`text-muted-foreground/60 transition-transform duration-150 ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </div>
        </Button>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="expanded"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="border-t border-border bg-background/50 px-3 py-3 space-y-2">
                {items.map((item) => {
                  if (item.type === "commandExecution") {
                    return (
                      <CommandBlock
                        key={item.id}
                        item={item}
                        isActive={item.status === "inProgress"}
                      />
                    );
                  }

                  return <WebSearchBlock key={item.id} item={item} />;
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function areExplorationGroupBlockPropsEqual(
  prev: ExplorationGroupBlockProps,
  next: ExplorationGroupBlockProps,
): boolean {
  return (
    prev.items === next.items &&
    prev.isActive === next.isActive &&
    prev.previousItemType === next.previousItemType &&
    prev.nextItemType === next.nextItemType
  );
}

export const ExplorationGroupBlock = memo(
  ExplorationGroupBlockComponent,
  areExplorationGroupBlockPropsEqual,
);
