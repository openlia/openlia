import { useState } from "react";
import type { SourceSearchFacets } from "../../shared/api";
import { ActionMenu } from "../components/common/ActionMenu";
import { ResponsiveDrawer } from "../components/common/ResponsiveDrawer";

export type IngestionScope = "library" | "processing" | "archived" | "workers";
export type ReviewFilter = "all" | "needs-review" | "reviewed";

export interface DocumentFilterBarProps {
  scope: IngestionScope;
  onScopeChange: (scope: IngestionScope) => void;
  reviewFilter: ReviewFilter;
  onReviewFilterChange: (filter: ReviewFilter) => void;
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
  onOpenPasswordManager?: () => void;
  onRebuildFts?: () => void;
}

export function DocumentFilterBar({
  scope,
  onScopeChange,
  reviewFilter,
  onReviewFilterChange,
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
  onOpenPasswordManager,
  onRebuildFts,
}: DocumentFilterBarProps) {
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const needsReviewCount =
    (facets.review_status["needs-review"] ?? 0) +
    (facets.review_status.unreviewed ?? 0);
  const reviewedCount = facets.review_status.reviewed ?? 0;
  const allReviewCount = Object.values(facets.review_status).reduce(
    (total, count) => total + count,
    0,
  );
  const processingCount =
    (facets.processing_status.queued ?? 0) +
    (facets.processing_status.processing ?? 0) +
    (facets.processing_status.failed ?? 0);

  const tagsList = Object.keys(facets.tags).sort();
  const correspondentsList = Object.keys(facets.correspondents).sort();
  const docTypesList = Object.keys(facets.document_types).sort();

  const activeFilterCount =
    (scope === "library" && reviewFilter !== "all" ? 1 : 0) +
    (searchQuery.trim() ? 1 : 0) +
    (selectedDocType ? 1 : 0) +
    (selectedCorrespondent ? 1 : 0) +
    (selectedTag ? 1 : 0);

  return (
    <div className="shrink-0 space-y-2 border-b border-base-content/10 bg-base-100 px-3 py-2 sm:space-y-3 sm:p-4">
      {/* Top row: Scope tabs and action buttons */}
      <div className="flex flex-wrap md:flex-nowrap items-center justify-between gap-2">
        <select
          aria-label="Document library view"
          className="workspace-compact-select select select-bordered w-full md:hidden"
          value={scope}
          onChange={(event) =>
            onScopeChange(event.target.value as IngestionScope)
          }
        >
          <option value="library">Library</option>
          <option value="processing">Processing ({processingCount})</option>
          <option value="archived">Archived</option>
          <option value="workers">Queue & Workers</option>
        </select>
        <div className="workspace-wide-controls hidden md:flex tabs tabs-boxed flex-nowrap overflow-x-auto no-scrollbar bg-base-200 p-1">
          <button
            type="button"
            className={`tab tab-xs sm:tab-sm whitespace-nowrap text-xs font-medium ${
              scope === "library" ? "tab-active" : ""
            }`}
            onClick={() => onScopeChange("library")}
          >
            Library
          </button>
          <button
            type="button"
            className={`tab tab-xs sm:tab-sm whitespace-nowrap text-xs font-medium ${
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
            className={`tab tab-xs sm:tab-sm whitespace-nowrap text-xs font-medium ${
              scope === "archived" ? "tab-active" : ""
            }`}
            onClick={() => onScopeChange("archived")}
          >
            Archived
          </button>
          <button
            type="button"
            className={`tab tab-xs sm:tab-sm whitespace-nowrap text-xs font-medium ${
              scope === "workers" ? "tab-active" : ""
            }`}
            onClick={() => onScopeChange("workers")}
          >
            Queue & Workers
          </button>
        </div>

        <div className="flex w-full md:w-auto shrink-0 items-center justify-between md:justify-end gap-1.5 sm:gap-2">
          {scope !== "workers" && (
            <button
              type="button"
              className={`workspace-compact-control btn btn-xs sm:btn-sm gap-1 md:hidden ${
                mobileFiltersOpen || activeFilterCount > 0
                  ? "btn-secondary"
                  : "btn-ghost border border-base-content/15"
              }`}
              aria-expanded={mobileFiltersOpen}
              aria-label="Toggle document filters"
              onClick={(event) => {
                event.currentTarget.focus();
                setMobileFiltersOpen(true);
              }}
            >
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                />
              </svg>
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="badge badge-xs badge-neutral">
                  {activeFilterCount}
                </span>
              )}
            </button>
          )}
          {(onOpenPasswordManager || onRebuildFts) && (
            <ActionMenu label="Ingestion tools" className="btn-xs sm:btn-sm">
              <ul className="menu w-full p-0">
                {onOpenPasswordManager && (
                  <li>
                    <button
                      type="button"
                      className="justify-start"
                      onClick={onOpenPasswordManager}
                      title="Manage document password profiles"
                    >
                      <span aria-hidden="true">🔑</span>
                      Passwords
                    </button>
                  </li>
                )}
                {onRebuildFts && (
                  <li>
                    <button
                      type="button"
                      className="justify-start"
                      onClick={onRebuildFts}
                      title="Re-index workspace sources in SQLite full-text search"
                    >
                      Rebuild FTS
                    </button>
                  </li>
                )}
              </ul>
            </ActionMenu>
          )}
          <button
            type="button"
            className="btn btn-primary btn-xs sm:btn-sm gap-1"
            onClick={onOpenUpload}
          >
            <svg
              className="h-3.5 w-3.5 sm:h-4 sm:w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <title>Upload</title>
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
        <ResponsiveDrawer
          title="Document filters"
          open={mobileFiltersOpen}
          onClose={() => setMobileFiltersOpen(false)}
          className="workspace-filter-sheet"
          desktopQuery="(min-width: 768px) and (min-height: 501px), (min-width: 1280px)"
        >
          <div className="workspace-filter-fields flex flex-wrap items-center gap-2 pt-0.5 sm:pt-1">
            {scope === "library" && (
              <select
                aria-label="Review filter"
                className="select select-bordered select-sm max-w-[170px] text-xs"
                value={reviewFilter}
                onChange={(event) =>
                  onReviewFilterChange(event.target.value as ReviewFilter)
                }
              >
                <option value="all">All Reviews ({allReviewCount})</option>
                <option value="needs-review">
                  Needs Review ({needsReviewCount})
                </option>
                <option value="reviewed">Reviewed ({reviewedCount})</option>
              </select>
            )}
            {/* Full-text search */}
            <div className="relative min-w-0 basis-full md:basis-auto flex-1">
              <input
                type="text"
                aria-label="Search documents"
                className="input input-bordered input-sm w-full pr-8"
                placeholder="Search documents by content, title, tags, correspondent..."
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear document search"
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
                aria-label="Document type"
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
                aria-label="Correspondent"
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
                aria-label="Document tag"
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
            {(selectedDocType ||
              selectedCorrespondent ||
              selectedTag ||
              searchQuery) && (
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
            <button
              type="button"
              className="workspace-filter-done btn btn-primary w-full"
              onClick={() => setMobileFiltersOpen(false)}
            >
              Show results
            </button>
          </div>
        </ResponsiveDrawer>
      )}
    </div>
  );
}
