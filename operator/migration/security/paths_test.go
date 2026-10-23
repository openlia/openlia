package security

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsProtectedWorkspacePath(t *testing.T) {
	tests := []struct {
		path      string
		protected bool
	}{
		{".git", true},
		{".git/config", true},
		{".git/objects/abc", true},
		{".openlia", true},
		{".openlia/secrets", true},
		{"sources/document-passwords.toml", true},
		{"AGENTS.md", true},
		{"SOUL.md", true},
		{"workspace.yaml", true},
		{"assistant-policy.yaml", true},
		{"docs/AGENTS.md", false},
		{"finance/2026.journal", false},
		{"calendar/events.rem", false},
		{"notes/todo.md", false},
		{"", true},
		{".", true},
	}

	for _, tc := range tests {
		got := IsProtectedWorkspacePath(tc.path)
		if got != tc.protected {
			t.Errorf("IsProtectedWorkspacePath(%q) = %v, expected %v", tc.path, got, tc.protected)
		}
	}
}

func TestValidateSafeWorkspacePath(t *testing.T) {
	tmpDir := t.TempDir()

	// Create valid dir and file
	if err := os.MkdirAll(filepath.Join(tmpDir, "finance"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "finance", "2026.journal"), []byte("ledger"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Valid paths
	if err := ValidateSafeWorkspacePath(tmpDir, "finance/2026.journal"); err != nil {
		t.Errorf("expected valid path, got %v", err)
	}
	if err := ValidateSafeWorkspacePath(tmpDir, "finance/new.journal"); err != nil {
		t.Errorf("expected valid new path, got %v", err)
	}

	// Protected paths
	if err := ValidateSafeWorkspacePath(tmpDir, "AGENTS.md"); err == nil {
		t.Errorf("expected error for AGENTS.md, got nil")
	}
	if err := ValidateSafeWorkspacePath(tmpDir, ".openlia/secrets.json"); err == nil {
		t.Errorf("expected error for .openlia path, got nil")
	}

	// Traversal
	if err := ValidateSafeWorkspacePath(tmpDir, "../escape.txt"); err == nil {
		t.Errorf("expected error for traversal, got nil")
	}
	if err := ValidateSafeWorkspacePath(tmpDir, "/etc/passwd"); err == nil {
		t.Errorf("expected error for absolute path, got nil")
	}

	// Symlink checks
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "secret.txt")
	_ = os.WriteFile(outsideFile, []byte("secret"), 0o644)

	// Symlink to file
	symlinkPath := filepath.Join(tmpDir, "finance", "symlinked.journal")
	if err := os.Symlink(outsideFile, symlinkPath); err == nil {
		if err := ValidateSafeWorkspacePath(tmpDir, "finance/symlinked.journal"); err == nil {
			t.Errorf("expected error for symlinked file, got nil")
		}
	}

	// Symlink directory
	symlinkDir := filepath.Join(tmpDir, "external_dir")
	if err := os.Symlink(outsideDir, symlinkDir); err == nil {
		if err := ValidateSafeWorkspacePath(tmpDir, "external_dir/secret.txt"); err == nil {
			t.Errorf("expected error for path inside symlinked directory, got nil")
		}
	}
}
