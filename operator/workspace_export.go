package operator

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type WorkspaceExportResult struct {
	OK         bool   `json:"ok"`
	OutputFile string `json:"output_file"`
	FilesCount int    `json:"files_count"`
	SizeBytes  int64  `json:"size_bytes"`
}

func isExportNoise(relPath string, info os.FileInfo) bool {
	if info.Mode()&os.ModeSymlink != 0 {
		return true
	}
	parts := strings.Split(filepath.ToSlash(relPath), "/")
	if isPortableExportExcludedPath(relPath) {
		return true
	}
	for _, part := range parts {
		if part == ".git" || part == ".obsidian" || part == ".trash" ||
			part == ".DS_Store" || strings.EqualFold(part, "thumbs.db") ||
			part == "desktop.ini" || strings.HasPrefix(part, "._") {
			return true
		}
	}
	return false
}

// isGeneratedArtifactPath identifies disposable files that should not be
// carried between machines. It intentionally does not interpret .gitignore;
// user-owned files can be ignored by Git and still be needed for recovery.
func isGeneratedArtifactPath(relPath string) bool {
	parts := strings.Split(filepath.ToSlash(relPath), "/")
	for _, part := range parts {
		switch strings.ToLower(part) {
		case ".curator_backups", "node_modules", "__pycache__", ".cache",
			".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox",
			".venv", "venv", "env":
			return true
		}
	}

	base := strings.ToLower(parts[len(parts)-1])
	return strings.HasSuffix(base, ".pyc") ||
		strings.HasSuffix(base, ".pyo") ||
		strings.HasSuffix(base, ".pyd") ||
		strings.HasSuffix(base, "$py.class") ||
		base == ".coverage" || strings.HasPrefix(base, ".coverage.") ||
		strings.HasSuffix(base, ".egg-info")
}

func isPortableExportExcludedPath(relPath string) bool {
	normalized := filepath.ToSlash(relPath)
	lowerPath := strings.ToLower(normalized)
	parts := strings.Split(lowerPath, "/")
	base := parts[len(parts)-1]

	if isGeneratedArtifactPath(normalized) {
		return true
	}
	if lowerPath == "sources/document-passwords.toml" ||
		lowerPath == "@memories" || strings.HasPrefix(lowerPath, "@memories/") ||
		base == "shares.sqlite" || base == "shares.sqlite-wal" || base == "shares.sqlite-shm" ||
		base == ".gitignore" || base == "agents.md" || base == "claude.md" ||
		base == ".cursorrules" || base == "auth.json" ||
		strings.Contains(lowerPath, ".secret") ||
		strings.HasSuffix(base, ".pem") || strings.HasSuffix(base, ".key") ||
		strings.HasSuffix(base, ".p12") || strings.HasSuffix(base, ".pfx") {
		return true
	}
	if strings.HasSuffix(base, "-shm") || strings.HasSuffix(base, ".lock") ||
		strings.HasSuffix(base, ".sock") || strings.HasSuffix(base, ".pid") ||
		strings.HasSuffix(base, ".tmp") {
		return true
	}
	if lowerPath == ".env" || strings.HasPrefix(lowerPath, ".env.") ||
		strings.HasSuffix(lowerPath, ".env") {
		return true
	}
	for _, part := range parts {
		switch part {
		case ".git", ".obsidian", ".trash", "browser-profile", "cache",
			"logs", "mcp-tokens", "pairing", "sessions":
			return true
		case ".env":
			return true
		}
		if strings.HasPrefix(part, ".env.") {
			return true
		}
	}
	return false
}

func addDirectoryToZip(w *zip.Writer, rootDir, archivePrefix string) (int, error) {
	if _, err := os.Stat(rootDir); os.IsNotExist(err) {
		return 0, nil
	}
	count := 0
	err := filepath.Walk(rootDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(rootDir, path)
		if err != nil || rel == "." {
			return nil
		}
		if isExportNoise(rel, info) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if info.IsDir() {
			return nil
		}

		cleanRel := filepath.ToSlash(rel)
		zipPath := archivePrefix + "/" + cleanRel

		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = zipPath
		header.Method = zip.Deflate

		writer, err := w.CreateHeader(header)
		if err != nil {
			return err
		}

		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()

		if _, err := io.Copy(writer, file); err != nil {
			return err
		}
		count++
		return nil
	})
	return count, err
}

func addMemoryFilesToZip(w *zip.Writer, rootDir string) (int, error) {
	info, err := os.Stat(rootDir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return 0, nil
	}

	count := 0
	for _, name := range []string{"USER.md", "MEMORY.md"} {
		path := filepath.Join(rootDir, name)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return count, err
		}
		if !info.Mode().IsRegular() {
			continue
		}

		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return count, err
		}
		header.Name = "memories/" + name
		header.Method = zip.Deflate

		writer, err := w.CreateHeader(header)
		if err != nil {
			return count, err
		}

		file, err := os.Open(path)
		if err != nil {
			return count, err
		}
		_, copyErr := io.Copy(writer, file)
		closeErr := file.Close()
		if copyErr != nil {
			return count, copyErr
		}
		if closeErr != nil {
			return count, closeErr
		}
		count++
	}
	return count, nil
}

func WorkspaceExport(config Config, outputFile string) (WorkspaceExportResult, error) {
	if err := os.MkdirAll(filepath.Dir(outputFile), 0o700); err != nil {
		return WorkspaceExportResult{}, fmt.Errorf("create export parent directory: %w", err)
	}

	zipFile, err := os.OpenFile(outputFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return WorkspaceExportResult{}, fmt.Errorf("create export file: %w", err)
	}
	defer zipFile.Close()

	zipWriter := zip.NewWriter(zipFile)

	workspaceDir := filepath.Join(config.DataRoot, "workspace")
	wsCount, err := addDirectoryToZip(zipWriter, workspaceDir, "workspace")
	if err != nil {
		return WorkspaceExportResult{}, fmt.Errorf("archive workspace: %w", err)
	}

	skillsDir := filepath.Join(config.DataRoot, "skills")
	skCount, err := addDirectoryToZip(zipWriter, skillsDir, "skills")
	if err != nil {
		return WorkspaceExportResult{}, fmt.Errorf("archive skills: %w", err)
	}

	memoryDir := filepath.Join(config.DataRoot, "memories")
	memoryCount, err := addMemoryFilesToZip(zipWriter, memoryDir)
	if err != nil {
		return WorkspaceExportResult{}, fmt.Errorf("archive memories: %w", err)
	}

	ingestionDir := filepath.Join(config.DataRoot, "ingestion")
	ingCount, err := addDirectoryToZip(zipWriter, ingestionDir, "ingestion")
	if err != nil {
		return WorkspaceExportResult{}, fmt.Errorf("archive ingestion: %w", err)
	}

	if err := zipWriter.Close(); err != nil {
		return WorkspaceExportResult{}, fmt.Errorf("close zip writer: %w", err)
	}

	info, err := zipFile.Stat()
	if err != nil {
		return WorkspaceExportResult{}, fmt.Errorf("stat export file: %w", err)
	}

	return WorkspaceExportResult{
		OK:         true,
		OutputFile: outputFile,
		FilesCount: wsCount + skCount + memoryCount + ingCount,
		SizeBytes:  info.Size(),
	}, nil
}
