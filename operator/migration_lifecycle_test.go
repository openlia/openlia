package operator

import (
	"os"
	"path/filepath"
	"testing"

	"openlia/operator/migration"
	"openlia/operator/migration/propgit"
)

func TestMigrationLifecycleAndApply(t *testing.T) {
	tempRoot := t.TempDir()
	dataRoot := filepath.Join(tempRoot, "data")
	runtimeRoot := filepath.Join(tempRoot, "runtime")
	_ = os.MkdirAll(dataRoot, 0o700)
	_ = os.MkdirAll(runtimeRoot, 0o700)

	liveWorkspace := filepath.Join(dataRoot, "workspace")
	_ = os.MkdirAll(liveWorkspace, 0o700)
	_ = os.WriteFile(filepath.Join(liveWorkspace, "existing.md"), []byte("# Existing Note\n"), 0o600)

	config := Config{
		DataRoot:    dataRoot,
		RuntimeRoot: runtimeRoot,
	}

	migID := "mig-test-lifecycle"
	migDir := MigrationRoot(config, migID)
	_ = os.MkdirAll(migDir, 0o700)

	// Create test source folder and zip/tar
	sourceDir := filepath.Join(migDir, "source")
	_ = os.MkdirAll(sourceDir, 0o700)
	_ = os.WriteFile(filepath.Join(sourceDir, "trip.md"), []byte("# Tokyo Trip\n"), 0o600)

	// Init migration
	mig, err := InitMigrationV2(config, migID)
	if err != nil {
		t.Fatalf("InitMigrationV2 failed: %v", err)
	}
	if mig.Schema != 2 || mig.State != migration.StateQueued {
		t.Fatalf("unexpected migration init state: %+v", mig)
	}

	// Verify Stop
	if err := StopMigration(config, migID); err != nil {
		t.Fatalf("StopMigration failed: %v", err)
	}

	statusObj, err := GetMigrationStatusV2(config, migID)
	if err != nil {
		t.Fatalf("GetMigrationStatusV2 failed: %v", err)
	}
	statusMap, ok := statusObj.(map[string]any)
	if !ok || statusMap["state"] != migration.StateStopped {
		t.Fatalf("expected state stopped, got: %+v", statusObj)
	}

	// Verify Diff when no revisions yet
	_, diffErr := GetMigrationDiffV2(config, migID, 0, 0)
	if diffErr == nil {
		t.Fatalf("expected diff error before revision publish, got nil")
	}

	// Simulate supervisor completion with mock file in proposal repo
	propRepoDir := filepath.Join(migDir, "proposal-repo")
	repo, err := propgit.OpenOrCreateRepo(propRepoDir)
	if err != nil {
		t.Fatalf("OpenOrCreateRepo failed: %v", err)
	}
	tripContent := "# Tokyo Trip Plan\nDetailed guide.\n"
	_ = os.WriteFile(filepath.Join(propRepoDir, "trip.md"), []byte(tripContent), 0o600)
	commitHash, err := repo.CheckpointJob("job-0001", "trip.md")
	if err != nil {
		t.Fatalf("CheckpointJob failed: %v", err)
	}
	treeHash, err := repo.GetTreeHash(commitHash)
	if err != nil {
		t.Fatalf("GetTreeHash failed: %v", err)
	}

	// Open DB and set state to ready_for_review, then publish a test revision
	db, err := migration.OpenDB(migDir)
	if err != nil {
		t.Fatalf("OpenDB failed: %v", err)
	}
	defer db.Close()

	if err := db.UpdateMigrationState(migID, migration.StateReadyForReview, ""); err != nil {
		t.Fatalf("UpdateMigrationState failed: %v", err)
	}

	rev := migration.ReviewRevision{
		ID:           "rev-1",
		MigrationID:  migID,
		RevisionNum:  1,
		BaselineHash: mig.BaselineManifest,
		CommitHash:   commitHash,
		TreeHash:     treeHash,
		PatchHash:    "dummy_patch_hash",
		ChangedFiles: []migration.ChangedFileEntry{
			{Path: "trip.md", Status: "added"},
		},
	}
	if err := db.CreateRevision(rev); err != nil {
		t.Fatalf("CreateRevision failed: %v", err)
	}

	// Apply revision
	if err := ApplyRevision(config, migID, "rev-1", "dummy_patch_hash"); err != nil {
		t.Fatalf("ApplyRevision failed: %v", err)
	}

	// Verify trip.md now exists in live workspace
	liveTrip := filepath.Join(liveWorkspace, "trip.md")
	content, err := os.ReadFile(liveTrip)
	if err != nil || string(content) != "# Tokyo Trip Plan\nDetailed guide.\n" {
		t.Fatalf("unexpected applied content: %s (err: %v)", string(content), err)
	}

	// Verify existing live note was untouched
	liveExisting := filepath.Join(liveWorkspace, "existing.md")
	existingContent, err := os.ReadFile(liveExisting)
	if err != nil || string(existingContent) != "# Existing Note\n" {
		t.Fatalf("existing note was corrupted: %s", string(existingContent))
	}
}
