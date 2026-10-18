import { useEffect, useMemo, useState } from "react";
import type {
  DocumentPasswordProfile,
  SourceDocument,
  SourceUpdateRequest,
} from "../../shared/api";
import { suggestPasswordProfiles } from "../../shared/passwordSuggester";
import type { WorkspaceApi } from "../api";
import { UploadModal } from "./UploadModal";

export interface DocumentInspectorProps {
  api: WorkspaceApi;
  document: SourceDocument | null;
  loading: boolean;
  onUpdate: (updated: SourceDocument) => void;
  onOpenFile: (path: string) => void;
  rawUrl: (path: string) => string;
  onOpenPasswordManager?: () => void;
  passwordProfilesVersion?: number;
  onDelete?: (deletedSourceId: string) => void;
}

interface ParsedPage {
  pageNumber: number;
  content: string;
}

function parsePagesFromContent(content: string | undefined): ParsedPage[] {
  if (!content) return [];
  const matches = Array.from(content.matchAll(/^## Page (\d+)\s*$/gm));
  if (matches.length === 0) return [];
  const pages: ParsedPage[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!match) continue;
    const pageNumber = Number(match[1]);
    const startIdx = (match.index ?? 0) + match[0].length;
    const endIdx =
      i + 1 < matches.length
        ? (matches[i + 1]?.index ?? content.length)
        : content.length;
    pages.push({
      pageNumber,
      content: content.slice(startIdx, endIdx).trim(),
    });
  }
  return pages;
}

export function DocumentInspector({
  api,
  document,
  loading,
  onUpdate,
  onOpenFile,
  rawUrl: _rawUrl,
  onOpenPasswordManager,
  passwordProfilesVersion,
  onDelete,
}: DocumentInspectorProps) {
  const [activeTab, setActiveTab] = useState<
    "content" | "metadata" | "backlinks"
  >("content");
  const [splitPreview, setSplitPreview] = useState(false);
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCitation, setCopiedCitation] = useState(false);
  const [copiedPageCitation, setCopiedPageCitation] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Version and lifecycle management state
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null,
  );
  const [isReplaceModalOpen, setIsReplaceModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [annotateBacklinks, setAnnotateBacklinks] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [selectedVersionData, setSelectedVersionData] =
    useState<SourceDocument | null>(null);
  const [selectedVersionLoading, setSelectedVersionLoading] = useState(false);

  // Password unlock & retry state
  const [retryPassword, setRetryPassword] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [saveProfileLabel, setSaveProfileLabel] = useState("");
  const [passwordProfiles, setPasswordProfiles] = useState<
    DocumentPasswordProfile[]
  >([]);
  const [assignedPasswordProfile, setAssignedPasswordProfile] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  // Form edit state
  const [title, setTitle] = useState("");
  const [correspondent, setCorrespondent] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [summary, setSummary] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState("");
  const [customFields, setCustomFields] = useState<
    Array<{ key: string; value: string }>
  >([]);
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");

  useEffect(() => {
    if (document) {
      setTitle(document.title ?? "");
      setCorrespondent(document.correspondent ?? "");
      setDocumentType(document.document_type ?? "");
      setDocumentDate(document.document_date ?? "");
      setSummary(document.summary ?? "");
      setTags(document.tags ?? []);
      const cf = document.custom_fields ?? {};
      setCustomFields(
        Object.entries(cf).map(([key, value]) => ({
          key,
          value: value === null || value === undefined ? "" : String(value),
        })),
      );
      setAssignedPasswordProfile(document.password_profile ?? "");
      setSelectedPage(null);
      setSelectedVersionId(null);
      setSelectedVersionData(null);
      setSelectedVersionLoading(false);
      setIsDeleteModalOpen(false);
      setIsReplaceModalOpen(false);
      setSaveError(null);
      setRetryMessage(null);
      setCancelling(false);
    }
  }, [document]);

  const needsPasswordOrRetry =
    document !== null &&
    ["awaiting-unlock", "waiting-for-password", "failed"].includes(
      document.processing.status,
    );

  const canCancel =
    document !== null &&
    [
      "queued",
      "processing",
      "running",
      "awaiting-unlock",
      "waiting-for-password",
      "retryable-failure",
    ].includes(document.processing.status);

  useEffect(() => {
    void passwordProfilesVersion;
    if (!document) return;
    let cancelled = false;
    api
      .listDocumentPasswords()
      .then((res) => {
        if (!cancelled) setPasswordProfiles(res.profiles ?? []);
      })
      .catch(() => {
        if (!cancelled) setPasswordProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [document, api, passwordProfilesVersion]);

  const latestDocumentVersion =
    document?.versions[document.versions.length - 1];
  const latestVersionId = latestDocumentVersion
    ? String(latestDocumentVersion.id ?? latestDocumentVersion.version_id ?? "")
    : null;

  useEffect(() => {
    if (
      !document ||
      !selectedVersionId ||
      selectedVersionId === latestVersionId
    ) {
      setSelectedVersionData(null);
      setSelectedVersionLoading(false);
      return;
    }

    let cancelled = false;
    setSelectedVersionLoading(true);
    api
      .loadSource(document.id, selectedVersionId)
      .then((versionDocument) => {
        if (!cancelled) setSelectedVersionData(versionDocument);
      })
      .catch((err) => {
        if (!cancelled) {
          setSelectedVersionData(null);
          setSelectedVersionId(null);
          setSaveError(
            err instanceof Error
              ? err.message
              : "Failed to load the selected version",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSelectedVersionLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, document, latestVersionId, selectedVersionId]);

  // Compute smart password suggestions for this document
  const suggestions = useMemo(() => {
    if (!document || passwordProfiles.length === 0) return [];
    return suggestPasswordProfiles(
      {
        filename: document.title,
        title: document.title,
        correspondent: document.correspondent ?? undefined,
      },
      passwordProfiles,
    );
  }, [document, passwordProfiles]);

  const topSuggestion = suggestions.length > 0 ? suggestions[0] : null;

  const displayedContent = selectedVersionData
    ? selectedVersionData.content
    : document?.content;

  const pages = useMemo(
    () => parsePagesFromContent(displayedContent ?? undefined),
    [displayedContent],
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-base-content/50">
        <span className="loading loading-spinner loading-md"></span>
        <span className="ml-2 text-sm">Loading document details...</span>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-base-content/40">
        <svg
          className="h-16 w-16 mb-2 stroke-current"
          fill="none"
          viewBox="0 0 24 24"
        >
          <title>No document selected</title>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <p className="text-sm font-semibold">Select a document to inspect</p>
        <p className="text-xs max-w-sm mt-1">
          Review OCR extractions, edit correspondent and metadata, and inspect
          domain backlinks.
        </p>
      </div>
    );
  }

  const isReviewed = document.review.status === "reviewed";

  async function toggleReviewStatus() {
    if (!document) return;
    setSaving(true);
    try {
      const nextStatus = isReviewed ? "needs-review" : "reviewed";
      const updated = await api.updateSource(document.id, {
        review: {
          status: nextStatus,
          reasons: nextStatus === "reviewed" ? [] : document.review.reasons,
        },
      });
      onUpdate(updated);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to update review status",
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchiveStatus() {
    if (!document) return;
    setSaving(true);
    setSaveError(null);
    try {
      const nextLifecycle =
        document.lifecycle === "archived" ? "active" : "archived";
      const updated = await api.updateSource(document.id, {
        lifecycle: nextLifecycle,
      });
      onUpdate(updated);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to toggle archive status",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteSource() {
    if (!document) return;
    setDeleting(true);
    setSaveError(null);
    try {
      await api.deleteSource(document.id, {
        annotate_backlinks: annotateBacklinks,
      });
      setIsDeleteModalOpen(false);
      onDelete?.(document.id);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to delete document",
      );
    } finally {
      setDeleting(false);
    }
  }

  async function handleSaveMetadata() {
    if (!document) return;
    setSaving(true);
    setSaveError(null);
    try {
      const customFieldsPayload: Record<
        string,
        string | number | boolean | null
      > = {};
      for (const item of customFields) {
        const cleanKey = item.key.trim();
        if (!cleanKey) continue;
        const cleanVal = item.value.trim();
        if (!cleanVal) {
          customFieldsPayload[cleanKey] = null;
        } else if (/^-?\d+(\.\d+)?$/.test(cleanVal)) {
          customFieldsPayload[cleanKey] = Number(cleanVal);
        } else {
          customFieldsPayload[cleanKey] = cleanVal;
        }
      }

      const updates: SourceUpdateRequest = {
        title: title.trim() || document.title,
        correspondent: correspondent.trim() || null,
        document_type: documentType.trim() || null,
        document_date: documentDate.trim() || null,
        summary: summary.trim() || null,
        password_profile: assignedPasswordProfile.trim() || null,
        tags: tags,
        custom_fields: customFieldsPayload,
      };
      const updated = await api.updateSource(document.id, updates);
      onUpdate(updated);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save metadata",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleRetrySource() {
    if (!document) return;
    setRetrying(true);
    setSaveError(null);
    setRetryMessage(null);
    try {
      const cleanLabel = saveProfileLabel.trim();
      const derivedProfileId =
        selectedProfileId ||
        (cleanLabel
          ? cleanLabel
              .toLowerCase()
              .replace(/[^a-z0-9._-]+/g, "_")
              .replace(/^_+|_+$/g, "")
          : retryPassword
            ? `unlock_${document.id}`
            : undefined);
      const res = await api.retrySource(document.id, {
        password: retryPassword || undefined,
        profile_id: derivedProfileId || undefined,
        label: cleanLabel || undefined,
      });
      setRetryPassword("");
      setSaveProfileLabel("");
      setRetryMessage(`Queued extraction retry (${res.job_id})`);
      const refreshed = await api.loadSource(document.id);
      onUpdate(refreshed);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to retry extraction",
      );
    } finally {
      setRetrying(false);
    }
  }

  async function handleCancelProcessing() {
    if (!document) return;
    setCancelling(true);
    setSaveError(null);
    setRetryMessage(null);
    try {
      await api.cancelSource(document.id);
      setRetryMessage("Processing cancelled. Extraction halted.");
      const refreshed = await api.loadSource(document.id);
      onUpdate(refreshed);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to cancel processing",
      );
    } finally {
      setCancelling(false);
    }
  }

  function handleAddTag() {
    const clean = newTagInput.trim().toLowerCase();
    if (clean && !tags.includes(clean)) {
      setTags([...tags, clean]);
      setNewTagInput("");
    }
  }

  function handleRemoveTag(tagToRemove: string) {
    setTags(tags.filter((t) => t !== tagToRemove));
  }

  function handleAddCustomField() {
    const cleanKey = newFieldKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    if (!cleanKey) return;
    const existingIdx = customFields.findIndex((f) => f.key === cleanKey);
    if (existingIdx >= 0) {
      const next = [...customFields];
      next[existingIdx] = { key: cleanKey, value: newFieldValue };
      setCustomFields(next);
    } else {
      setCustomFields([
        ...customFields,
        { key: cleanKey, value: newFieldValue },
      ]);
    }
    setNewFieldKey("");
    setNewFieldValue("");
  }

  function handleUpdateCustomField(index: number, value: string) {
    const next = [...customFields];
    const current = next[index];
    if (!current) return;
    next[index] = { key: current.key, value };
    setCustomFields(next);
  }

  function handleRemoveCustomField(keyToRemove: string) {
    setCustomFields(customFields.filter((f) => f.key !== keyToRemove));
  }

  function copyCanonicalUri() {
    if (!document) return;
    navigator.clipboard.writeText(document.canonical_uri);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1500);
  }

  function copyMarkdownCitation() {
    if (!document) return;
    navigator.clipboard.writeText(document.markdown_citation);
    setCopiedCitation(true);
    setTimeout(() => setCopiedCitation(false), 1500);
  }

  const versions = (document.versions ?? []) as Array<Record<string, unknown>>;
  const latestVersion =
    versions.length > 0
      ? (versions[versions.length - 1] as {
          id?: string;
          version_id?: string;
          original_ref?: string;
          mime_type?: string;
        })
      : null;
  const currentVersion = selectedVersionId
    ? ((versions.find(
        (v) =>
          ((v.id as string) ?? (v.version_id as string)) === selectedVersionId,
      ) as typeof latestVersion) ?? latestVersion)
    : latestVersion;
  const currentVersionId =
    currentVersion?.id ?? currentVersion?.version_id ?? "ver_001";
  const originalRef = currentVersion?.original_ref;
  const canPreview =
    document.kind === "pdf" ||
    document.kind === "image" ||
    Boolean(originalRef);
  const sourceRawHref = api.sourceRawUrl(document.id, currentVersionId);
  const previewUrl =
    selectedPage && document.kind === "pdf"
      ? `${sourceRawHref}#page=${selectedPage}`
      : sourceRawHref;

  function copyPageCitation(pageNum: number) {
    if (!document) return;
    const citation = `[${document.title}, p. ${pageNum}](${document.canonical_uri}#${currentVersionId}/p${pageNum})`;
    navigator.clipboard.writeText(citation);
    setCopiedPageCitation(true);
    setTimeout(() => setCopiedPageCitation(false), 1500);
  }

  const activePageContent =
    selectedPage !== null
      ? (pages.find((p) => p.pageNumber === selectedPage)?.content ??
        displayedContent ??
        document.content)
      : displayedContent;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-base-100">
      {/* Inspector Header */}
      <div className="border-b border-base-content/10 p-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-base-content/50">
              {document.id}
            </span>
            {document.document_type && (
              <span className="badge badge-outline badge-xs capitalize">
                {document.document_type}
              </span>
            )}
            {document.lifecycle === "archived" && (
              <span className="badge badge-warning badge-xs">Archived</span>
            )}
            {document.processing.status !== "complete" && (
              <span
                className={`badge badge-xs ${
                  document.processing.status === "failed" ||
                  document.processing.status === "awaiting-unlock" ||
                  document.processing.status === "waiting-for-password"
                    ? "badge-error"
                    : document.processing.status === "cancelled"
                      ? "badge-ghost opacity-80"
                      : "badge-info"
                }`}
              >
                {document.processing.status}
              </span>
            )}
          </div>
          <h2 className="mt-1 break-words text-xl font-bold">
            {document.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-base-content/60">
            {document.correspondent && (
              <span>
                Correspondent: <strong>{document.correspondent}</strong>
              </span>
            )}
            {document.document_date && (
              <span>Date: {document.document_date}</span>
            )}
            <span>
              Captured: {new Date(document.captured_at).toLocaleDateString()}
            </span>
          </div>

          {/* Version Selector */}
          {versions.length > 1 && (
            <div className="mt-3 flex items-center gap-2 text-xs">
              <span className="font-semibold text-base-content/60">
                Version:
              </span>
              <div className="join">
                {versions.map((ver, idx) => {
                  const vid =
                    (ver.id as string) ??
                    (ver.version_id as string) ??
                    `ver_${String(idx + 1).padStart(3, "0")}`;
                  const isLatest = idx === versions.length - 1;
                  const isCurrent = vid === currentVersionId;
                  return (
                    <button
                      key={vid}
                      type="button"
                      className={`join-item btn btn-xs ${
                        isCurrent
                          ? "btn-active btn-primary"
                          : "btn-ghost border border-base-content/10"
                      }`}
                      onClick={() => setSelectedVersionId(vid)}
                    >
                      {vid} {isLatest ? "(latest)" : ""}
                    </button>
                  );
                })}
              </div>
              {selectedVersionLoading && (
                <span className="loading loading-spinner loading-xs" />
              )}
            </div>
          )}

          {/* Stale Backlinks Warning Banner */}
          {document.stale_backlinks && document.stale_backlinks.length > 0 && (
            <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning-content flex items-start gap-2">
              <svg
                className="h-4 w-4 shrink-0 mt-0.5 fill-current"
                viewBox="0 0 20 20"
              >
                <title>Warning: Pinned to older version</title>
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              <div>
                <p className="font-semibold">
                  {document.stale_backlinks.length} backlink(s) are pinned to
                  older versions of this document.
                </p>
                <p className="mt-0.5 text-[11px] opacity-80">
                  References like{" "}
                  <code>openlia://source/{document.id}#ver_...</code> in your
                  workspace cite superseded versions. Check the Backlinks tab
                  for details.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Keep frequent actions visible; tuck lifecycle and copy variants away. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-base-content/10 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`btn btn-sm ${
                isReviewed ? "btn-outline btn-success" : "btn-warning"
              }`}
              onClick={toggleReviewStatus}
              disabled={saving}
            >
              {isReviewed ? "✓ Reviewed" : "Mark as Reviewed"}
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={copyMarkdownCitation}
              title="Copy markdown citation link"
            >
              {copiedCitation ? "Copied!" : "Copy Citation"}
            </button>
          </div>

          <div className="dropdown dropdown-end">
            <button
              type="button"
              className="btn btn-ghost btn-sm gap-1.5"
              aria-haspopup="menu"
              aria-label="More document actions"
              tabIndex={0}
              title="More document actions"
            >
              More
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <circle cx="5" cy="12" r="1.75" />
                <circle cx="12" cy="12" r="1.75" />
                <circle cx="19" cy="12" r="1.75" />
              </svg>
            </button>
            <ul className="dropdown-content menu z-30 mt-1 w-56 rounded-box border border-base-content/10 bg-base-100 p-1.5 text-xs shadow-lg">
              <li>
                <button
                  type="button"
                  className="justify-start"
                  onClick={() => setIsReplaceModalOpen(true)}
                  title="Upload a new version to replace this source"
                >
                  Replace / New Version
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="justify-start"
                  onClick={toggleArchiveStatus}
                  disabled={saving}
                  title={
                    document.lifecycle === "archived"
                      ? "Restore document to active library"
                      : "Archive this document"
                  }
                >
                  {document.lifecycle === "archived" ? "Restore" : "Archive"}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="justify-start"
                  onClick={copyCanonicalUri}
                  title="Copy canonical URI (openlia://source/...)"
                >
                  {copiedLink ? "Copied URI!" : "Copy URI"}
                </button>
              </li>
              {canCancel && (
                <li>
                  <button
                    type="button"
                    className="justify-start text-warning hover:bg-warning/10"
                    onClick={handleCancelProcessing}
                    disabled={cancelling}
                    title="Cancel queued or in-flight processing"
                  >
                    {cancelling ? "Cancelling..." : "Cancel Processing"}
                  </button>
                </li>
              )}
              {document.processing.status === "cancelled" && (
                <li>
                  <button
                    type="button"
                    className="justify-start text-primary hover:bg-primary/10"
                    onClick={handleRetrySource}
                    disabled={retrying}
                    title="Resume extraction using preserved raw Vault blob"
                  >
                    {retrying ? "Resuming..." : "Resume Extraction"}
                  </button>
                </li>
              )}
              <li className="my-1 border-t border-base-content/10" />
              <li>
                <button
                  type="button"
                  className="justify-start text-error hover:bg-error/10"
                  onClick={() => setIsDeleteModalOpen(true)}
                  title="Delete source and manage backlinks cascade"
                >
                  Delete...
                </button>
              </li>
            </ul>
          </div>
        </div>

        {/* Password Unlock / Retry Banner */}
        {needsPasswordOrRetry && (
          <section
            className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3.5 text-xs"
            aria-label="Document unlock and retry"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-warning-content">
                  {document.processing.status === "awaiting-unlock" ||
                  document.processing.status === "waiting-for-password"
                    ? "Password Required to Unlock PDF"
                    : "Extraction Failed or Incomplete"}
                </p>
                {document.processing.error_summary && (
                  <p className="mt-0.5 text-base-content/70">
                    {document.processing.error_code
                      ? `${document.processing.error_code}: `
                      : ""}
                    {document.processing.error_summary}
                  </p>
                )}
              </div>
            </div>

            {/* Smart unlock suggestion if available */}
            {topSuggestion &&
              topSuggestion.score >= 40 &&
              !selectedProfileId && (
                <div className="mt-2.5 flex items-center justify-between rounded bg-warning/20 px-2.5 py-1.5 text-[11px]">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="badge badge-info badge-xs">
                      {topSuggestion.score}% Match
                    </span>
                    <span>
                      Suggested profile:{" "}
                      <strong>{topSuggestion.profile.label}</strong>
                    </span>
                    {topSuggestion.profile.hint && (
                      <span className="text-base-content/70">
                        (Hint: {topSuggestion.profile.hint})
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs text-primary underline"
                    onClick={() =>
                      setSelectedProfileId(topSuggestion.profile.profile_id)
                    }
                  >
                    Select
                  </button>
                </div>
              )}

            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <input
                type="password"
                className="input input-bordered input-xs w-full"
                placeholder="Document password (optional)..."
                value={retryPassword}
                onChange={(e) => setRetryPassword(e.target.value)}
              />
              {passwordProfiles.length > 0 ? (
                <select
                  className="select select-bordered select-xs w-full"
                  value={selectedProfileId}
                  onChange={(e) => setSelectedProfileId(e.target.value)}
                >
                  <option value="">Or choose saved password profile...</option>
                  {passwordProfiles.map((prof) => (
                    <option key={prof.profile_id} value={prof.profile_id}>
                      {prof.label} ({prof.profile_id})
                      {prof.hint ? ` [Hint: ${prof.hint}]` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="input input-bordered input-xs w-full"
                  placeholder="Save password as profile label (optional)..."
                  value={saveProfileLabel}
                  onChange={(e) => setSaveProfileLabel(e.target.value)}
                />
              )}
              <div className="flex items-center gap-2">
                {passwordProfiles.length > 0 && retryPassword && (
                  <input
                    type="text"
                    className="input input-bordered input-xs flex-1"
                    placeholder="Save as label..."
                    value={saveProfileLabel}
                    onChange={(e) => setSaveProfileLabel(e.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="btn btn-warning btn-xs"
                  onClick={handleRetrySource}
                  disabled={retrying}
                >
                  {retrying ? "Retrying..." : "Unlock & Retry"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs text-base-content/70 hover:text-warning"
                  onClick={handleCancelProcessing}
                  disabled={cancelling}
                  title="Cancel extraction for this document"
                >
                  {cancelling ? "Cancelling..." : "Cancel"}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Queued Ingestion Banner */}
        {document.processing.status === "queued" && (
          <section
            className="mt-4 rounded-lg border border-info/40 bg-info/10 p-3.5 text-xs"
            aria-label="Document queued for extraction"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-info-content">
                  ⏱ Queued for Extraction
                </p>
                <p className="mt-0.5 text-base-content/70">
                  This document is waiting in the ingestion queue. Extraction
                  has not started yet.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-outline btn-xs text-warning hover:bg-warning/20"
                onClick={handleCancelProcessing}
                disabled={cancelling}
              >
                {cancelling ? "Cancelling..." : "Cancel Processing"}
              </button>
            </div>
          </section>
        )}

        {/* Cancelled Processing Banner */}
        {document.processing.status === "cancelled" && (
          <section
            className="mt-4 rounded-lg border border-base-content/20 bg-base-200/60 p-3.5 text-xs"
            aria-label="Document processing cancelled"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-base-content">
                  ⚪ Extraction Cancelled
                </p>
                <p className="mt-0.5 text-base-content/70">
                  Processing was halted. The raw document remains safely stored
                  in Vault.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-xs"
                onClick={handleRetrySource}
                disabled={retrying}
              >
                {retrying ? "Resuming..." : "Resume Extraction"}
              </button>
            </div>
          </section>
        )}

        {retryMessage && (
          <div className="alert alert-info mt-3 py-2 text-xs">
            <span>{retryMessage}</span>
          </div>
        )}

        {/* Tab selection */}
        <div className="tabs tabs-bordered mt-4">
          <button
            type="button"
            className={`tab ${activeTab === "content" ? "tab-active font-semibold" : ""}`}
            onClick={() => setActiveTab("content")}
          >
            Document Content & OCR
          </button>
          <button
            type="button"
            className={`tab ${activeTab === "metadata" ? "tab-active font-semibold" : ""}`}
            onClick={() => setActiveTab("metadata")}
          >
            Metadata & Tags
          </button>
          <button
            type="button"
            className={`tab ${activeTab === "backlinks" ? "tab-active font-semibold" : ""}`}
            onClick={() => setActiveTab("backlinks")}
          >
            Used by ({document.backlinks?.length ?? 0})
          </button>
        </div>
      </div>

      {saveError && (
        <div className="alert alert-error mx-5 mt-4 text-xs">
          <span>{saveError}</span>
        </div>
      )}

      {/* Split-Screen Body: Optional Left Preview + Right Inspector Tab Content */}
      <div
        className={`flex min-h-0 flex-1 ${
          splitPreview
            ? "flex-col lg:flex-row divide-y lg:divide-y-0 lg:divide-x divide-base-content/10"
            : "flex-col"
        } overflow-hidden`}
      >
        {splitPreview && (
          <section
            className="flex min-h-[22rem] flex-1 flex-col bg-base-200/40 p-3"
            aria-label="Original document preview"
          >
            <div className="mb-2 flex items-center justify-between text-xs text-base-content/60">
              <span className="font-semibold uppercase tracking-wider">
                Original Preview ({document.kind})
                {selectedPage ? ` · Page ${selectedPage}` : ""}
              </span>
              <a
                href={sourceRawHref}
                target="_blank"
                rel="noreferrer"
                className="link link-primary text-xs"
              >
                Open in New Tab ↗
              </a>
            </div>
            {document.kind === "image" ? (
              <div className="flex flex-1 items-center justify-center overflow-auto rounded border border-base-content/10 bg-base-100 p-2">
                <img
                  src={previewUrl}
                  alt={document.title}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : (
              <iframe
                src={previewUrl}
                title={`Preview ${document.title}`}
                className="h-full min-h-[26rem] w-full flex-1 rounded border border-base-content/10 bg-base-100"
              />
            )}
          </section>
        )}

        {/* Tab Panels */}
        <div className="flex-1 p-5 overflow-y-auto">
          {/* 1. Content Tab */}
          {activeTab === "content" && (
            <div className="space-y-4">
              {canPreview && (
                <div className="flex items-center justify-between rounded-lg border border-base-content/10 bg-base-200/50 p-3 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <svg
                      className="h-4 w-4 text-primary shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <title>Original file</title>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                      />
                    </svg>
                    <span
                      className="truncate font-mono"
                      title={originalRef ?? document.title}
                    >
                      {originalRef ?? `${document.title} (${document.kind})`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <a
                      href={sourceRawHref}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-ghost btn-xs"
                    >
                      View Original
                    </a>
                    <button
                      type="button"
                      className={`btn btn-xs ${
                        splitPreview ? "btn-primary" : "btn-outline"
                      }`}
                      aria-pressed={splitPreview}
                      onClick={() => setSplitPreview((v) => !v)}
                    >
                      {splitPreview ? "Close Split" : "Split View"}
                    </button>
                  </div>
                </div>
              )}

              {/* Page-level navigation & citation bar */}
              {pages.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-base-content/10 bg-base-200/30 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 font-semibold text-base-content/60">
                      Pages:
                    </span>
                    <button
                      type="button"
                      className={`btn btn-xs ${
                        selectedPage === null ? "btn-primary" : "btn-ghost"
                      }`}
                      onClick={() => setSelectedPage(null)}
                    >
                      All ({pages.length})
                    </button>
                    {pages.map((p) => (
                      <button
                        key={p.pageNumber}
                        type="button"
                        className={`btn btn-xs font-mono ${
                          selectedPage === p.pageNumber
                            ? "btn-primary"
                            : "btn-ghost"
                        }`}
                        onClick={() => setSelectedPage(p.pageNumber)}
                      >
                        #p{p.pageNumber}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    onClick={() => copyPageCitation(selectedPage ?? 1)}
                    title="Copy page-anchored markdown citation"
                  >
                    {copiedPageCitation
                      ? "Copied Page Citation!"
                      : `Cite #p${selectedPage ?? 1}`}
                  </button>
                </div>
              )}

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-base-content/50 mb-2">
                  Extracted Text & Extractions
                </h4>
                {activePageContent ? (
                  <div className="rounded-lg border border-base-content/10 bg-base-200/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap max-h-[600px] overflow-y-auto">
                    {activePageContent}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-base-content/20 p-8 text-center text-xs text-base-content/50">
                    No text extractions available yet.
                    {document.processing.status === "queued" &&
                      " The document is queued for OCR extraction."}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 2. Metadata Tab */}
          {activeTab === "metadata" && (
            <div className="max-w-xl space-y-4">
              <div>
                <label className="block text-xs font-semibold text-base-content/70">
                  Title
                  <input
                    type="text"
                    className="input input-bordered input-sm mt-1 w-full font-normal"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-base-content/70">
                    Correspondent
                    <input
                      type="text"
                      className="input input-bordered input-sm mt-1 w-full font-normal"
                      placeholder="e.g. ACME Corp, Bank"
                      value={correspondent}
                      onChange={(e) => setCorrespondent(e.target.value)}
                    />
                  </label>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-base-content/70">
                    Document Type
                    <input
                      type="text"
                      className="input input-bordered input-sm mt-1 w-full font-normal"
                      placeholder="e.g. invoice, statement, receipt"
                      value={documentType}
                      onChange={(e) => setDocumentType(e.target.value)}
                    />
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-base-content/70">
                  Document Date
                  <input
                    type="date"
                    className="input input-bordered input-sm mt-1 w-full font-normal"
                    value={documentDate}
                    onChange={(e) => setDocumentDate(e.target.value)}
                  />
                </label>
              </div>

              <div>
                <span className="block text-xs font-semibold text-base-content/70">
                  Tags
                </span>
                <div className="mt-1 flex flex-wrap gap-1.5 mb-2">
                  {tags.map((t) => (
                    <span
                      key={t}
                      className="badge badge-primary badge-sm gap-1 pl-2 pr-1"
                    >
                      #{t}
                      <button
                        type="button"
                        className="cursor-pointer font-bold hover:text-error"
                        onClick={() => handleRemoveTag(t)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="input input-bordered input-xs flex-1"
                    placeholder="Add a tag..."
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddTag();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    onClick={handleAddTag}
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Structured Custom Fields (Paperless-style) */}
              <div className="rounded-lg border border-base-content/10 bg-base-200/20 p-3">
                <span className="block text-xs font-semibold text-base-content/70">
                  Custom Fields
                </span>
                <p className="text-[11px] text-base-content/50 mb-2">
                  Structured fields extracted from this document (e.g.
                  total_amount, currency, due_date, invoice_number).
                </p>
                {customFields.length > 0 && (
                  <div className="space-y-1.5 mb-2">
                    {customFields.map((field, idx) => (
                      <div
                        key={field.key}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span className="w-36 truncate font-mono text-[11px] text-base-content/70">
                          {field.key}
                        </span>
                        <input
                          type="text"
                          aria-label={`Custom field ${field.key}`}
                          className="input input-bordered input-xs flex-1 font-mono"
                          value={field.value}
                          onChange={(e) =>
                            handleUpdateCustomField(idx, e.target.value)
                          }
                        />
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => handleRemoveCustomField(field.key)}
                          title={`Remove ${field.key}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="input input-bordered input-xs w-36 font-mono"
                    placeholder="field_name"
                    value={newFieldKey}
                    onChange={(e) => setNewFieldKey(e.target.value)}
                  />
                  <input
                    type="text"
                    className="input input-bordered input-xs flex-1 font-mono"
                    placeholder="Value..."
                    value={newFieldValue}
                    onChange={(e) => setNewFieldValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddCustomField();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    onClick={handleAddCustomField}
                  >
                    Add Field
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-base-content/70">
                  Summary
                  <textarea
                    className="textarea textarea-bordered mt-1 h-24 w-full text-xs font-normal"
                    placeholder="Brief summary of document facts or contents..."
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                  />
                </label>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="inspector-password-profile"
                    className="text-xs font-semibold text-base-content/70"
                  >
                    Password Profile (for encrypted PDF / Excel)
                  </label>
                  {onOpenPasswordManager && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs text-primary underline"
                      onClick={onOpenPasswordManager}
                    >
                      Manage Profiles
                    </button>
                  )}
                </div>
                <select
                  id="inspector-password-profile"
                  className="select select-bordered select-sm w-full font-normal"
                  value={assignedPasswordProfile}
                  onChange={(e) => setAssignedPasswordProfile(e.target.value)}
                >
                  <option value="">None (Unprotected or Unassigned)</option>
                  {passwordProfiles.map((prof) => (
                    <option key={prof.profile_id} value={prof.profile_id}>
                      {prof.label} ({prof.profile_id})
                      {prof.hint ? ` — Hint: ${prof.hint}` : ""}
                    </option>
                  ))}
                </select>
                {assignedPasswordProfile && (
                  <p className="mt-1 text-[11px] text-base-content/60">
                    Active Profile:{" "}
                    <span className="font-mono font-medium text-base-content">
                      {assignedPasswordProfile}
                    </span>
                    {passwordProfiles.find(
                      (p) => p.profile_id === assignedPasswordProfile,
                    )?.hint && (
                      <span className="ml-1.5 text-info">
                        — Hint:{" "}
                        {
                          passwordProfiles.find(
                            (p) => p.profile_id === assignedPasswordProfile,
                          )?.hint
                        }
                      </span>
                    )}
                  </p>
                )}
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleSaveMetadata}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save Metadata"}
                </button>
              </div>
            </div>
          )}

          {/* 3. Backlinks Tab */}
          {activeTab === "backlinks" && (
            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-base-content/50 mb-1">
                  Workspace Domain References
                </h4>
                <p className="text-xs text-base-content/60 mb-3">
                  Records across the workspace citing this document via{" "}
                  <code className="font-mono text-xs">
                    {document.canonical_uri}
                  </code>
                </p>
              </div>

              {document.backlinks && document.backlinks.length > 0 ? (
                <div className="divide-y divide-base-content/10 rounded-lg border border-base-content/10">
                  {document.backlinks.map((link) => (
                    <div
                      key={`${link.path}-${link.line_number}`}
                      className="flex items-center justify-between p-3 transition-colors hover:bg-base-200/50"
                    >
                      <div className="min-w-0 flex-1 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="badge badge-ghost badge-xs uppercase font-bold text-[10px]">
                            {link.domain}
                          </span>
                          <span className="font-medium text-xs truncate">
                            {link.filename}
                          </span>
                          {link.pinned_version_id && (
                            <span className="badge badge-warning badge-xs">
                              pinned: {link.pinned_version_id}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-base-content/50">
                          {link.path}
                          {link.line_number ? `:${link.line_number}` : ""}
                        </p>
                        {link.line_excerpt && (
                          <p className="mt-1 font-mono text-[10px] text-base-content/60 truncate bg-base-200/50 p-1 rounded">
                            {link.line_excerpt}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs text-primary"
                        onClick={() => onOpenFile(link.path)}
                      >
                        Open File →
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-base-content/20 p-8 text-center text-xs text-base-content/50">
                  <p>No workspace records currently cite this source.</p>
                  <p className="mt-1 text-[11px] text-base-content/40">
                    To cite this source in tasks, calendar, or finance records,
                    copy:
                  </p>
                  <div className="mt-2 inline-block rounded bg-base-200 px-2 py-1 font-mono text-xs text-base-content/80 select-all">
                    {document.markdown_citation}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Replace / New Version Modal */}
      {isReplaceModalOpen && (
        <UploadModal
          api={api}
          isOpen={isReplaceModalOpen}
          targetSourceId={document.id}
          onClose={() => setIsReplaceModalOpen(false)}
          onSuccess={async () => {
            setIsReplaceModalOpen(false);
            const refreshed = await api.loadSource(document.id);
            onUpdate(refreshed);
          }}
        />
      )}

      {/* Delete Confirmation Modal */}
      {isDeleteModalOpen && (
        <div
          className="modal modal-open z-50 bg-black/50"
          role="dialog"
          aria-modal="true"
        >
          <div className="modal-box max-w-md border border-base-content/10 bg-base-100 p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-error">
              Delete Source Document
            </h3>
            <p className="mt-2 text-sm">
              Are you sure you want to permanently delete{" "}
              <strong>{document.title}</strong> (
              <span className="font-mono text-xs">{document.id}</span>)?
            </p>

            {document.backlinks && document.backlinks.length > 0 && (
              <div className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
                <p className="font-semibold text-warning-content">
                  {document.backlinks.length} workspace file(s) cite this
                  source:
                </p>
                <ul className="mt-1 max-h-24 overflow-y-auto font-mono text-[11px] text-base-content/70 list-disc list-inside">
                  {document.backlinks.map((b) => (
                    <li key={`${b.path}-${b.line_number}`} className="truncate">
                      {b.path}
                    </li>
                  ))}
                </ul>
                <label className="mt-3 flex items-center gap-2 cursor-pointer font-medium text-warning-content">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-warning checkbox-xs"
                    checked={annotateBacklinks}
                    onChange={(e) => setAnnotateBacklinks(e.target.checked)}
                  />
                  <span>
                    Annotate backlinks in workspace files (recommended)
                  </span>
                </label>
                <p className="mt-1 text-[11px] text-base-content/60">
                  Rewrites references to{" "}
                  <code>(deleted source: {document.id})</code> and{" "}
                  <code>; source-deleted: {document.id}</code> to preserve
                  history without broken citations.
                </p>
              </div>
            )}

            <div className="modal-action border-t border-base-content/10 pt-4 mt-6">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setIsDeleteModalOpen(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-error btn-sm"
                onClick={handleDeleteSource}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete Permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
