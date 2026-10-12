package operator

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectSecretContent(t *testing.T) {
	cases := []struct {
		filename string
		content  string
		want     bool
	}{
		{"normal.md", "# Hello world\nJust some notes", false},
		{".env", "FOO=bar\n", true},
		{".env.production", "KEY=123\n", true},
		{"id_rsa", "something", true},
		{"cert.pem", "something", true},
		{"id_ed25519", "something", true},
		{"notes.md", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----", true},
		{"api.txt", "ghp_123456789012345678901234567890", true},
		{"config.txt", "api_key = \"abcdef0123456789abcdef\"", true},
	}

	for _, c := range cases {
		got := DetectSecretContent(c.filename, []byte(c.content))
		if got != c.want {
			t.Errorf("DetectSecretContent(%q, %q) = %v, want %v", c.filename, c.content, got, c.want)
		}
	}
}

func TestIsIgnoredPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{".obsidian/workspace.json", true},
		{".git/config", true},
		{"node_modules/package/index.js", true},
		{"personal/calendar/2026-09-20.md", false},
		{"personal/.DS_Store", true},
		{"learning/lessons/lesson-1.md", false},
		{"AGENTS.md", false},
		{"SOUL.md", true},
		{"IDENTITY.md", true},
		{"DREAMS.md", true},
		{"README.md", false},
		{"travel/upcoming/README.md", false},
		{"skills/life-manager/SKILL.md", true},
		{"memory/.dreams/corpus.txt", true},
		{"memory/dreaming/rem/1.md", true},
		{"script.sh", true},
		{"helper.py", true},
		{"USER.md", false},
	}

	for _, c := range cases {
		got := IsIgnoredPath(c.path)
		if got != c.want {
			t.Errorf("IsIgnoredPath(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestIsEmptyStub(t *testing.T) {
	cases := []struct {
		content string
		want    bool
	}{
		{"# Goals\n\nNo long-term goals have been recorded yet.\n", true},
		{"# Travel Preferences\n\nNo travel preferences have been recorded yet.\n", true},
		{"# Curriculum\n\nNo curriculum has been agreed yet.\n", true},
		{"# Real Note\n\nWe met today at 14:00 to discuss architecture.\n", false},
	}
	for _, c := range cases {
		got := IsEmptyStub([]byte(c.content))
		if got != c.want {
			t.Errorf("IsEmptyStub(%q) = %v, want %v", c.content, got, c.want)
		}
	}
}

func TestCleanTarballAndExtraction(t *testing.T) {
	tempDir := t.TempDir()
	sourceDir := filepath.Join(tempDir, "source")
	destDir := filepath.Join(tempDir, "dest")

	if err := os.MkdirAll(filepath.Join(sourceDir, ".obsidian"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sourceDir, "notes"), 0o700); err != nil {
		t.Fatal(err)
	}

	_ = os.WriteFile(filepath.Join(sourceDir, ".obsidian", "cache.json"), []byte("noise"), 0o600)
	_ = os.WriteFile(filepath.Join(sourceDir, "notes", "valid.md"), []byte("# Note 1"), 0o600)
	_ = os.WriteFile(filepath.Join(sourceDir, "notes", ".env"), []byte("SECRET=123"), 0o600)
	_ = os.WriteFile(filepath.Join(sourceDir, "notes", "stub.md"), []byte("# Goals\n\nNo long-term goals have been recorded yet.\n"), 0o600)

	var buf bytes.Buffer
	packaged, blocked, err := CreateCleanTarball(sourceDir, &buf)
	if err != nil {
		t.Fatalf("CreateCleanTarball failed: %v", err)
	}

	if packaged != 1 {
		t.Errorf("packaged count = %d, want 1", packaged)
	}
	if blocked != 1 {
		t.Errorf("blocked count = %d, want 1 (.env)", blocked)
	}

	tarPath := filepath.Join(tempDir, "archive.tar.gz")
	if err := os.WriteFile(tarPath, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ExtractTarball(tarPath, destDir); err != nil {
		t.Fatalf("ExtractTarball failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(destDir, "notes", "valid.md")); err != nil {
		t.Errorf("valid.md was not extracted")
	}
	if _, err := os.Stat(filepath.Join(destDir, "notes", ".env")); !os.IsNotExist(err) {
		t.Errorf(".env should not have been packaged or extracted")
	}
	if _, err := os.Stat(filepath.Join(destDir, "notes", "stub.md")); !os.IsNotExist(err) {
		t.Errorf("stub.md should not have been packaged or extracted")
	}
	if _, err := os.Stat(filepath.Join(destDir, ".obsidian")); !os.IsNotExist(err) {
		t.Errorf(".obsidian should have been ignored")
	}
}

func TestClassifyAndAdaptFile(t *testing.T) {
	cases := []struct {
		path       string
		content    string
		wantDomain string
		wantPrefix string
	}{
		{"USER.md", "# User Context\nTimezone: Asia/Ho_Chi_Minh", "people", "people/user-context.md"},
		{"personal/commute-routine.md", "# Commute\nRoute details", "areas", "areas/commute-routine.md"},
		{"personal/calendar/2026-09-20.md", "# Sunday\n- Meeting", "calendar", "calendar/"},
		{"personal/ideas/iphone-edge.md", "# iPhone\nA concept for edge device", "ideas", "ideas/"},
		{"personal/profile.md", "# Personal Profile\nGiven name: Quang", "people", "people/"},
		{"personal/tasks.md", "# Tasks\n- [ ] Buy groceries", "tasks", "tasks/"},
		{"travel/ideas/japan.md", "# Japan Trip\nItinerary", "travel", "travel/ideas/"},
		{"learning/lessons/lesson-1.md", "# Lesson 1", "knowledge", "knowledge/learning/lessons/"},
		{"memory/2026-09-15.md", "# Daily log", "archive", "archive/memory/"},
		{"random.txt", "Some text note", "inbox", "inbox/"},
	}

	for _, c := range cases {
		targetPath, domain, adapted, _ := ClassifyAndAdaptFile(c.path, []byte(c.content))
		if domain != c.wantDomain {
			t.Errorf("Classify(%q) domain = %q, want %q", c.path, domain, c.wantDomain)
		}
		if !strings.HasPrefix(targetPath, c.wantPrefix) {
			t.Errorf("Classify(%q) targetPath = %q, want prefix %q", c.path, targetPath, c.wantPrefix)
		}
		if adapted == "" {
			t.Errorf("Classify(%q) adapted content is empty", c.path)
		}
	}
}

func TestRunMigrationWorkerAndApplyChunk(t *testing.T) {
	tempRoot := t.TempDir()
	config := Config{
		DataRoot: filepath.Join(tempRoot, "hermes"),
	}
	workspaceRoot := filepath.Join(config.DataRoot, "workspace")
	if err := os.MkdirAll(workspaceRoot, 0o700); err != nil {
		t.Fatal(err)
	}

	// Pre-populate workspace with an existing file to test collision
	existingFile := filepath.Join(workspaceRoot, "tasks", "existing.md")
	if err := os.MkdirAll(filepath.Dir(existingFile), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(existingFile, []byte("# Existing Task"), 0o600)

	// Create source folder with files
	sourceDir := filepath.Join(tempRoot, "sample_vault")
	_ = os.MkdirAll(filepath.Join(sourceDir, "tasks"), 0o700)
	_ = os.MkdirAll(filepath.Join(sourceDir, "personal", "calendar"), 0o700)
	_ = os.WriteFile(filepath.Join(sourceDir, "tasks", "existing.md"), []byte("# Modified Task"), 0o600)
	_ = os.WriteFile(filepath.Join(sourceDir, "tasks", "new-task.md"), []byte("- [ ] Do something"), 0o600)
	_ = os.WriteFile(filepath.Join(sourceDir, "personal", "calendar", "2026-09-20.md"), []byte("Lunch with friend"), 0o600)

	migrationID := "test-mig-01"
	migDir := MigrationRoot(config, migrationID)
	if err := os.MkdirAll(migDir, 0o700); err != nil {
		t.Fatal(err)
	}

	// Package source archive
	tarFile, err := os.Create(filepath.Join(migDir, "source.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = CreateCleanTarball(sourceDir, tarFile)
	tarFile.Close()
	if err != nil {
		t.Fatal(err)
	}

	// Run migration worker
	ctx := context.Background()
	if err := RunMigrationWorker(ctx, config, migrationID); err != nil {
		t.Fatalf("RunMigrationWorker failed: %v", err)
	}

	// Verify status.json
	status, err := GetMigrationStatus(config, migrationID)
	if err != nil {
		t.Fatalf("GetMigrationStatus failed: %v", err)
	}
	if status.Status != MigrationStatusDone {
		t.Errorf("status = %q, want %q", status.Status, MigrationStatusDone)
	}
	if status.PlanSummary == nil || status.PlanSummary.TotalFiles != 3 {
		t.Fatalf("plan summary total files = %+v, want 3", status.PlanSummary)
	}
	if status.PlanSummary.Conflicts != 1 {
		t.Errorf("conflicts = %d, want 1", status.PlanSummary.Conflicts)
	}

	// Verify plan.json
	plan, err := GetMigrationPlan(config, migrationID)
	if err != nil {
		t.Fatalf("GetMigrationPlan failed: %v", err)
	}
	if len(plan.Chunks) == 0 {
		t.Fatal("plan chunks is empty")
	}

	// Find the tasks chunk and apply it
	var tasksChunk *WorkspaceMigrationChunk
	for _, ch := range plan.Chunks {
		if ch.Domain == "tasks" {
			tasksChunk = &ch
			break
		}
	}
	if tasksChunk == nil {
		t.Fatal("tasks chunk not found")
	}

	if err := ApplyMigrationChunk(config, migrationID, tasksChunk.ID, nil); err != nil {
		t.Fatalf("ApplyMigrationChunk failed: %v", err)
	}

	// Verify that new-task.md now exists in workspace
	writtenFile := filepath.Join(workspaceRoot, "tasks", "new-task.md")
	if _, err := os.Stat(writtenFile); err != nil {
		t.Errorf("tasks/new-task.md was not written to workspace: %v", err)
	}

	// Verify plan reflects applied state
	updatedPlan, err := GetMigrationPlan(config, migrationID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ch := range updatedPlan.Chunks {
		if ch.ID == tasksChunk.ID && ch.State != ChunkStateApplied {
			t.Errorf("chunk state = %q, want %q", ch.State, ChunkStateApplied)
		}
	}
}
