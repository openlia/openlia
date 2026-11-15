import type { ComponentProps } from "react";
import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FrontmatterBlock } from "../../FrontmatterBlock";
import { parseMarkdownFrontmatter } from "../../frontmatter";
import { extractOriginalMessage } from "../../markdown";
import { resolveRelativePath } from "../../openliaLinks";

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

function resolveWorkspaceImageSrc(
  src: string | undefined,
  currentFilePath: string | undefined,
  rawUrl?: ((path: string) => string) | undefined,
): string | undefined {
  if (!src) return undefined;
  if (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:") ||
    src.startsWith("/api/")
  ) {
    return src;
  }
  const cleanTarget =
    src.startsWith("./") || src.startsWith("../")
      ? currentFilePath
        ? resolveRelativePath(src, currentFilePath)
        : src.replace(/^\.\//, "")
      : src.startsWith("/files/")
        ? src.replace(/^\/files\//, "")
        : !src.startsWith("/")
          ? currentFilePath
            ? resolveRelativePath(src, currentFilePath)
            : src
          : src.replace(/^\/+/, "");
  if (!cleanTarget) return src;
  return rawUrl
    ? rawUrl(cleanTarget)
    : `/api/workspace/raw?${new URLSearchParams({ path: cleanTarget })}`;
}

export function MarkdownPreview({
  content,
  currentFilePath,
  onNavigateLink,
  rawUrl,
}: {
  content: string;
  currentFilePath?: string | undefined;
  onNavigateLink?: ((href: string) => void) | undefined;
  rawUrl?: ((path: string) => string) | undefined;
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
              !href.startsWith("#")));

        const isInternal =
          href &&
          (isRelative ||
            href.startsWith("openlia://") ||
            href.startsWith("/files/") ||
            ((href.startsWith("http://") || href.startsWith("https://")) &&
              href.includes("/files/")));

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
      img: ({ src, alt, ...props }: ComponentProps<"img">) => {
        const resolvedSrc = resolveWorkspaceImageSrc(
          typeof src === "string" ? src : undefined,
          currentFilePath,
          rawUrl,
        );
        return <img {...props} alt={alt ?? ""} src={resolvedSrc} />;
      },
      input: ({ checked, ...props }: ComponentProps<"input">) => (
        <input {...props} checked={checked} disabled type="checkbox" />
      ),
    };
  }, [currentFilePath, onNavigateLink, rawUrl]);

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
