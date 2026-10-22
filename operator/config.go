package operator

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"
	"github.com/robfig/cron/v3"
	"openlia/internal/releaseinfo"
	"openlia/internal/toolcatalog"
)

// Config is the typed view of the OPENLIA_* settings consumed by the
// operator. Secret values are deliberately not part of Config.
type Config struct {
	RepositoryRoot                string
	RuntimeRoot                   string
	InstallRoot                   string
	ProjectName                   string
	Timezone                      string
	NetworkName                   string
	ComposeFile                   string
	ComposeProjectDir             string
	GeneratedCompose              string
	DataRoot                      string
	SystemSkillsRoot              string
	LochoRoot                     string
	SecretDir                     string
	SecretFile                    string
	BackupRoot                    string
	BackupRetention               int
	BackupMaxBytes                int64
	BackupRecipient               string
	BackupSchedule                string
	BackupScheduleEnabled         bool
	WorkspaceGitSchedule          string
	WorkspaceGitEnabled           bool
	BackupDestinations            []BackupDestination
	BackupNamespaceRoot           string
	OperatorConfigFile            string
	MetaRoot                      string
	StateFile                     string
	LocalMode                     bool
	Provider                      string
	Model                         string
	OutputLanguage                string
	OpenLiaVersion                string
	OpenLiaRevision               string
	OpenLiaReleaseSHA256          string
	FallbackProviders             []FallbackProviderConfig
	HermesImage                   string
	HermesVersion                 string
	HermesDigest                  string
	LochoImage                    string
	LochoVersion                  string
	LochoX8664SHA256              string
	LochoARM64SHA256              string
	LochoRelayConfig              string
	LochoRelaySecrets             string
	EnabledSkills                 []string
	IngestionMaxConcurrentJobs    int
	SkillsConfigured              bool
	ExternalNetwork               string
	BackupRemoteRetentionDays     int
	APIEnabled                    bool
	APIHost                       string
	WorkspaceUIHost               string
	WorkspaceUIPort               int
	WorkspaceUIPublicOrigin       string
	WorkspaceUIAuthRequired       bool
	WorkspaceUIPasswordHashFile   string
	WorkspaceUIAllowedEmails      []string
	WorkspaceUIFirebaseProjectID  string
	WorkspaceUIFirebaseAPIKey     string
	WorkspaceUIFirebaseAuthDomain string
	WorkspaceUIFirebaseAppID      string
	OpenWebUIHost                 string
	OpenWebUIPort                 int
	OpenWebUIImage                string
	OpenWebUIAuth                 bool
	OpenWebUIGoogleClientID       string
	OpenWebUIGoogleClientSecret   string
	OpenWebUIURL                  string
	OpenWebUIAllowedDomains       []string
	OpenWebUIAllowedEmails        []string
	OpenWebUIEnableOAuthSignup    bool
	OpenWebUIDataRoot             string
	LochoHostEnabled              bool
	LochoHostRoot                 string
	LochoHostConfig               string
	LochoHostStateRoot            string
	RuntimeUID                    int
	RuntimeGID                    int
	ServiceRoles                  map[string]string
	ConfiguredHosts               []string
}

// BackupDestination describes a target-side remote backup store. Credentials
// are represented only by a protected file path and profile name; secret values
// are never embedded in this structure.
type BackupDestination struct {
	Name               string `json:"name"`
	Type               string `json:"type"`
	Endpoint           string `json:"endpoint,omitempty"`
	Bucket             string `json:"bucket,omitempty"`
	Prefix             string `json:"prefix,omitempty"`
	Region             string `json:"region,omitempty"`
	PathStyle          bool   `json:"path_style,omitempty"`
	RsyncTarget        string `json:"rsync_target,omitempty"`
	IdentityFile       string `json:"identity_file,omitempty"`
	CredentialsFile    string `json:"credentials_file,omitempty"`
	CredentialsProfile string `json:"credentials_profile,omitempty"`
}

type FallbackProviderConfig struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	BaseURL  string `json:"base_url,omitempty"`
	KeyEnv   string `json:"key_env,omitempty"`
}

// LoadConfig reads the process environment.
func LoadConfig() (Config, error) {
	if configPath := os.Getenv("OPENLIA_OPERATOR_CONFIG_FILE"); configPath != "" {
		data, err := os.ReadFile(configPath)
		if err != nil {
			return Config{}, fmt.Errorf("read persisted operator config: %w", err)
		}
		var config Config
		if err := json.Unmarshal(data, &config); err != nil {
			return Config{}, fmt.Errorf("parse persisted operator config: %w", err)
		}
		return config, config.ValidatePaths()
	}
	values := make(map[string]string)
	for _, value := range os.Environ() {
		key, item, ok := strings.Cut(value, "=")
		if ok {
			values[key] = item
		}
	}
	return LoadConfigFromEnv(values)
}

// LoadConfigFromEnv is the testable form of LoadConfig. The map contains
// environment names without the surrounding process environment.
func LoadConfigFromEnv(values map[string]string) (Config, error) {
	repositoryRoot := values["OPENLIA_REPO_ROOT"]
	var err error
	if repositoryRoot == "" {
		repositoryRoot, err = os.Getwd()
		if err != nil {
			return Config{}, fmt.Errorf("determine repository root: %w", err)
		}
	}
	repositoryRoot, err = filepath.Abs(repositoryRoot)
	if err != nil {
		return Config{}, fmt.Errorf("resolve repository root: %w", err)
	}

	runtimeValue, runtimeConfigured := values["OPENLIA_RUNTIME_ROOT"]
	if !runtimeConfigured || strings.TrimSpace(runtimeValue) == "" {
		return Config{}, fmt.Errorf("OPENLIA_RUNTIME_ROOT is required")
	}
	runtimeRoot := strings.TrimRight(runtimeValue, "/")
	if runtimeRoot == "" {
		runtimeRoot = "/"
	}
	installRoot := getOr(values, "OPENLIA_INSTALL_ROOT", strings.TrimSuffix(runtimeRoot, "/runtime"))
	project := getOr(values, "OPENLIA_PROJECT_NAME", "openlia")
	localMode, err := boolValue(values, "OPENLIA_LOCAL_MODE", false)
	if err != nil {
		return Config{}, err
	}
	runtimeUID, runtimeGID, err := runtimeIdentity(values, localMode)
	if err != nil {
		return Config{}, err
	}
	fallbackProviders := []FallbackProviderConfig{}
	if rawFallbacks := values["OPENLIA_FALLBACK_PROVIDERS"]; rawFallbacks != "" {
		if err := json.Unmarshal([]byte(rawFallbacks), &fallbackProviders); err != nil {
			return Config{}, fmt.Errorf("OPENLIA_FALLBACK_PROVIDERS must be valid JSON: %w", err)
		}
	}
	config := Config{
		RepositoryRoot:             repositoryRoot,
		RuntimeRoot:                runtimeRoot,
		InstallRoot:                installRoot,
		ProjectName:                project,
		Timezone:                   getOr(values, "HERMES_TIMEZONE", "Asia/Ho_Chi_Minh"),
		NetworkName:                getOr(values, "OPENLIA_NETWORK_NAME", project+"-private"),
		ComposeFile:                getOr(values, "OPENLIA_COMPOSE_FILE", filepath.Join(repositoryRoot, "docker", "compose.yaml")),
		ComposeProjectDir:          getOr(values, "OPENLIA_COMPOSE_PROJECT_DIR", filepath.Join(repositoryRoot, "docker")),
		GeneratedCompose:           getOr(values, "OPENLIA_GENERATED_COMPOSE", filepath.Join(repositoryRoot, "docker", "compose.generated.yaml")),
		DataRoot:                   getOr(values, "OPENLIA_DATA_ROOT", filepath.Join(runtimeRoot, "hermes")),
		SystemSkillsRoot:           getOr(values, "OPENLIA_SYSTEM_SKILLS_ROOT", filepath.Join(runtimeRoot, "system-skills")),
		LochoRoot:                  getOr(values, "OPENLIA_LOCHO_ROOT", filepath.Join(runtimeRoot, "locho")),
		SecretDir:                  getOr(values, "OPENLIA_SECRET_DIR", filepath.Join(runtimeRoot, "secrets")),
		SecretFile:                 getOr(values, "OPENLIA_SECRET_FILE", filepath.Join(runtimeRoot, "secrets", "hermes.env")),
		BackupRoot:                 getOr(values, "OPENLIA_BACKUP_ROOT", filepath.Join(runtimeRoot, "backups")),
		BackupRetention:            5,
		BackupMaxBytes:             10 << 30,
		BackupRecipient:            values["OPENLIA_BACKUP_RECIPIENT"],
		BackupSchedule:             getOr(values, "OPENLIA_BACKUP_SCHEDULE", "20 4 * * *"),
		BackupScheduleEnabled:      true,
		WorkspaceGitSchedule:       getOr(values, "OPENLIA_WORKSPACE_GIT_SCHEDULE", "0 4 * * *"),
		WorkspaceGitEnabled:        true,
		IngestionMaxConcurrentJobs: 1,
		BackupRemoteRetentionDays:  30,
		BackupDestinations:         []BackupDestination{},
		OperatorConfigFile:         values["OPENLIA_CLI_CONFIG_FILE"],
		MetaRoot:                   getOr(values, "OPENLIA_META_ROOT", filepath.Join(runtimeRoot, "meta")),
		StateFile:                  getOr(values, "OPENLIA_STATE_FILE", filepath.Join(runtimeRoot, "meta", "stack-state")),
		Provider:                   getOr(values, "OPENLIA_PROVIDER", "copilot"),
		Model:                      getOr(values, "OPENLIA_MODEL", "gpt-5.6-luna"),
		OutputLanguage:             getOr(values, "OPENLIA_OUTPUT_LANGUAGE", "en"),
		OpenLiaVersion:             getOr(values, "OPENLIA_VERSION", releaseinfo.Default.OpenLia),
		OpenLiaRevision:            values["OPENLIA_REVISION"],
		OpenLiaReleaseSHA256:       values["OPENLIA_RELEASE_SHA256"],
		FallbackProviders:          fallbackProviders,
		HermesImage:                getOr(values, "OPENLIA_HERMES_IMAGE", releaseinfo.InternalImage("openlia-hermes", releaseinfo.Default.Hermes.Tag)),
		HermesVersion:              getOr(values, "OPENLIA_HERMES_VERSION", getOr(values, "HERMES_BASE_TAG", releaseinfo.Default.Hermes.Tag)),
		HermesDigest:               getOr(values, "HERMES_BASE_DIGEST", releaseinfo.Default.Hermes.Digest),
		LochoImage:                 getOr(values, "OPENLIA_LOCHO_IMAGE", releaseinfo.InternalImage("openlia-locho", releaseinfo.Default.Locho.Version)),
		LochoVersion:               getOr(values, "OPENLIA_LOCHO_VERSION", releaseinfo.Default.Locho.Version),
		LochoX8664SHA256:           getOr(values, "OPENLIA_LOCHO_X86_64_SHA256", releaseinfo.Default.Locho.LinuxX8664SHA),
		LochoARM64SHA256:           getOr(values, "OPENLIA_LOCHO_ARM64_SHA256", releaseinfo.Default.Locho.LinuxARM64SHA),
		LochoRelayConfig:           values["OPENLIA_LOCHO_RELAY_CONFIG"],
		LochoRelaySecrets:          values["OPENLIA_LOCHO_RELAY_SECRETS"],
		ExternalNetwork:            values["OPENLIA_EXTERNAL_NETWORK"],
		APIHost:                    getOr(values, "OPENLIA_API_HOST", "127.0.0.1"),
		WorkspaceUIPort:            8089,
		WorkspaceUIPublicOrigin:    values["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"],
		RuntimeUID:                 runtimeUID,
		RuntimeGID:                 runtimeGID,
		LochoHostRoot:              filepath.Join(runtimeRoot, "locho-host"),
	}
	if config.OpenLiaReleaseSHA256 == "" {
		if data, readErr := os.ReadFile(filepath.Join(repositoryRoot, "release.sha256")); readErr == nil {
			config.OpenLiaReleaseSHA256 = strings.TrimSpace(string(data))
		}
	}
	if raw := values["OPENLIA_BACKUP_DESTINATIONS"]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &config.BackupDestinations); err != nil {
			return Config{}, fmt.Errorf("OPENLIA_BACKUP_DESTINATIONS must be valid JSON: %w", err)
		}
	}
	if raw := values["OPENLIA_BACKUP_SCHEDULE_ENABLED"]; raw != "" {
		config.BackupScheduleEnabled, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("OPENLIA_BACKUP_SCHEDULE_ENABLED must be true or false")
		}
	}
	if raw := values["OPENLIA_WORKSPACE_GIT_ENABLED"]; raw != "" {
		config.WorkspaceGitEnabled, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("OPENLIA_WORKSPACE_GIT_ENABLED must be true or false")
		}
	}
	if err := validateOutputLanguage(config.OutputLanguage); err != nil {
		return Config{}, fmt.Errorf("OPENLIA_OUTPUT_LANGUAGE: %w", err)
	}

	if rawRetention := values["OPENLIA_BACKUP_RETENTION"]; rawRetention != "" {
		parsed, err := strconv.Atoi(rawRetention)
		if err != nil || parsed <= 0 {
			return Config{}, fmt.Errorf("OPENLIA_BACKUP_RETENTION must be a positive integer")
		}
		config.BackupRetention = parsed
	}
	if rawMaxBytes := values["OPENLIA_BACKUP_MAX_BYTES"]; rawMaxBytes != "" {
		parsed, err := strconv.ParseInt(rawMaxBytes, 10, 64)
		if err != nil || parsed <= 0 {
			return Config{}, fmt.Errorf("OPENLIA_BACKUP_MAX_BYTES must be a positive integer")
		}
		config.BackupMaxBytes = parsed
	}
	if rawRetention := values["OPENLIA_BACKUP_REMOTE_RETENTION_DAYS"]; rawRetention != "" {
		parsed, err := strconv.Atoi(rawRetention)
		if err != nil || parsed <= 0 || int64(parsed) > maxBackupRemoteRetentionDays {
			return Config{}, fmt.Errorf("OPENLIA_BACKUP_REMOTE_RETENTION_DAYS must be a positive integer")
		}
		config.BackupRemoteRetentionDays = parsed
	}

	config.LocalMode = localMode
	if config.SkillsConfigured, err = boolValue(values, "OPENLIA_SKILLS_CONFIGURED", false); err != nil {
		return Config{}, err
	}
	if config.APIEnabled, err = boolValue(values, "OPENLIA_API_ENABLED", false); err != nil {
		return Config{}, err
	}
	config.WorkspaceUIHost = values["OPENLIA_WORKSPACE_UI_HOST"]
	if rawPort := values["OPENLIA_WORKSPACE_UI_PORT"]; rawPort != "" {
		config.WorkspaceUIPort, err = strconv.Atoi(rawPort)
		if err != nil {
			return Config{}, fmt.Errorf("OPENLIA_WORKSPACE_UI_PORT must be an integer")
		}
	}
	if config.WorkspaceUIAuthRequired, err = boolValue(values, "OPENLIA_WORKSPACE_UI_AUTH_REQUIRED", false); err != nil {
		return Config{}, err
	}
	config.WorkspaceUIPasswordHashFile = getOr(values, "OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE", filepath.Join(runtimeRoot, "secrets", "workspace-ui-password.hash"))
	if rawAllowedEmails := values["OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS"]; rawAllowedEmails != "" {
		for _, email := range strings.Split(rawAllowedEmails, ",") {
			trimmed := strings.TrimSpace(email)
			if trimmed != "" {
				config.WorkspaceUIAllowedEmails = append(config.WorkspaceUIAllowedEmails, trimmed)
			}
		}
	}
	config.WorkspaceUIFirebaseProjectID = values["OPENLIA_WORKSPACE_UI_FIREBASE_PROJECT_ID"]
	config.WorkspaceUIFirebaseAPIKey = values["OPENLIA_WORKSPACE_UI_FIREBASE_API_KEY"]
	config.WorkspaceUIFirebaseAuthDomain = values["OPENLIA_WORKSPACE_UI_FIREBASE_AUTH_DOMAIN"]
	config.WorkspaceUIFirebaseAppID = values["OPENLIA_WORKSPACE_UI_FIREBASE_APP_ID"]
	if err := validateWorkspaceUIPublicOrigin(config.WorkspaceUIPublicOrigin); err != nil {
		return Config{}, err
	}
	if err := validateWorkspaceUI(config.WorkspaceUIHost, config.WorkspaceUIPort, config.WorkspaceUIAuthRequired, config.WorkspaceUIPasswordHashFile, config.WorkspaceUIFirebaseProjectID, config.WorkspaceUIAllowedEmails, config.WorkspaceUIFirebaseAPIKey, config.WorkspaceUIFirebaseAuthDomain); err != nil {
		return Config{}, err
	}
	openWebUIPort := 8090
	if rawPort := values["OPENLIA_OPEN_WEBUI_PORT"]; rawPort != "" {
		parsed, err := strconv.Atoi(rawPort)
		if err != nil || parsed < 1 || parsed > 65535 {
			return Config{}, fmt.Errorf("OPENLIA_OPEN_WEBUI_PORT must be between 1 and 65535")
		}
		openWebUIPort = parsed
	}
	openWebUIAuth, err := boolValue(values, "OPENLIA_OPEN_WEBUI_AUTH", true)
	if err != nil {
		return Config{}, err
	}
	config.OpenWebUIHost = values["OPENLIA_OPEN_WEBUI_HOST"]
	config.OpenWebUIPort = openWebUIPort
	config.OpenWebUIImage = getOr(values, "OPENLIA_OPEN_WEBUI_IMAGE", releaseinfo.Default.OpenWebUI.Ref())
	config.OpenWebUIAuth = openWebUIAuth
	config.OpenWebUIGoogleClientID = values["OPENLIA_OPEN_WEBUI_GOOGLE_CLIENT_ID"]
	config.OpenWebUIGoogleClientSecret = values["OPENLIA_OPEN_WEBUI_GOOGLE_CLIENT_SECRET"]
	config.OpenWebUIURL = values["OPENLIA_OPEN_WEBUI_URL"]
	if rawDomains := values["OPENLIA_OPEN_WEBUI_ALLOWED_DOMAINS"]; rawDomains != "" {
		for _, domain := range strings.Split(rawDomains, ",") {
			trimmed := strings.TrimSpace(domain)
			if trimmed != "" {
				config.OpenWebUIAllowedDomains = append(config.OpenWebUIAllowedDomains, trimmed)
			}
		}
	}
	if rawEmails := values["OPENLIA_OPEN_WEBUI_ALLOWED_EMAILS"]; rawEmails != "" {
		for _, email := range strings.Split(rawEmails, ",") {
			trimmed := strings.TrimSpace(email)
			if trimmed != "" {
				config.OpenWebUIAllowedEmails = append(config.OpenWebUIAllowedEmails, trimmed)
			}
		}
	}
	openWebUIOAuthSignup, err := boolValue(values, "OPENLIA_OPEN_WEBUI_ENABLE_OAUTH_SIGNUP", false)
	if err != nil {
		return Config{}, err
	}
	config.OpenWebUIEnableOAuthSignup = openWebUIOAuthSignup
	config.OpenWebUIDataRoot = getOr(values, "OPENLIA_OPEN_WEBUI_DATA_ROOT", filepath.Join(runtimeRoot, "open-webui"))
	if config.LochoHostEnabled, err = boolValue(values, "OPENLIA_LOCHO_HOST_ENABLED", false); err != nil {
		return Config{}, err
	}
	config.LochoHostConfig = filepath.Join(config.LochoHostRoot, "locho.toml")
	config.LochoHostStateRoot = filepath.Join(config.LochoHostRoot, "state")
	if err := validateOpenWebUI(config.OpenWebUIHost, config.OpenWebUIPort, config.OpenWebUIGoogleClientID, config.OpenWebUIGoogleClientSecret, config.OpenWebUIURL, config.OpenWebUIAllowedDomains, config.OpenWebUIAllowedEmails, config.OpenWebUIEnableOAuthSignup); err != nil {
		return Config{}, err
	}
	if raw := values["OPENLIA_ENABLED_SKILLS"]; raw != "" {
		for _, skill := range strings.Split(raw, ",") {
			if skill == "" {
				return Config{}, fmt.Errorf("OPENLIA_ENABLED_SKILLS contains an empty skill")
			}
			config.EnabledSkills = append(config.EnabledSkills, skill)
		}
	}
	if raw := values["OPENLIA_INGESTION_MAX_CONCURRENT_JOBS"]; raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed <= 0 {
			return Config{}, fmt.Errorf("OPENLIA_INGESTION_MAX_CONCURRENT_JOBS must be a positive integer")
		}
		config.IngestionMaxConcurrentJobs = parsed
	}
	if strings.TrimSpace(values["OPENLIA_HERMES_IMAGE"]) == "" {
		config.HermesImage = toolcatalog.ManagedHermesImage(
			config.ProjectName,
			config.HermesVersion,
			config.HermesDigest,
			getOr(values, "DEBIAN_SNAPSHOT", toolcatalog.DefaultDebianSnapshot),
		)
	}
	config.ServiceRoles = make(map[string]string)
	if rawRoles := values["OPENLIA_SERVICE_ROLES"]; rawRoles != "" {
		var roles map[string]string
		if err := json.Unmarshal([]byte(rawRoles), &roles); err == nil {
			config.ServiceRoles = roles
		}
	}
	if rawHosts := values["OPENLIA_CONFIGURED_HOSTS"]; rawHosts != "" {
		for _, host := range strings.Split(rawHosts, ",") {
			host = strings.TrimSpace(host)
			if host != "" {
				config.ConfiguredHosts = append(config.ConfiguredHosts, host)
			}
		}
	}
	return config, nil
}

func validateOutputLanguage(value string) error {
	parts := strings.Split(value, "-")
	if len(parts) == 0 || len(parts[0]) < 2 || len(parts[0]) > 8 {
		return fmt.Errorf("must be a BCP 47 language tag")
	}
	for _, character := range parts[0] {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') {
			return fmt.Errorf("must be a BCP 47 language tag")
		}
	}
	for _, part := range parts[1:] {
		if len(part) < 1 || len(part) > 8 {
			return fmt.Errorf("must be a BCP 47 language tag")
		}
		for _, character := range part {
			if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') {
				return fmt.Errorf("must be a BCP 47 language tag")
			}
		}
	}
	return nil
}

func validateWorkspaceUI(host string, port int, authRequired bool, passwordHashFile, firebaseProjectID string, allowedEmails []string, firebaseAPIKey, firebaseAuthDomain string) error {
	if host != "" && host != "127.0.0.1" && host != "0.0.0.0" {
		return fmt.Errorf("workspace-ui.host must be 127.0.0.1 or 0.0.0.0")
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("workspace-ui.port must be between 1 and 65535")
	}
	isFirebase := firebaseProjectID != "" || len(allowedEmails) > 0
	if isFirebase {
		if len(allowedEmails) == 0 {
			return fmt.Errorf("workspace-ui.allowed_emails must contain at least one email address")
		}
		for _, email := range allowedEmails {
			if email == "" || !strings.Contains(email, "@") || strings.HasPrefix(email, "@") || strings.HasSuffix(email, "@") {
				return fmt.Errorf("workspace-ui.allowed_emails must contain valid email addresses")
			}
		}
		if firebaseProjectID == "" {
			return fmt.Errorf("workspace-ui.firebase_project_id is required when Firebase Auth is configured")
		}
		if firebaseAPIKey == "" {
			return fmt.Errorf("workspace-ui.firebase_api_key is required when Firebase Auth is configured")
		}
		if firebaseAuthDomain == "" {
			return fmt.Errorf("workspace-ui.firebase_auth_domain is required when Firebase Auth is configured")
		}
		return nil
	}
	if host == "0.0.0.0" && !authRequired {
		return fmt.Errorf("workspace-ui authentication is required when host is 0.0.0.0")
	}
	if authRequired {
		if err := ValidateAbsolutePath(passwordHashFile, "workspace-ui-password-hash-file"); err != nil {
			return err
		}
	}
	return nil
}

func validateOpenWebUI(host string, port int, googleClientID, googleClientSecret, openWebUIURL string, allowedDomains, allowedEmails []string, enableOAuthSignup bool) error {
	if host == "" {
		return nil
	}
	if host != "127.0.0.1" && host != "0.0.0.0" {
		return fmt.Errorf("open-webui.host must be 127.0.0.1 or 0.0.0.0")
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("open-webui.port must be between 1 and 65535")
	}
	isGoogleAuth := googleClientID != "" || googleClientSecret != "" || openWebUIURL != "" || len(allowedDomains) > 0 || len(allowedEmails) > 0
	if isGoogleAuth {
		if googleClientID == "" {
			return fmt.Errorf("open-webui.google_client_id is required when Google OAuth is configured")
		}
		if googleClientSecret == "" {
			return fmt.Errorf("open-webui.google_client_secret is required when Google OAuth is configured")
		}
		if openWebUIURL == "" {
			return fmt.Errorf("open-webui.url is required when Google OAuth is configured")
		}
		parsedURL, err := url.Parse(openWebUIURL)
		if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" {
			return fmt.Errorf("open-webui.url must be a valid http or https URL")
		}
		for _, domain := range allowedDomains {
			if strings.TrimSpace(domain) == "" || strings.Contains(domain, "@") || strings.Contains(domain, " ") {
				return fmt.Errorf("open-webui.allowed_domains must contain valid domain names without '@'")
			}
		}
		for _, email := range allowedEmails {
			if strings.TrimSpace(email) == "" || !strings.Contains(email, "@") || strings.HasPrefix(email, "@") || strings.HasSuffix(email, "@") || strings.Contains(email, " ") {
				return fmt.Errorf("open-webui.allowed_emails must contain valid email addresses")
			}
		}
		if !enableOAuthSignup && len(allowedEmails) == 0 {
			return fmt.Errorf("open-webui.allowed_emails must contain at least one email address when enable_oauth_signup is false")
		}
	}
	return nil
}

func validateWorkspaceUIPublicOrigin(value string) error {
	if value == "" {
		return nil
	}
	origin, err := url.Parse(value)
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Host == "" || origin.User != nil || origin.Opaque != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.Path != "" && origin.Path != "/" {
		return fmt.Errorf("workspace-ui.public_origin must be an absolute http(s) origin")
	}
	return nil
}

func getOr(values map[string]string, key, fallback string) string {
	if value := values[key]; value != "" {
		return value
	}
	return fallback
}

func boolValue(values map[string]string, key string, fallback bool) (bool, error) {
	value, ok := values[key]
	if !ok || value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false: %w", key, err)
	}
	return parsed, nil
}

func runtimeIdentity(values map[string]string, local bool) (int, int, error) {
	uid, gid := 10000, 10000
	if local {
		uid, gid = os.Getuid(), os.Getgid()
	}
	for key, value := range map[string]*int{
		"OPENLIA_RUNTIME_UID": &uid,
		"OPENLIA_RUNTIME_GID": &gid,
	} {
		if valueText := strings.TrimSpace(values[key]); valueText != "" {
			parsed, err := strconv.Atoi(valueText)
			if err != nil || parsed < 0 {
				return 0, 0, fmt.Errorf("%s must be a non-negative integer", key)
			}
			*value = parsed
		}
	}
	return uid, gid, nil
}

// ValidatePaths applies the path and component constraints used by the shell
// operations before they touch the filesystem.
func (c Config) ValidatePaths() error {
	if c.RuntimeUID < 0 || c.RuntimeGID < 0 {
		return fmt.Errorf("runtime UID/GID must be non-negative")
	}
	if c.LochoVersion == "" {
		return fmt.Errorf("Locho version is required")
	}
	for name, checksum := range map[string]string{"x86-64": c.LochoX8664SHA256, "arm64": c.LochoARM64SHA256} {
		if len(checksum) != 64 || strings.Trim(checksum, "0123456789abcdef") != "" {
			return fmt.Errorf("Locho %s checksum must be 64 lowercase hexadecimal characters", name)
		}
	}
	if err := validateOutputLanguage(c.OutputLanguage); err != nil {
		return fmt.Errorf("output language: %w", err)
	}
	if c.BackupRetention < 0 || c.BackupMaxBytes < 0 || c.BackupRemoteRetentionDays < 0 || int64(c.BackupRemoteRetentionDays) > maxBackupRemoteRetentionDays {
		return fmt.Errorf("backup retention values must be non-negative")
	}
	if c.BackupRecipient != "" {
		if _, err := age.ParseX25519Recipient(c.BackupRecipient); err != nil {
			return fmt.Errorf("backup recipient is invalid")
		}
	}
	timezone := c.Timezone
	if timezone == "" {
		timezone = "Asia/Ho_Chi_Minh"
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		return fmt.Errorf("backup timezone is invalid: %w", err)
	}
	if c.BackupScheduleEnabled {
		if _, err := cron.ParseStandard(c.BackupSchedule); err != nil {
			return fmt.Errorf("backup schedule must be a five-field cron expression: %w", err)
		}
	}
	if c.WorkspaceGitEnabled || c.WorkspaceGitSchedule != "" {
		if _, err := cron.ParseStandard(c.WorkspaceGitSchedule); err != nil {
			return fmt.Errorf("workspace Git schedule must be a five-field cron expression: %w", err)
		}
	}
	if err := validateBackupDestinations(c.BackupDestinations); err != nil {
		return err
	}
	for _, destination := range c.BackupDestinations {
		identityPath := filepath.Clean(destination.IdentityFile)
		if destination.IdentityFile != "" && (identityPath == filepath.Clean(c.SecretDir) || identityPath == filepath.Clean(c.DataRoot) || within(destination.IdentityFile, c.SecretDir) || within(destination.IdentityFile, c.DataRoot)) {
			return fmt.Errorf("rsync identity files must not be inside Hermes data or mounted runtime secrets")
		}
		credentialsPath := filepath.Clean(destination.CredentialsFile)
		if destination.CredentialsFile != "" && (credentialsPath == filepath.Clean(c.SecretDir) || credentialsPath == filepath.Clean(c.DataRoot) || within(destination.CredentialsFile, c.SecretDir) || within(destination.CredentialsFile, c.DataRoot)) {
			return fmt.Errorf("S3 credentials files must not be inside Hermes data or mounted runtime secrets")
		}
	}
	if err := ValidateAbsolutePath(c.RuntimeRoot, "runtime-root"); err != nil {
		return err
	}
	if err := ValidateSafeComponent(c.ProjectName, "project-name"); err != nil {
		return err
	}
	if err := ValidateSafeComponent(c.NetworkName, "network-name"); err != nil {
		return err
	}
	if c.ExternalNetwork != "" {
		if err := ValidateSafeComponent(c.ExternalNetwork, "external-network"); err != nil {
			return err
		}
	}
	if c.APIHost != "127.0.0.1" {
		return fmt.Errorf("API host must remain 127.0.0.1")
	}
	if err := validateWorkspaceUIPublicOrigin(c.WorkspaceUIPublicOrigin); err != nil {
		return err
	}
	if err := validateWorkspaceUI(c.WorkspaceUIHost, c.WorkspaceUIPort, c.WorkspaceUIAuthRequired, c.WorkspaceUIPasswordHashFile, c.WorkspaceUIFirebaseProjectID, c.WorkspaceUIAllowedEmails, c.WorkspaceUIFirebaseAPIKey, c.WorkspaceUIFirebaseAuthDomain); err != nil {
		return err
	}
	if err := validateOpenWebUI(c.OpenWebUIHost, c.OpenWebUIPort, c.OpenWebUIGoogleClientID, c.OpenWebUIGoogleClientSecret, c.OpenWebUIURL, c.OpenWebUIAllowedDomains, c.OpenWebUIAllowedEmails, c.OpenWebUIEnableOAuthSignup); err != nil {
		return err
	}
	if c.LochoHostEnabled {
		if c.WorkspaceUIHost != "127.0.0.1" || c.OpenWebUIHost != "127.0.0.1" {
			return fmt.Errorf("locho-host requires workspace-ui and open-webui to bind to 127.0.0.1")
		}
		if !c.WorkspaceUIAuthRequired && c.WorkspaceUIFirebaseProjectID == "" {
			return fmt.Errorf("locho-host requires Workspace UI authentication")
		}
		if c.WorkspaceUIPort == c.OpenWebUIPort {
			return fmt.Errorf("locho-host requires different Workspace UI and Open WebUI ports")
		}
		if !c.OpenWebUIAuth {
			return fmt.Errorf("locho-host requires Open WebUI authentication")
		}
	}
	if c.LochoRelaySecrets != "" && c.LochoRelayConfig == "" {
		return fmt.Errorf("Locho relay secrets require a relay configuration")
	}
	if err := validateFallbackProviders(c.FallbackProviders); err != nil {
		return err
	}
	if err := ValidateAbsolutePath(c.ComposeFile, "compose-file"); err != nil {
		return err
	}
	if err := ValidateAbsolutePath(c.GeneratedCompose, "generated-compose"); err != nil {
		return err
	}
	if err := ValidateAbsolutePath(c.ComposeProjectDir, "compose-project-dir"); err != nil {
		return err
	}

	repositoryRoot, err := filepath.Abs(c.RepositoryRoot)
	if err != nil {
		return fmt.Errorf("resolve repository root: %w", err)
	}
	if within(c.ComposeFile, filepath.Join(repositoryRoot, "local")) || within(c.GeneratedCompose, filepath.Join(repositoryRoot, "local")) {
		return fmt.Errorf("compose files must not be under local/")
	}
	if tooBroad(c.RuntimeRoot) {
		return fmt.Errorf("runtime-root is too broad: %s", c.RuntimeRoot)
	}
	if within(c.RuntimeRoot, repositoryRoot) {
		return fmt.Errorf("runtime-root must not be inside the repository")
	}
	if err := ValidateAbsolutePath(c.InstallRoot, "install-root"); err != nil {
		return err
	}
	if tooBroad(c.InstallRoot) {
		return fmt.Errorf("install-root is too broad: %s", c.InstallRoot)
	}

	paths := []struct {
		label string
		path  string
	}{
		{"data-root", c.DataRoot},
		{"system-skills-root", c.SystemSkillsRoot},
		{"locho-root", c.LochoRoot},
		{"secret-file", c.SecretFile},
		{"backup-root", c.BackupRoot},
		{"meta-root", c.MetaRoot},
		{"state-file", c.StateFile},
		{"secret-dir", c.SecretDir},
	}
	if c.LochoRelayConfig != "" {
		paths = append(paths, struct {
			label string
			path  string
		}{"locho-relay-config", c.LochoRelayConfig})
	}
	if c.LochoRelaySecrets != "" {
		paths = append(paths, struct {
			label string
			path  string
		}{"locho-relay-secrets", c.LochoRelaySecrets})
	}
	if c.OpenWebUIHost != "" {
		paths = append(paths, struct {
			label string
			path  string
		}{"open-webui-data-root", c.OpenWebUIDataRoot})
	}
	if c.LochoHostEnabled {
		paths = append(paths,
			struct {
				label string
				path  string
			}{"locho-host-root", c.LochoHostRoot},
			struct {
				label string
				path  string
			}{"locho-host-config", c.LochoHostConfig},
			struct {
				label string
				path  string
			}{"locho-host-state-root", c.LochoHostStateRoot},
		)
	}
	for _, item := range paths {
		if err := ValidateAbsolutePath(item.path, item.label); err != nil {
			return err
		}
		if !within(item.path, c.RuntimeRoot) {
			return fmt.Errorf("runtime paths must remain below runtime-root")
		}
		if within(item.path, filepath.Join(repositoryRoot, "local")) {
			return fmt.Errorf("runtime path must not touch local/")
		}
	}
	for _, skill := range c.EnabledSkills {
		if err := ValidateSafeComponent(skill, "skill"); err != nil {
			return err
		}
	}
	return nil
}

func validateBackupDestinations(destinations []BackupDestination) error {
	seen := make(map[string]bool)
	for index, destination := range destinations {
		if err := ValidateSafeComponent(destination.Name, "backup-destination-name"); err != nil {
			return fmt.Errorf("backup destination %d: %w", index, err)
		}
		if seen[destination.Name] {
			return fmt.Errorf("duplicate backup destination %q", destination.Name)
		}
		seen[destination.Name] = true
		switch destination.Type {
		case "s3":
			if destination.Bucket == "" || destination.Region == "" {
				return fmt.Errorf("S3 backup destination %s requires bucket and region", destination.Name)
			}
			if strings.ContainsAny(destination.Bucket, "/\\ \t\r\n") || strings.HasPrefix(destination.Bucket, "-") {
				return fmt.Errorf("S3 backup destination %s has an invalid bucket", destination.Name)
			}
			if destination.Endpoint != "" {
				parsed, err := url.Parse(destination.Endpoint)
				if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
					return fmt.Errorf("S3 backup destination %s has an invalid HTTPS endpoint", destination.Name)
				}
			}
			if strings.HasPrefix(destination.Prefix, "/") || strings.Contains(destination.Prefix, "..") || strings.ContainsAny(destination.Prefix, "\\\r\n") {
				return fmt.Errorf("S3 backup destination %s has an unsafe prefix", destination.Name)
			}
			if destination.CredentialsFile != "" {
				if err := ValidateAbsolutePath(destination.CredentialsFile, "backup-S3-credentials-file"); err != nil {
					return err
				}
			}
			if destination.CredentialsProfile != "" {
				if err := validateAWSProfile(destination.CredentialsProfile); err != nil {
					return fmt.Errorf("S3 backup destination %s: %w", destination.Name, err)
				}
			}
		case "rsync":
			if destination.RsyncTarget == "" || strings.ContainsAny(destination.RsyncTarget, " \t\r\n;$&|()<>`'") {
				return fmt.Errorf("rsync backup destination %s has an invalid target", destination.Name)
			}
			host, remotePath, err := splitRsyncTarget(destination.RsyncTarget)
			if err != nil || !safeSSHHost(host) || !filepath.IsAbs(remotePath) || strings.Contains(remotePath, "..") {
				return fmt.Errorf("rsync backup destination %s must use host:/absolute/path syntax", destination.Name)
			}
			if destination.IdentityFile != "" {
				if err := ValidateAbsolutePath(destination.IdentityFile, "backup-rsync-identity-file"); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("backup destination %s has unsupported type %q", destination.Name, destination.Type)
		}
	}
	return nil
}

func validateFallbackProviders(values []FallbackProviderConfig) error {
	for index, fallback := range values {
		if fallback.Provider == "" || (fallback.Provider != "custom" && fallback.Provider != "openai-api" && ValidateSafeComponent(fallback.Provider, "fallback-provider") != nil) {
			return fmt.Errorf("fallback provider %d has an invalid provider", index)
		}
		if fallback.Model == "" {
			return fmt.Errorf("fallback provider %d requires a model", index)
		}
		if fallback.Provider == "custom" && fallback.BaseURL == "" {
			return fmt.Errorf("fallback provider %d requires an explicit base URL", index)
		}
		if fallback.BaseURL != "" {
			parsed, err := url.Parse(fallback.BaseURL)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
				return fmt.Errorf("fallback provider %d has an invalid base URL", index)
			}
		}
		if fallback.KeyEnv != "" && !validEnvKey(fallback.KeyEnv) {
			return fmt.Errorf("fallback provider %d has an invalid key_env", index)
		}
	}
	return nil
}

// ValidateAbsolutePath rejects path syntax that the shell implementation
// treats as unsafe rather than silently cleaning it.
func ValidateAbsolutePath(path, label string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("%s must be absolute", label)
	}
	if strings.ContainsAny(path, "\n\r\t") {
		return fmt.Errorf("%s contains unsupported whitespace", label)
	}
	if hasUnsafeComponent(path) {
		return fmt.Errorf("%s contains an unsafe path component", label)
	}
	return nil
}

// ValidateSafeComponent validates project, host, skill, and network names.
func ValidateSafeComponent(value, label string) error {
	if value == "" || value == "." || value == ".." || strings.HasPrefix(value, ".") {
		return fmt.Errorf("invalid %s", label)
	}
	for _, character := range value {
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '_' || character == '-') {
			return fmt.Errorf("invalid %s", label)
		}
	}
	return nil
}

func hasUnsafeComponent(path string) bool {
	for _, component := range strings.Split(filepath.ToSlash(path), "/") {
		if component == "." || component == ".." {
			return true
		}
	}
	return false
}

func tooBroad(path string) bool {
	switch path {
	case "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var":
		return true
	default:
		return false
	}
}

func within(path, parent string) bool {
	pathAbs, pathErr := filepath.Abs(path)
	parentAbs, parentErr := filepath.Abs(parent)
	if pathErr != nil || parentErr != nil {
		return false
	}
	relative, err := filepath.Rel(parentAbs, pathAbs)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
