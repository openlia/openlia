import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DocumentScope } from "../shared/api";

export type CreateFileDialogMode = "create" | "upload";

export interface CreateFileDialogProps {
  directories?: string[] | undefined;
  error?: string | undefined;
  existingPaths?: Set<string> | undefined;
  initialDirectory?: string | undefined;
  initialMode?: CreateFileDialogMode | undefined;
  isCreating: boolean;
  isOpen: boolean;
  onCancel: () => void;
  onCreate: (path: string, content?: string) => void;
  onUpload?: ((destinationPath: string, file: File) => void) | undefined;
  scope?: DocumentScope | undefined;
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
  directories = [],
  error,
  existingPaths,
  initialDirectory = "",
  initialMode = "create",
  isCreating,
  isOpen,
  onCancel,
  onCreate,
  onUpload,
  scope = "workspace",
}: CreateFileDialogProps) {
  const folderId = useId();
  const nameId = useId();
  const uploadFolderId = useId();
  const uploadNameId = useId();
  const fileInputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const folderOptions = useMemo(() => {
    const allDirs = new Set<string>([""]);
    for (const dir of directories) {
      if (dir) allDirs.add(dir);
    }
    if (initialDirectory) {
      allDirs.add(initialDirectory);
    }
    return Array.from(allDirs).sort();
  }, [directories, initialDirectory]);

  const [mode, setMode] = useState<CreateFileDialogMode>(initialMode);
  const [selectedDir, setSelectedDir] = useState(initialDirectory);
  const [customDir, setCustomDir] = useState("");
  const [useCustomDir, setUseCustomDir] = useState(false);
  const [filename, setFilename] = useState("");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadFileName, setUploadFileName] = useState("");
  const [selectedUploadDir, setSelectedUploadDir] = useState(initialDirectory);
  const [customUploadDir, setCustomUploadDir] = useState("");
  const [useCustomUploadDir, setUseCustomUploadDir] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setMode(initialMode);
    setSelectedDir(initialDirectory);
    setCustomDir("");
    setUseCustomDir(false);
    setFilename("");
    setSelectedFile(null);
    setUploadFileName("");
    setSelectedUploadDir(initialDirectory);
    setCustomUploadDir("");
    setUseCustomUploadDir(false);
    setValidationError("");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [isOpen, initialDirectory, initialMode]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isCreating) {
        onCancel();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, isCreating, onCancel]);

  if (!isOpen) return null;

  const targetCreateDir = (
    useCustomDir ? customDir.trim() : selectedDir
  ).replace(/^\/+|\/+$/g, "");
  const rawCreateName = filename.trim();
  const normalizedCreateName =
    rawCreateName && !rawCreateName.includes(".")
      ? `${rawCreateName}.md`
      : rawCreateName;
  const previewPath = targetCreateDir
    ? `${targetCreateDir}/${normalizedCreateName || "<name>.md"}`
    : normalizedCreateName || "<name>.md";

  const targetUploadDir = (
    useCustomUploadDir ? customUploadDir.trim() : selectedUploadDir
  ).replace(/^\/+|\/+$/g, "");
  const cleanUploadName = uploadFileName.trim();
  const uploadPreviewPath = targetUploadDir
    ? `${targetUploadDir}/${cleanUploadName || "<file>"}`
    : cleanUploadName || "<file>";

  function handleSelectedFile(file: File | null) {
    setSelectedFile(file);
    setValidationError("");
    if (file) {
      setUploadFileName(file.name);
    }
  }

  function handleCreateSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!normalizedCreateName) {
      setValidationError("Please enter a file name.");
      return;
    }
    if (
      normalizedCreateName.includes("/") ||
      normalizedCreateName.includes("\\")
    ) {
      setValidationError("File name cannot contain path separators.");
      return;
    }
    if (normalizedCreateName.startsWith(".")) {
      setValidationError("File name cannot start with a dot.");
      return;
    }
    const targetPath = targetCreateDir
      ? `${targetCreateDir}/${normalizedCreateName}`
      : normalizedCreateName;
    if (existingPaths?.has(targetPath)) {
      setValidationError(`File "${targetPath}" already exists.`);
      return;
    }
    setValidationError("");
    let initialContent: string | undefined;
    if (
      scope === "skills" &&
      (normalizedCreateName === "SKILL.md" ||
        normalizedCreateName.endsWith("/SKILL.md"))
    ) {
      const skillName = targetCreateDir
        ? (targetCreateDir.split("/").pop() ?? "my-skill")
        : "my-skill";
      initialContent = `---\nname: ${skillName}\ndescription: Description for ${skillName}\n---\n\n# ${skillName}\n\n`;
    }
    onCreate(targetPath, initialContent);
  }

  function handleUploadSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!onUpload) return;
    if (!selectedFile) {
      setValidationError("Please choose a file to upload.");
      return;
    }
    if (!cleanUploadName) {
      setValidationError("File name cannot be empty.");
      return;
    }
    if (cleanUploadName.includes("/") || cleanUploadName.includes("\\")) {
      setValidationError("File name cannot contain path separators.");
      return;
    }
    const destinationPath = targetUploadDir
      ? `${targetUploadDir}/${cleanUploadName}`
      : cleanUploadName;
    if (existingPaths?.has(destinationPath)) {
      setValidationError(`File "${destinationPath}" already exists.`);
      return;
    }
    setValidationError("");
    onUpload(destinationPath, selectedFile);
  }

  const displayError = validationError || error;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
    >
      <section
        aria-labelledby="create-file-dialog-title"
        aria-modal="true"
        className="w-full max-w-lg rounded-xl border border-base-content/15 bg-base-100 p-6 shadow-2xl max-h-[90vh] overflow-y-auto"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              className="text-lg font-bold tracking-tight"
              id="create-file-dialog-title"
            >
              {mode === "upload" ? "Upload File" : "Create New File"}
            </h2>
            <p className="mt-1 text-xs text-base-content/60">
              {mode === "upload"
                ? "Upload a local file directly into the workspace."
                : "Create a new editable text or Markdown file in the workspace."}
            </p>
          </div>
          {onUpload && (
            <div
              aria-label="Creation mode"
              className="join shrink-0"
              role="tablist"
            >
              <button
                aria-selected={mode === "create"}
                className={`btn btn-xs join-item ${
                  mode === "create" ? "btn-primary" : "btn-ghost"
                }`}
                disabled={isCreating}
                onClick={() => {
                  setMode("create");
                  setValidationError("");
                }}
                role="tab"
                type="button"
              >
                New File
              </button>
              <button
                aria-selected={mode === "upload"}
                className={`btn btn-xs join-item ${
                  mode === "upload" ? "btn-primary" : "btn-ghost"
                }`}
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
          )}
        </div>

        {displayError && (
          <div className="alert alert-error mt-4 p-3 text-xs" role="alert">
            <span>{displayError}</span>
          </div>
        )}

        {mode === "create" ? (
          <form className="mt-4 space-y-4" onSubmit={handleCreateSubmit}>
            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold" htmlFor={folderId}>
                  Folder
                </label>
                <button
                  className="link link-hover text-[11px] text-primary"
                  disabled={isCreating}
                  onClick={() => {
                    setUseCustomDir((prev) => !prev);
                    setValidationError("");
                  }}
                  type="button"
                >
                  {useCustomDir
                    ? "Choose from existing"
                    : "Enter new folder path"}
                </button>
              </div>
              {useCustomDir ? (
                <input
                  className="input input-bordered input-sm mt-1 w-full font-mono"
                  disabled={isCreating}
                  id={folderId}
                  onChange={(e) => {
                    setCustomDir(e.target.value);
                    setValidationError("");
                  }}
                  placeholder="e.g. notes or docs/guides"
                  type="text"
                  value={customDir}
                />
              ) : (
                <select
                  className="select select-bordered select-sm mt-1 w-full font-mono text-xs"
                  disabled={isCreating}
                  id={folderId}
                  onChange={(e) => {
                    setSelectedDir(e.target.value);
                    setValidationError("");
                  }}
                  value={selectedDir}
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
              <label className="text-xs font-semibold" htmlFor={nameId}>
                File Name
              </label>
              <input
                className="input input-bordered input-sm mt-1 w-full font-mono"
                disabled={isCreating}
                id={nameId}
                onChange={(e) => {
                  setFilename(e.target.value);
                  setValidationError("");
                }}
                placeholder="e.g. notes.md, config.yaml, todo.txt"
                ref={inputRef}
                type="text"
                value={filename}
              />
              <span className="mt-1 block text-[11px] text-base-content/50">
                Defaults to <code>.md</code> if no extension is specified.
              </span>
            </div>

            <div className="rounded-lg border border-base-content/10 bg-base-200/50 p-3 text-xs space-y-1">
              <div className="text-base-content/60 font-medium">
                Target Path:
              </div>
              <code className="block text-primary font-mono text-[11px] truncate">
                {previewPath}
              </code>
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
                disabled={isCreating || !rawCreateName}
                type="submit"
              >
                {isCreating ? "Creating..." : "Create File"}
              </button>
            </div>
          </form>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={handleUploadSubmit}>
            <div>
              <label
                className="block text-xs font-semibold"
                htmlFor={fileInputId}
              >
                Source File
              </label>
              <input
                className="sr-only"
                disabled={isCreating}
                id={fileInputId}
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  handleSelectedFile(file);
                }}
                ref={fileInputRef}
                type="file"
              />
              <button
                className={`mt-1 flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-5 text-center transition-colors ${
                  isDragging
                    ? "border-primary bg-primary/10"
                    : "border-base-content/20 bg-base-200/40 hover:border-base-content/40"
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
                  const file = e.dataTransfer.files?.[0] ?? null;
                  handleSelectedFile(file);
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
                      Any file type (Markdown, text, YAML, PDF, images, etc.)
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
                  placeholder="e.g. assets or docs/images"
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
