import { useMemo, useState } from "react";

export interface MoveFileDialogProps {
  filePath: string;
  directories: string[];
  onCancel: () => void;
  onMove: (destinationDir: string) => void;
  moving: boolean;
  error?: string;
}

export function MoveFileDialog({
  directories,
  error,
  filePath,
  moving,
  onCancel,
  onMove,
}: MoveFileDialogProps) {
  const currentFileName = filePath.split("/").at(-1) ?? "";
  const currentDir = filePath.includes("/")
    ? filePath.slice(0, filePath.lastIndexOf("/"))
    : "";

  const [selectedDir, setSelectedDir] = useState(currentDir);
  const [customDir, setCustomDir] = useState("");
  const [useCustomDir, setUseCustomDir] = useState(false);
  const [validationError, setValidationError] = useState("");

  const folderOptions = useMemo(() => {
    const list = Array.from(new Set(["", ...directories])).sort();
    return list;
  }, [directories]);

  const targetDir = (useCustomDir ? customDir.trim() : selectedDir).replace(
    /^\/+|\/+$/g,
    "",
  );
  const targetPath = targetDir
    ? `${targetDir}/${currentFileName}`
    : currentFileName;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (targetPath === filePath) {
      setValidationError("Destination folder is identical to current folder");
      return;
    }

    setValidationError("");
    onMove(targetDir);
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
    >
      <section
        aria-labelledby="move-dialog-title"
        aria-modal="true"
        className="card w-full max-w-lg border border-base-content/15 bg-base-100 shadow-2xl"
        role="dialog"
      >
        <form className="card-body p-6" onSubmit={handleSubmit}>
          <h2 className="card-title text-lg" id="move-dialog-title">
            Move Document
          </h2>
          <p className="text-xs text-base-content/60 font-mono truncate">
            Source: {filePath}
          </p>

          <div className="mt-4 space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  className="text-xs font-semibold"
                  htmlFor="folder-select"
                >
                  Destination Folder
                </label>
                <button
                  className="link link-hover text-[11px] text-primary"
                  onClick={() => setUseCustomDir(!useCustomDir)}
                  type="button"
                >
                  {useCustomDir
                    ? "Choose from existing"
                    : "Enter new folder path"}
                </button>
              </div>

              {useCustomDir ? (
                <input
                  className="input input-bordered w-full text-xs font-mono"
                  disabled={moving}
                  onChange={(e) => {
                    setCustomDir(e.target.value);
                    setValidationError("");
                  }}
                  placeholder="e.g. archive or notes/2026"
                  type="text"
                  value={customDir}
                />
              ) : (
                <select
                  className="select select-bordered w-full text-xs font-mono"
                  disabled={moving}
                  id="folder-select"
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

            <div className="rounded-lg bg-base-200/60 p-2.5 text-xs">
              <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/50 block">
                Destination Preview
              </span>
              <span className="font-mono text-primary font-medium truncate block mt-0.5">
                {targetPath}
              </span>
            </div>
          </div>

          {(validationError || error) && (
            <div className="alert alert-error mt-3 py-2 text-xs" role="alert">
              <span>{validationError || error}</span>
            </div>
          )}

          <div className="card-actions mt-5 justify-end gap-2">
            <button
              className="btn btn-ghost btn-sm"
              disabled={moving}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={moving || !targetPath.trim()}
              type="submit"
            >
              {moving ? "Moving..." : "Move"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
