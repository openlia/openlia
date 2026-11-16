import type { DocumentScope, WorkspaceFileMetadata } from "../../../shared/api";
import { CopyLinkButton } from "../../components/common/CopyLinkButton";
import {
  buildCanonicalDocumentUri,
  buildDocumentLink,
} from "../../openliaLinks";
import { formatFileSize } from "./DocumentPane";

export function ArtifactInspector({
  artifact,
  scope = "workspace",
}: {
  artifact: WorkspaceFileMetadata;
  scope?: DocumentScope | undefined;
}) {
  const webLink = buildDocumentLink(artifact.path, scope);
  const canonicalUri = buildCanonicalDocumentUri(artifact.path, scope);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto p-4">
      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-base-content/50">
            Name
          </dt>
          <dd className="mt-1 break-all font-medium">
            {artifact.path.split("/").at(-1) ?? artifact.path}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-base-content/50">
            Status
          </dt>
          <dd className="mt-1 font-medium">View only artifact</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-base-content/50">
            Size
          </dt>
          <dd className="mt-1 font-medium">{formatFileSize(artifact.size)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-base-content/50">
            Last modified
          </dt>
          <dd className="mt-1 font-medium">
            {new Date(artifact.modified_at).toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-base-content/50">
            Saved revision
          </dt>
          <dd
            className="mt-1 break-all font-mono text-xs"
            title={artifact.revision}
          >
            {artifact.revision}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-base-content/50">
            Web Link
          </dt>
          <dd className="mt-1 flex items-center justify-between gap-2 break-all font-mono text-xs text-base-content/80">
            <span className="min-w-0 flex-1">{webLink}</span>
            <CopyLinkButton
              className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/60 hover:text-base-content"
              iconOnly
              link={webLink}
              size="xs"
              title={`Copy ${webLink}`}
            />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-base-content/50">
            Document URI (openlia://)
          </dt>
          <dd className="mt-1 flex items-center justify-between gap-2 break-all font-mono text-xs text-base-content/80">
            <span className="min-w-0 flex-1">{canonicalUri}</span>
            <CopyLinkButton
              className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/60 hover:text-base-content"
              iconOnly
              link={canonicalUri}
              size="xs"
              title={`Copy ${canonicalUri}`}
            />
          </dd>
        </div>
      </dl>
    </div>
  );
}
