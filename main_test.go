package main

import (
	"io/fs"
	"strings"
	"testing"
)

func TestEmbeddedWorkspaceIncludesControlFiles(t *testing.T) {
	for _, path := range []string{
		"THIRD_PARTY_NOTICES.md",
		"workspace-template/.gitignore",
		"workspace-template/inbox/.gitkeep",
		"docker/.env.example",
		"docker/secret-source.sh",
		"docker/install-tools.sh",
		"docker/verify-tools.sh",
		"docker/yt-dlp-requirements.txt",
		"profile/config.yaml",
		"profile/distribution.yaml",
		"examples/locho/hosts/example/README.md",
		"examples/locho/hosts/example/attachments.toml.example",
		"examples/locho/relay.toml.example",
		"examples/locho/relay.env.example",
	} {
		if _, err := fs.ReadFile(releaseAssets, path); err != nil {
			t.Fatalf("embedded release is missing %s: %v", path, err)
		}
	}
}

func TestEmbeddedRuntimeWiresRequiredIngestion(t *testing.T) {
	compose, err := fs.ReadFile(releaseAssets, "docker/compose.yaml")
	if err != nil {
		t.Fatal(err)
	}
	dockerfile, err := fs.ReadFile(releaseAssets, "docker/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(compose), `DEBIAN_SNAPSHOT: "${DEBIAN_SNAPSHOT:-20260801T000000Z}"`) {
		t.Fatal("embedded Compose file does not pin the Debian snapshot")
	}
	if !strings.Contains(string(dockerfile), "openlia-install-tools") || !strings.Contains(string(dockerfile), "openlia-ingestion") {
		t.Fatal("embedded Dockerfile does not install the required ingestion runtime")
	}
}

func TestEmbeddedBunRuntimeAssets(t *testing.T) {
	for _, path := range []string{
		"packages/openlia-browser/dist/server.js",
		"packages/workspace-ui/dist/server.js",
		"docker/workspace-ui.Dockerfile",
	} {
		if _, err := fs.ReadFile(releaseAssets, path); err != nil {
			t.Fatalf("embedded Bun runtime is missing %s: %v", path, err)
		}
	}
	entries, err := fs.ReadDir(releaseAssets, "packages/workspace-ui/dist/client/assets")
	if err != nil || len(entries) == 0 {
		t.Fatalf("embedded workspace-ui client assets are missing: %v", err)
	}
}

func TestEmbeddedRuntimeEnablesApprovalBridgeWithoutUnattendedBypass(t *testing.T) {
	compose, err := fs.ReadFile(releaseAssets, "docker/compose.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(compose), `HERMES_EXEC_ASK: "1"`) {
		t.Fatal("API approval bridge must be explicitly enabled")
	}
	config, err := fs.ReadFile(releaseAssets, "profile/config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"mode: manual", "cron_mode: deny", "single_query_mode: deny", "unattended_mode: deny"} {
		if !strings.Contains(string(config), required) {
			t.Fatalf("missing approval safeguard: %s", required)
		}
	}
	helper, err := fs.ReadFile(releaseAssets, "docker/secret-source.sh")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(helper), "HERMES_EXEC_ASK) exit 1") {
		t.Fatal("secret source must not override approval routing")
	}
}
