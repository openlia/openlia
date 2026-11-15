package operator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	ConsolidationStatusQueued    = "queued"
	ConsolidationStatusRunning   = "running"
	ConsolidationStatusSucceeded = "succeeded"
	ConsolidationStatusFailed    = "failed"
)

// ConsolidationRecord represents the single target consolidation state managed by openlia-operator.
type ConsolidationRecord struct {
	Schema      int            `json:"schema"`
	Action      string         `json:"action"`
	Status      string         `json:"status"`
	Phase       string         `json:"phase,omitempty"`
	StartedAt   string         `json:"started_at"`
	UpdatedAt   string         `json:"updated_at"`
	CompletedAt string         `json:"completed_at,omitempty"`
	PID         int            `json:"pid,omitempty"`
	Error       string         `json:"error,omitempty"`
	LogTail     string         `json:"log_tail,omitempty"`
	Result      map[string]any `json:"result,omitempty"`
}

// ConsolidationStartResult is the immediate response returned when a consolidation is dispatched.
type ConsolidationStartResult struct {
	Schema        int                 `json:"schema"`
	OK            bool                `json:"ok"`
	Async         bool                `json:"async"`
	Action        string              `json:"action"`
	Status        string              `json:"status"`
	Phase         string              `json:"phase,omitempty"`
	Consolidation ConsolidationRecord `json:"consolidation"`
}

// ConsolidationPath returns the JSON state path for the target consolidation.
func ConsolidationPath(config Config) string {
	return filepath.Join(config.MetaRoot, "reconcile.json")
}

// ConsolidationLogPath returns the log file path for the target consolidation.
func ConsolidationLogPath(config Config) string {
	return filepath.Join(config.MetaRoot, "reconcile.log")
}

func writeConsolidationRecord(config Config, record ConsolidationRecord) error {
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	path := ConsolidationPath(config)
	if err := AtomicWriteFile(path, data, 0o600); err != nil {
		return err
	}
	_ = ensureRuntimeOwner(path, config.RuntimeUID, config.RuntimeGID, 0o600)
	return nil
}

// ReadConsolidation reads the latest consolidation record from <MetaRoot>/reconcile.json,
// reconciling stale running states if the worker process is no longer alive.
func ReadConsolidation(config Config) (*ConsolidationRecord, error) {
	path := ConsolidationPath(config)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record ConsolidationRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, err
	}
	if (record.Status == ConsolidationStatusRunning || record.Status == ConsolidationStatusQueued) && record.PID > 0 {
		if !isProcessAlive(record.PID) {
			// Re-read the file in case the worker just wrote its terminal state.
			if freshData, readErr := os.ReadFile(path); readErr == nil {
				var fresh ConsolidationRecord
				if json.Unmarshal(freshData, &fresh) == nil && fresh.Status != ConsolidationStatusRunning && fresh.Status != ConsolidationStatusQueued {
					return &fresh, nil
				}
			}
			now := utcTimestamp(time.Now().UTC())
			record.Status = ConsolidationStatusFailed
			record.UpdatedAt = now
			record.CompletedAt = now
			if record.Error == "" {
				record.Error = "consolidation worker process terminated unexpectedly"
			}
			record.LogTail = readConsolidationLogTail(config, 20)
			_ = writeConsolidationRecord(config, record)
		}
	}
	return &record, nil
}

// ReadConsolidationLog returns the redacted log contents for the target consolidation.
func ReadConsolidationLog(config Config) (string, error) {
	data, err := os.ReadFile(ConsolidationLogPath(config))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return formatError(errors.New(string(data))).Error(), nil
}

func readConsolidationLogTail(config Config, maxLines int) string {
	text, err := ReadConsolidationLog(config)
	if err != nil || strings.TrimSpace(text) == "" {
		return ""
	}
	lines := strings.Split(strings.TrimRight(text, "\r\n"), "\n")
	if maxLines > 0 && len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return strings.Join(lines, "\n")
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// StartConsolidation validates prerequisites, persists the target operator config, and
// launches a detached background worker process to execute the requested consolidation.
// Only one consolidation may run at a time; concurrent requests are rejected immediately.
func StartConsolidation(ctx context.Context, config Config, action string, args []string, now time.Time) (ConsolidationStartResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return ConsolidationStartResult{}, err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return ConsolidationStartResult{}, err
	}

	if current, err := ReadConsolidation(config); err == nil && current != nil {
		if (current.Status == ConsolidationStatusRunning || current.Status == ConsolidationStatusQueued) && isProcessAlive(current.PID) {
			return ConsolidationStartResult{}, fmt.Errorf("another OpenLia consolidation (%s, phase=%s) is already running", current.Action, current.Phase)
		}
	}
	if err := probeOperationFlock(config); err != nil {
		return ConsolidationStartResult{}, err
	}

	if _, _, err := parseConsolidationArgs(action, args); err != nil {
		return ConsolidationStartResult{}, err
	}

	if err := WriteOperatorConfig(config); err != nil {
		return ConsolidationStartResult{}, fmt.Errorf("persist target operator config: %w", err)
	}

	stamp := utcTimestamp(now)
	record := ConsolidationRecord{
		Schema:    1,
		Action:    action,
		Status:    ConsolidationStatusQueued,
		Phase:     "queued",
		StartedAt: stamp,
		UpdatedAt: stamp,
	}
	if err := writeConsolidationRecord(config, record); err != nil {
		return ConsolidationStartResult{}, fmt.Errorf("create consolidation record: %w", err)
	}

	pid, err := spawnDetachedConsolidationWorker(config, action, args)
	if err != nil {
		record.Status = ConsolidationStatusFailed
		record.Error = err.Error()
		record.CompletedAt = utcTimestamp(time.Now().UTC())
		_ = writeConsolidationRecord(config, record)
		return ConsolidationStartResult{}, fmt.Errorf("launch detached consolidation worker: %w", err)
	}
	if pid > 0 {
		// Re-read in case an in-process worker already completed before we write PID.
		if latest, readErr := ReadConsolidation(config); readErr == nil && latest != nil && (latest.Status == ConsolidationStatusSucceeded || latest.Status == ConsolidationStatusFailed) {
			record = *latest
		} else {
			record.PID = pid
			record.Status = ConsolidationStatusRunning
			record.StartedAt = stamp
			_ = writeConsolidationRecord(config, record)
		}
	} else if latest, readErr := ReadConsolidation(config); readErr == nil && latest != nil {
		record = *latest
	}

	return ConsolidationStartResult{
		Schema:        1,
		OK:            true,
		Async:         true,
		Action:        record.Action,
		Status:        record.Status,
		Phase:         record.Phase,
		Consolidation: record,
	}, nil
}

func spawnDetachedConsolidationWorker(config Config, action string, args []string) (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	// Truncate the consolidation log file before starting the worker.
	logFile, err := os.OpenFile(ConsolidationLogPath(config), os.O_CREATE|os.O_WRONLY|os.O_TRUNC|os.O_APPEND, 0o600)
	if err != nil {
		return 0, err
	}
	_ = ensureRuntimeOwner(ConsolidationLogPath(config), config.RuntimeUID, config.RuntimeGID, 0o600)

	// During unit tests (*.test binary) or when OPENLIA_INPROCESS_CONSOLIDATION=1 is set,
	// run the consolidation in a background goroutine rather than re-execing the test binary.
	if strings.HasSuffix(exe, ".test") || os.Getenv("OPENLIA_INPROCESS_CONSOLIDATION") == "1" || os.Getenv("OPENLIA_INPROCESS_JOBS") == "1" {
		_ = logFile.Close()
		done := make(chan struct{})
		go func() {
			close(done)
			_ = ExecuteConsolidation(context.Background(), config, action, args, time.Now().UTC())
		}()
		<-done
		return os.Getpid(), nil
	}
	defer logFile.Close()

	cmdArgs := append([]string{"reconcile", "--run", action}, args...)
	cmd := exec.Command(exe, cmdArgs...)
	cmd.Env = append(os.Environ(),
		"OPENLIA_OPERATOR_CONFIG_FILE="+OperatorConfigPath(config.MetaRoot),
		"OPENLIA_INTERNAL_OPERATOR=1",
	)
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}

func parseConsolidationArgs(action string, args []string) (component string, bootstrap bool, err error) {
	switch action {
	case "deploy", "start", "stop", "restart":
		component = "all"
		for i := 0; i < len(args); i++ {
			switch args[i] {
			case "--component":
				if i+1 >= len(args) {
					return "", false, fmt.Errorf("--component requires a value")
				}
				i++
				component = args[i]
			case "--bootstrap":
				bootstrap = true
			case "--start":
				// compatibility flag
			default:
				return "", false, fmt.Errorf("unknown consolidation argument %q", args[i])
			}
		}
		return component, bootstrap, nil
	case "backup-create":
		remaining, _, flagErr := consumeOptionalValue(args, "--reason")
		if flagErr != nil {
			return "", false, flagErr
		}
		if len(remaining) != 0 {
			return "", false, fmt.Errorf("backup-create accepts --reason NAME")
		}
		return "", false, nil
	case "backup-push":
		_, remaining, flagErr := stringFlag(args, "--archive")
		if flagErr != nil || len(remaining) != 0 {
			return "", false, fmt.Errorf("backup-push accepts --archive PATH")
		}
		return "", false, nil
	default:
		return "", false, fmt.Errorf("unsupported consolidation action %q", action)
	}
}

func probeOperationFlock(config Config) error {
	lockPath := os.Getenv("OPENLIA_OPERATION_LOCK")
	if lockPath == "" {
		lockPath = config.InstallRoot + ".operation.lock"
	}
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return fmt.Errorf("prepare operation lock directory: %w", err)
	}
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open operation lock: %w", err)
	}
	defer file.Close()
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return fmt.Errorf("another OpenLia operation is already running")
		}
		return fmt.Errorf("acquire operation lock: %w", err)
	}
	_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
	return nil
}

func acquireOperationFlock(ctx context.Context, config Config) (func(), error) {
	lockPath := os.Getenv("OPENLIA_OPERATION_LOCK")
	if lockPath == "" {
		lockPath = config.InstallRoot + ".operation.lock"
	}
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return nil, fmt.Errorf("prepare operation lock directory: %w", err)
	}
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open operation lock: %w", err)
	}
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err == nil {
			return func() {
				_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
				_ = file.Close()
			}, nil
		} else if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			_ = file.Close()
			return nil, fmt.Errorf("acquire operation lock: %w", err)
		}
		select {
		case <-ctx.Done():
			_ = file.Close()
			return nil, ctx.Err()
		case <-deadline.C:
			_ = file.Close()
			return nil, fmt.Errorf("another OpenLia operation is already running")
		case <-ticker.C:
		}
	}
}

// ExecuteConsolidation runs the full target operation pipeline inside the
// detached worker process, updating <MetaRoot>/reconcile.json at each phase.
func ExecuteConsolidation(ctx context.Context, config Config, action string, args []string, now time.Time) error {
	existing, err := ReadConsolidation(config)
	var record ConsolidationRecord
	if err == nil && existing != nil && existing.Action == action && existing.Status != ConsolidationStatusSucceeded && existing.Status != ConsolidationStatusFailed {
		record = *existing
	} else {
		record = ConsolidationRecord{
			Schema:    1,
			Action:    action,
			StartedAt: utcTimestamp(now),
		}
	}
	record.Status = ConsolidationStatusRunning
	record.PID = os.Getpid()
	if record.StartedAt == "" {
		record.StartedAt = utcTimestamp(now)
	}
	record.UpdatedAt = utcTimestamp(now)
	record.CompletedAt = ""
	record.Error = ""
	record.LogTail = ""
	record.Result = nil
	_ = writeConsolidationRecord(config, record)

	_ = EnsureDir(config.MetaRoot, 0o700)
	logFile, _ := os.OpenFile(ConsolidationLogPath(config), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if logFile != nil {
		defer logFile.Close()
		_, _ = fmt.Fprintf(logFile, "[%s] consolidation action=%s started\n", utcTimestamp(now), action)
	}

	failConsolidation := func(runErr error) error {
		ts := utcTimestamp(time.Now().UTC())
		errMsg := formatError(runErr).Error()
		if logFile != nil {
			_, _ = fmt.Fprintf(logFile, "[%s] error=%s\n", ts, errMsg)
			_ = logFile.Sync()
		}
		record.Status = ConsolidationStatusFailed
		record.UpdatedAt = ts
		record.CompletedAt = ts
		record.Error = errMsg
		record.LogTail = readConsolidationLogTail(config, 20)
		_ = writeConsolidationRecord(config, record)
		return runErr
	}

	updatePhase := func(phase string) {
		ts := utcTimestamp(time.Now().UTC())
		if logFile != nil {
			_, _ = fmt.Fprintf(logFile, "[%s] phase=%s\n", ts, phase)
		}
		record.Phase = phase
		record.UpdatedAt = ts
		_ = writeConsolidationRecord(config, record)
	}

	unlock, lockErr := acquireOperationFlock(ctx, config)
	if lockErr != nil {
		return failConsolidation(lockErr)
	}
	defer unlock()

	var runner CommandRunner
	if logFile != nil {
		runner = &ExecRunner{Stderr: logFile}
	}
	compose := NewCompose(config, runner)
	var result map[string]any

	switch action {
	case "deploy", "start", "stop", "restart":
		component, bootstrap, parseErr := parseConsolidationArgs(action, args)
		if parseErr != nil {
			return failConsolidation(parseErr)
		}
		res, deployErr := executeDeployPipeline(ctx, config, compose, action, component, bootstrap, updatePhase)
		if deployErr != nil {
			return failConsolidation(deployErr)
		}
		result = res
	case "backup-create":
		updatePhase("backup-create")
		reason := "manual"
		remaining, val, flagErr := consumeOptionalValue(args, "--reason")
		if flagErr != nil {
			return failConsolidation(flagErr)
		}
		if val != "" {
			reason = val
		}
		if len(remaining) != 0 {
			return failConsolidation(fmt.Errorf("backup create accepts --reason NAME"))
		}
		backupRes, createErr := createBackup(ctx, config, reason, time.Now().UTC(), &compose, false)
		if createErr != nil {
			return failConsolidation(createErr)
		}
		updatePhase("backup-push")
		destinations, pushErr := PushBackup(ctx, config, backupRes, time.Now().UTC())
		backupRes.Destinations = destinations
		backupStatus := "ok"
		if pushErr != nil || backupRes.RetentionError != "" {
			backupStatus = "partial"
		}
		_ = RecordChange(config, "backup", backupStatus, backupRes.Archive, "reason="+reason, time.Now().UTC())
		if pushErr != nil {
			return failConsolidation(pushErr)
		}
		result = map[string]any{
			"ok":           true,
			"archive":      backupRes.Archive,
			"secrets":      backupRes.Secrets,
			"destinations": backupRes.Destinations,
		}
		if backupRes.RetentionError != "" {
			result["retention_error"] = backupRes.RetentionError
		}
	case "backup-push":
		updatePhase("backup-push")
		archive, remaining, flagErr := stringFlag(args, "--archive")
		if flagErr != nil || len(remaining) != 0 {
			return failConsolidation(fmt.Errorf("backup push accepts --archive PATH"))
		}
		if archive == "" {
			var latestErr error
			archive, latestErr = latestEncryptedBackup(config)
			if latestErr != nil {
				return failConsolidation(latestErr)
			}
		}
		if err := ValidateAbsolutePath(archive, "backup-archive"); err != nil || !within(archive, config.BackupRoot) || !strings.HasSuffix(archive, ".tar.gz.age") {
			return failConsolidation(fmt.Errorf("backup push requires an encrypted archive inside the backup directory"))
		}
		if err := verifyBackupDigest(archive); err != nil {
			return failConsolidation(err)
		}
		backupRes := BackupResult{OK: true, Archive: archive, Secrets: "excluded"}
		destinations, pushErr := PushBackup(ctx, config, backupRes, time.Now().UTC())
		if pushErr != nil {
			return failConsolidation(pushErr)
		}
		result = map[string]any{
			"ok":           true,
			"archive":      archive,
			"secrets":      "excluded",
			"destinations": destinations,
		}
	default:
		return failConsolidation(fmt.Errorf("unsupported consolidation action %q", action))
	}

	updatePhase("health-snapshot")
	_, _ = RefreshHealthSnapshot(ctx, config, compose, actionAllowsStopped(record.Action))

	ts := utcTimestamp(time.Now().UTC())
	if logFile != nil {
		_, _ = fmt.Fprintf(logFile, "[%s] consolidation action=%s completed\n", ts, action)
	}
	record.Status = ConsolidationStatusSucceeded
	record.Phase = "completed"
	record.UpdatedAt = ts
	record.CompletedAt = ts
	record.Result = result
	return writeConsolidationRecord(config, record)
}

func actionAllowsStopped(action string) bool {
	return action == "stop"
}

func executeDeployPipeline(
	ctx context.Context,
	config Config,
	compose Compose,
	action, component string,
	bootstrap bool,
	updatePhase func(string),
) (map[string]any, error) {
	now := time.Now().UTC()
	if bootstrap {
		updatePhase("bootstrap")
		if _, err := ValidateRuntime(ctx, config, compose.Runner); err != nil {
			return nil, err
		}
		if _, err := BootstrapContext(ctx, config, false, now, compose); err != nil {
			return nil, fmt.Errorf("runtime bootstrap failed: %w", err)
		}
		updatePhase("profile-deploy")
		rollbackPaths := []string{
			runtimeRelativePath(config, filepath.Join(config.DataRoot, "config.yaml")),
			runtimeRelativePath(config, filepath.Join(config.DataRoot, "AGENTS.md")),
			runtimeRelativePath(config, filepath.Join(config.DataRoot, "SOUL.md")),
			runtimeRelativePath(config, config.MetaRoot),
		}
		backup, err := CreateRollback(config, "profile-update", now, rollbackPaths...)
		if err != nil {
			return nil, err
		}
		if _, err := NewProfileOperator(config).Sync(); err != nil {
			_ = RecordChange(config, "profile", "failed", backup.Archive, "profile synchronization failed", now)
			return nil, fmt.Errorf("profile deployment failed: %w", err)
		}
		_ = RecordChange(config, "profile", "ok", backup.Archive, "profile assets synchronized", now)
	}

	incomingSecret := filepath.Join(config.MetaRoot, ".incoming", "secrets.env")
	if info, err := os.Stat(incomingSecret); err == nil && info.Mode().IsRegular() {
		updatePhase("auth-rotate")
		rotErr := RotateAuth(config, incomingSecret, now)
		_ = os.Remove(incomingSecret)
		if rotErr != nil {
			return nil, fmt.Errorf("stage secret source: %w", rotErr)
		}
	}
	incomingAttachments := filepath.Join(config.MetaRoot, ".incoming", "attachments")
	if entries, err := os.ReadDir(incomingAttachments); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".toml") {
				continue
			}
			host := strings.TrimSuffix(entry.Name(), ".toml")
			sourcePath := filepath.Join(incomingAttachments, entry.Name())
			updatePhase("attachment-rotate-" + host)
			rotErr := RotateAttachment(config, host, sourcePath, now)
			_ = os.Remove(sourcePath)
			if rotErr != nil {
				return nil, fmt.Errorf("stage attachment source for host %q: %w", host, rotErr)
			}
		}
		_ = os.Remove(incomingAttachments)
	}

	if action == "deploy" || action == "start" || action == "restart" {
		updatePhase("attachments-generate")
		if err := GenerateAttachmentsContext(ctx, config, compose); err != nil {
			return nil, fmt.Errorf("attachment Compose generation failed: %w", err)
		}
	}
	if action == "restart" {
		updatePhase("profile-sync")
		if _, err := NewProfileOperator(config).Sync(); err != nil {
			return nil, fmt.Errorf("profile synchronization failed: %w", err)
		}
	}

	updatePhase("compose-" + action)
	forceRecreate := config.LochoRelayConfig != "" || config.LochoRelaySecrets != ""
	deployRes, err := Deploy(ctx, config, compose, DeployOptions{
		Action:        action,
		Component:     component,
		ForceStart:    action == "start" || action == "restart",
		ForceRecreate: forceRecreate,
	}, time.Now().UTC())
	if err != nil {
		return nil, err
	}

	updatePhase("backup-schedule")
	if action == "stop" || !config.BackupScheduleEnabled {
		if _, err := RemoveBackupScheduleContext(ctx, config, compose); err != nil {
			return nil, fmt.Errorf("backup scheduler reconciliation failed: %w", err)
		}
	} else {
		if _, err := InstallBackupScheduleContext(ctx, config, time.Now().UTC()); err != nil {
			return nil, fmt.Errorf("backup scheduler reconciliation failed: %w", err)
		}
	}

	if action == "deploy" {
		updatePhase("profile-sync")
		if _, err := NewProfileOperator(config).Sync(); err != nil {
			return nil, fmt.Errorf("profile synchronization failed: %w", err)
		}
	}

	if action == "stop" {
		_ = StopReconcilerDaemon(config)
	} else if deployRes.State == stateRunning {
		_ = EnsureReconcilerDaemon(config)
	}

	return map[string]any{
		"ok":     deployRes.OK,
		"action": deployRes.Action,
		"state":  deployRes.State,
		"backup": deployRes.Backup,
	}, nil
}

// CachedHealthSnapshot stores the latest healthcheck report in <MetaRoot>/health.json
// so `openlia status` can respond without running expensive container exec probes.
type CachedHealthSnapshot struct {
	Schema     int          `json:"schema"`
	RecordedAt string       `json:"recorded_at"`
	Health     HealthResult `json:"health"`
}

// ReconcileResult reports actions taken during a target reconciliation tick.
type ReconcileResult struct {
	Schema            int      `json:"schema"`
	OK                bool     `json:"ok"`
	State             string   `json:"state"`
	RestartedServices []string `json:"restarted_services,omitempty"`
	LochoHostHealed   bool     `json:"locho_host_healed,omitempty"`
	BackupTriggered   bool     `json:"backup_triggered,omitempty"`
	BackupArchive     string   `json:"backup_archive,omitempty"`
	RecordedAt        string   `json:"recorded_at"`
}

// HealthSnapshotPath returns the path to the cached health JSON file.
func HealthSnapshotPath(metaRoot string) string {
	return filepath.Join(metaRoot, "health.json")
}

// WriteHealthSnapshot atomically writes the latest HealthResult to <MetaRoot>/health.json.
func WriteHealthSnapshot(config Config, health HealthResult, now time.Time) error {
	if config.MetaRoot == "" {
		return nil
	}
	info, err := os.Stat(config.MetaRoot)
	if err != nil || !info.IsDir() {
		return nil
	}
	cleanHealth := health
	cleanHealth.Cached = false
	cleanHealth.CachedAt = ""
	cleanHealth.Consolidation = nil
	snapshot := CachedHealthSnapshot{
		Schema:     1,
		RecordedAt: utcTimestamp(now),
		Health:     cleanHealth,
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	path := HealthSnapshotPath(config.MetaRoot)
	if err := AtomicWriteFile(path, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return ensureRuntimeOwner(path, config.RuntimeUID, config.RuntimeGID, 0o600)
}

// ReadHealthSnapshot reads the cached health snapshot if present and still valid
// against the current stack state.
func ReadHealthSnapshot(config Config, allowStopped bool) (*CachedHealthSnapshot, error) {
	path := HealthSnapshotPath(config.MetaRoot)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var snapshot CachedHealthSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil || snapshot.Schema != 1 {
		return nil, nil
	}
	currentState, err := ReadState(config)
	if err != nil || snapshot.Health.State != currentState {
		return nil, nil
	}
	if currentState == stateStopped && !allowStopped {
		// Recompute if caller requires running state but cached snapshot allowed stopped.
		for _, chk := range snapshot.Health.Checks {
			if chk.Name == "expected_running" && !chk.OK {
				return &snapshot, nil
			}
		}
		return nil, nil
	}
	return &snapshot, nil
}

// RefreshHealthSnapshot runs a live Healthcheck and persists the snapshot.
func RefreshHealthSnapshot(ctx context.Context, config Config, compose Compose, allowStopped bool) (HealthResult, error) {
	return Healthcheck(ctx, config, compose, allowStopped, false)
}

// HealthcheckCached returns the cached health snapshot when available (unless
// live or providerCheck is requested), attaching any active/recent ConsolidationRecord.
func HealthcheckCached(ctx context.Context, config Config, compose Compose, allowStopped, providerCheck, preferCached bool) (HealthResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return HealthResult{}, err
	}
	consolidation, _ := ReadConsolidation(config)
	if preferCached && !providerCheck {
		if snapshot, err := ReadHealthSnapshot(config, allowStopped); err == nil && snapshot != nil {
			res := snapshot.Health
			res.Cached = true
			res.CachedAt = snapshot.RecordedAt
			res.Consolidation = consolidation
			return res, nil
		}
	}
	res, err := Healthcheck(ctx, config, compose, allowStopped, providerCheck)
	if err != nil {
		return res, err
	}
	res.Consolidation = consolidation
	return res, nil
}

// ReconcileTick performs one non-blocking target reconciliation pass:
//  1. Ensures expected running Compose services are up when stack-state == "running".
//  2. Heals locho-host if hermes container IP changed and endpoints became stale.
//  3. Evaluates scheduled backups if enabled.
//  4. Refreshes the cached health snapshot (<MetaRoot>/health.json).
func ReconcileTick(ctx context.Context, config Config, compose Compose, now time.Time) (ReconcileResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return ReconcileResult{}, err
	}
	state, err := ReadState(config)
	if err != nil {
		return ReconcileResult{}, err
	}
	res := ReconcileResult{
		Schema:     1,
		OK:         true,
		State:      state,
		RecordedAt: utcTimestamp(now),
	}

	if state == stateRunning {
		if configured, cfgErr := compose.Run(ctx, "config", "--services"); cfgErr == nil {
			running := map[string]bool{}
			if psOut, psErr := compose.Run(ctx, "ps", "--services", "--filter", "status=running"); psErr == nil {
				for _, svc := range strings.Split(strings.TrimSpace(string(psOut.Stdout)), "\n") {
					if svc = strings.TrimSpace(svc); svc != "" {
						running[svc] = true
					}
				}
			}
			for _, svc := range strings.Split(strings.TrimSpace(string(configured.Stdout)), "\n") {
				svc = strings.TrimSpace(svc)
				if svc == "" || svc == "backup-scheduler" {
					continue
				}
				if !running[svc] {
					if _, startErr := compose.Run(ctx, "up", "-d", "--no-deps", svc); startErr == nil {
						res.RestartedServices = append(res.RestartedServices, svc)
						running[svc] = true
					} else {
						res.OK = false
					}
				}
			}
			if config.LochoHostEnabled && running["hermes"] && !lochoHostHealthy(ctx, config, compose) {
				if _, healErr := compose.Run(ctx, "up", "-d", "--no-deps", "--force-recreate", "locho-host"); healErr == nil {
					res.LochoHostHealed = true
				} else {
					res.OK = false
				}
			}
		}
	}

	if config.BackupScheduleEnabled && config.BackupRecipient != "" {
		if backupRes, ran, tickErr := BackupScheduleTick(ctx, config, now); tickErr == nil && ran {
			res.BackupTriggered = true
			res.BackupArchive = backupRes.Archive
		}
	}

	_, _ = RefreshHealthSnapshot(ctx, config, compose, state != stateRunning)
	return res, nil
}

// ReconcilerLockPath returns the flock file path used to ensure a single reconciler daemon.
func ReconcilerLockPath(metaRoot string) string {
	return filepath.Join(metaRoot, "reconciler.lock")
}

// ReconcilerPIDPath returns the PID file path for the active reconciler daemon.
func ReconcilerPIDPath(metaRoot string) string {
	return filepath.Join(metaRoot, "reconciler.pid")
}

// EnsureReconcilerDaemon starts the detached background reconciler daemon if it is not already running.
func EnsureReconcilerDaemon(config Config) error {
	if config.MetaRoot == "" || os.Getenv("OPENLIA_DISABLE_RECONCILER_DAEMON") == "1" {
		return nil
	}
	exe, err := os.Executable()
	if err != nil || strings.HasSuffix(exe, ".test") {
		return nil
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	lockFile, err := os.OpenFile(ReconcilerLockPath(config.MetaRoot), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	if flockErr := unix.Flock(int(lockFile.Fd()), unix.LOCK_EX|unix.LOCK_NB); flockErr != nil {
		_ = lockFile.Close()
		// Already running.
		return nil
	}
	_ = unix.Flock(int(lockFile.Fd()), unix.LOCK_UN)
	_ = lockFile.Close()

	_ = WriteOperatorConfig(config)
	cmd := exec.Command(exe, "reconcile", "--daemon")
	cmd.Env = append(os.Environ(),
		"OPENLIA_OPERATOR_CONFIG_FILE="+OperatorConfigPath(config.MetaRoot),
		"OPENLIA_INTERNAL_OPERATOR=1",
	)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

// StopReconcilerDaemon stops the background reconciler daemon if running.
func StopReconcilerDaemon(config Config) error {
	if config.MetaRoot == "" {
		return nil
	}
	pidPath := ReconcilerPIDPath(config.MetaRoot)
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return nil
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err == nil && pid > 0 && pid != os.Getpid() && isProcessAlive(pid) {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	_ = os.Remove(pidPath)
	return nil
}

func tryAcquireOperationFlock(config Config) (func(), bool) {
	lockPath := os.Getenv("OPENLIA_OPERATION_LOCK")
	if lockPath == "" {
		lockPath = config.InstallRoot + ".operation.lock"
	}
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, false
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, false
	}
	return func() {
		_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
		_ = file.Close()
	}, true
}

// RunReconcilerDaemon runs a singleton periodic reconciliation loop on the target host
// while the deployment stack state remains "running".
func RunReconcilerDaemon(ctx context.Context, config Config, interval time.Duration) error {
	if interval <= 0 {
		interval = 60 * time.Second
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	lockFile, err := os.OpenFile(ReconcilerLockPath(config.MetaRoot), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open reconciler lock: %w", err)
	}
	defer lockFile.Close()
	if err := unix.Flock(int(lockFile.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return nil
		}
		return fmt.Errorf("acquire reconciler lock: %w", err)
	}
	defer func() {
		_ = unix.Flock(int(lockFile.Fd()), unix.LOCK_UN)
	}()

	pidPath := ReconcilerPIDPath(config.MetaRoot)
	_ = AtomicWriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
	defer func() {
		_ = os.Remove(pidPath)
	}()

	sigCtx, stopSignals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	runOnce := func() bool {
		cfg := config
		if loaded, loadErr := loadConfigFromFile(OperatorConfigPath(config.MetaRoot)); loadErr == nil {
			cfg = loaded
		}
		state, stateErr := ReadState(cfg)
		if stateErr != nil || state != stateRunning {
			return false
		}
		unlock, acquired := tryAcquireOperationFlock(cfg)
		if !acquired {
			// Skip tick while a mutating operation owns operation.lock.
			return true
		}
		defer unlock()
		_, _ = ReconcileTick(sigCtx, cfg, NewCompose(cfg, nil), time.Now().UTC())
		return true
	}

	if !runOnce() {
		return nil
	}
	for {
		select {
		case <-sigCtx.Done():
			return nil
		case <-ticker.C:
			if !runOnce() {
				return nil
			}
		}
	}
}
