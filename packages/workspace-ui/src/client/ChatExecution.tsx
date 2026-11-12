import { useRef, useState } from "react";
import { terminalChatStatuses, type ChatRun } from "../shared/chat";

function label(status: string) {
  if (status === "unknown") return "Execution outcome unknown";
  if (status === "rejected") return "Request rejected before run acceptance";
  return `Execution ${status.replaceAll("_", " ")}`;
}

function explanation(status: string) {
  if (status === "unknown")
    return "Acceptance or the final outcome could not be confirmed. Sending is blocked; inspect the saved conversation and workspace before continuing.";
  if (status === "rejected")
    return "Hermes refused the submission before accepting a run. No automatic resend was performed.";
  if (status === "completed")
    return "Execution finished. Inspect the saved conversation and records to verify the result.";
  if (terminalChatStatuses.has(status))
    return "Execution ended, but tools may already have changed workspace records. Inspect their results before sending another request. No automatic resend was performed.";
  return "The agent may still be working. Refreshing or reopening this conversation does not resend the request.";
}

export function formatDuration(start?: number, end?: number): string | null {
  if (
    typeof start !== "number" ||
    !Number.isFinite(start) ||
    typeof end !== "number" ||
    !Number.isFinite(end) ||
    end < start
  ) {
    return null;
  }
  const ms = end - start;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 1) return `${ms}ms`;
  const seconds = totalSec % 60;
  const minutes = Math.floor(totalSec / 60) % 60;
  const hours = Math.floor(totalSec / 3600);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 21h5v-5" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function AlertOctagonIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function AlertTriangleIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`animate-spin ${className ?? ""}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  );
}

function statusThemeConfig(status: string) {
  if (status === "completed") {
    return {
      container: "border-success/30 bg-success/5 text-base-content",
      badge: "badge-success text-success-content",
      icon: <CheckIcon className="h-3.5 w-3.5" />,
      isAlert: false,
    };
  }
  if (status === "failed" || status === "rejected") {
    return {
      container: "border-error/30 bg-error/5 text-base-content",
      badge: "badge-error text-error-content",
      icon: <AlertOctagonIcon className="h-3.5 w-3.5" />,
      isAlert: true,
    };
  }
  if (status === "cancelled" || status === "interrupted") {
    return {
      container: "border-warning/30 bg-warning/5 text-base-content",
      badge: "badge-warning text-warning-content",
      icon: <AlertTriangleIcon className="h-3.5 w-3.5" />,
      isAlert: true,
    };
  }
  if (status === "unknown" || status === "waiting_for_approval") {
    return {
      container: "border-warning/30 bg-warning/5 text-base-content",
      badge: "badge-warning text-warning-content",
      icon: <AlertTriangleIcon className="h-3.5 w-3.5" />,
      isAlert: true,
    };
  }
  if (status === "running" || status === "queued" || status === "starting") {
    return {
      container: "border-info/30 bg-info/5 text-base-content",
      badge: "badge-info text-info-content",
      icon: <SpinnerIcon className="h-3.5 w-3.5" />,
      isAlert: false,
    };
  }
  return {
    container: "border-base-300 bg-base-200/40 text-base-content",
    badge: "badge-ghost",
    icon: <ClockIcon className="h-3.5 w-3.5" />,
    isAlert: false,
  };
}

function times(run: ChatRun) {
  const duration = formatDuration(run.submitted_at, run.status_observed_at);
  const elements = [];
  if (duration) {
    elements.push(
      <span
        key="duration"
        className="inline-flex items-center gap-1 font-medium text-base-content"
      >
        <ClockIcon className="h-3.5 w-3.5 opacity-70" />
        <span>Duration: {duration}</span>
      </span>,
    );
  }
  if (
    typeof run.submitted_at === "number" &&
    Number.isFinite(run.submitted_at)
  ) {
    const date = new Date(run.submitted_at);
    if (Number.isFinite(date.getTime())) {
      elements.push(
        <span key="submitted" className="inline-flex items-center gap-1">
          <CalendarIcon className="h-3.5 w-3.5 opacity-70" />
          <span>
            Submitted:{" "}
            <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
          </span>
        </span>,
      );
    }
  }
  if (
    typeof run.status_observed_at === "number" &&
    Number.isFinite(run.status_observed_at)
  ) {
    const date = new Date(run.status_observed_at);
    if (Number.isFinite(date.getTime())) {
      elements.push(
        <span key="status_observed" className="inline-flex items-center gap-1">
          <span>
            Status observed:{" "}
            <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
          </span>
        </span>,
      );
    }
  }
  return elements;
}

export function ChatExecution({
  run,
  history,
  hasMore,
  busy,
  historyError,
  onRefresh,
  onRefreshRun,
  onMore,
}: {
  run: ChatRun | null;
  history: ChatRun[];
  hasMore: boolean;
  busy: boolean;
  historyError: string;
  onRefresh: () => void;
  onRefreshRun: (id: string) => void;
  onMore: () => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyRunId = (id: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard
      .writeText(id)
      .then(() => {
        setCopiedId(id);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopiedId(null), 2000);
      })
      .catch(() => {});
  };

  const entries = [...history];
  if (run) {
    const index = entries.findIndex(
      (entry) =>
        Boolean(run.request_id && entry.request_id === run.request_id) ||
        Boolean(run.run_id && entry.run_id === run.run_id),
    );
    if (index < 0) entries.unshift(run);
    else entries[index] = run;
  }
  if (!run && !entries.length && !historyError) return null;

  const theme = run
    ? statusThemeConfig(run.status)
    : statusThemeConfig("unknown");

  return (
    <section
      aria-label="Chat execution"
      className={`chat-run-status chat-execution w-full max-w-[48rem] mx-auto my-3 rounded-xl border p-3.5 sm:p-4 text-sm transition-colors ${theme.container}`}
    >
      {run && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                role="status"
                className={`badge badge-sm font-semibold gap-1.5 ${theme.badge}`}
              >
                {theme.icon}
                {label(run.status)}
              </span>
              {run.run_id ? (
                <div className="inline-flex items-center gap-1.5 rounded-md border border-base-300/80 bg-base-200/60 px-2 py-0.5 text-xs font-mono">
                  <span className="opacity-70">Run ID:</span>
                  <code className="select-all font-semibold">{run.run_id}</code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-square h-5 min-h-0 w-5"
                    title={copiedId === run.run_id ? "Copied!" : "Copy Run ID"}
                    aria-label={
                      copiedId === run.run_id ? "Copied" : "Copy Run ID"
                    }
                    onClick={() => copyRunId(run.run_id)}
                  >
                    {copiedId === run.run_id ? (
                      <CheckIcon className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <CopyIcon className="h-3.5 w-3.5 opacity-70 hover:opacity-100" />
                    )}
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-xs gap-1.5 text-base-content/80 hover:text-base-content"
              disabled={busy}
              onClick={onRefresh}
            >
              <RefreshIcon
                className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
              />
              <span>Refresh execution status</span>
            </button>
          </div>

          {theme.isAlert ? (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-content">
              <p className="font-medium">{explanation(run.status)}</p>
              {run.status_source === "recorded" && (
                <p className="mt-1 opacity-90">
                  Last recorded status. Live Hermes run metadata is no longer
                  available.
                </p>
              )}
              {run.status_source === "unconfirmed" && (
                <p className="mt-1 opacity-90">
                  No run acceptance was confirmed; an empty run ID is not proof
                  that nothing executed.
                </p>
              )}
            </div>
          ) : (
            <div className="text-xs text-base-content/80 leading-relaxed">
              <p>{explanation(run.status)}</p>
              {run.status_source === "recorded" && (
                <p className="mt-1 opacity-75">
                  Last recorded status. Live Hermes run metadata is no longer
                  available.
                </p>
              )}
              {run.status_source === "unconfirmed" && (
                <p className="mt-1 opacity-75">
                  No run acceptance was confirmed; an empty run ID is not proof
                  that nothing executed.
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs opacity-75 pt-0.5">
            {times(run)}
          </div>
        </div>
      )}

      {!run && (
        <button
          type="button"
          className="btn btn-ghost btn-xs gap-1.5"
          disabled={busy}
          onClick={onRefresh}
        >
          <RefreshIcon
            className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
          />
          <span>Refresh execution status</span>
        </button>
      )}

      {historyError && (
        <p role="alert" className="mt-2 text-xs text-error">
          Execution history could not be loaded: {historyError}. Refresh to
          inspect it; no request was resent.
        </p>
      )}

      {entries.length > 0 && (
        <details className="chat-execution-history group mt-3 rounded-lg border border-base-300/70 bg-base-100/40 text-xs">
          <summary className="cursor-pointer select-none px-3.5 py-2 font-medium hover:bg-base-200/50">
            <span className="inline-flex items-center gap-1.5 mr-2">
              <ChevronIcon className="chat-execution-chevron h-3.5 w-3.5 transition-transform duration-200" />
            </span>
            Execution history ({entries.length}
            {hasMore ? "+" : ""})
          </summary>
          <div className="border-t border-base-300/60 p-3">
            <p className="opacity-70 text-[11px] leading-relaxed">
              Newest submissions first. Recorded statuses are observations, not
              proof that no workspace changes occurred. Older non-terminal
              observations must be refreshed before relying on them.
            </p>
            <ol className="mt-2.5 space-y-2">
              {entries.map((entry, index) => {
                const entryTheme = statusThemeConfig(entry.status);
                const entryKey =
                  entry.request_id ?? (entry.run_id || `unconfirmed-${index}`);
                return (
                  <li
                    key={entryKey}
                    className="rounded-md border border-base-300/60 bg-base-200/30 p-2.5 break-words"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <strong
                          className={`badge badge-xs font-semibold ${entryTheme.badge}`}
                        >
                          {label(entry.status)}
                        </strong>
                        <span className="badge badge-xs badge-ghost opacity-70">
                          {entry.status_source === "hermes"
                            ? "Reported by Hermes"
                            : entry.status_source === "unconfirmed"
                              ? "Submission outcome unconfirmed"
                              : "Last recorded observation"}
                        </span>
                      </div>
                      {entry.run_id ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs gap-1 h-6 min-h-0 text-[11px]"
                          disabled={busy}
                          onClick={() => onRefreshRun(entry.run_id)}
                        >
                          <RefreshIcon
                            className={`h-3 w-3 ${busy ? "animate-spin" : ""}`}
                          />
                          <span>Refresh run {entry.run_id}</span>
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {entry.run_id ? (
                        <div className="inline-flex items-center gap-1 font-mono text-[11px]">
                          <span className="opacity-60">Run ID:</span>
                          <code className="select-all font-semibold">
                            {entry.run_id}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs btn-square h-4 min-h-0 w-4"
                            title={
                              copiedId === entry.run_id
                                ? "Copied!"
                                : "Copy Run ID"
                            }
                            aria-label={`Copy run ID ${entry.run_id}`}
                            onClick={() => copyRunId(entry.run_id)}
                          >
                            {copiedId === entry.run_id ? (
                              <CheckIcon className="h-3 w-3 text-success" />
                            ) : (
                              <CopyIcon className="h-3 w-3 opacity-60" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] opacity-60">
                          No confirmed run ID
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] opacity-70">
                      {times(entry)}
                    </div>
                  </li>
                );
              })}
            </ol>
            {hasMore && (
              <button
                type="button"
                className="btn btn-ghost btn-xs mt-2.5 w-full border border-base-300/80"
                disabled={busy}
                onClick={onMore}
              >
                Load earlier executions
              </button>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
