package operator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	defaultBackupRetention = 5
	defaultBackupMaxBytes  = int64(10 << 30)
)

type backupRetentionState struct {
	Schema    int    `json:"schema"`
	UpdatedAt string `json:"updated_at"`
	LastError string `json:"last_error,omitempty"`
}

// PruneBackups retains the most recent keepCount durable and rollback archives
// plus auxiliary backup files in config.BackupRoot, removing older ones. The
// durable archive set also observes the configured soft byte budget.
func PruneBackups(config Config, keepCount int) ([]string, error) {
	if err := config.ValidatePaths(); err != nil {
		return nil, err
	}
	unlock, err := acquireBackupLock(context.Background(), config)
	if err != nil {
		return nil, err
	}
	defer unlock()
	removed, pruneErr := pruneBackups(config, keepCount)
	if stateErr := writeBackupRetentionState(config, pruneErr); stateErr != nil && pruneErr == nil {
		pruneErr = stateErr
	}
	return removed, pruneErr
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
		keepCount = defaultBackupRetention
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
		name      string
		path      string
		createdAt time.Time
		size      int64
		corrupt   bool
	}

	var archives []fileItem
	var rollbacks []fileItem
	var composeFiles []fileItem
	var auxiliary []fileItem
	var preRestores []fileItem
	archiveNames := make(map[string]struct{})

	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		name := entry.Name()
		fullPath := filepath.Join(config.BackupRoot, name)

		if entry.Type().IsRegular() && strings.HasPrefix(name, "openlia-") && strings.HasSuffix(name, ".tar.gz.age") {
			archiveNames[name] = struct{}{}
			archives = append(archives, fileItem{name: name, path: fullPath, createdAt: durableBackupCreatedAt(fullPath, info.ModTime()), size: backupPairSize(fullPath, info.Size())})
		} else if entry.Type().IsRegular() && strings.HasPrefix(name, "rollback-") && strings.HasSuffix(name, ".tar.gz") {
			rollbacks = append(rollbacks, fileItem{name: name, path: fullPath, createdAt: info.ModTime()})
		} else if entry.Type().IsRegular() && strings.HasPrefix(name, "compose-generated-") {
			composeFiles = append(composeFiles, fileItem{name: name, path: fullPath, createdAt: info.ModTime()})
		} else if entry.Type().IsRegular() && (strings.HasPrefix(name, "auth-secret-") || strings.HasPrefix(name, "locho-")) {
			auxiliary = append(auxiliary, fileItem{name: name, path: fullPath, createdAt: info.ModTime()})
		} else if strings.HasPrefix(name, "pre-restore-") {
			preRestores = append(preRestores, fileItem{name: name, path: fullPath, createdAt: info.ModTime()})
		}
	}
	var orphanMetadata []fileItem
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasPrefix(entry.Name(), "openlia-") || !strings.HasSuffix(entry.Name(), ".tar.gz.age.json") {
			continue
		}
		archiveName := strings.TrimSuffix(entry.Name(), ".json")
		if _, ok := archiveNames[archiveName]; !ok {
			info, infoErr := entry.Info()
			if infoErr == nil {
				orphanMetadata = append(orphanMetadata, fileItem{name: entry.Name(), path: filepath.Join(config.BackupRoot, entry.Name()), createdAt: info.ModTime(), size: info.Size()})
			}
		}
	}

	sortByNewest := func(items []fileItem) {
		sort.Slice(items, func(i, j int) bool {
			if items[i].createdAt.Equal(items[j].createdAt) {
				return items[i].name > items[j].name
			}
			return items[i].createdAt.After(items[j].createdAt)
		})
	}

	sortByNewest(archives)
	sortByNewest(rollbacks)
	sortByNewest(composeFiles)
	sortByNewest(auxiliary)
	sortByNewest(preRestores)
	sortByNewest(orphanMetadata)

	var removed []string
	for _, item := range orphanMetadata {
		if err := os.Remove(item.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return removed, err
		}
		removed = append(removed, item.name)
	}
	protectedIndex := -1
	if len(archives) > 0 {
		for index, item := range archives {
			if err := verifyDurableBackupArchive(item.path); err == nil {
				protectedIndex = index
				break
			}
			archives[index].corrupt = true
		}
		if protectedIndex < 0 {
			return removed, fmt.Errorf("no verified durable backup is available for retention")
		}
	}
	for archiveIndex, item := range archives {
		if archiveIndex == protectedIndex || (!item.corrupt && archiveIndex < keepCount) {
			continue
		}
		if err := removeBackupItem(item.path, true); err != nil {
			return removed, err
		}
		removed = append(removed, item.name)
	}
	retainedArchives := make([]fileItem, 0, keepCount+1)
	for index, item := range archives {
		if item.corrupt {
			continue
		}
		if index < keepCount || index == protectedIndex {
			retainedArchives = append(retainedArchives, item)
		}
	}
	maxBytes := config.BackupMaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultBackupMaxBytes
	}
	var archiveBytes int64
	for _, item := range retainedArchives {
		archiveBytes += item.size
	}
	// Keep the newest verified archive even when it is larger than the soft budget.
	protectedPath := ""
	if protectedIndex >= 0 {
		protectedPath = archives[protectedIndex].path
	}
	for index := len(retainedArchives) - 1; index >= 0 && archiveBytes > maxBytes; index-- {
		item := retainedArchives[index]
		if item.path == protectedPath {
			continue
		}
		if err := removeBackupItem(item.path, true); err != nil {
			return removed, err
		}
		archiveBytes -= item.size
		removed = append(removed, item.name)
	}
	if len(rollbacks) > keepCount {
		for _, item := range rollbacks[keepCount:] {
			if err := removeBackupItem(item.path, true); err != nil {
				return removed, err
			}
			removed = append(removed, item.name)
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

func durableBackupCreatedAt(path string, fallback time.Time) time.Time {
	data, err := os.ReadFile(path + ".json")
	if err == nil {
		var metadata backupMetadata
		if json.Unmarshal(data, &metadata) == nil {
			if created, parseErr := time.Parse(time.RFC3339Nano, metadata.CreatedAt); parseErr == nil {
				return created
			}
		}
	}
	return fallback
}

func verifyDurableBackupArchive(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("backup archive is not a regular file")
	}
	data, err := os.ReadFile(path + ".json")
	if err != nil {
		return err
	}
	var metadata backupMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return err
	}
	if metadata.Kind != "durable" || !metadata.Encrypted || metadata.Archive != filepath.Base(path) || metadata.SHA256 == "" {
		return fmt.Errorf("durable backup metadata is invalid")
	}
	return verifyBackupDigest(path)
}

func backupPairSize(path string, archiveSize int64) int64 {
	metadataSize := int64(0)
	if info, err := os.Stat(path + ".json"); err == nil {
		metadataSize = info.Size()
	}
	return archiveSize + metadataSize
}

func removeBackupItem(path string, removeMetadata bool) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if removeMetadata {
		if err := os.Remove(path + ".json"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func writeBackupRetentionState(config Config, pruneErr error) error {
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	state := backupRetentionState{Schema: 1, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if pruneErr != nil {
		state.LastError = pruneErr.Error()
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return AtomicWriteFile(filepath.Join(config.MetaRoot, "backup-retention-state.json"), append(data, '\n'), 0o600)
}

func readBackupRetentionState(config Config) (backupRetentionState, error) {
	data, err := os.ReadFile(filepath.Join(config.MetaRoot, "backup-retention-state.json"))
	if errors.Is(err, os.ErrNotExist) {
		return backupRetentionState{Schema: 1}, nil
	}
	if err != nil {
		return backupRetentionState{}, err
	}
	var state backupRetentionState
	if err := json.Unmarshal(data, &state); err != nil || state.Schema != 1 {
		return backupRetentionState{}, fmt.Errorf("backup retention state is invalid")
	}
	return state, nil
}
