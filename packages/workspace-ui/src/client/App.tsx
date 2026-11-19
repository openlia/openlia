import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthSessionResponse,
  DocumentScope,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceTreeEntry,
} from "../shared/api";
import { ApiError, type WorkspaceApi } from "./api";
import { isMarkdownPath } from "./CodeEditor";
import { CreateFileDialog } from "./CreateFileDialog";
import { DeleteFileDialog } from "./components/common/DeleteFileDialog";
import { DirtyDraftDialog } from "./components/common/DirtyDraftDialog";
import { useViewportHeight } from "./components/layout/useViewportHeight";
import { WorkspaceHeader } from "./components/layout/WorkspaceHeader";
import {
  DocumentPane,
  type WorkspaceView,
} from "./features/documents/DocumentPane";
import { FileNavigator } from "./features/documents/FileNavigator";
import { GoToModal } from "./GoToModal";
import { MoveFileDialog } from "./MoveFileDialog";
import { diffLines } from "./markdown";
import { resolveLinkTarget } from "./openliaLinks";
import { RenameFileDialog } from "./RenameFileDialog";

interface RouteState {
  path: string | undefined;
  view: WorkspaceView | undefined;
  scope: DocumentScope;
}

function parseRouteFromLocation(): RouteState {
  if (typeof window === "undefined") {
    return { path: undefined, scope: "workspace", view: undefined };
  }
  const { pathname, search } = window.location;
  const params = new URLSearchParams(search);
  const rawView = params.get("view");
  const view: WorkspaceView | undefined =
    rawView === "edit" || rawView === "preview" || rawView === "info"
      ? rawView
      : undefined;

  const rawScope = params.get("scope");
  const queryScope: DocumentScope =
    rawScope === "skills"
      ? "skills"
      : rawScope === "agent"
        ? "agent"
        : "workspace";

  if (pathname === "/skills" || pathname.startsWith("/skills/")) {
    const encoded = pathname.slice("/skills".length).replace(/^\/+/, "");
    try {
      const decoded = decodeURIComponent(encoded).replace(/^\/+/, "");
      return { path: decoded || undefined, scope: "skills", view };
    } catch {
      return {
        path: encoded.replace(/^\/+/, "") || undefined,
        scope: "skills",
        view,
      };
    }
  }

  if (pathname === "/agent" || pathname.startsWith("/agent/")) {
    const encoded = pathname.slice("/agent".length).replace(/^\/+/, "");
    try {
      const decoded = decodeURIComponent(encoded).replace(/^\/+/, "");
      return { path: decoded || undefined, scope: "agent", view };
    } catch {
      return {
        path: encoded.replace(/^\/+/, "") || undefined,
        scope: "agent",
        view,
      };
    }
  }

  if (pathname.startsWith("/files/")) {
    const encoded = pathname.slice("/files/".length);
    try {
      const decoded = decodeURIComponent(encoded).replace(/^\/+/, "");
      return { path: decoded || undefined, scope: "workspace", view };
    } catch {
      return {
        path: encoded.replace(/^\/+/, "") || undefined,
        scope: "workspace",
        view,
      };
    }
  }

  const queryPath = params.get("path")?.trim().replace(/^\/+/, "");
  return { path: queryPath || undefined, scope: queryScope, view };
}

function pushRouteToHistory(
  path: string | undefined,
  view?: WorkspaceView | undefined,
  replace = false,
  scope: DocumentScope = "workspace",
) {
  if (typeof window === "undefined") return;
  const cleanPath = path?.replace(/^\/+/, "");
  const prefix =
    scope === "skills" ? "/skills/" : scope === "agent" ? "/agent/" : "/files/";
  const nextPathname = cleanPath
    ? `${prefix}${cleanPath}`
    : scope === "skills"
      ? "/skills/"
      : scope === "agent"
        ? "/agent/"
        : "/";
  const params = new URLSearchParams(window.location.search);
  params.delete("path");
  params.delete("scope");
  if (view && view !== "preview") {
    params.set("view", view);
  } else {
    params.delete("view");
  }
  const query = params.toString();
  const nextUrl = query ? `${nextPathname}?${query}` : nextPathname;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl === currentUrl) return;
  if (replace) {
    window.history.replaceState(null, "", nextUrl);
  } else {
    window.history.pushState(null, "", nextUrl);
  }
}

export function App({ api }: { api: WorkspaceApi }) {
  const viewportRef = useViewportHeight();
  const initialRoute = useMemo(() => parseRouteFromLocation(), []);

  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [authError, setAuthError] = useState("");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [activeScope, setActiveScope] = useState<DocumentScope>(
    initialRoute.scope,
  );
  const [workspaceEntries, setWorkspaceEntries] = useState<
    WorkspaceTreeEntry[]
  >([]);
  const [skillsEntries, setSkillsEntries] = useState<WorkspaceTreeEntry[]>([]);
  const [agentEntries, setAgentEntries] = useState<WorkspaceTreeEntry[]>([]);
  const [workspaceTruncated, setWorkspaceTruncated] = useState(false);
  const [skillsTruncated, setSkillsTruncated] = useState(false);
  const [agentTruncated, setAgentTruncated] = useState(false);
  const [treeLoading, setTreeLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState("");
  const [filter, setFilter] = useState("");

  const entries =
    activeScope === "skills"
      ? skillsEntries
      : activeScope === "agent"
        ? agentEntries
        : workspaceEntries;
  const truncated =
    activeScope === "skills"
      ? skillsTruncated
      : activeScope === "agent"
        ? agentTruncated
        : workspaceTruncated;

  const [selectedPath, setSelectedPath] = useState<string | undefined>(
    initialRoute.path,
  );
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [artifact, setArtifact] = useState<WorkspaceFileMetadata | null>(null);
  const [draft, setDraft] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [documentError, setDocumentError] = useState("");
  const [conflict, setConflict] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<WorkspaceView>(
    initialRoute.view ?? "preview",
  );
  const [filesOpen, setFilesOpen] = useState(true);
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
  const [revealToken, setRevealToken] = useState(0);

  const [goToOpen, setGoToOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createInitialDir, setCreateInitialDir] = useState("");
  const [creatingFile, setCreatingFile] = useState(false);
  const [createError, setCreateError] = useState("");

  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renamingFile, setRenamingFile] = useState(false);
  const [renameError, setRenameError] = useState("");

  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [movingFile, setMovingFile] = useState(false);
  const [moveError, setMoveError] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<string | null>(
    null,
  );
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    label: string;
    run: () => void;
  } | null>(null);

  const activeScopeRef = useRef<DocumentScope>(activeScope);
  activeScopeRef.current = activeScope;
  const workspaceEntriesRef = useRef<WorkspaceTreeEntry[]>([]);
  workspaceEntriesRef.current = workspaceEntries;
  const skillsEntriesRef = useRef<WorkspaceTreeEntry[]>([]);
  skillsEntriesRef.current = skillsEntries;
  const agentEntriesRef = useRef<WorkspaceTreeEntry[]>([]);
  agentEntriesRef.current = agentEntries;
  const entriesRef = useRef<WorkspaceTreeEntry[]>([]);
  entriesRef.current = entries;

  const dirty = file !== null && file.content !== draft;
  const diff = useMemo(
    () => (file ? diffLines(file.content, draft) : []),
    [file, draft],
  );

  const directories = useMemo(() => {
    const dirs = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "directory") {
        dirs.add(entry.path);
      } else if (entry.path.includes("/")) {
        const parts = entry.path.split("/");
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join("/"));
        }
      }
    }
    return Array.from(dirs).sort();
  }, [entries]);

  const existingPaths = useMemo(
    () => new Set(entries.map((entry) => entry.path)),
    [entries],
  );

  const loadWorkspaceTree = useCallback(async () => {
    setTreeLoading(true);
    setWorkspaceError("");
    try {
      const [wsRes, skRes, agRes] = await Promise.allSettled([
        api.loadTree(),
        api.loadTree("skills"),
        api.loadTree("agent"),
      ]);

      let wsEntries: WorkspaceTreeEntry[] = [];
      if (wsRes.status === "fulfilled") {
        wsEntries = wsRes.value.entries;
        setWorkspaceEntries(wsEntries);
        setWorkspaceTruncated(wsRes.value.truncated);
      } else if (
        wsRes.reason instanceof ApiError &&
        wsRes.reason.status === 401
      ) {
        setSession((prev) =>
          prev
            ? { ...prev, authenticated: false }
            : {
                auth_provider: "password",
                auth_required: true,
                authenticated: false,
                schema: 1,
              },
        );
        return [];
      } else {
        setWorkspaceError(
          wsRes.reason instanceof Error
            ? wsRes.reason.message
            : "workspace_unavailable",
        );
      }

      if (skRes.status === "fulfilled") {
        setSkillsEntries(skRes.value.entries);
        setSkillsTruncated(skRes.value.truncated);
      } else {
        setSkillsEntries([]);
        setSkillsTruncated(false);
      }

      if (agRes.status === "fulfilled") {
        setAgentEntries(agRes.value.entries);
        setAgentTruncated(agRes.value.truncated);
      } else {
        setAgentEntries([]);
        setAgentTruncated(false);
      }

      return activeScopeRef.current === "skills" && skRes.status === "fulfilled"
        ? skRes.value.entries
        : activeScopeRef.current === "agent" && agRes.status === "fulfilled"
          ? agRes.value.entries
          : wsEntries;
    } finally {
      setTreeLoading(false);
    }
  }, [api]);

  const openPath = useCallback(
    async (
      path: string,
      options?: {
        preferredView?: WorkspaceView | undefined;
        replaceUrl?: boolean | undefined;
        knownEntries?: WorkspaceTreeEntry[] | undefined;
        scope?: DocumentScope | undefined;
      },
    ) => {
      const currentScope = activeScopeRef.current;
      const targetScope = options?.scope ?? currentScope;
      const cleanPath = path.replace(/^\/+/, "");
      if (!cleanPath) return;

      if (targetScope !== currentScope) {
        setActiveScope(targetScope);
      }
      setSelectedPath(cleanPath);
      setFileLoading(true);
      setDocumentError("");
      setConflict("");

      const treeList =
        options?.knownEntries ??
        (targetScope === "skills"
          ? skillsEntriesRef.current
          : targetScope === "agent"
            ? agentEntriesRef.current
            : workspaceEntriesRef.current);
      const entry = treeList.find((item) => item.path === cleanPath);
      const isBinaryEntry = entry?.kind === "file" && entry.editable === false;

      try {
        if (isBinaryEntry) {
          const meta =
            targetScope === "workspace"
              ? await api.loadFileMetadata(cleanPath)
              : await api.loadFileMetadata(cleanPath, targetScope);
          setFile(null);
          setArtifact(meta);
          setDraft("");
          pushRouteToHistory(
            cleanPath,
            undefined,
            options?.replaceUrl,
            targetScope,
          );
          return;
        }

        try {
          const loaded =
            targetScope === "workspace"
              ? await api.loadFile(cleanPath)
              : await api.loadFile(cleanPath, targetScope);
          setArtifact(null);
          setFile(loaded);
          setDraft(loaded.content);
          const nextView: WorkspaceView =
            options?.preferredView ??
            (isMarkdownPath(loaded.path) ? "preview" : "edit");
          setView(nextView);
          pushRouteToHistory(
            cleanPath,
            nextView,
            options?.replaceUrl,
            targetScope,
          );
        } catch (innerError) {
          if (
            innerError instanceof ApiError &&
            innerError.payload?.error === "binary_file"
          ) {
            const meta =
              targetScope === "workspace"
                ? await api.loadFileMetadata(cleanPath)
                : await api.loadFileMetadata(cleanPath, targetScope);
            setFile(null);
            setArtifact(meta);
            setDraft("");
            pushRouteToHistory(
              cleanPath,
              undefined,
              options?.replaceUrl,
              targetScope,
            );
            return;
          }
          throw innerError;
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setSession((prev) =>
            prev
              ? { ...prev, authenticated: false }
              : {
                  auth_provider: "password",
                  auth_required: true,
                  authenticated: false,
                  schema: 1,
                },
          );
          return;
        }
        setFile(null);
        setArtifact(null);
        setDocumentError(
          error instanceof Error ? error.message : "Failed to load file",
        );
      } finally {
        setFileLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    let active = true;
    void api
      .loadSession()
      .then(async (loadedSession) => {
        if (!active) return;
        setSession(loadedSession);
        if (loadedSession.authenticated) {
          const loadedEntries = await loadWorkspaceTree();
          if (!active) return;
          const route = parseRouteFromLocation();
          if (route.path) {
            await openPath(route.path, {
              knownEntries: loadedEntries,
              preferredView: route.view,
              replaceUrl: true,
            });
          }
        }
      })
      .catch(() => {
        if (!active) return;
        setSession({
          auth_provider: "password",
          auth_required: true,
          authenticated: false,
          schema: 1,
        });
      });
    return () => {
      active = false;
    };
  }, [api, loadWorkspaceTree, openPath]);

  useEffect(() => {
    const handlePopState = () => {
      const route = parseRouteFromLocation();
      if (route.path) {
        void openPath(route.path, {
          preferredView: route.view,
          replaceUrl: true,
          scope: route.scope,
        });
      } else {
        setActiveScope(route.scope);
        setSelectedPath(undefined);
        setFile(null);
        setArtifact(null);
        setDraft("");
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [openPath]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!file?.editable || !dirty || saving) return false;
    setSaving(true);
    setConflict("");
    setDocumentError("");
    try {
      const written = await api.saveFile(
        file.path,
        draft,
        file.revision,
        activeScope,
      );
      setFile({
        ...file,
        content: draft,
        modified_at: written.modified_at,
        revision: written.revision,
      });
      return true;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.payload?.error === "revision_conflict"
      ) {
        setConflict(
          "Another process modified this file on disk. Copy your changes and reload before saving.",
        );
      } else {
        setDocumentError(
          error instanceof Error ? error.message : "Failed to save file",
        );
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, [activeScope, api, dirty, draft, file, saving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setGoToOpen((prev) => !prev);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setGoToOpen((prev) => !prev);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (file?.editable && dirty) {
          event.preventDefault();
          void handleSave();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, file, handleSave]);

  const guardDirtyNavigation = useCallback(
    (label: string, action: () => void) => {
      if (dirty) {
        setPendingAction({ label, run: action });
        return;
      }
      action();
    },
    [dirty],
  );

  const handleScopeChange = useCallback(
    (newScope: DocumentScope) => {
      if (newScope === activeScope) return;
      guardDirtyNavigation(`switching to ${newScope}`, () => {
        setActiveScope(newScope);
        setSelectedPath(undefined);
        setFile(null);
        setArtifact(null);
        setDraft("");
        pushRouteToHistory(undefined, undefined, false, newScope);
      });
    },
    [activeScope, guardDirtyNavigation],
  );

  async function handleLoginSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!loginPassword || loggingIn) return;
    setLoggingIn(true);
    setAuthError("");
    try {
      await api.login(loginPassword, loginUsername.trim() || undefined);
      setLoginPassword("");
      const nextSession = await api.loadSession();
      setSession(nextSession);
      if (nextSession.authenticated) {
        const loadedEntries = await loadWorkspaceTree();
        const route = parseRouteFromLocation();
        if (route.path) {
          await openPath(route.path, {
            knownEntries: loadedEntries,
            preferredView: route.view,
            replaceUrl: true,
            scope: route.scope,
          });
        }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        setAuthError(
          error.payload?.error === "rate_limited"
            ? "Too many login attempts. Please wait and try again."
            : "Invalid credentials.",
        );
      } else {
        setAuthError("Sign-in failed.");
      }
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    await api.logout().catch(() => null);
    setSession((prev) =>
      prev
        ? { ...prev, authenticated: false }
        : {
            auth_provider: "password",
            auth_required: true,
            authenticated: false,
            schema: 1,
          },
    );
    setFile(null);
    setArtifact(null);
    setDraft("");
  }

  async function handleCreateFile(targetPath: string, content = "") {
    setCreatingFile(true);
    setCreateError("");
    try {
      await api.createFile(
        { content, path: targetPath, scope: activeScope },
        activeScope,
      );
      setCreateDialogOpen(false);
      const updatedEntries = await loadWorkspaceTree();
      await openPath(targetPath, {
        knownEntries: updatedEntries,
        preferredView: "edit",
        scope: activeScope,
      });
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Failed to create file",
      );
    } finally {
      setCreatingFile(false);
    }
  }

  async function handleUploadFile(destinationPath: string, uploadFile: File) {
    setCreatingFile(true);
    setCreateError("");
    try {
      const uploaded = await api.uploadFile(
        destinationPath,
        uploadFile,
        activeScope,
      );
      setCreateDialogOpen(false);
      const updatedEntries = await loadWorkspaceTree();
      await openPath(uploaded.path, {
        knownEntries: updatedEntries,
        scope: activeScope,
      });
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Failed to upload file",
      );
    } finally {
      setCreatingFile(false);
    }
  }

  async function handleRenameConfirm(newName: string) {
    if (!renameTarget) return;
    if (
      activeScope === "agent" &&
      (renameTarget === "SOUL.md" ||
        renameTarget === "AGENTS.md" ||
        renameTarget === "memories")
    ) {
      setRenameTarget(null);
      setRenameError("Protected files cannot be renamed");
      return;
    }
    setRenamingFile(true);
    setRenameError("");
    try {
      const result = await api.renameFile(renameTarget, newName, activeScope);
      setRenameTarget(null);
      const updatedEntries = await loadWorkspaceTree();
      if (selectedPath === renameTarget) {
        await openPath(result.new_path, {
          knownEntries: updatedEntries,
          preferredView: view,
          scope: activeScope,
        });
      }
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : "Failed to rename file",
      );
    } finally {
      setRenamingFile(false);
    }
  }

  async function handleMoveConfirm(destinationDir: string) {
    if (!moveTarget) return;
    if (
      activeScope === "agent" &&
      (moveTarget === "SOUL.md" ||
        moveTarget === "AGENTS.md" ||
        moveTarget === "memories")
    ) {
      setMoveTarget(null);
      setMoveError("Protected files cannot be moved");
      return;
    }
    setMovingFile(true);
    setMoveError("");
    try {
      const result = await api.moveFile(
        moveTarget,
        destinationDir,
        activeScope,
      );
      setMoveTarget(null);
      const updatedEntries = await loadWorkspaceTree();
      if (selectedPath === moveTarget) {
        await openPath(result.new_path, {
          knownEntries: updatedEntries,
          preferredView: view,
          scope: activeScope,
        });
      }
    } catch (error) {
      setMoveError(
        error instanceof Error ? error.message : "Failed to move file",
      );
    } finally {
      setMovingFile(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    if (
      (file?.path === deleteTarget && file.protected) ||
      (activeScope === "agent" &&
        (deleteTarget === "SOUL.md" ||
          deleteTarget === "AGENTS.md" ||
          deleteTarget === "memories"))
    ) {
      setDeleteTarget(null);
      setDocumentError("Protected files cannot be deleted");
      return;
    }
    setDeleting(true);
    try {
      const revision =
        file?.path === deleteTarget
          ? file.revision
          : artifact?.path === deleteTarget
            ? artifact.revision
            : (await api.loadFileMetadata(deleteTarget, activeScope)).revision;
      await api.deleteFile(deleteTarget, revision, activeScope);
      const deletedPath = deleteTarget;
      setDeleteTarget(null);
      await loadWorkspaceTree();
      if (selectedPath === deletedPath) {
        setSelectedPath(undefined);
        setFile(null);
        setArtifact(null);
        setDraft("");
        pushRouteToHistory(undefined, undefined, false, activeScope);
      }
    } catch (error) {
      setDocumentError(
        error instanceof Error ? error.message : "Failed to delete file",
      );
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeleteFolderConfirm() {
    if (!deleteFolderTarget) return;
    if (activeScope === "agent" && deleteFolderTarget === "memories") {
      setDeleteFolderTarget(null);
      setWorkspaceError("Protected folders cannot be deleted");
      return;
    }
    setDeletingFolder(true);
    try {
      await api.deleteDirectory(deleteFolderTarget, activeScope);
      const deletedFolder = deleteFolderTarget;
      setDeleteFolderTarget(null);
      await loadWorkspaceTree();
      if (
        selectedPath &&
        (selectedPath === deletedFolder ||
          selectedPath.startsWith(`${deletedFolder}/`))
      ) {
        setSelectedPath(undefined);
        setFile(null);
        setArtifact(null);
        setDraft("");
        pushRouteToHistory(undefined, undefined, false, activeScope);
      }
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Failed to delete folder",
      );
      setDeleteFolderTarget(null);
    } finally {
      setDeletingFolder(false);
    }
  }

  function handleNavigateLink(href: string) {
    const resolved = resolveLinkTarget(href, {
      currentFilePath: file?.path ?? artifact?.path,
      currentScope: activeScope,
      skillsTree: skillsEntries,
      tree: workspaceEntries,
    });
    if (resolved?.kind === "workspace" || resolved?.kind === "skills") {
      guardDirtyNavigation("opening another document", () => {
        void openPath(resolved.path, {
          scope:
            resolved.scope ??
            (resolved.kind === "skills" ? "skills" : "workspace"),
        });
      });
    }
  }

  function handleDownload(path: string) {
    const url = api.downloadUrl(path, activeScope);
    const link = document.createElement("a");
    link.href = url;
    link.download = path.split("/").at(-1) ?? "download";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  if (!session) {
    return (
      <main
        className="workspace-app grid place-items-center p-6"
        ref={viewportRef}
      >
        <p className="text-sm text-base-content/60">Loading workspace...</p>
      </main>
    );
  }

  if (!session.authenticated) {
    const returnTo =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : "/";
    const oidcLoginHref = `/auth/oidc/login?${new URLSearchParams({ return_to: returnTo })}`;

    return (
      <main
        className="workspace-app grid place-items-center p-6"
        ref={viewportRef}
      >
        <section
          aria-labelledby="auth-heading"
          className="card w-full max-w-md border border-base-content/15 bg-base-100 shadow-2xl"
        >
          <div className="card-body">
            <p className="workspace-eyebrow">OPENLIA / WORKSPACE</p>
            <h1 className="card-title text-xl" id="auth-heading">
              Sign in to Workspace
            </h1>
            {session.auth_provider === "oidc" ? (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-base-content/70">
                  Single sign-on is enabled for this workspace.
                </p>
                <a className="btn btn-primary w-full" href={oidcLoginHref}>
                  Sign in with SSO
                </a>
              </div>
            ) : (
              <form className="mt-3 space-y-4" onSubmit={handleLoginSubmit}>
                <div>
                  <label
                    className="label text-xs font-semibold"
                    htmlFor="workspace-username"
                  >
                    {session.username_required
                      ? "Username"
                      : "Username (optional)"}
                  </label>
                  <input
                    autoComplete="username"
                    className="input input-bordered w-full"
                    disabled={loggingIn}
                    id="workspace-username"
                    onChange={(e) => setLoginUsername(e.target.value)}
                    placeholder="admin"
                    required={Boolean(session.username_required)}
                    type="text"
                    value={loginUsername}
                  />
                </div>
                <div>
                  <label
                    className="label text-xs font-semibold"
                    htmlFor="workspace-password"
                  >
                    Password
                  </label>
                  <input
                    autoComplete="current-password"
                    className="input input-bordered w-full"
                    disabled={loggingIn}
                    id="workspace-password"
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                    type="password"
                    value={loginPassword}
                  />
                </div>
                {authError && (
                  <div className="alert alert-error py-2 text-xs" role="alert">
                    <span>{authError}</span>
                  </div>
                )}
                <button
                  className="btn btn-primary w-full"
                  disabled={
                    loggingIn ||
                    !loginPassword ||
                    (Boolean(session.username_required) &&
                      !loginUsername.trim())
                  }
                  type="submit"
                >
                  {loggingIn ? "Signing in..." : "Sign in"}
                </button>
              </form>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="workspace-app" ref={viewportRef}>
      <WorkspaceHeader
        agentCount={agentEntries.filter((e) => e.kind === "file").length}
        file={file ?? artifact}
        filesOpen={filesOpen}
        onOpenGoTo={() => setGoToOpen(true)}
        onScopeChange={handleScopeChange}
        onSignOut={
          session.auth_required ? () => void handleLogout() : undefined
        }
        onToggleFiles={() => {
          if (
            typeof window !== "undefined" &&
            window.matchMedia("(max-width: 1279px)").matches
          ) {
            setMobileFilesOpen((prev) => !prev);
          } else {
            setFilesOpen((prev) => !prev);
          }
        }}
        scope={activeScope}
        skillsCount={skillsEntries.filter((e) => e.kind === "file").length}
        workspaceCount={
          workspaceEntries.filter((e) => e.kind === "file").length
        }
      />

      <main className={`workspace-layout ${filesOpen ? "has-sidebar" : ""}`}>
        {filesOpen && (
          <FileNavigator
            downloadUrl={(p) => api.downloadUrl(p, activeScope)}
            entries={entries}
            filter={filter}
            loading={treeLoading}
            mobileOpen={mobileFilesOpen}
            onClose={() => setMobileFilesOpen(false)}
            onCreateFile={(dir) => {
              setCreateInitialDir(dir ?? "");
              setCreateError("");
              setCreateDialogOpen(true);
            }}
            onDeleteFile={(path) => setDeleteTarget(path)}
            onDeleteFolder={(path) => setDeleteFolderTarget(path)}
            onFilterChange={setFilter}
            onMoveFile={(path) => {
              setMoveError("");
              setMoveTarget(path);
            }}
            onOpenFile={(path) => {
              guardDirtyNavigation("switching files", () => {
                setMobileFilesOpen(false);
                void openPath(path, { scope: activeScope });
              });
            }}
            onRenameFile={(path) => {
              setRenameError("");
              setRenameTarget(path);
            }}
            onRetry={() => void loadWorkspaceTree()}
            onScopeChange={handleScopeChange}
            rawUrl={(p) => api.rawUrl(p, activeScope)}
            revealToken={revealToken}
            scope={activeScope}
            selectedPath={selectedPath}
            agentFileCount={
              agentEntries.filter((e) => e.kind === "file").length
            }
            skillsFileCount={
              skillsEntries.filter((e) => e.kind === "file").length
            }
            truncated={truncated}
            workspaceError={workspaceError}
            workspaceFileCount={
              workspaceEntries.filter((e) => e.kind === "file").length
            }
          />
        )}

        <DocumentPane
          artifact={artifact}
          conflict={conflict}
          deleting={deleting}
          detailsOpen={view === "info"}
          diff={diff}
          documentError={documentError}
          downloadUrl={(p) => api.downloadUrl(p, activeScope)}
          draft={draft}
          file={file}
          fileLoading={fileLoading}
          onCreateFile={() => {
            setCreateInitialDir("");
            setCreateError("");
            setCreateDialogOpen(true);
          }}
          onDelete={() => {
            const target = file?.path ?? artifact?.path;
            if (target) setDeleteTarget(target);
          }}
          onDownload={() => {
            const target = file?.path ?? artifact?.path;
            if (target) handleDownload(target);
          }}
          onDraftChange={setDraft}
          onMove={
            file?.editable
              ? () => {
                  setMoveError("");
                  setMoveTarget(file.path);
                }
              : undefined
          }
          onNavigateLink={handleNavigateLink}
          onOpenDetails={() => {
            const nextView: WorkspaceView =
              view === "info"
                ? file && isMarkdownPath(file.path)
                  ? "preview"
                  : "edit"
                : "info";
            setView(nextView);
            pushRouteToHistory(file?.path, nextView, true, activeScope);
          }}
          onRename={
            file?.editable
              ? () => {
                  setRenameError("");
                  setRenameTarget(file.path);
                }
              : undefined
          }
          onRetry={() => {
            if (selectedPath) void openPath(selectedPath);
          }}
          onRevealInTree={() => {
            setFilesOpen(true);
            setMobileFilesOpen(true);
            setRevealToken((prev) => prev + 1);
          }}
          onSave={() => void handleSave()}
          onViewChange={(nextView) => {
            setView(nextView);
            pushRouteToHistory(file?.path, nextView, true, activeScope);
          }}
          rawUrl={(p, scope) => api.rawUrl(p, scope ?? activeScope)}
          saving={saving}
          scope={activeScope}
          view={view}
        />
      </main>

      <GoToModal
        isOpen={goToOpen}
        onClose={() => setGoToOpen(false)}
        onNavigateWorkspace={(path, targetScope) => {
          guardDirtyNavigation("opening another document", () => {
            void openPath(path, { scope: targetScope ?? activeScope });
          });
        }}
        agentTree={agentEntries}
        scope={activeScope}
        skillsTree={skillsEntries}
        tree={workspaceEntries}
      />

      <CreateFileDialog
        directories={directories}
        error={createError}
        existingPaths={existingPaths}
        initialDirectory={createInitialDir}
        isCreating={creatingFile}
        isOpen={createDialogOpen}
        onCancel={() => setCreateDialogOpen(false)}
        onCreate={(path, content) => void handleCreateFile(path, content)}
        onUpload={(destinationPath, uploadedFile) =>
          void handleUploadFile(destinationPath, uploadedFile)
        }
        scope={activeScope}
      />

      {renameTarget && (
        <RenameFileDialog
          error={renameError}
          filePath={renameTarget}
          onCancel={() => setRenameTarget(null)}
          onRename={(newName) => void handleRenameConfirm(newName)}
          renaming={renamingFile}
        />
      )}

      {moveTarget && (
        <MoveFileDialog
          directories={directories}
          error={moveError}
          filePath={moveTarget}
          moving={movingFile}
          onCancel={() => setMoveTarget(null)}
          onMove={(destinationPath) => void handleMoveConfirm(destinationPath)}
        />
      )}

      {deleteTarget && (
        <DeleteFileDialog
          deleting={deleting}
          dirty={dirty && file?.path === deleteTarget}
          filePath={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void handleDeleteConfirm()}
        />
      )}

      {deleteFolderTarget && (
        <DeleteFileDialog
          deleting={deletingFolder}
          dirty={
            dirty &&
            Boolean(
              file?.path &&
                (file.path === deleteFolderTarget ||
                  file.path.startsWith(`${deleteFolderTarget}/`)),
            )
          }
          filePath={deleteFolderTarget}
          itemType="folder"
          onCancel={() => setDeleteFolderTarget(null)}
          onConfirm={() => void handleDeleteFolderConfirm()}
        />
      )}

      {pendingAction && (
        <DirtyDraftDialog
          actionLabel={pendingAction.label}
          onCancel={() => setPendingAction(null)}
          onDiscard={() => {
            const action = pendingAction.run;
            setPendingAction(null);
            if (file) setDraft(file.content);
            action();
          }}
          onSave={async () => {
            const ok = await handleSave();
            if (ok) {
              const action = pendingAction.run;
              setPendingAction(null);
              action();
            }
          }}
          saving={saving}
        />
      )}
    </div>
  );
}
