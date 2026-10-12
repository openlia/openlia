import type {
  AuthLoginResponse,
  AuthSessionResponse,
  SkillCreateRequest,
  SkillDetailResponse,
  SkillFileResponse,
  SkillsListResponse,
  SkillSuccessResponse,
  SkillWriteResponse,
  WorkspaceActivityResponse,
  WorkspaceDeleteResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceErrorResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceGitStatus,
  IngestionDetailResponse,
  IngestionOverviewResponse,
  MigrationActionResponse,
  MigrationDetailResponse,
  MigrationFeedbackRequest,
  MigrationListResponse,
  MigrationSummary,
  WorkspaceMoveResponse,
  WorkspaceRenameResponse,
  WorkspaceSettings,
  WorkspaceSystemInfo,
  WorkspaceTreeEntry,
  WorkspaceTreeResponse,
  WorkspaceWriteResponse,
} from "../shared/api";

export class ApiError extends Error {
  readonly status: number;
  readonly payload: WorkspaceErrorResponse | null;

  constructor(status: number, payload: WorkspaceErrorResponse | null) {
    super(payload?.error ?? "request_failed");
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export interface WorkspaceApi {
  loadTree(): Promise<WorkspaceTreeResponse>;
  loadSession(): Promise<AuthSessionResponse>;
  login(password: string): Promise<AuthLoginResponse>;
  logout(): Promise<AuthLoginResponse>;
  loadFile(path: string): Promise<WorkspaceFile>;
  loadFileMetadata(path: string): Promise<WorkspaceFileMetadata>;
  saveFile(
    path: string,
    content: string,
    expectedRevision: string,
  ): Promise<WorkspaceWriteResponse>;
  deleteFile(
    path: string,
    expectedRevision: string,
  ): Promise<WorkspaceDeleteResponse>;
  renameFile(
    path: string,
    newName: string,
    expectedRevision: string,
  ): Promise<WorkspaceRenameResponse>;
  moveFile(
    sourcePath: string,
    destinationPath: string,
    expectedRevision: string,
  ): Promise<WorkspaceMoveResponse>;
  loadDiagnostics(): Promise<WorkspaceDiagnosticsResponse>;
  loadSettings(): Promise<WorkspaceSettings>;
  updateSettings(settings: WorkspaceSettings): Promise<WorkspaceSettings>;
  loadSystemInfo(): Promise<WorkspaceSystemInfo>;
  loadGitStatus(): Promise<WorkspaceGitStatus>;
  loadActivity(): Promise<WorkspaceActivityResponse>;
  loadIngestion(
    options?: { query?: string; status?: string; limit?: number } | undefined,
  ): Promise<IngestionOverviewResponse>;
  loadIngestionDetail(intakeId: string): Promise<IngestionDetailResponse>;
  loadMigrations(): Promise<MigrationSummary[]>;
  loadMigrationDetail(id: string): Promise<MigrationDetailResponse>;
  submitMigrationFeedback(
    id: string,
    req: MigrationFeedbackRequest,
  ): Promise<MigrationActionResponse>;
  approveMigration(
    id: string,
    revisionId: string,
  ): Promise<MigrationActionResponse>;
  discardMigration(id: string): Promise<MigrationActionResponse>;
  stopMigration(id: string): Promise<MigrationActionResponse>;
  resumeMigration(id: string): Promise<MigrationActionResponse>;
  wakeMigration(id: string): Promise<MigrationActionResponse>;
  downloadUrl(path: string): string;
  rawUrl(path: string): string;
  exportWorkspaceUrl(): string;
  downloadWorkspaceExport(): Promise<void>;

  loadSkills(): Promise<SkillsListResponse>;
  loadSkillDetail(id: string): Promise<SkillDetailResponse>;
  loadSkillFile(id: string, path: string): Promise<SkillFileResponse>;
  saveSkillFile(
    id: string,
    path: string,
    content: string,
    expectedRevision: string,
  ): Promise<SkillWriteResponse>;
  toggleSkillEnable(
    id: string,
    enabled: boolean,
  ): Promise<SkillSuccessResponse>;
  toggleSkillPin(id: string, pinned: boolean): Promise<SkillSuccessResponse>;
  createSkill(request: SkillCreateRequest): Promise<SkillSuccessResponse>;
}

type ResponseValidator<T> = (value: unknown) => value is T;

async function requestJson<T>(
  input: string,
  validator: ResponseValidator<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      isErrorResponse(payload) ? payload : null,
    );
  }
  if (!validator(payload)) throw new Error("invalid_api_response");
  return payload;
}

function isErrorResponse(value: unknown): value is WorkspaceErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    value.schema === 1 &&
    "ok" in value &&
    value.ok === false &&
    "error" in value &&
    typeof value.error === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkspaceFileMetadata(
  value: unknown,
): value is WorkspaceFileMetadata {
  return (
    isObject(value) &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    typeof value.modified_at === "string" &&
    typeof value.editable === "boolean"
  );
}

function isWorkspaceTreeEntry(value: unknown): value is WorkspaceTreeEntry {
  return (
    isObject(value) &&
    typeof value.path === "string" &&
    (value.kind === "directory" ||
      (value.kind === "file" && isWorkspaceFileMetadata(value)))
  );
}

function isWorkspaceTreeResponse(
  value: unknown,
): value is WorkspaceTreeResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    Array.isArray(value.entries) &&
    value.entries.every(isWorkspaceTreeEntry) &&
    typeof value.truncated === "boolean"
  );
}

function isAuthSessionResponse(value: unknown): value is AuthSessionResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.auth_required === "boolean" &&
    typeof value.authenticated === "boolean"
  );
}

function isAuthLoginResponse(value: unknown): value is AuthLoginResponse {
  return isObject(value) && value.schema === 1 && value.ok === true;
}

function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  return (
    isWorkspaceFileMetadata(value) &&
    "schema" in value &&
    value.schema === 1 &&
    "content" in value &&
    "revision" in value &&
    typeof value.content === "string" &&
    typeof value.revision === "string"
  );
}

function isWorkspaceFileMetadataResponse(
  value: unknown,
): value is WorkspaceFileMetadata {
  return isWorkspaceFileMetadata(value);
}

function isWorkspaceWriteResponse(
  value: unknown,
): value is WorkspaceWriteResponse {
  return (
    isWorkspaceFileMetadata(value) &&
    "schema" in value &&
    value.schema === 1 &&
    "ok" in value &&
    "revision" in value &&
    value.ok === true &&
    typeof value.revision === "string"
  );
}

function isWorkspaceDeleteResponse(
  value: unknown,
): value is WorkspaceDeleteResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    value.ok === true &&
    typeof value.path === "string"
  );
}

function isWorkspaceRenameResponse(
  value: unknown,
): value is WorkspaceRenameResponse {
  return (
    isWorkspaceFileMetadata(value) &&
    "schema" in value &&
    value.schema === 1 &&
    "ok" in value &&
    value.ok === true &&
    "previous_path" in value &&
    typeof value.previous_path === "string" &&
    "revision" in value &&
    typeof value.revision === "string"
  );
}

function isWorkspaceMoveResponse(
  value: unknown,
): value is WorkspaceMoveResponse {
  return (
    isWorkspaceFileMetadata(value) &&
    "schema" in value &&
    value.schema === 1 &&
    "ok" in value &&
    value.ok === true &&
    "previous_path" in value &&
    typeof value.previous_path === "string" &&
    "revision" in value &&
    typeof value.revision === "string"
  );
}

function isWorkspaceDiagnosticsResponse(
  value: unknown,
): value is WorkspaceDiagnosticsResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.valid === "boolean" &&
    Array.isArray(value.issues)
  );
}

function isWorkspaceGitStatus(value: unknown): value is WorkspaceGitStatus {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.configured === "boolean" &&
    (value.branch === undefined || typeof value.branch === "string") &&
    (value.dirty === undefined || typeof value.dirty === "boolean") &&
    (value.status === undefined || typeof value.status === "string")
  );
}

function isWorkspaceActivityResponse(
  value: unknown,
): value is WorkspaceActivityResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.gitConfigured === "boolean" &&
    (value.branch === undefined || typeof value.branch === "string") &&
    Array.isArray(value.uncommitted) &&
    Array.isArray(value.commits) &&
    Array.isArray(value.recentFiles)
  );
}

function isIngestionOverviewResponse(
  value: unknown,
): value is IngestionOverviewResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.live_available === "boolean" &&
    typeof value.live_stale === "boolean" &&
    isObject(value.counts) &&
    isObject(value.queue_counts) &&
    Array.isArray(value.intakes) &&
    typeof value.total === "number" &&
    typeof value.offset === "number" &&
    typeof value.limit === "number" &&
    typeof value.truncated === "boolean"
  );
}

function isIngestionDetailResponse(
  value: unknown,
): value is IngestionDetailResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.live_available === "boolean" &&
    typeof value.live_stale === "boolean" &&
    isObject(value.intake) &&
    isObject(value.source) &&
    Array.isArray(value.artifacts)
  );
}

function isWorkspaceSettings(value: unknown): value is WorkspaceSettings {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.hide_template_schema_files === "boolean" &&
    typeof value.hide_configuration_files === "boolean"
  );
}

function isWorkspaceSystemInfo(value: unknown): value is WorkspaceSystemInfo {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.openlia_version === "string" &&
    typeof value.openlia_hash === "string" &&
    typeof value.hermes_version === "string" &&
    typeof value.locho_version === "string"
  );
}

function isSkillsListResponse(value: unknown): value is SkillsListResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    Array.isArray(value.skills) &&
    Array.isArray(value.categories)
  );
}

function isSkillDetailResponse(value: unknown): value is SkillDetailResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    isObject(value.skill) &&
    typeof value.skill.id === "string" &&
    typeof value.skill.name === "string"
  );
}

function isSkillFileResponse(value: unknown): value is SkillFileResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.content === "string" &&
    typeof value.revision === "string"
  );
}

function isSkillWriteResponse(value: unknown): value is SkillWriteResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    value.ok === true &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.revision === "string"
  );
}

function isSkillSuccessResponse(value: unknown): value is SkillSuccessResponse {
  return isObject(value) && value.schema === 1 && value.ok === true;
}

export const httpWorkspaceApi: WorkspaceApi = {
  loadTree: () =>
    requestJson<WorkspaceTreeResponse>(
      "/api/workspace/tree",
      isWorkspaceTreeResponse,
    ),
  loadSession: () =>
    requestJson<AuthSessionResponse>(
      "/api/auth/session",
      isAuthSessionResponse,
    ),
  login: (password) =>
    requestJson<AuthLoginResponse>("/api/auth/login", isAuthLoginResponse, {
      body: JSON.stringify({ password }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  logout: () =>
    requestJson<AuthLoginResponse>("/api/auth/logout", isAuthLoginResponse, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  loadFile: (path) =>
    requestJson<WorkspaceFile>(
      `/api/workspace/file?${new URLSearchParams({ path })}`,
      isWorkspaceFile,
    ),
  loadFileMetadata: (path) =>
    requestJson<WorkspaceFileMetadata>(
      `/api/workspace/metadata?${new URLSearchParams({ path })}`,
      isWorkspaceFileMetadataResponse,
    ),
  saveFile: (path, content, expectedRevision) =>
    requestJson<WorkspaceWriteResponse>(
      "/api/workspace/file",
      isWorkspaceWriteResponse,
      {
        body: JSON.stringify({
          content,
          expected_revision: expectedRevision,
          path,
        }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      },
    ),
  deleteFile: (path, expectedRevision) =>
    requestJson<WorkspaceDeleteResponse>(
      "/api/workspace/file",
      isWorkspaceDeleteResponse,
      {
        body: JSON.stringify({
          expected_revision: expectedRevision,
          path,
        }),
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      },
    ),
  renameFile: (path, newName, expectedRevision) =>
    requestJson<WorkspaceRenameResponse>(
      "/api/workspace/rename",
      isWorkspaceRenameResponse,
      {
        body: JSON.stringify({
          expected_revision: expectedRevision,
          new_name: newName,
          path,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  moveFile: (sourcePath, destinationPath, expectedRevision) =>
    requestJson<WorkspaceMoveResponse>(
      "/api/workspace/move",
      isWorkspaceMoveResponse,
      {
        body: JSON.stringify({
          destination_path: destinationPath,
          expected_revision: expectedRevision,
          source_path: sourcePath,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  loadDiagnostics: () =>
    requestJson<WorkspaceDiagnosticsResponse>(
      "/api/workspace/diagnostics",
      isWorkspaceDiagnosticsResponse,
    ),
  loadSettings: () =>
    requestJson<WorkspaceSettings>(
      "/api/workspace/settings",
      isWorkspaceSettings,
    ),
  updateSettings: (settings) =>
    requestJson<WorkspaceSettings>(
      "/api/workspace/settings",
      isWorkspaceSettings,
      {
        body: JSON.stringify(settings),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      },
    ),
  loadSystemInfo: () =>
    requestJson<WorkspaceSystemInfo>("/api/system/info", isWorkspaceSystemInfo),
  loadGitStatus: () =>
    requestJson<WorkspaceGitStatus>(
      "/api/workspace/git/status",
      isWorkspaceGitStatus,
    ),
  loadActivity: () =>
    requestJson<WorkspaceActivityResponse>(
      "/api/workspace/activity",
      isWorkspaceActivityResponse,
    ),
  loadIngestion: (options) => {
    const params = new URLSearchParams();
    if (options?.query) params.set("q", options.query);
    if (options?.status) params.set("status", options.status);
    if (options?.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return requestJson<IngestionOverviewResponse>(
      `/api/workspace/ingestion${query ? `?${query}` : ""}`,
      isIngestionOverviewResponse,
    );
  },
  loadIngestionDetail: (intakeId) =>
    requestJson<IngestionDetailResponse>(
      `/api/workspace/ingestion/${encodeURIComponent(intakeId)}`,
      isIngestionDetailResponse,
    ),
  loadMigrations: async () => {
    const res = await requestJson<MigrationListResponse>(
      "/api/workspace/migration",
      (val): val is MigrationListResponse =>
        isObject(val) && Array.isArray((val as any).migrations),
    );
    return res.migrations;
  },
  loadMigrationDetail: (id) =>
    requestJson<MigrationDetailResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}`,
      (val): val is MigrationDetailResponse =>
        isObject(val) && isObject((val as any).migration),
    ),
  submitMigrationFeedback: (id, req) =>
    requestJson<MigrationActionResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}/feedback`,
      (val): val is MigrationActionResponse =>
        isObject(val) && typeof (val as any).ok === "boolean",
      {
        body: JSON.stringify(req),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  approveMigration: (id, revisionId) =>
    requestJson<MigrationActionResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}/approve`,
      (val): val is MigrationActionResponse =>
        isObject(val) && typeof (val as any).ok === "boolean",
      {
        body: JSON.stringify({ revision_id: revisionId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  discardMigration: (id) =>
    requestJson<MigrationActionResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}/discard`,
      (val): val is MigrationActionResponse =>
        isObject(val) && typeof (val as any).ok === "boolean",
      {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  stopMigration: (id) =>
    requestJson<MigrationActionResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}/stop`,
      (val): val is MigrationActionResponse =>
        isObject(val) && typeof (val as any).ok === "boolean",
      {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  resumeMigration: (id) =>
    requestJson<MigrationActionResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}/resume`,
      (val): val is MigrationActionResponse =>
        isObject(val) && typeof (val as any).ok === "boolean",
      {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  wakeMigration: (id) =>
    requestJson<MigrationActionResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}/wake`,
      (val): val is MigrationActionResponse =>
        isObject(val) && typeof (val as any).ok === "boolean",
      {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  downloadUrl: (path) =>
    `/api/workspace/download?${new URLSearchParams({ path })}`,
  rawUrl: (path) => `/api/workspace/raw?${new URLSearchParams({ path })}`,
  exportWorkspaceUrl: () => "/api/workspace/export",
  downloadWorkspaceExport: async () => {
    const res = await fetch("/api/workspace/export");
    if (!res.ok) {
      let errorMsg = "Export failed";
      try {
        const payload = (await res.json()) as { error?: string };
        if (payload?.error) errorMsg = payload.error;
      } catch {}
      throw new Error(errorMsg);
    }
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition");
    let filename = "openlia-workspace-export.zip";
    if (disposition) {
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match?.[1]) filename = match[1];
    }
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(downloadUrl);
  },

  loadSkills: () =>
    requestJson<SkillsListResponse>("/api/skills/list", isSkillsListResponse),
  loadSkillDetail: (id) =>
    requestJson<SkillDetailResponse>(
      `/api/skills/detail?${new URLSearchParams({ id })}`,
      isSkillDetailResponse,
    ),
  loadSkillFile: (id, path) =>
    requestJson<SkillFileResponse>(
      `/api/skills/file?${new URLSearchParams({ id, path })}`,
      isSkillFileResponse,
    ),
  saveSkillFile: (id, path, content, expectedRevision) =>
    requestJson<SkillWriteResponse>("/api/skills/file", isSkillWriteResponse, {
      body: JSON.stringify({
        content,
        expected_revision: expectedRevision,
        id,
        path,
      }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    }),
  toggleSkillEnable: (id, enabled) =>
    requestJson<SkillSuccessResponse>(
      "/api/skills/toggle-enable",
      isSkillSuccessResponse,
      {
        body: JSON.stringify({ enabled, id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  toggleSkillPin: (id, pinned) =>
    requestJson<SkillSuccessResponse>(
      "/api/skills/toggle-pin",
      isSkillSuccessResponse,
      {
        body: JSON.stringify({ id, pinned }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  createSkill: (request) =>
    requestJson<SkillSuccessResponse>(
      "/api/skills/create",
      isSkillSuccessResponse,
      {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
};
