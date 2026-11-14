package operator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	JobStatusQueued    = "queued"
	JobStatusRunning   = "running"
	JobStatusSucceeded = "succeeded"
	JobStatusFailed    = "failed"
)

// JobRecord represents an asynchronous target operation managed by openlia-operator.
type JobRecord struct {
	Schema      int            `json:"schema"`
	ID          string         `json:"id"`
	Kind        string         `json:"kind"`
	Action      string         `json:"action,omitempty"`
	Status      string         `json:"status"`
	Phase       string         `json:"phase,omitempty"`
	CreatedAt   string         `json:"created_at"`
	StartedAt   string         `json:"started_at,omitempty"`
	UpdatedAt   string         `json:"updated_at"`
	CompletedAt string         `json:"completed_at,omitempty"`
	PID         int            `json:"pid,omitempty"`
	Error       string         `json:"error,omitempty"`
	LogTail     string         `json:"log_tail,omitempty"`
	Result      map[string]any `json:"result,omitempty"`
}

// JobStartResult is the immediate response returned when a job is dispatched.
type JobStartResult struct {
	Schema int       `json:"schema"`
	OK     bool      `json:"ok"`
	Async  bool      `json:"async"`
	JobID  string    `json:"job_id"`
	Kind   string    `json:"kind"`
	Action string    `json:"action,omitempty"`
	Status string    `json:"status"`
	Phase  string    `json:"phase,omitempty"`
	Job    JobRecord `json:"job"`
}

// JobsDir returns the directory under MetaRoot where job records and logs live.
func JobsDir(config Config) string {
	return filepath.Join(config.MetaRoot, "jobs")
}

// JobFilePath returns the JSON state path for a specific job ID.
func JobFilePath(config Config, id string) string {
	return filepath.Join(JobsDir(config), id+".json")
}

// JobLogPath returns the log file path for a specific job ID.
func JobLogPath(config Config, id string) string {
	return filepath.Join(JobsDir(config), id+".log")
}

// CurrentJobPath returns the path to the latest/active job pointer file.
func CurrentJobPath(config Config) string {
	return filepath.Join(config.MetaRoot, "current-job.json")
}

func generateJobID(now time.Time) string {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("job-%s-%d", now.UTC().Format("20060102T150405Z"), os.Getpid())
	}
	return fmt.Sprintf("job-%s-%s", now.UTC().Format("20060102T150405Z"), hex.EncodeToString(buf))
}

func writeJobRecord(config Config, record JobRecord) error {
	if err := EnsureDir(JobsDir(config), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	jobPath := JobFilePath(config, record.ID)
	if err := AtomicWriteFile(jobPath, data, 0o600); err != nil {
		return err
	}
	_ = ensureRuntimeOwner(jobPath, config.RuntimeUID, config.RuntimeGID, 0o600)
	currentPath := CurrentJobPath(config)
	if err := AtomicWriteFile(currentPath, data, 0o600); err != nil {
		return err
	}
	_ = ensureRuntimeOwner(currentPath, config.RuntimeUID, config.RuntimeGID, 0o600)
	return nil
}

// ReadCurrentJob reads the most recent job record from <MetaRoot>/current-job.json,
// reconciling stale running states if the worker process is no longer alive.
func ReadCurrentJob(config Config) (*JobRecord, error) {
	return readAndReconcileJobFile(config, CurrentJobPath(config))
}

// ReadJob reads a specific job record by ID.
func ReadJob(config Config, id string) (*JobRecord, error) {
	if err := ValidateSafeComponent(id, "job-id"); err != nil {
		return nil, err
	}
	return readAndReconcileJobFile(config, JobFilePath(config, id))
}

// ReadJobLog returns the redacted log contents for a specific job ID (or the current job if id == "").
func ReadJobLog(config Config, id string) (string, error) {
	if id == "" {
		cur, err := ReadCurrentJob(config)
		if err != nil {
			return "", err
		}
		if cur == nil {
			return "", nil
		}
		id = cur.ID
	}
	if err := ValidateSafeComponent(id, "job-id"); err != nil {
		return "", err
	}
	data, err := os.ReadFile(JobLogPath(config, id))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return formatError(errors.New(string(data))).Error(), nil
}

func readJobLogTail(config Config, id string, maxLines int) string {
	text, err := ReadJobLog(config, id)
	if err != nil || strings.TrimSpace(text) == "" {
		return ""
	}
	lines := strings.Split(strings.TrimRight(text, "\r\n"), "\n")
	if maxLines > 0 && len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return strings.Join(lines, "\n")
}

// PruneJobs removes old completed job records and logs, keeping the most recent `keep` jobs.
func PruneJobs(config Config, keep int) {
	if keep <= 0 {
		keep = 20
	}
	entries, err := os.ReadDir(JobsDir(config))
	if err != nil {
		return
	}
	var jobIDs []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		jobIDs = append(jobIDs, strings.TrimSuffix(entry.Name(), ".json"))
	}
	if len(jobIDs) <= keep {
		return
	}
	// Job IDs start with job-YYYYMMDDTHHMMSSZ-*, so lexical sort is chronological.
	current, _ := ReadCurrentJob(config)
	toRemove := len(jobIDs) - keep
	for _, id := range jobIDs {
		if toRemove <= 0 {
			break
		}
		if current != nil && current.ID == id {
			continue
		}
		rec, readErr := ReadJob(config, id)
		if readErr == nil && rec != nil && (rec.Status == JobStatusRunning || rec.Status == JobStatusQueued) {
			continue
		}
		_ = os.Remove(JobFilePath(config, id))
		_ = os.Remove(JobLogPath(config, id))
		toRemove--
	}
}

func readAndReconcileJobFile(config Config, path string) (*JobRecord, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record JobRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, err
	}
	if (record.Status == JobStatusRunning || record.Status == JobStatusQueued) && record.PID > 0 {
		if !isProcessAlive(record.PID) {
			// Re-read the job file in case the worker just wrote its terminal state.
			if freshData, readErr := os.ReadFile(JobFilePath(config, record.ID)); readErr == nil {
				var fresh JobRecord
				if json.Unmarshal(freshData, &fresh) == nil && fresh.Status != JobStatusRunning && fresh.Status != JobStatusQueued {
					return &fresh, nil
				}
			}
			now := utcTimestamp(time.Now().UTC())
			record.Status = JobStatusFailed
			record.UpdatedAt = now
			record.CompletedAt = now
			if record.Error == "" {
				record.Error = "job worker process terminated unexpectedly"
			}
			_ = writeJobRecord(config, record)
		}
	}
	return &record, nil
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// StartJob validates prerequisites, persists the target operator config, and
// launches a detached background worker process to execute the requested job.
func StartJob(ctx context.Context, config Config, kind string, args []string, now time.Time) (JobStartResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return JobStartResult{}, err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return JobStartResult{}, err
	}
	if err := EnsureDir(JobsDir(config), 0o700); err != nil {
		return JobStartResult{}, err
	}

	if current, err := ReadCurrentJob(config); err == nil && current != nil {
		if (current.Status == JobStatusRunning || current.Status == JobStatusQueued) && isProcessAlive(current.PID) {
			return JobStartResult{}, fmt.Errorf("another OpenLia operation job (%s, kind=%s, phase=%s) is already running", current.ID, current.Kind, current.Phase)
		}
	}
	if err := probeOperationFlock(config); err != nil {
		return JobStartResult{}, err
	}

	action, _, _, err := parseJobArgs(kind, args)
	if err != nil {
		return JobStartResult{}, err
	}

	if err := WriteOperatorConfig(config); err != nil {
		return JobStartResult{}, fmt.Errorf("persist target operator config: %w", err)
	}

	stamp := utcTimestamp(now)
	record := JobRecord{
		Schema:    1,
		ID:        generateJobID(now),
		Kind:      kind,
		Action:    action,
		Status:    JobStatusQueued,
		Phase:     "queued",
		CreatedAt: stamp,
		UpdatedAt: stamp,
	}
	if err := writeJobRecord(config, record); err != nil {
		return JobStartResult{}, fmt.Errorf("create job record: %w", err)
	}

	pid, err := spawnDetachedWorker(config, record.ID, kind, args)
	if err != nil {
		record.Status = JobStatusFailed
		record.Error = err.Error()
		record.CompletedAt = utcTimestamp(time.Now().UTC())
		_ = writeJobRecord(config, record)
		return JobStartResult{}, fmt.Errorf("launch detached job worker: %w", err)
	}
	if pid > 0 {
		// Re-read in case an in-process worker already completed before we write PID.
		if latest, readErr := ReadJob(config, record.ID); readErr == nil && latest != nil && (latest.Status == JobStatusSucceeded || latest.Status == JobStatusFailed) {
			record = *latest
		} else {
			record.PID = pid
			record.Status = JobStatusRunning
			record.StartedAt = stamp
			_ = writeJobRecord(config, record)
		}
	} else if latest, readErr := ReadJob(config, record.ID); readErr == nil && latest != nil {
		record = *latest
	}

	return JobStartResult{
		Schema: 1,
		OK:     true,
		Async:  true,
		JobID:  record.ID,
		Kind:   record.Kind,
		Action: record.Action,
		Status: record.Status,
		Phase:  record.Phase,
		Job:    record,
	}, nil
}

func spawnDetachedWorker(config Config, jobID, kind string, args []string) (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	// During unit tests (*.test binary) or when OPENLIA_INPROCESS_JOBS=1 is set,
	// run the job in a background goroutine rather than re-execing the test binary.
	if strings.HasSuffix(exe, ".test") || os.Getenv("OPENLIA_INPROCESS_JOBS") == "1" {
		done := make(chan struct{})
		go func() {
			close(done)
			_ = ExecuteJob(context.Background(), config, jobID, kind, args, time.Now().UTC())
		}()
		<-done
		return os.Getpid(), nil
	}

	logFile, err := os.OpenFile(JobLogPath(config, jobID), os.O_CREATE|os.O_WRONLY|os.O_TRUNC|os.O_APPEND, 0o600)
	if err != nil {
		return 0, err
	}
	defer logFile.Close()

	cmdArgs := append([]string{"job", "run", jobID, kind}, args...)
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

func parseJobArgs(kind string, args []string) (action, component string, bootstrap bool, err error) {
	switch kind {
	case "deploy":
		action = "deploy"
		component = "all"
		for i := 0; i < len(args); i++ {
			switch args[i] {
			case "deploy", "start", "stop", "restart":
				action = args[i]
			case "--action":
				if i+1 >= len(args) {
					return "", "", false, fmt.Errorf("--action requires a value")
				}
				i++
				action = args[i]
			case "--component":
				if i+1 >= len(args) {
					return "", "", false, fmt.Errorf("--component requires a value")
				}
				i++
				component = args[i]
			case "--bootstrap":
				bootstrap = true
			case "--start":
				// compatibility flag
			default:
				return "", "", false, fmt.Errorf("unknown deploy job argument %q", args[i])
			}
		}
		if action != "deploy" && action != "start" && action != "stop" && action != "restart" {
			return "", "", false, fmt.Errorf("invalid deploy job action %q", action)
		}
		return action, component, bootstrap, nil
	case "backup-create":
		return "create", "", false, nil
	case "backup-push":
		return "push", "", false, nil
	case "auth-rotate":
		return "auth-rotate", "", false, nil
	case "attachment-rotate":
		if len(args) == 0 || strings.HasPrefix(args[0], "-") {
			return "", "", false, fmt.Errorf("attachment-rotate job requires HOST")
		}
		if err := ValidateSafeComponent(args[0], "host"); err != nil {
			return "", "", false, err
		}
		return "attachment-rotate", args[0], false, nil
	default:
		return "", "", false, fmt.Errorf("unsupported job kind %q", kind)
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

// ExecuteJob runs the full target operation pipeline for a job inside the
// detached worker process, updating the job state file at each phase.
func ExecuteJob(ctx context.Context, config Config, jobID, kind string, args []string, now time.Time) error {
	if err := ValidateSafeComponent(jobID, "job-id"); err != nil {
		return err
	}
	existing, err := readAndReconcileJobFile(config, JobFilePath(config, jobID))
	var record JobRecord
	if err == nil && existing != nil {
		record = *existing
	} else {
		record = JobRecord{
			Schema:    1,
			ID:        jobID,
			Kind:      kind,
			CreatedAt: utcTimestamp(now),
		}
	}
	record.Status = JobStatusRunning
	record.PID = os.Getpid()
	if record.StartedAt == "" {
		record.StartedAt = utcTimestamp(now)
	}
	record.UpdatedAt = utcTimestamp(now)
	_ = writeJobRecord(config, record)

	_ = EnsureDir(JobsDir(config), 0o700)
	logFile, _ := os.OpenFile(JobLogPath(config, jobID), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if logFile != nil {
		defer logFile.Close()
		_, _ = fmt.Fprintf(logFile, "[%s] job=%s kind=%s started\n", utcTimestamp(now), jobID, kind)
	}

	failJob := func(runErr error) error {
		ts := utcTimestamp(time.Now().UTC())
		errMsg := formatError(runErr).Error()
		if logFile != nil {
			_, _ = fmt.Fprintf(logFile, "[%s] error=%s\n", ts, errMsg)
			_ = logFile.Sync()
		}
		record.Status = JobStatusFailed
		record.UpdatedAt = ts
		record.CompletedAt = ts
		record.Error = errMsg
		record.LogTail = readJobLogTail(config, jobID, 20)
		_ = writeJobRecord(config, record)
		PruneJobs(config, 20)
		return runErr
	}

	updatePhase := func(phase string) {
		ts := utcTimestamp(time.Now().UTC())
		if logFile != nil {
			_, _ = fmt.Fprintf(logFile, "[%s] phase=%s\n", ts, phase)
		}
		record.Phase = phase
		record.UpdatedAt = ts
		_ = writeJobRecord(config, record)
	}

	unlock, lockErr := acquireOperationFlock(ctx, config)
	if lockErr != nil {
		return failJob(lockErr)
	}
	defer unlock()

	var runner CommandRunner
	if logFile != nil {
		runner = &ExecRunner{Stderr: logFile}
	}
	compose := NewCompose(config, runner)
	var result map[string]any

	switch kind {
	case "deploy":
		action, component, bootstrap, parseErr := parseJobArgs(kind, args)
		if parseErr != nil {
			return failJob(parseErr)
		}
		record.Action = action
		res, deployErr := executeDeployPipeline(ctx, config, compose, action, component, bootstrap, updatePhase)
		if deployErr != nil {
			return failJob(deployErr)
		}
		result = res
	case "backup-create":
		updatePhase("backup-create")
		reason := "manual"
		remaining, val, flagErr := consumeOptionalValue(args, "--reason")
		if flagErr != nil {
			return failJob(flagErr)
		}
		if val != "" {
			reason = val
		}
		if len(remaining) != 0 {
			return failJob(fmt.Errorf("backup create accepts --reason NAME"))
		}
		backupRes, createErr := createBackup(ctx, config, reason, time.Now().UTC(), &compose, false)
		if createErr != nil {
			return failJob(createErr)
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
			return failJob(pushErr)
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
			return failJob(fmt.Errorf("backup push accepts --archive PATH"))
		}
		if archive == "" {
			var latestErr error
			archive, latestErr = latestEncryptedBackup(config)
			if latestErr != nil {
				return failJob(latestErr)
			}
		}
		if err := ValidateAbsolutePath(archive, "backup-archive"); err != nil || !within(archive, config.BackupRoot) || !strings.HasSuffix(archive, ".tar.gz.age") {
			return failJob(fmt.Errorf("backup push requires an encrypted archive inside the backup directory"))
		}
		if err := verifyBackupDigest(archive); err != nil {
			return failJob(err)
		}
		backupRes := BackupResult{OK: true, Archive: archive, Secrets: "excluded"}
		destinations, pushErr := PushBackup(ctx, config, backupRes, time.Now().UTC())
		if pushErr != nil {
			return failJob(pushErr)
		}
		result = map[string]any{
			"ok":           true,
			"archive":      archive,
			"secrets":      "excluded",
			"destinations": destinations,
		}
	case "auth-rotate":
		updatePhase("auth-rotate")
		source, remaining, flagErr := stringFlag(args, "--source")
		if flagErr != nil || len(remaining) != 0 {
			return failJob(fmt.Errorf("auth-rotate accepts optional --source PATH"))
		}
		if source == "" {
			source = filepath.Join(config.MetaRoot, ".incoming", "secrets.env")
		}
		rotErr := rotateAuthWithCompose(ctx, config, compose, source, time.Now().UTC())
		if within(source, filepath.Join(config.MetaRoot, ".incoming")) || filepath.Base(source) == ".openlia-incoming" {
			_ = os.Remove(source)
		}
		if rotErr != nil {
			return failJob(rotErr)
		}
		result = map[string]any{
			"ok":            true,
			"action":        "auth-rotate",
			"secret_values": "redacted",
			"restart":       "hermes_only",
		}
	case "attachment-rotate":
		_, host, _, parseErr := parseJobArgs(kind, args)
		if parseErr != nil {
			return failJob(parseErr)
		}
		updatePhase("attachment-rotate-" + host)
		source, remaining, flagErr := stringFlag(args[1:], "--source")
		if flagErr != nil || len(remaining) != 0 {
			return failJob(fmt.Errorf("attachment-rotate requires HOST [--source PATH]"))
		}
		if source == "" {
			source = filepath.Join(config.MetaRoot, ".incoming", "attachments", host+".toml")
		}
		previousState, _ := ReadState(config)
		rotErr := RotateAttachmentContext(ctx, config, host, source, time.Now().UTC(), compose)
		if within(source, filepath.Join(config.MetaRoot, ".incoming")) || filepath.Base(source) == ".openlia-incoming" {
			_ = os.Remove(source)
		}
		if rotErr != nil {
			return failJob(rotErr)
		}
		restart := "deferred-until-deploy"
		if previousState == stateRunning {
			restart = "sidecar-only"
		}
		result = map[string]any{
			"ok":           true,
			"action":       "locho-rotate",
			"host":         host,
			"capabilities": "redacted",
			"restart":      restart,
		}
	default:
		return failJob(fmt.Errorf("unsupported job kind %q", kind))
	}

	updatePhase("health-snapshot")
	_, _ = RefreshHealthSnapshot(ctx, config, compose, actionAllowsStopped(record.Action))

	ts := utcTimestamp(time.Now().UTC())
	if logFile != nil {
		_, _ = fmt.Fprintf(logFile, "[%s] job=%s completed\n", ts, jobID)
	}
	record.Status = JobStatusSucceeded
	record.Phase = "completed"
	record.UpdatedAt = ts
	record.CompletedAt = ts
	record.Result = result
	err = writeJobRecord(config, record)
	PruneJobs(config, 20)
	return err
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
