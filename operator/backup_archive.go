package operator

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func appendDurableTree(archive *tar.Writer, label, root string, include func(string, fs.DirEntry) bool, archiveLimits ...*backupArchiveLimits) error {
	var limits *backupArchiveLimits
	if len(archiveLimits) > 0 {
		limits = archiveLimits[0]
	}
	return filepath.WalkDir(root, func(current string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		if relative != "." && !include(filepath.ToSlash(relative), entry) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		relative = filepath.ToSlash(relative)
		name := label
		if relative != "." {
			name += "/" + relative
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			target, readErr := os.Readlink(current)
			if readErr != nil || !safeRelativeSymlink(name, target) {
				return fmt.Errorf("durable backup contains unsafe symlink: %s", name)
			}
			if limits != nil {
				if err := limits.add(name, 0, tar.TypeSymlink); err != nil {
					return err
				}
			}
			return archive.WriteHeader(&tar.Header{Name: name, Mode: int64(info.Mode().Perm()), Typeflag: tar.TypeSymlink, Linkname: target})
		}
		if entry.IsDir() {
			if limits != nil {
				if err := limits.add(name+"/", 0, tar.TypeDir); err != nil {
					return err
				}
			}
			return archive.WriteHeader(&tar.Header{Name: name + "/", Mode: int64(info.Mode().Perm()), Typeflag: tar.TypeDir})
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if limits != nil {
			if err := limits.add(name, info.Size(), tar.TypeReg); err != nil {
				return err
			}
		}
		input, err := os.Open(current)
		if err != nil {
			return err
		}
		if err := archive.WriteHeader(&tar.Header{Name: name, Mode: int64(info.Mode().Perm()), Size: info.Size(), Typeflag: tar.TypeReg}); err != nil {
			_ = input.Close()
			return err
		}
		written, copyErr := io.CopyN(archive, input, info.Size())
		closeErr := input.Close()
		if copyErr != nil || written != info.Size() {
			if copyErr == nil || errors.Is(copyErr, io.EOF) || errors.Is(copyErr, io.ErrUnexpectedEOF) {
				return fmt.Errorf("%w: %s", errBackupSourceChanged, current)
			}
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		after, err := os.Stat(current)
		if err != nil || !os.SameFile(info, after) || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
			return fmt.Errorf("%w: %s", errBackupSourceChanged, current)
		}
		return nil
	})
}

func durableHermesPath(relative string, entry fs.DirEntry, bundledGroups map[string]bool) bool {
	if excludedBackupPath(relative) {
		return false
	}
	if isGeneratedArtifactPath(relative) {
		return false
	}
	parts := strings.Split(relative, "/")
	if len(parts) > 0 && (parts[0] == "ingestion" || parts[0] == "usage") {
		base := parts[len(parts)-1]
		if strings.HasSuffix(base, "-shm") || strings.HasSuffix(base, ".lock") || strings.HasSuffix(base, ".sock") || strings.HasSuffix(base, ".pid") || strings.HasSuffix(base, ".tmp") {
			return false
		}
		return true
	}
	base := parts[len(parts)-1]
	for _, part := range parts {
		switch part {
		case "logs", "cache", "audio_cache", "image_cache", "lazy-packages", "bin", "home", ".local", ".npm":
			return false
		}
	}
	if portableHermesGeneratedPath(relative, entry) || base == ".bundled_manifest" || base == ".openlia-disabled" || base == "auth.json" || strings.HasPrefix(base, "models_dev_cache") {
		return false
	}
	if strings.HasSuffix(base, ".sock") || strings.HasSuffix(base, ".pid") || strings.HasSuffix(base, ".lock") || strings.HasSuffix(base, ".env") {
		return false
	}
	if len(parts) >= 2 && parts[0] == "skills" && bundledGroups[parts[1]] {
		return false
	}
	return true
}

func durableMetaPath(relative string, entry fs.DirEntry) bool {
	if excludedBackupPath(relative) {
		return false
	}
	if isGeneratedArtifactPath(relative) {
		return false
	}
	if portableMetaGeneratedPath(relative, entry) {
		return false
	}
	parts := strings.Split(relative, "/")
	for _, part := range parts {
		if part == "locks" || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	return true
}

func portableHermesGeneratedPath(relative string, entry fs.DirEntry) bool {
	if entry.IsDir() {
		return relative == "backups"
	}
	if strings.HasPrefix(relative, "backups/") {
		return true
	}
	switch relative {
	case "config.yaml", "services.json", "gateway_state.json", "channel_directory.json", ".clean_shutdown", "gateway-starts.log", "gateway.lock", "gateway.pid", "gateway.sock":
		return true
	default:
		return false
	}
}

func portableMetaGeneratedPath(relative string, entry fs.DirEntry) bool {
	if entry.IsDir() {
		return relative == "locks"
	}
	if strings.HasPrefix(relative, "locks/") {
		return true
	}
	switch relative {
	case "runtime.json", "last-change.json", "stack-state", "services.json", "backup-schedule-config.json", "backup-schedule-state.json", "backup-destinations.json":
		return true
	default:
		return false
	}
}

func bundledSkillGroups(dataRoot string) map[string]bool {
	result := make(map[string]bool)
	manifestPath := filepath.Join(dataRoot, "skills", ".bundled_manifest")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return result
	}
	bundled := make(map[string]bool)
	for _, line := range strings.Split(string(data), "\n") {
		name, _, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok && name != "" {
			bundled[name] = true
		}
	}
	entries, err := os.ReadDir(filepath.Join(dataRoot, "skills"))
	if err != nil {
		return result
	}
	for _, group := range entries {
		if !group.IsDir() {
			continue
		}
		children, err := os.ReadDir(filepath.Join(dataRoot, "skills", group.Name()))
		if err != nil || len(children) == 0 {
			continue
		}
		allBundled := true
		for _, child := range children {
			if !child.IsDir() && child.Name() == "DESCRIPTION.md" {
				continue
			}
			if !child.IsDir() || !bundled[child.Name()] {
				allBundled = false
				break
			}
		}
		if allBundled {
			result[group.Name()] = true
		}
	}
	return result
}

func safeRelativeSymlink(name, target string) bool {
	if target == "" || filepath.IsAbs(target) || strings.ContainsAny(target, "\x00\r\n") {
		return false
	}
	joined := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(name), target)))
	root := strings.Split(name, "/")[0]
	return joined == root || strings.HasPrefix(joined, root+"/")
}

func writeTarFile(archive *tar.Writer, name string, data []byte, mode os.FileMode) error {
	if err := archive.WriteHeader(&tar.Header{Name: name, Mode: int64(mode), Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	_, err := archive.Write(data)
	return err
}

func excludedBackupPath(path string) bool {
	parts := strings.Split(path, "/")
	if len(parts) >= 3 && parts[0] == "locho" && parts[len(parts)-1] == "attachments.toml" {
		return true
	}
	for _, part := range parts {
		switch part {
		case "secrets", "pairing", "mcp-tokens", "browser-profile", "logs":
			return true
		}
	}
	base := filepath.Base(path)
	if base == "shares.sqlite" || base == "shares.sqlite-wal" || base == "shares.sqlite-shm" {
		return true
	}
	return strings.HasSuffix(base, ".env") || strings.HasSuffix(base, ".sock") || strings.HasSuffix(base, ".secret") || strings.Contains(base, ".secret") || base == "auth.json"
}

func safeArchiveMember(name string) bool {
	return !strings.HasPrefix(name, "/") && !strings.ContainsAny(name, "\x00\r\n") && name != ".." && !strings.HasPrefix(name, "../") && !strings.Contains(name, "/../") && filepath.ToSlash(filepath.Clean(filepath.FromSlash(name))) == name && archivePathDepth(name) <= maxArchivePathDepth
}

func archivePathDepth(name string) int {
	return len(strings.Split(strings.Trim(name, "/"), "/"))
}

func allowedArchiveMember(name string) bool {
	if !safeArchiveMember(name) {
		return false
	}
	allowedRoots := []string{"hermes", "meta", "locho", "open-webui"}
	for _, root := range allowedRoots {
		if name == root || strings.HasPrefix(name, root+"/") {
			return true
		}
	}
	return false
}

func validateRestoreArchive(path string) error {
	_, err := inspectRestoreArchive(path)
	return err
}

// ValidateBackupArchive validates an unencrypted durable archive before the
// host CLI sends it to a target for restoration.
func ValidateBackupArchive(path string) error {
	return validateRestoreArchive(path)
}

func verifyBackupDigest(archivePath string) error {
	data, err := os.ReadFile(archivePath + ".json")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read backup metadata: %w", err)
	}
	var metadata backupMetadata
	if err := json.Unmarshal(data, &metadata); err != nil || metadata.SHA256 == "" {
		return fmt.Errorf("backup metadata is invalid")
	}
	digest, err := fileSHA256(archivePath)
	if err != nil {
		return fmt.Errorf("hash backup archive: %w", err)
	}
	if digest != metadata.SHA256 {
		return fmt.Errorf("backup archive checksum does not match metadata")
	}
	return nil
}

func inspectRestoreArchive(path string) (backupManifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return backupManifest{}, err
	}
	decompressor, err := gzip.NewReader(file)
	if err != nil {
		_ = file.Close()
		return backupManifest{}, fmt.Errorf("restore archive is not a readable tar archive")
	}
	reader := tar.NewReader(decompressor)
	manifest := backupManifest{}
	manifestFound := false
	dataBeforeManifest := false
	members := 0
	var totalSize int64
	for {
		header, readErr := reader.Next()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			_ = decompressor.Close()
			_ = file.Close()
			return backupManifest{}, fmt.Errorf("restore archive is not a readable tar archive")
		}
		name := strings.TrimSuffix(header.Name, "/")
		if name == "" {
			continue
		}
		if name == "manifest.json" {
			if manifestFound {
				return backupManifest{}, fmt.Errorf("restore archive contains duplicate manifest")
			}
			if header.Typeflag != tar.TypeReg || header.Size < 0 || header.Size > 64*1024 {
				_ = decompressor.Close()
				_ = file.Close()
				return backupManifest{}, fmt.Errorf("restore archive manifest is invalid")
			}
			data, readManifestErr := io.ReadAll(io.LimitReader(reader, header.Size))
			if readManifestErr != nil || int64(len(data)) != header.Size || json.Unmarshal(data, &manifest) != nil {
				_ = decompressor.Close()
				_ = file.Close()
				return backupManifest{}, fmt.Errorf("restore archive manifest is invalid")
			}
			manifestFound = true
			continue
		}
		members++
		if members > maxArchiveMembers || header.Size > maxArchiveMemberSize || totalSize > maxArchiveTotalSize-header.Size {
			return backupManifest{}, fmt.Errorf("restore archive exceeds safety limits")
		}
		totalSize += header.Size
		if !manifestFound {
			if !allowedArchiveMember(name) {
				_ = decompressor.Close()
				_ = file.Close()
				return backupManifest{}, fmt.Errorf("restore archive contains an unsupported or unsafe member")
			}
			dataBeforeManifest = true
		} else if !allowedArchiveMemberForManifest(name, manifest) {
			_ = decompressor.Close()
			_ = file.Close()
			return backupManifest{}, fmt.Errorf("restore archive contains an unsupported or unsafe member")
		}
		if header.Typeflag != tar.TypeDir && header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeSymlink || header.Size < 0 {
			_ = decompressor.Close()
			_ = file.Close()
			return backupManifest{}, fmt.Errorf("restore archive contains an unsupported or unsafe member")
		}
		if header.Typeflag == tar.TypeSymlink && !safeRelativeSymlink(name, header.Linkname) {
			_ = decompressor.Close()
			_ = file.Close()
			return backupManifest{}, fmt.Errorf("restore archive contains an unsafe symlink")
		}
	}
	if err := decompressor.Close(); err != nil {
		_ = file.Close()
		return backupManifest{}, fmt.Errorf("restore archive is not a readable tar archive")
	}
	if err := file.Close(); err != nil {
		return backupManifest{}, fmt.Errorf("restore archive is not a readable tar archive")
	}
	if !manifestFound || (manifest.Schema != 1 && manifest.Schema != 2) {
		return backupManifest{}, fmt.Errorf("restore archive manifest is unsupported")
	}
	if manifest.Schema >= 2 && manifest.Kind != "durable" && manifest.Kind != "rollback" {
		return backupManifest{}, fmt.Errorf("restore archive kind is unsupported")
	}
	if manifest.Schema >= 2 && dataBeforeManifest {
		return backupManifest{}, fmt.Errorf("restore archive manifest must precede data")
	}
	return manifest, nil
}

func allowedArchiveMemberForManifest(name string, manifest backupManifest) bool {
	if manifest.Schema == 1 {
		return allowedArchiveMember(name)
	}
	if !safeArchiveMember(name) {
		return false
	}
	for _, root := range manifest.Components {
		if name == root || strings.HasPrefix(name, root+"/") {
			return true
		}
	}
	return false
}

func extractRestoreArchive(path, destination string, manifest backupManifest) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	decompressor, err := gzip.NewReader(file)
	if err != nil {
		_ = file.Close()
		return fmt.Errorf("restore archive is not a readable tar archive")
	}
	reader := tar.NewReader(decompressor)
	members := 0
	var totalSize int64
	defer decompressor.Close()
	defer file.Close()
	for {
		header, readErr := reader.Next()
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return fmt.Errorf("restore archive is not a readable tar archive")
		}
		name := strings.TrimSuffix(header.Name, "/")
		if name == "" || name == "manifest.json" {
			continue
		}
		members++
		if members > maxArchiveMembers || header.Size > maxArchiveMemberSize || totalSize > maxArchiveTotalSize-header.Size {
			return fmt.Errorf("restore archive exceeds safety limits")
		}
		totalSize += header.Size
		if !allowedArchiveMemberForManifest(name, manifest) || (header.Typeflag != tar.TypeDir && header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeSymlink) || header.Size < 0 || (header.Typeflag == tar.TypeSymlink && !safeRelativeSymlink(name, header.Linkname)) {
			return fmt.Errorf("restore archive contains an unsupported or unsafe member")
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		if header.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			if err := os.Chmod(target, os.FileMode(header.Mode).Perm()); err != nil {
				return err
			}
			continue
		}
		if header.Typeflag == tar.TypeSymlink {
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		written, copyErr := io.CopyN(output, reader, header.Size)
		closeErr := output.Close()
		if copyErr != nil || closeErr != nil || written != header.Size {
			return fmt.Errorf("restore extraction failed")
		}
		if err := os.Chmod(target, os.FileMode(header.Mode).Perm()); err != nil {
			return err
		}
	}
}
