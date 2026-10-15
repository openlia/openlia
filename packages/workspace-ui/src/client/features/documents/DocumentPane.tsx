import type { ReactNode } from "react";
import { isMemoryDocument, memoryFilename } from "../../../shared/memory";
import type {
  WorkspaceActivityResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
} from "../../../shared/api";
import { ActivitySection } from "../../ActivitySection";
import {
  CodeEditor,
  isJournalPath,
  isMarkdownPath,
  isRemindPath,
} from "../../CodeEditor";
import { JournalPreviewPane } from "../../journal/JournalPreviewPane";
import { CalendarPreviewPane } from "../../calendar/CalendarPreviewPane";
import { MarkdownPreview } from "../../components/editor/MarkdownPreview";
import { CopyLinkButton } from "../../components/common/CopyLinkButton";
import { DocumentInspector } from "./DocumentInspector";
import {
  buildCanonicalWorkspaceUri,
  buildWorkspaceLink,
} from "../../openliaLinks";

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
      className={`btn btn-sm join-item ${active ? "btn-primary" : "btn-ghost"} ${className}`}
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
      <div className="workspace-pane-label">Editor</div>
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

function formatFileSize(size: number): string {
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
  rawUrl,
}: {
  artifact: WorkspaceFileMetadata;
  deleting?: boolean | undefined;
  downloadUrl?: ((path: string) => string) | undefined;
  onDelete?: (() => void) | undefined;
  onDownload: () => void;
  rawUrl?: ((path: string) => string) | undefined;
}) {
  const previewKind = artifactPreviewKind(artifact.path);
  const previewUrl = rawUrl?.(artifact.path) ?? "#";

  return (
    <section
      aria-label="Non-text artifact"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="workspace-document-toolbar">
        <div className="min-w-0 flex-1">
          <p className="workspace-document-name" title={artifact.path}>
            {artifact.path}
          </p>
          <p className="text-xs text-base-content/60">View only artifact</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <a
            className="btn btn-sm btn-primary"
            href={previewUrl}
            rel="noreferrer"
            target="_blank"
          >
            Open in New Tab ↗
          </a>
          <CopyLinkButton
            className="btn btn-sm btn-ghost"
            label="Copy Link"
            link={buildWorkspaceLink(artifact.path)}
            title="Copy link"
          />
          <button
            className="btn btn-sm btn-ghost"
            onClick={onDownload}
            type="button"
          >
            Download
          </button>
          {onDelete && (
            <button
              aria-label="Delete file"
              className="btn btn-sm btn-ghost text-error hover:bg-error/10 hover:text-error gap-1.5"
              disabled={deleting}
              onClick={onDelete}
              type="button"
            >
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Delete</span>
            </button>
          )}
        </div>
      </div>
      <div className="grid gap-4 border-b border-base-content/10 bg-base-200/30 px-5 py-4 sm:grid-cols-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
            Name
          </p>
          <p className="mt-1 break-all text-sm font-medium">
            {artifact.path.split("/").at(-1) ?? artifact.path}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
            Size
          </p>
          <p className="mt-1 text-sm font-medium">
            {formatFileSize(artifact.size)}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
            Modified
          </p>
          <p className="mt-1 text-sm font-medium">
            {new Date(artifact.modified_at).toLocaleString()}
          </p>
        </div>
        <div className="sm:col-span-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
            Link
          </p>
          <div className="mt-1 flex items-center gap-2 break-all font-mono text-xs">
            <span className="min-w-0 flex-1">
              {buildWorkspaceLink(artifact.path)}
            </span>
            <CopyLinkButton
              className="btn btn-ghost btn-xs btn-square shrink-0"
              iconOnly
              link={buildWorkspaceLink(artifact.path)}
              size="xs"
              title={`Copy link: ${buildWorkspaceLink(artifact.path)}`}
            />
          </div>
        </div>
      </div>
      <div className="workspace-preview-pane min-h-0 flex-1 overflow-auto p-4">
        {previewKind === "pdf" && (
          <iframe
            className="h-full min-h-[32rem] w-full rounded-lg border border-base-content/10 bg-base-100"
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
            {/* Workspace artifacts do not include a separate caption track. */}
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
    </section>
  );
}

export function DocumentPane({
  artifact,
  conflict,
  detailsOpen = false,
  diff,
  draft,
  documentError,
  file,
  fileLoading,
  onCloseFiles: _onCloseFiles,
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
  activity,
  activityLoading,
  diagnostics,
  diagnosticsLoading,
  onOpenFile,
  onOpenGitActivity,
  onRefreshActivity,
  rawUrl,
  downloadUrl,
  totalDocuments,
  onLoadCalendarFile,
  onSaveCalendarFile,
  onLoadInclude,
}: {
  conflict: string;
  detailsOpen?: boolean;
  diff: string[];
  draft: string;
  documentError: string;
  file: WorkspaceFile | null;
  artifact?: WorkspaceFileMetadata | null | undefined;
  fileLoading: boolean;
  onCloseFiles: () => void;
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
  activity?: WorkspaceActivityResponse | null | undefined;
  activityLoading?: boolean | undefined;
  diagnostics?: WorkspaceDiagnosticsResponse | null | undefined;
  diagnosticsLoading?: boolean | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  onOpenGitActivity?: (() => void) | undefined;
  onRefreshActivity?: (() => void) | undefined;
  rawUrl?: ((path: string) => string) | undefined;
  downloadUrl?: ((path: string) => string) | undefined;
  totalDocuments?: number | undefined;
  onLoadCalendarFile?:
    | ((path: string) => Promise<{ content: string; revision: string }>)
    | undefined;
  onSaveCalendarFile?:
    | ((
        path: string,
        content: string,
        expectedRevision: string,
      ) => Promise<{ revision: string }>)
    | undefined;
  onLoadInclude?:
    | ((resolvedPath: string) => Promise<string | null>)
    | undefined;
}) {
  const dirty = file !== null && file.content !== draft;
  const canEdit = Boolean(file?.editable);
  const isMemory = Boolean(file && isMemoryDocument(file.path));
  const isMarkdown = file !== null && isMarkdownPath(file.path);
  const isJournal = file !== null && isJournalPath(file.path);
  const isRemind = file !== null && isRemindPath(file.path);

  return (
    <section aria-label="Document workspace" className="workspace-document">
      {artifact ? (
        <ArtifactPane
          artifact={artifact}
          deleting={deleting}
          downloadUrl={downloadUrl}
          onDelete={onDelete}
          onDownload={onDownload}
          rawUrl={rawUrl}
        />
      ) : file ? (
        <>
          <div className="workspace-document-toolbar">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="workspace-document-name" title={file.path}>
                  {isMemory
                    ? `Assistant memory / ${memoryFilename(file.path)}`
                    : file.path}
                </p>
              </div>
              {!canEdit && <p className="text-xs text-warning">Read only</p>}
            </div>
            <div aria-label="Document view" className="join" role="toolbar">
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
              ) : isJournal ? (
                <>
                  <ModeButton
                    active={view === "preview"}
                    onClick={() => onViewChange("preview")}
                    value="preview"
                  >
                    Visual
                  </ModeButton>
                  <ModeButton
                    active={view === "edit"}
                    onClick={() => onViewChange("edit")}
                    value="edit"
                  >
                    Edit
                  </ModeButton>
                </>
              ) : isRemind ? (
                <>
                  <ModeButton
                    active={view === "preview"}
                    onClick={() => onViewChange("preview")}
                    value="preview"
                  >
                    Calendar
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
                <span className="btn btn-sm btn-primary pointer-events-none">
                  Code
                </span>
              )}
            </div>
            <button
              className={`btn btn-sm shrink-0 ${dirty ? "btn-primary" : "btn-ghost text-base-content/60"}`}
              disabled={!canEdit || (!dirty && !file.missing) || saving}
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
              ) : dirty || file.missing ? (
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
            <button
              aria-pressed={detailsOpen}
              className={`btn btn-sm gap-1.5 ${detailsOpen ? "btn-secondary" : "btn-outline"}`}
              onClick={onOpenDetails}
              type="button"
            >
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5 opacity-70"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Details</span>
            </button>
            <div className="dropdown dropdown-end shrink-0">
              <button
                aria-label="Document actions"
                className="btn btn-ghost btn-sm btn-square"
                tabIndex={0}
                title="Document actions"
                type="button"
              >
                <svg
                  className="h-4 w-4"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <title>Document actions</title>
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>
              <ul className="dropdown-content menu z-30 rounded-box border border-base-content/10 bg-base-100 p-1.5 shadow-lg text-xs w-48">
                {onRevealInTree && (
                  <li>
                    <button
                      aria-label="Reveal in tree"
                      onClick={onRevealInTree}
                      type="button"
                    >
                      <svg
                        aria-hidden="true"
                        className="h-3.5 w-3.5 opacity-70"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
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
                {onRename && file.editable && !isMemory && (
                  <li>
                    <button onClick={onRename} type="button">
                      <svg
                        aria-hidden="true"
                        className="h-3.5 w-3.5 opacity-70"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span>Rename...</span>
                    </button>
                  </li>
                )}
                {onMove && file.editable && !isMemory && (
                  <li>
                    <button onClick={onMove} type="button">
                      <svg
                        aria-hidden="true"
                        className="h-3.5 w-3.5 opacity-70"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path
                          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span>Move...</span>
                    </button>
                  </li>
                )}
                <li>
                  <button onClick={onDownload} type="button">
                    <svg
                      aria-hidden="true"
                      className="h-3.5 w-3.5 opacity-70"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>Download</span>
                  </button>
                </li>
                {!isMemory && (
                  <li className="border-t border-base-content/10 pt-1 mt-1">
                    <button
                      aria-label="Delete file"
                      className="text-error hover:bg-error/10 hover:text-error"
                      disabled={deleting}
                      onClick={onDelete}
                      type="button"
                    >
                      <svg
                        aria-hidden="true"
                        className="h-3.5 w-3.5 opacity-70"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span>Delete</span>
                    </button>
                  </li>
                )}
              </ul>
            </div>
          </div>
          {isMemory && (
            <div className="workspace-inline-status">
              {file.missing
                ? "This file has not been created yet. Save to create it. "
                : ""}
              {memoryFilename(file.path) === "USER.md"
                ? "Your profile and preferences."
                : "Durable assistant notes."}{" "}
              Changes are loaded into new assistant sessions.
            </div>
          )}
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
          {file.validation && !file.validation.valid && (
            <div
              className="alert alert-warning rounded-none py-2 px-4 text-xs flex items-start gap-2"
              role="status"
            >
              <svg
                className="h-4 w-4 shrink-0 text-warning mt-0.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <title>Validation warning</title>
                <path
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  Template & Schema Warning
                  {file.validation.schema_path && (
                    <span className="font-normal font-mono opacity-80 ml-1">
                      ({file.validation.schema_path})
                    </span>
                  )}
                </p>
                <ul className="list-disc list-inside mt-1 space-y-0.5 opacity-90">
                  {file.validation.errors.map((err: string) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
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
          ) : isJournal ? (
            view === "preview" ? (
              <section
                aria-label="Visual Journal View"
                className="workspace-preview-pane flex-1 overflow-hidden p-0"
              >
                <JournalPreviewPane
                  content={draft}
                  filePath={file.path}
                  onLoadInclude={onLoadInclude}
                  onNavigateLink={onNavigateLink}
                  onSwitchToEdit={() => onViewChange("edit")}
                />
              </section>
            ) : (
              <EditorPane
                draft={draft}
                file={file}
                fileLoading={fileLoading}
                onDraftChange={onDraftChange}
              />
            )
          ) : isRemind ? (
            view === "preview" ? (
              <section
                aria-label="Visual Calendar View"
                className="workspace-preview-pane flex-1 overflow-hidden p-0"
              >
                <CalendarPreviewPane
                  content={draft}
                  filePath={file.path}
                  fileRevision={file.revision}
                  onLoadCalendarFile={onLoadCalendarFile}
                  onSaveCalendarFile={onSaveCalendarFile}
                  onSwitchToEdit={() => onViewChange("edit")}
                  onNavigateLink={onNavigateLink}
                />
              </section>
            ) : (
              <EditorPane
                draft={draft}
                file={file}
                fileLoading={fileLoading}
                onDraftChange={onDraftChange}
              />
            )
          ) : !isMarkdown ? (
            <EditorPane
              draft={draft}
              file={file}
              fileLoading={fileLoading}
              onDraftChange={onDraftChange}
            />
          ) : view === "edit" ? (
            <EditorPane
              draft={draft}
              file={file}
              fileLoading={fileLoading}
              onDraftChange={onDraftChange}
            />
          ) : (
            <section aria-label="Preview" className="workspace-preview-pane">
              <div className="workspace-pane-label">Preview</div>
              <MarkdownPreview
                content={draft}
                currentFilePath={file.path}
                onNavigateLink={onNavigateLink}
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
        <ActivitySection
          activity={activity ?? null}
          diagnostics={diagnostics ?? null}
          diagnosticsLoading={diagnosticsLoading ?? false}
          loading={activityLoading ?? false}
          onOpenFile={onOpenFile ?? (() => {})}
          onOpenGitActivity={onOpenGitActivity}
          onRefresh={onRefreshActivity}
          totalDocuments={totalDocuments}
        />
      )}
    </section>
  );
}
