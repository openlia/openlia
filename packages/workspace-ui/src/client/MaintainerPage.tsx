import { useCallback, useEffect, useState } from "react";
import type {
  MaintainerFinding,
  MaintainerOverviewResponse,
} from "../shared/api";
import type { WorkspaceApi } from "./api";
import { MaintainerFixModal } from "./MaintainerFixModal";

export type MaintainerViewTab = "open" | "ignored" | "resolved" | "collections";

export interface MaintainerPageProps {
  api: WorkspaceApi;
  onOpenFile: (path: string) => void;
  onOpenProject?: ((projectPath: string) => void) | undefined;
  onAskLia?: ((prompt: string) => void) | undefined;
  onChanged?: (() => void) | undefined;
}

export function MaintainerPage({
  api,
  onOpenFile,
  onOpenProject,
  onAskLia,
  onChanged,
}: MaintainerPageProps) {
  const [overview, setOverview] = useState<MaintainerOverviewResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [auditing, setAuditing] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<MaintainerViewTab>("open");
  const [busyIssueId, setBusyIssueId] = useState<string | null>(null);
  const [fixModalFinding, setFixModalFinding] =
    useState<MaintainerFinding | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.loadMaintainerOverview();
      setOverview(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load Workspace Maintainer overview",
      );
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleRunAudit = async () => {
    setAuditing(true);
    setError("");
    try {
      const data = await api.runMaintainerAudit();
      setOverview(data);
      onChanged?.();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to run workspace audit",
      );
    } finally {
      setAuditing(false);
    }
  };

  const handleIgnore = async (finding: MaintainerFinding) => {
    setBusyIssueId(finding.issue_id);
    setError("");
    try {
      await api.ignoreMaintainerIssue(finding.issue_id);
      await loadOverview();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to ignore finding");
    } finally {
      setBusyIssueId(null);
    }
  };

  const handleRestore = async (finding: MaintainerFinding) => {
    setBusyIssueId(finding.issue_id);
    setError("");
    try {
      await api.restoreMaintainerIssue(finding.issue_id);
      await loadOverview();
      onChanged?.();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to restore warning",
      );
    } finally {
      setBusyIssueId(null);
    }
  };

  const scanState = overview?.scan_state;
  const counts = overview?.counts ?? {
    open: 0,
    ignored: 0,
    resolved: 0,
    suggestions: 0,
    collections: 0,
  };

  return (
    <div
      className="flex-1 overflow-y-auto bg-base-100 p-4 sm:p-6 lg:p-8"
      data-testid="maintainer-page"
    >
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <header className="flex flex-col gap-4 border-b border-base-content/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="workspace-eyebrow">OPENLIA / WORKSPACE MAINTAINER</p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
              Workspace Maintainer
            </h2>
            <p className="mt-1 max-w-2xl text-xs sm:text-sm text-base-content/60">
              Create freely. Validate automatically. Fix when useful. Ignore
              intentionally. Structural findings are advisory and never block
              saving content.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {scanState && (
              <span
                className={`badge badge-sm font-mono ${
                  scanState.coverage_status === "complete"
                    ? "badge-success badge-outline"
                    : "badge-warning"
                }`}
                title={`Scanned ${scanState.files_scanned} files (${scanState.files_skipped} skipped)`}
              >
                {scanState.coverage_status === "complete"
                  ? `Scan complete (${scanState.files_scanned} files)`
                  : `Partial scan (${scanState.scan_errors.length} error${scanState.scan_errors.length === 1 ? "" : "s"})`}
              </span>
            )}
            <button
              className="btn btn-primary btn-sm"
              disabled={auditing || loading}
              onClick={() => void handleRunAudit()}
              type="button"
            >
              {auditing ? (
                <>
                  <span className="loading loading-spinner loading-xs" />
                  <span>Auditing...</span>
                </>
              ) : (
                "Run Audit"
              )}
            </button>
          </div>
        </header>

        {/* Partial Scan Notice */}
        {scanState && scanState.coverage_status === "partial" && (
          <div className="alert alert-warning text-xs" role="status">
            <div>
              <p className="font-semibold">
                Workspace scan was incomplete ({scanState.scan_errors.length}{" "}
                unreadable path{scanState.scan_errors.length === 1 ? "" : "s"}).
              </p>
              <ul className="mt-1 list-disc list-inside opacity-80">
                {scanState.scan_errors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {error && (
          <div className="alert alert-error text-xs" role="alert">
            <span>{error}</span>
          </div>
        )}

        {/* Summary Stat Cards / Tab Selectors */}
        <div
          aria-label="Workspace Maintainer views"
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          role="tablist"
        >
          <button
            aria-selected={activeTab === "open"}
            className={`rounded-xl border p-4 text-left transition ${
              activeTab === "open"
                ? "border-primary bg-primary/10 shadow-xs"
                : "border-base-content/10 bg-base-200/30 hover:bg-base-200/60"
            }`}
            onClick={() => setActiveTab("open")}
            role="tab"
            type="button"
          >
            <span className="text-xs uppercase tracking-wider text-base-content/60">
              Open Warnings
            </span>
            <p className="mt-1 text-2xl font-bold">{counts.open}</p>
            <span className="text-xs text-base-content/50">
              Active contract findings
            </span>
          </button>

          <button
            aria-selected={activeTab === "ignored"}
            className={`rounded-xl border p-4 text-left transition ${
              activeTab === "ignored"
                ? "border-primary bg-primary/10 shadow-xs"
                : "border-base-content/10 bg-base-200/30 hover:bg-base-200/60"
            }`}
            onClick={() => setActiveTab("ignored")}
            role="tab"
            type="button"
          >
            <span className="text-xs uppercase tracking-wider text-base-content/60">
              Ignored
            </span>
            <p className="mt-1 text-2xl font-bold">{counts.ignored}</p>
            <span className="text-xs text-base-content/50">
              Suppressed in exact file
            </span>
          </button>

          <button
            aria-selected={activeTab === "resolved"}
            className={`rounded-xl border p-4 text-left transition ${
              activeTab === "resolved"
                ? "border-primary bg-primary/10 shadow-xs"
                : "border-base-content/10 bg-base-200/30 hover:bg-base-200/60"
            }`}
            onClick={() => setActiveTab("resolved")}
            role="tab"
            type="button"
          >
            <span className="text-xs uppercase tracking-wider text-base-content/60">
              Resolved
            </span>
            <p className="mt-1 text-2xl font-bold">{counts.resolved}</p>
            <span className="text-xs text-base-content/50">
              Verified by revalidation
            </span>
          </button>

          <button
            aria-selected={activeTab === "collections"}
            className={`rounded-xl border p-4 text-left transition ${
              activeTab === "collections"
                ? "border-primary bg-primary/10 shadow-xs"
                : "border-base-content/10 bg-base-200/30 hover:bg-base-200/60"
            }`}
            onClick={() => setActiveTab("collections")}
            role="tab"
            type="button"
          >
            <span className="text-xs uppercase tracking-wider text-base-content/60">
              Discovered Collections
            </span>
            <p className="mt-1 text-2xl font-bold">{counts.collections}</p>
            <span className="text-xs text-base-content/50">
              Folders, templates & projects
            </span>
          </button>
        </div>

        {/* Main Tab Content */}
        {loading && !overview ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm text-base-content/60">
            <span className="loading loading-spinner loading-md text-primary" />
            <span>Loading Workspace Maintainer...</span>
          </div>
        ) : activeTab === "open" ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/70">
                Open Contract Findings ({overview?.open_findings.length ?? 0})
              </h3>
            </div>
            {(overview?.open_findings.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-base-content/10 bg-base-200/20 p-8 text-center">
                <p className="text-base font-semibold text-success">
                  {scanState?.coverage_status === "partial"
                    ? "No open warnings found in scanned files (scan incomplete)"
                    : "All scanned files conform to their active contracts"}
                </p>
                <p className="mt-1 text-xs text-base-content/60">
                  Free-form folders and notes without templates or schemas are
                  valid by default.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-base-content/10 rounded-xl border border-base-content/15 bg-base-100">
                {overview?.open_findings.map((finding) => (
                  <div
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
                    key={finding.issue_id}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          className="font-mono text-xs font-semibold text-primary hover:underline"
                          onClick={() => onOpenFile(finding.relative_path)}
                          type="button"
                        >
                          {finding.relative_path}
                        </button>
                        <span className="badge badge-warning badge-xs font-mono">
                          {finding.rule_code}
                        </span>
                        <span className="badge badge-ghost badge-xs font-mono">
                          {finding.subject}
                        </span>
                        {finding.fix_strategy === "deterministic" && (
                          <span className="badge badge-success badge-outline badge-xs">
                            Instant Fix
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-medium">{finding.message}</p>
                      <p className="text-xs text-base-content/60">
                        {finding.explanation}
                      </p>
                      {finding.contract_path && (
                        <p className="text-[11px] font-mono text-base-content/50">
                          Contract:{" "}
                          <button
                            className="link link-hover text-primary"
                            onClick={() => {
                              if (finding.contract_path) {
                                onOpenFile(finding.contract_path);
                              }
                            }}
                            type="button"
                          >
                            {finding.contract_path}
                          </button>
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <button
                        className="btn btn-primary btn-xs"
                        disabled={busyIssueId === finding.issue_id}
                        onClick={() => setFixModalFinding(finding)}
                        type="button"
                      >
                        {finding.fix_strategy === "deterministic"
                          ? "Fix"
                          : "Fix with Lia"}
                      </button>
                      <button
                        className="btn btn-outline btn-xs"
                        disabled={busyIssueId === finding.issue_id}
                        onClick={() => void handleIgnore(finding)}
                        title="Suppress this specific issue in this exact file"
                        type="button"
                      >
                        Ignore
                      </button>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => onOpenFile(finding.relative_path)}
                        type="button"
                      >
                        Open File
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : activeTab === "ignored" ? (
          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/70">
              Ignored Findings ({overview?.ignored_findings.length ?? 0})
            </h3>
            {(overview?.ignored_findings.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-base-content/10 bg-base-200/20 p-8 text-center text-xs text-base-content/60">
                No ignored warnings. Ignored issues are scoped to an exact file
                and rule subject.
              </div>
            ) : (
              <div className="divide-y divide-base-content/10 rounded-xl border border-base-content/15 bg-base-100">
                {overview?.ignored_findings.map((finding) => (
                  <div
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
                    key={finding.issue_id}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          className="font-mono text-xs font-semibold text-primary hover:underline"
                          onClick={() => onOpenFile(finding.relative_path)}
                          type="button"
                        >
                          {finding.relative_path}
                        </button>
                        <span className="badge badge-ghost badge-xs font-mono">
                          {finding.rule_code}
                        </span>
                        <span className="badge badge-ghost badge-xs font-mono">
                          {finding.subject}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-base-content/80">
                        {finding.message}
                      </p>
                      {finding.ignore_reason && (
                        <p className="text-xs italic text-base-content/60">
                          Reason: {finding.ignore_reason}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        className="btn btn-outline btn-xs"
                        disabled={busyIssueId === finding.issue_id}
                        onClick={() => void handleRestore(finding)}
                        type="button"
                      >
                        Restore warning
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : activeTab === "resolved" ? (
          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/70">
              Resolved Findings ({overview?.resolved_findings.length ?? 0})
            </h3>
            {(overview?.resolved_findings.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-base-content/10 bg-base-200/20 p-8 text-center text-xs text-base-content/60">
                No resolved findings recorded yet.
              </div>
            ) : (
              <div className="divide-y divide-base-content/10 rounded-xl border border-base-content/15 bg-base-100">
                {overview?.resolved_findings.map((finding) => (
                  <div
                    className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
                    key={finding.issue_id}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          className="font-mono text-xs font-semibold text-primary hover:underline"
                          onClick={() => onOpenFile(finding.relative_path)}
                          type="button"
                        >
                          {finding.relative_path}
                        </button>
                        <span className="badge badge-success badge-outline badge-xs font-mono">
                          Resolved
                        </span>
                        <span className="badge badge-ghost badge-xs font-mono">
                          {finding.rule_code} ({finding.subject})
                        </span>
                      </div>
                      <p className="text-xs text-base-content/70">
                        {finding.message}
                      </p>
                    </div>
                    {finding.resolved_at && (
                      <span className="font-mono text-[11px] text-base-content/50">
                        {new Date(finding.resolved_at).toLocaleString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/70">
                Discovered Collections ({overview?.collections.length ?? 0})
              </h3>
              <p className="mt-1 text-xs text-base-content/60">
                Discovered automatically from workspace folders, local{" "}
                <code>*-template.md</code> files, schemas, and{" "}
                <code>project-manifest.toml</code>. No registration file is
                required.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {overview?.collections.map((col) => (
                <div
                  className="rounded-xl border border-base-content/10 bg-base-200/25 p-4 space-y-2"
                  key={col.path}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm">{col.label}</span>
                        <span className="badge badge-ghost badge-xs font-mono">
                          {col.kind}
                        </span>
                      </div>
                      <p className="font-mono text-xs text-base-content/50">
                        {col.path}/
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {col.open_finding_count > 0 && (
                        <span className="badge badge-warning badge-xs font-mono">
                          {col.open_finding_count} open
                        </span>
                      )}
                      <span className="badge badge-outline badge-xs font-mono">
                        {col.record_count} rec
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-base-content/70">
                    {col.inferred_purpose}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] font-mono">
                    {col.template_path && (
                      <button
                        className="link link-primary"
                        onClick={() => {
                          if (col.template_path) {
                            onOpenFile(col.template_path);
                          }
                        }}
                        type="button"
                      >
                        Template: {col.template_path}
                      </button>
                    )}
                    {col.schema_path && (
                      <button
                        className="link link-primary"
                        onClick={() => {
                          if (col.schema_path) {
                            onOpenFile(col.schema_path);
                          }
                        }}
                        type="button"
                      >
                        Schema: {col.schema_path}
                      </button>
                    )}
                    {col.manifest_path && onOpenProject && (
                      <button
                        className="btn btn-primary btn-outline btn-xs ml-auto"
                        onClick={() => onOpenProject(col.path)}
                        type="button"
                      >
                        Open Project UI →
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Optional Organizational Suggestions */}
            {(overview?.suggestions.length ?? 0) > 0 && (
              <div className="space-y-3 pt-4 border-t border-base-content/10">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
                  Optional Organizational Suggestions (
                  {overview?.suggestions.length})
                </h4>
                <div className="divide-y divide-base-content/10 rounded-xl border border-base-content/10 bg-base-200/20">
                  {overview?.suggestions.map((sug) => (
                    <div
                      className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between text-xs"
                      key={sug.issue_id}
                    >
                      <div>
                        <p className="font-medium">{sug.message}</p>
                        <p className="text-base-content/60">
                          {sug.explanation}
                        </p>
                      </div>
                      <button
                        className="btn btn-ghost btn-xs shrink-0"
                        onClick={() => void handleIgnore(sug)}
                        type="button"
                      >
                        Dismiss suggestion
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>

      <MaintainerFixModal
        api={api}
        finding={fixModalFinding}
        onApplied={() => {
          void loadOverview();
          onChanged?.();
        }}
        onAskLia={onAskLia}
        onClose={() => setFixModalFinding(null)}
      />
    </div>
  );
}
