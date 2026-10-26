package operator

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type DeployOptions struct {
	Action             string
	Component          string
	ForceStart         bool
	ForceRecreate      bool
	HealthAttempts     int
	HealthPollInterval time.Duration
}

type DeployResult struct {
	OK     bool   `json:"ok"`
	Action string `json:"action"`
	State  string `json:"state"`
	Backup string `json:"backup"`
}

func Deploy(ctx context.Context, config Config, compose Compose, options DeployOptions, now time.Time) (DeployResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return DeployResult{}, err
	}
	runtimeMetadata := filepath.Join(config.MetaRoot, "runtime.json")
	if info, err := os.Stat(runtimeMetadata); err == nil && info.Mode().IsRegular() {
		if err := ensureRuntimeOwner(runtimeMetadata, config.RuntimeUID, config.RuntimeGID, 0o600); err != nil {
			return DeployResult{}, fmt.Errorf("runtime metadata permissions could not be normalized: %w", err)
		}
	}
	if options.Component == "" {
		options.Component = "all"
	}
	if options.Action == "" {
		options.Action = "deploy"
	}
	if options.Action != "deploy" && options.Action != "start" && options.Action != "stop" && options.Action != "restart" {
		return DeployResult{}, fmt.Errorf("unknown deploy action %s", options.Action)
	}
	if options.Component != "all" && options.Component != "hermes" && options.Component != "locho" && options.Component != "workspace-ui" {
		return DeployResult{}, fmt.Errorf("component must be all, hermes, locho, or workspace-ui")
	}
	if info, err := os.Stat(config.ComposeFile); err != nil || !info.Mode().IsRegular() {
		return DeployResult{}, fmt.Errorf("base Compose file is missing")
	}
	if info, err := os.Stat(config.SecretFile); err != nil || !info.Mode().IsRegular() {
		return DeployResult{}, fmt.Errorf("Docker secret source is missing; run bootstrap first")
	}
	previous, err := ReadState(config)
	if err != nil {
		return DeployResult{}, err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return DeployResult{}, err
	}
	if options.Action == "stop" {
		if _, err := compose.Run(ctx, "stop"); err != nil {
			_ = WriteState(config, previous)
			_ = RecordChange(config, "stop", "failed", "", "Compose stop failed", now)
			return DeployResult{}, fmt.Errorf("Compose stop failed")
		}
		if err := WriteState(config, stateStopped); err != nil {
			return DeployResult{}, err
		}
		if err := RecordChange(config, "stop", "ok", "", "explicit stop recorded", now); err != nil {
			return DeployResult{}, err
		}
		return DeployResult{OK: true, Action: "stop", State: stateStopped, Backup: ""}, nil
	}
	backup := ""
	if _, err := compose.Run(ctx, "config", "--quiet"); err != nil {
		_ = RecordChange(config, options.Action, "failed", backup, "Compose configuration validation failed", now)
		return DeployResult{}, fmt.Errorf("Compose configuration validation failed")
	}
	if options.Action == "deploy" {
		if options.Component == "locho" && config.LochoHostEnabled && !compose.ServiceRunning(ctx, "workspace-ui") {
			return DeployResult{}, fmt.Errorf("locho-host requires running workspace-ui; run openlia deploy first")
		}
		if options.Component == "all" || options.Component == "hermes" {
			if _, err := compose.Run(ctx, "build", "hermes"); err != nil {
				_ = RecordChange(config, options.Action, "failed", backup, "Hermes image build failed", now)
				return DeployResult{}, fmt.Errorf("Hermes image build failed")
			}
		}
		if options.Component == "all" && config.BackupScheduleEnabled {
			if _, err := compose.Run(ctx, "build", "backup-scheduler"); err != nil {
				_ = RecordChange(config, options.Action, "failed", backup, "backup scheduler image build failed", now)
				return DeployResult{}, fmt.Errorf("backup scheduler image build failed")
			}
		}
		if options.Component == "all" || options.Component == "locho" {
			services := composeServices(ctx, compose)
			if len(services) > 0 {
				args := append([]string{"build"}, services...)
				if _, err := compose.Run(ctx, args...); err != nil {
					_ = RecordChange(config, options.Action, "failed", backup, "Locho image build failed", now)
					return DeployResult{}, fmt.Errorf("Locho image build failed")
				}
			}
		}
		if options.Component == "all" && config.WorkspaceUIHost != "" {
			if _, err := compose.Run(ctx, "build", "workspace-ui"); err != nil {
				_ = RecordChange(config, options.Action, "failed", backup, "workspace UI image build failed", now)
				return DeployResult{}, fmt.Errorf("workspace UI image build failed")
			}
		}
		if options.Component == "workspace-ui" {
			if config.WorkspaceUIHost == "" {
				return DeployResult{}, fmt.Errorf("workspace UI is disabled")
			}
			if _, err := compose.Run(ctx, "build", "workspace-ui"); err != nil {
				_ = RecordChange(config, options.Action, "failed", backup, "workspace UI image build failed", now)
				return DeployResult{}, fmt.Errorf("workspace UI image build failed")
			}
		}
	}
	if options.Action == "start" || options.Action == "restart" {
		options.ForceStart = true
	}
	shouldStart := options.ForceStart || (options.Action == "deploy" && previous != stateStopped)
	if shouldStart {
		normalizeWorkspace := func() error {
			ownership := strconv.Itoa(config.RuntimeUID) + ":" + strconv.Itoa(config.RuntimeGID)
			_, err := compose.Run(ctx, "exec", "-T", "-u", "root", "hermes", "sh", "-c", "chown -R "+ownership+" /opt/data/workspace && chmod 700 /opt/data/workspace")
			return err
		}
		workspaceUIStartedAfterHermes := false
		if options.Component == "all" && config.WorkspaceUIHost != "" && options.Action != "restart" {
			if _, err := compose.Run(ctx, "up", "-d", "--no-deps", "hermes"); err != nil {
				_ = RecordChange(config, options.Action, "failed", backup, "Hermes could not be started before Workspace UI", now)
				return DeployResult{}, fmt.Errorf("Hermes could not be started before Workspace UI: %w", err)
			}
			if err := normalizeWorkspace(); err != nil {
				_ = RecordChange(config, options.Action, "failed", backup, "workspace permissions could not be normalized", now)
				return DeployResult{}, fmt.Errorf("workspace permissions could not be normalized: %w", err)
			}
			workspaceUIStartedAfterHermes = true
		}
		var args []string
		switch {
		case options.Action == "restart" && options.Component == "all":
			// Compose restart does not refresh changed environment values. Recreate
			// the stack so configuration changes reach every service.
			args = []string{"up", "-d", "--force-recreate"}
		case options.Component == "all":
			args = []string{"up", "-d", "--remove-orphans"}
			if options.ForceRecreate {
				args = []string{"up", "-d", "--force-recreate", "--remove-orphans"}
			}
		case options.Component == "hermes":
			args = []string{"up", "-d", "--no-deps", "hermes"}
		case options.Component == "workspace-ui":
			args = []string{"up", "-d", "--no-deps", "--force-recreate", "workspace-ui"}
		default:
			services := composeServices(ctx, compose)
			if len(services) == 0 {
				return DeployResult{}, fmt.Errorf("stack was not started")
			}
			args = []string{"up", "-d"}
			if options.ForceRecreate {
				args = append(args, "--force-recreate")
			}
			args = append(args, append([]string{"--no-deps"}, services...)...)
		}
		lochoHostWasRunning := false
		workspaceUIBefore := ""
		if config.LochoHostEnabled {
			lochoHostWasRunning = compose.ServiceRunning(ctx, "locho-host")
			workspaceUIBefore = composeContainerID(ctx, compose, "workspace-ui")
		}
		if res, err := compose.Run(ctx, args...); err != nil {
			msg := strings.TrimSpace(string(res.Stderr))
			if msg == "" {
				msg = strings.TrimSpace(string(res.Stdout))
			}
			_ = RecordChange(config, options.Action, "failed", backup, "Compose start failed: "+msg, now)
			return DeployResult{}, fmt.Errorf("Compose start failed (%s): %w", msg, err)
		}
		reconcileLochoHost := config.LochoHostEnabled && options.Component == "workspace-ui"
		if config.LochoHostEnabled && options.Component == "all" && lochoHostWasRunning && options.Action != "restart" {
			reconcileLochoHost = workspaceUIBefore != composeContainerID(ctx, compose, "workspace-ui")
		}
		if reconcileLochoHost {
			if res, err := compose.Run(ctx, "up", "-d", "--no-deps", "--force-recreate", "locho-host"); err != nil {
				msg := strings.TrimSpace(string(res.Stderr))
				if msg == "" {
					msg = strings.TrimSpace(string(res.Stdout))
				}
				_ = RecordChange(config, options.Action, "failed", backup, "Locho host reconciliation failed: "+msg, now)
				return DeployResult{}, fmt.Errorf("Locho host reconciliation failed (%s): %w", msg, err)
			}
		}
		if (options.Component == "all" || options.Component == "hermes") && !workspaceUIStartedAfterHermes {
			// Normalize the bind-mounted workspace through the container user, not a
			// host-side chown that may not exist on Docker Desktop.
			ownership := strconv.Itoa(config.RuntimeUID) + ":" + strconv.Itoa(config.RuntimeGID)
			_, _ = compose.Run(ctx, "exec", "-T", "-u", "root", "hermes", "sh", "-c", "chown -R "+ownership+" /opt/data/workspace && chmod 700 /opt/data/workspace")
		}
		if err := WriteState(config, stateRunning); err != nil {
			return DeployResult{}, err
		}
		attempts := options.HealthAttempts
		if attempts <= 0 {
			attempts = 30
		}
		interval := options.HealthPollInterval
		if interval <= 0 {
			interval = 2 * time.Second
		}
		healthy := false
		for attempt := 0; attempt < attempts; attempt++ {
			healthyNow := deploymentReady(ctx, config, compose, options.Component)
			if healthyNow {
				healthy = true
				break
			}
			if attempt+1 < attempts {
				timer := time.NewTimer(interval)
				select {
				case <-ctx.Done():
					timer.Stop()
					_ = RecordChange(config, options.Action, "failed", backup, "health check cancelled after start", now)
					return DeployResult{}, ctx.Err()
				case <-timer.C:
				}
			}
		}
		if healthy && options.Component != "workspace-ui" {
			health, healthErr := Healthcheck(ctx, config, compose, false, false)
			healthy = healthErr == nil && health.OK
		}
		if !healthy {
			_ = RecordChange(config, options.Action, "failed", backup, "health check failed after start", now)
			return DeployResult{}, fmt.Errorf("health check failed after start; previous image metadata is retained")
		}
	} else if options.Action == "start" || options.Action == "restart" {
		_ = RecordChange(config, options.Action, "failed", backup, "stack was not started", now)
		return DeployResult{}, fmt.Errorf("stack was not started")
	}
	state, err := ReadState(config)
	if err != nil {
		return DeployResult{}, err
	}
	if err := RecordChange(config, options.Action, "ok", backup, "state="+state, now); err != nil {
		return DeployResult{}, err
	}
	return DeployResult{OK: true, Action: options.Action, State: state, Backup: backup}, nil
}

func composeContainerID(ctx context.Context, compose Compose, service string) string {
	result, err := compose.Run(ctx, "ps", "-q", service)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(result.Stdout))
}

// deploymentReady avoids running the full diagnostic health check on every
// two-second poll. The full check still runs once after the services are up.
func deploymentReady(ctx context.Context, config Config, compose Compose, component string) bool {
	result, err := compose.Run(ctx, "ps", "--services", "--filter", "status=running")
	if err != nil {
		return false
	}
	running := map[string]bool{}
	for _, service := range strings.Split(strings.TrimSpace(string(result.Stdout)), "\n") {
		if service = strings.TrimSpace(service); service != "" {
			running[service] = true
		}
	}
	required := []string{}
	switch component {
	case "hermes":
		required = []string{"hermes"}
	case "locho":
		required = append(required, composeServices(ctx, compose)...)
	case "workspace-ui":
		required = []string{"workspace-ui"}
	default:
		configured, configErr := compose.Run(ctx, "config", "--services")
		if configErr != nil {
			return false
		}
		for _, service := range strings.Split(strings.TrimSpace(string(configured.Stdout)), "\n") {
			if service = strings.TrimSpace(service); service != "" {
				required = append(required, service)
			}
		}
	}
	for _, service := range required {
		if !running[service] {
			return false
		}
	}
	if component == "workspace-ui" || (component == "all" && config.WorkspaceUIHost != "") {
		if !workspaceUIHealthy(ctx, config, compose) {
			return false
		}
	}
	if component == "all" || component == "hermes" || component == "locho" {
		command := "command -v hermes >/dev/null && hermes config check && command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null && command -v pdfinfo >/dev/null && command -v pdftoppm >/dev/null && command -v pdftotext >/dev/null && command -v yt-dlp >/dev/null && /opt/hermes/.venv/bin/python -c 'import PIL, openpyxl, xlrd, pypdfium2, jsonschema, msoffcrypto'"
		if _, err := compose.Run(ctx, "exec", "-T", "hermes", "sh", "-c", command); err != nil {
			return false
		}
	}
	if config.LochoHostEnabled && (component == "all" || component == "locho" || component == "workspace-ui") && !lochoHostHealthy(ctx, config, compose) {
		return false
	}
	return true
}

func lochoHostHealthy(ctx context.Context, config Config, compose Compose) bool {
	if !config.LochoHostEnabled || !compose.ServiceRunning(ctx, "locho-host") {
		return false
	}
	command := fmt.Sprintf("set -eu; set -- $(getent ahostsv4 workspace-ui); workspace_ip=\"$1\"; grep -F \"endpoint = \\\"$workspace_ip:%d\\\"\" /var/lib/openlia-locho-host/locho.toml >/dev/null; curl --fail --silent --show-error --max-time 5 http://workspace-ui:%d/health >/dev/null", config.WorkspaceUIPort, config.WorkspaceUIPort)
	_, err := compose.Run(ctx, "exec", "-T", "locho-host", "sh", "-c", command)
	return err == nil
}

func workspaceUIHealthy(ctx context.Context, config Config, compose Compose) bool {
	if config.WorkspaceUIHost == "" || !compose.ServiceRunning(ctx, "workspace-ui") {
		return false
	}
	result, err := compose.Run(ctx, "port", "workspace-ui", strconv.Itoa(config.WorkspaceUIPort))
	if err != nil {
		return false
	}
	binding := strings.TrimSpace(string(result.Stdout))
	if !strings.Contains(binding, fmt.Sprintf("%s:%d", config.WorkspaceUIHost, config.WorkspaceUIPort)) {
		return false
	}
	_, err = compose.Run(ctx, "exec", "-T", "workspace-ui", "bun", "-e", fmt.Sprintf("fetch('http://127.0.0.1:%d/health').then(r => { if (!r.ok) process.exit(1) })", config.WorkspaceUIPort))
	return err == nil
}

func composeServices(ctx context.Context, compose Compose) []string {
	result, err := compose.Run(ctx, "config", "--services")
	if err != nil {
		return nil
	}
	services := []string{}
	for _, service := range strings.Split(strings.TrimSpace(string(result.Stdout)), "\n") {
		if strings.HasPrefix(service, "locho-") {
			services = append(services, service)
		}
	}
	return services
}

type HealthResult struct {
	Schema       int            `json:"schema"`
	OK           bool           `json:"ok"`
	State        string         `json:"state"`
	Checks       []RuntimeCheck `json:"checks"`
	Secrets      string         `json:"secrets"`
	Capabilities string         `json:"capabilities"`
}

func Healthcheck(ctx context.Context, config Config, compose Compose, allowStopped, providerCheck bool) (HealthResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return HealthResult{}, err
	}
	state, err := ReadState(config)
	if err != nil {
		return HealthResult{}, err
	}
	result := HealthResult{Schema: 1, OK: true, State: state, Checks: []RuntimeCheck{}, Secrets: "redacted", Capabilities: "redacted"}
	add := func(name string, ok bool, detail string) {
		result.Checks = append(result.Checks, RuntimeCheck{Name: name, OK: ok, Detail: detail})
		if !ok {
			result.OK = false
		}
	}
	if _, err := compose.Docker(ctx, "info"); err != nil {
		add("docker", false, "unavailable")
	} else {
		add("docker", true, "available")
	}
	filesystem := ""
	if result, fsErr := compose.Host(ctx, "findmnt", "-T", config.DataRoot, "-n", "-o", "FSTYPE"); fsErr == nil {
		filesystem = strings.TrimSpace(string(result.Stdout))
	} else if result, statErr := compose.Host(ctx, "stat", "-f", "%T", config.DataRoot); statErr == nil {
		filesystem = strings.TrimSpace(string(result.Stdout))
	}
	switch {
	case filesystem == "":
		add("data_filesystem", true, "unverified")
	case filesystem == "nfs" || filesystem == "nfs4" || filesystem == "cifs" || filesystem == "smbfs" || strings.HasPrefix(filesystem, "fuse."):
		add("data_filesystem", false, "unsupported:"+filesystem)
	default:
		add("data_filesystem", true, filesystem)
	}
	if _, err := os.Stat(config.ComposeFile); err != nil {
		add("compose", false, "invalid_or_missing")
	} else if _, err := compose.Run(ctx, "config", "--quiet"); err != nil {
		add("compose", false, "invalid_or_missing")
	} else {
		add("compose", true, "valid")
	}
	if state == stateRunning {
		add("explicit_stop_state", true, stateRunning)
	} else if state == stateStopped {
		add("explicit_stop_state", true, stateStopped)
		if !allowStopped {
			add("expected_running", false, "explicitly_stopped")
		}
	} else {
		add("explicit_stop_state", true, stateNeverStarted)
		add("expected_running", false, "never_started")
	}
	servicesResult, servicesErr := compose.Run(ctx, "config", "--services")
	services := []string{}
	if servicesErr != nil {
		add("services", false, "unavailable")
	} else {
		for _, service := range strings.Split(strings.TrimSpace(string(servicesResult.Stdout)), "\n") {
			service = strings.TrimSpace(service)
			if service == "" {
				continue
			}
			services = append(services, service)
			if compose.ServiceRunning(ctx, service) {
				add("service:"+service, true, "running")
				if strings.HasPrefix(service, "locho-") {
					published, portErr := compose.Run(ctx, "port", service)
					if portErr != nil || strings.TrimSpace(string(published.Stdout)) == "" {
						add("listener:"+service, true, "private_only")
					} else {
						add("listener:"+service, false, "published")
					}
				} else if service == "workspace-ui" {
					expectedHost, expectedPort := config.WorkspaceUIHost, config.WorkspaceUIPort
					endpointErr := validateWorkspaceUI(expectedHost, expectedPort, config.WorkspaceUIAuthRequired, config.WorkspaceUIPasswordHashFile, config.WorkspaceUIFirebaseProjectID, config.WorkspaceUIAllowedEmails, config.WorkspaceUIFirebaseAPIKey, config.WorkspaceUIFirebaseAuthDomain)
					published, portErr := compose.Run(ctx, "port", service, strconv.Itoa(expectedPort))
					binding := strings.TrimSpace(string(published.Stdout))
					expectedBinding := fmt.Sprintf("%s:%d", expectedHost, expectedPort)
					if endpointErr != nil || portErr != nil || binding == "" {
						add("listener:workspace-ui", false, "missing_configured_port")
					} else if strings.Contains(binding, expectedBinding) {
						if _, probeErr := compose.Run(ctx, "exec", "-T", "workspace-ui", "bun", "-e", fmt.Sprintf("fetch('http://127.0.0.1:%d/health').then(r => { if (!r.ok) process.exit(1) })", expectedPort)); probeErr != nil {
							add("listener:workspace-ui", false, "health_endpoint_unavailable")
						} else {
							add("listener:workspace-ui", true, "configured_endpoint")
						}
					} else {
						add("listener:workspace-ui", false, "unexpected_endpoint")
					}
				}
			} else if state == stateStopped && allowStopped {
				add("service:"+service, true, "stopped")
			} else {
				add("service:"+service, false, "not_running")
			}
		}
	}
	if config.LochoHostEnabled {
		if state == stateStopped && allowStopped {
			add("locho_host_upstreams", true, "stopped")
		} else if lochoHostHealthy(ctx, config, compose) {
			add("locho_host_upstreams", true, "workspace-ui_reachable")
		} else {
			add("locho_host_upstreams", false, "unreachable_or_stale")
		}
	}
	hermesRunning := compose.ServiceRunning(ctx, "hermes")
	if hermesRunning {
		if _, err := compose.Run(ctx, "exec", "-T", "hermes", "sh", "-c", "command -v hermes >/dev/null && command -v bun >/dev/null && command -v uv >/dev/null && command -v git >/dev/null"); err != nil {
			add("hermes_runtimes", false, "hermes_bun_uv_git_missing")
		} else {
			add("hermes_runtimes", true, "hermes_bun_uv_git_available")
		}
		if _, err := compose.Run(ctx, "exec", "-T", "hermes", "sh", "-c", "command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null && command -v pdfinfo >/dev/null && command -v pdftoppm >/dev/null && command -v pdftotext >/dev/null && command -v yt-dlp >/dev/null && /opt/hermes/.venv/bin/python -c 'import PIL, openpyxl, xlrd, pypdfium2, jsonschema, msoffcrypto'"); err != nil {
			add("hermes_ingestion", false, "required_dependency_missing")
		} else {
			add("hermes_ingestion", true, "required_dependencies_available")
		}
		if _, err := compose.Run(ctx, "exec", "-T", "hermes", "hermes", "config", "check"); err != nil {
			add("hermes_config", false, "invalid")
		} else {
			add("hermes_config", true, "valid")
		}
		if providerCheck {
			if _, err := compose.Run(ctx, "exec", "-T", "hermes", "hermes", "doctor"); err != nil {
				add("hermes_doctor", false, "failed")
			} else {
				add("hermes_doctor", true, "healthy")
			}
			if _, err := compose.Run(ctx, "exec", "-T", "hermes", "hermes", "chat", "--oneshot", "-q", "Reply with OPENLIA_PROVIDER_CHECK"); err != nil {
				add("provider_request", false, "failed_or_unconfigured")
			} else {
				add("provider_request", true, "completed")
			}
			if baseURL := parseBaseURL(config.SecretFile); baseURL != "" {
				if config.Provider == "copilot" {
					add("openai_endpoint", false, "OPENAI_BASE_URL_must_be_unset_use_openai_gateway")
				} else if strings.Contains(baseURL, "://localhost") || strings.Contains(baseURL, "://127.0.0.1") {
					add("openai_endpoint", false, "container_cannot_reach_host_localhost_use_locho_service")
				}
			}
		} else {
			add("hermes_doctor", true, "not_requested")
			add("provider_request", true, "not_requested")
		}
		if _, err := compose.Run(ctx, "exec", "-T", "hermes", "sh", "-c", "test -d /opt/data/workspace && test -f /opt/data/workspace/AGENTS.md"); err != nil {
			add("workspace", false, "missing_or_uninitialized")
		} else {
			add("workspace", true, "initialized")
		}
	} else if state == stateStopped && allowStopped {
		add("hermes_runtimes", true, "stopped")
		add("hermes_config", true, "stopped")
		add("hermes_doctor", true, "not_requested")
		add("provider_request", true, "not_requested")
		if _, err := compose.Run(ctx, "exec", "-T", "hermes", "sh", "-c", "test -d /opt/data/workspace && test -f /opt/data/workspace/AGENTS.md"); err != nil {
			add("workspace", true, "stopped")
		} else {
			add("workspace", true, "initialized")
		}
	} else {
		add("hermes_runtimes", false, "hermes_not_running")
		add("hermes_config", false, "hermes_not_running")
		add("hermes_doctor", false, "hermes_not_running")
		add("provider_request", true, "not_requested")
		add("workspace", false, "hermes_not_running")
	}
	containerID, containerErr := compose.Run(ctx, "ps", "-q", "hermes")
	if containerErr == nil && strings.TrimSpace(string(containerID.Stdout)) != "" {
		id := strings.TrimSpace(string(containerID.Stdout))
		privileged, inspectErr := compose.Docker(ctx, "inspect", id, "--format", "{{.HostConfig.Privileged}}")
		if inspectErr != nil {
			add("container_privileged", false, "inspect_failed")
		} else if strings.TrimSpace(string(privileged.Stdout)) == "false" {
			add("container_privileged", true, "disabled")
		} else {
			add("container_privileged", false, strings.TrimSpace(string(privileged.Stdout)))
		}
		mounts, mountsErr := compose.Docker(ctx, "inspect", id, "--format", "{{range .Mounts}}{{.Source}} {{.Destination}}\\n{{end}}")
		if mountsErr != nil {
			add("docker_socket", false, "inspect_failed")
		} else if strings.Contains(string(mounts.Stdout), "docker.sock") {
			add("docker_socket", false, "mounted")
		} else {
			add("docker_socket", true, "absent")
		}
		for _, mount := range []struct {
			name, destination, expected string
		}{
			{"data_mount", "/opt/data", config.DataRoot},
			{"secret_mount", "/run/openlia-secrets", config.SecretDir},
		} {
			result, mountErr := compose.Docker(ctx, "inspect", id, "--format", fmt.Sprintf("{{range .Mounts}}{{if eq .Destination %q}}{{.Source}}{{end}}{{end}}", mount.destination))
			if mountErr != nil {
				add(mount.name, false, "inspect_failed")
			} else if strings.TrimSpace(string(result.Stdout)) != mount.expected {
				add(mount.name, false, "unexpected_source")
			} else {
				add(mount.name, true, "configured")
			}
		}
		networks, networksErr := compose.Docker(ctx, "inspect", id, "--format", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}")
		if networksErr != nil {
			add("network", false, "inspect_failed")
		} else if !strings.Contains(" "+string(networks.Stdout), " "+config.NetworkName+" ") {
			add("network", false, "unexpected_network")
		} else {
			add("network", true, "configured")
		}
	} else if state == stateStopped && allowStopped {
		add("container_privileged", true, "stopped")
		add("docker_socket", true, "stopped")
	} else {
		add("container_privileged", false, "hermes_container_missing")
		add("docker_socket", false, "hermes_container_missing")
	}
	if info, statErr := os.Stat(config.SecretFile); statErr == nil && info.Mode().Perm() == 0o600 {
		add("secret_source", true, "mode_0600")
	} else {
		add("secret_source", false, "missing_or_wrong_mode")
	}
	attachments, attachErr := ListAttachments(config)
	if attachErr == nil && len(attachments.Hosts) > 0 {
		registryPath := filepath.Join(config.DataRoot, "services.json")
		if info, statErr := os.Stat(registryPath); statErr == nil && info.Mode().IsRegular() {
			add("services_registry", true, "present")
		} else {
			add("services_registry", false, "missing")
		}
	}
	return result, nil
}
