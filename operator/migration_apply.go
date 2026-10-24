package operator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"openlia/operator/migration"
	"openlia/operator/migration/propgit"
	"openlia/operator/migration/security"
)

// ApplyOperation describes a single file action in the atomic apply sequence.
type ApplyOperation struct {
	Type          string `json:"type"` // write, delete
	Path          string `json:"path"` // relative path
	ExistedBefore bool   `json:"existed_before"`
	OldHash       string `json:"old_hash,omitempty"`
	NewHash       string `json:"new_hash,omitempty"`
	BackupPath    string `json:"backup_path,omitempty"`
	Status        string `json:"status"` // pending, applied, rolled_back, failed
}

// StoredApplyJournal is the persisted on-disk format for crash recovery.
type StoredApplyJournal struct {
	ID          string           `json:"id"`
	MigrationID string           `json:"migration_id"`
	RevisionID  string           `json:"revision_id"`
	CommitHash  string           `json:"commit_hash"`
	TreeHash    string           `json:"tree_hash"`
	PatchHash   string           `json:"patch_hash"`
	Status      string           `json:"status"` // preparing, applying, rolling_back, rolled_back, applied, failed, resolved
	Operations  []ApplyOperation `json:"operations"`
	CreatedAt   time.Time        `json:"created_at"`
	UpdatedAt   time.Time        `json:"updated_at"`
}

// RecoveryResult reports the outcome of a migration recovery action.
type RecoveryResult struct {
	Action      string              `json:"action"`
	MigrationID string              `json:"migration_id"`
	Status      string              `json:"status"`
	Message     string              `json:"message"`
	Journal     *StoredApplyJournal `json:"journal,omitempty"`
}

// ApplyRevision applies an approved review revision to the live workspace atomically.
func ApplyRevision(config Config, migrationID string, revisionID string, expectedPatchHash string) error {
	migDir := MigrationRoot(config, migrationID)
	db, err := migration.OpenDB(migDir)
	if err != nil {
		return fmt.Errorf("open migration db: %w", err)
	}
	defer db.Close()

	// 1. Acquire workspace mutation lock
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	unlock, err := AcquireWorkspaceLock(ctx, config)
	if err != nil {
		return fmt.Errorf("acquire workspace mutation lock: %w", err)
	}
	defer unlock()

	// 2. Reconcile any prior interrupted apply
	if err := ReconcileInterruptedApply(config, migrationID); err != nil {
		return fmt.Errorf("reconcile prior apply: %w", err)
	}

	mig, err := db.GetMigration(migrationID)
	if err != nil || mig == nil {
		return fmt.Errorf("migration %s not found: %w", migrationID, err)
	}
	if mig.State != migration.StateReadyForReview {
		return fmt.Errorf("migration %s is in state '%s', not '%s'", migrationID, mig.State, migration.StateReadyForReview)
	}

	if revisionID == "" {
		revisionID = mig.ActiveRevisionID
	}

	rev, err := db.GetRevision(revisionID)
	if err != nil || rev == nil {
		return fmt.Errorf("revision %s not found: %w", revisionID, err)
	}
	if rev.MigrationID != migrationID {
		return fmt.Errorf("revision %s belongs to migration %s, not %s", revisionID, rev.MigrationID, migrationID)
	}

	liveWorkspace := filepath.Join(config.DataRoot, "workspace")
	if wsRoot := os.Getenv("OPENLIA_WORKSPACE_ROOT"); wsRoot != "" {
		liveWorkspace = wsRoot
	}
	cleanLive := filepath.Clean(liveWorkspace)

	propRepoDir := filepath.Join(migDir, "proposal-repo")
	repo, err := propgit.OpenOrCreateRepo(propRepoDir)
	if err != nil {
		return fmt.Errorf("open proposal repo: %w", err)
	}

	// Verify revision commit exists in proposal repo
	if rev.CommitHash == "" {
		return fmt.Errorf("revision %s has empty commit hash", revisionID)
	}
	actualTree, err := repo.GetTreeHash(rev.CommitHash)
	if err != nil {
		return fmt.Errorf("verify commit %s tree: %w", rev.CommitHash, err)
	}
	if rev.TreeHash != "" && actualTree != rev.TreeHash {
		return fmt.Errorf("tree hash mismatch: expected %s, got %s", rev.TreeHash, actualTree)
	}

	// Recompute diff and patch hash from proposal repo to guard integrity
	diff, err := repo.Diff(mig.BaselineManifest, rev.CommitHash)
	if err != nil {
		return fmt.Errorf("recompute revision diff: %w", err)
	}
	actualPatchHash := propgit.ComputePatchHash(diff)
	if rev.PatchHash != actualPatchHash {
		return fmt.Errorf("patch hash mismatch: computed %s, revision has %s", actualPatchHash, rev.PatchHash)
	}
	if expectedPatchHash != "" && rev.PatchHash != expectedPatchHash {
		return fmt.Errorf("expected patch hash mismatch: expected %s, got %s", expectedPatchHash, rev.PatchHash)
	}

	// Recompute changed files with deterministic --no-renames decomposition
	changedFiles, err := repo.GetChangedFiles(mig.BaselineManifest, rev.CommitHash)
	if err != nil {
		return fmt.Errorf("recompute changed files: %w", err)
	}

	// 2b. Auto-install any built-in features whose domains are touched by changedFiles
	if config.RepositoryRoot != "" && len(changedFiles) > 0 {
		var changedPaths []string
		for _, f := range changedFiles {
			changedPaths = append(changedPaths, f.Path)
		}
		if detectedFeatures, detectErr := DetectFeaturesForPaths(config.RepositoryRoot, changedPaths); detectErr == nil {
			for _, featureID := range detectedFeatures {
				_, _ = FeatureInstall(config, featureID, true, time.Now().UTC())
			}
		}
	}

	// 3. Stale live files check & security boundary verification
	for _, f := range changedFiles {
		if err := security.ValidateSafeWorkspacePath(cleanLive, f.Path); err != nil {
			_ = db.UpdateMigrationState(migrationID, migration.StateFailed, "")
			return fmt.Errorf("security violation: %w", err)
		}

		livePath := filepath.Join(cleanLive, filepath.FromSlash(f.Path))
		if f.Status == "added" {
			if _, err := os.Stat(livePath); err == nil {
				_ = db.UpdateMigrationState(migrationID, migration.StateStale, "")
				return fmt.Errorf("stale check failed: file already exists in live workspace: %s", f.Path)
			}
		} else if f.Status == "modified" {
			data, err := os.ReadFile(livePath)
			if err != nil {
				_ = db.UpdateMigrationState(migrationID, migration.StateStale, "")
				return fmt.Errorf("stale check failed: cannot read existing live file: %s", f.Path)
			}
			h := sha256.Sum256(data)
			curHash := hex.EncodeToString(h[:])
			if f.OldHash != "" && curHash != f.OldHash {
				_ = db.UpdateMigrationState(migrationID, migration.StateStale, "")
				return fmt.Errorf("stale check failed: live file %s changed concurrently (expected hash %s, got %s)", f.Path, f.OldHash, curHash)
			}
		} else if f.Status == "deleted" {
			data, err := os.ReadFile(livePath)
			if err != nil {
				if os.IsNotExist(err) {
					_ = db.UpdateMigrationState(migrationID, migration.StateStale, "")
					return fmt.Errorf("stale check failed: live file %s already deleted", f.Path)
				}
				_ = db.UpdateMigrationState(migrationID, migration.StateStale, "")
				return fmt.Errorf("stale check failed: cannot read live file to be deleted: %s", f.Path)
			}
			h := sha256.Sum256(data)
			curHash := hex.EncodeToString(h[:])
			if f.OldHash != "" && curHash != f.OldHash {
				_ = db.UpdateMigrationState(migrationID, migration.StateStale, "")
				return fmt.Errorf("stale check failed: live file %s changed concurrently before deletion", f.Path)
			}
		}
	}

	// 4. Prepare operations and persist rollback pre-images to disk
	rollbackDir := filepath.Join(migDir, "apply", "rollback")
	_ = os.RemoveAll(rollbackDir)
	if err := os.MkdirAll(rollbackDir, 0o700); err != nil {
		return fmt.Errorf("create rollback dir: %w", err)
	}

	var operations []ApplyOperation
	for _, f := range changedFiles {
		livePath := filepath.Join(cleanLive, filepath.FromSlash(f.Path))
		rollbackPath := filepath.Join(rollbackDir, filepath.FromSlash(f.Path))

		op := ApplyOperation{
			Path:    f.Path,
			OldHash: f.OldHash,
			NewHash: f.NewHash,
			Status:  "pending",
		}

		if f.Status == "deleted" {
			op.Type = "delete"
			existingData, err := os.ReadFile(livePath)
			if err != nil {
				return fmt.Errorf("capture pre-image for delete %s: %w", f.Path, err)
			}
			if err := os.MkdirAll(filepath.Dir(rollbackPath), 0o700); err != nil {
				return fmt.Errorf("mkdir rollback dir for %s: %w", f.Path, err)
			}
			if err := AtomicWriteFile(rollbackPath, existingData, 0o600); err != nil {
				return fmt.Errorf("write rollback pre-image for %s: %w", f.Path, err)
			}
			op.ExistedBefore = true
			op.BackupPath = rollbackPath
		} else {
			op.Type = "write"
			if existingData, err := os.ReadFile(livePath); err == nil {
				if err := os.MkdirAll(filepath.Dir(rollbackPath), 0o700); err != nil {
					return fmt.Errorf("mkdir rollback dir for %s: %w", f.Path, err)
				}
				if err := AtomicWriteFile(rollbackPath, existingData, 0o600); err != nil {
					return fmt.Errorf("write rollback pre-image for %s: %w", f.Path, err)
				}
				op.ExistedBefore = true
				op.BackupPath = rollbackPath
			} else {
				op.ExistedBefore = false
			}
		}
		operations = append(operations, op)
	}

	// 5. Persist durable Apply Journal (both disk and sqlite) before touching live files
	journalID := fmt.Sprintf("app-%s-%d", migrationID, time.Now().Unix())
	journal := StoredApplyJournal{
		ID:          journalID,
		MigrationID: migrationID,
		RevisionID:  revisionID,
		CommitHash:  rev.CommitHash,
		TreeHash:    rev.TreeHash,
		PatchHash:   rev.PatchHash,
		Status:      "applying",
		Operations:  operations,
		CreatedAt:   time.Now().UTC(),
		UpdatedAt:   time.Now().UTC(),
	}

	journalPath := filepath.Join(migDir, "apply", "journal.json")
	journalData, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal apply journal: %w", err)
	}
	if err := AtomicWriteFile(journalPath, journalData, 0o600); err != nil {
		return fmt.Errorf("write apply journal: %w", err)
	}

	opsJSON, _ := json.Marshal(operations)
	_ = db.CreateApplyJournal(migration.ApplyJournal{
		ID:          journalID,
		MigrationID: migrationID,
		RevisionID:  revisionID,
		PatchHash:   rev.PatchHash,
		Status:      "applying",
		Operations:  string(opsJSON),
		CreatedAt:   journal.CreatedAt,
		UpdatedAt:   journal.UpdatedAt,
	})

	// Transition migration state to applying
	if err := db.UpdateMigrationState(migrationID, migration.StateApplying, ""); err != nil {
		return fmt.Errorf("update migration state to applying: %w", err)
	}

	// 6. Execute atomic writes reading directly from Git commit blobs
	var appliedCount int
	var applyErr error

	for i := range operations {
		op := &operations[i]
		livePath := filepath.Join(cleanLive, filepath.FromSlash(op.Path))

		if err := security.ValidateSafeWorkspacePath(cleanLive, op.Path); err != nil {
			applyErr = fmt.Errorf("security check on %s: %w", op.Path, err)
			break
		}

		if op.Type == "delete" {
			if err := os.Remove(livePath); err != nil && !os.IsNotExist(err) {
				applyErr = fmt.Errorf("delete %s: %w", op.Path, err)
				break
			}
		} else {
			propData, err := repo.ReadFileAtCommit(rev.CommitHash, op.Path)
			if err != nil {
				applyErr = fmt.Errorf("read blob %s from commit %s: %w", op.Path, rev.CommitHash, err)
				break
			}
			if err := os.MkdirAll(filepath.Dir(livePath), 0o700); err != nil {
				applyErr = fmt.Errorf("mkdir %s: %w", filepath.Dir(livePath), err)
				break
			}
			if err := AtomicWriteFile(livePath, propData, 0o600); err != nil {
				applyErr = fmt.Errorf("write %s: %w", livePath, err)
				break
			}
			if config.RuntimeUID > 0 && config.RuntimeGID > 0 && os.Geteuid() == 0 {
				_ = os.Chown(livePath, config.RuntimeUID, config.RuntimeGID)
			}
		}
		op.Status = "applied"
		appliedCount++
	}

	// 7. If failed mid-flight, rollback applied files using disk pre-images
	if applyErr != nil {
		_ = db.UpdateMigrationState(migrationID, migration.StateRollingBack, "")
		_ = db.UpdateApplyJournalStatus(journalID, "rolling_back", applyErr.Error())

		rollbackFailed := false
		for i := appliedCount - 1; i >= 0; i-- {
			op := &operations[i]
			livePath := filepath.Join(cleanLive, filepath.FromSlash(op.Path))

			if op.ExistedBefore {
				if op.BackupPath != "" {
					preData, err := os.ReadFile(op.BackupPath)
					if err == nil {
						_ = AtomicWriteFile(livePath, preData, 0o600)
						op.Status = "rolled_back"
					} else {
						rollbackFailed = true
						op.Status = "failed"
					}
				} else {
					rollbackFailed = true
					op.Status = "failed"
				}
			} else {
				_ = os.Remove(livePath)
				op.Status = "rolled_back"
			}
		}

		journal.Operations = operations
		journal.UpdatedAt = time.Now().UTC()

		if rollbackFailed {
			journal.Status = "failed"
			if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
				_ = AtomicWriteFile(journalPath, updated, 0o600)
			}
			_ = db.UpdateApplyJournalStatus(journalID, "failed", fmt.Sprintf("Apply failed: %v. Rollback incomplete.", applyErr))
			_ = db.UpdateMigrationState(migrationID, migration.StateRecoveryRequired, "")
			return fmt.Errorf("apply failed and rollback incomplete (entered recovery_required): %w", applyErr)
		}

		journal.Status = "rolled_back"
		if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
			_ = AtomicWriteFile(journalPath, updated, 0o600)
		}
		_ = db.UpdateApplyJournalStatus(journalID, "rolled_back", applyErr.Error())
		_ = db.UpdateMigrationState(migrationID, migration.StateReadyForReview, "")
		return fmt.Errorf("apply failed and rolled back cleanly: %w", applyErr)
	}

	// 8. Mark revision and migration applied
	journal.Status = "applied"
	journal.UpdatedAt = time.Now().UTC()
	if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
		_ = AtomicWriteFile(journalPath, updated, 0o600)
	}
	_ = db.UpdateApplyJournalStatus(journalID, "applied", "")
	_ = db.UpdateMigrationState(migrationID, migration.StateApplied, "")

	return nil
}

// ReconcileInterruptedApply recovers a crashed apply operation if journal status is applying or rolling_back.
func ReconcileInterruptedApply(config Config, migrationID string) error {
	migDir := MigrationRoot(config, migrationID)
	journalPath := filepath.Join(migDir, "apply", "journal.json")
	data, err := os.ReadFile(journalPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // No apply ever initiated
		}
		return fmt.Errorf("read apply journal: %w", err)
	}

	var journal StoredApplyJournal
	if err := json.Unmarshal(data, &journal); err != nil {
		return fmt.Errorf("unmarshal apply journal: %w", err)
	}

	if journal.Status != "applying" && journal.Status != "rolling_back" && journal.Status != "in_progress" {
		return nil // Already completed or cleanly rolled back
	}

	// Rollback applied operations using disk pre-images
	liveWorkspace := filepath.Join(config.DataRoot, "workspace")
	if wsRoot := os.Getenv("OPENLIA_WORKSPACE_ROOT"); wsRoot != "" {
		liveWorkspace = wsRoot
	}
	cleanLive := filepath.Clean(liveWorkspace)

	rollbackFailed := false
	for i := len(journal.Operations) - 1; i >= 0; i-- {
		op := &journal.Operations[i]
		livePath := filepath.Join(cleanLive, filepath.FromSlash(op.Path))

		if op.ExistedBefore {
			if op.BackupPath != "" {
				if preData, err := os.ReadFile(op.BackupPath); err == nil {
					_ = AtomicWriteFile(livePath, preData, 0o600)
					op.Status = "rolled_back"
				} else {
					rollbackFailed = true
					op.Status = "failed"
				}
			} else {
				rollbackFailed = true
				op.Status = "failed"
			}
		} else {
			_ = os.Remove(livePath)
			op.Status = "rolled_back"
		}
	}

	journal.UpdatedAt = time.Now().UTC()
	db, _ := migration.OpenDB(migDir)
	if db != nil {
		defer db.Close()
	}

	if rollbackFailed {
		journal.Status = "failed"
		if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
			_ = AtomicWriteFile(journalPath, updated, 0o600)
		}
		if db != nil {
			_ = db.UpdateApplyJournalStatus(journal.ID, "failed", "Crash recovery rollback incomplete")
			_ = db.UpdateMigrationState(migrationID, migration.StateRecoveryRequired, "")
		}
		return fmt.Errorf("crash recovery rollback failed: missing pre-images (entered recovery_required)")
	}

	journal.Status = "rolled_back"
	if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
		_ = AtomicWriteFile(journalPath, updated, 0o600)
	}
	if db != nil {
		_ = db.UpdateApplyJournalStatus(journal.ID, "rolled_back", "Interrupted apply cleanly rolled back")
		_ = db.UpdateMigrationState(migrationID, migration.StateReadyForReview, "")
	}

	return nil
}

// RecoverMigration provides manual inspection, retry, rollback, or resolution for recovery_required migrations.
func RecoverMigration(config Config, migrationID string, action string) (*RecoveryResult, error) {
	if action == "" {
		action = "inspect"
	}

	migDir := MigrationRoot(config, migrationID)
	db, err := migration.OpenDB(migDir)
	if err != nil {
		return nil, fmt.Errorf("open migration db: %w", err)
	}
	defer db.Close()

	mig, err := db.GetMigration(migrationID)
	if err != nil || mig == nil {
		return nil, fmt.Errorf("migration %s not found: %w", migrationID, err)
	}

	journalPath := filepath.Join(migDir, "apply", "journal.json")
	var journal StoredApplyJournal
	journalFound := false
	if data, err := os.ReadFile(journalPath); err == nil {
		if err := json.Unmarshal(data, &journal); err == nil {
			journalFound = true
		}
	}

	switch action {
	case "inspect":
		msg := fmt.Sprintf("Migration %s is in state '%s'.", migrationID, mig.State)
		if journalFound {
			msg += fmt.Sprintf(" Journal status: '%s' with %d operations.", journal.Status, len(journal.Operations))
		} else {
			msg += " No on-disk apply journal found."
		}
		return &RecoveryResult{
			Action:      action,
			MigrationID: migrationID,
			Status:      mig.State,
			Message:     msg,
			Journal:     &journal,
		}, nil

	case "rollback":
		// Force rollback of any operations using available pre-images
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		unlock, err := AcquireWorkspaceLock(ctx, config)
		if err != nil {
			return nil, fmt.Errorf("acquire workspace lock: %w", err)
		}
		defer unlock()

		liveWorkspace := filepath.Join(config.DataRoot, "workspace")
		if wsRoot := os.Getenv("OPENLIA_WORKSPACE_ROOT"); wsRoot != "" {
			liveWorkspace = wsRoot
		}
		cleanLive := filepath.Clean(liveWorkspace)

		for i := len(journal.Operations) - 1; i >= 0; i-- {
			op := &journal.Operations[i]
			livePath := filepath.Join(cleanLive, filepath.FromSlash(op.Path))
			if op.ExistedBefore && op.BackupPath != "" {
				if preData, err := os.ReadFile(op.BackupPath); err == nil {
					_ = AtomicWriteFile(livePath, preData, 0o600)
					op.Status = "rolled_back"
				}
			} else if !op.ExistedBefore {
				_ = os.Remove(livePath)
				op.Status = "rolled_back"
			}
		}

		journal.Status = "rolled_back"
		journal.UpdatedAt = time.Now().UTC()
		if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
			_ = AtomicWriteFile(journalPath, updated, 0o600)
		}
		_ = db.UpdateApplyJournalStatus(journal.ID, "rolled_back", "Manual recovery rollback completed")
		_ = db.UpdateMigrationState(migrationID, migration.StateReadyForReview, "")

		return &RecoveryResult{
			Action:      action,
			MigrationID: migrationID,
			Status:      migration.StateReadyForReview,
			Message:     "Pre-images successfully restored. Migration reset to ready_for_review.",
			Journal:     &journal,
		}, nil

	case "retry":
		// Retry forward apply for the active revision
		if err := ApplyRevision(config, migrationID, mig.ActiveRevisionID, ""); err != nil {
			return nil, fmt.Errorf("retry apply: %w", err)
		}
		return &RecoveryResult{
			Action:      action,
			MigrationID: migrationID,
			Status:      migration.StateApplied,
			Message:     "Migration apply retried and succeeded.",
			Journal:     &journal,
		}, nil

	case "resolve":
		// Operator confirms workspace is resolved
		journal.Status = "resolved"
		journal.UpdatedAt = time.Now().UTC()
		if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
			_ = AtomicWriteFile(journalPath, updated, 0o600)
		}
		_ = db.UpdateApplyJournalStatus(journal.ID, "resolved", "Operator resolved recovery manually")
		_ = db.UpdateMigrationState(migrationID, migration.StateReadyForReview, "")

		return &RecoveryResult{
			Action:      action,
			MigrationID: migrationID,
			Status:      migration.StateReadyForReview,
			Message:     "Migration marked resolved. State reset to ready_for_review.",
			Journal:     &journal,
		}, nil

	default:
		return nil, fmt.Errorf("unknown recovery action '%s': supported actions are inspect, rollback, retry, resolve", action)
	}
}
