package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"openlia/operator/migration"
)

// Run is the standalone Go operator entrypoint. The root CLI is intentionally
// left unchanged while this command is evaluated as a replacement boundary.
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
		result, err := syncProfileAndRefresh(ctx, config, NewCompose(config, nil))
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia profile: distribution assets synchronized; workspace preserved")
	case "skill-status":
		selected, remaining, err := stringFlag(args, "--skill")
		if err != nil || len(remaining) != 0 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("skill-status accepts --skill NAME"))
		}
		result, err := NewProfileOperator(config).Status(selected)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia skill-status: read-only skill provenance inspection")
	case "skill-fork":
		if len(args) != 1 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("skill-fork requires NAME"))
		}
		result, err := ForkSkill(config, args[0], now)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia skill-fork: skill forked; active files preserved")
	case "skill-migration":
		return runSkillMigration(config, args, output, errorOutput, jsonOutput, now)
	case "backup":
		return runBackup(ctx, config, args, input, output, errorOutput, jsonOutput, now)
	case "attachments":
		return runAttachments(ctx, config, args, output, errorOutput, jsonOutput, now)
	case "locho-host":
		return runLochoHost(ctx, config, args, output, errorOutput, jsonOutput)
	case "auth":
		return runAuth(ctx, config, args, output, errorOutput, jsonOutput, now)
	case "deploy":
		return runDeploy(ctx, config, args, output, errorOutput, jsonOutput, now)
	case "healthcheck":
		return runHealthcheck(ctx, config, args, output, errorOutput, jsonOutput)
	case "workspace-git":
		return runWorkspaceGit(ctx, config, args, output, errorOutput, jsonOutput)
	case "workspace-migrate":
		return runWorkspaceMigrate(ctx, config, args, output, errorOutput, jsonOutput)
	case "workspace-export":
		return runWorkspaceExport(ctx, config, args, output, errorOutput, jsonOutput)
	case "instructions":
		return runInstructions(config, args, input, output, errorOutput, jsonOutput, now)
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
	return emit(output, result, jsonOutput, "openlia backup: restored "+result.Archive+"; secrets, attachments, and Open WebUI data remain destination-owned")
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
		for _, skill := range config.EnabledSkills {
			rollbackPaths = append(rollbackPaths, runtimeRelativePath(config, filepath.Join(config.DataRoot, "skills", skill)))
		}
		backup, err := CreateRollback(config, "profile-update", now, rollbackPaths...)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		result, err := syncProfileAndRefresh(ctx, config, NewCompose(config, nil))
		if err != nil {
			_ = RecordChange(config, "profile", "failed", backup.Archive, "profile synchronization failed", now)
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		if err := RecordChange(config, "profile", "ok", backup.Archive, "profile assets synchronized", now); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		human := fmt.Sprintf("openlia deploy: profile assets synchronized; workspace preserved; updated=%d; forked=%d; updates_available=%d; customized=%d; unmanaged=%d", result.Skills.Updated, result.Skills.Forked, result.Skills.UpdatesAvailable, result.Skills.Customized, result.Skills.Unmanaged)
		return emit(output, map[string]any{"ok": true, "action": "profile", "backup": backup.Archive, "workspace": "preserved", "attention_required": result.Instructions.AttentionRequired, "profile_sync": result}, jsonOutput, human)
	}
	forceRecreate := config.LochoRelayConfig != "" || config.LochoRelaySecrets != ""
	result, err := Deploy(ctx, config, NewCompose(config, &ExecRunner{Stderr: errorOutput}), DeployOptions{Action: action, Component: component, ForceStart: forceStart, ForceRecreate: forceRecreate}, now)
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	return emit(output, result, jsonOutput, fmt.Sprintf("openlia deploy: action=%s state=%s", result.Action, result.State))
}

func syncProfileAndRefresh(ctx context.Context, config Config, compose Compose) (ProfileSyncResult, error) {
	result, err := NewProfileOperator(config).Sync()
	if err != nil {
		return ProfileSyncResult{}, err
	}
	if err := refreshProtectedSkillRuntime(ctx, config, compose); err != nil {
		return ProfileSyncResult{}, err
	}
	return result, nil
}

func refreshProtectedSkillRuntime(ctx context.Context, config Config, compose Compose) error {
	state, err := ReadState(config)
	if err != nil {
		return err
	}
	if state != stateRunning {
		return nil
	}
	if _, err := compose.Run(ctx, "up", "-d", "--no-deps", "--force-recreate", "hermes"); err != nil {
		return fmt.Errorf("reload Hermes protected skills: %w", err)
	}
	return nil
}

func runHealthcheck(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool) int {
	allowStopped, args := removeFlag(args, "--allow-stopped")
	providerCheck, args := removeFlag(args, "--provider-check")
	if len(args) != 0 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("unknown healthcheck option %s", args[0]))
	}
	result, err := Healthcheck(ctx, config, NewCompose(config, nil), allowStopped, providerCheck)
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	if jsonOutput {
		_ = WriteJSON(output, result)
	} else {
		fmt.Fprintf(output, "openlia health: state=%s result=%s\n", result.State, map[bool]string{true: "ok", false: "failed"}[result.OK])
	}
	if !result.OK {
		return ExitFailure
	}
	return ExitOK
}

func runWorkspaceGit(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool) int {
	action := "setup"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	if len(args) != 0 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("workspace-git accepts only setup, ensure, or status"))
	}
	result, err := WorkspaceGit(ctx, NewCompose(config, nil), WorkspaceGitOptions{
		Action:   action,
		Schedule: config.WorkspaceGitSchedule,
		Enabled:  config.WorkspaceGitEnabled,
	})
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	return emit(output, result, jsonOutput, "openlia workspace git: operation completed")
}

func runWorkspaceExport(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool) int {
	outputFile := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--output" && i+1 < len(args) {
			outputFile = args[i+1]
			i++
		}
	}
	if outputFile == "" {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("workspace-export requires --output"))
	}
	result, err := WorkspaceExport(config, outputFile)
	if err != nil {
		return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
	}
	return emit(output, result, jsonOutput, fmt.Sprintf("openlia workspace-export: %d files exported (%d bytes)", result.FilesCount, result.SizeBytes))
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

func runInstructions(config Config, args []string, input io.Reader, output, errorOutput io.Writer, jsonOutput bool, now time.Time) int {
	if len(args) == 0 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("instructions requires status, diff, merge, keep, or reset"))
	}
	action := args[0]
	args = args[1:]
	approved, args := removeFlag(args, "--approve")
	switch action {
	case "status":
		if len(args) > 1 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("instructions status accepts at most one name"))
		}
		selected := ""
		if len(args) == 1 {
			selected = args[0]
		}
		result, err := InstructionStatus(config, selected)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, fmt.Sprintf("openlia instructions: %d instruction file(s); attention_required=%t", len(result.Instructions), result.AttentionRequired))
	case "diff":
		if len(args) != 1 {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("instructions diff requires NAME"))
		}
		result, err := InstructionDiff(config, args[0])
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		if !jsonOutput {
			fmt.Fprint(output, result.ThreeWay)
			return ExitOK
		}
		return emit(output, result, true, "")
	case "merge", "keep", "reset":
		if len(args) != 1 || !approved {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("instructions %s requires NAME and --approve", action))
		}
		if input == nil {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("instruction mutation request is required"))
		}
		decoder := json.NewDecoder(io.LimitReader(input, 64*1024))
		decoder.DisallowUnknownFields()
		var request InstructionMutationRequest
		if err := decoder.Decode(&request); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("decode instruction mutation request: %w", err))
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("instruction mutation request contains trailing data"))
		}
		result, err := MutateInstruction(config, args[0], action, request, now)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, fmt.Sprintf("openlia instructions: %s %s; state=%s", action, args[0], result.State))
	default:
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("unknown instructions action %q", action))
	}
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

func intFlag(args []string, name string) (int, []string, error) {
	strVal, remaining, err := stringFlag(args, name)
	if err != nil || strVal == "" {
		return 0, remaining, err
	}
	val, err := strconv.Atoi(strVal)
	return val, remaining, err
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
	  bootstrap profile skill-status skill-fork skill-migration backup attachments locho-host auth deploy
	  healthcheck workspace-git workspace-migrate workspace-export instructions uninstall`)
}

func runWorkspaceMigrate(ctx context.Context, config Config, args []string, output, errorOutput io.Writer, jsonOutput bool) int {
	if len(args) == 0 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("workspace-migrate requires action: worker, status, plan, apply-chunk, or list"))
	}
	action := args[0]
	args = args[1:]
	migrationID, args, _ := stringFlag(args, "--migration-id")
	chunkID, args, _ := stringFlag(args, "--chunk-id")

	revisionID, args, _ := stringFlag(args, "--revision")
	revisionNum, args, _ := intFlag(args, "--revision")
	fromRev, args, _ := intFlag(args, "--from-revision")
	toRev, args, _ := intFlag(args, "--to-revision")
	patchHash, args, _ := stringFlag(args, "--patch-hash")

	switch action {
	case "init":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("init requires --migration-id"))
		}
		mig, err := InitMigrationV2(config, migrationID)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, mig, jsonOutput, fmt.Sprintf("openlia workspace-migrate: initialized %s", migrationID))

	case "worker":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("worker requires --migration-id"))
		}
		migDir := MigrationRoot(config, migrationID)
		if _, err := os.Stat(filepath.Join(migDir, "migration.sqlite")); err == nil {
			if err := RunMigrationSupervisor(ctx, config, migrationID); err != nil {
				return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
			}
			return emit(output, map[string]any{"ok": true, "migration_id": migrationID, "status": "completed"}, jsonOutput, "openlia workspace-migrate: worker finished")
		}
		if err := RunMigrationWorker(ctx, config, migrationID); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "migration_id": migrationID, "status": "completed"}, jsonOutput, "openlia workspace-migrate: worker finished")

	case "stop":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("stop requires --migration-id"))
		}
		if err := StopMigration(config, migrationID); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "migration_id": migrationID, "state": "stopped"}, jsonOutput, fmt.Sprintf("openlia workspace-migrate: migration %s stopped", migrationID))

	case "resume":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("resume requires --migration-id"))
		}
		if err := ResumeMigration(ctx, config, migrationID); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "migration_id": migrationID, "state": "resumed"}, jsonOutput, fmt.Sprintf("openlia workspace-migrate: migration %s resumed", migrationID))

	case "discard":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("discard requires --migration-id"))
		}
		if err := DiscardMigration(config, migrationID); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "migration_id": migrationID, "state": "discarded"}, jsonOutput, fmt.Sprintf("openlia workspace-migrate: migration %s discarded", migrationID))

	case "diff":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("diff requires --migration-id"))
		}
		targetToRev := toRev
		if targetToRev == 0 && revisionNum > 0 {
			targetToRev = revisionNum
		}
		diffText, err := GetMigrationDiffV2(config, migrationID, fromRev, targetToRev)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "migration_id": migrationID, "diff": diffText}, jsonOutput, diffText)

	case "apply":
		if migrationID == "" || revisionID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("apply requires --migration-id and --revision"))
		}
		if err := ApplyRevision(config, migrationID, revisionID, patchHash); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "migration_id": migrationID, "revision_id": revisionID, "state": "applied"}, jsonOutput, fmt.Sprintf("openlia workspace-migrate: revision %s applied", revisionID))

	case "status":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("status requires --migration-id"))
		}
		status, err := GetMigrationStatusV2(config, migrationID)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, status, jsonOutput, fmt.Sprintf("openlia workspace-migrate: status for %s", migrationID))

	case "plan":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("plan requires --migration-id"))
		}
		plan, err := GetMigrationPlan(config, migrationID)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, plan, jsonOutput, fmt.Sprintf("openlia workspace-migrate: plan contains %d chunks, %d files", plan.TotalChunks, plan.TotalFiles))

	case "apply-chunk":
		if migrationID == "" || chunkID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("apply-chunk requires --migration-id and --chunk-id"))
		}
		if err := ApplyMigrationChunk(config, migrationID, chunkID, nil); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "migration_id": migrationID, "chunk_id": chunkID, "state": "applied"}, jsonOutput, fmt.Sprintf("openlia workspace-migrate: chunk %s applied", chunkID))

	case "recover":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("recover requires --migration-id"))
		}
		recoverAction, _, _ := stringFlag(args, "--action")
		if recoverAction == "" {
			recoverAction = "inspect"
		}
		res, err := RecoverMigration(config, migrationID, recoverAction)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, res, jsonOutput, res.Message)

	case "feedback":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("feedback requires --migration-id"))
		}
		comment, args, _ := stringFlag(args, "--comment")
		if comment == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("feedback requires --comment"))
		}
		targetPath, args, _ := stringFlag(args, "--target-path")
		migDir := MigrationRoot(config, migrationID)
		db, err := migration.OpenDB(migDir)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		defer db.Close()
		mig, err := db.GetMigration(migrationID)
		if err != nil || mig == nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, fmt.Errorf("migration %s not found", migrationID))
		}
		targetRev := revisionID
		if targetRev == "" {
			targetRev = mig.ActiveRevisionID
		}
		item := migration.FeedbackItem{
			ID:          fmt.Sprintf("fb-%d", time.Now().UnixNano()),
			MigrationID: migrationID,
			RevisionID:  targetRev,
			TargetPath:  targetPath,
			Comment:     comment,
			Status:      "submitted",
			CreatedAt:   time.Now().UTC(),
		}
		if err := db.AddFeedback(item); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		state := mig.State
		if strings.HasPrefix(strings.TrimSpace(comment), "[CHANGES REQUESTED]") {
			_ = db.UpdateMigrationState(migrationID, migration.StateRevising, "")
			state = migration.StateRevising
			go func() {
				_ = RunMigrationSupervisor(context.Background(), config, migrationID)
			}()
		}
		return emit(output, map[string]any{"ok": true, "feedback_id": item.ID, "status": "submitted", "state": state}, jsonOutput, "Feedback submitted.")

	case "retry-jobs":
		if migrationID == "" {
			return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("retry-jobs requires --migration-id"))
		}
		migDir := MigrationRoot(config, migrationID)
		db, err := migration.OpenDB(migDir)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		defer db.Close()
		if err := db.ResetFailedJobs(migrationID); err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		_ = db.UpdateMigrationState(migrationID, migration.StateProcessing, "")
		go func() {
			_ = RunMigrationSupervisor(context.Background(), config, migrationID)
		}()
		return emit(output, map[string]any{"ok": true, "migration_id": migrationID, "status": "retrying"}, jsonOutput, "Failed jobs reset and worker restarted.")

	case "list":
		items, err := ListMigrations(config)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, map[string]any{"ok": true, "migrations": items}, jsonOutput, fmt.Sprintf("openlia workspace-migrate: %d migration(s) found", len(items)))

	default:
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("unknown workspace-migrate action %s", action))
	}
}

func runSkillMigration(config Config, args []string, output, errorOutput io.Writer, jsonOutput bool, now time.Time) int {
	if len(args) == 0 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("skill-migration requires prepare, show, apply, or reject"))
	}
	action := args[0]
	if len(args) != 2 {
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("skill-migration %s requires one name or proposal ID", action))
	}
	switch action {
	case "prepare":
		result, err := PrepareSkillMigration(config, args[1], now)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia skill-migration: context staged for Hermes")
	case "show":
		proposal, err := ReadSkillMigrationProposal(config, args[1])
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, proposal, jsonOutput, "openlia skill-migration: proposal loaded")
	case "apply":
		result, err := ApplySkillMigration(config, args[1], now)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia skill-migration: proposal applied")
	case "reject":
		result, err := RejectSkillMigration(config, args[1], now)
		if err != nil {
			return commandError(output, errorOutput, jsonOutput, ExitFailure, err)
		}
		return emit(output, result, jsonOutput, "openlia skill-migration: proposal rejected")
	default:
		return commandError(output, errorOutput, jsonOutput, ExitUsage, fmt.Errorf("unknown skill-migration action %s", action))
	}
}
