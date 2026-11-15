import type { WorkspaceFile, WorkspaceFileMetadata } from "../../../shared/api";
import { buildWorkspaceLink } from "../../openliaLinks";
import { CopyLinkButton } from "../common/CopyLinkButton";

export interface WorkspaceHeaderProps {
  file: WorkspaceFile | WorkspaceFileMetadata | null;
  filesOpen: boolean;
  onToggleFiles: () => void;
  onOpenGoTo?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
  userEmail?: string | undefined;
}

export function WorkspaceHeader({
  file,
  filesOpen,
  onToggleFiles,
  onOpenGoTo,
  onSignOut,
  userEmail,
}: WorkspaceHeaderProps) {
  const currentLink = file ? buildWorkspaceLink(file.path) : null;

  return (
    <header className="workspace-header">
      <button
        aria-expanded={filesOpen}
        aria-label={filesOpen ? "Hide files" : "Show files"}
        className={`btn btn-xs sm:btn-sm shrink-0 ${filesOpen ? "btn-secondary" : "btn-outline"}`}
        onClick={onToggleFiles}
        type="button"
      >
        Files
      </button>

      <div className="min-w-0 flex-1">
        <p className="workspace-eyebrow">OPENLIA / WORKSPACE</p>
        <div className="flex items-center gap-1 min-w-0">
          <h1 className="workspace-title" title={file?.path}>
            {file?.path.split("/").at(-1) ?? "Workspace"}
          </h1>
          {currentLink && (
            <CopyLinkButton
              className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/60 hover:text-base-content"
              iconOnly
              link={currentLink}
              size="xs"
              title={`Copy link: ${currentLink}`}
            />
          )}
        </div>
        {file?.path?.includes("/") && (
          <p className="workspace-path hidden md:block" title={file.path}>
            {file.path}
          </p>
        )}
      </div>

      <div className="workspace-header-actions flex shrink-0 items-center justify-end gap-1 sm:gap-2">
        {onOpenGoTo && (
          <button
            aria-label="Go to document (Cmd+K or Ctrl+K)"
            className="workspace-search-trigger btn btn-ghost btn-xs sm:btn-sm gap-1.5 px-2 text-base-content/80 hover:text-base-content"
            onClick={onOpenGoTo}
            title="Go To (Cmd+K or Ctrl+K)"
            type="button"
          >
            <svg
              className="h-3.5 w-3.5 opacity-70"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <title>Search icon</title>
              <path
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="hidden sm:inline">Go To</span>
            <kbd className="kbd kbd-xs hidden md:inline-flex bg-base-200/80 text-[10px]">
              ⌘K
            </kbd>
          </button>
        )}
        {userEmail && (
          <span
            className="hidden lg:inline-block max-w-44 truncate font-mono text-xs text-base-content/60"
            title={userEmail}
          >
            {userEmail}
          </span>
        )}
        {onSignOut && (
          <button
            className="btn btn-xs sm:btn-sm btn-ghost text-primary"
            onClick={onSignOut}
            type="button"
          >
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
