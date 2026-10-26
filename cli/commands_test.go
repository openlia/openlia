package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestDeploymentResultRunningGate(t *testing.T) {
	if !deploymentResultIsRunning([]byte(`{"state":"running"}`)) {
		t.Fatal("running deployment did not enable workspace Git reconciliation")
	}
	for _, raw := range [][]byte{[]byte(`{"state":"stopped"}`), []byte(`{"state":"never-started"}`), []byte(`not-json`)} {
		if deploymentResultIsRunning(raw) {
			t.Fatalf("non-running deployment enabled workspace Git reconciliation: %s", raw)
		}
	}
}

func TestDeploymentResultStateRejectsMissingOrInvalidState(t *testing.T) {
	for _, raw := range [][]byte{[]byte(`{}`), []byte(`not-json`)} {
		if state, ok := deploymentResultState(raw); ok || state != "" {
			t.Fatalf("deployment state %q, %t for %s", state, ok, raw)
		}
	}
}

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

func TestAuthSetupPersistsPromptedSourceBeforeDeployment(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.toml")
	t.Setenv("OPENLIA_CONFIG", configPath)
	config := defaultConfig()
	config.Mode = "local"
	config.Target = ""
	config.InstallRoot = filepath.Join(t.TempDir(), "missing-deployment")
	if err := saveConfig(config); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "hermes.env")
	if err := os.WriteFile(source, []byte("OPENAI_API_KEY=test-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.WriteString(source + "\n"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	previousStdin := os.Stdin
	os.Stdin = input
	t.Cleanup(func() {
		os.Stdin = previousStdin
		_ = input.Close()
	})

	if code := commandAuth(Options{}, []string{"setup"}); code != ExitFailure {
		t.Fatalf("auth setup exit code = %d, want deployment failure", code)
	}
	stored, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if stored.SecretSource != source {
		t.Fatalf("persisted secret source = %q, want %q", stored.SecretSource, source)
	}
}

func TestRunRejectsRetiredSkillSourceCommand(t *testing.T) {
	t.Setenv("OPENLIA_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	if code := Run([]string{"skill-sources", "list"}, fstest.MapFS{}); code != ExitUsage {
		t.Fatalf("retired skill-sources command exit code = %d, want %d", code, ExitUsage)
	}
}

func TestInitRejectsWorkspaceGitRemoteFlag(t *testing.T) {
	if code := commandInit(Options{}, []string{"--local", "--workspace-git-remote", "https://github.com/example/workspace.git"}, fstest.MapFS{}); code != ExitUsage {
		t.Fatalf("retired workspace Git remote flag exit code = %d, want %d", code, ExitUsage)
	}
}

func TestWorkspaceGitSetupRejectsRemoteOptions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	t.Setenv("OPENLIA_CONFIG", path)
	config := defaultConfig()
	config.Mode = "local"
	config.Target = ""
	config.InstallRoot = filepath.Join(t.TempDir(), "openlia")
	if err := saveConfig(config); err != nil {
		t.Fatal(err)
	}
	if code := commandWorkspaceGit(Options{}, []string{"setup", "--remote", "https://github.com/example/workspace.git"}); code != ExitUsage {
		t.Fatalf("retired workspace Git remote option exit code = %d, want %d", code, ExitUsage)
	}
}

func TestSkillsRejectsRetiredExternalLifecycleActions(t *testing.T) {
	for _, action := range []string{"install", "update", "uninstall", "reset", "audit", "fork-refresh"} {
		if code := commandSkills(Options{NonInteractive: true}, []string{action}, fstest.MapFS{}); code != ExitUsage {
			t.Fatalf("retired skills %s action exit code = %d, want %d", action, code, ExitUsage)
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

func TestInitRejectsSecretSourceOverride(t *testing.T) {
	if got := commandInit(Options{}, []string{
		"--target", "operator@example.test",
		"--secret-source", "/tmp/hermes.env",
	}, fstest.MapFS{}); got != ExitUsage {
		t.Fatalf("init with --secret-source exit code = %d, want %d", got, ExitUsage)
	}
}

func TestAuthRejectsSourceOverride(t *testing.T) {
	if got := commandAuth(Options{}, []string{"rotate", "--source", "/tmp/hermes.env"}); got != ExitUsage {
		t.Fatalf("auth rotate with --source exit code = %d, want %d", got, ExitUsage)
	}
}

func TestWorkspaceUIPasswordRejectsNonInteractiveSetup(t *testing.T) {
	if got := commandWorkspaceUI(Options{NonInteractive: true}, []string{"password"}); got != ExitUsage {
		t.Fatalf("non-interactive workspace-ui password exit code = %d, want %d", got, ExitUsage)
	}
	if got := commandWorkspaceUI(Options{}, []string{"password", "secret"}); got != ExitUsage {
		t.Fatalf("workspace-ui password argument exit code = %d, want %d", got, ExitUsage)
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

func TestSkillMigrationApplyRequiresInteractiveApproval(t *testing.T) {
	if got := commandSkillMigration(Options{NonInteractive: true}, []string{"apply", "proposal-1"}); got != ExitUsage {
		t.Fatalf("non-interactive migration apply exit code = %d, want %d", got, ExitUsage)
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

func TestUpdateOpenWebUIRejectsUnconfigured(t *testing.T) {
	temporary := t.TempDir()
	t.Setenv("OPENLIA_CONFIG", filepath.Join(temporary, "config.toml"))
	if err := saveConfig(defaultConfig()); err != nil {
		t.Fatal(err)
	}
	if got := commandUpdate(Options{}, []string{"open-webui"}, fstest.MapFS{}); got != ExitUsage {
		t.Fatalf("update open-webui exit code = %d, want %d", got, ExitUsage)
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
	config.WorkspaceUIHost = "127.0.0.1"
	config.WorkspaceUIPasswordHash = "$argon2id$v=19$m=65536,t=3,p=1$eIwxVdNwGiP5tSdLEaAU3g$KeDL6pxY8F3jC/rifCbGti4bQDFzPjE6lI0uHhKQ6e8"
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIAuth = true
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

	// Simulate fresh `openlia init` re-staging from operator directory
	if err := syncLochoHostState(ctx, dep, &config); err != nil {
		t.Fatalf("second syncLochoHostState after uninstall failed: %v", err)
	}
	restagedKey, err := os.ReadFile(stagedKeyPath)
	if err != nil || string(restagedKey) != string(operatorKey) {
		t.Fatalf("restaged host.key changed after uninstall/init: err=%v", err)
	}
	restagedState, err := os.ReadFile(stagedStatePath)
	if err != nil || string(restagedState) != string(operatorState) {
		t.Fatalf("restaged host_state.json changed after uninstall/init: err=%v", err)
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
