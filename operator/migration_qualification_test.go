package operator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"openlia/operator/migration"
	"openlia/operator/migration/intake"
	"openlia/operator/migration/propgit"
	"openlia/operator/migration/security"
	"openlia/operator/migration/validator"
)

func TestQualification_IntakeQuarantine(t *testing.T) {
	tempDir := t.TempDir()

	// 1. Secrets & Credentials
	_ = os.MkdirAll(filepath.Join(tempDir, "secrets"), 0o700)
	_ = os.WriteFile(filepath.Join(tempDir, "secrets", ".env"), []byte("API_KEY=secret123\n"), 0o600)
	_ = os.WriteFile(filepath.Join(tempDir, "secrets", "id_rsa"), []byte("-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n"), 0o600)
	_ = os.WriteFile(filepath.Join(tempDir, "secrets", "credentials.json"), []byte(`{"token": "ghp_123456789012345678901234567890123456"}`), 0o600)

	// 2. Protected System Overrides
	_ = os.MkdirAll(filepath.Join(tempDir, "override"), 0o700)
	_ = os.WriteFile(filepath.Join(tempDir, "override", "AGENTS.md"), []byte("# Malicious instructions\n"), 0o600)
	_ = os.MkdirAll(filepath.Join(tempDir, "policy"), 0o700)
	_ = os.WriteFile(filepath.Join(tempDir, "policy", "assistant-policy.yaml"), []byte("allow_all: true\n"), 0o600)

	// 3. Eligible Content
	_ = os.MkdirAll(filepath.Join(tempDir, "notes"), 0o700)
	_ = os.WriteFile(filepath.Join(tempDir, "notes", "safe.md"), []byte("# Meeting Notes\nDiscussion.\n"), 0o600)
	_ = os.MkdirAll(filepath.Join(tempDir, "data"), 0o700)
	_ = os.WriteFile(filepath.Join(tempDir, "data", "table.csv"), []byte("Col1,Col2\nVal1,Val2\n"), 0o600)

	// 4. Unsupported Binary
	_ = os.MkdirAll(filepath.Join(tempDir, "unsupported"), 0o700)
	_ = os.WriteFile(filepath.Join(tempDir, "unsupported", "binary.bin"), []byte{0x00, 0x01, 0x02, 0x00}, 0o600)

	entries, err := intake.ScanSourceFolder("mig-qual-intake", tempDir)
	if err != nil {
		t.Fatalf("ScanSourceFolder failed: %v", err)
	}

	byPath := make(map[string]migration.SourceEntry)
	for _, e := range entries {
		byPath[e.RelativePath] = e
	}

	// Verify all 5 secrets and protected overrides are blocked
	expectedBlocked := []string{
		"secrets/.env",
		"secrets/id_rsa",
		"secrets/credentials.json",
		"override/AGENTS.md",
		"policy/assistant-policy.yaml",
	}

	for _, p := range expectedBlocked {
		entry, exists := byPath[p]
		if !exists {
			t.Errorf("expected entry %s to be indexed, but was missing", p)
			continue
		}
		if entry.Eligibility != migration.EligibilityBlocked {
			t.Errorf("entry %s has eligibility %s, expected %s", p, entry.Eligibility, migration.EligibilityBlocked)
		}
		if !strings.Contains(entry.Reason, "credentials") && !strings.Contains(entry.Reason, "protected") {
			t.Errorf("entry %s has unexpected reason: %s", p, entry.Reason)
		}
	}

	// Verify eligible content
	if byPath["notes/safe.md"].Eligibility != migration.EligibilityEligible {
		t.Errorf("notes/safe.md should be eligible, got %s", byPath["notes/safe.md"].Eligibility)
	}
	if byPath["data/table.csv"].Eligibility != migration.EligibilityEligible {
		t.Errorf("data/table.csv should be eligible, got %s", byPath["data/table.csv"].Eligibility)
	}

	// Verify unsupported binary
	if byPath["unsupported/binary.bin"].Eligibility != migration.EligibilityUnsupported {
		t.Errorf("binary.bin should be unsupported, got %s", byPath["unsupported/binary.bin"].Eligibility)
	}
}

func TestQualification_RemindSafety(t *testing.T) {
	tempDir := t.TempDir()

	safeRem := "REM 2026-10-31 MSG Safe Halloween Party\nREM 2026-11-01 AT 10:00 MSG Meeting\n"
	maliciousRun := "REM 2026-10-31 RUN touch /tmp/exploited_run.txt\n"
	maliciousSh := "REM 2026-11-01 SH echo \"exploited\"\n"
	maliciousExec := "REM 2026-11-02 MSG Safe line\nEXEC /bin/sh\n"

	_ = os.WriteFile(filepath.Join(tempDir, "safe.rem"), []byte(safeRem), 0o600)
	_ = os.WriteFile(filepath.Join(tempDir, "malicious_run.rem"), []byte(maliciousRun), 0o600)
	_ = os.WriteFile(filepath.Join(tempDir, "malicious_sh.rem"), []byte(maliciousSh), 0o600)
	_ = os.WriteFile(filepath.Join(tempDir, "malicious_exec.rem"), []byte(maliciousExec), 0o600)

	changedFiles := []migration.ChangedFileEntry{
		{Path: "safe.rem", Status: "added"},
		{Path: "malicious_run.rem", Status: "added"},
		{Path: "malicious_sh.rem", Status: "added"},
		{Path: "malicious_exec.rem", Status: "added"},
	}

	findings := validator.ValidateProposalWorkspace(tempDir, changedFiles)

	errorFiles := make(map[string]bool)
	for _, f := range findings {
		if f.Domain == "calendar" && f.Severity == "error" {
			errorFiles[f.File] = true
		}
	}

	if errorFiles["safe.rem"] {
		t.Errorf("safe.rem should not have produced an error finding")
	}
	if !errorFiles["malicious_run.rem"] {
		t.Errorf("malicious_run.rem was not flagged as calendar error finding")
	}
	if !errorFiles["malicious_sh.rem"] {
		t.Errorf("malicious_sh.rem was not flagged as calendar error finding")
	}
	if !errorFiles["malicious_exec.rem"] {
		t.Errorf("malicious_exec.rem was not flagged as calendar error finding")
	}
}

func TestQualification_SafeWorkspacePathBoundaries(t *testing.T) {
	tempDir := t.TempDir()

	protectedList := []string{
		"AGENTS.md",
		"SOUL.md",
		"assistant-policy.yaml",
		"workspace.yaml",
		".git",
		".git/config",
		".openlia",
		".openlia/db.sqlite",
		"sources/document-passwords.toml",
	}

	for _, p := range protectedList {
		if !security.IsProtectedWorkspacePath(p) {
			t.Errorf("expected %s to be recognized as protected workspace path", p)
		}
		if err := security.ValidateSafeWorkspacePath(tempDir, p); err == nil {
			t.Errorf("expected ValidateSafeWorkspacePath to reject %s, but got nil", p)
		}
	}

	// Traversal attacks
	traversalList := []string{
		"../outside.txt",
		"sub/../../outside.txt",
		"/etc/passwd",
	}

	for _, trav := range traversalList {
		if err := security.ValidateSafeWorkspacePath(tempDir, trav); err == nil {
			t.Errorf("expected ValidateSafeWorkspacePath to reject traversal path %s", trav)
		}
	}
}

func TestQualification_AtomicMultiFileLifecycleAndPreImages(t *testing.T) {
	tempRoot := t.TempDir()
	dataRoot := filepath.Join(tempRoot, "data")
	runtimeRoot := filepath.Join(tempRoot, "runtime")
	_ = os.MkdirAll(dataRoot, 0o700)
	_ = os.MkdirAll(runtimeRoot, 0o700)

	liveWorkspace := filepath.Join(dataRoot, "workspace")
	_ = os.MkdirAll(liveWorkspace, 0o700)

	// Seed existing file in live workspace (will have pre-image captured)
	existingPath := filepath.Join(liveWorkspace, "existing.md")
	_ = os.WriteFile(existingPath, []byte("# Original Content\n"), 0o600)

	config := Config{
		DataRoot:    dataRoot,
		RuntimeRoot: runtimeRoot,
	}

	migID := "mig-qual-apply"
	migDir := MigrationRoot(config, migID)
	_ = os.MkdirAll(migDir, 0o700)
	sourceDir := filepath.Join(migDir, "source")
	_ = os.MkdirAll(sourceDir, 0o700)
	_ = os.WriteFile(filepath.Join(sourceDir, "note.md"), []byte("# Note\n"), 0o600)

	// 1. Init migration
	mig, err := InitMigrationV2(config, migID)
	if err != nil {
		t.Fatalf("InitMigrationV2 failed: %v", err)
	}

	// 2. Setup proposal repository
	propRepoDir := filepath.Join(migDir, "proposal-repo")
	repo, err := propgit.OpenOrCreateRepo(propRepoDir)
	if err != nil {
		t.Fatalf("OpenOrCreateRepo failed: %v", err)
	}

	// Update existing.md and add new.md in proposal
	_ = os.WriteFile(filepath.Join(propRepoDir, "existing.md"), []byte("# Updated Content\n"), 0o600)
	_ = os.WriteFile(filepath.Join(propRepoDir, "new.md"), []byte("# Brand New\n"), 0o600)

	rev1Hash, err := repo.CheckpointJob("job-0001", "existing.md")
	if err != nil {
		t.Fatalf("CheckpointJob failed: %v", err)
	}
	treeHash, err := repo.GetTreeHash(rev1Hash)
	if err != nil {
		t.Fatalf("GetTreeHash failed: %v", err)
	}

	diff, err := repo.Diff(mig.BaselineManifest, rev1Hash)
	if err != nil {
		t.Fatalf("Diff failed: %v", err)
	}
	patchHash := propgit.ComputePatchHash(diff)

	// 3. Register revision in DB and transition state
	db, err := migration.OpenDB(migDir)
	if err != nil {
		t.Fatalf("OpenDB failed: %v", err)
	}
	defer db.Close()

	if err := db.UpdateMigrationState(migID, migration.StateProcessing, ""); err != nil {
		t.Fatalf("UpdateMigrationState processing failed: %v", err)
	}
	if err := db.UpdateMigrationState(migID, migration.StateReadyForReview, ""); err != nil {
		t.Fatalf("UpdateMigrationState ready_for_review failed: %v", err)
	}

	rev := migration.ReviewRevision{
		ID:           "rev-1",
		MigrationID:  migID,
		RevisionNum:  1,
		BaselineHash: mig.BaselineManifest,
		CommitHash:   rev1Hash,
		TreeHash:     treeHash,
		PatchHash:    patchHash,
		Summary:      "Update existing note and introduce new note",
		ChangedFiles: []migration.ChangedFileEntry{
			{Path: "existing.md", Status: "modified"},
			{Path: "new.md", Status: "added"},
		},
	}
	if err := db.CreateRevision(rev); err != nil {
		t.Fatalf("CreateRevision failed: %v", err)
	}

	// 4. Apply revision
	if err := ApplyRevision(config, migID, "rev-1", patchHash); err != nil {
		t.Fatalf("ApplyRevision failed: %v", err)
	}

	// 5. Verify live workspace state
	updatedContent, err := os.ReadFile(existingPath)
	if err != nil || string(updatedContent) != "# Updated Content\n" {
		t.Fatalf("unexpected content for existing.md: %s (err: %v)", string(updatedContent), err)
	}

	newContent, err := os.ReadFile(filepath.Join(liveWorkspace, "new.md"))
	if err != nil || string(newContent) != "# Brand New\n" {
		t.Fatalf("unexpected content for new.md: %s (err: %v)", string(newContent), err)
	}

	// 6. Verify pre-image was captured before apply
	preImageFile := filepath.Join(migDir, "apply", "rollback", "existing.md")
	preImageData, err := os.ReadFile(preImageFile)
	if err != nil || string(preImageData) != "# Original Content\n" {
		t.Fatalf("pre-image was not safely recorded: %s (err: %v)", string(preImageData), err)
	}

	// 7. Verify apply journal record
	journal, err := db.GetLatestApplyJournal(migID)
	if err != nil || journal == nil {
		t.Fatalf("apply journal entry missing: %+v (err: %v)", journal, err)
	}
	if journal.Status != "applied" {
		t.Errorf("expected journal status 'applied', got %s", journal.Status)
	}
}
