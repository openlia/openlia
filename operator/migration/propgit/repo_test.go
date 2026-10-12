package propgit

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProposalRepo_BaselineAndCheckpoints(t *testing.T) {
	// Create mock live workspace
	liveDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(liveDir, "note.md"), []byte("# Live Note\nExisting content.\n"), 0o600)
	// Create secret file to ensure excluded
	_ = os.MkdirAll(filepath.Join(liveDir, "sources"), 0o700)
	_ = os.WriteFile(filepath.Join(liveDir, "sources", "document-passwords.toml"), []byte("secret=123"), 0o600)

	// Create proposal repo
	repoDir := t.TempDir()
	repo, err := OpenOrCreateRepo(repoDir)
	if err != nil {
		t.Fatalf("OpenOrCreateRepo failed: %v", err)
	}

	baseCommit, err := repo.CaptureBaseline(liveDir)
	if err != nil {
		t.Fatalf("CaptureBaseline failed: %v", err)
	}
	if baseCommit == "" {
		t.Fatalf("baseCommit should not be empty")
	}

	// Verify secret was excluded
	if _, err := os.Stat(filepath.Join(repoDir, "sources", "document-passwords.toml")); !os.IsNotExist(err) {
		t.Fatalf("document-passwords.toml should be excluded from baseline")
	}

	// Simulate job 1 creating a file
	_ = os.WriteFile(filepath.Join(repoDir, "imported.md"), []byte("# Imported Note\nNew file.\n"), 0o600)
	job1Commit, err := repo.CheckpointJob("job-1", "source/imported.md")
	if err != nil {
		t.Fatalf("CheckpointJob failed: %v", err)
	}
	if job1Commit == baseCommit {
		t.Fatalf("job1Commit should differ from baseCommit")
	}

	// Check diff
	diff, err := repo.Diff(baseCommit, job1Commit)
	if err != nil {
		t.Fatalf("Diff failed: %v", err)
	}
	if len(diff) == 0 {
		t.Fatalf("expected diff between baseline and job1")
	}

	patchHash := ComputePatchHash(diff)
	if patchHash == "" {
		t.Fatalf("expected non-empty patchHash")
	}

	// Changed files
	changed, err := repo.GetChangedFiles(baseCommit, job1Commit)
	if err != nil {
		t.Fatalf("GetChangedFiles failed: %v", err)
	}
	if len(changed) != 1 || changed[0].Path != "imported.md" || changed[0].Status != "added" {
		t.Fatalf("unexpected changed files: %+v", changed)
	}
}
