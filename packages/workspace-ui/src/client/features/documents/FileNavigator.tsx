import type { ReactNode } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WorkspaceTreeEntry } from "../../../shared/api";
import {
  isMemoryDocument,
  MEMORY_DOCUMENT_PREFIX,
} from "../../../shared/memory";
import { buildWorkspaceLink, copyToClipboard } from "../../openliaLinks";

export interface TreeNode {
  path: string;
  name: string;
  kind: WorkspaceTreeEntry["kind"];
  editable?: boolean;
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
        const createdNode: TreeNode = {
          children: [],
          kind: index === parts.length - 1 ? entry.kind : "directory",
          name:
            currentPath === MEMORY_DOCUMENT_PREFIX.slice(0, -1)
              ? "Assistant memory"
              : part,
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
  const memoryRootPath = MEMORY_DOCUMENT_PREFIX.slice(0, -1);
  const memoryNode = nodes.find((node) => node.path === memoryRootPath);
  const workspaceNodes = nodes.filter((node) => node.path !== memoryRootPath);
  const showMemorySection = Boolean(
    memoryNode && nodeMatches(memoryNode, query),
  );
  const showWorkspaceSection = workspaceNodes.some((node) =>
    nodeMatches(node, query),
  );

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
                        {onRenameFile &&
                          node.editable &&
                          !isMemoryDocument(node.path) && (
                            <li>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  (
                                    document.activeElement as HTMLElement
                                  )?.blur();
                                  onRenameFile(node.path);
                                }}
                                type="button"
                              >
                                Rename...
                              </button>
                            </li>
                          )}
                        {onMoveFile &&
                          node.editable &&
                          !isMemoryDocument(node.path) && (
                            <li>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  (
                                    document.activeElement as HTMLElement
                                  )?.blur();
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
                        {onDeleteFile &&
                          node.editable &&
                          !isMemoryDocument(node.path) && (
                            <li>
                              <button
                                className="text-error"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  (
                                    document.activeElement as HTMLElement
                                  )?.blur();
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
            <div className="mt-4">
              {showMemorySection && memoryNode && (
                <section aria-labelledby="assistant-memory-heading">
                  <h3
                    className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-base-content/50"
                    id="assistant-memory-heading"
                  >
                    Assistant memory
                  </h3>
                  {renderNodes(memoryNode.children)}
                </section>
              )}
              {showMemorySection && showWorkspaceSection && (
                <div
                  aria-hidden="true"
                  className="my-4 border-t border-base-content/10"
                />
              )}
              {showWorkspaceSection && (
                <section aria-labelledby="workspace-files-heading">
                  {showMemorySection && (
                    <h3
                      className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-base-content/50"
                      id="workspace-files-heading"
                    >
                      Workspace files
                    </h3>
                  )}
                  {renderNodes(workspaceNodes)}
                </section>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
