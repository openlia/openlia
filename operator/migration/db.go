package migration

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// DB manages SQLite access for a specific migration.
type DB struct {
	dbPath string
	db     *sql.DB
}

// OpenDB opens or initializes migration.sqlite with WAL mode.
func OpenDB(migrationDir string) (*DB, error) {
	if err := os.MkdirAll(migrationDir, 0o700); err != nil {
		return nil, fmt.Errorf("create migration dir: %w", err)
	}
	dbPath := filepath.Join(migrationDir, "migration.sqlite")
	// modernc.org/sqlite connection string
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(30000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite db: %w", err)
	}

	d := &DB{dbPath: dbPath, db: db}
	if err := d.initSchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return d, nil
}

// Close closes the database connection.
func (d *DB) Close() error {
	return d.db.Close()
}

func (d *DB) initSchema() error {
	schema := `
	CREATE TABLE IF NOT EXISTS migrations (
		id TEXT PRIMARY KEY,
		schema INTEGER NOT NULL,
		state TEXT NOT NULL,
		saved_phase TEXT,
		stop_intent INTEGER NOT NULL DEFAULT 0,
		baseline_manifest TEXT,
		active_revision_id TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		completed_at TEXT,
		error_message TEXT
	);

	CREATE TABLE IF NOT EXISTS sources (
		id TEXT PRIMARY KEY,
		migration_id TEXT NOT NULL,
		relative_path TEXT NOT NULL,
		byte_hash TEXT NOT NULL,
		byte_size INTEGER NOT NULL,
		encoding TEXT NOT NULL,
		detected_type TEXT NOT NULL,
		eligibility TEXT NOT NULL,
		reason TEXT,
		dependencies TEXT,
		order_index INTEGER NOT NULL,
		FOREIGN KEY (migration_id) REFERENCES migrations(id) ON DELETE CASCADE
	);

	CREATE INDEX IF NOT EXISTS idx_sources_order ON sources(migration_id, order_index);

	CREATE TABLE IF NOT EXISTS jobs (
		id TEXT PRIMARY KEY,
		migration_id TEXT NOT NULL,
		source_id TEXT NOT NULL,
		idempotency_key TEXT NOT NULL UNIQUE,
		state TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		max_attempts INTEGER NOT NULL DEFAULT 3,
		lease_owner TEXT,
		lease_generation INTEGER NOT NULL DEFAULT 0,
		lease_expires_at TEXT,
		heartbeat_at TEXT,
		result_summary TEXT,
		changed_paths TEXT,
		findings TEXT,
		unresolved_questions TEXT,
		error_code TEXT,
		error_message TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (migration_id) REFERENCES migrations(id) ON DELETE CASCADE,
		FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
	);

	CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(migration_id, state);

	CREATE TABLE IF NOT EXISTS revisions (
		id TEXT PRIMARY KEY,
		migration_id TEXT NOT NULL,
		revision_num INTEGER NOT NULL,
		baseline_hash TEXT NOT NULL,
		commit_hash TEXT NOT NULL,
		tree_hash TEXT NOT NULL,
		patch_hash TEXT NOT NULL,
		parent_rev_id TEXT,
		summary TEXT,
		changed_files TEXT,
		findings TEXT,
		unresolved_questions TEXT,
		created_at TEXT NOT NULL,
		FOREIGN KEY (migration_id) REFERENCES migrations(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS feedback (
		id TEXT PRIMARY KEY,
		migration_id TEXT NOT NULL,
		revision_id TEXT NOT NULL,
		target_path TEXT,
		source_id TEXT,
		line_number INTEGER,
		comment TEXT NOT NULL,
		status TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (migration_id) REFERENCES migrations(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS apply_journal (
		id TEXT PRIMARY KEY,
		migration_id TEXT NOT NULL,
		revision_id TEXT NOT NULL,
		patch_hash TEXT NOT NULL,
		status TEXT NOT NULL,
		operations TEXT NOT NULL,
		error_message TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (migration_id) REFERENCES migrations(id) ON DELETE CASCADE
	);
	`
	if _, err := d.db.Exec(schema); err != nil {
		return err
	}

	// Backward-compatible schema evolution for existing databases
	_, _ = d.db.Exec(`ALTER TABLE jobs ADD COLUMN findings TEXT`)
	_, _ = d.db.Exec(`ALTER TABLE jobs ADD COLUMN unresolved_questions TEXT`)
	_, _ = d.db.Exec(`ALTER TABLE revisions ADD COLUMN unresolved_questions TEXT`)

	return nil
}

// ValidStateTransitions defines allowed migration state changes.
var ValidStateTransitions = map[string][]string{
	StateUploaded:         {StateQueued, StateProcessing, StateStopped, StateDiscarded, StateFailed},
	StateQueued:           {StateProcessing, StateStopped, StateDiscarded, StateFailed},
	StateProcessing:       {StateValidating, StateReadyForReview, StateStopping, StateStopped, StateFailed, StateDiscarded},
	StateValidating:       {StateReadyForReview, StateProcessing, StateStopping, StateStopped, StateFailed, StateDiscarded},
	StateReadyForReview:   {StateRevising, StateProcessing, StateApplying, StateStale, StateStopped, StateDiscarded, StateFailed},
	StateRevising:         {StateProcessing, StateReadyForReview, StateStopping, StateStopped, StateFailed, StateDiscarded},
	StateApplying:         {StateApplied, StateRollingBack, StateRecoveryRequired, StateFailed},
	StateRollingBack:      {StateReadyForReview, StateRecoveryRequired, StateFailed},
	StateRecoveryRequired: {StateApplying, StateReadyForReview, StateFailed},
	StateStale:            {StateProcessing, StateReadyForReview, StateStopped, StateDiscarded, StateFailed},
	StateStopping:         {StateStopped, StateFailed},
	StateStopped:          {StateProcessing, StateQueued, StateReadyForReview, StateDiscarded, StateFailed},
	StateFailed:           {StateProcessing, StateDiscarded},
	StateApplied:          {}, // terminal
	StateDiscarded:        {}, // terminal
}

// IsValidStateTransition checks whether a state transition is permitted.
func IsValidStateTransition(from, to string) bool {
	if from == to || from == "" {
		return true
	}
	allowed, ok := ValidStateTransitions[from]
	if !ok {
		return false
	}
	for _, s := range allowed {
		if s == to {
			return true
		}
	}
	return false
}

// CreateMigration inserts the initial migration record.
func (d *DB) CreateMigration(m Migration) error {
	now := time.Now().UTC().Format(time.RFC3339)
	stopInt := 0
	if m.StopIntent {
		stopInt = 1
	}
	_, err := d.db.Exec(`
		INSERT INTO migrations (id, schema, state, saved_phase, stop_intent, baseline_manifest, active_revision_id, created_at, updated_at, error_message)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, m.ID, m.Schema, m.State, m.SavedPhase, stopInt, m.BaselineManifest, m.ActiveRevisionID, now, now, m.ErrorMessage)
	return err
}

// GetMigration retrieves a migration by ID.
func (d *DB) GetMigration(id string) (*Migration, error) {
	row := d.db.QueryRow(`
		SELECT id, schema, state, saved_phase, stop_intent, baseline_manifest, active_revision_id, created_at, updated_at, completed_at, error_message
		FROM migrations WHERE id = ?
	`, id)

	var m Migration
	var stopInt int
	var created, updated string
	var completed sql.NullString
	var savedPhase, baseline, activeRev, errMsg sql.NullString

	err := row.Scan(&m.ID, &m.Schema, &m.State, &savedPhase, &stopInt, &baseline, &activeRev, &created, &updated, &completed, &errMsg)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	m.StopIntent = stopInt == 1
	m.SavedPhase = savedPhase.String
	m.BaselineManifest = baseline.String
	m.ActiveRevisionID = activeRev.String
	m.ErrorMessage = errMsg.String
	m.CreatedAt, _ = time.Parse(time.RFC3339, created)
	m.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	if completed.Valid {
		t, _ := time.Parse(time.RFC3339, completed.String)
		m.CompletedAt = &t
	}
	return &m, nil
}

// UpdateMigrationState updates state, optionally saving phase or setting stop intent.
func (d *DB) UpdateMigrationState(id string, state string, savedPhase string) error {
	var currState string
	err := d.db.QueryRow(`SELECT state FROM migrations WHERE id = ?`, id).Scan(&currState)
	if err == nil && !IsValidStateTransition(currState, state) {
		return fmt.Errorf("invalid migration state transition from '%s' to '%s'", currState, state)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = d.db.Exec(`
		UPDATE migrations
		SET state = ?, saved_phase = CASE WHEN ? != '' THEN ? ELSE saved_phase END, updated_at = ?
		WHERE id = ?
	`, state, savedPhase, savedPhase, now, id)
	return err
}

// SetStopIntent sets or clears stop intent.
func (d *DB) SetStopIntent(id string, stop bool) error {
	stopInt := 0
	if stop {
		stopInt = 1
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := d.db.Exec(`UPDATE migrations SET stop_intent = ?, updated_at = ? WHERE id = ?`, stopInt, now, id)
	return err
}

// InsertSources records all discovered source entries.
func (d *DB) InsertSources(sources []SourceEntry) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		INSERT INTO sources (id, migration_id, relative_path, byte_hash, byte_size, encoding, detected_type, eligibility, reason, dependencies, order_index)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, s := range sources {
		deps, _ := json.Marshal(s.Dependencies)
		if _, err := stmt.Exec(s.ID, s.MigrationID, s.RelativePath, s.ByteHash, s.ByteSize, s.Encoding, s.DetectedType, s.Eligibility, s.Reason, string(deps), s.OrderIndex); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListSources retrieves all sources for a migration ordered by order_index.
func (d *DB) ListSources(migrationID string) ([]SourceEntry, error) {
	rows, err := d.db.Query(`
		SELECT id, migration_id, relative_path, byte_hash, byte_size, encoding, detected_type, eligibility, reason, dependencies, order_index
		FROM sources WHERE migration_id = ? ORDER BY order_index ASC
	`, migrationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []SourceEntry
	for rows.Next() {
		var s SourceEntry
		var reason sql.NullString
		var depsStr sql.NullString
		if err := rows.Scan(&s.ID, &s.MigrationID, &s.RelativePath, &s.ByteHash, &s.ByteSize, &s.Encoding, &s.DetectedType, &s.Eligibility, &reason, &depsStr, &s.OrderIndex); err != nil {
			return nil, err
		}
		s.Reason = reason.String
		if depsStr.Valid && depsStr.String != "" {
			_ = json.Unmarshal([]byte(depsStr.String), &s.Dependencies)
		}
		entries = append(entries, s)
	}
	return entries, nil
}

// EnqueueJobs enqueues jobs for eligible sources.
func (d *DB) EnqueueJobs(jobs []Job) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		INSERT INTO jobs (id, migration_id, source_id, idempotency_key, state, attempts, max_attempts, lease_generation, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	for _, j := range jobs {
		maxAtt := j.MaxAttempts
		if maxAtt <= 0 {
			maxAtt = 3
		}
		if _, err := stmt.Exec(j.ID, j.MigrationID, j.SourceID, j.IdempotencyKey, JobPending, 0, maxAtt, now, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ClaimNextJob claims the next pending job or expired lease.
func (d *DB) ClaimNextJob(ctx context.Context, migrationID string, workerID string, leaseDuration time.Duration) (*Job, error) {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339)

	// Find eligible job: either pending or (running with lease_expires_at < now and attempts < max_attempts)
	row := tx.QueryRow(`
		SELECT id, source_id, idempotency_key, state, attempts, max_attempts, lease_generation
		FROM jobs
		WHERE migration_id = ?
		  AND (state = ? OR (state = ? AND lease_expires_at < ? AND attempts < max_attempts))
		ORDER BY created_at ASC LIMIT 1
	`, migrationID, JobPending, JobRunning, nowStr)

	var j Job
	j.MigrationID = migrationID
	err = row.Scan(&j.ID, &j.SourceID, &j.IdempotencyKey, &j.State, &j.Attempts, &j.MaxAttempts, &j.LeaseGeneration)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil // No runnable jobs
		}
		return nil, err
	}

	expiresAt := now.Add(leaseDuration)
	expiresStr := expiresAt.Format(time.RFC3339)
	newAttempts := j.Attempts + 1
	newGen := j.LeaseGeneration + 1

	res, err := tx.Exec(`
		UPDATE jobs
		SET state = ?, attempts = ?, lease_owner = ?, lease_generation = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
		WHERE id = ? AND lease_generation = ?
	`, JobRunning, newAttempts, workerID, newGen, expiresStr, nowStr, nowStr, j.ID, j.LeaseGeneration)
	if err != nil {
		return nil, err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return nil, nil // Lost race to claim
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	j.State = JobRunning
	j.Attempts = newAttempts
	j.LeaseOwner = workerID
	j.LeaseGeneration = newGen
	j.LeaseExpiresAt = &expiresAt
	j.HeartbeatAt = &now
	return &j, nil
}

// HeartbeatJob extends the active lease.
func (d *DB) HeartbeatJob(jobID string, workerID string, leaseGen int64, leaseDuration time.Duration) error {
	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339)
	expiresStr := now.Add(leaseDuration).Format(time.RFC3339)

	res, err := d.db.Exec(`
		UPDATE jobs
		SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
		WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND state = ?
	`, nowStr, expiresStr, nowStr, jobID, workerID, leaseGen, JobRunning)
	if err != nil {
		return err
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return fmt.Errorf("heartbeat rejected: lease lost or job no longer running")
	}
	return nil
}

// CompleteJob marks a job finished with its outcome, enforcing lease owner and generation fencing.
func (d *DB) CompleteJob(jobID string, workerID string, leaseGen int64, state string, summary string, changedPaths []string, findings []ValidationFinding, questions []string, errCode, errMsg string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	pathsJSON, _ := json.Marshal(changedPaths)
	findingsJSON, _ := json.Marshal(findings)
	questionsJSON, _ := json.Marshal(questions)

	query := `
		UPDATE jobs
		SET state = ?, result_summary = ?, changed_paths = ?, findings = ?, unresolved_questions = ?, error_code = ?, error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
		WHERE id = ?
	`
	args := []any{state, summary, string(pathsJSON), string(findingsJSON), string(questionsJSON), errCode, errMsg, now, jobID}

	// If workerID and leaseGen are provided, enforce lease fencing
	if workerID != "" && leaseGen > 0 {
		query = `
			UPDATE jobs
			SET state = ?, result_summary = ?, changed_paths = ?, findings = ?, unresolved_questions = ?, error_code = ?, error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
			WHERE id = ? AND lease_owner = ? AND lease_generation = ?
		`
		args = []any{state, summary, string(pathsJSON), string(findingsJSON), string(questionsJSON), errCode, errMsg, now, jobID, workerID, leaseGen}
	}

	res, err := d.db.Exec(query, args...)
	if err != nil {
		return err
	}
	if workerID != "" && leaseGen > 0 {
		affected, _ := res.RowsAffected()
		if affected == 0 {
			return fmt.Errorf("complete job rejected: lease expired or claimed by another generation")
		}
	}
	return nil
}

// FailOrRetryJob handles a job failure during execution.
// If job.Attempts < job.MaxAttempts, it resets the job to pending for retry.
// Otherwise, it marks the job as failed.
// Returns retried (true if queued for retry, false if marked failed) and error.
func (d *DB) FailOrRetryJob(jobID string, workerID string, leaseGen int64, summary string, errCode, errMsg string) (bool, error) {
	var attempts, maxAttempts int
	err := d.db.QueryRow(`SELECT attempts, max_attempts FROM jobs WHERE id = ?`, jobID).Scan(&attempts, &maxAttempts)
	if err != nil {
		return false, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if attempts < maxAttempts {
		// Retry: reset to pending so ClaimNextJob can pick it up again
		query := `
			UPDATE jobs
			SET state = ?, result_summary = ?, error_code = ?, error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
			WHERE id = ?
		`
		args := []any{JobPending, summary, errCode, errMsg, now, jobID}
		if workerID != "" && leaseGen > 0 {
			query = `
				UPDATE jobs
				SET state = ?, result_summary = ?, error_code = ?, error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
				WHERE id = ? AND lease_owner = ? AND lease_generation = ?
			`
			args = []any{JobPending, summary, errCode, errMsg, now, jobID, workerID, leaseGen}
		}
		res, err := d.db.Exec(query, args...)
		if err != nil {
			return false, err
		}
		if workerID != "" && leaseGen > 0 {
			affected, _ := res.RowsAffected()
			if affected == 0 {
				return false, fmt.Errorf("fail/retry job rejected: lease expired")
			}
		}
		return true, nil
	}

	// Max attempts reached: mark failed
	err = d.CompleteJob(jobID, workerID, leaseGen, JobFailed, summary, nil, nil, nil, errCode, errMsg)
	return false, err
}

// SweepExpiredJobs cleans up jobs whose leases have expired.
// If attempts >= max_attempts, they are marked failed; otherwise reset to pending.
func (d *DB) SweepExpiredJobs(migrationID string) (int, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	rows, err := d.db.Query(`
		SELECT id, attempts, max_attempts
		FROM jobs
		WHERE migration_id = ? AND state = ? AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
	`, migrationID, JobRunning, now)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type expiredJob struct {
		id          string
		attempts    int
		maxAttempts int
	}
	var expired []expiredJob
	for rows.Next() {
		var ej expiredJob
		if err := rows.Scan(&ej.id, &ej.attempts, &ej.maxAttempts); err == nil {
			expired = append(expired, ej)
		}
	}

	swept := 0
	for _, ej := range expired {
		if ej.attempts >= ej.maxAttempts {
			_, _ = d.db.Exec(`
				UPDATE jobs
				SET state = ?, lease_owner = NULL, lease_expires_at = NULL, error_code = 'lease_expired', error_message = 'Job lease expired and max attempts reached', updated_at = ?
				WHERE id = ?
			`, JobFailed, now, ej.id)
		} else {
			_, _ = d.db.Exec(`
				UPDATE jobs
				SET state = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
				WHERE id = ?
			`, JobPending, now, ej.id)
		}
		swept++
	}
	return swept, nil
}

// ListJobs retrieves all jobs for a migration ordered by created_at.
func (d *DB) ListJobs(migrationID string) ([]Job, error) {
	rows, err := d.db.Query(`
		SELECT id, migration_id, source_id, idempotency_key, state, attempts, max_attempts, lease_owner, lease_generation, lease_expires_at, heartbeat_at, result_summary, changed_paths, findings, unresolved_questions, error_code, error_message, created_at, updated_at
		FROM jobs WHERE migration_id = ? ORDER BY created_at ASC
	`, migrationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var jobs []Job
	for rows.Next() {
		var j Job
		var owner, expStr, hbStr, sumStr, pathsJSON, findingsJSON, qJSON, errCode, errMsg sql.NullString
		var created, updated string
		err := rows.Scan(
			&j.ID, &j.MigrationID, &j.SourceID, &j.IdempotencyKey, &j.State, &j.Attempts, &j.MaxAttempts,
			&owner, &j.LeaseGeneration, &expStr, &hbStr, &sumStr, &pathsJSON, &findingsJSON, &qJSON,
			&errCode, &errMsg, &created, &updated,
		)
		if err != nil {
			return nil, err
		}
		j.LeaseOwner = owner.String
		if expStr.Valid && expStr.String != "" {
			t, _ := time.Parse(time.RFC3339, expStr.String)
			j.LeaseExpiresAt = &t
		}
		if hbStr.Valid && hbStr.String != "" {
			t, _ := time.Parse(time.RFC3339, hbStr.String)
			j.HeartbeatAt = &t
		}
		j.ResultSummary = sumStr.String
		j.ErrorCode = errCode.String
		j.ErrorMessage = errMsg.String
		j.CreatedAt, _ = time.Parse(time.RFC3339, created)
		j.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
		if pathsJSON.Valid && pathsJSON.String != "" {
			_ = json.Unmarshal([]byte(pathsJSON.String), &j.ChangedPaths)
		}
		if findingsJSON.Valid && findingsJSON.String != "" {
			_ = json.Unmarshal([]byte(findingsJSON.String), &j.Findings)
		}
		if qJSON.Valid && qJSON.String != "" {
			_ = json.Unmarshal([]byte(qJSON.String), &j.UnresolvedQuestions)
		}
		jobs = append(jobs, j)
	}
	return jobs, nil
}

// GetJobSummary returns count of jobs by state for a migration.
func (d *DB) GetJobSummary(migrationID string) (map[string]int, error) {
	rows, err := d.db.Query(`
		SELECT state, COUNT(*) FROM jobs WHERE migration_id = ? GROUP BY state
	`, migrationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := make(map[string]int)
	for rows.Next() {
		var st string
		var count int
		if err := rows.Scan(&st, &count); err != nil {
			return nil, err
		}
		counts[st] = count
	}
	return counts, nil
}

// MigrationProgressInfo represents live progress metrics and ETA.
type MigrationProgressInfo struct {
	Total             int        `json:"total"`
	Completed         int        `json:"completed"`
	Succeeded         int        `json:"succeeded"`
	Running           int        `json:"running"`
	Pending           int        `json:"pending"`
	Failed            int        `json:"failed"`
	Percent           int        `json:"percent"`
	CurrentFile       string     `json:"current_file,omitempty"`
	AvgDurationSec    int        `json:"avg_duration_sec,omitempty"`
	ETASec            int        `json:"eta_seconds,omitempty"`
	EstimatedFinishAt *time.Time `json:"estimated_finish_at,omitempty"`
}

// GetMigrationProgress computes progress statistics and estimated finish time.
func (d *DB) GetMigrationProgress(migrationID string) (*MigrationProgressInfo, error) {
	counts, err := d.GetJobSummary(migrationID)
	if err != nil {
		return nil, err
	}

	info := &MigrationProgressInfo{
		Succeeded: counts[JobSucceeded] + counts[JobNoChange],
		Running:   counts[JobRunning],
		Pending:   counts[JobPending],
		Failed:    counts[JobFailed] + counts[JobBlocked] + counts[JobSkipped],
	}
	info.Completed = info.Succeeded + info.Failed
	info.Total = info.Completed + info.Running + info.Pending

	if info.Total > 0 {
		info.Percent = (info.Succeeded * 100) / info.Total
	}

	// Find current running file
	var currentFile string
	row := d.db.QueryRow(`
		SELECT s.relative_path
		FROM jobs j
		JOIN sources s ON j.source_id = s.id
		WHERE j.migration_id = ? AND j.state = ?
		ORDER BY j.updated_at DESC LIMIT 1
	`, migrationID, JobRunning)
	if err := row.Scan(&currentFile); err == nil && currentFile != "" {
		info.CurrentFile = currentFile
	}

	// Calculate average job duration from succeeded jobs
	rows, err := d.db.Query(`
		SELECT updated_at FROM jobs
		WHERE migration_id = ? AND state = ?
		ORDER BY updated_at ASC
	`, migrationID, JobSucceeded)
	if err == nil {
		defer rows.Close()
		var timestamps []time.Time
		for rows.Next() {
			var tsStr string
			if scanErr := rows.Scan(&tsStr); scanErr == nil {
				if t, parseErr := time.Parse(time.RFC3339, tsStr); parseErr == nil {
					timestamps = append(timestamps, t)
				}
			}
		}

		avgSec := 80 // sensible fallback ~80s per job
		if len(timestamps) >= 2 {
			var totalDiff float64
			for i := 1; i < len(timestamps); i++ {
				diff := timestamps[i].Sub(timestamps[i-1]).Seconds()
				if diff > 0 && diff < 600 { // disregard anomalies > 10m
					totalDiff += diff
				}
			}
			if totalDiff > 0 {
				avgSec = int(totalDiff / float64(len(timestamps)-1))
				if avgSec < 30 {
					avgSec = 30
				}
			}
		}
		info.AvgDurationSec = avgSec

		remainingCount := info.Pending + info.Running
		if remainingCount > 0 && info.Running > 0 {
			info.ETASec = remainingCount * avgSec
			finish := time.Now().UTC().Add(time.Duration(info.ETASec) * time.Second)
			info.EstimatedFinishAt = &finish
		}
	}

	return info, nil
}

// CreateRevision records an immutable review revision.
func (d *DB) CreateRevision(rev ReviewRevision) error {
	filesJSON, _ := json.Marshal(rev.ChangedFiles)
	findingsJSON, _ := json.Marshal(rev.Findings)
	questionsJSON, _ := json.Marshal(rev.UnresolvedQuestions)
	now := rev.CreatedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	nowStr := now.Format(time.RFC3339)

	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec(`
		INSERT INTO revisions (id, migration_id, revision_num, baseline_hash, commit_hash, tree_hash, patch_hash, parent_rev_id, summary, changed_files, findings, unresolved_questions, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, rev.ID, rev.MigrationID, rev.RevisionNum, rev.BaselineHash, rev.CommitHash, rev.TreeHash, rev.PatchHash, rev.ParentRevID, rev.Summary, string(filesJSON), string(findingsJSON), string(questionsJSON), nowStr)
	if err != nil {
		return err
	}

	_, err = tx.Exec(`
		UPDATE migrations SET active_revision_id = ?, updated_at = ? WHERE id = ?
	`, rev.ID, nowStr, rev.MigrationID)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// GetRevision fetches a revision by ID.
func (d *DB) GetRevision(revID string) (*ReviewRevision, error) {
	row := d.db.QueryRow(`
		SELECT id, migration_id, revision_num, baseline_hash, commit_hash, tree_hash, patch_hash, parent_rev_id, summary, changed_files, findings, unresolved_questions, created_at
		FROM revisions WHERE id = ? OR CAST(revision_num AS TEXT) = ?
		ORDER BY revision_num DESC LIMIT 1
	`, revID, revID)

	var rev ReviewRevision
	var parent, summary, filesJSON, findingsJSON, questionsJSON, created string
	err := row.Scan(&rev.ID, &rev.MigrationID, &rev.RevisionNum, &rev.BaselineHash, &rev.CommitHash, &rev.TreeHash, &rev.PatchHash, &parent, &summary, &filesJSON, &findingsJSON, &questionsJSON, &created)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	rev.ParentRevID = parent
	rev.Summary = summary
	rev.CreatedAt, _ = time.Parse(time.RFC3339, created)
	if filesJSON != "" {
		_ = json.Unmarshal([]byte(filesJSON), &rev.ChangedFiles)
	}
	if findingsJSON != "" {
		_ = json.Unmarshal([]byte(findingsJSON), &rev.Findings)
	}
	if questionsJSON != "" {
		_ = json.Unmarshal([]byte(questionsJSON), &rev.UnresolvedQuestions)
	}
	return &rev, nil
}

// ListRevisions lists all revisions for a migration.
func (d *DB) ListRevisions(migrationID string) ([]ReviewRevision, error) {
	rows, err := d.db.Query(`
		SELECT id, migration_id, revision_num, baseline_hash, commit_hash, tree_hash, patch_hash, parent_rev_id, summary, changed_files, findings, unresolved_questions, created_at
		FROM revisions WHERE migration_id = ? ORDER BY revision_num ASC
	`, migrationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []ReviewRevision
	for rows.Next() {
		var rev ReviewRevision
		var parent, summary, filesJSON, findingsJSON, questionsJSON, created string
		if err := rows.Scan(&rev.ID, &rev.MigrationID, &rev.RevisionNum, &rev.BaselineHash, &rev.CommitHash, &rev.TreeHash, &rev.PatchHash, &parent, &summary, &filesJSON, &findingsJSON, &questionsJSON, &created); err != nil {
			return nil, err
		}
		rev.ParentRevID = parent
		rev.Summary = summary
		rev.CreatedAt, _ = time.Parse(time.RFC3339, created)
		if filesJSON != "" {
			_ = json.Unmarshal([]byte(filesJSON), &rev.ChangedFiles)
		}
		if findingsJSON != "" {
			_ = json.Unmarshal([]byte(findingsJSON), &rev.Findings)
		}
		if questionsJSON != "" {
			_ = json.Unmarshal([]byte(questionsJSON), &rev.UnresolvedQuestions)
		}
		list = append(list, rev)
	}
	return list, nil
}

// AddFeedback inserts a feedback comment.
func (d *DB) AddFeedback(item FeedbackItem) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := d.db.Exec(`
		INSERT INTO feedback (id, migration_id, revision_id, target_path, source_id, line_number, comment, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, item.ID, item.MigrationID, item.RevisionID, item.TargetPath, item.SourceID, item.LineNumber, item.Comment, item.Status, now)
	return err
}

// ListFeedback lists feedback items for a revision or entire migration.
func (d *DB) ListFeedback(migrationID string, revisionID string) ([]FeedbackItem, error) {
	query := `SELECT id, migration_id, revision_id, target_path, source_id, line_number, comment, status, created_at FROM feedback WHERE migration_id = ?`
	args := []any{migrationID}
	if revisionID != "" {
		query += ` AND revision_id = ?`
		args = append(args, revisionID)
	}
	query += ` ORDER BY created_at ASC`

	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []FeedbackItem
	for rows.Next() {
		var it FeedbackItem
		var target, src sql.NullString
		var line sql.NullInt64
		var created string
		if err := rows.Scan(&it.ID, &it.MigrationID, &it.RevisionID, &target, &src, &line, &it.Comment, &it.Status, &created); err != nil {
			return nil, err
		}
		it.TargetPath = target.String
		it.SourceID = src.String
		if line.Valid {
			it.LineNumber = int(line.Int64)
		}
		it.CreatedAt, _ = time.Parse(time.RFC3339, created)
		items = append(items, it)
	}
	return items, nil
}

// ResetFailedJobs resets failed jobs back to pending state for retrying.
func (d *DB) ResetFailedJobs(migrationID string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := d.db.Exec(`UPDATE jobs SET state = ?, attempts = 0, error_code = '', error_message = '', updated_at = ? WHERE migration_id = ? AND state = ?`, JobPending, now, migrationID, JobFailed)
	return err
}

// MarkFeedbackAddressed updates all submitted feedback for a migration to addressed.
func (d *DB) MarkFeedbackAddressed(migrationID string) error {
	_, err := d.db.Exec(`UPDATE feedback SET status = 'addressed' WHERE migration_id = ? AND status = 'submitted'`, migrationID)
	return err
}

// MarkFeedbackAddressedByIDs updates specified feedback items to addressed.
func (d *DB) MarkFeedbackAddressedByIDs(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	query := `UPDATE feedback SET status = 'addressed' WHERE id IN (`
	args := make([]any, len(ids))
	for i, id := range ids {
		if i > 0 {
			query += ", "
		}
		query += "?"
		args[i] = id
	}
	query += `) AND status = 'submitted'`
	_, err := d.db.Exec(query, args...)
	return err
}

// CreateApplyJournal inserts an initial apply journal entry.
func (d *DB) CreateApplyJournal(aj ApplyJournal) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := d.db.Exec(`
		INSERT INTO apply_journal (id, migration_id, revision_id, patch_hash, status, operations, error_message, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, aj.ID, aj.MigrationID, aj.RevisionID, aj.PatchHash, aj.Status, aj.Operations, aj.ErrorMessage, now, now)
	return err
}

// UpdateApplyJournalStatus updates status, error message, and updated_at timestamp.
func (d *DB) UpdateApplyJournalStatus(id, status, errorMsg string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := d.db.Exec(`
		UPDATE apply_journal
		SET status = ?, error_message = ?, updated_at = ?
		WHERE id = ?
	`, status, errorMsg, now, id)
	return err
}

// GetApplyJournal fetches an apply journal by its ID.
func (d *DB) GetApplyJournal(id string) (*ApplyJournal, error) {
	row := d.db.QueryRow(`
		SELECT id, migration_id, revision_id, patch_hash, status, operations, error_message, created_at, updated_at
		FROM apply_journal WHERE id = ?
	`, id)

	var aj ApplyJournal
	var errMsg sql.NullString
	var created, updated string
	err := row.Scan(&aj.ID, &aj.MigrationID, &aj.RevisionID, &aj.PatchHash, &aj.Status, &aj.Operations, &errMsg, &created, &updated)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	aj.ErrorMessage = errMsg.String
	aj.CreatedAt, _ = time.Parse(time.RFC3339, created)
	aj.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	return &aj, nil
}

// GetLatestApplyJournal fetches the most recent apply journal for a migration.
func (d *DB) GetLatestApplyJournal(migrationID string) (*ApplyJournal, error) {
	row := d.db.QueryRow(`
		SELECT id, migration_id, revision_id, patch_hash, status, operations, error_message, created_at, updated_at
		FROM apply_journal WHERE migration_id = ?
		ORDER BY created_at DESC LIMIT 1
	`, migrationID)

	var aj ApplyJournal
	var errMsg sql.NullString
	var created, updated string
	err := row.Scan(&aj.ID, &aj.MigrationID, &aj.RevisionID, &aj.PatchHash, &aj.Status, &aj.Operations, &errMsg, &created, &updated)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	aj.ErrorMessage = errMsg.String
	aj.CreatedAt, _ = time.Parse(time.RFC3339, created)
	aj.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	return &aj, nil
}
