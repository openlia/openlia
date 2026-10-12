import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  SkillDetail,
  SkillFileEntry,
  SkillFileResponse,
  SkillSummary,
  IngestionDetailResponse,
  IngestionOverviewResponse,
  MigrationDetailResponse,
  MigrationSummary,
  WorkspaceActivityResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceGitStatus,
  WorkspaceSettings,
  WorkspaceSystemInfo,
  WorkspaceTreeEntry,
  FirebaseClientConfig,
} from "../shared/api";
import { ApiError, httpWorkspaceApi, type WorkspaceApi } from "./api";
import { signInWithGoogle, signOutFirebase } from "./firebase";
import { isJournalPath, isMarkdownPath, isRemindPath } from "./CodeEditor";
import { CreateSkillModal } from "./CreateSkillModal";
import { ConfigurationPage } from "./ConfigurationPage";
import { isMemoryDocument } from "../shared/memory";
import {
  DeleteFileDialog,
  DirtyDraftDialog,
  DocumentInspector,
  DocumentPane,
  FileNavigator,
  GitActivitySection,
  IngestionSection,
  MoveFileDialog,
  RenameFileDialog,
  WorkspaceHeader,
  type WorkspaceView,
} from "./components";
import { MigrationSection } from "./migration/MigrationSection";
import { GoToModal } from "./GoToModal";
import { diffLines } from "./markdown";
import {
  buildCanonicalWorkspaceUri,
  buildSkillLink,
  resolveLinkTarget,
} from "./openliaLinks";
import { type MainTab, navigateRoute, parseRoute } from "./route";
import { SkillDetailPane, type SkillSubTab } from "./SkillDetailPane";
import { SkillsNavigator } from "./SkillsNavigator";
import "./styles.css";

type PendingAction =
  | { kind: "open"; path: string; view?: WorkspaceView | undefined }
  | { kind: "openSkill"; id: string; skillFile?: string | undefined }
  | {
      kind: "switchTab";
      tab: MainTab;
      ingestionId?: string | undefined;
      migrationId?: string | undefined;
    }
  | { kind: "signout" }
  | null;

function defaultView(path?: string): WorkspaceView {
  return path &&
    !isMarkdownPath(path) &&
    !isJournalPath(path) &&
    !isRemindPath(path)
    ? "edit"
    : "preview";
}

function viewForPath(
  path: string | undefined,
  requested: WorkspaceView | undefined,
): WorkspaceView {
  if (requested === "info") return "info";
  if (
    path &&
    !isMarkdownPath(path) &&
    !isJournalPath(path) &&
    !isRemindPath(path)
  )
    return "edit";
  return requested ?? defaultView(path);
}

function isArtifactError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ["binary_file", "file_too_large", "invalid_utf8"].includes(
      error.payload?.error ?? "",
    )
  );
}

const artifactExtensions = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".doc",
  ".docx",
  ".flac",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".oga",
  ".ogg",
  ".ogv",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".svg",
  ".iso",
  ".tar",
  ".gz",
  ".tif",
  ".tiff",
  ".wav",
  ".webm",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);

function isKnownArtifactPath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return artifactExtensions.has(extension);
}

function areTreesEqual(
  a: WorkspaceTreeEntry[],
  b: WorkspaceTreeEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i];
    const itemB = b[i];
    if (!itemA || !itemB) return false;
    if (itemA.path !== itemB.path || itemA.kind !== itemB.kind) return false;
    if (itemA.kind === "file" && itemB.kind === "file") {
      if (
        itemA.size !== itemB.size ||
        itemA.missing !== itemB.missing ||
        itemA.modified_at !== itemB.modified_at ||
        itemA.editable !== itemB.editable
      ) {
        return false;
      }
    }
  }
  return true;
}

function areGitEqual(
  a: WorkspaceGitStatus | null,
  b: WorkspaceGitStatus | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.configured === b.configured &&
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.status === b.status
  );
}

function areSettingsEqual(a: WorkspaceSettings, b: WorkspaceSettings): boolean {
  return (
    a.enable_memory_editing === b.enable_memory_editing &&
    a.hide_configuration_files === b.hide_configuration_files &&
    a.hide_template_schema_files === b.hide_template_schema_files
  );
}

function ErrorMessage({
  error,
  onRetry,
}: {
  error: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="alert alert-error mb-4 flex-wrap justify-between rounded-lg"
      role="alert"
    >
      <span>{error}</span>
      {onRetry && (
        <button
          className="btn btn-error btn-sm"
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      )}
    </div>
  );
}

function LoginScreen({
  authProvider,
  error,
  onGoogleSignIn,
  onSubmit,
  password,
  setPassword,
  submitting,
}: {
  authProvider?: "password" | "firebase" | "none" | undefined;
  error: string;
  onGoogleSignIn?: (() => void) | undefined;
  onSubmit: () => void;
  password: string;
  setPassword: (value: string) => void;
  submitting: boolean;
}) {
  const passwordId = useId();
  const insecure =
    typeof window !== "undefined" && window.location.protocol !== "https:";

  return (
    <main className="grid min-h-dvh place-items-center bg-base-300 p-4 text-base-content sm:p-8">
      <section className="card w-full max-w-md border border-base-content/10 bg-base-100 shadow-2xl">
        <div className="card-body p-6 sm:p-8">
          <p className="workspace-eyebrow">OPENLIA / WORKSPACE</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Sign in to your workspace
          </h1>
          <p className="mt-2 text-sm text-base-content/60">
            {authProvider === "firebase"
              ? "Authentication via Firebase Google Sign-In is required. Only the authorized account can access this workspace."
              : "Enter the workspace password to continue."}
          </p>
          {insecure && (
            <div className="alert alert-warning mt-5 text-sm">
              This connection is not encrypted. Use a trusted private network or
              an HTTPS reverse proxy.
            </div>
          )}

          {authProvider === "firebase" ? (
            <div className="mt-6 flex flex-col gap-4">
              <button
                className="btn btn-primary flex w-full items-center justify-center gap-2"
                disabled={submitting}
                onClick={onGoogleSignIn}
                type="button"
              >
                {submitting ? (
                  <>
                    <span className="loading loading-spinner loading-xs" />
                    Signing in...
                  </>
                ) : (
                  <>
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        fill="#4285F4"
                      />
                      <path
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        fill="#34A853"
                      />
                      <path
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                        fill="#FBBC05"
                      />
                      <path
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                        fill="#EA4335"
                      />
                    </svg>
                    Sign in with Google
                  </>
                )}
              </button>
            </div>
          ) : (
            <form
              className="mt-6 grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              <label className="text-sm font-semibold" htmlFor={passwordId}>
                Password
              </label>
              <input
                autoComplete="current-password"
                className="input input-bordered w-full bg-base-200"
                disabled={submitting}
                id={passwordId}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
              <button
                className="btn btn-primary mt-3 w-full"
                disabled={submitting || !password}
                type="submit"
              >
                {submitting ? "Signing in..." : "Sign in"}
              </button>
            </form>
          )}

          {error && <ErrorMessage error={error} />}
        </div>
      </section>
    </main>
  );
}

export function App({ api = httpWorkspaceApi }: { api?: WorkspaceApi } = {}) {
  const initialRoute = useRef(
    typeof window !== "undefined"
      ? parseRoute(window.location)
      : {
          filter: undefined,
          path: undefined,
          scenario: undefined,
          skill: undefined,
          skillFile: undefined,
          tab: undefined,
          ingestionId: undefined,
          migrationId: undefined,
          view: undefined,
        },
  );

  const [activeTab, setActiveTab] = useState<MainTab>(
    () =>
      initialRoute.current.tab ??
      (initialRoute.current.skill ? "skills" : "documents"),
  );

  // Documents state
  const [tree, setTree] = useState<WorkspaceTreeEntry[]>([]);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [filter, setFilter] = useState(() => initialRoute.current.filter ?? "");
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [artifact, setArtifact] = useState<WorkspaceFileMetadata | null>(null);
  const [draft, setDraft] = useState("");
  const [git, setGit] = useState<WorkspaceGitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [documentError, setDocumentError] = useState("");
  const [conflict, setConflict] = useState("");
  const [activity, setActivity] = useState<WorkspaceActivityResponse | null>(
    null,
  );
  const [activityLoading, setActivityLoading] = useState(false);
  const [ingestion, setIngestion] = useState<IngestionOverviewResponse | null>(
    null,
  );
  const [ingestionDetail, setIngestionDetail] =
    useState<IngestionDetailResponse | null>(null);
  const [ingestionLoading, setIngestionLoading] = useState(false);
  const [ingestionDetailLoading, setIngestionDetailLoading] = useState(false);
  const [migrationsList, setMigrationsList] = useState<MigrationSummary[]>([]);
  const [migrationDetail, setMigrationDetail] =
    useState<MigrationDetailResponse | null>(null);
  const [migrationLoading, setMigrationLoading] = useState(false);
  const [selectedMigrationId, setSelectedMigrationId] = useState<string | null>(
    () => initialRoute.current.migrationId ?? null,
  );
  const [exporting, setExporting] = useState(false);
  const [settings, setSettings] = useState<WorkspaceSettings>({
    enable_memory_editing: false,
    hide_configuration_files: true,
    hide_template_schema_files: true,
    schema: 1,
  });
  const [systemInfo, setSystemInfo] = useState<WorkspaceSystemInfo | null>(
    null,
  );
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [configurationError, setConfigurationError] = useState("");
  const [diagnostics, setDiagnostics] =
    useState<WorkspaceDiagnosticsResponse | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [otherCalendarFiles, setOtherCalendarFiles] = useState<
    Array<{ path: string; content: string }>
  >([]);

  useEffect(() => {
    if (!file || !isRemindPath(file.path)) {
      setOtherCalendarFiles([]);
      return;
    }

    const siblingRemFiles = tree.filter(
      (entry): entry is WorkspaceTreeEntry & { kind: "file" } =>
        entry.kind === "file" &&
        isRemindPath(entry.path) &&
        entry.path !== file.path,
    );

    if (siblingRemFiles.length === 0) {
      setOtherCalendarFiles([]);
      return;
    }

    let cancelled = false;
    Promise.all(
      siblingRemFiles.map(async (entry) => {
        try {
          const loaded = await api.loadFile(entry.path);
          return { path: entry.path, content: loaded.content };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (!cancelled) {
        setOtherCalendarFiles(
          results.filter(
            (r): r is { path: string; content: string } => r !== null,
          ),
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [file, tree, api]);

  const handleLoadInclude = useCallback(
    async (resolvedPath: string): Promise<string | null> => {
      try {
        const loaded = await api.loadFile(resolvedPath);
        return loaded.content;
      } catch {
        return null;
      }
    },
    [api],
  );

  const [pendingRename, setPendingRename] = useState<{
    path: string;
    revision?: string | undefined;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [pendingMove, setPendingMove] = useState<{
    path: string;
    revision?: string | undefined;
  } | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState("");

  // Skills state
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillCategories, setSkillCategories] = useState<string[]>([]);
  const [skillsFilter, setSkillsFilter] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(
    () => initialRoute.current.skill ?? null,
  );
  const [selectedSkillDetail, setSelectedSkillDetail] =
    useState<SkillDetail | null>(null);
  const [selectedSkillFile, setSelectedSkillFile] =
    useState<SkillFileResponse | null>(null);
  const [activeSkillSubTab, setActiveSkillSubTab] =
    useState<SkillSubTab>("instructions");
  const [skillDraft, setSkillDraft] = useState("");
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillFileLoading, setSkillFileLoading] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillError, setSkillError] = useState("");
  const [isCreateSkillOpen, setIsCreateSkillOpen] = useState(false);
  const [isGoToOpen, setIsGoToOpen] = useState(false);
  const [revealToken, setRevealToken] = useState(0);

  // Auth & Navigation state
  const [authReady, setAuthReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authProvider, setAuthProvider] = useState<
    "password" | "firebase" | "none"
  >("none");
  const [firebaseConfig, setFirebaseConfig] = useState<
    FirebaseClientConfig | undefined
  >(undefined);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const filesButtonRef = useRef<HTMLButtonElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(
    () => initialRoute.current.view === "info",
  );
  const [view, setView] = useState<WorkspaceView>(() =>
    viewForPath(initialRoute.current.path, initialRoute.current.view),
  );
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    dirty: boolean;
    path: string;
    revision: string;
  } | null>(null);
  const fileRequestSequence = useRef(0);
  const skillRequestSequence = useRef(0);
  const initialPathOpened = useRef(false);
  const isSyncingRef = useRef(false);
  const memoryDraftRecoveryRef = useRef<{
    file: WorkspaceFile;
    draft: string;
  } | null>(null);

  const docDirty = file !== null && file.content !== draft;
  const skillDirty =
    selectedSkillFile !== null && selectedSkillFile.content !== skillDraft;
  const dirty =
    activeTab === "skills"
      ? skillDirty
      : activeTab === "documents"
        ? docDirty
        : false;
  const diff = docDirty && file ? diffLines(file.content, draft) : [];

  const currentLink =
    activeTab === "skills"
      ? selectedSkillDetail
        ? buildSkillLink(
            selectedSkillDetail.id,
            selectedSkillFile?.path ?? undefined,
          )
        : undefined
      : activeTab === "documents"
        ? file
          ? buildCanonicalWorkspaceUri(file.path)
          : artifact
            ? buildCanonicalWorkspaceUri(artifact.path)
            : undefined
        : undefined;

  const directories = useMemo(() => {
    const set = new Set<string>();
    for (const entry of tree) {
      if (entry.kind === "directory") {
        set.add(entry.path);
      } else {
        const slashIdx = entry.path.lastIndexOf("/");
        if (slashIdx > 0) {
          set.add(entry.path.slice(0, slashIdx));
        }
      }
    }
    return Array.from(set).sort();
  }, [tree]);

  const appStateRef = useRef({
    activeTab,
    artifact,
    dirty,
    docDirty,
    file,
    filter,
    openFile,
    openSkill,
    save,
    saveSkillFile,
    selectedSkillFile,
    settings,
    draft,
    skillDirty,
    view,
  });
  appStateRef.current = {
    activeTab,
    artifact,
    dirty,
    docDirty,
    file,
    filter,
    openFile,
    openSkill,
    save,
    saveSkillFile,
    selectedSkillFile,
    settings,
    draft,
    skillDirty,
    view,
  };

  const loadIngestionDetail = useCallback(
    async (intakeId: string) => {
      setIngestionDetailLoading(true);
      try {
        const nextDetail = await api.loadIngestionDetail(intakeId);
        setIngestionDetail(nextDetail);
      } catch {
        setIngestionDetail(null);
      } finally {
        setIngestionDetailLoading(false);
      }
    },
    [api],
  );

  const loadMigrationDetail = useCallback(
    async (id: string) => {
      setMigrationLoading(true);
      try {
        const detail = await api.loadMigrationDetail(id);
        setMigrationDetail(detail);
        setSelectedMigrationId(id);
      } catch {
        setMigrationDetail(null);
      } finally {
        setMigrationLoading(false);
      }
    },
    [api],
  );

  const refreshMigrations = useCallback(
    async (overrideMigrationId?: string | null) => {
      setMigrationLoading(true);
      try {
        const list = await api.loadMigrations();
        setMigrationsList(list);
        const targetId =
          overrideMigrationId !== undefined
            ? overrideMigrationId
            : selectedMigrationId;
        if (targetId) {
          const detail = await api.loadMigrationDetail(targetId);
          setMigrationDetail(detail);
        } else {
          setMigrationDetail(null);
        }
      } catch {
        // ignore
      } finally {
        setMigrationLoading(false);
      }
    },
    [api, selectedMigrationId],
  );

  const loadWorkspace = useCallback(
    async (isActive?: () => boolean) => {
      setAuthReady(false);
      setLoading(true);
      setWorkspaceError("");
      try {
        const session = await api.loadSession();
        if (isActive && !isActive()) return;
        setAuthRequired(session.auth_required);
        setAuthProvider(
          session.auth_provider ??
            (session.auth_required ? "password" : "none"),
        );
        setFirebaseConfig(session.firebase_config);
        if (session.auth_required && !session.authenticated) {
          setNeedsLogin(true);
          setAuthReady(true);
          setLoading(false);
          return;
        }

        const [
          treeResponse,
          gitResponse,
          skillsResponse,
          activityResponse,
          diagnosticsResponse,
          settingsResponse,
          systemInfoResponse,
          ingestionResponse,
          migrationsResponse,
        ] = await Promise.all([
          api.loadTree(),
          api.loadGitStatus().catch(() => null),
          api.loadSkills().catch(() => ({
            categories: [],
            schema: 1 as const,
            skills: [],
          })),
          api.loadActivity().catch(() => null),
          api.loadDiagnostics().catch(() => null),
          api.loadSettings().catch(() => null),
          api.loadSystemInfo().catch(() => null),
          api.loadIngestion().catch(() => null),
          api.loadMigrations().catch(() => []),
        ]);
        if (isActive && !isActive()) return;

        setTree(treeResponse.entries);
        setTreeTruncated(treeResponse.truncated);
        setGit(gitResponse);
        setSkills(skillsResponse.skills);
        setSkillCategories(skillsResponse.categories);
        setActivity(activityResponse);
        setDiagnostics(diagnosticsResponse);
        if (settingsResponse) setSettings(settingsResponse);
        setSystemInfo(systemInfoResponse);
        setIngestion(ingestionResponse);
        setMigrationsList(migrationsResponse);
        setNeedsLogin(false);
        setAuthReady(true);

        if (!initialPathOpened.current) {
          initialPathOpened.current = true;
          const route =
            typeof window !== "undefined"
              ? parseRoute(window.location)
              : initialRoute.current;

          if (route.tab === "skills" || route.skill) {
            setActiveTab("skills");
            if (route.skill) {
              void appStateRef.current.openSkill(route.skill, route.skillFile);
            }
          } else if (route.tab === "configuration") {
            setActiveTab("configuration");
          } else if (route.tab === "migration" || route.migrationId) {
            setActiveTab("migration");
            if (route.migrationId) {
              void loadMigrationDetail(route.migrationId);
            }
          } else if (route.tab === "ingestion" || route.ingestionId) {
            setActiveTab("ingestion");
            if (route.ingestionId) void loadIngestionDetail(route.ingestionId);
          } else if (route.path) {
            void appStateRef.current.openFile(route.path, {
              requestedView: route.view,
              replaceHistory: true,
            });
          }
        }
      } catch {
        if (isActive && !isActive()) return;
        setWorkspaceError("Workspace data could not be loaded.");
        setGit(null);
        setAuthReady(true);
      } finally {
        if (!isActive || isActive()) {
          setLoading(false);
        }
      }
    },
    [api, loadIngestionDetail, loadMigrationDetail],
  );

  const syncWorkspace = useCallback(async () => {
    if (isSyncingRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    isSyncingRef.current = true;
    try {
      const {
        activeTab,
        file,
        settings: currentSettings,
      } = appStateRef.current;
      const latestSettings = await api.loadSettings().catch(() => null);
      if (
        latestSettings &&
        !areSettingsEqual(currentSettings, latestSettings)
      ) {
        setSettings(latestSettings);
      }
      if (activeTab === "documents") {
        const [treeRes, gitRes, activityRes, diagRes] = await Promise.all([
          api.loadTree().catch(() => null),
          api.loadGitStatus().catch(() => null),
          api.loadActivity().catch(() => null),
          api.loadDiagnostics().catch(() => null),
        ]);

        if (treeRes) {
          setTree((prev) =>
            areTreesEqual(prev, treeRes.entries) ? prev : treeRes.entries,
          );
          setTreeTruncated((prev) =>
            prev === treeRes.truncated ? prev : treeRes.truncated,
          );
        }

        if (gitRes) {
          setGit((prev) => (areGitEqual(prev, gitRes) ? prev : gitRes));
        }

        if (activityRes) {
          setActivity(activityRes);
        }

        if (diagRes) {
          setDiagnostics(diagRes);
        }

        if (file) {
          try {
            const nextFile = await api.loadFile(file.path);
            const current = appStateRef.current;
            if (
              !current.file ||
              current.file.path !== file.path ||
              current.file.revision !== file.revision
            ) {
              return;
            }
            if (
              nextFile.revision !== file.revision ||
              nextFile.missing !== file.missing ||
              nextFile.editable !== file.editable
            ) {
              if (!current.docDirty) {
                setFile(nextFile);
                setDraft(nextFile.content);
                setConflict("");
              } else {
                if (nextFile.editable !== file.editable) {
                  setFile({ ...current.file, editable: nextFile.editable });
                }
                setConflict(
                  nextFile.revision !== file.revision ||
                    nextFile.missing !== file.missing
                    ? "The file changed on disk. Your unsaved draft is preserved; review before saving."
                    : "",
                );
              }
            }
          } catch (caught) {
            if (
              isMemoryDocument(file.path) &&
              latestSettings &&
              !latestSettings.enable_memory_editing
            ) {
              const current = appStateRef.current;
              if (
                !current.file ||
                current.file.path !== file.path ||
                current.file.revision !== file.revision
              ) {
                return;
              }
              if (current.docDirty) {
                const disabledFile = { ...current.file, editable: false };
                memoryDraftRecoveryRef.current = {
                  draft: current.draft,
                  file: disabledFile,
                };
                setFile(disabledFile);
                setConflict(
                  "Memory editing was disabled. Your unsaved draft is preserved; enable it in Configuration to save.",
                );
              } else {
                setFile(null);
                setDraft("");
                navigateRoute({ tab: "documents" }, { replace: true });
              }
              return;
            }
            if (caught instanceof ApiError && caught.status === 404) {
              const current = appStateRef.current;
              if (
                !current.file ||
                current.file.path !== file.path ||
                current.file.revision !== file.revision
              ) {
                return;
              }
              if (!current.docDirty) {
                setFile(null);
                setDraft("");
                setConflict("");
                setDocumentError("This document was deleted elsewhere.");
                navigateRoute(
                  {
                    filter: appStateRef.current.filter || undefined,
                    tab: "documents",
                  },
                  { replace: true },
                );
              } else {
                setConflict(
                  "This file was deleted elsewhere. Your unsaved draft is preserved.",
                );
              }
            }
          }
        }
      } else if (activeTab === "ingestion") {
        const nextIngestion = await api.loadIngestion().catch(() => null);
        if (nextIngestion) setIngestion(nextIngestion);
        const selectedId =
          typeof window !== "undefined"
            ? parseRoute(window.location).ingestionId
            : undefined;
        if (selectedId) {
          const nextDetail = await api
            .loadIngestionDetail(selectedId)
            .catch(() => null);
          if (nextDetail) setIngestionDetail(nextDetail);
        }
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void loadWorkspace(() => active);
    return () => {
      active = false;
    };
  }, [loadWorkspace]);

  useEffect(() => {
    const timer = setInterval(() => {
      void syncWorkspace();
    }, 4000);

    function handleRevalidation() {
      if (typeof document !== "undefined" && !document.hidden) {
        void syncWorkspace();
      }
    }

    window.addEventListener("focus", handleRevalidation);
    document.addEventListener("visibilitychange", handleRevalidation);

    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", handleRevalidation);
      document.removeEventListener("visibilitychange", handleRevalidation);
    };
  }, [syncWorkspace]);

  useEffect(() => {
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    function handleSaveShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s")
        return;
      const { activeTab, docDirty, file, save, saveSkillFile, skillDirty } =
        appStateRef.current;
      if (activeTab === "skills") {
        if (!skillDirty) return;
        event.preventDefault();
        void saveSkillFile();
      } else {
        if ((!docDirty && !file?.missing) || !file?.editable) return;
        event.preventDefault();
        void save();
      }
    }

    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, []);

  useEffect(() => {
    function handleGoToShortcut(event: KeyboardEvent) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        (event.key.toLowerCase() !== "p" && event.key.toLowerCase() !== "k")
      )
        return;
      event.preventDefault();
      setIsGoToOpen((prev) => !prev);
    }

    window.addEventListener("keydown", handleGoToShortcut);
    return () => window.removeEventListener("keydown", handleGoToShortcut);
  }, []);

  useEffect(() => {
    function handlePopState() {
      const {
        activeTab,
        artifact,
        dirty,
        file,
        filter,
        openFile,
        openSkill,
        view,
      } = appStateRef.current;
      const route = parseRoute(window.location);

      if (dirty) {
        if (activeTab === "documents" && file?.path) {
          navigateRoute(
            {
              filter: filter || undefined,
              path: file.path,
              scenario: route.scenario,
              tab: "documents",
              view,
            },
            { replace: true },
          );
        }
        if (route.tab === "skills" || route.skill) {
          setPendingAction({
            id: route.skill ?? "",
            kind: "openSkill",
            skillFile: route.skillFile,
          });
        } else if (route.tab === "git-activity") {
          setPendingAction({
            kind: "switchTab",
            tab: "git-activity",
          });
        } else if (route.tab === "ingestion" || route.ingestionId) {
          setPendingAction({
            ingestionId: route.ingestionId,
            kind: "switchTab",
            tab: "ingestion",
          });
        } else if (route.tab === "migration" || route.migrationId) {
          setPendingAction({
            kind: "switchTab",
            migrationId: route.migrationId,
            tab: "migration",
          });
        } else if (route.tab === "configuration") {
          setPendingAction({ kind: "switchTab", tab: "configuration" });
        } else {
          setPendingAction({
            kind: "open",
            path: route.path ?? "",
            view: route.view,
          });
        }
        return;
      }

      setFilter(route.filter ?? "");

      if (route.tab) {
        setActiveTab(route.tab);
      }

      if (route.view) {
        const nextView = viewForPath(route.path ?? file?.path, route.view);
        setView(nextView);
        if (nextView === "info") setDetailsOpen(true);
      }

      if (route.tab === "skills" || route.skill) {
        setActiveTab("skills");
        if (route.skill) {
          void openSkill(route.skill, route.skillFile);
        }
      } else if (route.tab === "git-activity") {
        setActiveTab("git-activity");
        setFile(null);
        setArtifact(null);
        setDraft("");
        setConflict("");
        setDocumentError("");
      } else if (route.tab === "ingestion" || route.ingestionId) {
        setActiveTab("ingestion");
        setFile(null);
        setArtifact(null);
        setDraft("");
        setConflict("");
        setDocumentError("");
        if (route.ingestionId) void loadIngestionDetail(route.ingestionId);
      } else if (route.tab === "migration" || route.migrationId) {
        setActiveTab("migration");
        setFile(null);
        setArtifact(null);
        setDraft("");
        setConflict("");
        setDocumentError("");
        if (route.migrationId) {
          void loadMigrationDetail(route.migrationId);
        } else {
          void refreshMigrations();
        }
      } else if (route.tab === "configuration") {
        setActiveTab("configuration");
      } else if (route.path) {
        if (route.path !== file?.path && route.path !== artifact?.path) {
          void openFile(route.path, {
            requestedView: route.view,
            replaceHistory: true,
          });
        }
      } else {
        setActiveTab("documents");
        setFile(null);
        setArtifact(null);
        setDraft("");
        setConflict("");
        setDocumentError("");
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [loadIngestionDetail, loadMigrationDetail, refreshMigrations]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (activeTab === "skills") {
      document.title = selectedSkillDetail
        ? `${selectedSkillDetail.name} - OpenLia Skills`
        : "Skills - OpenLia Workspace";
    } else if (activeTab === "git-activity") {
      document.title = "Git Activity - OpenLia Workspace";
    } else if (activeTab === "ingestion") {
      document.title = "Ingestion - OpenLia Workspace";
    } else if (activeTab === "configuration") {
      document.title = "Configuration - OpenLia Workspace";
    } else {
      const selectedPath = file?.path ?? artifact?.path;
      if (selectedPath) {
        const name = selectedPath.split("/").at(-1) ?? selectedPath;
        document.title = `${name} - OpenLia Workspace`;
      } else {
        document.title = "OpenLia Workspace";
      }
    }
  }, [activeTab, artifact?.path, file?.path, selectedSkillDetail]);

  function handleUnauthorized() {
    setTree([]);
    setSkills([]);
    setGit(null);
    setDiagnostics(null);
    setNeedsLogin(true);
    setAuthRequired(true);
    setAuthReady(true);
    setAuthError("Your session expired. Sign in again to keep working.");
  }

  async function submitLogin() {
    setAuthError("");
    setAuthSubmitting(true);
    try {
      await api.login(password);
      setPassword("");
      setNeedsLogin(false);
      setLoading(true);
      const [
        treeResponse,
        gitResponse,
        skillsResponse,
        activityResponse,
        diagnosticsResponse,
        settingsResponse,
        systemInfoResponse,
        ingestionResponse,
      ] = await Promise.all([
        api.loadTree(),
        api.loadGitStatus().catch(() => null),
        api
          .loadSkills()
          .catch(() => ({ categories: [], schema: 1 as const, skills: [] })),
        api.loadActivity().catch(() => null),
        api.loadDiagnostics().catch(() => null),
        api.loadSettings().catch(() => null),
        api.loadSystemInfo().catch(() => null),
        api.loadIngestion().catch(() => null),
      ]);
      setTree(treeResponse.entries);
      setTreeTruncated(treeResponse.truncated);
      setGit(gitResponse);
      setSkills(skillsResponse.skills);
      setSkillCategories(skillsResponse.categories);
      setActivity(activityResponse);
      setDiagnostics(diagnosticsResponse);
      if (settingsResponse) setSettings(settingsResponse);
      setSystemInfo(systemInfoResponse);
      setIngestion(ingestionResponse);
      setWorkspaceError("");

      if (!initialPathOpened.current) {
        initialPathOpened.current = true;
        const route =
          typeof window !== "undefined"
            ? parseRoute(window.location)
            : initialRoute.current;
        if (route.tab === "skills" || route.skill) {
          setActiveTab("skills");
          if (route.skill) {
            void appStateRef.current.openSkill(route.skill, route.skillFile);
          }
        } else if (route.tab === "configuration") {
          setActiveTab("configuration");
        } else if (route.tab === "ingestion" || route.ingestionId) {
          setActiveTab("ingestion");
          if (route.ingestionId) void loadIngestionDetail(route.ingestionId);
        } else if (route.path) {
          void openFile(route.path, {
            requestedView: route.view,
            replaceHistory: true,
          });
        }
      }
    } catch (caught) {
      setPassword("");
      if (caught instanceof ApiError) {
        if (caught.status === 429)
          setAuthError("Too many attempts. Try again shortly.");
        else if (caught.payload?.error === "origin_not_allowed")
          setAuthError(
            "This workspace address is not trusted by the server. Check the reverse proxy origin configuration.",
          );
        else if (caught.status === 401)
          setAuthError("The password was not accepted.");
        else setAuthError("Sign-in failed. Try again shortly.");
      } else setAuthError("Sign-in failed. Try again shortly.");
    } finally {
      setAuthSubmitting(false);
      setLoading(false);
    }
  }

  async function submitGoogleSignIn() {
    if (!firebaseConfig) {
      setAuthError("Firebase authentication is not configured.");
      return;
    }
    setAuthError("");
    setAuthSubmitting(true);
    try {
      const idToken = await signInWithGoogle(firebaseConfig);
      await api.loginWithFirebase(idToken);
      setNeedsLogin(false);
      setLoading(true);
      const [
        treeResponse,
        gitResponse,
        skillsResponse,
        activityResponse,
        diagnosticsResponse,
        settingsResponse,
        systemInfoResponse,
        ingestionResponse,
      ] = await Promise.all([
        api.loadTree(),
        api.loadGitStatus().catch(() => null),
        api
          .loadSkills()
          .catch(() => ({ categories: [], schema: 1 as const, skills: [] })),
        api.loadActivity().catch(() => null),
        api.loadDiagnostics().catch(() => null),
        api.loadSettings().catch(() => null),
        api.loadSystemInfo().catch(() => null),
        api.loadIngestion().catch(() => null),
      ]);
      setTree(treeResponse.entries);
      setTreeTruncated(treeResponse.truncated);
      setGit(gitResponse);
      setSkills(skillsResponse.skills);
      setSkillCategories(skillsResponse.categories);
      setActivity(activityResponse);
      setDiagnostics(diagnosticsResponse);
      if (settingsResponse) setSettings(settingsResponse);
      setSystemInfo(systemInfoResponse);
      setIngestion(ingestionResponse);
      setWorkspaceError("");

      if (!file && !artifact) {
        const route =
          typeof window !== "undefined"
            ? parseRoute(window.location)
            : initialRoute.current;
        if (route.tab === "skills" || route.skill) {
          setActiveTab("skills");
          if (route.skill) {
            void appStateRef.current.openSkill(route.skill, route.skillFile);
          }
        } else if (route.tab === "configuration") {
          setActiveTab("configuration");
        } else if (route.tab === "ingestion" || route.ingestionId) {
          setActiveTab("ingestion");
          if (route.ingestionId) void loadIngestionDetail(route.ingestionId);
        } else if (route.path) {
          void openFile(route.path, {
            requestedView: route.view,
            replaceHistory: true,
          });
        }
      }
    } catch (caught) {
      void signOutFirebase(firebaseConfig);
      if (caught instanceof ApiError) {
        if (caught.payload?.error === "forbidden_user") {
          setAuthError(
            "Access denied: The account signed in is not authorized for this workspace.",
          );
        } else if (caught.payload?.error === "unverified_email") {
          setAuthError("Access denied: Your Google email is not verified.");
        } else if (caught.status === 429) {
          setAuthError("Too many attempts. Try again shortly.");
        } else if (caught.payload?.error === "origin_not_allowed") {
          setAuthError(
            "This workspace address is not trusted by the server. Check the reverse proxy origin configuration.",
          );
        } else {
          setAuthError("Google sign-in failed. Try again shortly.");
        }
      } else if (
        caught instanceof Error &&
        caught.message.includes("popup-closed-by-user")
      ) {
        setAuthError("");
      } else {
        setAuthError("Google sign-in could not be completed. Try again.");
      }
    } finally {
      setAuthSubmitting(false);
      setLoading(false);
    }
  }

  async function performSignOut() {
    await api.logout().catch(() => undefined);
    void signOutFirebase(firebaseConfig);
    setTree([]);
    setSkills([]);
    setGit(null);
    setFile(null);
    setArtifact(null);
    setDraft("");
    setDiagnostics(null);
    setSelectedSkillDetail(null);
    setSelectedSkillFile(null);
    setNeedsLogin(true);
    setAuthRequired(true);
    setAuthError("");
    const currentRoute =
      typeof window !== "undefined" ? parseRoute(window.location) : {};
    navigateRoute({ scenario: currentRoute.scenario }, { replace: true });
  }

  function requestSignOut() {
    if (dirty) setPendingAction({ kind: "signout" });
    else void performSignOut();
  }

  function requestDelete(path?: string) {
    const targetPath = path ?? file?.path;
    if (!targetPath || deleting || isMemoryDocument(targetPath)) return;
    setPendingDelete({
      dirty: file?.path === targetPath ? docDirty : false,
      path: targetPath,
      revision: file?.path === targetPath ? file.revision : "",
    });
  }

  function requestRename(path?: string) {
    const targetPath = path ?? file?.path;
    if (!targetPath || renaming || isMemoryDocument(targetPath)) return;
    setRenameError("");
    setPendingRename({
      path: targetPath,
      revision: file?.path === targetPath ? file.revision : undefined,
    });
  }

  function requestMove(path?: string) {
    const targetPath = path ?? file?.path;
    if (!targetPath || moving || isMemoryDocument(targetPath)) return;
    setMoveError("");
    setPendingMove({
      path: targetPath,
      revision: file?.path === targetPath ? file.revision : undefined,
    });
  }

  function requestTabChange(nextTab: MainTab) {
    if (nextTab === "migration") {
      requestMigration(undefined);
      return;
    }
    if (nextTab === activeTab) return;
    const canRecoverMemoryDraft =
      nextTab === "configuration" &&
      ((file?.source === "memory" && file.editable === false) ||
        memoryDraftRecoveryRef.current !== null);
    const protectedMemoryDraft =
      activeTab === "configuration" &&
      ((file?.source === "memory" && docDirty) ||
        memoryDraftRecoveryRef.current !== null);
    if (nextTab === "documents" && memoryDraftRecoveryRef.current) {
      setActiveTab("documents");
      navigateRoute({
        path: memoryDraftRecoveryRef.current.file.path,
        tab: "documents",
        view,
      });
      return;
    }
    if (
      nextTab === "documents" &&
      activeTab === "configuration" &&
      file?.source === "memory" &&
      docDirty
    ) {
      memoryDraftRecoveryRef.current = { draft, file };
      setActiveTab("documents");
      navigateRoute({ path: file.path, tab: "documents", view });
      return;
    }
    if ((dirty || protectedMemoryDraft) && !canRecoverMemoryDraft) {
      setPendingAction({ kind: "switchTab", tab: nextTab });
    } else {
      setActiveTab(nextTab);
      navigateRoute({
        path: nextTab === "documents" ? file?.path : undefined,
        skill:
          nextTab === "skills" ? (selectedSkillId ?? undefined) : undefined,
        tab: nextTab,
      });
      if (nextTab === "ingestion") {
        setIngestionDetail(null);
      }
    }
  }

  function requestMigration(migId?: string) {
    if (dirty) {
      setPendingAction({
        kind: "switchTab",
        migrationId: migId,
        tab: "migration",
      });
      return;
    }
    setActiveTab("migration");
    setFile(null);
    setArtifact(null);
    setDraft("");
    navigateRoute({ migrationId: migId, tab: "migration" });
    if (migId) {
      void loadMigrationDetail(migId);
    } else {
      setSelectedMigrationId(null);
      setMigrationDetail(null);
      void refreshMigrations(null);
    }
  }

  function requestIngestion(intakeId?: string) {
    if (dirty) {
      setPendingAction({
        ingestionId: intakeId,
        kind: "switchTab",
        tab: "ingestion",
      });
      return;
    }
    setActiveTab("ingestion");
    setFile(null);
    setArtifact(null);
    setDraft("");
    setIngestionDetail(null);
    navigateRoute({ tab: "ingestion", ingestionId: intakeId });
    if (intakeId) void loadIngestionDetail(intakeId);
  }

  async function openFile(
    path: string,
    options?: {
      replaceHistory?: boolean;
      requestedView?: WorkspaceView | undefined;
    },
  ) {
    const requestSequence = ++fileRequestSequence.current;
    setActiveTab("documents");
    setFileLoading(true);
    setDocumentError("");
    setConflict("");
    const selectArtifact = (metadata: WorkspaceFileMetadata) => {
      if (requestSequence !== fileRequestSequence.current) return;
      setActiveTab("documents");
      setFile(null);
      setArtifact(metadata);
      setDraft("");
      setFilesOpen(false);
      setView(viewForPath(path, options?.requestedView));
      const currentRoute =
        typeof window !== "undefined" ? parseRoute(window.location) : {};
      navigateRoute(
        {
          filter: filter || undefined,
          path,
          scenario: currentRoute.scenario,
          tab: "documents",
          view: options?.requestedView,
        },
        { replace: options?.replaceHistory },
      );
    };
    const treeEntry = tree.find(
      (entry): entry is WorkspaceTreeEntry & { kind: "file" } =>
        entry.kind === "file" && entry.path === path,
    );
    try {
      if (treeEntry && !treeEntry.editable && isKnownArtifactPath(path)) {
        selectArtifact(treeEntry);
        return;
      }
      const response = await api.loadFile(path);
      if (requestSequence !== fileRequestSequence.current) return;
      setFile(response);
      setArtifact(null);
      setDraft(response.content);
      setFilesOpen(false);
      const nextView = viewForPath(path, options?.requestedView);
      setView(nextView);
      const currentRoute =
        typeof window !== "undefined" ? parseRoute(window.location) : {};
      navigateRoute(
        {
          filter: filter || undefined,
          path,
          scenario: currentRoute.scenario,
          tab: "documents",
          view: nextView,
        },
        { replace: options?.replaceHistory },
      );
    } catch (caught) {
      if (requestSequence !== fileRequestSequence.current) return;
      if (caught instanceof ApiError && caught.status === 401) {
        handleUnauthorized();
        return;
      }
      if (isArtifactError(caught)) {
        try {
          const metadata = treeEntry ?? (await api.loadFileMetadata(path));
          selectArtifact(metadata);
          return;
        } catch (metadataError) {
          if (metadataError instanceof ApiError && metadataError.status === 401)
            handleUnauthorized();
          else
            setDocumentError("This document could not be opened. Try again.");
          return;
        }
      }
      setDocumentError("This document could not be opened. Try again.");
    } finally {
      if (requestSequence === fileRequestSequence.current)
        setFileLoading(false);
    }
  }

  function requestOpenFile(path: string) {
    if (!path) {
      if (activeTab === "documents" && !file && !artifact) {
        setFilesOpen(false);
        return;
      }
      if (dirty) {
        setPendingAction({ kind: "open", path: "" });
      } else {
        setActiveTab("documents");
        setFile(null);
        setArtifact(null);
        setDraft("");
        setConflict("");
        setDocumentError("");
        setFilesOpen(false);
        const currentRoute =
          typeof window !== "undefined" ? parseRoute(window.location) : {};
        navigateRoute({
          filter: filter || undefined,
          scenario: currentRoute.scenario,
          tab: "documents",
        });
      }
      return;
    }
    if (path === (file?.path ?? artifact?.path)) {
      setFilesOpen(false);
      return;
    }
    if (dirty) setPendingAction({ kind: "open", path });
    else void openFile(path);
  }

  function requestOpenDocuments() {
    if (
      memoryDraftRecoveryRef.current ||
      (activeTab === "configuration" && file?.source === "memory" && docDirty)
    ) {
      requestTabChange("documents");
      return;
    }
    requestOpenFile("");
  }

  async function openSkill(id: string, skillFilePath = "SKILL.md") {
    const requestSequence = ++skillRequestSequence.current;
    setSkillsLoading(true);
    setSkillError("");
    try {
      const [detailRes, fileRes] = await Promise.all([
        api.loadSkillDetail(id),
        api.loadSkillFile(id, skillFilePath).catch(() => null),
      ]);
      if (requestSequence !== skillRequestSequence.current) return;
      setSelectedSkillId(id);
      setSelectedSkillDetail(detailRes.skill);
      setSelectedSkillFile(fileRes);
      setSkillDraft(fileRes ? fileRes.content : "");
      setActiveSkillSubTab(
        skillFilePath === "SKILL.md" ? "instructions" : "files",
      );
      setFilesOpen(false);

      navigateRoute({
        skill: id,
        skillFile: skillFilePath !== "SKILL.md" ? skillFilePath : undefined,
        tab: "skills",
      });
    } catch (caught) {
      if (requestSequence !== skillRequestSequence.current) return;
      if (caught instanceof ApiError && caught.status === 401) {
        handleUnauthorized();
        return;
      }
      setSkillError("Failed to load skill details.");
    } finally {
      if (requestSequence === skillRequestSequence.current)
        setSkillsLoading(false);
    }
  }

  function requestOpenSkill(id: string, skillFilePath?: string) {
    if (
      id === selectedSkillId &&
      (!skillFilePath || skillFilePath === selectedSkillFile?.path)
    ) {
      setFilesOpen(false);
      return;
    }
    if (dirty) {
      setPendingAction({ id, kind: "openSkill", skillFile: skillFilePath });
    } else {
      void openSkill(id, skillFilePath);
    }
  }

  function handleNavigateLink(href: string) {
    const target = resolveLinkTarget(href, {
      currentFilePath: file?.path,
      skills,
      tree,
    });
    if (!target) return;
    if (target.kind === "workspace") {
      requestOpenFile(target.path);
    } else if (target.kind === "skill") {
      requestOpenSkill(target.skillId, target.skillFile);
    } else if (target.kind === "git-activity") {
      requestTabChange("git-activity");
    }
  }

  async function openSkillFile(fileEntry: SkillFileEntry) {
    if (!selectedSkillId) return;
    if (skillDirty) {
      setPendingAction({
        id: selectedSkillId,
        kind: "openSkill",
        skillFile: fileEntry.path,
      });
      return;
    }
    setSkillFileLoading(true);
    try {
      const res = await api.loadSkillFile(selectedSkillId, fileEntry.path);
      setSelectedSkillFile(res);
      setSkillDraft(res.content);
    } catch {
      setSkillError(`Could not load ${fileEntry.path}`);
    } finally {
      setSkillFileLoading(false);
    }
  }

  async function save(): Promise<boolean> {
    if (!file?.editable || saving) return false;
    if (isMemoryDocument(file.path) && !settings.enable_memory_editing)
      return false;
    setSaving(true);
    setDocumentError("");
    setConflict("");
    try {
      const response = await api.saveFile(file.path, draft, file.revision);
      setFile({ ...file, ...response, content: draft });
      if (isMemoryDocument(file.path)) memoryDraftRecoveryRef.current = null;
      const [treeResponse, nextGit, nextActivity, nextDiag] = await Promise.all(
        [
          api.loadTree(),
          api.loadGitStatus().catch(() => null),
          api.loadActivity().catch(() => null),
          api.loadDiagnostics().catch(() => null),
        ],
      );
      setTree(treeResponse.entries);
      setTreeTruncated(treeResponse.truncated);
      if (nextGit) setGit(nextGit);
      if (nextActivity) setActivity(nextActivity);
      if (nextDiag) setDiagnostics(nextDiag);
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        handleUnauthorized();
        return false;
      }
      if (caught instanceof ApiError && caught.status === 409) {
        setConflict(
          "The file changed elsewhere. Your draft is safe; review it before saving again.",
        );
      } else setDocumentError("The document could not be saved. Try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function deleteFile(): Promise<void> {
    const pending = pendingDelete;
    if (!pending || deleting) return;
    setDeleting(true);
    setDocumentError("");
    setConflict("");
    try {
      let revision = pending.revision;
      if (!revision) {
        const loaded = await api.loadFile(pending.path);
        revision = loaded.revision;
      }
      await api.deleteFile(pending.path, revision);
      setPendingDelete(null);
      if (file?.path === pending.path) {
        setFile(null);
        setArtifact(null);
        setDraft("");
        setConflict("");
        setDocumentError("");
        setDetailsOpen(false);
        setView(defaultView());
        const currentRoute =
          typeof window !== "undefined" ? parseRoute(window.location) : {};
        navigateRoute(
          {
            filter: filter || undefined,
            scenario: currentRoute.scenario,
            tab: "documents",
          },
          { replace: true },
        );
      }
      const [treeResponse, nextGit, nextActivity, nextDiag] = await Promise.all(
        [
          api.loadTree().catch(() => null),
          api.loadGitStatus().catch(() => null),
          api.loadActivity().catch(() => null),
          api.loadDiagnostics().catch(() => null),
        ],
      );
      if (treeResponse) {
        setTree(treeResponse.entries);
        setTreeTruncated(treeResponse.truncated);
      }
      if (nextGit) setGit(nextGit);
      if (nextActivity) setActivity(nextActivity);
      if (nextDiag) setDiagnostics(nextDiag);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setPendingDelete(null);
        handleUnauthorized();
      } else if (caught instanceof ApiError && caught.status === 404) {
        setPendingDelete(null);
        setFile(null);
        setArtifact(null);
        setDraft("");
        setConflict("");
        setDocumentError("This document no longer exists.");
        const [treeResponse, nextDiag] = await Promise.all([
          api.loadTree().catch(() => null),
          api.loadDiagnostics().catch(() => null),
        ]);
        if (treeResponse) {
          setTree(treeResponse.entries);
          setTreeTruncated(treeResponse.truncated);
        }
        if (nextDiag) setDiagnostics(nextDiag);
        navigateRoute({ tab: "documents" }, { replace: true });
      } else if (caught instanceof ApiError && caught.status === 409) {
        setPendingDelete(null);
        setConflict("The file changed elsewhere. Reload it before deleting.");
      } else {
        setDocumentError("The document could not be deleted. Try again.");
      }
    } finally {
      setDeleting(false);
    }
  }

  async function handleRename(newName: string): Promise<void> {
    if (!pendingRename || renaming) return;
    setRenaming(true);
    setRenameError("");
    try {
      if (file?.path === pendingRename.path && docDirty) {
        const saved = await save();
        if (!saved) {
          setRenaming(false);
          return;
        }
      }
      let revision =
        file?.path === pendingRename.path
          ? file.revision
          : pendingRename.revision;
      if (!revision) {
        const target = await api.loadFile(pendingRename.path);
        revision = target.revision;
      }
      const res = await api.renameFile(pendingRename.path, newName, revision);
      const oldPath = pendingRename.path;
      setPendingRename(null);
      if (file?.path === oldPath) {
        await openFile(res.path, { replaceHistory: true });
      }
      const [treeRes, nextGit, nextActivity, nextDiag] = await Promise.all([
        api.loadTree().catch(() => null),
        api.loadGitStatus().catch(() => null),
        api.loadActivity().catch(() => null),
        api.loadDiagnostics().catch(() => null),
      ]);
      if (treeRes) {
        setTree(treeRes.entries);
        setTreeTruncated(treeRes.truncated);
      }
      if (nextGit) setGit(nextGit);
      if (nextActivity) setActivity(nextActivity);
      if (nextDiag) setDiagnostics(nextDiag);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 409) {
          setRenameError(
            "The file was modified elsewhere or the target name already exists.",
          );
        } else if (caught.status === 401) {
          setPendingRename(null);
          handleUnauthorized();
        } else {
          setRenameError(
            caught.payload?.error
              ? String(caught.payload.error)
              : "Failed to rename file.",
          );
        }
      } else {
        setRenameError("Failed to rename file.");
      }
    } finally {
      setRenaming(false);
    }
  }

  async function handleMove(destinationPath: string): Promise<void> {
    if (!pendingMove || moving) return;
    setMoving(true);
    setMoveError("");
    try {
      if (file?.path === pendingMove.path && docDirty) {
        const saved = await save();
        if (!saved) {
          setMoving(false);
          return;
        }
      }
      let revision =
        file?.path === pendingMove.path ? file.revision : pendingMove.revision;
      if (!revision) {
        const target = await api.loadFile(pendingMove.path);
        revision = target.revision;
      }
      const res = await api.moveFile(
        pendingMove.path,
        destinationPath,
        revision,
      );
      const oldPath = pendingMove.path;
      setPendingMove(null);
      if (file?.path === oldPath) {
        await openFile(res.path, { replaceHistory: true });
      }
      const [treeRes, nextGit, nextActivity, nextDiag] = await Promise.all([
        api.loadTree().catch(() => null),
        api.loadGitStatus().catch(() => null),
        api.loadActivity().catch(() => null),
        api.loadDiagnostics().catch(() => null),
      ]);
      if (treeRes) {
        setTree(treeRes.entries);
        setTreeTruncated(treeRes.truncated);
      }
      if (nextGit) setGit(nextGit);
      if (nextActivity) setActivity(nextActivity);
      if (nextDiag) setDiagnostics(nextDiag);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 409) {
          setMoveError(
            "The destination path already exists or the file changed elsewhere.",
          );
        } else if (caught.status === 401) {
          setPendingMove(null);
          handleUnauthorized();
        } else {
          setMoveError(
            caught.payload?.error
              ? String(caught.payload.error)
              : "Failed to move file.",
          );
        }
      } else {
        setMoveError("Failed to move file.");
      }
    } finally {
      setMoving(false);
    }
  }

  async function saveSkillFile(): Promise<boolean> {
    if (!selectedSkillDetail || !selectedSkillFile || skillSaving) return false;
    setSkillSaving(true);
    setSkillError("");
    try {
      const res = await api.saveSkillFile(
        selectedSkillDetail.id,
        selectedSkillFile.path,
        skillDraft,
        selectedSkillFile.revision,
      );
      setSelectedSkillFile({
        ...selectedSkillFile,
        content: skillDraft,
        modified_at: res.modified_at,
        revision: res.revision,
      });

      // If SKILL.md was updated, reload detail and skills list to refresh frontmatter description
      if (selectedSkillFile.path === "SKILL.md") {
        const [updatedDetail, updatedSkills] = await Promise.all([
          api.loadSkillDetail(selectedSkillDetail.id),
          api.loadSkills(),
        ]);
        setSelectedSkillDetail(updatedDetail.skill);
        setSkills(updatedSkills.skills);
      }
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setSkillError(
          "Revision conflict. The file changed on disk. Revert or copy your changes.",
        );
      } else {
        setSkillError("Failed to save skill file.");
      }
      return false;
    } finally {
      setSkillSaving(false);
    }
  }

  async function handleToggleSkillEnable(enabled: boolean) {
    if (!selectedSkillDetail) return;
    try {
      await api.toggleSkillEnable(selectedSkillDetail.id, enabled);
      setSelectedSkillDetail({ ...selectedSkillDetail, enabled });
      setSkills((prev) =>
        prev.map((s) =>
          s.id === selectedSkillDetail.id ? { ...s, enabled } : s,
        ),
      );
    } catch {
      setSkillError("Failed to toggle skill enable state.");
    }
  }

  async function handleToggleSkillPin(id: string, pinned: boolean) {
    try {
      await api.toggleSkillPin(id, pinned);
      if (selectedSkillDetail?.id === id) {
        setSelectedSkillDetail({ ...selectedSkillDetail, pinned });
      }
      setSkills((prev) =>
        prev.map((s) => (s.id === id ? { ...s, pinned } : s)),
      );
    } catch {
      setSkillError("Failed to update skill pin state.");
    }
  }

  async function handleCreateSkill(
    name: string,
    category: string,
    description: string,
  ) {
    const res = await api.createSkill({ category, description, name });
    const skillsRes = await api.loadSkills();
    setSkills(skillsRes.skills);
    setSkillCategories(skillsRes.categories);
    if (res.id) {
      void openSkill(res.id);
    }
  }

  async function saveAndContinue() {
    const action = pendingAction;
    if (!action) return;
    const ok = activeTab === "skills" ? await saveSkillFile() : await save();
    if (!ok) return;
    setPendingAction(null);

    if (action.kind === "open") {
      if (action.path) {
        void openFile(action.path, { requestedView: action.view });
      } else {
        setFile(null);
        setArtifact(null);
        setDraft("");
        navigateRoute({ tab: "documents", view }, { replace: true });
      }
    } else if (action.kind === "openSkill") {
      void openSkill(action.id, action.skillFile);
    } else if (action.kind === "switchTab") {
      setActiveTab(action.tab);
      setIngestionDetail(null);
      navigateRoute({
        ingestionId: action.ingestionId,
        migrationId: action.migrationId,
        tab: action.tab,
      });
      if (action.ingestionId) void loadIngestionDetail(action.ingestionId);
    } else {
      void performSignOut();
    }
  }

  function discardAndContinue() {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);

    if (activeTab === "skills") {
      setSkillDraft(selectedSkillFile?.content ?? "");
    } else {
      setDraft(file?.content ?? "");
      if (file && isMemoryDocument(file.path)) {
        memoryDraftRecoveryRef.current = null;
      }
    }

    if (action.kind === "open") {
      if (action.path) {
        void openFile(action.path, { requestedView: action.view });
      } else {
        setFile(null);
        setArtifact(null);
        setDraft("");
        navigateRoute({ tab: "documents", view }, { replace: true });
      }
    } else if (action.kind === "openSkill") {
      void openSkill(action.id, action.skillFile);
    } else if (action.kind === "switchTab") {
      setActiveTab(action.tab);
      setIngestionDetail(null);
      navigateRoute({
        ingestionId: action.ingestionId,
        migrationId: action.migrationId,
        tab: action.tab,
      });
      if (action.ingestionId) void loadIngestionDetail(action.ingestionId);
    } else {
      void performSignOut();
    }
  }

  function handleFilterChange(nextFilter: string) {
    setFilter(nextFilter);
    const normalizedFilter = nextFilter.trim();
    const currentRoute =
      typeof window !== "undefined" ? parseRoute(window.location) : {};
    navigateRoute(
      {
        filter: normalizedFilter || undefined,
        path: file?.path ?? artifact?.path,
        scenario: currentRoute.scenario,
        tab: "documents",
        view,
      },
      { replace: true },
    );
  }

  function handleViewChange(nextView: WorkspaceView) {
    const normalizedView = viewForPath(file?.path ?? artifact?.path, nextView);
    setView(normalizedView);
    if (normalizedView === "info") setDetailsOpen(true);
    const currentRoute =
      typeof window !== "undefined" ? parseRoute(window.location) : {};
    navigateRoute(
      {
        filter: filter || undefined,
        path: file?.path ?? artifact?.path,
        scenario: currentRoute.scenario,
        tab: activeTab,
        view: normalizedView,
      },
      { replace: true },
    );
  }

  function openHeaderDetails() {
    const nextOpen = !detailsOpen;
    setDetailsOpen(nextOpen);
    let nextView = view;
    if (
      typeof window !== "undefined" &&
      !window.matchMedia("(min-width: 1280px)").matches
    ) {
      nextView = nextOpen ? "info" : defaultView(file?.path ?? artifact?.path);
      setView(nextView);
    } else if (!nextOpen && view === "info") {
      nextView = defaultView(file?.path ?? artifact?.path);
      setView(nextView);
    }
    const currentRoute =
      typeof window !== "undefined" ? parseRoute(window.location) : {};
    navigateRoute(
      {
        filter: filter || undefined,
        path: file?.path ?? artifact?.path,
        scenario: currentRoute.scenario,
        tab: activeTab,
        view: nextView,
      },
      { replace: true },
    );
  }

  function handleRevealInTree() {
    if (filter) {
      handleFilterChange("");
    }
    setFilesOpen(true);
    setRevealToken((prev) => prev + 1);
  }

  const handleExport = useCallback(async () => {
    if (exporting) return;
    try {
      setExporting(true);
      await api.downloadWorkspaceExport();
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Failed to export workspace",
      );
    } finally {
      setExporting(false);
    }
  }, [api, exporting]);

  async function handleSettingsChange(
    key: Exclude<keyof WorkspaceSettings, "schema">,
    value: boolean,
  ) {
    if (settingsSaving) return;
    setConfigurationError("");
    setSettingsSaving(true);
    try {
      const next = await api.updateSettings({ ...settings, [key]: value });
      setSettings(next);
      if (
        next.enable_memory_editing &&
        ((file?.source === "memory" && !file.editable) ||
          memoryDraftRecoveryRef.current)
      ) {
        const recovery = memoryDraftRecoveryRef.current;
        if (recovery) {
          setFile({ ...recovery.file, editable: true });
          setDraft(recovery.draft);
          memoryDraftRecoveryRef.current = null;
        } else if (file) {
          setFile({ ...file, editable: true });
        }
      }
      if (!next.enable_memory_editing && file && isMemoryDocument(file.path)) {
        if (docDirty) {
          const disabledFile = { ...file, editable: false };
          memoryDraftRecoveryRef.current = { draft, file: disabledFile };
          setFile(disabledFile);
          setConflict(
            "Memory editing was disabled. Your unsaved draft is preserved; enable it in Configuration to save.",
          );
        } else {
          setFile(null);
          setDraft("");
          setConflict("");
        }
      }
      const [treeResponse, activityResponse] = await Promise.all([
        api.loadTree().catch(() => null),
        api.loadActivity().catch(() => null),
      ]);
      if (treeResponse) {
        setTree(treeResponse.entries);
        setTreeTruncated(treeResponse.truncated);
      }
      if (activityResponse) setActivity(activityResponse);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        handleUnauthorized();
      } else {
        setConfigurationError(
          caught instanceof ApiError &&
            caught.payload?.error === "memory_unavailable"
            ? "Memory editing could not be enabled because the Hermes memories directory is unavailable."
            : caught instanceof Error
              ? caught.message
              : "Workspace settings could not be saved.",
        );
      }
    } finally {
      setSettingsSaving(false);
    }
  }

  if (!authReady)
    return (
      <main className="grid min-h-dvh place-items-center bg-base-300 p-4 text-base-content">
        <p
          className="flex items-center gap-3 text-sm text-base-content/60"
          role="status"
        >
          <span
            aria-hidden="true"
            className="loading loading-spinner loading-sm text-primary"
          />
          Loading workspace...
        </p>
      </main>
    );

  if (authRequired && needsLogin)
    return (
      <LoginScreen
        authProvider={authProvider}
        error={authError}
        onGoogleSignIn={() => void submitGoogleSignIn()}
        onSubmit={() => void submitLogin()}
        password={password}
        setPassword={setPassword}
        submitting={authSubmitting}
      />
    );

  return (
    <main className="workspace-app">
      <WorkspaceHeader
        activeTab={activeTab}
        authRequired={authRequired}
        currentLink={currentLink}
        file={activeTab === "documents" ? (file ?? artifact) : null}
        filesButtonRef={filesButtonRef}
        git={git}
        onOpenFiles={() => setFilesOpen(true)}
        onOpenDocuments={requestOpenDocuments}
        onOpenCalendar={() => requestOpenFile("calendar/reminders.rem")}
        onOpenGoTo={() => setIsGoToOpen(true)}
        onSignOut={requestSignOut}
        onTabChange={requestTabChange}
      />

      {workspaceError && (
        <ErrorMessage
          error={workspaceError}
          onRetry={() => void loadWorkspace()}
        />
      )}

      {activeTab === "configuration" ? (
        <ConfigurationPage
          error={configurationError}
          exporting={exporting}
          onExport={() => void handleExport()}
          onSettingsChange={(key, value) =>
            void handleSettingsChange(key, value)
          }
          savingSettings={settingsSaving}
          settings={settings}
          systemInfo={systemInfo}
        />
      ) : activeTab === "documents" ? (
        <div
          className={`workspace-layout ${
            detailsOpen
              ? "xl:grid-cols-[clamp(18rem,22vw,22rem)_minmax(0,1fr)_clamp(16rem,20vw,20rem)]"
              : "xl:grid-cols-[clamp(18rem,22vw,22rem)_minmax(0,1fr)]"
          }`}
        >
          <FileNavigator
            entries={tree}
            filter={filter}
            loading={loading}
            mobileOpen={filesOpen}
            onClose={() => {
              setFilesOpen(false);
              filesButtonRef.current?.focus();
            }}
            onDeleteFile={(path) => requestDelete(path)}
            downloadUrl={api.downloadUrl}
            onFilterChange={handleFilterChange}
            onMoveFile={(path) => requestMove(path)}
            onOpenFile={requestOpenFile}
            onRenameFile={(path) => requestRename(path)}
            onRetry={() => void loadWorkspace()}
            rawUrl={api.rawUrl}
            revealToken={revealToken}
            selectedPath={file?.path ?? artifact?.path}
            truncated={treeTruncated}
            workspaceError={workspaceError}
          />
          <DocumentPane
            activity={activity}
            activityLoading={activityLoading}
            artifact={artifact}
            conflict={conflict}
            deleting={deleting}
            detailsOpen={detailsOpen}
            diagnostics={diagnostics}
            diagnosticsLoading={diagnosticsLoading}
            diff={diff}
            documentError={documentError}
            draft={draft}
            file={file}
            fileLoading={fileLoading}
            otherCalendarFiles={otherCalendarFiles}
            onLoadInclude={handleLoadInclude}
            onCloseFiles={() => setFilesOpen(true)}
            onDelete={() => requestDelete()}
            onDownload={() => {
              const path = file?.path ?? artifact?.path;
              if (path) window.location.href = api.downloadUrl(path);
            }}
            onDraftChange={setDraft}
            onMove={() => requestMove()}
            onNavigateLink={handleNavigateLink}
            onOpenDetails={openHeaderDetails}
            onOpenFile={requestOpenFile}
            onOpenGitActivity={() => requestTabChange("git-activity")}
            onRename={() => requestRename()}
            onRefreshActivity={() => {
              setActivityLoading(true);
              setDiagnosticsLoading(true);
              Promise.all([
                api
                  .loadActivity()
                  .then((res) => setActivity(res))
                  .catch(() => {}),
                api
                  .loadDiagnostics()
                  .then((res) => setDiagnostics(res))
                  .catch(() => {}),
              ]).finally(() => {
                setActivityLoading(false);
                setDiagnosticsLoading(false);
              });
            }}
            onRevealInTree={file || artifact ? handleRevealInTree : undefined}
            onRetry={() => {
              const pathToRetry =
                file?.path ??
                artifact?.path ??
                (typeof window !== "undefined"
                  ? parseRoute(window.location).path
                  : undefined);
              if (pathToRetry)
                void openFile(pathToRetry, { requestedView: view });
            }}
            onSave={() => void save()}
            totalDocuments={tree.filter((e) => e.kind === "file").length}
            onViewChange={handleViewChange}
            rawUrl={api.rawUrl}
            downloadUrl={api.downloadUrl}
            saving={saving}
            view={view}
          />
          {detailsOpen && (
            <div className="hidden min-h-0 xl:block">
              <DocumentInspector diff={diff} draft={draft} file={file} />
            </div>
          )}
        </div>
      ) : activeTab === "skills" ? (
        <div className="workspace-layout xl:grid-cols-[clamp(18rem,22vw,22rem)_minmax(0,1fr)]">
          <div
            className={`fixed inset-y-0 left-0 z-30 min-h-0 min-w-0 w-72 transform bg-base-100 transition-transform xl:static xl:w-full xl:translate-x-0 ${
              filesOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            <SkillsNavigator
              categories={skillCategories}
              filter={skillsFilter}
              loading={skillsLoading}
              onCreateClick={() => setIsCreateSkillOpen(true)}
              onFilterChange={setSkillsFilter}
              onSelectSkill={requestOpenSkill}
              onTogglePin={(id, pinned) =>
                void handleToggleSkillPin(id, pinned)
              }
              selectedSkillId={selectedSkillId}
              skills={skills}
            />
          </div>

          {filesOpen && (
            <button
              aria-label="Close skills navigator"
              className="fixed inset-0 z-20 bg-black/40 xl:hidden"
              onClick={() => setFilesOpen(false)}
              type="button"
            />
          )}

          {selectedSkillDetail ? (
            <SkillDetailPane
              activeSubTab={activeSkillSubTab}
              draftContent={skillDraft}
              error={skillError}
              isSaving={skillSaving || skillFileLoading}
              onDismissError={() => setSkillError("")}
              onDraftChange={setSkillDraft}
              onNavigateLink={handleNavigateLink}
              onResetFile={() => {
                if (selectedSkillFile) setSkillDraft(selectedSkillFile.content);
              }}
              onSaveFile={() => void saveSkillFile()}
              onSelectFile={(f) => void openSkillFile(f)}
              onSubTabChange={setActiveSkillSubTab}
              onToggleEnable={(en) => void handleToggleSkillEnable(en)}
              onTogglePin={(pin) => {
                if (selectedSkillDetail)
                  void handleToggleSkillPin(selectedSkillDetail.id, pin);
              }}
              onViewChange={setView}
              selectedFile={selectedSkillFile}
              skill={selectedSkillDetail}
              view={view}
            />
          ) : (
            <div className="workspace-document items-center justify-center overflow-auto p-8 text-center">
              <div className="max-w-md space-y-3">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
                  <svg
                    className="h-6 w-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    viewBox="0 0 24 24"
                  >
                    <title>Skills Management</title>
                    <path
                      d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <h2 className="text-xl font-bold">Skills Management</h2>
                <p className="text-sm text-base-content/60">
                  Select a skill from the sidebar to inspect its instructions
                  and files, or scaffold a new skill.
                </p>
                <button
                  className="btn btn-primary btn-sm mt-2"
                  onClick={() => setIsCreateSkillOpen(true)}
                  type="button"
                >
                  Create New Skill
                </button>
              </div>
            </div>
          )}
        </div>
      ) : activeTab === "ingestion" ? (
        <div className="workspace-layout xl:grid-cols-1">
          <IngestionSection
            detail={ingestionDetail}
            detailLoading={ingestionDetailLoading}
            loading={ingestionLoading}
            onOpenFile={requestOpenFile}
            onRefresh={() => {
              setIngestionLoading(true);
              Promise.all([
                api
                  .loadIngestion()
                  .then(setIngestion)
                  .catch(() => {}),
                ingestionDetail?.intake.intake_id
                  ? api
                      .loadIngestionDetail(ingestionDetail.intake.intake_id)
                      .then(setIngestionDetail)
                      .catch(() => {})
                  : Promise.resolve(),
              ]).finally(() => setIngestionLoading(false));
            }}
            onSelect={requestIngestion}
            overview={ingestion}
            rawUrl={api.rawUrl}
          />
        </div>
      ) : activeTab === "migration" ? (
        <div className="workspace-layout xl:grid-cols-1">
          <MigrationSection
            migrationDetail={migrationDetail}
            migrationsList={migrationsList}
            loading={migrationLoading}
            onSelectMigration={(id) => requestMigration(id)}
            onBack={() => requestMigration()}
            onRefresh={refreshMigrations}
            onWakeWorker={async () => {
              if (!selectedMigrationId) return;
              try {
                await api.wakeMigration(selectedMigrationId);
                await refreshMigrations(selectedMigrationId);
              } catch (err) {
                console.error("Wake error", err);
              }
            }}
            onStop={async () => {
              if (!selectedMigrationId) return;
              try {
                await api.stopMigration(selectedMigrationId);
                await refreshMigrations(selectedMigrationId);
              } catch (err) {
                console.error("Stop error", err);
              }
            }}
            onResume={async () => {
              if (!selectedMigrationId) return;
              try {
                await api.resumeMigration(selectedMigrationId);
                await refreshMigrations(selectedMigrationId);
              } catch (err) {
                console.error("Resume error", err);
              }
            }}
            onApprove={async (revId) => {
              if (!selectedMigrationId) return;
              try {
                await api.approveMigration(selectedMigrationId, revId);
                await refreshMigrations();
              } catch (err) {
                console.error("Approve error", err);
                throw err;
              }
            }}
            onDiscard={async () => {
              if (!selectedMigrationId) return;
              try {
                await api.discardMigration(selectedMigrationId);
                await refreshMigrations();
              } catch (err) {
                console.error("Discard error", err);
                throw err;
              }
            }}
            onSubmitFeedback={async (req) => {
              if (!selectedMigrationId) return;
              await api.submitMigrationFeedback(selectedMigrationId, req);
              await refreshMigrations();
            }}
          />
        </div>
      ) : (
        <div className="workspace-layout xl:grid-cols-1">
          <GitActivitySection
            activity={activity}
            git={git}
            loading={activityLoading}
            onOpenFile={requestOpenFile}
            onRefresh={() => {
              setActivityLoading(true);
              api
                .loadActivity()
                .then((res) => setActivity(res))
                .catch(() => {})
                .finally(() => setActivityLoading(false));
            }}
          />
        </div>
      )}

      {pendingAction && (
        <DirtyDraftDialog
          actionLabel={
            pendingAction.kind === "open"
              ? "opening another file"
              : pendingAction.kind === "openSkill"
                ? "opening another skill"
                : pendingAction.kind === "switchTab"
                  ? "switching view mode"
                  : "signing out"
          }
          onCancel={() => setPendingAction(null)}
          onDiscard={discardAndContinue}
          onSave={() => void saveAndContinue()}
          saving={saving || skillSaving}
        />
      )}

      {pendingDelete && (
        <DeleteFileDialog
          deleting={deleting}
          dirty={pendingDelete.dirty}
          filePath={pendingDelete.path}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void deleteFile()}
        />
      )}

      {pendingRename && (
        <RenameFileDialog
          error={renameError}
          filePath={pendingRename.path}
          onCancel={() => {
            setPendingRename(null);
            setRenameError("");
          }}
          onRename={(newName) => void handleRename(newName)}
          renaming={renaming}
        />
      )}

      {pendingMove && (
        <MoveFileDialog
          directories={directories}
          error={moveError}
          filePath={pendingMove.path}
          moving={moving}
          onCancel={() => {
            setPendingMove(null);
            setMoveError("");
          }}
          onMove={(destinationPath) => void handleMove(destinationPath)}
        />
      )}

      <CreateSkillModal
        categories={skillCategories}
        isOpen={isCreateSkillOpen}
        onClose={() => setIsCreateSkillOpen(false)}
        onCreate={handleCreateSkill}
      />

      <GoToModal
        isOpen={isGoToOpen}
        onClose={() => setIsGoToOpen(false)}
        onNavigateGitActivity={() => requestTabChange("git-activity")}
        onNavigateSkill={(id, skillFile) => requestOpenSkill(id, skillFile)}
        onNavigateWorkspace={(path) => requestOpenFile(path)}
        skills={skills}
        tree={tree}
      />
    </main>
  );
}
