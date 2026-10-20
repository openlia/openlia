import type { RefObject } from "react";
import type {
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceGitStatus,
} from "../../../shared/api";
import { isRemindPath } from "../../CodeEditor";
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
  onOpenCalendar,
  onOpenGoTo,
  onSignOut,
  onTabChange,
}: {
  activeTab?:
    | "documents"
    | "skills"
    | "ingestion"
    | "git-activity"
    | "configuration"
    | "usage"
    | "migration"
    | undefined;
  authRequired: boolean;
  currentLink?: string | undefined;
  filesButtonRef: RefObject<HTMLButtonElement | null>;
  file: (WorkspaceFile | WorkspaceFileMetadata) | null;
  git: WorkspaceGitStatus | null;
  onOpenFiles: () => void;
  onOpenDocuments?: (() => void) | undefined;
  onOpenCalendar?: (() => void) | undefined;
  onOpenGoTo?: (() => void) | undefined;
  onSignOut: () => void;
  onTabChange?:
    | ((
        tab:
          | "documents"
          | "skills"
          | "ingestion"
          | "git-activity"
          | "configuration"
          | "usage"
          | "migration",
      ) => void)
    | undefined;
}) {
  const gitText = git?.configured
    ? `${git.branch ?? "Git"}${git.dirty ? " / changes" : " / clean"}`
    : "Version control unavailable";

  const isCalendarActive =
    activeTab === "documents" && file !== null && isRemindPath(file.path);

  return (
    <header className="workspace-header">
      {activeTab !== "configuration" && activeTab !== "usage" && (
        <button
          aria-label={
            activeTab === "skills" ? "Open skills drawer" : "Open files drawer"
          }
          className="btn btn-ghost btn-sm xl:hidden"
          ref={filesButtonRef}
          onClick={onOpenFiles}
          type="button"
        >
          {activeTab === "skills" ? "Skills" : "Files"}
        </button>
      )}

      {(onTabChange || onOpenDocuments) && (
        <nav
          aria-label="Workspace navigation"
          className="join flex max-w-full shrink-0 flex-wrap border border-base-content/15 rounded-lg bg-base-200/60 p-0.5 mr-2"
        >
          {(onOpenDocuments || onTabChange) && (
            <button
              aria-current={
                activeTab === "documents" && !isCalendarActive
                  ? "page"
                  : undefined
              }
              className={`btn btn-xs join-item ${
                activeTab === "documents" && !isCalendarActive
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
          {onOpenCalendar && (
            <button
              aria-current={isCalendarActive ? "page" : undefined}
              className={`btn btn-xs join-item ${
                isCalendarActive
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              onClick={onOpenCalendar}
              title="Open Calendar (reminders.rem)"
              type="button"
            >
              Calendar
            </button>
          )}
          {onTabChange && (
            <button
              aria-current={activeTab === "ingestion" ? "page" : undefined}
              className={`btn btn-xs join-item ${
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
              aria-current={activeTab === "skills" ? "page" : undefined}
              className={`btn btn-xs join-item ${
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
              aria-current={activeTab === "migration" ? "page" : undefined}
              aria-label="Migrations"
              className={`btn btn-xs join-item ${
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
              className={`btn btn-xs join-item ${activeTab === "usage" ? "btn-primary shadow-xs" : "btn-ghost text-base-content/70"}`}
              onClick={() => onTabChange("usage")}
            >
              Usage
            </button>
          )}
          {onTabChange && (
            <button
              aria-current={activeTab === "git-activity" ? "page" : undefined}
              className={`btn btn-xs join-item ${
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
          {activeTab === "usage"
            ? "USAGE"
            : activeTab === "skills"
              ? "SKILLS"
              : activeTab === "git-activity"
                ? "GIT ACTIVITY"
                : activeTab === "ingestion"
                  ? "INGESTION RUNTIME"
                  : activeTab === "migration"
                    ? "MIGRATION"
                    : activeTab === "configuration"
                      ? "CONFIGURATION"
                      : file
                        ? file.source === "memory"
                          ? "ASSISTANT MEMORY"
                          : "WORKSPACE"
                        : "ACTIVITY"}
        </p>
        <div className="flex items-center gap-1.5">
          <h1 className="workspace-title" title={file?.path}>
            {file?.path.split("/").at(-1) ??
              (activeTab === "usage"
                ? "Usage"
                : activeTab === "skills"
                  ? "Skills"
                  : activeTab === "git-activity"
                    ? "Git Activity"
                    : activeTab === "ingestion"
                      ? "Ingestion"
                      : activeTab === "configuration"
                        ? "Configuration"
                        : "Activity")}
          </h1>
          {currentLink && (
            <CopyLinkButton
              className="btn btn-ghost btn-xs btn-square text-base-content/60 hover:text-base-content"
              iconOnly
              link={currentLink}
              size="xs"
              title={`Copy link: ${currentLink}`}
            />
          )}
        </div>
        {file?.path?.includes("/") && (
          <p className="workspace-path" title={file.path}>
            {file.source === "memory"
              ? `Assistant memory / ${file.path.split("/").at(-1)}`
              : file.path}
          </p>
        )}
      </div>
      <div className="workspace-header-actions flex shrink-0 flex-wrap items-center justify-end gap-2">
        {onOpenGoTo && (
          <button
            aria-label="Go to document or skill (Cmd+P or Ctrl+P)"
            className="btn btn-ghost btn-sm gap-1.5 text-base-content/80 hover:text-base-content"
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
            className={`btn btn-sm ${activeTab === "configuration" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onTabChange("configuration")}
            type="button"
          >
            Configuration
          </button>
        )}
        {authRequired && (
          <button
            className="btn btn-ghost btn-sm text-primary"
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
