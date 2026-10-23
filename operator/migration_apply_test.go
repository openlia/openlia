package operator

import (
	"os"
	"path/filepath"
	"testing"

	"openlia/operator/migration"
	"openlia/operator/migration/propgit"
)

func setupTestMigration(t *testing.T) (Config, string, *propgit.ProposalRepo, string, *migration.DB) {
	tmpDir := t.TempDir()
	wsDir := filepath.Join(tmpDir, "workspace")
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Initial workspace files
	if err := os.WriteFile(filepath.Join(wsDir, "existing.md"), []byte("initial existing content"), 0o644); err != nil {
		t.Fatal(err)
	}

	config := Config{
		DataRoot:    tmpDir,
		RuntimeRoot: filepath.Join(tmpDir, "runtime"),
	}

	migID := "test-mig-apply-1"
	migDir := MigrationRoot(config, migID)
	if err := os.MkdirAll(migDir, 0o755); err != nil {
		t.Fatal(err)
	}

	propRepoDir := filepath.Join(migDir, "proposal-repo")
	repo, err := propgit.OpenOrCreateRepo(propRepoDir)
	if err != nil {
		t.Fatalf("OpenOrCreateRepo: %v", err)
	}

	baselineCommit, err := repo.CaptureBaseline(wsDir)
	if err != nil {
		t.Fatalf("CaptureBaseline: %v", err)
	}

	db, err := migration.OpenDB(migDir)
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}

	mig := migration.Migration{
		ID:               migID,
		Schema:           2,
		State:            migration.StateReadyForReview,
		BaselineManifest: baselineCommit,
	}
	if err := db.CreateMigration(mig); err != nil {
		t.Fatalf("CreateMigration: %v", err)
	}

	return config, migID, repo, baselineCommit, db
}

func TestApplyRevision_Success(t *testing.T) {
	config, migID, repo, baselineCommit, db := setupTestMigration(t)
	defer db.Close()

	// Propose changes: modify existing.md and add new.md
	wsProposal := repo.RepoDir
	if err := os.WriteFile(filepath.Join(wsProposal, "existing.md"), []byte("modified content"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wsProposal, "new.md"), []byte("brand new file"), 0o644); err != nil {
		t.Fatal(err)
	}

	commitHash, err := repo.CheckpointJob("job-1", "edit files")
	if err != nil {
		t.Fatalf("CheckpointJob: %v", err)
	}
	treeHash, _ := repo.GetTreeHash(commitHash)
	diff, _ := repo.Diff(baselineCommit, commitHash)
	patchHash := propgit.ComputePatchHash(diff)

	rev := migration.ReviewRevision{
		ID:           "rev-success",
		MigrationID:  migID,
		RevisionNum:  1,
		BaselineHash: baselineCommit,
		CommitHash:   commitHash,
		TreeHash:     treeHash,
		PatchHash:    patchHash,
	}
	if err := db.CreateRevision(rev); err != nil {
		t.Fatal(err)
	}

	if err := ApplyRevision(config, migID, "rev-success", patchHash); err != nil {
		t.Fatalf("ApplyRevision failed: %v", err)
	}

	// Verify live workspace
	liveWorkspace := filepath.Join(config.DataRoot, "workspace")
	dataExist, _ := os.ReadFile(filepath.Join(liveWorkspace, "existing.md"))
	if string(dataExist) != "modified content" {
		t.Errorf("existing.md content = %q, expected %q", string(dataExist), "modified content")
	}
	dataNew, _ := os.ReadFile(filepath.Join(liveWorkspace, "new.md"))
	if string(dataNew) != "brand new file" {
		t.Errorf("new.md content = %q, expected %q", string(dataNew), "brand new file")
	}

	// Verify migration state
	mig, _ := db.GetMigration(migID)
	if mig.State != migration.StateApplied {
		t.Errorf("migration state = %s, expected %s", mig.State, migration.StateApplied)
	}
}

func TestApplyRevision_RollbackOnSecurityViolation(t *testing.T) {
	config, migID, repo, baselineCommit, db := setupTestMigration(t)
	defer db.Close()

	// Propose changes including a protected path
	wsProposal := repo.RepoDir
	if err := os.WriteFile(filepath.Join(wsProposal, "AGENTS.md"), []byte("malicious overwrite"), 0o644); err != nil {
		t.Fatal(err)
	}

	commitHash, err := repo.CheckpointJob("job-sec", "security violation")
	if err != nil {
		t.Fatal(err)
	}
	treeHash, _ := repo.GetTreeHash(commitHash)
	diff, _ := repo.Diff(baselineCommit, commitHash)
	patchHash := propgit.ComputePatchHash(diff)

	rev := migration.ReviewRevision{
		ID:           "rev-sec",
		MigrationID:  migID,
		RevisionNum:  1,
		BaselineHash: baselineCommit,
		CommitHash:   commitHash,
		TreeHash:     treeHash,
		PatchHash:    patchHash,
	}
	if err := db.CreateRevision(rev); err != nil {
		t.Fatal(err)
	}

	err = ApplyRevision(config, migID, "rev-sec", patchHash)
	if err == nil {
		t.Fatalf("expected ApplyRevision to fail on protected path violation")
	}

	// Verify AGENTS.md was never created in live workspace
	liveWorkspace := filepath.Join(config.DataRoot, "workspace")
	if _, err := os.Stat(filepath.Join(liveWorkspace, "AGENTS.md")); !os.IsNotExist(err) {
		t.Errorf("AGENTS.md was written despite security violation")
	}
}

func TestRecoverMigration_InspectAndRollback(t *testing.T) {
	config, migID, repo, baselineCommit, db := setupTestMigration(t)
	defer db.Close()

	// Prepare proposal
	wsProposal := repo.RepoDir
	if err := os.WriteFile(filepath.Join(wsProposal, "existing.md"), []byte("corrupted edit"), 0o644); err != nil {
		t.Fatal(err)
	}
	commitHash, _ := repo.CheckpointJob("job-corrupt", "corrupt edit")
	treeHash, _ := repo.GetTreeHash(commitHash)
	diff, _ := repo.Diff(baselineCommit, commitHash)
	patchHash := propgit.ComputePatchHash(diff)

	rev := migration.ReviewRevision{
		ID:           "rev-rec",
		MigrationID:  migID,
		RevisionNum:  1,
		BaselineHash: baselineCommit,
		CommitHash:   commitHash,
		TreeHash:     treeHash,
		PatchHash:    patchHash,
	}
	_ = db.CreateRevision(rev)

	// Inject a pre-created failed journal in recovery_required state
	migDir := MigrationRoot(config, migID)
	journalPath := filepath.Join(migDir, "apply", "journal.json")
	_ = os.MkdirAll(filepath.Dir(journalPath), 0o700)
	rollbackPath := filepath.Join(migDir, "apply", "rollback", "existing.md")
	_ = os.MkdirAll(filepath.Dir(rollbackPath), 0o700)
	_ = os.WriteFile(rollbackPath, []byte("initial existing content"), 0o600)

	// Live file is currently changed to corrupted
	liveWorkspace := filepath.Join(config.DataRoot, "workspace")
	_ = os.WriteFile(filepath.Join(liveWorkspace, "existing.md"), []byte("corrupted edit"), 0o644)

	_ = AtomicWriteFile(journalPath, []byte(`{
		"id": "app-manual-1",
		"migration_id": "`+migID+`",
		"revision_id": "rev-rec",
		"status": "failed",
		"operations": [
			{
				"type": "write",
				"path": "existing.md",
				"existed_before": true,
				"backup_path": "`+rollbackPath+`",
				"status": "applied"
			}
		]
	}`), 0o600)

	_ = db.UpdateMigrationState(migID, migration.StateApplying, "")
	if err := db.UpdateMigrationState(migID, migration.StateRecoveryRequired, ""); err != nil {
		t.Fatalf("set recovery_required state: %v", err)
	}

	// 1. Inspect
	res, err := RecoverMigration(config, migID, "inspect")
	if err != nil {
		t.Fatalf("RecoverMigration inspect: %v", err)
	}
	if res.Status != migration.StateRecoveryRequired {
		t.Errorf("expected status recovery_required, got %s", res.Status)
	}

	// 2. Rollback
	resRollback, err := RecoverMigration(config, migID, "rollback")
	if err != nil {
		t.Fatalf("RecoverMigration rollback: %v", err)
	}
	if resRollback.Status != migration.StateReadyForReview {
		t.Errorf("expected status ready_for_review after rollback, got %s", resRollback.Status)
	}

	// Verify live file restored to initial
	data, _ := os.ReadFile(filepath.Join(liveWorkspace, "existing.md"))
	if string(data) != "initial existing content" {
		t.Errorf("expected live file restored to initial content, got %q", string(data))
	}
}
