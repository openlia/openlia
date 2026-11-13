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
	calls  []string
	hostID string
}

func (r *lochoShareRunner) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	r.calls = append(r.calls, call)
	hostID := r.hostID
	if hostID == "" {
		hostID = "test-host"
	}
	switch {
	case strings.Contains(call, "config --services"):
		return CommandResult{Stdout: []byte("locho-host\n")}, nil
	case strings.Contains(call, "ps --services --filter status=running"):
		return CommandResult{Stdout: []byte("locho-host\n")}, nil
	case strings.Contains(call, "share hermes-api"):
		return CommandResult{Stdout: []byte("locho attach " + hostID + " hermes-api:tcp:api-secret\n")}, nil
	case strings.Contains(call, "share hermes-dashboard"):
		return CommandResult{Stdout: []byte("locho attach " + hostID + " hermes-dashboard:tcp:dashboard-secret\n")}, nil
	default:
		return CommandResult{}, nil
	}
}

func TestShareLochoHostBuildsHermesAttachmentConfig(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	config.LochoHostEnabled = true
	config.LochoHostRoot = filepath.Join(config.RuntimeRoot, "locho-host")
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
	config.LochoRelayConfig = filepath.Join(config.RuntimeRoot, "locho", "relay.toml")

	runner := &lochoShareRunner{}
	result, err := ShareLochoHost(context.Background(), config, NewCompose(config, runner))
	if err != nil {
		t.Fatal(err)
	}
	if result.HostID != "test-host" || len(result.Services) != 2 || result.Services[0] != "hermes-api" || result.Services[1] != "hermes-dashboard" {
		t.Fatalf("unexpected share result: %+v", result)
	}
	for _, expected := range []string{
		"host_id = \"test-host\"",
		"listen_host = \"127.0.0.1\"",
		"capability = \"hermes-api:tcp:api-secret\"",
		"listen_port = 8642",
		"capability = \"hermes-dashboard:tcp:dashboard-secret\"",
		"listen_port = 9119",
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
	if _, _, err := parseLochoShareOutput("locho attach host other-service:tcp:secret", "hermes-api"); err == nil {
		t.Fatal("wrong service capability was accepted")
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

func TestEnsureAPIServerEnvForwardsOIDCWithoutFallbackBasicAuth(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	config.LochoHostEnabled = true
	if err := os.MkdirAll(config.SecretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	secretContent := strings.Join([]string{
		"API_SERVER_KEY=sk-openlia-0123456789abcdef0123456789abcdef",
		"HERMES_DASHBOARD_OIDC_ISSUER=https://accounts.google.com",
		"HERMES_DASHBOARD_OIDC_CLIENT_ID=12345-abc.apps.googleusercontent.com",
		"HERMES_DASHBOARD_OIDC_CLIENT_SECRET=GOCSPX-secretvalue",
		"HERMES_DASHBOARD_PUBLIC_URL=http://127.0.0.1:9119",
	}, "\n") + "\n"
	if err := os.WriteFile(config.SecretFile, []byte(secretContent), 0o600); err != nil {
		t.Fatal(err)
	}
	apiEnvPath := filepath.Join(config.SecretDir, "api-server.env")
	if err := ensureAPIServerEnv(config, apiEnvPath); err != nil {
		t.Fatalf("ensureAPIServerEnv failed: %v", err)
	}
	raw, err := os.ReadFile(apiEnvPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, want := range []string{
		"API_SERVER_KEY=sk-openlia-0123456789abcdef0123456789abcdef",
		"HERMES_DASHBOARD_OIDC_ISSUER=https://accounts.google.com",
		"HERMES_DASHBOARD_OIDC_CLIENT_ID=12345-abc.apps.googleusercontent.com",
		"HERMES_DASHBOARD_OIDC_CLIENT_SECRET=GOCSPX-secretvalue",
		"HERMES_DASHBOARD_PUBLIC_URL=http://127.0.0.1:9119",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("api-server.env missing %q, got:\n%s", want, text)
		}
	}
	if strings.Contains(text, "HERMES_DASHBOARD_BASIC_AUTH_") {
		t.Fatalf("expected no fallback BASIC_AUTH when OIDC is configured, got:\n%s", text)
	}
}
