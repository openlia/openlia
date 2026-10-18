import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentPasswordProfile } from "../../shared/api";
import { suggestPasswordProfiles } from "../../shared/passwordSuggester";
import type { WorkspaceApi } from "../api";

export interface UploadModalProps {
  api: WorkspaceApi;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialFiles?: File[];
  onOpenPasswordManager?: () => void;
}

export function UploadModal({
  api,
  isOpen,
  onClose,
  onSuccess,
  initialFiles = [],
  onOpenPasswordManager,
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

  // Password protection state
  const [passwordProfiles, setPasswordProfiles] = useState<
    DocumentPasswordProfile[]
  >([]);
  const [isPasswordProtected, setIsPasswordProtected] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [customPassword, setCustomPassword] = useState("");
  const [saveProfileLabel, setSaveProfileLabel] = useState("");
  const [saveProfileHint, setSaveProfileHint] = useState("");
  const [saveProfileDesc, setSaveProfileDesc] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
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
  }, [isOpen, api]);

  // Compute smart suggestions based on uploaded files or document title
  const suggestions = useMemo(() => {
    if (passwordProfiles.length === 0) return [];
    const queryFilename = files.length > 0 ? files[0]!.name : textTitle;
    if (!queryFilename) return [];
    return suggestPasswordProfiles(
      { filename: queryFilename, title: textTitle },
      passwordProfiles,
    );
  }, [files, textTitle, passwordProfiles]);

  const topSuggestion = suggestions.length > 0 ? suggestions[0] : null;

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
      if (isPasswordProtected) {
        if (selectedProfileId) {
          formData.append("password_profile", selectedProfileId);
        } else if (customPassword) {
          formData.append("password", customPassword);
          if (saveProfileLabel) {
            formData.append("password_label", saveProfileLabel);
          }
          if (saveProfileHint) {
            formData.append("password_hint", saveProfileHint);
          }
          if (saveProfileDesc) {
            formData.append("password_description", saveProfileDesc);
          }
        }
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
        password_profile:
          isPasswordProtected && selectedProfileId
            ? selectedProfileId
            : undefined,
        password:
          isPasswordProtected && !selectedProfileId && customPassword
            ? customPassword
            : undefined,
        password_label: saveProfileLabel || undefined,
        password_hint: saveProfileHint || undefined,
        password_description: saveProfileDesc || undefined,
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

            {/* Smart Password Suggestion Banner */}
            {topSuggestion && topSuggestion.score >= 40 && (
              <div className="rounded-lg border border-info/30 bg-info/10 p-3 text-xs flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="badge badge-info badge-xs">
                      {topSuggestion.score}% Match
                    </span>
                    <span className="font-semibold text-info-content">
                      Suggested: {topSuggestion.profile.label}
                    </span>
                  </div>
                  {topSuggestion.profile.hint && (
                    <p className="mt-0.5 text-base-content/70">
                      💡 Hint: {topSuggestion.profile.hint}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-xs btn-outline btn-info shrink-0"
                  onClick={() => {
                    setIsPasswordProtected(true);
                    setSelectedProfileId(topSuggestion.profile.profile_id);
                  }}
                >
                  {selectedProfileId === topSuggestion.profile.profile_id
                    ? "Selected ✓"
                    : "Apply Suggestion"}
                </button>
              </div>
            )}

            {/* Password Protection Section */}
            <div className="rounded-lg border border-base-content/10 bg-base-200/30 p-3 text-xs">
              <label className="flex cursor-pointer items-center justify-between">
                <span className="font-semibold flex items-center gap-1.5">
                  <span>🔒 Document Password Protection</span>
                  {selectedProfileId && (
                    <span className="badge badge-primary badge-xs">
                      Profile assigned
                    </span>
                  )}
                </span>
                <input
                  type="checkbox"
                  className="toggle toggle-primary toggle-xs"
                  checked={isPasswordProtected}
                  onChange={(e) => setIsPasswordProtected(e.target.checked)}
                />
              </label>

              {isPasswordProtected && (
                <div className="mt-3 space-y-2.5 pt-2 border-t border-base-content/10">
                  <div className="flex items-center justify-between mb-1">
                    <label
                      htmlFor="upload-file-password-profile"
                      className="block text-base-content/70 font-medium"
                    >
                      {passwordProfiles.length > 0
                        ? "Select Saved Password Profile"
                        : "Password Profiles"}
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
                  {passwordProfiles.length > 0 && (
                    <div>
                      <select
                        id="upload-file-password-profile"
                        className="select select-bordered select-xs w-full"
                        value={selectedProfileId}
                        onChange={(e) => setSelectedProfileId(e.target.value)}
                      >
                        <option value="">
                          -- Choose saved password profile --
                        </option>
                        {passwordProfiles.map((p) => (
                          <option key={p.profile_id} value={p.profile_id}>
                            {p.label} {p.hint ? `(Hint: ${p.hint})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="upload-file-custom-password"
                      className="block text-base-content/70 font-medium mb-1"
                    >
                      {passwordProfiles.length > 0
                        ? "Or Enter New Document Password"
                        : "Enter Document Password"}
                    </label>
                    <input
                      id="upload-file-custom-password"
                      type="password"
                      className="input input-bordered input-xs w-full"
                      placeholder="Enter document password..."
                      value={customPassword}
                      onChange={(e) => {
                        setCustomPassword(e.target.value);
                        if (e.target.value && selectedProfileId) {
                          setSelectedProfileId("");
                        }
                      }}
                    />
                  </div>

                  {customPassword && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      <div>
                        <label
                          htmlFor="upload-file-profile-label"
                          className="block text-base-content/70 text-[11px] mb-0.5"
                        >
                          Save Profile Label (optional)
                        </label>
                        <input
                          id="upload-file-profile-label"
                          type="text"
                          className="input input-bordered input-xs w-full"
                          placeholder="e.g. Chase Bank Checking"
                          value={saveProfileLabel}
                          onChange={(e) => setSaveProfileLabel(e.target.value)}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="upload-file-profile-hint"
                          className="block text-base-content/70 text-[11px] mb-0.5"
                        >
                          Safe Hint (optional)
                        </label>
                        <input
                          id="upload-file-profile-hint"
                          type="text"
                          className="input input-bordered input-xs w-full"
                          placeholder="e.g. Last 4 digits of SSN"
                          value={saveProfileHint}
                          onChange={(e) => setSaveProfileHint(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
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

            {/* Password Protection Section for Text Tab */}
            <div className="rounded-lg border border-base-content/10 bg-base-200/30 p-3 text-xs">
              <label className="flex cursor-pointer items-center justify-between">
                <span className="font-semibold flex items-center gap-1.5">
                  <span>🔒 Document Password Protection</span>
                  {selectedProfileId && (
                    <span className="badge badge-primary badge-xs">
                      Profile assigned
                    </span>
                  )}
                </span>
                <input
                  type="checkbox"
                  className="toggle toggle-primary toggle-xs"
                  checked={isPasswordProtected}
                  onChange={(e) => setIsPasswordProtected(e.target.checked)}
                />
              </label>

              {isPasswordProtected && (
                <div className="mt-3 space-y-2.5 pt-2 border-t border-base-content/10">
                  {passwordProfiles.length > 0 && (
                    <div>
                      <label
                        htmlFor="upload-text-password-profile"
                        className="block text-base-content/70 font-medium mb-1"
                      >
                        Select Saved Password Profile
                      </label>
                      <select
                        id="upload-text-password-profile"
                        className="select select-bordered select-xs w-full"
                        value={selectedProfileId}
                        onChange={(e) => setSelectedProfileId(e.target.value)}
                      >
                        <option value="">
                          -- Choose saved password profile --
                        </option>
                        {passwordProfiles.map((p) => (
                          <option key={p.profile_id} value={p.profile_id}>
                            {p.label} {p.hint ? `(Hint: ${p.hint})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="upload-text-custom-password"
                      className="block text-base-content/70 font-medium mb-1"
                    >
                      {passwordProfiles.length > 0
                        ? "Or Enter New Document Password"
                        : "Enter Document Password"}
                    </label>
                    <input
                      id="upload-text-custom-password"
                      type="password"
                      className="input input-bordered input-xs w-full"
                      placeholder="Enter document password..."
                      value={customPassword}
                      onChange={(e) => {
                        setCustomPassword(e.target.value);
                        if (e.target.value && selectedProfileId) {
                          setSelectedProfileId("");
                        }
                      }}
                    />
                  </div>

                  {customPassword && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      <div>
                        <label
                          htmlFor="upload-text-profile-label"
                          className="block text-base-content/70 text-[11px] mb-0.5"
                        >
                          Save Profile Label (optional)
                        </label>
                        <input
                          id="upload-text-profile-label"
                          type="text"
                          className="input input-bordered input-xs w-full"
                          placeholder="e.g. Confidential Note Key"
                          value={saveProfileLabel}
                          onChange={(e) => setSaveProfileLabel(e.target.value)}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="upload-text-profile-hint"
                          className="block text-base-content/70 text-[11px] mb-0.5"
                        >
                          Safe Hint (optional)
                        </label>
                        <input
                          id="upload-text-profile-hint"
                          type="text"
                          className="input input-bordered input-xs w-full"
                          placeholder="e.g. Team passphrase"
                          value={saveProfileHint}
                          onChange={(e) => setSaveProfileHint(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
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
