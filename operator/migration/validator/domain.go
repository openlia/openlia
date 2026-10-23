package validator

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"openlia/operator/migration"
)

// ValidateProposalWorkspace executes deterministic domain validations on changed files.
func ValidateProposalWorkspace(workspaceDir string, changedFiles []migration.ChangedFileEntry) []migration.ValidationFinding {
	var findings []migration.ValidationFinding

	hasHledger := false
	if _, err := exec.LookPath("hledger"); err == nil {
		hasHledger = true
	}

	hasRemind := false
	if _, err := exec.LookPath("remind"); err == nil {
		hasRemind = true
	}

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

		// 1. Markdown Frontmatter Validation
		if ext == ".md" || ext == ".markdown" {
			if f := validateMarkdownFrontmatter(cf.Path, data); f != nil {
				findings = append(findings, *f)
			}
		}

		// 2. Hledger Validation
		if ext == ".journal" || ext == ".hledger" {
			if hasHledger {
				cmd := exec.Command("hledger", "-f", fullPath, "check")
				out, err := cmd.CombinedOutput()
				if err != nil {
					findings = append(findings, migration.ValidationFinding{
						Severity: "error",
						Domain:   "finance",
						File:     cf.Path,
						Message:  fmt.Sprintf("hledger check failed: %s", strings.TrimSpace(string(out))),
					})
				}
			}
		}

		// 3. Remind Validation
		if ext == ".rem" || ext == ".remind" {
			if f := validateRemindSafety(cf.Path, data); f != nil {
				findings = append(findings, *f)
			} else if hasRemind {
				cmd := exec.Command("remind", "-r", "-c", fullPath)
				out, err := cmd.CombinedOutput()
				if err != nil {
					findings = append(findings, migration.ValidationFinding{
						Severity: "error",
						Domain:   "calendar",
						File:     cf.Path,
						Message:  fmt.Sprintf("remind check failed: %s", strings.TrimSpace(string(out))),
					})
				}
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

func validateRemindSafety(relPath string, data []byte) *migration.ValidationFinding {
	lines := strings.Split(string(data), "\n")
	for lineNum, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			continue
		}
		upper := strings.ToUpper(trimmed)
		if strings.Contains(upper, " RUN ") || strings.HasPrefix(upper, "RUN ") ||
			strings.Contains(upper, " SH ") || strings.HasPrefix(upper, "SH ") ||
			strings.Contains(upper, "EXEC") {
			return &migration.ValidationFinding{
				Severity: "error",
				Domain:   "calendar",
				File:     relPath,
				Line:     lineNum + 1,
				Message:  fmt.Sprintf("dangerous command execution pattern detected in Remind file on line %d: %s", lineNum+1, trimmed),
			}
		}
	}
	return nil
}
