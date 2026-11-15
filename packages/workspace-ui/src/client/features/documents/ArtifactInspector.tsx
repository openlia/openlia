import type { WorkspaceFileMetadata } from "../../../shared/api";
import { CopyLinkButton } from "../../components/common/CopyLinkButton";
import {
  buildCanonicalWorkspaceUri,
  buildWorkspaceLink,
} from "../../openliaLinks";
import { formatFileSize } from "./DocumentPane";

export function ArtifactInspector({
  artifact,
}: {
  artifact: WorkspaceFileMetadata;
}) {
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
            <span className="min-w-0 flex-1">
              {buildWorkspaceLink(artifact.path)}
            </span>
            <CopyLinkButton
              className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/60 hover:text-base-content"
              iconOnly
              link={buildWorkspaceLink(artifact.path)}
              size="xs"
              title={`Copy ${buildWorkspaceLink(artifact.path)}`}
            />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-base-content/50">
            Document URI (openlia://)
          </dt>
          <dd className="mt-1 flex items-center justify-between gap-2 break-all font-mono text-xs text-base-content/80">
            <span className="min-w-0 flex-1">
              {buildCanonicalWorkspaceUri(artifact.path)}
            </span>
            <CopyLinkButton
              className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/60 hover:text-base-content"
              iconOnly
              link={buildCanonicalWorkspaceUri(artifact.path)}
              size="xs"
              title={`Copy ${buildCanonicalWorkspaceUri(artifact.path)}`}
            />
          </dd>
        </div>
      </dl>
    </div>
  );
}
