import { Renderer } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";
import "@openuidev/react-ui/index.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MinionDetail,
  MinionRuntime,
  MinionSummary,
  WorkspaceFile,
} from "../shared/api";
import { openUIErrors } from "../shared/openui";
import type { WorkspaceApi } from "./api";
import { CodeEditor } from "./CodeEditor";
import { MarkdownPreview } from "./components/editor/MarkdownPreview";
import { CHART_THEME } from "./openui/charts/palette";
import { OpenLiaOpenUIProvider } from "./openui/context";
import { normalizeOpenUIProgram, openliaLibrary } from "./openui/library";
import { OpenUIDiagnostics } from "./openui/OpenUIDiagnostics";
import { OpenUIErrorBoundary } from "./openui/OpenUIErrorBoundary";
import { buildCanonicalMinionUri } from "./openliaLinks";

export type MinionSubTab = "dashboard" | "data" | "code" | "readme";

interface ExecutionLog {
  kind: "run" | "install" | "test";
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timestamp: string;
}

function MinionOpenUIView({
  api,
  code,
  minion,
  onNavigateLink,
  onAskLia,
}: {
  api: WorkspaceApi;
  code: string;
  minion: MinionDetail;
  onNavigateLink?: ((href: string) => void) | undefined;
  onAskLia?: ((prompt: string) => void) | undefined;
}) {
  const { normalized, hasErrors } = useMemo(() => {
    const errors = openUIErrors(code);
    return {
      normalized: errors.length ? "" : normalizeOpenUIProgram(code),
      hasErrors: errors.length > 0,
    };
  }, [code]);

  const primaryUiFile = minion.primary_ui_file ?? "ui.openui";

  const contextValue = useMemo(
    () => ({
      financeApi: api,
      calendarApi: api,
      loadFile: api.loadFile,
      domainPath: minion.path,
      filePath: `${minion.path}/${primaryUiFile}`,
      onOpenRecord: onNavigateLink,
      onSendChatPrompt: onAskLia,
    }),
    [api, minion.path, primaryUiFile, onNavigateLink, onAskLia],
  );

  if (hasErrors) {
    return (
      <div
        className="rounded-xl border border-warning/30 bg-warning/5 overflow-hidden"
        data-testid="minion-openui-error"
      >
        <OpenUIDiagnostics content={code} />
        <pre className="m-0 border-t border-warning/20 bg-base-300/50 p-3 text-xs font-mono overflow-x-auto">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className="workspace-inline-openui"
      data-testid="minion-openui-dashboard"
    >
      <ThemeProvider
        mode="dark"
        darkTheme={CHART_THEME}
        cssSelector=".workspace-inline-openui"
      >
        <OpenLiaOpenUIProvider value={contextValue}>
          <OpenUIErrorBoundary
            source={code}
            uiPath={`${minion.path}/${primaryUiFile}`}
          >
            <Renderer
              library={openliaLibrary}
              response={normalized}
              onAction={(event) => {
                if (event.type === "continue_conversation") {
                  const message =
                    typeof event.params.message === "string"
                      ? event.params.message
                      : event.humanFriendlyMessage;
                  if (message) onAskLia?.(message);
                } else if (
                  event.type === "open_url" &&
                  typeof event.params.url === "string"
                ) {
                  onNavigateLink?.(event.params.url);
                }
              }}
            />
          </OpenUIErrorBoundary>
        </OpenLiaOpenUIProvider>
      </ThemeProvider>
    </div>
  );
}

export function MinionsPage({
  api,
  selectedMinionId,
  selectedMinionFile,
  onSelectMinion,
  onOpenFile,
  onNavigateLink,
  onAskLia,
}: {
  api: WorkspaceApi;
  selectedMinionId?: string | undefined;
  selectedMinionFile?: string | undefined;
  onSelectMinion: (minionId?: string, minionFile?: string) => void;
  onOpenFile: (path: string) => void;
  onNavigateLink?: ((href: string) => void) | undefined;
  onAskLia?: ((prompt: string) => void) | undefined;
}) {
  const [minions, setMinions] = useState<MinionSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<MinionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [activeSubTab, setActiveSubTab] = useState<MinionSubTab>("dashboard");

  // Quick input & execution state
  const [selectedActionId, setSelectedActionId] = useState("");
  const [quickInputText, setQuickInputText] = useState("");
  const [runningState, setRunningState] = useState<
    "idle" | "run" | "install" | "test"
  >("idle");
  const [executionLog, setExecutionLog] = useState<ExecutionLog | null>(null);

  // Dashboard OpenUI editor toggle
  const [editingOpenUI, setEditingOpenUI] = useState(false);
  const [openUIDraft, setOpenUIDraft] = useState("");
  const [openUISaving, setOpenUISaving] = useState(false);

  // Selected file editor state (for Data or Code sub-tabs)
  const [activeFile, setActiveFile] = useState<WorkspaceFile | null>(null);
  const [fileDraft, setFileDraft] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);

  // Create new data file state
  const [newDataFilePath, setNewDataFilePath] = useState("");
  const [creatingDataFile, setCreatingDataFile] = useState(false);

  // Create Minion modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newMinionId, setNewMinionId] = useState("");
  const [newMinionName, setNewMinionName] = useState("");
  const [newMinionDesc, setNewMinionDesc] = useState("");
  const [newMinionRuntime, setNewMinionRuntime] =
    useState<MinionRuntime>("python");
  const [creatingMinion, setCreatingMinion] = useState(false);

  const loadMinionsList = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await api.listMinions();
      setMinions(res.minions);
      if (!selectedMinionId && res.minions.length > 0 && res.minions[0]) {
        onSelectMinion(res.minions[0].id);
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to load minions.",
      );
    } finally {
      setListLoading(false);
    }
  }, [api, selectedMinionId, onSelectMinion]);

  const loadMinionDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      setError("");
      try {
        const res = await api.getMinion(id);
        setDetail(res.minion);
        const uiKey = res.minion.primary_ui_file ?? "ui.openui";
        setOpenUIDraft(res.minion.ui_contents[uiKey] ?? "");
        const firstAction = res.minion.quick_actions[0];
        setSelectedActionId(firstAction ? firstAction.id : "add");
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : `Failed to load minion '${id}'.`,
        );
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void loadMinionsList();
  }, [loadMinionsList]);

  useEffect(() => {
    if (selectedMinionId) {
      void loadMinionDetail(selectedMinionId);
      setExecutionLog(null);
      setActiveFile(null);
      setEditingOpenUI(false);
    } else {
      setDetail(null);
    }
  }, [selectedMinionId, loadMinionDetail]);

  const openMinionFile = useCallback(
    async (minionId: string, pathOrRel: string) => {
      const clean = pathOrRel.replace(/^\/+/, "");
      const fullPath = clean.startsWith(`minions/${minionId}/`)
        ? clean
        : `minions/${minionId}/${clean}`;
      setFileLoading(true);
      setError("");
      try {
        const loaded = await api.loadFile(fullPath);
        setActiveFile(loaded);
        setFileDraft(loaded.content);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : `Failed to load file ${pathOrRel}`,
        );
      } finally {
        setFileLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (selectedMinionId && selectedMinionFile) {
      if (selectedMinionFile.startsWith("data/")) {
        setActiveSubTab("data");
      } else if (selectedMinionFile === "README.md") {
        setActiveSubTab("readme");
      } else if (selectedMinionFile.endsWith(".openui")) {
        setActiveSubTab("dashboard");
      } else {
        setActiveSubTab("code");
      }
      void openMinionFile(selectedMinionId, selectedMinionFile);
    }
  }, [selectedMinionId, selectedMinionFile, openMinionFile]);

  const filteredMinions = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return minions;
    return minions.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q),
    );
  }, [minions, filter]);

  const activeQuickAction = useMemo(() => {
    if (!detail) return undefined;
    return (
      detail.quick_actions.find((a) => a.id === selectedActionId) ??
      detail.quick_actions[0]
    );
  }, [detail, selectedActionId]);

  async function handleRunQuickInput(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || runningState !== "idle") return;
    setRunningState("run");
    setError("");
    try {
      const actionId = activeQuickAction?.id ?? (selectedActionId || "add");
      const res = await api.runMinion(detail.id, {
        action: actionId,
        input: quickInputText,
      });
      setExecutionLog({
        kind: "run",
        ok: res.ok,
        exit_code: res.exit_code,
        stdout: res.stdout,
        stderr: res.stderr,
        duration_ms: res.duration_ms,
        timestamp: new Date().toLocaleTimeString(),
      });
      if (res.ok) {
        setQuickInputText("");
      }
      await loadMinionDetail(detail.id);
      await loadMinionsList();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to run minion.",
      );
    } finally {
      setRunningState("idle");
    }
  }

  async function handleInstallDeps() {
    if (!detail || runningState !== "idle") return;
    setRunningState("install");
    setError("");
    try {
      const res = await api.installMinionDependencies(detail.id);
      setExecutionLog({
        kind: "install",
        ok: res.ok,
        exit_code: res.exit_code,
        stdout: res.stdout,
        stderr: res.stderr,
        duration_ms: res.duration_ms,
        timestamp: new Date().toLocaleTimeString(),
      });
      await loadMinionDetail(detail.id);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to install minion dependencies.",
      );
    } finally {
      setRunningState("idle");
    }
  }

  async function handleRunTests() {
    if (!detail || runningState !== "idle") return;
    setRunningState("test");
    setError("");
    try {
      const res = await api.testMinion(detail.id);
      setExecutionLog({
        kind: "test",
        ok: res.ok,
        exit_code: res.exit_code,
        stdout: res.stdout,
        stderr: res.stderr,
        duration_ms: res.duration_ms,
        timestamp: new Date().toLocaleTimeString(),
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to run minion tests.",
      );
    } finally {
      setRunningState("idle");
    }
  }

  async function handleSaveOpenUI() {
    if (!detail || openUISaving) return;
    setOpenUISaving(true);
    setError("");
    try {
      const openuiRel = detail.primary_ui_file ?? "ui.openui";
      const fullPath = `${detail.path}/${openuiRel}`;
      const loaded = await api.loadFile(fullPath);
      await api.saveFile(fullPath, openUIDraft, loaded.revision);
      await loadMinionDetail(detail.id);
      setEditingOpenUI(false);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to save OpenUI file.",
      );
    } finally {
      setOpenUISaving(false);
    }
  }

  async function handleSaveActiveFile() {
    if (!activeFile || !detail || fileSaving) return;
    setFileSaving(true);
    setError("");
    try {
      const saved = await api.saveFile(
        activeFile.path,
        fileDraft,
        activeFile.revision,
      );
      setActiveFile({
        ...activeFile,
        content: fileDraft,
        revision: saved.revision,
        modified_at: saved.modified_at,
        size: saved.size,
      });
      await loadMinionDetail(detail.id);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to save file.",
      );
    } finally {
      setFileSaving(false);
    }
  }

  async function handleCreateDataFile(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !newDataFilePath.trim() || creatingDataFile) return;
    setCreatingDataFile(true);
    setError("");
    try {
      const cleanRel = newDataFilePath
        .trim()
        .replace(/^\/+/, "")
        .replace(/^data\//, "");
      const initialContent = cleanRel.endsWith(".json")
        ? "{\n  \"items\": []\n}\n"
        : cleanRel.endsWith(".csv")
          ? "id,name,notes\n"
          : cleanRel.endsWith(".yaml") || cleanRel.endsWith(".yml")
            ? "items: []\n"
            : `# ${cleanRel}\n`;
      const created = await api.createFile(
        `${detail.path}/data`,
        cleanRel,
        { content: initialContent },
      );
      setNewDataFilePath("");
      await loadMinionDetail(detail.id);
      setActiveFile(created);
      setFileDraft(created.content);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to create data file.",
      );
    } finally {
      setCreatingDataFile(false);
    }
  }

  async function handleCreateMinion(e: React.FormEvent) {
    e.preventDefault();
    if (!newMinionId.trim() || creatingMinion) return;
    setCreatingMinion(true);
    setError("");
    try {
      const created = await api.createMinion({
        id: newMinionId.trim().toLowerCase().replace(/\s+/g, "-"),
        name: newMinionName.trim() || newMinionId.trim(),
        description: newMinionDesc.trim() || undefined,
        runtime: newMinionRuntime,
      });
      setCreateModalOpen(false);
      setNewMinionId("");
      setNewMinionName("");
      setNewMinionDesc("");
      await loadMinionsList();
      onSelectMinion(created.minion.id);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to create minion.",
      );
    } finally {
      setCreatingMinion(false);
    }
  }

  return (
    <div
      className="workspace-layout xl:grid-cols-[clamp(18rem,22vw,22rem)_minmax(0,1fr)]"
      data-testid="minions-page"
    >
      {/* Left Sidebar: Minion Selector */}
      <aside className="workspace-sidebar flex flex-col border-r border-base-content/10 bg-base-100 min-h-0">
        <div className="flex items-center justify-between gap-2 border-b border-base-content/10 p-3">
          <div>
            <h2 className="text-sm font-bold tracking-tight">Minions</h2>
            <p className="text-xs text-base-content/60">
              Programmable workspace apps
            </p>
          </div>
          <button
            className="btn btn-primary btn-xs"
            onClick={() => setCreateModalOpen(true)}
            type="button"
            data-testid="create-minion-button"
          >
            + New Minion
          </button>
        </div>

        <div className="p-2 border-b border-base-content/10">
          <input
            className="input input-bordered input-xs w-full"
            placeholder="Filter minions..."
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {listLoading ? (
            <div className="p-4 text-center text-xs text-base-content/60">
              Loading minions...
            </div>
          ) : filteredMinions.length === 0 ? (
            <div className="p-4 text-center text-xs text-base-content/60 space-y-2">
              <p>No minions found in `minions/`.</p>
              <button
                className="btn btn-outline btn-xs"
                onClick={() => setCreateModalOpen(true)}
                type="button"
              >
                Create Starter Minion
              </button>
            </div>
          ) : (
            filteredMinions.map((m) => {
              const selected = m.id === selectedMinionId;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onSelectMinion(m.id)}
                  className={`w-full text-left rounded-lg p-2.5 transition-colors border ${
                    selected
                      ? "bg-primary/10 border-primary/30 text-base-content"
                      : "border-transparent hover:bg-base-200/70 text-base-content/80"
                  }`}
                  data-testid={`minion-item-${m.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm truncate">
                      {m.name}
                    </span>
                    <span className="badge badge-xs badge-ghost font-mono">
                      {m.runtime === "python" ? "py" : "ts"}
                    </span>
                  </div>
                  <p className="text-xs text-base-content/60 line-clamp-2 mt-0.5">
                    {m.description}
                  </p>
                  <div className="flex items-center gap-2 mt-2 text-[11px] text-base-content/50 font-mono">
                    <span>{m.entrypoint}</span>
                    <span>•</span>
                    <span>{m.data_file_count} data</span>
                    {m.test_file_count > 0 && (
                      <>
                        <span>•</span>
                        <span>{m.test_file_count} tests</span>
                      </>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Main Minion Workspace */}
      <section className="workspace-document flex flex-col min-h-0 overflow-hidden bg-base-100">
        {error && (
          <div className="alert alert-error m-3 mb-0 py-2 text-xs flex justify-between">
            <span>{error}</span>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => setError("")}
              type="button"
            >
              Dismiss
            </button>
          </div>
        )}

        {detailLoading ? (
          <div className="flex-1 grid place-items-center p-8 text-sm text-base-content/60">
            Loading minion...
          </div>
        ) : !detail ? (
          <div className="flex-1 grid place-items-center p-8 text-center">
            <div className="max-w-md space-y-3">
              <h2 className="text-xl font-bold">Workspace Minions</h2>
              <p className="text-sm text-base-content/60">
                Minions are autonomous workspace apps (`minions/&lt;slug&gt;/`)
                with Python or TypeScript entrypoints, `.openui` dashboards,
                tests, and structured `data/` folders that you and OpenLia build
                together as Project Owner.
              </p>
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setCreateModalOpen(true)}
                  type="button"
                >
                  + Scaffold New Minion
                </button>
                {onAskLia && (
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() =>
                      onAskLia(
                        "Let's create a new Minion in minions/! As Project Owner, I want to build a Minion with an .openui dashboard, main entrypoint, tests, and data/ storage.",
                      )
                    }
                    type="button"
                  >
                    Ask Lia to Build a Minion
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Minion Header & Quick Actions Bar */}
            <div className="border-b border-base-content/10 p-4 space-y-3 bg-base-200/30">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold tracking-tight">
                      {detail.name}
                    </h2>
                    <span className="badge badge-sm badge-primary/20 text-primary font-mono">
                      {detail.runtime === "python" ? "Python" : "TypeScript"}
                    </span>
                    <span className="badge badge-sm badge-ghost font-mono">
                      {detail.path}/{detail.entrypoint}
                    </span>
                  </div>
                  <p className="text-xs text-base-content/70 mt-1">
                    {detail.description}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    className="btn btn-xs btn-outline"
                    disabled={runningState !== "idle"}
                    onClick={() => void handleInstallDeps()}
                    type="button"
                    data-testid="minion-install-deps"
                  >
                    {runningState === "install"
                      ? "Installing..."
                      : "Install Deps"}
                  </button>
                  <button
                    className="btn btn-xs btn-outline"
                    disabled={runningState !== "idle"}
                    onClick={() => void handleRunTests()}
                    type="button"
                    data-testid="minion-run-tests"
                  >
                    {runningState === "test" ? "Testing..." : "Run Tests"}
                  </button>
                  <button
                    className="btn btn-xs btn-ghost"
                    onClick={() => onOpenFile(`${detail.path}/README.md`)}
                    type="button"
                  >
                    Open in Documents
                  </button>
                  {onAskLia && (
                    <button
                      className="btn btn-xs btn-secondary"
                      onClick={() =>
                        onAskLia(
                          `Let's work on the ${detail.name} Minion (${buildCanonicalMinionUri(detail.id)}) in \`${detail.path}/\`. Please review its \`README.md\`, \`${detail.entrypoint}\`, \`${detail.primary_ui_file ?? "ui.openui"}\`, and \`data/\` files.`,
                        )
                      }
                      type="button"
                    >
                      Ask Lia
                    </button>
                  )}
                </div>
              </div>

              {/* Quick Input Form */}
              <form
                onSubmit={(e) => void handleRunQuickInput(e)}
                className="flex flex-wrap items-center gap-2"
                data-testid="minion-quick-input-form"
              >
                {detail.quick_actions.length > 1 ? (
                  <select
                    className="select select-bordered select-xs font-medium"
                    value={selectedActionId}
                    onChange={(e) => setSelectedActionId(e.target.value)}
                  >
                    {detail.quick_actions.map((act) => (
                      <option key={act.id} value={act.id}>
                        {act.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="badge badge-sm badge-neutral font-medium">
                    {activeQuickAction?.label ?? "Quick Input"}
                  </span>
                )}
                <input
                  type="text"
                  className="input input-bordered input-xs flex-1 min-w-[14rem]"
                  placeholder={
                    activeQuickAction?.placeholder ??
                    `Quick input for ${detail.entrypoint}...`
                  }
                  value={quickInputText}
                  onChange={(e) => setQuickInputText(e.target.value)}
                  data-testid="minion-quick-input"
                />
                <button
                  type="submit"
                  className="btn btn-primary btn-xs"
                  disabled={runningState !== "idle"}
                  data-testid="minion-run-button"
                >
                  {runningState === "run" ? "Running..." : "Run"}
                </button>
              </form>

              {/* Execution Log Banner */}
              {executionLog && (
                <div
                  className={`rounded-lg border p-2.5 text-xs font-mono space-y-1 ${
                    executionLog.ok
                      ? "border-success/30 bg-success/5"
                      : "border-error/30 bg-error/5"
                  }`}
                  data-testid="minion-execution-log"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">
                      [{executionLog.kind.toUpperCase()}] exit{" "}
                      {executionLog.exit_code} ({executionLog.duration_ms}ms) at{" "}
                      {executionLog.timestamp}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-2xs"
                      onClick={() => setExecutionLog(null)}
                    >
                      Close
                    </button>
                  </div>
                  {executionLog.stdout && (
                    <pre className="whitespace-pre-wrap overflow-x-auto max-h-40 text-[11px] bg-base-300/40 p-2 rounded">
                      {executionLog.stdout}
                    </pre>
                  )}
                  {executionLog.stderr && (
                    <pre className="whitespace-pre-wrap overflow-x-auto max-h-40 text-[11px] text-error bg-error/10 p-2 rounded">
                      {executionLog.stderr}
                    </pre>
                  )}
                </div>
              )}

              {/* Sub-tab Navigation */}
              <div className="tabs tabs-boxed bg-base-200/60 p-0.5 w-fit">
                <button
                  type="button"
                  className={`tab tab-xs ${activeSubTab === "dashboard" ? "tab-active" : ""}`}
                  onClick={() => setActiveSubTab("dashboard")}
                >
                  Dashboard (.openui)
                </button>
                <button
                  type="button"
                  className={`tab tab-xs ${activeSubTab === "data" ? "tab-active" : ""}`}
                  onClick={() => {
                    setActiveSubTab("data");
                    if (
                      detail.data_files[0] &&
                      (!activeFile ||
                        !activeFile.path.startsWith(`${detail.path}/data/`))
                    ) {
                      void openMinionFile(detail.id, detail.data_files[0].path);
                    }
                  }}
                >
                  Data ({detail.data_file_count})
                </button>
                <button
                  type="button"
                  className={`tab tab-xs ${activeSubTab === "code" ? "tab-active" : ""}`}
                  onClick={() => {
                    setActiveSubTab("code");
                    void openMinionFile(detail.id, detail.entrypoint);
                  }}
                >
                  Code & Tests (
                  {detail.code_files.length + detail.test_files.length})
                </button>
                <button
                  type="button"
                  className={`tab tab-xs ${activeSubTab === "readme" ? "tab-active" : ""}`}
                  onClick={() => setActiveSubTab("readme")}
                >
                  README
                </button>
              </div>
            </div>

            {/* Sub-tab Content */}
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              {activeSubTab === "dashboard" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-base-content/60">
                      {detail.path}/{detail.primary_ui_file ?? "ui.openui"}
                    </span>
                    <div className="flex items-center gap-2">
                      {editingOpenUI && (
                        <button
                          type="button"
                          className="btn btn-primary btn-xs"
                          disabled={openUISaving}
                          onClick={() => void handleSaveOpenUI()}
                        >
                          {openUISaving ? "Saving..." : "Save .openui"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => setEditingOpenUI((v) => !v)}
                      >
                        {editingOpenUI ? "Preview Dashboard" : "Edit .openui"}
                      </button>
                    </div>
                  </div>

                  {editingOpenUI ? (
                    <div className="space-y-2">
                      <OpenUIDiagnostics content={openUIDraft} />
                      <div className="h-[28rem] border border-base-content/15 rounded-lg overflow-hidden">
                        <CodeEditor
                          onChange={setOpenUIDraft}
                          filePath={`${detail.path}/${detail.primary_ui_file ?? "ui.openui"}`}
                          value={openUIDraft}
                        />
                      </div>
                    </div>
                  ) : detail.ui_contents[detail.primary_ui_file ?? "ui.openui"] ? (
                    <MinionOpenUIView
                      api={api}
                      code={
                        detail.ui_contents[
                          detail.primary_ui_file ?? "ui.openui"
                        ] ?? ""
                      }
                      minion={detail}
                      onNavigateLink={onNavigateLink}
                      onAskLia={onAskLia}
                    />
                  ) : (
                    <div className="rounded-xl border border-base-content/10 p-6 text-center text-sm text-base-content/60">
                      No `.openui` dashboard file found yet. Click{" "}
                      <button
                        type="button"
                        className="link link-primary"
                        onClick={() => setEditingOpenUI(true)}
                      >
                        Edit .openui
                      </button>{" "}
                      to create `ui.openui`.
                    </div>
                  )}
                </div>
              )}

              {activeSubTab === "data" && (
                <div className="grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-4 h-full min-h-[24rem]">
                  <div className="border border-base-content/10 rounded-lg p-3 space-y-3 flex flex-col">
                    <div className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
                      data/ Files (Nested Supported)
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-1">
                      {detail.data_files.length === 0 ? (
                        <p className="text-xs text-base-content/50">
                          No files in `data/` yet.
                        </p>
                      ) : (
                        detail.data_files.map((f) => {
                          const isSelected = activeFile?.path === f.path;
                          const shortPath = f.path
                            .replace(new RegExp(`^minions/${detail.id}/`), "")
                            .replace(/^data\//, "");
                          return (
                            <button
                              key={f.path}
                              type="button"
                              onClick={() =>
                                void openMinionFile(detail.id, f.path)
                              }
                              className={`w-full text-left px-2 py-1.5 rounded text-xs font-mono truncate ${
                                isSelected
                                  ? "bg-primary text-primary-content"
                                  : "hover:bg-base-200"
                              }`}
                            >
                              {shortPath}
                            </button>
                          );
                        })
                      )}
                    </div>
                    <form
                      onSubmit={(e) => void handleCreateDataFile(e)}
                      className="space-y-1.5 pt-2 border-t border-base-content/10"
                    >
                      <input
                        type="text"
                        className="input input-bordered input-xs w-full font-mono"
                        placeholder="e.g. 2026/menu.json or log.csv"
                        value={newDataFilePath}
                        onChange={(e) => setNewDataFilePath(e.target.value)}
                      />
                      <button
                        type="submit"
                        className="btn btn-outline btn-xs w-full"
                        disabled={creatingDataFile || !newDataFilePath.trim()}
                      >
                        + Add data/ File
                      </button>
                    </form>
                  </div>

                  <div className="border border-base-content/10 rounded-lg flex flex-col min-h-[24rem] overflow-hidden">
                    {fileLoading ? (
                      <div className="p-6 text-xs text-base-content/60">
                        Loading file...
                      </div>
                    ) : activeFile ? (
                      <>
                        <div className="flex items-center justify-between border-b border-base-content/10 px-3 py-2 bg-base-200/40">
                          <span className="text-xs font-mono">
                            {activeFile.path}
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs"
                              onClick={() => onOpenFile(activeFile.path)}
                            >
                              Open in Documents
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-xs"
                              disabled={
                                fileSaving || fileDraft === activeFile.content
                              }
                              onClick={() => void handleSaveActiveFile()}
                            >
                              {fileSaving ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </div>
                        <div className="flex-1 min-h-[20rem]">
                          <CodeEditor
                            onChange={setFileDraft}
                            filePath={activeFile.path}
                            value={fileDraft}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="p-6 text-xs text-base-content/60">
                        Select a `data/` file to inspect or edit.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeSubTab === "code" && (
                <div className="grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-4 h-full min-h-[24rem]">
                  <div className="border border-base-content/10 rounded-lg p-3 space-y-2 flex flex-col">
                    <div className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
                      Entrypoint, Scripts & Tests
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-1">
                      {[...detail.code_files, ...detail.test_files].map((f) => {
                        const isSelected = activeFile?.path === f.path;
                        const shortPath = f.path.replace(
                          new RegExp(`^minions/${detail.id}/`),
                          "",
                        );
                        return (
                          <button
                            key={f.path}
                            type="button"
                            onClick={() =>
                              void openMinionFile(detail.id, f.path)
                            }
                            className={`w-full text-left px-2 py-1.5 rounded text-xs font-mono truncate ${
                              isSelected
                                ? "bg-primary text-primary-content"
                                : "hover:bg-base-200"
                            }`}
                          >
                            {shortPath}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="border border-base-content/10 rounded-lg flex flex-col min-h-[24rem] overflow-hidden">
                    {fileLoading ? (
                      <div className="p-6 text-xs text-base-content/60">
                        Loading file...
                      </div>
                    ) : activeFile ? (
                      <>
                        <div className="flex items-center justify-between border-b border-base-content/10 px-3 py-2 bg-base-200/40">
                          <span className="text-xs font-mono">
                            {activeFile.path}
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="btn btn-primary btn-xs"
                              disabled={
                                fileSaving || fileDraft === activeFile.content
                              }
                              onClick={() => void handleSaveActiveFile()}
                            >
                              {fileSaving ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </div>
                        <div className="flex-1 min-h-[20rem]">
                          <CodeEditor
                            onChange={setFileDraft}
                            filePath={activeFile.path}
                            value={fileDraft}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="p-6 text-xs text-base-content/60">
                        Select a code or test file to inspect or edit.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeSubTab === "readme" && (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="btn btn-outline btn-xs"
                      onClick={() => onOpenFile(`${detail.path}/README.md`)}
                    >
                      Edit README in Documents
                    </button>
                  </div>
                  <div className="prose prose-sm max-w-none">
                    <MarkdownPreview
                      content={detail.readme_content}
                      currentFilePath={`${detail.path}/README.md`}
                      onNavigateLink={onNavigateLink}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {/* Create Minion Modal */}
      {createModalOpen && (
        <div className="modal modal-open">
          <div className="modal-box max-w-md space-y-4">
            <h3 className="font-bold text-lg">Create New Minion</h3>
            <p className="text-xs text-base-content/70">
              Scaffolds `minions/&lt;id&gt;/` with `README.md`, entrypoint
              (`main.py` or `main.ts`), dependencies file, `ui.openui`, `data/`,
              and `tests/`.
            </p>
            <form
              onSubmit={(e) => void handleCreateMinion(e)}
              className="space-y-3"
            >
              <label className="form-control w-full">
                <span className="label-text text-xs font-medium">
                  Minion ID (slug)
                </span>
                <input
                  type="text"
                  required
                  className="input input-bordered input-sm w-full font-mono"
                  placeholder="e.g. family-menu, gym-tracker"
                  value={newMinionId}
                  onChange={(e) => setNewMinionId(e.target.value)}
                  data-testid="new-minion-id-input"
                />
              </label>
              <label className="form-control w-full">
                <span className="label-text text-xs font-medium">
                  Display Name
                </span>
                <input
                  type="text"
                  className="input input-bordered input-sm w-full"
                  placeholder="e.g. Family Menu"
                  value={newMinionName}
                  onChange={(e) => setNewMinionName(e.target.value)}
                  data-testid="new-minion-name-input"
                />
              </label>
              <label className="form-control w-full">
                <span className="label-text text-xs font-medium">
                  Description
                </span>
                <input
                  type="text"
                  className="input input-bordered input-sm w-full"
                  placeholder="Weekly meal plan and grocery list tracker"
                  value={newMinionDesc}
                  onChange={(e) => setNewMinionDesc(e.target.value)}
                />
              </label>
              <label className="form-control w-full">
                <span className="label-text text-xs font-medium">Runtime</span>
                <select
                  className="select select-bordered select-sm w-full"
                  value={newMinionRuntime}
                  onChange={(e) =>
                    setNewMinionRuntime(e.target.value as MinionRuntime)
                  }
                >
                  <option value="python">
                    Python (main.py + requirements.txt)
                  </option>
                  <option value="typescript">
                    TypeScript / Bun (main.ts + package.json)
                  </option>
                </select>
              </label>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setCreateModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={creatingMinion || !newMinionId.trim()}
                  data-testid="confirm-create-minion"
                >
                  {creatingMinion ? "Creating..." : "Create Minion"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
