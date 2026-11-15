package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWriteAndLoadOperatorConfig(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.BackupRecipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
	config.BackupSchedule = "0 3 * * *"
	config.BackupScheduleEnabled = true
	config.OutputLanguage = "vi"

	if err := WriteOperatorConfig(config); err != nil {
		t.Fatalf("WriteOperatorConfig failed: %v", err)
	}
	cfgPath := OperatorConfigPath(config.MetaRoot)
	info, err := os.Stat(cfgPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("operator-config.json stat = %v, err = %v", info, err)
	}

	t.Setenv("OPENLIA_OPERATOR_CONFIG_FILE", "")
	t.Setenv("OPENLIA_PROJECT_NAME", "")
	t.Setenv("OPENLIA_RUNTIME_ROOT", runtimeRoot)
	t.Setenv("OPENLIA_REPO_ROOT", repo)

	loaded, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig from persisted operator-config.json failed: %v", err)
	}
	if loaded.ProjectName != config.ProjectName || loaded.BackupRecipient != config.BackupRecipient || loaded.OutputLanguage != "vi" {
		t.Fatalf("loaded config mismatch: %+v", loaded)
	}
}

func TestReadConsolidationRecoversStalePID(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := ConsolidationRecord{
		Schema:    1,
		Action:    "deploy",
		Status:    ConsolidationStatusRunning,
		Phase:     "compose-deploy",
		PID:       99999999,
		StartedAt: "2026-11-14T00:00:00Z",
		UpdatedAt: "2026-11-14T00:00:00Z",
	}
	if err := writeConsolidationRecord(config, stale); err != nil {
		t.Fatal(err)
	}
	got, err := ReadConsolidation(config)
	if err != nil || got == nil {
		t.Fatalf("ReadConsolidation = %+v, err = %v", got, err)
	}
	if got.Status != ConsolidationStatusFailed || !strings.Contains(got.Error, "terminated unexpectedly") {
		t.Fatalf("stale consolidation was not marked failed: %+v", got)
	}
}

func TestStartConsolidationRejectsWhileBusy(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	active := ConsolidationRecord{
		Schema:    1,
		Action:    "deploy",
		Status:    ConsolidationStatusRunning,
		Phase:     "compose-deploy",
		PID:       os.Getpid(),
		StartedAt: "2026-11-14T00:00:00Z",
		UpdatedAt: "2026-11-14T00:00:00Z",
	}
	if err := writeConsolidationRecord(config, active); err != nil {
		t.Fatal(err)
	}
	_, err := StartConsolidation(context.Background(), config, "restart", []string{"--component", "all"}, time.Now().UTC())
	if err == nil || !strings.Contains(err.Error(), "another OpenLia consolidation (deploy, phase=compose-deploy) is already running") {
		t.Fatalf("expected busy rejection error, got: %v", err)
	}
}

func TestHealthcheckCachedUsesSnapshotAndAttachesConsolidation(t *testing.T) {
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
	if err := WriteState(config, stateRunning); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 14, 7, 0, 0, 0, time.UTC)
	snap := HealthResult{
		Schema:       1,
		OK:           true,
		State:        stateRunning,
		Checks:       []RuntimeCheck{{Name: "service:hermes", OK: true, Detail: "running"}},
		Secrets:      "redacted",
		Capabilities: "redacted",
	}
	if err := WriteHealthSnapshot(config, snap, now); err != nil {
		t.Fatalf("WriteHealthSnapshot failed: %v", err)
	}
	cons := ConsolidationRecord{
		Schema:      1,
		Action:      "deploy",
		Status:      ConsolidationStatusSucceeded,
		Phase:       "completed",
		StartedAt:   utcTimestamp(now),
		UpdatedAt:   utcTimestamp(now),
		CompletedAt: utcTimestamp(now),
	}
	if err := writeConsolidationRecord(config, cons); err != nil {
		t.Fatal(err)
	}

	// Runner that fails if invoked — proving cached healthcheck does not shell out to Docker.
	runner := &recordedRunner{}
	got, err := HealthcheckCached(context.Background(), config, NewCompose(config, runner), true, false, true)
	if err != nil {
		t.Fatalf("HealthcheckCached failed: %v", err)
	}
	if !got.Cached || got.CachedAt == "" || !got.OK || got.State != stateRunning {
		t.Fatalf("unexpected cached health result: %+v", got)
	}
	if got.Consolidation == nil || got.Consolidation.Action != "deploy" || got.Consolidation.Status != ConsolidationStatusSucceeded {
		t.Fatalf("expected attached consolidation, got %+v", got.Consolidation)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("cached healthcheck should not invoke Docker/Compose, got calls: %v", runner.calls)
	}
}

func TestReconcileTickSelfHealsStoppedServicesAndStaleLochoHost(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.LochoHostEnabled = true
	config.LochoHostRoot = filepath.Join(runtimeRoot, "locho-host")
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
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
	if err := os.WriteFile(config.SecretFile, []byte("COPILOT_GITHUB_TOKEN=gho_testtoken123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateRunning); err != nil {
		t.Fatal(err)
	}

	// Only hermes is running; locho-host is stopped/stale.
	runner := &lochoLifecycleRunner{
		runningServices: "hermes\n",
		stale:           true,
	}
	res, err := ReconcileTick(context.Background(), config, NewCompose(config, runner), time.Now().UTC())
	if err != nil {
		t.Fatalf("ReconcileTick failed: %v", err)
	}
	if len(res.RestartedServices) != 1 || res.RestartedServices[0] != "locho-host" {
		t.Fatalf("RestartedServices = %v, want [locho-host]", res.RestartedServices)
	}
	if !res.LochoHostHealed {
		t.Fatalf("expected LochoHostHealed = true, got %+v", res)
	}
	snap, err := ReadHealthSnapshot(config, true)
	if err != nil {
		t.Fatalf("expected health.json to be written after ReconcileTick, err=%v", err)
	}
	_ = snap
}

func TestStartAndExecuteDeployConsolidationStagesIncomingSecretsAndAttachments(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	for _, dir := range []string{
		filepath.Join(repo, "profile"),
		filepath.Join(repo, "docker"),
		config.DataRoot,
		config.BackupRoot,
		config.MetaRoot,
		config.LochoRoot,
		config.SecretDir,
		filepath.Join(config.MetaRoot, ".incoming", "attachments"),
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(repo, "profile", "config.yaml"), []byte("model: gpt-5.6-luna\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "profile", "AGENTS.md"), []byte("# Agents\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "profile", "SOUL.md"), []byte("# Soul\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateStopped); err != nil {
		t.Fatal(err)
	}

	incomingSecret := filepath.Join(config.MetaRoot, ".incoming", "secrets.env")
	if err := os.WriteFile(incomingSecret, []byte("COPILOT_GITHUB_TOKEN=gho_validtoken12345\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	incomingAttachment := filepath.Join(config.MetaRoot, ".incoming", "attachments", "laptop.toml")
	attachmentContent := "host_id = \"host-1\"\nlisten_host = \"0.0.0.0\"\n\n[[services]]\ncapability = \"ollama:http:cap123\"\nlisten_port = 11434\n"
	if err := os.WriteFile(incomingAttachment, []byte(attachmentContent), 0o600); err != nil {
		t.Fatal(err)
	}

	bin := t.TempDir()
	docker := filepath.Join(bin, "docker")
	dockerScript := "#!/bin/sh\n" +
		"case \"$*\" in\n" +
		"  *\"config --services\"*) printf 'hermes\\nlocho-laptop\\n' ;;\n" +
		"  *\"info\"*) printf 'linux\\n' ;;\n" +
		"esac\n"
	if err := os.WriteFile(docker, []byte(dockerScript), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	now := time.Now().UTC()
	startRes, err := StartConsolidation(context.Background(), config, "deploy", []string{"--component", "all"}, now)
	if err != nil {
		t.Fatalf("StartConsolidation failed: %v", err)
	}
	if !startRes.OK || startRes.Action != "deploy" {
		t.Fatalf("unexpected StartConsolidation result: %+v", startRes)
	}

	// Poll until the in-process test worker finishes.
	deadline := time.Now().Add(5 * time.Second)
	var finalRecord *ConsolidationRecord
	for time.Now().Before(deadline) {
		rec, readErr := ReadConsolidation(config)
		if readErr == nil && rec != nil && (rec.Status == ConsolidationStatusSucceeded || rec.Status == ConsolidationStatusFailed) {
			finalRecord = rec
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if finalRecord == nil || finalRecord.Status != ConsolidationStatusSucceeded {
		t.Fatalf("consolidation did not succeed: %+v", finalRecord)
	}

	// Verify incoming secret and attachment were staged into their final locations and removed from .incoming.
	if _, err := os.Stat(incomingSecret); !os.IsNotExist(err) {
		t.Fatalf("incoming secret was not cleaned up: %v", err)
	}
	secretBytes, err := os.ReadFile(config.SecretFile)
	if err != nil || !strings.Contains(string(secretBytes), "COPILOT_GITHUB_TOKEN=gho_validtoken12345") {
		t.Fatalf("SecretFile not updated: err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(config.LochoRoot, "laptop", "attachments.toml")); err != nil {
		t.Fatalf("laptop attachments.toml not staged: %v", err)
	}

	// Verify `reconcile --status --json` CLI output.
	var stdout, stderr bytes.Buffer
	t.Setenv("OPENLIA_OPERATOR_CONFIG_FILE", OperatorConfigPath(config.MetaRoot))
	if code := Run([]string{"reconcile", "--status", "--json"}, strings.NewReader(""), &stdout, &stderr); code != ExitOK {
		t.Fatalf("reconcile --status exit code = %d, stderr = %s", code, stderr.String())
	}
	var statusPayload ConsolidationRecord
	if err := json.Unmarshal(stdout.Bytes(), &statusPayload); err != nil || statusPayload.Action != "deploy" || statusPayload.Status != ConsolidationStatusSucceeded {
		t.Fatalf("reconcile --status payload = %+v, err = %v", statusPayload, err)
	}
}

func TestConsolidationLogCaptureAndFailureLogTail(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	for _, dir := range []string{config.DataRoot, config.BackupRoot, config.MetaRoot, config.LochoRoot, config.SecretDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := WriteOperatorConfig(config); err != nil {
		t.Fatal(err)
	}

	// Execute a backup-create consolidation without BackupRecipient so it fails and populates LogTail.
	now := time.Date(2026, 11, 14, 8, 0, 0, 0, time.UTC)
	_ = ExecuteConsolidation(context.Background(), config, "backup-create", nil, now)

	rec, err := ReadConsolidation(config)
	if err != nil || rec == nil {
		t.Fatalf("ReadConsolidation = %+v, err = %v", rec, err)
	}
	if rec.Status != ConsolidationStatusFailed || rec.LogTail == "" {
		t.Fatalf("expected failed consolidation with LogTail, got: %+v", rec)
	}
	logText, err := ReadConsolidationLog(config)
	if err != nil || !strings.Contains(logText, "phase=backup-create") || !strings.Contains(logText, "error=backup encryption recipient is required") {
		t.Fatalf("ReadConsolidationLog = %q, err = %v", logText, err)
	}
	logInfo, err := os.Stat(ConsolidationLogPath(config))
	if err != nil || logInfo.Mode().Perm() != 0o600 {
		t.Fatalf("consolidation log mode = %v, err = %v", logInfo, err)
	}
}

func TestRunReconcilerDaemonSingletonAndAutoExitWhenStopped(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	for _, dir := range []string{config.DataRoot, config.BackupRoot, config.MetaRoot, config.LochoRoot, config.SecretDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(config.ComposeFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteState(config, stateRunning); err != nil {
		t.Fatal(err)
	}
	if err := WriteOperatorConfig(config); err != nil {
		t.Fatal(err)
	}

	bin := t.TempDir()
	docker := filepath.Join(bin, "docker")
	dockerScript := "#!/bin/sh\n" +
		"case \"$*\" in\n" +
		"  *\"config --services\"*) printf 'hermes\\n' ;;\n" +
		"  *\"ps --services --filter status=running\"*) printf 'hermes\\n' ;;\n" +
		"  *\"info\"*) printf 'linux\\n' ;;\n" +
		"esac\n"
	if err := os.WriteFile(docker, []byte(dockerScript), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- RunReconcilerDaemon(ctx, config, 40*time.Millisecond)
	}()

	// Wait for reconciler.pid to appear.
	pidPath := ReconcilerPIDPath(config.MetaRoot)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(pidPath); err == nil {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if _, err := os.Stat(pidPath); err != nil {
		t.Fatalf("reconciler.pid was not created: %v", err)
	}

	// Starting a second daemon instance while the first holds reconciler.lock must return nil immediately.
	if err := RunReconcilerDaemon(ctx, config, 40*time.Millisecond); err != nil {
		t.Fatalf("second RunReconcilerDaemon returned error: %v", err)
	}

	// Flip stack-state to stopped; the running daemon must exit cleanly on its next tick.
	if err := WriteState(config, stateStopped); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RunReconcilerDaemon exited with error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RunReconcilerDaemon did not exit after stack-state changed to stopped")
	}
	if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
		t.Fatalf("reconciler.pid was not removed on exit: %v", err)
	}
}
