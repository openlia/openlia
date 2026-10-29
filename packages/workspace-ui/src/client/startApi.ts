import type {
  AuthLoginResponse,
  AuthSessionResponse,
  IngestionDetailResponse,
  IngestionOverviewResponse,
  MigrationActionResponse,
  MigrationDetailResponse,
  MigrationFeedbackRequest,
  MigrationListResponse,
  PublicShareResponse,
  ShareCreateRequest,
  ShareDeleteResponse,
  ShareExpirationPreset,
  ShareKind,
  ShareListResponse,
  ShareMutationResponse,
  ShareUpdateRequest,
  SourceDocument,
  SourceSearchResponse,
  SourceUpdateRequest,
  SourceUploadResponse,
  SkillCreateRequest,
  SkillDetailResponse,
  SkillFileResponse,
  SkillSuccessResponse,
  SkillWriteResponse,
  SkillsListResponse,
  WorkspaceActivityResponse,
  WorkspaceDeleteResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceDomainRecordsResponse,
  WorkspaceDomainsResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceFixDomainTemplateResponse,
  WorkspaceFixTemplateResponse,
  WorkspaceGitStatus,
  WorkspaceMoveResponse,
  WorkspaceRenameResponse,
  WorkspaceSettings,
  WorkspaceSystemInfo,
  WorkspaceTreeResponse,
  WorkspaceWriteResponse,
} from "../shared/api";
import { isMemoryDocument, memoryFilename } from "../shared/memory";
import { notifyWorkspaceFileChange } from "./workspaceFileChanges";
import {
  ApiError,
  httpWorkspaceApi,
  isErrorResponse,
  type WorkspaceApi,
} from "./api";
import {
  workspaceServerRequest,
  type WorkspaceServerRequest,
} from "../server/start-api";

async function request<T>(input: WorkspaceServerRequest): Promise<T> {
  const response = await workspaceServerRequest({ data: input });
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(
      response.status,
      isErrorResponse(response.payload) ? response.payload : null,
    );
  }
  return response.payload as T;
}

export const startWorkspaceApi: WorkspaceApi = {
  ...httpWorkspaceApi,
  loadCheckpointProposals: () =>
    request({ path: "/api/workspace/git/proposals" }),
  approveCheckpoint: (id, revision) =>
    request({
      path: `/api/workspace/git/proposals/${encodeURIComponent(id)}/approve`,
      method: "POST",
      body: { revision },
    }),
  dismissCheckpoint: (id, revision) =>
    request({
      path: `/api/workspace/git/proposals/${encodeURIComponent(id)}/dismiss`,
      method: "POST",
      body: { revision },
    }),
  loadMaintainerOverview: () => request({ path: "/api/maintainer/overview" }),
  runMaintainerAudit: () =>
    request({ path: "/api/maintainer/audit", method: "POST" }),
  ignoreMaintainerIssue: (issueId, reason) =>
    request({
      path: "/api/maintainer/ignore",
      method: "POST",
      body: reason ? { issue_id: issueId, reason } : { issue_id: issueId },
    }),
  restoreMaintainerIssue: (issueId) =>
    request({
      path: "/api/maintainer/restore",
      method: "POST",
      body: { issue_id: issueId },
    }),
  previewMaintainerFix: (issueId) =>
    request({
      path: "/api/maintainer/fix/preview",
      method: "POST",
      body: { issue_id: issueId },
    }),
  applyMaintainerFix: (issueId, expectedRevision) =>
    request({
      path: "/api/maintainer/fix/apply",
      method: "POST",
      body: { issue_id: issueId, expected_revision: expectedRevision },
    }),
  loadPermissions: () => request({ path: "/api/permissions" }),
  updatePermissions: (permissions) =>
    request({
      path: "/api/permissions",
      method: "PUT",
      body: { permissions },
    }),
  loadUsage: (reference) =>
    request<import("../shared/usage").UsageResponse>({
      path: `/api/workspace/usage${reference ? `?reference=${encodeURIComponent(reference)}` : ""}`,
    }),
  saveUsageOverride: (provider, model, rates) =>
    request<{ schema: 1; ok: true }>({
      path: "/api/workspace/usage/override",
      method: rates === null ? "DELETE" : "PUT",
      body: { provider, model, rates },
    }),
  loadSession: () =>
    request<AuthSessionResponse>({ path: "/api/auth/session" }),
  login: (password) =>
    request<AuthLoginResponse>({
      body: { password },
      method: "POST",
      path: "/api/auth/login",
    }),
  loginWithFirebase: (idToken) =>
    request<AuthLoginResponse>({
      body: { idToken },
      method: "POST",
      path: "/api/auth/firebase-login",
    }),
  logout: () =>
    request<AuthLoginResponse>({ method: "POST", path: "/api/auth/logout" }),
  loadTree: () =>
    request<WorkspaceTreeResponse>({ path: "/api/workspace/tree" }),
  loadFile: (path) =>
    request<WorkspaceFile>({
      path: isMemoryDocument(path)
        ? `/api/memory/file?${new URLSearchParams({ name: memoryFilename(path) })}`
        : `/api/workspace/file?${new URLSearchParams({ path })}`,
    }),
  saveFile: async (path, content, expectedRevision) => {
    const response = await request<WorkspaceWriteResponse>({
      body: {
        content,
        expected_revision: expectedRevision,
        ...(isMemoryDocument(path) ? { name: memoryFilename(path) } : { path }),
      },
      method: "PUT",
      path: isMemoryDocument(path) ? "/api/memory/file" : "/api/workspace/file",
    });
    notifyWorkspaceFileChange(path);
    return response;
  },
  loadFileMetadata: (path) =>
    request<WorkspaceFileMetadata>({
      path: isMemoryDocument(path)
        ? `/api/memory/metadata?${new URLSearchParams({ name: memoryFilename(path) })}`
        : `/api/workspace/metadata?${new URLSearchParams({ path })}`,
    }),
  deleteFile: (path, expectedRevision) =>
    request<WorkspaceDeleteResponse>({
      body: { expected_revision: expectedRevision, path },
      method: "DELETE",
      path: "/api/workspace/file",
    }),
  renameFile: (path, newName, expectedRevision) =>
    request<WorkspaceRenameResponse>({
      body: { expected_revision: expectedRevision, new_name: newName, path },
      method: "POST",
      path: "/api/workspace/rename",
    }),
  moveFile: (sourcePath, destinationPath, expectedRevision) =>
    request<WorkspaceMoveResponse>({
      body: {
        destination_path: destinationPath,
        expected_revision: expectedRevision,
        source_path: sourcePath,
      },
      method: "POST",
      path: "/api/workspace/move",
    }),
  loadDiagnostics: () =>
    request<WorkspaceDiagnosticsResponse>({
      path: "/api/workspace/diagnostics",
    }),
  loadFinanceContext: (path) =>
    request({
      path: `/api/workspace/finance?${new URLSearchParams({ path })}`,
    }),
  loadFinanceReport: (scope) =>
    request({
      path: `/api/workspace/finance/report?${new URLSearchParams({ ...scope })}`,
    }),
  createFinanceMapping: (input) =>
    request({
      path: "/api/workspace/finance/accounts",
      method: "POST",
      body: input,
    }),
  validateFinanceMapping: (input) =>
    request({
      path: "/api/workspace/finance/accounts/validate",
      method: "POST",
      body: input,
    }),
  loadCalendar: (range) =>
    request({
      path: `/api/workspace/calendar?${new URLSearchParams({ ...range })}`,
    }),
  createCalendarEvent: (event) =>
    request({
      path: "/api/workspace/calendar",
      method: "POST",
      body: event,
    }),
  loadCreatableDomains: () =>
    request<WorkspaceDomainsResponse>({
      path: "/api/workspace/creatable-domains",
    }),
  loadDomainOverview: (domainPath) =>
    request<WorkspaceDomainRecordsResponse>({
      path: `/api/workspace/domain-overview?${new URLSearchParams({ path: domainPath })}`,
    }),
  createFile: (domain, name) =>
    request<WorkspaceFile>({
      body: { domain, name },
      method: "POST",
      path: "/api/workspace/create-file",
    }),
  fixTemplateIssues: (path, content) =>
    request<WorkspaceFixTemplateResponse>({
      body: { path, content },
      method: "POST",
      path: "/api/workspace/fix-template-issues",
    }),
  fixDomainTemplateIssues: (domain) =>
    request<WorkspaceFixDomainTemplateResponse>({
      body: { domain },
      method: "POST",
      path: "/api/workspace/fix-domain-template",
    }),
  loadSettings: () =>
    request<WorkspaceSettings>({ path: "/api/workspace/settings" }),
  updateSettings: (settings) =>
    request<WorkspaceSettings>({
      body: settings,
      method: "PUT",
      path: "/api/workspace/settings",
    }),
  loadSystemInfo: () =>
    request<WorkspaceSystemInfo>({ path: "/api/system/info" }),
  loadGitStatus: () =>
    request<WorkspaceGitStatus>({ path: "/api/workspace/git/status" }),
  loadActivity: () =>
    request<WorkspaceActivityResponse>({ path: "/api/workspace/activity" }),
  loadIngestion: (options) => {
    const params = new URLSearchParams();
    if (options?.query) params.set("q", options.query);
    if (options?.status) params.set("status", options.status);
    if (options?.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return request<IngestionOverviewResponse>({
      path: `/api/workspace/ingestion${query ? `?${query}` : ""}`,
    });
  },
  loadIngestionDetail: (intakeId) =>
    request<IngestionDetailResponse>({
      path: `/api/workspace/ingestion/${encodeURIComponent(intakeId)}`,
    }),
  searchSources: (options) => {
    const params = new URLSearchParams();
    if (options?.query) params.set("q", options.query);
    if (options?.tags?.length) params.set("tags", options.tags.join(","));
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
    return request<SourceSearchResponse>({
      path: `/api/workspace/ingestion/search${query ? `?${query}` : ""}`,
    });
  },
  loadSource: (sourceId) =>
    request<SourceDocument>({
      path: `/api/workspace/ingestion/sources/${encodeURIComponent(sourceId)}`,
    }),
  updateSource: (sourceId, updates: SourceUpdateRequest) =>
    request<SourceDocument>({
      body: updates,
      method: "PATCH",
      path: `/api/workspace/ingestion/sources/${encodeURIComponent(sourceId)}`,
    }),
  uploadDocumentJson: (body) =>
    request<SourceUploadResponse>({
      body,
      method: "POST",
      path: "/api/workspace/ingestion/upload",
    }),
  loadMigrations: async () => {
    const response = await request<MigrationListResponse>({
      path: "/api/workspace/migration",
    });
    return response.migrations;
  },
  loadMigrationDetail: (id) =>
    request<MigrationDetailResponse>({
      path: `/api/workspace/migration/${encodeURIComponent(id)}`,
    }),
  submitMigrationFeedback: (id, body: MigrationFeedbackRequest) =>
    request<MigrationActionResponse>({
      body,
      method: "POST",
      path: `/api/workspace/migration/${encodeURIComponent(id)}/feedback`,
    }),
  approveMigration: (id, revisionId, patchHash) =>
    request<MigrationActionResponse>({
      body: { revision_id: revisionId, patch_hash: patchHash },
      method: "POST",
      path: `/api/workspace/migration/${encodeURIComponent(id)}/approve`,
    }),
  recoverMigration: (id, action) =>
    request<MigrationActionResponse>({
      body: { action: action ?? "inspect" },
      method: "POST",
      path: `/api/workspace/migration/${encodeURIComponent(id)}/recover`,
    }),
  retryMigrationJobs: (id) =>
    request<MigrationActionResponse>({
      body: {},
      method: "POST",
      path: `/api/workspace/migration/${encodeURIComponent(id)}/retry-jobs`,
    }),
  discardMigration: (id) =>
    request<MigrationActionResponse>({
      body: {},
      method: "POST",
      path: `/api/workspace/migration/${encodeURIComponent(id)}/discard`,
    }),
  stopMigration: (id) =>
    request<MigrationActionResponse>({
      body: {},
      method: "POST",
      path: `/api/workspace/migration/${encodeURIComponent(id)}/stop`,
    }),
  resumeMigration: (id) =>
    request<MigrationActionResponse>({
      body: {},
      method: "POST",
      path: `/api/workspace/migration/${encodeURIComponent(id)}/resume`,
    }),
  wakeMigration: (id) =>
    request<MigrationActionResponse>({
      body: {},
      method: "POST",
      path: `/api/workspace/migration/${encodeURIComponent(id)}/wake`,
    }),
  loadSkills: () => request<SkillsListResponse>({ path: "/api/skills/list" }),
  loadSkillDetail: (id) =>
    request<SkillDetailResponse>({
      path: `/api/skills/detail?${new URLSearchParams({ id })}`,
    }),
  loadSkillFile: (id, path) =>
    request<SkillFileResponse>({
      path: `/api/skills/file?${new URLSearchParams({ id, path })}`,
    }),
  saveSkillFile: (id, path, content, expectedRevision) =>
    request<SkillWriteResponse>({
      body: {
        content,
        expected_revision: expectedRevision,
        id,
        path,
      },
      method: "PUT",
      path: "/api/skills/file",
    }),
  toggleSkillEnable: (id, enabled) =>
    request<SkillSuccessResponse>({
      body: { enabled, id },
      method: "POST",
      path: "/api/skills/toggle-enable",
    }),
  toggleSkillPin: (id, pinned) =>
    request<SkillSuccessResponse>({
      body: { id, pinned },
      method: "POST",
      path: "/api/skills/toggle-pin",
    }),
  createSkill: (requestBody: SkillCreateRequest) =>
    request<SkillSuccessResponse>({
      body: requestBody,
      method: "POST",
      path: "/api/skills/create",
    }),
  listShares: (filter?: {
    kind?: ShareKind | undefined;
    targetPath?: string | undefined;
  }) => {
    const params = new URLSearchParams();
    if (filter?.kind) params.set("kind", filter.kind);
    if (filter?.targetPath) params.set("target_path", filter.targetPath);
    const query = params.toString();
    return request<ShareListResponse>({
      path: `/api/shares${query ? `?${query}` : ""}`,
    });
  },
  createShare: (req: ShareCreateRequest) =>
    request<ShareMutationResponse>({
      body: req,
      method: "POST",
      path: "/api/shares",
    }),
  updateShare: (id: string, req: ShareUpdateRequest) =>
    request<ShareMutationResponse>({
      body: req,
      method: "PATCH",
      path: `/api/shares/${encodeURIComponent(id)}`,
    }),
  syncShare: (id: string, expiresIn?: ShareExpirationPreset) =>
    request<ShareMutationResponse>({
      body: expiresIn !== undefined ? { expires_in: expiresIn } : {},
      method: "POST",
      path: `/api/shares/${encodeURIComponent(id)}/sync`,
    }),
  deleteShare: (id: string) =>
    request<ShareDeleteResponse>({
      method: "DELETE",
      path: `/api/shares/${encodeURIComponent(id)}`,
    }),
  getPublicShare: (id: string) =>
    request<PublicShareResponse>({
      path: `/api/public/share/${encodeURIComponent(id)}`,
    }),
};
