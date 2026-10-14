import { useState, useEffect } from "react";
import type { SourceDocument, SourceUpdateRequest } from "../../shared/api";
import { api } from "../api";

export interface DocumentInspectorProps {
  document: SourceDocument | null;
  loading: boolean;
  onUpdate: (updated: SourceDocument) => void;
  onOpenFile: (path: string) => void;
  rawUrl: (path: string) => string;
}

export function DocumentInspector({
  document,
  loading,
  onUpdate,
  onOpenFile,
  rawUrl,
}: DocumentInspectorProps) {
  const [activeTab, setActiveTab] = useState<"content" | "metadata" | "backlinks">("content");
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCitation, setCopiedCitation] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Form edit state
  const [title, setTitle] = useState("");
  const [correspondent, setCorrespondent] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [summary, setSummary] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState("");

  useEffect(() => {
    if (document) {
      setTitle(document.title ?? "");
      setCorrespondent(document.correspondent ?? "");
      setDocumentType(document.document_type ?? "");
      setDocumentDate(document.document_date ?? "");
      setSummary(document.summary ?? "");
      setTags(document.tags ?? []);
      setSaveError(null);
    }
  }, [document]);

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
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <p className="text-sm font-semibold">Select a document to inspect</p>
        <p className="text-xs max-w-sm mt-1">
          Review OCR extractions, edit correspondent and metadata, and inspect domain backlinks.
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
      setSaveError(err instanceof Error ? err.message : "Failed to update review status");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveMetadata() {
    if (!document) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updates: SourceUpdateRequest = {
        title: title.trim() || document.title,
        correspondent: correspondent.trim() || null,
        document_type: documentType.trim() || null,
        document_date: documentDate.trim() || null,
        summary: summary.trim() || null,
        tags: tags,
      };
      const updated = await api.updateSource(document.id, updates);
      onUpdate(updated);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save metadata");
    } finally {
      setSaving(false);
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

  const latestVersion =
    document.versions.length > 0
      ? (document.versions[document.versions.length - 1] as { original_ref?: string })
      : null;
  const originalRef = latestVersion?.original_ref;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-base-100">
      {/* Inspector Header */}
      <div className="border-b border-base-content/10 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-base-content/50">
                {document.id}
              </span>
              {document.document_type && (
                <span className="badge badge-outline badge-xs capitalize">
                  {document.document_type}
                </span>
              )}
              {document.processing.status !== "complete" && (
                <span className="badge badge-info badge-xs">
                  {document.processing.status}
                </span>
              )}
            </div>
            <h2 className="mt-1 text-xl font-bold break-words">{document.title}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-base-content/60">
              {document.correspondent && (
                <span>
                  Correspondent: <strong>{document.correspondent}</strong>
                </span>
              )}
              {document.document_date && <span>Date: {document.document_date}</span>}
              <span>Captured: {new Date(document.captured_at).toLocaleDateString()}</span>
            </div>
          </div>

          {/* Quick Review Action */}
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
              className="btn btn-ghost btn-sm"
              onClick={copyMarkdownCitation}
              title="Copy markdown citation link"
            >
              {copiedCitation ? "Copied!" : "Copy Citation"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={copyCanonicalUri}
              title="Copy canonical URI (openlia://source/...)"
            >
              {copiedLink ? "Copied URI!" : "Copy URI"}
            </button>
          </div>
        </div>

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

      {/* Tab Panels */}
      <div className="flex-1 p-5 overflow-y-auto">
        {/* 1. Content Tab */}
        {activeTab === "content" && (
          <div className="space-y-4">
            {originalRef && (
              <div className="flex items-center justify-between rounded-lg border border-base-content/10 bg-base-200/50 p-3 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <svg className="h-4 w-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  <span className="truncate font-mono">{originalRef}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={rawUrl(originalRef)}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-ghost btn-xs"
                  >
                    View Original
                  </a>
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    onClick={() => onOpenFile(`sources/records/${document.id}.md`)}
                  >
                    Open Record
                  </button>
                </div>
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-base-content/50 mb-2">
                Extracted Text & Extractions
              </h4>
              {document.content ? (
                <div className="rounded-lg border border-base-content/10 bg-base-200/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap max-h-[600px] overflow-y-auto">
                  {document.content}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-base-content/20 p-8 text-center text-xs text-base-content/50">
                  No text extractions available yet.
                  {document.processing.status === "queued" && " The document is queued for OCR extraction."}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 2. Metadata Tab */}
        {activeTab === "metadata" && (
          <div className="max-w-xl space-y-4">
            <div>
              <label className="text-xs font-semibold text-base-content/70">Title</label>
              <input
                type="text"
                className="input input-bordered input-sm mt-1 w-full"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-base-content/70">Correspondent</label>
                <input
                  type="text"
                  className="input input-bordered input-sm mt-1 w-full"
                  placeholder="e.g. ACME Corp, Bank"
                  value={correspondent}
                  onChange={(e) => setCorrespondent(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-base-content/70">Document Type</label>
                <input
                  type="text"
                  className="input input-bordered input-sm mt-1 w-full"
                  placeholder="e.g. invoice, statement, receipt"
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-base-content/70">Document Date</label>
              <input
                type="date"
                className="input input-bordered input-sm mt-1 w-full"
                value={documentDate}
                onChange={(e) => setDocumentDate(e.target.value)}
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-base-content/70">Tags</label>
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

            <div>
              <label className="text-xs font-semibold text-base-content/70">Summary</label>
              <textarea
                className="textarea textarea-bordered mt-1 h-24 w-full text-xs"
                placeholder="Brief summary of document facts or contents..."
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
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
                Records across the workspace citing this document via <code className="font-mono text-xs">{document.canonical_uri}</code>
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
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-base-content/50">
                        {link.path}
                        {link.line_number ? `:${link.line_number}` : ""}
                      </p>
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
                  To cite this source in tasks, calendar, or finance records, copy:
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
  );
}
