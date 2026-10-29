import { Renderer } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";
import "@openuidev/react-ui/index.css";
import type { ComponentProps } from "react";
import { isValidElement, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FrontmatterBlock } from "../../FrontmatterBlock";
import { parseMarkdownFrontmatter } from "../../frontmatter";
import { extractOriginalMessage } from "../../markdown";
import { CHART_THEME } from "../../openui/charts/palette";
import { OpenLiaOpenUIProvider, useOpenLiaOpenUI } from "../../openui/context";
import { normalizeOpenUIProgram, openliaLibrary } from "../../openui/library";
import { OpenUIDiagnostics } from "../../openui/OpenUIDiagnostics";
import { OpenUIErrorBoundary } from "../../openui/OpenUIErrorBoundary";
import { openUIErrors } from "../../../shared/openui";

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

function InlineOpenUIBlock({
  code,
  currentFilePath,
  onNavigateLink,
}: {
  code: string;
  currentFilePath?: string | undefined;
  onNavigateLink?: ((href: string) => void) | undefined;
}) {
  const parentContext = useOpenLiaOpenUI();

  const { normalized, hasErrors } = useMemo(() => {
    const errors = openUIErrors(code);
    return {
      normalized: errors.length ? "" : normalizeOpenUIProgram(code),
      hasErrors: errors.length > 0,
    };
  }, [code]);

  const inferredDomainPath = useMemo(() => {
    if (!currentFilePath) return undefined;
    const clean = currentFilePath.replace(/^\/+/, "");
    const slashIdx = clean.lastIndexOf("/");
    return slashIdx >= 0 ? clean.slice(0, slashIdx) : "";
  }, [currentFilePath]);

  const contextValue = useMemo(
    () => ({
      ...parentContext,
      domainPath: inferredDomainPath ?? parentContext.domainPath,
      filePath: currentFilePath,
      onOpenRecord: parentContext.onOpenRecord ?? onNavigateLink,
    }),
    [parentContext, inferredDomainPath, currentFilePath, onNavigateLink],
  );

  if (hasErrors) {
    return (
      <div
        className="my-4 rounded-xl border border-warning/30 bg-warning/5 overflow-hidden"
        data-testid="inline-openui-error"
      >
        <OpenUIDiagnostics content={code} />
        <pre className="m-0 border-t border-warning/20 bg-base-300/50 p-3 text-xs font-mono overflow-x-auto">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className="workspace-inline-openui my-4"
      data-testid="inline-openui-block"
    >
      <ThemeProvider
        mode="dark"
        darkTheme={CHART_THEME}
        cssSelector=".workspace-inline-openui"
      >
        <OpenLiaOpenUIProvider value={contextValue}>
          <OpenUIErrorBoundary
            key={normalized}
            source={code}
            uiPath={
              currentFilePath
                ? `${currentFilePath} (openui)`
                : "inline OpenUI block"
            }
          >
            <Renderer
              library={openliaLibrary}
              response={normalized}
              onAction={(event) => {
                if (event.type === "continue_conversation") {
                  const message =
                    typeof event.params.message === "string"
                      ? event.params.message
                      : event.humanFriendlyMessage;
                  if (message) contextValue.onSendChatPrompt?.(message);
                } else if (
                  event.type === "open_url" &&
                  typeof event.params.url === "string"
                ) {
                  const url = event.params.url;
                  if (
                    /^(?:openlia:\/\/(?:workspace|skills)\/|\/files\/|\.\.?\/)/.test(
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
    </div>
  );
}

export function MarkdownPreview({
  content,
  currentFilePath,
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
              code={rawCode}
              currentFilePath={currentFilePath}
              onNavigateLink={onNavigateLink}
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
  }, [currentFilePath, onNavigateLink]);

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
