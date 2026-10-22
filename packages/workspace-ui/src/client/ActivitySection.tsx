import { useMemo, useState } from "react";
import type {
  WorkspaceActivityResponse,
  WorkspaceDiagnosticsResponse,
} from "../shared/api";

export interface ActivitySectionProps {
  activity: WorkspaceActivityResponse | null;
  diagnostics?: WorkspaceDiagnosticsResponse | null;
  diagnosticsLoading?: boolean;
  loading: boolean;
  onOpenFile: (path: string) => void;
  onOpenGitActivity?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined;
  totalDocuments?: number | undefined;
}

function formatRelativeTime(dateString: string): string {
  try {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return dateString;
    const now = Date.now();
    const diffMs = now - date.getTime();
    if (diffMs < 0) return "Just now";
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  } catch {
    return dateString;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ActivitySection({
  activity,
  diagnostics,
  diagnosticsLoading: _diagnosticsLoading,
  loading,
  onOpenFile,
  onOpenGitActivity,
  onRefresh,
  totalDocuments,
}: ActivitySectionProps) {
  const [search, setSearch] = useState("");

  const recentFiles = activity?.recentFiles ?? [];

  const filteredRecentFiles = useMemo(() => {
    if (!search.trim()) return recentFiles;
    const q = search.toLowerCase();
    return recentFiles.filter((f) => f.path.toLowerCase().includes(q));
  }, [recentFiles, search]);

  if (loading && !activity) {
    return (
      <div className="flex h-full min-h-[30rem] items-center justify-center p-8">
        <p
          className="flex items-center gap-3 text-sm text-base-content/60"
          role="status"
        >
          <span
            aria-hidden="true"
            className="loading loading-spinner loading-md text-primary"
          />
          Loading workspace activity...
        </p>
      </div>
    );
  }

  const docCount = totalDocuments ?? recentFiles.length;

  return (
    <div
      className="workspace-activity flex-1 overflow-y-auto bg-base-100 p-4 sm:p-6 lg:p-8"
      data-testid="workspace-activity"
    >
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="workspace-eyebrow">OPENLIA / WORKSPACE</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">
            Recent Changes
          </h2>
          <p className="mt-1 text-xs text-base-content/60">
            Overview of recently updated workspace documents and template schema
            health.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onRefresh && (
            <button
              aria-label="Refresh activity"
              className="btn btn-ghost btn-sm btn-square"
              onClick={onRefresh}
              title="Refresh activity"
              type="button"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <title>Refresh</title>
                <path
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Background Git Audit Notice Banner */}
      {activity?.gitConfigured && (
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-base-content/10 bg-base-200/30 p-3.5">
          <div className="flex items-center gap-2.5">
            <svg
              className="h-4 w-4 text-primary shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <title>Git history indicator</title>
              <path
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-xs text-base-content/80">
              <strong>Git History:</strong> Version tracking records changes
              automatically in the background ({activity.commits.length} commits
              recorded on {activity.branch || "main"}).
            </span>
          </div>
          {onOpenGitActivity && (
            <button
              className="btn btn-ghost btn-xs text-primary self-start sm:self-auto shrink-0"
              onClick={onOpenGitActivity}
              type="button"
            >
              View Git Activity →
            </button>
          )}
        </div>
      )}

      {/* Template & Schema Diagnostics Panel */}
      {diagnostics && (
        <section
          aria-label="Template and schema diagnostics"
          className="mb-6 rounded-xl border border-base-content/15 bg-base-100 p-4 shadow-sm"
        >
          <div className="flex items-center justify-between gap-2 border-b border-base-content/10 pb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">
                Template & Schema Health
              </span>
              <span
                className={`badge badge-sm font-mono ${
                  diagnostics.valid ? "badge-success" : "badge-warning"
                }`}
              >
                {diagnostics.valid
                  ? "All Conforming"
                  : `${diagnostics.issues.length} ${
                      diagnostics.issues.length === 1 ? "issue" : "issues"
                    }`}
              </span>
            </div>
          </div>

          {diagnostics.issues.length > 0 ? (
            <div className="mt-3 space-y-2.5">
              <p className="text-xs text-base-content/70">
                The following files have frontmatter that does not conform to
                their domain template schemas. Click any file to inspect or
                edit:
              </p>
              <ul className="divide-y divide-base-content/5 rounded-lg border border-base-content/10 bg-base-200/40">
                {diagnostics.issues.map((issue) => (
                  <li
                    className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 p-3 hover:bg-base-200/80 transition-colors"
                    key={issue.path}
                  >
                    <div className="min-w-0 flex-1">
                      <button
                        className="font-mono text-xs font-semibold text-primary hover:underline text-left block truncate"
                        onClick={() => onOpenFile(issue.path)}
                        type="button"
                      >
                        {issue.path}
                      </button>
                      {issue.schema_path && (
                        <span className="text-[10px] text-base-content/50 font-mono block">
                          Schema: {issue.schema_path}
                        </span>
                      )}
                      <ul className="mt-1.5 max-h-28 overflow-y-auto list-disc list-inside text-xs text-warning space-y-0.5">
                        {issue.errors.map((err) => (
                          <li className="break-words" key={err}>
                            {err}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <button
                      className="btn btn-xs btn-outline shrink-0 self-start mt-1 sm:mt-0"
                      onClick={() => onOpenFile(issue.path)}
                      type="button"
                    >
                      Open & Fix
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mt-2.5 flex items-center gap-2 text-xs text-success">
              <svg
                className="h-4 w-4 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <title>All schemas and templates valid</title>
                <path
                  d="M5 13l4 4L19 7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>
                All documents in this workspace conform to their template
                schemas.
              </span>
            </div>
          )}
        </section>
      )}

      {/* Overview Stat Cards */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-4">
          <span className="text-xs uppercase tracking-wider text-base-content/50">
            Recently Modified
          </span>
          <p className="mt-1 text-2xl font-bold">{recentFiles.length}</p>
          <span className="text-xs text-base-content/60">
            {recentFiles.length === 1 ? "file updated" : "files updated"}
          </span>
        </div>

        <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-4">
          <span className="text-xs uppercase tracking-wider text-base-content/50">
            Workspace Files
          </span>
          <p className="mt-1 text-2xl font-bold">{docCount}</p>
          <span className="text-xs text-base-content/60">
            {docCount === 1 ? "tracked document" : "tracked documents"}
          </span>
        </div>

        <div className="col-span-2 sm:col-span-1 rounded-xl border border-base-content/10 bg-base-200/40 p-4">
          <span className="text-xs uppercase tracking-wider text-base-content/50">
            Template Health
          </span>
          <p className="mt-1 text-xl font-bold">
            {diagnostics
              ? diagnostics.valid
                ? "Conforming"
                : `${diagnostics.issues.length} Issues`
              : "Healthy"}
          </p>
          <span className="text-xs text-base-content/60">
            {diagnostics?.valid ? "All templates valid" : "Schema verification"}
          </span>
        </div>
      </div>

      {/* Search Toolbar */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm font-semibold text-base-content/70">
          Recently Modified Documents ({filteredRecentFiles.length})
        </div>

        <div className="w-full sm:w-64">
          <input
            aria-label="Filter activity"
            className="input input-bordered input-sm w-full bg-base-200/50"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents or paths..."
            type="search"
            value={search}
          />
        </div>
      </div>

      {/* Recently Modified Files */}
      {filteredRecentFiles.length > 0 ? (
        <section aria-labelledby="files-heading" className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-base-content/10 bg-base-200/20">
            <table className="table table-sm w-full">
              <thead>
                <tr className="border-b border-base-content/10 text-xs text-base-content/60">
                  <th>Document</th>
                  <th>Last Modified</th>
                  <th className="hidden sm:table-cell">Size</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecentFiles.map((file) => (
                  <tr
                    className="hover:bg-base-200/60 cursor-pointer"
                    key={file.path}
                    onClick={() => onOpenFile(file.path)}
                  >
                    <td className="font-medium">
                      <div className="flex items-center gap-2">
                        <svg
                          className="h-4 w-4 opacity-50 shrink-0"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={1.5}
                          viewBox="0 0 24 24"
                        >
                          <title>Document</title>
                          <path
                            d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span className="truncate" title={file.path}>
                          {file.path}
                        </span>
                      </div>
                    </td>
                    <td className="text-xs text-base-content/60 whitespace-nowrap">
                      {formatRelativeTime(file.modified_at)}
                    </td>
                    <td className="hidden sm:table-cell text-xs text-base-content/60 font-mono whitespace-nowrap">
                      {formatBytes(file.size)}
                    </td>
                    <td className="text-right">
                      <button
                        className="btn btn-ghost btn-xs text-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenFile(file.path);
                        }}
                        type="button"
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <div className="rounded-2xl border border-dashed border-base-content/20 bg-base-200/20 p-12 text-center">
          <h3 className="text-lg font-bold">
            No workspace documents modified yet
          </h3>
          <p className="mt-2 text-sm text-base-content/60">
            Start creating or editing documents to see changes and history
            recorded here.
          </p>
        </div>
      )}
    </div>
  );
}
