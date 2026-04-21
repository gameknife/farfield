import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ExpandableToolBlockProps {
  title: string;
  summary: string;
  body: ReactNode;
  className?: string;
  defaultExpanded?: boolean;
  isActive?: boolean;
  durationMs?: number | null | undefined;
  statusTone?: "success" | "danger" | "neutral" | undefined;
}

function ExpandableToolBlockComponent({
  title,
  summary,
  body,
  className,
  defaultExpanded = false,
  isActive = false,
  durationMs,
  statusTone = "neutral",
}: ExpandableToolBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const previousIsActiveRef = useRef(isActive);

  useEffect(() => {
    if (isActive && !previousIsActiveRef.current) {
      setExpanded(true);
    }
    if (!isActive && previousIsActiveRef.current) {
      setExpanded(false);
    }
    previousIsActiveRef.current = isActive;
  }, [isActive]);

  return (
    <div
      className={`${className ?? ""} rounded-xl border border-border overflow-hidden text-sm`}
    >
      <Button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        variant="ghost"
        className="h-auto w-full grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-none bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted/70"
      >
        <div className="min-w-0 overflow-hidden">
          <div className="text-[10px] text-muted-foreground font-mono mb-1 uppercase tracking-wider">
            {title}
          </div>
          <div className="text-xs text-foreground/90 whitespace-pre-wrap break-words">
            {summary}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 self-start">
          {isActive ? (
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          ) : statusTone === "success" ? (
            <CheckCircle2 size={12} className="text-success" />
          ) : statusTone === "danger" ? (
            <XCircle size={12} className="text-danger" />
          ) : null}
          {durationMs != null && (
            <span className="text-[11px] text-muted-foreground/50 font-mono">
              {durationMs}ms
            </span>
          )}
          <ChevronRight
            size={12}
            className={`text-muted-foreground/60 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
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
            <div className="border-t border-border px-3 py-3">
              {body}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function areExpandableToolBlockPropsEqual(
  prev: ExpandableToolBlockProps,
  next: ExpandableToolBlockProps,
): boolean {
  return (
    prev.title === next.title &&
    prev.summary === next.summary &&
    prev.body === next.body &&
    prev.className === next.className &&
    prev.defaultExpanded === next.defaultExpanded &&
    prev.isActive === next.isActive &&
    prev.durationMs === next.durationMs &&
    prev.statusTone === next.statusTone
  );
}

export const ExpandableToolBlock = memo(
  ExpandableToolBlockComponent,
  areExpandableToolBlockPropsEqual,
);
