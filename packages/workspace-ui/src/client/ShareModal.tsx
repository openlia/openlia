import { useCallback, useEffect, useState } from "react";
import type {
  ShareExpirationPreset,
  ShareKind,
  ShareSummary,
} from "../shared/api";
import type { WorkspaceApi } from "./api";
import { copyToClipboard } from "./openliaLinks";

export const EXPIRATION_OPTIONS: Array<{
  value: ShareExpirationPreset;
  label: string;
}> = [
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "never", label: "No Expire" },
];

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatShareTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function formatExpirationSummary(expiresAt: string | null): string {
  if (!expiresAt) return "Never expires";
  try {
    const expMs = new Date(expiresAt).getTime();
    if (Number.isNaN(expMs)) return `Expires ${expiresAt}`;
    const diffMs = expMs - Date.now();
    if (diffMs <= 0) return "Expired";
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);
    const formattedDate = new Date(expiresAt).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    if (diffDays >= 1) {
      return `Expires in ${diffDays}d (${formattedDate})`;
    }
    if (diffHours >= 1) {
      return `Expires in ${diffHours}h (${formattedDate})`;
    }
    const diffMins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
    return `Expires in ${diffMins}m`;
  } catch {
    return `Expires ${expiresAt}`;
  }
}

export function buildPublicShareUrl(shareId: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  return `${origin}/share/${encodeURIComponent(shareId)}`;
}

export interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  kind: ShareKind;
  targetPath: string;
  title: string;
  api: WorkspaceApi;
  onOpenSharesTab?: (() => void) | undefined;
}

export function ShareModal({
  isOpen,
  onClose,
  kind,
  targetPath,
  title,
  api,
  onOpenSharesTab,
}: ShareModalProps) {
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expiresIn, setExpiresIn] = useState<ShareExpirationPreset>("30d");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);

  const loadSharesForTarget = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await api.listShares({ kind, targetPath });
      setShares(response.shares);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to load shared links",
      );
    } finally {
      setLoading(false);
    }
  }, [api, kind, targetPath]);

  useEffect(() => {
    if (isOpen) {
      void loadSharesForTarget();
    }
  }, [isOpen, loadSharesForTarget]);

  if (!isOpen) return null;

  async function handleCreateShare() {
    setCreating(true);
    setErrorMessage(null);
    try {
      const response = await api.createShare({
        kind,
        target_path: targetPath,
        expires_in: expiresIn,
      });
      setShares((prev) => [response.share, ...prev]);
      const fullUrl = buildPublicShareUrl(response.share.id);
      const copied = await copyToClipboard(fullUrl);
      if (copied) {
        setCopiedId(response.share.id);
        setTimeout(() => {
          setCopiedId((current) =>
            current === response.share.id ? null : current,
          );
        }, 2000);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to create share link",
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleCopyShareLink(shareId: string) {
    const fullUrl = buildPublicShareUrl(shareId);
    const ok = await copyToClipboard(fullUrl);
    if (ok) {
      setCopiedId(shareId);
      setTimeout(() => {
        setCopiedId((current) => (current === shareId ? null : current));
      }, 2000);
    }
  }

  async function handleSyncShare(shareId: string) {
    setBusyShareId(shareId);
    setErrorMessage(null);
    try {
      const response = await api.syncShare(shareId);
      setShares((prev) =>
        prev.map((item) => (item.id === shareId ? response.share : item)),
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to update snapshot",
      );
    } finally {
      setBusyShareId(null);
    }
  }

  async function handleChangeExpiration(
    shareId: string,
    nextPreset: ShareExpirationPreset,
  ) {
    setBusyShareId(shareId);
    setErrorMessage(null);
    try {
      const response = await api.updateShare(shareId, {
        expires_in: nextPreset,
      });
      setShares((prev) =>
        prev.map((item) => (item.id === shareId ? response.share : item)),
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to update expiration",
      );
    } finally {
      setBusyShareId(null);
    }
  }

  async function handleRevokeShare(shareId: string) {
    setBusyShareId(shareId);
    setErrorMessage(null);
    try {
      await api.deleteShare(shareId);
      setShares((prev) => prev.filter((item) => item.id !== shareId));
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to revoke share link",
      );
    } finally {
      setBusyShareId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2.5 backdrop-blur-xs sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Share ${title}`}
    >
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl sm:max-h-[85vh]">
        <div className="flex items-start justify-between gap-2 border-b border-base-300 bg-base-200/40 px-3.5 py-2.5 sm:gap-4 sm:px-5 sm:py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="badge badge-xs badge-primary uppercase tracking-wider">
                {kind === "skill" ? "Skill Package" : "Workspace Document"}
              </span>
              <span className="truncate font-mono text-xs text-base-content/60">
                {targetPath}
              </span>
            </div>
            <h3 className="mt-0.5 truncate text-sm font-bold text-base-content sm:mt-1 sm:text-base">
              Share “{title}”
            </h3>
            <p className="mt-0.5 hidden text-xs text-base-content/65 sm:block">
              Public share links capture an isolated snapshot in{" "}
              <code className="font-mono">shares.sqlite</code>. Local edits stay
              private until you explicitly update the snapshot.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square sm:btn-sm"
            aria-label="Close share modal"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-3.5 sm:space-y-5 sm:p-5">
          {errorMessage && (
            <div
              role="alert"
              className="alert alert-error py-2 text-xs font-medium"
            >
              <span>{errorMessage}</span>
            </div>
          )}

          <div className="rounded-lg border border-base-300 bg-base-200/40 p-3 sm:p-4">
            <div className="flex flex-wrap items-end justify-between gap-2 sm:gap-3">
              <label className="form-control min-w-[140px] flex-1">
                <span className="label-text mb-1 text-xs font-semibold text-base-content/80">
                  Expiration
                </span>
                <select
                  aria-label="Expiration"
                  className="select select-bordered select-sm w-full bg-base-100"
                  value={expiresIn}
                  onChange={(e) =>
                    setExpiresIn(e.target.value as ShareExpirationPreset)
                  }
                >
                  {EXPIRATION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-primary btn-sm gap-2"
                disabled={creating}
                onClick={() => void handleCreateShare()}
              >
                {creating ? "Creating Snapshot..." : "Create Share Link"}
              </button>
            </div>
          </div>

          <div className="space-y-2.5 sm:space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-wider text-base-content/60">
                Active Share Links ({shares.length})
              </h4>
              {onOpenSharesTab && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs text-primary"
                  onClick={() => {
                    onClose();
                    onOpenSharesTab();
                  }}
                >
                  Manage All Shared Links →
                </button>
              )}
            </div>

            {loading ? (
              <div className="py-6 text-center text-xs text-base-content/60 sm:py-8">
                Loading active share links...
              </div>
            ) : shares.length === 0 ? (
              <div className="rounded-lg border border-dashed border-base-300 px-4 py-6 text-center text-xs text-base-content/60 sm:py-8">
                No active share links for this{" "}
                {kind === "skill" ? "skill package" : "document"}.
              </div>
            ) : (
              <div className="space-y-2.5 sm:space-y-3">
                {shares.map((share) => {
                  const sharePath = `/share/${share.id}`;
                  const isBusy = busyShareId === share.id;
                  const isCopied = copiedId === share.id;

                  return (
                    <div
                      key={share.id}
                      className="space-y-2 rounded-lg border border-base-300 bg-base-200/30 p-2.5 sm:space-y-2.5 sm:p-3.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <code className="truncate rounded bg-base-300/70 px-2 py-1 font-mono text-xs text-base-content">
                            {sharePath}
                          </code>
                          {share.status === "up_to_date" ? (
                            <span className="badge badge-success badge-sm gap-1 font-medium">
                              Up to date
                            </span>
                          ) : share.status === "stale" ? (
                            <span className="badge badge-warning badge-sm gap-1 font-medium">
                              Stale (local changes not published)
                            </span>
                          ) : (
                            <span className="badge badge-error badge-sm gap-1 font-medium">
                              Source missing
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className="btn btn-outline btn-xs"
                            onClick={() => void handleCopyShareLink(share.id)}
                          >
                            {isCopied ? "Copied!" : "Copy Link"}
                          </button>
                          <a
                            href={sharePath}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-ghost btn-xs"
                          >
                            Open in New Tab ↗
                          </a>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-base-content/65">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span>
                            Created: {formatShareTimestamp(share.created_at)}
                          </span>
                          <span>
                            Updated: {formatShareTimestamp(share.updated_at)}
                          </span>
                          <span className="font-medium text-base-content/80">
                            {formatExpirationSummary(share.expires_at)}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            aria-label={`Expiration for ${share.id}`}
                            className="select select-bordered select-xs bg-base-100"
                            disabled={isBusy}
                            value={share.expiration_preset}
                            onChange={(e) =>
                              void handleChangeExpiration(
                                share.id,
                                e.target.value as ShareExpirationPreset,
                              )
                            }
                          >
                            {EXPIRATION_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>

                          {share.status !== "source_missing" && (
                            <button
                              type="button"
                              className={`btn btn-xs ${
                                share.status === "stale"
                                  ? "btn-warning"
                                  : "btn-ghost border-base-300"
                              }`}
                              disabled={isBusy}
                              onClick={() => void handleSyncShare(share.id)}
                            >
                              Update Snapshot
                            </button>
                          )}

                          <button
                            type="button"
                            className="btn btn-error btn-outline btn-xs"
                            disabled={isBusy}
                            onClick={() => void handleRevokeShare(share.id)}
                          >
                            Revoke
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      <button
        type="button"
        aria-label="Close modal backdrop"
        className="fixed inset-0 z-0 cursor-default bg-transparent"
        onClick={onClose}
      />
    </div>
  );
}
