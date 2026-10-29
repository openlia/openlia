import type { WorkspaceFile } from "../../../shared/api";
import { CopyLinkButton } from "../../components/common/CopyLinkButton";
import {
  buildCanonicalWorkspaceUri,
  buildWorkspaceLink,
} from "../../openliaLinks";

export function DocumentInspector({
  diff,
  draft,
  file,
}: {
  diff: string[];
  draft: string;
  file: WorkspaceFile | null;
}) {
  const dirty = file !== null && file.content !== draft;
  return (
    <aside aria-label="Document details" className="workspace-inspector">
      <div className="mb-5">
        <p className="workspace-eyebrow">DOCUMENT</p>
        <h2 className="mt-1 text-xl font-bold tracking-tight">Details</h2>
      </div>
      {!file ? (
        <p className="text-sm text-base-content/50">
          Select a document to inspect it.
        </p>
      ) : (
        <>
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-base-content/50">
                Status
              </dt>
              <dd className="mt-1 font-medium">
                {dirty
                  ? "Unsaved draft"
                  : file.missing
                    ? "Not created yet"
                    : "Saved"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-base-content/50">
                Draft size
              </dt>
              <dd className="mt-1 font-medium">
                {new TextEncoder().encode(draft).byteLength} B
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-base-content/50">
                Saved revision
              </dt>
              <dd
                className="mt-1 break-all font-mono text-xs"
                title={file.revision}
              >
                {file.revision}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-base-content/50">
                Last modified
              </dt>
              <dd className="mt-1 font-medium">
                {file.missing
                  ? "Not created yet"
                  : new Date(file.modified_at).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-base-content/50">
                Web Link (Share)
              </dt>
              <dd className="mt-1 flex items-center justify-between gap-2 break-all font-mono text-xs text-base-content/80">
                <span>{buildWorkspaceLink(file.path)}</span>
                <CopyLinkButton
                  className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/60 hover:text-base-content"
                  iconOnly
                  link={buildWorkspaceLink(file.path)}
                  size="xs"
                  title={`Copy ${buildWorkspaceLink(file.path)}`}
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-base-content/50">
                Document URI (openlia://)
              </dt>
              <dd className="mt-1 flex items-center justify-between gap-2 break-all font-mono text-xs text-base-content/80">
                <span>{buildCanonicalWorkspaceUri(file.path)}</span>
                <CopyLinkButton
                  className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/60 hover:text-base-content"
                  iconOnly
                  link={buildCanonicalWorkspaceUri(file.path)}
                  size="xs"
                  title={`Copy ${buildCanonicalWorkspaceUri(file.path)}`}
                />
              </dd>
            </div>
          </dl>
          {file.validation && (
            <div className="mt-4 rounded-lg border border-base-content/10 bg-base-200/40 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
                  Template & Schema
                </span>
                <span
                  className={`badge badge-xs font-mono ${
                    file.validation.valid ? "badge-success" : "badge-warning"
                  }`}
                >
                  {file.validation.valid ? "Conforming" : "Issues Found"}
                </span>
              </div>
              {file.validation.template_path && (
                <p className="text-[11px] font-mono text-base-content/60 truncate">
                  Template: {file.validation.template_path}
                </p>
              )}
              {file.validation.warnings?.length ? (
                <ul
                  aria-label="Inline OpenUI warnings"
                  className="list-disc list-inside text-xs text-warning space-y-1 pt-1"
                >
                  {file.validation.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              {file.validation.schema_path && (
                <p className="text-[11px] font-mono text-base-content/60 truncate">
                  Schema: {file.validation.schema_path}
                </p>
              )}
              {!file.validation.valid && file.validation.errors.length > 0 && (
                <ul className="list-disc list-inside text-xs text-warning space-y-1 pt-1">
                  {file.validation.errors.map((err: string) => (
                    <li key={err} className="break-words">
                      {err}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="mt-8">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/50">
                Draft changes
              </h3>
              {dirty && (
                <span className="text-xs text-warning">
                  Review before saving
                </span>
              )}
            </div>
            <pre className="workspace-diff mt-2">
              {dirty && diff.length ? diff.join("\n") : "No unsaved changes."}
            </pre>
          </div>
        </>
      )}
    </aside>
  );
}
