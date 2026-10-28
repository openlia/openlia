import { Renderer } from "@openuidev/react-lang";
import { CHART_THEME } from "../../openui/charts/palette";
import { ThemeProvider } from "@openuidev/react-ui";
import "@openuidev/react-ui/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectSummary,
  WorkspaceProjectResponse,
} from "../../../shared/api";
import type { WorkspaceApi } from "../../api";
import { CopyLinkButton } from "../../components/common/CopyLinkButton";
import { buildCanonicalProjectUri, buildProjectLink } from "../../openliaLinks";
import { OpenLiaOpenUIProvider } from "../../openui/context";
import {
  createOpenLiaLibrary,
  normalizeOpenUIProgram,
} from "../../openui/library";
import { OpenUIDiagnostics } from "../../openui/OpenUIDiagnostics";
import { OpenUIErrorBoundary } from "../../openui/OpenUIErrorBoundary";
import { mutateRecordFrontmatter } from "../../openui/recordMutator";
import { createOpenLiaToolProvider } from "../../openui/toolProvider";
import type { ProjectViewTab } from "../../route";
import { ConfirmChatPromptModal } from "./ConfirmChatPromptModal";

export type { ProjectViewTab } from "../../route";

export function ProjectPage({
  api,
  selectedProjectPath,
  activeView: controlledView,
  onSelectProject,
  onViewChange,
  onOpenFile,
  onCreateFile,
  onAskLia,
}: {
  api: WorkspaceApi;
  selectedProjectPath?: string | undefined;
  activeView?: ProjectViewTab | undefined;
  onSelectProject: (
    projectPath: string,
    options?: { replace?: boolean },
  ) => void;
  onViewChange?: ((view: ProjectViewTab) => void) | undefined;
  onOpenFile: (path: string) => void;
  onCreateFile?: ((domainPath?: string) => void) | undefined;
  onAskLia?: ((prompt: string) => void) | undefined;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectData, setProjectData] =
    useState<WorkspaceProjectResponse | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [error, setError] = useState("");
  const [internalView, setInternalView] = useState<ProjectViewTab>(
    controlledView ?? "ui",
  );
  const [pendingPrompt, setPendingPrompt] = useState<{
    title: string;
    projectName: string;
    prompt: string;
  } | null>(null);

  useEffect(() => {
    if (controlledView) {
      setInternalView(controlledView);
    }
  }, [controlledView]);

  const activeView = controlledView ?? internalView;

  const handleViewChange = useCallback(
    (nextView: ProjectViewTab) => {
      setInternalView(nextView);
      onViewChange?.(nextView);
    },
    [onViewChange],
  );

  const onSelectProjectRef = useRef(onSelectProject);
  onSelectProjectRef.current = onSelectProject;
  const selectedProjectPathRef = useRef(selectedProjectPath);
  selectedProjectPathRef.current = selectedProjectPath;
  const loadRequestSeqRef = useRef(0);

  const loadProjectsList = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const res = await api.loadProjects();
      setProjects(res.projects);
      if (!selectedProjectPathRef.current && res.projects[0]) {
        onSelectProjectRef.current(res.projects[0].path, { replace: true });
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load projects list",
      );
    } finally {
      setProjectsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadProjectsList();
  }, [loadProjectsList]);

  const activePath = selectedProjectPath || projects[0]?.path;

  const loadSelectedProject = useCallback(
    async (path: string, silent = false) => {
      const seq = ++loadRequestSeqRef.current;
      if (!silent) {
        setProjectLoading(true);
        setError("");
      }
      try {
        const data = await api.loadProject(path);
        if (seq !== loadRequestSeqRef.current) return;
        setProjectData(data);
      } catch (err) {
        if (seq !== loadRequestSeqRef.current) return;
        if (!silent) {
          setError(
            err instanceof Error ? err.message : "Failed to load project",
          );
        }
      } finally {
        if (!silent && seq === loadRequestSeqRef.current) {
          setProjectLoading(false);
        }
      }
    },
    [api],
  );

  useEffect(() => {
    if (!activePath) {
      setProjectData(null);
      return;
    }
    void loadSelectedProject(activePath);
  }, [activePath, loadSelectedProject]);

  const handleUpdateRecordFrontmatter = useCallback(
    async (recordPath: string, updates: Record<string, unknown>) => {
      let previousRecords: WorkspaceProjectResponse["records"] | undefined;
      setProjectData((prev) => {
        if (!prev) return prev;
        previousRecords = prev.records;
        return {
          ...prev,
          records: prev.records.map((r) =>
            r.path === recordPath
              ? { ...r, frontmatter: { ...r.frontmatter, ...updates } }
              : r,
          ),
        };
      });

      try {
        const file = await api.loadFile(recordPath);
        const updatedContent = mutateRecordFrontmatter(file.content, updates);
        await api.saveFile(recordPath, updatedContent, file.revision);
        if (activePath) {
          await loadSelectedProject(activePath, true);
        }
      } catch (err) {
        if (previousRecords !== undefined) {
          const snapshot = previousRecords;
          setProjectData((prev) =>
            prev ? { ...prev, records: snapshot } : prev,
          );
        }
        setError(
          err instanceof Error
            ? err.message
            : "Failed to update record frontmatter",
        );
      }
    },
    [api, activePath, loadSelectedProject],
  );

  const requestPromptConfirmation = useCallback(
    (title: string, projectName: string, prompt: string) => {
      if (!onAskLia) return;
      setPendingPrompt({ title, projectName, prompt });
    },
    [onAskLia],
  );

  const handleImproveUI = useCallback(() => {
    if (!projectData || !onAskLia) return;
    const { project } = projectData;
    const prompt = [
      `Help me improve the "${project.name}" mini-project UI in \`${project.path}/\`.`,
      `Please review \`${project.manifest_path}\` and \`${project.ui_path}\`${project.schema_path ? ` (schema: \`${project.schema_path}\`)` : ""} using the workspace-template-customization skill.`,
    ].join(" ");
    requestPromptConfirmation("Improve UI with Lia", project.name, prompt);
  }, [projectData, onAskLia, requestPromptConfirmation]);

  const scopedLibrary = useMemo(() => {
    const runtimeData = {
      records: projectData?.records ?? [],
      queries: projectData?.queries ?? {},
    };
    return createOpenLiaLibrary(runtimeData);
  }, [projectData?.records, projectData?.queries]);

  const toolProvider = useMemo(() => {
    return createOpenLiaToolProvider({
      api,
      domainPath: projectData?.project.path,
      onOpenFile,
    });
  }, [api, projectData?.project.path, onOpenFile]);

  return (
    <section
      aria-label="Projects workspace"
      className="flex min-h-0 flex-1 flex-col lg:flex-row bg-base-100 overflow-hidden"
    >
      {/* Left Sidebar: Mini-Projects Switcher */}
      <aside
        aria-label="Mini-projects list"
        className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-base-content/10 bg-base-200/30 flex flex-col max-h-48 lg:max-h-none overflow-y-auto"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-base-content/10">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
              Mini-Projects
            </h2>
            <p className="text-[11px] text-base-content/50">
              Folders with project-manifest.toml
            </p>
          </div>
          <span className="badge badge-ghost badge-xs font-mono">
            {projects.length}
          </span>
        </div>

        {projectsLoading && projects.length === 0 ? (
          <div className="p-4 text-xs text-base-content/60 flex items-center gap-2">
            <span className="loading loading-spinner loading-xs" />
            <span>Loading projects...</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="p-4 text-xs text-base-content/60 space-y-2">
            <p>No mini-projects found in this workspace.</p>
            {onAskLia && (
              <button
                className="btn btn-primary btn-xs w-full"
                onClick={() =>
                  requestPromptConfirmation(
                    "Create Project with Lia",
                    "Workspace",
                    "Help me create a new mini-project with a project-manifest.toml and ui.openui.",
                  )
                }
                type="button"
              >
                Create Project with Lia
              </button>
            )}
          </div>
        ) : (
          <ul className="menu menu-sm p-2 gap-1">
            {projects.map((proj) => {
              const isSelected = proj.path === activePath;
              return (
                <li key={proj.path}>
                  <button
                    aria-current={isSelected ? "page" : undefined}
                    className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left ${
                      isSelected
                        ? "bg-primary text-primary-content font-medium shadow-xs"
                        : "hover:bg-base-200 text-base-content"
                    }`}
                    onClick={() => onSelectProject(proj.path)}
                    type="button"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{proj.name}</div>
                      <div
                        className={`truncate font-mono text-[10px] ${
                          isSelected
                            ? "text-primary-content/80"
                            : "text-base-content/50"
                        }`}
                      >
                        {proj.path}/
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {proj.invalid_record_count > 0 && (
                        <span
                          className="badge badge-warning badge-xs"
                          title={`${proj.invalid_record_count} invalid record(s)`}
                        >
                          !
                        </span>
                      )}
                      <span
                        className={`badge badge-xs font-mono ${
                          isSelected
                            ? "badge-neutral"
                            : "badge-ghost text-base-content/70"
                        }`}
                      >
                        {proj.record_count}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* Main Project Pane */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {error && (
          <div className="alert alert-error rounded-none text-xs py-2 px-4">
            <span>{error}</span>
            {activePath && (
              <button
                className="btn btn-xs btn-ghost"
                onClick={() => void loadSelectedProject(activePath)}
                type="button"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {projectLoading && !projectData ? (
          <div
            className="flex flex-1 items-center justify-center gap-2 text-sm text-base-content/60"
            role="status"
          >
            <span className="loading loading-spinner loading-sm" />
            <span>Loading project...</span>
          </div>
        ) : projectData ? (
          <>
            {/* Project Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-content/10 bg-base-100 px-4 py-3 shrink-0">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-bold text-base-content">
                    {projectData.project.name}
                  </h2>
                  <span className="badge badge-outline badge-xs font-mono">
                    {projectData.project.path}/
                  </span>
                  <CopyLinkButton
                    className="btn btn-ghost btn-xs btn-square text-base-content/60"
                    iconOnly
                    link={buildProjectLink(projectData.project.path)}
                    size="xs"
                    title={`Copy project link (${buildCanonicalProjectUri(projectData.project.path)})`}
                  />
                </div>
                {projectData.project.description && (
                  <p className="text-xs text-base-content/65 mt-0.5 line-clamp-1">
                    {projectData.project.description}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* View Switcher: UI View vs Project Files */}
                <div
                  aria-label="Project view mode"
                  className="join border border-base-content/15 rounded-lg p-0.5 bg-base-200/50"
                  role="toolbar"
                >
                  <button
                    aria-pressed={activeView === "ui"}
                    className={`btn btn-xs join-item ${
                      activeView === "ui" ? "btn-primary" : "btn-ghost"
                    }`}
                    onClick={() => handleViewChange("ui")}
                    type="button"
                  >
                    Project UI
                  </button>
                  <button
                    aria-pressed={activeView === "files"}
                    className={`btn btn-xs join-item ${
                      activeView === "files" ? "btn-primary" : "btn-ghost"
                    }`}
                    onClick={() => handleViewChange("files")}
                    type="button"
                  >
                    Project Files
                  </button>
                </div>

                {/* Manifest Quick Prompts */}
                {(projectData.manifest.logic?.prompts ?? []).map((p) => (
                  <button
                    key={p.id}
                    className="btn btn-outline btn-xs"
                    onClick={() =>
                      requestPromptConfirmation(
                        p.label,
                        projectData.project.name,
                        p.prompt,
                      )
                    }
                    title={p.prompt}
                    type="button"
                  >
                    {p.label}
                  </button>
                ))}

                {/* Improve UI with Lia */}
                {onAskLia && (
                  <button
                    className="btn btn-secondary btn-outline btn-xs gap-1"
                    onClick={handleImproveUI}
                    title="Chat with Lia to customize project-manifest.toml or ui.openui"
                    type="button"
                  >
                    <span>Improve UI with Lia</span>
                  </button>
                )}

                {/* + New Record */}
                {onCreateFile && projectData.project.template_path && (
                  <button
                    className="btn btn-primary btn-xs"
                    onClick={() => onCreateFile(projectData.project.path)}
                    type="button"
                  >
                    + New Record
                  </button>
                )}
              </div>
            </div>

            {/* Content Area */}
            {activeView === "files" ? (
              <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
                {/* Project Architecture & Glue Card */}
                <div className="rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-xs space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
                      Project Architecture ({projectData.project.manifest_path})
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        className="btn btn-xs btn-outline"
                        onClick={() =>
                          onOpenFile(projectData.project.manifest_path)
                        }
                        type="button"
                      >
                        Edit project-manifest.toml
                      </button>
                      <button
                        className="btn btn-xs btn-outline"
                        onClick={() => onOpenFile(projectData.project.ui_path)}
                        type="button"
                      >
                        Edit {projectData.manifest.ui.entry}
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                    <div className="rounded-lg border border-base-content/10 bg-base-200/30 p-3 space-y-1">
                      <div className="font-semibold text-base-content/60 uppercase text-[10px]">
                        Data Contract
                      </div>
                      <div>
                        Template:{" "}
                        {projectData.project.template_path ? (
                          <button
                            className="link link-primary font-mono"
                            onClick={() =>
                              onOpenFile(projectData.project.template_path!)
                            }
                            type="button"
                          >
                            {projectData.project.template_path}
                          </button>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div>
                        Schema:{" "}
                        {projectData.project.schema_path ? (
                          <button
                            className="link link-primary font-mono"
                            onClick={() =>
                              onOpenFile(projectData.project.schema_path!)
                            }
                            type="button"
                          >
                            {projectData.project.schema_path}
                          </button>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div>
                        Named Queries:{" "}
                        <span className="font-mono">
                          {Object.keys(
                            projectData.manifest.data.queries ?? {},
                          ).join(", ") || "none"}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-lg border border-base-content/10 bg-base-200/30 p-3 space-y-1">
                      <div className="font-semibold text-base-content/60 uppercase text-[10px]">
                        UI Entry
                      </div>
                      <div>
                        File:{" "}
                        <button
                          className="link link-primary font-mono"
                          onClick={() =>
                            onOpenFile(projectData.project.ui_path)
                          }
                          type="button"
                        >
                          {projectData.project.ui_path}
                        </button>
                      </div>
                      <div>
                        Records Loaded:{" "}
                        <span className="font-mono">
                          {projectData.records.length}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-lg border border-base-content/10 bg-base-200/30 p-3 space-y-1">
                      <div className="font-semibold text-base-content/60 uppercase text-[10px]">
                        Logic & Mutations
                      </div>
                      <div>
                        Skills:{" "}
                        <span className="font-mono">
                          {projectData.project.skills.join(", ") || "none"}
                        </span>
                      </div>
                      <div>
                        Editable Fields:{" "}
                        <span className="font-mono">
                          {(
                            projectData.manifest.logic?.mutations
                              ?.editable_fields ?? []
                          ).join(", ") || "none"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Records List */}
                <div className="rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-xs space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
                    Project Records ({projectData.records.length})
                  </h3>
                  {projectData.records.length === 0 ? (
                    <p className="text-xs text-base-content/50 italic">
                      No records in this project yet.
                    </p>
                  ) : (
                    <div className="divide-y divide-base-content/10">
                      {projectData.records.map((rec) => (
                        <div
                          key={rec.path}
                          className="flex items-center justify-between py-2 text-xs"
                        >
                          <div>
                            <div className="font-medium text-base-content">
                              {rec.title}
                            </div>
                            <div className="font-mono text-[11px] text-base-content/50">
                              {rec.path}
                            </div>
                          </div>
                          <button
                            className="btn btn-ghost btn-xs text-primary"
                            onClick={() => onOpenFile(rec.path)}
                            type="button"
                          >
                            Open in Documents →
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <ThemeProvider
                mode="dark"
                darkTheme={CHART_THEME}
                cssSelector=".workspace-project-ui"
              >
                <OpenLiaOpenUIProvider
                  value={{
                    calendarApi: api,
                    loadFile: (path) => api.loadFile(path),
                    project: projectData.project,
                    manifest: projectData.manifest,
                    queries: projectData.queries,
                    domainPath: projectData.project.path,
                    domainInfo: {
                      path: projectData.project.path,
                      label: projectData.project.name,
                      purpose: projectData.project.description,
                      template_path: projectData.project.template_path,
                      schema_path: projectData.project.schema_path,
                      record_count: projectData.project.record_count,
                      invalid_record_count:
                        projectData.project.invalid_record_count,
                    },
                    records: projectData.records,
                    schemaJson: projectData.schema_json,
                    templateHeadings: projectData.template_headings,
                    onOpenRecord: onOpenFile,
                    onCreateRecord: onCreateFile,
                    onEditOpenUI: () => onOpenFile(projectData.project.ui_path),
                    onImproveUI: handleImproveUI,
                    onUpdateRecordFrontmatter: handleUpdateRecordFrontmatter,
                  }}
                >
                  <div className="workspace-project-ui flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col gap-4">
                    {projectData.renderable === false && (
                      <div
                        className="rounded-xl border border-warning/40 bg-warning/10 p-4 space-y-3 text-xs"
                        role="alert"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="font-bold text-sm text-warning">
                              Project UI cannot render yet
                            </p>
                            <p className="text-base-content/75 mt-0.5">
                              Your project records ({projectData.records.length}
                              ) are safely stored and accessible, but the UI or
                              manifest has structural issues:
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              className="btn btn-xs btn-outline"
                              onClick={() =>
                                onOpenFile(projectData.project.manifest_path)
                              }
                              type="button"
                            >
                              Edit project-manifest.toml
                            </button>
                            <button
                              className="btn btn-xs btn-outline"
                              onClick={() =>
                                onOpenFile(projectData.project.ui_path)
                              }
                              type="button"
                            >
                              Edit {projectData.manifest.ui.entry}
                            </button>
                            <button
                              className="btn btn-xs btn-outline"
                              onClick={() => handleViewChange("files")}
                              type="button"
                            >
                              View Project Files ({projectData.records.length})
                            </button>
                            {onAskLia && (
                              <button
                                className="btn btn-xs btn-primary"
                                onClick={handleImproveUI}
                                type="button"
                              >
                                Fix with Lia
                              </button>
                            )}
                          </div>
                        </div>
                        {projectData.render_errors &&
                          projectData.render_errors.length > 0 && (
                            <ul className="list-disc list-inside font-mono text-warning space-y-0.5">
                              {projectData.render_errors.map((err) => (
                                <li key={err}>{err}</li>
                              ))}
                            </ul>
                          )}
                      </div>
                    )}
                    <OpenUIDiagnostics content={projectData.ui_content} />
                    <OpenUIErrorBoundary
                      key={projectData.project.ui_path}
                      onEditUI={() => onOpenFile(projectData.project.ui_path)}
                      uiPath={projectData.project.ui_path}
                    >
                      <Renderer
                        library={scopedLibrary}
                        response={normalizeOpenUIProgram(
                          projectData.ui_content,
                        )}
                        toolProvider={toolProvider}
                        onAction={(event) => {
                          if (
                            event.type === "OpenRecord" &&
                            event.params?.path
                          ) {
                            onOpenFile(String(event.params.path));
                          } else if (
                            event.type === "CreateDomainRecord" &&
                            onCreateFile
                          ) {
                            onCreateFile(
                              String(
                                event.params?.domain ??
                                  projectData.project.path,
                              ),
                            );
                          } else if (
                            event.type === "UpdateFrontmatter" &&
                            event.params?.path &&
                            event.params?.field
                          ) {
                            void handleUpdateRecordFrontmatter(
                              String(event.params.path),
                              {
                                [String(event.params.field)]:
                                  event.params.value,
                              },
                            );
                          }
                        }}
                      />
                    </OpenUIErrorBoundary>
                  </div>
                </OpenLiaOpenUIProvider>
              </ThemeProvider>
            )}
          </>
        ) : null}
      </main>

      {pendingPrompt && (
        <ConfirmChatPromptModal
          initialPrompt={pendingPrompt.prompt}
          onCancel={() => setPendingPrompt(null)}
          onConfirm={(confirmedPrompt) => {
            setPendingPrompt(null);
            onAskLia?.(confirmedPrompt);
          }}
          projectName={pendingPrompt.projectName}
          title={pendingPrompt.title}
        />
      )}
    </section>
  );
}
