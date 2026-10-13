package operator

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// PruneBackups retains the most recent keepCount durable and rollback archives
// plus auxiliary backup files in config.BackupRoot, removing older ones.
func PruneBackups(config Config, keepCount int) ([]string, error) {
	if err := config.ValidatePaths(); err != nil {
		return nil, err
	}
	unlock, err := acquireBackupLock(context.Background(), config)
	if err != nil {
		return nil, err
	}
	defer unlock()
	return pruneBackups(config, keepCount)
}

func acquireBackupLock(ctx context.Context, config Config) (func(), error) {
	if err := EnsureDir(config.BackupRoot, 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(config.BackupRoot, ".operation.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open backup operation lock: %w", err)
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
			return nil, fmt.Errorf("acquire backup operation lock: %w", err)
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

func pruneBackups(config Config, keepCount int) ([]string, error) {
	if keepCount <= 0 {
		keepCount = 5
	}
	if err := config.ValidatePaths(); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(config.BackupRoot); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}

	entries, err := os.ReadDir(config.BackupRoot)
	if err != nil {
		return nil, err
	}

	type fileItem struct {
		name    string
		path    string
		modTime time.Time
	}

	var archives []fileItem
	var rollbacks []fileItem
	var composeFiles []fileItem
	var auxiliary []fileItem
	var preRestores []fileItem

	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		name := entry.Name()
		fullPath := filepath.Join(config.BackupRoot, name)

		if entry.Type().IsRegular() && strings.HasPrefix(name, "openlia-") && strings.HasSuffix(name, ".tar.gz.age") {
			archives = append(archives, fileItem{name: name, path: fullPath, modTime: info.ModTime()})
		} else if entry.Type().IsRegular() && strings.HasPrefix(name, "rollback-") && strings.HasSuffix(name, ".tar.gz") {
			rollbacks = append(rollbacks, fileItem{name: name, path: fullPath, modTime: info.ModTime()})
		} else if entry.Type().IsRegular() && strings.HasPrefix(name, "compose-generated-") {
			composeFiles = append(composeFiles, fileItem{name: name, path: fullPath, modTime: info.ModTime()})
		} else if entry.Type().IsRegular() && (strings.HasPrefix(name, "auth-secret-") || strings.HasPrefix(name, "locho-")) {
			auxiliary = append(auxiliary, fileItem{name: name, path: fullPath, modTime: info.ModTime()})
		} else if strings.HasPrefix(name, "pre-restore-") {
			preRestores = append(preRestores, fileItem{name: name, path: fullPath, modTime: info.ModTime()})
		}
	}

	sortByNewest := func(items []fileItem) {
		sort.Slice(items, func(i, j int) bool {
			if items[i].modTime.Equal(items[j].modTime) {
				return items[i].name > items[j].name
			}
			return items[i].modTime.After(items[j].modTime)
		})
	}

	sortByNewest(archives)
	sortByNewest(rollbacks)
	sortByNewest(composeFiles)
	sortByNewest(auxiliary)
	sortByNewest(preRestores)

	var removed []string
	if len(archives) > keepCount {
		for _, item := range archives[keepCount:] {
			if err := os.Remove(item.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return removed, err
			}
			removed = append(removed, item.name)
			jsonPath := item.path + ".json"
			if _, statErr := os.Lstat(jsonPath); statErr == nil {
				_ = os.Remove(jsonPath)
			}
		}
	}
	if len(rollbacks) > keepCount {
		for _, item := range rollbacks[keepCount:] {
			if err := os.Remove(item.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return removed, err
			}
			removed = append(removed, item.name)
			_ = os.Remove(item.path + ".json")
		}
	}

	if len(composeFiles) > keepCount {
		for _, item := range composeFiles[keepCount:] {
			if err := os.Remove(item.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return removed, err
			}
			removed = append(removed, item.name)
		}
	}
	if len(auxiliary) > keepCount {
		for _, item := range auxiliary[keepCount:] {
			if err := os.Remove(item.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return removed, err
			}
			removed = append(removed, item.name)
		}
	}

	if len(preRestores) > keepCount {
		for _, item := range preRestores[keepCount:] {
			if err := os.RemoveAll(item.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return removed, err
			}
			removed = append(removed, item.name)
		}
	}

	return removed, nil
}
