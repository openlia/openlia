package operator

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/BurntSushi/toml"
)

type recordedRunner struct {
	calls []string
}

type restartRunner struct {
	calls     []string
	dataRoot  string
	secretDir string
	network   string
}

type workspaceUIRunner struct {
	calls []string
}

func (r *workspaceUIRunner) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	r.calls = append(r.calls, call)
	if strings.Contains(call, "config --services") {
		return CommandResult{Stdout: []byte("workspace-ui\n")}, nil
	}
	if strings.Contains(call, "ps --services --filter status=running") {
		return CommandResult{Stdout: []byte("workspace-ui\n")}, nil
	}
	if strings.Contains(call, "port workspace-ui 8089") {
		return CommandResult{Stdout: []byte("127.0.0.1:8089\n")}, nil
	}
	return CommandResult{}, nil
}

type openWebUIRunner struct {
	calls []string
}

type deployBuildRunner struct {
	calls     []string
	dataRoot  string
	secretDir string
}

type lochoLifecycleRunner struct {
	calls           []string
	runningServices string
	stale           bool
}

func (r *lochoLifecycleRunner) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	r.calls = append(r.calls, call)
	if strings.Contains(call, "config --services") {
		return CommandResult{Stdout: []byte("workspace-ui\nopen-webui\nlocho-host\n")}, nil
	}
	if strings.Contains(call, "ps --services --filter status=running") {
		return CommandResult{Stdout: []byte(r.runningServices)}, nil
	}
	if strings.Contains(call, "port workspace-ui 8089") {
		return CommandResult{Stdout: []byte("127.0.0.1:8089\n")}, nil
	}
	if strings.Contains(call, "port open-webui 8080") {
		return CommandResult{Stdout: []byte("127.0.0.1:8090\n")}, nil
	}
	if strings.Contains(call, "exec -T locho-host sh -c") && r.stale {
		return CommandResult{ExitCode: 1}, fmt.Errorf("stale endpoint")
	}
	return CommandResult{}, nil
}

func (r *deployBuildRunner) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	r.calls = append(r.calls, call)
	if name == "docker" && len(args) > 0 && args[0] == "info" {
		return CommandResult{Stdout: []byte("linux\n")}, nil
	}
	if strings.Contains(call, "config --services") || strings.Contains(call, "ps --services --filter status=running") {
		return CommandResult{Stdout: []byte("hermes\n")}, nil
	}
	if strings.Contains(call, "ps -q hermes") {
		return CommandResult{Stdout: []byte("hermes-id\n")}, nil
	}
	if strings.Contains(call, "HostConfig.Privileged") {
		return CommandResult{Stdout: []byte("false\n")}, nil
	}
	if strings.Contains(call, `.Destination "/opt/data"`) {
		return CommandResult{Stdout: []byte(r.dataRoot)}, nil
	}
	if strings.Contains(call, `.Destination "/run/openlia-secrets"`) {
		return CommandResult{Stdout: []byte(r.secretDir)}, nil
	}
	if strings.Contains(call, "NetworkSettings.Networks") {
		return CommandResult{Stdout: []byte("test-project-private \n")}, nil
	}
	return CommandResult{}, nil
}

func (r *openWebUIRunner) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	r.calls = append(r.calls, call)
	if strings.Contains(call, "config --services") {
		return CommandResult{Stdout: []byte("open-webui\n")}, nil
	}
	if strings.Contains(call, "ps --services --filter status=running") {
		return CommandResult{Stdout: []byte("open-webui\n")}, nil
	}
	if strings.Contains(call, "port open-webui 8080") {
		return CommandResult{Stdout: []byte("127.0.0.1:8090\n")}, nil
	}
	return CommandResult{}, nil
}

func (r *recordedRunner) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	r.calls = append(r.calls, strings.Join(append([]string{name}, args...), " "))
	if name == "docker" && len(args) >= 2 && args[0] == "info" {
		return CommandResult{Stdout: []byte("linux\n")}, nil
	}
	if name == "docker" && len(args) >= 2 && args[0] == "network" && args[1] == "inspect" {
		return CommandResult{ExitCode: 1}, fmt.Errorf("network is absent")
	}
	return CommandResult{}, nil
}

func (r *restartRunner) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	r.calls = append(r.calls, call)
	if name == "docker" && (strings.Contains(call, "ps --services") || strings.Contains(call, "ps -q hermes")) {
		return CommandResult{Stdout: []byte("hermes\n")}, nil
	}
	if name == "docker" && strings.Contains(call, "config --services") {
		return CommandResult{Stdout: []byte("hermes\n")}, nil
	}
	if name == "docker" && strings.Contains(call, "HostConfig.Privileged") {
		return CommandResult{Stdout: []byte("false\n")}, nil
	}
	if name == "docker" && strings.Contains(call, `.Destination "/opt/data"`) {
		return CommandResult{Stdout: []byte(r.dataRoot)}, nil
	}
	if name == "docker" && strings.Contains(call, `.Destination "/run/openlia-secrets"`) {
		return CommandResult{Stdout: []byte(r.secretDir)}, nil
	}
	if name == "docker" && strings.Contains(call, "NetworkSettings.Networks") {
		return CommandResult{Stdout: []byte(r.network + " \n")}, nil
	}
	return CommandResult{}, nil
}

func TestValidateRuntimeDoesNotRequireTargetArchiveTools(t *testing.T) {
	repo := t.TempDir()
	config := testConfig(repo, filepath.Join(t.TempDir(), "runtime"))
	runner := &recordedRunner{}
	if _, err := ValidateRuntime(context.Background(), config, runner); err != nil {
		t.Fatal(err)
	}
	pythonCommand := "py" + "thon3 "
	tarCommand := "t" + "ar "
	for _, call := range runner.calls {
		if strings.HasPrefix(call, pythonCommand) || strings.HasPrefix(call, tarCommand) {
			t.Fatalf("target archive prerequisite was invoked: %s", call)
		}
	}
}

func TestProtectedSkillRefreshRecreatesOnlyRunningHermes(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	if err := os.MkdirAll(config.MetaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateRunning); err != nil {
		t.Fatal(err)
	}
	runner := &recordedRunner{}
	if err := refreshProtectedSkillRuntime(context.Background(), config, NewCompose(config, runner)); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 || !strings.Contains(runner.calls[0], "up -d --no-deps --force-recreate hermes") {
		t.Fatalf("unexpected protected skill refresh calls: %v", runner.calls)
	}
}

func TestSyncProfileAndRefreshRecreatesHermesAfterProtectedSkillSync(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtime)
	files := map[string]string{
		filepath.Join(repo, "profile", "SOUL.md"):                                                                               "soul\n",
		filepath.Join(repo, "profile", "AGENTS.md"):                                                                             "agents\n",
		filepath.Join(repo, "profile", "config.yaml"):                                                                           "model: {}\n",
		filepath.Join(repo, "profile", "skills", ".gitkeep"):                                                                    "",
		filepath.Join(repo, "profile", "system-skills", "openlia-skill-migration", "SKILL.md"):                                  "migration\n",
		filepath.Join(repo, "profile", "system-skills", "workspace-template-customization", "SKILL.md"):                         "customization\n",
		filepath.Join(repo, "profile", "system-skills", "workspace-template-customization", "scripts", "workspace_registry.py"): "helper\n",
		filepath.Join(repo, "release", "manifest.json"):                                                                         `{"openlia":"test"}`,
	}
	for path, contents := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(config.MetaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateRunning); err != nil {
		t.Fatal(err)
	}
	runner := &recordedRunner{}
	if _, err := syncProfileAndRefresh(context.Background(), config, NewCompose(config, runner)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(config.SystemSkillsRoot, "workspace-template-customization", "scripts", "workspace_registry.py")); err != nil {
		t.Fatalf("protected helper was not synchronized: %v", err)
	}
	if !strings.Contains(strings.Join(runner.calls, "\n"), "up -d --no-deps --force-recreate hermes") {
		t.Fatalf("running Hermes was not refreshed after profile sync: %v", runner.calls)
	}
}

func TestDeployRestartRecreatesFullStack(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	for _, directory := range []string{config.DataRoot, config.BackupRoot, config.MetaRoot, config.LochoRoot, config.SecretDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(config.ComposeFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("# test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateNeverStarted); err != nil {
		t.Fatal(err)
	}
	runner := &restartRunner{dataRoot: config.DataRoot, secretDir: config.SecretDir, network: config.NetworkName}
	if _, err := Deploy(context.Background(), config, NewCompose(config, runner), DeployOptions{Action: "restart", Component: "all", HealthAttempts: 1}, time.Now()); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "up -d --force-recreate") {
		t.Fatalf("restart did not recreate the full stack: %s", joined)
	}
	if strings.Contains(joined, " compose restart") {
		t.Fatalf("restart still used Compose restart: %s", joined)
	}
}

func TestDeployBuildsOnceAndRunsOneFullHealthcheck(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	for _, directory := range []string{config.DataRoot, config.BackupRoot, config.MetaRoot, config.LochoRoot, config.SecretDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(config.ComposeFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("# test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateNeverStarted); err != nil {
		t.Fatal(err)
	}
	runner := &deployBuildRunner{dataRoot: config.DataRoot, secretDir: config.SecretDir}
	if _, err := Deploy(context.Background(), config, NewCompose(config, runner), DeployOptions{Action: "deploy", Component: "hermes", HealthAttempts: 1}, time.Now()); err != nil {
		t.Fatalf("%v; calls=%v", err, runner.calls)
	}
	builds := 0
	fullHealthchecks := 0
	for _, call := range runner.calls {
		if strings.Contains(call, " build hermes") {
			builds++
		}
		if strings.Contains(call, " up -d") && strings.Contains(call, "--build") {
			t.Fatalf("Compose up requested a duplicate build: %s", call)
		}
		if strings.HasSuffix(call, " info") {
			fullHealthchecks++
		}
	}
	if builds != 1 {
		t.Fatalf("Hermes was built %d times: %v", builds, runner.calls)
	}
	if fullHealthchecks != 1 {
		t.Fatalf("full healthcheck ran %d times: %v", fullHealthchecks, runner.calls)
	}
}

func TestDeployWorkspaceUIComponentTargetsOnlyWorkspaceUI(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtime)
	config.WorkspaceUIHost = "127.0.0.1"
	if err := os.MkdirAll(filepath.Dir(config.ComposeFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.SecretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("# test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.MetaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateNeverStarted); err != nil {
		t.Fatal(err)
	}
	runner := &workspaceUIRunner{}
	if _, err := Deploy(context.Background(), config, NewCompose(config, runner), DeployOptions{Action: "start", Component: "workspace-ui", HealthAttempts: 1}, time.Now()); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "up -d --no-deps --force-recreate workspace-ui") {
		t.Fatalf("workspace-ui target was not started directly: %s", joined)
	}
	if strings.Contains(joined, "hermes") || strings.Contains(joined, "locho") {
		t.Fatalf("targeted workspace-ui deploy touched another service: %s", joined)
	}
}

func TestDeployOpenWebUIComponentTargetsOnlyOpenWebUI(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIPort = 8090
	config.OpenWebUIAuth = true
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.SecretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("# test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.MetaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateNeverStarted); err != nil {
		t.Fatal(err)
	}
	runner := &openWebUIRunner{}
	if _, err := Deploy(context.Background(), config, NewCompose(config, runner), DeployOptions{Action: "start", Component: "open-webui", HealthAttempts: 1}, time.Now()); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.calls, "\n")
	if !strings.Contains(joined, "up -d --no-deps --force-recreate open-webui") {
		t.Fatalf("open-webui target was not started directly: %s", joined)
	}
	if !strings.Contains(joined, "except Exception:") || !strings.Contains(joined, "sys.exit(1)") {
		t.Fatalf("open-webui health probe does not suppress expected startup failures: %s", joined)
	}
	if strings.Contains(joined, "hermes") || strings.Contains(joined, "locho") || strings.Contains(joined, "workspace-ui") {
		t.Fatalf("targeted open-webui deploy touched another service: %s", joined)
	}
}

func TestTargetedUIRecreationAlsoRecreatesLochoHost(t *testing.T) {
	for _, component := range []string{"workspace-ui", "open-webui"} {
		t.Run(component, func(t *testing.T) {
			repo := t.TempDir()
			runtimeRoot := filepath.Join(t.TempDir(), "runtime")
			config := testConfig(repo, runtimeRoot)
			config.LochoHostEnabled = true
			config.LochoHostRoot = filepath.Join(runtimeRoot, "locho-host")
			config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
			config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
			config.WorkspaceUIHost = "127.0.0.1"
			config.WorkspaceUIAuthRequired = true
			config.WorkspaceUIPasswordHashFile = filepath.Join(config.SecretDir, "workspace-ui-password.hash")
			config.OpenWebUIHost = "127.0.0.1"
			config.OpenWebUIAuth = true
			for _, directory := range []string{filepath.Dir(config.ComposeFile), config.SecretDir, config.MetaRoot, config.LochoHostRoot, config.LochoHostStateRoot} {
				if err := os.MkdirAll(directory, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(config.SecretFile, []byte("# test\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := WriteState(config, stateNeverStarted); err != nil {
				t.Fatal(err)
			}
			runner := &lochoLifecycleRunner{runningServices: "workspace-ui\nopen-webui\nlocho-host\n"}
			if _, err := Deploy(context.Background(), config, NewCompose(config, runner), DeployOptions{Action: "start", Component: component, HealthAttempts: 1}, time.Now()); err != nil {
				t.Fatalf("%v; calls=%v", err, runner.calls)
			}
			joined := strings.Join(runner.calls, "\n")
			if !strings.Contains(joined, "up -d --no-deps --force-recreate "+component) || !strings.Contains(joined, "up -d --no-deps --force-recreate locho-host") {
				t.Fatalf("targeted recreation did not reconcile Locho host: %s", joined)
			}
		})
	}
}

func TestLochoHostHealthRejectsStaleEndpoints(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	config.LochoHostEnabled = true
	runner := &lochoLifecycleRunner{runningServices: "workspace-ui\nopen-webui\nlocho-host\n", stale: true}
	if lochoHostHealthy(context.Background(), config, NewCompose(config, runner)) {
		t.Fatal("stale Locho endpoints were reported healthy")
	}
}

func TestLochoOnlyDeployRejectsStoppedUIDependencies(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.LochoHostEnabled = true
	config.LochoHostRoot = filepath.Join(runtimeRoot, "locho-host")
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
	config.WorkspaceUIHost = "127.0.0.1"
	config.WorkspaceUIAuthRequired = true
	config.WorkspaceUIPasswordHashFile = filepath.Join(config.SecretDir, "workspace-ui-password.hash")
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIAuth = true
	for _, directory := range []string{filepath.Dir(config.ComposeFile), config.SecretDir, config.MetaRoot, config.LochoHostRoot, config.LochoHostStateRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("# test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateRunning); err != nil {
		t.Fatal(err)
	}
	runner := &lochoLifecycleRunner{runningServices: "locho-host\n"}
	if _, err := Deploy(context.Background(), config, NewCompose(config, runner), DeployOptions{Action: "deploy", Component: "locho", HealthAttempts: 1}, time.Now()); err == nil || !strings.Contains(err.Error(), "run openlia deploy first") {
		t.Fatalf("missing UI dependencies were not rejected: %v", err)
	}
}

func TestTargetedUIUpdateRejectsStoppedPeer(t *testing.T) {
	for _, test := range []struct {
		component string
		running   string
	}{
		{component: "workspace-ui", running: "workspace-ui\nlocho-host\n"},
		{component: "open-webui", running: "open-webui\nlocho-host\n"},
	} {
		t.Run(test.component, func(t *testing.T) {
			repo := t.TempDir()
			runtimeRoot := filepath.Join(t.TempDir(), "runtime")
			config := testConfig(repo, runtimeRoot)
			config.LochoHostEnabled = true
			config.LochoHostRoot = filepath.Join(runtimeRoot, "locho-host")
			config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
			config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
			config.WorkspaceUIHost = "127.0.0.1"
			config.WorkspaceUIAuthRequired = true
			config.WorkspaceUIPasswordHashFile = filepath.Join(config.SecretDir, "workspace-ui-password.hash")
			config.OpenWebUIHost = "127.0.0.1"
			config.OpenWebUIAuth = true
			for _, directory := range []string{filepath.Dir(config.ComposeFile), config.SecretDir, config.MetaRoot, config.LochoHostRoot, config.LochoHostStateRoot} {
				if err := os.MkdirAll(directory, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(config.SecretFile, []byte("# test\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := WriteState(config, stateStopped); err != nil {
				t.Fatal(err)
			}
			runner := &lochoLifecycleRunner{runningServices: test.running}
			if _, err := Deploy(context.Background(), config, NewCompose(config, runner), DeployOptions{Action: "deploy", Component: test.component, ForceStart: true, HealthAttempts: 1}, time.Now()); err == nil || !strings.Contains(err.Error(), "run openlia deploy first") {
				t.Fatalf("stopped peer was not rejected: %v", err)
			}
			for _, call := range runner.calls {
				if strings.Contains(call, " up -d") {
					t.Fatalf("partial stack was started before rejection: %v", runner.calls)
				}
			}
		})
	}
}

func TestLochoHostConfigRejectsSymlink(t *testing.T) {
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(t.TempDir(), runtimeRoot)
	config.LochoHostEnabled = true
	config.LochoHostRoot = filepath.Join(runtimeRoot, "locho-host")
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
	if err := os.MkdirAll(config.LochoHostStateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("protected\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, config.LochoHostConfig); err != nil {
		t.Fatal(err)
	}
	if err := writeLochoHostConfig(config); err == nil || !strings.Contains(err.Error(), "non-symlink") {
		t.Fatalf("Locho config symlink was not rejected: %v", err)
	}
	if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("symlink target metadata changed: %v, %v", info, err)
	}
}

func TestBackupExcludesSecretsAndAttachmentCapabilities(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	for _, directory := range []string{config.DataRoot, config.LochoRoot, config.MetaRoot, config.BackupRoot, config.SecretDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(config.DataRoot, "keep.txt"):                        "keep",
		filepath.Join(config.DataRoot, "auth.json"):                       "secret",
		filepath.Join(config.DataRoot, "session.env"):                     "secret",
		filepath.Join(config.DataRoot, "pairing", "device.json"):          "secret",
		filepath.Join(config.DataRoot, "mcp-tokens", "token.secret"):      "secret",
		filepath.Join(config.DataRoot, "nested", "private.secret"):        "secret",
		filepath.Join(config.LochoRoot, "laptop", "attachments.toml"):     "capability",
		filepath.Join(config.LochoRoot, "laptop", "runtime.txt"):          "runtime",
		filepath.Join(config.RuntimeRoot, "secrets", "hermes.env"):        "secret",
		filepath.Join(config.RuntimeRoot, "hermes", "logs", "hermes.log"): "log",
	}
	for path, contents := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	result, identity := createTestEncryptedBackup(t, &config, "test", time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC))
	plainArchive := decryptTestBackup(t, config.BackupRoot, result.Archive, identity)
	names := archiveNames(t, plainArchive)
	if !names["hermes/keep.txt"] || names["locho/laptop/runtime.txt"] {
		t.Fatalf("ordinary runtime files missing from archive: %v", names)
	}
	for _, forbidden := range []string{"hermes/auth.json", "hermes/session.env", "hermes/pairing/device.json", "hermes/mcp-tokens/token.secret", "hermes/nested/private.secret", "locho/laptop/attachments.toml", "secrets/hermes.env", "hermes/logs/hermes.log"} {
		if names[forbidden] {
			t.Fatalf("sensitive archive member present: %s", forbidden)
		}
	}
}

func TestDurableBackupExcludesRebuildableSkillsAndCaches(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	for _, directory := range []string{config.DataRoot, config.MetaRoot, config.BackupRoot, config.LochoRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(config.DataRoot, "workspace", "keep.md"):                          "workspace",
		filepath.Join(config.DataRoot, "cache", "model.bin"):                            "cache",
		filepath.Join(config.DataRoot, "home", "package.bin"):                           "package",
		filepath.Join(config.DataRoot, "skills", "creative", "DESCRIPTION.md"):          "bundled metadata",
		filepath.Join(config.DataRoot, "skills", "creative", "ascii-video", "SKILL.md"): "bundled",
		filepath.Join(config.DataRoot, "skills", "weekly-review", "SKILL.md"):           "managed",
		filepath.Join(config.DataRoot, "skills", ".bundled_manifest"):                   "ascii-video:hash\n",
		filepath.Join(config.RuntimeRoot, "open-webui", "webui.db"):                     "open-webui",
	}
	for path, contents := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	result, identity := createTestEncryptedBackup(t, &config, "durable-scope", time.Now())
	plainArchive := decryptTestBackup(t, config.BackupRoot, result.Archive, identity)
	names := archiveNames(t, plainArchive)
	for _, expected := range []string{"hermes/workspace/keep.md", "hermes/skills/weekly-review/SKILL.md"} {
		if !names[expected] {
			t.Fatalf("durable member missing %s: %v", expected, names)
		}
	}
	for _, excluded := range []string{"hermes/cache/model.bin", "hermes/home/package.bin", "hermes/skills/creative/ascii-video/SKILL.md", "open-webui/webui.db", "locho"} {
		if names[excluded] {
			t.Fatalf("rebuildable or excluded member present %s: %v", excluded, names)
		}
	}
}

func TestRollbackBackupContainsOnlyDeclaredPaths(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	for _, directory := range []string{config.DataRoot, config.MetaRoot, config.BackupRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for path, contents := range map[string]string{
		filepath.Join(config.DataRoot, "config.yaml"):          "config",
		filepath.Join(config.DataRoot, "workspace", "keep.md"): "workspace",
		filepath.Join(config.DataRoot, "unrelated.db"):         "unrelated",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := CreateRollback(config, "test-rollback", time.Now(), "hermes/config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	names := archiveNames(t, result.Archive)
	if !names["manifest.json"] || !names["hermes/config.yaml"] {
		t.Fatalf("declared rollback member missing: %v", names)
	}
	if names["hermes/workspace/keep.md"] || names["hermes/unrelated.db"] {
		t.Fatalf("rollback captured undeclared state: %v", names)
	}
}

func TestRestoreRollbackAppliesOnlyDeclaredPaths(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	for _, directory := range []string{config.DataRoot, config.MetaRoot, config.BackupRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	configPath := filepath.Join(config.DataRoot, "config.yaml")
	if err := os.WriteFile(configPath, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive, err := CreateRollback(config, "restore-test", time.Now(), "hermes/config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("after"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config.DataRoot, "unrelated.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreRollback(config, archive.Archive, time.Now()); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(configPath)
	if err != nil || string(contents) != "before" {
		t.Fatalf("rollback restored config = %q, err=%v", contents, err)
	}
	if _, err := os.Stat(filepath.Join(config.DataRoot, "unrelated.txt")); err != nil {
		t.Fatalf("rollback touched unrelated state: %v", err)
	}
}

func TestDurableBackupRestoresAcrossRuntimeRoots(t *testing.T) {
	sourceConfig := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "source-runtime"))
	for _, directory := range []string{sourceConfig.DataRoot, sourceConfig.MetaRoot, sourceConfig.BackupRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for path, contents := range map[string]string{
		filepath.Join(sourceConfig.DataRoot, "workspace", "note.md"):  "portable",
		filepath.Join(sourceConfig.DataRoot, "config.yaml"):           "old host config",
		filepath.Join(sourceConfig.DataRoot, "services.json"):         "old services",
		filepath.Join(sourceConfig.MetaRoot, "runtime.json"):          `{"install_root":"/old/root"}`,
		filepath.Join(sourceConfig.MetaRoot, "managed", "state.json"): "managed state",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	archive, identity := createTestEncryptedBackup(t, &sourceConfig, "portable", time.Now())
	var metadata backupMetadata
	metadataData, err := os.ReadFile(archive.Archive + ".json")
	if err != nil || json.Unmarshal(metadataData, &metadata) != nil || metadata.Archive != filepath.Base(archive.Archive) {
		t.Fatalf("backup metadata is not portable: %s", metadataData)
	}
	targetConfig := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "new-runtime"))
	for _, directory := range []string{targetConfig.DataRoot, targetConfig.MetaRoot, targetConfig.BackupRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	targetConfig.BackupRecipient = sourceConfig.BackupRecipient
	if err := os.WriteFile(filepath.Join(targetConfig.DataRoot, "config.yaml"), []byte("new host config"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := restoreTestEncryptedBackup(t, targetConfig, archive.Archive, identity, time.Now()); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filepath.Join(targetConfig.DataRoot, "workspace", "note.md"))
	if err != nil || string(contents) != "portable" {
		t.Fatalf("portable workspace restore = %q, err=%v", contents, err)
	}
	configContents, err := os.ReadFile(filepath.Join(targetConfig.DataRoot, "config.yaml"))
	if err != nil || string(configContents) != "new host config" {
		t.Fatalf("host config was restored over destination config: %q, err=%v", configContents, err)
	}
	var runtime RuntimeMetadata
	runtimeData, err := os.ReadFile(filepath.Join(targetConfig.MetaRoot, "runtime.json"))
	if err != nil || json.Unmarshal(runtimeData, &runtime) != nil || runtime.InstallRoot != targetConfig.InstallRoot {
		t.Fatalf("runtime metadata was not rebased: %s", runtimeData)
	}
}

func TestDurableRestoreRemovesStaleFilesAndKeepsGeneratedState(t *testing.T) {
	sourceConfig := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "source-runtime"))
	for _, directory := range []string{sourceConfig.DataRoot, sourceConfig.MetaRoot, sourceConfig.BackupRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for path, contents := range map[string]string{
		filepath.Join(sourceConfig.DataRoot, "workspace", "restored.md"): "restored",
		filepath.Join(sourceConfig.MetaRoot, "managed", "state.json"):    "managed",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	archive, identity := createTestEncryptedBackup(t, &sourceConfig, "portable", time.Now())
	targetConfig := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "target-runtime"))
	for _, directory := range []string{targetConfig.DataRoot, targetConfig.MetaRoot, targetConfig.BackupRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for path, contents := range map[string]string{
		filepath.Join(targetConfig.DataRoot, "stale.db"):      "stale",
		filepath.Join(targetConfig.DataRoot, "config.yaml"):   "current-config",
		filepath.Join(targetConfig.MetaRoot, "services.json"): "current-services",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	targetConfig.BackupRecipient = sourceConfig.BackupRecipient
	if _, err := restoreTestEncryptedBackup(t, targetConfig, archive.Archive, identity, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(targetConfig.DataRoot, "stale.db")); !os.IsNotExist(err) {
		t.Fatalf("stale file survived durable restore: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(targetConfig.DataRoot, "config.yaml")); err != nil || string(data) != "current-config" {
		t.Fatalf("generated config was not preserved: %q, %v", data, err)
	}
}

func TestRestoreRejectsUnsafeArchiveBeforeChangingState(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	for _, directory := range []string{config.DataRoot, config.MetaRoot, config.BackupRoot, config.LochoRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	current := filepath.Join(config.DataRoot, "keep.txt")
	if err := os.WriteFile(current, []byte("current"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(config.BackupRoot, "openlia-unsafe.tar.gz")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	if err := tarWriter.WriteHeader(&tar.Header{Name: "../escape", Mode: 0o600, Size: 1, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	_, _ = tarWriter.Write([]byte("x"))
	_ = tarWriter.Close()
	_ = gzipWriter.Close()
	_ = file.Close()
	if _, err := RestoreBackup(config, archive, time.Now()); err == nil {
		t.Fatal("unsafe archive was accepted")
	}
	contents, err := os.ReadFile(current)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "current" {
		t.Fatalf("current data changed after rejected archive: %q", contents)
	}
}

func TestArchiveMemberAllowsSpacesAndRejectsDeepPaths(t *testing.T) {
	if !safeArchiveMember("hermes/workspace/My Notes.md") {
		t.Fatal("archive member with spaces was rejected")
	}
	deep := "hermes/" + strings.Repeat("nested/", maxArchivePathDepth) + "file.md"
	if safeArchiveMember(deep) {
		t.Fatal("overly deep archive member was accepted")
	}
}

func TestRestoreRejectsMismatchedBackupDigest(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	for _, directory := range []string{config.DataRoot, config.MetaRoot, config.BackupRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	archive, _ := createTestEncryptedBackup(t, &config, "digest", time.Now())
	if err := os.WriteFile(archive.Archive, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyBackupDigest(archive.Archive); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered archive error = %v", err)
	}
}

func TestRestoreCreatesPreflightBackupWithoutOverwritingSelectedArchive(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	for _, directory := range []string{config.DataRoot, config.MetaRoot, config.BackupRoot, config.LochoRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(config.DataRoot, "value.txt")
	if err := os.WriteFile(path, []byte("archived"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive, identity := createTestEncryptedBackup(t, &config, "restore-test", time.Now())
	if err := os.WriteFile(path, []byte("current"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := restoreTestEncryptedBackup(t, config, archive.Archive, identity, time.Now()); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "archived" {
		t.Fatalf("restored contents = %q, want archived", contents)
	}
}

func TestGeneratedAttachmentsContainLochoBuildAndHardening(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.ServiceRoles = map[string]string{"laptop.openlia-browser": "openlia-browser"}
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIPort = 8090
	config.LochoRelayConfig = filepath.Join(runtimeRoot, "locho", "relay.toml")
	config.LochoRelaySecrets = filepath.Join(runtimeRoot, "locho-relay-secrets", "relay.env")
	if err := os.MkdirAll(filepath.Dir(config.LochoRelayConfig), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.LochoRelayConfig, []byte("include_n0_relays = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.SecretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("COPILOT_GITHUB_TOKEN=gho_testtoken\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(config.LochoRelayConfig), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.LochoRelayConfig, []byte("include_n0_relays = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(config.LochoRelaySecrets), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.LochoRelaySecrets, []byte("LOCHO_RELAY_TOKEN=test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	attachment := filepath.Join(config.LochoRoot, "laptop", "attachments.toml")
	if err := os.MkdirAll(filepath.Dir(attachment), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(attachment, []byte("host_id = \"laptop\"\nlisten_host = \"127.0.0.1\"\n[[services]]\ncapability = \"genai:http:capability\"\nlisten_port = 8088\n[[services]]\ncapability = \"openlia-browser:http:capability\"\nlisten_port = 8932\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(config.LochoRelayConfig)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("relay config permissions = %o", info.Mode().Perm())
	}
	data, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{"locho-laptop:", "build:", "docker/locho.Dockerfile", fmt.Sprintf("user: \"%d:%d\"", config.RuntimeUID, config.RuntimeGID), "cap_drop: [ALL]", "no-new-privileges:true", "OPENLIA_BROWSER_MCP_URL: \"http://locho-laptop:8932\"", "--relay-config", "/etc/locho/relay.toml", "target: /etc/locho/relay.toml", "locho-relay-secrets/relay.env"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("generated Compose missing %q:\n%s", expected, text)
		}
	}
	if strings.Contains(text, "/runtime/secrets/locho-relay.env") {
		t.Fatal("relay secrets were placed in Hermes' mounted secrets directory")
	}
	if strings.Index(text, "env_file:") < strings.Index(text, "OPENLIA_BROWSER_MCP_URL:") {
		t.Fatal("Hermes env_file interrupts its generated environment mapping")
	}
	start := strings.Index(text, "  locho-laptop:\n")
	if start < 0 {
		t.Fatalf("generated Compose has no locho-laptop service:\n%s", text)
	}
	serviceStart := start + len("  locho-laptop:\n")
	end := len(text)
	if relative := strings.Index(text[serviceStart:], "\n  locho-"); relative >= 0 {
		end = serviceStart + relative
	} else if relative := strings.Index(text[serviceStart:], "\nnetworks:"); relative >= 0 {
		end = serviceStart + relative
	}
	block := text[start:end]
	relayVolume := "        target: /etc/locho/relay.toml\n        read_only: true\n"
	relayEnvFile := fmt.Sprintf("    env_file:\n      - %q\n", config.LochoRelaySecrets)
	volumeIndex := strings.Index(block, relayVolume)
	envFileIndex := strings.Index(block, relayEnvFile)
	networksIndex := strings.Index(block, "    networks:\n")
	if volumeIndex < 0 || envFileIndex < 0 || networksIndex < 0 || volumeIndex > envFileIndex || envFileIndex > networksIndex {
		t.Fatalf("attachment relay fields are not service-level siblings in order:\n%s", block)
	}
	if !strings.Contains(block, "\"--relay-config\", \"/etc/locho/relay.toml\"") {
		t.Fatalf("attachment command is missing relay config:\n%s", block)
	}
	if strings.Contains(block, filepath.Join(config.SecretDir, "locho-relay.env")) {
		t.Fatalf("attachment relay secrets were placed in Hermes' mounted secrets directory:\n%s", block)
	}
}

func TestAttachmentInventoryCarriesHTTPTimeout(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	if err := os.MkdirAll(filepath.Join(config.LochoRoot, "api"), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(config.LochoRoot, "api", "attachments.toml")
	if err := os.WriteFile(path, []byte("host_id = \"api\"\nlisten_host = \"127.0.0.1\"\n[[services]]\ncapability = \"gateway:http:secret\"\nlisten_port = 8765\nhttp_timeout_secs = 9_0 # comment\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := ListAttachments(config)
	if err != nil || len(result.Hosts) != 1 || result.Hosts[0].Services[0].HTTPTimeoutSecs != 90 {
		t.Fatalf("attachment timeout inventory = %#v, err=%v", result, err)
	}
	for _, value := range []string{"0", "301"} {
		if err := os.WriteFile(path, []byte("host_id = \"api\"\nlisten_host = \"127.0.0.1\"\n[[services]]\ncapability = \"gateway:http:secret\"\nlisten_port = 8765\nhttp_timeout_secs = "+value+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := ListAttachments(config); err == nil {
			t.Fatalf("invalid HTTP timeout %s was accepted", value)
		}
	}
	if err := os.WriteFile(path, []byte("host_id = \"api\"\nlisten_host = \"127.0.0.1\"\n[[services]]\ncapability = \"database:tcp:secret\"\nlisten_port = 5432\nhttp_timeout_secs = 90\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ListAttachments(config); err == nil {
		t.Fatal("HTTP timeout on TCP service was accepted")
	}
}

func TestGeneratedLochoHostHasOneRelayEnvFile(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.WorkspaceUIHost = "127.0.0.1"
	config.WorkspaceUIAuthRequired = true
	config.WorkspaceUIPasswordHashFile = filepath.Join(runtimeRoot, "secrets", "workspace-ui-password.hash")
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIAuth = true
	config.LochoHostEnabled = true
	config.LochoHostRoot = filepath.Join(runtimeRoot, "locho-host")
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
	config.LochoRelayConfig = filepath.Join(runtimeRoot, "locho", "relay.toml")
	config.LochoRelaySecrets = filepath.Join(runtimeRoot, "locho-relay-secrets", "relay.env")
	if err := os.MkdirAll(filepath.Dir(config.LochoRelayConfig), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.LochoRelayConfig, []byte("include_n0_relays = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	start := strings.Index(text, "  locho-host:\n")
	end := -1
	if start >= 0 {
		serviceStart := start + len("  locho-host:\n")
		end = len(text)
		if relative := strings.Index(text[serviceStart:], "\n  locho-"); relative >= 0 {
			end = serviceStart + relative
		} else if relative := strings.Index(text[serviceStart:], "\nnetworks:"); relative >= 0 {
			end = serviceStart + relative
		}
	}
	if start < 0 || end < 0 {
		t.Fatalf("generated Compose has no isolated locho-host service:\n%s", text)
	}
	block := text[start:end]
	if strings.Count(block, "    env_file:\n") != 1 {
		t.Fatalf("locho-host env_file count = %d:\n%s", strings.Count(block, "    env_file:\n"), block)
	}
	relayVolume := "        target: /etc/locho/relay.toml\n        read_only: true\n"
	relayEnvFile := fmt.Sprintf("    env_file:\n      - %q\n", config.LochoRelaySecrets)
	volumeIndex := strings.Index(block, relayVolume)
	envFileIndex := strings.Index(block, relayEnvFile)
	dependsOnIndex := strings.Index(block, "    depends_on:\n")
	if volumeIndex < 0 || envFileIndex < 0 || dependsOnIndex < 0 || volumeIndex > envFileIndex || envFileIndex > dependsOnIndex {
		t.Fatalf("locho-host relay fields are not service-level siblings in order:\n%s", block)
	}
	if !strings.Contains(block, "--relay-config /etc/locho/relay.toml") {
		t.Fatalf("locho-host command is missing relay config:\n%s", block)
	}
}

func TestGeneratedAttachmentsContainWorkspaceUIWhenEnabled(t *testing.T) {
	for _, test := range []struct {
		name      string
		host      string
		port      int
		published string
	}{
		{name: "loopback", host: "127.0.0.1", port: 8089, published: "127.0.0.1:8089:8089"},
		{name: "all interfaces", host: "0.0.0.0", port: 8090, published: "0.0.0.0:8090:8090"},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo := t.TempDir()
			runtimeRoot := filepath.Join(t.TempDir(), "runtime")
			config := testConfig(repo, runtimeRoot)
			config.OpenLiaReleaseSHA256 = strings.Repeat("a", 64)
			config.WorkspaceUIHost = test.host
			config.WorkspaceUIPort = test.port
			config.WorkspaceUIAuthRequired = test.host == "0.0.0.0"
			config.WorkspaceUIPasswordHashFile = filepath.Join(runtimeRoot, "secrets", "workspace-ui-password.hash")
			if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := GenerateAttachments(config); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(config.GeneratedCompose)
			if err != nil {
				t.Fatal(err)
			}
			text := string(data)
			for _, expected := range []string{"OPENLIA_MEMORIES_ROOT: /memories", "target: /memories", filepath.Join(config.DataRoot, "memories")} {
				if !strings.Contains(text, expected) {
					t.Fatalf("generated Compose missing memory mount %q:\n%s", expected, text)
				}
			}
			for _, expected := range []string{"workspace-ui:", "docker/workspace-ui.Dockerfile", "OPENLIA_RELEASE_SHA256: \"" + strings.Repeat("a", 64) + "\"", test.published, fmt.Sprintf("OPENLIA_WORKSPACE_UI_PORT: \"%d\"", test.port), "OPENLIA_SKILLS_ROOT: /skills", "OPENLIA_INGESTION_ROOT: /ingestion", "target: /workspace", "target: /skills", "target: /ingestion", fmt.Sprintf("user: \"%d:%d\"", config.RuntimeUID, config.RuntimeGID), "cap_drop: [ALL]"} {
				if !strings.Contains(text, expected) {
					t.Fatalf("generated Compose missing %q:\n%s", expected, text)
				}
			}
			if test.host == "0.0.0.0" {
				for _, expected := range []string{"OPENLIA_WORKSPACE_UI_AUTH_REQUIRED: \"true\"", "OPENLIA_WORKSPACE_UI_SESSION_DB: /var/lib/openlia/sessions.sqlite", "target: /run/openlia-secrets/workspace-ui-password.hash", "target: /var/lib/openlia", "read_only: true"} {
					if !strings.Contains(text, expected) {
						t.Fatalf("generated public Workspace UI Compose missing %q:\n%s", expected, text)
					}
				}
			} else if strings.Contains(text, "OPENLIA_WORKSPACE_UI_AUTH_REQUIRED") {
				t.Fatal("loopback Workspace UI unexpectedly enabled authentication")
			}
		})
	}
}

func TestGeneratedAttachmentsContainOpenWebUI(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIPort = 8090
	config.OpenWebUIImage = "ghcr.io/open-webui/open-webui:main"
	config.OpenWebUIAuth = true
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.SecretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("COPILOT_GITHUB_TOKEN=gho_testtoken\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(config.OpenWebUIDataRoot); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("Open WebUI data root permissions = %v, want 0700", err)
	}
	data, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{
		"open-webui:",
		"ghcr.io/open-webui/open-webui:main",
		"127.0.0.1:8090:8080",
		"target: /app/backend/data",
		"OPENAI_API_BASE_URL: \"http://hermes:8642/v1\"",
		"ENABLE_OLLAMA_API: \"False\"",
		"WEBUI_NAME: \"OpenLia\"",
		"WEBUI_AUTH: \"True\"",
		"except Exception:\\n    sys.exit(1)",
		"API_SERVER_ENABLED: \"true\"",
		"API_SERVER_HOST: \"0.0.0.0\"",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("generated Compose missing %q:\n%s", expected, text)
		}
	}

	// Verify secrets were provisioned
	openWebUIEnvPath := filepath.Join(config.SecretDir, "open-webui.env")
	envData, err := os.ReadFile(openWebUIEnvPath)
	if err != nil {
		t.Fatalf("open-webui.env missing: %v", err)
	}
	envText := string(envData)
	if !strings.Contains(envText, "OPENAI_API_KEY=sk-openlia-") || !strings.Contains(envText, "WEBUI_SECRET_KEY=") {
		t.Fatalf("open-webui.env missing expected keys:\n%s", envText)
	}

	apiKey, err := readSecretValue(openWebUIEnvPath, "OPENAI_API_KEY")
	if err != nil || apiKey == "" {
		t.Fatalf("failed to read OPENAI_API_KEY: %v", err)
	}
	serverKey, err := readSecretValue(config.SecretFile, "API_SERVER_KEY")
	if err != nil || serverKey == "" {
		t.Fatalf("failed to read API_SERVER_KEY: %v", err)
	}
	if apiKey != serverKey {
		t.Fatalf("key mismatch: open-webui=%q hermes=%q", apiKey, serverKey)
	}

	// Ensure secret token NEVER leaks into generated compose
	if strings.Contains(text, apiKey) {
		t.Fatalf("API key %q leaked into generated Compose file:\n%s", apiKey, text)
	}
	apiEnvPath := filepath.Join(config.SecretDir, "api-server.env")
	apiEnv, err := os.ReadFile(apiEnvPath)
	if err != nil {
		t.Fatalf("api-server.env missing: %v", err)
	}
	if string(apiEnv) != "API_SERVER_KEY="+apiKey+"\n" {
		t.Fatalf("api-server.env has unexpected contents: %q", apiEnv)
	}
	if info, err := os.Stat(apiEnvPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("api-server.env has unsafe mode: %v", err)
	}
}

func TestGeneratedAttachmentsContainOpenWebUIGoogleOAuth(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIPort = 8090
	config.OpenWebUIImage = "ghcr.io/open-webui/open-webui:main"
	config.OpenWebUIAuth = true
	config.OpenWebUIGoogleClientID = "test-client-id.apps.googleusercontent.com"
	config.OpenWebUIGoogleClientSecret = "test-client-secret-12345"
	config.OpenWebUIURL = "http://127.0.0.1:8090"
	config.OpenWebUIAllowedDomains = []string{"example.com", "company.org"}
	config.OpenWebUIAllowedEmails = []string{"admin@example.com", "user@company.org"}
	config.OpenWebUIEnableOAuthSignup = false

	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.SecretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("COPILOT_GITHUB_TOKEN=gho_testtoken\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)

	for _, expected := range []string{
		"ENABLE_OAUTH: \"True\"",
		"GOOGLE_CLIENT_ID: \"test-client-id.apps.googleusercontent.com\"",
		"WEBUI_URL: \"http://127.0.0.1:8090\"",
		"ENABLE_OAUTH_SIGNUP: \"False\"",
		"OAUTH_MERGE_ACCOUNTS_BY_EMAIL: \"True\"",
		"ENABLE_LOGIN_FORM: \"False\"",
		"OAUTH_ALLOWED_DOMAINS: \"example.com,company.org\"",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("generated Compose missing %q:\n%s", expected, text)
		}
	}

	// Secret MUST NOT be leaked in Compose
	if strings.Contains(text, "test-client-secret-12345") {
		t.Fatalf("Google client secret leaked into generated compose file:\n%s", text)
	}

	// Secret MUST be present in open-webui.env with 0600 permissions
	openWebUIEnvPath := filepath.Join(config.SecretDir, "open-webui.env")
	envData, err := os.ReadFile(openWebUIEnvPath)
	if err != nil {
		t.Fatalf("open-webui.env missing: %v", err)
	}
	envText := string(envData)
	if !strings.Contains(envText, "GOOGLE_CLIENT_SECRET=test-client-secret-12345") {
		t.Fatalf("open-webui.env missing GOOGLE_CLIENT_SECRET:\n%s", envText)
	}
	if info, err := os.Stat(openWebUIEnvPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("open-webui.env has unsafe permissions: %v", err)
	}

	// Verify database users and auth credentials were seeded
	dbPath := filepath.Join(config.OpenWebUIDataRoot, "webui.db")
	verifyCmd := exec.Command("python3", "-c", fmt.Sprintf(`import sqlite3
conn = sqlite3.connect(%q)
c = conn.cursor()
c.execute("SELECT email, role FROM \"user\" ORDER BY email")
rows = c.fetchall()
assert ("admin@example.com", "admin") in rows, f"missing admin: {rows}"
assert ("user@company.org", "user") in rows, f"missing user: {rows}"

c.execute("SELECT email, active FROM \"auth\" ORDER BY email")
auth_rows = c.fetchall()
assert ("admin@example.com", 1) in auth_rows, f"missing auth admin: {auth_rows}"
assert ("user@company.org", 1) in auth_rows, f"missing auth user: {auth_rows}"
conn.close()
`, dbPath))
	if output, err := verifyCmd.CombinedOutput(); err != nil {
		t.Fatalf("webui user seeding verification failed: %v\nOutput: %s", err, string(output))
	}
}

func TestOpenWebUILifecycleToggleOffAndReenable(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.SecretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("COPILOT_GITHUB_TOKEN=gho_testtoken\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. Initial deployment with Open WebUI enabled and Google OAuth
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIPort = 8090
	config.OpenWebUIImage = "ghcr.io/open-webui/open-webui:main"
	config.OpenWebUIAuth = true
	config.OpenWebUIGoogleClientID = "client-id-1"
	config.OpenWebUIGoogleClientSecret = "client-secret-1"
	config.OpenWebUIURL = "http://127.0.0.1:8090"
	config.OpenWebUIAllowedEmails = []string{"initial@example.com"}

	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "open-webui:") {
		t.Fatal("generated compose missing open-webui when enabled")
	}

	dbPath := filepath.Join(config.OpenWebUIDataRoot, "webui.db")
	verifyInitial := exec.Command("python3", "-c", fmt.Sprintf(`import sqlite3
conn = sqlite3.connect(%q)
c = conn.cursor()
c.execute("SELECT email, role FROM \"user\" WHERE email = 'initial@example.com'")
row = c.fetchone()
assert row == ("initial@example.com", "admin"), f"unexpected row: {row}"
conn.close()
`, dbPath))
	if output, err := verifyInitial.CombinedOutput(); err != nil {
		t.Fatalf("initial user verification failed: %v\nOutput: %s", err, string(output))
	}

	// 2. Turning feature off: host is empty
	configDisabled := config
	configDisabled.OpenWebUIHost = ""
	if err := GenerateAttachments(configDisabled); err != nil {
		t.Fatal(err)
	}
	dataDisabled, err := os.ReadFile(configDisabled.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(dataDisabled), "open-webui:") {
		t.Fatal("open-webui still present in generated compose when disabled")
	}
	// Verify persistent data directory remains intact
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("webui.db was unexpectedly deleted when feature turned off: %v", err)
	}

	// 3. Re-enabling with Google Sign In and updated allowed emails
	configReenabled := config
	configReenabled.OpenWebUIHost = "127.0.0.1"
	configReenabled.OpenWebUIAllowedEmails = []string{"newowner@example.com", "initial@example.com", "family@example.com"}
	if err := GenerateAttachments(configReenabled); err != nil {
		t.Fatal(err)
	}
	dataReenabled, err := os.ReadFile(configReenabled.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dataReenabled), "open-webui:") {
		t.Fatal("open-webui missing from compose when re-enabled")
	}

	// Verify database was reconciled: newowner is admin, initial and family are user
	verifyReenabled := exec.Command("python3", "-c", fmt.Sprintf(`import sqlite3
conn = sqlite3.connect(%q)
c = conn.cursor()
c.execute("SELECT email, role FROM \"user\" ORDER BY email")
rows = dict(c.fetchall())
assert rows.get("newowner@example.com") == "admin", f"newowner role incorrect: {rows}"
assert rows.get("initial@example.com") == "user", f"initial role incorrect: {rows}"
assert rows.get("family@example.com") == "user", f"family role incorrect: {rows}"
conn.close()
`, dbPath))
	if output, err := verifyReenabled.CombinedOutput(); err != nil {
		t.Fatalf("re-enabled user verification failed: %v\nOutput: %s", err, string(output))
	}
}

func TestGeneratedAttachmentsContainLochoHostForBothUIs(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.LochoHostEnabled = true
	config.LochoHostRoot = filepath.Join(runtimeRoot, "locho-host")
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
	config.LochoVersion = "9.9.9-test"
	config.LochoX8664SHA256 = strings.Repeat("a", 64)
	config.LochoARM64SHA256 = strings.Repeat("b", 64)
	config.WorkspaceUIHost = "127.0.0.1"
	config.WorkspaceUIAuthRequired = true
	config.WorkspaceUIPasswordHashFile = filepath.Join(runtimeRoot, "secrets", "workspace-ui-password.hash")
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIPort = 8090
	config.OpenWebUIAuth = true
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.SecretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("COPILOT_GITHUB_TOKEN=gho_testtoken\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	lochoConfig, err := os.ReadFile(config.LochoHostConfig)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"name = \"workspace-ui\"",
		"endpoint = \"127.0.0.1:8089\"",
		"name = \"open-webui\"",
		"endpoint = \"127.0.0.1:8090\"",
	} {
		if !strings.Contains(string(lochoConfig), expected) {
			t.Fatalf("Locho host config missing %q:\n%s", expected, lochoConfig)
		}
	}
	data, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{
		"locho-host:",
		"entrypoint: [\"sh\", \"-c\"]",
		"exec locho host --config",
		"target: /var/lib/openlia-locho-host",
		"LOCHO_STATE_DIR: /var/lib/openlia-locho-host/state",
		"- openlia-private",
		"depends_on:",
		"LOCHO_VERSION: \"9.9.9-test\"",
		"LOCHO_X86_64_SHA256: \"" + strings.Repeat("a", 64) + "\"",
		"LOCHO_AARCH64_SHA256: \"" + strings.Repeat("b", 64) + "\"",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("generated Compose missing %q:\n%s", expected, text)
		}
	}
	activeConfig := "[[services]]\nname = \"workspace-ui\"\ntype = \"tcp\"\nendpoint = \"172.30.0.2:8089\"\n\n[[services]]\nname = \"open-webui\"\ntype = \"tcp\"\nendpoint = \"172.30.0.3:8080\"\n"
	if err := os.WriteFile(config.LochoHostConfig, []byte(activeConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	preserved, err := os.ReadFile(config.LochoHostConfig)
	if err != nil || string(preserved) != activeConfig {
		t.Fatalf("active Locho host config was overwritten: %q, %v", preserved, err)
	}
}

func TestLochoHostRuntimeConfigIsValidTOML(t *testing.T) {
	contents := fmt.Sprintf(
		strings.ReplaceAll(lochoHostConfigFormat(8089, 8080), `\n`, "\n"),
		"172.30.0.2",
		"172.30.0.3",
	)
	if strings.Contains(contents, `\"`) {
		t.Fatalf("Locho host config contains escaped quotes:\n%s", contents)
	}

	var config struct {
		Services []struct {
			Name     string `toml:"name"`
			Type     string `toml:"type"`
			Endpoint string `toml:"endpoint"`
		} `toml:"services"`
	}
	if _, err := toml.Decode(contents, &config); err != nil {
		t.Fatalf("Locho host config is invalid TOML: %v\n%s", err, contents)
	}

	expected := []struct {
		name     string
		typeName string
		endpoint string
	}{
		{name: "workspace-ui", typeName: "tcp", endpoint: "172.30.0.2:8089"},
		{name: "open-webui", typeName: "tcp", endpoint: "172.30.0.3:8080"},
	}
	if len(config.Services) != len(expected) {
		t.Fatalf("Locho host config has %d services, want %d", len(config.Services), len(expected))
	}
	for i, service := range config.Services {
		want := expected[i]
		if service.Name != want.name || service.Type != want.typeName || service.Endpoint != want.endpoint {
			t.Errorf("service %d = {%q, %q, %q}, want {%q, %q, %q}", i, service.Name, service.Type, service.Endpoint, want.name, want.typeName, want.endpoint)
		}
	}
}

func TestGeneratedLochoComposeValidates(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker CLI is unavailable")
	}
	repo, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.GeneratedCompose = filepath.Join(t.TempDir(), "compose.generated.yaml")
	config.LochoHostEnabled = true
	config.LochoHostRoot = filepath.Join(runtimeRoot, "locho-host")
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
	config.LochoRelayConfig = filepath.Join(runtimeRoot, "locho", "relay.toml")
	config.LochoRelaySecrets = filepath.Join(runtimeRoot, "locho-relay-secrets", "relay.env")
	config.WorkspaceUIHost = "127.0.0.1"
	config.WorkspaceUIAuthRequired = true
	config.WorkspaceUIPasswordHashFile = filepath.Join(config.SecretDir, "workspace-ui-password.hash")
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIAuth = true
	if err := os.MkdirAll(config.SecretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.SecretFile, []byte("COPILOT_GITHUB_TOKEN=gho_testtoken\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(config.LochoRelayConfig), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.LochoRelayConfig, []byte("include_n0_relays = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(config.LochoRelaySecrets), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.LochoRelaySecrets, []byte("LOCHO_RELAY_TOKEN=test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	attachment := filepath.Join(config.LochoRoot, "laptop", "attachments.toml")
	if err := os.MkdirAll(filepath.Dir(attachment), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(attachment, []byte("host_id = \"laptop\"\nlisten_host = \"127.0.0.1\"\n[[services]]\ncapability = \"genai:http:capability\"\nlisten_port = 8088\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	if result, err := NewCompose(config, nil).Run(context.Background(), "config", "--quiet"); err != nil {
		t.Fatalf("generated Locho Compose is invalid: %v\n%s\n%s", err, result.Stdout, result.Stderr)
	}
}

func TestGeneratedAttachmentsDisableHermesOpenLiaBrowserToolset(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.ServiceRoles = map[string]string{"laptop.openlia-browser": "openlia-browser"}
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	attachment := filepath.Join(config.LochoRoot, "laptop", "attachments.toml")
	if err := os.MkdirAll(filepath.Dir(attachment), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(attachment, []byte("host_id = \"laptop\"\nlisten_host = \"127.0.0.1\"\n[[services]]\ncapability = \"openlia-browser:http:capability\"\nlisten_port = 8932\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.DataRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(config.DataRoot, "config.yaml")
	if err := os.WriteFile(configPath, []byte("browser:\n  backend: \"off\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{
		"tools:\n  tool_search:\n    enabled: off",
		"agent:\n  disabled_toolsets:\n    - browser",
		"url: \"http://locho-laptop:8932/mcp\"",
		"connect_timeout: 30",
		"timeout: 120",
		"tools:\n      include:",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("browser toolset policy is missing %q:\n%s", expected, data)
		}
	}
	for _, tool := range managedBrowserToolAllowlist {
		if !strings.Contains(text, "        - "+tool) {
			t.Fatalf("browser toolset policy is missing allowlisted tool %q:\n%s", tool, data)
		}
	}
	for _, excluded := range []string{"browser_evaluate", "browser_run_code_unsafe", "browser_request", "browser_console_messages"} {
		if strings.Contains(text, excluded) {
			t.Fatalf("browser toolset policy unexpectedly includes excluded tool %q:\n%s", excluded, data)
		}
	}
	if strings.Contains(text, "transport: \"sse\"") || strings.Contains(text, "OPENLIA_BROWSER_JOB") || strings.Contains(text, "OPENLIA_BROWSER_JOBS") {
		t.Fatalf("browser toolset was not disabled:\n%s", data)
	}
	config.ServiceRoles["laptop.openlia-browser"] = "unassigned"
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), managedBrowserPolicyStart) || strings.Contains(string(data), "disabled_toolsets:\n    - browser") {
		t.Fatalf("managed browser policy was not removed:\n%s", data)
	}
}

func TestBrowserPolicyRefusesUserAgentMapping(t *testing.T) {
	data := []byte("agent:\n  disabled_toolsets: [terminal]\n")
	if _, _, err := renderBrowserPolicy(data, true, "http://locho-laptop:8932"); err == nil {
		t.Fatal("browser policy overwrote a user-owned agent mapping")
	}
}

func TestWorkspaceGitProtectsSensitivePaths(t *testing.T) {
	for _, path := range []string{".env", "nested/auth.json", "logs/hermes.log", "cache/token", "private.key", "notes.md"} {
		want := path != "notes.md"
		if protectedWorkspacePath(path) != want {
			t.Fatalf("protectedWorkspacePath(%q) = %t, want %t", path, protectedWorkspacePath(path), want)
		}
	}
}

func TestUninstallAcceptsCanonicalizedTemporaryRootSymlink(t *testing.T) {
	repo := t.TempDir()
	root := filepath.Join(t.TempDir(), "openlia")
	config := testConfig(repo, filepath.Join(root, "runtime"))
	config.InstallRoot = root
	config.ProjectName = "test-project"
	config.NetworkName = "test-project-private"
	if err := os.MkdirAll(filepath.Join(root, "releases", "0.1.0"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "releases", "0.1.0"), filepath.Join(root, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.MetaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(config.ComposeFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteRuntimeMetadata(config, time.Now()); err != nil {
		t.Fatal(err)
	}
	result, err := Uninstall(context.Background(), config, NewCompose(config, &recordedRunner{}))
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "removed" {
		t.Fatalf("uninstall state = %q, want removed", result.State)
	}
	if _, err := os.Lstat(root); !os.IsNotExist(err) {
		t.Fatalf("installation root still exists, stat error = %v", err)
	}
}

func archiveNames(t *testing.T, path string) map[string]bool {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	decompressor, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(decompressor)
	result := map[string]bool{}
	for {
		header, err := reader.Next()
		if err != nil {
			break
		}
		result[strings.TrimSuffix(header.Name, "/")] = true
	}
	_ = decompressor.Close()
	_ = file.Close()
	return result
}

func TestPruneBackups(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	if err := os.MkdirAll(config.BackupRoot, 0o700); err != nil {
		t.Fatal(err)
	}

	baseTime := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
	// Create 7 backup archives with .json pairs spaced 1 minute apart
	for i := 1; i <= 7; i++ {
		archivePath := filepath.Join(config.BackupRoot, fmt.Sprintf("openlia-20260921T10000%dZ-%d.tar.gz.age", i, i))
		if err := os.WriteFile(archivePath, []byte(fmt.Sprintf("archive-%d", i)), 0o600); err != nil {
			t.Fatal(err)
		}
		jsonPath := archivePath + ".json"
		if err := os.WriteFile(jsonPath, []byte(fmt.Sprintf("meta-%d", i)), 0o600); err != nil {
			t.Fatal(err)
		}
		modTime := baseTime.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(archivePath, modTime, modTime); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(jsonPath, modTime, modTime); err != nil {
			t.Fatal(err)
		}
	}

	// Create 4 compose-generated files
	for i := 1; i <= 4; i++ {
		composePath := filepath.Join(config.BackupRoot, fmt.Sprintf("compose-generated-20260921T10000%dZ-%d", i, i))
		if err := os.WriteFile(composePath, []byte(fmt.Sprintf("compose-%d", i)), 0o600); err != nil {
			t.Fatal(err)
		}
		modTime := baseTime.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(composePath, modTime, modTime); err != nil {
			t.Fatal(err)
		}
	}

	// Prune keeping 3
	removed, err := PruneBackups(config, 3)
	if err != nil {
		t.Fatalf("PruneBackups failed: %v", err)
	}

	// 4 archives (1, 2, 3, 4) and 1 compose file (1) should be removed = 5 total
	if len(removed) != 5 {
		t.Fatalf("expected 5 removed files, got %d: %v", len(removed), removed)
	}

	// Verify archives 1..4 are gone, 5..7 remain
	for i := 1; i <= 4; i++ {
		archivePath := filepath.Join(config.BackupRoot, fmt.Sprintf("openlia-20260921T10000%dZ-%d.tar.gz.age", i, i))
		if _, err := os.Stat(archivePath); !os.IsNotExist(err) {
			t.Fatalf("expected archive %d to be deleted, but it exists", i)
		}
		if _, err := os.Stat(archivePath + ".json"); !os.IsNotExist(err) {
			t.Fatalf("expected metadata %d to be deleted, but it exists", i)
		}
	}
	for i := 5; i <= 7; i++ {
		archivePath := filepath.Join(config.BackupRoot, fmt.Sprintf("openlia-20260921T10000%dZ-%d.tar.gz.age", i, i))
		if _, err := os.Stat(archivePath); err != nil {
			t.Fatalf("expected archive %d to exist, but stat error: %v", i, err)
		}
		if _, err := os.Stat(archivePath + ".json"); err != nil {
			t.Fatalf("expected metadata %d to exist, but stat error: %v", i, err)
		}
	}

	// Verify compose-generated-1 is gone, 2..4 remain
	compose1 := filepath.Join(config.BackupRoot, "compose-generated-20260921T100001Z-1")
	if _, err := os.Stat(compose1); !os.IsNotExist(err) {
		t.Fatal("expected compose-generated-1 to be deleted")
	}
	for i := 2; i <= 4; i++ {
		composePath := filepath.Join(config.BackupRoot, fmt.Sprintf("compose-generated-20260921T10000%dZ-%d", i, i))
		if _, err := os.Stat(composePath); err != nil {
			t.Fatalf("expected compose file %d to exist: %v", i, err)
		}
	}
}

func TestLochoServiceRegistryAndRoleMapping(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	config.ServiceRoles = map[string]string{
		"laptop.openlia-browser": "openlia-browser",
		"laptop.ollama":          "openai-gateway",
	}
	attachmentDir := filepath.Join(config.LochoRoot, "laptop")
	if err := os.MkdirAll(attachmentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	attachmentContent := `host_id = "laptop"
listen_host = "0.0.0.0"

[[services]]
 capability = "openlia-browser:http:supersecrettoken1"
 listen_port = 8932

[[services]]
capability = "ollama:http:supersecrettoken2"
listen_port = 11434

[[services]]
capability = "genai:http:supersecrettoken3"
listen_port = 8765

[[services]]
capability = "ssh:tcp:supersecrettoken4"
listen_port = 2222
`
	if err := os.WriteFile(filepath.Join(attachmentDir, "attachments.toml"), []byte(attachmentContent), 0o600); err != nil {
		t.Fatal(err)
	}

	listResult, err := ListAttachments(config)
	if err != nil {
		t.Fatalf("ListAttachments failed: %v", err)
	}
	if len(listResult.Hosts) != 1 {
		t.Fatalf("expected 1 host, got %d", len(listResult.Hosts))
	}
	host := listResult.Hosts[0]
	if len(host.Services) != 4 {
		t.Fatalf("expected 4 services, got %d", len(host.Services))
	}

	roleMap := make(map[string]string)
	endpointMap := make(map[string]string)
	for _, svc := range host.Services {
		roleMap[svc.Name] = svc.Role
		endpointMap[svc.Name] = svc.Endpoint
	}
	if roleMap["openlia-browser"] != "openlia-browser" {
		t.Errorf("openlia-browser role = %q, want 'openlia-browser'", roleMap["openlia-browser"])
	}
	if roleMap["ollama"] != "openai-gateway" {
		t.Errorf("ollama role = %q, want 'openai-gateway'", roleMap["ollama"])
	}
	if roleMap["genai"] != "unassigned" {
		t.Errorf("genai role = %q, want 'unassigned'", roleMap["genai"])
	}
	if roleMap["ssh"] != "unassigned" {
		t.Errorf("ssh role = %q, want 'unassigned'", roleMap["ssh"])
	}

	if endpointMap["openlia-browser"] != "http://locho-laptop:8932" {
		t.Errorf("openlia-browser endpoint = %q, want 'http://locho-laptop:8932'", endpointMap["openlia-browser"])
	}
	if endpointMap["ollama"] != "http://locho-laptop:11434" {
		t.Errorf("ollama endpoint = %q, want 'http://locho-laptop:11434'", endpointMap["ollama"])
	}
	if endpointMap["ssh"] != "locho-laptop:2222" {
		t.Errorf("ssh endpoint = %q, want 'locho-laptop:2222'", endpointMap["ssh"])
	}

	if err := GenerateAttachments(config); err != nil {
		t.Fatalf("GenerateAttachments failed: %v", err)
	}

	// Verify services.json in DataRoot
	dataRegistryPath := filepath.Join(config.DataRoot, "services.json")
	dataRegistryBytes, err := os.ReadFile(dataRegistryPath)
	if err != nil {
		t.Fatalf("failed to read data services.json: %v", err)
	}
	var registry ServiceRegistry
	if err := json.Unmarshal(dataRegistryBytes, &registry); err != nil {
		t.Fatalf("failed to unmarshal services.json: %v", err)
	}
	if len(registry.Services) != 4 {
		t.Fatalf("services.json contains %d services, want 4", len(registry.Services))
	}
	if info, err := os.Stat(dataRegistryPath); err != nil {
		t.Fatalf("failed to stat data services.json: %v", err)
	} else if info.Mode().Perm() != 0o600 {
		t.Fatalf("services.json mode = %o, want 600", info.Mode().Perm())
	}

	// Ensure secret tokens NEVER leak into registry or compose file
	for _, forbidden := range []string{"supersecrettoken1", "supersecrettoken2", "supersecrettoken3", "supersecrettoken4"} {
		if strings.Contains(string(dataRegistryBytes), forbidden) {
			t.Fatalf("services.json leaked forbidden token %q", forbidden)
		}
	}

	// Verify generated Compose
	composeBytes, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatalf("failed to read generated compose: %v", err)
	}
	composeText := string(composeBytes)
	for _, forbidden := range []string{"supersecrettoken1", "supersecrettoken2", "supersecrettoken3", "supersecrettoken4"} {
		if strings.Contains(composeText, forbidden) {
			t.Fatalf("compose leaked forbidden token %q", forbidden)
		}
	}

	for _, expected := range []string{
		"OPENLIA_BROWSER_MCP_URL: \"http://locho-laptop:8932\"",
		"OPENLIA_SERVICE_LAPTOP_OPENLIA_BROWSER_URL: \"http://locho-laptop:8932\"",
		"OPENLIA_SERVICE_LAPTOP_OLLAMA_URL: \"http://locho-laptop:11434\"",
	} {
		if !strings.Contains(composeText, expected) {
			t.Errorf("generated Compose missing %q:\n%s", expected, composeText)
		}
	}
	if strings.Contains(composeText, "OPENAI_BASE_URL") {
		t.Fatalf("generated Compose must not configure OPENAI_BASE_URL:\n%s", composeText)
	}
}

func TestReconcileAttachments_WorkspaceUIPublicOrigin(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	config.WorkspaceUIHost = "127.0.0.1"
	config.WorkspaceUIPort = 8089
	config.WorkspaceUIPublicOrigin = "https://workspace.example.test"

	if err := EnsureDir(config.LochoRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := generateAttachmentsFile(config); err != nil {
		t.Fatalf("generateAttachmentsFile failed: %v", err)
	}
	composeBytes, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatalf("failed to read generated compose: %v", err)
	}
	composeText := string(composeBytes)
	expectedHermesEnv := "OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN: \"https://workspace.example.test\""
	if !strings.Contains(composeText, expectedHermesEnv) {
		t.Fatalf("compose missing Hermes OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN:\n%s", composeText)
	}
}
