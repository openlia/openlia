package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsInsideWorkingTree(t *testing.T) {
	root := t.TempDir()
	write := func(path, contents string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	checkout := filepath.Join(root, "checkout")
	write(filepath.Join(checkout, "go.mod"), "module openlia\n\ngo 1.26.0\n")
	if err := os.Mkdir(filepath.Join(checkout, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(checkout, "nested", "key"), "test key")
	worktree := filepath.Join(root, "worktree")
	write(filepath.Join(worktree, "go.mod"), "module openlia\n")
	write(filepath.Join(worktree, ".git"), "gitdir: ../checkout/.git/worktrees/test\n")
	unrelated := filepath.Join(root, "unrelated")
	write(filepath.Join(unrelated, "go.mod"), "module example.com/other\n")
	write(filepath.Join(unrelated, ".git"), "gitdir: elsewhere\n")
	configDir := filepath.Join(root, "config")
	write(filepath.Join(configDir, "dev", "key"), "test key")
	link := func(target, path string) {
		t.Helper()
		if err := os.Symlink(target, path); err != nil {
			t.Fatal(err)
		}
	}
	link(checkout, filepath.Join(root, "checkout-link"))
	link(filepath.Join(checkout, "nested", "key"), filepath.Join(root, "key-link"))
	link(configDir, filepath.Join(checkout, "outside-link"))

	cases := []struct {
		name string
		path string
		want bool
	}{
		{"checkout root", checkout, true},
		{"existing checkout file", filepath.Join(checkout, "nested", "key"), true},
		{"new checkout file", filepath.Join(checkout, "new", "key"), true},
		{"git worktree", filepath.Join(worktree, "new", "key"), true},
		{"unrelated repository", filepath.Join(unrelated, "key"), false},
		{"config directory", filepath.Join(configDir, "dev", "key"), false},
		{"new config file", filepath.Join(configDir, "new", "key"), false},
		{"checkout prefix sibling", filepath.Join(root, "checkout-other", "key"), false},
		{"symlinked checkout file", filepath.Join(root, "key-link"), true},
		{"new file below symlink", filepath.Join(root, "checkout-link", "new", "key"), true},
		{"symlink out of checkout", filepath.Join(checkout, "outside-link", "dev", "key"), true},
	}
	for _, cwd := range []string{configDir, checkout, filepath.Join(checkout, "nested")} {
		t.Run(filepath.Base(cwd), func(t *testing.T) {
			t.Chdir(cwd)
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					if got := isInsideWorkingTree(tc.path); got != tc.want {
						t.Fatalf("isInsideWorkingTree(%q) = %v, want %v", tc.path, got, tc.want)
					}
				})
			}
		})
	}
	t.Chdir(checkout)
	if !isInsideWorkingTree(filepath.Join("nested", "key")) {
		t.Fatal("relative path inside checkout was accepted")
	}
	if isInsideWorkingTree(filepath.Join("..", "config", "dev", "key")) {
		t.Fatal("relative path outside checkout was rejected")
	}
}

func TestConfigAllowsBackupIdentityBelowWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	identity := filepath.Join(root, "dev", "backup-identity.txt")
	raw := fmt.Sprintf("[backup]\nidentity_file = %q\n", identity)
	config, err := parseConfig(raw)
	if err != nil {
		t.Fatalf("config directory mistaken for checkout: %v", err)
	}
	if config.BackupIdentityFile != identity {
		t.Fatalf("identity file = %q, want %q", config.BackupIdentityFile, identity)
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module openlia\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = parseConfig(raw)
	if err == nil || !strings.Contains(err.Error(), "backup.identity_file must be outside the OpenLia checkout") {
		t.Fatalf("checkout identity validation error = %v", err)
	}
}
