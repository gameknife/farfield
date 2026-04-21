import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeSnippet } from "./CodeSnippet";
import { openExternalUrl } from "@/lib/native-shell";

interface MarkdownTextProps {
  text: string;
}

function detectLanguage(className: string | undefined): string {
  if (!className) return "text";
  const prefix = "language-";
  if (!className.startsWith(prefix)) return "text";
  const name = className.slice(prefix.length).trim();
  return name.length > 0 ? name : "text";
}

const baseComponents: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const code = String(children ?? "");
    const isBlock =
      code.includes("\n") || (className?.startsWith("language-") ?? false);

    if (!isBlock) {
      return (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
          {code}
        </code>
      );
    }

    return (
      <CodeSnippet
        code={code.replace(/\n$/, "")}
        language={detectLanguage(className)}
      />
    );
  },
  img: ({ src, alt }) => {
    if (!src) {
      return null;
    }

    return (
      <img
        src={src}
        alt={alt ?? ""}
        className="my-3 max-h-[28rem] w-auto max-w-full rounded-xl border border-border bg-muted/20 object-contain shadow-sm"
      />
    );
  },
};

function MarkdownTextComponent({ text }: MarkdownTextProps) {
  const components: Components = {
    ...baseComponents,
    a: ({ href, children }) => {
      if (!href) {
        return <span>{children}</span>;
      }

      const isExternalLink =
        href.startsWith("http://") ||
        href.startsWith("https://") ||
        href.startsWith("mailto:");

      return (
        <a
          href={href}
          className="text-sky-600 underline decoration-sky-500/70 underline-offset-4 transition-colors hover:text-sky-500 dark:text-sky-400 dark:decoration-sky-400/70 dark:hover:text-sky-300"
          target={isExternalLink ? "_blank" : undefined}
          rel={isExternalLink ? "noopener noreferrer" : undefined}
          onClick={(event) => {
            if (!isExternalLink) {
              return;
            }
            event.preventDefault();
            void openExternalUrl(href);
          }}
        >
          {children}
        </a>
      );
    },
  };

  return (
    <div className="markdown-content text-sm leading-relaxed text-foreground break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownText = memo(MarkdownTextComponent);
