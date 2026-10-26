package security

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ProtectedPaths lists exact file paths and directory prefixes that are protected
// from any modification or deletion by migrations.
var ProtectedPaths = []string{
	".git",
	".openlia",
	"sources/document-passwords.toml",
	"AGENTS.md",
	"SOUL.md",
	"workspace.yaml",
	"assistant-policy.yaml",
	"permissions.yaml",
}

// IsProtectedWorkspacePath returns true for system paths and core instruction
// files that must never be altered or overwritten by migrations.
func IsProtectedWorkspacePath(relPath string) bool {
	clean := filepath.ToSlash(filepath.Clean(relPath))
	clean = strings.TrimPrefix(clean, "./")
	clean = strings.TrimPrefix(clean, "/")

	if clean == "" || clean == "." {
		return true
	}

	for _, p := range ProtectedPaths {
		if clean == p {
			return true
		}
		if strings.HasPrefix(clean, p+"/") {
			return true
		}
	}

	return false
}

// ValidateSafeWorkspacePath verifies that a relative path is safe within workspaceRoot:
// 1. It is not an absolute path.
// 2. It does not escape workspaceRoot via ".." or relative tricks.
// 3. It is not a protected path (e.g. .git, .openlia, AGENTS.md, etc.).
// 4. No ancestor directory or existing file on the path inside workspaceRoot is a symlink.
func ValidateSafeWorkspacePath(workspaceRoot, relPath string) error {
	if relPath == "" {
		return fmt.Errorf("empty path")
	}

	if filepath.IsAbs(relPath) || strings.HasPrefix(relPath, "/") || strings.HasPrefix(relPath, "\\") {
		return fmt.Errorf("absolute path is not allowed: %s", relPath)
	}

	cleanRel := filepath.ToSlash(filepath.Clean(relPath))
	cleanRel = strings.TrimPrefix(cleanRel, "./")
	if cleanRel == ".." || strings.HasPrefix(cleanRel, "../") {
		return fmt.Errorf("path escapes workspace: %s", relPath)
	}

	if IsProtectedWorkspacePath(cleanRel) {
		return fmt.Errorf("path is protected and cannot be modified by migrations: %s", cleanRel)
	}

	cleanRoot, err := filepath.Abs(workspaceRoot)
	if err != nil {
		cleanRoot = filepath.Clean(workspaceRoot)
	}

	fullTarget := filepath.Join(cleanRoot, filepath.FromSlash(cleanRel))
	cleanFull := filepath.Clean(fullTarget)

	// Ensure target is strictly inside root
	expectedPrefix := cleanRoot + string(filepath.Separator)
	if !strings.HasPrefix(cleanFull, expectedPrefix) && cleanFull != cleanRoot {
		return fmt.Errorf("path escapes workspace root %s: %s", cleanRoot, relPath)
	}

	// Symlink check on each segment from root to target
	if err := CheckNoSymlinksInPath(cleanRoot, cleanRel); err != nil {
		return err
	}

	return nil
}

// CheckNoSymlinksInPath walks each segment from workspaceRoot down to relPath.
// If any existing segment is a symlink, it returns an error.
func CheckNoSymlinksInPath(workspaceRoot, relPath string) error {
	cleanRel := filepath.Clean(filepath.FromSlash(relPath))
	parts := strings.Split(cleanRel, string(filepath.Separator))

	curr := filepath.Clean(workspaceRoot)
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		curr = filepath.Join(curr, part)
		fi, err := os.Lstat(curr)
		if err != nil {
			if os.IsNotExist(err) {
				// Non-existent components are fine (e.g. new files or directories)
				break
			}
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink encountered in path %s at %s", relPath, curr)
		}
	}

	return nil
}
