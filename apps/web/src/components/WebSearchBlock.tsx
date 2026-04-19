import { memo } from "react";
import type { UnifiedItem } from "@farfield/unified-surface";

type WebSearchItem = Extract<UnifiedItem, { type: "webSearch" }>;

interface WebSearchBlockProps {
  item: WebSearchItem;
  className?: string;
}

function WebSearchBlockComponent({
  item,
  className,
}: WebSearchBlockProps): React.JSX.Element {
  return (
    <div
      className={`${className ?? ""} rounded-lg border border-border bg-muted/20 px-3 py-2`}
    >
      <div className="text-[10px] text-muted-foreground font-mono mb-1 uppercase tracking-wider">
        Web search
      </div>
      <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words">
        {item.query}
      </div>
    </div>
  );
}

function areWebSearchBlockPropsEqual(
  prev: WebSearchBlockProps,
  next: WebSearchBlockProps,
): boolean {
  return prev.item === next.item && prev.className === next.className;
}

export const WebSearchBlock = memo(
  WebSearchBlockComponent,
  areWebSearchBlockPropsEqual,
);
