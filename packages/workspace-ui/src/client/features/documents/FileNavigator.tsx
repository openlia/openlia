import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentScope, WorkspaceTreeEntry } from "../../../shared/api";
import { ResponsiveDrawer } from "../../components/common/ResponsiveDrawer";
import { buildDocumentLink, copyToClipboard } from "../../openliaLinks";

export interface TreeNode {
  path: string;
  name: string;
  kind: WorkspaceTreeEntry["kind"];
  editable?: boolean | undefined;
  children: TreeNode[];
}

export function buildTree(entries: WorkspaceTreeEntry[]): TreeNode[] {
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
    parts.forEach((part: string, index: number) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let node = parent.children.find((child) => child.path === currentPath);
      if (!node) {
        const isLeaf = index === parts.length - 1;
        const createdNode: TreeNode = {
          children: [],
          kind: isLeaf ? entry.kind : "directory",
          name: part,
          path: currentPath,
        };
        if (isLeaf && entry.kind === "file") {
          createdNode.editable = entry.editable;
        }
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

export function countFiles(nodes: TreeNode[]): number {
  return nodes.reduce(
    (count, node) =>
      count + (node.kind === "file" ? 1 : countFiles(node.children)),
    0,
  );
}

export function nodeMatches(node: TreeNode, query: string): boolean {
  if (!query) return true;
  return (
    node.path.toLowerCase().includes(query) ||
    node.children.some((child) => nodeMatches(child, query))
  );
}

export function matchedFiles(nodes: TreeNode[], query: string): number {
  return nodes.reduce((count, node) => {
    if (node.kind === "file")
      return count + (node.path.toLowerCase().includes(query) ? 1 : 0);
    return count + matchedFiles(node.children, query);
  }, 0);
}

export function FileNavigator({
  entries,
  filter,
  loading,
  mobileOpen,
  onClose,
  onCreateFile,
  onFilterChange,
  onOpenFile,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onDeleteFolder,
  rawUrl,
  downloadUrl,
  onRetry,
  revealToken = 0,
  selectedPath,
  truncated,
  workspaceError,
  scope = "workspace",
  onScopeChange,
  workspaceFileCount,
  skillsFileCount,
}: {
  entries: WorkspaceTreeEntry[];
  filter: string;
  loading: boolean;
  mobileOpen: boolean;
  onClose: () => void;
  onCreateFile?: ((directory?: string) => void) | undefined;
  onFilterChange: (value: string) => void;
  onOpenFile: (path: string) => void;
  onRenameFile?: ((path: string) => void) | undefined;
  onMoveFile?: ((path: string) => void) | undefined;
  onDeleteFile?: ((path: string) => void) | undefined;
  onDeleteFolder?: ((path: string) => void) | undefined;
  rawUrl?: ((path: string) => string) | undefined;
  downloadUrl?: ((path: string) => string) | undefined;
  onRetry: () => void;
  revealToken?: number | undefined;
  selectedPath: string | undefined;
  truncated: boolean;
  workspaceError: string;
  scope?: DocumentScope | undefined;
  onScopeChange?: ((scope: DocumentScope) => void) | undefined;
  workspaceFileCount?: number | undefined;
  skillsFileCount?: number | undefined;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
  const nodes = useMemo(() => buildTree(entries), [entries]);
  const initializedTree = useRef(false);
  const lastScope = useRef(scope);
  const fileButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    if (lastScope.current !== scope) {
      lastScope.current = scope;
      initializedTree.current = false;
    }
    if (initializedTree.current || nodes.length === 0) return;
    initializedTree.current = true;
    setCollapsed(
      new Set(
        nodes
          .filter((node) => node.kind === "directory")
          .map((node) => node.path),
      ),
    );
  }, [nodes, scope]);

  useEffect(() => {
    if (!selectedPath) return;
    const parts = selectedPath.split("/");
    const ancestors = parts.map((_, index) =>
      parts.slice(0, index + 1).join("/"),
    );
    setCollapsed((current) => {
      const next = new Set(current);
      for (const ancestor of ancestors) next.delete(ancestor);
      return next;
    });
  }, [selectedPath]);

  useEffect(() => {
    if (!revealToken || !selectedPath) return;
    const parts = selectedPath.split("/");
    const ancestors = parts.map((_, index) =>
      parts.slice(0, index + 1).join("/"),
    );
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

  const query = filter.trim().toLowerCase();
  const totalFiles = countFiles(nodes);
  const visibleFiles = query ? matchedFiles(nodes, query) : totalFiles;
  const showWorkspaceSection = nodes.some((node) => nodeMatches(node, query));

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
          const directoryPaddingClass =
            onCreateFile && onDeleteFolder
              ? "pr-14"
              : onCreateFile || onDeleteFolder
                ? "pr-7"
                : "";
          return (
            <li key={node.path}>
              {isDirectory ? (
                <>
                  <div className="group relative flex items-center">
                    {hasChildren ? (
                      <button
                        aria-controls={directoryId}
                        aria-expanded={childrenVisible}
                        className={`workspace-tree-row workspace-tree-directory flex-1 ${directoryPaddingClass}`}
                        data-testid={`workspace-directory-${node.path}`}
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
                        className={`workspace-tree-row workspace-tree-directory workspace-tree-empty-directory flex-1 ${directoryPaddingClass}`}
                        data-testid={`workspace-directory-${node.path}`}
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
                    {onCreateFile && (
                      <button
                        aria-label={`Create file in ${node.name}`}
                        className={`btn btn-ghost btn-xs btn-square absolute ${onDeleteFolder ? "right-7" : "right-1"} z-10 h-5 w-5 text-base-content/60 hover:text-base-content opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCreateFile(node.path);
                          if (mobileOpen) onClose();
                        }}
                        title={`Create file in ${node.name}`}
                        type="button"
                      >
                        <svg
                          aria-hidden="true"
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          viewBox="0 0 24 24"
                        >
                          <path
                            d="M12 4.5v15m7.5-7.5h-15"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                    {onDeleteFolder && (
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
                            <title>Folder actions</title>
                            <circle cx="12" cy="5" r="2" />
                            <circle cx="12" cy="12" r="2" />
                            <circle cx="12" cy="19" r="2" />
                          </svg>
                        </button>
                        <ul className="dropdown-content menu z-30 rounded-box border border-base-content/10 bg-base-100 p-1 shadow-lg text-xs w-36">
                          {onCreateFile && (
                            <li>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  (
                                    document.activeElement as HTMLElement
                                  )?.blur();
                                  onCreateFile(node.path);
                                  if (mobileOpen) onClose();
                                }}
                                type="button"
                              >
                                New File...
                              </button>
                            </li>
                          )}
                          <li>
                            <button
                              className="text-error"
                              data-testid={`delete-folder-${node.path}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                (document.activeElement as HTMLElement)?.blur();
                                onDeleteFolder(node.path);
                                if (mobileOpen) onClose();
                              }}
                              type="button"
                            >
                              Delete Folder...
                            </button>
                          </li>
                        </ul>
                      </div>
                    )}
                  </div>
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
                    onClick={() => {
                      onOpenFile(node.path);
                      if (mobileOpen) onClose();
                    }}
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
                                if (mobileOpen) onClose();
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
                                if (mobileOpen) onClose();
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
                                buildDocumentLink(node.path, scope),
                              );
                            }}
                            type="button"
                          >
                            Copy Link
                          </button>
                        </li>
                        {onDeleteFile && (
                          <li>
                            <button
                              className="text-error"
                              onClick={(e) => {
                                e.stopPropagation();
                                (document.activeElement as HTMLElement)?.blur();
                                onDeleteFile(node.path);
                                if (mobileOpen) onClose();
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
    <ResponsiveDrawer
      title={scope === "skills" ? "Skills" : "Files"}
      label={scope === "skills" ? "Hermes skills" : "Workspace files"}
      open={mobileOpen}
      onClose={onClose}
      className="workspace-navigator"
    >
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {onScopeChange && (
          <div className="join mb-4 grid w-full grid-cols-2">
            <button
              className={`btn btn-xs join-item ${
                scope === "workspace" ? "btn-active btn-neutral" : "btn-ghost"
              }`}
              onClick={() => onScopeChange("workspace")}
              type="button"
            >
              Workspace
              {typeof workspaceFileCount === "number" && (
                <span className="badge badge-xs opacity-70 ml-1">
                  {workspaceFileCount}
                </span>
              )}
            </button>
            <button
              className={`btn btn-xs join-item ${
                scope === "skills" ? "btn-active btn-neutral" : "btn-ghost"
              }`}
              onClick={() => onScopeChange("skills")}
              type="button"
            >
              Skills
              {typeof skillsFileCount === "number" && (
                <span className="badge badge-xs opacity-70 ml-1">
                  {skillsFileCount}
                </span>
              )}
            </button>
          </div>
        )}
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              {scope === "skills" ? "Skills" : "Files"}
            </h2>
            <p aria-live="polite" className="mt-1 text-xs text-base-content/50">
              {query ? `${visibleFiles} matching files` : `${totalFiles} files`}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {query && (
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => onFilterChange("")}
                type="button"
              >
                Clear
              </button>
            )}
            {onCreateFile && (
              <button
                className="btn btn-ghost btn-xs text-primary font-medium"
                onClick={() => {
                  onCreateFile();
                  if (mobileOpen) onClose();
                }}
                title={
                  scope === "skills"
                    ? "Create new skill file"
                    : "Create new file"
                }
                type="button"
              >
                {scope === "skills" ? "+ New Skill" : "+ New File"}
              </button>
            )}
          </div>
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
          <p className="mt-5 text-sm text-base-content/50">Loading files...</p>
        ) : visibleFiles === 0 && !showWorkspaceSection ? (
          <div className="mt-5 rounded-lg border border-base-content/10 bg-base-200/40 p-4">
            <p className="text-sm font-semibold">
              {query ? `No files match “${filter}”` : "No documents yet"}
            </p>
            <p className="mt-1 text-xs text-base-content/60">
              {query
                ? "Try a different path or clear the search."
                : "Create or upload a file to get started."}
            </p>
          </div>
        ) : (
          <div className="mt-4">{renderNodes(nodes)}</div>
        )}
      </div>
    </ResponsiveDrawer>
  );
}
