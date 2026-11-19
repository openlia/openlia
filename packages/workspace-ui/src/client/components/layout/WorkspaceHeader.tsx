import type {
  DocumentScope,
  WorkspaceFile,
  WorkspaceFileMetadata,
} from "../../../shared/api";
import { ScopeSwitcher } from "./ScopeSwitcher";

export interface WorkspaceHeaderProps {
  file: WorkspaceFile | WorkspaceFileMetadata | null;
  filesOpen: boolean;
  onToggleFiles: () => void;
  onOpenGoTo?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
  userEmail?: string | undefined;
  scope?: DocumentScope | undefined;
  onScopeChange?: ((scope: DocumentScope) => void) | undefined;
  workspaceCount?: number | undefined;
  skillsCount?: number | undefined;
  agentCount?: number | undefined;
}

export function WorkspaceHeader({
  file,
  filesOpen,
  onToggleFiles,
  onOpenGoTo,
  onSignOut,
  userEmail,
  scope = "workspace",
  onScopeChange,
  workspaceCount,
  skillsCount,
  agentCount,
}: WorkspaceHeaderProps) {
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

      {onScopeChange && (
        <>
          <div className="hidden sm:flex shrink-0">
            <ScopeSwitcher
              activeScope={scope}
              agentCount={agentCount}
              onScopeChange={onScopeChange}
              size="xs"
              skillsCount={skillsCount}
              workspaceCount={workspaceCount}
            />
          </div>

          <div className="dropdown dropdown-bottom sm:hidden shrink-0">
            <button
              aria-label={`Current scope: ${scope}. Tap to switch`}
              className="btn btn-ghost btn-xs gap-1 px-1.5 font-medium border border-base-content/10 bg-base-200/60"
              type="button"
            >
              {scope === "skills" ? (
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 opacity-80"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : scope === "agent" ? (
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 opacity-80"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M12 2v2m-6 4a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-8a2 2 0 00-2-2H6zm0 0V6a2 2 0 012-2h8a2 2 0 012 2v2M9 13h.01M15 13h.01M9 17h6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 opacity-80"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              <span className="capitalize text-xs font-semibold">{scope}</span>
              <span className="text-[10px] opacity-60">▾</span>
            </button>
            <ul className="dropdown-content menu z-30 rounded-box border border-base-content/10 bg-base-100 p-1 shadow-lg text-xs w-36">
              <li>
                <button
                  className={scope === "workspace" ? "active font-medium" : ""}
                  onClick={(e) => {
                    (e.currentTarget as HTMLElement).blur();
                    (document.activeElement as HTMLElement)?.blur();
                    onScopeChange("workspace");
                  }}
                  type="button"
                >
                  📁 Workspace
                  {typeof workspaceCount === "number" && (
                    <span className="badge badge-xs ml-auto opacity-70">
                      {workspaceCount}
                    </span>
                  )}
                </button>
              </li>
              <li>
                <button
                  className={scope === "skills" ? "active font-medium" : ""}
                  onClick={(e) => {
                    (e.currentTarget as HTMLElement).blur();
                    (document.activeElement as HTMLElement)?.blur();
                    onScopeChange("skills");
                  }}
                  type="button"
                >
                  ⚡ Skills
                  {typeof skillsCount === "number" && (
                    <span className="badge badge-xs ml-auto opacity-70">
                      {skillsCount}
                    </span>
                  )}
                </button>
              </li>
              <li>
                <button
                  className={scope === "agent" ? "active font-medium" : ""}
                  onClick={(e) => {
                    (e.currentTarget as HTMLElement).blur();
                    (document.activeElement as HTMLElement)?.blur();
                    onScopeChange("agent");
                  }}
                  type="button"
                >
                  🤖 Agent
                  {typeof agentCount === "number" && (
                    <span className="badge badge-xs ml-auto opacity-70">
                      {agentCount}
                    </span>
                  )}
                </button>
              </li>
            </ul>
          </div>
        </>
      )}

      <div className="min-w-0 flex-1">
        <p className="workspace-eyebrow">
          OPENLIA /{" "}
          {scope === "skills"
            ? "SKILLS"
            : scope === "agent"
              ? "AGENT"
              : "WORKSPACE"}
        </p>
        <div className="flex items-center gap-1 min-w-0">
          <h1 className="workspace-title truncate" title={file?.path}>
            {file?.path.split("/").at(-1) ??
              (scope === "skills"
                ? "Skills"
                : scope === "agent"
                  ? "Agent"
                  : "Workspace")}
          </h1>
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
