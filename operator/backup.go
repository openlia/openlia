package operator

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type BackupResult struct {
	OK             bool                      `json:"ok"`
	Archive        string                    `json:"archive"`
	Secrets        string                    `json:"secrets,omitempty"`
	Action         string                    `json:"action,omitempty"`
	State          string                    `json:"state,omitempty"`
	RetentionError string                    `json:"retention_error,omitempty"`
	Destinations   []BackupDestinationResult `json:"destinations,omitempty"`
}

type backupManifest struct {
	Schema       int      `json:"schema"`
	Kind         string   `json:"kind"`
	Reason       string   `json:"reason"`
	CreatedAt    string   `json:"created_at"`
	SecretValues string   `json:"secret_values"`
	Capabilities string   `json:"capabilities"`
	Components   []string `json:"components"`
	Exclusions   []string `json:"exclusions"`
}

type backupMetadata struct {
	Schema    int    `json:"schema"`
	Kind      string `json:"kind"`
	Archive   string `json:"archive"`
	SHA256    string `json:"sha256"`
	Encrypted bool   `json:"encrypted,omitempty"`
	Reason    string `json:"reason"`
	CreatedAt string `json:"created_at"`
	Secrets   string `json:"secrets"`
}

const (
	maxArchiveMembers    = 100000
	maxArchiveMemberSize = int64(1 << 30)
	maxArchiveTotalSize  = int64(8 << 30)
	maxArchivePathDepth  = 32
)

var errBackupSourceChanged = errors.New("backup source changed during live capture")

type backupArchiveLimits struct {
	members int
	total   int64
}

func (limits *backupArchiveLimits) add(name string, size int64, kind byte) error {
	cleanName := strings.TrimSuffix(name, "/")
	if !safeArchiveMember(cleanName) || size < 0 || (kind != tar.TypeDir && kind != tar.TypeReg && kind != tar.TypeSymlink) {
		return fmt.Errorf("backup generated an unsupported archive member")
	}
	if limits.members >= maxArchiveMembers || size > maxArchiveMemberSize || limits.total > maxArchiveTotalSize-size {
		return fmt.Errorf("backup archive exceeds safety limits")
	}
	limits.members++
	limits.total += size
	return nil
}

func CreateBackup(config Config, reason string, now time.Time, composers ...Compose) (BackupResult, error) {
	if config.BackupRecipient == "" {
		return BackupResult{}, fmt.Errorf("backup encryption recipient is required")
	}
	var compose *Compose
	if len(composers) > 0 {
		compose = &composers[0]
	}
	return createBackup(context.Background(), config, reason, now, compose, false)
}

// CreateScheduledBackup captures a portable durable backup while services
// remain online. The resulting archive is best-effort when writers modify
// files during collection, but archive validation still fails closed.
func CreateScheduledBackup(ctx context.Context, config Config, reason string, now time.Time) (BackupResult, error) {
	if config.BackupRecipient == "" {
		return BackupResult{}, fmt.Errorf("backup encryption recipient is required")
	}
	for attempt := 0; attempt < 3; attempt++ {
		result, err := createBackup(ctx, config, reason, now, nil, true)
		if !errors.Is(err, errBackupSourceChanged) || attempt == 2 {
			return result, err
		}
	}
	return BackupResult{}, errBackupSourceChanged
}

// CreateRollback captures only the explicitly named runtime-relative paths for
// an operation-scoped rollback. It never includes caches or
// unrelated Hermes state; auth rotation may explicitly include a protected
// secret file.
func CreateRollback(config Config, reason string, now time.Time, paths ...string) (BackupResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return BackupResult{}, err
	}
	unlock, err := acquireBackupLock(context.Background(), config)
	if err != nil {
		return BackupResult{}, err
	}
	defer unlock()
	if err := ValidateSafeComponent(reason, "rollback-reason"); err != nil {
		return BackupResult{}, err
	}
	if len(paths) == 0 {
		return BackupResult{}, fmt.Errorf("rollback requires at least one path")
	}
	if err := EnsureDir(config.BackupRoot, 0o700); err != nil {
		return BackupResult{}, err
	}
	stamp := now.UTC().Format("20060102T150405Z")
	temporary, err := os.CreateTemp(config.BackupRoot, ".rollback-*.tar.gz")
	if err != nil {
		return BackupResult{}, err
	}
	temporaryName := temporary.Name()
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(temporaryName)
		}
	}()
	compressor := gzip.NewWriter(temporary)
	archive := tar.NewWriter(compressor)
	secretRollback := false
	for _, path := range paths {
		if strings.Contains(path, "secrets/") || strings.HasPrefix(path, "secrets") {
			secretRollback = true
		}
	}
	secretStatus := "excluded"
	if secretRollback {
		secretStatus = "protected-rollback"
	}
	manifest := backupManifest{Schema: 2, Kind: "rollback", Reason: reason, CreatedAt: utcTimestamp(now), SecretValues: secretStatus, Capabilities: "excluded", Components: append([]string{}, paths...)}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return BackupResult{}, err
	}
	if err := writeTarFile(archive, "manifest.json", manifestData, 0o600); err != nil {
		return BackupResult{}, err
	}
	for _, relative := range paths {
		if !safeRuntimeRelativePath(relative) {
			return BackupResult{}, fmt.Errorf("rollback path is unsafe: %s", relative)
		}
		absolute := filepath.Join(config.RuntimeRoot, filepath.FromSlash(relative))
		if _, err := os.Lstat(absolute); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return BackupResult{}, err
		}
		if err := appendDurableTree(archive, filepath.ToSlash(relative), absolute, func(string, fs.DirEntry) bool { return true }); err != nil {
			return BackupResult{}, err
		}
	}
	if err := archive.Close(); err != nil {
		return BackupResult{}, err
	}
	if err := compressor.Close(); err != nil {
		return BackupResult{}, err
	}
	if err := temporary.Sync(); err != nil {
		return BackupResult{}, err
	}
	if err := temporary.Close(); err != nil {
		return BackupResult{}, err
	}
	if err := validateRestoreArchive(temporaryName); err != nil {
		return BackupResult{}, fmt.Errorf("rollback archive validation failed")
	}
	destination := filepath.Join(config.BackupRoot, fmt.Sprintf("rollback-%s-%d.tar.gz", stamp, os.Getpid()))
	if err := os.Rename(temporaryName, destination); err != nil {
		return BackupResult{}, err
	}
	removeTemporary = false
	if err := os.Chmod(destination, 0o600); err != nil {
		return BackupResult{}, err
	}
	digest, err := fileSHA256(destination)
	if err != nil {
		return BackupResult{}, err
	}
	metadata := backupMetadata{Schema: 2, Kind: "rollback", Archive: filepath.Base(destination), SHA256: digest, Reason: reason, CreatedAt: utcTimestamp(now), Secrets: secretStatus}
	data, err := json.Marshal(metadata)
	if err != nil {
		return BackupResult{}, err
	}
	if err := AtomicWriteFile(destination+".json", append(data, '\n'), 0o600); err != nil {
		return BackupResult{}, err
	}
	_, pruneErr := pruneBackups(config, config.BackupRetention)
	if stateErr := writeBackupRetentionState(config, pruneErr); stateErr != nil && pruneErr == nil {
		pruneErr = fmt.Errorf("record backup retention status: %w", stateErr)
	}
	result := BackupResult{OK: true, Archive: destination, Secrets: secretStatus, Action: "rollback"}
	if pruneErr != nil {
		result.RetentionError = pruneErr.Error()
	}
	return result, nil
}

func safeRuntimeRelativePath(value string) bool {
	return value != "" && !filepath.IsAbs(value) && safeArchiveMember(filepath.ToSlash(value))
}

func runtimeRelativePath(config Config, path string) string {
	relative, err := filepath.Rel(config.RuntimeRoot, path)
	if err != nil {
		return filepath.ToSlash(path)
	}
	return filepath.ToSlash(relative)
}

func createBackup(ctx context.Context, config Config, reason string, now time.Time, compose *Compose, live bool) (result BackupResult, err error) {
	if config.BackupRecipient == "" {
		return BackupResult{}, fmt.Errorf("backup encryption recipient is required")
	}
	unlock, err := acquireBackupLock(ctx, config)
	if err != nil {
		return BackupResult{}, err
	}
	defer unlock()
	return createBackupWithRestart(ctx, config, reason, now, compose, true, live)
}

func createBackupWithRestart(ctx context.Context, config Config, reason string, now time.Time, compose *Compose, restartServices, live bool) (result BackupResult, err error) {
	if err := config.ValidatePaths(); err != nil {
		return BackupResult{}, err
	}
	if err := ValidateSafeComponent(reason, "backup-reason"); err != nil {
		return BackupResult{}, err
	}
	if config.BackupRecipient == "" {
		return BackupResult{}, fmt.Errorf("backup encryption recipient is required")
	}
	if info, err := os.Lstat(config.DataRoot); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return BackupResult{}, fmt.Errorf("Hermes data directory is missing")
	}
	if err := EnsureDir(config.BackupRoot, 0o700); err != nil {
		return BackupResult{}, err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return BackupResult{}, err
	}
	if info, statErr := os.Lstat(config.MetaRoot); statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return BackupResult{}, fmt.Errorf("metadata directory is missing")
	}
	wasRunning := false
	uiWasRunning := false
	if !live && compose != nil && compose.ServiceRunning(ctx, "hermes") {
		if _, err := compose.Run(ctx, "stop", "hermes"); err != nil {
			return BackupResult{}, fmt.Errorf("cannot stop Hermes for a consistent backup")
		}
		wasRunning = true
	}
	if !live && compose != nil && config.WorkspaceUIHost != "" && compose.ServiceRunning(ctx, "workspace-ui") {
		if _, err := compose.Run(ctx, "stop", "workspace-ui"); err != nil {
			if wasRunning {
				_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "hermes")
			}
			return BackupResult{}, fmt.Errorf("cannot stop workspace UI for a consistent backup")
		}
		uiWasRunning = true
	}
	defer func() {
		if !restartServices {
			return
		}
		if !wasRunning && !uiWasRunning {
			return
		}
		if wasRunning {
			if res, restartErr := compose.Run(ctx, "up", "-d", "--no-deps", "hermes"); restartErr != nil {
				msg := strings.TrimSpace(string(res.Stderr))
				if msg == "" {
					msg = strings.TrimSpace(string(res.Stdout))
				}
				failure := fmt.Errorf("Hermes could not be restarted (%s): %w", msg, restartErr)
				if err == nil {
					err = fmt.Errorf("backup completed but %w", failure)
				} else {
					err = fmt.Errorf("%v; %w", err, failure)
				}
			}
		}
		if uiWasRunning {
			if res, restartErr := compose.Run(ctx, "up", "-d", "--no-deps", "workspace-ui"); restartErr != nil {
				msg := strings.TrimSpace(string(res.Stderr))
				if msg == "" {
					msg = strings.TrimSpace(string(res.Stdout))
				}
				failure := fmt.Errorf("workspace UI could not be restarted (%s): %w", msg, restartErr)
				if err == nil {
					err = fmt.Errorf("backup completed but %w", failure)
				} else {
					err = fmt.Errorf("%v; %w", err, failure)
				}
			}
		}
	}()
	stamp := now.UTC().Format("20060102T150405Z")
	encryptedTemporary, err := os.CreateTemp(config.BackupRoot, ".encrypted-*.age")
	if err != nil {
		return BackupResult{}, err
	}
	encryptedTemporaryName := encryptedTemporary.Name()
	removeEncryptedTemporary := true
	defer func() {
		if removeEncryptedTemporary {
			_ = os.Remove(encryptedTemporaryName)
		}
	}()
	encryptedWriter, err := newBackupEncryptWriter(encryptedTemporary, config.BackupRecipient)
	if err != nil {
		_ = encryptedTemporary.Close()
		return BackupResult{}, err
	}
	compressor := gzip.NewWriter(encryptedWriter)
	archive := tar.NewWriter(compressor)
	limits := &backupArchiveLimits{}
	defer func() {
		_ = archive.Close()
		_ = compressor.Close()
		_ = encryptedWriter.Close()
		_ = encryptedTemporary.Close()
	}()
	manifest := backupManifest{
		Schema:       2,
		Kind:         "durable",
		Reason:       reason,
		CreatedAt:    utcTimestamp(now),
		SecretValues: "excluded",
		Capabilities: "excluded",
		Components:   []string{"hermes", "meta"},
		Exclusions:   []string{"secrets", "caches", "bundled-skills", "logs"},
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return BackupResult{}, err
	}
	if len(manifestData) > 64*1024 {
		return BackupResult{}, fmt.Errorf("backup manifest exceeds safety limits")
	}
	if err := writeTarFile(archive, "manifest.json", manifestData, 0o600); err != nil {
		return BackupResult{}, err
	}
	bundledGroups := bundledSkillGroups(config.DataRoot)
	if err := appendDurableTree(archive, "hermes", config.DataRoot, func(relative string, entry fs.DirEntry) bool {
		return durableHermesPath(relative, entry, bundledGroups)
	}, limits); err != nil {
		return BackupResult{}, err
	}
	if err := appendDurableTree(archive, "meta", config.MetaRoot, func(relative string, entry fs.DirEntry) bool {
		return durableMetaPath(relative, entry)
	}, limits); err != nil {
		return BackupResult{}, err
	}
	if err := archive.Close(); err != nil {
		return BackupResult{}, err
	}
	if err := compressor.Close(); err != nil {
		return BackupResult{}, err
	}
	if err := encryptedWriter.Close(); err != nil {
		return BackupResult{}, err
	}
	if err := encryptedTemporary.Sync(); err != nil {
		return BackupResult{}, err
	}
	if err := encryptedTemporary.Close(); err != nil {
		return BackupResult{}, err
	}
	// End the manual maintenance window as soon as the consistent encrypted
	// snapshot is finalized. Remote transport happens after services restart.
	if restartServices && !live && compose != nil {
		if wasRunning {
			if _, restartErr := compose.Run(ctx, "up", "-d", "--no-deps", "hermes"); restartErr == nil {
				wasRunning = false
			}
		}
		if uiWasRunning {
			if _, restartErr := compose.Run(ctx, "up", "-d", "--no-deps", "workspace-ui"); restartErr == nil {
				uiWasRunning = false
			}
		}
	}
	digest, err := fileSHA256(encryptedTemporaryName)
	if err != nil {
		return BackupResult{}, err
	}
	archiveSuffix := ".tar.gz.age"
	destination := filepath.Join(config.BackupRoot, fmt.Sprintf("openlia-%s-%d%s", stamp, os.Getpid(), archiveSuffix))
	for collision := 1; ; collision++ {
		if _, statErr := os.Lstat(destination); errors.Is(statErr, os.ErrNotExist) {
			break
		} else if statErr != nil {
			return BackupResult{}, statErr
		}
		destination = filepath.Join(config.BackupRoot, fmt.Sprintf("openlia-%s-%d-%d%s", stamp, os.Getpid(), collision, archiveSuffix))
	}
	if err := os.Rename(encryptedTemporaryName, destination); err != nil {
		return BackupResult{}, err
	}
	removeEncryptedTemporary = false
	if err := os.Chmod(destination, 0o600); err != nil {
		_ = os.Remove(destination)
		return BackupResult{}, err
	}
	metadata := backupMetadata{Schema: 2, Kind: "durable", Archive: filepath.Base(destination), SHA256: digest, Encrypted: true, Reason: reason, CreatedAt: utcTimestamp(now), Secrets: "excluded"}
	metadataData, err := json.Marshal(metadata)
	if err != nil {
		_ = os.Remove(destination)
		return BackupResult{}, err
	}
	if err := AtomicWriteFile(destination+".json", append(metadataData, '\n'), 0o600); err != nil {
		_ = os.Remove(destination)
		return BackupResult{}, err
	}
	if reason != "restore-preflight" {
		retention := config.BackupRetention
		if retention <= 0 {
			retention = defaultBackupRetention
		}
		_, pruneErr := pruneBackups(config, retention)
		if stateErr := writeBackupRetentionState(config, pruneErr); stateErr != nil && pruneErr == nil {
			pruneErr = fmt.Errorf("record backup retention status: %w", stateErr)
		}
		result := BackupResult{OK: true, Archive: destination, Secrets: "excluded"}
		if pruneErr != nil {
			result.RetentionError = pruneErr.Error()
		}
		return result, nil
	}
	return BackupResult{OK: true, Archive: destination, Secrets: "excluded"}, nil
}

func RestoreBackup(config Config, archivePath string, now time.Time, composers ...Compose) (BackupResult, error) {
	var compose *Compose
	if len(composers) > 0 {
		compose = &composers[0]
	}
	return restoreBackup(context.Background(), config, archivePath, now, compose)
}

func restoreBackup(ctx context.Context, config Config, archivePath string, now time.Time, compose *Compose) (BackupResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return BackupResult{}, err
	}
	unlock, err := acquireBackupLock(ctx, config)
	if err != nil {
		return BackupResult{}, err
	}
	defer unlock()
	if archivePath == "" {
		return BackupResult{}, fmt.Errorf("encrypted durable archives must be decrypted and supplied by the operator CLI")
	}
	if err := ValidateAbsolutePath(archivePath, "backup-archive"); err != nil {
		return BackupResult{}, err
	}
	if !within(archivePath, config.BackupRoot) {
		return BackupResult{}, fmt.Errorf("restore archive must be inside the backup directory")
	}
	if info, err := os.Stat(archivePath); err != nil || !info.Mode().IsRegular() {
		return BackupResult{}, fmt.Errorf("restore archive does not exist")
	}
	if info, err := os.Lstat(archivePath); err != nil || info.Mode()&os.ModeSymlink != 0 {
		return BackupResult{}, fmt.Errorf("restore archive must be a regular file")
	}
	if err := verifyBackupDigest(archivePath); err != nil {
		return BackupResult{}, err
	}
	manifest, err := inspectRestoreArchive(archivePath)
	if err != nil {
		return BackupResult{}, err
	}
	if manifest.Schema >= 2 && manifest.Kind == "rollback" {
		return BackupResult{}, fmt.Errorf("rollback archives require an operation-specific restore")
	}
	if err := EnsureDir(config.DataRoot, 0o700); err != nil {
		return BackupResult{}, err
	}
	if info, err := os.Lstat(config.DataRoot); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return BackupResult{}, fmt.Errorf("Hermes data directory is missing")
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return BackupResult{}, err
	}
	wasRunning := compose != nil && compose.ServiceRunning(ctx, "hermes")
	uiWasRunning := compose != nil && config.WorkspaceUIHost != "" && compose.ServiceRunning(ctx, "workspace-ui")
	restoreCommitted := false
	defer func() {
		if restoreCommitted || compose == nil {
			return
		}
		if wasRunning {
			_, _ = compose.Run(context.Background(), "up", "-d", "--no-deps", "hermes")
		}
		if uiWasRunning {
			_, _ = compose.Run(context.Background(), "up", "-d", "--no-deps", "workspace-ui")
		}
		if wasRunning {
			_ = WriteState(config, stateRunning)
		}
	}()
	preRestore, err := createBackupWithRestart(ctx, config, "restore-preflight", now, compose, false, false)
	if err != nil {
		return BackupResult{}, err
	}
	if compose != nil {
		if _, statErr := os.Stat(config.ComposeFile); statErr == nil {
			if compose.ServiceRunning(ctx, "hermes") {
				if _, stopErr := compose.Run(ctx, "stop", "hermes"); stopErr != nil {
					return BackupResult{}, fmt.Errorf("cannot stop Hermes before restore")
				}
			}
			if config.WorkspaceUIHost != "" && compose.ServiceRunning(ctx, "workspace-ui") {
				if _, stopErr := compose.Run(ctx, "stop", "workspace-ui"); stopErr != nil {
					return BackupResult{}, fmt.Errorf("cannot stop workspace UI before restore")
				}
			}
		}
	}
	if err := WriteState(config, stateStopped); err != nil {
		return BackupResult{}, err
	}
	parent := filepath.Dir(config.DataRoot)
	staging, err := os.MkdirTemp(parent, ".restore-*")
	if err != nil {
		return BackupResult{}, err
	}
	defer os.RemoveAll(staging)
	if err := extractRestoreArchive(archivePath, staging, manifest); err != nil {
		_ = RecordChange(config, "restore", "failed", preRestore.Archive, "restore extraction failed", now)
		return BackupResult{}, err
	}
	if manifest.Schema >= 2 && manifest.Kind == "durable" {
		result, restoreErr := restoreDurableBackup(config, archivePath, staging, preRestore, now)
		if restoreErr == nil {
			restoreCommitted = true
		}
		return result, restoreErr
	}
	for _, root := range []string{"hermes", "meta", "locho"} {
		info, rootErr := os.Stat(filepath.Join(staging, root))
		if rootErr != nil || !info.IsDir() {
			_ = RecordChange(config, "restore", "failed", preRestore.Archive, "restore extraction failed", now)
			return BackupResult{}, fmt.Errorf("restore extraction failed; archive is missing %s", root)
		}
	}
	restoreRoots := []string{"hermes", "meta", "locho"}
	oldRoots := make(map[string]string)
	for _, root := range restoreRoots {
		oldPath := filepath.Join(config.BackupRoot, fmt.Sprintf("pre-restore-%s-%s-%d", root, now.UTC().Format("20060102T150405Z"), os.Getpid()))
		for suffix := 1; ; suffix++ {
			if _, statErr := os.Lstat(oldPath); errors.Is(statErr, os.ErrNotExist) {
				break
			} else if statErr != nil {
				return BackupResult{}, statErr
			}
			oldPath = filepath.Join(config.BackupRoot, fmt.Sprintf("pre-restore-%s-%s-%d-%d", root, now.UTC().Format("20060102T150405Z"), os.Getpid(), suffix))
		}
		oldRoots[root] = oldPath
	}
	for _, root := range restoreRoots {
		currentPath := filepath.Join(config.RuntimeRoot, root)
		if err := os.Rename(currentPath, oldRoots[root]); err != nil {
			for _, movedRoot := range restoreRoots {
				if oldPath := oldRoots[movedRoot]; oldPath != "" {
					if _, statErr := os.Lstat(oldPath); statErr == nil {
						_ = os.Rename(oldPath, filepath.Join(config.RuntimeRoot, movedRoot))
					}
				}
			}
			return BackupResult{}, fmt.Errorf("current %s move failed; restore was not applied", root)
		}
	}
	for _, root := range restoreRoots {
		if err := os.Rename(filepath.Join(staging, root), filepath.Join(config.RuntimeRoot, root)); err != nil {
			for _, restoredRoot := range restoreRoots {
				_ = os.RemoveAll(filepath.Join(config.RuntimeRoot, restoredRoot))
				if oldPath := oldRoots[restoredRoot]; oldPath != "" {
					_ = os.Rename(oldPath, filepath.Join(config.RuntimeRoot, restoredRoot))
				}
			}
			_ = RecordChange(config, "restore", "failed", preRestore.Archive, "restore replacement failed", now)
			return BackupResult{}, fmt.Errorf("restore replacement failed; current state was restored")
		}
	}
	if err := WriteState(config, stateStopped); err != nil {
		for _, restoredRoot := range restoreRoots {
			_ = os.RemoveAll(filepath.Join(config.RuntimeRoot, restoredRoot))
			if oldPath := oldRoots[restoredRoot]; oldPath != "" {
				_ = os.Rename(oldPath, filepath.Join(config.RuntimeRoot, restoredRoot))
			}
		}
		return BackupResult{}, err
	}
	if err := RecordChange(config, "restore", "ok", preRestore.Archive, "archive="+archivePath, now); err != nil {
		_ = RecordChange(config, "restore", "failed", preRestore.Archive, "restore record failed", now)
		return BackupResult{}, err
	}
	restoreCommitted = true
	return BackupResult{OK: true, Action: "restore", Archive: archivePath, State: stateStopped, Secrets: "supplied_out_of_band"}, nil
}

func restoreDurableBackup(config Config, archivePath, staging string, preRestore BackupResult, now time.Time) (BackupResult, error) {
	hermesStage := filepath.Join(staging, "hermes")
	metaStage := filepath.Join(staging, "meta")
	if info, err := os.Stat(hermesStage); err != nil || !info.IsDir() {
		return BackupResult{}, fmt.Errorf("durable restore is missing hermes data")
	}
	if info, err := os.Stat(metaStage); err != nil || !info.IsDir() {
		return BackupResult{}, fmt.Errorf("durable restore is missing metadata")
	}
	dataReplacement, err := buildDurableReplacement(hermesStage, config.DataRoot, portableHermesGeneratedPath, config.RuntimeUID, config.RuntimeGID)
	if err != nil {
		return BackupResult{}, fmt.Errorf("stage Hermes restore: %w", err)
	}
	metaReplacement, err := buildDurableReplacement(metaStage, config.MetaRoot, portableMetaGeneratedPath, config.RuntimeUID, config.RuntimeGID)
	if err != nil {
		_ = os.RemoveAll(dataReplacement)
		return BackupResult{}, fmt.Errorf("stage metadata restore: %w", err)
	}
	oldData := filepath.Join(config.BackupRoot, fmt.Sprintf("pre-restore-hermes-%s-%d", now.UTC().Format("20060102T150405Z"), os.Getpid()))
	oldMeta := filepath.Join(config.BackupRoot, fmt.Sprintf("pre-restore-meta-%s-%d", now.UTC().Format("20060102T150405Z"), os.Getpid()))
	rollback := func() {
		_ = os.RemoveAll(config.DataRoot)
		_ = os.RemoveAll(config.MetaRoot)
		_ = os.Rename(oldData, config.DataRoot)
		_ = os.Rename(oldMeta, config.MetaRoot)
	}
	if err := os.Rename(config.DataRoot, oldData); err != nil {
		_ = os.RemoveAll(dataReplacement)
		_ = os.RemoveAll(metaReplacement)
		return BackupResult{}, fmt.Errorf("current Hermes data move failed; restore was not applied")
	}
	if err := os.Rename(config.MetaRoot, oldMeta); err != nil {
		_ = os.Rename(oldData, config.DataRoot)
		_ = os.RemoveAll(dataReplacement)
		_ = os.RemoveAll(metaReplacement)
		return BackupResult{}, fmt.Errorf("current metadata move failed; restore was not applied")
	}
	if err := os.Rename(dataReplacement, config.DataRoot); err != nil {
		rollback()
		_ = os.RemoveAll(metaReplacement)
		return BackupResult{}, fmt.Errorf("Hermes data restore failed; current state was restored")
	}
	if err := os.Rename(metaReplacement, config.MetaRoot); err != nil {
		rollback()
		return BackupResult{}, fmt.Errorf("metadata restore failed; current state was restored")
	}
	if err := WriteRuntimeMetadata(config, now); err != nil {
		rollback()
		return BackupResult{}, err
	}
	if err := WriteState(config, stateStopped); err != nil {
		rollback()
		return BackupResult{}, err
	}
	if err := ensureRuntimeTreeOwner(config.MetaRoot, config.RuntimeUID, config.RuntimeGID); err != nil {
		rollback()
		return BackupResult{}, fmt.Errorf("restore metadata ownership: %w", err)
	}
	if err := RecordChange(config, "restore", "ok", preRestore.Archive, "durable archive="+archivePath, now); err != nil {
		return BackupResult{}, err
	}
	_ = os.RemoveAll(oldData)
	_ = os.RemoveAll(oldMeta)
	return BackupResult{OK: true, Action: "restore", Archive: archivePath, State: stateStopped, Secrets: "supplied_out_of_band"}, nil
}

func buildDurableReplacement(source, current string, generated func(string, fs.DirEntry) bool, uid, gid int) (string, error) {
	replacement, err := os.MkdirTemp(filepath.Dir(current), ".restore-tree-*")
	if err != nil {
		return "", err
	}
	if err := restoreDurableTreeFiltered(source, replacement, nil); err != nil {
		_ = os.RemoveAll(replacement)
		return "", err
	}
	if err := copyGeneratedTree(current, replacement, generated); err != nil {
		_ = os.RemoveAll(replacement)
		return "", err
	}
	if err := ensureRuntimeTreeOwner(replacement, uid, gid); err != nil {
		_ = os.RemoveAll(replacement)
		return "", err
	}
	return replacement, nil
}

func copyGeneratedTree(source, destination string, generated func(string, fs.DirEntry) bool) error {
	return filepath.WalkDir(source, func(current string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		relative = filepath.ToSlash(relative)
		if !generated(relative, entry) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			info, infoErr := entry.Info()
			if infoErr != nil {
				return infoErr
			}
			if err := os.MkdirAll(filepath.Join(destination, filepath.FromSlash(relative)), info.Mode().Perm()); err != nil {
				return err
			}
			return os.Chmod(filepath.Join(destination, filepath.FromSlash(relative)), info.Mode().Perm())
		}
		return copyRestoreEntry(current, filepath.Join(destination, filepath.FromSlash(relative)), entry)
	})
}

func copyRestoreEntry(source, destination string, entry fs.DirEntry) error {
	if entry.Type()&os.ModeSymlink != 0 {
		link, err := os.Readlink(source)
		if err != nil || !safeRelativeSymlink(filepath.ToSlash(filepath.Base(destination)), link) {
			return fmt.Errorf("generated state contains unsafe symlink: %s", destination)
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return err
		}
		return os.Symlink(link, destination)
	}
	info, err := entry.Info()
	if err != nil {
		return err
	}
	if entry.IsDir() {
		if err := os.MkdirAll(destination, info.Mode().Perm()); err != nil {
			return err
		}
		return os.Chmod(destination, info.Mode().Perm())
	}
	base := filepath.Base(source)
	if !info.Mode().IsRegular() || strings.HasSuffix(base, ".sock") || strings.HasSuffix(base, ".pid") || strings.HasSuffix(base, ".lock") {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return AtomicWriteFile(destination, data, info.Mode().Perm())
}

func restoreDurableTree(source, destination string) error {
	return restoreDurableTreeFiltered(source, destination, nil)
}

func restoreDurableTreeFiltered(source, destination string, skip func(string, fs.DirEntry) bool) error {
	return filepath.WalkDir(source, func(current string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		if skip != nil && skip(filepath.ToSlash(relative), entry) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		target := filepath.Join(destination, relative)
		if entry.Type()&os.ModeSymlink != 0 {
			link, readErr := os.Readlink(current)
			if readErr != nil || !safeRelativeSymlink(filepath.ToSlash(filepath.Join("root", relative)), link) {
				return fmt.Errorf("durable restore contains unsafe symlink: %s", relative)
			}
			_ = os.RemoveAll(target)
			return os.Symlink(link, target)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if err := os.MkdirAll(target, info.Mode().Perm()); err != nil {
				return err
			}
			return os.Chmod(target, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		data, err := os.ReadFile(current)
		if err != nil {
			return err
		}
		if err := AtomicWriteFile(target, data, info.Mode().Perm()); err != nil {
			return err
		}
		return os.Chmod(target, info.Mode().Perm())
	})
}

// RestoreRollback applies only the components declared by a rollback archive.
// A missing component is intentional and removes that path from the target.
func RestoreRollback(config Config, archivePath string, now time.Time, composers ...Compose) (BackupResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return BackupResult{}, err
	}
	unlock, err := acquireBackupLock(context.Background(), config)
	if err != nil {
		return BackupResult{}, err
	}
	defer unlock()
	if err := ValidateAbsolutePath(archivePath, "rollback-archive"); err != nil || !within(archivePath, config.BackupRoot) {
		return BackupResult{}, fmt.Errorf("rollback archive must be inside the backup directory")
	}
	if info, err := os.Lstat(archivePath); err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return BackupResult{}, fmt.Errorf("rollback archive must be a regular file")
	}
	manifest, err := inspectRestoreArchive(archivePath)
	if err != nil {
		return BackupResult{}, err
	}
	if manifest.Kind != "rollback" {
		return BackupResult{}, fmt.Errorf("archive is not an operation rollback")
	}
	parent := filepath.Dir(config.DataRoot)
	staging, err := os.MkdirTemp(parent, ".rollback-restore-*")
	if err != nil {
		return BackupResult{}, err
	}
	defer os.RemoveAll(staging)
	if err := extractRestoreArchive(archivePath, staging, manifest); err != nil {
		return BackupResult{}, err
	}
	var compose *Compose
	if len(composers) > 0 {
		compose = &composers[0]
	}
	wasRunning := false
	uiWasRunning := false
	if compose != nil && compose.ServiceRunning(context.Background(), "hermes") {
		if _, err := compose.Run(context.Background(), "stop", "hermes"); err != nil {
			return BackupResult{}, fmt.Errorf("cannot stop Hermes before rollback")
		}
		wasRunning = true
	}
	if compose != nil && config.WorkspaceUIHost != "" && compose.ServiceRunning(context.Background(), "workspace-ui") {
		if _, err := compose.Run(context.Background(), "stop", "workspace-ui"); err != nil {
			if wasRunning {
				_, _ = compose.Run(context.Background(), "up", "-d", "--no-deps", "hermes")
			}
			return BackupResult{}, fmt.Errorf("cannot stop workspace UI before rollback")
		}
		uiWasRunning = true
	}
	defer func() {
		if wasRunning {
			_, _ = compose.Run(context.Background(), "up", "-d", "--no-deps", "hermes")
		}
		if uiWasRunning {
			_, _ = compose.Run(context.Background(), "up", "-d", "--no-deps", "workspace-ui")
		}
	}()
	old := make(map[string]string)
	restoreOld := func() {
		for _, relative := range manifest.Components {
			if oldPath := old[relative]; oldPath != "" {
				_ = os.RemoveAll(filepath.Join(config.RuntimeRoot, filepath.FromSlash(relative)))
				_ = os.Rename(oldPath, filepath.Join(config.RuntimeRoot, filepath.FromSlash(relative)))
			}
		}
	}
	for _, relative := range manifest.Components {
		if !safeRuntimeRelativePath(relative) {
			restoreOld()
			return BackupResult{}, fmt.Errorf("rollback component is unsafe: %s", relative)
		}
		target := filepath.Join(config.RuntimeRoot, filepath.FromSlash(relative))
		oldPath := target + fmt.Sprintf(".rollback-old-%d", os.Getpid())
		if _, err := os.Lstat(target); err == nil {
			if err := os.Rename(target, oldPath); err != nil {
				restoreOld()
				return BackupResult{}, err
			}
			old[relative] = oldPath
		}
		source := filepath.Join(staging, filepath.FromSlash(relative))
		if _, err := os.Lstat(source); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			restoreOld()
			return BackupResult{}, err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			restoreOld()
			return BackupResult{}, err
		}
		if err := os.Rename(source, target); err != nil {
			restoreOld()
			return BackupResult{}, err
		}
	}
	for _, oldPath := range old {
		_ = os.RemoveAll(oldPath)
	}
	_ = RecordChange(config, "rollback-restore", "ok", archivePath, "operation rollback restored", now)
	return BackupResult{OK: true, Action: "rollback-restore", Archive: archivePath, State: stateRunning, Secrets: manifest.SecretValues}, nil
}
