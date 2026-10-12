import type { ComponentProps, ReactNode, RefObject } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  WorkspaceActivityResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceGitStatus,
  WorkspaceTreeEntry,
} from "../shared/api";
import { ActivitySection } from "./ActivitySection";
import {
  CodeEditor,
  isJournalPath,
  isMarkdownPath,
  isRemindPath,
} from "./CodeEditor";
import { FrontmatterBlock } from "./FrontmatterBlock";
import { JournalPreviewPane } from "./journal/JournalPreviewPane";
import { CalendarPreviewPane } from "./calendar/CalendarPreviewPane";
import { parseMarkdownFrontmatter } from "./frontmatter";
import { extractOriginalMessage } from "./markdown";
import {
  buildCanonicalWorkspaceUri,
  buildWorkspaceLink,
  copyToClipboard,
} from "./openliaLinks";

export { ActivitySection } from "./ActivitySection";
export { GitActivitySection } from "./GitActivitySection";
export { IngestionSection } from "./IngestionSection";
export { MoveFileDialog } from "./MoveFileDialog";
export { RenameFileDialog } from "./RenameFileDialog";
export { isJournalPath, isMarkdownPath, isRemindPath } from "./CodeEditor";

export type WorkspaceView = "edit" | "preview" | "info";

interface TreeNode {
  path: string;
  name: string;
  kind: WorkspaceTreeEntry["kind"];
  editable?: boolean;
  children: TreeNode[];
}

function buildTree(entries: WorkspaceTreeEntry[]): TreeNode[] {
  const root: TreeNode = {
    children: [],
    kind: "directory",
    name: "",
    path: "",
  };

  for (const entry of entries) {
    const parts = entry.path.split("/");
    let parent = root;
    let currentPath = "";
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let node = parent.children.find((child) => child.path === currentPath);
      if (!node) {
        const createdNode: TreeNode = {
          children: [],
          kind: index === parts.length - 1 ? entry.kind : "directory",
          name: part,
          path: currentPath,
        };
        if (entry.kind === "file") createdNode.editable = entry.editable;
        node = createdNode;
        parent.children.push(node);
      }
      parent = node;
    });
  }

  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return [...nodes]
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return (
          left.name.localeCompare(right.name, undefined, {
            numeric: true,
            sensitivity: "base",
          }) || left.path.localeCompare(right.path)
        );
      })
      .map((node) => ({ ...node, children: sortNodes(node.children) }));
  }

  return sortNodes(root.children);
}

function countFiles(nodes: TreeNode[]): number {
  return nodes.reduce(
    (count, node) =>
      count + (node.kind === "file" ? 1 : countFiles(node.children)),
    0,
  );
}

function nodeMatches(node: TreeNode, query: string): boolean {
  if (!query) return true;
  return (
    node.path.toLowerCase().includes(query) ||
    node.children.some((child) => nodeMatches(child, query))
  );
}

function matchedFiles(nodes: TreeNode[], query: string): number {
  return nodes.reduce((count, node) => {
    if (node.kind === "file")
      return count + (node.path.toLowerCase().includes(query) ? 1 : 0);
    return count + matchedFiles(node.children, query);
  }, 0);
}

export function CopyLinkButton({
  link,
  label = "Copy Link",
  copiedLabel = "Copied!",
  className = "btn btn-outline btn-sm gap-1.5",
  title = "Copy link to clipboard",
  iconOnly = false,
  size = "sm",
  onClick,
}: {
  link: string;
  label?: string | undefined;
  copiedLabel?: string | undefined;
  className?: string | undefined;
  title?: string | undefined;
  iconOnly?: boolean | undefined;
  size?: "xs" | "sm" | undefined;
  onClick?: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboard(link);
    if (ok) {
      setCopied(true);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 2000);
    }
    onClick?.();
  };

  return (
    <button
      aria-label={copied ? "Link copied to clipboard" : title}
      className={`${className} ${size === "xs" ? "btn-xs" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : title}
      type="button"
    >
      {copied ? (
        <svg
          className={
            size === "xs" ? "h-3 w-3 text-success" : "h-3.5 w-3.5 text-success"
          }
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <title>Checkmark icon</title>
          <path
            d="M5 13l4 4L19 7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg
          className={
            size === "xs" ? "h-3 w-3 opacity-70" : "h-3.5 w-3.5 opacity-70"
          }
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <title>Copy link icon</title>
          <path
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {!iconOnly && <span>{copied ? copiedLabel : label}</span>}
    </button>
  );
}

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
      {activeTab !== "configuration" && (
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
          className="join shrink-0 border border-base-content/15 rounded-lg bg-base-200/60 p-0.5 mr-2"
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
          {activeTab === "skills"
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
                      ? "WORKSPACE"
                      : "ACTIVITY"}
        </p>
        <div className="flex items-center gap-1.5">
          <h1 className="workspace-title" title={file?.path}>
            {file?.path.split("/").at(-1) ??
              (activeTab === "skills"
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
            {file.path}
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

export function FileNavigator({
  entries,
  filter,
  loading,
  mobileOpen,
  onClose,
  onFilterChange,
  onOpenFile,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  rawUrl,
  downloadUrl,
  onRetry,
  revealToken = 0,
  selectedPath,
  truncated,
  workspaceError,
}: {
  entries: WorkspaceTreeEntry[];
  filter: string;
  loading: boolean;
  mobileOpen: boolean;
  onClose: () => void;
  onFilterChange: (value: string) => void;
  onOpenFile: (path: string) => void;
  onRenameFile?: ((path: string) => void) | undefined;
  onMoveFile?: ((path: string) => void) | undefined;
  onDeleteFile?: ((path: string) => void) | undefined;
  rawUrl?: ((path: string) => string) | undefined;
  downloadUrl?: ((path: string) => string) | undefined;
  onRetry: () => void;
  revealToken?: number | undefined;
  selectedPath: string | undefined;
  truncated: boolean;
  workspaceError: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
  const nodes = useMemo(() => buildTree(entries), [entries]);
  const initializedTree = useRef(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const filesHeadingId = useId();
  const fileButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  closeRef.current = onClose;

  useEffect(() => {
    if (initializedTree.current || nodes.length === 0) return;
    initializedTree.current = true;
    setCollapsed(
      new Set(
        nodes
          .filter((node) => node.kind === "directory")
          .map((node) => node.path),
      ),
    );
  }, [nodes]);

  useEffect(() => {
    if (!selectedPath) return;
    const parts = selectedPath.split("/");
    const ancestors = parts
      .slice(0, -1)
      .map((_, index) => parts.slice(0, index + 1).join("/"));
    setCollapsed((current) => {
      const next = new Set(current);
      for (const ancestor of ancestors) next.delete(ancestor);
      return next;
    });
  }, [selectedPath]);

  useEffect(() => {
    if (!revealToken || !selectedPath) return;
    const parts = selectedPath.split("/");
    const ancestors = parts
      .slice(0, -1)
      .map((_, index) => parts.slice(0, index + 1).join("/"));
    setCollapsed((current) => {
      const next = new Set(current);
      for (const ancestor of ancestors) next.delete(ancestor);
      return next;
    });

    setHighlightedPath(selectedPath);
    const timer = setTimeout(() => {
      setHighlightedPath(null);
    }, 2000);

    const raf = requestAnimationFrame(() => {
      const el = fileButtonRefs.current.get(selectedPath);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
      }
    });

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [revealToken, selectedPath]);

  useEffect(() => {
    if (!mobileOpen) return;
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const query = filter.trim().toLowerCase();
  const totalFiles = countFiles(nodes);
  const visibleFiles = query ? matchedFiles(nodes, query) : totalFiles;

  function renderNodes(nodesToRender: TreeNode[], depth = 0): ReactNode {
    return (
      <ul className="grid gap-0.5">
        {nodesToRender.map((node) => {
          if (!nodeMatches(node, query)) return null;
          const isCollapsed = collapsed.has(node.path);
          const isDirectory = node.kind === "directory";
          const forcedOpen = Boolean(query);
          const hasChildren = isDirectory && node.children.length > 0;
          const childrenVisible = hasChildren && (!isCollapsed || forcedOpen);
          const directoryId = `workspace-directory-${encodeURIComponent(node.path)}`;
          return (
            <li key={node.path}>
              {isDirectory ? (
                <>
                  {hasChildren ? (
                    <button
                      aria-controls={directoryId}
                      aria-expanded={childrenVisible}
                      className="workspace-tree-row workspace-tree-directory"
                      disabled={forcedOpen}
                      onClick={() => {
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(node.path)) next.delete(node.path);
                          else next.add(node.path);
                          return next;
                        });
                      }}
                      style={{ paddingInlineStart: `${depth * 12 + 8}px` }}
                      title={
                        forcedOpen
                          ? "Clear search to collapse folders"
                          : node.path
                      }
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="workspace-tree-chevron"
                      >
                        {childrenVisible ? "▾" : "▸"}
                      </span>
                      <span className="truncate">{node.name}</span>
                    </button>
                  ) : (
                    <div
                      aria-label={`${node.name}, empty folder`}
                      className="workspace-tree-row workspace-tree-directory workspace-tree-empty-directory"
                      role="treeitem"
                      style={{ paddingInlineStart: `${depth * 12 + 8}px` }}
                      tabIndex={-1}
                      title={`${node.path} (empty)`}
                    >
                      <span
                        aria-hidden="true"
                        className="workspace-tree-chevron"
                      />
                      <span className="truncate">{node.name}</span>
                    </div>
                  )}
                  {childrenVisible && (
                    <div id={directoryId}>
                      {renderNodes(node.children, depth + 1)}
                    </div>
                  )}
                </>
              ) : (
                <div className="group relative flex items-center">
                  <button
                    ref={(el) => {
                      if (el) {
                        fileButtonRefs.current.set(node.path, el);
                      } else {
                        fileButtonRefs.current.delete(node.path);
                      }
                    }}
                    aria-current={
                      selectedPath === node.path ? "page" : undefined
                    }
                    className={`workspace-tree-row workspace-tree-file flex-1 pr-7 ${selectedPath === node.path ? "workspace-tree-file-selected" : ""} ${highlightedPath === node.path ? "workspace-tree-file-highlight" : ""}`}
                    onClick={() => onOpenFile(node.path)}
                    style={{ paddingInlineStart: `${depth * 12 + 28}px` }}
                    title={node.path}
                    type="button"
                  >
                    <span className="min-w-0 truncate">{node.name}</span>
                    {!node.editable && (
                      <span className="text-[10px]" title="View only">
                        View only ↗
                      </span>
                    )}
                  </button>
                  {(onRenameFile ||
                    onMoveFile ||
                    onDeleteFile ||
                    (rawUrl && downloadUrl)) && (
                    <div className="dropdown dropdown-end absolute right-1 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        aria-label={`Actions for ${node.name}`}
                        className="btn btn-ghost btn-xs btn-square h-5 w-5 text-base-content/60 hover:text-base-content"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                        type="button"
                      >
                        <svg
                          className="h-3 w-3"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <title>More file actions</title>
                          <circle cx="12" cy="5" r="2" />
                          <circle cx="12" cy="12" r="2" />
                          <circle cx="12" cy="19" r="2" />
                        </svg>
                      </button>
                      <ul className="dropdown-content menu z-30 rounded-box border border-base-content/10 bg-base-100 p-1 shadow-lg text-xs w-36">
                        {onRenameFile && node.editable && (
                          <li>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                (document.activeElement as HTMLElement)?.blur();
                                onRenameFile(node.path);
                              }}
                              type="button"
                            >
                              Rename...
                            </button>
                          </li>
                        )}
                        {onMoveFile && node.editable && (
                          <li>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                (document.activeElement as HTMLElement)?.blur();
                                onMoveFile(node.path);
                              }}
                              type="button"
                            >
                              Move...
                            </button>
                          </li>
                        )}
                        {!node.editable && rawUrl && downloadUrl && (
                          <>
                            <li>
                              <a
                                href={rawUrl(node.path)}
                                onClick={(e) => e.stopPropagation()}
                                rel="noreferrer"
                                target="_blank"
                              >
                                Open in New Tab ↗
                              </a>
                            </li>
                            <li>
                              <a
                                download
                                href={downloadUrl(node.path)}
                                onClick={(e) => e.stopPropagation()}
                              >
                                Download
                              </a>
                            </li>
                          </>
                        )}
                        <li>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              (document.activeElement as HTMLElement)?.blur();
                              void copyToClipboard(
                                buildWorkspaceLink(node.path),
                              );
                            }}
                            type="button"
                          >
                            Copy Link
                          </button>
                        </li>
                        {onDeleteFile && node.editable && (
                          <li>
                            <button
                              className="text-error"
                              onClick={(e) => {
                                e.stopPropagation();
                                (document.activeElement as HTMLElement)?.blur();
                                onDeleteFile(node.path);
                              }}
                              type="button"
                            >
                              Delete...
                            </button>
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      {mobileOpen && (
        <button
          aria-label="Close files"
          className="fixed inset-0 z-30 bg-black/75 backdrop-blur-sm xl:hidden"
          onClick={onClose}
          type="button"
        />
      )}
      <aside
        aria-label="Workspace files"
        aria-labelledby={mobileOpen ? filesHeadingId : undefined}
        className={`workspace-navigator ${mobileOpen ? "fixed inset-y-0 left-0 z-40 flex w-[min(88vw,340px)] bg-base-100 shadow-2xl" : "hidden"} xl:relative xl:flex`}
        role={mobileOpen ? "dialog" : "complementary"}
      >
        <div className="flex items-center justify-between border-b border-base-content/10 px-4 py-3 xl:hidden">
          <h2 className="font-semibold" id={filesHeadingId}>
            Files
          </h2>
          <button
            className="btn btn-ghost btn-sm"
            ref={closeButtonRef}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Files</h2>
              <p
                aria-live="polite"
                className="mt-1 text-xs text-base-content/50"
              >
                {query
                  ? `${visibleFiles} matching files`
                  : `${totalFiles} files`}
              </p>
            </div>
            {query && (
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => onFilterChange("")}
                type="button"
              >
                Clear
              </button>
            )}
          </div>
          <label className="sr-only" htmlFor="workspace-file-filter">
            Find files
          </label>
          <input
            className="input input-bordered input-sm w-full bg-base-200/50"
            id="workspace-file-filter"
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Search paths"
            type="search"
            value={filter}
          />
          {query &&
            selectedPath &&
            !selectedPath.toLowerCase().includes(query) && (
              <p className="mt-2 text-xs text-warning" role="status">
                Current document is outside this search.
              </p>
            )}
          {truncated && (
            <p className="alert alert-warning mt-3 p-3 text-xs">
              Showing the first {entries.length} workspace entries.
            </p>
          )}
          {workspaceError ? (
            <div className="mt-5 rounded-lg border border-error/30 bg-error/10 p-4">
              <p className="text-sm font-semibold">Workspace unavailable</p>
              <p className="mt-1 text-xs text-base-content/60">
                Workspace files could not be loaded.
              </p>
              <button
                className="btn btn-error btn-sm mt-3"
                onClick={onRetry}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : loading ? (
            <p className="mt-5 text-sm text-base-content/50">
              Loading files...
            </p>
          ) : visibleFiles === 0 ? (
            <div className="mt-5 rounded-lg border border-base-content/10 bg-base-200/40 p-4">
              <p className="text-sm font-semibold">
                {query ? `No files match “${filter}”` : "No documents yet"}
              </p>
              <p className="mt-1 text-xs text-base-content/60">
                {query
                  ? "Try a different path or clear the search."
                  : "Choose a document when one is available in this workspace."}
              </p>
            </div>
          ) : (
            <div className="mt-4">{renderNodes(nodes)}</div>
          )}
        </div>
      </aside>
    </>
  );
}

export function transformMarkdownUrl(url: string): string {
  if (
    url.startsWith("openlia://") ||
    url.startsWith("/") ||
    url.startsWith("./") ||
    url.startsWith("../")
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}

export function MarkdownPreview({
  content,
  currentFilePath: _currentFilePath,
  onNavigateLink,
}: {
  content: string;
  currentFilePath?: string | undefined;
  onNavigateLink?: ((href: string) => void) | undefined;
}) {
  const {
    frontmatter,
    rawYaml,
    body: markdownBody,
  } = useMemo(() => parseMarkdownFrontmatter(content), [content]);
  const { body, originalMessage } = useMemo(
    () => extractOriginalMessage(markdownBody),
    [markdownBody],
  );

  const customComponents = useMemo(() => {
    return {
      a: ({ children, href, onClick, ...props }: ComponentProps<"a">) => {
        const isRelative =
          href &&
          (href.startsWith("./") ||
            href.startsWith("../") ||
            (!href.includes("://") &&
              !href.startsWith("/") &&
              !href.startsWith("mailto:") &&
              !href.startsWith("#") &&
              href.endsWith(".md")));

        const isInternal =
          href &&
          (isRelative ||
            href.startsWith("openlia://") ||
            href.startsWith("/files/") ||
            href.startsWith("/skills/") ||
            ((href.startsWith("http://") || href.startsWith("https://")) &&
              (href.includes("/files/") || href.includes("/skills/"))));

        if (isInternal && onNavigateLink) {
          return (
            <a
              {...props}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                onClick?.(e);
                onNavigateLink(href);
              }}
              title={props.title || "Open in Workspace UI"}
            >
              {children}
            </a>
          );
        }

        return (
          <a
            {...props}
            href={href}
            onClick={onClick}
            rel="noreferrer noopener"
            target="_blank"
          >
            {children}
          </a>
        );
      },
      input: ({ checked, ...props }: ComponentProps<"input">) => (
        <input {...props} checked={checked} disabled type="checkbox" />
      ),
    };
  }, [onNavigateLink]);

  if (!content)
    return (
      <div className="grid h-full min-h-[22rem] place-items-center p-6 text-center text-sm italic text-base-content/50">
        Preview appears here when you select a document.
      </div>
    );

  return (
    <article aria-label="Markdown preview" className="workspace-markdown">
      {frontmatter && rawYaml && (
        <FrontmatterBlock data={frontmatter} rawYaml={rawYaml} />
      )}
      {body && (
        <ReactMarkdown
          components={customComponents}
          remarkPlugins={[remarkGfm]}
          urlTransform={transformMarkdownUrl}
        >
          {body}
        </ReactMarkdown>
      )}
      {originalMessage !== null && (
        <section
          aria-label="Original message"
          className="workspace-original-message"
        >
          <h2 className="workspace-original-message-heading">
            Original message
          </h2>
          <div className="workspace-original-message-content">
            <ReactMarkdown
              components={customComponents}
              remarkPlugins={[remarkGfm]}
              urlTransform={transformMarkdownUrl}
            >
              {originalMessage}
            </ReactMarkdown>
          </div>
        </section>
      )}
    </article>
  );
}

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
                {dirty ? "Unsaved draft" : "Saved"}
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
                {new Date(file.modified_at).toLocaleString()}
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
              {file.validation.schema_path && (
                <p className="text-[11px] font-mono text-base-content/60 truncate">
                  Schema: {file.validation.schema_path}
                </p>
              )}
              {!file.validation.valid && file.validation.errors.length > 0 && (
                <ul className="list-disc list-inside text-xs text-warning space-y-1 pt-1">
                  {file.validation.errors.map((err) => (
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
  downloadUrl,
  onDownload,
  rawUrl,
}: {
  artifact: WorkspaceFileMetadata;
  downloadUrl?: ((path: string) => string) | undefined;
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
  otherCalendarFiles,
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
  otherCalendarFiles?: Array<{ path: string; content: string }> | undefined;
  onLoadInclude?:
    | ((resolvedPath: string) => Promise<string | null>)
    | undefined;
}) {
  const dirty = file !== null && file.content !== draft;
  const canEdit = Boolean(file?.editable);
  const isMarkdown = file !== null && isMarkdownPath(file.path);
  const isJournal = file !== null && isJournalPath(file.path);
  const isRemind = file !== null && isRemindPath(file.path);

  return (
    <section aria-label="Document workspace" className="workspace-document">
      {artifact ? (
        <ArtifactPane
          artifact={artifact}
          downloadUrl={downloadUrl}
          onDownload={onDownload}
          rawUrl={rawUrl}
        />
      ) : file ? (
        <>
          <div className="workspace-document-toolbar">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="workspace-document-name" title={file.path}>
                  {file.path}
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
                {onRename && file.editable && (
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
                {onMove && file.editable && (
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
              </ul>
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
                  {file.validation.errors.map((err) => (
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
                  onDraftChange={onDraftChange}
                  onSwitchToEdit={() => onViewChange("edit")}
                  onNavigateLink={onNavigateLink}
                  otherCalendarFiles={otherCalendarFiles}
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

export function DirtyDraftDialog({
  onCancel,
  onDiscard,
  onSave,
  actionLabel,
  saving,
}: {
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
  actionLabel: string;
  saving: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
    >
      <section
        aria-labelledby="unsaved-dialog-title"
        aria-modal="true"
        className="card w-full max-w-md border border-base-content/10 bg-base-100 shadow-2xl"
        role="dialog"
      >
        <div className="card-body">
          <h2 className="card-title" id="unsaved-dialog-title">
            Keep your draft?
          </h2>
          <p className="text-sm leading-6 text-base-content/60">
            You have changes that are not saved. Save them before{" "}
            {actionLabel.toLowerCase()}, discard them, or keep editing.
          </p>
          <div className="card-actions mt-4 justify-end">
            <button className="btn btn-ghost" onClick={onCancel} type="button">
              Keep editing
            </button>
            <button
              className="btn btn-error btn-outline"
              onClick={onDiscard}
              type="button"
            >
              Discard
            </button>
            <button
              className="btn btn-primary"
              disabled={saving}
              onClick={onSave}
              type="button"
            >
              {saving ? "Saving..." : "Save and continue"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function DeleteFileDialog({
  dirty,
  filePath,
  onCancel,
  onConfirm,
  deleting,
}: {
  dirty: boolean;
  filePath: string;
  onCancel: () => void;
  onConfirm: () => void;
  deleting: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
    >
      <section
        aria-labelledby="delete-dialog-title"
        aria-modal="true"
        className="card w-full max-w-md border border-error/30 bg-base-100 shadow-2xl"
        role="dialog"
      >
        <div className="card-body">
          <h2 className="card-title" id="delete-dialog-title">
            Delete document?
          </h2>
          <p className="break-words text-sm leading-6 text-base-content/60">
            {dirty
              ? `"${filePath}" has unsaved changes. Deleting it will discard the draft.`
              : `This will permanently delete "${filePath}" from the workspace.`}
          </p>
          <div className="card-actions mt-4 justify-end">
            <button
              className="btn btn-ghost"
              disabled={deleting}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-error"
              disabled={deleting}
              onClick={onConfirm}
              type="button"
            >
              {deleting
                ? "Deleting..."
                : dirty
                  ? "Discard and delete"
                  : "Delete"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
