package operator

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	LochoHostServiceAPI       = "hermes-api"
	LochoHostServiceDashboard = "hermes-dashboard"
	HermesAPIPort             = 8642
	HermesDashboardPort       = 9119
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

	hostedServices := []struct {
		name string
		port int
	}{
		{name: LochoHostServiceAPI, port: HermesAPIPort},
		{name: LochoHostServiceDashboard, port: HermesDashboardPort},
	}

	var hostID string
	var builder strings.Builder
	serviceNames := make([]string, 0, len(hostedServices))

	for idx, svc := range hostedServices {
		args := []string{"exec", "-T", "locho-host", "locho", "share", svc.name, "--config", "/var/lib/openlia-locho-host/locho.toml"}
		if config.LochoRelayConfig != "" {
			args = append(args, "--relay-config", "/etc/locho/relay.toml")
		}
		result, err := compose.Run(ctx, args...)
		if err != nil {
			return LochoHostShareResult{}, fmt.Errorf("share %s capability: %w", svc.name, err)
		}
		parsedHostID, capability, err := parseLochoShareOutput(string(result.Stdout), svc.name)
		if err != nil {
			return LochoHostShareResult{}, err
		}
		if idx == 0 {
			hostID = parsedHostID
			fmt.Fprintf(&builder, "host_id = %s\nlisten_host = \"127.0.0.1\"\n\n", strconv.Quote(hostID))
		} else if parsedHostID != hostID {
			return LochoHostShareResult{}, fmt.Errorf("Locho returned mismatched host_id for %s", svc.name)
		}
		fmt.Fprintf(&builder, "[[services]]\ncapability = %s\nlisten_port = %d\n\n", strconv.Quote(capability), svc.port)
		serviceNames = append(serviceNames, svc.name)
	}

	return LochoHostShareResult{
		HostID:           hostID,
		AttachmentConfig: builder.String(),
		Services:         serviceNames,
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
