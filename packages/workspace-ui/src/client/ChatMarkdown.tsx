import { useEffect, useMemo, useState, type ReactNode } from "react";
import type Prism from "prismjs";
import type { Token } from "prismjs";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

function renderTokens(value: string | Token | (string | Token)[]): ReactNode {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let offset = 0;
    return value.map((token) => {
      const start = offset;
      offset += token.length;
      return <span key={start}>{renderTokens(token)}</span>;
    });
  }
  return (
    <span className={`token ${value.type}`}>{renderTokens(value.content)}</span>
  );
}

function HighlightedCode({
  content,
  className,
}: {
  content: string;
  className: string | undefined;
}) {
  const [prism, setPrism] = useState<typeof Prism | null>(null);
  useEffect(() => {
    let active = true;
    void import("prismjs")
      .then((module) => {
        if (active) setPrism(module.default);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const highlighted = useMemo(() => {
    const language = className?.match(/language-([\w-]+)/)?.[1];
    const grammar = language ? prism?.languages[language] : undefined;
    if (!grammar || content.length > 64_000) return content;
    try {
      return prism ? renderTokens(prism.tokenize(content, grammar)) : content;
    } catch {
      return content;
    }
  }, [content, className, prism]);
  return <code className={className}>{highlighted}</code>;
}

export function ChatMarkdown({
  content,
  onNavigateLink,
}: {
  content: string;
  onNavigateLink?: ((href: string) => void) | undefined;
}) {
  return (
    <div className="workspace-markdown chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          /^openlia:\/\//i.test(url) ? url : defaultUrlTransform(url)
        }
        components={{
          // No remote-image tracking or raw HTML in chat. Attachments are a later feature.
          img: ({ alt }) => <span>[Image: {alt || "attachment"}]</span>,
          a: ({ children, href }) => {
            if (href && /^openlia:\/\//i.test(href) && onNavigateLink) {
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigateLink(href);
                  }}
                  title="Open in Workspace UI"
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} rel="noopener noreferrer" target="_blank">
                {children}
              </a>
            );
          },
          code: ({ children, className }) =>
            typeof children === "string" ? (
              <HighlightedCode content={children} className={className} />
            ) : (
              <code>{children}</code>
            ),
          pre: ({ children }) => (
            <div className="chat-code-block">
              <div className="chat-code-toolbar">
                <span>Code</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={(event) => {
                    const code = event.currentTarget
                      .closest(".chat-code-block")
                      ?.querySelector("pre")?.textContent;
                    if (code)
                      void navigator.clipboard?.writeText(code).catch(() => {});
                  }}
                >
                  Copy code
                </button>
              </div>
              <pre>{children}</pre>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
