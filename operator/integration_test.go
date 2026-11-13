package operator

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFilesystemOperatorWorkflow(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	for path, contents := range map[string]string{
		filepath.Join(repo, "profile", "SOUL.md"):       "soul\n",
		filepath.Join(repo, "profile", "AGENTS.md"):     "agents\n",
		filepath.Join(repo, "release", "manifest.json"): `{"openlia":"test"}`,
		filepath.Join(repo, "docker", ".gitkeep"):       "",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC)
	if result, err := Bootstrap(config, false, now); err != nil || !result.OK {
		t.Fatalf("Bootstrap() = %+v, %v", result, err)
	}
	if info, err := os.Stat(config.SecretDir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("secret directory permissions = %v, want 0700", err)
	}
	if info, err := os.Stat(config.SecretFile); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("secret file permissions = %v, want 0600", err)
	}
	for _, name := range []string{"SOUL.md", "AGENTS.md"} {
		info, err := os.Stat(filepath.Join(config.DataRoot, name))
		if err != nil {
			t.Fatalf("%s stat failed: %v", name, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s permissions = %v, want 0600", name, info.Mode().Perm())
		}
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	if _, err := NewProfileOperator(config).Sync(); err != nil {
		t.Fatal(err)
	}

	metadataSentinel := filepath.Join(config.MetaRoot, "managed", "restore-sentinel")
	if err := os.WriteFile(metadataSentinel, []byte("archived metadata\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(config.DataRoot, "workspace"), 0o700); err != nil {
		t.Fatal(err)
	}
	backup, identity := createTestEncryptedBackup(t, &config, "test", now)
	sentinel := filepath.Join(config.DataRoot, "workspace", "sentinel.md")
	if err := os.WriteFile(sentinel, []byte("preserve me\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metadataSentinel, []byte("current metadata\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := restoreTestEncryptedBackup(t, config, backup.Archive, identity, now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatalf("restore retained post-backup file, stat error = %v", err)
	}
	if state, err := ReadState(config); err != nil || state != StateStopped {
		t.Fatalf("restored state = %q, %v", state, err)
	}
	metadata, err := os.ReadFile(metadataSentinel)
	if err != nil {
		t.Fatal(err)
	}
	if string(metadata) != "archived metadata\n" {
		t.Fatalf("metadata was not restored: %q", metadata)
	}
}
