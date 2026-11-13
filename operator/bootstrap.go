package operator

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

type BootstrapResult struct {
	OK           bool   `json:"ok"`
	Action       string `json:"action"`
	State        string `json:"state,omitempty"`
	RuntimeRoot  string `json:"runtime_root,omitempty"`
	SecretValues string `json:"secret_values,omitempty"`
}

// Bootstrap prepares runtime state without starting services. Docker checks
// belong to ValidateRuntime so filesystem tests do not need a Docker daemon.
func Bootstrap(config Config, checkOnly bool, now time.Time, composers ...Compose) (BootstrapResult, error) {
	return BootstrapContext(context.Background(), config, checkOnly, now, composers...)
}

func BootstrapContext(ctx context.Context, config Config, checkOnly bool, now time.Time, composers ...Compose) (BootstrapResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return BootstrapResult{}, err
	}
	if checkOnly {
		info, err := os.Stat(config.RuntimeRoot)
		if errors.Is(err, os.ErrNotExist) || (err == nil && !info.IsDir()) {
			return BootstrapResult{OK: false, Action: "bootstrap-check", RuntimeRoot: "missing"}, nil
		} else if err != nil {
			return BootstrapResult{}, err
		}
		return BootstrapResult{OK: true, Action: "bootstrap-check", RuntimeRoot: "configured"}, nil
	}

	for _, item := range []struct {
		path string
		mode fs.FileMode
	}{
		{config.RuntimeRoot, 0o700},
		{config.DataRoot, 0o700},
		{config.LochoRoot, 0o700},
		{config.SecretDir, 0o700},
		{config.BackupRoot, 0o700},
		{config.MetaRoot, 0o700},
		{filepath.Join(config.MetaRoot, "locks"), 0o700},
	} {
		if err := EnsureDir(item.path, item.mode); err != nil {
			return BootstrapResult{}, err
		}
	}
	if config.LochoHostEnabled {
		for _, path := range []string{config.LochoHostRoot, config.LochoHostStateRoot} {
			if err := ensureLochoHostDirectory(path, config.RuntimeUID, config.RuntimeGID); err != nil {
				return BootstrapResult{}, err
			}
		}
		if err := ensureLochoHostStateFiles(config.LochoHostStateRoot, config.RuntimeUID, config.RuntimeGID); err != nil {
			return BootstrapResult{}, err
		}
	}
	if err := ensureSecretDirectory(config); err != nil {
		return BootstrapResult{}, err
	}
	if _, err := os.Lstat(config.SecretFile); errors.Is(err, os.ErrNotExist) {
		if err := AtomicWriteFile(config.SecretFile, []byte("# Add KEY=VALUE lines through the operator's secret rotation workflow.\n"), 0o600); err != nil {
			return BootstrapResult{}, err
		}
	} else if err != nil {
		return BootstrapResult{}, err
	} else if info, err := os.Stat(config.SecretFile); err != nil || !info.Mode().IsRegular() {
		return BootstrapResult{}, fmt.Errorf("secret source path is not a regular file")
	} else if err := os.Chmod(config.SecretFile, 0o600); err != nil {
		return BootstrapResult{}, err
	}
	if err := ensureRuntimeOwner(config.SecretFile, config.RuntimeUID, config.RuntimeGID, 0o600); err != nil {
		return BootstrapResult{}, err
	}

	for _, dir := range []string{
		filepath.Join(config.DataRoot, "memories"),
		filepath.Join(config.DataRoot, "workspace"),
		filepath.Join(config.DataRoot, "skills"),
	} {
		if err := EnsureDir(dir, 0o700); err != nil {
			return BootstrapResult{}, err
		}
		if err := ensureRuntimeOwner(dir, config.RuntimeUID, config.RuntimeGID, 0o700); err != nil {
			return BootstrapResult{}, err
		}
	}

	if _, err := NewProfileOperator(config).Sync(); err != nil {
		return BootstrapResult{}, err
	}

	if _, err := os.Stat(config.StateFile); errors.Is(err, os.ErrNotExist) {
		if err := WriteState(config, stateNeverStarted); err != nil {
			return BootstrapResult{}, err
		}
	} else if err != nil {
		return BootstrapResult{}, err
	}
	if err := WriteRuntimeMetadata(config, now); err != nil {
		return BootstrapResult{}, err
	}

	var attachmentErr error
	if len(composers) > 0 {
		attachmentErr = GenerateAttachmentsContext(ctx, config, composers[0])
	} else {
		attachmentErr = GenerateAttachments(config)
	}
	if attachmentErr != nil {
		return BootstrapResult{}, attachmentErr
	}
	if err := RecordChange(config, "bootstrap", "ok", "", "runtime initialized", now); err != nil {
		return BootstrapResult{}, err
	}
	return BootstrapResult{OK: true, Action: "bootstrap", State: stateNeverStarted, SecretValues: "not_reported"}, nil
}

func ensureSecretDirectory(config Config) error {
	if err := EnsureDir(config.SecretDir, 0o700); err != nil {
		return err
	}
	return ensureRuntimeOwner(config.SecretDir, config.RuntimeUID, config.RuntimeGID, 0o700)
}

func copyOnce(source, destination string, mode fs.FileMode) error {
	if _, err := os.Lstat(source); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err := os.Lstat(destination); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return AtomicCopyFile(source, destination, mode)
}
