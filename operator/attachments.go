package operator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type LochoService struct {
	Host            string `json:"host"`
	Name            string `json:"name"`
	Protocol        string `json:"protocol"`
	Port            int    `json:"port"`
	Endpoint        string `json:"endpoint"`
	Role            string `json:"role"`
	HTTPTimeoutSecs int    `json:"http_timeout_secs,omitempty"`
}

type AttachmentHost struct {
	Host         string         `json:"host"`
	Configured   bool           `json:"configured"`
	ServiceCount int            `json:"service_count"`
	Services     []LochoService `json:"services"`
	Capabilities string         `json:"capabilities"`
}

type ServiceRegistry struct {
	Schema      int            `json:"schema"`
	GeneratedAt string         `json:"generated_at"`
	Services    []LochoService `json:"services"`
}

type AttachmentListResult struct {
	OK           bool             `json:"ok"`
	Hosts        []AttachmentHost `json:"hosts"`
	Capabilities string           `json:"capabilities"`
}

func ListAttachments(config Config) (AttachmentListResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return AttachmentListResult{}, err
	}
	result := AttachmentListResult{OK: true, Hosts: []AttachmentHost{}, Capabilities: "redacted"}
	entries, err := os.ReadDir(config.LochoRoot)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return AttachmentListResult{}, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if ValidateSafeComponent(entry.Name(), "host") != nil {
			continue
		}
		if len(config.ConfiguredHosts) > 0 {
			configured := false
			for _, h := range config.ConfiguredHosts {
				if h == entry.Name() {
					configured = true
					break
				}
			}
			if !configured {
				continue
			}
		}
		path := filepath.Join(config.LochoRoot, entry.Name(), "attachments.toml")
		if info, statErr := os.Stat(path); statErr != nil || !info.Mode().IsRegular() {
			continue
		}
		services, err := serviceInventory(entry.Name(), path, config.ServiceRoles)
		if err != nil {
			return AttachmentListResult{}, err
		}
		result.Hosts = append(result.Hosts, AttachmentHost{
			Host:         entry.Name(),
			Configured:   true,
			ServiceCount: len(services),
			Services:     services,
			Capabilities: "redacted",
		})
	}
	sort.Slice(result.Hosts, func(i, j int) bool { return result.Hosts[i].Host < result.Hosts[j].Host })
	return result, nil
}

func GenerateAttachments(config Config, composers ...Compose) error {
	return GenerateAttachmentsContext(context.Background(), config, composers...)
}

func GenerateAttachmentsContext(ctx context.Context, config Config, composers ...Compose) error {
	if err := config.ValidatePaths(); err != nil {
		return err
	}
	if config.APIHost != "127.0.0.1" {
		return fmt.Errorf("API host must remain 127.0.0.1")
	}
	if config.ExternalNetwork != "" {
		if err := ValidateSafeComponent(config.ExternalNetwork, "external-network"); err != nil {
			return err
		}
	}
	if err := EnsureDir(config.LochoRoot, 0o700); err != nil {
		return err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	if config.WorkspaceUIAuthRequired {
		sessionDir := filepath.Join(config.RuntimeRoot, "workspace-ui")
		if err := EnsureDir(sessionDir, 0o700); err != nil {
			return err
		}
		if err := ensureRuntimeOwner(sessionDir, config.RuntimeUID, config.RuntimeGID, 0o700); err != nil {
			return err
		}
	}
	ingestionDir := filepath.Join(config.DataRoot, "ingestion")
	if err := EnsureDir(ingestionDir, 0o700); err != nil {
		return err
	}
	if err := ensureRuntimeOwner(ingestionDir, config.RuntimeUID, config.RuntimeGID, 0o700); err != nil {
		return err
	}
	if len(composers) > 0 {
		return generateAttachmentsWithCompose(ctx, config, composers[0])
	}
	return generateAttachmentsFile(config)
}

func generateAttachmentsWithCompose(ctx context.Context, config Config, compose Compose) error {
	if err := EnsureDir(config.LochoRoot, 0o700); err != nil {
		return err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	generatedBackup := ""
	wasPresent := false
	previousConfig, configErr := os.ReadFile(filepath.Join(config.DataRoot, "config.yaml"))
	configPresent := configErr == nil
	if info, err := os.Stat(config.GeneratedCompose); err == nil && info.Mode().IsRegular() {
		wasPresent = true
		if _, err := CreateRollback(config, "attachments-generate", time.Now().UTC(), runtimeRelativePath(config, filepath.Join(config.DataRoot, "config.yaml")), runtimeRelativePath(config, filepath.Join(config.DataRoot, "services.json")), runtimeRelativePath(config, filepath.Join(config.MetaRoot, "services.json"))); err != nil {
			return err
		}
		generatedBackup, err = backupFile(config, config.GeneratedCompose, "compose-generated", 0o600, time.Now().UTC())
		if err != nil {
			return err
		}
	}
	restore := func() {
		if generatedBackup != "" {
			_ = AtomicCopyFile(generatedBackup, config.GeneratedCompose, 0o600)
		} else if !wasPresent {
			_ = os.Remove(config.GeneratedCompose)
		}
		configPath := filepath.Join(config.DataRoot, "config.yaml")
		if configPresent {
			_ = AtomicWriteFile(configPath, previousConfig, 0o600)
		} else {
			_ = os.Remove(configPath)
		}
	}
	if err := generateAttachmentsFile(config); err != nil {
		restore()
		_ = RecordChange(config, "attachments-generate", "failed", generatedBackup, "Compose sidecar generation failed", time.Now().UTC())
		return err
	}
	if result, err := compose.Run(ctx, "config", "--quiet"); err != nil {
		restore()
		_ = RecordChange(config, "attachments-generate", "failed", generatedBackup, "generated Compose validation failed", time.Now().UTC())
		detail := strings.TrimSpace(string(result.Stderr))
		if detail == "" {
			detail = strings.TrimSpace(string(result.Stdout))
		}
		if detail != "" {
			return fmt.Errorf("generated Compose validation failed: %s", detail)
		}
		return fmt.Errorf("generated Compose validation failed")
	}
	currentConfig, currentConfigErr := os.ReadFile(filepath.Join(config.DataRoot, "config.yaml"))
	policyChanged := configPresent && currentConfigErr == nil && string(previousConfig) != string(currentConfig)
	if policyChanged {
		state, stateErr := ReadState(config)
		if stateErr != nil {
			restore()
			return stateErr
		}
		if state == stateRunning {
			if _, restartErr := compose.Run(ctx, "up", "-d", "--no-deps", "--force-recreate", "hermes"); restartErr != nil {
				restore()
				if _, recoveryErr := compose.Run(ctx, "up", "-d", "--no-deps", "--force-recreate", "hermes"); recoveryErr != nil {
					return fmt.Errorf("Hermes browser policy reconciliation failed: %w; rollback restart failed: %v", restartErr, recoveryErr)
				}
				return fmt.Errorf("Hermes browser policy reconciliation failed: %w", restartErr)
			}
		}
	}
	return RecordChange(config, "attachments-generate", "ok", "", "Compose sidecars regenerated", time.Now().UTC())
}

func generateAttachmentsFile(config Config) error {
	if err := validateWorkspaceUI(config.WorkspaceUIHost, config.WorkspaceUIPort, config.WorkspaceUIAuthRequired, config.WorkspaceUIPasswordHashFile, config.WorkspaceUIFirebaseProjectID, config.WorkspaceUIAllowedEmails, config.WorkspaceUIFirebaseAPIKey, config.WorkspaceUIFirebaseAuthDomain); err != nil {
		return err
	}
	if err := validateOpenWebUI(config.OpenWebUIHost, config.OpenWebUIPort, config.OpenWebUIGoogleClientID, config.OpenWebUIGoogleClientSecret, config.OpenWebUIURL, config.OpenWebUIAllowedDomains, config.OpenWebUIAllowedEmails, config.OpenWebUIEnableOAuthSignup); err != nil {
		return err
	}
	if config.LochoHostEnabled {
		if err := writeLochoHostConfig(config); err != nil {
			return err
		}
	}
	apiEnvPath := filepath.Join(config.SecretDir, "api-server.env")
	if config.OpenWebUIHost != "" {
		if err := EnsureOpenWebUISecrets(config); err != nil {
			return err
		}
	}
	if config.APIEnabled || config.OpenWebUIHost != "" {
		if err := ensureAPIServerEnv(config, apiEnvPath); err != nil {
			return err
		}
	}
	workspaceUIHost, workspaceUIPort := config.WorkspaceUIHost, config.WorkspaceUIPort
	hosts, err := ListAttachments(config)
	if err != nil {
		return err
	}
	for _, host := range hosts.Hosts {
		path := filepath.Join(config.LochoRoot, host.Host, "attachments.toml")
		if err := ensureLochoReadable(config, path); err != nil {
			return fmt.Errorf("prepare Locho attachment %s: %w", host.Host, err)
		}
	}
	var allServices []LochoService
	browserURL := ""
	hasOpenLiaBrowserRole := false
	for _, host := range hosts.Hosts {
		for _, svc := range host.Services {
			allServices = append(allServices, svc)
			if svc.Role == "openlia-browser" {
				hasOpenLiaBrowserRole = true
				if browserURL != "" && browserURL != svc.Endpoint {
					return fmt.Errorf("multiple openlia-browser attachment endpoints are configured")
				}
				browserURL = svc.Endpoint
			}
		}
	}

	registry := ServiceRegistry{
		Schema:      1,
		GeneratedAt: utcTimestamp(time.Now().UTC()),
		Services:    allServices,
	}
	registryBytes, marshalErr := json.MarshalIndent(registry, "", "  ")
	if marshalErr == nil {
		if ensureErr := EnsureDir(config.DataRoot, 0o700); ensureErr == nil {
			path := filepath.Join(config.DataRoot, "services.json")
			if err := AtomicWriteFile(path, append(registryBytes, '\n'), 0o600); err == nil {
				_ = ensureHermesReadable(path)
			}
		}
		if ensureErr := EnsureDir(config.MetaRoot, 0o700); ensureErr == nil {
			_ = AtomicWriteFile(filepath.Join(config.MetaRoot, "services.json"), append(registryBytes, '\n'), 0o600)
		}
	}

	var builder strings.Builder
	hasHermesEnv := config.APIEnabled || config.OpenWebUIHost != "" || config.ExternalNetwork != "" || browserURL != "" || config.WorkspaceUIPublicOrigin != "" || len(allServices) > 0
	schedulerVolumes := append(backupSchedulerIdentityVolumes(config), backupSchedulerCredentialVolumes(config)...)
	hasGeneratedServices := hasHermesEnv || config.WorkspaceUIHost != "" || config.OpenWebUIHost != "" || len(hosts.Hosts) > 0 || len(schedulerVolumes) > 0
	if !hasGeneratedServices {
		builder.WriteString("services: {}\n")
	} else {
		builder.WriteString("services:\n")
		if hasHermesEnv {
			builder.WriteString("  hermes:\n")
			if config.APIEnabled {
				fmt.Fprintf(&builder, "    ports:\n      - %q\n", config.APIHost+":8642:8642")
			}
			builder.WriteString("    environment:\n")
			if config.APIEnabled || config.OpenWebUIHost != "" {
				builder.WriteString("      API_SERVER_ENABLED: \"true\"\n      API_SERVER_HOST: \"0.0.0.0\"\n")
			}
			if config.WorkspaceUIPublicOrigin != "" {
				fmt.Fprintf(&builder, "      OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN: %q\n", config.WorkspaceUIPublicOrigin)
			}
			if browserURL != "" {
				fmt.Fprintf(&builder, "      OPENLIA_BROWSER_MCP_URL: %q\n", browserURL)
			}
			for _, svc := range allServices {
				if svc.Role != "unassigned" {
					envKey := fmt.Sprintf("OPENLIA_SERVICE_%s_%s_URL", sanitizeEnvKey(svc.Host), sanitizeEnvKey(svc.Name))
					fmt.Fprintf(&builder, "      %s: %q\n", envKey, svc.Endpoint)
				}
			}
			if config.APIEnabled || config.OpenWebUIHost != "" {
				quotedAPIEnvPath, _ := json.Marshal(apiEnvPath)
				builder.WriteString("    env_file:\n      - ")
				builder.Write(quotedAPIEnvPath)
				builder.WriteString("\n")
			}
			if config.ExternalNetwork != "" {
				builder.WriteString("    networks:\n      - openlia-private\n      - openlia-external\n")
			}
		}
	}
	if config.WorkspaceUIHost != "" {
		workspace, _ := json.Marshal(filepath.Join(config.DataRoot, "workspace"))
		skills, _ := json.Marshal(filepath.Join(config.DataRoot, "skills"))
		memories, _ := json.Marshal(filepath.Join(config.DataRoot, "memories"))
		ingestion, _ := json.Marshal(filepath.Join(config.DataRoot, "ingestion"))
		migrations, _ := json.Marshal(filepath.Join(config.DataRoot, ".openlia", "workspace-migrations"))
		sessionDir, _ := json.Marshal(filepath.Join(config.RuntimeRoot, "workspace-ui"))
		passwordHashFile, _ := json.Marshal(config.WorkspaceUIPasswordHashFile)
		builder.WriteString("  workspace-ui:\n    image: \"${OPENLIA_WORKSPACE_UI_IMAGE:-openlia-workspace-ui:v0.1.0}\"\n")
		builder.WriteString("    build:\n      context: ..\n      dockerfile: docker/workspace-ui.Dockerfile\n")
		builder.WriteString(fmt.Sprintf("    command: [\"bun\", \"/opt/openlia/workspace-ui/server.js\"]\n    restart: unless-stopped\n    user: \"%d:%d\"\n    read_only: true\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,size=32m\n    security_opt:\n      - no-new-privileges:true\n    cap_drop: [ALL]\n    environment:\n      OPENLIA_WORKSPACE_ROOT: /workspace\n      OPENLIA_SKILLS_ROOT: /skills\n      OPENLIA_VERSION: %q\n      OPENLIA_REVISION: %q\n      OPENLIA_HERMES_VERSION: %q\n      OPENLIA_LOCHO_VERSION: %q\n      OPENLIA_WORKSPACE_UI_BIND: 0.0.0.0\n      OPENLIA_WORKSPACE_UI_PORT: \"%d\"\n", config.RuntimeUID, config.RuntimeGID, config.OpenLiaVersion, config.OpenLiaRevision, config.HermesVersion, config.LochoVersion, workspaceUIPort))
		if config.OpenLiaReleaseSHA256 != "" {
			builder.WriteString(fmt.Sprintf("      OPENLIA_RELEASE_SHA256: %q\n", config.OpenLiaReleaseSHA256))
		}
		builder.WriteString("      OPENLIA_INGESTION_ROOT: /ingestion\n")
		builder.WriteString("      OPENLIA_MEMORIES_ROOT: /memories\n")
		builder.WriteString("      OPENLIA_MIGRATIONS_ROOT: /migrations\n")
		builder.WriteString("      OPENLIA_RUNTIME_ROOT: /var/lib/openlia\n")
		builder.WriteString("      OPENLIA_DATA_ROOT: /workspace/..\n")
		quotedPublicOrigin, _ := json.Marshal(config.WorkspaceUIPublicOrigin)
		builder.WriteString("      OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN: ")
		builder.Write(quotedPublicOrigin)
		builder.WriteString("\n")
		isFirebase := config.WorkspaceUIFirebaseProjectID != ""
		if isFirebase {
			builder.WriteString(fmt.Sprintf("      OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS: %q\n", strings.Join(config.WorkspaceUIAllowedEmails, ",")))
			builder.WriteString(fmt.Sprintf("      OPENLIA_WORKSPACE_UI_FIREBASE_PROJECT_ID: %q\n", config.WorkspaceUIFirebaseProjectID))
			builder.WriteString(fmt.Sprintf("      OPENLIA_WORKSPACE_UI_FIREBASE_API_KEY: %q\n", config.WorkspaceUIFirebaseAPIKey))
			builder.WriteString(fmt.Sprintf("      OPENLIA_WORKSPACE_UI_FIREBASE_AUTH_DOMAIN: %q\n", config.WorkspaceUIFirebaseAuthDomain))
			if config.WorkspaceUIFirebaseAppID != "" {
				builder.WriteString(fmt.Sprintf("      OPENLIA_WORKSPACE_UI_FIREBASE_APP_ID: %q\n", config.WorkspaceUIFirebaseAppID))
			}
			builder.WriteString("      OPENLIA_WORKSPACE_UI_SESSION_DB: /var/lib/openlia/sessions.sqlite\n")
		} else if config.WorkspaceUIAuthRequired {
			builder.WriteString("      OPENLIA_WORKSPACE_UI_AUTH_REQUIRED: \"true\"\n      OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE: /run/openlia-secrets/workspace-ui-password.hash\n      OPENLIA_WORKSPACE_UI_SESSION_DB: /var/lib/openlia/sessions.sqlite\n")
		}
		builder.WriteString("    volumes:\n      - type: bind\n        source: ")
		builder.Write(workspace)
		builder.WriteString("\n        target: /workspace\n      - type: bind\n        source: ")
		builder.Write(skills)
		builder.WriteString("\n        target: /skills\n      - type: bind\n        source: ")
		builder.Write(memories)
		builder.WriteString("\n        target: /memories\n      - type: bind\n        source: ")
		builder.Write(ingestion)
		builder.WriteString("\n        target: /ingestion\n        read_only: true\n      - type: bind\n        source: ")
		builder.Write(migrations)
		builder.WriteString("\n        target: /migrations")
		if !isFirebase && config.WorkspaceUIAuthRequired {
			builder.WriteString("\n      - type: bind\n        source: ")
			builder.Write(passwordHashFile)
			builder.WriteString("\n        target: /run/openlia-secrets/workspace-ui-password.hash\n        read_only: true")
		}
		if isFirebase || config.WorkspaceUIAuthRequired {
			builder.WriteString("\n      - type: bind\n        source: ")
			builder.Write(sessionDir)
			builder.WriteString("\n        target: /var/lib/openlia")
		}
		builder.WriteString(fmt.Sprintf("\n    ports:\n      - %q\n    networks:\n      - openlia-private\n    healthcheck:\n      test: [\"CMD\", \"bun\", \"-e\", \"fetch('http://127.0.0.1:%d/health').then(r => { if (!r.ok) process.exit(1) })\"]\n      interval: 10s\n      timeout: 3s\n      retries: 5\n    deploy:\n      resources:\n        limits:\n          cpus: \"0.5\"\n          memory: 256M\n    logging:\n      driver: \"json-file\"\n      options:\n        max-size: \"20m\"\n        max-file: \"5\"\n", fmt.Sprintf("%s:%d:%d", workspaceUIHost, workspaceUIPort, workspaceUIPort), workspaceUIPort))
	}
	if config.OpenWebUIHost != "" {
		dataRoot, _ := json.Marshal(config.OpenWebUIDataRoot)
		envFilePath, _ := json.Marshal(filepath.Join(config.SecretDir, "open-webui.env"))
		image := config.OpenWebUIImage
		if image == "" {
			image = "${OPENLIA_OPEN_WEBUI_IMAGE:-ghcr.io/open-webui/open-webui:main}"
		}
		builder.WriteString("  open-webui:\n")
		fmt.Fprintf(&builder, "    image: %q\n", image)
		builder.WriteString("    restart: unless-stopped\n")
		fmt.Fprintf(&builder, "    ports:\n      - %q\n", fmt.Sprintf("%s:%d:8080", config.OpenWebUIHost, config.OpenWebUIPort))
		builder.WriteString("    volumes:\n      - type: bind\n        source: ")
		builder.Write(dataRoot)
		builder.WriteString("\n        target: /app/backend/data\n")
		builder.WriteString("    env_file:\n      - ")
		builder.Write(envFilePath)
		builder.WriteString("\n    environment:\n")
		builder.WriteString("      OPENAI_API_BASE_URL: \"http://hermes:8642/v1\"\n")
		builder.WriteString("      ENABLE_OLLAMA_API: \"False\"\n")
		builder.WriteString("      WEBUI_NAME: \"OpenLia\"\n")
		if config.OpenWebUIAuth {
			builder.WriteString("      WEBUI_AUTH: \"True\"\n")
		} else {
			builder.WriteString("      WEBUI_AUTH: \"False\"\n")
		}
		if config.OpenWebUIGoogleClientID != "" {
			builder.WriteString("      ENABLE_OAUTH: \"True\"\n")
			builder.WriteString(fmt.Sprintf("      GOOGLE_CLIENT_ID: %q\n", config.OpenWebUIGoogleClientID))
			builder.WriteString(fmt.Sprintf("      WEBUI_URL: %q\n", config.OpenWebUIURL))
			if config.OpenWebUIEnableOAuthSignup {
				builder.WriteString("      ENABLE_OAUTH_SIGNUP: \"True\"\n")
			} else {
				builder.WriteString("      ENABLE_OAUTH_SIGNUP: \"False\"\n")
			}
			builder.WriteString("      OAUTH_MERGE_ACCOUNTS_BY_EMAIL: \"True\"\n")
			builder.WriteString("      ENABLE_LOGIN_FORM: \"False\"\n")
			if len(config.OpenWebUIAllowedDomains) > 0 {
				builder.WriteString(fmt.Sprintf("      OAUTH_ALLOWED_DOMAINS: %q\n", strings.Join(config.OpenWebUIAllowedDomains, ",")))
			}
		}
		builder.WriteString("    networks:\n      - openlia-private\n")
		fmt.Fprintf(&builder, "    healthcheck:\n      test: [\"CMD\", \"python3\", \"-c\", %q]\n      interval: 10s\n      timeout: 5s\n      retries: 5\n", openWebUIHealthProbe)
		builder.WriteString("    deploy:\n      resources:\n        limits:\n          cpus: \"1.0\"\n          memory: 1G\n")
		builder.WriteString("    logging:\n      driver: \"json-file\"\n      options:\n        max-size: \"20m\"\n        max-file: \"5\"\n")
	}
	if config.LochoHostEnabled {
		lochoRoot, _ := json.Marshal(config.LochoHostRoot)
		lochoCommand := "set -eu; set -- $(getent ahostsv4 workspace-ui); workspace_ip=\"$$1\"; set -- $(getent ahostsv4 open-webui); open_webui_ip=\"$$1\"; config=/var/lib/openlia-locho-host/locho.toml; temporary=\"$$config.tmp\"; trap 'rm -f \"$$temporary\"' EXIT; printf '" + lochoHostConfigFormat(config.WorkspaceUIPort, 8080) + "' \"$$workspace_ip\" \"$$open_webui_ip\" > \"$$temporary\"; chmod 600 \"$$temporary\"; mv -f \"$$temporary\" \"$$config\"; trap - EXIT; exec locho host --config \"$$config\""
		if config.LochoRelayConfig != "" {
			lochoCommand += " --relay-config /etc/locho/relay.toml"
		}
		quotedLochoCommand, _ := json.Marshal(lochoCommand)
		builder.WriteString("  locho-host:\n")
		builder.WriteString("    image: \"${OPENLIA_LOCHO_IMAGE:-openlia-locho:v1.2.0}\"\n")
		fmt.Fprintf(&builder, "    build:\n      context: ..\n      dockerfile: docker/locho.Dockerfile\n      args:\n        LOCHO_BASE_IMAGE: \"${LOCHO_BASE_IMAGE:-debian}\"\n        LOCHO_BASE_TAG: \"${LOCHO_BASE_TAG:-13.4-slim}\"\n        LOCHO_BASE_DIGEST: \"${LOCHO_BASE_DIGEST:-sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b}\"\n        LOCHO_VERSION: %q\n        LOCHO_X86_64_SHA256: %q\n        LOCHO_AARCH64_SHA256: %q\n", config.LochoVersion, config.LochoX8664SHA256, config.LochoARM64SHA256)
		builder.WriteString(fmt.Sprintf("    entrypoint: [\"sh\", \"-c\"]\n    command: [%s]\n    restart: unless-stopped\n    user: \"%d:%d\"\n    read_only: true\n    tmpfs:\n      - /tmp\n    security_opt:\n      - no-new-privileges:true\n    cap_drop: [ALL]\n    environment:\n      LOCHO_STATE_DIR: /var/lib/openlia-locho-host/state\n    volumes:\n      - type: bind\n        source: %s\n        target: /var/lib/openlia-locho-host\n", quotedLochoCommand, config.RuntimeUID, config.RuntimeGID, lochoRoot))
		if config.LochoRelayConfig != "" {
			fmt.Fprintf(&builder, "      - type: bind\n        source: %q\n        target: /etc/locho/relay.toml\n        read_only: true\n", config.LochoRelayConfig)
		}
		if config.LochoRelaySecrets != "" {
			fmt.Fprintf(&builder, "    env_file:\n      - %q\n", config.LochoRelaySecrets)
		}
		builder.WriteString("    depends_on:\n      - workspace-ui\n      - open-webui\n    networks:\n      - openlia-private\n    deploy:\n      resources:\n        limits:\n          cpus: \"0.5\"\n          memory: 512M\n    logging:\n      driver: \"json-file\"\n      options:\n        max-size: \"20m\"\n        max-file: \"5\"\n")
	}
	for _, host := range hosts.Hosts {
		configPath := filepath.Join(config.LochoRoot, host.Host, "attachments.toml")
		quoted, _ := json.Marshal(configPath)
		fmt.Fprintf(&builder, "  locho-%s:\n", host.Host)
		builder.WriteString("    image: \"${OPENLIA_LOCHO_IMAGE:-openlia-locho:v1.2.0}\"\n")
		fmt.Fprintf(&builder, "    build:\n      context: ..\n      dockerfile: docker/locho.Dockerfile\n      args:\n        LOCHO_BASE_IMAGE: \"${LOCHO_BASE_IMAGE:-debian}\"\n        LOCHO_BASE_TAG: \"${LOCHO_BASE_TAG:-13.4-slim}\"\n        LOCHO_BASE_DIGEST: \"${LOCHO_BASE_DIGEST:-sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b}\"\n        LOCHO_VERSION: %q\n        LOCHO_X86_64_SHA256: %q\n        LOCHO_AARCH64_SHA256: %q\n", config.LochoVersion, config.LochoX8664SHA256, config.LochoARM64SHA256)
		builder.WriteString("    command: [\"attach\", \"--config\", \"/etc/locho/attachments.toml\"")
		if config.LochoRelayConfig != "" {
			builder.WriteString(", \"--relay-config\", \"/etc/locho/relay.toml\"")
		}
		fmt.Fprintf(&builder, "]\n    restart: unless-stopped\n    user: \"%d:%d\"\n    read_only: true\n    tmpfs:\n      - /tmp\n    security_opt:\n      - no-new-privileges:true\n    cap_drop: [ALL]\n    volumes:\n      - type: bind\n        source: %s\n        target: /etc/locho/attachments.toml\n        read_only: true\n", config.RuntimeUID, config.RuntimeGID, quoted)
		if config.LochoRelayConfig != "" {
			fmt.Fprintf(&builder, "      - type: bind\n        source: %q\n        target: /etc/locho/relay.toml\n        read_only: true\n", config.LochoRelayConfig)
		}
		if config.LochoRelaySecrets != "" {
			fmt.Fprintf(&builder, "    env_file:\n      - %q\n", config.LochoRelaySecrets)
		}
		builder.WriteString("    networks:\n      - openlia-private\n")
		builder.WriteString("    deploy:\n      resources:\n        limits:\n          cpus: \"0.5\"\n          memory: 512M\n")
		builder.WriteString("    logging:\n      driver: \"json-file\"\n      options:\n        max-size: \"20m\"\n        max-file: \"5\"\n")
	}
	if len(schedulerVolumes) > 0 {
		builder.WriteString("  backup-scheduler:\n    volumes:\n")
		for _, volume := range schedulerVolumes {
			builder.WriteString("      - type: bind\n        source: ")
			builder.WriteString(volume.source)
			builder.WriteString("\n        target: ")
			builder.WriteString(volume.target)
			builder.WriteString("\n        read_only: true\n")
		}
	}
	if config.ExternalNetwork != "" {
		fmt.Fprintf(&builder, "networks:\n  openlia-external:\n    name: %q\n    external: true\n", config.ExternalNetwork)
	}
	if config.LochoRelayConfig != "" {
		if err := ensureLochoReadable(config, config.LochoRelayConfig); err != nil {
			return fmt.Errorf("prepare Locho relay configuration: %w", err)
		}
	}
	generated := builder.String()
	if err := AtomicWriteFile(config.GeneratedCompose, []byte(generated), 0o600); err != nil {
		return err
	}
	if err := ReconcileBrowserPolicy(config, hasOpenLiaBrowserRole, browserURL); err != nil {
		return err
	}
	return nil
}

type backupSchedulerIdentityVolume struct {
	source string
	target string
}

func backupSchedulerIdentityVolumes(config Config) []backupSchedulerIdentityVolume {
	if !config.BackupScheduleEnabled {
		return nil
	}
	volumes := make([]backupSchedulerIdentityVolume, 0)
	for _, destination := range config.BackupDestinations {
		if destination.Type != "rsync" || destination.IdentityFile == "" {
			continue
		}
		source, err := json.Marshal(destination.IdentityFile)
		if err != nil {
			continue
		}
		volumes = append(volumes, backupSchedulerIdentityVolume{
			source: string(source),
			target: "/run/openlia-destinations/" + destination.Name,
		})
	}
	return volumes
}

func backupSchedulerCredentialVolumes(config Config) []backupSchedulerIdentityVolume {
	if !config.BackupScheduleEnabled {
		return nil
	}
	volumes := make([]backupSchedulerIdentityVolume, 0)
	for _, destination := range config.BackupDestinations {
		if destination.Type != "s3" || destination.CredentialsFile == "" {
			continue
		}
		source, err := json.Marshal(filepath.Dir(destination.CredentialsFile))
		if err != nil {
			continue
		}
		volumes = append(volumes, backupSchedulerIdentityVolume{
			source: string(source),
			target: "/run/openlia-destinations/" + destination.Name,
		})
	}
	return volumes
}

func lochoHostConfigFormat(workspacePort, openWebUIPort int) string {
	return fmt.Sprintf("[[services]]\\nname = \"workspace-ui\"\\ntype = \"tcp\"\\nendpoint = \"%%s:%d\"\\n\\n[[services]]\\nname = \"open-webui\"\\ntype = \"tcp\"\\nendpoint = \"%%s:%d\"\\n", workspacePort, openWebUIPort)
}

func writeLochoHostConfig(config Config) error {
	if err := ensureLochoHostDirectory(config.LochoHostRoot, config.RuntimeUID, config.RuntimeGID); err != nil {
		return err
	}
	if err := ensureLochoHostDirectory(config.LochoHostStateRoot, config.RuntimeUID, config.RuntimeGID); err != nil {
		return err
	}
	if info, err := os.Lstat(config.LochoHostConfig); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("Locho host config must be a regular non-symlink file")
		}
		return ensureRuntimeOwner(config.LochoHostConfig, config.RuntimeUID, config.RuntimeGID, 0o600)
	} else if !os.IsNotExist(err) {
		return err
	}
	contents := "[[services]]\nname = \"workspace-ui\"\ntype = \"tcp\"\nendpoint = \"127.0.0.1:" + strconv.Itoa(config.WorkspaceUIPort) + "\"\n\n[[services]]\nname = \"open-webui\"\ntype = \"tcp\"\nendpoint = \"127.0.0.1:" + strconv.Itoa(config.OpenWebUIPort) + "\"\n"
	if err := AtomicWriteFile(config.LochoHostConfig, []byte(contents), 0o600); err != nil {
		return err
	}
	return ensureRuntimeOwner(config.LochoHostConfig, config.RuntimeUID, config.RuntimeGID, 0o600)
}

func ensureAPIServerEnv(config Config, path string) error {
	apiKey, err := readSecretValue(config.SecretFile, "API_SERVER_KEY")
	if err != nil || apiKey == "" {
		return fmt.Errorf("API_SERVER_KEY is required for the Hermes API server")
	}
	if err := ensureSecretDirectory(config); err != nil {
		return err
	}
	if err := AtomicWriteFile(path, []byte("API_SERVER_KEY="+apiKey+"\n"), 0o600); err != nil {
		return err
	}
	return ensureRuntimeOwner(path, config.RuntimeUID, config.RuntimeGID, 0o600)
}

func RotateAttachment(config Config, host, source string, now time.Time, composers ...Compose) error {
	return RotateAttachmentContext(context.Background(), config, host, source, now, composers...)
}

func RotateAttachmentContext(ctx context.Context, config Config, host, source string, now time.Time, composers ...Compose) error {
	if len(composers) > 0 {
		return rotateAttachmentWithCompose(ctx, config, composers[0], host, source, now)
	}
	if err := config.ValidatePaths(); err != nil {
		return err
	}
	if err := ValidateSafeComponent(host, "host"); err != nil {
		return err
	}
	if err := validateExternalSource(config, source, "attachment source"); err != nil {
		return err
	}
	if err := validateAttachmentFile(source); err != nil {
		return err
	}
	targetDir := filepath.Join(config.LochoRoot, host)
	if err := EnsureDir(targetDir, 0o700); err != nil {
		return err
	}
	targetFile := filepath.Join(targetDir, "attachments.toml")
	configBackup := ""
	if info, err := os.Stat(targetFile); err == nil && info.Mode().IsRegular() {
		configBackup, err = backupFile(config, targetFile, "locho-"+host, 0o600, now)
		if err != nil {
			return err
		}
	}
	if _, err := CreateRollback(config, "locho-"+host+"-rotate", now, runtimeRelativePath(config, filepath.Join(config.LochoRoot, host, "attachments.toml")), runtimeRelativePath(config, filepath.Join(config.DataRoot, "services.json")), runtimeRelativePath(config, filepath.Join(config.MetaRoot, "services.json"))); err != nil {
		return err
	}
	if err := AtomicCopyFile(source, targetFile, 0o600); err != nil {
		return err
	}
	if err := ensureLochoReadable(config, targetFile); err != nil {
		return fmt.Errorf("prepare Locho attachment permissions: %w", err)
	}
	if err := GenerateAttachments(config); err != nil {
		if configBackup != "" {
			_ = AtomicCopyFile(configBackup, targetFile, 0o600)
		} else {
			_ = os.Remove(targetFile)
		}
		return err
	}
	return RecordChange(config, "locho-"+host+"-rotate", "ok", configBackup, "single host sidecar replaced", now)
}

func rotateAttachmentWithCompose(ctx context.Context, config Config, compose Compose, host, source string, now time.Time) error {
	if err := config.ValidatePaths(); err != nil {
		return err
	}
	if config.APIHost != "127.0.0.1" {
		return fmt.Errorf("API host must remain 127.0.0.1")
	}
	if err := ValidateSafeComponent(host, "host"); err != nil {
		return err
	}
	if err := validateExternalSource(config, source, "attachment source"); err != nil {
		return err
	}
	if err := validateAttachmentFile(source); err != nil {
		return err
	}
	if err := EnsureDir(config.LochoRoot, 0o700); err != nil {
		return err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	targetDir := filepath.Join(config.LochoRoot, host)
	targetFile := filepath.Join(targetDir, "attachments.toml")
	configBackup := ""
	if info, err := os.Stat(targetFile); err == nil && info.Mode().IsRegular() {
		configBackup, err = backupFile(config, targetFile, "locho-"+host, 0o600, now)
		if err != nil {
			return err
		}
	}
	if _, err := CreateRollback(config, "locho-"+host+"-rotate", now, runtimeRelativePath(config, filepath.Join(config.LochoRoot, host, "attachments.toml")), runtimeRelativePath(config, filepath.Join(config.DataRoot, "services.json")), runtimeRelativePath(config, filepath.Join(config.MetaRoot, "services.json"))); err != nil {
		return err
	}
	generatedBackup := ""
	generatedPresent := false
	if info, err := os.Stat(config.GeneratedCompose); err == nil && info.Mode().IsRegular() {
		generatedPresent = true
		generatedBackup, err = backupFile(config, config.GeneratedCompose, "compose-generated", 0o600, now)
		if err != nil {
			return err
		}
	}
	previousState, err := ReadState(config)
	if err != nil {
		return err
	}
	if configBackup != "" {
		_, _ = compose.Run(ctx, "stop", "locho-"+host)
	}
	restore := func() {
		if configBackup != "" {
			_ = AtomicCopyFile(configBackup, targetFile, 0o600)
			_ = ensureLochoReadable(config, targetFile)
		} else {
			_ = os.Remove(targetFile)
		}
		if generatedBackup != "" {
			_ = AtomicCopyFile(generatedBackup, config.GeneratedCompose, 0o600)
		} else if !generatedPresent {
			_ = os.Remove(config.GeneratedCompose)
		}
	}
	if err := EnsureDir(targetDir, 0o700); err != nil {
		return err
	}
	if err := AtomicCopyFile(source, targetFile, 0o600); err != nil {
		restore()
		if previousState == stateRunning {
			_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "locho-"+host)
		}
		_ = RecordChange(config, "locho-"+host+"-rotate", "failed", configBackup, "attachment replacement failed", now)
		return fmt.Errorf("attachment replacement failed")
	}
	if err := ensureLochoReadable(config, targetFile); err != nil {
		restore()
		if previousState == stateRunning {
			_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "locho-"+host)
		}
		_ = RecordChange(config, "locho-"+host+"-rotate", "failed", configBackup, "attachment permissions could not be prepared", now)
		return fmt.Errorf("attachment permissions could not be prepared")
	}
	if err := generateAttachmentsFile(config); err != nil {
		restore()
		if previousState == stateRunning {
			_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "locho-"+host)
		}
		_ = RecordChange(config, "locho-"+host+"-rotate", "failed", configBackup, "sidecar configuration replacement failed: "+err.Error(), now)
		return fmt.Errorf("sidecar configuration replacement failed (%w); previous attachment was restored", err)
	}
	if _, err := compose.Run(ctx, "config", "--quiet"); err != nil {
		restore()
		if previousState == stateRunning {
			_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "locho-"+host)
		}
		_ = RecordChange(config, "locho-"+host+"-rotate", "failed", configBackup, "generated Compose validation failed", now)
		return fmt.Errorf("generated Compose validation failed; previous attachment was restored")
	}
	if previousState == stateRunning {
		if res, err := compose.Run(ctx, "up", "-d", "--no-deps", "--remove-orphans", "locho-"+host); err != nil {
			restore()
			_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "locho-"+host)
			msg := strings.TrimSpace(string(res.Stderr))
			if msg == "" {
				msg = strings.TrimSpace(string(res.Stdout))
			}
			_ = RecordChange(config, "locho-"+host+"-rotate", "failed", configBackup, "Locho restart failed: "+msg, now)
			return fmt.Errorf("Locho restart failed (%s): %w; previous attachment was restored", msg, err)
		}
	}
	return RecordChange(config, "locho-"+host+"-rotate", "ok", configBackup, "single host sidecar replaced", now)
}

func ensureLochoReadable(config Config, path string) error {
	return ensureRuntimeOwner(path, config.RuntimeUID, config.RuntimeGID, 0o600)
}

func backupFile(config Config, source, label string, mode os.FileMode, now time.Time) (string, error) {
	if err := ValidateSafeComponent(label, "backup-label"); err != nil {
		return "", err
	}
	info, err := os.Stat(source)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("cannot back up a missing file")
	}
	if err := EnsureDir(config.BackupRoot, 0o700); err != nil {
		return "", err
	}
	destination := filepath.Join(config.BackupRoot, fmt.Sprintf("%s-%s-%d", label, now.UTC().Format("20060102T150405Z"), os.Getpid()))
	for suffix := 1; ; suffix++ {
		if _, statErr := os.Lstat(destination); os.IsNotExist(statErr) {
			break
		} else if statErr != nil {
			return "", statErr
		}
		destination = filepath.Join(config.BackupRoot, fmt.Sprintf("%s-%s-%d-%d", label, now.UTC().Format("20060102T150405Z"), os.Getpid(), suffix))
	}
	if err := AtomicCopyFile(source, destination, mode); err != nil {
		return "", err
	}
	_, _ = PruneBackups(config, config.BackupRetention)
	return destination, nil
}

func serviceInventory(host, path string, roles map[string]string) ([]LochoService, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var services []LochoService
	inService := false
	capability := ""
	listenPort := 0
	httpTimeoutSecs := 0
	httpTimeoutConfigured := false
	flush := func() error {
		if !inService {
			return nil
		}
		parts := strings.Split(capability, ":")
		name := ""
		proto := "http"
		if len(parts) >= 3 {
			name = parts[0]
			proto = parts[1]
		} else if len(parts) == 2 {
			name = parts[0]
			if parts[1] == "http" || parts[1] == "tcp" {
				proto = parts[1]
			}
		} else if len(parts) == 1 {
			name = parts[0]
		}
		if httpTimeoutConfigured && (httpTimeoutSecs < 1 || httpTimeoutSecs > 300) {
			return fmt.Errorf("HTTP timeout for %s must be between 1 and 300 seconds", name)
		}
		if proto == "tcp" && httpTimeoutConfigured {
			return fmt.Errorf("TCP service %s cannot define an HTTP timeout", name)
		}
		if name == "" {
			name = fmt.Sprintf("service-%d", len(services)+1)
		}
		role := "unassigned"
		if assigned, ok := roles[host+"."+name]; ok && assigned != "" {
			role = assigned
		} else if assigned, ok := roles[name]; ok && assigned != "" {
			role = assigned
		}
		endpoint := fmt.Sprintf("http://locho-%s:%d", host, listenPort)
		if proto == "tcp" && role != "openlia-browser" {
			endpoint = fmt.Sprintf("locho-%s:%d", host, listenPort)
		}
		services = append(services, LochoService{
			Host:            host,
			Name:            name,
			Protocol:        proto,
			Port:            listenPort,
			Endpoint:        endpoint,
			Role:            role,
			HTTPTimeoutSecs: httpTimeoutSecs,
		})
		return nil
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "[[services]]" {
			if err := flush(); err != nil {
				return nil, err
			}
			inService = true
			capability = ""
			listenPort = 0
			httpTimeoutSecs = 0
			httpTimeoutConfigured = false
			continue
		}
		if !inService {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "capability":
			if parsed, parseErr := strconv.Unquote(strings.TrimSpace(value)); parseErr == nil {
				capability = parsed
			}
		case "listen_port":
			if parsed, parseErr := strconv.Atoi(strings.TrimSpace(value)); parseErr == nil {
				listenPort = parsed
			}
		case "http_timeout_secs":
			httpTimeoutConfigured = true
			rawTimeout := strings.TrimSpace(strings.SplitN(value, "#", 2)[0])
			rawTimeout = strings.ReplaceAll(rawTimeout, "_", "")
			if parsed, parseErr := strconv.Atoi(rawTimeout); parseErr == nil {
				httpTimeoutSecs = parsed
			} else {
				return nil, fmt.Errorf("invalid HTTP timeout")
			}
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return services, nil
}

func sanitizeEnvKey(name string) string {
	var builder strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
		} else {
			builder.WriteRune('_')
		}
	}
	return strings.ToUpper(builder.String())
}

func validateAttachmentFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("attachment source is not a readable file")
	}
	hasHost, hasListen, services := false, false, 0
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		switch {
		case strings.HasPrefix(line, "host_id ="), strings.HasPrefix(line, "host_id="):
			hasHost = true
		case strings.HasPrefix(line, "listen_host ="), strings.HasPrefix(line, "listen_host="):
			hasListen = true
		case line == "[[services]]":
			services++
		}
	}
	if !hasHost || !hasListen || services == 0 {
		return fmt.Errorf("attachment source is missing required Locho fields")
	}
	return nil
}

func validateExternalSource(config Config, path, label string) error {
	if err := ValidateAbsolutePath(path, label); err != nil {
		return err
	}
	if within(path, filepath.Join(config.RepositoryRoot, "local")) {
		return fmt.Errorf("%s must not be under local/", label)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a readable file", label)
	}
	return nil
}

func FormatAttachmentListHuman(result AttachmentListResult) string {
	if len(result.Hosts) == 0 {
		return "openlia attachments: no hosts configured"
	}
	var builder strings.Builder
	builder.WriteString("openlia attachments:\n")
	for i, host := range result.Hosts {
		if i > 0 {
			builder.WriteString("\n")
		}
		plural := "s"
		if len(host.Services) == 1 {
			plural = ""
		}
		fmt.Fprintf(&builder, "  Host: %s (%d service%s configured)\n", host.Host, len(host.Services), plural)
		if len(host.Services) == 0 {
			builder.WriteString("    (no services declared)\n")
		}
		for _, svc := range host.Services {
			fmt.Fprintf(&builder, "    - %s (%s, port %d) -> %s [role: %s]\n", svc.Name, svc.Protocol, svc.Port, svc.Endpoint, svc.Role)
		}
	}
	return strings.TrimRight(builder.String(), "\n")
}

func EnsureOpenWebUISecrets(config Config) error {
	if config.OpenWebUIHost == "" {
		return nil
	}
	if err := ensureSecretDirectory(config); err != nil {
		return err
	}
	if err := EnsureDir(config.OpenWebUIDataRoot, 0o700); err != nil {
		return err
	}
	openWebUIEnvPath := filepath.Join(config.SecretDir, "open-webui.env")

	hermesDotEnv := filepath.Join(config.DataRoot, ".env")
	apiKey, err := readSecretValue(hermesDotEnv, "API_SERVER_KEY")
	if err != nil || apiKey == "" {
		apiKey, err = readSecretValue(config.SecretFile, "API_SERVER_KEY")
	}
	if err != nil || apiKey == "" {
		buf := make([]byte, 16)
		if _, randErr := rand.Read(buf); randErr != nil {
			return fmt.Errorf("generate api key: %w", randErr)
		}
		apiKey = "sk-openlia-" + hex.EncodeToString(buf)
		currentData, readErr := os.ReadFile(config.SecretFile)
		if os.IsNotExist(readErr) {
			currentData = []byte("# Add KEY=VALUE lines through the operator's secret rotation workflow.\n")
		} else if readErr != nil {
			return fmt.Errorf("read secret file: %w", readErr)
		}
		newContent := string(currentData)
		if !strings.HasSuffix(newContent, "\n") && len(newContent) > 0 {
			newContent += "\n"
		}
		newContent += fmt.Sprintf("API_SERVER_KEY=%s\n", apiKey)
		if writeErr := AtomicWriteFile(config.SecretFile, []byte(newContent), 0o600); writeErr != nil {
			return fmt.Errorf("write api server key: %w", writeErr)
		}
	}

	if apiKey != "" && config.DataRoot != "" {
		if _, statErr := os.Stat(config.DataRoot); statErr == nil {
			hermesKey, _ := readSecretValue(hermesDotEnv, "API_SERVER_KEY")
			if hermesKey != apiKey {
				currentDotEnv, readErr := os.ReadFile(hermesDotEnv)
				if os.IsNotExist(readErr) {
					currentDotEnv = []byte{}
				}
				dotEnvText := string(currentDotEnv)
				if !strings.HasSuffix(dotEnvText, "\n") && len(dotEnvText) > 0 {
					dotEnvText += "\n"
				}
				dotEnvText += fmt.Sprintf("API_SERVER_KEY=%s\n", apiKey)
				_ = AtomicWriteFile(hermesDotEnv, []byte(dotEnvText), 0o600)
			}
		}
	}

	webuiSecret, _ := readSecretValue(openWebUIEnvPath, "WEBUI_SECRET_KEY")
	if webuiSecret == "" {
		buf := make([]byte, 16)
		if _, randErr := rand.Read(buf); randErr != nil {
			return fmt.Errorf("generate webui secret: %w", randErr)
		}
		webuiSecret = hex.EncodeToString(buf)
	}

	content := fmt.Sprintf("OPENAI_API_KEY=%s\nWEBUI_SECRET_KEY=%s\n", apiKey, webuiSecret)
	if config.OpenWebUIGoogleClientSecret != "" {
		content += fmt.Sprintf("GOOGLE_CLIENT_SECRET=%s\n", config.OpenWebUIGoogleClientSecret)
	}
	syncWebUIDatabaseKey(filepath.Join(config.OpenWebUIDataRoot, "webui.db"), apiKey)
	if len(config.OpenWebUIAllowedEmails) > 0 {
		syncWebUIAllowedUsers(filepath.Join(config.OpenWebUIDataRoot, "webui.db"), config.OpenWebUIAllowedEmails)
	}
	if err := AtomicWriteFile(openWebUIEnvPath, []byte(content), 0o600); err != nil {
		return err
	}
	if err := ensureRuntimeOwner(config.SecretFile, config.RuntimeUID, config.RuntimeGID, 0o600); err != nil {
		return err
	}
	return ensureRuntimeOwner(openWebUIEnvPath, config.RuntimeUID, config.RuntimeGID, 0o600)
}

func syncWebUIDatabaseKey(dbPath, apiKey string) {
	if _, err := os.Stat(dbPath); err != nil {
		return
	}
	query := fmt.Sprintf("UPDATE config SET value = json_array(%q) WHERE key = 'openai.api_keys';", apiKey)
	if _, lookErr := exec.LookPath("sqlite3"); lookErr == nil {
		cmd := exec.Command("sqlite3", dbPath, query)
		if cmd.Run() == nil {
			return
		}
	}
	pyScript := fmt.Sprintf("import sqlite3, json; conn = sqlite3.connect(%q); conn.execute('UPDATE config SET value = ? WHERE key = \"openai.api_keys\"', (json.dumps([%q]),)); conn.commit(); conn.close()", dbPath, apiKey)
	_ = exec.Command("python3", "-c", pyScript).Run()
}

func syncWebUIAllowedUsers(dbPath string, allowedEmails []string) {
	if len(allowedEmails) == 0 {
		return
	}
	encoded, err := json.Marshal(allowedEmails)
	if err != nil {
		return
	}
	pyScript := fmt.Sprintf(`import sqlite3, json, time, uuid

db_path = %q
allowed_emails = json.loads(%q)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Ensure user and auth tables exist
cursor.execute("""
CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'pending',
    profile_image_url TEXT NOT NULL DEFAULT '/user.png',
    api_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    settings TEXT,
    info TEXT,
    oauth_sub TEXT
);
""")

cursor.execute("""
CREATE TABLE IF NOT EXISTS "auth" (
    id VARCHAR NOT NULL PRIMARY KEY,
    email VARCHAR,
    password TEXT,
    active BOOLEAN
);
""")

now = int(time.time())

for index, email in enumerate(allowed_emails):
    clean_email = email.strip()
    if not clean_email:
        continue
    target_role = "admin" if index == 0 else "user"
    cursor.execute('SELECT id, role FROM "user" WHERE email = ?', (clean_email,))
    existing = cursor.fetchone()
    if existing:
        user_id, current_role = existing
        if current_role != target_role:
            cursor.execute('UPDATE "user" SET role = ?, updated_at = ? WHERE id = ?', (target_role, now, user_id))
    else:
        user_id = str(uuid.uuid4())
        name = clean_email.split("@")[0]
        cursor.execute(
            'INSERT INTO "user" (id, name, email, role, profile_image_url, created_at, updated_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (user_id, name, clean_email, target_role, "/user.png", now, now, now),
        )

    # Ensure corresponding auth table row exists and is active
    cursor.execute('SELECT id FROM "auth" WHERE id = ?', (user_id,))
    if cursor.fetchone():
        cursor.execute('UPDATE "auth" SET email = ?, active = 1 WHERE id = ?', (clean_email, user_id))
    else:
        cursor.execute('INSERT INTO "auth" (id, email, password, active) VALUES (?, ?, ?, ?)', (user_id, clean_email, "", 1))

# Demote any users whose email is not in allowed_emails to pending
placeholders = ",".join("?" for _ in allowed_emails)
cursor.execute(f'UPDATE "user" SET role = "pending", updated_at = ? WHERE email NOT IN ({placeholders}) AND role != "pending"', [now] + allowed_emails)

conn.commit()
conn.close()
`, dbPath, string(encoded))

	_ = exec.Command("python3", "-c", pyScript).Run()
}
