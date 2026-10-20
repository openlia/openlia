package operator

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDurableUsagePaths(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"usage.sqlite", "usage.sqlite-wal", "usage.sqlite-shm", "collector.lock", "pending.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		want := entry.Name() != "usage.sqlite-shm" && entry.Name() != "collector.lock"
		if got := durableHermesPath("usage/"+entry.Name(), entry, nil); got != want {
			t.Errorf("%s: got %v want %v", entry.Name(), got, want)
		}
	}
}
