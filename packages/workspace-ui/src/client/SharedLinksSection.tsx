import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ShareExpirationPreset,
  ShareKind,
  ShareSummary,
  ShareSyncStatus,
} from "../shared/api";
import type { WorkspaceApi } from "./api";
import { copyToClipboard } from "./openliaLinks";
import {
  buildPublicShareUrl,
  EXPIRATION_OPTIONS,
  formatByteSize,
  formatExpirationSummary,
  formatShareTimestamp,
} from "./ShareModal";

export interface SharedLinksSectionProps {
  api: WorkspaceApi;
  onOpenWorkspaceDocument: (path: string) => void;
  onOpenSkill: (skillId: string) => void;
}

export function SharedLinksSection({
  api,
  onOpenWorkspaceDocument,
  onOpenSkill,
}: SharedLinksSectionProps) {
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | ShareKind>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | ShareSyncStatus>(
    "all",
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadAllShares = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await api.listShares();
      setShares(response.shares);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to load shared links",
      );
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadAllShares();
  }, [loadAllShares]);

  const counts = useMemo(() => {
    const docs = shares.filter((s) => s.kind === "workspace").length;
    const skills = shares.filter((s) => s.kind === "skill").length;
    const stale = shares.filter((s) => s.status === "stale").length;
    const missing = shares.filter((s) => s.status === "source_missing").length;
    return { total: shares.length, docs, skills, stale, missing };
  }, [shares]);

  const filteredShares = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return shares.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.target_path.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q)
      );
    });
  }, [shares, kindFilter, statusFilter, searchQuery]);

  async function handleCopyLink(shareId: string) {
    const url = buildPublicShareUrl(shareId);
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopiedId(shareId);
      setTimeout(() => {
        setCopiedId((current) => (current === shareId ? null : current));
      }, 2000);
    }
  }

  async function handleSyncSnapshot(shareId: string) {
    setBusyId(shareId);
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
      setBusyId(null);
    }
  }

  async function handleExpirationChange(
    shareId: string,
    preset: ShareExpirationPreset,
  ) {
    setBusyId(shareId);
    setErrorMessage(null);
    try {
      const response = await api.updateShare(shareId, { expires_in: preset });
      setShares((prev) =>
        prev.map((item) => (item.id === shareId ? response.share : item)),
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to update expiration",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevoke(shareId: string) {
    setBusyId(shareId);
    setErrorMessage(null);
    try {
      await api.deleteShare(shareId);
      setShares((prev) => prev.filter((item) => item.id !== shareId));
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to revoke share link",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section
      aria-label="Shared Links"
      className="flex flex-1 flex-col overflow-hidden bg-base-100"
    >
      <div className="border-b border-base-300 bg-base-200/40 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-primary">
              Snapshot Sharing
            </p>
            <h2 className="text-lg font-bold text-base-content">
              Shared Links
            </h2>
            <p className="mt-0.5 text-xs text-base-content/65">
              Public share links serve isolated snapshots from{" "}
              <code className="font-mono">shares.sqlite</code> (excluded from
              workspace backups and exports). Expired links are automatically
              pruned.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={loading}
              onClick={() => void loadAllShares()}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-base-300 bg-base-100 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-base-content/55">
              Active Shares
            </div>
            <div className="mt-0.5 text-lg font-bold text-base-content">
              {counts.total}
            </div>
          </div>
          <div className="rounded-lg border border-base-300 bg-base-100 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-base-content/55">
              Documents
            </div>
            <div className="mt-0.5 text-lg font-bold text-base-content">
              {counts.docs}
            </div>
          </div>
          <div className="rounded-lg border border-base-300 bg-base-100 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-base-content/55">
              Skill Packages
            </div>
            <div className="mt-0.5 text-lg font-bold text-base-content">
              {counts.skills}
            </div>
          </div>
          <div className="rounded-lg border border-base-300 bg-base-100 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-base-content/55">
              Stale Snapshots
            </div>
            <div className="mt-0.5 text-lg font-bold text-warning">
              {counts.stale}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              aria-label="Search shared links"
              placeholder="Filter by title, path, or share ID..."
              className="input input-bordered input-sm w-64 bg-base-100"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <fieldset
              aria-label="Filter by type"
              className="join border border-base-300 rounded-lg"
            >
              <button
                type="button"
                className={`btn btn-xs join-item ${
                  kindFilter === "all" ? "btn-primary" : "btn-ghost"
                }`}
                onClick={() => setKindFilter("all")}
              >
                All
              </button>
              <button
                type="button"
                className={`btn btn-xs join-item ${
                  kindFilter === "workspace" ? "btn-primary" : "btn-ghost"
                }`}
                onClick={() => setKindFilter("workspace")}
              >
                Documents
              </button>
              <button
                type="button"
                className={`btn btn-xs join-item ${
                  kindFilter === "skill" ? "btn-primary" : "btn-ghost"
                }`}
                onClick={() => setKindFilter("skill")}
              >
                Skills
              </button>
            </fieldset>

            <select
              aria-label="Filter by status"
              className="select select-bordered select-sm bg-base-100 text-xs"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as "all" | ShareSyncStatus)
              }
            >
              <option value="all">All Statuses</option>
              <option value="up_to_date">Up to date</option>
              <option value="stale">Stale</option>
              <option value="source_missing">Source missing</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {errorMessage && (
          <div
            role="alert"
            className="alert alert-error mb-4 py-2 text-xs font-medium"
          >
            <span>{errorMessage}</span>
          </div>
        )}

        {loading ? (
          <div className="py-16 text-center text-sm text-base-content/60">
            Loading shared links...
          </div>
        ) : filteredShares.length === 0 ? (
          <div className="rounded-xl border border-dashed border-base-300 bg-base-200/20 px-6 py-16 text-center">
            <h3 className="text-sm font-semibold text-base-content">
              No shared links found
            </h3>
            <p className="mt-1 text-xs text-base-content/60">
              {shares.length === 0
                ? "Open any document in Documents or any skill in Skills and click Share to create a public snapshot link."
                : "No shared links match the current filter criteria."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredShares.map((share) => {
              const sharePath = `/share/${share.id}`;
              const isBusy = busyId === share.id;
              const isCopied = copiedId === share.id;

              return (
                <div
                  key={share.id}
                  data-testid={`shared-link-card-${share.id}`}
                  className="rounded-xl border border-base-300 bg-base-200/25 p-4 transition-colors hover:border-base-content/20"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`badge badge-xs uppercase tracking-wider font-semibold ${
                            share.kind === "skill"
                              ? "badge-secondary"
                              : "badge-primary"
                          }`}
                        >
                          {share.kind === "skill" ? "Skill" : "Document"}
                        </span>

                        {share.status === "up_to_date" ? (
                          <span className="badge badge-success badge-sm font-medium">
                            Up to date
                          </span>
                        ) : share.status === "stale" ? (
                          <span className="badge badge-warning badge-sm font-medium">
                            Stale
                          </span>
                        ) : (
                          <span className="badge badge-error badge-sm font-medium">
                            Source missing
                          </span>
                        )}

                        <span className="text-xs text-base-content/55">
                          {share.file_count}{" "}
                          {share.file_count === 1 ? "file" : "files"} ·{" "}
                          {formatByteSize(share.total_bytes)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {share.status !== "source_missing" ? (
                          <button
                            type="button"
                            className="text-left text-base font-bold text-base-content hover:text-primary hover:underline"
                            onClick={() =>
                              share.kind === "skill"
                                ? onOpenSkill(share.target_path)
                                : onOpenWorkspaceDocument(share.target_path)
                            }
                          >
                            {share.title}
                          </button>
                        ) : (
                          <span className="text-base font-bold text-base-content">
                            {share.title}
                          </span>
                        )}
                        <span className="font-mono text-xs text-base-content/60">
                          ({share.target_path})
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <code className="rounded bg-base-300/70 px-2 py-0.5 font-mono text-xs text-base-content">
                          {sharePath}
                        </code>
                        <button
                          type="button"
                          className="btn btn-outline btn-xs"
                          onClick={() => void handleCopyLink(share.id)}
                        >
                          {isCopied ? "Copied!" : "Copy Link"}
                        </button>
                        <a
                          href={sharePath}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-ghost btn-xs"
                        >
                          Open Preview ↗
                        </a>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={`Expiration for ${share.title}`}
                        className="select select-bordered select-xs bg-base-100"
                        disabled={isBusy}
                        value={share.expiration_preset}
                        onChange={(e) =>
                          void handleExpirationChange(
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
                              : "btn-outline"
                          }`}
                          disabled={isBusy}
                          onClick={() => void handleSyncSnapshot(share.id)}
                        >
                          Update Snapshot
                        </button>
                      )}

                      <button
                        type="button"
                        className="btn btn-error btn-outline btn-xs"
                        disabled={isBusy}
                        onClick={() => void handleRevoke(share.id)}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-base-300/60 pt-2.5 text-[11px] text-base-content/60">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span>
                        Created: {formatShareTimestamp(share.created_at)}
                      </span>
                      <span>
                        Snapshot Updated:{" "}
                        {formatShareTimestamp(share.updated_at)}
                      </span>
                      <span className="font-medium text-base-content/80">
                        {formatExpirationSummary(share.expires_at)}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-base-content/45">
                      Snapshot {share.snapshot_revision.slice(0, 19)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
