import { useId, useState } from "react";

export interface FrontmatterBlockProps {
  data: Record<string, unknown>;
  rawYaml: string;
}

export function FrontmatterBlock({ data, rawYaml }: FrontmatterBlockProps) {
  const [viewMode, setViewMode] = useState<"structured" | "yaml">("structured");
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutId = useId();

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
    : [];

  const platforms = Array.isArray(data.platforms)
    ? (data.platforms.filter(
        (p): p is string => typeof p === "string",
      ) as string[])
    : [];

  const standardKeys = new Set([
    "name",
    "version",
    "author",
    "license",
    "description",
    "tags",
    "platforms",
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
      platforms.length > 0,
  );

  return (
    <div className="not-prose mb-4 overflow-hidden rounded-xl border border-base-content/15 bg-base-200/50 shadow-xs sm:mb-6">
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
              {copied ? <span>Copied!</span> : <span>Copy</span>}
            </button>
          )}
        </div>
      </div>

      {!isCollapsed && (
        <div className="p-2.5 text-xs sm:p-4">
          {viewMode === "structured" ? (
            <div className="space-y-2.5 sm:space-y-3">
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
                    <span className="text-base-content/60">by {author}</span>
                  )}
                  {license && (
                    <span className="badge badge-ghost badge-sm">
                      {license}
                    </span>
                  )}
                </div>
              )}

              {description && (
                <p className="text-base-content/85 leading-relaxed">
                  {description}
                </p>
              )}

              {tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
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
              <code className="language-yaml">{rawYaml}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
