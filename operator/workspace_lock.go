package operator

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

// AcquireWorkspaceLock acquires an exclusive OS file lock on the workspace mutation boundary.
// It ensures mutual exclusion between migration snapshot capture, migration apply,
// and other workspace modification operations.
func AcquireWorkspaceLock(ctx context.Context, config Config) (func(), error) {
	lockDir := config.RuntimeRoot
	if lockDir == "" {
		lockDir = filepath.Join(config.DataRoot, "..", "runtime")
	}
	if err := EnsureDir(lockDir, 0o700); err != nil {
		return nil, fmt.Errorf("ensure runtime root for lock: %w", err)
	}

	lockPath := filepath.Join(lockDir, "workspace.lock")
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open workspace lock file: %w", err)
	}

	for {
		err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return func() {
				_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
				_ = file.Close()
			}, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			_ = file.Close()
			return nil, fmt.Errorf("acquire workspace lock: %w", err)
		}

		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			_ = file.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
