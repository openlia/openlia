package operator

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type LochoHostShareResult struct {
	HostID           string
	AttachmentConfig string
	Services         []string
}

func ensureLochoHostDirectory(path string, uid, gid int) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		if err := os.Mkdir(path, 0o700); err != nil {
			return fmt.Errorf("create Locho host directory %s: %w", path, err)
		}
		info, err = os.Lstat(path)
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("Locho host path must be a real directory: %s", path)
	}
	return ensureRuntimeOwner(path, uid, gid, 0o700)
}

func ensureLochoHostStateFiles(stateRoot string, uid, gid int) error {
	for _, name := range []string{"host.key", "host_state.json"} {
		filePath := filepath.Join(stateRoot, name)
		info, err := os.Lstat(filePath)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("Locho host state file must be a regular non-symlink file: %s", filePath)
		}
		if err := ensureRuntimeOwner(filePath, uid, gid, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func ShareLochoHost(ctx context.Context, config Config, compose Compose) (LochoHostShareResult, error) {
	if !config.LochoHostEnabled {
		return LochoHostShareResult{}, fmt.Errorf("locho-host is disabled")
	}
	if err := config.ValidatePaths(); err != nil {
		return LochoHostShareResult{}, err
	}
	if !compose.ServiceRunning(ctx, "locho-host") {
		return LochoHostShareResult{}, fmt.Errorf("locho-host is not running; deploy the stack first")
	}

	args := []string{"exec", "-T", "locho-host", "locho", "share", "workspace-ui", "--config", "/var/lib/openlia-locho-host/locho.toml"}
	if config.LochoRelayConfig != "" {
		args = append(args, "--relay-config", "/etc/locho/relay.toml")
	}
	result, err := compose.Run(ctx, args...)
	if err != nil {
		return LochoHostShareResult{}, fmt.Errorf("share workspace-ui capability: %w", err)
	}
	hostID, capability, err := parseLochoShareOutput(string(result.Stdout), "workspace-ui")
	if err != nil {
		return LochoHostShareResult{}, err
	}

	var builder strings.Builder
	fmt.Fprintf(&builder, "host_id = %s\nlisten_host = \"127.0.0.1\"\n\n", strconv.Quote(hostID))
	fmt.Fprintf(&builder, "[[services]]\ncapability = %s\nlisten_port = %d\n\n", strconv.Quote(capability), config.WorkspaceUIPort)
	return LochoHostShareResult{
		HostID:           hostID,
		AttachmentConfig: builder.String(),
		Services:         []string{"workspace-ui"},
	}, nil
}

func parseLochoShareOutput(output, expectedService string) (string, string, error) {
	fields := strings.Fields(output)
	for index := 0; index+3 < len(fields); index++ {
		if fields[index] != "locho" || fields[index+1] != "attach" {
			continue
		}
		hostID, capability := fields[index+2], fields[index+3]
		parts := strings.Split(capability, ":")
		if hostID == "" || len(parts) != 3 || parts[0] != expectedService || parts[1] != "tcp" || parts[2] == "" {
			return "", "", fmt.Errorf("Locho returned an invalid %s capability", expectedService)
		}
		return hostID, capability, nil
	}
	return "", "", fmt.Errorf("Locho did not return a %s attachment command", expectedService)
}
