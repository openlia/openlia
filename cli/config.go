package cli

import (
	"bufio"
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"
	"github.com/robfig/cron/v3"
	"openlia/internal/releaseinfo"
	"openlia/internal/toolcatalog"
	"openlia/internal/webuiauth"
)

const (
	configSchema                 = 2
	defaultRemoteRoot            = "/srv/openlia"
	defaultLocalRoot             = ".openlia"
	defaultProject               = "openlia"
	defaultOutputLanguage        = "en"
	defaultTimezone              = "Asia/Ho_Chi_Minh"
	defaultWorkspaceUIPort       = 8089
	defaultOpenWebUIPort         = 8090
	maxBackupRemoteRetentionDays = (1<<63 - 1) / int64(24*time.Hour)
)

var (
	defaultVersion        = releaseinfo.Default.OpenLia
	defaultHermesTag      = releaseinfo.Default.Hermes.Tag
	defaultLochoVersion   = releaseinfo.Default.Locho.Version
	defaultOpenWebUIImage = releaseinfo.Default.OpenWebUI.Ref()
	defaultHermesImage    = "openlia-hermes:" + defaultHermesTag
)

var defaultSkills = []string{
	"inbox-triage",
	"document-intelligence",
	"daily-briefing",
	"weekly-review",
	"calendar",
	"workspace-git",
	"workspace-organize",
}

const (
	RoleOpenLiaBrowser = "openlia-browser"
	RoleOpenAIGateway  = "openai-gateway"
)

var allowedServiceRoles = map[string]bool{
	RoleOpenLiaBrowser: true,
	RoleOpenAIGateway:  true,
}

func ValidateServiceRole(role string) error {
	if !allowedServiceRoles[role] {
		return fmt.Errorf("invalid service role %q; must be one of: %s, %s", role, RoleOpenLiaBrowser, RoleOpenAIGateway)
	}
	return nil
}

type Config struct {
	Schema                        int
	Version                       string
	Mode                          string
	Target                        string
	InstallRoot                   string
	Project                       string
	Model                         string
	OutputLanguage                string
	FallbackProviders             []FallbackProviderConfig
	Timezone                      string
	Provider                      string
	ExternalNetwork               string
	HermesImage                   string
	HermesTag                     string
	HermesDigest                  string
	LochoImage                    string
	LochoVersion                  string
	LochoX8664SHA256              string
	LochoARM64SHA256              string
	APIEnabled                    bool
	APIHost                       string
	WorkspaceUIHost               string
	WorkspaceUIPort               int
	WorkspaceUIPublicOrigin       string
	WorkspaceUIPasswordHash       string
	WorkspaceUIAllowedEmails      []string
	WorkspaceUIFirebaseProjectID  string
	WorkspaceUIFirebaseAPIKey     string
	WorkspaceUIFirebaseAuthDomain string
	WorkspaceUIFirebaseAppID      string
	OpenWebUIHost                 string
	OpenWebUIPort                 int
	OpenWebUIImage                string
	OpenWebUIAuth                 bool
	OpenWebUIAdminEmail           string
	OpenWebUIAdminPasswordHash    string
	OpenWebUIGoogleClientID       string
	OpenWebUIGoogleClientSecret   string
	OpenWebUIURL                  string
	OpenWebUIAllowedDomains       []string
	OpenWebUIAllowedEmails        []string
	OpenWebUIEnableOAuthSignup    bool
	LochoHostEnabled              bool
	LochoHostStateDir             string
	LochoRelayConfigSource        string
	LochoRelaySecretsSource       string
	SecretSource                  string
	ReleaseSource                 string
	EnabledSkills                 []string
	SkillsConfigured              bool
	IngestionMaxConcurrentJobs    int
	BackupIdentityFile            string
	BackupKnownHosts              string
	BackupRecipient               string
	BackupSchedule                string
	BackupScheduleEnabled         bool
	BackupLocalRetention          int
	BackupLocalMaxBytes           int64
	BackupRemoteRetentionDays     int
	BackupDestinations            []BackupDestinationConfig
	WorkspaceGitSchedule          string
	WorkspaceGitEnabled           bool
	Services                      []ServiceHostConfig
	OpenLiaBrowser                OpenLiaBrowserConfig
}

type BackupDestinationConfig struct {
	Name                  string
	Type                  string
	Endpoint              string
	Bucket                string
	Prefix                string
	Region                string
	PathStyle             bool
	RsyncTarget           string
	IdentityFile          string
	OperatorIdentityFile  string
	ReaderCredentialsFile string
	ReaderAWSProfile      string
	WriterCredentialsFile string
	WriterAWSProfile      string
}

type ServiceHostConfig struct {
	Name   string
	Source string
	Roles  map[string]string
}

type FallbackProviderConfig struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	BaseURL  string `json:"base_url,omitempty"`
	KeyEnv   string `json:"key_env,omitempty"`
}

type OpenLiaBrowserConfig struct {
	Configured         bool
	Mode               string
	Target             string
	SSHPort            int
	Root               string
	ExtensionTokenFile string
}

func defaultConfig() Config {
	return Config{
		Schema:                     configSchema,
		Version:                    defaultVersion,
		Mode:                       "ssh",
		InstallRoot:                defaultRemoteRoot,
		Project:                    defaultProject,
		Model:                      "gpt-5.6-luna",
		OutputLanguage:             defaultOutputLanguage,
		Timezone:                   defaultTimezone,
		Provider:                   "copilot",
		HermesImage:                defaultHermesImage,
		HermesTag:                  defaultHermesTag,
		HermesDigest:               releaseinfo.Default.Hermes.Digest,
		LochoImage:                 releaseinfo.InternalImage("openlia-locho", defaultLochoVersion),
		LochoVersion:               defaultLochoVersion,
		LochoX8664SHA256:           releaseinfo.Default.Locho.LinuxX8664SHA,
		LochoARM64SHA256:           releaseinfo.Default.Locho.LinuxARM64SHA,
		APIHost:                    "127.0.0.1",
		WorkspaceUIHost:            "",
		WorkspaceUIPort:            defaultWorkspaceUIPort,
		OpenWebUIHost:              "",
		OpenWebUIPort:              defaultOpenWebUIPort,
		OpenWebUIImage:             defaultOpenWebUIImage,
		OpenWebUIAuth:              true,
		OpenWebUIEnableOAuthSignup: false,
		LochoHostEnabled:           false,
		EnabledSkills:              append([]string(nil), defaultSkills...),
		BackupSchedule:             "20 4 * * *",
		BackupScheduleEnabled:      true,
		BackupLocalRetention:       5,
		BackupLocalMaxBytes:        10 << 30,
		BackupRemoteRetentionDays:  30,
		BackupDestinations:         []BackupDestinationConfig{},
		WorkspaceGitSchedule:       "0 4 * * *",
		WorkspaceGitEnabled:        true,
		IngestionMaxConcurrentJobs: 1,
		OpenLiaBrowser:             OpenLiaBrowserConfig{Mode: "local", SSHPort: 22},
		Services:                   nil,
	}
}

func hermesImage(config Config) string {
	if config.HermesImage != defaultHermesImage {
		return config.HermesImage
	}
	return toolcatalog.ManagedHermesImage(config.Project, config.HermesTag, config.HermesDigest, toolcatalog.DefaultDebianSnapshot)
}

func defaultLocalInstallRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return defaultLocalRoot
	}
	return filepath.Join(home, defaultLocalRoot)
}

func configPath() string {
	if value := os.Getenv("OPENLIA_CONFIG"); value != "" {
		return value
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return filepath.Join(".", ".config", "openlia", "config.toml")
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "openlia", "config.toml")
}

func loadConfig() (Config, error) {
	path := configPath()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return defaultConfig(), os.ErrNotExist
	}
	if err != nil {
		return Config{}, fmt.Errorf("read operator config: %w", err)
	}
	config, err := parseConfig(string(data))
	if err != nil {
		return Config{}, fmt.Errorf("parse operator config: %w", err)
	}
	return config, nil
}

func loadConfigUnchecked() (Config, error) {
	path := configPath()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return defaultConfig(), os.ErrNotExist
	}
	if err != nil {
		return Config{}, fmt.Errorf("read operator config: %w", err)
	}
	return parseConfigUnchecked(string(data))
}

func parseConfig(data string) (Config, error) {
	config, err := parseConfigUnchecked(data)
	if err != nil {
		return Config{}, err
	}
	return config, validateConfig(config)
}

func parseConfigUnchecked(data string) (Config, error) {
	config := defaultConfig()
	section := ""
	var err error
	scanner := bufio.NewScanner(strings.NewReader(data))
	lineNumber := 0
	backupLocalMaxBytesSet := false
	backupLocalMaxSizeSet := false
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[[") && strings.HasSuffix(line, "]]") {
			section = strings.TrimSpace(line[2 : len(line)-2])
			switch section {
			case "services":
				config.Services = append(config.Services, ServiceHostConfig{Roles: make(map[string]string)})
			case "fallback_providers":
				config.FallbackProviders = append(config.FallbackProviders, FallbackProviderConfig{})
			case "backup.destinations":
				config.BackupDestinations = append(config.BackupDestinations, BackupDestinationConfig{})
			}
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(line[1 : len(line)-1])
			if section == "services" && len(config.Services) == 0 {
				config.Services = append(config.Services, ServiceHostConfig{Roles: make(map[string]string)})
			}
			if section == "openlia-browser" {
				config.OpenLiaBrowser.Configured = true
			}
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return Config{}, fmt.Errorf("line %d is not a key/value pair", lineNumber)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(strings.SplitN(value, " #", 2)[0])
		if section == "services" {
			if len(config.Services) == 0 {
				config.Services = append(config.Services, ServiceHostConfig{Roles: make(map[string]string)})
			}
			current := &config.Services[len(config.Services)-1]
			cleanKey := strings.Trim(key, "\"")
			switch cleanKey {
			case "name":
				current.Name, err = parseString(value)
			case "source":
				current.Source, err = parseString(value)
				if err == nil {
					current.Source = expandTilde(current.Source)
				}
			default:
				if strings.Contains(cleanKey, ".") {
					return Config{}, fmt.Errorf("line %d: invalid service key %q; service names cannot contain dots (declare host with 'name = ...')", lineNumber, cleanKey)
				}
				var role string
				role, err = parseString(value)
				if err == nil {
					err = ValidateServiceRole(role)
				}
				if err == nil {
					if current.Roles == nil {
						current.Roles = make(map[string]string)
					}
					current.Roles[cleanKey] = role
				}
			}
		} else if section == "fallback_providers" {
			if len(config.FallbackProviders) == 0 {
				return Config{}, fmt.Errorf("line %d defines fallback provider fields without a table", lineNumber)
			}
			current := &config.FallbackProviders[len(config.FallbackProviders)-1]
			switch strings.Trim(key, "\"") {
			case "provider":
				current.Provider, err = parseString(value)
			case "model":
				current.Model, err = parseString(value)
			case "base_url":
				current.BaseURL, err = parseString(value)
			case "key_env":
				current.KeyEnv, err = parseString(value)
			default:
				return Config{}, fmt.Errorf("line %d contains unknown fallback provider setting %q", lineNumber, key)
			}
		} else if section == "backup.destinations" {
			if len(config.BackupDestinations) == 0 {
				return Config{}, fmt.Errorf("line %d defines backup destination fields without a table", lineNumber)
			}
			current := &config.BackupDestinations[len(config.BackupDestinations)-1]
			switch strings.Trim(key, "\"") {
			case "name":
				current.Name, err = parseString(value)
			case "type":
				current.Type, err = parseString(value)
			case "endpoint":
				current.Endpoint, err = parseString(value)
			case "bucket":
				current.Bucket, err = parseString(value)
			case "prefix":
				current.Prefix, err = parseString(value)
			case "region":
				current.Region, err = parseString(value)
			case "path_style":
				current.PathStyle, err = parseBool(value)
			case "rsync_target":
				current.RsyncTarget, err = parseString(value)
			case "identity_file":
				current.IdentityFile, err = parseString(value)
			case "operator_identity_file":
				current.OperatorIdentityFile, err = parseString(value)
				if err == nil {
					current.OperatorIdentityFile = expandTilde(current.OperatorIdentityFile)
				}
			case "reader_credentials_file":
				current.ReaderCredentialsFile, err = parseString(value)
				if err == nil {
					current.ReaderCredentialsFile = expandTilde(current.ReaderCredentialsFile)
				}
			case "reader_aws_profile":
				current.ReaderAWSProfile, err = parseString(value)
			case "writer_credentials_file":
				current.WriterCredentialsFile, err = parseString(value)
				if err == nil {
					current.WriterCredentialsFile = expandTilde(current.WriterCredentialsFile)
				}
			case "writer_aws_profile":
				current.WriterAWSProfile, err = parseString(value)
			default:
				return Config{}, fmt.Errorf("line %d contains unknown backup destination setting %q", lineNumber, key)
			}
		} else {
			switch section + "." + key {
			case "openlia.schema":
				config.Schema, err = parseInt(value)
			case "openlia.version":
				config.Version, err = parseString(value)
			case "openlia.mode":
				config.Mode, err = parseString(value)
			case "openlia.target":
				config.Target, err = parseString(value)
			case "openlia.root":
				config.InstallRoot, err = parseString(value)
			case "openlia.remote_root":
				config.InstallRoot, err = parseString(value)
			case "openlia.project":
				config.Project, err = parseString(value)
			case "openlia.model":
				config.Model, err = parseString(value)
			case "openlia.output_language":
				config.OutputLanguage, err = parseString(value)
			case "openlia.timezone":
				config.Timezone, err = parseString(value)
			case "openlia.provider":
				config.Provider, err = parseString(value)
			case "openlia.external_network":
				config.ExternalNetwork, err = parseString(value)
			case "workspace-ui.host":
				config.WorkspaceUIHost, err = parseString(value)
			case "workspace-ui.port":
				config.WorkspaceUIPort, err = parseInt(value)
			case "workspace-ui.public_origin":
				config.WorkspaceUIPublicOrigin, err = parseString(value)
			case "workspace-ui.password_hash":
				config.WorkspaceUIPasswordHash, err = parseString(value)
			case "workspace-ui.allowed_emails":
				config.WorkspaceUIAllowedEmails, err = parseStringArray(value)
			case "workspace-ui.firebase_project_id":
				config.WorkspaceUIFirebaseProjectID, err = parseString(value)
			case "workspace-ui.firebase_api_key":
				config.WorkspaceUIFirebaseAPIKey, err = parseString(value)
			case "workspace-ui.firebase_auth_domain":
				config.WorkspaceUIFirebaseAuthDomain, err = parseString(value)
			case "workspace-ui.firebase_app_id":
				config.WorkspaceUIFirebaseAppID, err = parseString(value)
			case "open-webui.host":
				config.OpenWebUIHost, err = parseString(value)
			case "open-webui.port":
				config.OpenWebUIPort, err = parseInt(value)
			case "open-webui.image":
				config.OpenWebUIImage, err = parseString(value)
			case "open-webui.auth":
				config.OpenWebUIAuth, err = parseBool(value)
			case "open-webui.admin_email":
				config.OpenWebUIAdminEmail, err = parseString(value)
			case "open-webui.admin_password_hash":
				config.OpenWebUIAdminPasswordHash, err = parseString(value)
			case "open-webui.google_client_id":
				config.OpenWebUIGoogleClientID, err = parseString(value)
			case "open-webui.google_client_secret":
				config.OpenWebUIGoogleClientSecret, err = parseString(value)
			case "open-webui.url":
				config.OpenWebUIURL, err = parseString(value)
			case "open-webui.allowed_domains":
				config.OpenWebUIAllowedDomains, err = parseStringArray(value)
			case "open-webui.allowed_emails":
				config.OpenWebUIAllowedEmails, err = parseStringArray(value)
			case "open-webui.enable_oauth_signup":
				config.OpenWebUIEnableOAuthSignup, err = parseBool(value)
			case "locho-host.enabled":
				config.LochoHostEnabled, err = parseBool(value)
			case "locho-host.state_dir":
				config.LochoHostStateDir, err = parseString(value)
				if err == nil {
					config.LochoHostStateDir = expandTilde(config.LochoHostStateDir)
				}
			case "locho.relay_config":
				config.LochoRelayConfigSource, err = parseString(value)
				if err == nil {
					config.LochoRelayConfigSource = expandTilde(config.LochoRelayConfigSource)
				}
			case "locho.relay_secrets":
				config.LochoRelaySecretsSource, err = parseString(value)
				if err == nil {
					config.LochoRelaySecretsSource = expandTilde(config.LochoRelaySecretsSource)
				}
			case "openlia-browser.mode":
				config.OpenLiaBrowser.Mode, err = parseString(value)
			case "openlia-browser.target":
				config.OpenLiaBrowser.Target, err = parseString(value)
			case "openlia-browser.ssh_port":
				config.OpenLiaBrowser.SSHPort, err = parseInt(value)
			case "openlia-browser.root":
				config.OpenLiaBrowser.Root, err = parseString(value)
			case "openlia-browser.extension_token_file":
				config.OpenLiaBrowser.ExtensionTokenFile, err = parseString(value)
			case "components.open_webui_image":
				config.OpenWebUIImage, err = parseString(value)
			case "release.source":
				config.ReleaseSource, err = parseString(value)
			case "components.hermes_image":
				config.HermesImage, err = parseString(value)
			case "components.hermes_tag":
				config.HermesTag, err = parseString(value)
			case "components.hermes_digest":
				config.HermesDigest, err = parseString(value)
			case "components.locho_image":
				config.LochoImage, err = parseString(value)
			case "components.locho_version":
				config.LochoVersion, err = parseString(value)
			case "components.locho_x86_64_sha256":
				config.LochoX8664SHA256, err = parseString(value)
			case "components.locho_arm64_sha256":
				config.LochoARM64SHA256, err = parseString(value)
			case "api.enabled":
				config.APIEnabled, err = parseBool(value)
			case "api.host":
				config.APIHost, err = parseString(value)
			case "secrets.source":
				config.SecretSource, err = parseString(value)
			case "skills.enabled":
				config.EnabledSkills, err = parseStringArray(value)
				config.SkillsConfigured = true
			case "ingestion.max_concurrent_jobs":
				config.IngestionMaxConcurrentJobs, err = parseInt(value)
			case "backup.identity_file":
				config.BackupIdentityFile, err = parseString(value)
				if err == nil {
					config.BackupIdentityFile = expandTilde(config.BackupIdentityFile)
				}
			case "backup.known_hosts":
				config.BackupKnownHosts, err = parseString(value)
				if err == nil {
					config.BackupKnownHosts = expandTilde(config.BackupKnownHosts)
				}
			case "backup.recipient":
				config.BackupRecipient, err = parseString(value)
			case "backup.schedule":
				config.BackupSchedule, err = parseString(value)
			case "backup.schedule_enabled":
				config.BackupScheduleEnabled, err = parseBool(value)
			case "backup.local_retention":
				config.BackupLocalRetention, err = parseInt(value)
			case "backup.local_max_bytes":
				if backupLocalMaxSizeSet {
					return Config{}, fmt.Errorf("line %d cannot set both backup.local_max_size and backup.local_max_bytes", lineNumber)
				}
				config.BackupLocalMaxBytes, err = parseInt64(value)
				backupLocalMaxBytesSet = true
			case "backup.local_max_size":
				if backupLocalMaxBytesSet {
					return Config{}, fmt.Errorf("line %d cannot set both backup.local_max_size and backup.local_max_bytes", lineNumber)
				}
				config.BackupLocalMaxBytes, err = parseBackupSize(value)
				backupLocalMaxSizeSet = true
			case "backup.remote_retention_days":
				config.BackupRemoteRetentionDays, err = parseInt(value)
			case "workspace_git.schedule":
				config.WorkspaceGitSchedule, err = parseString(value)
			case "workspace_git.enabled":
				config.WorkspaceGitEnabled, err = parseBool(value)
			default:
				return Config{}, fmt.Errorf("line %d contains unknown setting %q", lineNumber, section+"."+key)
			}
		}
		if err != nil {
			return Config{}, fmt.Errorf("line %d: %w", lineNumber, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func parseString(value string) (string, error) {
	if len(value) < 2 || value[0] != '"' || value[len(value)-1] != '"' {
		return "", errors.New("expected a quoted string")
	}
	return strconv.Unquote(value)
}

func parseInt(value string) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("expected integer: %w", err)
	}
	return parsed, nil
}

func parseInt64(value string) (int64, error) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("expected integer: %w", err)
	}
	return parsed, nil
}

func parseBackupSize(value string) (int64, error) {
	text, err := parseString(value)
	if err != nil {
		return 0, err
	}
	parts := strings.Fields(text)
	if len(parts) != 2 {
		return 0, errors.New("expected a quoted size such as \"10 GiB\"")
	}
	number, err := strconv.ParseFloat(parts[0], 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return 0, errors.New("size amount must be a positive number")
	}
	multipliers := map[string]float64{
		"B":   1,
		"KB":  1e3,
		"MB":  1e6,
		"GB":  1e9,
		"TB":  1e12,
		"KIB": 1 << 10,
		"MIB": 1 << 20,
		"GIB": 1 << 30,
		"TIB": 1 << 40,
	}
	multiplier, ok := multipliers[strings.ToUpper(parts[1])]
	if !ok {
		return 0, errors.New("size unit must be B, KB, MB, GB, TB, KiB, MiB, GiB, or TiB")
	}
	bytes := number * multiplier
	if bytes > float64(math.MaxInt64) || bytes < 1 {
		return 0, errors.New("size is outside the supported range")
	}
	return int64(math.Round(bytes)), nil
}

func formatBackupSize(bytes int64) string {
	units := []struct {
		name   string
		factor int64
	}{
		{"TiB", 1 << 40},
		{"GiB", 1 << 30},
		{"MiB", 1 << 20},
		{"KiB", 1 << 10},
	}
	for _, unit := range units {
		if bytes >= unit.factor && bytes%unit.factor == 0 {
			return fmt.Sprintf("%d %s", bytes/unit.factor, unit.name)
		}
	}
	return fmt.Sprintf("%d B", bytes)
}

func parseBool(value string) (bool, error) {
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("expected boolean: %w", err)
	}
	return parsed, nil
}

func parseStringArray(value string) ([]string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value[0] != '[' || value[len(value)-1] != ']' {
		return nil, errors.New("expected an array")
	}
	value = strings.TrimSpace(value[1 : len(value)-1])
	if value == "" {
		return []string{}, nil
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		item, err := parseString(strings.TrimSpace(part))
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

func validateConfig(config Config) error {
	if config.Schema != configSchema {
		return fmt.Errorf("unsupported config schema %d", config.Schema)
	}
	if !safeVersion(config.Version) || config.Project == "" || config.Model == "" {
		return errors.New("version, project, and model are required")
	}
	if err := validateTimezone(config.Timezone); err != nil {
		return err
	}
	if config.BackupLocalRetention <= 0 {
		return errors.New("backup.local_retention must be a positive integer")
	}
	if config.BackupLocalMaxBytes <= 0 {
		return errors.New("backup.local_max_size must be a positive size")
	}
	if config.BackupRemoteRetentionDays <= 0 || int64(config.BackupRemoteRetentionDays) > maxBackupRemoteRetentionDays {
		return errors.New("backup.remote_retention_days must be a positive integer")
	}
	if config.BackupRecipient != "" {
		if _, err := age.ParseX25519Recipient(config.BackupRecipient); err != nil {
			return errors.New("backup.recipient must be an age X25519 public recipient")
		}
	}
	if config.BackupIdentityFile != "" {
		if err := validateAbsoluteRoot(config.BackupIdentityFile, "backup.identity_file"); err != nil {
			return err
		}
		if isInsideWorkingTree(config.BackupIdentityFile) {
			return errors.New("backup.identity_file must be outside the OpenLia checkout")
		}
	}
	if config.BackupKnownHosts != "" {
		if err := validateAbsoluteRoot(config.BackupKnownHosts, "backup.known_hosts"); err != nil {
			return err
		}
	}
	if config.BackupScheduleEnabled || config.BackupSchedule != "" {
		if _, err := cron.ParseStandard(config.BackupSchedule); err != nil {
			return fmt.Errorf("backup.schedule must be a five-field cron expression: %w", err)
		}
	}
	if config.WorkspaceGitEnabled || config.WorkspaceGitSchedule != "" {
		if _, err := cron.ParseStandard(config.WorkspaceGitSchedule); err != nil {
			return fmt.Errorf("workspace_git.schedule must be a five-field cron expression: %w", err)
		}
	}
	if err := validateBackupDestinations(config.BackupDestinations); err != nil {
		return err
	}
	for _, destination := range config.BackupDestinations {
		if destination.IdentityFile != "" && (pathWithin(destination.IdentityFile, filepath.Join(config.InstallRoot, "runtime", "secrets")) || pathWithin(destination.IdentityFile, filepath.Join(config.InstallRoot, "runtime", "hermes"))) {
			return fmt.Errorf("backup rsync identity files must not be inside Hermes data or mounted runtime secrets")
		}
		if err := validateBackupCredentialReferences(destination); err != nil {
			return err
		}
	}
	if err := validateOutputLanguage(config.OutputLanguage); err != nil {
		return err
	}
	if config.Mode != "local" && config.Mode != "ssh" {
		return fmt.Errorf("mode must be local or ssh")
	}
	if config.Mode == "local" {
		if config.Target != "" {
			return errors.New("local mode cannot have a target")
		}
	} else if err := validateTarget(config.Target); err != nil && config.Target != "" {
		return err
	}
	if err := validateAbsoluteRoot(config.InstallRoot, "root"); err != nil {
		return err
	}
	if !safeComponent(config.Project) {
		return errors.New("project must contain only letters, numbers, underscore, or hyphen")
	}
	if !safeReference(config.Provider) {
		return errors.New("provider must contain only URL-safe provider identifier characters")
	}
	if config.ExternalNetwork != "" && !safeComponent(config.ExternalNetwork) {
		return errors.New("external network must contain only letters, numbers, underscore, or hyphen")
	}
	if !safeImageRef(config.HermesImage) || !safeImageRef(config.LochoImage) {
		return errors.New("component image references contain unsupported characters")
	}
	if config.OpenWebUIImage != "" && !safeImageRef(config.OpenWebUIImage) {
		return errors.New("component image references contain unsupported characters")
	}
	if config.HermesTag == "" || !validDigest(config.HermesDigest) {
		return errors.New("Hermes tag and digest are required")
	}
	if config.LochoVersion == "" || config.LochoImage == "" || config.HermesImage == "" {
		return errors.New("component versions and image names are required")
	}
	if !validDigest("sha256:"+config.LochoX8664SHA256) || !validDigest("sha256:"+config.LochoARM64SHA256) {
		return errors.New("Locho release checksums must be 64 lowercase hexadecimal characters")
	}
	if config.APIHost != "127.0.0.1" {
		return errors.New("API host must remain 127.0.0.1; use SSH or a private network for access")
	}
	if err := validateWorkspaceUI(config.WorkspaceUIHost, config.WorkspaceUIPort, config.WorkspaceUIPublicOrigin, config.WorkspaceUIPasswordHash, config.WorkspaceUIAllowedEmails, config.WorkspaceUIFirebaseProjectID, config.WorkspaceUIFirebaseAPIKey, config.WorkspaceUIFirebaseAuthDomain, config.LochoHostEnabled); err != nil {
		return err
	}
	if err := webuiauth.ValidateAdmin(config.OpenWebUIAdminEmail, config.OpenWebUIAdminPasswordHash, config.OpenWebUIAuth, config.OpenWebUIGoogleClientID); err != nil {
		return err
	}
	if config.OpenWebUIHost != "" {
		if err := validateOpenWebUI(config.OpenWebUIHost, config.OpenWebUIPort, config.OpenWebUIGoogleClientID, config.OpenWebUIGoogleClientSecret, config.OpenWebUIURL, config.OpenWebUIAllowedDomains, config.OpenWebUIAllowedEmails, config.OpenWebUIEnableOAuthSignup); err != nil {
			return err
		}
	}
	if config.LochoHostEnabled {
		if config.WorkspaceUIHost != "127.0.0.1" || config.OpenWebUIHost != "127.0.0.1" {
			return errors.New("locho-host requires workspace-ui and open-webui to bind to 127.0.0.1")
		}
		if config.WorkspaceUIPort == config.OpenWebUIPort {
			return errors.New("locho-host requires different workspace-ui and open-webui ports")
		}
		if !config.OpenWebUIAuth {
			return errors.New("locho-host requires open-webui authentication")
		}
	}
	if config.LochoHostStateDir != "" {
		if err := validateAbsoluteRoot(config.LochoHostStateDir, "locho-host.state_dir"); err != nil {
			return err
		}
		if isInsideWorkingTree(config.LochoHostStateDir) {
			return errors.New("locho-host.state_dir must be outside the OpenLia checkout")
		}
	}
	if config.LochoRelayConfigSource != "" {
		if err := validateAbsoluteRoot(config.LochoRelayConfigSource, "locho.relay_config"); err != nil {
			return err
		}
	}
	if config.LochoRelaySecretsSource != "" {
		if config.LochoRelayConfigSource == "" {
			return errors.New("locho.relay_secrets requires locho.relay_config")
		}
		if err := validateAbsoluteRoot(config.LochoRelaySecretsSource, "locho.relay_secrets"); err != nil {
			return err
		}
	}
	if config.OpenLiaBrowser.Configured {
		if err := validateOpenLiaBrowser(config.OpenLiaBrowser); err != nil {
			return err
		}
	}
	if config.SecretSource != "" && !filepath.IsAbs(config.SecretSource) {
		return errors.New("secret source must be an absolute path")
	}
	if !safeReference(config.Model) {
		return errors.New("model must contain only URL-safe model identifier characters")
	}
	for index, fallback := range config.FallbackProviders {
		if !safeReference(fallback.Provider) || fallback.Provider == "custom" && fallback.BaseURL == "" {
			return fmt.Errorf("fallback provider %d requires a provider and explicit base_url", index)
		}
		if !safeReference(fallback.Model) {
			return fmt.Errorf("fallback provider %d model must contain only URL-safe model identifier characters", index)
		}
		if err := validateOpenAIEndpoint(fallback.BaseURL); err != nil {
			return fmt.Errorf("fallback provider %d: %w", index, err)
		}
		if fallback.KeyEnv != "" && !safeEnvName(fallback.KeyEnv) {
			return fmt.Errorf("fallback provider %d key_env is invalid", index)
		}
	}
	for _, skill := range config.EnabledSkills {
		if !safeComponent(skill) {
			return fmt.Errorf("invalid skill name %q", skill)
		}
	}
	if config.IngestionMaxConcurrentJobs <= 0 {
		return errors.New("ingestion.max_concurrent_jobs must be a positive integer")
	}
	hostNames := make(map[string]bool)
	for i, host := range config.Services {
		if host.Name == "" {
			return fmt.Errorf("service host at index %d requires a name", i)
		}
		if !safeComponent(host.Name) {
			return fmt.Errorf("invalid service host name %q", host.Name)
		}
		if hostNames[host.Name] {
			return fmt.Errorf("duplicate service host name %q", host.Name)
		}
		hostNames[host.Name] = true
		if host.Source != "" {
			if !filepath.IsAbs(host.Source) {
				return fmt.Errorf("service host %q source %q must be an absolute path", host.Name, host.Source)
			}
			if isInsideWorkingTree(host.Source) {
				return fmt.Errorf("service host %q source %q must be outside the OpenLia checkout", host.Name, host.Source)
			}
		}
		for svc, role := range host.Roles {
			if !safeComponent(svc) {
				return fmt.Errorf("service host %q has invalid service name %q", host.Name, svc)
			}
			if err := ValidateServiceRole(role); err != nil {
				return fmt.Errorf("service host %q service %q: %w", host.Name, svc, err)
			}
		}
	}
	return nil
}

func validateBackupDestinations(destinations []BackupDestinationConfig) error {
	seen := make(map[string]bool)
	for index, destination := range destinations {
		if !safeComponent(destination.Name) {
			return fmt.Errorf("backup destination %d has an invalid name", index)
		}
		if seen[destination.Name] {
			return fmt.Errorf("duplicate backup destination %q", destination.Name)
		}
		seen[destination.Name] = true
		switch destination.Type {
		case "s3":
			if destination.Bucket == "" || destination.Region == "" {
				return fmt.Errorf("S3 destination %s requires bucket and region", destination.Name)
			}
			if destination.Endpoint != "" {
				parsed, err := url.Parse(destination.Endpoint)
				if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
					return fmt.Errorf("S3 destination %s requires a credential-free HTTPS endpoint", destination.Name)
				}
			}
			if strings.HasPrefix(destination.Prefix, "/") || strings.Contains(destination.Prefix, "..") || strings.ContainsAny(destination.Prefix, "\\\r\n") {
				return fmt.Errorf("S3 destination %s has an unsafe prefix", destination.Name)
			}
			if destination.WriterAWSProfile != "" && destination.WriterCredentialsFile == "" {
				return fmt.Errorf("S3 destination %s writer_aws_profile requires writer_credentials_file", destination.Name)
			}
			if destination.ReaderAWSProfile != "" && destination.ReaderCredentialsFile == "" {
				return fmt.Errorf("S3 destination %s reader_aws_profile requires reader_credentials_file", destination.Name)
			}
		case "rsync":
			if destination.RsyncTarget == "" || strings.ContainsAny(destination.RsyncTarget, " \t\r\n;$&|()<>`'") {
				return fmt.Errorf("rsync destination %s has an invalid target", destination.Name)
			}
			if destination.IdentityFile != "" {
				if err := validateAbsoluteRoot(destination.IdentityFile, "backup destination identity_file"); err != nil {
					return err
				}
			}
			if destination.OperatorIdentityFile != "" {
				if err := validateAbsoluteRoot(destination.OperatorIdentityFile, "backup destination operator_identity_file"); err != nil {
					return err
				}
				if isInsideWorkingTree(destination.OperatorIdentityFile) {
					return errors.New("backup destination operator_identity_file must be outside the OpenLia checkout")
				}
			}
			if destination.ReaderCredentialsFile != "" || destination.ReaderAWSProfile != "" || destination.WriterCredentialsFile != "" || destination.WriterAWSProfile != "" {
				return fmt.Errorf("rsync destination %s cannot configure S3 credentials", destination.Name)
			}
		default:
			return fmt.Errorf("backup destination %s type must be s3 or rsync", destination.Name)
		}
	}
	return nil
}

func validateWorkspaceUI(host string, port int, publicOrigin, passwordHash string, allowedEmails []string, firebaseProjectID, firebaseAPIKey, firebaseAuthDomain string, authRequired bool) error {
	if host != "" && (net.ParseIP(host) == nil || host != "127.0.0.1" && host != "0.0.0.0") {
		return errors.New("workspace-ui.host must be 127.0.0.1 or 0.0.0.0")
	}
	if port < 1 || port > 65535 {
		return errors.New("workspace-ui.port must be between 1 and 65535")
	}
	if err := validateWorkspaceUIPublicOrigin(publicOrigin); err != nil {
		return err
	}

	isFirebase := firebaseProjectID != "" || len(allowedEmails) > 0
	if isFirebase {
		if len(allowedEmails) == 0 {
			return errors.New("workspace-ui.allowed_emails must contain at least one email address")
		}
		for _, email := range allowedEmails {
			if email == "" || !strings.Contains(email, "@") || strings.HasPrefix(email, "@") || strings.HasSuffix(email, "@") {
				return errors.New("workspace-ui.allowed_emails must contain valid email addresses")
			}
		}
		if firebaseProjectID == "" {
			return errors.New("workspace-ui.firebase_project_id is required when Firebase Auth is configured")
		}
		if firebaseAPIKey == "" {
			return errors.New("workspace-ui.firebase_api_key is required when Firebase Auth is configured")
		}
		if firebaseAuthDomain == "" {
			return errors.New("workspace-ui.firebase_auth_domain is required when Firebase Auth is configured")
		}
		return nil
	}

	if passwordHash != "" {
		if err := validateWorkspaceUIPasswordHash(passwordHash); err != nil {
			return err
		}
	}
	if (host == "0.0.0.0" || authRequired) && passwordHash == "" {
		return errors.New("workspace-ui.password_hash is required when Workspace UI authentication is enabled")
	}
	return nil
}

func validateOpenWebUI(host string, port int, googleClientID, googleClientSecret, openWebUIURL string, allowedDomains, allowedEmails []string, enableOAuthSignup bool) error {
	if host == "" {
		return nil
	}
	if net.ParseIP(host) == nil || host != "127.0.0.1" && host != "0.0.0.0" {
		return errors.New("open-webui.host must be 127.0.0.1 or 0.0.0.0")
	}
	if port < 1 || port > 65535 {
		return errors.New("open-webui.port must be between 1 and 65535")
	}
	isGoogleAuth := googleClientID != "" || googleClientSecret != "" || openWebUIURL != "" || len(allowedDomains) > 0 || len(allowedEmails) > 0
	if isGoogleAuth {
		if googleClientID == "" {
			return errors.New("open-webui.google_client_id is required when Google OAuth is configured")
		}
		if googleClientSecret == "" {
			return errors.New("open-webui.google_client_secret is required when Google OAuth is configured")
		}
		if openWebUIURL == "" {
			return errors.New("open-webui.url is required when Google OAuth is configured")
		}
		parsedURL, err := url.Parse(openWebUIURL)
		if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" {
			return errors.New("open-webui.url must be a valid http or https URL")
		}
		for _, domain := range allowedDomains {
			if strings.TrimSpace(domain) == "" || strings.Contains(domain, "@") || strings.Contains(domain, " ") {
				return errors.New("open-webui.allowed_domains must contain valid domain names without '@'")
			}
		}
		for _, email := range allowedEmails {
			if strings.TrimSpace(email) == "" || !strings.Contains(email, "@") || strings.HasPrefix(email, "@") || strings.HasSuffix(email, "@") || strings.Contains(email, " ") {
				return errors.New("open-webui.allowed_emails must contain valid email addresses")
			}
		}
		if !enableOAuthSignup && len(allowedEmails) == 0 {
			return errors.New("open-webui.allowed_emails must contain at least one email address when enable_oauth_signup is false")
		}
	}
	return nil
}

func validateOpenLiaBrowser(config OpenLiaBrowserConfig) error {
	if config.Mode != "local" && config.Mode != "ssh" {
		return errors.New("openlia-browser.mode must be local or ssh")
	}
	if config.Root == "" {
		return errors.New("openlia-browser.root is required")
	}
	if config.ExtensionTokenFile == "" {
		return errors.New("openlia-browser.extension_token_file is required")
	}
	if err := validateAbsoluteRoot(config.ExtensionTokenFile, "openlia-browser.extension_token_file"); err != nil {
		return err
	}
	if err := validateAbsoluteRoot(config.Root, "openlia-browser.root"); err != nil {
		return err
	}
	if config.SSHPort < 1 || config.SSHPort > 65535 {
		return errors.New("openlia-browser.ssh_port must be between 1 and 65535")
	}
	if config.Mode == "local" {
		if config.Target != "" {
			return errors.New("openlia-browser.target must be empty in local mode")
		}
		return nil
	}
	if config.Target == "" {
		return errors.New("openlia-browser.target is required in ssh mode")
	}
	if err := validateTarget(config.Target); err != nil {
		return fmt.Errorf("openlia-browser.target: %w", err)
	}
	if !strings.Contains(config.Target, "@") || strings.HasPrefix(config.Target, "@") || strings.HasSuffix(config.Target, "@") {
		return errors.New("openlia-browser.target must use user@host syntax")
	}
	return nil
}

func validateWorkspaceUIPublicOrigin(value string) error {
	if value == "" {
		return nil
	}
	origin, err := url.Parse(value)
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Host == "" || origin.User != nil || origin.Opaque != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.Path != "" && origin.Path != "/" {
		return errors.New("workspace-ui.public_origin must be an absolute http(s) origin")
	}
	return nil
}

func validateOpenAIEndpoint(value string) error {
	if value == "" {
		return nil
	}
	if strings.ContainsAny(value, " \t\r\n") {
		return errors.New("gateway base URL must not contain whitespace")
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("gateway base URL must be an HTTP(S) URL without credentials, query, or fragment")
	}
	return nil
}

func safeEnvName(value string) bool {
	if value == "" || !((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z') || value[0] == '_') {
		return false
	}
	for _, character := range value[1:] {
		if !((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_') {
			return false
		}
	}
	return true
}

func validateTarget(target string) error {
	if target == "" || strings.ContainsAny(target, " \t\r\n'\";$&|()<>`") {
		return errors.New("target must be a non-empty SSH destination without shell metacharacters")
	}
	return nil
}

func validateTimezone(value string) error {
	if value == "" || value == "Local" || strings.HasPrefix(value, "/") || strings.Contains(value, "..") {
		return errors.New("timezone must be a valid IANA timezone, not Local or a filesystem path")
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && !strings.ContainsRune("/_+-", character) {
			return errors.New("timezone must be a valid IANA timezone, not Local or a filesystem path")
		}
	}
	if _, err := time.LoadLocation(value); err != nil {
		return fmt.Errorf("timezone must be a valid IANA timezone: %w", err)
	}
	return nil
}

func validateOutputLanguage(value string) error {
	parts := strings.Split(value, "-")
	if len(parts) == 0 || len(parts[0]) < 2 || len(parts[0]) > 8 {
		return errors.New("output language must be a BCP 47 language tag")
	}
	for _, character := range parts[0] {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') {
			return errors.New("output language must be a BCP 47 language tag")
		}
	}
	for _, part := range parts[1:] {
		if len(part) < 1 || len(part) > 8 {
			return errors.New("output language must be a BCP 47 language tag")
		}
		for _, character := range part {
			if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') {
				return errors.New("output language must be a BCP 47 language tag")
			}
		}
	}
	return nil
}

func validateAbsoluteRoot(root, label string) error {
	if !strings.HasPrefix(root, "/") || strings.ContainsAny(root, "\r\n\t'\";$&|()<>`") || strings.Contains(root, "/../") || strings.HasSuffix(root, "/..") {
		return fmt.Errorf("%s must be a safe absolute path", label)
	}
	if root == "/" || root == "/srv" || root == "/opt" || root == "/var" || root == "/home" {
		return fmt.Errorf("%s is too broad", label)
	}
	return nil
}

func safeComponent(value string) bool {
	if value == "" || value == "." || value == ".." || strings.HasPrefix(value, ".") {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func pathWithin(path, parent string) bool {
	path, pathErr := filepath.Abs(path)
	parent, parentErr := filepath.Abs(parent)
	if pathErr != nil || parentErr != nil {
		return false
	}
	relative, err := filepath.Rel(parent, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func safeVersion(value string) bool {
	if value == "" || strings.HasPrefix(value, ".") || strings.HasPrefix(value, "-") {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && !strings.ContainsRune(".-_+", character) {
			return false
		}
	}
	return true
}

func safeReference(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && !strings.ContainsRune("._:/-", character) {
			return false
		}
	}
	return true
}

func safeImageRef(value string) bool {
	parts := strings.Split(value, "@")
	if len(parts) > 2 || !safeReference(parts[0]) || strings.Contains(parts[0], "..") {
		return false
	}
	return len(parts) == 1 || validDigest(parts[1])
}

func validDigest(value string) bool {
	if len(value) != len("sha256:")+64 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	for _, character := range value[len("sha256:"):] {
		if !(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func saveConfig(config Config) error {
	if err := validateConfig(config); err != nil {
		return err
	}
	path := configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	content := renderConfig(config)
	temporary, err := os.CreateTemp(filepath.Dir(path), ".config.toml.tmp-*")
	if err != nil {
		return fmt.Errorf("create config temporary file: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.WriteString(content); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return fmt.Errorf("activate operator config: %w", err)
	}
	return nil
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func renderConfig(config Config) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "[openlia]\nschema = %d\nversion = %q\nmode = %q\ntarget = %q\nroot = %q\nproject = %q\nmodel = %q\noutput_language = %q\ntimezone = %q\nprovider = %q\nexternal_network = %q\n\n", config.Schema, config.Version, config.Mode, config.Target, config.InstallRoot, config.Project, config.Model, config.OutputLanguage, config.Timezone, config.Provider, config.ExternalNetwork)
	if config.OpenLiaBrowser.Configured {
		fmt.Fprintf(&builder, "[openlia-browser]\nmode = %q\ntarget = %q\nssh_port = %d\nroot = %q\nextension_token_file = %q\n\n", config.OpenLiaBrowser.Mode, config.OpenLiaBrowser.Target, config.OpenLiaBrowser.SSHPort, config.OpenLiaBrowser.Root, config.OpenLiaBrowser.ExtensionTokenFile)
	}
	if config.WorkspaceUIHost != "" {
		fmt.Fprintf(&builder, "[workspace-ui]\nhost = %q\nport = %d\n", config.WorkspaceUIHost, config.WorkspaceUIPort)
		if config.WorkspaceUIPublicOrigin != "" {
			fmt.Fprintf(&builder, "public_origin = %q\n", config.WorkspaceUIPublicOrigin)
		}
		if config.WorkspaceUIPasswordHash != "" {
			fmt.Fprintf(&builder, "password_hash = %q\n", config.WorkspaceUIPasswordHash)
		}
		if len(config.WorkspaceUIAllowedEmails) > 0 {
			builder.WriteString("allowed_emails = [")
			for i, email := range config.WorkspaceUIAllowedEmails {
				if i > 0 {
					builder.WriteString(", ")
				}
				fmt.Fprintf(&builder, "%q", email)
			}
			builder.WriteString("]\n")
		}
		if config.WorkspaceUIFirebaseProjectID != "" {
			fmt.Fprintf(&builder, "firebase_project_id = %q\n", config.WorkspaceUIFirebaseProjectID)
		}
		if config.WorkspaceUIFirebaseAPIKey != "" {
			fmt.Fprintf(&builder, "firebase_api_key = %q\n", config.WorkspaceUIFirebaseAPIKey)
		}
		if config.WorkspaceUIFirebaseAuthDomain != "" {
			fmt.Fprintf(&builder, "firebase_auth_domain = %q\n", config.WorkspaceUIFirebaseAuthDomain)
		}
		if config.WorkspaceUIFirebaseAppID != "" {
			fmt.Fprintf(&builder, "firebase_app_id = %q\n", config.WorkspaceUIFirebaseAppID)
		}
		builder.WriteString("\n")
	}
	if config.LochoHostEnabled || config.LochoHostStateDir != "" {
		builder.WriteString("[locho-host]\n")
		if config.LochoHostEnabled {
			builder.WriteString("enabled = true\n")
		} else {
			builder.WriteString("enabled = false\n")
		}
		if config.LochoHostStateDir != "" {
			fmt.Fprintf(&builder, "state_dir = %q\n", config.LochoHostStateDir)
		}
		builder.WriteString("\n")
	}
	if config.LochoRelayConfigSource != "" || config.LochoRelaySecretsSource != "" {
		builder.WriteString("[locho]\n")
		if config.LochoRelayConfigSource != "" {
			fmt.Fprintf(&builder, "relay_config = %q\n", config.LochoRelayConfigSource)
		}
		if config.LochoRelaySecretsSource != "" {
			fmt.Fprintf(&builder, "relay_secrets = %q\n", config.LochoRelaySecretsSource)
		}
		builder.WriteString("\n")
	}
	if config.OpenWebUIHost != "" {
		fmt.Fprintf(&builder, "[open-webui]\nhost = %q\nport = %d\n", config.OpenWebUIHost, config.OpenWebUIPort)
		if config.OpenWebUIImage != "" && config.OpenWebUIImage != defaultOpenWebUIImage {
			fmt.Fprintf(&builder, "image = %q\n", config.OpenWebUIImage)
		}
		if !config.OpenWebUIAuth {
			builder.WriteString("auth = false\n")
		}
		if config.OpenWebUIAdminEmail != "" {
			fmt.Fprintf(&builder, "admin_email = %q\n", config.OpenWebUIAdminEmail)
		}
		if config.OpenWebUIAdminPasswordHash != "" {
			fmt.Fprintf(&builder, "admin_password_hash = %q\n", config.OpenWebUIAdminPasswordHash)
		}
		if config.OpenWebUIGoogleClientID != "" {
			fmt.Fprintf(&builder, "google_client_id = %q\n", config.OpenWebUIGoogleClientID)
		}
		if config.OpenWebUIGoogleClientSecret != "" {
			fmt.Fprintf(&builder, "google_client_secret = %q\n", config.OpenWebUIGoogleClientSecret)
		}
		if config.OpenWebUIURL != "" {
			fmt.Fprintf(&builder, "url = %q\n", config.OpenWebUIURL)
		}
		if len(config.OpenWebUIAllowedDomains) > 0 {
			builder.WriteString("allowed_domains = [")
			for i, domain := range config.OpenWebUIAllowedDomains {
				if i > 0 {
					builder.WriteString(", ")
				}
				fmt.Fprintf(&builder, "%q", domain)
			}
			builder.WriteString("]\n")
		}
		if len(config.OpenWebUIAllowedEmails) > 0 {
			builder.WriteString("allowed_emails = [")
			for i, email := range config.OpenWebUIAllowedEmails {
				if i > 0 {
					builder.WriteString(", ")
				}
				fmt.Fprintf(&builder, "%q", email)
			}
			builder.WriteString("]\n")
		}
		if config.OpenWebUIGoogleClientID != "" && config.OpenWebUIEnableOAuthSignup {
			builder.WriteString("enable_oauth_signup = true\n")
		}
		builder.WriteString("\n")
	}
	for _, fallback := range config.FallbackProviders {
		builder.WriteString("[[fallback_providers]]\n")
		fmt.Fprintf(&builder, "provider = %q\nmodel = %q\n", fallback.Provider, fallback.Model)
		if fallback.BaseURL != "" {
			fmt.Fprintf(&builder, "base_url = %q\n", fallback.BaseURL)
		}
		if fallback.KeyEnv != "" {
			fmt.Fprintf(&builder, "key_env = %q\n", fallback.KeyEnv)
		}
		builder.WriteString("\n")
	}
	fmt.Fprintf(&builder, "[release]\nsource = %q\n\n", config.ReleaseSource)
	fmt.Fprintf(&builder, "[components]\nhermes_image = %q\nhermes_tag = %q\nhermes_digest = %q\nlocho_image = %q\nlocho_version = %q\nlocho_x86_64_sha256 = %q\nlocho_arm64_sha256 = %q\n\n", config.HermesImage, config.HermesTag, config.HermesDigest, config.LochoImage, config.LochoVersion, config.LochoX8664SHA256, config.LochoARM64SHA256)
	fmt.Fprintf(&builder, "[api]\nenabled = %t\nhost = %q\n\n", config.APIEnabled, config.APIHost)
	fmt.Fprintf(&builder, "[secrets]\nsource = %q\n\n", config.SecretSource)
	if config.SkillsConfigured || !sameStrings(config.EnabledSkills, defaultSkills) {
		builder.WriteString("[skills]\nenabled = [")
		for index, skill := range config.EnabledSkills {
			if index > 0 {
				builder.WriteString(", ")
			}
			fmt.Fprintf(&builder, "%q", skill)
		}
		builder.WriteString("]\n")
	}
	fmt.Fprintf(&builder, "\n[ingestion]\nmax_concurrent_jobs = %d\n", config.IngestionMaxConcurrentJobs)
	fmt.Fprintf(&builder, "\n[workspace_git]\nenabled = %t\nschedule = %q\n", config.WorkspaceGitEnabled, config.WorkspaceGitSchedule)
	fmt.Fprintf(&builder, "\n[backup]\nschedule = %q\nschedule_enabled = %t\nlocal_retention = %d\nlocal_max_size = %q\nremote_retention_days = %d\n", config.BackupSchedule, config.BackupScheduleEnabled, config.BackupLocalRetention, formatBackupSize(config.BackupLocalMaxBytes), config.BackupRemoteRetentionDays)
	if config.BackupKnownHosts != "" {
		fmt.Fprintf(&builder, "known_hosts = %q\n", config.BackupKnownHosts)
	}
	if config.BackupIdentityFile != "" {
		fmt.Fprintf(&builder, "identity_file = %q\n", config.BackupIdentityFile)
	}
	if config.BackupRecipient != "" {
		fmt.Fprintf(&builder, "recipient = %q\n", config.BackupRecipient)
	}
	for _, destination := range config.BackupDestinations {
		builder.WriteString("\n[[backup.destinations]]\n")
		fmt.Fprintf(&builder, "name = %q\ntype = %q\n", destination.Name, destination.Type)
		if destination.Endpoint != "" {
			fmt.Fprintf(&builder, "endpoint = %q\n", destination.Endpoint)
		}
		if destination.Bucket != "" {
			fmt.Fprintf(&builder, "bucket = %q\n", destination.Bucket)
		}
		if destination.Prefix != "" {
			fmt.Fprintf(&builder, "prefix = %q\n", destination.Prefix)
		}
		if destination.Region != "" {
			fmt.Fprintf(&builder, "region = %q\n", destination.Region)
		}
		if destination.PathStyle {
			builder.WriteString("path_style = true\n")
		}
		if destination.RsyncTarget != "" {
			fmt.Fprintf(&builder, "rsync_target = %q\n", destination.RsyncTarget)
		}
		if destination.IdentityFile != "" {
			fmt.Fprintf(&builder, "identity_file = %q\n", destination.IdentityFile)
		}
		if destination.OperatorIdentityFile != "" {
			fmt.Fprintf(&builder, "operator_identity_file = %q\n", destination.OperatorIdentityFile)
		}
		if destination.ReaderCredentialsFile != "" {
			fmt.Fprintf(&builder, "reader_credentials_file = %q\n", destination.ReaderCredentialsFile)
		}
		if destination.ReaderAWSProfile != "" {
			fmt.Fprintf(&builder, "reader_aws_profile = %q\n", destination.ReaderAWSProfile)
		}
		if destination.WriterCredentialsFile != "" {
			fmt.Fprintf(&builder, "writer_credentials_file = %q\n", destination.WriterCredentialsFile)
		}
		if destination.WriterAWSProfile != "" {
			fmt.Fprintf(&builder, "writer_aws_profile = %q\n", destination.WriterAWSProfile)
		}
	}
	for _, host := range config.Services {
		builder.WriteString("\n[[services]]\n")
		if host.Source != "" {
			fmt.Fprintf(&builder, "source = %q\n", host.Source)
		}
		if host.Name != "" {
			fmt.Fprintf(&builder, "name = %q\n", host.Name)
		}
		keys := make([]string, 0, len(host.Roles))
		for k := range host.Roles {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(&builder, "%q = %q\n", k, host.Roles[k])
		}
	}
	return builder.String()
}

func expandTilde(path string) string {
	if strings.HasPrefix(path, "~/") || path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			if path == "~" {
				return home
			}
			return filepath.Join(home, path[2:])
		}
	}
	return path
}
