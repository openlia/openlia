import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WorkspaceDomainInfo } from "../shared/api";
import type { WorkspaceApi } from "./api";

export interface CreateFileOptions {
  starter_id?: string | undefined;
  title?: string | undefined;
  frontmatter?: Record<string, unknown> | undefined;
  sections?: Record<string, string> | undefined;
}

export type CreateFileDialogMode = "template" | "upload";

export interface CreateFileDialogProps {
  api?: WorkspaceApi | undefined;
  availableDomains: WorkspaceDomainInfo[];
  directories?: string[] | undefined;
  error?: string | undefined;
  existingPaths?: Set<string> | undefined;
  initialDomain?: string | undefined;
  initialMode?: CreateFileDialogMode | undefined;
  isCreating: boolean;
  isOpen: boolean;
  onCancel: () => void;
  onCreate: (
    domain: string,
    filename: string,
    options?: CreateFileOptions,
  ) => void;
  onUpload?: ((destinationPath: string, file: File) => void) | undefined;
}

function formatUploadSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = units[0] ?? "KB";
  for (let index = 0; index < units.length - 1 && value >= 1024; index++) {
    value /= 1024;
    unit = units[index + 1] ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

export function CreateFileDialog({
  availableDomains,
  directories,
  error,
  existingPaths,
  initialDomain,
  initialMode = "template",
  isCreating,
  isOpen,
  onCancel,
  onCreate,
  onUpload,
}: CreateFileDialogProps) {
  const domainId = useId();
  const nameId = useId();
  const uploadFolderId = useId();
  const uploadNameId = useId();
  const fileInputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const defaultDomain = useMemo(() => {
    if (
      initialDomain &&
      availableDomains.some((d) => d.path === initialDomain)
    ) {
      return initialDomain;
    }
    return availableDomains[0]?.path ?? "tasks";
  }, [availableDomains, initialDomain]);

  const folderOptions = useMemo(() => {
    const allDirs = new Set<string>([""]);
    for (const d of availableDomains) {
      if (d.path) allDirs.add(d.path);
    }
    if (directories) {
      for (const dir of directories) {
        if (dir) allDirs.add(dir);
      }
    }
    if (initialDomain) {
      allDirs.add(initialDomain);
    }
    return Array.from(allDirs).sort();
  }, [availableDomains, directories, initialDomain]);

  const [mode, setMode] = useState<CreateFileDialogMode>(initialMode);
  const [selectedDomain, setSelectedDomain] = useState(defaultDomain);
  const [fileName, setFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedUploadDir, setSelectedUploadDir] = useState(
    initialDomain ?? "",
  );
  const [customUploadDir, setCustomUploadDir] = useState("");
  const [useCustomUploadDir, setUseCustomUploadDir] = useState(false);
  const [uploadFileName, setUploadFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setSelectedDomain(defaultDomain);
      setFileName("");
      setSelectedFile(null);
      setSelectedUploadDir(initialDomain ?? "");
      setCustomUploadDir("");
      setUseCustomUploadDir(false);
      setUploadFileName("");
      setIsDragging(false);
      setValidationError("");
      setTimeout(() => {
        if (initialMode === "template") {
          inputRef.current?.focus();
        }
      }, 0);
    }
  }, [isOpen, defaultDomain, initialDomain, initialMode]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const activeDomainInfo = availableDomains.find(
    (d) => d.path === selectedDomain,
  );

  const allowNestedSubfolders = selectedDomain === "knowledge";
  const cleanName = fileName.trim().replace(/^\/+/, "");
  const normalizedFileName = cleanName
    ? cleanName.toLowerCase().endsWith(".md")
      ? cleanName
      : `${cleanName}.md`
    : "";
  const previewPath = normalizedFileName
    ? `${selectedDomain}/${normalizedFileName}`
    : `${selectedDomain}/...`;

  const rawUploadDir = useCustomUploadDir ? customUploadDir : selectedUploadDir;
  const cleanUploadDir = rawUploadDir.trim().replace(/^\/+|\/+$/g, "");
  const cleanUploadName = uploadFileName.trim().replace(/^\/+|\/+$/g, "");
  const uploadTargetPath = cleanUploadName
    ? cleanUploadDir
      ? `${cleanUploadDir}/${cleanUploadName}`
      : cleanUploadName
    : "";
  const uploadPreviewPath = uploadTargetPath
    ? uploadTargetPath
    : cleanUploadDir
      ? `${cleanUploadDir}/...`
      : "/...";

  const applySelectedFile = (file: File) => {
    setSelectedFile(file);
    setUploadFileName(file.name);
    setValidationError("");
  };

  const handleSubmitTemplate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cleanName) {
      setValidationError("File name cannot be empty");
      return;
    }
    if (
      (!allowNestedSubfolders && cleanName.includes("/")) ||
      cleanName.includes("\\") ||
      cleanName.includes("..")
    ) {
      setValidationError("File name cannot contain path separators");
      return;
    }
    if (
      cleanName.endsWith("-template.md") ||
      cleanName.endsWith(".schema.json")
    ) {
      setValidationError("Cannot create a template or schema file directly");
      return;
    }
    if (existingPaths?.has(`${selectedDomain}/${normalizedFileName}`)) {
      setValidationError(
        `File "${normalizedFileName}" already exists in ${selectedDomain}`,
      );
      return;
    }

    setValidationError("");
    onCreate(selectedDomain, normalizedFileName);
  };

  const handleSubmitUpload = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setValidationError("Please select a file to upload");
      return;
    }
    if (!cleanUploadName) {
      setValidationError("File name cannot be empty");
      return;
    }
    if (
      cleanUploadName.includes("\\") ||
      cleanUploadDir.includes("\\") ||
      uploadTargetPath
        .split("/")
        .some((seg) => !seg || seg === "." || seg === "..")
    ) {
      setValidationError("File path cannot contain invalid path segments");
      return;
    }
    const baseUploadName =
      uploadTargetPath.split("/").at(-1) ?? uploadTargetPath;
    if (
      baseUploadName.toLowerCase().endsWith("-template.md") ||
      baseUploadName.toLowerCase().endsWith(".schema.json")
    ) {
      setValidationError("Cannot create a template or schema file directly");
      return;
    }
    if (existingPaths?.has(uploadTargetPath)) {
      setValidationError(
        `File "${uploadTargetPath}" already exists in workspace`,
      );
      return;
    }

    setValidationError("");
    onUpload?.(uploadTargetPath, selectedFile);
  };

  const displayedError = validationError || error;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
    >
      <section
        aria-labelledby="create-file-dialog-title"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-base-content/10 bg-base-100 p-6 shadow-2xl space-y-4"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              className="text-base font-semibold"
              id="create-file-dialog-title"
            >
              Create New File
            </h2>
            <p className="mt-1 text-xs text-base-content/60">
              {mode === "template"
                ? "Create a record initialized with this domain's template schema."
                : "Upload a file directly into any folder in this workspace."}
            </p>
          </div>
          <button
            aria-label="Close"
            className="btn btn-ghost btn-xs btn-square"
            onClick={onCancel}
            type="button"
          >
            ✕
          </button>
        </div>

        <div
          aria-label="New file mode"
          className="tabs tabs-boxed bg-base-200/60 p-1"
          role="tablist"
        >
          <button
            aria-selected={mode === "template"}
            className={`tab tab-sm flex-1 font-medium ${mode === "template" ? "tab-active" : ""}`}
            disabled={isCreating}
            onClick={() => {
              setMode("template");
              setValidationError("");
            }}
            role="tab"
            type="button"
          >
            Create from Template
          </button>
          <button
            aria-selected={mode === "upload"}
            className={`tab tab-sm flex-1 font-medium ${mode === "upload" ? "tab-active" : ""}`}
            disabled={isCreating}
            onClick={() => {
              setMode("upload");
              setValidationError("");
            }}
            role="tab"
            type="button"
          >
            Upload File
          </button>
        </div>

        {displayedError && (
          <div
            className="alert alert-error text-xs p-3 rounded-lg"
            role="alert"
          >
            <span>{displayedError}</span>
          </div>
        )}

        {mode === "template" ? (
          <form className="space-y-4" onSubmit={handleSubmitTemplate}>
            <div>
              <label className="text-xs font-semibold" htmlFor={domainId}>
                Domain
              </label>
              <select
                className="select select-bordered select-sm mt-1 w-full"
                disabled={isCreating}
                id={domainId}
                onChange={(e) => {
                  setSelectedDomain(e.target.value);
                  setValidationError("");
                }}
                value={selectedDomain}
              >
                {availableDomains.map((domain) => (
                  <option key={domain.path} value={domain.path}>
                    {domain.label} ({domain.path}/)
                  </option>
                ))}
              </select>
              {activeDomainInfo?.purpose && (
                <p className="mt-1 text-[11px] text-base-content/50">
                  {activeDomainInfo.purpose}
                </p>
              )}
              {selectedDomain === "calendar" && (
                <p className="mt-2 text-xs">
                  This creates an event note, not a scheduled appointment.
                </p>
              )}
              {(selectedDomain === "finance" ||
                selectedDomain.startsWith("finance/")) && (
                <p className="mt-2 text-xs">
                  This creates a template copy. For a complete account mapping
                  before any save,{" "}
                  <a
                    className="link link-primary"
                    href="/files/finance/overview.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    open Finance in a new tab and choose New account
                  </a>
                  .
                </p>
              )}
            </div>

            <div>
              <label className="text-xs font-semibold" htmlFor={nameId}>
                File Name
              </label>
              <input
                ref={inputRef}
                className="input input-bordered input-sm mt-1 w-full font-mono"
                disabled={isCreating}
                id={nameId}
                onChange={(e) => {
                  setFileName(e.target.value);
                  setValidationError("");
                }}
                placeholder={
                  allowNestedSubfolders
                    ? "e.g. project-apollo.md or projects/project-apollo.md"
                    : "e.g. quarterly-review"
                }
                type="text"
                value={fileName}
              />
            </div>

            <div className="rounded-lg border border-base-content/10 bg-base-200/50 p-3 text-xs space-y-1">
              <div className="text-base-content/60 font-medium">
                Target Path:
              </div>
              <code className="block text-primary font-mono text-[11px] truncate">
                {previewPath}
              </code>
              {activeDomainInfo?.template_path && (
                <div className="text-[11px] text-base-content/50">
                  Template:{" "}
                  <span className="font-mono">
                    {activeDomainInfo.template_path}
                  </span>
                </div>
              )}
              {activeDomainInfo?.schema_path && (
                <div className="text-[11px] text-base-content/50">
                  Schema:{" "}
                  <span className="font-mono">
                    {activeDomainInfo.schema_path}
                  </span>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                className="btn btn-ghost btn-sm"
                disabled={isCreating}
                onClick={onCancel}
                type="button"
              >
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={isCreating || !cleanName}
                type="submit"
              >
                {isCreating ? "Creating..." : "Create File"}
              </button>
            </div>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmitUpload}>
            <div>
              <label className="text-xs font-semibold" htmlFor={fileInputId}>
                File
              </label>
              <input
                ref={fileInputRef}
                className="sr-only"
                disabled={isCreating}
                id={fileInputId}
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  if (chosen) applySelectedFile(chosen);
                }}
                type="file"
              />
              <button
                className={`mt-1 flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
                  isDragging
                    ? "border-primary bg-primary/10"
                    : "border-base-content/20 bg-base-200/30 hover:border-base-content/40"
                }`}
                disabled={isCreating}
                onClick={() => fileInputRef.current?.click()}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) applySelectedFile(dropped);
                }}
                type="button"
              >
                {selectedFile ? (
                  <>
                    <span className="text-xs font-semibold text-primary break-all">
                      {selectedFile.name}
                    </span>
                    <span className="text-[11px] text-base-content/60">
                      {formatUploadSize(selectedFile.size)} · Click or drop to
                      replace
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-xs font-medium">
                      Click to choose a file or drag and drop
                    </span>
                    <span className="text-[11px] text-base-content/50">
                      Any file type (Markdown, text, PDF, images, CSV, etc.)
                    </span>
                  </>
                )}
              </button>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label
                  className="text-xs font-semibold"
                  htmlFor={uploadFolderId}
                >
                  Destination Folder
                </label>
                <button
                  className="link link-hover text-[11px] text-primary"
                  disabled={isCreating}
                  onClick={() => {
                    setUseCustomUploadDir((prev) => !prev);
                    setValidationError("");
                  }}
                  type="button"
                >
                  {useCustomUploadDir
                    ? "Choose from existing"
                    : "Enter new folder path"}
                </button>
              </div>
              {useCustomUploadDir ? (
                <input
                  className="input input-bordered input-sm mt-1 w-full font-mono"
                  disabled={isCreating}
                  id={uploadFolderId}
                  onChange={(e) => {
                    setCustomUploadDir(e.target.value);
                    setValidationError("");
                  }}
                  placeholder="e.g. assets or knowledge/diagrams"
                  type="text"
                  value={customUploadDir}
                />
              ) : (
                <select
                  className="select select-bordered select-sm mt-1 w-full font-mono text-xs"
                  disabled={isCreating}
                  id={uploadFolderId}
                  onChange={(e) => {
                    setSelectedUploadDir(e.target.value);
                    setValidationError("");
                  }}
                  value={selectedUploadDir}
                >
                  <option value="">/ (Workspace Root)</option>
                  {folderOptions
                    .filter((dir) => Boolean(dir))
                    .map((dir) => (
                      <option key={dir} value={dir}>
                        {dir}/
                      </option>
                    ))}
                </select>
              )}
            </div>

            <div>
              <label className="text-xs font-semibold" htmlFor={uploadNameId}>
                File Name
              </label>
              <input
                className="input input-bordered input-sm mt-1 w-full font-mono"
                disabled={isCreating}
                id={uploadNameId}
                onChange={(e) => {
                  setUploadFileName(e.target.value);
                  setValidationError("");
                }}
                placeholder="e.g. report.pdf or notes.md"
                type="text"
                value={uploadFileName}
              />
            </div>

            <div className="rounded-lg border border-base-content/10 bg-base-200/50 p-3 text-xs space-y-1">
              <div className="text-base-content/60 font-medium">
                Target Path:
              </div>
              <code className="block text-primary font-mono text-[11px] truncate">
                {uploadPreviewPath}
              </code>
              <div className="text-[11px] text-base-content/50">
                Uploaded file contents are saved directly as-is.
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                className="btn btn-ghost btn-sm"
                disabled={isCreating}
                onClick={onCancel}
                type="button"
              >
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={isCreating || !selectedFile || !cleanUploadName}
                type="submit"
              >
                {isCreating ? "Uploading..." : "Upload File"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
