package operator

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"openlia/internal/releaseinfo"
)

func testConfig(repo, runtime string) Config {
	return Config{
		RepositoryRoot:    repo,
		RuntimeRoot:       runtime,
		InstallRoot:       filepath.Dir(runtime),
		ProjectName:       "test-project",
		NetworkName:       "test-project-private",
		ComposeFile:       filepath.Join(repo, "docker", "compose.yaml"),
		ComposeProjectDir: filepath.Join(repo, "docker"),
		GeneratedCompose:  filepath.Join(repo, "docker", "compose.generated.yaml"),
		DataRoot:          filepath.Join(runtime, "hermes"),
		LochoRoot:         filepath.Join(runtime, "locho"),
		LochoVersion:      releaseinfo.Default.Locho.Version,
		LochoX8664SHA256:  releaseinfo.Default.Locho.LinuxX8664SHA,
		LochoARM64SHA256:  releaseinfo.Default.Locho.LinuxARM64SHA,
		SecretDir:         filepath.Join(runtime, "secrets"),
		SecretFile:        filepath.Join(runtime, "secrets", "hermes.env"),
		BackupRoot:        filepath.Join(runtime, "backups"),
		MetaRoot:          filepath.Join(runtime, "meta"),
		StateFile:         filepath.Join(runtime, "meta", "stack-state"),
		APIHost:           "127.0.0.1",
		OutputLanguage:    "en",
		RuntimeUID:        os.Getuid(),
		RuntimeGID:        os.Getgid(),
	}
}

func TestConfigValidatePaths(t *testing.T) {
	repo := t.TempDir()
	runtimeParent := t.TempDir()
	config := testConfig(repo, filepath.Join(runtimeParent, "runtime"))
	if err := config.ValidatePaths(); err != nil {
		t.Fatalf("valid paths rejected: %v", err)
	}

	tests := []struct {
		name  string
		edit  func(*Config)
		match string
	}{
		{"relative runtime", func(c *Config) { c.RuntimeRoot = "runtime" }, "runtime-root must be absolute"},
		{"unsafe runtime component", func(c *Config) { c.RuntimeRoot = filepath.Join(runtimeParent, "runtime") + "/../other" }, "unsafe path component"},
		{"repository runtime", func(c *Config) { c.RuntimeRoot = filepath.Join(repo, "runtime") }, "must not be inside the repository"},
		{"broad runtime", func(c *Config) { c.RuntimeRoot = "/tmp" }, "runtime-root is too broad"},
		{"unsafe project", func(c *Config) { c.ProjectName = "../project" }, "invalid project-name"},
		{"local compose", func(c *Config) { c.ComposeFile = filepath.Join(repo, "local", "compose.yaml") }, "compose files must not be under local"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := config
			test.edit(&candidate)
			if err := candidate.ValidatePaths(); err == nil || !strings.Contains(err.Error(), test.match) {
				t.Fatalf("ValidatePaths() error = %v, want %q", err, test.match)
			}
		})
	}
}

func TestConfigValidatesLochoRelayPaths(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	config.LochoRelayConfig = filepath.Join(config.RuntimeRoot, "locho", "relay.toml")
	config.LochoRelaySecrets = filepath.Join(config.RuntimeRoot, "secrets", "locho-relay.env")
	if err := config.ValidatePaths(); err != nil {
		t.Fatalf("valid relay paths rejected: %v", err)
	}
	config.LochoRelaySecrets = filepath.Join(config.RuntimeRoot, "relay.env")
	config.LochoRelayConfig = ""
	if err := config.ValidatePaths(); err == nil || !strings.Contains(err.Error(), "relay secrets require") {
		t.Fatalf("relay secrets without config error = %v", err)
	}
}

func TestConfigRejectsRsyncIdentityMountedIntoHermes(t *testing.T) {
	repo := t.TempDir()
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	config := testConfig(repo, runtimeRoot)
	config.BackupDestinations = []BackupDestination{{
		Name:         "nas",
		Type:         "rsync",
		RsyncTarget:  "backup@nas.example.test:/srv/openlia",
		IdentityFile: filepath.Join(runtimeRoot, "secrets", "rsync-key"),
	}}
	if err := config.ValidatePaths(); err == nil || !strings.Contains(err.Error(), "must not be inside Hermes data or mounted runtime secrets") {
		t.Fatalf("ValidatePaths() error = %v, want mounted credential rejection", err)
	}
}

func TestLoadConfigFromEnv(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	releaseDigest := strings.Repeat("c", 64)
	if err := os.WriteFile(filepath.Join(repo, "release.sha256"), []byte(releaseDigest+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfigFromEnv(map[string]string{
		"OPENLIA_REPO_ROOT":                    repo,
		"OPENLIA_RUNTIME_ROOT":                 runtime,
		"OPENLIA_PROJECT_NAME":                 "example",
		"OPENLIA_PROVIDER":                     "copilot",
		"OPENLIA_OUTPUT_LANGUAGE":              "vi",
		"OPENLIA_FALLBACK_PROVIDERS":           `[{"provider":"custom","model":"gateway-model","base_url":"https://gateway.example.test/v1","key_env":"OPENAI_GATEWAY_API_KEY"},{"provider":"openai-api","model":"official-model"}]`,
		"OPENLIA_LOCAL_MODE":                   "true",
		"OPENLIA_BACKUP_RETENTION":             "4",
		"OPENLIA_BACKUP_MAX_BYTES":             "123456789",
		"OPENLIA_BACKUP_REMOTE_RETENTION_DAYS": "17",
		"OPENLIA_LOCHO_VERSION":                releaseinfo.Default.Locho.Version,
		"OPENLIA_LOCHO_X86_64_SHA256":          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"OPENLIA_LOCHO_ARM64_SHA256":           "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !config.LocalMode || config.OutputLanguage != "vi" || config.OpenLiaReleaseSHA256 != releaseDigest || config.LochoX8664SHA256 != strings.Repeat("a", 64) || config.LochoARM64SHA256 != strings.Repeat("b", 64) || config.BackupRetention != 4 || config.BackupMaxBytes != 123456789 || config.BackupRemoteRetentionDays != 17 || config.NetworkName != "example-private" || config.Provider != "copilot" || len(config.FallbackProviders) != 2 || config.FallbackProviders[0].BaseURL != "https://gateway.example.test/v1" || config.FallbackProviders[1].Model != "official-model" {
		t.Fatalf("unexpected typed config: %+v", config)
	}
	wantImage := releaseinfo.InternalImage("openlia-hermes", releaseinfo.Default.Hermes.Tag)
	if config.HermesImage != wantImage {
		t.Fatalf("managed Hermes image = %q, want %q", config.HermesImage, wantImage)
	}
}

func TestLoadConfigFromEnvRequiresRuntimeRoot(t *testing.T) {
	_, err := LoadConfigFromEnv(map[string]string{"OPENLIA_REPO_ROOT": t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "OPENLIA_RUNTIME_ROOT is required") {
		t.Fatalf("missing runtime root error = %v", err)
	}
}

func TestLoadConfigFromEnvRejectsRemoteRetentionDurationOverflow(t *testing.T) {
	_, err := LoadConfigFromEnv(map[string]string{
		"OPENLIA_REPO_ROOT":                    t.TempDir(),
		"OPENLIA_RUNTIME_ROOT":                 filepath.Join(t.TempDir(), "runtime"),
		"OPENLIA_BACKUP_REMOTE_RETENTION_DAYS": strconv.FormatInt(maxBackupRemoteRetentionDays+1, 10),
	})
	if err == nil || !strings.Contains(err.Error(), "OPENLIA_BACKUP_REMOTE_RETENTION_DAYS") {
		t.Fatalf("overflowing remote retention error = %v", err)
	}
}

func TestLoadConfigFromEnvUsesRuntimeIdentity(t *testing.T) {
	config, err := LoadConfigFromEnv(map[string]string{
		"OPENLIA_REPO_ROOT":    t.TempDir(),
		"OPENLIA_RUNTIME_ROOT": filepath.Join(t.TempDir(), "runtime"),
		"OPENLIA_LOCAL_MODE":   "false",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.RuntimeUID != 10000 || config.RuntimeGID != 10000 {
		t.Fatalf("remote runtime identity = %d:%d, want 10000:10000", config.RuntimeUID, config.RuntimeGID)
	}

	config, err = LoadConfigFromEnv(map[string]string{
		"OPENLIA_REPO_ROOT":    t.TempDir(),
		"OPENLIA_RUNTIME_ROOT": filepath.Join(t.TempDir(), "runtime"),
		"OPENLIA_LOCAL_MODE":   "true",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.RuntimeUID != os.Getuid() || config.RuntimeGID != os.Getgid() {
		t.Fatalf("local runtime identity = %d:%d, want %d:%d", config.RuntimeUID, config.RuntimeGID, os.Getuid(), os.Getgid())
	}
}

func TestLoadConfigFromEnvConfiguresLochoHostState(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	config, err := LoadConfigFromEnv(map[string]string{
		"OPENLIA_REPO_ROOT":          repo,
		"OPENLIA_RUNTIME_ROOT":       runtime,
		"OPENLIA_LOCAL_MODE":         "true",
		"OPENLIA_LOCHO_HOST_ENABLED": "true",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !config.LochoHostEnabled || config.LochoHostRoot != filepath.Join(runtime, "locho-host") || config.LochoHostConfig != filepath.Join(runtime, "locho-host", "locho.toml") || config.LochoHostStateRoot != filepath.Join(runtime, "locho-host", "state") {
		t.Fatalf("unexpected Locho host config: %+v", config)
	}
	if err := config.ValidatePaths(); err != nil {
		t.Fatalf("valid Locho host paths rejected: %v", err)
	}
}

func TestLoadConfigFromEnvRejectsInvalidRuntimeIdentity(t *testing.T) {
	_, err := LoadConfigFromEnv(map[string]string{
		"OPENLIA_REPO_ROOT":    t.TempDir(),
		"OPENLIA_RUNTIME_ROOT": filepath.Join(t.TempDir(), "runtime"),
		"OPENLIA_RUNTIME_UID":  "not-a-number",
	})
	if err == nil || !strings.Contains(err.Error(), "OPENLIA_RUNTIME_UID") {
		t.Fatalf("invalid runtime identity error = %v", err)
	}
}

func TestLoadConfigFromEnvRejectsInvalidOutputLanguage(t *testing.T) {
	_, err := LoadConfigFromEnv(map[string]string{
		"OPENLIA_REPO_ROOT":       t.TempDir(),
		"OPENLIA_RUNTIME_ROOT":    filepath.Join(t.TempDir(), "runtime"),
		"OPENLIA_OUTPUT_LANGUAGE": "en_US",
	})
	if err == nil || !strings.Contains(err.Error(), "OPENLIA_OUTPUT_LANGUAGE") {
		t.Fatalf("invalid output language error = %v", err)
	}
}
