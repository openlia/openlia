package operator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type UninstallResult struct {
	OK         bool   `json:"ok"`
	Action     string `json:"action"`
	State      string `json:"state"`
	Containers string `json:"containers,omitempty"`
	Network    string `json:"network,omitempty"`
	Backups    string `json:"backups,omitempty"`
	Images     string `json:"images"`
}

func Uninstall(ctx context.Context, config Config, compose Compose) (UninstallResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return UninstallResult{}, err
	}
	if filepath.Clean(config.RuntimeRoot) != filepath.Join(filepath.Clean(config.InstallRoot), "runtime") {
		return UninstallResult{}, fmt.Errorf("runtime root does not match install root")
	}
	if strings.HasPrefix(config.InstallRoot, "/home/") && !strings.Contains(strings.TrimPrefix(config.InstallRoot, "/home/"), "/") {
		return UninstallResult{}, fmt.Errorf("install-root must be below a user home directory, not the home directory itself")
	}
	if info, err := os.Lstat(config.InstallRoot); errors.Is(err, os.ErrNotExist) {
		return UninstallResult{OK: true, Action: "uninstall", State: "absent", Images: "preserved"}, nil
	} else if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return UninstallResult{}, fmt.Errorf("install-root must be a non-symlink directory")
	}
	markerPath := filepath.Join(config.MetaRoot, "runtime.json")
	data, err := os.ReadFile(markerPath)
	if err != nil {
		return UninstallResult{}, fmt.Errorf("runtime marker is missing; refusing to remove an unmarked root")
	}
	var marker RuntimeMetadata
	if json.Unmarshal(data, &marker) != nil || marker.InstallRoot != config.InstallRoot || marker.Project != config.ProjectName || marker.Network != config.NetworkName {
		return UninstallResult{}, fmt.Errorf("installation marker does not match configured installation")
	}
	_ = StopReconcilerDaemon(config)
	backupUnlock, err := acquireBackupLock(ctx, config)
	if err != nil {
		return UninstallResult{}, fmt.Errorf("cannot quiesce backup before uninstall: %w", err)
	}
	defer backupUnlock()
	if _, err := RemoveBackupScheduleContext(ctx, config, compose); err != nil {
		return UninstallResult{}, fmt.Errorf("backup schedule cleanup failed; installation root was preserved: %w", err)
	}
	current := filepath.Join(config.InstallRoot, "current")
	if _, err := os.Lstat(current); err == nil {
		resolved, resolveErr := filepath.EvalSymlinks(current)
		releasesRoot, releasesErr := filepath.EvalSymlinks(filepath.Join(config.InstallRoot, "releases"))
		if resolveErr != nil || releasesErr != nil || !within(resolved, releasesRoot) {
			return UninstallResult{}, fmt.Errorf("current release points outside installation root")
		}
	}
	if info, err := os.Stat(config.ComposeFile); err == nil && info.Mode().IsRegular() {
		if _, err := compose.Run(ctx, "down", "--remove-orphans"); err != nil {
			return UninstallResult{}, fmt.Errorf("Compose shutdown failed")
		}
	} else {
		containers, err := compose.Docker(ctx, "ps", "-aq", "--filter", "label=com.docker.compose.project="+config.ProjectName)
		if err != nil {
			return UninstallResult{}, fmt.Errorf("Docker container validation failed")
		}
		if ids := strings.Fields(string(containers.Stdout)); len(ids) > 0 {
			args := append([]string{"rm", "-f"}, ids...)
			if _, err := compose.Docker(ctx, args...); err != nil {
				return UninstallResult{}, fmt.Errorf("Docker container removal failed")
			}
		}
	}
	remaining, err := compose.Docker(ctx, "ps", "-aq", "--filter", "label=com.docker.compose.project="+config.ProjectName)
	if err != nil {
		return UninstallResult{}, fmt.Errorf("Docker container validation failed")
	}
	if strings.TrimSpace(string(remaining.Stdout)) != "" {
		return UninstallResult{}, fmt.Errorf("Compose containers remain; installation root was preserved")
	}
	network, networkErr := compose.Docker(ctx, "network", "inspect", config.NetworkName)
	if networkErr == nil && strings.TrimSpace(string(network.Stdout)) != "" {
		owner, ownerErr := compose.Docker(ctx, "network", "inspect", config.NetworkName, "--format", "{{index .Labels \"com.docker.compose.project\"}}")
		if ownerErr != nil {
			return UninstallResult{}, fmt.Errorf("configured network could not be validated")
		}
		project := strings.TrimSpace(string(owner.Stdout))
		if project != "" && project != config.ProjectName {
			return UninstallResult{}, fmt.Errorf("the configured network belongs to another Compose project; installation root was preserved")
		}
		if project == config.ProjectName {
			if _, err := compose.Docker(ctx, "network", "rm", config.NetworkName); err != nil {
				return UninstallResult{}, fmt.Errorf("project network could not be removed")
			}
		}
	}
	if networkErr != nil {
		// A non-zero inspect means the network is absent. The command runner
		// still reports an unavailable Docker binary as an operational failure.
		if network.ExitCode == 0 {
			return UninstallResult{}, fmt.Errorf("Docker network validation failed")
		}
	}
	if _, err := compose.Docker(ctx, "network", "inspect", config.NetworkName); err == nil {
		return UninstallResult{}, fmt.Errorf("project network remains; installation root was preserved")
	}
	if err := os.RemoveAll(config.InstallRoot); err != nil {
		return UninstallResult{}, err
	}
	if _, err := os.Lstat(config.InstallRoot); !errors.Is(err, os.ErrNotExist) {
		return UninstallResult{}, fmt.Errorf("installation root could not be removed")
	}
	return UninstallResult{OK: true, Action: "uninstall", State: "removed", Containers: "removed", Network: "removed", Backups: "local-removed; remote-preserved", Images: "preserved"}, nil
}
