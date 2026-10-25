import { Renderer } from "@openuidev/react-lang";
import { Component, useCallback, useEffect, useState } from "react";
import type { WorkspaceApi } from "../api";
import type { WorkspaceDomainRecordsResponse } from "../../shared/api";
import { OpenLiaOpenUIProvider } from "./context";
import { openliaLibrary } from "./library";
import { mutateRecordFrontmatter } from "./recordMutator";
import { DEFAULT_DOMAIN_OPENUI, synthesizeDomainOpenUI } from "./synthesizer";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: (error: Error, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class OpenUIErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  override render() {
    if (this.state.hasError && this.state.error) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}

export function DomainDashboardPane({
  domainPath,
  api,
  onOpenFile,
  onCreateFile,
  onNavigate,
}: {
  domainPath: string;
  api: WorkspaceApi;
  onOpenFile: (path: string) => void;
  onCreateFile?: ((domain?: string) => void) | undefined;
  onNavigate?: ((url: string) => void) | undefined;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] =
    useState<WorkspaceDomainRecordsResponse | null>(null);
  const [openuiContent, setOpenuiContent] = useState<string>("");
  const [isCustomOpenUI, setIsCustomOpenUI] = useState(false);
  const [useFallbackUI, setUseFallbackUI] = useState(false);
  const [fixingDomain, setFixingDomain] = useState(false);
  const [openuiError, setOpenuiError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setOpenuiError(null);
    try {
      const data = await api.loadDomainOverview(domainPath);
      setOverview(data);

      let customContent: string | null = null;
      if (data.domain.dashboard_openui_path) {
        try {
          const fileRes = await api.loadFile(data.domain.dashboard_openui_path);
          if (fileRes.content && fileRes.content.trim()) {
            customContent = fileRes.content;
            setIsCustomOpenUI(true);
          }
        } catch {}
      }

      if (customContent) {
        setOpenuiContent(customContent);
      } else {
        const defaultUI =
          DEFAULT_DOMAIN_OPENUI[domainPath]?.dashboardOpenUI ??
          synthesizeDomainOpenUI(
            domainPath,
            data.domain,
            data.schema_json,
            data.template_headings,
          ).dashboardOpenUI;
        setOpenuiContent(defaultUI);
        setIsCustomOpenUI(false);
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load domain dashboard data.",
      );
    } finally {
      setLoading(false);
    }
  }, [api, domainPath]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleFixDomainTemplate = async () => {
    setFixingDomain(true);
    try {
      const res = await api.fixDomainTemplateIssues(domainPath);
      if (res.migration_id) {
        if (onNavigate) {
          onNavigate(`/migration/${encodeURIComponent(res.migration_id)}`);
        } else if (typeof window !== "undefined") {
          window.location.href = `/migration/${encodeURIComponent(res.migration_id)}`;
        }
      } else {
        void loadData();
      }
    } catch (err: unknown) {
      alert(
        err instanceof Error ? err.message : "Failed to fix domain template",
      );
    } finally {
      setFixingDomain(false);
    }
  };

  const handleUpdateRecordFrontmatter = async (
    recordPath: string,
    updates: Record<string, unknown>,
  ) => {
    try {
      const currentDoc = await api.loadFile(recordPath);
      const updatedMarkdown = mutateRecordFrontmatter(
        currentDoc.content,
        updates,
      );
      await api.saveFile(recordPath, updatedMarkdown, currentDoc.revision);
      void loadData();
    } catch (err: unknown) {
      console.error("Failed to update frontmatter:", err);
      throw err;
    }
  };

  if (loading) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center p-6">
        <span className="loading loading-spinner loading-md text-primary" />
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="flex h-full min-h-[300px] flex-col items-center justify-center p-6 text-center">
        <p className="text-sm text-error mb-3">
          {error ?? "Domain overview unavailable."}
        </p>
        <button
          className="btn btn-outline btn-sm"
          onClick={() => void loadData()}
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }

  const invalidCount = overview.domain.invalid_record_count ?? 0;
  const effectiveOpenUI = useFallbackUI
    ? synthesizeDomainOpenUI(
        domainPath,
        overview.domain,
        overview.schema_json,
        overview.template_headings,
      ).dashboardOpenUI
    : openuiContent;

  return (
    <OpenLiaOpenUIProvider
      value={{
        domainInfo: overview.domain,
        loadFile: api.loadFile,
        domainPath,
        onCreateRecord: (targetDomain) =>
          onCreateFile?.(targetDomain ?? domainPath),
        onEditOpenUI: (openuiPath) => {
          const target =
            openuiPath ??
            overview.domain.dashboard_openui_path ??
            `${domainPath}/${domainPath.split("/").pop()}-dashboard.openui`;
          onOpenFile(target);
        },
        onOpenRecord: (path) => onOpenFile(path),
        onUpdateRecordFrontmatter: handleUpdateRecordFrontmatter,
        records: overview.records,
        schemaJson: overview.schema_json,
        templateHeadings: overview.template_headings,
      }}
    >
      <div className="flex flex-col gap-4 p-6 max-w-7xl mx-auto w-full">
        {/* Domain Contract Drift Banner */}
        {invalidCount > 0 && (
          <div
            aria-live="polite"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-warning-content shadow-xs"
          >
            <div className="flex items-center gap-3">
              <span className="text-lg">⚠️</span>
              <div>
                <span className="font-semibold text-sm">
                  {invalidCount} {invalidCount === 1 ? "record" : "records"} in{" "}
                  <code className="font-mono text-xs font-bold">
                    {domainPath}
                  </code>{" "}
                  do not match the updated template or schema.
                </span>
                <p className="text-xs text-base-content/70 mt-0.5">
                  Update missing sections and backfill default properties via a
                  Git-backed migration revision.
                </p>
              </div>
            </div>
            <button
              className="btn btn-warning btn-sm font-medium"
              disabled={fixingDomain}
              onClick={handleFixDomainTemplate}
              type="button"
            >
              {fixingDomain
                ? "Creating Migration..."
                : `Fix All ${invalidCount} in Migrations`}
            </button>
          </div>
        )}

        {/* Fallback diagnostic toggle */}
        {isCustomOpenUI && useFallbackUI && (
          <div className="flex items-center justify-between rounded-lg border border-info/30 bg-info/5 px-4 py-2 text-xs">
            <span>
              Viewing default dashboard. Custom{" "}
              <code className="font-mono font-medium">
                {overview.domain.dashboard_openui_path}
              </code>{" "}
              is bypassed.
            </span>
            <button
              className="btn btn-ghost btn-xs text-primary underline"
              onClick={() => setUseFallbackUI(false)}
              type="button"
            >
              Restore Custom View
            </button>
          </div>
        )}

        {/* OpenUI parse or runtime error banner */}
        {openuiError && !useFallbackUI && (
          <div className="flex flex-col gap-3 rounded-xl border border-error/30 bg-error/5 p-5 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-error text-sm">
                OpenUI Render Error ({openuiError})
              </span>
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-neutral btn-xs"
                  onClick={() => {
                    setUseFallbackUI(true);
                    setOpenuiError(null);
                  }}
                  type="button"
                >
                  Use Default View
                </button>
                {overview.domain.dashboard_openui_path && (
                  <button
                    className="btn btn-outline btn-xs"
                    onClick={() =>
                      onOpenFile(overview.domain.dashboard_openui_path!)
                    }
                    type="button"
                  >
                    Edit .openui
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* OpenUI Renderer wrapped with Error Boundary */}
        <OpenUIErrorBoundary
          fallback={(err, reset) => (
            <div className="flex flex-col gap-3 rounded-xl border border-error/30 bg-error/5 p-5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-error text-sm">
                  Failed to render domain dashboard ({err.message})
                </span>
                <div className="flex items-center gap-2">
                  <button
                    className="btn btn-neutral btn-xs"
                    onClick={() => {
                      setUseFallbackUI(true);
                      reset();
                    }}
                    type="button"
                  >
                    Use Default View
                  </button>
                  {overview.domain.dashboard_openui_path && (
                    <button
                      className="btn btn-outline btn-xs"
                      onClick={() =>
                        onOpenFile(overview.domain.dashboard_openui_path!)
                      }
                      type="button"
                    >
                      Edit .openui
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        >
          {(!openuiError || useFallbackUI) && (
            <div className="openui-dashboard-container">
              <Renderer
                library={openliaLibrary}
                onError={(errs: unknown) => {
                  if (Array.isArray(errs) && errs.length > 0) {
                    const first = errs[0];
                    setOpenuiError(
                      typeof first === "object" && first && "message" in first
                        ? String((first as { message: unknown }).message)
                        : "Invalid OpenUI Lang response",
                    );
                  } else if (errs instanceof Error) {
                    setOpenuiError(errs.message);
                  }
                }}
                response={effectiveOpenUI}
              />
            </div>
          )}
        </OpenUIErrorBoundary>
      </div>
    </OpenLiaOpenUIProvider>
  );
}
