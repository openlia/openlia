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
	cleanHealth.Job = nil
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
// live or providerCheck is requested), attaching any active/recent JobRecord.
func HealthcheckCached(ctx context.Context, config Config, compose Compose, allowStopped, providerCheck, preferCached bool) (HealthResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return HealthResult{}, err
	}
	job, _ := ReadCurrentJob(config)
	if preferCached && !providerCheck {
		if snapshot, err := ReadHealthSnapshot(config, allowStopped); err == nil && snapshot != nil {
			res := snapshot.Health
			res.Cached = true
			res.CachedAt = snapshot.RecordedAt
			res.Job = job
			return res, nil
		}
	}
	res, err := Healthcheck(ctx, config, compose, allowStopped, providerCheck)
	if err != nil {
		return res, err
	}
	res.Job = job
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
