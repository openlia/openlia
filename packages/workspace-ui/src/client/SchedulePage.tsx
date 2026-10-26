import { useCallback, useEffect, useState } from "react";
import type { WorkspaceApi } from "./api";
import type { CronOverviewResponse, HermesCronJob } from "../shared/cron";
import { getScheduleExpression } from "../shared/cron";

export interface SchedulePageProps {
  api: WorkspaceApi;
  onOpenDocument?: (path: string) => void;
}

const PROMPT_TEMPLATES = [
  {
    title: "Daily Morning Briefing",
    schedule: "0 9 * * * (9:00 AM daily)",
    prompt:
      "Lia, please schedule a daily briefing every morning at 09:00 that summarizes upcoming calendar events, financial alerts, and pending inbox items into inbox/daily-briefing.",
  },
  {
    title: "Inbox & Document Triage",
    schedule: "0 */6 * * * (Every 6 hours)",
    prompt:
      "Lia, please set up a scheduled job every 6 hours to run inbox triage on newly ingested documents and summarize them.",
  },
  {
    title: "Custom Script & Routine Check",
    schedule: "0 4 * * 1 (Mondays at 4:00 AM)",
    prompt:
      "Lia, help me write a custom Python script to check for upcoming renewals and schedule it to run every Monday at 04:00.",
  },
];

export function SchedulePage({ api, onOpenDocument }: SchedulePageProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<CronOverviewResponse | null>(null);

  // Modal states
  const [guideModalOpen, setGuideModalOpen] = useState(false);
  const [inspectingJob, setInspectingJob] = useState<HermesCronJob | null>(
    null,
  );
  const [deletingJob, setDeletingJob] = useState<HermesCronJob | null>(null);

  // Copy feedback states
  const [copiedTemplate, setCopiedTemplate] = useState<string | null>(null);
  const [copiedRevision, setCopiedRevision] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.loadCronJobs();
      setOverview(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load schedule data",
      );
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCopyTemplate = async (prompt: string, title: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedTemplate(title);
      setTimeout(() => setCopiedTemplate(null), 2500);
    } catch {
      // Ignore clipboard write failures in restricted environments
    }
  };

  const handleCopyRevision = async (job: HermesCronJob) => {
    const sched = getScheduleExpression(job.schedule);
    const text = `Lia, please update my scheduled task "${job.name}" (schedule: "${sched}"): `;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedRevision(true);
      setTimeout(() => setCopiedRevision(false), 2500);
    } catch {
      // Ignore clipboard write failures in restricted environments
    }
  };

  const handleToggle = async (job: HermesCronJob) => {
    setTogglingId(job.id);
    try {
      await api.toggleCronJob(job.id);
      await loadData();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to toggle task state",
      );
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deletingJob) return;
    setSubmitting(true);
    try {
      await api.deleteCronJob(deletingJob.id);
      setDeletingJob(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete task");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Page Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="workspace-eyebrow">AUTOMATION & MONITORING</p>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
              Scheduled Tasks & Automation
            </h2>
            <p className="text-sm text-base-content/70 mt-1">
              Observe Hermes scheduled agents, automated system backups, and
              policy boundaries.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-primary btn-sm gap-2"
              onClick={() => setGuideModalOpen(true)}
              type="button"
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
                  d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                />
              </svg>
              Schedule with Agent
            </button>
            <button
              className="btn btn-outline btn-sm"
              onClick={() => void loadData()}
              disabled={loading}
              type="button"
            >
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="alert alert-error text-sm rounded-xl" role="alert">
            <span>{error}</span>
            <button
              className="btn btn-ghost btn-xs ml-auto"
              onClick={() => void loadData()}
              type="button"
            >
              Retry
            </button>
          </div>
        )}

        {/* Policy Notice Banner */}
        {overview?.policy && (
          <div
            className={`rounded-2xl border p-4 md:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 ${
              overview.policy.enabled
                ? "border-success/20 bg-success/5 text-success-content"
                : "border-warning/20 bg-warning/5 text-warning-content"
            }`}
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">
                {overview.policy.enabled ? "🛡️" : "⚠️"}
              </span>
              <div>
                <h4 className="font-semibold text-base-content text-sm md:text-base">
                  Assistant Scheduled Policy is{" "}
                  {overview.policy.enabled ? "Enabled" : "Disabled"}
                </h4>
                <p className="text-xs text-base-content/70 mt-0.5">
                  {overview.policy.enabled
                    ? `Scheduled agent jobs can run authorized actions (${(
                        overview.policy.allowed_actions ?? []
                      ).join(", ")}) and report to "${
                        overview.policy.report_destination ?? "inbox"
                      }".`
                    : "Scheduled work is currently disabled in assistant-policy.yaml. Agent cron jobs will fail closed."}
                </p>
              </div>
            </div>
            {onOpenDocument && (
              <button
                className="btn btn-outline btn-sm self-start md:self-auto"
                onClick={() => onOpenDocument("assistant-policy.yaml")}
                type="button"
              >
                View Policy
              </button>
            )}
          </div>
        )}

        {/* System Schedules Section */}
        <section aria-labelledby="system-schedules-heading">
          <div className="mb-4">
            <p className="workspace-eyebrow">SYSTEM OPERATIONS</p>
            <h3
              className="mt-1 text-xl font-bold"
              id="system-schedules-heading"
            >
              System Schedules
            </h3>
            <p className="text-xs text-base-content/60 mt-0.5">
              Host-managed schedules configured in OpenLia's config.toml and
              executed via Docker sidecars.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Backup Scheduler Card */}
            <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-base flex items-center gap-2">
                    <span>🔐</span> Encrypted Backup Scheduler
                  </span>
                  <span
                    className={`badge badge-sm font-medium ${
                      overview?.system.backup.enabled
                        ? "badge-success text-success-content"
                        : "badge-ghost text-base-content/60"
                    }`}
                  >
                    {overview?.system.backup.enabled ? "Active" : "Disabled"}
                  </span>
                </div>
                <p className="text-xs text-base-content/70 leading-relaxed">
                  Automated background backups creating encrypted snapshots of
                  your workspace, agent cron jobs, and database records.
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-base-content/10 flex items-center justify-between text-xs">
                <span className="text-base-content/60">Schedule:</span>
                <span className="font-mono bg-base-200 px-2 py-0.5 rounded border border-base-content/10">
                  {overview?.system.backup.schedule || "20 4 * * *"}
                </span>
              </div>
            </div>

            {/* Workspace Git Card */}
            <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-base flex items-center gap-2">
                    <span>📦</span> Workspace Git Automation
                  </span>
                  <span
                    className={`badge badge-sm font-medium ${
                      overview?.system.workspace_git.job_found
                        ? "badge-info text-info-content"
                        : "badge-ghost text-base-content/60"
                    }`}
                  >
                    {overview?.system.workspace_git.job_found
                      ? "Active"
                      : "Disabled"}
                  </span>
                </div>
                <p className="text-xs text-base-content/70 leading-relaxed">
                  Scheduled background commits tracking changes in your local
                  workspace Git repository for audit history.
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-base-content/10 flex items-center justify-between text-xs">
                <span className="text-base-content/60">Schedule:</span>
                <span className="font-mono bg-base-200 px-2 py-0.5 rounded border border-base-content/10">
                  {overview?.system.workspace_git.schedule || "0 4 * * *"}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Hermes Cron Jobs Section */}
        <section aria-labelledby="hermes-tasks-heading">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="workspace-eyebrow">AGENT WORKFLOWS</p>
              <h3 className="mt-1 text-xl font-bold" id="hermes-tasks-heading">
                Hermes Scheduled Tasks
              </h3>
            </div>
            {overview && (
              <span className="text-xs text-base-content/60">
                {overview.jobs.length}{" "}
                {overview.jobs.length === 1 ? "task" : "tasks"} configured
              </span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center p-12 text-sm text-base-content/60">
              <span className="loading loading-spinner loading-sm mr-2" />
              Loading scheduled tasks...
            </div>
          ) : !overview || overview.jobs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-base-content/20 p-10 text-center">
              <p className="font-semibold text-base-content">
                No scheduled tasks yet
              </p>
              <p className="mt-1 text-xs text-base-content/60 max-w-md mx-auto">
                Hermes can execute recurring workflows on schedule, such as
                morning briefings, review summaries, or research intake.
              </p>
              <button
                className="btn btn-primary btn-sm mt-4 gap-2"
                onClick={() => setGuideModalOpen(true)}
                type="button"
              >
                <span>🤖</span> Schedule with Agent
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-base-content/10 bg-base-200/20">
              <table className="table w-full">
                <thead>
                  <tr className="border-b border-base-content/10 text-xs text-base-content/50 uppercase tracking-wider">
                    <th>Name</th>
                    <th>Schedule</th>
                    <th>Prompt</th>
                    <th>Skills</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base-content/5 text-sm">
                  {overview.jobs.map((job) => {
                    const schedExpr = getScheduleExpression(job.schedule);
                    const isSystemJob =
                      job.name === "openlia-workspace-git" ||
                      job.id === "openlia-workspace-git";
                    return (
                      <tr
                        key={job.id}
                        className="hover:bg-base-200/40 transition"
                      >
                        <td className="font-medium">
                          <div>{job.name}</div>
                          {isSystemJob && (
                            <span className="badge badge-xs badge-info/20 text-info mt-1">
                              System Managed
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="font-mono text-xs bg-base-200 px-2 py-1 rounded border border-base-content/10">
                            {schedExpr || "No schedule"}
                          </span>
                        </td>
                        <td
                          className="max-w-xs truncate text-xs text-base-content/70"
                          title={job.prompt}
                        >
                          {job.prompt}
                        </td>
                        <td>
                          {job.skills && job.skills.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {job.skills.map((s) => (
                                <span
                                  key={s}
                                  className="badge badge-ghost badge-xs font-mono"
                                >
                                  {s}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-base-content/40 text-xs">
                              —
                            </span>
                          )}
                        </td>
                        <td>
                          <span
                            className={`badge badge-sm font-medium ${
                              job.state === "scheduled"
                                ? "badge-success text-success-content"
                                : "badge-warning/80 text-warning-content"
                            }`}
                          >
                            {job.state === "scheduled" ? "Scheduled" : "Paused"}
                          </span>
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              className="btn btn-ghost btn-xs"
                              disabled={togglingId === job.id}
                              onClick={() => void handleToggle(job)}
                              title={
                                job.state === "scheduled"
                                  ? "Pause Task"
                                  : "Resume Task"
                              }
                              type="button"
                            >
                              {togglingId === job.id ? (
                                <span className="loading loading-spinner loading-xs" />
                              ) : job.state === "scheduled" ? (
                                "Pause"
                              ) : (
                                "Resume"
                              )}
                            </button>
                            <button
                              className="btn btn-ghost btn-xs"
                              onClick={() => setInspectingJob(job)}
                              title="Inspect Task Details"
                              type="button"
                            >
                              Inspect
                            </button>
                            {!isSystemJob && (
                              <button
                                className="btn btn-ghost btn-xs text-error hover:bg-error/10"
                                onClick={() => setDeletingJob(job)}
                                title="Delete Task"
                                type="button"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Schedule with Agent Guide Modal */}
        {guideModalOpen && (
          <div className="modal modal-open">
            <div className="modal-box max-w-2xl">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-bold text-lg flex items-center gap-2">
                    <span>🤖</span> Schedule a Task with Your Agent
                  </h3>
                  <p className="text-xs text-base-content/60 mt-1">
                    In OpenLia, scheduled tasks are composed and managed through
                    conversation with your agent (via Telegram, Workspace UI
                    Chat, or chat session).
                  </p>
                </div>
                <button
                  className="btn btn-ghost btn-xs btn-circle"
                  onClick={() => setGuideModalOpen(false)}
                  type="button"
                >
                  ✕
                </button>
              </div>

              <div className="mt-4 space-y-4 text-xs">
                {/* Why Agent banner */}
                <div className="rounded-lg bg-base-200/60 p-3.5 border border-base-content/10">
                  <p className="font-semibold text-base-content mb-1 text-sm">
                    Why work with Lia instead of a simple form?
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-base-content/70 leading-relaxed">
                    <li>
                      <strong>Complex Workflows:</strong> Lia can author helper
                      Python scripts in <code>skills/</code> or{" "}
                      <code>workspace/</code> to parse feeds, process data, or
                      format reports.
                    </li>
                    <li>
                      <strong>Safety & Policy Compliance:</strong> Lia checks{" "}
                      <code>assistant-policy.yaml</code> permissions (e.g.{" "}
                      <code>generate_reports</code>) and tests prompts before
                      scheduling.
                    </li>
                    <li>
                      <strong>Interactive Review:</strong> Lia proposes the
                      exact cron timing and parameter bindings for your
                      confirmation.
                    </li>
                  </ul>
                </div>

                {/* Prompt Templates */}
                <div>
                  <p className="font-semibold text-base-content uppercase tracking-wider text-[11px] mb-2">
                    Ready-to-Use Prompt Templates
                  </p>
                  <div className="space-y-2.5">
                    {PROMPT_TEMPLATES.map((tmpl) => (
                      <div
                        key={tmpl.title}
                        className="rounded-lg border border-base-content/10 bg-base-100 p-3 flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-base-content">
                            {tmpl.title}
                          </span>
                          <span className="badge badge-ghost badge-xs font-mono">
                            {tmpl.schedule}
                          </span>
                        </div>
                        <p className="font-mono text-[11px] bg-base-200/50 p-2.5 rounded text-base-content/80 select-all leading-relaxed">
                          {tmpl.prompt}
                        </p>
                        <div className="flex justify-end">
                          <button
                            className="btn btn-xs btn-outline gap-1"
                            onClick={() =>
                              void handleCopyTemplate(tmpl.prompt, tmpl.title)
                            }
                            type="button"
                          >
                            {copiedTemplate === tmpl.title ? (
                              <>
                                <span className="text-success">✓</span> Copied!
                              </>
                            ) : (
                              <>Copy Prompt for Chat</>
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Policy Notice */}
                <div className="flex items-center justify-between rounded-lg border border-info/20 bg-info/5 p-3 text-info text-xs">
                  <div>
                    <p className="font-semibold">Assistant Policy Check</p>
                    <p className="text-[11px] opacity-80 mt-0.5">
                      Ensure <code>scheduled_work.enabled</code> is set to true
                      in <code>assistant-policy.yaml</code> for automated runs.
                    </p>
                  </div>
                  {onOpenDocument && (
                    <button
                      className="btn btn-info btn-xs btn-outline"
                      onClick={() => {
                        setGuideModalOpen(false);
                        onOpenDocument("assistant-policy.yaml");
                      }}
                      type="button"
                    >
                      View Policy
                    </button>
                  )}
                </div>
              </div>

              <div className="modal-action mt-4">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setGuideModalOpen(false)}
                  type="button"
                >
                  Got It
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Task Details & Prompt Inspector Modal */}
        {inspectingJob && (
          <div className="modal modal-open">
            <div className="modal-box max-w-xl">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-bold text-lg flex items-center gap-2">
                    <span>📋</span> Task Details & Agent Prompt
                  </h3>
                  <p className="text-xs text-base-content/60 mt-1">
                    Inspect scheduled execution instructions and generate
                    revision prompts for chat.
                  </p>
                </div>
                <button
                  className="btn btn-ghost btn-xs btn-circle"
                  onClick={() => setInspectingJob(null)}
                  type="button"
                >
                  ✕
                </button>
              </div>

              <div className="mt-4 space-y-3.5 text-xs">
                <div className="grid grid-cols-2 gap-3 bg-base-200/40 p-3.5 rounded-lg border border-base-content/10">
                  <div>
                    <span className="text-base-content/50 uppercase tracking-wider text-[10px] block font-semibold">
                      Task Name
                    </span>
                    <span className="font-semibold text-base-content text-sm mt-0.5 block">
                      {inspectingJob.name}
                    </span>
                  </div>
                  <div>
                    <span className="text-base-content/50 uppercase tracking-wider text-[10px] block font-semibold">
                      Status
                    </span>
                    <span
                      className={`badge badge-sm mt-1 font-medium ${
                        inspectingJob.state === "scheduled"
                          ? "badge-success text-success-content"
                          : "badge-warning/80 text-warning-content"
                      }`}
                    >
                      {inspectingJob.state === "scheduled"
                        ? "Scheduled (Active)"
                        : "Paused"}
                    </span>
                  </div>
                  <div>
                    <span className="text-base-content/50 uppercase tracking-wider text-[10px] block font-semibold">
                      Cron Schedule
                    </span>
                    <span className="font-mono text-xs font-semibold bg-base-200 px-2 py-0.5 rounded border border-base-content/10 inline-block mt-1">
                      {getScheduleExpression(inspectingJob.schedule)}
                    </span>
                  </div>
                  <div>
                    <span className="text-base-content/50 uppercase tracking-wider text-[10px] block font-semibold">
                      Attached Skills
                    </span>
                    <span className="text-xs mt-1 block">
                      {inspectingJob.skills &&
                      inspectingJob.skills.length > 0 ? (
                        inspectingJob.skills.join(", ")
                      ) : (
                        <span className="text-base-content/40">None</span>
                      )}
                    </span>
                  </div>
                </div>

                <div>
                  <span className="text-base-content/70 font-semibold uppercase tracking-wider text-[11px] block mb-1">
                    Execution Prompt
                  </span>
                  <pre className="font-mono text-xs bg-base-200/80 p-3 rounded-lg border border-base-content/10 whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed select-all">
                    {inspectingJob.prompt}
                  </pre>
                </div>

                {/* Revise via chat box */}
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3.5 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-primary">
                      Need to edit or revise this task?
                    </span>
                    <button
                      className="btn btn-primary btn-xs gap-1"
                      onClick={() => void handleCopyRevision(inspectingJob)}
                      type="button"
                    >
                      {copiedRevision ? (
                        <>
                          <span className="text-success">✓</span> Copied!
                        </>
                      ) : (
                        <>Copy Prompt to Revise in Chat</>
                      )}
                    </button>
                  </div>
                  <p className="text-[11px] text-base-content/70">
                    Ask Lia via Telegram or Workspace UI Chat to adjust the
                    prompt, change timing, or bind new skills.
                  </p>
                </div>
              </div>

              <div className="modal-action mt-4">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setInspectingJob(null)}
                  type="button"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {deletingJob && (
          <div className="modal modal-open">
            <div className="modal-box max-w-sm">
              <h3 className="font-bold text-lg text-error">
                Delete Scheduled Task?
              </h3>
              <p className="text-sm text-base-content/70 mt-2">
                Are you sure you want to delete{" "}
                <span className="font-semibold text-base-content">
                  {deletingJob.name}
                </span>
                ? This task will no longer run.
              </p>
              <div className="modal-action mt-6">
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={submitting}
                  onClick={() => setDeletingJob(null)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="btn btn-error btn-sm"
                  disabled={submitting}
                  onClick={() => void handleDelete()}
                  type="button"
                >
                  {submitting ? "Deleting..." : "Delete Task"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
