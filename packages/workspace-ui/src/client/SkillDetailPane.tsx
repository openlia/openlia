import type {
  SkillDetail,
  SkillFileEntry,
  SkillFileResponse,
} from "../shared/api";
import { CodeEditor } from "./CodeEditor";
import {
  CopyLinkButton,
  MarkdownPreview,
  type WorkspaceView,
} from "./components";
import { buildCanonicalSkillUri, buildSkillLink } from "./openliaLinks";

export type SkillSubTab = "instructions" | "files" | "overview";

export interface SkillDetailPaneProps {
  skill: SkillDetail;
  activeSubTab: SkillSubTab;
  onSubTabChange: (tab: SkillSubTab) => void;
  selectedFile: SkillFileResponse | null;
  onSelectFile: (fileEntry: SkillFileEntry) => void;
  draftContent: string;
  onDraftChange: (content: string) => void;
  onSaveFile: () => void;
  onResetFile: () => void;
  isSaving: boolean;
  onToggleEnable: (enabled: boolean) => void;
  onTogglePin: (pinned: boolean) => void;
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  error?: string;
  onDismissError?: () => void;
  onNavigateLink?: (href: string) => void;
  onShare?: (() => void) | undefined;
}

export function SkillDetailPane({
  skill,
  activeSubTab,
  onSubTabChange,
  selectedFile,
  onSelectFile,
  draftContent,
  onDraftChange,
  onSaveFile,
  onResetFile,
  isSaving,
  onToggleEnable,
  onTogglePin,
  view,
  onViewChange,
  error,
  onDismissError,
  onNavigateLink,
  onShare,
}: SkillDetailPaneProps) {
  const isDirty =
    selectedFile !== null && selectedFile.content !== draftContent;

  return (
    <div className="workspace-document">
      {/* Skill Header */}
      <div className="shrink-0 border-b border-base-content/10 bg-base-200/50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge badge-neutral text-xs font-semibold uppercase tracking-wider">
                {skill.category}
              </span>
              {skill.version && (
                <span className="badge badge-outline text-xs">
                  v{skill.version}
                </span>
              )}
              {skill.bundled ? (
                <span className="badge badge-info badge-outline text-xs">
                  Bundled
                </span>
              ) : (
                <span className="badge badge-secondary badge-outline text-xs">
                  Custom
                </span>
              )}
              <span
                className={`badge text-xs font-medium ${
                  skill.enabled ? "badge-success" : "badge-ghost opacity-60"
                }`}
              >
                {skill.enabled ? "Active" : "Disabled"}
              </span>
            </div>

            <h1 className="mt-1.5 truncate text-2xl font-bold tracking-tight">
              {skill.name}
            </h1>

            {skill.description && (
              <p className="mt-1 text-sm text-base-content/70">
                {skill.description}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {onShare && (
              <button
                aria-label="Share skill"
                className="btn btn-outline btn-sm gap-1.5"
                onClick={onShare}
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
                    d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>Share</span>
              </button>
            )}
            <CopyLinkButton
              className="btn btn-outline btn-sm gap-1.5"
              link={buildSkillLink(skill.id)}
              title={`Copy link (${buildSkillLink(skill.id)})`}
            />
            <CopyLinkButton
              className="btn btn-outline btn-sm gap-1.5"
              label="Copy URI"
              link={buildCanonicalSkillUri(skill.id)}
              title={`Copy URI (${buildCanonicalSkillUri(skill.id)})`}
            />

            <button
              aria-label={skill.pinned ? "Unpin skill" : "Pin skill"}
              className={`btn btn-circle btn-sm ${
                skill.pinned ? "btn-warning" : "btn-ghost"
              }`}
              onClick={() => onTogglePin(!skill.pinned)}
              title={skill.pinned ? "Pinned" : "Pin to top"}
              type="button"
            >
              <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                <title>{skill.pinned ? "Pinned" : "Pin"}</title>
                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
              </svg>
            </button>

            <button
              className={`btn btn-sm ${
                skill.enabled ? "btn-outline btn-warning" : "btn-success"
              }`}
              onClick={() => onToggleEnable(!skill.enabled)}
              type="button"
            >
              {skill.enabled ? "Disable Skill" : "Enable Skill"}
            </button>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="mt-4 flex border-b border-base-content/10">
          <button
            className={`cursor-pointer px-4 py-2 text-sm font-medium transition-colors ${
              activeSubTab === "instructions"
                ? "border-b-2 border-primary text-primary"
                : "text-base-content/60 hover:text-base-content"
            }`}
            onClick={() => onSubTabChange("instructions")}
            type="button"
          >
            Instructions (SKILL.md)
          </button>
          <button
            className={`cursor-pointer px-4 py-2 text-sm font-medium transition-colors ${
              activeSubTab === "files"
                ? "border-b-2 border-primary text-primary"
                : "text-base-content/60 hover:text-base-content"
            }`}
            onClick={() => onSubTabChange("files")}
            type="button"
          >
            Files ({skill.files.length})
          </button>
          <button
            className={`cursor-pointer px-4 py-2 text-sm font-medium transition-colors ${
              activeSubTab === "overview"
                ? "border-b-2 border-primary text-primary"
                : "text-base-content/60 hover:text-base-content"
            }`}
            onClick={() => onSubTabChange("overview")}
            type="button"
          >
            Overview & Details
          </button>
        </div>
      </div>

      {error && (
        <div className="m-4 flex shrink-0 items-center justify-between rounded-lg bg-error p-3 text-sm text-error-content">
          <span>{error}</span>
          {onDismissError && (
            <button
              className="btn btn-ghost btn-xs text-error-content"
              onClick={onDismissError}
              type="button"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Tab Content */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {activeSubTab === "instructions" && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Editor toolbar */}
            <div className="flex shrink-0 items-center justify-between border-b border-base-content/10 px-4 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-base-content/60">
                  {selectedFile?.path ?? "SKILL.md"}
                </span>
                {isDirty && (
                  <span className="badge badge-warning badge-xs">Unsaved</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {/* View switcher */}
                <div className="join">
                  <button
                    className={`btn join-item btn-xs ${
                      view === "preview" ? "btn-neutral" : "btn-ghost"
                    }`}
                    onClick={() => onViewChange("preview")}
                    type="button"
                  >
                    Preview
                  </button>
                  <button
                    className={`btn join-item btn-xs ${
                      view === "edit" ? "btn-neutral" : "btn-ghost"
                    }`}
                    onClick={() => onViewChange("edit")}
                    type="button"
                  >
                    Edit
                  </button>
                </div>

                {isDirty && (
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={onResetFile}
                    type="button"
                  >
                    Revert
                  </button>
                )}

                <button
                  className="btn btn-primary btn-xs gap-1"
                  disabled={!isDirty || isSaving}
                  onClick={onSaveFile}
                  type="button"
                >
                  {isSaving ? "Saving..." : "Save"}
                  <kbd className="kbd kbd-xs bg-base-100/20 text-[10px]">
                    ⌘S
                  </kbd>
                </button>
              </div>
            </div>

            {/* Edit / Preview pane */}
            <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
              {view === "edit" ? (
                <div className="workspace-editor-pane border-r-0">
                  <CodeEditor
                    className="min-h-0 flex-1"
                    filePath={selectedFile?.path ?? "SKILL.md"}
                    minHeight="0"
                    onChange={onDraftChange}
                    value={draftContent}
                  />
                </div>
              ) : (
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
                  <MarkdownPreview
                    content={draftContent}
                    onNavigateLink={onNavigateLink}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {activeSubTab === "files" && (
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {/* File list on left */}
            <div className="min-h-0 w-64 shrink-0 border-r border-base-content/10 overflow-y-auto p-2 bg-base-200/30">
              <p className="px-2 py-1 text-xs font-semibold uppercase text-base-content/50">
                Skill Files
              </p>
              <ul className="space-y-0.5 mt-1">
                {skill.files.map((file) => {
                  const isCurrent = selectedFile?.path === file.path;
                  return (
                    <li key={file.path}>
                      <button
                        className={`flex w-full items-center justify-between rounded p-2 text-left text-xs transition-colors ${
                          isCurrent
                            ? "bg-primary text-primary-content font-medium"
                            : "hover:bg-base-200 text-base-content"
                        }`}
                        onClick={() => onSelectFile(file)}
                        type="button"
                      >
                        <span className="truncate">{file.path}</span>
                        <span className="text-[10px] opacity-60">
                          {Math.round(file.size / 1024)}k
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Selected file editor on right */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {selectedFile ? (
                <>
                  <div className="flex shrink-0 items-center justify-between border-b border-base-content/10 px-4 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{selectedFile.path}</span>
                      <CopyLinkButton
                        className="btn btn-ghost btn-xs btn-square text-base-content/60 hover:text-base-content"
                        iconOnly
                        link={buildSkillLink(skill.id, selectedFile.path)}
                        size="xs"
                        title={`Copy link: ${buildSkillLink(skill.id, selectedFile.path)}`}
                      />
                      {isDirty && (
                        <span className="badge badge-warning badge-xs">
                          Unsaved
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <CopyLinkButton
                        className="btn btn-outline btn-xs gap-1"
                        link={buildSkillLink(skill.id, selectedFile.path)}
                        size="xs"
                        title={`Copy link (${buildSkillLink(skill.id, selectedFile.path)})`}
                      />
                      <CopyLinkButton
                        className="btn btn-outline btn-xs gap-1"
                        label="Copy URI"
                        link={buildCanonicalSkillUri(
                          skill.id,
                          selectedFile.path,
                        )}
                        size="xs"
                        title={`Copy URI (${buildCanonicalSkillUri(skill.id, selectedFile.path)})`}
                      />
                      {isDirty && (
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={onResetFile}
                          type="button"
                        >
                          Revert
                        </button>
                      )}
                      <button
                        className="btn btn-primary btn-xs"
                        disabled={!isDirty || isSaving}
                        onClick={onSaveFile}
                        type="button"
                      >
                        {isSaving ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </div>
                  <div className="workspace-editor-pane border-r-0">
                    <CodeEditor
                      className="min-h-0 flex-1"
                      filePath={selectedFile.path}
                      minHeight="0"
                      onChange={onDraftChange}
                      value={draftContent}
                    />
                  </div>
                </>
              ) : (
                <div className="grid h-full place-items-center text-sm text-base-content/40">
                  Select a file from the list to view and edit.
                </div>
              )}
            </div>
          </div>
        )}

        {activeSubTab === "overview" && (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6 max-w-4xl space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Telemetry & Usage Card */}
              <div className="card border border-base-content/10 bg-base-100 p-4 shadow-sm">
                <h3 className="text-sm font-semibold text-base-content/70">
                  Usage & Telemetry
                </h3>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="text-base-content/50">Invocations</dt>
                    <dd className="text-base font-semibold">
                      {skill.useCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-base-content/50">Last Invoked</dt>
                    <dd className="font-medium">
                      {skill.lastUsedAt
                        ? new Date(skill.lastUsedAt).toLocaleDateString()
                        : "Never"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-base-content/50">Total Files</dt>
                    <dd className="font-medium">{skill.fileCount}</dd>
                  </div>
                  <div>
                    <dt className="text-base-content/50">Pinned</dt>
                    <dd className="font-medium">
                      {skill.pinned ? "Yes" : "No"}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Environment & Prerequisites Card */}
              <div className="card border border-base-content/10 bg-base-100 p-4 shadow-sm">
                <h3 className="text-sm font-semibold text-base-content/70">
                  Prerequisites
                </h3>
                {skill.prerequisites?.env_vars &&
                  skill.prerequisites.env_vars.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <p className="text-xs text-base-content/50">
                        Required Environment Variables:
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {skill.prerequisites.env_vars.map((v) => (
                          <code
                            key={v}
                            className="badge badge-outline font-mono text-xs"
                          >
                            {v}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}

                {skill.prerequisites?.credential_files &&
                  skill.prerequisites.credential_files.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <p className="text-xs text-base-content/50">
                        Required Credential Files:
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {skill.prerequisites.credential_files.map((cf) => (
                          <code
                            key={cf}
                            className="badge badge-outline font-mono text-xs"
                          >
                            {cf}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}

                {(!skill.prerequisites?.env_vars ||
                  skill.prerequisites.env_vars.length === 0) &&
                  (!skill.prerequisites?.credential_files ||
                    skill.prerequisites.credential_files.length === 0) && (
                    <p className="mt-3 text-xs text-base-content/50">
                      No special environment variables or tokens required.
                    </p>
                  )}

                {skill.platforms && skill.platforms.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-base-content/50">Platforms:</p>
                    <div className="mt-1 flex gap-1">
                      {skill.platforms.map((p) => (
                        <span
                          key={p}
                          className="badge badge-ghost badge-xs capitalize"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Tags Card */}
            {skill.tags.length > 0 && (
              <div className="card border border-base-content/10 bg-base-100 p-4 shadow-sm">
                <h3 className="text-sm font-semibold text-base-content/70">
                  Tags & Discovery Keywords
                </h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {skill.tags.map((t) => (
                    <span key={t} className="badge badge-secondary badge-sm">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Skill Link Card */}
            <div className="card border border-base-content/10 bg-base-100 p-4 shadow-sm space-y-3">
              <div>
                <h3 className="text-xs uppercase tracking-wide text-base-content/50">
                  Web Link (Share)
                </h3>
                <div className="mt-1 flex items-center justify-between gap-2 rounded bg-base-200/50 p-2 text-xs font-mono">
                  <span className="truncate">{buildSkillLink(skill.id)}</span>
                  <CopyLinkButton
                    className="btn btn-outline btn-xs gap-1 shrink-0"
                    link={buildSkillLink(skill.id)}
                    size="xs"
                    title={`Copy ${buildSkillLink(skill.id)}`}
                  />
                </div>
              </div>
              <div>
                <h3 className="text-xs uppercase tracking-wide text-base-content/50">
                  Skill URI (openlia://)
                </h3>
                <div className="mt-1 flex items-center justify-between gap-2 rounded bg-base-200/50 p-2 text-xs font-mono">
                  <span className="truncate">
                    {buildCanonicalSkillUri(skill.id)}
                  </span>
                  <CopyLinkButton
                    className="btn btn-outline btn-xs gap-1 shrink-0"
                    link={buildCanonicalSkillUri(skill.id)}
                    size="xs"
                    title={`Copy ${buildCanonicalSkillUri(skill.id)}`}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
