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

export type MaintainerSeverity = "error" | "warning" | "info";
export type MaintainerCategory = "contract" | "suggestion";
export type MaintainerFixStrategy = "deterministic" | "agent" | "manual";
export type MaintainerIssueState = "open" | "ignored" | "resolved";

export interface MaintainerFinding {
  issue_id: string;
  workspace_id: string;
  relative_path: string;
  rule_code: string;
  severity: MaintainerSeverity;
  category: MaintainerCategory;
  subject: string;
  message: string;
  explanation: string;
  contract_path?: string | undefined;
  contract_fingerprint: string;
  fix_strategy: MaintainerFixStrategy;
  state: MaintainerIssueState;
  present: boolean;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at?: string | undefined;
  last_checked_revision: string;
  ignored_at?: string | undefined;
  ignored_by?: string | undefined;
  ignore_reason?: string | undefined;
  restored_at?: string | undefined;
}

export interface MaintainerDiscoveredCollection {
  path: string;
  label: string;
  kind: "core" | "template" | "freeform";
  template_path?: string | undefined;
  schema_path?: string | undefined;
  inferred_purpose: string;
  record_count: number;
  open_finding_count: number;
  ignored_finding_count: number;
}

export interface MaintainerScanState {
  workspace_id: string;
  last_scan_at: string;
  coverage_status: "complete" | "partial";
  files_scanned: number;
  files_skipped: number;
  scan_errors: string[];
}

export interface MaintainerOverviewResponse {
  schema: 1;
  workspace_id: string;
  counts: {
    open: number;
    ignored: number;
    resolved: number;
    suggestions: number;
    collections: number;
  };
  scan_state: MaintainerScanState;
  collections: MaintainerDiscoveredCollection[];
  open_findings: MaintainerFinding[];
  ignored_findings: MaintainerFinding[];
  resolved_findings: MaintainerFinding[];
  suggestions: MaintainerFinding[];
}

export interface MaintainerFixPreviewResponse {
  schema: 1;
  issue_id: string;
  path: string;
  rule_code: string;
  subject: string;
  fix_strategy: MaintainerFixStrategy;
  deterministically_fixable: boolean;
  current_revision: string;
  before_content: string;
  after_content: string;
  summary: string;
  agent_prompt: string;
}

export interface MaintainerFixApplyResponse {
  schema: 1;
  ok: true;
  issue_id: string;
  path: string;
  before_revision: string;
  after_revision: string;
  summary: string;
  finding: MaintainerFinding | null;
  file_findings: MaintainerFinding[];
}

export type PermissionMode = "allow" | "ask" | "deny";

export interface ConsequentialPermissionsResponse {
  schema: 1;
  version: 1;
  permissions: {
    destructive: {
      delete_records: PermissionMode;
      overwrite_records: PermissionMode;
    };
    external: {
      send_messages: PermissionMode;
      make_purchases: PermissionMode;
      modify_external_accounts: PermissionMode;
      ingest_external_content: PermissionMode;
    };
    scheduled_work: {
      run_briefings: PermissionMode;
      run_audits: PermissionMode;
      run_monitors: PermissionMode;
    };
  };
}

export interface WorkspaceFileValidation {
  valid: boolean;
  warnings?: string[] | undefined;
  schema_path?: string;
  template_path?: string;
  errors: string[];
  findings?: MaintainerFinding[] | undefined;
  ignored_count?: number | undefined;
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
  warnings?: string[] | undefined;
  schema_path?: string | undefined;
  template_path?: string | undefined;
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
  pinned_version_id?: string | null;
  line_excerpt?: string;
}

export interface SourceProcessingState {
  status:
    | "captured"
    | "queued"
    | "processing"
    | "complete"
    | "partial"
    | "awaiting-unlock"
    | "waiting-for-password"
    | "retryable-failure"
    | "failed"
    | "cancelled";
  last_job_id?: string | null;
  error?: string | null;
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
  password_profile?: string | null;
  origin?: Record<string, unknown>;
  versions: Array<Record<string, unknown>>;
  custom_fields?: Record<string, unknown>;
  canonical_uri: string;
  markdown_citation: string;
  backlinks?: SourceBacklink[];
  stale_backlinks?: SourceBacklink[];
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
  password_profile?: string | null;
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
  replaced_existing?: boolean | undefined;
  stale_backlinks?: SourceBacklink[] | undefined;
}

export interface SourceDeleteResponse {
  schema: 1;
  ok: boolean;
  source_id: string;
  deleted: boolean;
  backlinks?: SourceBacklink[] | undefined;
  annotated_files?: string[] | undefined;
}

export interface SourceCancelResponse {
  schema: 1;
  ok: boolean;
  source_id: string;
  cancelled: boolean;
  cancelled_jobs?: string[] | undefined;
}

export interface DocumentPasswordProfile {
  profile_id: string;
  label: string;
  description?: string | undefined;
  hint?: string | undefined;
  patterns?: string[] | undefined;
}

export interface PasswordSuggestion {
  profile: DocumentPasswordProfile;
  score: number;
  match_reasons: string[];
}

export interface DocumentPasswordListResponse {
  schema: 1;
  ok: boolean;
  profiles: DocumentPasswordProfile[];
}

export interface DocumentPasswordSuggestResponse {
  schema: 1;
  ok: boolean;
  suggestions: PasswordSuggestion[];
}

export interface DocumentPasswordDeleteResponse {
  schema: 1;
  ok: boolean;
  deleted?: string | undefined;
}

export interface SourceRetryRequest {
  password_profile?: string | undefined;
  profile_id?: string | undefined;
  label?: string | undefined;
  password?: string | undefined;
}

export interface SourceRetryResponse {
  schema: 1;
  ok: boolean;
  source_id: string;
  job_id: string;
  state: string;
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
  job_state?: string | undefined;
  job_attempts?: number | undefined;
  job_max_attempts?: number | undefined;
  job_summary?: string | undefined;
  job_error?: string | undefined;
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
  unresolved_questions?: string[] | undefined;
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

export interface MigrationRecoveryInfo {
  required: boolean;
  journal_status?: string | undefined;
  operations_count?: number | undefined;
  error_message?: string | undefined;
}

export interface MigrationDetailResponse {
  schema: 2;
  migration: MigrationSummary;
  sources: MigrationSourceItem[];
  revisions: MigrationRevisionSummary[];
  active_diff?: string | undefined;
  feedback: MigrationFeedbackItem[];
  worker_status: "sleeping" | "starting" | "running" | "stopping" | "failed";
  recovery?: MigrationRecoveryInfo | undefined;
}

export interface MigrationFeedbackRequest {
  revision_id: string;
  comment: string;
  target_path?: string | undefined;
  line_number?: number | undefined;
  request_changes?: boolean | undefined;
}
export interface MigrationListResponse {
  schema: 2;
  migrations: MigrationSummary[];
}

export interface MigrationActionResponse {
  ok: boolean;
  migration_id: string;
  state?: string;
  recovery?: unknown;
  revision_id?: string;
  error?: string;
}

export interface WorkspaceDomainInfo {
  path: string;
  label: string;
  template_path?: string | undefined;
  schema_path?: string | undefined;
  purpose?: string | undefined;
  kind?: "core" | "extension" | undefined;
  lifecycle?: string | undefined;
  feature?: string | undefined;
  skills?: string[] | undefined;
  record_count?: number | undefined;
  invalid_record_count?: number | undefined;
}

export interface WorkspaceDomainRecordSummary {
  path: string;
  filename: string;
  title: string;
  modified_at: string;
  size: number;
  revision: string;
  frontmatter: Record<string, unknown>;
  sections: string[];
  excerpt: string;
  validation?: WorkspaceFileValidation | undefined;
}

export interface WorkspaceStarterTemplate {
  id: string;
  label: string;
  description: string;
  schema_json?: Record<string, unknown> | undefined;
  template_headings: string[];
  template_content: string;
  template_defaults?: Record<string, unknown> | undefined;
  template_sections?: Record<string, string> | undefined;
}

export interface WorkspaceDomainRecordsResponse {
  schema: 1;
  domain: WorkspaceDomainInfo;
  records: WorkspaceDomainRecordSummary[];
  schema_json?: Record<string, unknown> | undefined;
  template_headings?: string[] | undefined;
  template_content?: string | undefined;
  template_defaults?: Record<string, unknown> | undefined;
  template_sections?: Record<string, string> | undefined;
  starter_templates?: WorkspaceStarterTemplate[] | undefined;
}

export interface WorkspaceDomainsResponse {
  schema: 1;
  domains: WorkspaceDomainInfo[];
}

export interface WorkspaceCreateFileRequest {
  domain: string;
  name: string;
  starter_id?: string | undefined;
  title?: string | undefined;
  frontmatter?: Record<string, unknown> | undefined;
  sections?: Record<string, string> | undefined;
  content?: string | undefined;
}

export interface WorkspaceFixTemplateRequest {
  path: string;
  content?: string | undefined;
}

export interface WorkspaceFixTemplateResponse {
  schema: 1;
  ok: true;
  migration_id: string;
}

export interface WorkspaceFixDomainTemplateRequest {
  domain: string;
}

export interface WorkspaceFixDomainTemplateResponse {
  schema: 1;
  ok: true;
  migration_id: string;
  fixed_count: number;
}

export type ShareKind = "workspace" | "skill" | "feature";
export type ShareExpirationPreset = "1d" | "7d" | "30d" | "90d" | "never";
export type ShareSyncStatus = "up_to_date" | "stale" | "source_missing";

export interface ShareSkillMetadata {
  name: string;
  category: string;
  description: string;
  version?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
  tags: string[];
  platforms: string[];
  prerequisites?: SkillPrerequisites | undefined;
}

export interface ShareFeatureMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string | undefined;
  license?: string | undefined;
  domains: string[];
  skills: string[];
}

export interface FeatureSummary {
  requires_openlia?: string | undefined;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string | undefined;
  license?: string | undefined;
  source: "builtin" | "imported" | "custom";
  state: "installed" | "partial" | "available";
  domains: string[];
  skills: string[];
}

export interface FeaturesListResponse {
  catalog?: TemplatesCatalogProvenance | undefined;
  schema: 1;
  ok: true;
  features: FeatureSummary[];
}

export interface FeatureInstallRequest {
  id: string;
  approve_policy?: boolean | undefined;
}

export interface FeatureInstallResponse {
  catalog?: TemplatesCatalogProvenance | undefined;
  schema: 1;
  ok: true;
  feature_id: string;
  installed_domains: string[];
  installed_skills: string[];
  policy_updated: boolean;
}

export interface TemplatesCatalogProvenance {
  schema: 1;
  source: string;
  ref: string;
  revision?: string | undefined;
  mode: "git" | "local-worktree";
  dirty: boolean;
  content_sha256: string;
}

export interface FeaturePackageRequest {
  id: string;
  name?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  domains?: string[] | undefined;
  skills?: string[] | undefined;
  include_records?: boolean | undefined;
}

export interface ShareSummary {
  id: string;
  kind: ShareKind;
  target_path: string;
  title: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  expiration_preset: ShareExpirationPreset;
  snapshot_revision: string;
  current_revision: string | null;
  status: ShareSyncStatus;
  file_count: number;
  total_bytes: number;
  media_type: string;
  skill_metadata?: ShareSkillMetadata | undefined;
  feature_metadata?: ShareFeatureMetadata | undefined;
}

export interface ShareListResponse {
  schema: 1;
  ok: true;
  shares: ShareSummary[];
}

export interface ShareMutationResponse {
  schema: 1;
  ok: true;
  share: ShareSummary;
}

export interface ShareDeleteResponse {
  schema: 1;
  ok: true;
  id: string;
}

export interface ShareCreateRequest {
  kind: ShareKind;
  target_path: string;
  expires_in?: ShareExpirationPreset | undefined;
}

export interface ShareUpdateRequest {
  action?: "sync" | undefined;
  expires_in?: ShareExpirationPreset | undefined;
}

export interface PublicShareFileEntry {
  path: string;
  size: number;
  modified_at: string;
  media_type: string;
  editable: boolean;
  content?: string | undefined;
}

export interface PublicShareResponse {
  schema: 1;
  ok: true;
  share: {
    id: string;
    kind: ShareKind;
    target_path: string;
    title: string;
    created_at: string;
    updated_at: string;
    expires_at: string | null;
    expiration_preset: ShareExpirationPreset;
    snapshot_revision: string;
    file_count: number;
    total_bytes: number;
    media_type: string;
    editable: boolean;
    content?: string | undefined;
    skill_metadata?: ShareSkillMetadata | undefined;
    feature_metadata?: ShareFeatureMetadata | undefined;
    files: PublicShareFileEntry[];
  };
}

export type MinionRuntime = "python" | "typescript";

export type MinionTriggerKind = "entry" | "heartbeat" | "input" | "manual";

export type MinionTriggerSpec =
  | "entry"
  | "cron"
  | "both"
  | {
      on_new_entry?: boolean | undefined;
      cron?: string | undefined;
    };

export interface MinionConfig {
  trigger: MinionTriggerSpec;
  [key: string]: unknown;
}

export interface MinionTriggersConfig {
  after_entry: boolean;
  heartbeat_schedule?: string | undefined;
}

export interface MinionQuickAction {
  id: string;
  label: string;
  description?: string | undefined;
  placeholder?: string | undefined;
  args?: string[] | undefined;
}

export interface MinionSummary {
  id: string;
  path: string;
  name: string;
  description: string;
  icon?: string | undefined;
  runtime: MinionRuntime;
  entrypoint: "main.py" | "main.ts";
  input_entrypoint?: "input.py" | "input.ts" | undefined;
  input_schema_file?: string | undefined;
  config_file?: string | undefined;
  config_schema_file?: string | undefined;
  dependency_file?: "requirements.txt" | "package.json" | undefined;
  ui_files: string[];
  dashboard_ui_file?: string | undefined;
  input_ui_file?: string | undefined;
  primary_ui_file?: string | undefined;
  triggers?: MinionTriggersConfig | undefined;
  data_file_count: number;
  script_file_count: number;
  test_file_count: number;
  renderable: boolean;
  render_errors?: string[] | undefined;
  quick_actions: MinionQuickAction[];
}

export interface MinionDetail extends MinionSummary {
  readme_content: string;
  ui_contents: Record<string, string>;
  input_schema?: Record<string, unknown> | undefined;
  input_schema_content?: string | undefined;
  config?: MinionConfig | undefined;
  config_content?: string | undefined;
  config_schema?: Record<string, unknown> | undefined;
  config_schema_content?: string | undefined;
  data_files: WorkspaceFileMetadata[];
  code_files: WorkspaceFileMetadata[];
  test_files: WorkspaceFileMetadata[];
}

export interface MinionsListResponse {
  schema: 1;
  minions: MinionSummary[];
}

export interface MinionDetailResponse {
  schema: 1;
  minion: MinionDetail;
}

export interface MinionCreateRequest {
  id: string;
  name: string;
  description?: string | undefined;
  runtime: MinionRuntime;
  heartbeat_schedule?: string | undefined;
}

export interface MinionRunRequest {
  trigger?: MinionTriggerKind | undefined;
  action?: string | undefined;
  input?: string | undefined;
  data?: Record<string, unknown> | undefined;
  args?: string[] | undefined;
  skip_post_entry_main?: boolean | undefined;
}

export interface MinionExecutionStep {
  step: "input" | "post_entry_main" | "heartbeat" | "main";
  script: string;
  trigger?: string | undefined;
  ok?: boolean | undefined;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface MinionRunResponse {
  schema: 1;
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  steps?: MinionExecutionStep[] | undefined;
  minion: MinionDetail;
}
