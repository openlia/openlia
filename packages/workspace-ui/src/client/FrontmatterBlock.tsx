import { useEffect, useId, useState } from "react";

export interface FrontmatterBlockProps {
  data: Record<string, unknown>;
  rawYaml: string;
}

export function FrontmatterBlock({ data, rawYaml }: FrontmatterBlockProps) {
  const [viewMode, setViewMode] = useState<"structured" | "yaml">("structured");
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutId = useId();

  const [highlightedYaml, setHighlightedYaml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setHighlightedYaml(null);
    void import("prismjs")
      .then(async (prismModule) => {
        const Prism = prismModule.default;
        (globalThis as { Prism?: typeof Prism }).Prism = Prism;
        await import("prismjs/components/prism-yaml");
        if (!active) return;
        try {
          setHighlightedYaml(
            Prism.highlight(
              rawYaml,
              Prism.languages.yaml || Prism.languages.extend("clike", {}),
              "yaml",
            ),
          );
        } catch {
          setHighlightedYaml(null);
        }
      })
      .catch(() => {
        if (active) setHighlightedYaml(null);
      });
    return () => {
      active = false;
    };
  }, [rawYaml]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawYaml);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const name = typeof data.name === "string" ? data.name : undefined;
  const version = typeof data.version === "string" ? data.version : undefined;
  const author = typeof data.author === "string" ? data.author : undefined;
  const license = typeof data.license === "string" ? data.license : undefined;
  const description =
    typeof data.description === "string" ? data.description : undefined;

  const tags = Array.isArray(data.tags)
    ? (data.tags.filter((t): t is string => typeof t === "string") as string[])
    : Array.isArray(
          (data.metadata as Record<string, unknown> | undefined)?.hermes &&
            (
              (data.metadata as Record<string, unknown>).hermes as Record<
                string,
                unknown
              >
            )?.tags,
        )
      ? ((
          (data.metadata as Record<string, unknown>).hermes as Record<
            string,
            unknown
          >
        ).tags as string[])
      : [];

  const platforms = Array.isArray(data.platforms)
    ? (data.platforms.filter(
        (p): p is string => typeof p === "string",
      ) as string[])
    : [];

  const prerequisites =
    data.prerequisites && typeof data.prerequisites === "object"
      ? (data.prerequisites as Record<string, unknown>)
      : undefined;

  const envVars = Array.isArray(prerequisites?.env_vars)
    ? (prerequisites?.env_vars as string[])
    : [];
  const credentialFiles = Array.isArray(prerequisites?.credential_files)
    ? (prerequisites?.credential_files as string[])
    : [];

  // Custom extra keys
  const standardKeys = new Set([
    "name",
    "version",
    "author",
    "license",
    "description",
    "tags",
    "platforms",
    "prerequisites",
    "metadata",
  ]);

  const extraEntries = Object.entries(data).filter(
    ([k]) => !standardKeys.has(k),
  );
  const hasStandardMetadata = Boolean(
    name ||
      version ||
      author ||
      license ||
      description ||
      tags.length > 0 ||
      platforms.length > 0 ||
      envVars.length > 0 ||
      credentialFiles.length > 0,
  );

  return (
    <div className="not-prose mb-4 overflow-hidden rounded-xl border border-base-content/15 bg-base-200/50 shadow-xs sm:mb-6">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/10 bg-base-300/40 px-3.5 py-2">
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 text-left text-xs font-bold uppercase tracking-wider text-base-content/70 hover:text-base-content"
            onClick={() => setIsCollapsed(!isCollapsed)}
            type="button"
          >
            <svg
              className={`h-3.5 w-3.5 transition-transform duration-200 ${
                isCollapsed ? "-rotate-90" : ""
              }`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <title>
                {isCollapsed ? "Expand metadata" : "Collapse metadata"}
              </title>
              <path
                d="m19 9-7 7-7-7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>Metadata</span>
            <span className="badge badge-neutral badge-xs font-mono font-normal">
              {Object.keys(data).length} keys
            </span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="join">
            <button
              className={`btn join-item btn-xs ${
                viewMode === "structured"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => setViewMode("structured")}
              type="button"
            >
              Structured
            </button>
            <button
              className={`btn join-item btn-xs ${
                viewMode === "yaml"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => setViewMode("yaml")}
              type="button"
            >
              YAML
            </button>
          </div>

          {viewMode === "yaml" && (
            <button
              className="btn btn-ghost btn-xs gap-1"
              id={copyTimeoutId}
              onClick={handleCopy}
              type="button"
            >
              {copied ? (
                <>
                  <svg
                    className="h-3 w-3 text-success"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <title>Copied</title>
                    <path
                      d="M5 13l4 4L19 7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <title>Copy YAML</title>
                    <path
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>Copy</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Body content */}
      {!isCollapsed && (
        <div className="p-2.5 text-xs sm:p-4">
          {viewMode === "structured" ? (
            <div className="space-y-2.5 sm:space-y-3">
              {/* Primary metadata row */}
              {(name || version || author || license) && (
                <div className="flex flex-wrap items-center gap-2">
                  {name && (
                    <span className="font-semibold text-base text-base-content">
                      {name}
                    </span>
                  )}
                  {version && (
                    <span className="badge badge-outline badge-sm font-mono">
                      v{version}
                    </span>
                  )}
                  {author && (
                    <span className="badge badge-ghost badge-sm">
                      by {author}
                    </span>
                  )}
                  {license && (
                    <span className="badge badge-ghost badge-sm uppercase">
                      {license}
                    </span>
                  )}
                </div>
              )}

              {description && (
                <p className="text-base-content/80 text-sm leading-relaxed">
                  {description}
                </p>
              )}

              {/* Tags */}
              {tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[11px] font-medium text-base-content/50 mr-1">
                    Tags:
                  </span>
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="badge badge-secondary badge-sm text-[10px]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Platforms */}
              {platforms.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-base-content/50 mr-1">
                    Platforms:
                  </span>
                  {platforms.map((p) => (
                    <span
                      key={p}
                      className="badge badge-outline badge-xs capitalize"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              )}

              {/* Prerequisites */}
              {(envVars.length > 0 || credentialFiles.length > 0) && (
                <div className="rounded-lg border border-base-content/10 bg-base-100/60 p-2.5 space-y-2 mt-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/60">
                    Prerequisites
                  </span>
                  {envVars.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-base-content/50">
                        Env Vars:
                      </span>
                      {envVars.map((v) => (
                        <code
                          key={v}
                          className="badge badge-outline font-mono text-[10px]"
                        >
                          {v}
                        </code>
                      ))}
                    </div>
                  )}
                  {credentialFiles.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-base-content/50">
                        Files:
                      </span>
                      {credentialFiles.map((f) => (
                        <code
                          key={f}
                          className="badge badge-outline font-mono text-[10px]"
                        >
                          {f}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Custom Extra Key/Value Pairs */}
              {extraEntries.length > 0 && (
                <div
                  className={
                    hasStandardMetadata
                      ? "mt-3 border-t border-base-content/10 pt-2.5"
                      : ""
                  }
                >
                  <dl className="grid grid-cols-2 gap-1.5 sm:gap-2">
                    {extraEntries.map(([key, val]) => {
                      const strVal =
                        typeof val === "object"
                          ? JSON.stringify(val)
                          : String(val);
                      const isWide = strVal.length > 26;
                      return (
                        <div
                          key={key}
                          className={`rounded border border-base-content/5 bg-base-100/40 px-2.5 py-1.5 sm:p-2 ${
                            isWide ? "col-span-2 sm:col-span-1" : ""
                          }`}
                        >
                          <dt className="truncate font-mono text-[10px] font-semibold text-base-content/60 sm:text-[11px]">
                            {key}
                          </dt>
                          <dd className="mt-0.5 truncate font-mono text-xs text-base-content">
                            {strVal}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              )}
            </div>
          ) : (
            <pre className="overflow-x-auto rounded-lg bg-base-300/60 p-3.5 font-mono text-xs leading-relaxed">
              {highlightedYaml === null ? (
                <code className="language-yaml">{rawYaml}</code>
              ) : (
                <code
                  className="language-yaml"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: syntax highlighting HTML produced safely by Prism.js
                  dangerouslySetInnerHTML={{ __html: highlightedYaml }}
                />
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
