import { useMemo, useState } from "react";

export interface MoveFileDialogProps {
  filePath: string;
  directories: string[];
  domains?:
    | Array<{ path: string; template_path?: string | undefined }>
    | undefined;
  onCancel: () => void;
  onMove: (destinationPath: string) => void;
  moving: boolean;
  error?: string;
}

const knownSchemaDomains = new Set([
  "areas",
  "calendar",
  "decisions",
  "finance",
  "goals",
  "ideas",
  "monitors",
  "people",
  "projects",
  "shopping",
  "tasks",
  "travel",
  "knowledge/claims",
]);

export function MoveFileDialog({
  directories,
  domains,
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
  const [fileName, setFileName] = useState(currentFileName);
  const [validationError, setValidationError] = useState("");

  const folderOptions = useMemo(() => {
    const list = Array.from(new Set(["", ...directories])).sort();
    return list;
  }, [directories]);

  const targetDir = useCustomDir ? customDir.trim() : selectedDir;
  const targetPath = targetDir
    ? `${targetDir}/${fileName.trim()}`
    : fileName.trim();

  // Check if target domain has a schema
  const targetTopDomain = targetDir.split("/")[0] ?? "";
  const dynamicSchemaDomains = useMemo(() => {
    if (!domains || domains.length === 0) return knownSchemaDomains;
    const set = new Set<string>(knownSchemaDomains);
    for (const d of domains) {
      if (d.template_path) {
        set.add(d.path);
      }
    }
    return set;
  }, [domains]);
  const isTargetSchemaDomain =
    dynamicSchemaDomains.has(targetDir) ||
    dynamicSchemaDomains.has(targetTopDomain);
  const sourceTopDomain = currentDir.split("/")[0] ?? "";
  const isCrossDomainMove =
    isTargetSchemaDomain && targetTopDomain !== sourceTopDomain;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanFileName = fileName.trim();
    if (!cleanFileName) {
      setValidationError("File name cannot be empty");
      return;
    }
    if (cleanFileName.includes("/") || cleanFileName.includes("\\")) {
      setValidationError("File name cannot contain path separators");
      return;
    }
    if (targetPath === filePath) {
      setValidationError("Destination path is identical to current path");
      return;
    }
    if (
      cleanFileName.endsWith("-template.md") ||
      cleanFileName.endsWith(".schema.json")
    ) {
      setValidationError("Cannot move file to a template or schema name");
      return;
    }

    setValidationError("");
    onMove(targetPath);
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
                  placeholder="e.g. archive or tasks/done"
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

            <div>
              <label
                className="label text-xs font-semibold py-1"
                htmlFor="move-filename"
              >
                File Name
              </label>
              <input
                className="input input-bordered w-full text-xs font-mono"
                disabled={moving}
                id="move-filename"
                onChange={(e) => {
                  setFileName(e.target.value);
                  setValidationError("");
                }}
                type="text"
                value={fileName}
              />
            </div>

            {/* Target preview */}
            <div className="rounded-lg bg-base-200/60 p-2.5 text-xs">
              <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/50 block">
                Destination Preview
              </span>
              <span className="font-mono text-primary font-medium truncate block mt-0.5">
                {targetPath}
              </span>
            </div>

            {/* Schema guidance alert */}
            {isCrossDomainMove && (
              <div className="alert alert-info py-2 text-xs" role="status">
                <span>
                  Moving into <strong>{targetTopDomain}/</strong>: this domain
                  enforces template schemas. You can modify the document freely,
                  and schema validation feedback will be shown in the editor.
                </span>
              </div>
            )}
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
