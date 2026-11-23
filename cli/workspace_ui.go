package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

type workspaceUIServeConfig struct {
	Root         string
	WorkspaceDir string
	SkillsDir    string
	MemoriesDir  string
	CacheDir     string
	DistDir      string
	SessionDB    string
	Host         string
	Port         int
	PublicOrigin string
	EnvFile      string
	NoAuth       bool
	AuthRequired bool
	EnvVars      map[string]string
}

var workspaceUIAuthEnvKeys = []string{
	"OPENLIA_WORKSPACE_UI_USERNAME",
	"OPENLIA_WORKSPACE_UI_PASSWORD",
	"OPENLIA_WORKSPACE_UI_PASSWORD_HASH",
	"OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE",
	"OPENLIA_WORKSPACE_UI_OIDC_ISSUER",
	"OPENLIA_WORKSPACE_UI_OIDC_CLIENT_ID",
	"OPENLIA_WORKSPACE_UI_OIDC_CLIENT_SECRET",
	"OPENLIA_WORKSPACE_UI_OIDC_SCOPES",
	"OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS",
	"OPENLIA_WORKSPACE_UI_ALLOW_ANY_OIDC_EMAIL",
	"OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN",
	"OPENLIA_WORKSPACE_UI_TRUST_PROXY",
	"HERMES_DASHBOARD_BASIC_AUTH_USERNAME",
	"HERMES_DASHBOARD_BASIC_AUTH_PASSWORD",
	"HERMES_DASHBOARD_OIDC_ISSUER",
	"HERMES_DASHBOARD_OIDC_CLIENT_ID",
	"HERMES_DASHBOARD_OIDC_CLIENT_SECRET",
	"HERMES_DASHBOARD_OIDC_SCOPES",
	"HERMES_DASHBOARD_ALLOWED_EMAILS",
	"HERMES_DASHBOARD_PUBLIC_URL",
}

func commandWorkspaceUI(options Options, args []string, assets fs.FS) int {
	if len(args) == 0 || args[0] != "serve" {
		return fail(options, ExitUsage, "workspace-ui requires serve", nil)
	}
	return serveWorkspaceUI(options, args[1:], assets)
}

func parseWorkspaceUIServeConfig(args []string) (workspaceUIServeConfig, bool, error) {
	defaultRoot := strings.TrimSpace(os.Getenv("HERMES_HOME"))
	if defaultRoot == "" {
		defaultRoot = "~/.hermes"
	}

	set := newFlagSet("workspace-ui serve")
	rootFlag := set.String("root", defaultRoot, "Hermes home directory containing workspace/, skills/, SOUL.md, AGENTS.md, and memories/")
	portFlag := set.Int("port", defaultWorkspaceUIPort, "Workspace UI listen port")
	hostFlag := set.String("host", "127.0.0.1", "Workspace UI bind address")
	bindFlag := set.String("bind", "", "alias for --host")
	publicOriginFlag := set.String("public-origin", "", "optional external http(s) origin for OIDC callbacks and secure cookies")
	envFileFlag := set.String("env-file", "", "optional dotenv file for Workspace UI / Hermes Dashboard credentials (defaults to <root>/.env if present)")
	noAuthFlag := set.Bool("no-auth", false, "disable Workspace UI authentication")

	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return workspaceUIServeConfig{}, true, nil
		}
		return workspaceUIServeConfig{}, false, errors.New("workspace-ui serve accepts --root PATH [--port PORT] [--host ADDR] [--public-origin URL] [--env-file PATH] [--no-auth]")
	}
	if set.NArg() != 0 {
		return workspaceUIServeConfig{}, false, errors.New("workspace-ui serve does not accept positional arguments")
	}

	rawRoot := strings.TrimSpace(*rootFlag)
	if rawRoot == "" {
		return workspaceUIServeConfig{}, false, errors.New("workspace-ui serve requires a non-empty --root path")
	}
	resolvedRoot := expandTilde(rawRoot)
	absRoot, err := filepath.Abs(resolvedRoot)
	if err != nil {
		return workspaceUIServeConfig{}, false, fmt.Errorf("resolve --root path: %w", err)
	}

	host := strings.TrimSpace(*hostFlag)
	if strings.TrimSpace(*bindFlag) != "" {
		host = strings.TrimSpace(*bindFlag)
	}
	if host == "" {
		host = "127.0.0.1"
	}
	if strings.ContainsAny(host, " \t\r\n\x00") {
		return workspaceUIServeConfig{}, false, errors.New("--host must not contain whitespace or control characters")
	}
	if *portFlag < 1 || *portFlag > 65535 {
		return workspaceUIServeConfig{}, false, errors.New("--port must be between 1 and 65535")
	}

	publicOrigin := strings.TrimRight(strings.TrimSpace(*publicOriginFlag), "/")
	if publicOrigin != "" {
		parsedOrigin, parseErr := url.Parse(publicOrigin)
		if parseErr != nil || (parsedOrigin.Scheme != "http" && parsedOrigin.Scheme != "https") || parsedOrigin.Host == "" || parsedOrigin.Path != "" || parsedOrigin.RawQuery != "" || parsedOrigin.Fragment != "" {
			return workspaceUIServeConfig{}, false, errors.New("--public-origin must be an absolute http(s) origin without path or query")
		}
	}

	envVars := make(map[string]string)
	explicitEnvFile := strings.TrimSpace(*envFileFlag)
	resolvedEnvFile := ""
	if explicitEnvFile != "" {
		resolvedEnvFile = expandTilde(explicitEnvFile)
		fileVars, readErr := parseDotEnvFile(resolvedEnvFile)
		if readErr != nil {
			return workspaceUIServeConfig{}, false, fmt.Errorf("read --env-file: %w", readErr)
		}
		for k, v := range fileVars {
			envVars[k] = v
		}
	} else {
		candidate := filepath.Join(absRoot, ".env")
		if info, statErr := os.Stat(candidate); statErr == nil && info.Mode().IsRegular() {
			if fileVars, readErr := parseDotEnvFile(candidate); readErr == nil {
				resolvedEnvFile = candidate
				for k, v := range fileVars {
					envVars[k] = v
				}
			}
		}
	}

	// Process environment variables take precedence over .env file values.
	for _, key := range workspaceUIAuthEnvKeys {
		if val, ok := os.LookupEnv(key); ok && strings.TrimSpace(val) != "" {
			envVars[key] = val
		}
	}
	if publicOrigin == "" {
		publicOrigin = strings.TrimRight(strings.TrimSpace(envVars["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"]), "/")
	}

	hasOIDC := strings.TrimSpace(firstNonEmpty(envVars["OPENLIA_WORKSPACE_UI_OIDC_ISSUER"], envVars["HERMES_DASHBOARD_OIDC_ISSUER"])) != "" &&
		strings.TrimSpace(firstNonEmpty(envVars["OPENLIA_WORKSPACE_UI_OIDC_CLIENT_ID"], envVars["HERMES_DASHBOARD_OIDC_CLIENT_ID"])) != ""
	hasPassword := firstNonEmpty(
		envVars["OPENLIA_WORKSPACE_UI_PASSWORD"],
		envVars["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"],
		envVars["OPENLIA_WORKSPACE_UI_PASSWORD_HASH"],
		envVars["OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE"],
	) != ""
	hasCredentials := hasOIDC || hasPassword

	authRequired := false
	if *noAuthFlag {
		authRequired = false
	} else if hasCredentials {
		authRequired = true
	} else if isLoopbackHost(host) {
		authRequired = false
	} else {
		return workspaceUIServeConfig{}, false, fmt.Errorf("binding to non-loopback address %q requires authentication credentials (via environment, --env-file, or %s/.env) or explicit --no-auth", host, absRoot)
	}

	cacheDir := filepath.Join(absRoot, "cache", "workspace-ui")
	return workspaceUIServeConfig{
		Root:         absRoot,
		WorkspaceDir: filepath.Join(absRoot, "workspace"),
		SkillsDir:    filepath.Join(absRoot, "skills"),
		MemoriesDir:  filepath.Join(absRoot, "memories"),
		CacheDir:     cacheDir,
		DistDir:      filepath.Join(cacheDir, "dist"),
		SessionDB:    filepath.Join(cacheDir, "sessions.sqlite"),
		Host:         host,
		Port:         *portFlag,
		PublicOrigin: publicOrigin,
		EnvFile:      resolvedEnvFile,
		NoAuth:       *noAuthFlag,
		AuthRequired: authRequired,
		EnvVars:      envVars,
	}, false, nil
}

func serveWorkspaceUI(options Options, args []string, assets fs.FS) int {
	cfg, helpRequested, err := parseWorkspaceUIServeConfig(args)
	if helpRequested {
		return ExitOK
	}
	if err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}
	if assets == nil {
		return fail(options, ExitInternal, "workspace-ui embedded assets are missing", nil)
	}

	bunPath, err := findBunExecutable()
	if err != nil {
		return fail(options, ExitPrereq, err.Error(), nil)
	}

	if err := prepareStandaloneWorkspaceUI(cfg, assets); err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}

	serverScript := filepath.Join(cfg.DistDir, "server.js")
	cmd := exec.Command(bunPath, serverScript)
	cmd.Env = buildWorkspaceUIServeEnv(os.Environ(), cfg)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return fail(options, ExitFailure, fmt.Sprintf("start workspace-ui server: %v", err), nil)
	}

	sigChan := make(chan os.Signal, 2)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigChan)

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case waitErr := <-done:
		if waitErr != nil {
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) {
				return exitErr.ExitCode()
			}
			return fail(options, ExitFailure, waitErr.Error(), nil)
		}
		return ExitOK
	case sig := <-sigChan:
		if cmd.Process != nil {
			_ = cmd.Process.Signal(sig)
		}
		waitErr := <-done
		if waitErr != nil {
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) && (sig == os.Interrupt || sig == syscall.SIGTERM) {
				return ExitOK
			}
			return fail(options, ExitFailure, waitErr.Error(), nil)
		}
		return ExitOK
	}
}

func prepareStandaloneWorkspaceUI(cfg workspaceUIServeConfig, assets fs.FS) error {
	if info, err := os.Lstat(cfg.Root); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("workspace-ui root %s must be a real directory", cfg.Root)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect workspace-ui root %s: %w", cfg.Root, err)
	}

	for _, dir := range []string{
		cfg.Root,
		cfg.WorkspaceDir,
		cfg.SkillsDir,
		cfg.MemoriesDir,
		cfg.CacheDir,
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("prepare directory %s: %w", dir, err)
		}
	}

	return extractWorkspaceUIAssets(assets, cfg.DistDir)
}

func extractWorkspaceUIAssets(assets fs.FS, destDir string) error {
	const prefix = "packages/workspace-ui/dist"
	type embeddedAsset struct {
		relPath string
		data    []byte
	}
	var collected []embeddedAsset
	hasher := sha256.New()

	walkErr := fs.WalkDir(assets, prefix, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		rel := strings.TrimPrefix(path.Clean(name), prefix+"/")
		if rel == "" || rel == "." || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("invalid embedded workspace-ui asset path %q", name)
		}
		data, readErr := fs.ReadFile(assets, name)
		if readErr != nil {
			return readErr
		}
		collected = append(collected, embeddedAsset{relPath: rel, data: data})
		return nil
	})
	if walkErr != nil {
		return fmt.Errorf("workspace-ui bundle is missing from embedded assets: %w", walkErr)
	}
	if len(collected) == 0 {
		return errors.New("workspace-ui bundle is empty")
	}

	sort.Slice(collected, func(i, j int) bool {
		return collected[i].relPath < collected[j].relPath
	})
	hasServer := false
	for _, item := range collected {
		if item.relPath == "server.js" {
			hasServer = true
		}
		_, _ = hasher.Write([]byte(item.relPath))
		_, _ = hasher.Write([]byte{0})
		_, _ = hasher.Write(item.data)
		_, _ = hasher.Write([]byte{0})
	}
	if !hasServer {
		return errors.New("workspace-ui server.js is missing from embedded assets")
	}

	digest := hex.EncodeToString(hasher.Sum(nil))
	stampPath := filepath.Join(destDir, ".bundle-sha256")
	serverPath := filepath.Join(destDir, "server.js")
	if existingStamp, err := os.ReadFile(stampPath); err == nil && strings.TrimSpace(string(existingStamp)) == digest {
		if info, statErr := os.Stat(serverPath); statErr == nil && info.Mode().IsRegular() {
			return nil
		}
	}

	stagingDir := destDir + ".tmp-openlia"
	_ = os.RemoveAll(stagingDir)
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return fmt.Errorf("create workspace-ui staging directory: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(stagingDir)
	}()

	for _, item := range collected {
		targetPath := filepath.Join(stagingDir, filepath.FromSlash(item.relPath))
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(targetPath, item.data, 0o600); err != nil {
			return err
		}
	}
	if err := os.WriteFile(filepath.Join(stagingDir, ".bundle-sha256"), []byte(digest+"\n"), 0o600); err != nil {
		return err
	}

	_ = os.RemoveAll(destDir)
	if err := os.Rename(stagingDir, destDir); err != nil {
		return fmt.Errorf("activate workspace-ui bundle: %w", err)
	}
	return nil
}

func buildWorkspaceUIServeEnv(baseEnv []string, cfg workspaceUIServeConfig) []string {
	overrides := make(map[string]string, len(cfg.EnvVars)+10)
	for k, v := range cfg.EnvVars {
		overrides[k] = v
	}
	overrides["OPENLIA_DATA_ROOT"] = cfg.Root
	overrides["OPENLIA_WORKSPACE_ROOT"] = cfg.WorkspaceDir
	overrides["OPENLIA_WORKSPACE_UI_SKILLS_ROOT"] = cfg.SkillsDir
	overrides["OPENLIA_WORKSPACE_UI_STATIC_ROOT"] = filepath.Join(cfg.DistDir, "client")
	overrides["OPENLIA_WORKSPACE_UI_SESSION_DB"] = cfg.SessionDB
	overrides["OPENLIA_WORKSPACE_UI_BIND"] = cfg.Host
	overrides["OPENLIA_WORKSPACE_UI_PORT"] = strconv.Itoa(cfg.Port)
	if cfg.AuthRequired {
		overrides["OPENLIA_WORKSPACE_UI_AUTH_REQUIRED"] = "true"
	} else {
		overrides["OPENLIA_WORKSPACE_UI_AUTH_REQUIRED"] = "false"
	}
	if cfg.PublicOrigin != "" {
		overrides["OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN"] = cfg.PublicOrigin
	}

	result := make([]string, 0, len(baseEnv)+len(overrides))
	for _, entry := range baseEnv {
		key, _, ok := strings.Cut(entry, "=")
		if ok {
			if _, overridden := overrides[key]; overridden {
				continue
			}
		}
		result = append(result, entry)
	}
	keys := make([]string, 0, len(overrides))
	for key := range overrides {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		result = append(result, key+"="+overrides[key])
	}
	return result
}

func findBunExecutable() (string, error) {
	if explicit := strings.TrimSpace(os.Getenv("OPENLIA_BUN_BIN")); explicit != "" {
		expanded := expandTilde(explicit)
		if info, err := os.Stat(expanded); err == nil && !info.IsDir() {
			return expanded, nil
		}
		return "", fmt.Errorf("OPENLIA_BUN_BIN %q was not found", explicit)
	}
	home, _ := os.UserHomeDir()
	candidates := []string{}
	if home != "" {
		candidates = append(candidates, filepath.Join(home, ".bun", "bin", "bun"))
	}
	candidates = append(candidates,
		"/opt/homebrew/bin/bun",
		"/usr/local/bin/bun",
		"/usr/bin/bun",
	)
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	if path, err := exec.LookPath("bun"); err == nil {
		return path, nil
	}
	return "", errors.New("bun is required to run `openlia workspace-ui serve`; install Bun (https://bun.sh) or set OPENLIA_BUN_BIN")
}

func parseDotEnvFile(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	values := make(map[string]string)
	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(rawLine, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key := strings.TrimSpace(k)
		val := strings.TrimSpace(v)
		if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}
		if key != "" {
			values[key] = val
		}
	}
	return values, nil
}

func isLoopbackHost(host string) bool {
	normalized := strings.ToLower(strings.TrimSpace(host))
	return normalized == "127.0.0.1" || normalized == "localhost" || normalized == "::1" || normalized == "[::1]"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
