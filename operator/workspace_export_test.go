package operator

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceExport(t *testing.T) {
	tempDir := t.TempDir()
	dataRoot := filepath.Join(tempDir, "hermes")
	wsDir := filepath.Join(dataRoot, "workspace")
	skDir := filepath.Join(dataRoot, "skills")
	memDir := filepath.Join(dataRoot, "memories")

	if err := os.MkdirAll(filepath.Join(wsDir, "inbox"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wsDir, "workspace.yaml"), []byte("name: test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wsDir, "inbox", "note.md"), []byte("# Note\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Noise file to skip
	if err := os.WriteFile(filepath.Join(wsDir, ".DS_Store"), []byte("noise"), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string]string{
		".gitignore": "node_modules/\n",
		".env":       "TOKEN=secret\n",
		"auth.json":  "{}",
	} {
		if err := os.WriteFile(filepath.Join(wsDir, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if err := os.MkdirAll(filepath.Join(skDir, "my-skill"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skDir, "my-skill", "SKILL.md"), []byte("# Skill\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	generatedSkillFiles := map[string]string{
		filepath.Join(skDir, ".curator_backups", "2026-10-10", "skills.tar.gz"): "old snapshot",
		filepath.Join(skDir, "my-skill", "__pycache__", "helper.pyc"):           "bytecode",
		filepath.Join(skDir, "my-skill", ".venv", "bin", "python"):              "virtualenv",
		filepath.Join(skDir, "my-skill", "node_modules", "package", "index.js"): "dependency",
	}
	for path, contents := range generatedSkillFiles {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(memDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(memDir, "USER.md"), []byte("# User\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(memDir, "MEMORY.md"), []byte("# Memory\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(memDir, "private.txt"), []byte("not exported"), 0o600); err != nil {
		t.Fatal(err)
	}

	exportFile := filepath.Join(tempDir, "export.zip")
	config := Config{
		DataRoot: dataRoot,
	}

	result, err := WorkspaceExport(config, exportFile)
	if err != nil {
		t.Fatalf("WorkspaceExport failed: %v", err)
	}

	if !result.OK {
		t.Errorf("result.OK = false, want true")
	}
	if result.FilesCount != 5 {
		t.Errorf("result.FilesCount = %d, want 5 (workspace, skills, and two memory files)", result.FilesCount)
	}
	if result.SizeBytes <= 0 {
		t.Errorf("result.SizeBytes = %d, want > 0", result.SizeBytes)
	}

	// Verify zip contents
	r, err := zip.OpenReader(exportFile)
	if err != nil {
		t.Fatalf("zip.OpenReader failed: %v", err)
	}
	defer r.Close()

	found := make(map[string]string)
	for _, f := range r.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		found[f.Name] = string(data)
	}

	if _, hasNoise := found["workspace/.DS_Store"]; hasNoise {
		t.Errorf("zip contains .DS_Store, which should be omitted")
	}
	for _, excluded := range []string{"workspace/.gitignore", "workspace/.env", "workspace/auth.json"} {
		if _, exported := found[excluded]; exported {
			t.Errorf("zip contains protected file %s", excluded)
		}
	}
	if found["workspace/workspace.yaml"] != "name: test\n" {
		t.Errorf("workspace.yaml content mismatch: got %q", found["workspace/workspace.yaml"])
	}
	if found["workspace/inbox/note.md"] != "# Note\n" {
		t.Errorf("inbox/note.md content mismatch: got %q", found["workspace/inbox/note.md"])
	}
	if found["skills/my-skill/SKILL.md"] != "# Skill\n" {
		t.Errorf("skills/my-skill/SKILL.md content mismatch: got %q", found["skills/my-skill/SKILL.md"])
	}
	for _, excluded := range []string{
		"skills/.curator_backups/2026-10-10/skills.tar.gz",
		"skills/my-skill/__pycache__/helper.pyc",
		"skills/my-skill/.venv/bin/python",
		"skills/my-skill/node_modules/package/index.js",
	} {
		if _, exported := found[excluded]; exported {
			t.Errorf("zip contains generated skill artifact %s", excluded)
		}
	}
	if found["memories/USER.md"] != "# User\n" {
		t.Errorf("memories/USER.md content mismatch: got %q", found["memories/USER.md"])
	}
	if found["memories/MEMORY.md"] != "# Memory\n" {
		t.Errorf("memories/MEMORY.md content mismatch: got %q", found["memories/MEMORY.md"])
	}
	if _, exported := found["memories/private.txt"]; exported {
		t.Error("zip contains private memory file, which should be omitted")
	}
}
