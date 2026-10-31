import type { RefObject } from "react";
import type {
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceGitStatus,
} from "../../../shared/api";
import { CopyLinkButton } from "../common/CopyLinkButton";

export function WorkspaceHeader({
  activeTab = "documents",
  authRequired,
  currentLink,
  filesButtonRef,
  file,
  git,
  onOpenFiles,
  onOpenDocuments,
  onOpenGoTo,
  onSignOut,
  onTabChange,
}: {
  activeTab?:
    | "chat"
    | "documents"
    | "minions"
    | "skills"
    | "shares"
    | "ingestion"
    | "git-activity"
    | "configuration"
    | "schedule"
    | "usage"
    | "migration"
    | "maintainer"
    | undefined;
  authRequired: boolean;
  currentLink?: string | undefined;
  filesButtonRef: RefObject<HTMLButtonElement | null>;
  file: (WorkspaceFile | WorkspaceFileMetadata) | null;
  git: WorkspaceGitStatus | null;
  onOpenFiles: () => void;
  onOpenDocuments?: (() => void) | undefined;
  onOpenGoTo?: (() => void) | undefined;
  onSignOut: () => void;
  onTabChange?:
    | ((
        tab:
          | "chat"
          | "documents"
          | "minions"
          | "skills"
          | "shares"
          | "ingestion"
          | "git-activity"
          | "configuration"
          | "schedule"
          | "usage"
          | "migration"
          | "maintainer",
      ) => void)
    | undefined;
}) {
  const gitText = git?.configured
    ? `${git.branch ?? "Git"}${git.dirty ? " / changes" : " / clean"}`
    : "Version control unavailable";

  return (
    <header className="workspace-header">
      {(activeTab === "documents" || activeTab === "skills") && (
        <button
          aria-label={
            activeTab === "skills" ? "Open skills drawer" : "Open files drawer"
          }
          className="btn btn-ghost btn-xs sm:btn-sm shrink-0 px-2 xl:hidden"
          ref={filesButtonRef}
          onClick={onOpenFiles}
          type="button"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4 opacity-75"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{activeTab === "skills" ? "Skills" : "Files"}</span>
        </button>
      )}

      {(onTabChange || onOpenDocuments) && (
        <nav
          aria-label="Workspace navigation"
          className="workspace-nav join order-3 flex w-full max-w-full shrink-0 flex-nowrap overflow-x-auto border border-base-content/15 rounded-lg bg-base-200/60 p-0.5 xl:order-none xl:w-auto xl:mr-2"
        >
          {onTabChange && (
            <button
              aria-current={activeTab === "chat" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${activeTab === "chat" ? "btn-primary shadow-xs" : "btn-ghost text-base-content/70"}`}
              onClick={() => onTabChange("chat")}
              type="button"
            >
              Chat
            </button>
          )}
          {(onOpenDocuments || onTabChange) && (
            <button
              aria-current={activeTab === "documents" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${
                activeTab === "documents"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => {
                if (onOpenDocuments) onOpenDocuments();
                else onTabChange?.("documents");
              }}
              title={`View recent workspace changes (${gitText})`}
              type="button"
            >
              Documents
            </button>
          )}
          {onTabChange && (
            <button
              aria-current={activeTab === "ingestion" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${
                activeTab === "ingestion"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => onTabChange("ingestion")}
              type="button"
            >
              Ingestion
            </button>
          )}
          {onTabChange && (
            <button
              aria-current={activeTab === "minions" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${
                activeTab === "minions"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => onTabChange("minions")}
              type="button"
            >
              Minions
            </button>
          )}
          {onTabChange && (
            <button
              aria-current={activeTab === "skills" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${
                activeTab === "skills"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => onTabChange("skills")}
              type="button"
            >
              Skills
            </button>
          )}
          {onTabChange && (
            <button
              aria-current={activeTab === "shares" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${
                activeTab === "shares"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => onTabChange("shares")}
              type="button"
            >
              Shared Links
            </button>
          )}
          {onTabChange && (
            <button
              aria-current={activeTab === "maintainer" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${
                activeTab === "maintainer"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => onTabChange("maintainer")}
              title="Open Workspace Maintainer"
              type="button"
            >
              Maintainer
            </button>
          )}
          {onTabChange && (
            <button
              aria-current={activeTab === "migration" ? "page" : undefined}
              aria-label="Migrations"
              className={`btn btn-xs join-item shrink-0 ${
                activeTab === "migration"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => onTabChange("migration")}
              type="button"
            >
              <span>Migrations</span>
              <span className="badge badge-xs badge-warning/80 font-mono text-[9px] uppercase px-1 py-0 ml-1">
                Beta
              </span>
            </button>
          )}
          {onTabChange && (
            <button
              type="button"
              aria-current={activeTab === "usage" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${activeTab === "usage" ? "btn-primary shadow-xs" : "btn-ghost text-base-content/70"}`}
              onClick={() => onTabChange("usage")}
            >
              Usage
            </button>
          )}
          {onTabChange && (
            <button
              type="button"
              aria-current={activeTab === "schedule" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${activeTab === "schedule" ? "btn-primary shadow-xs" : "btn-ghost text-base-content/70"}`}
              onClick={() => onTabChange("schedule")}
            >
              Schedule
            </button>
          )}
          {onTabChange && (
            <button
              aria-current={activeTab === "git-activity" ? "page" : undefined}
              className={`btn btn-xs join-item shrink-0 ${
                activeTab === "git-activity"
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={() => onTabChange("git-activity")}
              type="button"
            >
              Git
            </button>
          )}
        </nav>
      )}

      <div className="min-w-0 flex-1">
        <p className="workspace-eyebrow">
          OPENLIA /{" "}
          {activeTab === "chat"
            ? "CHAT"
            : activeTab === "usage"
              ? "USAGE"
              : activeTab === "schedule"
                ? "SCHEDULE"
                : activeTab === "minions"
                  ? "MINIONS"
                  : activeTab === "skills"
                    ? "SKILLS"
                  : activeTab === "shares"
                    ? "SHARED LINKS"
                    : activeTab === "git-activity"
                      ? "GIT ACTIVITY"
                      : activeTab === "ingestion"
                        ? "INGESTION RUNTIME"
                        : activeTab === "migration"
                          ? "MIGRATION"
                          : activeTab === "maintainer"
                            ? "MAINTAINER"
                            : activeTab === "configuration"
                              ? "CONFIGURATION"
                              : file
                                ? file.source === "memory"
                                  ? "ASSISTANT MEMORY"
                                  : "WORKSPACE"
                                : "ACTIVITY"}
        </p>
        <div className="flex items-center gap-1 min-w-0">
          <h1 className="workspace-title" title={file?.path}>
            {file?.path.split("/").at(-1) ??
              (activeTab === "chat"
                ? "Chat"
                : activeTab === "usage"
                  ? "Usage"
                  : activeTab === "schedule"
                    ? "Schedule"
                    : activeTab === "minions"
                      ? "Minions"
                      : activeTab === "skills"
                        ? "Skills"
                      : activeTab === "shares"
                        ? "Shared Links"
                        : activeTab === "git-activity"
                          ? "Git Activity"
                          : activeTab === "ingestion"
                            ? "Ingestion"
                            : activeTab === "migration"
                              ? "Migrations"
                              : activeTab === "maintainer"
                                ? "Workspace Maintainer"
                                : activeTab === "configuration"
                                  ? "Configuration"
                                  : "Activity")}
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
            {file.source === "memory"
              ? `Assistant memory / ${file.path.split("/").at(-1)}`
              : file.path}
          </p>
        )}
      </div>
      <div className="workspace-header-actions flex shrink-0 items-center justify-end gap-1 sm:gap-2">
        {onOpenGoTo && (
          <button
            aria-label="Go to document or skill (Cmd+P or Ctrl+P)"
            className="btn btn-ghost btn-xs sm:btn-sm gap-1.5 px-2 text-base-content/80 hover:text-base-content"
            onClick={onOpenGoTo}
            title="Go To (Cmd+P or Ctrl+P)"
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
              ⌘P
            </kbd>
          </button>
        )}
        {onTabChange && (
          <button
            aria-current={activeTab === "configuration" ? "page" : undefined}
            className={`btn btn-xs sm:btn-sm px-2 sm:px-3 ${activeTab === "configuration" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onTabChange("configuration")}
            type="button"
          >
            Configuration
          </button>
        )}
        {authRequired && (
          <button
            className="btn btn-ghost btn-xs sm:btn-sm px-2 text-primary"
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
