package cli

import (
	"os"
	"path/filepath"
	"strings"
)

// isInsideWorkingTree checks the path, not the process's working directory.
// Both the named location and its symlink target must be outside a checkout.
func isInsideWorkingTree(file string) bool {
	file, err := filepath.Abs(file)
	if err != nil {
		return false
	}
	if hasOpenLiaCheckoutAncestor(file) {
		return true
	}
	// Keys and state directories may not exist yet. Resolve the nearest existing
	// ancestor so a new file below a symlink into a checkout is also rejected.
	for {
		resolved, err := filepath.EvalSymlinks(file)
		if err == nil {
			return hasOpenLiaCheckoutAncestor(resolved)
		}
		parent := filepath.Dir(file)
		if !os.IsNotExist(err) || parent == file {
			return false
		}
		file = parent
	}
}

func hasOpenLiaCheckoutAncestor(path string) bool {
	for {
		// Git worktrees use a .git file instead of a directory. The module
		// declaration distinguishes OpenLia from unrelated Git repositories.
		if _, err := os.Stat(filepath.Join(path, ".git")); err == nil {
			if data, err := os.ReadFile(filepath.Join(path, "go.mod")); err == nil {
				for _, line := range strings.Split(string(data), "\n") {
					fields := strings.Fields(line)
					if len(fields) >= 2 && fields[0] == "module" && strings.Trim(fields[1], `"`) == "openlia" {
						return true
					}
				}
			}
		}
		parent := filepath.Dir(path)
		if parent == path {
			return false
		}
		path = parent
	}
}
