import type { ComponentProps } from "react";
import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FrontmatterBlock } from "../../FrontmatterBlock";
import { parseMarkdownFrontmatter } from "../../frontmatter";
import { extractOriginalMessage } from "../../markdown";

export function transformMarkdownUrl(url: string): string {
  if (
    url.startsWith("openlia://") ||
    url.startsWith("/") ||
    url.startsWith("./") ||
    url.startsWith("../")
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}

export function MarkdownPreview({
  content,
  currentFilePath: _currentFilePath,
  onNavigateLink,
}: {
  content: string;
  currentFilePath?: string | undefined;
  onNavigateLink?: ((href: string) => void) | undefined;
}) {
  const {
    frontmatter,
    rawYaml,
    body: markdownBody,
  } = useMemo(() => parseMarkdownFrontmatter(content), [content]);
  const { body, originalMessage } = useMemo(
    () => extractOriginalMessage(markdownBody),
    [markdownBody],
  );

  const customComponents = useMemo(() => {
    return {
      a: ({ children, href, onClick, ...props }: ComponentProps<"a">) => {
        const isRelative =
          href &&
          (href.startsWith("./") ||
            href.startsWith("../") ||
            (!href.includes("://") &&
              !href.startsWith("/") &&
              !href.startsWith("mailto:") &&
              !href.startsWith("#") &&
              href.endsWith(".md")));

        const isInternal =
          href &&
          (isRelative ||
            href.startsWith("openlia://") ||
            href.startsWith("/files/") ||
            href.startsWith("/skills/") ||
            ((href.startsWith("http://") || href.startsWith("https://")) &&
              (href.includes("/files/") || href.includes("/skills/"))));

        if (isInternal && onNavigateLink) {
          return (
            <a
              {...props}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                onClick?.(e);
                onNavigateLink(href);
              }}
              title={props.title || "Open in Workspace UI"}
            >
              {children}
            </a>
          );
        }

        return (
          <a
            {...props}
            href={href}
            onClick={onClick}
            rel="noreferrer noopener"
            target="_blank"
          >
            {children}
          </a>
        );
      },
      input: ({ checked, ...props }: ComponentProps<"input">) => (
        <input {...props} checked={checked} disabled type="checkbox" />
      ),
    };
  }, [onNavigateLink]);

  if (!content)
    return (
      <div className="grid h-full min-h-[22rem] place-items-center p-6 text-center text-sm italic text-base-content/50">
        Preview appears here when you select a document.
      </div>
    );

  return (
    <article aria-label="Markdown preview" className="workspace-markdown">
      {frontmatter && rawYaml && (
        <FrontmatterBlock data={frontmatter} rawYaml={rawYaml} />
      )}
      {body && (
        <ReactMarkdown
          components={customComponents}
          remarkPlugins={[remarkGfm]}
          urlTransform={transformMarkdownUrl}
        >
          {body}
        </ReactMarkdown>
      )}
      {originalMessage !== null && (
        <section
          aria-label="Original message"
          className="workspace-original-message"
        >
          <h2 className="workspace-original-message-heading">
            Original message
          </h2>
          <div className="workspace-original-message-content">
            <ReactMarkdown
              components={customComponents}
              remarkPlugins={[remarkGfm]}
              urlTransform={transformMarkdownUrl}
            >
              {originalMessage}
            </ReactMarkdown>
          </div>
        </section>
      )}
    </article>
  );
}
