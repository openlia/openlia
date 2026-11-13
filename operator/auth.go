package operator

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

type ProviderStatus struct {
	Name               string `json:"name"`
	Configured         bool   `json:"configured"`
	Slots              int    `json:"slots"`
	EndpointConfigured bool   `json:"endpoint_configured"`
}

type AuthListResult struct {
	OK           bool             `json:"ok"`
	Providers    []ProviderStatus `json:"providers"`
	SecretValues string           `json:"secret_values"`
}

func ListAuth(config Config) (AuthListResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return AuthListResult{}, err
	}
	openAISlots, copilot, gateway, baseURL, err := providerInventory(config.SecretFile)
	if err != nil {
		return AuthListResult{}, err
	}
	gatewayEndpoint := hasGatewayProvider(config.FallbackProviders)
	return AuthListResult{OK: true, Providers: []ProviderStatus{
		{Name: "copilot", Configured: copilot, Slots: boolInt(copilot)},
		{Name: "openai-gateway", Configured: gatewayEndpoint, Slots: boolInt(gateway), EndpointConfigured: gatewayEndpoint},
		{Name: "openai-api", Configured: openAISlots > 0, Slots: openAISlots, EndpointConfigured: baseURL},
	}, SecretValues: "redacted"}, nil
}

func readSecretValue(path, wanted string) (string, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return "", os.ErrNotExist
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("protected secret file must be a regular mode-0600 file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read protected secret file: %w", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(strings.TrimSuffix(line, "\r"), "=")
		if ok && key == wanted {
			return value, nil
		}
	}
	return "", nil
}

func RotateAuth(config Config, source string, now time.Time, composers ...Compose) error {
	if len(composers) > 0 {
		return rotateAuthWithCompose(context.Background(), config, composers[0], source, now)
	}
	if err := config.ValidatePaths(); err != nil {
		return err
	}
	if err := validateExternalSource(config, source, "credential source"); err != nil {
		return err
	}
	if err := validateSecretFile(source); err != nil {
		return err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	if err := EnsureDir(config.RuntimeRoot, 0o700); err != nil {
		return err
	}
	if err := ensureSecretDirectory(config); err != nil {
		return err
	}
	if _, err := CreateRollback(config, "auth-rotate", now, runtimeRelativePath(config, config.SecretFile)); err != nil {
		return err
	}
	secretBackup := ""
	if info, err := os.Stat(config.SecretFile); err == nil && info.Mode().IsRegular() {
		secretBackup, err = backupFile(config, config.SecretFile, "auth-secret", 0o600, now)
		if err != nil {
			return err
		}
	}
	if err := AtomicCopyFile(source, config.SecretFile, 0o600); err != nil {
		return err
	}
	if err := ensureRuntimeOwner(config.SecretFile, config.RuntimeUID, config.RuntimeGID, 0o600); err != nil {
		return err
	}
	if config.APIEnabled || config.LochoHostEnabled {
		if err := ensureAPIServerEnv(config, config.SecretDir+"/api-server.env"); err != nil {
			return err
		}
	}
	return RecordChange(config, "auth-rotate", "ok", secretBackup, "provider credentials replaced atomically", now)
}

func rotateAuthWithCompose(ctx context.Context, config Config, compose Compose, source string, now time.Time) error {
	if err := config.ValidatePaths(); err != nil {
		return err
	}
	if err := validateExternalSource(config, source, "credential source"); err != nil {
		return err
	}
	if err := validateSecretFile(source); err != nil {
		return err
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	if err := EnsureDir(config.RuntimeRoot, 0o700); err != nil {
		return err
	}
	if err := ensureSecretDirectory(config); err != nil {
		return err
	}
	if _, err := CreateRollback(config, "auth-rotate", now, runtimeRelativePath(config, config.SecretFile)); err != nil {
		return err
	}
	secretBackup := ""
	secretPresent := false
	if info, err := os.Stat(config.SecretFile); err == nil && info.Mode().IsRegular() {
		secretPresent = true
		secretBackup, err = backupFile(config, config.SecretFile, "auth-secret", 0o600, now)
		if err != nil {
			return err
		}
	}
	previousState, err := ReadState(config)
	if err != nil {
		return err
	}
	if _, err := compose.Run(ctx, "stop", "hermes"); err != nil {
		_ = RecordChange(config, "auth-rotate", "failed", secretBackup, "Hermes stop failed", now)
		return fmt.Errorf("Hermes stop failed; credentials were not changed")
	}
	if err := AtomicCopyFile(source, config.SecretFile, 0o600); err != nil {
		if previousState == stateRunning {
			_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "hermes")
		}
		_ = RecordChange(config, "auth-rotate", "failed", secretBackup, "credential replacement failed", now)
		return fmt.Errorf("credential replacement failed")
	}
	if err := ensureRuntimeOwner(config.SecretFile, config.RuntimeUID, config.RuntimeGID, 0o600); err != nil {
		restoreSecret := func() {
			if secretBackup != "" {
				_ = AtomicCopyFile(secretBackup, config.SecretFile, 0o600)
				_ = ensureRuntimeOwner(config.SecretFile, config.RuntimeUID, config.RuntimeGID, 0o600)
			} else if !secretPresent {
				_ = os.Remove(config.SecretFile)
			}
		}
		restoreSecret()
		if previousState == stateRunning {
			_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "hermes")
		}
		return fmt.Errorf("credential permissions could not be prepared")
	}
	restoreSecret := func() {
		if secretBackup != "" {
			_ = AtomicCopyFile(secretBackup, config.SecretFile, 0o600)
			_ = ensureRuntimeOwner(config.SecretFile, config.RuntimeUID, config.RuntimeGID, 0o600)
		} else if !secretPresent {
			_ = os.Remove(config.SecretFile)
		}
	}
	if config.APIEnabled || config.LochoHostEnabled {
		if err := ensureAPIServerEnv(config, config.SecretDir+"/api-server.env"); err != nil {
			restoreSecret()
			if previousState == stateRunning {
				_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "hermes")
			}
			return err
		}
	}
	if previousState == stateRunning {
		if _, err := compose.Run(ctx, "up", "-d", "--no-deps", "--force-recreate", "hermes"); err != nil {
			restoreSecret()
			_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "--force-recreate", "hermes")
			_ = RecordChange(config, "auth-rotate", "failed", secretBackup, "Hermes restart failed; previous secret restored", now)
			return fmt.Errorf("Hermes restart failed; previous secret was restored")
		}
	} else if previousState == stateStopped {
		_, _ = compose.Run(ctx, "rm", "-f", "hermes")
		if err := WriteState(config, stateStopped); err != nil {
			return err
		}
	}
	return RecordChange(config, "auth-rotate", "ok", secretBackup, "provider credentials replaced atomically", now)
}

func providerInventory(path string) (openAISlots int, copilot, gateway, baseURL bool, err error) {
	data, readErr := os.ReadFile(path)
	if os.IsNotExist(readErr) {
		return 0, false, false, false, nil
	}
	if readErr != nil {
		return 0, false, false, false, readErr
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		key := strings.TrimSpace(strings.SplitN(line, "=", 2)[0])
		switch {
		case isOpenAIKeySlot(key):
			openAISlots++
		case key == "COPILOT_GITHUB_TOKEN":
			copilot = true
		case key == "OPENAI_GATEWAY_API_KEY":
			gateway = true
		case key == "OPENAI_BASE_URL":
			baseURL = true
		}
	}
	return openAISlots, copilot, gateway, baseURL, nil
}

func parseBaseURL(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if strings.HasPrefix(line, "#") {
			continue
		}
		if key, val, ok := strings.Cut(line, "="); ok && strings.TrimSpace(key) == "OPENAI_BASE_URL" {
			return strings.TrimSpace(val)
		}
	}
	return ""
}

func isOpenAIKeySlot(key string) bool {
	if key == "OPENAI_API_KEY" {
		return true
	}
	if !strings.HasPrefix(key, "OPENAI_API_KEY_") {
		return false
	}
	suffix := strings.TrimPrefix(key, "OPENAI_API_KEY_")
	if suffix == "" || suffix == "1" || suffix[0] == '0' {
		return false
	}
	for _, character := range suffix {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func validateSecretFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("credential source is not a readable file")
	}
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.Contains(line, "=") {
			return fmt.Errorf("credential source is not dotenv-shaped")
		}
		key, value, _ := strings.Cut(line, "=")
		if !validEnvKey(key) {
			return fmt.Errorf("credential source contains an invalid key name")
		}
		if protectedEnvKey(key) {
			return fmt.Errorf("credential source contains a protected environment key")
		}
		if value == "" {
			return fmt.Errorf("credential source contains an empty value")
		}
		if key == "COPILOT_GITHUB_TOKEN" && !strings.HasPrefix(value, "gho_") && !strings.HasPrefix(value, "github_pat_") && !strings.HasPrefix(value, "ghu_") {
			return fmt.Errorf("COPILOT_GITHUB_TOKEN must use a supported OAuth, fine-grained, or GitHub App token")
		}
		count++
	}
	if count == 0 {
		return fmt.Errorf("credential source contains no credentials")
	}
	return nil
}

func validEnvKey(value string) bool {
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

func protectedEnvKey(key string) bool {
	for _, item := range []string{"BASH_ENV", "ENV", "LD_PRELOAD", "LD_LIBRARY_PATH", "PATH", "PYTHONPATH", "NODE_OPTIONS", "SHELL", "HERMES_HOME", "HERMES_ENV", "HERMES_CONFIG", "HERMES_TIMEZONE", "HERMES_YOLO_MODE", "HERMES_INTERACTIVE"} {
		if key == item {
			return true
		}
	}
	return false
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func hasGatewayProvider(providers []FallbackProviderConfig) bool {
	for _, provider := range providers {
		if provider.Provider == "custom" {
			return true
		}
	}
	return false
}
