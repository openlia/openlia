package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func commandWorkspaceExport(options Options, args []string) int {
	set := newFlagSet("workspace export")
	if err := set.Parse(args); err != nil {
		return ExitUsage
	}
	if set.NArg() > 1 {
		return fail(options, ExitUsage, "workspace export accepts at most one destination archive path", nil)
	}

	destPath := "openlia-workspace-export.zip"
	if set.NArg() == 1 {
		destPath = set.Arg(0)
	}

	if !strings.HasSuffix(strings.ToLower(destPath), ".zip") {
		return fail(options, ExitUsage, "destination archive must have a .zip extension", nil)
	}

	absDest, err := filepath.Abs(destPath)
	if err != nil {
		return fail(options, ExitUsage, "invalid destination path: "+err.Error(), nil)
	}

	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	exportID := fmt.Sprintf("exp-%s", time.Now().UTC().Format("20060102-150405"))
	targetArchive := deployment.rootPath("runtime", "backups", fmt.Sprintf(".openlia-workspace-export-%s.zip", exportID))

	// Step 1: Run workspace-export on the target deployment
	_, err = deployment.operation(ctx, "workspace-export", nil, "--output", targetArchive, "--json")
	if err != nil {
		return fail(options, ExitFailure, "workspace export failed: "+err.Error(), nil)
	}

	// Step 2: Download the generated zip archive to local destination
	// If local destination already exists, remove it first so downloadFile can create it
	_ = os.Remove(absDest)
	if err := deployment.downloadFile(ctx, targetArchive, absDest); err != nil {
		_ = deployment.removeFile(ctx, targetArchive)
		return fail(options, ExitFailure, "download exported workspace archive: "+err.Error(), nil)
	}

	// Step 3: Clean up target archive
	_ = deployment.removeFile(ctx, targetArchive)

	info, statErr := os.Stat(absDest)
	sizeBytes := int64(0)
	if statErr == nil {
		sizeBytes = info.Size()
	}

	humanMsg := fmt.Sprintf("Exported workspace, skills, and assistant memory to %s (%s).\n\nTo unpack and serve locally:\n  unzip %s -d ./my-workspace\n  openlia workspace serve ./my-workspace/workspace",
		destPath, formatExportBytes(sizeBytes), destPath)

	return writeResult(options, map[string]any{
		"schema":     1,
		"ok":         true,
		"action":     "export",
		"path":       absDest,
		"size_bytes": sizeBytes,
	}, humanMsg)
}

func formatExportBytes(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}
