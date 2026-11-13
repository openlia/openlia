package main

import (
	"io/fs"
	"strings"
	"testing"
)

func TestEmbeddedReleaseAssetsPresent(t *testing.T) {
	required := []string{
		"docker/.env.example",
		"docker/compose.yaml",
		"docker/Dockerfile",
		"docker/locho.Dockerfile",
		"docker/secret-source.sh",
		"profile/SOUL.md",
		"profile/AGENTS.md",
		"examples/locho/relay.toml.example",
		"examples/locho/relay.env.example",
	}

	for _, relPath := range required {
		data, err := fs.ReadFile(releaseAssets, relPath)
		if err != nil {
			t.Fatalf("missing embedded asset %s: %v", relPath, err)
		}
		if len(data) == 0 {
			t.Fatalf("embedded asset %s is empty", relPath)
		}
	}
}

func TestEmbeddedBunRuntimeAssets(t *testing.T) {
	required := []string{
		"packages/openlia-browser/dist/server.js",
	}
	for _, relPath := range required {
		data, err := fs.ReadFile(releaseAssets, relPath)
		if err != nil {
			t.Fatalf("missing embedded Bun asset %s: %v", relPath, err)
		}
		if len(data) == 0 {
			t.Fatalf("embedded Bun asset %s is empty", relPath)
		}
	}
}

func TestEmbeddedHermesExecApprovalScaffold(t *testing.T) {
	compose, err := fs.ReadFile(releaseAssets, "docker/compose.yaml")
	if err != nil {
		t.Fatalf("read embedded compose: %v", err)
	}
	if !strings.Contains(string(compose), `HERMES_EXEC_ASK: "1"`) {
		t.Fatalf("embedded compose does not enable HERMES_EXEC_ASK")
	}

	secretSource, err := fs.ReadFile(releaseAssets, "docker/secret-source.sh")
	if err != nil {
		t.Fatalf("read embedded secret-source.sh: %v", err)
	}
	if !strings.Contains(string(secretSource), "HERMES_EXEC_ASK") {
		t.Fatalf("embedded secret-source.sh does not guard HERMES_EXEC_ASK")
	}
}
