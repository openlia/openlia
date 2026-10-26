import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  WorkspaceActivityResponse,
  WorkspaceGitStatus,
} from "../shared/api";

export interface GitActivitySectionProps {
  activity: WorkspaceActivityResponse | null;
  git?: WorkspaceGitStatus | null | undefined;
  loading: boolean;
  onOpenFile: (path: string) => void;
  onRefresh?: (() => void) | undefined;
  proposals?: ReactNode;
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

function statusBadge(status: string) {
  switch (status) {
    case "added":
      return (
        <span className="badge badge-success badge-xs font-mono">Added</span>
      );
    case "modified":
      return (
        <span className="badge badge-warning badge-xs font-mono">Modified</span>
      );
    case "deleted":
      return (
        <span className="badge badge-error badge-xs font-mono">Deleted</span>
      );
    case "renamed":
      return (
        <span className="badge badge-info badge-xs font-mono">Renamed</span>
      );
    case "untracked":
      return (
        <span className="badge badge-neutral badge-xs font-mono">
          Untracked
        </span>
      );
    default:
      return (
        <span className="badge badge-ghost badge-xs font-mono">{status}</span>
      );
  }
}

export function GitActivitySection({
  activity,
  git,
  loading,
  onOpenFile,
  onRefresh,
  proposals,
}: GitActivitySectionProps) {
  const [search, setSearch] = useState("");
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleCommit = (hash: string) => {
    setExpandedCommits((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const uncommitted = activity?.uncommitted ?? [];
  const commits = activity?.commits ?? [];
  const branchName = activity?.branch || git?.branch || "main";
  const isGitConfigured = activity?.gitConfigured ?? git?.configured ?? false;

  const filteredUncommitted = useMemo(() => {
    if (!search.trim()) return uncommitted;
    const q = search.toLowerCase();
    return uncommitted.filter((u) => u.path.toLowerCase().includes(q));
  }, [uncommitted, search]);

  const filteredCommits = useMemo(() => {
    if (!search.trim()) return commits;
    const q = search.toLowerCase();
    return commits.filter(
      (c) =>
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.shortHash.toLowerCase().includes(q) ||
        c.files.some((f) => f.path.toLowerCase().includes(q)),
    );
  }, [commits, search]);

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
          Loading Git activity...
        </p>
      </div>
    );
  }

  return (
    <div
      className="workspace-activity flex-1 overflow-y-auto bg-base-100 p-4 sm:p-6 lg:p-8"
      data-testid="git-activity"
    >
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="workspace-eyebrow">OPENLIA / GIT ACTIVITY</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">
            Git History & Activity
          </h2>
          <p className="mt-1 text-xs text-base-content/60">
            User-approved checkpoints and chronological commit history.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isGitConfigured && (
            <span
              className={`badge gap-1.5 py-3 ${
                uncommitted.length > 0 ? "badge-warning" : "badge-success"
              }`}
            >
              <span className="font-mono text-xs">{branchName}</span>
              <span className="opacity-75">
                {uncommitted.length > 0
                  ? `(${uncommitted.length} uncommitted)`
                  : "(clean)"}
              </span>
            </span>
          )}
          {onRefresh && (
            <button
              aria-label="Refresh Git activity"
              className="btn btn-ghost btn-sm btn-square"
              onClick={onRefresh}
              title="Refresh Git activity"
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

      {proposals}
      {/* Overview Stat Cards */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-4">
          <span className="text-xs uppercase tracking-wider text-base-content/50">
            Active Branch
          </span>
          <p className="mt-1 text-xl font-bold font-mono truncate">
            {branchName}
          </p>
          <span className="text-xs text-base-content/60">
            {isGitConfigured ? "Version controlled" : "Not configured"}
          </span>
        </div>

        <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-4">
          <span className="text-xs uppercase tracking-wider text-base-content/50">
            Recorded Commits
          </span>
          <p className="mt-1 text-2xl font-bold">{commits.length}</p>
          <span className="text-xs text-base-content/60">
            {commits.length === 1 ? "commit recorded" : "commits recorded"}
          </span>
        </div>

        <div className="col-span-2 sm:col-span-1 rounded-xl border border-base-content/10 bg-base-200/40 p-4">
          <span className="text-xs uppercase tracking-wider text-base-content/50">
            Working Tree
          </span>
          <p className="mt-1 text-2xl font-bold">
            {uncommitted.length === 0 ? "Clean" : uncommitted.length}
          </p>
          <span className="text-xs text-base-content/60">
            {uncommitted.length === 0
              ? "No working changes"
              : uncommitted.length === 1
                ? "uncommitted change"
                : "uncommitted changes"}
          </span>
        </div>
      </div>

      {/* Search Toolbar */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm font-semibold text-base-content/70">
          History Records ({filteredCommits.length})
        </div>

        <div className="w-full sm:w-72">
          <input
            aria-label="Filter Git activity"
            className="input input-bordered input-sm w-full bg-base-200/50"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search commits, authors, hashes, or paths..."
            type="search"
            value={search}
          />
        </div>
      </div>

      {/* Uncommitted changes (if any) */}
      {filteredUncommitted.length > 0 && (
        <section
          aria-labelledby="uncommitted-heading"
          className="mb-8 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h3
              className="text-sm font-bold uppercase tracking-wider text-warning"
              id="uncommitted-heading"
            >
              Working Tree Modifications ({filteredUncommitted.length})
            </h3>
            <span className="text-xs text-base-content/50">
              Uncommitted changes pending background record
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border border-warning/30 bg-warning/5">
            <ul className="divide-y divide-base-content/10">
              {filteredUncommitted.map((item) => (
                <li key={item.path}>
                  <button
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-base-200/60"
                    onClick={() => {
                      if (item.status !== "deleted") onOpenFile(item.path);
                    }}
                    type="button"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      {statusBadge(item.status)}
                      <span
                        className={`truncate text-sm font-medium ${
                          item.status === "deleted"
                            ? "line-through opacity-60"
                            : ""
                        }`}
                      >
                        {item.path}
                      </span>
                    </div>
                    {item.status !== "deleted" && (
                      <span className="btn btn-ghost btn-xs shrink-0 text-primary">
                        Open in Workspace →
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Commits Section */}
      {filteredCommits.length > 0 ? (
        <section aria-labelledby="commits-heading" className="space-y-3">
          <div className="flex items-center justify-between">
            <h3
              className="text-sm font-bold uppercase tracking-wider text-base-content/70"
              id="commits-heading"
            >
              Git Commit History ({filteredCommits.length})
            </h3>
            <span className="text-xs text-base-content/50">
              Chronological history
            </span>
          </div>

          <div className="space-y-3">
            {filteredCommits.map((commit) => {
              const isExpanded = expandedCommits.has(commit.hash);
              return (
                <div
                  className="rounded-xl border border-base-content/10 bg-base-200/30 p-4 transition hover:border-base-content/20"
                  key={commit.hash}
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-base leading-snug">
                        {commit.message}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/60">
                        <span className="badge badge-neutral badge-xs font-mono">
                          {commit.shortHash}
                        </span>
                        <span>{commit.author}</span>
                        <span>•</span>
                        <time dateTime={commit.timestamp}>
                          {formatRelativeTime(commit.timestamp)}
                        </time>
                        {commit.files.length > 0 && (
                          <>
                            <span>•</span>
                            <button
                              className="text-primary hover:underline"
                              onClick={() => toggleCommit(commit.hash)}
                              type="button"
                            >
                              {commit.files.length}{" "}
                              {commit.files.length === 1 ? "file" : "files"}{" "}
                              {isExpanded ? "▴" : "▾"}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Changed files drawer */}
                  {isExpanded && commit.files.length > 0 && (
                    <div className="mt-3 rounded-lg border border-base-content/10 bg-base-100 p-2 text-xs">
                      <ul className="space-y-1">
                        {commit.files.map((file) => (
                          <li
                            className="flex items-center justify-between gap-2 px-2 py-1 hover:bg-base-200/50 rounded"
                            key={file.path}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              {statusBadge(file.status)}
                              <span
                                className={`truncate ${
                                  file.status === "deleted"
                                    ? "line-through opacity-60"
                                    : ""
                                }`}
                              >
                                {file.path}
                              </span>
                            </div>
                            {file.status !== "deleted" && (
                              <button
                                className="text-primary hover:underline shrink-0"
                                onClick={() => onOpenFile(file.path)}
                                type="button"
                              >
                                View
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        <div className="rounded-2xl border border-dashed border-base-content/20 bg-base-200/20 p-12 text-center">
          <h3 className="text-lg font-bold">No Git history recorded yet</h3>
          <p className="mt-2 text-sm text-base-content/60">
            Git automatically creates history records in the background when
            changes are committed.
          </p>
        </div>
      )}
    </div>
  );
}
