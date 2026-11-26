import { Renderer } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";
import "@openuidev/react-ui/index.css";
import type { ComponentProps } from "react";
import { isValidElement, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocumentScope } from "../../../shared/api";
import { openUIErrors } from "../../../shared/openui";
import { httpWorkspaceApi, type WorkspaceApi } from "../../api";
import { FrontmatterBlock } from "../../FrontmatterBlock";
import { parseMarkdownFrontmatter } from "../../frontmatter";
import { extractOriginalMessage } from "../../markdown";
import { resolveRelativePath } from "../../openliaLinks";
import { CHART_THEME } from "../../openui/charts/palette";
import { OpenLiaOpenUIProvider } from "../../openui/context";
import { normalizeOpenUIProgram, openliaLibrary } from "../../openui/library";
import { OpenUIDiagnostics } from "../../openui/OpenUIDiagnostics";
import { OpenUIErrorBoundary } from "../../openui/OpenUIErrorBoundary";

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

export function resolveWorkspaceImageSrc(
  src: string | undefined,
  currentFilePath: string | undefined,
  rawUrl?: ((path: string, scope?: DocumentScope) => string) | undefined,
  currentScope: DocumentScope = "workspace",
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
  let targetScope = currentScope;
  let cleanTarget: string;
  if (src.startsWith("openlia://")) {
    try {
      const uri = new URL(src);
      if (uri.host === "workspace") {
        targetScope = "workspace";
      } else if (uri.host === "skills" || uri.host === "skill") {
        targetScope = "skills";
      } else {
        return src;
      }
      cleanTarget = decodeURIComponent(uri.pathname.replace(/^\/+/, ""));
    } catch {
      return src;
    }
  } else if (src.startsWith("/files/")) {
    targetScope = "workspace";
    cleanTarget = src.replace(/^\/files\//, "");
  } else if (src.startsWith("/skills/")) {
    targetScope = "skills";
    cleanTarget = src.replace(/^\/skills\//, "");
  } else if (src.startsWith("./") || src.startsWith("../")) {
    cleanTarget = currentFilePath
      ? resolveRelativePath(src, currentFilePath)
      : src.replace(/^\.\//, "");
  } else if (!src.startsWith("/")) {
    cleanTarget = currentFilePath
      ? resolveRelativePath(src, currentFilePath)
      : src;
  } else {
    cleanTarget = src.replace(/^\/+/, "");
  }
  if (!cleanTarget) return src;
  return rawUrl
    ? rawUrl(cleanTarget, targetScope)
    : `/api/${targetScope}/raw?${new URLSearchParams({ path: cleanTarget })}`;
}

function InlineOpenUIBlock({
  api = httpWorkspaceApi,
  code,
  currentFilePath,
  onNavigateLink,
  scope = "workspace",
}: {
  api?: WorkspaceApi | undefined;
  code: string;
  currentFilePath?: string | undefined;
  onNavigateLink?: ((href: string) => void) | undefined;
  scope?: DocumentScope | undefined;
}) {
  const errors = useMemo(() => openUIErrors(code), [code]);
  const normalizedCode = useMemo(
    () => (errors.length ? "" : normalizeOpenUIProgram(code)),
    [code, errors.length],
  );
  const contextValue = useMemo(
    () => ({
      api,
      filePath: currentFilePath,
      onNavigateLink,
      scope,
    }),
    [api, currentFilePath, onNavigateLink, scope],
  );

  if (errors.length > 0) {
    return (
      <div className="my-4 overflow-hidden rounded-xl border border-warning/30 bg-base-200/40">
        <OpenUIDiagnostics content={code} variant="errors-only" />
        <pre className="m-0 overflow-x-auto p-3 text-xs">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <section
      aria-label="Inline OpenUI view"
      className="workspace-openui-surface my-4 min-w-0"
    >
      <ThemeProvider
        mode="dark"
        lightTheme={CHART_THEME}
        darkTheme={CHART_THEME}
      >
        <OpenLiaOpenUIProvider value={contextValue}>
          <OpenUIErrorBoundary source={code} uiPath={currentFilePath}>
            <Renderer
              library={openliaLibrary}
              response={normalizedCode}
              isStreaming={false}
              onAction={(event) => {
                if (
                  event.type === "open_url" &&
                  typeof event.params?.url === "string"
                ) {
                  const url = event.params.url;
                  if (
                    /^(?:openlia:\/\/(?:workspace|skills|agent)\/|\/files\/|\/skills\/|\/agent\/|\.\.?\/)/.test(
                      url,
                    )
                  )
                    onNavigateLink?.(url);
                }
              }}
            />
          </OpenUIErrorBoundary>
        </OpenLiaOpenUIProvider>
      </ThemeProvider>
    </section>
  );
}

export function MarkdownPreview({
  api = httpWorkspaceApi,
  content,
  currentFilePath,
  onNavigateLink,
  rawUrl,
  scope = "workspace",
}: {
  api?: WorkspaceApi | undefined;
  content: string;
  currentFilePath?: string | undefined;
  onNavigateLink?: ((href: string) => void) | undefined;
  rawUrl?: ((path: string, scope?: DocumentScope) => string) | undefined;
  scope?: DocumentScope | undefined;
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
      pre: ({ children, ...props }: ComponentProps<"pre">) => {
        if (
          isValidElement<{ className?: string }>(children) &&
          typeof children.props?.className === "string" &&
          /^language-openui(?:-lang)?$/i.test(children.props.className)
        ) {
          return <>{children}</>;
        }
        return <pre {...props}>{children}</pre>;
      },
      code: ({ className, children, ...props }: ComponentProps<"code">) => {
        if (
          typeof className === "string" &&
          /^language-openui(?:-lang)?$/i.test(className)
        ) {
          const rawCode = String(children ?? "").replace(/\n$/, "");
          return (
            <InlineOpenUIBlock
              api={api}
              code={rawCode}
              currentFilePath={currentFilePath}
              onNavigateLink={onNavigateLink}
              scope={scope}
            />
          );
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
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
      img: ({ src, alt, ...props }: ComponentProps<"img">) => {
        const resolvedSrc = resolveWorkspaceImageSrc(
          typeof src === "string" ? src : undefined,
          currentFilePath,
          rawUrl,
          scope,
        );
        return <img {...props} alt={alt ?? ""} src={resolvedSrc} />;
      },
      input: ({ checked, ...props }: ComponentProps<"input">) => (
        <input {...props} checked={checked} disabled type="checkbox" />
      ),
    };
  }, [api, currentFilePath, onNavigateLink, rawUrl, scope]);

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
