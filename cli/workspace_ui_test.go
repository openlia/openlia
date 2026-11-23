package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func testWorkspaceUIAssets() fstest.MapFS {
	return fstest.MapFS{
		"packages/workspace-ui/dist/server.js":               &fstest.MapFile{Data: []byte("console.log('server');\n")},
		"packages/workspace-ui/dist/client/index.html":       &fstest.MapFile{Data: []byte("<!doctype html><html></html>\n")},
		"packages/workspace-ui/dist/client/assets/index.css": &fstest.MapFile{Data: []byte("body { margin: 0; }\n")},
	}
}

func TestParseWorkspaceUIServeConfigDefaultsAndScopes(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".hermes")
	for _, key := range workspaceUIAuthEnvKeys {
		t.Setenv(key, "")
	}

	cfg, help, err := parseWorkspaceUIServeConfig([]string{"--root", root, "--port", "9099"})
	if err != nil || help {
		t.Fatalf("parseWorkspaceUIServeConfig error = %v, help = %v", err, help)
	}
	if cfg.Root != root {
		t.Fatalf("Root = %q, want %q", cfg.Root, root)
	}
	if cfg.WorkspaceDir != filepath.Join(root, "workspace") {
		t.Fatalf("WorkspaceDir = %q", cfg.WorkspaceDir)
	}
	if cfg.SkillsDir != filepath.Join(root, "skills") {
		t.Fatalf("SkillsDir = %q", cfg.SkillsDir)
	}
	if cfg.MemoriesDir != filepath.Join(root, "memories") {
		t.Fatalf("MemoriesDir = %q", cfg.MemoriesDir)
	}
	if cfg.Host != "127.0.0.1" || cfg.Port != 9099 {
		t.Fatalf("Host:Port = %s:%d, want 127.0.0.1:9099", cfg.Host, cfg.Port)
	}
	if cfg.AuthRequired {
		t.Fatalf("expected AuthRequired=false on loopback without credentials")
	}
}

func TestParseWorkspaceUIServeConfigLoadsRootDotEnvAndEnforcesNonLoopbackAuth(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".hermes")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, key := range workspaceUIAuthEnvKeys {
		t.Setenv(key, "")
	}

	// Non-loopback without credentials fails unless --no-auth is set
	if _, _, err := parseWorkspaceUIServeConfig([]string{"--root", root, "--host", "0.0.0.0"}); err == nil {
		t.Fatal("expected error when binding 0.0.0.0 without credentials or --no-auth")
	}

	// Non-loopback with --no-auth succeeds
	noAuthCfg, _, err := parseWorkspaceUIServeConfig([]string{"--root", root, "--host", "0.0.0.0", "--no-auth"})
	if err != nil {
		t.Fatalf("unexpected error with --no-auth: %v", err)
	}
	if noAuthCfg.AuthRequired {
		t.Fatal("expected AuthRequired=false when --no-auth is passed")
	}

	// Writing credentials to <root>/.env enables auth automatically on loopback and 0.0.0.0
	dotEnv := "HERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin\nHERMES_DASHBOARD_BASIC_AUTH_PASSWORD=\"secret-pass\"\n"
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte(dotEnv), 0o600); err != nil {
		t.Fatal(err)
	}
	authedCfg, _, err := parseWorkspaceUIServeConfig([]string{"--root", root, "--host", "0.0.0.0"})
	if err != nil {
		t.Fatalf("unexpected error with .env credentials: %v", err)
	}
	if !authedCfg.AuthRequired {
		t.Fatal("expected AuthRequired=true when .env contains credentials")
	}
	if authedCfg.EnvVars["HERMES_DASHBOARD_BASIC_AUTH_USERNAME"] != "admin" || authedCfg.EnvVars["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"] != "secret-pass" {
		t.Fatalf("unexpected parsed .env vars: %+v", authedCfg.EnvVars)
	}
}

func TestCommandWorkspaceUIServeExtractsAssetsAndInvokesBun(t *testing.T) {
	root := filepath.Join(t.TempDir(), "hermes-home")
	envDump := filepath.Join(t.TempDir(), "bun-env.txt")
	fakeBun := filepath.Join(t.TempDir(), "fake-bun.sh")
	script := "#!/bin/sh\nset -eu\nprintf 'ARG1=%s\\n' \"$1\" > " + shellQuote(envDump) + "\nenv | grep -E '^(OPENLIA_|HERMES_DASHBOARD_)' | sort >> " + shellQuote(envDump) + "\n"
	if err := os.WriteFile(fakeBun, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENLIA_BUN_BIN", fakeBun)
	t.Setenv("OPENLIA_CONFIG", filepath.Join(t.TempDir(), "nonexistent-config.toml"))

	code := Run([]string{"workspace-ui", "serve", "--root", root, "--port", "18089"}, testWorkspaceUIAssets())
	if code != ExitOK {
		t.Fatalf("Run(workspace-ui serve) exit code = %d, want %d", code, ExitOK)
	}

	for _, dir := range []string{
		filepath.Join(root, "workspace"),
		filepath.Join(root, "skills"),
		filepath.Join(root, "memories"),
		filepath.Join(root, "cache", "workspace-ui", "dist", "client"),
	} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Fatalf("expected directory %s to exist: %v", dir, err)
		}
	}

	dumpBytes, err := os.ReadFile(envDump)
	if err != nil {
		t.Fatal(err)
	}
	dump := string(dumpBytes)
	for _, expected := range []string{
		"ARG1=" + filepath.Join(root, "cache", "workspace-ui", "dist", "server.js"),
		"OPENLIA_DATA_ROOT=" + root,
		"OPENLIA_WORKSPACE_ROOT=" + filepath.Join(root, "workspace"),
		"OPENLIA_WORKSPACE_UI_SKILLS_ROOT=" + filepath.Join(root, "skills"),
		"OPENLIA_WORKSPACE_UI_STATIC_ROOT=" + filepath.Join(root, "cache", "workspace-ui", "dist", "client"),
		"OPENLIA_WORKSPACE_UI_SESSION_DB=" + filepath.Join(root, "cache", "workspace-ui", "sessions.sqlite"),
		"OPENLIA_WORKSPACE_UI_BIND=127.0.0.1",
		"OPENLIA_WORKSPACE_UI_PORT=18089",
		"OPENLIA_WORKSPACE_UI_AUTH_REQUIRED=false",
	} {
		if !strings.Contains(dump, expected) {
			t.Fatalf("bun execution missing %q:\n%s", expected, dump)
		}
	}
}
