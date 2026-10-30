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

function times(run: ChatRun) {
  return [
    ["Submitted", run.submitted_at],
    ["Status observed", run.status_observed_at],
  ].flatMap(([name, value]) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return [];
    return [
      <span key={String(name)}>
        {name}:{" "}
        <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
      </span>,
    ];
  });
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
  return (
    <section
      aria-label="Chat execution"
      className="mx-3 my-2 rounded-lg border border-base-300 p-3 text-sm"
    >
      {run && (
        <>
          <p role="status" className="font-medium">
            {label(run.status)}
          </p>
          {run.run_id && (
            <p className="break-all">
              Run ID: <code>{run.run_id}</code>
            </p>
          )}
          <p>{explanation(run.status)}</p>
          {run.status_source === "recorded" && (
            <p>
              Last recorded status. Live Hermes run metadata is no longer
              available.
            </p>
          )}
          {run.status_source === "unconfirmed" && (
            <p>
              No run acceptance was confirmed; an empty run ID is not proof that
              nothing executed.
            </p>
          )}
          <div className="flex flex-wrap gap-x-3 text-xs opacity-70">
            {times(run)}
          </div>
        </>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-xs mt-2"
        disabled={busy}
        onClick={onRefresh}
      >
        Refresh execution status
      </button>
      {historyError && (
        <p role="alert">
          Execution history could not be loaded: {historyError}. Refresh to
          inspect it; no request was resent.
        </p>
      )}
      {entries.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer">
            Execution history ({entries.length}
            {hasMore ? "+" : ""})
          </summary>
          <p className="mt-2 opacity-70">
            Newest submissions first. Recorded statuses are observations, not
            proof that no workspace changes occurred. Older non-terminal
            observations must be refreshed before relying on them.
          </p>
          <ol className="mt-2 space-y-3">
            {entries.map((entry, index) => (
              <li
                key={
                  entry.request_id ?? (entry.run_id || `unconfirmed-${index}`)
                }
                className="break-words border-t border-base-300 pt-2"
              >
                <strong>{label(entry.status)}</strong>
                <p className="break-all">
                  {entry.run_id ? (
                    <>
                      Run ID: <code>{entry.run_id}</code>
                    </>
                  ) : (
                    "No confirmed run ID"
                  )}
                </p>
                <p>
                  {entry.status_source === "hermes"
                    ? "Reported by Hermes"
                    : entry.status_source === "unconfirmed"
                      ? "Submission outcome unconfirmed"
                      : "Last recorded observation"}
                </p>
                <div className="flex flex-wrap gap-x-3 text-xs opacity-70">
                  {times(entry)}
                </div>
                {entry.run_id && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    disabled={busy}
                    onClick={() => onRefreshRun(entry.run_id)}
                  >
                    Refresh run {entry.run_id}
                  </button>
                )}
              </li>
            ))}
          </ol>
          {hasMore && (
            <button
              type="button"
              className="btn btn-ghost btn-xs mt-2"
              disabled={busy}
              onClick={onMore}
            >
              Load earlier executions
            </button>
          )}
        </details>
      )}
    </section>
  );
}
