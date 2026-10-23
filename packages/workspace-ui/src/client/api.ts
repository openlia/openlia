import type {
  AuthLoginResponse,
  AuthSessionResponse,
  DocumentPasswordDeleteResponse,
  DocumentPasswordListResponse,
  DocumentPasswordProfile,
  DocumentPasswordSuggestResponse,
  IngestionDetailResponse,
  IngestionOverviewResponse,
  MigrationActionResponse,
  MigrationDetailResponse,
  MigrationFeedbackRequest,
  MigrationListResponse,
  MigrationSummary,
  PublicShareResponse,
  ShareCreateRequest,
  ShareDeleteResponse,
  ShareExpirationPreset,
  ShareKind,
  ShareListResponse,
  ShareMutationResponse,
  ShareUpdateRequest,
  SkillCreateRequest,
  SkillDetailResponse,
  SkillFileResponse,
  SkillSuccessResponse,
  SkillsListResponse,
  SkillWriteResponse,
  SourceCancelResponse,
  SourceDeleteResponse,
  SourceDocument,
  SourceRetryRequest,
  SourceRetryResponse,
  SourceSearchResponse,
  SourceUpdateRequest,
  SourceUploadResponse,
  WorkspaceActivityResponse,
  WorkspaceDeleteResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceDomainInfo,
  WorkspaceDomainsResponse,
  WorkspaceErrorResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceFixTemplateResponse,
  WorkspaceGitStatus,
  WorkspaceMoveResponse,
  WorkspaceRenameResponse,
  WorkspaceSettings,
  WorkspaceSystemInfo,
  WorkspaceTreeEntry,
  WorkspaceTreeResponse,
  WorkspaceWriteResponse,
} from "../shared/api";
import type {
  CreateCronJobInput,
  CronOverviewResponse,
  HermesCronJob,
  UpdateCronJobInput,
} from "../shared/cron";
import { isMemoryDocument, memoryFilename } from "../shared/memory";
import type { UsageRates, UsageResponse } from "../shared/usage";

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
  loadUsage(reference?: string): Promise<UsageResponse>;
  saveUsageOverride(
    provider: string,
    model: string,
    rates: UsageRates | null,
  ): Promise<{ schema: 1; ok: true }>;
  loadTree(): Promise<WorkspaceTreeResponse>;
  loadSession(): Promise<AuthSessionResponse>;
  login(password: string): Promise<AuthLoginResponse>;
  loginWithFirebase(idToken: string): Promise<AuthLoginResponse>;
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
  loadCreatableDomains(): Promise<WorkspaceDomainsResponse>;
  createFile(domain: string, name: string): Promise<WorkspaceFile>;
  fixTemplateIssues(
    path: string,
    content?: string,
  ): Promise<WorkspaceFixTemplateResponse>;
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
  searchSources(
    options?:
      | {
          query?: string | undefined;
          tags?: string[] | undefined;
          correspondent?: string | undefined;
          document_type?: string | undefined;
          review_status?: string | undefined;
          processing_status?: string | undefined;
          lifecycle?: string | undefined;
          offset?: number | undefined;
          limit?: number | undefined;
        }
      | undefined,
  ): Promise<SourceSearchResponse>;
  loadSource(
    sourceId: string,
    versionId?: string | undefined,
  ): Promise<SourceDocument>;
  updateSource(
    sourceId: string,
    updates: SourceUpdateRequest,
  ): Promise<SourceDocument>;
  sourceRawUrl(sourceId: string, versionId?: string): string;
  retrySource(
    sourceId: string,
    req?: SourceRetryRequest,
  ): Promise<SourceRetryResponse>;
  listDocumentPasswords(): Promise<DocumentPasswordListResponse>;
  saveDocumentPassword(
    profileId: string,
    label: string,
    password?: string | undefined,
    description?: string | undefined,
    hint?: string | undefined,
    patterns?: string[] | undefined,
  ): Promise<{ schema: 1; ok: true; profile: DocumentPasswordProfile }>;
  deleteDocumentPassword(
    profileId: string,
  ): Promise<DocumentPasswordDeleteResponse>;
  suggestDocumentPasswords(params: {
    filename?: string | undefined;
    title?: string | undefined;
    correspondent?: string | undefined;
    message?: string | undefined;
  }): Promise<DocumentPasswordSuggestResponse>;
  deleteSource(
    sourceId: string,
    options?: { annotate_backlinks?: boolean },
  ): Promise<SourceDeleteResponse>;
  cancelSource(
    sourceId: string,
    reason?: string,
  ): Promise<SourceCancelResponse>;
  uploadDocument(formData: FormData): Promise<SourceUploadResponse>;
  uploadDocumentJson(body: {
    title?: string | undefined;
    content?: string | undefined;
    base64?: string | undefined;
    filename?: string | undefined;
    kind?: string | undefined;
    password_profile?: string | undefined;
    password?: string | undefined;
    password_label?: string | undefined;
    password_hint?: string | undefined;
    password_description?: string | undefined;
    source_id?: string | undefined;
    purge_previous_versions?: boolean | undefined;
  }): Promise<SourceUploadResponse>;
  loadMigrations(): Promise<MigrationSummary[]>;
  loadMigrationDetail(id: string): Promise<MigrationDetailResponse>;
  submitMigrationFeedback(
    id: string,
    req: MigrationFeedbackRequest,
  ): Promise<MigrationActionResponse>;
  approveMigration(
    id: string,
    revisionId: string,
    patchHash?: string,
  ): Promise<MigrationActionResponse>;
  recoverMigration(
    id: string,
    action?: string,
  ): Promise<MigrationActionResponse>;
  retryMigrationJobs(id: string): Promise<MigrationActionResponse>;
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
  loadCronJobs(): Promise<CronOverviewResponse>;
  createCronJob(
    input: CreateCronJobInput,
  ): Promise<{ schema: 1; ok: true; job: HermesCronJob }>;
  updateCronJob(
    id: string,
    input: UpdateCronJobInput,
  ): Promise<{ schema: 1; ok: true; job: HermesCronJob }>;
  toggleCronJob(
    id: string,
    paused?: boolean,
  ): Promise<{ schema: 1; ok: true; job: HermesCronJob }>;
  deleteCronJob(id: string): Promise<{ schema: 1; ok: true; id: string }>;

  listShares(filter?: {
    kind?: ShareKind | undefined;
    targetPath?: string | undefined;
  }): Promise<ShareListResponse>;
  createShare(request: ShareCreateRequest): Promise<ShareMutationResponse>;
  updateShare(
    id: string,
    request: ShareUpdateRequest,
  ): Promise<ShareMutationResponse>;
  syncShare(
    id: string,
    expiresIn?: ShareExpirationPreset | undefined,
  ): Promise<ShareMutationResponse>;
  deleteShare(id: string): Promise<ShareDeleteResponse>;
  getPublicShare(id: string): Promise<PublicShareResponse>;
  publicShareRawUrl(id: string, filePath?: string | undefined): string;
  publicShareDownloadUrl(id: string, filePath?: string | undefined): string;
  publicShareSkillDownloadUrl(id: string): string;
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
    typeof value.editable === "boolean" &&
    (value.revision === undefined || typeof value.revision === "string")
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

function isWorkspaceFixTemplateResponse(
  value: unknown,
): value is WorkspaceFixTemplateResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    value.ok === true &&
    typeof value.migration_id === "string"
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

function isSourceSearchResponse(value: unknown): value is SourceSearchResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.total === "number" &&
    Array.isArray(value.matches) &&
    isObject(value.facets)
  );
}

function isSourceDocument(value: unknown): value is SourceDocument {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.kind === "string" &&
    isObject(value.processing) &&
    isObject(value.review)
  );
}

function isSourceUploadResponse(value: unknown): value is SourceUploadResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    value.ok === true &&
    typeof value.source_id === "string"
  );
}

function isSourceDeleteResponse(value: unknown): value is SourceDeleteResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    value.ok === true &&
    typeof value.source_id === "string" &&
    typeof value.deleted === "boolean"
  );
}

function isSourceCancelResponse(value: unknown): value is SourceCancelResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    value.ok === true &&
    typeof value.source_id === "string" &&
    typeof value.cancelled === "boolean"
  );
}

function isWorkspaceSettings(value: unknown): value is WorkspaceSettings {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.hide_template_schema_files === "boolean" &&
    typeof value.enable_memory_editing === "boolean" &&
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

function isWorkspaceDomainInfo(value: unknown): value is WorkspaceDomainInfo {
  return (
    isObject(value) &&
    typeof value.path === "string" &&
    typeof value.label === "string" &&
    (value.template_path === undefined ||
      typeof value.template_path === "string") &&
    (value.purpose === undefined || typeof value.purpose === "string")
  );
}

function isWorkspaceDomainsResponse(
  value: unknown,
): value is WorkspaceDomainsResponse {
  return (
    isObject(value) &&
    value.schema === 1 &&
    Array.isArray(value.domains) &&
    value.domains.every(isWorkspaceDomainInfo)
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
  loadUsage: (reference) =>
    requestJson<UsageResponse>(
      `/api/workspace/usage${reference ? `?reference=${encodeURIComponent(reference)}` : ""}`,
      (value): value is UsageResponse =>
        isObject(value) &&
        value.schema === 1 &&
        Array.isArray(value.rows) &&
        Array.isArray(value.prices),
    ),
  saveUsageOverride: (provider, model, rates) =>
    requestJson<{ schema: 1; ok: true }>(
      "/api/workspace/usage/override",
      (value): value is { schema: 1; ok: true } =>
        isObject(value) && value.ok === true,
      {
        method: rates === null ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, rates }),
      },
    ),
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
  loginWithFirebase: (idToken) =>
    requestJson<AuthLoginResponse>(
      "/api/auth/firebase-login",
      isAuthLoginResponse,
      {
        body: JSON.stringify({ idToken }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  logout: () =>
    requestJson<AuthLoginResponse>("/api/auth/logout", isAuthLoginResponse, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  loadFile: (path) =>
    requestJson<WorkspaceFile>(
      isMemoryDocument(path)
        ? `/api/memory/file?${new URLSearchParams({ name: memoryFilename(path) })}`
        : `/api/workspace/file?${new URLSearchParams({ path })}`,
      isWorkspaceFile,
    ),
  loadFileMetadata: (path) =>
    requestJson<WorkspaceFileMetadata>(
      isMemoryDocument(path)
        ? `/api/memory/metadata?${new URLSearchParams({ name: memoryFilename(path) })}`
        : `/api/workspace/metadata?${new URLSearchParams({ path })}`,
      isWorkspaceFileMetadataResponse,
    ),
  saveFile: (path, content, expectedRevision) =>
    requestJson<WorkspaceWriteResponse>(
      isMemoryDocument(path) ? "/api/memory/file" : "/api/workspace/file",
      isWorkspaceWriteResponse,
      {
        body: JSON.stringify({
          content,
          expected_revision: expectedRevision,
          ...(isMemoryDocument(path)
            ? { name: memoryFilename(path) }
            : { path }),
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
  loadCreatableDomains: () =>
    requestJson<WorkspaceDomainsResponse>(
      "/api/workspace/creatable-domains",
      isWorkspaceDomainsResponse,
    ),
  createFile: (domain, name) =>
    requestJson<WorkspaceFile>("/api/workspace/create-file", isWorkspaceFile, {
      body: JSON.stringify({ domain, name }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  fixTemplateIssues: (path, content) =>
    requestJson<WorkspaceFixTemplateResponse>(
      "/api/workspace/fix-template-issues",
      isWorkspaceFixTemplateResponse,
      {
        body: JSON.stringify({ path, content }),
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
  searchSources: (options) => {
    const params = new URLSearchParams();
    if (options?.query) params.set("q", options.query);
    if (options?.tags && options.tags.length > 0)
      params.set("tags", options.tags.join(","));
    if (options?.correspondent)
      params.set("correspondent", options.correspondent);
    if (options?.document_type)
      params.set("document_type", options.document_type);
    if (options?.review_status)
      params.set("review_status", options.review_status);
    if (options?.processing_status)
      params.set("processing_status", options.processing_status);
    if (options?.lifecycle) params.set("lifecycle", options.lifecycle);
    if (options?.offset !== undefined)
      params.set("offset", String(options.offset));
    if (options?.limit !== undefined)
      params.set("limit", String(options.limit));
    const query = params.toString();
    return requestJson<SourceSearchResponse>(
      `/api/workspace/ingestion/search${query ? `?${query}` : ""}`,
      isSourceSearchResponse,
    );
  },
  loadSource: (sourceId, versionId) => {
    const query = versionId
      ? `?${new URLSearchParams({ version_id: versionId }).toString()}`
      : "";
    return requestJson<SourceDocument>(
      `/api/workspace/ingestion/sources/${encodeURIComponent(sourceId)}${query}`,
      isSourceDocument,
    );
  },
  updateSource: (sourceId, updates) =>
    requestJson<SourceDocument>(
      `/api/workspace/ingestion/sources/${encodeURIComponent(sourceId)}`,
      isSourceDocument,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updates),
      },
    ),
  sourceRawUrl: (sourceId, versionId) => {
    const params = new URLSearchParams();
    if (versionId) params.set("version_id", versionId);
    const query = params.toString();
    return `/api/workspace/ingestion/sources/${encodeURIComponent(sourceId)}/raw${query ? `?${query}` : ""}`;
  },
  retrySource: (sourceId, req) =>
    requestJson<SourceRetryResponse>(
      `/api/workspace/ingestion/sources/${encodeURIComponent(sourceId)}/retry`,
      (val): val is SourceRetryResponse =>
        isObject(val) && val.ok === true && typeof val.job_id === "string",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req ?? {}),
      },
    ),
  listDocumentPasswords: () =>
    requestJson<DocumentPasswordListResponse>(
      "/api/workspace/ingestion/passwords",
      (val): val is DocumentPasswordListResponse =>
        isObject(val) && Array.isArray((val as any).profiles),
    ),
  saveDocumentPassword: (
    profileId,
    label,
    password,
    description,
    hint,
    patterns,
  ) =>
    requestJson<{ schema: 1; ok: true; profile: DocumentPasswordProfile }>(
      "/api/workspace/ingestion/passwords",
      (val): val is { schema: 1; ok: true; profile: DocumentPasswordProfile } =>
        isObject(val) && val.ok === true && isObject((val as any).profile),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile_id: profileId,
          label,
          password,
          description,
          hint,
          patterns,
        }),
      },
    ),
  deleteDocumentPassword: (profileId: string) =>
    requestJson<DocumentPasswordDeleteResponse>(
      `/api/workspace/ingestion/passwords/${encodeURIComponent(profileId)}`,
      (val): val is DocumentPasswordDeleteResponse =>
        isObject(val) && val.ok === true,
      {
        method: "DELETE",
      },
    ),
  suggestDocumentPasswords: (params) => {
    const q = new URLSearchParams();
    if (params.filename) q.set("filename", params.filename);
    if (params.title) q.set("title", params.title);
    if (params.correspondent) q.set("correspondent", params.correspondent);
    if (params.message) q.set("message", params.message);
    return requestJson<DocumentPasswordSuggestResponse>(
      `/api/workspace/ingestion/passwords/suggest?${q.toString()}`,
      (val): val is DocumentPasswordSuggestResponse =>
        isObject(val) &&
        val.ok === true &&
        Array.isArray((val as any).suggestions),
    );
  },
  deleteSource: (sourceId, options) => {
    const params = new URLSearchParams();
    if (options?.annotate_backlinks !== undefined) {
      params.set("annotate_backlinks", String(options.annotate_backlinks));
    }
    const q = params.toString();
    return requestJson<SourceDeleteResponse>(
      `/api/workspace/ingestion/sources/${encodeURIComponent(sourceId)}${q ? `?${q}` : ""}`,
      isSourceDeleteResponse,
      {
        method: "DELETE",
      },
    );
  },
  cancelSource: (sourceId, reason) =>
    requestJson<SourceCancelResponse>(
      `/api/workspace/ingestion/sources/${encodeURIComponent(sourceId)}/cancel`,
      isSourceCancelResponse,
      {
        method: "POST",
        body: JSON.stringify({ reason: reason || "cancelled_by_user" }),
      },
    ),
  uploadDocument: (formData) =>
    requestJson<SourceUploadResponse>(
      "/api/workspace/ingestion/upload",
      isSourceUploadResponse,
      {
        method: "POST",
        body: formData,
      },
    ),
  uploadDocumentJson: (body) =>
    requestJson<SourceUploadResponse>(
      "/api/workspace/ingestion/upload",
      isSourceUploadResponse,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
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
  approveMigration: (id, revisionId, patchHash) =>
    requestJson<MigrationActionResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}/approve`,
      (val): val is MigrationActionResponse =>
        isObject(val) && typeof (val as any).ok === "boolean",
      {
        body: JSON.stringify({ revision_id: revisionId, patch_hash: patchHash }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  recoverMigration: (id, action) =>
    requestJson<MigrationActionResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}/recover`,
      (val): val is MigrationActionResponse =>
        isObject(val) && typeof (val as any).ok === "boolean",
      {
        body: JSON.stringify({ action: action ?? "inspect" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  retryMigrationJobs: (id) =>
    requestJson<MigrationActionResponse>(
      `/api/workspace/migration/${encodeURIComponent(id)}/retry-jobs`,
      (val): val is MigrationActionResponse =>
        isObject(val) && typeof (val as any).ok === "boolean",
      {
        body: JSON.stringify({}),
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
    isMemoryDocument(path)
      ? `/api/memory/download?${new URLSearchParams({ name: memoryFilename(path) })}`
      : `/api/workspace/download?${new URLSearchParams({ path })}`,
  rawUrl: (path) =>
    isMemoryDocument(path)
      ? `/api/memory/raw?${new URLSearchParams({ name: memoryFilename(path) })}`
      : `/api/workspace/raw?${new URLSearchParams({ path })}`,
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
  loadCronJobs: () =>
    requestJson<CronOverviewResponse>(
      "/api/cron/jobs",
      (v): v is CronOverviewResponse =>
        isObject(v) && Array.isArray((v as any).jobs),
    ),
  createCronJob: (input) =>
    requestJson<{ schema: 1; ok: true; job: HermesCronJob }>(
      "/api/cron/jobs",
      (v): v is { schema: 1; ok: true; job: HermesCronJob } =>
        isObject(v) && (v as any).ok === true,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  updateCronJob: (id, input) =>
    requestJson<{ schema: 1; ok: true; job: HermesCronJob }>(
      `/api/cron/jobs/${encodeURIComponent(id)}`,
      (v): v is { schema: 1; ok: true; job: HermesCronJob } =>
        isObject(v) && (v as any).ok === true,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      },
    ),
  toggleCronJob: (id, paused) =>
    requestJson<{ schema: 1; ok: true; job: HermesCronJob }>(
      `/api/cron/jobs/${encodeURIComponent(id)}/toggle`,
      (v): v is { schema: 1; ok: true; job: HermesCronJob } =>
        isObject(v) && (v as any).ok === true,
      {
        body: JSON.stringify(paused !== undefined ? { paused } : {}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  deleteCronJob: (id) =>
    requestJson<{ schema: 1; ok: true; id: string }>(
      `/api/cron/jobs/${encodeURIComponent(id)}`,
      (v): v is { schema: 1; ok: true; id: string } =>
        isObject(v) && (v as any).ok === true,
      {
        method: "DELETE",
      },
    ),

  listShares: (filter) => {
    const params = new URLSearchParams();
    if (filter?.kind) params.set("kind", filter.kind);
    if (filter?.targetPath) params.set("target_path", filter.targetPath);
    const query = params.toString();
    return requestJson<ShareListResponse>(
      `/api/shares${query ? `?${query}` : ""}`,
      (v): v is ShareListResponse =>
        isObject(v) &&
        v.schema === 1 &&
        v.ok === true &&
        Array.isArray((v as any).shares),
    );
  },
  createShare: (req) =>
    requestJson<ShareMutationResponse>(
      "/api/shares",
      (v): v is ShareMutationResponse =>
        isObject(v) &&
        v.schema === 1 &&
        v.ok === true &&
        isObject((v as any).share),
      {
        body: JSON.stringify(req),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  updateShare: (id, req) =>
    requestJson<ShareMutationResponse>(
      `/api/shares/${encodeURIComponent(id)}`,
      (v): v is ShareMutationResponse =>
        isObject(v) &&
        v.schema === 1 &&
        v.ok === true &&
        isObject((v as any).share),
      {
        body: JSON.stringify(req),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      },
    ),
  syncShare: (id, expiresIn) =>
    requestJson<ShareMutationResponse>(
      `/api/shares/${encodeURIComponent(id)}/sync`,
      (v): v is ShareMutationResponse =>
        isObject(v) &&
        v.schema === 1 &&
        v.ok === true &&
        isObject((v as any).share),
      {
        body: JSON.stringify(
          expiresIn !== undefined ? { expires_in: expiresIn } : {},
        ),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  deleteShare: (id) =>
    requestJson<ShareDeleteResponse>(
      `/api/shares/${encodeURIComponent(id)}`,
      (v): v is ShareDeleteResponse =>
        isObject(v) &&
        v.schema === 1 &&
        v.ok === true &&
        typeof (v as any).id === "string",
      {
        method: "DELETE",
      },
    ),
  getPublicShare: (id) =>
    requestJson<PublicShareResponse>(
      `/api/public/share/${encodeURIComponent(id)}`,
      (v): v is PublicShareResponse =>
        isObject(v) &&
        v.schema === 1 &&
        v.ok === true &&
        isObject((v as any).share),
    ),
  publicShareRawUrl: (id, filePath) => {
    const query = filePath
      ? `?${new URLSearchParams({ path: filePath }).toString()}`
      : "";
    return `/api/public/share/${encodeURIComponent(id)}/raw${query}`;
  },
  publicShareDownloadUrl: (id, filePath) => {
    const query = filePath
      ? `?${new URLSearchParams({ path: filePath }).toString()}`
      : "";
    return `/api/public/share/${encodeURIComponent(id)}/download${query}`;
  },
  publicShareSkillDownloadUrl: (id) =>
    `/api/public/share/skill/${encodeURIComponent(id)}/download`,
};

export const api = httpWorkspaceApi;
