package migration

import "time"

// Migration states
const (
	StateUploaded         = "uploaded"
	StateQueued           = "queued"
	StateProcessing       = "processing"
	StateValidating       = "validating"
	StateReadyForReview   = "ready_for_review"
	StateRevising         = "revising"
	StateApplying         = "applying"
	StateApplied          = "applied"
	StateStale            = "stale"
	StateStopping         = "stopping"
	StateStopped          = "stopped"
	StateFailed           = "failed"
	StateDiscarded        = "discarded"
	StateRecoveryRequired = "recovery_required"
)

// Job states
const (
	JobPending    = "pending"
	JobRunning    = "running"
	JobSucceeded  = "succeeded"
	JobNoChange   = "no_change"
	JobNeedsInput = "needs_input"
	JobFailed     = "failed"
	JobSkipped    = "skipped"
	JobBlocked    = "blocked"
)

// Eligibility states
const (
	EligibilityEligible    = "eligible"
	EligibilitySkipped     = "skipped"
	EligibilityBlocked     = "blocked"
	EligibilityUnsupported = "unsupported"
)

// Worker lifecycle states
const (
	WorkerSleeping = "sleeping"
	WorkerStarting = "starting"
	WorkerRunning  = "running"
	WorkerStopping = "stopping"
	WorkerFailed   = "failed"
)

// Migration represents a complete folder import lifecycle.
type Migration struct {
	ID               string    `json:"id"`
	Schema           int       `json:"schema"` // 2 for durable workflow
	State            string    `json:"state"`
	SavedPhase       string    `json:"saved_phase,omitempty"` // phase to restore when resumed from stopped
	StopIntent       bool      `json:"stop_intent"`
	BaselineManifest string    `json:"baseline_manifest,omitempty"`
	ActiveRevisionID string    `json:"active_revision_id,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
	CompletedAt      *time.Time `json:"completed_at,omitempty"`
	ErrorMessage     string    `json:"error_message,omitempty"`
}

// SourceEntry represents an uploaded file in the source snapshot manifest.
type SourceEntry struct {
	ID           string   `json:"id"`
	MigrationID  string   `json:"migration_id"`
	RelativePath string   `json:"relative_path"`
	ByteHash     string   `json:"byte_hash"`
	ByteSize     int64    `json:"byte_size"`
	Encoding     string   `json:"encoding"`
	DetectedType string   `json:"detected_type"` // markdown, csv, json, yaml, hledger, remind, text, binary, etc.
	Eligibility  string   `json:"eligibility"`   // eligible, skipped, blocked, unsupported
	Reason       string   `json:"reason,omitempty"`
	Dependencies []string `json:"dependencies,omitempty"` // e.g. includes
	OrderIndex   int      `json:"order_index"`
}

// Job represents a sequential task processing a single eligible source file.
type Job struct {
	ID              string     `json:"id"`
	MigrationID     string     `json:"migration_id"`
	SourceID        string     `json:"source_id"`
	IdempotencyKey  string     `json:"idempotency_key"`
	State           string     `json:"state"`
	Attempts        int        `json:"attempts"`
	MaxAttempts     int        `json:"max_attempts"`
	LeaseOwner      string     `json:"lease_owner,omitempty"`
	LeaseGeneration int64      `json:"lease_generation"`
	LeaseExpiresAt  *time.Time `json:"lease_expires_at,omitempty"`
	HeartbeatAt     *time.Time `json:"heartbeat_at,omitempty"`
	ResultSummary   string     `json:"result_summary,omitempty"`
	ChangedPaths    []string   `json:"changed_paths,omitempty"`
	ErrorCode       string     `json:"error_code,omitempty"`
	ErrorMessage    string     `json:"error_message,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// ReviewRevision is an immutable review checkpoint.
type ReviewRevision struct {
	ID           string               `json:"id"`
	MigrationID  string               `json:"migration_id"`
	RevisionNum  int                  `json:"revision_num"`
	BaselineHash string               `json:"baseline_hash"`
	CommitHash   string               `json:"commit_hash"`
	TreeHash     string               `json:"tree_hash"`
	PatchHash    string               `json:"patch_hash"`
	ParentRevID  string               `json:"parent_rev_id,omitempty"`
	Summary      string               `json:"summary,omitempty"`
	ChangedFiles []ChangedFileEntry   `json:"changed_files"`
	Findings     []ValidationFinding  `json:"findings,omitempty"`
	CreatedAt    time.Time            `json:"created_at"`
}

// ChangedFileEntry records file status in a review revision.
type ChangedFileEntry struct {
	Path        string   `json:"path"`
	Status      string   `json:"status"` // added, modified, deleted
	SourceIDs   []string `json:"source_ids"`
	OldHash     string   `json:"old_hash,omitempty"`
	NewHash     string   `json:"new_hash,omitempty"`
	Additions   int      `json:"additions"`
	Deletions   int      `json:"deletions"`
}

// ValidationFinding captures issues discovered during domain validation (hledger check, remind, etc.)
type ValidationFinding struct {
	Severity string `json:"severity"` // error, warning, info
	Domain   string `json:"domain"`
	File     string `json:"file,omitempty"`
	Line     int    `json:"line,omitempty"`
	Message  string `json:"message"`
}

// FeedbackItem captures review feedback / instructions.
type FeedbackItem struct {
	ID          string    `json:"id"`
	MigrationID string    `json:"migration_id"`
	RevisionID  string    `json:"revision_id"`
	TargetPath  string    `json:"target_path,omitempty"`
	SourceID    string    `json:"source_id,omitempty"`
	LineNumber  int       `json:"line_number,omitempty"`
	Comment     string    `json:"comment"`
	Status      string    `json:"status"` // draft, submitted, addressed, declined
	CreatedAt   time.Time `json:"created_at"`
}

// ApplyJournal records atomic apply operations.
type ApplyJournal struct {
	ID           string    `json:"id"`
	MigrationID  string    `json:"migration_id"`
	RevisionID   string    `json:"revision_id"`
	PatchHash    string    `json:"patch_hash"`
	Status       string    `json:"status"` // preparing, applying, applied, rolling_back, rolled_back, failed
	Operations   string    `json:"operations"` // JSON list of file write/delete operations
	ErrorMessage string    `json:"error_message,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}
