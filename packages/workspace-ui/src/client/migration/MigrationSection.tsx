import { useMemo, useState } from "react";
import type {
  MigrationDetailResponse,
  MigrationFeedbackRequest,
  MigrationSummary,
} from "../../shared/api";

export interface MigrationSectionProps {
  usageSummary?: import("react").ReactNode;
  migrationDetail: MigrationDetailResponse | null;
  migrationsList: MigrationSummary[];
  loading: boolean;
  onSelectMigration: (id: string) => void;
  onBack?: () => void;
  onRefresh: () => void;
  onWakeWorker: () => void;
  onStop: () => void;
  onResume: () => void;
  onApprove: (revisionId: string, patchHash?: string) => Promise<void>;
  onDiscard: () => Promise<void>;
  onSubmitFeedback: (req: MigrationFeedbackRequest) => Promise<void>;
  onRecover?: (action: string) => Promise<void>;
  onRetryJobs?: () => Promise<void>;
}

interface DiffLine {
  type: "add" | "del" | "hunk" | "meta" | "context";
  text: string;
  oldLineNo?: number | undefined;
  newLineNo?: number | undefined;
}

interface DiffFile {
  header: string;
  path: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

function parseGitDiff(diffText: string): DiffFile[] {
  if (!diffText) return [];
  const files: DiffFile[] = [];
  const rawLines = diffText.split("\n");

  let currentFile: DiffFile | null = null;
  let oldLineCounter = 0;
  let newLineCounter = 0;

  for (const line of rawLines) {
    if (line.startsWith("diff --git ")) {
      if (currentFile) files.push(currentFile);
      const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      const filePath = match?.[2] ?? line.slice("diff --git ".length);
      currentFile = {
        header: line,
        path: filePath,
        lines: [],
        additions: 0,
        deletions: 0,
      };
      oldLineCounter = 0;
      newLineCounter = 0;
    } else if (currentFile) {
      if (line.startsWith("@@")) {
        // Hunk header: @@ -oldStart,oldLen +newStart,newLen @@ optional heading
        const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          oldLineCounter = parseInt(hunkMatch[1] ?? "1", 10);
          newLineCounter = parseInt(hunkMatch[2] ?? "1", 10);
        }
        currentFile.lines.push({
          type: "hunk",
          text: line,
        });
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        currentFile.additions++;
        currentFile.lines.push({
          type: "add",
          text: line,
          newLineNo: newLineCounter++,
        });
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        currentFile.deletions++;
        currentFile.lines.push({
          type: "del",
          text: line,
          oldLineNo: oldLineCounter++,
        });
      } else if (
        line.startsWith("index ") ||
        line.startsWith("---") ||
        line.startsWith("+++") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") ||
        line.startsWith("similarity index") ||
        line.startsWith("rename from") ||
        line.startsWith("rename to")
      ) {
        currentFile.lines.push({
          type: "meta",
          text: line,
        });
      } else if (line.startsWith("\\ No newline at end of file")) {
        currentFile.lines.push({
          type: "meta",
          text: line,
        });
      } else {
        // Context line
        currentFile.lines.push({
          type: "context",
          text: line,
          oldLineNo: oldLineCounter++,
          newLineNo: newLineCounter++,
        });
      }
    }
  }
  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

export function MigrationSection({
  usageSummary,
  migrationDetail,
  migrationsList,
  loading,
  onSelectMigration,
  onBack,
  onRefresh,
  onWakeWorker,
  onStop,
  onResume,
  onApprove,
  onDiscard,
  onSubmitFeedback,
  onRecover,
  onRetryJobs,
}: MigrationSectionProps) {
  const [activeSubTab, setActiveSubTab] = useState<
    "overview" | "changes" | "sources" | "discussion"
  >("overview");
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const [commentText, setCommentText] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [requestChanges, setRequestChanges] = useState(false);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [isApproveModalOpen, setIsApproveModalOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [retryingJobs, setRetryingJobs] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [selectedFileFilter, setSelectedFileFilter] = useState("");
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>(
    {},
  );

  const parsedDiffFiles = useMemo(() => {
    return parseGitDiff(migrationDetail?.active_diff ?? "");
  }, [migrationDetail?.active_diff]);

  const filteredDiffFiles = useMemo(() => {
    if (!selectedFileFilter) return parsedDiffFiles;
    return parsedDiffFiles.filter((f) => f.path === selectedFileFilter);
  }, [parsedDiffFiles, selectedFileFilter]);

  const toggleCollapseFile = (path: string) => {
    setCollapsedFiles((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  const collapseAllFiles = () => {
    const next: Record<string, boolean> = {};
    for (const f of filteredDiffFiles) {
      next[f.path] = true;
    }
    setCollapsedFiles(next);
  };

  const expandAllFiles = () => {
    setCollapsedFiles({});
  };

  const totalDiffStats = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const f of filteredDiffFiles) {
      adds += f.additions;
      dels += f.deletions;
    }
    return { additions: adds, deletions: dels };
  }, [filteredDiffFiles]);

  if (!migrationDetail) {
    return (
      <div className="flex flex-col h-full overflow-y-auto p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-2 pb-4 border-b border-base-content/10">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold">Workspace Migrations</h2>
              <span className="badge badge-sm badge-warning/90 font-mono text-[10px] uppercase font-bold">
                Beta
              </span>
            </div>
            <p className="text-sm text-base-content/60">
              Review and apply imported workspace data and synthesized skills.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {migrationsList.length === 0 ? (
          <div className="p-12 text-center text-base-content/60 bg-base-200/50 rounded-xl">
            <h3 className="text-lg font-semibold">No migrations found</h3>
            <p className="mt-2 text-sm">
              Run{" "}
              <code className="px-2 py-0.5 bg-base-300 rounded font-mono">
                openlia workspace migrate &lt;folder&gt;
              </code>{" "}
              to start an import.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-base-content/10 bg-base-100">
            <table className="table table-zebra w-full">
              <thead>
                <tr>
                  <th>Migration ID</th>
                  <th>State</th>
                  <th>Progress</th>
                  <th>Sources</th>
                  <th>Revisions</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {migrationsList.map((m) => (
                  <tr key={m.id}>
                    <td className="font-mono font-medium">{m.id}</td>
                    <td>
                      <span
                        className={`badge badge-sm ${
                          m.state === "ready_for_review"
                            ? "badge-success"
                            : m.state === "applied"
                              ? "badge-neutral"
                              : m.state === "discarded"
                                ? "badge-ghost"
                                : "badge-info"
                        }`}
                      >
                        {m.state}
                      </span>
                    </td>
                    <td className="min-w-32">
                      {m.progress ? (
                        <div className="flex flex-col gap-1">
                          <div className="flex justify-between text-xs font-mono">
                            <span>{m.progress.percent}%</span>
                            <span className="text-base-content/60">
                              {m.progress.succeeded}/{m.progress.total}
                            </span>
                          </div>
                          <progress
                            className="progress progress-primary w-full h-1.5"
                            value={m.progress.percent}
                            max="100"
                          />
                        </div>
                      ) : (
                        <span className="text-xs text-base-content/40">—</span>
                      )}
                    </td>
                    <td>{m.total_sources}</td>
                    <td>{m.total_revisions}</td>
                    <td className="text-sm">
                      {new Date(m.created_at).toLocaleString()}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-xs btn-primary"
                        onClick={() => onSelectMigration(m.id)}
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  const {
    migration,
    sources,
    revisions,
    active_diff,
    feedback,
    worker_status,
    recovery,
  } = migrationDetail;
  const latestRev =
    revisions.length > 0 ? revisions[revisions.length - 1] : null;
  const activeRev =
    (selectedRevisionId
      ? revisions.find((r) => r.id === selectedRevisionId || String(r.revision_num) === selectedRevisionId)
      : null) ?? latestRev;

  const hasFailedJobs = sources.some(
    (s) => s.job_state === "failed" || (s.eligibility === "eligible" && s.reason?.toLowerCase().includes("failed")),
  );

  const handleSendFeedback = async () => {
    if (!commentText.trim() || !activeRev) return;
    setSubmittingFeedback(true);
    try {
      await onSubmitFeedback({
        revision_id: activeRev.id,
        target_path: targetPath.trim() || undefined,
        comment: commentText.trim(),
        request_changes: requestChanges,
      });
      setCommentText("");
      setTargetPath("");
      setRequestChanges(false);
    } finally {
      setSubmittingFeedback(false);
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectReason.trim() || !activeRev) return;
    setSubmittingFeedback(true);
    try {
      await onSubmitFeedback({
        revision_id: activeRev.id,
        comment: `[CHANGES REQUESTED]: ${rejectReason.trim()}`,
        request_changes: true,
      });
      setRejectReason("");
      setIsRejectModalOpen(false);
      setActiveSubTab("discussion");
    } finally {
      setSubmittingFeedback(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {usageSummary}

      {/* Recovery Required Alert Banner */}
      {recovery?.required && (
        <div className="bg-error/15 border border-error/30 rounded-xl p-3 sm:p-4 m-3 sm:m-4 space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="font-bold text-error text-sm flex items-center gap-2">
                <span>⚠️</span> Recovery Required
              </h4>
              <p className="text-xs sm:text-sm text-base-content/80 mt-1">
                An apply operation was interrupted or encountered an error before committing. Normal review actions are suspended until resolved.
              </p>
              {recovery.error_message && (
                <p className="text-xs font-mono text-error/90 mt-1">
                  {recovery.error_message}
                </p>
              )}
            </div>
            <span className="badge badge-error badge-sm uppercase font-mono">
              {recovery.journal_status ?? "recovery_required"}
            </span>
          </div>
          {onRecover && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                className="btn btn-xs sm:btn-sm btn-error text-white"
                disabled={recovering}
                onClick={async () => {
                  setRecovering(true);
                  try {
                    await onRecover("rollback");
                  } finally {
                    setRecovering(false);
                  }
                }}
              >
                Rollback to Ready for Review
              </button>
              <button
                type="button"
                className="btn btn-xs sm:btn-sm btn-warning"
                disabled={recovering}
                onClick={async () => {
                  setRecovering(true);
                  try {
                    await onRecover("retry");
                  } finally {
                    setRecovering(false);
                  }
                }}
              >
                Retry Apply
              </button>
              <button
                type="button"
                className="btn btn-xs sm:btn-sm btn-outline"
                disabled={recovering}
                onClick={async () => {
                  setRecovering(true);
                  try {
                    await onRecover("inspect");
                  } finally {
                    setRecovering(false);
                  }
                }}
              >
                Inspect Journal
              </button>
              <button
                type="button"
                className="btn btn-xs sm:btn-sm btn-ghost"
                disabled={recovering}
                onClick={async () => {
                  setRecovering(true);
                  try {
                    await onRecover("resolve");
                  } finally {
                    setRecovering(false);
                  }
                }}
              >
                Mark Resolved
              </button>
            </div>
          )}
        </div>
      )}

      {/* Top Header Bar */}
      <div className="flex flex-wrap items-center justify-between p-3 sm:p-4 border-b border-base-content/10 bg-base-100 gap-2">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5 min-w-0">
          {onBack && (
            <button
              type="button"
              aria-label="Back to migrations list"
              className="btn btn-xs sm:btn-sm btn-ghost gap-1 px-2 text-base-content/70 hover:text-base-content"
              onClick={onBack}
              title="Back to migrations list"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 19l-7-7m0 0l7-7m-7 7h18"
                />
              </svg>
              Migrations
            </button>
          )}
          {onBack && (
            <span className="text-base-content/30 font-semibold">/</span>
          )}
          <span className="font-mono text-sm sm:text-lg font-bold whitespace-nowrap truncate">
            {migration.id}
          </span>
          <span className="badge badge-xs badge-warning/90 font-mono text-[9px] uppercase font-bold">
            Beta
          </span>
          <span
            className={`badge badge-sm font-semibold ${
              migration.state === "ready_for_review"
                ? "badge-success"
                : migration.state === "applied"
                  ? "badge-neutral"
                  : migration.state === "discarded"
                    ? "badge-ghost"
                    : migration.state === "recovery_required"
                      ? "badge-error"
                      : "badge-primary"
            }`}
          >
            {migration.state}
          </span>
          <span
            className={`badge badge-sm ${
              worker_status === "running"
                ? "badge-success"
                : worker_status === "sleeping"
                  ? "badge-ghost"
                  : "badge-warning"
            }`}
          >
            Worker: {worker_status}
          </span>

          {revisions.length > 1 && (
            <div className="flex items-center gap-1 ml-1 sm:ml-2">
              <span className="text-xs text-base-content/60 font-medium">Rev:</span>
              <select
                aria-label="Select revision"
                className="select select-bordered select-xs font-mono"
                value={activeRev?.id ?? ""}
                onChange={(e) => setSelectedRevisionId(e.target.value)}
              >
                {revisions.map((r) => (
                  <option key={r.id} value={r.id}>
                    Rev {r.revision_num} ({r.id.slice(0, 10)})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {worker_status === "sleeping" && (
            <button
              type="button"
              className="btn btn-xs sm:btn-sm btn-accent"
              onClick={onWakeWorker}
            >
              Wake Worker
            </button>
          )}

          {migration.state === "stopped" ? (
            <button
              type="button"
              className="btn btn-xs sm:btn-sm btn-info"
              onClick={onResume}
            >
              Resume
            </button>
          ) : migration.state === "processing" ? (
            <button
              type="button"
              className="btn btn-xs sm:btn-sm btn-warning"
              onClick={onStop}
            >
              Stop
            </button>
          ) : null}

          {activeRev && migration.state !== "applied" && (
            <>
              <button
                type="button"
                className="btn btn-xs sm:btn-sm btn-success text-white"
                onClick={() => setIsApproveModalOpen(true)}
              >
                Approve & Apply
              </button>
              <button
                type="button"
                className="btn btn-xs sm:btn-sm btn-warning btn-outline"
                onClick={() => setIsRejectModalOpen(true)}
              >
                Reject with Comment
              </button>
            </>
          )}

          {migration.state !== "applied" && (
            <button
              type="button"
              className="btn btn-xs sm:btn-sm btn-error btn-outline"
              onClick={onDiscard}
            >
              Discard
            </button>
          )}

          <button
            type="button"
            className="btn btn-xs sm:btn-sm btn-ghost"
            onClick={onRefresh}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs tabs-bordered px-2 sm:px-4 bg-base-100 flex-nowrap overflow-x-auto no-scrollbar">
        <button
          type="button"
          className={`tab whitespace-nowrap text-xs sm:text-sm ${activeSubTab === "overview" ? "tab-active" : ""}`}
          onClick={() => setActiveSubTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={`tab whitespace-nowrap text-xs sm:text-sm ${activeSubTab === "changes" ? "tab-active" : ""}`}
          onClick={() => setActiveSubTab("changes")}
        >
          Changes ({activeRev ? activeRev.changed_files.length : 0})
        </button>
        <button
          type="button"
          className={`tab whitespace-nowrap text-xs sm:text-sm ${activeSubTab === "sources" ? "tab-active" : ""}`}
          onClick={() => setActiveSubTab("sources")}
        >
          Sources ({sources.length})
        </button>
        <button
          type="button"
          className={`tab whitespace-nowrap text-xs sm:text-sm ${activeSubTab === "discussion" ? "tab-active" : ""}`}
          onClick={() => setActiveSubTab("discussion")}
        >
          Discussion ({feedback.length})
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-6 bg-base-200/30">
        {activeSubTab === "overview" && (
          <div className="space-y-6 max-w-4xl">
            {/* Live Progress & ETA Banner (when processing or stopped or progress exists) */}
            {migration.progress && (
              <div className="p-5 rounded-2xl bg-base-100 border border-base-content/10 shadow-sm space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold uppercase tracking-wider text-base-content/70">
                      Migration Progress
                    </span>
                    <span className="badge badge-primary font-mono font-semibold">
                      {migration.progress.percent}%
                    </span>
                  </div>
                  {migration.progress.estimated_finish_at && (
                    <div className="flex items-center gap-1.5 text-xs font-medium text-base-content/70 bg-base-200/70 px-2.5 py-1 rounded-lg">
                      <span>⏱ Est. finish:</span>
                      <span className="font-mono font-bold text-primary">
                        {new Date(
                          migration.progress.estimated_finish_at,
                        ).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      {migration.progress.eta_seconds && (
                        <span className="text-base-content/50">
                          (~
                          {Math.max(
                            1,
                            Math.round(migration.progress.eta_seconds / 60),
                          )}
                          m remaining)
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Progress bar */}
                <progress
                  className="progress progress-primary w-full h-3"
                  value={migration.progress.percent}
                  max="100"
                />

                <div className="flex flex-wrap items-center justify-between text-xs text-base-content/70 gap-2 pt-1">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-success"></span>
                      <span>{migration.progress.succeeded} succeeded</span>
                    </span>
                    {migration.progress.running > 0 && (
                      <span className="flex items-center gap-1 font-semibold text-primary">
                        <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse"></span>
                        <span>{migration.progress.running} running</span>
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-base-content/30"></span>
                      <span>{migration.progress.pending} pending</span>
                    </span>
                    {migration.progress.failed > 0 && (
                      <span className="flex items-center gap-1 text-error">
                        <span className="inline-block w-2 h-2 rounded-full bg-error"></span>
                        <span>{migration.progress.failed} failed</span>
                      </span>
                    )}
                  </div>

                  {migration.progress.current_file && (
                    <div className="flex items-center gap-1.5 truncate max-w-sm">
                      <span className="text-base-content/50 shrink-0">
                        Processing:
                      </span>
                      <span className="font-mono font-medium truncate text-base-content/90">
                        {migration.progress.current_file}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-base-100 border border-base-content/10 shadow-xs">
                <div className="text-xs uppercase tracking-wider text-base-content/60">
                  Total Sources
                </div>
                <div className="mt-1 text-3xl font-bold">{sources.length}</div>
                <div className="mt-1 text-xs text-base-content/60">
                  Extracted from intake archive
                </div>
              </div>
              <div className="p-4 rounded-xl bg-base-100 border border-base-content/10 shadow-xs">
                <div className="text-xs uppercase tracking-wider text-base-content/60">
                  Review Revisions
                </div>
                <div className="mt-1 text-3xl font-bold">
                  {revisions.length}
                </div>
                <div className="mt-1 text-xs text-base-content/60">
                  {latestRev ? `Active: ${latestRev.id}` : "None published"}
                </div>
              </div>
              <div className="p-4 rounded-xl bg-base-100 border border-base-content/10 shadow-xs">
                <div className="text-xs uppercase tracking-wider text-base-content/60">
                  Proposed Changes
                </div>
                <div className="mt-1 text-3xl font-bold">
                  {activeRev ? activeRev.changed_files.length : 0}
                </div>
                <div className="mt-1 text-xs text-base-content/60">
                  Files staged in proposal
                </div>
              </div>
            </div>

            {activeRev?.unresolved_questions &&
              activeRev.unresolved_questions.length > 0 && (
                <div className="p-4 rounded-xl bg-warning/10 border border-warning/30 space-y-2">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-warning flex items-center gap-1.5">
                    <span>❓</span> Unresolved Questions for Operator
                  </h3>
                  <ul className="list-disc list-inside text-sm space-y-1.5 text-base-content/85">
                    {activeRev.unresolved_questions.map((q, idx) => (
                      <li key={idx}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}

            {activeRev?.summary && (
              <div className="p-4 rounded-xl bg-base-100 border border-base-content/10">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/60">
                  <span>Revision Summary</span> (Rev {activeRev.revision_num})
                </h3>
                <p className="mt-2 text-sm whitespace-pre-wrap">
                  {activeRev.summary}
                </p>
              </div>
            )}

            {activeRev?.findings && activeRev.findings.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-base font-semibold">Validation Findings</h3>
                <div className="space-y-2">
                  {activeRev.findings.map((f) => (
                    <div
                      key={`${f.domain}-${f.file ?? ""}-${f.line ?? ""}-${f.message}`}
                      className={`p-3 rounded-lg border text-sm ${
                        f.severity === "error"
                          ? "bg-error/10 border-error text-error-content"
                          : "bg-warning/10 border-warning text-warning-content"
                      }`}
                    >
                      <span className="font-bold uppercase text-xs mr-2">
                        {f.severity}
                      </span>
                      <span>{f.message}</span>
                      {f.file && (
                        <span className="ml-2 font-mono text-xs opacity-80">
                          ({f.file})
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeSubTab === "changes" && (
          <div className="space-y-4">
            {/* Filter & stats toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-base-100 border border-base-content/10 rounded-xl shadow-xs">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
                    Filter file:
                  </span>
                  <select
                    className="select select-sm select-bordered max-w-xs font-mono text-xs"
                    value={selectedFileFilter}
                    onChange={(e) => setSelectedFileFilter(e.target.value)}
                  >
                    <option value="">
                      All files ({parsedDiffFiles.length})
                    </option>
                    {parsedDiffFiles.map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path} (+{f.additions} / -{f.deletions})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Overall diff statistics badge */}
                <div className="flex items-center gap-1.5 text-xs font-mono">
                  <span className="badge badge-sm badge-success font-semibold">
                    +{totalDiffStats.additions}
                  </span>
                  <span className="badge badge-sm badge-error font-semibold">
                    -{totalDiffStats.deletions}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-xs btn-ghost text-base-content/70 hover:text-base-content"
                  onClick={collapseAllFiles}
                  title="Collapse all diff panels"
                >
                  Collapse all
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost text-base-content/70 hover:text-base-content"
                  onClick={expandAllFiles}
                  title="Expand all diff panels"
                >
                  Expand all
                </button>
                <span className="text-xs text-base-content/50 border-l border-base-content/10 pl-2">
                  {filteredDiffFiles.length} of {parsedDiffFiles.length} files
                </span>
              </div>
            </div>

            {/* Formatted Diff Cards */}
            {filteredDiffFiles.length > 0 ? (
              filteredDiffFiles.map((file) => {
                const isCollapsed = !!collapsedFiles[file.path];
                return (
                  <div
                    key={file.path}
                    className="border border-base-content/15 rounded-xl overflow-hidden bg-base-100 shadow-xs"
                  >
                    {/* File Header */}
                    <div className="flex items-center justify-between px-3.5 py-2.5 bg-base-200/80 border-b border-base-content/10 select-none">
                      <button
                        type="button"
                        className="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0 text-left bg-transparent border-none p-0"
                        onClick={() => toggleCollapseFile(file.path)}
                      >
                        <span className="text-xs text-base-content/60 w-3">
                          {isCollapsed ? "▶" : "▼"}
                        </span>
                        <span className="font-mono text-xs font-bold text-base-content/95 truncate">
                          {file.path}
                        </span>
                        <div className="flex items-center gap-1 font-mono text-[11px] shrink-0">
                          <span className="text-success font-semibold">
                            +{file.additions}
                          </span>
                          <span className="text-error font-semibold">
                            -{file.deletions}
                          </span>
                        </div>
                      </button>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost text-primary hover:bg-primary/10"
                          onClick={() => {
                            setTargetPath(file.path);
                            setActiveSubTab("discussion");
                          }}
                        >
                          Comment
                        </button>
                      </div>
                    </div>

                    {/* Diff Content / Lines */}
                    {!isCollapsed && (
                      <div className="overflow-x-auto font-mono text-xs bg-base-300/30">
                        <table className="w-full border-collapse">
                          <tbody>
                            {file.lines.map((line, idx) => {
                              const lineKey = `${line.type}-${line.oldLineNo ?? ""}-${line.newLineNo ?? ""}-${idx}`;
                              if (line.type === "meta") {
                                return (
                                  <tr
                                    key={lineKey}
                                    className="border-b border-base-content/5 bg-base-200/40 text-base-content/50 italic text-[11px]"
                                  >
                                    <td
                                      colSpan={3}
                                      className="py-0.5 px-3 select-none"
                                    >
                                      {line.text}
                                    </td>
                                  </tr>
                                );
                              }

                              if (line.type === "hunk") {
                                return (
                                  <tr
                                    key={lineKey}
                                    className="bg-info/10 text-info font-medium border-y border-info/20 text-[11px]"
                                  >
                                    <td
                                      colSpan={3}
                                      className="py-1 px-3 select-none"
                                    >
                                      {line.text}
                                    </td>
                                  </tr>
                                );
                              }

                              const isAdd = line.type === "add";
                              const isDel = line.type === "del";

                              const rowBg = isAdd
                                ? "bg-success/15 hover:bg-success/20"
                                : isDel
                                  ? "bg-error/15 hover:bg-error/20"
                                  : "hover:bg-base-200/50";

                              const signCol = isAdd ? (
                                <span className="text-success font-bold">
                                  +
                                </span>
                              ) : isDel ? (
                                <span className="text-error font-bold">-</span>
                              ) : (
                                <span className="opacity-0"> </span>
                              );

                              // Clear, high-contrast text color
                              const textCol = isAdd
                                ? "text-base-content font-medium"
                                : isDel
                                  ? "text-base-content/90 font-medium"
                                  : "text-base-content/85";

                              return (
                                <tr
                                  key={lineKey}
                                  className={`${rowBg} transition-colors`}
                                >
                                  {/* Old Line Number */}
                                  <td className="w-12 text-right pr-2 py-0.5 select-none text-[11px] text-base-content/35 border-r border-base-content/5">
                                    {line.oldLineNo ?? ""}
                                  </td>
                                  {/* New Line Number */}
                                  <td className="w-12 text-right pr-2 py-0.5 select-none text-[11px] text-base-content/35 border-r border-base-content/5">
                                    {line.newLineNo ?? ""}
                                  </td>
                                  {/* Code Content */}
                                  <td className="py-0.5 px-3 whitespace-pre flex items-start gap-2">
                                    <span className="w-3 text-center select-none shrink-0 font-mono">
                                      {signCol}
                                    </span>
                                    <span className={`flex-1 ${textCol}`}>
                                      {line.text.slice(1)}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })
            ) : active_diff ? (
              <pre className="p-4 font-mono text-xs bg-base-300 rounded-xl overflow-x-auto whitespace-pre-wrap">
                {active_diff}
              </pre>
            ) : (
              <div className="p-8 text-center text-base-content/60 bg-base-100 rounded-xl border border-base-content/10">
                No diff changes detected in this revision.
              </div>
            )}
          </div>
        )}

        {activeSubTab === "sources" && (
          <div className="space-y-3">
            {hasFailedJobs && onRetryJobs && (
              <div className="flex items-center justify-between p-3 bg-error/10 border border-error/25 rounded-xl">
                <div>
                  <h4 className="text-xs font-bold text-error">Source Processing Issues</h4>
                  <p className="text-xs text-base-content/70">One or more source files encountered errors during processing.</p>
                </div>
                <button
                  type="button"
                  className="btn btn-xs btn-error text-white"
                  disabled={retryingJobs}
                  onClick={async () => {
                    setRetryingJobs(true);
                    try {
                      await onRetryJobs();
                    } finally {
                      setRetryingJobs(false);
                    }
                  }}
                >
                  {retryingJobs ? "Retrying..." : "Retry Failed Jobs"}
                </button>
              </div>
            )}
            <div className="overflow-x-auto bg-base-100 rounded-xl border border-base-content/10">
              <table className="table table-zebra w-full">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Source File</th>
                    <th>Type</th>
                    <th>Eligibility</th>
                    <th>Job Outcome</th>
                    <th>Size</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <td className="text-xs text-base-content/60">
                        {s.order_index}
                      </td>
                      <td className="font-mono text-xs font-medium">
                        {s.relative_path}
                      </td>
                      <td>{s.detected_type}</td>
                      <td>
                        <span
                          className={`badge badge-xs ${
                            s.eligibility === "eligible"
                              ? "badge-success"
                              : s.eligibility === "blocked"
                                ? "badge-error"
                                : "badge-ghost"
                          }`}
                        >
                          {s.eligibility}
                        </span>
                      </td>
                      <td>
                        {s.job_state ? (
                          <div className="space-y-0.5">
                            <span
                              className={`badge badge-xs ${
                                s.job_state === "succeeded"
                                  ? "badge-success"
                                  : s.job_state === "failed"
                                    ? "badge-error"
                                    : s.job_state === "no_change"
                                      ? "badge-ghost"
                                      : "badge-primary"
                              }`}
                            >
                              {s.job_state} {s.job_attempts ? `(${s.job_attempts}x)` : ""}
                            </span>
                            {s.job_error && (
                              <p className="text-[11px] text-error font-mono truncate max-w-xs" title={s.job_error}>
                                {s.job_error}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-base-content/40">—</span>
                        )}
                      </td>
                      <td className="text-xs">{s.byte_size} bytes</td>
                      <td className="text-xs text-base-content/70">
                        {s.job_summary || s.reason || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeSubTab === "discussion" && (
          <div className="space-y-6 max-w-3xl">
            <div className="space-y-3">
              {feedback.length === 0 ? (
                <div className="p-8 text-center text-base-content/60 bg-base-100 rounded-xl border border-base-content/10">
                  No review comments recorded yet.
                </div>
              ) : (
                feedback.map((fb) => (
                  <div
                    key={fb.id}
                    className="p-4 rounded-xl bg-base-100 border border-base-content/10 shadow-xs space-y-1"
                  >
                    <div className="flex items-center justify-between text-xs text-base-content/60">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold">
                          {fb.revision_id}
                        </span>
                        {fb.target_path && (
                          <span className="badge badge-xs badge-neutral font-mono">
                            {fb.target_path}
                          </span>
                        )}
                      </div>
                      <span>{new Date(fb.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-sm pt-1 whitespace-pre-wrap">
                      {fb.comment}
                    </p>
                  </div>
                ))
              )}
            </div>

            <div className="p-5 bg-base-100 rounded-xl border border-base-content/10 space-y-3 shadow-xs">
              <h4 className="text-sm font-semibold">Submit Review Feedback</h4>
              {targetPath && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-base-content/60">Regarding:</span>
                  <span className="font-mono font-bold">{targetPath}</span>
                  <button
                    type="button"
                    className="text-error hover:underline text-xs"
                    onClick={() => setTargetPath("")}
                  >
                    Clear
                  </button>
                </div>
              )}
              <textarea
                className="textarea textarea-bordered w-full h-24 text-sm"
                placeholder="Leave comments or instructions for the next revision..."
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
              />
              <div className="flex items-center justify-between gap-2 pt-1">
                <label className="label cursor-pointer gap-2 py-0">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-xs checkbox-warning"
                    checked={requestChanges}
                    onChange={(e) => setRequestChanges(e.target.checked)}
                  />
                  <span className="label-text text-xs font-medium">
                    Request changes (triggers Hermes revision run)
                  </span>
                </label>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={submittingFeedback || !commentText.trim()}
                  onClick={handleSendFeedback}
                >
                  {submittingFeedback ? "Submitting..." : "Submit Feedback"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Approve Modal */}
      {isApproveModalOpen && activeRev && (
        <div className="modal modal-open">
          <div className="modal-box max-w-lg">
            <h3 className="font-bold text-lg text-success">
              Approve & Apply Migration
            </h3>
            <p className="py-3 text-sm text-base-content/80">
              You are about to apply revision{" "}
              <code className="font-mono font-bold">{activeRev.id}</code> to
              your live workspace.
            </p>
            <div className="p-3 bg-base-200 rounded-lg text-xs space-y-1 mb-4">
              <div>
                <strong>Revision:</strong> {activeRev.revision_num}
              </div>
              <div>
                <strong>Changed Files:</strong> {activeRev.changed_files.length}
              </div>
              <div>
                <strong>Commit Hash:</strong>{" "}
                <span className="font-mono">{activeRev.commit_hash}</span>
              </div>
              <div>
                <strong>Patch Hash:</strong>{" "}
                <span className="font-mono">{activeRev.patch_hash}</span>
              </div>
            </div>
            <p className="text-xs text-base-content/60">
              This will atomically write all proposed files to your workspace
              with rollback protection.
            </p>
            {actionError && (
              <div className="alert alert-error text-xs p-2 mt-2">
                <span>{actionError}</span>
              </div>
            )}
            <div className="modal-action">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={approving}
                onClick={() => {
                  setActionError(null);
                  setIsApproveModalOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-success text-white"
                disabled={approving}
                onClick={async () => {
                  setActionError(null);
                  setApproving(true);
                  try {
                    await onApprove(activeRev.id, activeRev.patch_hash);
                    setIsApproveModalOpen(false);
                  } catch (err) {
                    setActionError(
                      err instanceof Error ? err.message : String(err),
                    );
                  } finally {
                    setApproving(false);
                  }
                }}
              >
                {approving ? (
                  <>
                    <span className="loading loading-spinner loading-xs"></span>
                    <span>Applying...</span>
                  </>
                ) : (
                  "Confirm & Apply"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {isRejectModalOpen && latestRev && (
        <div className="modal modal-open">
          <div className="modal-box max-w-lg">
            <h3 className="font-bold text-lg text-warning">
              Reject with Comment / Request Changes
            </h3>
            <p className="py-2 text-sm text-base-content/80">
              Specify what needs to be changed in revision{" "}
              <code className="font-mono font-bold">{latestRev.id}</code>.
            </p>
            <textarea
              className="textarea textarea-bordered w-full h-28 text-sm mt-2"
              placeholder="Explain why this proposal is rejected and what adjustments should be made..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <div className="modal-action">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setIsRejectModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-warning"
                disabled={!rejectReason.trim() || submittingFeedback}
                onClick={handleConfirmReject}
              >
                Submit Rejection & Comment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
