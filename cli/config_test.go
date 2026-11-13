package cli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"filippo.io/age"
)

func TestConfigRoundTrip(t *testing.T) {
	temporary := t.TempDir()
	path := filepath.Join(temporary, "config.toml")
	t.Setenv("OPENLIA_CONFIG", path)
	want := defaultConfig()
	want.Target = "operator@example.test"
	want.LochoRelayConfigSource = filepath.Join(temporary, "relay.toml")
	want.LochoRelaySecretsSource = filepath.Join(temporary, "relay.env")
	want.Model = "test-model"
	want.OutputLanguage = "vi"
	want.FallbackProviders = []FallbackProviderConfig{
		{Provider: "custom", Model: "gateway-model", BaseURL: "https://gateway.example.test/v1", KeyEnv: "OPENAI_GATEWAY_API_KEY"},
		{Provider: "openai-api", Model: "official-model"},
	}
	want.Timezone = "Asia/Tokyo"
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	want.BackupIdentityFile = filepath.Join(temporary, "backup-identity.txt")
	want.BackupKnownHosts = filepath.Join(temporary, "known_hosts")
	want.BackupRecipient = identity.Recipient().String()
	want.BackupSchedule = "15 3 * * 1,3,5"
	want.BackupScheduleEnabled = true
	want.BackupLocalRetention = 4
	want.BackupLocalMaxBytes = 123456789
	want.BackupRemoteRetentionDays = 17
	want.BackupDestinations = []BackupDestinationConfig{
		{Name: "archive", Type: "s3", Endpoint: "https://s3.example.test", Bucket: "openlia-backups", Prefix: "personal", Region: "us-east-1", PathStyle: true, ReaderCredentialsFile: filepath.Join(temporary, "reader-credentials"), ReaderAWSProfile: "reader", WriterCredentialsFile: filepath.Join(temporary, "writer-credentials"), WriterAWSProfile: "writer"},
		{Name: "nas", Type: "rsync", RsyncTarget: "backup@nas.example.test:/srv/backups/openlia", IdentityFile: "/srv/openlia/backup-ssh-key", OperatorIdentityFile: filepath.Join(temporary, "rsync-key")},
	}
	want.SecretSource = filepath.Join(temporary, "hermes.env")
	want.OpenLiaBrowser = OpenLiaBrowserConfig{
		Configured:         true,
		Mode:               "ssh",
		Target:             "browser@example.test",
		SSHPort:            2222,
		Root:               "/home/browser/services/openlia-browser",
		ExtensionTokenFile: "/home/browser/services/playwright-server-token.txt",
	}
	if err := saveConfig(want); err != nil {
		t.Fatal(err)
	}
	got, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.Target != want.Target || got.Model != want.Model || got.OutputLanguage != want.OutputLanguage || got.LochoRelayConfigSource != want.LochoRelayConfigSource || got.LochoRelaySecretsSource != want.LochoRelaySecretsSource || len(got.FallbackProviders) != 2 || got.FallbackProviders[0] != want.FallbackProviders[0] || got.FallbackProviders[1] != want.FallbackProviders[1] || got.Timezone != want.Timezone || got.SecretSource != want.SecretSource || got.BackupIdentityFile != want.BackupIdentityFile || got.BackupKnownHosts != want.BackupKnownHosts || got.BackupRecipient != want.BackupRecipient || got.BackupSchedule != want.BackupSchedule || got.BackupScheduleEnabled != want.BackupScheduleEnabled || len(got.BackupDestinations) != len(want.BackupDestinations) || got.BackupDestinations[0] != want.BackupDestinations[0] || got.BackupDestinations[1] != want.BackupDestinations[1] || got.OpenLiaBrowser != want.OpenLiaBrowser {
		t.Fatalf("round trip mismatch: got %#v want %#v", got, want)
	}
	if got.BackupLocalRetention != want.BackupLocalRetention || got.BackupLocalMaxBytes != want.BackupLocalMaxBytes || got.BackupRemoteRetentionDays != want.BackupRemoteRetentionDays {
		t.Fatalf("backup retention round trip mismatch: got %#v want %#v", got, want)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode is %o, want 600", info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `local_max_size = "123456789 B"`) || strings.Contains(string(data), "local_max_bytes") {
		t.Fatalf("rendered config does not use human-readable local size: %s", data)
	}
}

func TestBackupSizeConfigUsesHumanReadableUnits(t *testing.T) {
	config, err := parseConfig("[backup]\nlocal_max_size = \"10 GiB\"\n")
	if err != nil {
		t.Fatal(err)
	}
	if config.BackupLocalMaxBytes != 10<<30 {
		t.Fatalf("10 GiB parsed as %d bytes", config.BackupLocalMaxBytes)
	}

	config, err = parseConfig("[backup]\nlocal_max_size = \"1.5 GB\"\n")
	if err != nil {
		t.Fatal(err)
	}
	if config.BackupLocalMaxBytes != 1500000000 {
		t.Fatalf("1.5 GB parsed as %d bytes", config.BackupLocalMaxBytes)
	}
}

func TestBackupSizeConfigRejectsAmbiguousAndLegacyRemoteSettings(t *testing.T) {
	_, err := parseConfig("[backup]\nlocal_max_bytes = 10737418240\nlocal_max_size = \"10 GiB\"\n")
	if err == nil || !strings.Contains(err.Error(), "cannot set both") {
		t.Fatalf("ambiguous local size error = %v", err)
	}
	_, err = parseConfig("[backup]\nremote_retention = 30\n")
	if err == nil || !strings.Contains(err.Error(), "unknown setting") {
		t.Fatalf("legacy remote retention error = %v", err)
	}
}

func TestBackupRemoteRetentionRejectsDurationOverflow(t *testing.T) {
	config := defaultConfig()
	config.BackupRemoteRetentionDays = int(maxBackupRemoteRetentionDays + 1)
	if err := validateConfig(config); err == nil || !strings.Contains(err.Error(), "remote_retention_days") {
		t.Fatalf("overflowing remote retention error = %v", err)
	}
}

func TestOpenLiaBrowserConfigValidation(t *testing.T) {
	valid := defaultConfig()
	valid.OpenLiaBrowser = OpenLiaBrowserConfig{Configured: true, Mode: "local", SSHPort: 22, Root: "/Users/test/services/openlia-browser", ExtensionTokenFile: "/Users/test/services/playwright-server-token.txt"}
	if err := validateConfig(valid); err != nil {
		t.Fatalf("valid local openlia-browser config rejected: %v", err)
	}
	valid.OpenLiaBrowser = OpenLiaBrowserConfig{Configured: true, Mode: "ssh", Target: "user@example.test", SSHPort: 2222, Root: "/home/user/services/openlia-browser", ExtensionTokenFile: "/home/user/services/playwright-server-token.txt"}
	if err := validateConfig(valid); err != nil {
		t.Fatalf("valid ssh openlia-browser config rejected: %v", err)
	}
	for _, config := range []OpenLiaBrowserConfig{
		{Configured: true, Mode: "remote", Root: "/Users/test/services/openlia-browser", ExtensionTokenFile: "/Users/test/services/playwright-server-token.txt"},
		{Configured: true, Mode: "local", Target: "user@example.test", Root: "/Users/test/services/openlia-browser", ExtensionTokenFile: "/Users/test/services/playwright-server-token.txt"},
		{Configured: true, Mode: "ssh", Root: "/home/user/services/openlia-browser", ExtensionTokenFile: "/home/user/services/playwright-server-token.txt"},
		{Configured: true, Mode: "ssh", Target: "user@example.test", SSHPort: 0, Root: "/home/user/services/openlia-browser", ExtensionTokenFile: "/home/user/services/playwright-server-token.txt"},
		{Configured: true, Mode: "ssh", Target: "example.test", Root: "/home/user/services/openlia-browser", ExtensionTokenFile: "/home/user/services/playwright-server-token.txt"},
		{Configured: true, Mode: "local", Root: "~/services/openlia-browser", ExtensionTokenFile: "/Users/test/services/playwright-server-token.txt"},
	} {
		candidate := defaultConfig()
		candidate.OpenLiaBrowser = config
		if err := validateConfig(candidate); err == nil {
			t.Fatalf("invalid openlia-browser config accepted: %#v", config)
		}
	}
}

func TestOpenLiaBrowserConfigAbsentFromLegacyConfig(t *testing.T) {
	config, err := parseConfig("[openlia]\nschema = 2\n")
	if err != nil {
		t.Fatal(err)
	}
	if config.OpenLiaBrowser.Configured {
		t.Fatal("legacy config unexpectedly configured openlia-browser")
	}
	if strings.Contains(renderConfig(config), "[openlia-browser]") {
		t.Fatal("legacy config unexpectedly rendered openlia-browser")
	}
}

func TestConfigRejectsInvalidFallbackProvider(t *testing.T) {
	for _, endpoint := range []string{
		"gateway.example.test/v1",
		"https://user:pass@gateway.example.test/v1",
		"https://gateway.example.test/v1?token=secret",
		"https://gateway.example.test/v1#fragment",
	} {
		config := defaultConfig()
		config.FallbackProviders = []FallbackProviderConfig{{Provider: "custom", Model: "gateway", BaseURL: endpoint}}
		if err := validateConfig(config); err == nil {
			t.Fatalf("gateway URL %q was accepted", endpoint)
		}
	}
	config := defaultConfig()
	config.FallbackProviders = []FallbackProviderConfig{{Provider: "custom", Model: "gateway"}}
	if err := validateConfig(config); err == nil {
		t.Fatal("custom fallback without base URL was accepted")
	}
}

func TestConfigAcceptsFallbackProviders(t *testing.T) {
	config := defaultConfig()
	config.FallbackProviders = []FallbackProviderConfig{
		{Provider: "custom", Model: "gateway", BaseURL: "http://gateway.example.test:8080/v1"},
		{Provider: "openai-api", Model: "official"},
	}
	if err := validateConfig(config); err != nil {
		t.Fatalf("valid gateway URL was rejected: %v", err)
	}
}

func TestConfigDefaultsTimezoneForMinimalConfig(t *testing.T) {
	got, err := parseConfig("[openlia]\nschema = 2\n")
	if err != nil {
		t.Fatal(err)
	}
	if got.Timezone != defaultTimezone {
		t.Fatalf("timezone = %q, want %q", got.Timezone, defaultTimezone)
	}
	if got.OutputLanguage != defaultOutputLanguage {
		t.Fatalf("output language = %q, want %q", got.OutputLanguage, defaultOutputLanguage)
	}
}

func TestConfigRejectsInvalidOutputLanguage(t *testing.T) {
	for _, language := range []string{"", "e", "en_US", "en space", "../vi", "en--US", "en-"} {
		config := defaultConfig()
		config.OutputLanguage = language
		if err := validateConfig(config); err == nil {
			t.Fatalf("output language %q was accepted", language)
		}
	}
	for _, language := range []string{"en", "vi", "pt-BR", "zh-Hans-CN"} {
		config := defaultConfig()
		config.OutputLanguage = language
		if err := validateConfig(config); err != nil {
			t.Fatalf("valid output language %q was rejected: %v", language, err)
		}
	}
}

func TestLochoHostConfigRoundTrip(t *testing.T) {
	config := defaultConfig()
	config.LochoHostEnabled = true
	if err := validateConfig(config); err != nil {
		t.Fatalf("valid Locho host config was rejected: %v", err)
	}
	parsed, err := parseConfig(renderConfig(config))
	if err != nil {
		t.Fatal(err)
	}
	if !parsed.LochoHostEnabled || parsed.LochoX8664SHA256 != config.LochoX8664SHA256 || parsed.LochoARM64SHA256 != config.LochoARM64SHA256 {
		t.Fatalf("Locho host config did not round trip: %#v", parsed)
	}
}

func TestLocalConfigRoundTrip(t *testing.T) {
	temporary := t.TempDir()
	path := filepath.Join(temporary, "config.toml")
	t.Setenv("OPENLIA_CONFIG", path)
	want := defaultConfig()
	want.Mode = "local"
	want.Target = ""
	want.InstallRoot = filepath.Join(temporary, "runtime")
	if err := saveConfig(want); err != nil {
		t.Fatal(err)
	}
	got, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != "local" || got.Target != "" || got.InstallRoot != want.InstallRoot {
		t.Fatalf("local config mismatch: got %#v want %#v", got, want)
	}
}

func TestLegacyRemoteRootConfigIsReadable(t *testing.T) {
	got, err := parseConfig("[openlia]\nschema = 2\nremote_root = \"/srv/openlia-test\"\n")
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != "ssh" || got.InstallRoot != "/srv/openlia-test" {
		t.Fatalf("legacy config mismatch: got %#v", got)
	}
}

func TestConfigRejectsInvalidTimezone(t *testing.T) {
	for _, timezone := range []string{"", "Local", "../UTC", "Mars/Olympus", "Asia/Ho Chi Minh"} {
		config := defaultConfig()
		config.Timezone = timezone
		if err := validateConfig(config); err == nil {
			t.Fatalf("timezone %q was accepted", timezone)
		}
	}

	config := defaultConfig()
	config.Timezone = "America/New_York"
	if err := validateConfig(config); err != nil {
		t.Fatalf("valid timezone was rejected: %v", err)
	}
}

func TestMissingConfigReturnsDefaultAndSentinel(t *testing.T) {
	t.Setenv("OPENLIA_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	got, err := loadConfig()
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("error = %v, want not-exist", err)
	}
	if got.Version != defaultVersion {
		t.Fatalf("unexpected default config: %#v", got)
	}
}

func TestConfigRejectsUnsafeTargetAndRoot(t *testing.T) {
	config := defaultConfig()
	config.Target = "user@host;rm -rf /"
	if err := validateConfig(config); err == nil {
		t.Fatal("unsafe target was accepted")
	}
	config = defaultConfig()
	config.InstallRoot = "/srv"
	if err := validateConfig(config); err == nil {
		t.Fatal("broad installation root was accepted")
	}
}

func TestLocalConfigRejectsTarget(t *testing.T) {
	config := defaultConfig()
	config.Mode = "local"
	config.Target = "operator@example.test"
	if err := validateConfig(config); err == nil {
		t.Fatal("local config accepted an SSH target")
	}
}

func TestConfigRejectsRelativeSecretSource(t *testing.T) {
	config := defaultConfig()
	config.SecretSource = "hermes.env"
	if err := validateConfig(config); err == nil {
		t.Fatal("relative secret source was accepted")
	}
}

func TestConfigRejectsRetiredSettings(t *testing.T) {
	for _, text := range []string{
		"[openlia]\nschema = 2\n\n[workspace-ui]\nhost = \"127.0.0.1\"\n",
		"[openlia]\nschema = 2\n\n[workspace_git]\nenabled = true\n",
		"[openlia]\nschema = 2\n\n[templates]\nrepo = \"openlia/minions\"\n",
		"[openlia]\nschema = 2\n\n[skills]\nenabled = [\"calendar\"]\n",
	} {
		if _, err := parseConfig(text); err == nil {
			t.Fatalf("retired config was accepted:\n%s", text)
		}
	}
}

func TestProtectedSourcePathRequiresMode600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hermes.env")
	if err := os.WriteFile(path, []byte("OPENAI_API_KEY=test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateProtectedSourcePath(path, "secret source"); err != nil {
		t.Fatalf("valid protected source was rejected: %v", err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := validateProtectedSourcePath(path, "secret source"); err == nil {
		t.Fatal("insecure secret source was accepted")
	}
}

func TestConfigServicesRoundTrip(t *testing.T) {
	temporary := t.TempDir()
	sourcePath := filepath.Join(temporary, "locho-attachments.toml")
	if err := os.WriteFile(sourcePath, []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(temporary, "config.toml")
	t.Setenv("OPENLIA_CONFIG", path)
	want := defaultConfig()
	want.Services = []ServiceHostConfig{
		{
			Name:   "m1pro",
			Source: sourcePath,
			Roles: map[string]string{
				"openlia-browser": RoleOpenLiaBrowser,
				"genai":           RoleOpenAIGateway,
			},
		},
	}
	if err := saveConfig(want); err != nil {
		t.Fatal(err)
	}
	got, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Services) != 1 {
		t.Fatalf("expected 1 service host, got %d", len(got.Services))
	}
	host := got.Services[0]
	if host.Name != "m1pro" || host.Source != sourcePath || len(host.Roles) != 2 || host.Roles["openlia-browser"] != RoleOpenLiaBrowser || host.Roles["genai"] != RoleOpenAIGateway {
		t.Fatalf("services round-trip mismatch: got %#v want %#v", host, want.Services[0])
	}
}

func TestConfigServicesMultiHostRoundTrip(t *testing.T) {
	temporary := t.TempDir()
	source1 := filepath.Join(temporary, "host1.toml")
	source2 := filepath.Join(temporary, "host2.toml")
	_ = os.WriteFile(source1, []byte("h1"), 0o600)
	_ = os.WriteFile(source2, []byte("h2"), 0o600)
	path := filepath.Join(temporary, "config.toml")
	t.Setenv("OPENLIA_CONFIG", path)
	want := defaultConfig()
	want.Services = []ServiceHostConfig{
		{
			Name:   "m1pro",
			Source: source1,
			Roles: map[string]string{
				"openlia-browser": RoleOpenLiaBrowser,
			},
		},
		{
			Name:   "gpu-server",
			Source: source2,
			Roles: map[string]string{
				"vllm": RoleOpenAIGateway,
			},
		},
	}
	if err := saveConfig(want); err != nil {
		t.Fatal(err)
	}
	got, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Services) != 2 {
		t.Fatalf("expected 2 service hosts, got %d", len(got.Services))
	}
	if got.Services[0].Name != "m1pro" || got.Services[1].Name != "gpu-server" {
		t.Fatalf("unexpected hosts: got %#v", got.Services)
	}
}

func TestConfigServicesRejectsInvalidRole(t *testing.T) {
	for _, invalid := range []string{"generic", "image-generator", "unassigned", "custom", "openai-endpoint", ""} {
		config := defaultConfig()
		config.Services = []ServiceHostConfig{
			{
				Name: "laptop",
				Roles: map[string]string{
					"svc": invalid,
				},
			},
		}
		if err := validateConfig(config); err == nil {
			t.Fatalf("invalid service role %q was accepted", invalid)
		}
	}
}

func TestConfigServicesRejectsDottedKey(t *testing.T) {
	data := `
[openlia]
schema = 2
version = "0.1.0"
mode = "local"
root = ".openlia"
project = "openlia"
model = "gpt-5.6-luna"
timezone = "UTC"
provider = "openai-api"

[[services]]
name = "m1pro"
"m1pro.genai" = "openai-gateway"
`
	_, err := parseConfig(data)
	if err == nil {
		t.Fatal("expected error on dotted service key, got nil")
	}
}

func TestConfigServicesRejectsDuplicateHost(t *testing.T) {
	config := defaultConfig()
	config.Services = []ServiceHostConfig{
		{Name: "m1pro"},
		{Name: "m1pro"},
	}
	if err := validateConfig(config); err == nil {
		t.Fatal("expected error on duplicate host name, got nil")
	}
}

func TestDevelopmentOverridesAllowExperimentalComponentPins(t *testing.T) {
	config := defaultConfig()
	config.HermesTag = "v0.23.0-rc.1"
	config.HermesDigest = "sha256:" + strings.Repeat("a", 64)
	if err := validateConfig(config); err != nil {
		t.Fatalf("experimental development overrides rejected: %v", err)
	}
}

func TestLochoHostStateDirConfigRoundTripAndValidation(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "locho-host")
	config := defaultConfig()
	config.LochoHostEnabled = true
	config.LochoHostStateDir = stateDir

	rendered := renderConfig(config)
	if !strings.Contains(rendered, "state_dir = ") {
		t.Fatalf("rendered config missing state_dir:\n%s", rendered)
	}
	parsed, err := parseConfig(rendered)
	if err != nil {
		t.Fatalf("parseConfig failed: %v", err)
	}
	if parsed.LochoHostStateDir != stateDir {
		t.Fatalf("parsed LochoHostStateDir = %q, want %q", parsed.LochoHostStateDir, stateDir)
	}

	config.LochoHostStateDir = "relative/path"
	if err := validateConfig(config); err == nil {
		t.Fatal("expected error for relative locho-host.state_dir")
	}
}

func TestCustomInitConfigParsesAndRendersDocs(t *testing.T) {
	dir := t.TempDir()
	agentsFile := filepath.Join(dir, "custom-agents.md")
	if err := os.WriteFile(agentsFile, []byte("# Custom Agents\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	initTOML := `
[soul.md]
append = """
## Custom Tone
Always reply concisely.
"""

[agents.md]
file = "custom-agents.md"
append = "Follow repo rules."
`
	cfg, err := parseCustomInitConfig(initTOML, dir)
	if err != nil {
		t.Fatalf("parseCustomInitConfig failed: %v", err)
	}
	assets := fstest.MapFS{
		"profile/SOUL.md":   &fstest.MapFile{Data: []byte("# Base Soul\n")},
		"profile/AGENTS.md": &fstest.MapFile{Data: []byte("# Base Agents\n")},
	}
	soulBytes, ok, err := renderCustomDoc(assets, "profile/SOUL.md", cfg.SoulMD)
	if err != nil || !ok {
		t.Fatalf("renderCustomDoc SOUL.md failed: ok=%v err=%v", ok, err)
	}
	if !strings.Contains(string(soulBytes), "# Base Soul") || !strings.Contains(string(soulBytes), "Always reply concisely.") {
		t.Fatalf("rendered SOUL.md = %q", soulBytes)
	}
	agentsBytes, ok, err := renderCustomDoc(assets, "profile/AGENTS.md", cfg.AgentsMD)
	if err != nil || !ok {
		t.Fatalf("renderCustomDoc AGENTS.md failed: ok=%v err=%v", ok, err)
	}
	if !strings.Contains(string(agentsBytes), "# Custom Agents") || !strings.Contains(string(agentsBytes), "Follow repo rules.") {
		t.Fatalf("rendered AGENTS.md = %q", agentsBytes)
	}
}
