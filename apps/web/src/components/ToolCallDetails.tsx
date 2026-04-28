import { CodeSnippet } from "./CodeSnippet";

interface ToolCallDetailsProps {
  children: React.ReactNode;
}

interface ToolCallDetailRowsProps {
  rows: { label: string; value: string }[];
}

interface ToolCallDetailCodeProps {
  label: string;
  code: string;
  language: string;
  className?: string;
}

interface ToolCallDetailTextProps {
  children: React.ReactNode;
  tone?: "muted" | "danger";
}

export function ToolCallDetails({ children }: ToolCallDetailsProps) {
  return <div className="space-y-2 pb-1">{children}</div>;
}

export function ToolCallDetailRows({ rows }: ToolCallDetailRowsProps) {
  if (rows.length === 0) return null;

  return (
    <div className="grid gap-1 text-xs leading-5">
      {rows.map((row) => (
        <div
          key={`${row.label}:${row.value}`}
          className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3"
        >
          <div className="text-muted-foreground/55">{row.label}</div>
          <div className="min-w-0 text-foreground/75 whitespace-pre-wrap break-words">
            {row.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ToolCallDetailCode({
  label,
  code,
  language,
  className,
}: ToolCallDetailCodeProps) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/55">
        {label}
      </div>
      {className === undefined ? (
        <CodeSnippet code={code} language={language} />
      ) : (
        <CodeSnippet code={code} language={language} className={className} />
      )}
    </div>
  );
}

export function ToolCallDetailText({
  children,
  tone = "muted",
}: ToolCallDetailTextProps) {
  return (
    <div
      className={`text-xs whitespace-pre-wrap break-words ${
        tone === "danger" ? "text-danger" : "text-muted-foreground"
      }`}
    >
      {children}
    </div>
  );
}
