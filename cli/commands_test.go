package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestSplitCommonFlagsParsesReleaseAndRejectsItForNonDeployLifecycle(t *testing.T) {
	options, remaining, err := splitCommonFlags([]string{"--json", "deploy", "--release"})
	if err != nil {
		t.Fatal(err)
	}
	if !options.JSON || !options.Release || strings.Join(remaining, " ") != "deploy" {
		t.Fatalf("options=%+v remaining=%v", options, remaining)
	}

	if got := Run([]string{"--release", "start"}, nil); got != ExitUsage {
		t.Fatalf("start --release exit code = %d, want %d", got, ExitUsage)
	}
}

func TestRunRejectsRetiredCommands(t *testing.T) {
	t.Setenv("OPENLIA_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	for _, cmd := range []string{
		"skill-sources",
		"skills",
		"features",
		"feature",
		"workspace",
		"workspace-ui",
		"instructions",
		"telegram",
		"update",
		"doctor",
	} {
		if code := Run([]string{cmd}, fstest.MapFS{}); code != ExitUsage {
			t.Fatalf("retired %s command exit code = %d, want %d", cmd, code, ExitUsage)
		}
	}
}

func TestRunDispatchesBrowser(t *testing.T) {
	t.Setenv("OPENLIA_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	if code := Run([]string{"browser", "status"}, fstest.MapFS{}); code != ExitPrereq {
		t.Fatalf("browser dispatch exit code = %d, want %d", code, ExitPrereq)
	}
}

func TestRunDispatchesLochoHost(t *testing.T) {
	t.Setenv("OPENLIA_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	if code := Run([]string{"locho-host", "share"}, fstest.MapFS{}); code != ExitPrereq {
		t.Fatalf("locho-host dispatch exit code = %d, want %d", code, ExitPrereq)
	}
}

func TestWriteExclusiveFileDoesNotOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "attachments.toml")
	if err := writeExclusiveFile(path, []byte("first\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeExclusiveFile(path, []byte("second\n"), 0o600); err == nil {
		t.Fatal("existing attachment file was overwritten")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "first\n" {
		t.Fatalf("attachment file = %q, %v", data, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("attachment file mode = %v, %v", info, err)
	}
}

func TestAttachmentHostIDValidation(t *testing.T) {
	if hostID, err := attachmentHostID("host_id = \"host-1\"\n"); err != nil || hostID != "host-1" {
		t.Fatalf("host ID = %q, %v", hostID, err)
	}
	for _, value := range []string{"", "host_id = unquoted\n", "listen_host = \"127.0.0.1\"\n"} {
		if _, err := attachmentHostID(value); err == nil {
			t.Fatalf("invalid attachment config was accepted: %q", value)
		}
	}
}

func TestUnknownInitCommand(t *testing.T) {
	if got := Run([]string{"init"}, nil); got != ExitUsage {
		t.Fatalf("Run(['init']) exit code = %d, want %d", got, ExitUsage)
	}
}

func TestDeployWithoutConfigFileFailsWithPrereq(t *testing.T) {
	t.Setenv("OPENLIA_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	if got := Run([]string{"deploy"}, nil); got != ExitPrereq {
		t.Fatalf("Run(['deploy']) without config exit code = %d, want %d", got, ExitPrereq)
	}
}

func TestUninstallWithoutConfigRequiresExplicitSelection(t *testing.T) {
	t.Setenv("OPENLIA_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	if got := commandUninstall(Options{}, nil); got != ExitUsage {
		t.Fatalf("uninstall without config or deployment arguments exit code = %d, want %d", got, ExitUsage)
	}
}

func TestResolveMaintenanceDeploymentUsesConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	t.Setenv("OPENLIA_CONFIG", path)
	want := defaultConfig()
	want.Target = "root@example.test"
	want.InstallRoot = "/opt/example"
	want.Project = "example"
	if err := saveConfig(want); err != nil {
		t.Fatal(err)
	}

	got, err := resolveMaintenanceDeployment(deploymentSelectors{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Target != want.Target || got.InstallRoot != want.InstallRoot || got.Project != want.Project {
		t.Fatalf("resolved deployment = %#v, want target=%q root=%q project=%q", got, want.Target, want.InstallRoot, want.Project)
	}
}

func TestResolveMaintenanceDeploymentAcceptsMatchingAssertions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	t.Setenv("OPENLIA_CONFIG", path)
	want := defaultConfig()
	want.Target = "root@example.test"
	want.InstallRoot = "/opt/example"
	want.Project = "example"
	if err := saveConfig(want); err != nil {
		t.Fatal(err)
	}

	_, err := resolveMaintenanceDeployment(deploymentSelectors{
		mode:       "ssh",
		modeSet:    true,
		target:     want.Target,
		targetSet:  true,
		root:       want.InstallRoot,
		rootSet:    true,
		project:    want.Project,
		projectSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestResolveMaintenanceDeploymentRejectsConflictingAssertions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	t.Setenv("OPENLIA_CONFIG", path)
	want := defaultConfig()
	want.Target = "root@example.test"
	want.InstallRoot = "/opt/example"
	want.Project = "example"
	if err := saveConfig(want); err != nil {
		t.Fatal(err)
	}

	_, err := resolveMaintenanceDeployment(deploymentSelectors{
		target:    "root@other.example.test",
		targetSet: true,
	})
	if err == nil || !strings.Contains(err.Error(), "target") {
		t.Fatalf("conflicting target error = %v", err)
	}
}

func TestResolveMaintenanceDeploymentSupportsExplicitSelectionWithoutConfig(t *testing.T) {
	t.Setenv("OPENLIA_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))

	got, err := resolveMaintenanceDeployment(deploymentSelectors{
		mode:       "ssh",
		modeSet:    true,
		target:     "root@example.test",
		targetSet:  true,
		root:       "/opt/example",
		rootSet:    true,
		project:    "example",
		projectSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != "ssh" || got.Target != "root@example.test" || got.InstallRoot != "/opt/example" || got.Project != "example" {
		t.Fatalf("explicit selection = %#v", got)
	}
}

func TestAttachmentsMapRejectsInvalidRole(t *testing.T) {
	temporary := t.TempDir()
	t.Setenv("OPENLIA_CONFIG", filepath.Join(temporary, "config.toml"))
	if err := saveConfig(defaultConfig()); err != nil {
		t.Fatal(err)
	}

	for _, invalid := range []string{"generic", "image-generator", "unassigned", "custom", ""} {
		code := commandAttachments(Options{}, []string{"map", "laptop", "ollama", "--role", invalid})
		if code != ExitUsage {
			t.Fatalf("expected ExitUsage for invalid role %q, got %d", invalid, code)
		}
	}
}

func TestAttachmentsMapRejectsMissingArgs(t *testing.T) {
	temporary := t.TempDir()
	t.Setenv("OPENLIA_CONFIG", filepath.Join(temporary, "config.toml"))
	if err := saveConfig(defaultConfig()); err != nil {
		t.Fatal(err)
	}

	for _, args := range [][]string{
		{"map"},
		{"map", "laptop"},
		{"map", "laptop", "ollama"},
		{"map", "laptop", "ollama", "--wrong", "openai-gateway"},
	} {
		code := commandAttachments(Options{}, args)
		if code != ExitUsage {
			t.Fatalf("expected ExitUsage for args %v, got %d", args, code)
		}
	}
}

func TestLochoHostStatePersistsInOperatorConfigAcrossUninstallReinit(t *testing.T) {
	operatorDir := t.TempDir()
	cfgPath := filepath.Join(operatorDir, "config.toml")
	t.Setenv("OPENLIA_CONFIG", cfgPath)

	installRoot := filepath.Join(t.TempDir(), "openlia_dev")
	config := defaultConfig()
	config.Mode = "local"
	config.Target = ""
	config.InstallRoot = installRoot
	config.LochoHostEnabled = true
	if err := saveConfig(config); err != nil {
		t.Fatal(err)
	}

	dep := newDeployment(config)
	ctx := context.Background()

	if err := syncLochoHostState(ctx, dep, &config); err != nil {
		t.Fatalf("first syncLochoHostState failed: %v", err)
	}
	wantStateDir := filepath.Join(operatorDir, "locho-host")
	if config.LochoHostStateDir != wantStateDir {
		t.Fatalf("LochoHostStateDir = %q, want %q", config.LochoHostStateDir, wantStateDir)
	}

	operatorKey, err := os.ReadFile(filepath.Join(wantStateDir, "host.key"))
	if err != nil || len(operatorKey) != 32 {
		t.Fatalf("operator host.key len = %d, err = %v", len(operatorKey), err)
	}
	operatorState, err := os.ReadFile(filepath.Join(wantStateDir, "host_state.json"))
	if err != nil {
		t.Fatal(err)
	}

	stagedKeyPath := filepath.Join(installRoot, "runtime", "locho-host", "state", "host.key")
	stagedStatePath := filepath.Join(installRoot, "runtime", "locho-host", "state", "host_state.json")
	stagedKey, err := os.ReadFile(stagedKeyPath)
	if err != nil || string(stagedKey) != string(operatorKey) {
		t.Fatalf("staged host.key mismatch: err=%v", err)
	}
	stagedState, err := os.ReadFile(stagedStatePath)
	if err != nil || string(stagedState) != string(operatorState) {
		t.Fatalf("staged host_state.json mismatch: err=%v", err)
	}

	// Simulate `openlia uninstall` wiping the target install root
	if err := os.RemoveAll(installRoot); err != nil {
		t.Fatal(err)
	}

	// Simulate fresh `openlia deploy` re-staging from operator directory
	if err := syncLochoHostState(ctx, dep, &config); err != nil {
		t.Fatalf("second syncLochoHostState after uninstall failed: %v", err)
	}
	restagedKey, err := os.ReadFile(stagedKeyPath)
	if err != nil || string(restagedKey) != string(operatorKey) {
		t.Fatalf("restaged host.key changed after uninstall/deploy: err=%v", err)
	}
	restagedState, err := os.ReadFile(stagedStatePath)
	if err != nil || string(restagedState) != string(operatorState) {
		t.Fatalf("restaged host_state.json changed after uninstall/deploy: err=%v", err)
	}
}

func TestLochoHostStateAdoptsExistingTargetStateWhenOperatorDirMissing(t *testing.T) {
	operatorDir := t.TempDir()
	cfgPath := filepath.Join(operatorDir, "config.toml")
	t.Setenv("OPENLIA_CONFIG", cfgPath)

	// Pre-populate a target deployment's locho-host state using a temporary state dir
	seedDir := filepath.Join(t.TempDir(), "seed-locho-host")
	seedCfg := defaultConfig()
	seedCfg.LochoHostEnabled = true
	seedCfg.LochoHostStateDir = seedDir
	if err := ensureLochoHostState(context.Background(), nil, &seedCfg); err != nil {
		t.Fatal(err)
	}
	wantKey, _ := os.ReadFile(filepath.Join(seedDir, "host.key"))
	wantState, _ := os.ReadFile(filepath.Join(seedDir, "host_state.json"))

	installRoot := filepath.Join(t.TempDir(), "existing_target")
	targetStateDir := filepath.Join(installRoot, "runtime", "locho-host", "state")
	if err := os.MkdirAll(targetStateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(targetStateDir, "host.key"), wantKey, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(targetStateDir, "host_state.json"), wantState, 0o600); err != nil {
		t.Fatal(err)
	}

	config := defaultConfig()
	config.Mode = "local"
	config.InstallRoot = installRoot
	config.LochoHostEnabled = true
	dep := newDeployment(config)

	if err := ensureLochoHostState(context.Background(), dep, &config); err != nil {
		t.Fatalf("adopt existing target state failed: %v", err)
	}
	gotKey, err := os.ReadFile(filepath.Join(config.LochoHostStateDir, "host.key"))
	if err != nil || string(gotKey) != string(wantKey) {
		t.Fatalf("adopted host.key mismatch: err=%v", err)
	}
	gotState, err := os.ReadFile(filepath.Join(config.LochoHostStateDir, "host_state.json"))
	if err != nil || string(gotState) != string(wantState) {
		t.Fatalf("adopted host_state.json mismatch: err=%v", err)
	}
}

func TestCommandAuthUpdatesDashboardCredentialsInSecretSource(t *testing.T) {
	tmp := t.TempDir()
	cfgPath := filepath.Join(tmp, "config.toml")
	secretPath := filepath.Join(tmp, "openlia_dev.env")
	if err := os.WriteFile(secretPath, []byte("# Comment preserved\nCOPILOT_GITHUB_TOKEN=gho_testtoken123456\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := defaultConfig()
	cfg.Mode = "local"
	cfg.InstallRoot = filepath.Join(tmp, "install")
	cfg.SecretSource = secretPath
	if err := os.WriteFile(cfgPath, []byte(renderConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}

	origStdin := os.Stdin
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = origStdin })
	if _, err := w.WriteString("liaadmin\nSuperSecretPass123!\nSuperSecretPass123!\n"); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()

	code := Run([]string{"auth", "--config", cfgPath, "--json"}, fstest.MapFS{})
	if code != ExitOK {
		t.Fatalf("openlia auth exited with %d", code)
	}

	updated, err := os.ReadFile(secretPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(updated)
	for _, want := range []string{
		"# Comment preserved",
		"COPILOT_GITHUB_TOKEN=gho_testtoken123456",
		"HERMES_DASHBOARD_BASIC_AUTH_USERNAME=liaadmin",
		"HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=SuperSecretPass123!",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("expected %q in secret file, got:\n%s", want, text)
		}
	}
}

func TestCommandAuthOIDCUpdatesOIDCCredentialsInSecretSource(t *testing.T) {
	tmp := t.TempDir()
	cfgPath := filepath.Join(tmp, "config.toml")
	secretPath := filepath.Join(tmp, "openlia_dev.env")
	if err := os.WriteFile(secretPath, []byte("COPILOT_GITHUB_TOKEN=gho_testtoken123456\nHERMES_DASHBOARD_BASIC_AUTH_USERNAME=old\nHERMES_DASHBOARD_BASIC_AUTH_PASSWORD=oldpass\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := defaultConfig()
	cfg.Mode = "local"
	cfg.InstallRoot = filepath.Join(tmp, "install")
	cfg.SecretSource = secretPath
	if err := os.WriteFile(cfgPath, []byte(renderConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}

	origStdin := os.Stdin
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = origStdin })
	if _, err := w.WriteString("https://accounts.google.com\n12345-abc.apps.googleusercontent.com\nGOCSPX-mysecret\nhttp://127.0.0.1:9119\n"); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()

	code := Run([]string{"auth", "--oidc", "--config", cfgPath, "--json"}, fstest.MapFS{})
	if code != ExitOK {
		t.Fatalf("openlia auth --oidc exited with %d", code)
	}

	updated, err := os.ReadFile(secretPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(updated)
	for _, want := range []string{
		"COPILOT_GITHUB_TOKEN=gho_testtoken123456",
		"HERMES_DASHBOARD_OIDC_ISSUER=https://accounts.google.com",
		"HERMES_DASHBOARD_OIDC_CLIENT_ID=12345-abc.apps.googleusercontent.com",
		"HERMES_DASHBOARD_OIDC_CLIENT_SECRET=GOCSPX-mysecret",
		"HERMES_DASHBOARD_PUBLIC_URL=http://127.0.0.1:9119",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("expected %q in secret file, got:\n%s", want, text)
		}
	}
	if strings.Contains(text, "HERMES_DASHBOARD_BASIC_AUTH_") {
		t.Fatalf("expected basic auth keys to be removed when switching to OIDC, got:\n%s", text)
	}
}
