import { useCallback, useEffect, useState } from "react";
import type { CheckpointProposal } from "../shared/checkpoints";
import type { WorkspaceApi } from "./api";

export function CheckpointProposals({
  api,
  onAskLia,
  onApplied,
}: {
  api: Pick<
    WorkspaceApi,
    "loadCheckpointProposals" | "approveCheckpoint" | "dismissCheckpoint"
  >;
  onAskLia: (prompt: string) => void;
  onApplied?: (() => void) | undefined;
}) {
  const [proposals, setProposals] = useState<CheckpointProposal[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<CheckpointProposal | null>(null);
  const refresh = useCallback(async () => {
    const result = await api.loadCheckpointProposals();
    setProposals(result.proposals);
  }, [api]);
  const report = useCallback((err: unknown) => {
    const code =
      err instanceof Error
        ? err.message
        : "Could not load checkpoint proposals";
    const messages: Record<string, string> = {
      proposal_stale:
        "The reviewed files or HEAD changed. Ask Lia to refresh the proposal, then review it again.",
      selected_file_partially_staged:
        "A selected file has partially staged changes. Resolve its staging before confirming; no commits were created.",
      git_index_busy:
        "Another Git operation is using the index. Wait for it to finish, then retry.",
      checkpoint_index_recovery_required:
        "Checkpoint publication needs recovery. Inspect Git history and staging before taking further action; commits may already exist.",
    };
    setError(messages[code] ?? code.replaceAll("_", " "));
  }, []);
  useEffect(() => {
    let mounted = true;
    api
      .loadCheckpointProposals()
      .then((result) => {
        if (mounted) setProposals(result.proposals);
      })
      .catch((err) => {
        if (mounted) report(err);
      });
    return () => {
      mounted = false;
    };
  }, [api, report]);

  const act = async (
    proposal: CheckpointProposal,
    action: "approve" | "dismiss",
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result =
        action === "approve"
          ? await api.approveCheckpoint(proposal.id, proposal.revision)
          : await api.dismissCheckpoint(proposal.id, proposal.revision);
      setProposals((previous) =>
        previous.map((p) => (p.id === result.id ? result : p)),
      );
      setConfirm(null);
      if (action === "approve") onApplied?.();
      await refresh();
    } catch (err) {
      report(err);
      setConfirm(null);
      await refresh().catch(report);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Checkpoint proposals"
      className="mb-6 space-y-4 rounded-xl border border-base-content/15 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Review checkpoints</h3>
          <p className="text-sm text-base-content/60">
            Lia recommends commits. Nothing is committed until you confirm.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              setError("");
              void refresh().catch(report);
            }}
          >
            Refresh proposals
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() =>
              onAskLia(
                "Use the workspace-git skill to inspect my current workspace diffs and propose one or more coherent checkpoint commits for review in Git Activity. Explain the grouping and excluded changes. Save the proposal with workspace_git_propose; do not commit. I will confirm in the UI.",
              )
            }
          >
            Propose commits
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {proposals.length === 0 && (
        <p className="text-sm text-base-content/60">
          No proposals yet. Ask Lia to review your changes.
        </p>
      )}
      {proposals.map((proposal) => (
        <article
          key={proposal.id}
          className="space-y-3 rounded-lg border border-base-content/10 p-4"
        >
          <div className="flex flex-wrap justify-between gap-2">
            <span className="text-sm font-mono">
              {proposal.id.slice(0, 8)} · revision {proposal.revision}
            </span>
            <span className="badge badge-outline">
              {proposal.stale ? "Needs refresh" : proposal.status}
            </span>
          </div>
          {proposal.stale && (
            <p className="text-sm text-warning">
              The reviewed changes or repository HEAD changed. Ask Lia to
              refresh this proposal before confirming.
            </p>
          )}
          {proposal.commits.map((commit, index) => (
            <div key={commit.files.join("\0")} className="space-y-2">
              <h4 className="font-mono text-sm font-semibold">
                {index + 1}. {commit.message}
              </h4>
              <p className="text-sm text-base-content/70">{commit.rationale}</p>
              {commit.files.map((path) => (
                <details
                  key={path}
                  className="rounded border border-base-content/10 px-3 py-2"
                >
                  <summary className="cursor-pointer break-all font-mono text-xs">
                    {path}
                  </summary>
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {proposal.files.find((file) => file.path === path)?.diff ??
                      "Diff unavailable"}
                  </pre>
                </details>
              ))}
            </div>
          ))}
          {proposal.excluded.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm">
                Excluded changes ({proposal.excluded.length})
              </summary>
              <ul className="list-inside list-disc break-all text-xs">
                {proposal.excluded.map((path) => (
                  <li key={path}>
                    {path}
                    {proposal.exclusion_reasons?.[path]
                      ? ` — ${proposal.exclusion_reasons[path]}`
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {proposal.hashes.length > 0 && (
            <p role="status" className="break-all font-mono text-xs">
              Created: {proposal.hashes.join(", ")}
            </p>
          )}
          {proposal.status === "pending" && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || proposal.stale}
                onClick={() => setConfirm(proposal)}
              >
                Review & confirm
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={busy}
                onClick={() =>
                  onAskLia(
                    `Revise workspace checkpoint proposal ${proposal.id}, revision ${proposal.revision}. Read it with workspace_git_proposals, inspect current changes, and use workspace_git_propose with proposal_id and expected_revision to save the revision. Do not commit. My requested changes: `,
                  )
                }
              >
                Revise in chat
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  void act(proposal, "dismiss");
                }}
              >
                Dismiss
              </button>
            </div>
          )}
        </article>
      ))}
      {confirm && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkpoint-confirm-title"
            className="w-full max-w-lg space-y-4 rounded-xl bg-base-100 p-6"
          >
            <h3 id="checkpoint-confirm-title" className="text-lg font-semibold">
              Confirm checkpoint commits?
            </h3>
            <p className="text-sm">
              Approve revision {confirm.revision} of proposal{" "}
              {confirm.id.slice(0, 8)}. Only the reviewed file versions will be
              committed locally. No files will be rewritten and nothing will be
              pushed.
            </p>
            <ol className="list-inside list-decimal text-sm">
              {confirm.commits.map((commit) => (
                <li key={commit.files.join("\0")}>
                  {commit.message} ({commit.files.length} files)
                </li>
              ))}
            </ol>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => {
                  void act(confirm, "approve");
                }}
              >
                {busy ? "Creating commits…" : "Confirm commits"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
