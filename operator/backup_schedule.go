package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

type BackupScheduleResult struct {
	OK        bool   `json:"ok"`
	Action    string `json:"action"`
	Enabled   bool   `json:"enabled"`
	Schedule  string `json:"schedule"`
	Timezone  string `json:"timezone"`
	Installed string `json:"installed,omitempty"`
}

type backupScheduleState struct {
	Schema          int    `json:"schema"`
	InstalledAt     string `json:"installed_at"`
	LastAttemptSlot string `json:"last_attempt_slot,omitempty"`
	LastResult      string `json:"last_result,omitempty"`
}

func nextBackupSchedule(expression, timezone string, after time.Time) (time.Time, error) {
	if timezone == "" {
		timezone = "Asia/Ho_Chi_Minh"
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, err
	}
	schedule, err := cron.ParseStandard(expression)
	if err != nil {
		return time.Time{}, err
	}
	return schedule.Next(after.In(location)), nil
}

func BackupScheduleTick(ctx context.Context, config Config, now time.Time) (BackupResult, bool, error) {
	if err := config.ValidatePaths(); err != nil {
		return BackupResult{}, false, err
	}
	if !config.BackupScheduleEnabled {
		return BackupResult{}, false, nil
	}
	if config.BackupRecipient == "" {
		return BackupResult{}, false, fmt.Errorf("backup encryption recipient is not configured")
	}
	location, err := time.LoadLocation(config.Timezone)
	if err != nil {
		return BackupResult{}, false, err
	}
	schedule, err := cron.ParseStandard(config.BackupSchedule)
	if err != nil {
		return BackupResult{}, false, err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return BackupResult{}, false, err
	}
	statePath := filepath.Join(config.MetaRoot, "backup-schedule-state.json")
	state := backupScheduleState{Schema: 1, InstalledAt: utcTimestamp(now)}
	if data, readErr := os.ReadFile(statePath); readErr == nil {
		if err := json.Unmarshal(data, &state); err != nil || state.Schema != 1 {
			return BackupResult{}, false, fmt.Errorf("backup schedule state is invalid")
		}
	} else if !os.IsNotExist(readErr) {
		return BackupResult{}, false, readErr
	}
	start, err := time.Parse(time.RFC3339Nano, state.InstalledAt)
	if err != nil {
		start = now
	}
	if state.LastAttemptSlot != "" {
		if parsed, parseErr := time.Parse(time.RFC3339Nano, state.LastAttemptSlot); parseErr == nil {
			start = parsed
		}
	}
	start = start.In(location)
	current := now.In(location).Truncate(time.Minute)
	var due time.Time
	for count := 0; count < 100000; count++ {
		next := schedule.Next(start)
		if next.After(current) {
			break
		}
		due = next
		start = next
	}
	if due.IsZero() {
		return BackupResult{}, false, nil
	}
	state.LastAttemptSlot = due.UTC().Format(time.RFC3339Nano)
	stateData, _ := json.Marshal(state)
	if err := AtomicWriteFile(statePath, append(stateData, '\n'), 0o600); err != nil {
		return BackupResult{}, false, err
	}
	result, err := CreateScheduledBackup(ctx, config, "scheduled", now)
	if err == nil {
		result.Destinations, err = PushBackup(ctx, config, result, now)
	}
	state.LastResult = "ok"
	if err != nil {
		state.LastResult = "failed"
	} else if result.RetentionError != "" {
		state.LastResult = "partial"
	}
	stateData, _ = json.Marshal(state)
	if writeErr := AtomicWriteFile(statePath, append(stateData, '\n'), 0o600); writeErr != nil && err == nil {
		err = writeErr
	}
	changeStatus := "ok"
	if err != nil || result.RetentionError != "" {
		changeStatus = "partial"
	}
	if recordErr := RecordChange(config, "backup", changeStatus, result.Archive, "reason=scheduled", now); recordErr != nil && err == nil {
		err = recordErr
	}
	return result, true, err
}

func InstallBackupSchedule(config Config, now time.Time) (BackupScheduleResult, error) {
	return InstallBackupScheduleContext(context.Background(), config, now)
}

func InstallBackupScheduleContext(ctx context.Context, config Config, now time.Time) (BackupScheduleResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return BackupScheduleResult{}, err
	}
	if config.BackupRecipient == "" {
		return BackupScheduleResult{}, fmt.Errorf("backup encryption recipient is required before enabling the schedule")
	}
	if !config.BackupScheduleEnabled {
		return RemoveBackupScheduleContext(ctx, config)
	}
	if _, err := cron.ParseStandard(config.BackupSchedule); err != nil {
		return BackupScheduleResult{}, fmt.Errorf("invalid backup schedule: %w", err)
	}
	for _, destination := range config.BackupDestinations {
		if destination.Type != "rsync" {
			continue
		}
		if destination.IdentityFile != "" {
			info, err := os.Stat(destination.IdentityFile)
			if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
				return BackupScheduleResult{}, fmt.Errorf("rsync identity for destination %s must be a protected regular file", destination.Name)
			}
		}
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return BackupScheduleResult{}, err
	}
	if err := generateAttachmentsFile(config); err != nil {
		return BackupScheduleResult{}, fmt.Errorf("generate backup scheduler mounts: %w", err)
	}
	runtimeConfig := scheduleRuntimeConfig(config)
	configData, err := json.Marshal(runtimeConfig)
	if err != nil {
		return BackupScheduleResult{}, err
	}
	configPath := filepath.Join(config.MetaRoot, "backup-schedule-config.json")
	if err := AtomicWriteFile(configPath, append(configData, '\n'), 0o600); err != nil {
		return BackupScheduleResult{}, err
	}
	statePath := filepath.Join(config.MetaRoot, "backup-schedule-state.json")
	if err := ensureBackupScheduleState(statePath, now); err != nil {
		return BackupScheduleResult{}, err
	}
	compose := NewCompose(config, nil)
	if _, err := compose.Run(ctx, "--profile", "backup", "build", "backup-scheduler"); err != nil {
		return BackupScheduleResult{}, fmt.Errorf("build backup scheduler: %w", err)
	}
	if _, err := compose.Run(ctx, "--profile", "backup", "up", "-d", "--no-deps", "--force-recreate", "backup-scheduler"); err != nil {
		return BackupScheduleResult{}, fmt.Errorf("start backup scheduler: %w", err)
	}
	if err := waitForBackupScheduler(ctx, compose); err != nil {
		return BackupScheduleResult{}, err
	}
	return BackupScheduleResult{OK: true, Action: "schedule-install", Enabled: true, Schedule: config.BackupSchedule, Timezone: config.Timezone, Installed: utcTimestamp(now)}, nil
}

func ensureBackupScheduleState(statePath string, now time.Time) error {
	if _, err := os.Stat(statePath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	state := backupScheduleState{Schema: 1, InstalledAt: utcTimestamp(now)}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return AtomicWriteFile(statePath, append(data, '\n'), 0o600)
}

func RemoveBackupSchedule(config Config, composers ...Compose) (BackupScheduleResult, error) {
	return RemoveBackupScheduleContext(context.Background(), config, composers...)
}

func RemoveBackupScheduleContext(ctx context.Context, config Config, composers ...Compose) (BackupScheduleResult, error) {
	if !config.BackupScheduleEnabled {
		if err := generateAttachmentsFile(config); err != nil {
			return BackupScheduleResult{}, fmt.Errorf("remove backup scheduler mounts: %w", err)
		}
	}
	if _, err := os.Stat(config.ComposeFile); err == nil {
		compose := NewCompose(config, nil)
		if len(composers) > 0 {
			compose = composers[0]
		}
		if _, err := compose.Run(ctx, "--profile", "backup", "rm", "-sf", "backup-scheduler"); err != nil {
			return BackupScheduleResult{}, fmt.Errorf("remove backup scheduler: %w", err)
		}
	}
	return BackupScheduleResult{OK: true, Action: "schedule-remove", Enabled: false, Schedule: config.BackupSchedule, Timezone: config.Timezone}, nil
}

func waitForBackupScheduler(ctx context.Context, compose Compose) error {
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		result, err := compose.Run(ctx, "--profile", "backup", "ps", "--format", "{{.State}} {{.Health}}", "backup-scheduler")
		if err == nil {
			status := strings.TrimSpace(string(result.Stdout))
			fields := strings.Fields(status)
			if len(fields) == 2 && fields[0] == "running" && fields[1] == "healthy" {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			if err != nil {
				return fmt.Errorf("backup scheduler did not become healthy: %w", err)
			}
			return fmt.Errorf("backup scheduler did not become healthy: %s", strings.TrimSpace(string(result.Stdout)))
		case <-ticker.C:
		}
	}
}

func backupScheduleInstalled(config Config) bool {
	if !config.BackupScheduleEnabled {
		return false
	}
	compose := NewCompose(config, nil)
	result, err := compose.Run(context.Background(), "--profile", "backup", "ps", "--services", "--filter", "status=running")
	return err == nil && containsService(result.Stdout, "backup-scheduler")
}

func scheduleRuntimeConfig(config Config) Config {
	config.BackupDestinations = append([]BackupDestination(nil), config.BackupDestinations...)
	config.BackupNamespaceRoot = config.InstallRoot
	config.RepositoryRoot = "/opt/openlia/current"
	config.RuntimeRoot = "/runtime"
	config.InstallRoot = "/opt/openlia"
	config.ComposeFile = "/opt/openlia/current/docker/compose.yaml"
	config.ComposeProjectDir = "/opt/openlia/current/docker"
	config.GeneratedCompose = "/opt/openlia/current/docker/compose.generated.yaml"
	config.DataRoot = "/runtime/hermes"
	config.SystemSkillsRoot = "/runtime/system-skills"
	config.LochoRoot = "/runtime/locho"
	if config.LochoRelayConfig != "" {
		config.LochoRelayConfig = "/runtime/locho/relay.toml"
	}
	if config.LochoRelaySecrets != "" {
		config.LochoRelaySecrets = "/runtime/locho-relay-secrets/relay.env"
	}
	config.SecretDir = "/runtime/secrets"
	config.SecretFile = "/runtime/secrets/hermes.env"
	config.BackupRoot = "/runtime/backups"
	config.MetaRoot = "/runtime/meta"
	config.StateFile = "/runtime/state"
	config.LochoHostRoot = "/runtime/locho-host"
	config.LochoHostConfig = "/runtime/locho-host/locho.toml"
	config.LochoHostStateRoot = "/runtime/locho-host/state"
	config.WorkspaceUIPasswordHashFile = "/runtime/secrets/workspace-ui-password.hash"
	config.OperatorConfigFile = "/etc/openlia/backup-schedule-config.json"
	for index := range config.BackupDestinations {
		if config.BackupDestinations[index].IdentityFile != "" {
			config.BackupDestinations[index].IdentityFile = "/run/openlia-destinations/" + config.BackupDestinations[index].Name
		}
		if config.BackupDestinations[index].CredentialsFile != "" {
			config.BackupDestinations[index].CredentialsFile = "/tmp/openlia-backup/" + config.BackupDestinations[index].Name + "/credentials"
		}
	}
	return config
}
