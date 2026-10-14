import type { SourceSearchFacets } from "../../shared/api";

export type IngestionScope = "needs-review" | "library" | "processing" | "archived" | "workers";

export interface DocumentFilterBarProps {
  scope: IngestionScope;
  onScopeChange: (scope: IngestionScope) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedTag?: string | undefined;
  onTagChange: (tag: string | undefined) => void;
  selectedCorrespondent?: string | undefined;
  onCorrespondentChange: (corr: string | undefined) => void;
  selectedDocType?: string | undefined;
  onDocTypeChange: (dt: string | undefined) => void;
  facets: SourceSearchFacets;
  onOpenUpload: () => void;
  onRebuildFts?: () => void;
}

export function DocumentFilterBar({
  scope,
  onScopeChange,
  searchQuery,
  onSearchChange,
  selectedTag,
  onTagChange,
  selectedCorrespondent,
  onCorrespondentChange,
  selectedDocType,
  onDocTypeChange,
  facets,
  onOpenUpload,
  onRebuildFts,
}: DocumentFilterBarProps) {
  const needsReviewCount =
    (facets.review_status["needs-review"] ?? 0) +
    (facets.review_status["unreviewed"] ?? 0);
  const processingCount =
    (facets.processing_status["queued"] ?? 0) +
    (facets.processing_status["processing"] ?? 0) +
    (facets.processing_status["failed"] ?? 0);

  const tagsList = Object.keys(facets.tags).sort();
  const correspondentsList = Object.keys(facets.correspondents).sort();
  const docTypesList = Object.keys(facets.document_types).sort();

  return (
    <div className="space-y-3 border-b border-base-content/10 bg-base-100 p-4">
      {/* Top row: Scope tabs and action buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="tabs tabs-boxed bg-base-200">
          <button
            type="button"
            className={`tab text-xs font-medium ${
              scope === "needs-review" ? "tab-active" : ""
            }`}
            onClick={() => onScopeChange("needs-review")}
          >
            Needs Review
            {needsReviewCount > 0 && (
              <span className="badge badge-warning badge-xs ml-1.5 font-bold">
                {needsReviewCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`tab text-xs font-medium ${
              scope === "library" ? "tab-active" : ""
            }`}
            onClick={() => onScopeChange("library")}
          >
            Library
          </button>
          <button
            type="button"
            className={`tab text-xs font-medium ${
              scope === "processing" ? "tab-active" : ""
            }`}
            onClick={() => onScopeChange("processing")}
          >
            Processing
            {processingCount > 0 && (
              <span className="badge badge-info badge-xs ml-1.5 font-bold">
                {processingCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`tab text-xs font-medium ${
              scope === "archived" ? "tab-active" : ""
            }`}
            onClick={() => onScopeChange("archived")}
          >
            Archived
          </button>
          <button
            type="button"
            className={`tab text-xs font-medium ${
              scope === "workers" ? "tab-active" : ""
            }`}
            onClick={() => onScopeChange("workers")}
          >
            Queue & Workers
          </button>
        </div>

        <div className="flex items-center gap-2">
          {onRebuildFts && (
            <button
              type="button"
              className="btn btn-ghost btn-xs text-base-content/60 hover:text-base-content"
              onClick={onRebuildFts}
              title="Re-index workspace sources in SQLite full-text search"
            >
              Rebuild FTS
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm gap-1.5"
            onClick={onOpenUpload}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M12 4v16m8-8H4"
              />
            </svg>
            Upload
          </button>
        </div>
      </div>

      {/* Second row: Search query and facet filters (when not in raw workers view) */}
      {scope !== "workers" && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {/* Full-text search */}
          <div className="relative min-w-[200px] flex-1">
            <input
              type="text"
              className="input input-bordered input-sm w-full pr-8"
              placeholder="Search documents by content, title, tags, correspondent..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-circle absolute right-1 top-1/2 -translate-y-1/2 text-base-content/50 hover:text-base-content"
                onClick={() => onSearchChange("")}
              >
                ✕
              </button>
            )}
          </div>

          {/* Document Type Facet */}
          {docTypesList.length > 0 && (
            <select
              className="select select-bordered select-sm max-w-[150px] text-xs"
              value={selectedDocType ?? ""}
              onChange={(e) => onDocTypeChange(e.target.value || undefined)}
            >
              <option value="">All Document Types</option>
              {docTypesList.map((dt) => (
                <option key={dt} value={dt}>
                  {dt} ({facets.document_types[dt]})
                </option>
              ))}
            </select>
          )}

          {/* Correspondent Facet */}
          {correspondentsList.length > 0 && (
            <select
              className="select select-bordered select-sm max-w-[150px] text-xs"
              value={selectedCorrespondent ?? ""}
              onChange={(e) =>
                onCorrespondentChange(e.target.value || undefined)
              }
            >
              <option value="">All Correspondents</option>
              {correspondentsList.map((c) => (
                <option key={c} value={c}>
                  {c} ({facets.correspondents[c]})
                </option>
              ))}
            </select>
          )}

          {/* Tag Facet */}
          {tagsList.length > 0 && (
            <select
              className="select select-bordered select-sm max-w-[130px] text-xs"
              value={selectedTag ?? ""}
              onChange={(e) => onTagChange(e.target.value || undefined)}
            >
              <option value="">All Tags</option>
              {tagsList.map((t) => (
                <option key={t} value={t}>
                  #{t} ({facets.tags[t]})
                </option>
              ))}
            </select>
          )}

          {/* Reset Filters button */}
          {(selectedDocType || selectedCorrespondent || selectedTag || searchQuery) && (
            <button
              type="button"
              className="btn btn-ghost btn-xs text-xs text-base-content/60"
              onClick={() => {
                onSearchChange("");
                onDocTypeChange(undefined);
                onCorrespondentChange(undefined);
                onTagChange(undefined);
              }}
            >
              Reset Filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
