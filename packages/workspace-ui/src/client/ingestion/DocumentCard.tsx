import { useState } from "react";
import type { SourceSearchResultItem } from "../../shared/api";

export interface DocumentCardProps {
  item: SourceSearchResultItem;
  isSelected: boolean;
  onSelect: () => void;
}

function reviewBadge(status: string) {
  switch (status) {
    case "reviewed":
      return <span className="badge badge-success badge-xs">Reviewed</span>;
    case "needs-review":
      return (
        <span className="badge badge-warning badge-xs font-semibold">
          Needs Review
        </span>
      );
    default:
      return <span className="badge badge-ghost badge-xs">Unreviewed</span>;
  }
}

function processingBadge(status: string) {
  switch (status) {
    case "complete":
      return null;
    case "processing":
      return <span className="badge badge-info badge-xs">Extracting...</span>;
    case "queued":
      return <span className="badge badge-neutral badge-xs">Queued</span>;
    case "partial":
      return <span className="badge badge-warning badge-xs">Partial</span>;
    case "failed":
      return <span className="badge badge-error badge-xs">Failed</span>;
    default:
      return null;
  }
}

export function DocumentCard({ item, isSelected, onSelect }: DocumentCardProps) {
  const [copied, setCopied] = useState(false);

  function copyCitation(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(item.markdown_citation);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      onClick={onSelect}
      className={`group relative cursor-pointer border-b border-base-content/10 p-3.5 transition-colors hover:bg-base-200/60 ${
        isSelected ? "bg-primary/10" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h4 className="truncate text-sm font-semibold text-base-content group-hover:text-primary">
              {item.title}
            </h4>
            {item.document_type && (
              <span className="badge badge-outline badge-xs text-xs capitalize">
                {item.document_type}
              </span>
            )}
          </div>

          {/* Subtitle: Correspondent & Date */}
          <div className="mt-1 flex items-center gap-2 text-xs text-base-content/60">
            {item.correspondent && (
              <span className="font-medium text-base-content/80">
                {item.correspondent}
              </span>
            )}
            {item.document_date && <span>· {item.document_date}</span>}
            <span className="font-mono text-[10px] text-base-content/40">
              {item.source_id}
            </span>
          </div>
        </div>

        {/* Status badges */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-1">
            {reviewBadge(item.review_status)}
            {processingBadge(item.processing_status)}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
            onClick={copyCitation}
            title="Copy markdown citation link"
          >
            {copied ? "Copied!" : "Cite"}
          </button>
        </div>
      </div>

      {/* Snippet from full-text search match */}
      {item.snippet && (
        <div
          className="mt-2 line-clamp-2 text-xs text-base-content/75 italic bg-base-200/40 rounded p-1.5 font-mono [&>mark]:bg-warning/30 [&>mark]:text-warning-content [&>mark]:font-bold"
          dangerouslySetInnerHTML={{ __html: item.snippet }}
        />
      )}

      {/* Summary if no snippet */}
      {!item.snippet && item.summary && (
        <p className="mt-1.5 line-clamp-2 text-xs text-base-content/70">
          {item.summary}
        </p>
      )}

      {/* Tags */}
      {item.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="badge badge-ghost badge-xs bg-base-200/80 text-[10px] text-base-content/60"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
