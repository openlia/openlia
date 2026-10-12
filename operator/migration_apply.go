package operator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"openlia/operator/migration"
	"openlia/operator/migration/propgit"
)

// ApplyOperation describes a single file action in the atomic apply sequence.
type ApplyOperation struct {
	Type     string `json:"type"` // write, delete
	Path     string `json:"path"` // relative path
	OldHash  string `json:"old_hash,omitempty"`
	NewHash  string `json:"new_hash,omitempty"`
}

// StoredApplyJournal is the persisted on-disk format for crash recovery.
type StoredApplyJournal struct {
	ID          string           `json:"id"`
	MigrationID string           `json:"migration_id"`
	RevisionID  string           `json:"revision_id"`
	CommitHash  string           `json:"commit_hash"`
	TreeHash    string           `json:"tree_hash"`
	PatchHash   string           `json:"patch_hash"`
	Status      string           `json:"status"` // in_progress, applied, failed, rolled_back
	Operations  []ApplyOperation `json:"operations"`
	CreatedAt   time.Time        `json:"created_at"`
	UpdatedAt   time.Time        `json:"updated_at"`
}

// ApplyRevision applies an approved review revision to the live workspace atomically.
// It enforces:
// 1. Shared OS flock on workspace mutation boundary.
// 2. Migration state must be 'ready_for_review'.
// 3. Stale checks: OldHash matches for modified/deleted, live file does not exist for added.
// 4. Proposed contents are read strictly from immutable Git commit blobs, NOT disk.
// 5. Pre-images are written to disk (<migDir>/apply/rollback/<path>) before writing live files.
// 6. Recovery journal is persisted on disk before writes and updated after completion.
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

	rev, err := db.GetRevision(revisionID)
	if err != nil || rev == nil {
		return fmt.Errorf("revision %s not found: %w", revisionID, err)
	}

	if expectedPatchHash != "" && rev.PatchHash != expectedPatchHash {
		return fmt.Errorf("patch hash mismatch: expected %s, got %s", expectedPatchHash, rev.PatchHash)
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

	// 3. Stale live files check
	for _, f := range rev.ChangedFiles {
		livePath := filepath.Join(cleanLive, f.Path)
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

	// Update migration state to applying
	_ = db.UpdateMigrationState(migrationID, migration.StateApplying, "")

	// 4. Prepare operations and persist rollback pre-images to disk
	rollbackDir := filepath.Join(migDir, "apply", "rollback")
	_ = os.RemoveAll(rollbackDir)
	if err := os.MkdirAll(rollbackDir, 0o700); err != nil {
		return fmt.Errorf("create rollback dir: %w", err)
	}

	var operations []ApplyOperation
	for _, f := range rev.ChangedFiles {
		livePath := filepath.Join(cleanLive, f.Path)
		rollbackPath := filepath.Join(rollbackDir, f.Path)

		op := ApplyOperation{
			Path:    f.Path,
			OldHash: f.OldHash,
			NewHash: f.NewHash,
		}

		if f.Status == "deleted" {
			op.Type = "delete"
			if existingData, err := os.ReadFile(livePath); err == nil {
				_ = os.MkdirAll(filepath.Dir(rollbackPath), 0o700)
				_ = os.WriteFile(rollbackPath, existingData, 0o600)
			}
		} else {
			op.Type = "write"
			if existingData, err := os.ReadFile(livePath); err == nil {
				_ = os.MkdirAll(filepath.Dir(rollbackPath), 0o700)
				_ = os.WriteFile(rollbackPath, existingData, 0o600)
			}
		}
		operations = append(operations, op)
	}

	// 5. Persist durable Apply Journal before touching live files
	journal := StoredApplyJournal{
		ID:          fmt.Sprintf("app-%s-%d", migrationID, time.Now().Unix()),
		MigrationID: migrationID,
		RevisionID:  revisionID,
		CommitHash:  rev.CommitHash,
		TreeHash:    rev.TreeHash,
		PatchHash:   rev.PatchHash,
		Status:      "in_progress",
		Operations:  operations,
		CreatedAt:   time.Now().UTC(),
		UpdatedAt:   time.Now().UTC(),
	}
	journalPath := filepath.Join(migDir, "apply", "journal.json")
	journalData, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal apply journal: %w", err)
	}
	if err := os.WriteFile(journalPath, journalData, 0o600); err != nil {
		return fmt.Errorf("write apply journal: %w", err)
	}

	// 6. Execute atomic writes reading directly from Git commit blobs
	var appliedOps []ApplyOperation
	var applyErr error

	for _, op := range operations {
		livePath := filepath.Join(cleanLive, op.Path)
		if !strings.HasPrefix(filepath.Clean(livePath), cleanLive+string(filepath.Separator)) {
			applyErr = fmt.Errorf("illegal path outside live workspace: %s", op.Path)
			break
		}

		if op.Type == "delete" {
			if err := os.Remove(livePath); err != nil && !os.IsNotExist(err) {
				applyErr = fmt.Errorf("delete %s: %w", op.Path, err)
				break
			}
		} else {
			// Read proposed content directly from Git commit blob
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
		}
		appliedOps = append(appliedOps, op)
	}

	// 7. If failed mid-flight, rollback applied files using disk pre-images
	if applyErr != nil {
		for i := len(appliedOps) - 1; i >= 0; i-- {
			op := appliedOps[i]
			livePath := filepath.Join(cleanLive, op.Path)
			rollbackPath := filepath.Join(rollbackDir, op.Path)
			if preData, err := os.ReadFile(rollbackPath); err == nil {
				_ = AtomicWriteFile(livePath, preData, 0o600)
			} else {
				_ = os.Remove(livePath)
			}
		}
		journal.Status = "rolled_back"
		journal.UpdatedAt = time.Now().UTC()
		if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
			_ = os.WriteFile(journalPath, updated, 0o600)
		}
		_ = db.UpdateMigrationState(migrationID, migration.StateRecoveryRequired, "")
		return fmt.Errorf("apply failed and rolled back: %w", applyErr)
	}

	// 8. Mark revision and migration applied
	_ = db.UpdateMigrationState(migrationID, migration.StateApplied, "")
	journal.Status = "applied"
	journal.UpdatedAt = time.Now().UTC()
	if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
		_ = os.WriteFile(journalPath, updated, 0o600)
	}

	return nil
}

// ReconcileInterruptedApply recovers a crashed apply operation if journal status is in_progress.
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

	if journal.Status != "in_progress" {
		return nil // Already completed or rolled back
	}

	// Revert all operations using rollback pre-images
	liveWorkspace := filepath.Join(config.DataRoot, "workspace")
	if wsRoot := os.Getenv("OPENLIA_WORKSPACE_ROOT"); wsRoot != "" {
		liveWorkspace = wsRoot
	}
	cleanLive := filepath.Clean(liveWorkspace)
	rollbackDir := filepath.Join(migDir, "apply", "rollback")

	for i := len(journal.Operations) - 1; i >= 0; i-- {
		op := journal.Operations[i]
		livePath := filepath.Join(cleanLive, op.Path)
		rollbackPath := filepath.Join(rollbackDir, op.Path)

		if preData, err := os.ReadFile(rollbackPath); err == nil {
			_ = AtomicWriteFile(livePath, preData, 0o600)
		} else {
			_ = os.Remove(livePath)
		}
	}

	journal.Status = "rolled_back"
	journal.UpdatedAt = time.Now().UTC()
	if updated, err := json.MarshalIndent(journal, "", "  "); err == nil {
		_ = os.WriteFile(journalPath, updated, 0o600)
	}

	db, err := migration.OpenDB(migDir)
	if err == nil {
		defer db.Close()
		_ = db.UpdateMigrationState(migrationID, migration.StateRecoveryRequired, "")
	}

	return nil
}
