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
	LochoHostServiceWorkspace = "workspace-ui"
	HermesAPIPort             = 8642
	HermesDashboardPort       = 9119
	WorkspaceUIPort           = 8089
)

type LochoHostShareResult struct {
	HostID           string
	AttachmentConfig string
	Services         []string
}

type LochoShareServiceSpec struct {
	Name string
	Port int
}

func ParseLochoShareServices(raw string, defaultWorkspacePort int) ([]LochoShareServiceSpec, error) {
	if defaultWorkspacePort <= 0 {
		defaultWorkspacePort = WorkspaceUIPort
	}
	defaults := map[string]int{
		LochoHostServiceAPI:       HermesAPIPort,
		LochoHostServiceDashboard: HermesDashboardPort,
		LochoHostServiceWorkspace: defaultWorkspacePort,
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return []LochoShareServiceSpec{
			{Name: LochoHostServiceAPI, Port: HermesAPIPort},
			{Name: LochoHostServiceDashboard, Port: HermesDashboardPort},
			{Name: LochoHostServiceWorkspace, Port: defaultWorkspacePort},
		}, nil
	}
	seenServices := make(map[string]bool)
	seenPorts := make(map[int]bool)
	parts := strings.Split(trimmed, ",")
	specs := make([]LochoShareServiceSpec, 0, len(parts))
	for _, item := range parts {
		token := strings.TrimSpace(item)
		if token == "" {
			return nil, fmt.Errorf("empty service entry in --services")
		}
		name, portStr, hasPort := strings.Cut(token, ":")
		name = strings.TrimSpace(name)
		defaultPort, ok := defaults[name]
		if !ok {
			return nil, fmt.Errorf("unknown locho-host service %q (supported: %s, %s, %s)", name, LochoHostServiceAPI, LochoHostServiceDashboard, LochoHostServiceWorkspace)
		}
		if seenServices[name] {
			return nil, fmt.Errorf("duplicate locho-host service %q in --services", name)
		}
		port := defaultPort
		if hasPort {
			parsedPort, err := strconv.Atoi(strings.TrimSpace(portStr))
			if err != nil || parsedPort < 1 || parsedPort > 65535 {
				return nil, fmt.Errorf("invalid listen port %q for service %s (must be 1..65535)", portStr, name)
			}
			port = parsedPort
		}
		if seenPorts[port] {
			return nil, fmt.Errorf("duplicate listen port %d in --services", port)
		}
		seenServices[name] = true
		seenPorts[port] = true
		specs = append(specs, LochoShareServiceSpec{Name: name, Port: port})
	}
	return specs, nil
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

func ShareLochoHost(ctx context.Context, config Config, compose Compose, servicesFilter ...string) (LochoHostShareResult, error) {
	if !config.LochoHostEnabled {
		return LochoHostShareResult{}, fmt.Errorf("locho-host is disabled")
	}
	if err := config.ValidatePaths(); err != nil {
		return LochoHostShareResult{}, err
	}
	rawFilter := ""
	if len(servicesFilter) > 0 {
		rawFilter = servicesFilter[0]
	}
	hostedServices, err := ParseLochoShareServices(rawFilter, workspaceUIPort(config))
	if err != nil {
		return LochoHostShareResult{}, err
	}
	if !compose.ServiceRunning(ctx, "locho-host") {
		return LochoHostShareResult{}, fmt.Errorf("locho-host is not running; deploy the stack first")
	}

	var hostID string
	var builder strings.Builder
	serviceNames := make([]string, 0, len(hostedServices))

	for idx, svc := range hostedServices {
		args := []string{"exec", "-T", "locho-host", "locho", "share", svc.Name, "--config", "/var/lib/openlia-locho-host/locho.toml"}
		if config.LochoRelayConfig != "" {
			args = append(args, "--relay-config", "/etc/locho/relay.toml")
		}
		result, err := compose.Run(ctx, args...)
		if err != nil {
			return LochoHostShareResult{}, fmt.Errorf("share %s capability: %w", svc.Name, err)
		}
		parsedHostID, capability, err := parseLochoShareOutput(string(result.Stdout), svc.Name)
		if err != nil {
			return LochoHostShareResult{}, err
		}
		if idx == 0 {
			hostID = parsedHostID
			fmt.Fprintf(&builder, "host_id = %s\nlisten_host = \"127.0.0.1\"\n\n", strconv.Quote(hostID))
		} else if parsedHostID != hostID {
			return LochoHostShareResult{}, fmt.Errorf("Locho returned mismatched host_id for %s", svc.Name)
		}
		fmt.Fprintf(&builder, "[[services]]\ncapability = %s\nlisten_port = %d\n\n", strconv.Quote(capability), svc.Port)
		serviceNames = append(serviceNames, svc.Name)
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
