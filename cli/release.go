package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type releaseFile struct {
	Name string
	Mode int64
	Data []byte
}

type releaseIdentity struct {
	Version string
	SHA256  string
}

func bundledReleaseIdentity(assets fs.FS) (releaseIdentity, error) {
	_, digest, err := releaseArchive(assets)
	if err != nil {
		return releaseIdentity{}, err
	}
	return releaseIdentity{Version: defaultVersion, SHA256: digest}, nil
}

func normalizeReleaseDigest(raw []byte) (string, error) {
	digest := strings.TrimSpace(string(raw))
	if len(digest) != sha256.Size*2 || strings.Trim(digest, "0123456789abcdef") != "" {
		return "", fmt.Errorf("invalid release digest %q", digest)
	}
	return digest, nil
}

func collectReleaseFiles(assets fs.FS) ([]releaseFile, error) {
	files := make([]releaseFile, 0)
	err := fs.WalkDir(assets, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if name == ".git" || strings.HasPrefix(name, ".git/") || strings.Contains(name, "/__pycache__/") || strings.HasSuffix(name, ".pyc") || strings.HasSuffix(name, ".pyo") {
			return nil
		}
		data, err := fs.ReadFile(assets, name)
		if err != nil {
			return err
		}
		mode := int64(0o600)
		if strings.HasSuffix(name, ".sh") || strings.HasSuffix(name, ".py") || strings.HasPrefix(name, "operator/") {
			mode = 0o700
		}
		files = append(files, releaseFile{Name: path.Clean(name), Mode: mode, Data: data})
		return nil
	})
	if err != nil {
		return nil, err
	}
	operatorFiles, err := collectTargetOperatorFiles()
	if err != nil {
		return nil, err
	}
	files = append(files, operatorFiles...)
	sort.Slice(files, func(left, right int) bool { return files[left].Name < files[right].Name })
	return files, nil
}

// Target operators are sidecar artifacts so a normal `go build .` does not
// require cross-compiled files to exist. The build targets place them next to
// the host CLI, and OPENLIA_OPERATOR_ASSET_DIR can point at another bundle.
func collectTargetOperatorFiles() ([]releaseFile, error) {
	directories := make([]string, 0, 6)
	if directory := os.Getenv("OPENLIA_OPERATOR_ASSET_DIR"); directory != "" {
		directories = append(directories, directory)
	}
	if executable, err := os.Executable(); err == nil {
		executableDirectory := filepath.Dir(executable)
		directories = append(directories,
			filepath.Join(executableDirectory, "dist"),
			filepath.Join(executableDirectory, "operator"),
		)
	}
	if workingDirectory, err := os.Getwd(); err == nil {
		directories = append(directories,
			filepath.Join(workingDirectory, "dist"),
			filepath.Join(workingDirectory, "operator"),
		)
	}

	assets := make([]releaseFile, 0, 2)
	seen := make(map[string]bool)
	for _, architecture := range []struct {
		name       string
		targetName string
	}{
		{name: "amd64", targetName: "operator/linux-amd64/openlia-operator"},
		{name: "arm64", targetName: "operator/linux-arm64/openlia-operator"},
	} {
		found := false
		for _, directory := range directories {
			if found {
				break
			}
			for _, candidate := range []string{
				filepath.Join(directory, "openlia-operator-linux-"+architecture.name),
				filepath.Join(directory, "linux-"+architecture.name, "openlia-operator"),
				filepath.Join(directory, "operator-linux-"+architecture.name),
			} {
				if seen[candidate] {
					continue
				}
				seen[candidate] = true
				info, err := os.Stat(candidate)
				if os.IsNotExist(err) {
					continue
				}
				if err != nil {
					return nil, fmt.Errorf("inspect target operator asset: %w", err)
				}
				if !info.Mode().IsRegular() {
					return nil, fmt.Errorf("target operator asset is not a regular file: %s", candidate)
				}
				data, err := os.ReadFile(candidate)
				if err != nil {
					return nil, fmt.Errorf("read target operator asset: %w", err)
				}
				assets = append(assets, releaseFile{Name: architecture.targetName, Mode: 0o700, Data: data})
				found = true
				break
			}
		}
	}
	return assets, nil
}

func targetOperatorAssetsAvailable() bool {
	files, err := collectTargetOperatorFiles()
	return err == nil && len(files) == 2
}

func releaseArchive(assets fs.FS) ([]byte, string, error) {
	files, err := collectReleaseFiles(assets)
	if err != nil {
		return nil, "", fmt.Errorf("collect release assets: %w", err)
	}
	var buffer bytes.Buffer
	zipper := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(zipper)
	for _, file := range files {
		header := &tar.Header{
			Name:    file.Name,
			Mode:    file.Mode,
			Size:    int64(len(file.Data)),
			ModTime: time.Unix(0, 0).UTC(),
		}
		if err := writer.WriteHeader(header); err != nil {
			return nil, "", err
		}
		if _, err := writer.Write(file.Data); err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	if err := zipper.Close(); err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(buffer.Bytes())
	return buffer.Bytes(), hex.EncodeToString(digest[:]), nil
}

func releaseSummary(assets fs.FS) (map[string]any, error) {
	files, err := collectReleaseFiles(assets)
	if err != nil {
		return nil, err
	}
	archive, digest, err := releaseArchive(assets)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"schema":         1,
		"version":        defaultVersion,
		"file_count":     len(files),
		"archive_bytes":  len(archive),
		"archive_sha256": digest,
		"hermes_tag":     defaultHermesTag,
		"locho_version":  defaultLochoVersion,
	}, nil
}
