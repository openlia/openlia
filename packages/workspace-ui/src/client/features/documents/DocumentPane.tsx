import { type ReactNode, useState } from "react";
import type { WorkspaceFile, WorkspaceFileMetadata } from "../../../shared/api";
import { CodeEditor, isMarkdownPath } from "../../CodeEditor";
import { ActionMenu } from "../../components/common/ActionMenu";
import { CopyLinkButton } from "../../components/common/CopyLinkButton";
import { ResponsiveDrawer } from "../../components/common/ResponsiveDrawer";
import { MarkdownPreview } from "../../components/editor/MarkdownPreview";
import {
  buildCanonicalWorkspaceUri,
  buildWorkspaceLink,
} from "../../openliaLinks";
import { ArtifactInspector } from "./ArtifactInspector";
import { DocumentInspector } from "./DocumentInspector";

export type WorkspaceView = "edit" | "preview" | "info";

function ModeButton({
  active,
  children,
  className = "",
  onClick,
  value,
}: {
  active: boolean;
  className?: string;
  children: ReactNode;
  onClick: () => void;
  value: string;
}) {
  return (
    <button
      aria-pressed={active}
      className={`btn btn-xs sm:btn-sm join-item ${active ? "btn-primary" : "btn-ghost"} ${className}`}
      onClick={onClick}
      type="button"
      value={value}
    >
      {children}
    </button>
  );
}

function EditorPane({
  draft,
  file,
  fileLoading,
  onDraftChange,
}: {
  draft: string;
  file: WorkspaceFile;
  fileLoading: boolean;
  onDraftChange: (value: string) => void;
}) {
  return (
    <section aria-label="Editor" className="workspace-editor-pane">
      <div className="workspace-pane-label sr-only">Editor</div>
      <CodeEditor
        className="min-h-0 flex-1"
        filePath={file.path}
        onChange={onDraftChange}
        readOnly={!file.editable || fileLoading}
        value={draft}
      />
    </section>
  );
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = units[0];
  for (let index = 0; index < units.length - 1 && value >= 1024; index++) {
    value /= 1024;
    unit = units[index + 1] ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function artifactPreviewKind(
  path: string,
): "audio" | "image" | "pdf" | "video" | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (
    [
      ".avif",
      ".bmp",
      ".gif",
      ".ico",
      ".jpeg",
      ".jpg",
      ".png",
      ".svg",
      ".tif",
      ".tiff",
      ".webp",
    ].includes(extension)
  )
    return "image";
  if ([".flac", ".m4a", ".mp3", ".oga", ".ogg", ".wav"].includes(extension))
    return "audio";
  if ([".mov", ".mp4", ".ogv", ".webm"].includes(extension)) return "video";
  return undefined;
}

function ArtifactPane({
  artifact,
  deleting = false,
  downloadUrl,
  onDelete,
  onDownload,
  onRevealInTree,
  rawUrl,
}: {
  artifact: WorkspaceFileMetadata;
  deleting?: boolean | undefined;
  downloadUrl?: ((path: string) => string) | undefined;
  onDelete?: (() => void) | undefined;
  onDownload: () => void;
  onRevealInTree?: (() => void) | undefined;
  rawUrl?: ((path: string) => string) | undefined;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const previewKind = artifactPreviewKind(artifact.path);
  const previewUrl = rawUrl?.(artifact.path) ?? "#";

  return (
    <section
      aria-label="Non-text artifact"
      className="workspace-mobile-content workspace-artifact-pane relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="workspace-document-toolbar">
        <div className="min-w-0 flex-1">
          <p
            className="workspace-document-name truncate min-w-0"
            title={artifact.path}
          >
            {artifact.path.split("/").at(-1) ?? artifact.path}
          </p>
          <p
            className="text-xs text-base-content/60 truncate"
            title={artifact.path}
          >
            View only artifact
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <a
            className="btn btn-xs sm:btn-sm btn-primary shrink-0"
            href={previewUrl}
            rel="noreferrer"
            target="_blank"
          >
            <span className="sm:hidden">Open ↗</span>
            <span className="hidden sm:inline">Open in New Tab ↗</span>
          </a>
          <ActionMenu label="Artifact actions" className="btn-xs sm:btn-sm">
            <ul className="menu w-full p-0">
              <li>
                <button
                  type="button"
                  onClick={() => setDetailsOpen((prev) => !prev)}
                >
                  Details
                </button>
              </li>
              {onRevealInTree && (
                <li>
                  <button
                    aria-label="Reveal in tree"
                    onClick={onRevealInTree}
                    type="button"
                  >
                    <span>Reveal in Tree</span>
                  </button>
                </li>
              )}
              <li>
                <CopyLinkButton
                  className="flex w-full items-center gap-2 text-left font-normal"
                  link={buildWorkspaceLink(artifact.path)}
                  title={`Copy link (${buildWorkspaceLink(artifact.path)})`}
                />
              </li>
              <li>
                <CopyLinkButton
                  className="flex w-full items-center gap-2 text-left font-normal"
                  label="Copy URI"
                  link={buildCanonicalWorkspaceUri(artifact.path)}
                  title={`Copy URI (${buildCanonicalWorkspaceUri(artifact.path)})`}
                />
              </li>
              <li>
                <button onClick={onDownload} type="button">
                  <span>Download</span>
                </button>
              </li>
              {onDelete && (
                <li className="border-t border-base-content/10 pt-1 mt-1">
                  <button
                    aria-label="Delete file"
                    className="text-error hover:bg-error/10 hover:text-error"
                    disabled={deleting}
                    onClick={onDelete}
                    type="button"
                  >
                    <span>Delete</span>
                  </button>
                </li>
              )}
            </ul>
          </ActionMenu>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="workspace-preview-pane min-h-0 flex-1 overflow-auto p-2 sm:p-4">
          {previewKind === "pdf" && (
            <iframe
              className="h-full min-h-[16rem] w-full rounded-lg border border-base-content/10 bg-base-100"
              src={previewUrl}
              title={`Preview of ${artifact.path}`}
            />
          )}
          {previewKind === "image" && (
            <div className="flex min-h-full items-center justify-center rounded-lg border border-base-content/10 bg-base-100 p-4">
              <img
                alt={artifact.path}
                className="max-h-full max-w-full object-contain"
                src={previewUrl}
              />
            </div>
          )}
          {previewKind === "audio" && (
            <div className="flex min-h-full items-center justify-center rounded-lg border border-base-content/10 bg-base-100 p-8">
              {/* biome-ignore lint/a11y/useMediaCaption: No caption track is available in the source artifact. */}
              <audio controls src={previewUrl} />
            </div>
          )}
          {previewKind === "video" && (
            <div className="flex min-h-full items-center justify-center rounded-lg border border-base-content/10 bg-base-100 p-4">
              {/* biome-ignore lint/a11y/useMediaCaption: No caption track is available in the source artifact. */}
              <video
                className="max-h-full max-w-full"
                controls
                src={previewUrl}
              />
            </div>
          )}
          {!previewKind && (
            <div className="flex min-h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-base-content/20 bg-base-100 p-8 text-center">
              <p className="font-semibold">
                This file cannot be previewed in the browser.
              </p>
              <p className="max-w-md text-sm text-base-content/60">
                Open it in a new tab or download it to use an application that
                supports this file type.
              </p>
              {downloadUrl && (
                <a
                  className="btn btn-sm btn-outline"
                  download
                  href={downloadUrl(artifact.path)}
                >
                  Download {artifact.path.split("/").at(-1) ?? "file"}
                </a>
              )}
            </div>
          )}
        </div>
        {detailsOpen && (
          <ResponsiveDrawer
            className="responsive-drawer-right workspace-inspector-drawer w-80 shrink-0"
            label="Artifact details"
            onClose={() => setDetailsOpen(false)}
            open={detailsOpen}
            title="Artifact Details"
          >
            <ArtifactInspector
              artifact={artifact}
              onClose={() => setDetailsOpen(false)}
            />
          </ResponsiveDrawer>
        )}
      </div>
    </section>
  );
}

export function DocumentPane({
  artifact,
  conflict,
  diff,
  draft,
  documentError,
  file,
  fileLoading,
  onDelete,
  onDownload,
  onDraftChange,
  onMove,
  onOpenDetails,
  onRename,
  onRevealInTree,
  onRetry,
  onSave,
  deleting,
  saving,
  view,
  onViewChange,
  onNavigateLink,
  rawUrl,
  downloadUrl,
  onCreateFile,
}: {
  conflict: string;
  detailsOpen?: boolean;
  diff: string[];
  draft: string;
  documentError: string;
  file: WorkspaceFile | null;
  artifact?: WorkspaceFileMetadata | null | undefined;
  fileLoading: boolean;
  onDelete: () => void;
  onDownload: () => void;
  onDraftChange: (value: string) => void;
  onMove?: (() => void) | undefined;
  onOpenDetails: () => void;
  onRename?: (() => void) | undefined;
  onRevealInTree?: (() => void) | undefined;
  onRetry: () => void;
  onSave: () => void;
  deleting: boolean;
  saving: boolean;
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  onNavigateLink?: ((href: string) => void) | undefined;
  rawUrl?: ((path: string) => string) | undefined;
  downloadUrl?: ((path: string) => string) | undefined;
  onCreateFile?: (() => void) | undefined;
}) {
  const dirty = file !== null && file.content !== draft;
  const canEdit = Boolean(file?.editable);
  const isMarkdown = file !== null && isMarkdownPath(file.path);

  return (
    <section
      aria-label="Document workspace"
      className={`workspace-document workspace-mobile-page document-workspace ${artifact ? "document-workspace-artifact" : ""}`}
    >
      {artifact ? (
        <ArtifactPane
          artifact={artifact}
          deleting={deleting}
          downloadUrl={downloadUrl}
          onDelete={onDelete}
          onDownload={onDownload}
          onRevealInTree={onRevealInTree}
          rawUrl={rawUrl}
        />
      ) : file ? (
        <>
          <div className="workspace-document-toolbar">
            <div className="min-w-0 flex-1 hidden sm:block">
              <div className="flex items-center gap-1.5">
                <p className="workspace-document-name" title={file.path}>
                  {file.path}
                </p>
              </div>
              {!canEdit && <p className="text-xs text-warning">Read only</p>}
            </div>
            {!canEdit && (
              <span className="badge badge-warning badge-xs sm:hidden shrink-0">
                Read only
              </span>
            )}
            <div
              aria-label="Document view"
              className="join shrink-0"
              role="toolbar"
            >
              {isMarkdown ? (
                <>
                  <ModeButton
                    active={view === "preview"}
                    onClick={() => onViewChange("preview")}
                    value="preview"
                  >
                    Preview
                  </ModeButton>
                  <ModeButton
                    active={view === "edit"}
                    onClick={() => onViewChange("edit")}
                    value="edit"
                  >
                    Edit
                  </ModeButton>
                </>
              ) : (
                <ModeButton
                  active={view !== "info"}
                  onClick={() => onViewChange("edit")}
                  value="edit"
                >
                  Edit
                </ModeButton>
              )}
            </div>
            <div className="ml-auto sm:ml-0 flex items-center gap-1.5 shrink-0">
              <button
                className={`btn btn-xs sm:btn-sm shrink-0 ${dirty ? "btn-primary" : "btn-ghost text-base-content/60"}`}
                disabled={!canEdit || !dirty || saving}
                onClick={onSave}
                type="button"
              >
                {saving ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="loading loading-spinner loading-xs"
                    />
                    <span>Saving...</span>
                  </>
                ) : dirty ? (
                  "Save"
                ) : (
                  <>
                    <svg
                      aria-hidden="true"
                      className="h-3.5 w-3.5 text-success opacity-80"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M5 13l4 4L19 7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>Saved</span>
                  </>
                )}
              </button>
              <ActionMenu label="Document actions" className="btn-xs sm:btn-sm">
                <ul className="menu w-full p-0">
                  <li>
                    <button type="button" onClick={onOpenDetails}>
                      Details
                    </button>
                  </li>
                  {onRevealInTree && (
                    <li>
                      <button
                        aria-label="Reveal in tree"
                        onClick={onRevealInTree}
                        type="button"
                      >
                        <span>Reveal in Tree</span>
                      </button>
                    </li>
                  )}
                  <li>
                    <CopyLinkButton
                      className="flex w-full items-center gap-2 text-left font-normal"
                      link={buildWorkspaceLink(file.path)}
                      title={`Copy link (${buildWorkspaceLink(file.path)})`}
                    />
                  </li>
                  <li>
                    <CopyLinkButton
                      className="flex w-full items-center gap-2 text-left font-normal"
                      label="Copy URI"
                      link={buildCanonicalWorkspaceUri(file.path)}
                      title={`Copy URI (${buildCanonicalWorkspaceUri(file.path)})`}
                    />
                  </li>
                  {onRename && file.editable && (
                    <li>
                      <button onClick={onRename} type="button">
                        <span>Rename...</span>
                      </button>
                    </li>
                  )}
                  {onMove && file.editable && (
                    <li>
                      <button onClick={onMove} type="button">
                        <span>Move...</span>
                      </button>
                    </li>
                  )}
                  <li>
                    <button onClick={onDownload} type="button">
                      <span>Download</span>
                    </button>
                  </li>
                  <li className="border-t border-base-content/10 pt-1 mt-1">
                    <button
                      aria-label="Delete file"
                      className="text-error hover:bg-error/10 hover:text-error"
                      disabled={deleting}
                      onClick={onDelete}
                      type="button"
                    >
                      <span>Delete</span>
                    </button>
                  </li>
                </ul>
              </ActionMenu>
            </div>
          </div>
          {fileLoading && (
            <div className="workspace-inline-status" role="status">
              Loading document...
            </div>
          )}
          {conflict && (
            <div className="alert alert-warning rounded-none" role="alert">
              <div>
                <p className="font-semibold">
                  This file changed after you opened it.
                </p>
                <p className="text-sm">{conflict}</p>
              </div>
            </div>
          )}
          {documentError && (
            <div className="alert alert-error rounded-none" role="alert">
              <span>{documentError}</span>
              <button
                className="btn btn-error btn-sm"
                onClick={onRetry}
                type="button"
              >
                Retry
              </button>
            </div>
          )}
          {view === "info" ? (
            <DocumentInspector diff={diff} draft={draft} file={file} />
          ) : !isMarkdown || view === "edit" ? (
            <EditorPane
              draft={draft}
              file={file}
              fileLoading={fileLoading}
              onDraftChange={onDraftChange}
            />
          ) : (
            <section
              aria-label="Preview"
              className="workspace-preview-pane workspace-mobile-content"
            >
              <div className="workspace-pane-label sr-only">Preview</div>
              <MarkdownPreview
                content={draft}
                currentFilePath={file.path}
                onNavigateLink={onNavigateLink}
                rawUrl={rawUrl}
              />
            </section>
          )}
        </>
      ) : documentError ? (
        <div className="workspace-empty-document">
          <div className="max-w-md w-full p-4">
            <div className="alert alert-error rounded-lg" role="alert">
              <span>{documentError}</span>
              <button
                className="btn btn-error btn-sm"
                onClick={onRetry}
                type="button"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="workspace-empty-document">
          <div className="max-w-md space-y-3">
            <p className="workspace-eyebrow">WORKSPACE</p>
            <h2 className="text-lg font-bold">Select a file to view or edit</h2>
            <p className="text-sm text-base-content/60">
              Browse files in the sidebar, press{" "}
              <kbd className="kbd kbd-xs">⌘K</kbd> to jump to a path, or create
              a new file.
            </p>
            {onCreateFile && (
              <div className="pt-2">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={onCreateFile}
                  type="button"
                >
                  + New File
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
