import { useEffect, useState } from "react";
import type {
  MaintainerFinding,
  MaintainerFixPreviewResponse,
} from "../shared/api";
import type { WorkspaceApi } from "./api";
import { diffLines } from "./markdown";

export interface MaintainerFixModalProps {
  api: WorkspaceApi;
  finding: MaintainerFinding | null;
  onClose: () => void;
  onApplied: (path: string) => void;
  onAskLia?: ((prompt: string) => void) | undefined;
}

export function MaintainerFixModal({
  api,
  finding,
  onClose,
  onApplied,
  onAskLia,
}: MaintainerFixModalProps) {
  const [preview, setPreview] = useState<MaintainerFixPreviewResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [promptDraft, setPromptDraft] = useState("");

  useEffect(() => {
    if (!finding) {
      setPreview(null);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    api
      .previewMaintainerFix(finding.issue_id)
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setPromptDraft(res.agent_prompt);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load fix preview",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, finding]);

  if (!finding) return null;

  const computedDiff =
    preview && preview.deterministically_fixable
      ? diffLines(preview.before_content, preview.after_content)
      : [];

  const handleApplyDeterministic = async () => {
    if (!preview) return;
    setApplying(true);
    setError("");
    try {
      await api.applyMaintainerFix(preview.issue_id, preview.current_revision);
      onApplied(preview.path);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to apply deterministic fix",
      );
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      aria-modal="true"
      className="modal modal-open z-50 bg-black/50"
      role="dialog"
    >
      <div className="modal-box max-w-2xl border border-base-content/15 bg-base-100 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-base-content/10 pb-3">
          <div>
            <p className="workspace-eyebrow">WORKSPACE MAINTAINER / FIX</p>
            <h3 className="mt-1 text-lg font-bold">
              {preview?.deterministically_fixable
                ? "Preview Deterministic Fix"
                : "Fix with Lia"}
            </h3>
            <p className="mt-0.5 font-mono text-xs text-base-content/60">
              {finding.relative_path} · {finding.rule_code} ({finding.subject})
            </p>
          </div>
          <button
            aria-label="Close fix dialog"
            className="btn btn-ghost btn-xs btn-square"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-4 text-sm">
          <div className="rounded-lg border border-base-content/10 bg-base-200/40 p-3">
            <p className="font-semibold text-xs text-warning">
              {finding.message}
            </p>
            <p className="mt-1 text-xs text-base-content/70">
              {finding.explanation}
            </p>
          </div>

          {error && (
            <div className="alert alert-error py-2 px-3 text-xs" role="alert">
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 py-8 justify-center text-xs text-base-content/60">
              <span className="loading loading-spinner loading-sm text-primary" />
              <span>Preparing scoped fix preview...</span>
            </div>
          ) : preview ? (
            preview.deterministically_fixable ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-base-content/80">
                    {preview.summary}
                  </span>
                  <span className="badge badge-success badge-xs font-mono">
                    Instant Fix
                  </span>
                </div>
                <pre className="max-h-64 overflow-auto rounded-lg border border-base-content/10 bg-base-200/70 p-3 font-mono text-xs leading-relaxed">
                  {computedDiff.length > 0
                    ? computedDiff.map((line, idx) => (
                        <div
                          className={
                            line.startsWith("+")
                              ? "text-success"
                              : line.startsWith("-")
                                ? "text-error"
                                : "text-base-content/70"
                          }
                          key={`${idx}-${line.slice(0, 16)}`}
                        >
                          {line}
                        </div>
                      ))
                    : preview.after_content}
                </pre>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-base-content/70">
                  This finding involves semantic or layout context. Send this
                  bounded fix request to Lia in Chat:
                </p>
                <textarea
                  aria-label="Fix prompt for Lia"
                  className="textarea textarea-bordered w-full font-mono text-xs h-36 bg-base-200/50"
                  onChange={(e) => setPromptDraft(e.target.value)}
                  value={promptDraft}
                />
              </div>
            )
          ) : null}
        </div>

        <div className="modal-action mt-6 flex flex-wrap items-center justify-between gap-2">
          <div>
            {preview?.deterministically_fixable && onAskLia && (
              <button
                className="btn btn-ghost btn-xs text-primary"
                onClick={() => {
                  onAskLia(promptDraft || preview.agent_prompt);
                  onClose();
                }}
                type="button"
              >
                Ask Lia in Chat instead →
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-ghost btn-sm"
              disabled={applying}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            {preview?.deterministically_fixable ? (
              <button
                className="btn btn-primary btn-sm"
                disabled={applying || loading}
                onClick={() => void handleApplyDeterministic()}
                type="button"
              >
                {applying ? (
                  <>
                    <span className="loading loading-spinner loading-xs" />
                    <span>Applying...</span>
                  </>
                ) : (
                  "Apply Fix"
                )}
              </button>
            ) : (
              onAskLia &&
              preview && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!promptDraft.trim()}
                  onClick={() => {
                    onAskLia(promptDraft.trim());
                    onClose();
                  }}
                  type="button"
                >
                  Send to Lia in Chat
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
