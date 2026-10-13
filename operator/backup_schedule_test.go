package operator

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type backupSchedulerStatusRunner struct {
	calls int
}

func (runner *backupSchedulerStatusRunner) Run(_ context.Context, _ string, args ...string) (CommandResult, error) {
	if len(args) > 0 && args[len(args)-1] == "backup-scheduler" {
		runner.calls++
		if runner.calls < 2 {
			return CommandResult{Stdout: []byte("running starting\n")}, nil
		}
		return CommandResult{Stdout: []byte("running healthy\n")}, nil
	}
	return CommandResult{}, nil
}

func TestScheduleRuntimeConfigUsesContainerPaths(t *testing.T) {
	config := Config{
		InstallRoot: filepath.Join("/srv", "openlia"),
		RuntimeRoot: filepath.Join("/srv", "openlia", "runtime"),
		BackupDestinations: []BackupDestination{{
			Name: "nas", Type: "rsync", IdentityFile: "/srv/keys/openlia",
		}},
	}
	runtimeConfig := scheduleRuntimeConfig(config)
	if runtimeConfig.RuntimeRoot != "/runtime" || runtimeConfig.BackupRoot != "/runtime/backups" || runtimeConfig.MetaRoot != "/runtime/meta" {
		t.Fatalf("runtime paths = %#v", runtimeConfig)
	}
	if runtimeConfig.BackupNamespaceRoot != filepath.Join("/srv", "openlia") {
		t.Fatalf("namespace root = %q", runtimeConfig.BackupNamespaceRoot)
	}
	if got := runtimeConfig.BackupDestinations[0].IdentityFile; got != "/run/openlia-destinations/nas" {
		t.Fatalf("identity path = %q", got)
	}
}

func TestScheduleRuntimeConfigProjectsOptionalRuntimePaths(t *testing.T) {
	runtimeConfig := scheduleRuntimeConfig(testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime")))
	runtimeConfig.WorkspaceUIHost = "127.0.0.1"
	runtimeConfig.WorkspaceUIAuthRequired = true
	runtimeConfig.OpenWebUIHost = "127.0.0.1"
	runtimeConfig.OpenWebUIAuth = true
	runtimeConfig.LochoHostEnabled = true
	if err := runtimeConfig.ValidatePaths(); err != nil {
		t.Fatalf("projected scheduler config is invalid: %v", err)
	}
	for name, path := range map[string]string{
		"Open WebUI":            runtimeConfig.OpenWebUIDataRoot,
		"Locho root":            runtimeConfig.LochoHostRoot,
		"Locho config":          runtimeConfig.LochoHostConfig,
		"Locho state":           runtimeConfig.LochoHostStateRoot,
		"Workspace UI password": runtimeConfig.WorkspaceUIPasswordHashFile,
	} {
		if !within(path, "/runtime") {
			t.Errorf("%s path = %q, want path below /runtime", name, path)
		}
	}
}

func TestScheduleRuntimeConfigProjectsWriterCredentialsIntoTmpfs(t *testing.T) {
	config := Config{
		InstallRoot: filepath.Join("/srv", "openlia"),
		BackupDestinations: []BackupDestination{{
			Name: "archive", Type: "s3", CredentialsFile: "/srv/openlia/runtime/backup-credentials/archive/credentials",
		}},
	}
	runtimeConfig := scheduleRuntimeConfig(config)
	if got := runtimeConfig.BackupDestinations[0].CredentialsFile; got != "/tmp/openlia-backup/archive/credentials" {
		t.Fatalf("runtime credential path = %q", got)
	}
	if got := config.BackupDestinations[0].CredentialsFile; got != "/srv/openlia/runtime/backup-credentials/archive/credentials" {
		t.Fatalf("host credential path was mutated = %q", got)
	}
}

func TestBackupSchedulerCredentialVolumesUseCredentialDirectories(t *testing.T) {
	config := Config{BackupScheduleEnabled: true, BackupDestinations: []BackupDestination{{
		Name: "archive", Type: "s3", CredentialsFile: "/srv/openlia/runtime/backup-credentials/archive/credentials",
	}}}
	volumes := backupSchedulerCredentialVolumes(config)
	if len(volumes) != 1 || volumes[0].source != `"/srv/openlia/runtime/backup-credentials/archive"` || volumes[0].target != "/run/openlia-destinations/archive" {
		t.Fatalf("credential volumes = %#v", volumes)
	}
}

func TestBackupSchedulerIdentityVolumesFollowScheduleState(t *testing.T) {
	config := Config{BackupScheduleEnabled: true, BackupDestinations: []BackupDestination{{Name: "nas", Type: "rsync", IdentityFile: "/srv/keys/openlia"}}}
	if got := backupSchedulerIdentityVolumes(config); len(got) != 1 || got[0].target != "/run/openlia-destinations/nas" {
		t.Fatalf("enabled scheduler volumes = %#v", got)
	}
	config.BackupScheduleEnabled = false
	if got := backupSchedulerIdentityVolumes(config); len(got) != 0 {
		t.Fatalf("disabled scheduler volumes = %#v, want none", got)
	}
}

func TestWaitForBackupSchedulerWaitsForHealthyState(t *testing.T) {
	runner := &backupSchedulerStatusRunner{}
	compose := NewCompose(Config{}, runner)
	if err := waitForBackupScheduler(context.Background(), compose); err != nil {
		t.Fatal(err)
	}
	if runner.calls != 2 {
		t.Fatalf("status calls = %d, want 2", runner.calls)
	}
}

func TestWaitForBackupSchedulerRejectsUnhealthyState(t *testing.T) {
	runner := &backupSchedulerUnhealthyStatusRunner{}
	compose := NewCompose(Config{}, runner)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	err := waitForBackupScheduler(ctx, compose)
	if err == nil {
		t.Fatal("waitForBackupScheduler accepted an unhealthy scheduler")
	}
}

type backupSchedulerUnhealthyStatusRunner struct{}

func (runner *backupSchedulerUnhealthyStatusRunner) Run(_ context.Context, _ string, args ...string) (CommandResult, error) {
	if len(args) > 0 && args[len(args)-1] == "backup-scheduler" {
		return CommandResult{Stdout: []byte("running unhealthy\n")}, nil
	}
	return CommandResult{}, nil
}

func TestEnsureBackupScheduleStateInitializesOnlyWhenMissing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backup-schedule-state.json")
	now := time.Date(2026, time.October, 1, 4, 20, 0, 0, time.UTC)
	if err := ensureBackupScheduleState(path, now); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureBackupScheduleState(path, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state backupScheduleState
	if err := json.Unmarshal(first, &state); err != nil || state.InstalledAt != utcTimestamp(now) {
		t.Fatalf("initial state = %s", first)
	}
	if string(second) != string(first) {
		t.Fatalf("existing state changed: before=%s after=%s", first, second)
	}
}
