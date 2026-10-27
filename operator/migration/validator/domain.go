package validator

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"openlia/operator/migration"
)

// ValidateProposalWorkspace executes deterministic domain validations on changed files.
func ValidateProposalWorkspace(workspaceDir string, changedFiles []migration.ChangedFileEntry) []migration.ValidationFinding {
	var findings []migration.ValidationFinding

	for _, cf := range changedFiles {
		if cf.Status == "deleted" {
			continue
		}

		fullPath := filepath.Join(workspaceDir, filepath.FromSlash(cf.Path))
		data, err := os.ReadFile(fullPath)
		if err != nil {
			continue
		}

		ext := strings.ToLower(filepath.Ext(cf.Path))

		// Markdown Frontmatter Validation
		if ext == ".md" || ext == ".markdown" {
			if f := validateMarkdownFrontmatter(cf.Path, data); f != nil {
				findings = append(findings, *f)
			}
		}
	}

	return findings
}

func validateMarkdownFrontmatter(relPath string, data []byte) *migration.ValidationFinding {
	content := string(data)
	if !strings.HasPrefix(content, "---\n") && !strings.HasPrefix(content, "---\r\n") {
		return nil // No frontmatter
	}

	// Find closing ---
	rest := content[4:]
	idx := strings.Index(rest, "\n---")
	if idx == -1 {
		return &migration.ValidationFinding{
			Severity: "error",
			Domain:   "document",
			File:     relPath,
			Message:  "unclosed YAML frontmatter: missing closing '---'",
		}
	}

	rawYAML := rest[:idx]
	lines := strings.Split(rawYAML, "\n")
	for lineNum, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		// If line is not indented, it should be a key: value or list item
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			if !strings.Contains(trimmed, ":") && !strings.HasPrefix(trimmed, "- ") {
				return &migration.ValidationFinding{
					Severity: "error",
					Domain:   "document",
					File:     relPath,
					Line:     lineNum + 2,
					Message:  fmt.Sprintf("invalid YAML frontmatter syntax on line %d: %q", lineNum+2, trimmed),
				}
			}
		}
	}

	return nil
}
