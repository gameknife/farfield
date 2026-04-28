import type React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ToolCallRowProps {
  icon: React.ElementType;
  title: React.ReactNode;
  meta?: React.ReactNode;
  iconClassName?: string;
  titleClassName?: string;
  className?: string;
  expanded?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
}

const ROW_CLASS =
  "group h-auto w-full grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md px-0 py-1 text-left font-normal transition-colors hover:bg-transparent hover:text-current focus-visible:ring-0 focus-visible:outline-none [&_svg]:size-3.5";

function RowContent({
  icon: Icon,
  title,
  meta,
  iconClassName,
  titleClassName,
  expanded,
  canExpand,
}: ToolCallRowProps & { canExpand: boolean }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 text-xs font-normal text-foreground/70 transition-colors group-hover:text-foreground">
        <Icon className={`shrink-0 transition-colors ${iconClassName ?? "text-muted-foreground/65"}`} />
        <div className={`min-w-0 truncate ${titleClassName ?? ""}`}>{title}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground/50 transition-colors group-hover:text-muted-foreground/75">
        {meta}
        {canExpand && (
          <ChevronRight
            className={`text-muted-foreground/45 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
        )}
      </div>
    </>
  );
}

export function ToolCallRow(props: ToolCallRowProps) {
  const canExpand = props.onToggle !== undefined;
  const detailsAreVisible = props.children !== undefined && (!canExpand || props.expanded === true);

  return (
    <div className={`${props.className ?? ""} text-sm`}>
      {canExpand ? (
        <Button
          type="button"
          variant="ghost"
          onClick={props.onToggle}
          className={ROW_CLASS}
        >
          <RowContent {...props} canExpand />
        </Button>
      ) : (
        <div className={ROW_CLASS}>
          <RowContent {...props} canExpand={false} />
        </div>
      )}
      <AnimatePresence initial={false}>
        {detailsAreVisible && (
          <motion.div
            key="tool-row-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1 border-l-2 border-muted-foreground/25 pl-3 pb-1">
              {props.children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
