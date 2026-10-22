package operator

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"openlia/internal/releaseinfo"
)

// CommandResult keeps stdout and stderr separate so JSON output can remain
// machine-readable while diagnostics stay on stderr.
type CommandResult struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// CommandRunner is the seam used by Compose and command tests.
type CommandRunner interface {
	Run(context.Context, string, ...string) (CommandResult, error)
}

// EnvironmentCommandRunner lets the operator pass resolved non-secret
// Compose paths even when it was launched outside the top-level CLI.
type EnvironmentCommandRunner interface {
	RunWithEnv(context.Context, []string, string, ...string) (CommandResult, error)
}

// ExecRunner runs a host process without invoking a shell. Stderr is retained
// for diagnostics and can also be streamed to the operator's error output.
type ExecRunner struct {
	Stderr io.Writer
}

func (runner ExecRunner) Run(ctx context.Context, name string, args ...string) (CommandResult, error) {
	return runner.RunWithEnv(ctx, nil, name, args...)
}

func (runner ExecRunner) RunWithEnv(ctx context.Context, overrides []string, name string, args ...string) (CommandResult, error) {
	command := exec.CommandContext(ctx, name, args...)
	if len(overrides) > 0 {
		command.Env = mergedEnvironment(overrides)
	}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	if runner.Stderr == nil {
		command.Stderr = &stderr
	} else {
		command.Stderr = io.MultiWriter(&stderr, runner.Stderr)
	}
	err := command.Run()
	result := CommandResult{Stdout: stdout.Bytes(), Stderr: stderr.Bytes(), ExitCode: 0}
	if err == nil {
		return result, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.ExitCode = exitError.ExitCode()
	}
	return result, fmt.Errorf("run %s: %w", name, err)
}

func mergedEnvironment(overrides []string) []string {
	values := make(map[string]string)
	order := make([]string, 0)
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		if _, exists := values[key]; !exists {
			order = append(order, key)
		}
		values[key] = value
	}
	for _, item := range overrides {
		key, value, ok := strings.Cut(item, "=")
		if !ok || key == "" {
			continue
		}
		if _, exists := values[key]; !exists {
			order = append(order, key)
		}
		values[key] = value
	}
	result := make([]string, 0, len(order))
	for _, key := range order {
		result = append(result, key+"="+values[key])
	}
	return result
}

type Compose struct {
	Config Config
	Runner CommandRunner
}

func NewCompose(config Config, runner CommandRunner) Compose {
	if runner == nil {
		runner = ExecRunner{}
	}
	return Compose{Config: config, Runner: runner}
}

// Arguments returns the stable global Compose arguments used by the runtime.
func (c Compose) Arguments(args ...string) []string {
	result := []string{"compose", "--project-name", c.Config.ProjectName, "--project-directory", c.Config.ComposeProjectDir, "-f", c.Config.ComposeFile}
	if info, err := os.Stat(c.Config.GeneratedCompose); err == nil && info.Mode().IsRegular() {
		result = append(result, "-f", c.Config.GeneratedCompose)
	}
	return append(result, args...)
}

func (c Compose) Run(ctx context.Context, args ...string) (CommandResult, error) {
	arguments := c.Arguments(args...)
	if c.Runner == nil {
		c.Runner = ExecRunner{}
	}
	if runner, ok := c.Runner.(EnvironmentCommandRunner); ok {
		return runner.RunWithEnv(ctx, c.composeEnvironment(), "docker", arguments...)
	}
	return c.Runner.Run(ctx, "docker", arguments...)
}

func (c Compose) composeEnvironment() []string {
	hermesImage := c.Config.HermesImage
	if hermesImage == "" {
		hermesImage = releaseinfo.InternalImage("openlia-hermes", releaseinfo.Default.Hermes.Tag)
	}
	hermesVersion := c.Config.HermesVersion
	if hermesVersion == "" {
		hermesVersion = releaseinfo.Default.Hermes.Tag
	}
	hermesDigest := c.Config.HermesDigest
	if hermesDigest == "" {
		hermesDigest = releaseinfo.Default.Hermes.Digest
	}
	lochoImage := c.Config.LochoImage
	if lochoImage == "" {
		lochoImage = releaseinfo.InternalImage("openlia-locho", releaseinfo.Default.Locho.Version)
	}
	openWebUIImage := c.Config.OpenWebUIImage
	if openWebUIImage == "" {
		openWebUIImage = releaseinfo.Default.OpenWebUI.Ref()
	}
	knownHosts := os.Getenv("OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE")
	if knownHosts == "" {
		if home, err := os.UserHomeDir(); err == nil {
			knownHosts = filepath.Join(home, ".ssh", "known_hosts")
		}
	}
	if info, err := os.Stat(knownHosts); err != nil || !info.Mode().IsRegular() {
		knownHosts = "/dev/null"
	}
	awsCredentials := os.Getenv("OPENLIA_AWS_CREDENTIALS_SOURCE")
	awsConfig := os.Getenv("OPENLIA_AWS_CONFIG_SOURCE")
	if home, err := os.UserHomeDir(); err == nil {
		if awsCredentials == "" {
			awsCredentials = filepath.Join(home, ".aws", "credentials")
		}
		if awsConfig == "" {
			awsConfig = filepath.Join(home, ".aws", "config")
		}
	}
	if info, err := os.Stat(awsCredentials); err != nil || !info.Mode().IsRegular() {
		awsCredentials = "/dev/null"
	}
	if info, err := os.Stat(awsConfig); err != nil || !info.Mode().IsRegular() {
		awsConfig = "/dev/null"
	}
	return []string{
		"OPENLIA_HERMES_IMAGE=" + hermesImage,
		"OPENLIA_BACKUP_SCHEDULER_IMAGE=" + releaseinfo.InternalImage("openlia-backup-scheduler", hermesVersion),
		"HERMES_BASE_IMAGE=" + releaseinfo.Default.Hermes.Image,
		"HERMES_BASE_TAG=" + hermesVersion,
		"HERMES_BASE_DIGEST=" + hermesDigest,
		"OPENLIA_LOCHO_IMAGE=" + lochoImage,
		"OPENLIA_OPEN_WEBUI_IMAGE=" + openWebUIImage,
		"OPENLIA_DATA_ROOT=" + c.Config.DataRoot,
		"OPENLIA_SYSTEM_SKILLS_ROOT=" + c.Config.SystemSkillsRoot,
		"OPENLIA_SECRET_DIR=" + c.Config.SecretDir,
		"OPENLIA_META_ROOT=" + c.Config.MetaRoot,
		"OPENLIA_BACKUP_ROOT=" + c.Config.BackupRoot,
		"OPENLIA_RUNTIME_UID=" + strconv.Itoa(c.Config.RuntimeUID),
		"OPENLIA_RUNTIME_GID=" + strconv.Itoa(c.Config.RuntimeGID),
		"OPENLIA_OPERATION_LOCK=" + c.Config.InstallRoot + ".operation.lock",
		"OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE=" + knownHosts,
		"OPENLIA_AWS_CREDENTIALS_SOURCE=" + awsCredentials,
		"OPENLIA_AWS_CONFIG_SOURCE=" + awsConfig,
		"OPENLIA_NETWORK_NAME=" + c.Config.NetworkName,
		"OPENLIA_INGESTION_MAX_CONCURRENT_JOBS=" + strconv.Itoa(c.Config.IngestionMaxConcurrentJobs),
	}
}

func (c Compose) Quiet(ctx context.Context, args ...string) error {
	_, err := c.Run(ctx, args...)
	return err
}

func (c Compose) ServiceRunning(ctx context.Context, service string) bool {
	configured, err := c.Run(ctx, "config", "--services")
	if err != nil || !containsService(configured.Stdout, service) {
		return false
	}
	result, err := c.Run(ctx, "ps", "--services", "--filter", "status=running")
	if err != nil {
		return false
	}
	return containsService(result.Stdout, service)
}

func containsService(output []byte, service string) bool {
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		if string(line) == service {
			return true
		}
	}
	return false
}

func (c Compose) Docker(ctx context.Context, args ...string) (CommandResult, error) {
	runner := c.Runner
	if runner == nil {
		runner = ExecRunner{}
	}
	return runner.Run(ctx, "docker", args...)
}

func (c Compose) Host(ctx context.Context, name string, args ...string) (CommandResult, error) {
	runner := c.Runner
	if runner == nil {
		runner = ExecRunner{}
	}
	return runner.Run(ctx, name, args...)
}
