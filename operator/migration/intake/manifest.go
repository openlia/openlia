package intake

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"openlia/operator/migration"
)

var (
	envFileNamePattern    = regexp.MustCompile(`(?i)^\.env(\..+)?$`)
	secretFileNamePattern = regexp.MustCompile(`(?i)(token|credential|secret|id_rsa|id_ed25519)`)

	secretContentPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----`),
		regexp.MustCompile(`(?i)\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b`),
		regexp.MustCompile(`(?i)\bglpat-[A-Za-z0-9\-=_]{20,}\b`),
		regexp.MustCompile(`(?i)\bsk-[A-Za-z0-9]{20,}\b`),
		regexp.MustCompile(`(?i)\bAKIA[0-9A-Z]{16}\b`),
	}

	ignoredDirs = map[string]bool{
		".git":         true,
		".svn":         true,
		".hg":          true,
		"node_modules": true,
		"__pycache__":  true,
		".venv":        true,
		"venv":         true,
		".tox":         true,
		".pytest_cache": true,
		".cache":       true,
		"dist":         true,
		"build":        true,
	}
)

// DetectSecretContent returns true if a filename or content appears to be a secret.
func DetectSecretContent(relPath string, data []byte) bool {
	base := filepath.Base(relPath)
	if envFileNamePattern.MatchString(base) || secretFileNamePattern.MatchString(base) {
		return true
	}
	if relPath == "sources/document-passwords.toml" {
		return true
	}
	for _, pattern := range secretContentPatterns {
		if pattern.Match(data) {
			return true
		}
	}
	return false
}

// IsIgnoredDir checks if any directory segment is an ignored directory.
func IsIgnoredDir(relPath string) bool {
	parts := strings.Split(filepath.ToSlash(relPath), "/")
	for _, p := range parts {
		if ignoredDirs[p] {
			return true
		}
	}
	return false
}

// DetectEncoding checks for UTF-8 or BOM encodings.
func DetectEncoding(data []byte) (string, bool) {
	if len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		return "utf-8-bom", true
	}
	if len(data) >= 2 && data[0] == 0xfe && data[1] == 0xff {
		return "utf-16-be", true
	}
	if len(data) >= 2 && data[0] == 0xff && data[1] == 0xfe {
		return "utf-16-le", true
	}
	// Check for binary bytes (null bytes)
	if bytes.IndexByte(data, 0) != -1 {
		return "binary", false
	}
	if utf8.Valid(data) {
		return "utf-8", true
	}
	return "unknown-text", false
}

// DetectTypeByExtension categorizes readable formats.
func DetectTypeByExtension(relPath string) string {
	ext := strings.ToLower(filepath.Ext(relPath))
	switch ext {
	case ".md", ".markdown":
		return "markdown"
	case ".csv":
		return "csv"
	case ".tsv":
		return "tsv"
	case ".json":
		return "json"
	case ".yaml", ".yml":
		return "yaml"
	case ".toml":
		return "toml"
	case ".xml":
		return "xml"
	case ".journal", ".hledger":
		return "hledger"
	case ".rem":
		return "remind"
	case ".txt":
		return "text"
	default:
		return "other"
	}
}

// ComputeSHA256 returns hex digest of data.
func ComputeSHA256(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// ScanSourceFolder walks an uploaded folder or extracted source directory, producing SourceEntries.
func ScanSourceFolder(migrationID string, folderPath string) ([]migration.SourceEntry, error) {
	absPath, err := filepath.Abs(folderPath)
	if err != nil {
		return nil, err
	}

	var entries []migration.SourceEntry
	orderIndex := 0

	err = filepath.Walk(absPath, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(absPath, path)
		if err != nil || rel == "." {
			return nil
		}
		slashRel := filepath.ToSlash(rel)

		// Check if directory is ignored
		if info.IsDir() {
			if IsIgnoredDir(slashRel) {
				return filepath.SkipDir
			}
			return nil
		}

		// Skip symlinks outside or broken
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil || !filepath.IsLocal(target) {
				entries = append(entries, migration.SourceEntry{
					ID:           fmt.Sprintf("src-%04d", orderIndex),
					MigrationID:  migrationID,
					RelativePath: slashRel,
					ByteSize:     info.Size(),
					Eligibility:  migration.EligibilitySkipped,
					Reason:       "symlink target outside source directory",
					OrderIndex:   orderIndex,
				})
				orderIndex++
				return nil
			}
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		byteHash := ComputeSHA256(data)
		encoding, isText := DetectEncoding(data)
		detectedType := DetectTypeByExtension(slashRel)

		eligibility := migration.EligibilityEligible
		reason := ""

		if DetectSecretContent(slashRel, data) {
			eligibility = migration.EligibilityBlocked
			reason = "credentials or secret patterns detected"
		} else if !isText {
			eligibility = migration.EligibilityUnsupported
			reason = fmt.Sprintf("unsupported non-text format (%s)", encoding)
		}

		// Discover include dependencies for hledger and remind files
		var deps []string
		if eligibility == migration.EligibilityEligible {
			if detectedType == "hledger" {
				deps = ExtractHledgerIncludes(data)
			} else if detectedType == "remind" {
				deps = ExtractRemindIncludes(data)
			}
		}

		entries = append(entries, migration.SourceEntry{
			ID:           fmt.Sprintf("src-%04d", orderIndex),
			MigrationID:  migrationID,
			RelativePath: slashRel,
			ByteHash:     byteHash,
			ByteSize:     int64(len(data)),
			Encoding:     encoding,
			DetectedType: detectedType,
			Eligibility:  eligibility,
			Reason:       reason,
			Dependencies: deps,
			OrderIndex:   orderIndex,
		})
		orderIndex++
		return nil
	})

	if err != nil {
		return nil, err
	}

	// Sort entries deterministically: eligible dependencies first, then relative path
	sort.SliceStable(entries, func(i, j int) bool {
		// Put eligible before skipped/blocked
		if (entries[i].Eligibility == migration.EligibilityEligible) != (entries[j].Eligibility == migration.EligibilityEligible) {
			return entries[i].Eligibility == migration.EligibilityEligible
		}
		return entries[i].RelativePath < entries[j].RelativePath
	})
	for i := range entries {
		entries[i].OrderIndex = i
	}

	return entries, nil
}

// ExtractTarball extracts a tar.gz into targetDir safely preventing directory traversal.
func ExtractTarball(tarGzPath string, targetDir string) error {
	f, err := os.Open(tarGzPath)
	if err != nil {
		return err
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	cleanTarget := filepath.Clean(targetDir)

	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		dest := filepath.Join(cleanTarget, header.Name)
		if !strings.HasPrefix(filepath.Clean(dest), cleanTarget+string(filepath.Separator)) {
			return fmt.Errorf("illegal path traversal in tarball: %s", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dest, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
				return err
			}
			out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			out.Close()
		}
	}
	return nil
}

var (
	hledgerIncludeRegex = regexp.MustCompile(`(?m)^\s*include\s+([^\r\n#;]+)`)
	remindIncludeRegex  = regexp.MustCompile(`(?mi)^\s*include\s+([^\r\n#;]+)`)
)

// ExtractHledgerIncludes extracts relative file paths from include directives.
func ExtractHledgerIncludes(data []byte) []string {
	matches := hledgerIncludeRegex.FindAllSubmatch(data, -1)
	var includes []string
	for _, m := range matches {
		inc := strings.TrimSpace(string(m[1]))
		inc = strings.Trim(inc, `"'`)
		if inc != "" {
			includes = append(includes, inc)
		}
	}
	return includes
}

// ExtractRemindIncludes extracts relative file paths from INCLUDE directives.
func ExtractRemindIncludes(data []byte) []string {
	matches := remindIncludeRegex.FindAllSubmatch(data, -1)
	var includes []string
	for _, m := range matches {
		inc := strings.TrimSpace(string(m[1]))
		inc = strings.Trim(inc, `"'`)
		if inc != "" {
			includes = append(includes, inc)
		}
	}
	return includes
}
