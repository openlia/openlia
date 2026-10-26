package cli

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const lochoHostStateSchemaVersion = 2

type lochoPersistedHostState struct {
	SchemaVersion  int               `json:"schema_version"`
	EndpointID     string            `json:"endpoint_id"`
	AttachSecret   string            `json:"attach_secret"`
	ServiceSecrets map[string]string `json:"service_secrets"`
}

func defaultLochoHostStateDir() string {
	return filepath.Join(filepath.Dir(configPath()), "locho-host")
}

func ensureLochoHostState(ctx context.Context, deployment deployment, config *Config) error {
	if !config.LochoHostEnabled {
		return nil
	}
	if config.LochoHostStateDir == "" {
		config.LochoHostStateDir = defaultLochoHostStateDir()
	}
	if !filepath.IsAbs(config.LochoHostStateDir) {
		abs, err := filepath.Abs(config.LochoHostStateDir)
		if err != nil {
			return err
		}
		config.LochoHostStateDir = abs
	}
	if err := validateAbsoluteRoot(config.LochoHostStateDir, "locho-host.state_dir"); err != nil {
		return err
	}
	if isInsideWorkingTree(config.LochoHostStateDir) {
		return errors.New("locho-host.state_dir must be outside the OpenLia checkout")
	}

	keyPath := filepath.Join(config.LochoHostStateDir, "host.key")
	statePath := filepath.Join(config.LochoHostStateDir, "host_state.json")

	_, keyErr := os.Stat(keyPath)
	_, stateErr := os.Stat(statePath)

	if keyErr == nil && stateErr == nil {
		return validateLochoHostStateDir(config.LochoHostStateDir)
	}
	if keyErr != nil && !errors.Is(keyErr, os.ErrNotExist) {
		return fmt.Errorf("inspect locho-host key: %w", keyErr)
	}
	if stateErr != nil && !errors.Is(stateErr, os.ErrNotExist) {
		return fmt.Errorf("inspect locho-host state: %w", stateErr)
	}
	if errors.Is(keyErr, os.ErrNotExist) && stateErr == nil {
		return errors.New("locho-host state directory has host_state.json without host.key")
	}

	if keyErr == nil && errors.Is(stateErr, os.ErrNotExist) {
		endpointID, err := validateLochoHostKeyFile(keyPath)
		if err != nil {
			return err
		}
		state, err := generateLochoHostState(endpointID)
		if err != nil {
			return err
		}
		return writeLochoHostStateFile(statePath, state)
	}

	// Neither file exists locally; attempt to adopt existing state from target first.
	if deployment != nil {
		if adopted, err := pullTargetLochoHostState(ctx, deployment, config.LochoHostStateDir); err == nil && adopted {
			return nil
		}
	}

	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return fmt.Errorf("generate locho-host key: %w", err)
	}
	endpointID := deriveLochoEndpointID(seed)
	state, err := generateLochoHostState(endpointID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(config.LochoHostStateDir, 0o700); err != nil {
		return fmt.Errorf("create locho-host state directory: %w", err)
	}
	if err := os.Chmod(config.LochoHostStateDir, 0o700); err != nil {
		return fmt.Errorf("secure locho-host state directory: %w", err)
	}
	if err := writePrivateFileAtomic(keyPath, seed); err != nil {
		return fmt.Errorf("write locho-host key: %w", err)
	}
	if err := writeLochoHostStateFile(statePath, state); err != nil {
		_ = os.Remove(keyPath)
		return fmt.Errorf("write locho-host state: %w", err)
	}
	return nil
}

func syncLochoHostState(ctx context.Context, deployment deployment, config *Config) error {
	if !config.LochoHostEnabled {
		return nil
	}
	hadStateDir := config.LochoHostStateDir != ""
	if err := ensureLochoHostState(ctx, deployment, config); err != nil {
		return err
	}
	if !hadStateDir && config.LochoHostStateDir != "" {
		if _, err := os.Stat(configPath()); err == nil {
			if err := saveConfig(*config); err != nil {
				return fmt.Errorf("save locho-host state_dir in config: %w", err)
			}
		}
	}
	keyPath := filepath.Join(config.LochoHostStateDir, "host.key")
	statePath := filepath.Join(config.LochoHostStateDir, "host_state.json")
	if err := deployment.uploadFile(ctx, keyPath, deployment.rootPath("runtime", "locho-host", "state", "host.key"), 0o600); err != nil {
		return fmt.Errorf("upload locho-host key: %w", err)
	}
	if err := deployment.uploadFile(ctx, statePath, deployment.rootPath("runtime", "locho-host", "state", "host_state.json"), 0o600); err != nil {
		return fmt.Errorf("upload locho-host state: %w", err)
	}
	return nil
}

func deriveLochoEndpointID(seed []byte) string {
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	return hex.EncodeToString(publicKey)
}

func generateLochoSecretHex() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func generateLochoHostState(endpointID string) (lochoPersistedHostState, error) {
	attachSecret, err := generateLochoSecretHex()
	if err != nil {
		return lochoPersistedHostState{}, err
	}
	workspaceSecret, err := generateLochoSecretHex()
	if err != nil {
		return lochoPersistedHostState{}, err
	}
	openWebUISecret, err := generateLochoSecretHex()
	if err != nil {
		return lochoPersistedHostState{}, err
	}
	return lochoPersistedHostState{
		SchemaVersion: lochoHostStateSchemaVersion,
		EndpointID:    endpointID,
		AttachSecret:  attachSecret,
		ServiceSecrets: map[string]string{
			"open-webui":   openWebUISecret,
			"workspace-ui": workspaceSecret,
		},
	}, nil
}

func validateLochoHostKeyFile(keyPath string) (string, error) {
	info, err := os.Lstat(keyPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("locho-host key must be a regular file protected with mode 0600")
	}
	seed, err := os.ReadFile(keyPath)
	if err != nil {
		return "", err
	}
	if len(seed) != ed25519.SeedSize {
		return "", errors.New("locho-host key must be a 32-byte Ed25519 seed")
	}
	return deriveLochoEndpointID(seed), nil
}

func validateLochoHostStateDir(stateDir string) error {
	dirInfo, err := os.Lstat(stateDir)
	if err != nil || !dirInfo.IsDir() || dirInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("locho-host state_dir must be a regular directory")
	}
	if dirInfo.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(stateDir, 0o700); err != nil {
			return fmt.Errorf("secure locho-host state_dir: %w", err)
		}
	}
	keyPath := filepath.Join(stateDir, "host.key")
	statePath := filepath.Join(stateDir, "host_state.json")
	endpointID, err := validateLochoHostKeyFile(keyPath)
	if err != nil {
		return err
	}
	stateInfo, err := os.Lstat(statePath)
	if err != nil || !stateInfo.Mode().IsRegular() || stateInfo.Mode()&os.ModeSymlink != 0 || stateInfo.Mode().Perm()&0o077 != 0 {
		return errors.New("locho-host state file must be a regular file protected with mode 0600")
	}
	raw, err := os.ReadFile(statePath)
	if err != nil {
		return err
	}
	state, changed, err := parseAndRepairLochoHostState(raw, endpointID)
	if err != nil {
		return err
	}
	if changed {
		return writeLochoHostStateFile(statePath, state)
	}
	return nil
}

func parseAndRepairLochoHostState(raw []byte, expectedEndpointID string) (lochoPersistedHostState, bool, error) {
	var state lochoPersistedHostState
	if err := json.Unmarshal(raw, &state); err != nil {
		return lochoPersistedHostState{}, false, errors.New("locho-host state file is not valid JSON")
	}
	if state.SchemaVersion != lochoHostStateSchemaVersion && state.SchemaVersion != 1 {
		return lochoPersistedHostState{}, false, fmt.Errorf("unsupported locho-host state schema version %d", state.SchemaVersion)
	}
	if state.EndpointID != expectedEndpointID {
		return lochoPersistedHostState{}, false, errors.New("locho-host state endpoint_id does not match host.key")
	}
	changed := false
	if state.SchemaVersion != lochoHostStateSchemaVersion {
		state.SchemaVersion = lochoHostStateSchemaVersion
		changed = true
	}
	if !validLochoHexSecret(state.AttachSecret) {
		secret, err := generateLochoSecretHex()
		if err != nil {
			return lochoPersistedHostState{}, false, err
		}
		state.AttachSecret = secret
		changed = true
	}
	if state.ServiceSecrets == nil {
		state.ServiceSecrets = make(map[string]string)
		changed = true
	}
	for _, service := range []string{"workspace-ui", "open-webui"} {
		if !validLochoHexSecret(state.ServiceSecrets[service]) {
			secret, err := generateLochoSecretHex()
			if err != nil {
				return lochoPersistedHostState{}, false, err
			}
			state.ServiceSecrets[service] = secret
			changed = true
		}
	}
	return state, changed, nil
}

func validLochoHexSecret(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, ch := range value {
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
			return false
		}
	}
	return true
}

func writeLochoHostStateFile(path string, state lochoPersistedHostState) error {
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	return writePrivateFileAtomic(path, encoded)
}

func writePrivateFileAtomic(path string, data []byte) error {
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(parent, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func pullTargetLochoHostState(ctx context.Context, dep deployment, localStateDir string) (bool, error) {
	remoteKeyPath := dep.rootPath("runtime", "locho-host", "state", "host.key")
	remoteStatePath := dep.rootPath("runtime", "locho-host", "state", "host_state.json")

	var seed []byte
	var stateBytes []byte

	switch target := dep.(type) {
	case Local:
		keyInfo, keyErr := os.Lstat(remoteKeyPath)
		stateInfo, stateErr := os.Lstat(remoteStatePath)
		if keyErr != nil || stateErr != nil || !keyInfo.Mode().IsRegular() || !stateInfo.Mode().IsRegular() {
			return false, nil
		}
		var err error
		seed, err = os.ReadFile(remoteKeyPath)
		if err != nil {
			return false, err
		}
		stateBytes, err = os.ReadFile(remoteStatePath)
		if err != nil {
			return false, err
		}
	case Remote:
		script := "set -eu; key=" + shellQuote(remoteKeyPath) + "; state=" + shellQuote(remoteStatePath) + "; " +
			"if [ ! -f \"$key\" ] || [ -L \"$key\" ] || [ ! -f \"$state\" ] || [ -L \"$state\" ]; then exit 44; fi; " +
			"base64 < \"$key\" | tr -d '\\n'; printf '\\n---LOCHO-STATE---\\n'; cat -- \"$state\""
		raw, err := target.ssh(ctx, privilegedCommand(script), nil)
		if err != nil {
			return false, nil
		}
		parts := strings.SplitN(string(raw), "\n---LOCHO-STATE---\n", 2)
		if len(parts) != 2 {
			return false, nil
		}
		decodedKey, err := base64.StdEncoding.DecodeString(strings.TrimSpace(parts[0]))
		if err != nil {
			return false, err
		}
		seed = decodedKey
		stateBytes = []byte(parts[1])
	default:
		return false, nil
	}

	if len(seed) != ed25519.SeedSize {
		return false, errors.New("target locho-host key has invalid length")
	}
	endpointID := deriveLochoEndpointID(seed)
	state, _, err := parseAndRepairLochoHostState(stateBytes, endpointID)
	if err != nil {
		return false, err
	}
	if err := writePrivateFileAtomic(filepath.Join(localStateDir, "host.key"), seed); err != nil {
		return false, err
	}
	if err := writeLochoHostStateFile(filepath.Join(localStateDir, "host_state.json"), state); err != nil {
		_ = os.Remove(filepath.Join(localStateDir, "host.key"))
		return false, err
	}
	return true, nil
}
