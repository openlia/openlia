import { type DragEvent, useEffect, useRef, useState } from "react";
import type {
  DocumentPasswordProfile,
  PasswordSuggestion,
} from "../../shared/api";
import { suggestPasswordProfiles } from "../../shared/passwordSuggester";
import type { WorkspaceApi } from "../api";

export interface UploadFileItem {
  id: string;
  file: File;
  isPasswordProtected: boolean;
  selectedProfileId: string;
  customPassword?: string | undefined;
  saveProfileLabel?: string | undefined;
  saveProfileHint?: string | undefined;
  suggestedProfile?: PasswordSuggestion | null | undefined;
  status: "idle" | "uploading" | "success" | "error";
  errorMessage?: string | undefined;
}

export interface UploadModalProps {
  api: WorkspaceApi;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialFiles?: File[];
  onOpenPasswordManager?: () => void;
  targetSourceId?: string;
}

function createFileItem(
  file: File,
  profiles: DocumentPasswordProfile[],
): UploadFileItem {
  const suggestions =
    profiles.length > 0
      ? suggestPasswordProfiles({ filename: file.name }, profiles)
      : [];
  const top = suggestions.length > 0 ? suggestions[0] : null;
  const autoSelect = top && top.score >= 70;
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    file,
    isPasswordProtected: Boolean(autoSelect),
    selectedProfileId: autoSelect ? top.profile.profile_id : "",
    customPassword: "",
    saveProfileLabel: "",
    saveProfileHint: "",
    suggestedProfile: top && top.score >= 40 ? top : null,
    status: "idle",
  };
}

export function UploadModal({
  api,
  isOpen,
  onClose,
  onSuccess,
  initialFiles = [],
  onOpenPasswordManager,
  targetSourceId,
}: UploadModalProps) {
  const [tab, setTab] = useState<"files" | "text">("files");
  const [fileItems, setFileItems] = useState<UploadFileItem[]>(() =>
    (targetSourceId ? initialFiles.slice(0, 1) : initialFiles).map((f) =>
      createFileItem(f, []),
    ),
  );
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [purgePreviousVersions, setPurgePreviousVersions] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Batch password settings
  const [batchProfileId, setBatchProfileId] = useState("");
  const [batchPassword, setBatchPassword] = useState("");
  const [showBatchTools, setShowBatchTools] = useState(false);

  // Text tab state
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [textKind, setTextKind] = useState("text");
  const [textPasswordProtected, setTextPasswordProtected] = useState(false);
  const [textSelectedProfileId, setTextSelectedProfileId] = useState("");
  const [textCustomPassword, setTextCustomPassword] = useState("");
  const [textSaveProfileLabel, setTextSaveProfileLabel] = useState("");
  const [textSaveProfileHint, setTextSaveProfileHint] = useState("");
  const [textSaveProfileDescription, setTextSaveProfileDescription] =
    useState("");

  // Loaded profiles
  const [passwordProfiles, setPasswordProfiles] = useState<
    DocumentPasswordProfile[]
  >([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setFileItems(
        (targetSourceId ? initialFiles.slice(0, 1) : initialFiles).map((file) =>
          createFileItem(file, passwordProfiles),
        ),
      );
      setError(null);
      setUploading(false);
    }
    prevOpenRef.current = isOpen;
  }, [isOpen, initialFiles, passwordProfiles, targetSourceId]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api
      .listDocumentPasswords()
      .then((res) => {
        if (!cancelled) {
          const profiles = res.profiles ?? [];
          setPasswordProfiles(profiles);
          setFileItems((prev) =>
            prev.map((item) => {
              if (item.selectedProfileId || item.customPassword) return item;
              const suggestions = suggestPasswordProfiles(
                { filename: item.file.name },
                profiles,
              );
              const top = suggestions[0];
              const autoSelect = top && top.score >= 70;
              return {
                ...item,
                isPasswordProtected:
                  Boolean(autoSelect) || item.isPasswordProtected,
                selectedProfileId: autoSelect
                  ? top.profile.profile_id
                  : item.selectedProfileId,
                suggestedProfile: top && top.score >= 40 ? top : null,
              };
            }),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setPasswordProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, api]);

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
      if (targetSourceId && fileItems.length > 0) {
        setError("Replace / New Version accepts one file at a time.");
        return;
      }
      if (targetSourceId && dropped.length > 1) {
        setError("Replace / New Version accepts one file at a time.");
      }
      const filesToAdd = targetSourceId ? dropped.slice(0, 1) : dropped;
      setFileItems((prev) => [
        ...prev,
        ...filesToAdd.map((f) => createFileItem(f, passwordProfiles)),
      ]);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      const selected = Array.from(e.target.files);
      if (targetSourceId && fileItems.length > 0) {
        setError("Replace / New Version accepts one file at a time.");
        return;
      }
      if (targetSourceId && selected.length > 1) {
        setError("Replace / New Version accepts one file at a time.");
      }
      const filesToAdd = targetSourceId ? selected.slice(0, 1) : selected;
      setFileItems((prev) => [
        ...prev,
        ...filesToAdd.map((f) => createFileItem(f, passwordProfiles)),
      ]);
    }
  }

  function removeFile(id: string) {
    setFileItems((prev) => prev.filter((item) => item.id !== id));
  }

  function updateFileItem(id: string, patch: Partial<UploadFileItem>) {
    setFileItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  function applyBatchSettings() {
    setFileItems((prev) =>
      prev.map((item) => ({
        ...item,
        isPasswordProtected: Boolean(batchProfileId || batchPassword),
        selectedProfileId: batchProfileId,
        customPassword: batchProfileId ? "" : batchPassword,
      })),
    );
  }

  async function handleUploadFiles() {
    const pendingItems = fileItems.filter((i) => i.status !== "success");
    if (pendingItems.length === 0) return;
    if (targetSourceId && pendingItems.length > 1) {
      setError("Replace / New Version accepts one file at a time.");
      return;
    }
    setUploading(true);
    setError(null);

    let hasErrors = false;
    for (const item of pendingItems) {
      updateFileItem(item.id, {
        status: "uploading",
        errorMessage: undefined,
      });

      try {
        const formData = new FormData();
        formData.append("files", item.file);

        if (targetSourceId) {
          formData.append("source_id", targetSourceId);
          if (purgePreviousVersions) {
            formData.append("purge_previous_versions", "true");
          }
        }

        if (item.isPasswordProtected) {
          if (item.selectedProfileId) {
            formData.append("password_profile", item.selectedProfileId);
          } else if (item.customPassword) {
            formData.append("password", item.customPassword);
            if (item.saveProfileLabel) {
              formData.append("password_label", item.saveProfileLabel);
            }
            if (item.saveProfileHint) {
              formData.append("password_hint", item.saveProfileHint);
            }
          }
        }

        await api.uploadDocument(formData);
        updateFileItem(item.id, { status: "success" });
      } catch (err) {
        hasErrors = true;
        updateFileItem(item.id, {
          status: "error",
          errorMessage: err instanceof Error ? err.message : "Upload failed",
        });
      }
    }

    setUploading(false);
    if (!hasErrors) {
      setFileItems([]);
      onSuccess();
      onClose();
    } else {
      setError(
        "Some files could not be uploaded. Please verify credentials and retry.",
      );
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
        source_id: targetSourceId,
        purge_previous_versions: purgePreviousVersions,
        password_profile:
          textPasswordProtected && textSelectedProfileId
            ? textSelectedProfileId
            : undefined,
        password:
          textPasswordProtected && !textSelectedProfileId && textCustomPassword
            ? textCustomPassword
            : undefined,
        password_label: textSaveProfileLabel || undefined,
        password_hint: textSaveProfileHint || undefined,
        password_description: textSaveProfileDescription || undefined,
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

  const pendingCount = fileItems.filter((i) => i.status !== "success").length;
  const failedCount = fileItems.filter((i) => i.status === "error").length;

  return (
    <div
      className="modal modal-open z-50 bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
    >
      <div className="modal-box max-w-2xl border border-base-content/10 bg-base-100 p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-base-content/10 pb-4">
          <h3 id="upload-modal-title" className="text-lg font-bold">
            {targetSourceId
              ? "Upload New Version / Replace Source"
              : "Upload & Ingest Documents"}
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
              className={`w-full flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
                isDragging
                  ? "border-primary bg-primary/10"
                  : "border-base-content/20 hover:border-primary/50 hover:bg-base-200/50"
              }`}
            >
              <svg
                className="h-8 w-8 text-base-content/40"
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
                Subtitles, Markdown, Text
              </p>
              <span className="btn btn-outline btn-xs mt-2 pointer-events-none">
                Browse Files
              </span>
              <input
                ref={fileInputRef}
                type="file"
                multiple={!targetSourceId}
                className="hidden"
                onChange={handleFileChange}
              />
            </button>

            {/* Batch "Apply to All" toolbar */}
            {fileItems.length > 1 && (
              <div className="rounded-lg border border-base-content/15 bg-base-200/50 p-2.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-base-content/80 flex items-center gap-1.5">
                    <span>⚡ Batch Password Action</span>
                    <span className="text-base-content/50 font-normal">
                      ({fileItems.length} files selected)
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs text-primary"
                    onClick={() => setShowBatchTools(!showBatchTools)}
                  >
                    {showBatchTools ? "Hide Tools ▲" : "Apply to all files ▼"}
                  </button>
                </div>

                {showBatchTools && (
                  <div className="mt-2.5 pt-2 border-t border-base-content/10 flex flex-wrap items-center gap-2">
                    <select
                      className="select select-bordered select-xs flex-1 min-w-[200px]"
                      value={batchProfileId}
                      onChange={(e) => {
                        setBatchProfileId(e.target.value);
                        if (e.target.value) setBatchPassword("");
                      }}
                      aria-label="Batch password profile"
                    >
                      <option value="">
                        -- Choose saved profile for all files --
                      </option>
                      {passwordProfiles.map((p) => (
                        <option key={p.profile_id} value={p.profile_id}>
                          {p.label} {p.hint ? `(Hint: ${p.hint})` : ""}
                        </option>
                      ))}
                    </select>
                    {!batchProfileId && (
                      <input
                        type="password"
                        placeholder="Or custom password for all..."
                        className="input input-bordered input-xs flex-1 min-w-[160px]"
                        value={batchPassword}
                        onChange={(e) => setBatchPassword(e.target.value)}
                        aria-label="Batch custom password"
                      />
                    )}
                    <button
                      type="button"
                      className="btn btn-primary btn-xs"
                      onClick={applyBatchSettings}
                      disabled={!batchProfileId && !batchPassword}
                    >
                      Apply to All Files
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Selected files list with per-file credentials */}
            {fileItems.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-base-content/70">
                  <span>
                    Files to upload ({fileItems.length})
                    {failedCount > 0 && (
                      <span className="ml-2 text-error">
                        ({failedCount} failed)
                      </span>
                    )}
                  </span>
                  {onOpenPasswordManager && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs text-primary underline"
                      onClick={onOpenPasswordManager}
                    >
                      Manage Saved Profiles
                    </button>
                  )}
                </div>

                <div className="max-h-64 space-y-2.5 overflow-y-auto pr-1">
                  {fileItems.map((item) => (
                    <div
                      key={item.id}
                      className={`rounded-lg border p-3 text-xs transition-colors ${
                        item.status === "error"
                          ? "border-error/40 bg-error/5"
                          : item.status === "success"
                            ? "border-success/40 bg-success/5"
                            : "border-base-content/10 bg-base-200/40"
                      }`}
                    >
                      {/* File item header */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1 truncate font-medium flex items-center gap-2">
                          <span className="truncate">{item.file.name}</span>
                          <span className="text-[11px] text-base-content/50 shrink-0">
                            ({(item.file.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {item.status === "uploading" && (
                            <span className="flex items-center gap-1 text-primary text-[11px]">
                              <span className="loading loading-spinner loading-xs" />
                              Uploading...
                            </span>
                          )}
                          {item.status === "success" && (
                            <span className="badge badge-success badge-xs">
                              ✓ Complete
                            </span>
                          )}
                          {item.status === "error" && (
                            <span className="badge badge-error badge-xs">
                              Failed
                            </span>
                          )}
                          {item.status !== "uploading" && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs text-error"
                              onClick={() => removeFile(item.id)}
                              aria-label={`Remove ${item.file.name}`}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Error message */}
                      {item.status === "error" && item.errorMessage && (
                        <div className="mt-1 text-error text-[11px] font-medium">
                          Error: {item.errorMessage}
                        </div>
                      )}

                      {/* Per-file Password Configuration */}
                      <div className="mt-2.5 pt-2 border-t border-base-content/10 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              className="checkbox checkbox-primary checkbox-xs"
                              checked={item.isPasswordProtected}
                              onChange={(e) =>
                                updateFileItem(item.id, {
                                  isPasswordProtected: e.target.checked,
                                })
                              }
                            />
                            <span className="font-medium text-base-content/80">
                              🔒 Requires Password
                            </span>
                          </label>

                          {/* Smart suggestion pill for this file */}
                          {item.suggestedProfile &&
                            !item.selectedProfileId &&
                            !item.customPassword && (
                              <button
                                type="button"
                                className="badge badge-info badge-outline badge-sm gap-1 hover:badge-info cursor-pointer transition-colors"
                                onClick={() =>
                                  updateFileItem(item.id, {
                                    isPasswordProtected: true,
                                    selectedProfileId:
                                      item.suggestedProfile?.profile
                                        .profile_id ?? "",
                                  })
                                }
                                title={item.suggestedProfile.match_reasons.join(
                                  ", ",
                                )}
                              >
                                <span>💡 Suggest:</span>
                                <span className="font-semibold">
                                  {item.suggestedProfile.profile.label}
                                </span>
                                <span>
                                  ({item.suggestedProfile.score}% match)
                                </span>
                              </button>
                            )}
                        </div>

                        {item.isPasswordProtected && (
                          <div className="pl-5 space-y-2">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div>
                                <select
                                  className="select select-bordered select-xs w-full"
                                  value={item.selectedProfileId}
                                  onChange={(e) => {
                                    updateFileItem(item.id, {
                                      selectedProfileId: e.target.value,
                                      customPassword: e.target.value
                                        ? ""
                                        : (item.customPassword ?? ""),
                                    });
                                  }}
                                  aria-label={`Password profile for ${item.file.name}`}
                                >
                                  <option value="">
                                    -- Choose saved profile --
                                  </option>
                                  {passwordProfiles.map((p) => (
                                    <option
                                      key={p.profile_id}
                                      value={p.profile_id}
                                    >
                                      {p.label}{" "}
                                      {p.hint ? `(Hint: ${p.hint})` : ""}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              <div>
                                <input
                                  type="password"
                                  className="input input-bordered input-xs w-full"
                                  placeholder={
                                    item.selectedProfileId
                                      ? "Profile selected (or enter custom)"
                                      : "Or enter password..."
                                  }
                                  value={item.customPassword ?? ""}
                                  onChange={(e) => {
                                    updateFileItem(item.id, {
                                      customPassword: e.target.value,
                                      selectedProfileId: e.target.value
                                        ? ""
                                        : item.selectedProfileId,
                                    });
                                  }}
                                  aria-label={`Custom password for ${item.file.name}`}
                                />
                              </div>
                            </div>

                            {/* Optional Save profile fields for custom password */}
                            {item.customPassword && !item.selectedProfileId && (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-[11px]">
                                <input
                                  type="text"
                                  className="input input-bordered input-xs w-full"
                                  placeholder="Save Profile Label (optional)"
                                  value={item.saveProfileLabel ?? ""}
                                  onChange={(e) =>
                                    updateFileItem(item.id, {
                                      saveProfileLabel: e.target.value,
                                    })
                                  }
                                />
                                <input
                                  type="text"
                                  className="input input-bordered input-xs w-full"
                                  placeholder="Safe Hint (optional)"
                                  value={item.saveProfileHint ?? ""}
                                  onChange={(e) =>
                                    updateFileItem(item.id, {
                                      saveProfileHint: e.target.value,
                                    })
                                  }
                                />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {targetSourceId && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
                <label className="flex items-center gap-2 cursor-pointer font-medium text-warning-content">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-warning checkbox-xs"
                    checked={purgePreviousVersions}
                    onChange={(e) => setPurgePreviousVersions(e.target.checked)}
                  />
                  <span>
                    Purge previous versions instead of keeping version history
                  </span>
                </label>
                <p className="mt-1 text-[11px] text-base-content/70">
                  By default, OpenLia preserves earlier versions in history.
                  Check this to permanently remove earlier versions.
                </p>
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
                disabled={pendingCount === 0 || uploading}
              >
                {uploading
                  ? "Ingesting..."
                  : targetSourceId
                    ? "Upload New Version"
                    : failedCount > 0
                      ? `Retry Failed (${failedCount})`
                      : `Upload & Ingest (${fileItems.length})`}
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
                  {textSelectedProfileId && (
                    <span className="badge badge-primary badge-xs">
                      Profile assigned
                    </span>
                  )}
                </span>
                <input
                  type="checkbox"
                  className="toggle toggle-primary toggle-xs"
                  checked={textPasswordProtected}
                  onChange={(e) => setTextPasswordProtected(e.target.checked)}
                />
              </label>

              {textPasswordProtected && (
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
                        value={textSelectedProfileId}
                        onChange={(e) =>
                          setTextSelectedProfileId(e.target.value)
                        }
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
                      value={textCustomPassword}
                      onChange={(e) => {
                        setTextCustomPassword(e.target.value);
                        if (e.target.value && textSelectedProfileId) {
                          setTextSelectedProfileId("");
                        }
                      }}
                    />
                  </div>

                  {textCustomPassword && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
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
                          value={textSaveProfileLabel}
                          onChange={(e) =>
                            setTextSaveProfileLabel(e.target.value)
                          }
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
                          value={textSaveProfileHint}
                          onChange={(e) =>
                            setTextSaveProfileHint(e.target.value)
                          }
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="upload-text-profile-description"
                          className="block text-base-content/70 text-[11px] mb-0.5"
                        >
                          Description (optional)
                        </label>
                        <input
                          id="upload-text-profile-description"
                          type="text"
                          className="input input-bordered input-xs w-full"
                          placeholder="e.g. Shared finance documents"
                          value={textSaveProfileDescription}
                          onChange={(e) =>
                            setTextSaveProfileDescription(e.target.value)
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {targetSourceId && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
                <label className="flex items-center gap-2 cursor-pointer font-medium text-warning-content">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-warning checkbox-xs"
                    checked={purgePreviousVersions}
                    onChange={(e) => setPurgePreviousVersions(e.target.checked)}
                  />
                  <span>
                    Purge previous versions instead of keeping version history
                  </span>
                </label>
                <p className="mt-1 text-[11px] text-base-content/70">
                  By default, OpenLia preserves earlier versions in history.
                  Check this to permanently remove earlier versions.
                </p>
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
                onClick={handleUploadText}
                disabled={!textContent.trim() || uploading}
              >
                {uploading
                  ? "Ingesting..."
                  : targetSourceId
                    ? "Save New Version"
                    : "Ingest Document"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
