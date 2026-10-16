import { useState, useRef, type DragEvent } from "react";
import type { WorkspaceApi } from "../api";

export interface UploadModalProps {
  api: WorkspaceApi;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialFiles?: File[];
}

export function UploadModal({
  api,
  isOpen,
  onClose,
  onSuccess,
  initialFiles = [],
}: UploadModalProps) {
  const [tab, setTab] = useState<"files" | "text">("files");
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Text tab state
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [textKind, setTextKind] = useState("text");

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  function handleDragOver(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const dropped = Array.from(e.dataTransfer.files);
      setFiles((prev) => [...prev, ...dropped]);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      const selected = Array.from(e.target.files);
      setFiles((prev) => [...prev, ...selected]);
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleUploadFiles() {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      await api.uploadDocument(formData);
      setFiles([]);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleUploadText() {
    if (!textContent.trim()) {
      setError("Please enter document content");
      return;
    }
    setUploading(true);
    setError(null);

    try {
      await api.uploadDocumentJson({
        title: textTitle.trim() || undefined,
        content: textContent,
        kind: textKind,
      });
      setTextTitle("");
      setTextContent("");
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      className="modal modal-open z-50 bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
    >
      <div className="modal-box max-w-xl border border-base-content/10 bg-base-100 p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-base-content/10 pb-4">
          <h3 id="upload-modal-title" className="text-lg font-bold">
            Upload & Ingest Documents
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Tab switch */}
        <div className="tabs tabs-boxed mt-4 bg-base-200">
          <button
            type="button"
            className={`tab ${tab === "files" ? "tab-active" : ""}`}
            onClick={() => setTab("files")}
          >
            File Upload (PDF, Images, CSV, Office)
          </button>
          <button
            type="button"
            className={`tab ${tab === "text" ? "tab-active" : ""}`}
            onClick={() => setTab("text")}
          >
            Paste Text & Notes
          </button>
        </div>

        {error && (
          <div className="alert alert-error mt-4 text-xs" role="alert">
            <span>{error}</span>
          </div>
        )}

        {tab === "files" ? (
          <div className="mt-4 space-y-4">
            {/* Drag and drop zone */}
            <button
              type="button"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`w-full flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
                isDragging
                  ? "border-primary bg-primary/10"
                  : "border-base-content/20 hover:border-primary/50 hover:bg-base-200/50"
              }`}
            >
              <svg
                className="h-10 w-10 text-base-content/40"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <title>Upload files</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
              <p className="mt-2 text-sm font-semibold">
                Drag & drop document files here
              </p>
              <p className="text-xs text-base-content/50">
                Supports PDF, Images (PNG, JPG, WebP), Spreadsheets (XLSX, CSV),
                Markdown, Text
              </p>
              <span className="btn btn-outline btn-xs mt-3 pointer-events-none">
                Browse Files
              </span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
            </button>

            {/* Selected files list */}
            {files.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-base-content/70">
                  {files.length} file{files.length > 1 ? "s" : ""} to upload:
                </p>
                <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
                  {files.map((file, idx) => (
                    <div
                      key={`${file.name}-${file.size}-${file.lastModified}`}
                      className="flex items-center justify-between rounded-lg border border-base-content/10 bg-base-200/40 p-2 text-xs"
                    >
                      <div className="min-w-0 flex-1 truncate pr-2">
                        <span className="font-medium">{file.name}</span>
                        <span className="ml-2 text-base-content/50">
                          ({(file.size / 1024).toFixed(1)} KB)
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs text-error"
                        onClick={() => removeFile(idx)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="modal-action border-t border-base-content/10 pt-4">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onClose}
                disabled={uploading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleUploadFiles}
                disabled={files.length === 0 || uploading}
              >
                {uploading
                  ? "Ingesting..."
                  : `Upload & Ingest (${files.length})`}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-base-content/70">
                Document Title (Optional)
                <input
                  type="text"
                  className="input input-bordered input-sm mt-1 w-full font-normal"
                  placeholder="e.g. Meeting Note, Financial Statement, Invoice Snippet"
                  value={textTitle}
                  onChange={(e) => setTextTitle(e.target.value)}
                />
              </label>
            </div>

            <div>
              <label className="block text-xs font-semibold text-base-content/70">
                Format / Kind
                <select
                  className="select select-bordered select-sm mt-1 w-full font-normal"
                  value={textKind}
                  onChange={(e) => setTextKind(e.target.value)}
                >
                  <option value="text">Plain Text / Markdown</option>
                  <option value="chat">Chat Transcript / Excerpt</option>
                  <option value="csv">CSV Data</option>
                </select>
              </label>
            </div>

            <div>
              <label className="block text-xs font-semibold text-base-content/70">
                Document Content
                <textarea
                  className="textarea textarea-bordered mt-1 h-36 w-full font-mono text-xs font-normal"
                  placeholder="Paste document text, invoice lines, statement details, or markdown here..."
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                />
              </label>
            </div>

            <div className="modal-action border-t border-base-content/10 pt-4">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onClose}
                disabled={uploading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleUploadText}
                disabled={!textContent.trim() || uploading}
              >
                {uploading ? "Ingesting..." : "Ingest Document"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
