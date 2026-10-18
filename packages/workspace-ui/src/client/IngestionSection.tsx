import { type DragEvent, useCallback, useEffect, useState } from "react";
import type {
  IngestionDetailResponse,
  IngestionListItem,
  IngestionOverviewResponse,
  SourceDocument,
  SourceSearchResponse,
} from "../shared/api";
import type { WorkspaceApi } from "./api";
import { DocumentCard } from "./ingestion/DocumentCard";
import {
  DocumentFilterBar,
  type IngestionScope,
  type ReviewFilter,
} from "./ingestion/DocumentFilterBar";
import { DocumentInspector } from "./ingestion/DocumentInspector";
import { PasswordManagerModal } from "./ingestion/PasswordManagerModal";
import { UploadModal } from "./ingestion/UploadModal";

export interface IngestionSectionProps {
  api: WorkspaceApi;
  overview: IngestionOverviewResponse | null;
  detail: IngestionDetailResponse | null;
  detailLoading: boolean;
  loading: boolean;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onSelect: (intakeId: string | undefined) => void;
  rawUrl: (path: string) => string;
}

function formatTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "Not recorded";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatRelative(value: string | number): string {
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return String(value);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function statusClass(status: string): string {
  if (["complete", "completed"].includes(status)) return "badge-success";
  if (["failed", "awaiting-unlock", "waiting-for-password"].includes(status))
    return "badge-error";
  if (["partial", "retryable-failure"].includes(status)) return "badge-warning";
  if (["processing", "running", "queued"].includes(status)) return "badge-info";
  return "badge-ghost";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge badge-sm ${statusClass(status)}`}>{status}</span>
  );
}

function Stage({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-base-content/10 bg-base-200/40 p-3">
      <p className="text-[10px] uppercase tracking-wider text-base-content/50">
        {label}
      </p>
      <p className="mt-1 break-words text-sm font-semibold">{value}</p>
    </div>
  );
}

function ItemRow({
  item,
  selected,
  onSelect,
}: {
  item: IngestionListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`w-full border-b border-base-content/10 p-4 text-left transition-colors last:border-b-0 hover:bg-base-200/70 ${selected ? "bg-primary/10" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{item.source_title}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-base-content/55">
            {item.intake_id}
          </p>
        </div>
        <StatusBadge status={item.status} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-base-content/60">
        <span>
          {item.kind} / {item.operation}
        </span>
        <span>{formatRelative(item.captured_at)}</span>
      </div>
      {item.job && (
        <p className="mt-2 text-[11px] text-info">
          Worker: {item.job.state} · attempt {item.job.attempts}
        </p>
      )}
    </button>
  );
}

function DetailPane({
  detail,
  onOpenFile,
  rawUrl,
}: {
  detail: IngestionDetailResponse;
  onOpenFile: (path: string) => void;
  rawUrl: (path: string) => string;
}) {
  const { intake } = detail;
  return (
    <section
      className="min-w-0 flex-1 overflow-y-auto bg-base-100 p-5 sm:p-7"
      aria-label="Ingestion details"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="workspace-eyebrow">INGESTION / DETAIL</p>
          <h3 className="mt-1 truncate text-xl font-bold">
            {intake.source_title}
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-base-content/55">
            {intake.intake_id}
          </p>
        </div>
        <StatusBadge status={intake.status} />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Stage label="Worker" value={intake.job?.state ?? "No live job"} />
        <Stage
          label="Callback"
          value={
            intake.callback.delivery_state ??
            intake.callback.durable_status ??
            "Not emitted"
          }
        />
        <Stage
          label="Follow-up"
          value={intake.action?.status ?? "Not started"}
        />
      </div>

      {intake.job?.error_summary && (
        <div className="alert alert-error mt-5 text-sm" role="alert">
          <span>
            {intake.job.error_code ? `${intake.job.error_code}: ` : ""}
            {intake.job.error_summary}
          </span>
        </div>
      )}

      <div className="mt-6">
        <h4 className="text-sm font-semibold">Published Artifacts</h4>
        {detail.artifacts.length > 0 ? (
          <div className="mt-3 divide-y divide-base-content/10 rounded-lg border border-base-content/10">
            {detail.artifacts.map((artifact) => (
              <div
                key={artifact.path}
                className="flex items-center justify-between p-3 text-xs"
              >
                <div className="min-w-0 flex-1 truncate pr-3">
                  <span className="font-mono">{artifact.path}</span>
                  <span className="ml-2 text-base-content/50">
                    ({artifact.role})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={rawUrl(artifact.path)}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-ghost btn-xs"
                  >
                    Raw
                  </a>
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    onClick={() => onOpenFile(artifact.path)}
                  >
                    Open
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-base-content/50">
            No artifacts published for this intake yet.
          </p>
        )}
      </div>

      <div className="mt-6 border-t border-base-content/10 pt-4 text-xs text-base-content/60 space-y-1">
        <p>Source Record: {intake.source_record_path}</p>
        <p>Intake Record: {intake.intake_record_path}</p>
        <p>Captured: {formatTime(intake.captured_at)}</p>
      </div>
    </section>
  );
}

export function IngestionSection({
  api,
  overview,
  detail,
  detailLoading,
  loading: _parentLoading,
  onOpenFile,
  onRefresh,
  onSelect,
  rawUrl,
}: IngestionSectionProps) {
  // Navigation & Scope
  const [scope, setScope] = useState<IngestionScope>("library");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | undefined>();
  const [selectedCorrespondent, setSelectedCorrespondent] = useState<
    string | undefined
  >();
  const [selectedDocType, setSelectedDocType] = useState<string | undefined>();

  // Document state
  const [searchResults, setSearchResults] =
    useState<SourceSearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<
    string | undefined
  >();
  const [selectedSource, setSelectedSource] = useState<SourceDocument | null>(
    null,
  );
  const [sourceLoading, setSourceLoading] = useState(false);

  // Upload modal state
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [isWindowDragging, setIsWindowDragging] = useState(false);

  // Password manager modal state
  const [isPasswordManagerOpen, setIsPasswordManagerOpen] = useState(false);
  const [passwordProfilesVersion, setPasswordProfilesVersion] = useState(0);

  // Perform search query based on active filters
  const performSearch = useCallback(async () => {
    if (scope === "workers") return;
    setSearchLoading(true);
    try {
      let review_status: string | undefined;
      let lifecycle: string | undefined;
      let processing_status: string | undefined;

      if (scope === "library") {
        review_status = reviewFilter === "all" ? undefined : reviewFilter;
        lifecycle = "active";
      } else if (scope === "processing") {
        processing_status = "processing";
      } else if (scope === "archived") {
        lifecycle = "archived";
      }

      const res = await api.searchSources({
        query: searchQuery.trim() || undefined,
        tags: selectedTag ? [selectedTag] : undefined,
        correspondent: selectedCorrespondent,
        document_type: selectedDocType,
        review_status,
        lifecycle,
        processing_status,
        limit: 50,
      });
      setSearchResults(res);

      // Keep the inspector inside the active filtered collection.
      if (res.matches.length === 0) {
        setSelectedSourceId(undefined);
      } else if (
        !selectedSourceId ||
        !res.matches.some((match) => match.source_id === selectedSourceId)
      ) {
        setSelectedSourceId(res.matches[0]?.source_id);
      }
    } catch {
      // Ignore search error
    } finally {
      setSearchLoading(false);
    }
  }, [
    scope,
    reviewFilter,
    searchQuery,
    selectedTag,
    selectedCorrespondent,
    selectedDocType,
    selectedSourceId,
    api.searchSources,
  ]);

  useEffect(() => {
    void performSearch();
  }, [performSearch]);

  // Load selected document detail
  useEffect(() => {
    if (!selectedSourceId || scope === "workers") {
      setSelectedSource(null);
      return;
    }
    let cancelled = false;
    setSourceLoading(true);
    api
      .loadSource(selectedSourceId)
      .then((doc: SourceDocument) => {
        if (!cancelled) setSelectedSource(doc);
      })
      .catch(() => {
        if (!cancelled) setSelectedSource(null);
      })
      .finally(() => {
        if (!cancelled) setSourceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSourceId, scope, api.loadSource]);

  // Global drag-and-drop listener to open upload modal
  function handleWindowDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsWindowDragging(true);
  }

  function handleWindowDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsWindowDragging(false);
  }

  function handleWindowDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsWindowDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setDroppedFiles(Array.from(e.dataTransfer.files));
      setIsUploadOpen(true);
    }
  }

  async function handleRebuildFts() {
    try {
      await fetch("/api/workspace/ingestion/rebuild-fts", { method: "POST" });
      void performSearch();
    } catch {
      // Ignore
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: full-window drag and drop target for document upload
    <div
      onDragOver={handleWindowDragOver}
      onDragLeave={handleWindowDragLeave}
      onDrop={handleWindowDrop}
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-base-100"
    >
      {/* Window Drag Overlay */}
      {isWindowDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/20 backdrop-blur-sm pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-primary bg-base-100/90 p-8 shadow-2xl text-center">
            <svg
              className="mx-auto h-12 w-12 text-primary"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <title>Upload document</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <p className="mt-2 text-lg font-bold">Drop files to ingest</p>
            <p className="text-xs text-base-content/60">
              Files will be stored into sources/ and queued for OCR extraction
            </p>
          </div>
        </div>
      )}

      {/* Top filter bar */}
      <DocumentFilterBar
        scope={scope}
        onScopeChange={(newScope) => {
          setScope(newScope);
          setSelectedSourceId(undefined);
        }}
        reviewFilter={reviewFilter}
        onReviewFilterChange={(filter) => {
          setReviewFilter(filter);
          setSelectedSourceId(undefined);
        }}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedTag={selectedTag}
        onTagChange={setSelectedTag}
        selectedCorrespondent={selectedCorrespondent}
        onCorrespondentChange={setSelectedCorrespondent}
        selectedDocType={selectedDocType}
        onDocTypeChange={setSelectedDocType}
        facets={
          searchResults?.facets ?? {
            tags: {},
            correspondents: {},
            document_types: {},
            review_status: {},
            processing_status: {},
          }
        }
        onOpenUpload={() => {
          setDroppedFiles([]);
          setIsUploadOpen(true);
        }}
        onOpenPasswordManager={() => setIsPasswordManagerOpen(true)}
        onRebuildFts={handleRebuildFts}
      />

      {/* Main content body */}
      {scope === "workers" ? (
        /* Legacy Queue & Worker Leases View */
        <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
          <section
            className="max-h-[28rem] w-full overflow-y-auto border-b border-base-content/10 xl:max-h-none xl:w-[min(34rem,38%)] xl:border-b-0 xl:border-r"
            aria-label="Ingestion intakes"
          >
            {overview && overview.intakes.length > 0 ? (
              overview.intakes.map((item) => (
                <ItemRow
                  item={item}
                  key={item.intake_id}
                  onSelect={() => onSelect(item.intake_id)}
                  selected={detail?.intake.intake_id === item.intake_id}
                />
              ))
            ) : (
              <div className="p-8 text-center text-sm text-base-content/60">
                No legacy intake records found.
              </div>
            )}
          </section>
          {detailLoading ? (
            <div className="flex min-h-[24rem] flex-1 items-center justify-center">
              <span
                className="loading loading-spinner loading-md text-primary"
                role="status"
              />
            </div>
          ) : detail ? (
            <DetailPane
              detail={detail}
              onOpenFile={onOpenFile}
              rawUrl={rawUrl}
            />
          ) : (
            <div className="flex min-h-[24rem] flex-1 items-center justify-center p-8 text-center text-sm text-base-content/60">
              Select an intake to inspect worker leases and published
              extractions.
            </div>
          )}
        </div>
      ) : (
        /* Modern Paperless Document Console */
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Document List (Left Column) */}
          <section
            className="w-full md:w-[min(32rem,40%)] border-b md:border-b-0 md:border-r border-base-content/10 overflow-y-auto bg-base-100 flex flex-col"
            aria-label="Document library"
          >
            {searchLoading ? (
              <div className="flex flex-1 items-center justify-center p-8">
                <span className="loading loading-spinner loading-md text-primary" />
              </div>
            ) : searchResults && searchResults.matches.length > 0 ? (
              <div className="divide-y divide-base-content/10">
                <div className="bg-base-200/40 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-base-content/50">
                  {searchResults.total} document
                  {searchResults.total !== 1 ? "s" : ""}
                </div>
                {searchResults.matches.map((item) => (
                  <DocumentCard
                    key={item.source_id}
                    item={item}
                    isSelected={selectedSourceId === item.source_id}
                    onSelect={() => setSelectedSourceId(item.source_id)}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-sm text-base-content/50">
                <svg
                  className="h-10 w-10 mb-2 stroke-current opacity-40"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <title>No documents</title>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <p className="font-semibold">No documents match this view</p>
                <p className="text-xs text-base-content/40 mt-1">
                  Upload a PDF, image, or paste notes to get started.
                </p>
                <button
                  type="button"
                  className="btn btn-outline btn-xs mt-3"
                  onClick={() => setIsUploadOpen(true)}
                >
                  Upload Document
                </button>
              </div>
            )}
          </section>

          {/* Document Inspector (Right Column) */}
          <section className="flex-1 min-w-0 flex flex-col overflow-hidden bg-base-100">
            <DocumentInspector
              api={api}
              document={selectedSource}
              loading={sourceLoading}
              onUpdate={(updated) => {
                setSelectedSource(updated);
                void performSearch();
                onRefresh();
              }}
              onDelete={(_deletedId) => {
                setSelectedSourceId(undefined);
                setSelectedSource(null);
                void performSearch();
                onRefresh();
              }}
              onOpenFile={onOpenFile}
              rawUrl={rawUrl}
              onOpenPasswordManager={() => setIsPasswordManagerOpen(true)}
              passwordProfilesVersion={passwordProfilesVersion}
            />
          </section>
        </div>
      )}

      {/* Upload Modal */}
      <UploadModal
        api={api}
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        initialFiles={droppedFiles}
        onOpenPasswordManager={() => setIsPasswordManagerOpen(true)}
        onSuccess={() => {
          void performSearch();
          onRefresh();
        }}
      />

      {/* Password Manager Modal */}
      <PasswordManagerModal
        api={api}
        isOpen={isPasswordManagerOpen}
        onClose={() => setIsPasswordManagerOpen(false)}
        onChanged={() => {
          setPasswordProfilesVersion((v) => v + 1);
        }}
      />
    </div>
  );
}
