package operator

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type lochoShareRunner struct {
	calls         []string
	workspaceHost string
	openWebUIHost string
}

func (r *lochoShareRunner) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	r.calls = append(r.calls, call)
	workspaceHost := r.workspaceHost
	if workspaceHost == "" {
		workspaceHost = "test-host"
	}
	openWebUIHost := r.openWebUIHost
	if openWebUIHost == "" {
		openWebUIHost = "test-host"
	}
	switch {
	case strings.Contains(call, "config --services"):
		return CommandResult{Stdout: []byte("locho-host\n")}, nil
	case strings.Contains(call, "ps --services --filter status=running"):
		return CommandResult{Stdout: []byte("locho-host\n")}, nil
	case strings.Contains(call, "share workspace-ui"):
		return CommandResult{Stdout: []byte("locho attach " + workspaceHost + " workspace-ui:tcp:workspace-secret\n")}, nil
	case strings.Contains(call, "share open-webui"):
		return CommandResult{Stdout: []byte("locho attach " + openWebUIHost + " open-webui:tcp:webui-secret\n")}, nil
	default:
		return CommandResult{}, nil
	}
}

func TestShareLochoHostBuildsCombinedAttachmentConfig(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	config.LochoHostEnabled = true
	config.LochoHostRoot = filepath.Join(config.RuntimeRoot, "locho-host")
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
	config.LochoRelayConfig = filepath.Join(config.RuntimeRoot, "locho", "relay.toml")
	config.WorkspaceUIHost = "127.0.0.1"
	config.WorkspaceUIAuthRequired = true
	config.WorkspaceUIPasswordHashFile = filepath.Join(config.RuntimeRoot, "secrets", "workspace-ui-password.hash")
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIAuth = true

	runner := &lochoShareRunner{}
	result, err := ShareLochoHost(context.Background(), config, NewCompose(config, runner))
	if err != nil {
		t.Fatal(err)
	}
	if result.HostID != "test-host" || len(result.Services) != 2 {
		t.Fatalf("unexpected share result: %+v", result)
	}
	for _, expected := range []string{
		"host_id = \"test-host\"",
		"listen_host = \"127.0.0.1\"",
		"capability = \"workspace-ui:tcp:workspace-secret\"",
		"listen_port = 8089",
		"capability = \"open-webui:tcp:webui-secret\"",
		"listen_port = 8090",
	} {
		if !strings.Contains(result.AttachmentConfig, expected) {
			t.Fatalf("attachment config missing %q:\n%s", expected, result.AttachmentConfig)
		}
	}
	if calls := strings.Join(runner.calls, "\n"); !strings.Contains(calls, "--config /var/lib/openlia-locho-host/locho.toml") {
		t.Fatalf("share did not use the active host config: %s", calls)
	}
	if calls := strings.Join(runner.calls, "\n"); !strings.Contains(calls, "--relay-config /etc/locho/relay.toml") {
		t.Fatalf("share did not use the relay config: %s", calls)
	}
}

func TestParseLochoShareOutputRejectsWrongService(t *testing.T) {
	if _, _, err := parseLochoShareOutput("locho attach host open-webui:tcp:secret", "workspace-ui"); err == nil {
		t.Fatal("wrong service capability was accepted")
	}
}

func TestShareLochoHostRejectsInconsistentHostIDs(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	config.LochoHostEnabled = true
	config.LochoHostRoot = filepath.Join(config.RuntimeRoot, "locho-host")
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
	config.WorkspaceUIHost = "127.0.0.1"
	config.WorkspaceUIAuthRequired = true
	config.WorkspaceUIPasswordHashFile = filepath.Join(config.RuntimeRoot, "secrets", "workspace-ui-password.hash")
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIAuth = true
	runner := &lochoShareRunner{workspaceHost: "host-a", openWebUIHost: "host-b"}
	if _, err := ShareLochoHost(context.Background(), config, NewCompose(config, runner)); err == nil || !strings.Contains(err.Error(), "inconsistent") {
		t.Fatalf("inconsistent host IDs were not rejected: %v", err)
	}
}

func TestLochoHostShareRejectsJSONOutput(t *testing.T) {
	var output, errors bytes.Buffer
	code := runLochoHost(context.Background(), Config{}, []string{"share"}, &output, &errors, true)
	if code != ExitUsage || strings.Contains(output.String(), ":tcp:") || !strings.Contains(output.String(), "does not expose capabilities") {
		t.Fatalf("unexpected JSON rejection: code=%d output=%q errors=%q", code, output.String(), errors.String())
	}
}

func TestEnsureLochoHostStateFilesSecuresPermissionsAndRejectsSymlinks(t *testing.T) {
	stateRoot := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(stateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(stateRoot, "host.key")
	statePath := filepath.Join(stateRoot, "host_state.json")
	if err := os.WriteFile(keyPath, make([]byte, 32), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureLochoHostStateFiles(stateRoot, os.Getuid(), os.Getgid()); err != nil {
		t.Fatalf("ensureLochoHostStateFiles failed: %v", err)
	}
	for _, path := range []string{keyPath, statePath} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("file %s mode = %v, want 0600 (err=%v)", path, info.Mode().Perm(), err)
		}
	}

	_ = os.Remove(keyPath)
	if err := os.Symlink(statePath, keyPath); err != nil {
		t.Fatal(err)
	}
	if err := ensureLochoHostStateFiles(stateRoot, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("expected symlink host.key to be rejected")
	}
}
