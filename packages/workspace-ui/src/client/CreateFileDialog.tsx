import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WorkspaceDomainInfo } from "../shared/api";

export interface CreateFileDialogProps {
  availableDomains: WorkspaceDomainInfo[];
  error?: string | undefined;
  existingPaths?: Set<string> | undefined;
  initialDomain?: string | undefined;
  isCreating: boolean;
  isOpen: boolean;
  onCancel: () => void;
  onCreate: (domain: string, filename: string) => void;
}

export function CreateFileDialog({
  availableDomains,
  error,
  existingPaths,
  initialDomain,
  isCreating,
  isOpen,
  onCancel,
  onCreate,
}: CreateFileDialogProps) {
  const domainId = useId();
  const nameId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const defaultDomain = useMemo(() => {
    if (
      initialDomain &&
      availableDomains.some((d) => d.path === initialDomain)
    ) {
      return initialDomain;
    }
    return availableDomains[0]?.path ?? "tasks";
  }, [availableDomains, initialDomain]);

  const [selectedDomain, setSelectedDomain] = useState(defaultDomain);
  const [fileName, setFileName] = useState("");
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    if (isOpen) {
      setSelectedDomain(defaultDomain);
      setFileName("");
      setValidationError("");
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  }, [isOpen, defaultDomain]);

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

  const cleanName = fileName.trim();
  const normalizedFileName = cleanName
    ? cleanName.toLowerCase().endsWith(".md")
      ? cleanName
      : `${cleanName}.md`
    : "";
  const previewPath = normalizedFileName
    ? `${selectedDomain}/${normalizedFileName}`
    : `${selectedDomain}/...`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cleanName) {
      setValidationError("File name cannot be empty");
      return;
    }
    if (cleanName.includes("/") || cleanName.includes("\\")) {
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
    if (
      existingPaths &&
      existingPaths.has(`${selectedDomain}/${normalizedFileName}`)
    ) {
      setValidationError(
        `File "${normalizedFileName}" already exists in ${selectedDomain}`,
      );
      return;
    }

    setValidationError("");
    onCreate(selectedDomain, normalizedFileName);
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
              Create a record initialized with this domain's template schema.
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

        {displayedError && (
          <div
            className="alert alert-error text-xs p-3 rounded-lg"
            role="alert"
          >
            <span>{displayedError}</span>
          </div>
        )}

        <form className="space-y-4" onSubmit={handleSubmit}>
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
                This creates an event note, not a scheduled appointment.{" "}
                <a
                  className="link link-primary"
                  href="/projects/calendar"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Calendar in a new tab to create an appointment
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
              className="input input-bordered input-sm mt-1 w-full"
              disabled={isCreating}
              id={nameId}
              onChange={(e) => {
                setFileName(e.target.value);
                setValidationError("");
              }}
              placeholder="e.g. quarterly-review"
              type="text"
              value={fileName}
            />
          </div>

          <div className="rounded-lg border border-base-content/10 bg-base-200/50 p-3 text-xs space-y-1">
            <div className="text-base-content/60 font-medium">Target Path:</div>
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
      </section>
    </div>
  );
}
