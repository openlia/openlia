export interface WorkspaceFileMetadata {
  source?: "memory";
  missing?: boolean;
  path: string;
  size: number;
  modified_at: string;
  editable: boolean;
  revision?: string;
}

export type WorkspaceTreeEntry =
  | { path: string; kind: "directory" }
  | (WorkspaceFileMetadata & { kind: "file" });

export interface WorkspaceTreeResponse {
  schema: 1;
  entries: WorkspaceTreeEntry[];
  truncated: boolean;
}

export interface WorkspaceFileValidation {
  valid: boolean;
  schema_path?: string;
  errors: string[];
}

export interface WorkspaceFile extends WorkspaceFileMetadata {
  schema: 1;
  content: string;
  revision: string;
  validation?: WorkspaceFileValidation;
}

export interface WorkspaceWriteResponse extends WorkspaceFileMetadata {
  schema: 1;
  ok: true;
  revision: string;
  validation?: WorkspaceFileValidation;
}

export interface WorkspaceDeleteResponse {
  schema: 1;
  ok: true;
  path: string;
}

export interface WorkspaceMoveResponse extends WorkspaceFileMetadata {
  schema: 1;
  ok: true;
  previous_path: string;
  revision: string;
  validation?: WorkspaceFileValidation;
}

export interface WorkspaceRenameResponse extends WorkspaceFileMetadata {
  schema: 1;
  ok: true;
  previous_path: string;
  revision: string;
  validation?: WorkspaceFileValidation;
}

export interface WorkspaceGitStatus {
  schema: 1;
  configured: boolean;
  branch?: string;
  dirty?: boolean;
  status?: string;
}

export interface WorkspaceCommitChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface WorkspaceCommit {
  hash: string;
  shortHash: string;
  author: string;
  message: string;
  timestamp: string;
  files: WorkspaceCommitChange[];
}

export interface WorkspaceUncommittedChange {
  path: string;
  status: "added" | "modified" | "deleted" | "untracked";
}

export interface WorkspaceActivityResponse {
  schema: 1;
  gitConfigured: boolean;
  branch?: string | undefined;
  uncommitted: WorkspaceUncommittedChange[];
  commits: WorkspaceCommit[];
  recentFiles: WorkspaceFileMetadata[];
}

export interface WorkspaceErrorResponse {
  schema: 1;
  ok: false;
  error: string;
  current_revision?: string;
}

export interface WorkspaceWriteRequest {
  path: string;
  content: string;
  expected_revision: string;
}

export interface WorkspaceDeleteRequest {
  path: string;
  expected_revision: string;
}

export interface WorkspaceMoveRequest {
  source_path: string;
  destination_path: string;
  expected_revision: string;
}

export interface WorkspaceRenameRequest {
  path: string;
  new_name: string;
  expected_revision: string;
}

export interface WorkspaceDiagnosticIssue {
  path: string;
  schema_path?: string | undefined;
  errors: string[];
}

export interface WorkspaceDiagnosticsResponse {
  schema: 1;
  valid: boolean;
  issues: WorkspaceDiagnosticIssue[];
}

export interface WorkspaceSettings {
  schema: 1;
  enable_memory_editing: boolean;
  hide_template_schema_files: boolean;
  hide_configuration_files: boolean;
}

export interface WorkspaceSystemInfo {
  schema: 1;
  openlia_version: string;
  openlia_hash: string;
  hermes_version: string;
  locho_version: string;
}

export interface IngestionLiveJob {
  job_id: string;
  intake_id: string;
  source_id: string;
  version_id?: string | null;
  operation: string;
  requested_outputs: string[];
  state: string;
  attempts: number;
  error_code?: string | null;
  error_summary?: string | null;
  next_attempt_at?: number | null;
  heartbeat_at?: number | null;
  lease_expires_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface IngestionLiveEvent {
  event_id: string;
  job_id: string;
  event_type: string;
  delivery_state: string;
  attempts: number;
  last_error?: string | null;
  delivered_at?: number | null;
  acknowledged_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface IngestionLiveAction {
  action_id: string;
  event_id: string;
  intake_id: string;
  status: string;
  record_refs: string[];
  created_at: number;
  updated_at: number;
}

export interface IngestionCallbackStatus {
  event_id?: string | null;
  durable_status?: string | null;
  delivery_state?: string | null;
  attempts?: number | undefined;
  last_error?: string | null;
  delivered_at?: number | null;
  acknowledged_at?: number | null;
}

export interface IngestionArtifact {
  artifact_id?: string | undefined;
  path: string;
  role: string;
  manifest_path?: string | undefined;
  size_bytes?: number | undefined;
  complete?: boolean | undefined;
  warnings: string[];
}

export interface IngestionListItem {
  intake_id: string;
  source_id: string;
  version_id: string;
  captured_at: string;
  kind: string;
  operation: string;
  requested_outputs: string[];
  status: string;
  durable_status: string | null;
  source_title: string;
  source_status: string | null;
  source_url?: string | null;
  source_record_path: string;
  intake_record_path: string;
  job?: IngestionLiveJob | undefined;
  event?: IngestionLiveEvent | undefined;
  action?: IngestionLiveAction | undefined;
  callback: IngestionCallbackStatus;
}

export interface IngestionOverviewResponse {
  schema: 1;
  live_available: boolean;
  live_stale: boolean;
  live_generated_at?: number | undefined;
  live_age_seconds?: number | undefined;
  live_error?: string | undefined;
  counts: Record<string, number>;
  queue_counts: Record<string, number>;
  intakes: IngestionListItem[];
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
}

export interface IngestionDetailResponse {
  schema: 1;
  live_available: boolean;
  live_stale: boolean;
  live_generated_at?: number | undefined;
  live_age_seconds?: number | undefined;
  live_error?: string | undefined;
  intake: IngestionListItem;
  source: {
    id: string;
    title: string;
    kind: string;
    status: string | null;
    captured_at: string | null;
    origin: Record<string, unknown>;
    versions: Array<Record<string, unknown>>;
  };
  artifacts: IngestionArtifact[];
}

export interface SourceBacklink {
  path: string;
  domain: string;
  filename: string;
  line_number?: number;
}

export interface SourceProcessingState {
  status:
    | "captured"
    | "queued"
    | "processing"
    | "complete"
    | "partial"
    | "failed";
  last_job_id?: string | null;
  error_code?: string | null;
  error_summary?: string | null;
}

export interface SourceReviewState {
  status: "unreviewed" | "needs-review" | "reviewed";
  reasons: string[];
  reviewed_at?: string | null;
}

export interface SourceExtractionItem {
  extraction_id: string;
  version_id: string;
  path: string;
}

export interface SourceDocument {
  id: string;
  title: string;
  kind: string;
  document_type?: string | null;
  correspondent?: string | null;
  document_date?: string | null;
  tags: string[];
  summary?: string | null;
  processing: SourceProcessingState;
  review: SourceReviewState;
  lifecycle: "active" | "archived";
  captured_at: string;
  origin?: Record<string, unknown>;
  versions: Array<Record<string, unknown>>;
  custom_fields?: Record<string, unknown>;
  canonical_uri: string;
  markdown_citation: string;
  backlinks?: SourceBacklink[];
  content?: string | null;
  extractions?: SourceExtractionItem[];
}

export interface SourceSearchFacets {
  tags: Record<string, number>;
  correspondents: Record<string, number>;
  document_types: Record<string, number>;
  review_status: Record<string, number>;
  processing_status: Record<string, number>;
}

export interface SourceSearchResultItem {
  source_id: string;
  title: string;
  correspondent?: string | null;
  document_type?: string | null;
  document_date?: string | null;
  tags: string[];
  summary?: string | null;
  review_status: string;
  processing_status: string;
  lifecycle: string;
  snippet?: string | null;
  rank: number;
  canonical_uri: string;
  markdown_citation: string;
}

export interface SourceSearchResponse {
  schema: 1;
  total: number;
  offset: number;
  limit: number;
  matches: SourceSearchResultItem[];
  facets: SourceSearchFacets;
}

export interface SourceUpdateRequest {
  title?: string;
  correspondent?: string | null;
  document_type?: string | null;
  document_date?: string | null;
  tags?: string[];
  summary?: string | null;
  review?: {
    status?: "unreviewed" | "needs-review" | "reviewed";
    reasons?: string[];
  };
  lifecycle?: "active" | "archived";
  custom_fields?: Record<string, unknown>;
}

export interface SourceUploadResponse {
  schema: 1;
  ok: boolean;
  source_id: string;
  version_id: string;
  job_id: string;
  title: string;
}

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string | undefined;
}

export interface AuthSessionResponse {
  schema: 1;
  auth_required: boolean;
  authenticated: boolean;
  auth_provider?: "password" | "firebase" | "none";
  firebase_config?: FirebaseClientConfig;
}

export interface AuthLoginResponse {
  schema: 1;
  ok: true;
}

export interface SkillPrerequisites {
  env_vars?: string[] | undefined;
  credential_files?: string[] | undefined;
}

export interface SkillSummary {
  id: string;
  name: string;
  category: string;
  description: string;
  version?: string | undefined;
  author?: string | undefined;
  tags: string[];
  enabled: boolean;
  pinned: boolean;
  bundled: boolean;
  useCount: number;
  lastUsedAt?: string | undefined;
  fileCount: number;
}

export interface SkillFileEntry {
  path: string;
  size: number;
  modified_at: string;
  editable: boolean;
}

export interface SkillDetail extends SkillSummary {
  license?: string | undefined;
  platforms?: string[] | undefined;
  prerequisites?: SkillPrerequisites | undefined;
  files: SkillFileEntry[];
}

export interface SkillsListResponse {
  schema: 1;
  skills: SkillSummary[];
  categories: string[];
}

export interface SkillDetailResponse {
  schema: 1;
  skill: SkillDetail;
}

export interface SkillFileResponse {
  schema: 1;
  id: string;
  path: string;
  content: string;
  revision: string;
  editable: boolean;
  size: number;
  modified_at: string;
}

export interface SkillWriteRequest {
  id: string;
  path: string;
  content: string;
  expected_revision: string;
}

export interface SkillWriteResponse {
  schema: 1;
  ok: true;
  id: string;
  path: string;
  revision: string;
  size: number;
  modified_at: string;
}

export interface SkillToggleEnableRequest {
  id: string;
  enabled: boolean;
}

export interface SkillTogglePinRequest {
  id: string;
  pinned: boolean;
}

export interface SkillCreateRequest {
  name: string;
  category?: string | undefined;
  description: string;
}

export interface SkillSuccessResponse {
  schema: 1;
  ok: true;
  id?: string | undefined;
}

export interface MigrationSourceItem {
  id: string;
  relative_path: string;
  byte_size: number;
  encoding: string;
  detected_type: string;
  eligibility: "eligible" | "skipped" | "blocked" | "unsupported";
  reason?: string | undefined;
  dependencies?: string[] | undefined;
  order_index: number;
}

export interface MigrationChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  source_ids?: string[] | undefined;
  old_hash?: string | undefined;
  new_hash?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface MigrationValidationFinding {
  severity: "error" | "warning" | "info";
  domain: string;
  file?: string | undefined;
  line?: number | undefined;
  message: string;
}

export interface MigrationRevisionSummary {
  id: string;
  migration_id: string;
  revision_num: number;
  baseline_hash: string;
  commit_hash: string;
  tree_hash: string;
  patch_hash: string;
  summary: string;
  changed_files: MigrationChangedFile[];
  findings?: MigrationValidationFinding[] | undefined;
  created_at: string;
}

export interface MigrationFeedbackItem {
  id: string;
  migration_id: string;
  revision_id: string;
  target_path?: string | undefined;
  source_id?: string | undefined;
  line_number?: number | undefined;
  comment: string;
  status: "draft" | "submitted" | "addressed" | "declined";
  created_at: string;
}

export interface MigrationProgress {
  total: number;
  completed: number;
  succeeded: number;
  running: number;
  pending: number;
  failed: number;
  percent: number;
  current_file?: string | undefined;
  avg_duration_sec?: number | undefined;
  eta_seconds?: number | undefined;
  estimated_finish_at?: string | undefined;
}

export interface MigrationSummary {
  id: string;
  schema: number;
  state: string;
  stop_intent: boolean;
  baseline_manifest?: string | undefined;
  active_revision_id?: string | undefined;
  job_summary?: Record<string, number> | undefined;
  progress?: MigrationProgress | undefined;
  total_sources: number;
  total_revisions: number;
  created_at: string;
  updated_at: string;
}

export interface MigrationDetailResponse {
  schema: 2;
  migration: MigrationSummary;
  sources: MigrationSourceItem[];
  revisions: MigrationRevisionSummary[];
  active_diff?: string | undefined;
  feedback: MigrationFeedbackItem[];
  worker_status: "sleeping" | "starting" | "running" | "stopping" | "failed";
}

export interface MigrationFeedbackRequest {
  revision_id: string;
  comment: string;
  target_path?: string | undefined;
  line_number?: number | undefined;
}
export interface MigrationListResponse {
  schema: 2;
  migrations: MigrationSummary[];
}

export interface MigrationActionResponse {
  ok: boolean;
  migration_id: string;
  state?: string;
  revision_id?: string;
  error?: string;
}
