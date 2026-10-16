package cli

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestWorkspaceServeRejectsZipArchiveWithGuidance(t *testing.T) {
	tempDir := t.TempDir()
	zipPath := filepath.Join(tempDir, "archive.zip")
	if err := os.WriteFile(zipPath, []byte("PK\x03\x04fake"), 0o644); err != nil {
		t.Fatal(err)
	}

	options := Options{JSON: true}
	assets := fstest.MapFS{}
	code := commandWorkspaceServe(options, []string{zipPath}, assets)
	if code != ExitUsage {
		t.Fatalf("expected ExitUsage (%d), got %d", ExitUsage, code)
	}
}

func TestWorkspaceServeRejectsMissingDirectory(t *testing.T) {
	options := Options{JSON: true}
	assets := fstest.MapFS{}
	code := commandWorkspaceServe(options, []string{"/path/to/missing/nonexistent/directory"}, assets)
	if code != ExitUsage {
		t.Fatalf("expected ExitUsage (%d), got %d", ExitUsage, code)
	}
}

func TestDetectWorkspaceServeRootsFromExport(t *testing.T) {
	exportRoot := t.TempDir()
	for _, name := range []string{"workspace", "skills", "memories"} {
		if err := os.Mkdir(filepath.Join(exportRoot, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	workspaceRoot, skillsRoot, memoriesRoot := detectWorkspaceServeRoots(exportRoot, "")
	if workspaceRoot != filepath.Join(exportRoot, "workspace") {
		t.Fatalf("workspace root = %q, want unpacked workspace directory", workspaceRoot)
	}
	if skillsRoot != filepath.Join(exportRoot, "skills") {
		t.Fatalf("skills root = %q, want unpacked skills directory", skillsRoot)
	}
	if memoriesRoot != filepath.Join(exportRoot, "memories") {
		t.Fatalf("memories root = %q, want unpacked memories directory", memoriesRoot)
	}

	workspaceRoot, skillsRoot, memoriesRoot = detectWorkspaceServeRoots(filepath.Join(exportRoot, "workspace"), "")
	if workspaceRoot != filepath.Join(exportRoot, "workspace") {
		t.Fatalf("direct workspace root = %q, want workspace directory", workspaceRoot)
	}
	if skillsRoot != filepath.Join(exportRoot, "skills") {
		t.Fatalf("direct skills root = %q, want sibling skills directory", skillsRoot)
	}
	if memoriesRoot != filepath.Join(exportRoot, "memories") {
		t.Fatalf("direct memories root = %q, want sibling memories directory", memoriesRoot)
	}
}

func TestDetectWorkspaceServeRootsDoesNotRequireMemories(t *testing.T) {
	exportRoot := t.TempDir()
	if err := os.Mkdir(filepath.Join(exportRoot, "workspace"), 0o755); err != nil {
		t.Fatal(err)
	}

	_, _, memoriesRoot := detectWorkspaceServeRoots(exportRoot, "")
	if memoriesRoot != "" {
		t.Fatalf("memories root = %q, want empty when memories directory is absent", memoriesRoot)
	}
}

func TestExtractWorkspaceUIBundle(t *testing.T) {
	fakeAssets := fstest.MapFS{
		"packages/workspace-ui/dist/server.js":              &fstest.MapFile{Data: []byte("console.log('test');")},
		"packages/workspace-ui/dist/client/assets/index.js": &fstest.MapFile{Data: []byte("console.log('client');")},
		"packages/workspace-ui/dist/server/server.js":       &fstest.MapFile{Data: []byte("console.log('start');")},
	}

	cacheDir, err := extractWorkspaceUIBundle(fakeAssets)
	if err != nil {
		t.Fatalf("extractWorkspaceUIBundle failed: %v", err)
	}
	defer os.RemoveAll(cacheDir)

	serverData, err := os.ReadFile(filepath.Join(cacheDir, "server.js"))
	if err != nil || string(serverData) != "console.log('test');" {
		t.Fatalf("extracted server.js incorrect or missing: %v", err)
	}

	clientData, err := os.ReadFile(filepath.Join(cacheDir, "client", "assets", "index.js"))
	if err != nil || string(clientData) != "console.log('client');" {
		t.Fatalf("extracted client asset incorrect or missing: %v", err)
	}

	// Calling again should reuse cached directory
	cacheDir2, err := extractWorkspaceUIBundle(fakeAssets)
	if err != nil {
		t.Fatalf("extractWorkspaceUIBundle second call failed: %v", err)
	}
	if cacheDir != cacheDir2 {
		t.Fatalf("expected same cache dir, got %s and %s", cacheDir, cacheDir2)
	}
}
