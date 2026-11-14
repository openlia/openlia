package operator

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Run is the standalone Go operator entrypoint.
func Run(args []string, input io.Reader, output, errorOutput io.Writer) int {
	return RunContext(context.Background(), args, input, output, errorOutput)
}

// RunContext is the cancellable entrypoint used by the host CLI.
func RunContext(ctx context.Context, args []string, input io.Reader, output, errorOutput io.Writer) int {
	jsonOutput, args := removeFlag(args, "--json")
	if len(args) == 0 || contains(args, "--help") || contains(args, "-h") {
		writeUsage(output)
		return ExitOK
	}
	config, err := LoadConfig()
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, err)
	}
	command := args[0]
	args = args[1:]
	now := time.Now().UTC()

	switch command {
	case "bootstrap":
		checkOnly, args := removeFlag(args, "--check-only")
		if len(args) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("bootstrap accepts only --check-only"))
		}
		if _, err := ValidateRuntime(ctx, config, nil); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitPrereq, err)
		}
		result, err := BootstrapContext(ctx, config, checkOnly, now, NewCompose(config, nil))
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		if jsonOutput {
			_ = WriteJSON(output, result)
		} else if !result.OK {
			fmt.Fprintln(output, "openlia bootstrap: runtime root is missing")
		} else {
			fmt.Fprintln(output, "openlia bootstrap: runtime prepared; no services started")
		}
		if !result.OK {
			return ExitFailure
		}
		return ExitOK
	case "profile":
		if len(args) > 1 || (len(args) == 1 && args[0] != "sync") {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("profile accepts sync"))
		}
		result, err := NewProfileOperator(config).Sync()
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia profile: distribution assets synchronized")
	case "backup":
		return runBackup(ctx, config, args, input, output, errorOutput, jsonOutput, now)
	case "attachments":
		return runAttachments(ctx, config, args, output, errorOutput, jsonOutput, now)
	case "locho-host":
		return runLochoHost(ctx, config, args, output, errorOutput, jsonOutput)
	case "auth":
		return runAuth(ctx, config, args, output, errorOutput, jsonOutput, now)
	case "deploy":
		_ = WriteOperatorConfig(config)
		return runDeploy(ctx, config, args, output, errorOutput, jsonOutput, now)
	case "job":
		return runJob(ctx, config, args, output, errorOutput, jsonOutput, now)
	case "reconcile":
		return runReconcile(ctx, config, args, output, errorOutput, jsonOutput, now)
	case "healthcheck":
		return runHealthcheck(ctx, config, args, output, errorOutput, jsonOutput)
	case "uninstall":
		if len(args) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("uninstall accepts no arguments"))
		}
		result, err := Uninstall(ctx, config, NewCompose(config, nil))
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia uninstall: local installation and backups removed; remote backups and Docker images preserved")
	default:
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("unknown command %q", command))
	}
}

func runBackup(ctx context.Context, config Config, args []string, _ io.Reader, output, errorOutput io.Writer, jsonOutput bool, now time.Time) int {
	action := "create"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	if action == "create" {
		scheduled, args := removeFlag(args, "--scheduled")
		if config.BackupRecipient == "" {
			return commandError(output, errorOutput, jsonOutput, ExitPrereq, fmt.Errorf("backup encryption recipient is not configured; run `openlia backup keygen`"))
		}
		reason := "manual"
		remaining, value, err := consumeOptionalValue(args, "--reason")
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, err)
		}
		if value != "" {
			reason = value
		}
		if len(remaining) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup create accepts --reason NAME"))
		}
		var result BackupResult
		if scheduled {
			result, err = CreateScheduledBackup(ctx, config, reason, now)
		} else {
			compose := NewCompose(config, nil)
			result, err = createBackup(ctx, config, reason, now, &compose, false)
		}
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		result.Destinations, err = PushBackup(ctx, config, result, now)
		backupStatus := "ok"
		if err != nil || result.RetentionError != "" {
			backupStatus = "partial"
		}
		if recordErr := RecordChange(config, "backup", backupStatus, result.Archive, "reason="+reason, now); recordErr != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, recordErr)
		}
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia backup: created "+result.Archive)
	}
	if action == "tick" {
		if len(args) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup tick accepts no arguments"))
		}
		result, ran, err := BackupScheduleTick(ctx, config, now)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		if !ran {
			return emit(output, map[string]any{"ok": true, "action": "tick", "ran": false}, jsonOutput, "openlia backup: schedule not due")
		}
		return emit(output, result, jsonOutput, "openlia backup: scheduled archive created "+result.Archive)
	}
	if action == "schedule-install" {
		if len(args) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup schedule-install accepts no arguments"))
		}
		result, err := InstallBackupScheduleContext(ctx, config, now)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia backup: schedule installed")
	}
	if action == "schedule-remove" {
		if len(args) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup schedule-remove accepts no arguments"))
		}
		result, err := RemoveBackupScheduleContext(ctx, config)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia backup: schedule removed")
	}
	if action == "status" {
		if len(args) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup status accepts no arguments"))
		}
		result, err := ReadBackupStatus(config)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, FormatBackupStatus(result))
	}
	if action == "push" {
		archive, remaining, err := stringFlag(args, "--archive")
		if err != nil || len(remaining) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup push accepts --archive PATH"))
		}
		if archive == "" {
			archive, err = latestEncryptedBackup(config)
			if err != nil {
				return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
			}
		}
		if err := ValidateAbsolutePath(archive, "backup-archive"); err != nil || !within(archive, config.BackupRoot) || !strings.HasSuffix(archive, ".tar.gz.age") {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup push requires an encrypted archive inside the backup directory"))
		}
		if err := verifyBackupDigest(archive); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		result := BackupResult{OK: true, Archive: archive, Secrets: "excluded"}
		result.Destinations, err = PushBackup(ctx, config, result, now)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia backup: pushed "+filepath.Base(archive))
	}
	if action == "prune" {
		keep := config.BackupRetention
		if keep <= 0 {
			keep = 5
		}
		remaining, value, err := consumeOptionalValue(args, "--keep")
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, err)
		}
		if value != "" {
			k, err := strconv.Atoi(value)
			if err != nil || k <= 0 {
				return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("--keep must be a positive integer"))
			}
			keep = k
		}
		if len(remaining) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup prune accepts --keep COUNT"))
		}
		removed, err := PruneBackups(config, keep)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		result := map[string]any{"ok": true, "action": "prune", "kept": keep, "removed": removed}
		return emit(output, result, jsonOutput, fmt.Sprintf("openlia backup: pruned %d archives, keeping %d", len(removed), keep))
	}
	if action != "restore" && action != "rollback-restore" {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup requires create, restore, rollback-restore, prune, status, tick, schedule-install, or schedule-remove"))
	}
	archive, remaining, err := stringFlag(args, "--archive")
	if err != nil || len(remaining) != 0 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("backup restore accepts --archive PATH"))
	}
	compose := NewCompose(config, nil)
	var result BackupResult
	if action == "rollback-restore" {
		result, err = RestoreRollback(config, archive, now, compose)
	} else {
		result, err = restoreBackup(ctx, config, archive, now, &compose)
	}
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	return emit(output, result, jsonOutput, "openlia backup: restored "+result.Archive+"; secrets and attachments remain destination-owned")
}

func runLochoHost(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool) int {
	if len(args) == 0 || args[0] != "share" || len(args) != 1 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("locho-host requires share"))
	}
	if jsonOutput {
		return commandError(output, errorOutput, true, ExitUsage, fmt.Errorf("locho-host share does not expose capabilities through JSON output"))
	}
	result, err := ShareLochoHost(ctx, config, NewCompose(config, nil))
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	if _, err := io.WriteString(output, result.AttachmentConfig); err != nil {
		return commandError(output, errorOutput, false, ExitFailure, err)
	}
	return ExitOK
}

func runAttachments(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool, now time.Time) int {
	action := "list"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	switch action {
	case "list":
		if len(args) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("attachments list accepts no arguments"))
		}
		result, err := ListAttachments(config)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, FormatAttachmentListHuman(result))
	case "generate":
		if len(args) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("attachments generate accepts no arguments"))
		}
		if err := GenerateAttachmentsContext(ctx, config, NewCompose(config, nil)); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "action": "attachments-generate", "capabilities": "redacted"}, jsonOutput, "openlia attachments: Compose sidecars regenerated")
	case "rotate":
		if len(args) == 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("attachments rotate requires HOST --source PATH"))
		}
		host := args[0]
		previousState, _ := ReadState(config)
		source, remaining, err := stringFlag(args[1:], "--source")
		if err != nil || len(remaining) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("attachments rotate requires HOST --source PATH"))
		}
		if err := RotateAttachmentContext(ctx, config, host, source, now, NewCompose(config, nil)); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		restart := "deferred-until-deploy"
		if previousState == stateRunning {
			restart = "sidecar-only"
		}
		return emit(output, map[string]any{"ok": true, "action": "locho-rotate", "host": host, "capabilities": "redacted", "restart": restart}, jsonOutput, "openlia attachments: host="+host+" rotated; capabilities were not displayed")
	default:
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("unknown attachments action %s", action))
	}
}

func runAuth(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool, now time.Time) int {
	action := "list"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	if action == "list" {
		if len(args) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("auth list accepts no arguments"))
		}
		result, err := ListAuth(config)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia auth: secret values redacted")
	}
	if action != "rotate" {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("auth requires list or rotate"))
	}
	source, remaining, err := stringFlag(args, "--source")
	if err != nil || len(remaining) != 0 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("auth rotate requires --source PATH"))
	}
	compose := NewCompose(config, nil)
	if err := rotateAuthWithCompose(ctx, config, compose, source, now); err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	return emit(output, map[string]any{"ok": true, "action": "auth-rotate", "secret_values": "redacted", "restart": "hermes_only"}, jsonOutput, "openlia auth: credentials rotated; values were not displayed")
}

func runDeploy(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool, now time.Time) int {
	action := "deploy"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	component := "all"
	forceStart := false
	for len(args) > 0 {
		switch args[0] {
		case "--start":
			forceStart = true
			args = args[1:]
		case "--component":
			if len(args) < 2 {
				return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("--component requires a value"))
			}
			component, args = args[1], args[2:]
		default:
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("unknown deploy option %s", args[0]))
		}
	}
	if action == "profile" {
		rollbackPaths := []string{
			runtimeRelativePath(config, filepath.Join(config.DataRoot, "config.yaml")),
			runtimeRelativePath(config, filepath.Join(config.DataRoot, "AGENTS.md")),
			runtimeRelativePath(config, filepath.Join(config.DataRoot, "SOUL.md")),
			runtimeRelativePath(config, config.MetaRoot),
		}
		backup, err := CreateRollback(config, "profile-update", now, rollbackPaths...)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		result, err := NewProfileOperator(config).Sync()
		if err != nil {
			_ = RecordChange(config, "profile", "failed", backup.Archive, "profile synchronization failed", now)
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		if err := RecordChange(config, "profile", "ok", backup.Archive, "profile assets synchronized", now); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "action": "profile", "backup": backup.Archive, "profile_sync": result}, jsonOutput, "openlia deploy: profile assets synchronized")
	}
	forceRecreate := config.LochoRelayConfig != "" || config.LochoRelaySecrets != ""
	result, err := Deploy(ctx, config, NewCompose(config, &ExecRunner{Stderr: errorOutput}), DeployOptions{Action: action, Component: component, ForceStart: forceStart, ForceRecreate: forceRecreate}, now)
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	return emit(output, result, jsonOutput, fmt.Sprintf("openlia deploy: action=%s state=%s", result.Action, result.State))
}

func runHealthcheck(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool) int {
	allowStopped, args := removeFlag(args, "--allow-stopped")
	providerCheck, args := removeFlag(args, "--provider-check")
	cached, args := removeFlag(args, "--cached")
	if len(args) != 0 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("unknown healthcheck option %s", args[0]))
	}
	compose := NewCompose(config, nil)
	var (
		result HealthResult
		err    error
	)
	if cached {
		result, err = HealthcheckCached(ctx, config, compose, allowStopped, providerCheck, true)
	} else {
		result, err = Healthcheck(ctx, config, compose, allowStopped, providerCheck)
		if err == nil {
			if job, jobErr := ReadCurrentJob(config); jobErr == nil && job != nil {
				result.Job = job
			}
		}
	}
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	if jsonOutput {
		_ = WriteJSON(output, result)
	} else {
		jobSuffix := ""
		if result.Job != nil {
			jobSuffix = fmt.Sprintf(" job=%s(%s:%s)", result.Job.ID, result.Job.Kind, result.Job.Status)
		}
		fmt.Fprintf(output, "openlia health: state=%s result=%s%s\n", result.State, map[bool]string{true: "ok", false: "failed"}[result.OK], jobSuffix)
	}
	if !result.OK {
		return ExitFailure
	}
	return ExitOK
}

func runJob(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool, now time.Time) int {
	action := "status"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	switch action {
	case "start":
		if len(args) == 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("job start requires KIND [ARGS...]"))
		}
		kind := args[0]
		jobArgs := args[1:]
		result, err := StartJob(ctx, config, kind, jobArgs, now)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, fmt.Sprintf("openlia job: id=%s kind=%s status=%s", result.JobID, result.Kind, result.Status))
	case "run":
		if len(args) < 2 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("job run requires ID KIND [ARGS...]"))
		}
		jobID := args[0]
		kind := args[1]
		jobArgs := args[2:]
		if err := ExecuteJob(ctx, config, jobID, kind, jobArgs, now); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		record, err := ReadJob(config, jobID)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, record, jsonOutput, fmt.Sprintf("openlia job: id=%s kind=%s status=%s", record.ID, record.Kind, record.Status))
	case "status":
		if len(args) > 1 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("job status accepts at most one JOB_ID"))
		}
		var (
			record *JobRecord
			err    error
		)
		if len(args) == 1 {
			record, err = ReadJob(config, args[0])
		} else {
			record, err = ReadCurrentJob(config)
		}
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		if record == nil {
			return emit(output, map[string]any{"schema": 1, "ok": true, "status": "idle"}, jsonOutput, "openlia job: status=idle")
		}
		human := fmt.Sprintf("openlia job: id=%s kind=%s status=%s", record.ID, record.Kind, record.Status)
		if record.Error != "" {
			human += " error=" + record.Error
		}
		if record.LogTail != "" {
			human += "\n" + record.LogTail
		}
		if jsonOutput {
			_ = WriteJSON(output, record)
		} else {
			fmt.Fprintln(output, human)
		}
		if record.Status == JobStatusFailed {
			return ExitFailure
		}
		return ExitOK
	case "logs":
		if len(args) > 1 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("job logs accepts at most one JOB_ID"))
		}
		jobID := ""
		if len(args) == 1 {
			jobID = args[0]
		} else {
			record, err := ReadCurrentJob(config)
			if err != nil {
				return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
			}
			if record == nil {
				return emit(output, map[string]any{"schema": 1, "ok": true, "job_id": "", "logs": ""}, jsonOutput, "openlia job: no active or recent job")
			}
			jobID = record.ID
		}
		logs, err := ReadJobLog(config, jobID)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		if jsonOutput {
			_ = WriteJSON(output, map[string]any{"schema": 1, "ok": true, "job_id": jobID, "logs": logs})
			return ExitOK
		}
		if logs != "" {
			if !strings.HasSuffix(logs, "\n") {
				logs += "\n"
			}
			_, _ = io.WriteString(output, logs)
		}
		return ExitOK
	default:
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("job requires start, run, status, or logs"))
	}
}

func runReconcile(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool, now time.Time) int {
	daemon, args := removeFlag(args, "--daemon")
	if len(args) != 0 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("reconcile accepts only --daemon"))
	}
	if daemon {
		if err := RunReconcilerDaemon(ctx, config, 60*time.Second); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return ExitOK
	}
	result, err := ReconcileTick(ctx, config, NewCompose(config, nil), now)
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	return emit(output, result, jsonOutput, fmt.Sprintf("openlia reconcile: state=%s restarted=%d ok=%t", result.State, len(result.RestartedServices), result.OK))
}

func emit(output io.Writer, value any, jsonOutput bool, human string) int {
	if jsonOutput {
		if err := WriteJSON(output, value); err != nil {
			return ExitInternal
		}
		return ExitOK
	}
	if human != "" {
		fmt.Fprintln(output, human)
	}
	return ExitOK
}

func commandError(output, errorOutput io.Writer, jsonOutput bool, code int, err error) int {
	if jsonOutput {
		_ = WriteJSON(output, map[string]any{"schema": 1, "ok": false, "error": formatError(err).Error()})
	} else {
		fmt.Fprintf(errorOutput, "openlia: %s\n", formatError(err))
	}
	return code
}

func removeFlag(args []string, wanted string) (bool, []string) {
	found := false
	result := make([]string, 0, len(args))
	for _, arg := range args {
		if arg == wanted {
			found = true
		} else {
			result = append(result, arg)
		}
	}
	return found, result
}

func stringFlag(args []string, name string) (string, []string, error) {
	value := ""
	remaining := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		if args[index] == name {
			if index+1 >= len(args) || args[index+1] == "" {
				return "", nil, fmt.Errorf("%s requires a value", name)
			}
			value = args[index+1]
			index++
		} else {
			remaining = append(remaining, args[index])
		}
	}
	return value, remaining, nil
}

func consumeOptionalValue(args []string, name string) ([]string, string, error) {
	value, remaining, err := stringFlag(args, name)
	return remaining, value, err
}

func contains(args []string, value string) bool {
	for _, arg := range args {
		if arg == value {
			return true
		}
	}
	return false
}

func writeUsage(writer io.Writer) {
	fmt.Fprintln(writer, `openlia operator

Usage:
  openlia-operator <subcommand> [--json]

Subcommands:
  bootstrap profile backup attachments locho-host auth deploy job reconcile healthcheck uninstall`)
}
