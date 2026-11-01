import { Renderer } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";
import "@openuidev/react-ui/index.css";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type {
  MinionDetail,
  MinionExecutionStep,
  MinionRuntime,
  MinionSummary,
  WorkspaceFile,
} from "../shared/api";
import { extractFormDataFromOpenUIEvent, openUIErrors } from "../shared/openui";
import type { WorkspaceApi } from "./api";
import { CodeEditor } from "./CodeEditor";
import { ResponsiveDrawer } from "./components/common/ResponsiveDrawer";
import { ActionMenu } from "./components/common/ActionMenu";
import { ScrollableToolbar } from "./components/common/ScrollableToolbar";
import { MarkdownPreview } from "./components/editor/MarkdownPreview";
import { buildCanonicalMinionUri } from "./openliaLinks";
import { CHART_THEME } from "./openui/charts/palette";
import { OpenLiaOpenUIProvider } from "./openui/context";
import { normalizeOpenUIProgram, openliaLibrary } from "./openui/library";
import { OpenUIDiagnostics } from "./openui/OpenUIDiagnostics";
import { OpenUIErrorBoundary } from "./openui/OpenUIErrorBoundary";

export { extractFormDataFromOpenUIEvent };

export type MinionSubTab =
  | "dashboard"
  | "input"
  | "config"
  | "data"
  | "code"
  | "readme";

function resizeQuickInput(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  const borders = element.offsetHeight - element.clientHeight;
  element.style.height = `${element.scrollHeight + borders}px`;
}

interface ExecutionLog {
  kind: "run" | "input" | "heartbeat" | "install" | "test";
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  steps?: MinionExecutionStep[] | undefined;
  timestamp: string;
}

function MinionOpenUIView({
  api,
  code,
  uiFileName,
  testId = "minion-openui-dashboard",
  minion,
  onNavigateLink,
  onAskLia,
  onSubmitFormData,
}: {
  api: WorkspaceApi;
  code: string;
  uiFileName: string;
  testId?: string | undefined;
  minion: MinionDetail;
  onNavigateLink?: ((href: string) => void) | undefined;
  onAskLia?: ((prompt: string) => void) | undefined;
  onSubmitFormData?: ((data: Record<string, unknown>) => void) | undefined;
}) {
  const { normalized, hasErrors } = useMemo(() => {
    const errors = openUIErrors(code);
    return {
      normalized: errors.length ? "" : normalizeOpenUIProgram(code),
      hasErrors: errors.length > 0,
    };
  }, [code]);

  const contextValue = useMemo(
    () => ({
      financeApi: api,
      calendarApi: api,
      loadFile: api.loadFile,
      domainPath: minion.path,
      filePath: `${minion.path}/${uiFileName}`,
      onOpenRecord: onNavigateLink,
      onSendChatPrompt: onAskLia,
    }),
    [api, minion.path, uiFileName, onNavigateLink, onAskLia],
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
    <div className="workspace-inline-openui" data-testid={testId}>
      <ThemeProvider
        mode="dark"
        darkTheme={CHART_THEME}
        cssSelector=".workspace-inline-openui"
      >
        <OpenLiaOpenUIProvider value={contextValue}>
          <OpenUIErrorBoundary
            source={code}
            uiPath={`${minion.path}/${uiFileName}`}
          >
            <Renderer
              library={openliaLibrary}
              response={normalized}
              onAction={(event) => {
                const formData = extractFormDataFromOpenUIEvent(event);
                if (
                  onSubmitFormData &&
                  formData &&
                  Object.keys(formData).length > 0
                ) {
                  onSubmitFormData(formData);
                  return;
                }
                if (event.type === "continue_conversation") {
                  const message =
                    typeof event.params?.message === "string"
                      ? event.params.message
                      : event.humanFriendlyMessage;
                  if (message) onAskLia?.(message);
                } else if (
                  event.type === "open_url" &&
                  typeof event.params?.url === "string"
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
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [titleRow, setTitleRow] = useState<HTMLDivElement | null>(null);
  const [wideActions, setWideActions] = useState(false);
  useEffect(() => {
    if (!titleRow) return;
    // Observe the actual panel: a desktop split pane can be phone-sized too.
    const update = () => setWideActions(titleRow.clientWidth >= 640);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(titleRow);
    return () => observer.disconnect();
  }, [titleRow]);
  const [minions, setMinions] = useState<MinionSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<MinionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [statusNotice, setStatusNotice] = useState("");
  const [filter, setFilter] = useState("");
  const [activeSubTab, setActiveSubTab] = useState<MinionSubTab>("dashboard");

  // Quick input & execution state
  const [selectedActionId, setSelectedActionId] = useState("");
  const [quickInputText, setQuickInputText] = useState("");
  const [quickInputElement, setQuickInputElement] =
    useState<HTMLTextAreaElement | null>(null);
  const quickInputHintId = useId();
  useEffect(() => {
    // Measure once React has committed the controlled draft to the textarea.
    if (quickInputElement?.value === quickInputText)
      resizeQuickInput(quickInputElement);
  }, [quickInputElement, quickInputText]);
  useEffect(() => {
    if (!quickInputElement) return;
    let width = quickInputElement.clientWidth;
    const observer = new ResizeObserver(() => {
      if (quickInputElement.clientWidth === width) return;
      width = quickInputElement.clientWidth;
      resizeQuickInput(quickInputElement);
    });
    observer.observe(quickInputElement);
    return () => observer.disconnect();
  }, [quickInputElement]);
  const [runningState, setRunningState] = useState<
    "idle" | "run" | "input" | "heartbeat" | "install" | "test" | "schedule"
  >("idle");
  const [executionLog, setExecutionLog] = useState<ExecutionLog | null>(null);
  const [formResetKey, setFormResetKey] = useState(0);

  // Dashboard OpenUI editor toggle
  const [editingOpenUI, setEditingOpenUI] = useState(false);
  const [openUIDraft, setOpenUIDraft] = useState("");
  const [openUISaving, setOpenUISaving] = useState(false);

  // Input OpenUI / Schema editor toggle
  const [inputEditorTarget, setInputEditorTarget] = useState<
    "preview" | "input.openui" | "input.schema.json"
  >("preview");
  const [inputOpenUIDraft, setInputOpenUIDraft] = useState("");
  const [inputSchemaDraft, setInputSchemaDraft] = useState("");
  const [inputAssetSaving, setInputAssetSaving] = useState(false);

  // Config / Config Schema editor state
  const [configEditorTarget, setConfigEditorTarget] = useState<
    "config.json" | "config.schema.json"
  >("config.json");
  const [configDraft, setConfigDraft] = useState("");
  const [configSchemaDraft, setConfigSchemaDraft] = useState("");
  const [configSaving, setConfigSaving] = useState(false);
  const [triggerOnNewEntry, setTriggerOnNewEntry] = useState(true);
  const [triggerCron, setTriggerCron] = useState("0 */6 * * *");

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
  const [newMinionHeartbeatSchedule, setNewMinionHeartbeatSchedule] =
    useState("0 */6 * * *");
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
        const dashboardKey =
          res.minion.dashboard_ui_file ??
          res.minion.primary_ui_file ??
          "dashboard.openui";
        setOpenUIDraft(res.minion.ui_contents[dashboardKey] ?? "");
        const inputUiKey = res.minion.input_ui_file ?? "input.openui";
        setInputOpenUIDraft(res.minion.ui_contents[inputUiKey] ?? "");
        setInputSchemaDraft(res.minion.input_schema_content ?? "");
        setConfigDraft(
          res.minion.config_content ??
            `${JSON.stringify(
              res.minion.config ?? {
                trigger: {
                  on_new_entry: res.minion.triggers?.after_entry ?? true,
                  cron:
                    res.minion.triggers?.heartbeat_schedule ?? "0 */6 * * *",
                },
              },
              null,
              2,
            )}\n`,
        );
        setConfigSchemaDraft(res.minion.config_schema_content ?? "");
        setTriggerOnNewEntry(res.minion.triggers?.after_entry ?? true);
        setTriggerCron(res.minion.triggers?.heartbeat_schedule ?? "");
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
      setStatusNotice("");
      setActiveFile(null);
      setEditingOpenUI(false);
      setInputEditorTarget("preview");
      setConfigEditorTarget("config.json");
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
      } else if (selectedMinionFile === "input.openui") {
        setActiveSubTab("input");
      } else if (
        selectedMinionFile === "config.json" ||
        selectedMinionFile === "config.schema.json"
      ) {
        setActiveSubTab("config");
        setConfigEditorTarget(selectedMinionFile);
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

  const dashboardUiFile =
    detail?.dashboard_ui_file ?? detail?.primary_ui_file ?? "dashboard.openui";
  const inputUiFile = detail?.input_ui_file ?? "input.openui";

  async function handleRunQuickInput(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || runningState !== "idle") return;
    setRunningState("run");
    setError("");
    setStatusNotice("");
    try {
      const actionId = activeQuickAction?.id ?? (selectedActionId || "add");
      const trimmed = quickInputText.trim();
      const res =
        actionId === "heartbeat" && !trimmed
          ? await api.runMinionHeartbeat(detail.id)
          : trimmed
            ? await api.submitMinionInput(detail.id, {
                action: actionId,
                input: quickInputText,
              })
            : await api.runMinion(detail.id, {
                action: actionId,
                input: quickInputText,
              });
      setExecutionLog({
        kind: actionId === "heartbeat" && !trimmed ? "heartbeat" : "run",
        ok: res.ok,
        exit_code: res.exit_code,
        stdout: res.stdout,
        stderr: res.stderr,
        duration_ms: res.duration_ms,
        steps: res.steps,
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

  async function handleSubmitStructuredInput(data: Record<string, unknown>) {
    if (!detail || runningState !== "idle") return;
    setRunningState("input");
    setError("");
    setStatusNotice("");
    try {
      const res = await api.submitMinionInput(detail.id, { data });
      setExecutionLog({
        kind: "input",
        ok: res.ok,
        exit_code: res.exit_code,
        stdout: res.stdout,
        stderr: res.stderr,
        duration_ms: res.duration_ms,
        steps: res.steps,
        timestamp: new Date().toLocaleTimeString(),
      });
      if (res.ok) {
        setFormResetKey((k) => k + 1);
      }
      await loadMinionDetail(detail.id);
      await loadMinionsList();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to submit minion input.",
      );
    } finally {
      setRunningState("idle");
    }
  }

  async function handleRunHeartbeat() {
    if (!detail || runningState !== "idle") return;
    setRunningState("heartbeat");
    setError("");
    setStatusNotice("");
    try {
      const res = await api.runMinionHeartbeat(detail.id);
      setExecutionLog({
        kind: "heartbeat",
        ok: res.ok,
        exit_code: res.exit_code,
        stdout: res.stdout,
        stderr: res.stderr,
        duration_ms: res.duration_ms,
        steps: res.steps,
        timestamp: new Date().toLocaleTimeString(),
      });
      await loadMinionDetail(detail.id);
      await loadMinionsList();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to run minion heartbeat.",
      );
    } finally {
      setRunningState("idle");
    }
  }

  async function handleScheduleHeartbeatCron() {
    if (!detail || runningState !== "idle") return;
    setRunningState("schedule");
    setError("");
    setStatusNotice("");
    try {
      const schedule = detail.triggers?.heartbeat_schedule ?? "0 */6 * * *";
      const runnerCmd =
        detail.runtime === "python"
          ? `python3 ${detail.path}/${detail.entrypoint} --trigger heartbeat`
          : `bun ${detail.path}/${detail.entrypoint} --trigger heartbeat`;
      await api.createCronJob({
        name: `Minion Heartbeat: ${detail.name}`,
        schedule,
        prompt: `Run the heartbeat enrichment for Minion '${detail.name}' (\`${detail.path}\`) by executing \`${runnerCmd}\` and verify \`${detail.path}/${dashboardUiFile}\` is updated.`,
      });
      setStatusNotice(
        `Scheduled heartbeat cron job (${schedule}) for ${detail.name}.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to schedule heartbeat cron job.",
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
      const fullPath = `${detail.path}/${dashboardUiFile}`;
      const loaded = await api.loadFile(fullPath);
      await api.saveFile(fullPath, openUIDraft, loaded.revision);
      await loadMinionDetail(detail.id);
      setEditingOpenUI(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to save dashboard OpenUI file.",
      );
    } finally {
      setOpenUISaving(false);
    }
  }

  async function handleSaveInputAsset() {
    if (!detail || inputAssetSaving || inputEditorTarget === "preview") return;
    setInputAssetSaving(true);
    setError("");
    try {
      const targetRel =
        inputEditorTarget === "input.openui"
          ? inputUiFile
          : (detail.input_schema_file ?? "input.schema.json");
      const draftContent =
        inputEditorTarget === "input.openui"
          ? inputOpenUIDraft
          : inputSchemaDraft;
      const fullPath = `${detail.path}/${targetRel}`;
      const loaded = await api.loadFile(fullPath);
      await api.saveFile(fullPath, draftContent, loaded.revision);
      await loadMinionDetail(detail.id);
      setInputEditorTarget("preview");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : `Failed to save ${inputEditorTarget}.`,
      );
    } finally {
      setInputAssetSaving(false);
    }
  }

  function handleQuickTriggerChange(nextOnNewEntry: boolean, nextCron: string) {
    setTriggerOnNewEntry(nextOnNewEntry);
    setTriggerCron(nextCron);
    try {
      const parsed = configDraft.trim() ? JSON.parse(configDraft) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const nextTrigger: Record<string, unknown> = {
          on_new_entry: nextOnNewEntry,
        };
        if (nextCron.trim()) {
          nextTrigger.cron = nextCron.trim();
        }
        record.trigger = nextTrigger;
        setConfigDraft(`${JSON.stringify(record, null, 2)}\n`);
      }
    } catch {}
  }

  async function handleSaveConfigAsset() {
    if (!detail || configSaving) return;
    setConfigSaving(true);
    setError("");
    setStatusNotice("");
    try {
      if (configEditorTarget === "config.json") {
        let parsed: Record<string, unknown>;
        try {
          const candidate = JSON.parse(configDraft);
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          ) {
            throw new Error("config.json root must be a JSON object");
          }
          parsed = candidate as Record<string, unknown>;
        } catch (err) {
          throw new Error(
            err instanceof Error ? err.message : "Invalid JSON in config.json",
          );
        }
        await api.updateMinionConfig(detail.id, parsed);
        setStatusNotice(`Saved ${detail.path}/config.json.`);
      } else {
        const schemaRel = detail.config_schema_file ?? "config.schema.json";
        const fullPath = `${detail.path}/${schemaRel}`;
        const loaded = await api.loadFile(fullPath);
        await api.saveFile(fullPath, configSchemaDraft, loaded.revision);
        setStatusNotice(`Saved ${fullPath}.`);
      }
      await loadMinionDetail(detail.id);
      await loadMinionsList();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : `Failed to save ${configEditorTarget}.`,
      );
    } finally {
      setConfigSaving(false);
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
        ? '{\n  "items": []\n}\n'
        : cleanRel.endsWith(".csv")
          ? "id,name,notes\n"
          : cleanRel.endsWith(".yaml") || cleanRel.endsWith(".yml")
            ? "items: []\n"
            : `# ${cleanRel}\n`;
      const created = await api.createFile(`${detail.path}/data`, cleanRel, {
        content: initialContent,
      });
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
        heartbeat_schedule: newMinionHeartbeatSchedule.trim() || undefined,
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

  const heartbeatAction = (
    <button
      className={`btn btn-sm ${wideActions ? "btn-outline" : "btn-ghost"}`}
      disabled={runningState !== "idle"}
      onClick={() => void handleRunHeartbeat()}
      type="button"
      data-testid="minion-heartbeat-button"
      title="Run main entrypoint with --trigger heartbeat to enrich data and refresh dashboard.openui"
    >
      {runningState === "heartbeat" ? "Enriching..." : "Run Heartbeat"}
    </button>
  );
  const askLiaAction =
    onAskLia && detail ? (
      <button
        className="btn btn-sm btn-ghost"
        onClick={() =>
          onAskLia(
            `Let's work on the ${detail.name} Minion (${buildCanonicalMinionUri(detail.id)}) in \`${detail.path}/\`. Please review its \`README.md\`, \`${detail.input_entrypoint ?? "input.py"}\`, \`${detail.input_schema_file ?? "input.schema.json"}\`, \`${detail.entrypoint}\`, \`${dashboardUiFile}\`, \`${inputUiFile}\`, and \`data/\` files.`,
          )
        }
        type="button"
      >
        Ask Lia
      </button>
    ) : null;

  return (
    <div
      className="workspace-layout xl:grid-cols-[clamp(18rem,22vw,22rem)_minmax(0,1fr)]"
      data-testid="minions-page"
    >
      {/* Left Sidebar: Minion Selector */}
      <ResponsiveDrawer
        title="Minions"
        open={navigatorOpen}
        onClose={() => setNavigatorOpen(false)}
        className="workspace-sidebar"
      >
        <div className="flex items-center justify-between gap-2 border-b border-base-content/10 p-3">
          <div>
            <h2 className="text-sm font-bold tracking-tight">Minions</h2>
            <p className="text-xs text-base-content/60">
              Programmable workspace apps
            </p>
          </div>
          <button
            className="btn btn-primary btn-xs"
            onClick={() => {
              setNavigatorOpen(false);
              setCreateModalOpen(true);
            }}
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
                onClick={() => {
                  setNavigatorOpen(false);
                  setCreateModalOpen(true);
                }}
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
                  onClick={() => {
                    onSelectMinion(m.id);
                    setNavigatorOpen(false);
                  }}
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
                  <div className="flex flex-wrap items-center gap-1.5 mt-2 text-[11px] text-base-content/50 font-mono">
                    <span>{m.entrypoint}</span>
                    {m.input_entrypoint && (
                      <>
                        <span>•</span>
                        <span>{m.input_entrypoint}</span>
                      </>
                    )}
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
      </ResponsiveDrawer>

      {/* Main Minion Workspace */}
      <section
        className="workspace-document workspace-mobile-page minion-workspace flex flex-col min-h-0 overflow-hidden bg-base-100"
        aria-label="Minion workspace"
      >
        <div className="border-b border-base-content/10 p-2 xl:hidden">
          <button
            type="button"
            className="btn btn-ghost w-full justify-start"
            aria-expanded={navigatorOpen}
            onClick={(event) => {
              event.currentTarget.focus();
              setNavigatorOpen(true);
            }}
          >
            Browse minions{" "}
            <span aria-hidden="true" className="ml-auto">
              ▾
            </span>
          </button>
        </div>
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
        {statusNotice && (
          <div className="alert alert-success m-3 mb-0 py-2 text-xs flex justify-between">
            <span>{statusNotice}</span>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => setStatusNotice("")}
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
          <div className="flex-1 min-h-0 overflow-auto grid place-items-center p-5 sm:p-8 text-center">
            <div className="min-w-0 w-full max-w-md space-y-3">
              <h2 className="text-xl font-bold">Workspace Minions</h2>
              <p className="text-sm text-base-content/60">
                Small apps that collect data, show dashboards, and run
                workflows. Browse your minions or create a new one to get
                started.
              </p>
              <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-center gap-2 pt-2">
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
                        "Let's create a new Minion in minions/! As Project Owner, I want to build a Minion with dashboard.openui, input.openui + input.schema.json + input handler, and main entrypoint for post-entry analysis and heartbeat enrichment.",
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
              <div
                ref={setTitleRow}
                className="minion-title-row flex min-w-0 items-center justify-between gap-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <h2
                    className="min-w-0 truncate text-lg font-bold tracking-tight"
                    title={detail.name}
                  >
                    {detail.name}
                  </h2>
                  <span className="badge badge-sm shrink-0 badge-primary/20 text-primary font-mono">
                    {detail.runtime === "python" ? "Python" : "TypeScript"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {wideActions && (
                    <>
                      {heartbeatAction}
                      {askLiaAction}
                    </>
                  )}
                  <ActionMenu label="Minion actions" className="btn-sm">
                    {!wideActions && (
                      <>
                        {heartbeatAction}
                        {askLiaAction}
                      </>
                    )}
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={runningState !== "idle"}
                      onClick={() => void handleScheduleHeartbeatCron()}
                      type="button"
                      data-testid="minion-schedule-heartbeat"
                      title="Create a scheduled cron job for this Minion's heartbeat trigger"
                    >
                      {runningState === "schedule"
                        ? "Scheduling..."
                        : "Schedule Heartbeat"}
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
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
                      className="btn btn-sm btn-ghost"
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
                  </ActionMenu>
                </div>
              </div>
              <p className="text-xs text-base-content/70">
                {detail.description}
              </p>
              <details className="minion-runtime-details">
                <summary className="cursor-pointer py-2 text-xs text-base-content/60">
                  Runtime & triggers
                </summary>
                <div className="flex flex-wrap gap-2 pb-2">
                  {detail.input_entrypoint && (
                    <span
                      className="badge badge-sm badge-ghost font-mono"
                      title="Input entrypoint"
                    >
                      input: {detail.input_entrypoint}
                    </span>
                  )}
                  <span
                    className="badge badge-sm badge-ghost font-mono"
                    title="Data & enrichment entrypoint"
                  >
                    main: {detail.entrypoint}
                  </span>
                  {detail.triggers?.after_entry !== false && (
                    <span
                      className="badge badge-sm badge-info/20 text-info font-mono"
                      title="main runs automatically right after every new entry"
                    >
                      trigger: after-entry
                    </span>
                  )}
                  {detail.triggers?.heartbeat_schedule && (
                    <span
                      className="badge badge-sm badge-ghost font-mono"
                      title="Recommended cron schedule for heartbeat enrichment"
                    >
                      heartbeat: {detail.triggers.heartbeat_schedule}
                    </span>
                  )}
                </div>
              </details>

              {/* Multiline quick entry stays in the normal page flow. */}
              <form
                onSubmit={(e) => void handleRunQuickInput(e)}
                className="minion-quick-entry flex flex-col gap-2"
                data-testid="minion-quick-input-form"
              >
                {detail.quick_actions.length > 1 ? (
                  <select
                    className="select select-bordered select-sm max-w-full self-start font-medium"
                    aria-label="Input action"
                    value={selectedActionId}
                    onChange={(e) => setSelectedActionId(e.target.value)}
                  >
                    {detail.quick_actions.map((act) => (
                      <option key={act.id} value={act.id}>
                        {act.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                <textarea
                  ref={setQuickInputElement}
                  rows={3}
                  className="textarea textarea-bordered w-full min-w-0"
                  aria-label="Quick input"
                  aria-describedby={quickInputHintId}
                  placeholder={
                    activeQuickAction?.placeholder ?? "Paste or type an entry…"
                  }
                  value={quickInputText}
                  onChange={(e) => setQuickInputText(e.target.value)}
                  readOnly={runningState !== "idle"}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "Enter" ||
                      (!event.ctrlKey && !event.metaKey) ||
                      event.nativeEvent.isComposing
                    )
                      return;
                    event.preventDefault();
                    if (runningState === "idle")
                      event.currentTarget.form?.requestSubmit();
                  }}
                  data-testid="minion-quick-input"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p
                    id={quickInputHintId}
                    className="min-w-0 flex-1 text-xs text-base-content/50"
                  >
                    Enter for a new line · Ctrl/⌘ + Enter to submit
                  </p>
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm ml-auto shrink-0"
                    disabled={runningState !== "idle"}
                    data-testid="minion-run-button"
                  >
                    {runningState === "run" ||
                    runningState === "input" ||
                    runningState === "heartbeat"
                      ? "Running..."
                      : (activeQuickAction?.label ?? "Add Entry")}
                  </button>
                </div>
              </form>

              {/* Execution Log Banner */}
              {executionLog && (
                <div
                  className={`rounded-lg border p-2.5 text-xs font-mono space-y-1.5 ${
                    executionLog.ok
                      ? "border-success/30 bg-success/5"
                      : "border-error/30 bg-error/5"
                  }`}
                  data-testid="minion-execution-log"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        [{executionLog.kind.toUpperCase()}] exit{" "}
                        {executionLog.exit_code} ({executionLog.duration_ms}ms)
                        at {executionLog.timestamp}
                      </span>
                      {executionLog.steps && executionLog.steps.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          {executionLog.steps.map((s, idx) => (
                            <span
                              key={`${s.step}-${s.script}`}
                              className={`badge badge-xs font-mono ${
                                s.exit_code === 0
                                  ? "badge-success/20 text-success"
                                  : "badge-error/20 text-error"
                              }`}
                            >
                              {idx + 1}. {s.step} ({s.script}: {s.duration_ms}
                              ms)
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
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
              <select
                aria-label="Minion section"
                className="workspace-compact-select select select-bordered w-full sm:hidden"
                value={activeSubTab}
                onChange={(event) => {
                  const tab = event.target.value as MinionSubTab;
                  setActiveSubTab(tab);
                  if (
                    tab === "data" &&
                    detail.data_files[0] &&
                    !activeFile?.path.startsWith(`${detail.path}/data/`)
                  )
                    void openMinionFile(detail.id, detail.data_files[0].path);
                  if (tab === "code")
                    void openMinionFile(detail.id, detail.entrypoint);
                }}
              >
                <option value="dashboard">Dashboard</option>
                <option value="input">Input Form</option>
                <option value="config">Config</option>
                <option value="data">Data ({detail.data_file_count})</option>
                <option value="code">Code & Tests</option>
                <option value="readme">README</option>
              </select>
              <div className="workspace-wide-controls hidden sm:flex flex-wrap tabs tabs-boxed bg-base-200/60 p-0.5 w-fit max-w-full">
                <button
                  type="button"
                  className={`tab tab-xs ${activeSubTab === "dashboard" ? "tab-active" : ""}`}
                  onClick={() => setActiveSubTab("dashboard")}
                  data-testid="minion-tab-dashboard"
                >
                  Dashboard ({dashboardUiFile})
                </button>
                <button
                  type="button"
                  className={`tab tab-xs ${activeSubTab === "input" ? "tab-active" : ""}`}
                  onClick={() => setActiveSubTab("input")}
                  data-testid="minion-tab-input"
                >
                  Input Form ({inputUiFile})
                </button>
                <button
                  type="button"
                  className={`tab tab-xs ${activeSubTab === "config" ? "tab-active" : ""}`}
                  onClick={() => setActiveSubTab("config")}
                  data-testid="minion-tab-config"
                >
                  Config ({detail.config_file ?? "config.json"})
                </button>
                <button
                  type="button"
                  className={`tab tab-xs ${activeSubTab === "data" ? "tab-active" : ""}`}
                  onClick={() => {
                    setActiveSubTab("data");
                    if (
                      detail.data_files[0] &&
                      !activeFile?.path.startsWith(`${detail.path}/data/`)
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
            <div className="workspace-mobile-content flex-1 overflow-y-auto p-4 min-h-0">
              {activeSubTab === "dashboard" && (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 min-w-0">
                    <span className="break-all text-xs font-mono text-base-content/60">
                      {detail.path}/{dashboardUiFile}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {detail.ui_contents[inputUiFile] && !editingOpenUI && (
                        <button
                          type="button"
                          className="btn btn-outline btn-xs"
                          onClick={() => setActiveSubTab("input")}
                        >
                          Input form
                          <span className="hidden sm:inline">
                            {" "}
                            ({inputUiFile})
                          </span>
                        </button>
                      )}
                      {editingOpenUI && (
                        <button
                          type="button"
                          className="btn btn-primary btn-xs"
                          disabled={openUISaving}
                          onClick={() => void handleSaveOpenUI()}
                        >
                          {openUISaving
                            ? "Saving..."
                            : `Save ${dashboardUiFile}`}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => setEditingOpenUI((v) => !v)}
                      >
                        {editingOpenUI ? "Preview Dashboard" : "Edit dashboard"}
                      </button>
                    </div>
                  </div>

                  {editingOpenUI ? (
                    <div className="space-y-2">
                      <OpenUIDiagnostics content={openUIDraft} />
                      <div className="workspace-editor-frame h-[28rem] border border-base-content/15 rounded-lg overflow-hidden">
                        <CodeEditor
                          onChange={setOpenUIDraft}
                          filePath={`${detail.path}/${dashboardUiFile}`}
                          value={openUIDraft}
                        />
                      </div>
                    </div>
                  ) : detail.ui_contents[dashboardUiFile] ? (
                    <MinionOpenUIView
                      api={api}
                      code={detail.ui_contents[dashboardUiFile] ?? ""}
                      uiFileName={dashboardUiFile}
                      testId="minion-openui-dashboard"
                      minion={detail}
                      onNavigateLink={onNavigateLink}
                      onAskLia={onAskLia}
                      onSubmitFormData={(formData) =>
                        void handleSubmitStructuredInput(formData)
                      }
                    />
                  ) : (
                    <div className="rounded-xl border border-base-content/10 p-6 text-center text-sm text-base-content/60">
                      No `{dashboardUiFile}` dashboard file found yet. Click{" "}
                      <button
                        type="button"
                        className="link link-primary"
                        onClick={() => setEditingOpenUI(true)}
                      >
                        Edit {dashboardUiFile}
                      </button>{" "}
                      to author `{dashboardUiFile}`.
                    </div>
                  )}
                </div>
              )}

              {activeSubTab === "input" && (
                <div className="space-y-4">
                  <div className="min-w-0 space-y-2">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-base-content/70">
                        <span className="w-full break-all font-mono">
                          {detail.path}/{inputUiFile}
                        </span>
                        {detail.input_schema_file && (
                          <span className="badge badge-xs badge-ghost max-w-full h-auto whitespace-normal break-all font-mono">
                            schema: {detail.input_schema_file}
                          </span>
                        )}
                        {detail.input_entrypoint && (
                          <span className="badge badge-xs badge-ghost max-w-full h-auto whitespace-normal break-all font-mono">
                            handler: {detail.input_entrypoint} -&gt;{" "}
                            {detail.entrypoint} (--trigger entry)
                          </span>
                        )}
                      </div>
                      {inputEditorTarget !== "preview" && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm shrink-0"
                          aria-label={`Save ${inputEditorTarget}`}
                          disabled={inputAssetSaving}
                          onClick={() => void handleSaveInputAsset()}
                        >
                          {inputAssetSaving ? "Saving..." : "Save"}
                        </button>
                      )}
                    </div>
                    <ScrollableToolbar label="Input editor modes">
                      <button
                        type="button"
                        aria-pressed={inputEditorTarget === "preview"}
                        className={`btn btn-xs ${inputEditorTarget === "preview" ? "btn-active" : "btn-ghost"}`}
                        onClick={() => setInputEditorTarget("preview")}
                      >
                        Form Preview
                      </button>
                      <button
                        type="button"
                        aria-pressed={inputEditorTarget === "input.openui"}
                        className={`btn btn-xs ${inputEditorTarget === "input.openui" ? "btn-active" : "btn-ghost"}`}
                        onClick={() => setInputEditorTarget("input.openui")}
                      >
                        Edit {inputUiFile}
                      </button>
                      {detail.input_schema_file && (
                        <button
                          type="button"
                          aria-pressed={
                            inputEditorTarget === "input.schema.json"
                          }
                          className={`btn btn-xs ${inputEditorTarget === "input.schema.json" ? "btn-active" : "btn-ghost"}`}
                          onClick={() =>
                            setInputEditorTarget("input.schema.json")
                          }
                        >
                          Edit {detail.input_schema_file}
                        </button>
                      )}
                    </ScrollableToolbar>
                  </div>

                  {inputEditorTarget === "input.openui" ? (
                    <div className="space-y-2">
                      <OpenUIDiagnostics content={inputOpenUIDraft} />
                      <div className="workspace-editor-frame h-[28rem] border border-base-content/15 rounded-lg overflow-hidden">
                        <CodeEditor
                          onChange={setInputOpenUIDraft}
                          filePath={`${detail.path}/${inputUiFile}`}
                          value={inputOpenUIDraft}
                        />
                      </div>
                    </div>
                  ) : inputEditorTarget === "input.schema.json" ? (
                    <div className="workspace-editor-frame h-[28rem] border border-base-content/15 rounded-lg overflow-hidden">
                      <CodeEditor
                        onChange={setInputSchemaDraft}
                        filePath={`${detail.path}/${detail.input_schema_file ?? "input.schema.json"}`}
                        value={inputSchemaDraft}
                      />
                    </div>
                  ) : detail.ui_contents[inputUiFile] ? (
                    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_22rem] gap-4 items-start">
                      <MinionOpenUIView
                        key={`input-form-${formResetKey}`}
                        api={api}
                        code={detail.ui_contents[inputUiFile] ?? ""}
                        uiFileName={inputUiFile}
                        testId="minion-openui-input"
                        minion={detail}
                        onNavigateLink={onNavigateLink}
                        onAskLia={onAskLia}
                        onSubmitFormData={(formData) =>
                          void handleSubmitStructuredInput(formData)
                        }
                      />
                      {detail.input_schema_content && (
                        <div className="rounded-xl border border-base-content/10 bg-base-200/30 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold">
                              Input Schema (`input.schema.json`)
                            </span>
                            <button
                              type="button"
                              className="btn btn-ghost btn-2xs"
                              onClick={() =>
                                setInputEditorTarget("input.schema.json")
                              }
                            >
                              Edit
                            </button>
                          </div>
                          <pre className="text-[11px] font-mono overflow-x-auto max-h-80 bg-base-300/40 p-2 rounded">
                            {detail.input_schema_content}
                          </pre>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-base-content/10 p-6 text-center text-sm text-base-content/60">
                      No `{inputUiFile}` input form found for this Minion.
                    </div>
                  )}
                </div>
              )}

              {activeSubTab === "config" && (
                <div className="space-y-4" data-testid="minion-config-panel">
                  <div className="rounded-xl border border-base-content/10 bg-base-200/30 p-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/70">
                          Standardized Trigger (`config.json` -&gt; `trigger`)
                        </h3>
                        <p className="text-xs text-base-content/60">
                          `trigger` is required by OpenLia/Hermes. Custom
                          Minion-specific settings (URLs, endpoints, workspace
                          paths, etc.) can be added alongside `trigger` in
                          `config.json` and `config.schema.json`.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 pt-1">
                      <label className="label cursor-pointer gap-2 py-0">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-xs checkbox-primary"
                          checked={triggerOnNewEntry}
                          onChange={(e) =>
                            handleQuickTriggerChange(
                              e.target.checked,
                              triggerCron,
                            )
                          }
                          data-testid="minion-trigger-on-new-entry"
                        />
                        <span className="label-text text-xs font-medium">
                          Trigger `main` after every new entry (`on_new_entry`)
                        </span>
                      </label>

                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-base-content/70">
                          Cron Heartbeat (`cron`):
                        </span>
                        <input
                          type="text"
                          className="input input-bordered input-xs font-mono w-44"
                          placeholder="0 */6 * * *"
                          value={triggerCron}
                          onChange={(e) =>
                            handleQuickTriggerChange(
                              triggerOnNewEntry,
                              e.target.value,
                            )
                          }
                          data-testid="minion-trigger-cron"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0 space-y-2">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex-1 break-all text-xs font-mono text-base-content/70">
                        {detail.path}/{configEditorTarget}
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm shrink-0"
                        disabled={configSaving}
                        onClick={() => void handleSaveConfigAsset()}
                        data-testid="minion-save-config"
                        aria-label={`Save ${configEditorTarget}`}
                      >
                        {configSaving ? "Saving..." : "Save"}
                      </button>
                    </div>
                    <ScrollableToolbar label="Config editor modes">
                      <button
                        type="button"
                        aria-pressed={configEditorTarget === "config.json"}
                        aria-label="Edit config.json (Local Instance)"
                        title="Edit config.json (Local Instance)"
                        className={`btn btn-xs ${configEditorTarget === "config.json" ? "btn-active" : "btn-ghost"}`}
                        onClick={() => setConfigEditorTarget("config.json")}
                      >
                        Edit config.json
                      </button>
                      <button
                        type="button"
                        aria-pressed={
                          configEditorTarget === "config.schema.json"
                        }
                        aria-label="Edit config.schema.json (Packaged Schema)"
                        title="Edit config.schema.json (Packaged Schema)"
                        className={`btn btn-xs ${configEditorTarget === "config.schema.json" ? "btn-active" : "btn-ghost"}`}
                        onClick={() =>
                          setConfigEditorTarget("config.schema.json")
                        }
                      >
                        Edit config.schema.json
                      </button>
                    </ScrollableToolbar>
                  </div>

                  <div className="workspace-editor-frame h-[26rem] border border-base-content/15 rounded-lg overflow-hidden">
                    {configEditorTarget === "config.json" ? (
                      <CodeEditor
                        onChange={setConfigDraft}
                        filePath={`${detail.path}/${detail.config_file ?? "config.json"}`}
                        value={configDraft}
                      />
                    ) : (
                      <CodeEditor
                        onChange={setConfigSchemaDraft}
                        filePath={`${detail.path}/${detail.config_schema_file ?? "config.schema.json"}`}
                        value={configSchemaDraft}
                      />
                    )}
                  </div>
                </div>
              )}

              {activeSubTab === "data" && (
                <div className="minion-file-layout grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-4 h-full min-h-[24rem]">
                  <div className="border border-base-content/10 rounded-lg p-3 space-y-3 flex flex-col">
                    <div className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
                      data/ Files (Nested Supported)
                    </div>
                    <select
                      aria-label="Minion data file"
                      className="select select-bordered w-full lg:hidden"
                      value={
                        detail.data_files.some(
                          (file) => file.path === activeFile?.path,
                        )
                          ? activeFile?.path
                          : ""
                      }
                      onChange={(event) =>
                        void openMinionFile(detail.id, event.target.value)
                      }
                    >
                      <option value="" disabled>
                        {detail.data_files.length
                          ? "Select a data file"
                          : "No data files yet"}
                      </option>
                      {detail.data_files.map((file) => (
                        <option key={file.path} value={file.path}>
                          {file.path.replace(`${detail.path}/`, "")}
                        </option>
                      ))}
                    </select>
                    <div className="hidden lg:block flex-1 overflow-y-auto space-y-1">
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

                  <div className="minion-file-editor border border-base-content/10 rounded-lg flex flex-col min-h-[24rem] overflow-hidden">
                    {fileLoading ? (
                      <div className="p-6 text-xs text-base-content/60">
                        Loading file...
                      </div>
                    ) : activeFile ? (
                      <>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-base-content/10 px-3 py-2 bg-base-200/40">
                          <span className="break-all text-xs font-mono">
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
                        <div className="workspace-editor-frame flex-1 min-h-[20rem]">
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
                <div className="minion-file-layout grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-4 h-full min-h-[24rem]">
                  <div className="border border-base-content/10 rounded-lg p-3 space-y-2 flex flex-col">
                    <div className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
                      Input, Main, Schema & Tests
                    </div>
                    <select
                      aria-label="Minion code file"
                      className="select select-bordered w-full lg:hidden"
                      value={
                        [...detail.code_files, ...detail.test_files].some(
                          (file) => file.path === activeFile?.path,
                        )
                          ? activeFile?.path
                          : ""
                      }
                      onChange={(event) =>
                        void openMinionFile(detail.id, event.target.value)
                      }
                    >
                      <option value="" disabled>
                        Select a code or test file
                      </option>
                      {[...detail.code_files, ...detail.test_files].map(
                        (file) => (
                          <option key={file.path} value={file.path}>
                            {file.path.replace(`${detail.path}/`, "")}
                          </option>
                        ),
                      )}
                    </select>
                    <div className="hidden lg:block flex-1 overflow-y-auto space-y-1">
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

                  <div className="minion-file-editor border border-base-content/10 rounded-lg flex flex-col min-h-[24rem] overflow-hidden">
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
                        <div className="workspace-editor-frame flex-1 min-h-[20rem]">
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
              Scaffolds `minions/&lt;id&gt;/` with `README.md`,{" "}
              `dashboard.openui`, `input.openui`, `input.schema.json`,{" "}
              `input.py`/`input.ts`, `main.py`/`main.ts`, `data/`, and `tests/`.
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
                  placeholder="e.g. Gym Tracker"
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
                  placeholder="Track workouts and get next-exercise recommendations"
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
                    Python (input.py + main.py + requirements.txt)
                  </option>
                  <option value="typescript">
                    TypeScript / Bun (input.ts + main.ts + package.json)
                  </option>
                </select>
              </label>
              <label className="form-control w-full">
                <span className="label-text text-xs font-medium">
                  Heartbeat Cron Schedule
                </span>
                <input
                  type="text"
                  className="input input-bordered input-sm w-full font-mono"
                  placeholder="0 */6 * * *"
                  value={newMinionHeartbeatSchedule}
                  onChange={(e) =>
                    setNewMinionHeartbeatSchedule(e.target.value)
                  }
                />
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
