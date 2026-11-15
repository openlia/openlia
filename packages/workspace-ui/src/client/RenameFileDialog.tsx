import { useEffect, useRef, useState } from "react";

export interface RenameFileDialogProps {
  filePath: string;
  onCancel: () => void;
  onRename: (newName: string) => void;
  renaming: boolean;
  error?: string;
}

export function RenameFileDialog({
  error,
  filePath,
  onCancel,
  onRename,
  renaming,
}: RenameFileDialogProps) {
  const currentFileName = filePath.split("/").at(-1) ?? "";
  const [name, setName] = useState(currentFileName);
  const [validationError, setValidationError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      const dotIndex = currentFileName.lastIndexOf(".");
      if (dotIndex > 0) {
        inputRef.current.setSelectionRange(0, dotIndex);
      } else {
        inputRef.current.select();
      }
    }
  }, [currentFileName]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setValidationError("File name cannot be empty");
      return;
    }
    if (cleanName === currentFileName) {
      onCancel();
      return;
    }
    if (cleanName.includes("/") || cleanName.includes("\\")) {
      setValidationError("File name cannot contain path separators (/ or \\)");
      return;
    }
    if (cleanName.startsWith(".")) {
      setValidationError("File name cannot start with a dot");
      return;
    }

    setValidationError("");
    onRename(cleanName);
  };

  const currentDir = filePath.includes("/")
    ? filePath.slice(0, filePath.lastIndexOf("/"))
    : "";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
    >
      <section
        aria-labelledby="rename-dialog-title"
        aria-modal="true"
        className="card w-full max-w-md border border-base-content/15 bg-base-100 shadow-2xl"
        role="dialog"
      >
        <form className="card-body p-6" onSubmit={handleSubmit}>
          <h2 className="card-title text-lg" id="rename-dialog-title">
            Rename File
          </h2>
          {currentDir && (
            <p className="text-xs text-base-content/60 font-mono truncate">
              Folder: {currentDir}
            </p>
          )}

          <div className="mt-3">
            <label
              className="label text-xs font-semibold"
              htmlFor="rename-input"
            >
              New File Name
            </label>
            <input
              className="input input-bordered w-full text-sm font-mono"
              disabled={renaming}
              id="rename-input"
              onChange={(e) => {
                setName(e.target.value);
                setValidationError("");
              }}
              ref={inputRef}
              type="text"
              value={name}
            />
          </div>

          {(validationError || error) && (
            <div className="alert alert-error mt-3 py-2 text-xs" role="alert">
              <span>{validationError || error}</span>
            </div>
          )}

          <div className="card-actions mt-5 justify-end gap-2">
            <button
              className="btn btn-ghost btn-sm"
              disabled={renaming}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={renaming || !name.trim()}
              type="submit"
            >
              {renaming ? "Renaming..." : "Rename"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
