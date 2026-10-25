import { Renderer } from "@openuidev/react-lang";
import { Component, useEffect, useRef, useState } from "react";
import type { WorkspaceApi } from "../api";
import type { WorkspaceDomainRecordsResponse } from "../../shared/api";
import { OpenLiaOpenUIProvider } from "./context";
import { openliaLibrary } from "./library";
import {
  addRecordChecklistItem,
  mutateRecordFrontmatter,
  toggleRecordChecklistItem,
  updateRecordSectionContent,
} from "./recordMutator";
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

export function RecordOpenUIPane({
  path,
  content,
  api,
  onSaveContent,
  onOpenFile,
}: {
  path: string;
  content: string;
  api: WorkspaceApi;
  onSaveContent?: ((newContent: string) => Promise<void> | void) | undefined;
  onOpenFile: (path: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [domainOverview, setDomainOverview] =
    useState<WorkspaceDomainRecordsResponse | null>(null);
  const [openuiContent, setOpenuiContent] = useState<string>("");
  const [isCustomOpenUI, setIsCustomOpenUI] = useState(false);
  const [useFallbackUI, setUseFallbackUI] = useState(false);
  const [openuiError, setOpenuiError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const latestContent = useRef(content);
  const currentPath = useRef(path);
  currentPath.current = path;
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    latestContent.current = content;
  }, [content]);

  const saveMutation = (mutate: (value: string) => string) => {
    const targetPath = path;
    const operation = saveQueue.current
      .catch(() => {})
      .then(async () => {
        if (currentPath.current !== targetPath || !onSaveContent) return;
        setSaveError(null);
        try {
          const nextContent = mutate(latestContent.current);
          await onSaveContent(nextContent);
          if (currentPath.current === targetPath)
            latestContent.current = nextContent;
        } catch (error) {
          if (currentPath.current === targetPath)
            setSaveError(
              error instanceof Error ? error.message : "Save failed",
            );
          throw error;
        }
      });
    saveQueue.current = operation;
    return operation;
  };

  const domainParts = path.split("/").slice(0, -1);
  const domainPath = domainParts.join("/");

  useEffect(() => {
    let active = true;
    setUseFallbackUI(false);
    setOpenuiError(null);
    setSaveError(null);
    setDomainOverview(null);
    const loadOpenUI = async () => {
      setLoading(true);
      try {
        let overview: WorkspaceDomainRecordsResponse | null = null;
        if (domainPath) {
          try {
            overview = await api.loadDomainOverview(domainPath);
            if (active) setDomainOverview(overview);
          } catch {}
        }

        let customContent: string | null = null;
        const recordOpenUIPath =
          overview?.domain?.record_openui_path ??
          (domainPath
            ? `${domainPath}/${domainPath.split("/").pop()}-record.openui`
            : null);

        if (recordOpenUIPath) {
          try {
            const fileRes = await api.loadFile(recordOpenUIPath);
            if (fileRes.content && fileRes.content.trim()) {
              customContent = fileRes.content;
              if (active) setIsCustomOpenUI(true);
            }
          } catch {}
        }

        if (active) {
          if (customContent) {
            setOpenuiContent(customContent);
          } else {
            const defaultUI =
              DEFAULT_DOMAIN_OPENUI[domainPath]?.recordOpenUI ??
              synthesizeDomainOpenUI(
                domainPath,
                overview?.domain,
                overview?.schema_json,
                overview?.template_headings,
              ).recordOpenUI;
            setOpenuiContent(defaultUI);
            setIsCustomOpenUI(false);
          }
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadOpenUI();
    return () => {
      active = false;
    };
  }, [api, domainPath]);

  const handleUpdateRecordFrontmatter = async (
    _recordPath: string,
    updates: Record<string, unknown>,
  ) => {
    await saveMutation((value) => mutateRecordFrontmatter(value, updates));
  };

  const handleToggleChecklistItem = async (
    _recordPath: string,
    heading: string | undefined,
    itemIndex: number,
    checked?: boolean,
  ) => {
    await saveMutation((value) =>
      toggleRecordChecklistItem(value, heading, itemIndex, checked),
    );
  };

  const handleAddChecklistItem = async (
    _recordPath: string,
    heading: string,
    itemText: string,
  ) => {
    await saveMutation((value) =>
      addRecordChecklistItem(value, heading, itemText),
    );
  };

  const handleUpdateSectionContent = async (
    _recordPath: string,
    heading: string,
    markdownContent: string,
  ) => {
    await saveMutation((value) =>
      updateRecordSectionContent(value, heading, markdownContent),
    );
  };

  if (loading) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center p-6">
        <span className="loading loading-spinner loading-md text-primary" />
      </div>
    );
  }

  const effectiveOpenUI = useFallbackUI
    ? synthesizeDomainOpenUI(
        domainPath,
        domainOverview?.domain,
        domainOverview?.schema_json,
        domainOverview?.template_headings,
      ).recordOpenUI
    : openuiContent;

  const recordOpenUIPath =
    domainOverview?.domain?.record_openui_path ??
    (domainPath
      ? `${domainPath}/${domainPath.split("/").pop()}-record.openui`
      : undefined);

  return (
    <OpenLiaOpenUIProvider
      value={{
        currentRecordContent: content,
        loadFile: api.loadFile,
        financeApi: api,
        currentRecordPath: path,
        domainInfo: domainOverview?.domain,
        domainPath,
        onAddChecklistItem: onSaveContent ? handleAddChecklistItem : undefined,
        onEditOpenUI: (openuiPath) => {
          const target = openuiPath ?? recordOpenUIPath;
          if (target) onOpenFile(target);
        },
        onOpenRecord: (targetPath) => onOpenFile(targetPath),
        onToggleChecklistItem: onSaveContent
          ? handleToggleChecklistItem
          : undefined,
        onUpdateRecordFrontmatter: onSaveContent
          ? handleUpdateRecordFrontmatter
          : undefined,
        onUpdateSectionContent: onSaveContent
          ? handleUpdateSectionContent
          : undefined,
        schemaJson: domainOverview?.schema_json,
        templateHeadings: domainOverview?.template_headings,
      }}
    >
      <div className="flex flex-col gap-4 p-6 max-w-5xl mx-auto w-full">
        {isCustomOpenUI && useFallbackUI && (
          <div className="flex items-center justify-between rounded-lg border border-info/30 bg-info/5 px-4 py-2 text-xs">
            <span>
              Viewing default layout. Custom{" "}
              <code className="font-mono font-medium">{recordOpenUIPath}</code>{" "}
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

        {saveError && (
          <p
            role="alert"
            className="rounded-lg border border-error p-3 text-error"
          >
            Could not save record: {saveError}
          </p>
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
                {recordOpenUIPath && (
                  <button
                    className="btn btn-outline btn-xs"
                    onClick={() => onOpenFile(recordOpenUIPath)}
                    type="button"
                  >
                    Edit .openui
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <OpenUIErrorBoundary
          fallback={(err, reset) => (
            <div className="flex flex-col gap-3 rounded-xl border border-error/30 bg-error/5 p-5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-error text-sm">
                  Failed to render visual record view ({err.message})
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
                  {recordOpenUIPath && (
                    <button
                      className="btn btn-outline btn-xs"
                      onClick={() => onOpenFile(recordOpenUIPath)}
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
            <div className="openui-record-container">
              <Renderer
                key={path}
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
