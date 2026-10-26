package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
	"openlia/internal/releaseinfo"
	"openlia/internal/toolcatalog"
	"openlia/operator"
)

type Remote struct {
	Config Config
}

type deployment interface {
	rootPath(parts ...string) string
	uploadFile(ctx context.Context, source, destination string, mode os.FileMode) error
	downloadFile(ctx context.Context, source, destination string) error
	removeFile(ctx context.Context, destination string) error
	uploadRelease(ctx context.Context, archive []byte, digest string) error
	activateRelease(ctx context.Context) error
	releaseDigest(ctx context.Context) (string, error)
	workspaceUIReleaseDigest(ctx context.Context) (string, error)
	bootstrap(ctx context.Context) ([]byte, error)
	deploy(ctx context.Context, action string, start bool, component string) ([]byte, error)
	health(ctx context.Context, allowStopped, providerCheck bool) ([]byte, error)
	operation(ctx context.Context, script string, input []byte, args ...string) ([]byte, error)
	workspaceGit(ctx context.Context, action string) ([]byte, error)
	uninstall(ctx context.Context) ([]byte, error)
	composeLogs(ctx context.Context, follow bool) ([]byte, error)
}

func newDeployment(config Config) deployment {
	if config.Mode == "local" {
		return Local{Config: config}
	}
	return Remote{Config: config}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func (remote Remote) rootPath(parts ...string) string {
	items := append([]string{remote.Config.InstallRoot}, parts...)
	return filepath.Join(items...)
}

func (remote Remote) releasePath() string {
	return remote.rootPath("releases", remote.Config.Version)
}

func (remote Remote) releaseDigest(ctx context.Context) (string, error) {
	path := remote.rootPath("current", "release.sha256")
	command := "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n cat -- " + shellQuote(path) + "; else cat -- " + shellQuote(path) + "; fi"
	raw, err := remote.ssh(ctx, command, nil)
	if err != nil {
		return "", err
	}
	return normalizeReleaseDigest(raw)
}

func (remote Remote) workspaceUIReleaseDigest(ctx context.Context) (string, error) {
	if remote.Config.WorkspaceUIHost == "" {
		return "", nil
	}
	root := remote.rootPath("current")
	base := filepath.Join(root, "docker", "compose.yaml")
	generated := filepath.Join(root, "docker", "compose.generated.yaml")
	compose := remote.composeEnvironment() + " docker compose --project-name " + shellQuote(remote.Config.Project) + " --project-directory " + shellQuote(filepath.Join(root, "docker")) + " -f " + shellQuote(base)
	probe := "bun -e " + shellQuote(fmt.Sprintf("fetch('http://127.0.0.1:%d/health').then(async response => { if (!response.ok) process.exit(1); console.log(await response.text()) })", remote.Config.WorkspaceUIPort))
	command := "set -eu; if [ -f " + shellQuote(generated) + " ]; then " + compose + " -f " + shellQuote(generated) + " exec -T workspace-ui " + probe + "; else " + compose + " exec -T workspace-ui " + probe + "; fi"
	raw, err := remote.ssh(ctx, command, nil)
	if err != nil {
		return "", err
	}
	return parseWorkspaceUIReleaseDigest(raw)
}

func parseWorkspaceUIReleaseDigest(raw []byte) (string, error) {
	var payload struct {
		ReleaseSHA256 string `json:"release_sha256"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &payload); err != nil {
		return "", fmt.Errorf("parse workspace UI health response: %w", err)
	}
	return normalizeReleaseDigest([]byte(payload.ReleaseSHA256))
}

func (remote Remote) ssh(ctx context.Context, command string, input []byte) ([]byte, error) {
	return remote.sshReader(ctx, command, bytes.NewReader(input))
}

func (remote Remote) sshReader(ctx context.Context, command string, input io.Reader) ([]byte, error) {
	if err := validateTarget(remote.Config.Target); err != nil {
		return nil, err
	}
	ssh, err := exec.LookPath("ssh")
	if err != nil {
		return nil, fmt.Errorf("ssh is required: %w", err)
	}
	process := exec.CommandContext(ctx, ssh,
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=5",
		"-o", "ServerAliveCountMax=3",
		"--", remote.Config.Target, command,
	)
	process.Stdin = input
	var stdout, stderr bytes.Buffer
	process.Stdout = &stdout
	process.Stderr = io.MultiWriter(&stderr, os.Stderr)
	err = process.Run()
	if err != nil {
		detail := strings.TrimSpace(redact(stderr.String()))
		if parsed := operatorError(stdout.Bytes()); parsed != "" {
			detail = parsed
		}
		if detail != "" {
			return stdout.Bytes(), fmt.Errorf("remote command failed: %s", detail)
		}
		return stdout.Bytes(), fmt.Errorf("remote command failed: %w", err)
	}
	return stdout.Bytes(), nil
}

func (remote Remote) operationCommand(operation string, args ...string) string {
	return remote.operationCommandForRoot(remote.releasePath(), operation, args...)
}

func (remote Remote) composeEnvironment() string {
	knownHosts := remote.Config.BackupKnownHosts
	if knownHosts == "" {
		knownHosts = "/root/.ssh/known_hosts"
	}
	values := []string{
		"OPENLIA_DATA_ROOT=" + shellQuote(remote.rootPath("runtime", "hermes")),
		"OPENLIA_SYSTEM_SKILLS_ROOT=" + shellQuote(remote.rootPath("runtime", "system-skills")),
		"OPENLIA_SECRET_DIR=" + shellQuote(remote.rootPath("runtime", "secrets")),
		"OPENLIA_META_ROOT=" + shellQuote(remote.rootPath("runtime", "meta")),
		"OPENLIA_BACKUP_ROOT=" + shellQuote(remote.rootPath("runtime", "backups")),
		"OPENLIA_RUNTIME_UID='10000'",
		"OPENLIA_RUNTIME_GID='10000'",
		"OPENLIA_OPERATION_LOCK=" + shellQuote(remote.Config.InstallRoot+".operation.lock"),
		"OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE=" + shellQuote(knownHosts),
		"OPENLIA_NETWORK_NAME=" + shellQuote(remote.Config.Project+"-private"),
	}
	return strings.Join(values, " ")
}

func (remote Remote) operationCommandForRoot(operationRoot, operation string, args ...string) string {
	version := currentVersionInfo()
	knownHosts := remote.Config.BackupKnownHosts
	if knownHosts == "" {
		knownHosts = "/root/.ssh/known_hosts"
	}
	relayConfigPath, relaySecretsPath := "", ""
	if remote.Config.LochoRelayConfigSource != "" {
		relayConfigPath = remote.rootPath("runtime", "locho", "relay.toml")
	}
	if remote.Config.LochoRelaySecretsSource != "" {
		relaySecretsPath = remote.rootPath("runtime", "locho-relay-secrets", "relay.env")
	}
	environment := []string{
		"OPENLIA_LOCAL_MODE='false'",
		"OPENLIA_RUNTIME_UID='10000'",
		"OPENLIA_RUNTIME_GID='10000'",
		"OPENLIA_REPO_ROOT=" + shellQuote(operationRoot),
		"OPENLIA_RUNTIME_ROOT=" + shellQuote(remote.rootPath("runtime")),
		"OPENLIA_INSTALL_ROOT=" + shellQuote(remote.Config.InstallRoot),
		"OPENLIA_PROJECT_NAME=" + shellQuote(remote.Config.Project),
		"OPENLIA_NETWORK_NAME=" + shellQuote(remote.Config.Project+"-private"),
		"OPENLIA_PROVIDER=" + shellQuote(remote.Config.Provider),
		"OPENLIA_EXTERNAL_NETWORK=" + shellQuote(remote.Config.ExternalNetwork),
		"OPENLIA_MODEL=" + shellQuote(remote.Config.Model),
		"OPENLIA_OUTPUT_LANGUAGE=" + shellQuote(remote.Config.OutputLanguage),
		"OPENLIA_VERSION=" + shellQuote(version.Version),
		"OPENLIA_REVISION=" + shellQuote(version.Revision),
		"OPENLIA_FALLBACK_PROVIDERS=" + shellQuote(renderFallbackProvidersJSON(remote.Config.FallbackProviders)),
		"HERMES_TIMEZONE=" + shellQuote(remote.Config.Timezone),
		"OPENLIA_HERMES_IMAGE=" + shellQuote(hermesImage(remote.Config)),
		"OPENLIA_HERMES_VERSION=" + shellQuote(remote.Config.HermesTag),
		"OPENLIA_LOCHO_IMAGE=" + shellQuote(remote.Config.LochoImage),
		"OPENLIA_LOCHO_VERSION=" + shellQuote(remote.Config.LochoVersion),
		"OPENLIA_LOCHO_X86_64_SHA256=" + shellQuote(remote.Config.LochoX8664SHA256),
		"OPENLIA_LOCHO_ARM64_SHA256=" + shellQuote(remote.Config.LochoARM64SHA256),
		"OPENLIA_LOCHO_RELAY_CONFIG=" + shellQuote(relayConfigPath),
		"OPENLIA_LOCHO_RELAY_SECRETS=" + shellQuote(relaySecretsPath),
		"HERMES_BASE_IMAGE=" + shellQuote(releaseinfo.Default.Hermes.Image),
		"HERMES_BASE_TAG=" + shellQuote(remote.Config.HermesTag),
		"HERMES_BASE_DIGEST=" + shellQuote(remote.Config.HermesDigest),
		"DEBIAN_SNAPSHOT=" + shellQuote(toolcatalog.DefaultDebianSnapshot),
		"OPENLIA_API_ENABLED=" + shellQuote(strconv.FormatBool(remote.Config.APIEnabled)),
		"OPENLIA_API_HOST=" + shellQuote(remote.Config.APIHost),
		"OPENLIA_WORKSPACE_UI_HOST=" + shellQuote(remote.Config.WorkspaceUIHost),
		"OPENLIA_WORKSPACE_UI_PORT=" + shellQuote(strconv.Itoa(remote.Config.WorkspaceUIPort)),
		"OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN=" + shellQuote(remote.Config.WorkspaceUIPublicOrigin),
		"OPENLIA_WORKSPACE_UI_AUTH_REQUIRED=" + shellQuote(strconv.FormatBool(workspaceUIPasswordRequired(remote.Config))),
		"OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE=" + shellQuote(remote.rootPath("runtime", "secrets", "workspace-ui-password.hash")),
		"OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS=" + shellQuote(strings.Join(remote.Config.WorkspaceUIAllowedEmails, ",")),
		"OPENLIA_WORKSPACE_UI_FIREBASE_PROJECT_ID=" + shellQuote(remote.Config.WorkspaceUIFirebaseProjectID),
		"OPENLIA_WORKSPACE_UI_FIREBASE_API_KEY=" + shellQuote(remote.Config.WorkspaceUIFirebaseAPIKey),
		"OPENLIA_WORKSPACE_UI_FIREBASE_AUTH_DOMAIN=" + shellQuote(remote.Config.WorkspaceUIFirebaseAuthDomain),
		"OPENLIA_WORKSPACE_UI_FIREBASE_APP_ID=" + shellQuote(remote.Config.WorkspaceUIFirebaseAppID),
		"OPENLIA_LOCHO_HOST_ENABLED=" + shellQuote(strconv.FormatBool(remote.Config.LochoHostEnabled)),
		"OPENLIA_DATA_ROOT=" + shellQuote(remote.rootPath("runtime", "hermes")),
		"OPENLIA_SYSTEM_SKILLS_ROOT=" + shellQuote(remote.rootPath("runtime", "system-skills")),
		"OPENLIA_LOCHO_ROOT=" + shellQuote(remote.rootPath("runtime", "locho")),
		"OPENLIA_SECRET_FILE=" + shellQuote(remote.rootPath("runtime", "secrets", "hermes.env")),
		"OPENLIA_SECRET_DIR=" + shellQuote(remote.rootPath("runtime", "secrets")),
		"OPENLIA_BACKUP_ROOT=" + shellQuote(remote.rootPath("runtime", "backups")),
		"OPENLIA_META_ROOT=" + shellQuote(remote.rootPath("runtime", "meta")),
		"OPENLIA_OPERATION_LOCK=" + shellQuote(remote.Config.InstallRoot+".operation.lock"),
		"OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE=" + shellQuote(knownHosts),
		"OPENLIA_BACKUP_RECIPIENT=" + shellQuote(remote.Config.BackupRecipient),
		"OPENLIA_BACKUP_SCHEDULE=" + shellQuote(remote.Config.BackupSchedule),
		"OPENLIA_BACKUP_SCHEDULE_ENABLED=" + shellQuote(strconv.FormatBool(remote.Config.BackupScheduleEnabled)),
		"OPENLIA_BACKUP_RETENTION=" + shellQuote(strconv.Itoa(remote.Config.BackupLocalRetention)),
		"OPENLIA_BACKUP_MAX_BYTES=" + shellQuote(strconv.FormatInt(remote.Config.BackupLocalMaxBytes, 10)),
		"OPENLIA_WORKSPACE_GIT_SCHEDULE=" + shellQuote(remote.Config.WorkspaceGitSchedule),
		"OPENLIA_WORKSPACE_GIT_ENABLED=" + shellQuote(strconv.FormatBool(remote.Config.WorkspaceGitEnabled)),
		"OPENLIA_BACKUP_REMOTE_RETENTION_DAYS=" + shellQuote(strconv.Itoa(remote.Config.BackupRemoteRetentionDays)),
		"OPENLIA_BACKUP_DESTINATIONS=" + shellQuote(renderBackupDestinationsJSON(remote.Config.BackupDestinations, remote.Config.InstallRoot)),
		"OPENLIA_COMPOSE_FILE=" + shellQuote(filepath.Join(operationRoot, "docker", "compose.yaml")),
		"OPENLIA_COMPOSE_PROJECT_DIR=" + shellQuote(filepath.Join(operationRoot, "docker")),
		"OPENLIA_GENERATED_COMPOSE=" + shellQuote(filepath.Join(operationRoot, "docker", "compose.generated.yaml")),
		"OPENLIA_ENABLED_SKILLS=" + shellQuote(strings.Join(remote.Config.EnabledSkills, ",")),
		"OPENLIA_INGESTION_MAX_CONCURRENT_JOBS=" + shellQuote(strconv.Itoa(remote.Config.IngestionMaxConcurrentJobs)),
		"OPENLIA_SKILLS_CONFIGURED='true'",
		"OPENLIA_SERVICE_ROLES=" + shellQuote(renderServicesJSON(remote.Config.Services)),
		"OPENLIA_CONFIGURED_HOSTS=" + shellQuote(configuredHosts(remote.Config.Services)),
	}
	legacyScript := legacyOperationScript(operation)
	scriptCommand := shellQuote(filepath.Join(operationRoot, legacyScript))
	if operatorArgs, ok := operatorArguments(operation, args); ok {
		operatorPaths := map[string]string{
			"amd64": filepath.Join(operationRoot, "operator", "linux-amd64", "openlia-operator"),
			"arm64": filepath.Join(operationRoot, "operator", "linux-arm64", "openlia-operator"),
		}
		if operatorOnlyOperation(operation) {
			return "operator_path=''; case \"$(uname -m)\" in x86_64|amd64) operator_path=" + shellQuote(operatorPaths["amd64"]) + ";; aarch64|arm64) operator_path=" + shellQuote(operatorPaths["arm64"]) + ";; esac; if [ -n \"$operator_path\" ] && { [ -x \"$operator_path\" ] || (command -v sudo >/dev/null 2>&1 && sudo -n test -x \"$operator_path\"); }; then " + privilegedEnvironmentCommand(environment, "\"$operator_path\"", operatorArgs...) + "; else printf '%s\\n' 'OpenLia Go operator is required for this operation' >&2; exit 3; fi"
		}
		return "operator_path=''; case \"$(uname -m)\" in x86_64|amd64) operator_path=" + shellQuote(operatorPaths["amd64"]) + ";; aarch64|arm64) operator_path=" + shellQuote(operatorPaths["arm64"]) + ";; esac; if [ -n \"$operator_path\" ] && { [ -x \"$operator_path\" ] || (command -v sudo >/dev/null 2>&1 && sudo -n test -x \"$operator_path\"); }; then " + privilegedEnvironmentCommand(environment, "\"$operator_path\"", operatorArgs...) + "; else " + privilegedEnvironmentCommand(environment, scriptCommand, args...) + "; fi"
	}
	return privilegedEnvironmentCommand(environment, scriptCommand, args...)
}

func (remote Remote) operation(ctx context.Context, script string, input []byte, args ...string) ([]byte, error) {
	command := remote.operationCommand(script, args...)
	if remoteOperationReadOnly(script, args) {
		return remote.ssh(ctx, command, input)
	}
	return remote.lockedSSH(ctx, command, input)
}

func remoteOperationReadOnly(script string, args []string) bool {
	switch filepath.ToSlash(script) {
	case "healthcheck", "skill-status", "locho-host", "workspace-export":
		return true
	case "instructions":
		return len(args) > 0 && (args[0] == "status" || args[0] == "diff")
	case "workspace-git":
		return len(args) > 0 && args[0] == "status"
	case "workspace-migrate":
		return len(args) > 0 && (args[0] == "status" || args[0] == "diff" || args[0] == "list" || args[0] == "stop")
	default:
		return false
	}
}

// lockedSSH serializes mutating remote operations and releases the lock when
// the SSH process exits. flock avoids stale lock files after a disconnected
// operator or a crashed remote process.
func (remote Remote) lockedSSH(ctx context.Context, command string, input []byte) ([]byte, error) {
	return remote.lockedSSHReader(ctx, command, bytes.NewReader(input))
}

func (remote Remote) lockedSSHReader(ctx context.Context, command string, input io.Reader) ([]byte, error) {
	lockPath := remote.Config.InstallRoot + ".operation.lock"
	rootCommand := "set -eu; command -v flock >/dev/null 2>&1 || { printf '%s\\n' 'flock is required for serialized OpenLia operations' >&2; exit 69; }; exec 9>" + shellQuote(lockPath) + "; if ! flock -n 9; then printf '%s\\n' 'another OpenLia operation is already running' >&2; exit 75; fi; " + command
	return remote.sshReader(ctx, privilegedCommand(rootCommand), input)
}

func privilegedEnvironmentCommand(environment []string, executable string, args ...string) string {
	quotedArgs := make([]string, 0, len(args))
	for _, arg := range args {
		quotedArgs = append(quotedArgs, shellQuote(arg))
	}
	arguments := strings.Join(quotedArgs, " ")
	passthrough := []string{
		`AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID-}"`,
		`AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY-}"`,
		`AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN-}"`,
		`AWS_PROFILE="${AWS_PROFILE-}"`,
		`AWS_REGION="${AWS_REGION-}"`,
		`AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION-}"`,
	}
	environmentCommand := strings.Join(append(append([]string{}, environment...), passthrough...), " ")
	return "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n env " + environmentCommand + " " + executable + " " + arguments + "; else env " + strings.Join(unprivilegedEnvironment(environment), " ") + " " + strings.Join(passthrough, " ") + " " + executable + " " + arguments + "; fi"
}

func unprivilegedEnvironment(environment []string) []string {
	values := append([]string(nil), environment...)
	for index, value := range values {
		switch {
		case strings.HasPrefix(value, "OPENLIA_RUNTIME_UID="):
			values[index] = `OPENLIA_RUNTIME_UID="$(id -u)"`
		case strings.HasPrefix(value, "OPENLIA_RUNTIME_GID="):
			values[index] = `OPENLIA_RUNTIME_GID="$(id -g)"`
		}
	}
	return values
}

func operatorArguments(operation string, args []string) ([]string, bool) {
	var command string
	switch filepath.ToSlash(operation) {
	case "bootstrap":
		command = "bootstrap"
	case "profile":
		command = "profile"
	case "skill-status":
		command = "skill-status"
	case "skill-fork":
		command = "skill-fork"
	case "skill-migration":
		command = "skill-migration"
	case "backup":
		command = "backup"
	case "attachments":
		command = "attachments"
	case "locho-host":
		command = "locho-host"
	case "auth":
		command = "auth"
	case "deploy":
		command = "deploy"
	case "healthcheck":
		command = "healthcheck"
	case "workspace-git":
		command = "workspace-git"
	case "uninstall":
		command = "uninstall"
	case "workspace-migrate":
		command = "workspace-migrate"
	case "workspace-export":
		command = "workspace-export"
	case "instructions":
		command = "instructions"
	case "features":
		command = "features"
	case "ops/bootstrap.sh":
		command = "bootstrap"
	case "ops/profile.sh":
		command = "profile"
	case "ops/skill-status.sh":
		command = "skill-status"
	case "ops/backup.sh":
		command = "backup"
	case "ops/attachments.sh":
		command = "attachments"
	case "ops/auth.sh":
		command = "auth"
	case "ops/deploy.sh":
		command = "deploy"
	case "ops/healthcheck.sh":
		command = "healthcheck"
	case "ops/workspace-git.sh":
		command = "workspace-git"
	case "ops/uninstall.sh":
		command = "uninstall"
	default:
		return nil, false
	}
	return append([]string{command}, args...), true
}

func operatorOnlyOperation(operation string) bool {
	switch filepath.ToSlash(operation) {
	case "workspace-git", "ops/workspace-git.sh", "workspace-migrate", "workspace-export", "instructions", "features":
		return true
	default:
		return false
	}
}

func legacyOperationScript(operation string) string {
	switch operation {
	case "bootstrap", "ops/bootstrap.sh":
		return "ops/bootstrap.sh"
	case "profile", "ops/profile.sh":
		return "ops/profile.sh"
	case "skill-status", "ops/skill-status.sh":
		return "ops/skill-status.sh"
	case "skill-fork":
		return "ops/skill-fork.sh"
	case "skill-migration":
		return "ops/skill-migration.sh"
	case "backup", "ops/backup.sh":
		return "ops/backup.sh"
	case "attachments", "ops/attachments.sh":
		return "ops/attachments.sh"
	case "auth", "ops/auth.sh":
		return "ops/auth.sh"
	case "deploy", "ops/deploy.sh":
		return "ops/deploy.sh"
	case "healthcheck", "ops/healthcheck.sh":
		return "ops/healthcheck.sh"
	case "workspace-git", "ops/workspace-git.sh":
		return "ops/workspace-git.sh"
	case "uninstall", "ops/uninstall.sh":
		return "ops/uninstall.sh"
	default:
		return operation
	}
}

func workspaceGitArguments(action string) []string {
	return []string{action, "--json"}
}

func (remote Remote) workspaceGit(ctx context.Context, action string) ([]byte, error) {
	return remote.operation(ctx, "workspace-git", nil, workspaceGitArguments(action)...)
}

func (remote Remote) uninstall(ctx context.Context) ([]byte, error) {
	current := remote.rootPath("current")
	script := filepath.Join(current, "ops", "uninstall.sh")
	operatorAMD64 := filepath.Join(current, "operator", "linux-amd64", "openlia-operator")
	operatorARM64 := filepath.Join(current, "operator", "linux-arm64", "openlia-operator")
	command := "if [ -x " + shellQuote(operatorAMD64) + " ] || [ -x " + shellQuote(operatorARM64) + " ] || [ -x " + shellQuote(script) + " ]; then " +
		remote.operationCommandForRoot(current, "uninstall", "--json") +
		"; else " + privilegedCommand(remote.legacyUninstallCommand(current)) + "; fi"
	result, err := remote.lockedSSH(ctx, command, nil)
	if err != nil {
		return result, err
	}
	if _, err := remote.ssh(ctx, privilegedCommand("rm -f -- "+shellQuote(remote.Config.InstallRoot+".operation.lock")), nil); err != nil {
		return result, fmt.Errorf("installation removed but operation lock cleanup failed: %w", err)
	}
	return result, nil
}

func privilegedCommand(command string) string {
	return "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n sh -c " + shellQuote(command) + "; else " + command + "; fi"
}

func (remote Remote) legacyUninstallCommand(current string) string {
	installRoot := shellQuote(remote.Config.InstallRoot)
	composeFile := shellQuote(filepath.Join(current, "docker", "compose.yaml"))
	generatedCompose := shellQuote(filepath.Join(current, "docker", "compose.generated.yaml"))
	composeDirectory := shellQuote(filepath.Join(current, "docker"))
	project := shellQuote(remote.Config.Project)
	network := shellQuote(remote.Config.Project + "-private")
	marker := shellQuote(remote.rootPath("runtime", "meta", "runtime.json"))
	composeBase := remote.composeEnvironment() + " docker compose --project-name " + project + " --project-directory " + composeDirectory + " -f " + composeFile
	return "set -eu; " +
		"if [ ! -e " + installRoot + " ]; then printf '%s\\n' '{\"ok\":true,\"action\":\"uninstall\",\"state\":\"absent\",\"images\":\"preserved\"}'; exit 0; fi; " +
		"test -d " + installRoot + "; test ! -L " + installRoot + "; test -f " + marker + "; " +
		"if [ -f " + composeFile + " ]; then if [ -f " + generatedCompose + " ]; then " + composeBase + " -f " + generatedCompose + " down --remove-orphans; else " + composeBase + " down --remove-orphans; fi; else containers=$(docker ps -aq --filter label=com.docker.compose.project=" + project + "); if [ -n \"$containers\" ]; then docker rm -f $containers >/dev/null; fi; fi; " +
		"remaining=$(docker ps -aq --filter label=com.docker.compose.project=" + project + "); test -z \"$remaining\"; " +
		"if docker network inspect " + network + " >/dev/null 2>&1; then network_project=$(docker network inspect " + network + " --format '{{index .Labels \"com.docker.compose.project\"}}' 2>/dev/null || true); if [ \"$network_project\" = " + project + " ]; then docker network rm " + network + " >/dev/null; else test -z \"$network_project\"; fi; fi; " +
		"if docker network inspect " + network + " >/dev/null 2>&1; then exit 1; fi; " +
		"rm -rf -- " + installRoot + "; test ! -e " + installRoot + "; printf '%s\\n' '{\"ok\":true,\"action\":\"uninstall\",\"state\":\"removed\",\"containers\":\"removed\",\"network\":\"removed\",\"images\":\"preserved\"}'"
}

func (remote Remote) uploadRelease(ctx context.Context, archive []byte, digest string) error {
	release := remote.releasePath()
	if !safeVersion(remote.Config.Version) {
		return fmt.Errorf("invalid release version")
	}
	if len(digest) != sha256.Size*2 || strings.Trim(digest, "0123456789abcdef") != "" {
		return fmt.Errorf("invalid release digest")
	}
	checksum := shellQuote(digest + "\n")
	marker := "{\"schema\":1,\"install_root\":\"" + strings.ReplaceAll(remote.Config.InstallRoot, "\\", "\\\\") + "\",\"project\":\"" + strings.ReplaceAll(remote.Config.Project, "\\", "\\\\") + "\",\"network\":\"" + strings.ReplaceAll(remote.Config.Project+"-private", "\\", "\\\\") + "\"}\n"
	releases := remote.rootPath("releases")
	archivePath := filepath.Join(releases, ".upload-"+remote.Config.Version+"-"+digest+".tar.gz")
	staging := filepath.Join(releases, ".staging-"+remote.Config.Version+"-"+digest)
	rootCommand := "set -eu; cleanup() { rm -rf -- " + shellQuote(staging) + " " + shellQuote(archivePath) + "; }; trap cleanup EXIT; mkdir -p " + shellQuote(releases) + " " + shellQuote(remote.rootPath("runtime", "meta")) + "; rm -rf -- " + shellQuote(staging) + "; rm -f -- " + shellQuote(archivePath) + "; cat > " + shellQuote(archivePath) + "; actual=$(sha256sum " + shellQuote(archivePath) + " | cut -d ' ' -f1); test \"$actual\" = " + shellQuote(digest) + "; mkdir " + shellQuote(staging) + "; tar -xzf " + shellQuote(archivePath) + " -C " + shellQuote(staging) + "; test -x " + shellQuote(filepath.Join(staging, "operator", "linux-arm64", "openlia-operator")) + " -o -x " + shellQuote(filepath.Join(staging, "operator", "linux-amd64", "openlia-operator")) + "; printf %s " + checksum + " > " + shellQuote(filepath.Join(staging, "release.sha256")) + "; chmod 600 " + shellQuote(filepath.Join(staging, "release.sha256")) + "; rm -rf -- " + shellQuote(release) + "; mv -- " + shellQuote(staging) + " " + shellQuote(release) + "; printf %s " + shellQuote(marker) + " > " + shellQuote(remote.rootPath("runtime", "meta", "runtime.json")) + "; chmod 600 " + shellQuote(remote.rootPath("runtime", "meta", "runtime.json"))
	_, err := remote.lockedSSH(ctx, rootCommand, archive)
	return err
}

func (remote Remote) activateRelease(ctx context.Context) error {
	current := remote.rootPath("current")
	marker := "{\"schema\":1,\"install_root\":\"" + strings.ReplaceAll(remote.Config.InstallRoot, "\\", "\\\\") + "\",\"project\":\"" + strings.ReplaceAll(remote.Config.Project, "\\", "\\\\") + "\",\"network\":\"" + strings.ReplaceAll(remote.Config.Project+"-private", "\\", "\\\\") + "\"}\n"
	rootCommand := "set -eu; mkdir -p " + shellQuote(remote.rootPath("releases")) + " " + shellQuote(remote.rootPath("runtime", "meta")) + "; ln -sfn " + shellQuote(remote.releasePath()) + " " + shellQuote(current) + "; printf %s " + shellQuote(marker) + " > " + shellQuote(remote.rootPath("runtime", "meta", "runtime.json")) + "; chmod 600 " + shellQuote(remote.rootPath("runtime", "meta", "runtime.json"))
	_, err := remote.lockedSSH(ctx, rootCommand, nil)
	return err
}

func (remote Remote) bootstrap(ctx context.Context) ([]byte, error) {
	return remote.operation(ctx, "bootstrap", nil, "--json")
}

func (remote Remote) deploy(ctx context.Context, action string, start bool, component string) ([]byte, error) {
	args := []string{action, "--json", "--component", component}
	if start {
		args = append(args, "--start")
	}
	return remote.operation(ctx, "deploy", nil, args...)
}

func (remote Remote) health(ctx context.Context, allowStopped, providerCheck bool) ([]byte, error) {
	args := []string{"--json"}
	if allowStopped {
		args = append(args, "--allow-stopped")
	}
	if providerCheck {
		args = append(args, "--provider-check")
	}
	return remote.operation(ctx, "healthcheck", nil, args...)
}

func (remote Remote) composeLogs(ctx context.Context, follow bool) ([]byte, error) {
	base := filepath.Join(remote.releasePath(), "docker", "compose.yaml")
	generated := filepath.Join(remote.releasePath(), "docker", "compose.generated.yaml")
	compose := remote.composeEnvironment() + " docker compose --project-name " + shellQuote(remote.Config.Project) + " --project-directory " + shellQuote(filepath.Join(remote.releasePath(), "docker")) + " -f " + shellQuote(base)
	command := "set -eu; if [ -f " + shellQuote(generated) + " ]; then " + compose + " -f " + shellQuote(generated) + " logs --tail 200; else " + compose + " logs --tail 200; fi"
	if follow {
		command += " --follow"
	}
	return remote.ssh(ctx, command, nil)
}

func (remote Remote) uploadFile(ctx context.Context, source, destination string, mode os.FileMode) error {
	file, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("read upload source: %w", err)
	}
	defer file.Close()
	if err := validateAbsoluteRoot(destination, "upload destination"); err != nil {
		return err
	}
	temporary := destination + ".tmp-openlia"
	rootCommand := "set -eu; mkdir -p " + shellQuote(filepath.Dir(destination)) + "; umask 077; cat > " + shellQuote(temporary) + "; chmod " + shellQuote(fmt.Sprintf("%o", mode.Perm())) + " " + shellQuote(temporary) + "; mv -f " + shellQuote(temporary) + " " + shellQuote(destination)
	command := "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n sh -c " + shellQuote(rootCommand) + "; else " + rootCommand + "; fi"
	_, err = remote.lockedSSHReader(ctx, command, file)
	return err
}

func (remote Remote) downloadFile(ctx context.Context, source, destination string) error {
	backupRoot := remote.rootPath("runtime", "backups")
	if !filepath.IsAbs(source) || !operatorPathWithin(source, backupRoot) {
		return fmt.Errorf("download source must be inside the OpenLia backup directory")
	}
	// Reject symlink sources so a target-side backup path cannot redirect the
	// operator download to arbitrary runtime data.
	if err := remote.statBackupPath(ctx, source); err != nil {
		return fmt.Errorf("download source must be a regular backup file")
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	command := "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n cat -- " + shellQuote(source) + "; else cat -- " + shellQuote(source) + "; fi"
	ssh, err := exec.LookPath("ssh")
	if err != nil {
		_ = output.Close()
		_ = os.Remove(destination)
		return fmt.Errorf("ssh is required: %w", err)
	}
	process := exec.CommandContext(ctx, ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3", "--", remote.Config.Target, command)
	var stderr bytes.Buffer
	process.Stdout = output
	process.Stderr = io.MultiWriter(&stderr, os.Stderr)
	if err := process.Run(); err != nil {
		_ = output.Close()
		_ = os.Remove(destination)
		return fmt.Errorf("remote backup download failed: %s", strings.TrimSpace(redact(stderr.String())))
	}
	if err := output.Sync(); err != nil {
		_ = output.Close()
		_ = os.Remove(destination)
		return err
	}
	return output.Close()
}

func (remote Remote) statBackupPath(ctx context.Context, source string) error {
	command := "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n stat -c '%F' -- " + shellQuote(source) + "; else stat -c '%F' -- " + shellQuote(source) + "; fi"
	output, err := remote.ssh(ctx, command, nil)
	if err != nil || strings.TrimSpace(string(output)) != "regular file" {
		return fmt.Errorf("backup source is not a regular file")
	}
	return nil
}

type Local struct {
	Config Config
}

func (local Local) rootPath(parts ...string) string {
	items := append([]string{local.Config.InstallRoot}, parts...)
	return filepath.Join(items...)
}

func operationEnvironment(config Config, operationRoot string) []string {
	version := currentVersionInfo()
	operatorConfigFile := configPath()
	if absolute, err := filepath.Abs(operatorConfigFile); err == nil {
		operatorConfigFile = absolute
	}
	home, _ := os.UserHomeDir()
	knownHosts := config.BackupKnownHosts
	if knownHosts == "" {
		knownHosts = filepath.Join(home, ".ssh", "known_hosts")
	}
	relayConfigPath, relaySecretsPath := "", ""
	if config.LochoRelayConfigSource != "" {
		relayConfigPath = filepath.Join(config.InstallRoot, "runtime", "locho", "relay.toml")
	}
	if config.LochoRelaySecretsSource != "" {
		relaySecretsPath = filepath.Join(config.InstallRoot, "runtime", "locho-relay-secrets", "relay.env")
	}
	return []string{
		"OPENLIA_CLI_CONFIG_FILE=" + operatorConfigFile,
		"OPENLIA_LOCAL_MODE=true",
		"OPENLIA_RUNTIME_UID=" + strconv.Itoa(os.Getuid()),
		"OPENLIA_RUNTIME_GID=" + strconv.Itoa(os.Getgid()),
		"OPENLIA_REPO_ROOT=" + operationRoot,
		"OPENLIA_RUNTIME_ROOT=" + filepath.Join(config.InstallRoot, "runtime"),
		"OPENLIA_INSTALL_ROOT=" + config.InstallRoot,
		"OPENLIA_PROJECT_NAME=" + config.Project,
		"OPENLIA_NETWORK_NAME=" + config.Project + "-private",
		"OPENLIA_PROVIDER=" + config.Provider,
		"OPENLIA_EXTERNAL_NETWORK=" + config.ExternalNetwork,
		"OPENLIA_MODEL=" + config.Model,
		"OPENLIA_OUTPUT_LANGUAGE=" + config.OutputLanguage,
		"OPENLIA_VERSION=" + version.Version,
		"OPENLIA_REVISION=" + version.Revision,
		"OPENLIA_FALLBACK_PROVIDERS=" + renderFallbackProvidersJSON(config.FallbackProviders),
		"HERMES_TIMEZONE=" + config.Timezone,
		"OPENLIA_HERMES_IMAGE=" + hermesImage(config),
		"OPENLIA_HERMES_VERSION=" + config.HermesTag,
		"OPENLIA_LOCHO_IMAGE=" + config.LochoImage,
		"OPENLIA_LOCHO_VERSION=" + config.LochoVersion,
		"OPENLIA_LOCHO_X86_64_SHA256=" + config.LochoX8664SHA256,
		"OPENLIA_LOCHO_ARM64_SHA256=" + config.LochoARM64SHA256,
		"OPENLIA_LOCHO_RELAY_CONFIG=" + relayConfigPath,
		"OPENLIA_LOCHO_RELAY_SECRETS=" + relaySecretsPath,
		"HERMES_BASE_IMAGE=" + releaseinfo.Default.Hermes.Image,
		"HERMES_BASE_TAG=" + config.HermesTag,
		"HERMES_BASE_DIGEST=" + config.HermesDigest,
		"DEBIAN_SNAPSHOT=" + toolcatalog.DefaultDebianSnapshot,
		"OPENLIA_API_ENABLED=" + strconv.FormatBool(config.APIEnabled),
		"OPENLIA_API_HOST=" + config.APIHost,
		"OPENLIA_WORKSPACE_UI_HOST=" + config.WorkspaceUIHost,
		"OPENLIA_WORKSPACE_UI_PORT=" + strconv.Itoa(config.WorkspaceUIPort),
		"OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN=" + config.WorkspaceUIPublicOrigin,
		"OPENLIA_WORKSPACE_UI_AUTH_REQUIRED=" + strconv.FormatBool(workspaceUIPasswordRequired(config)),
		"OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE=" + filepath.Join(config.InstallRoot, "runtime", "secrets", "workspace-ui-password.hash"),
		"OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS=" + strings.Join(config.WorkspaceUIAllowedEmails, ","),
		"OPENLIA_WORKSPACE_UI_FIREBASE_PROJECT_ID=" + config.WorkspaceUIFirebaseProjectID,
		"OPENLIA_WORKSPACE_UI_FIREBASE_API_KEY=" + config.WorkspaceUIFirebaseAPIKey,
		"OPENLIA_WORKSPACE_UI_FIREBASE_AUTH_DOMAIN=" + config.WorkspaceUIFirebaseAuthDomain,
		"OPENLIA_WORKSPACE_UI_FIREBASE_APP_ID=" + config.WorkspaceUIFirebaseAppID,
		"OPENLIA_LOCHO_HOST_ENABLED=" + strconv.FormatBool(config.LochoHostEnabled),
		"OPENLIA_DATA_ROOT=" + filepath.Join(config.InstallRoot, "runtime", "hermes"),
		"OPENLIA_SYSTEM_SKILLS_ROOT=" + filepath.Join(config.InstallRoot, "runtime", "system-skills"),
		"OPENLIA_LOCHO_ROOT=" + filepath.Join(config.InstallRoot, "runtime", "locho"),
		"OPENLIA_SECRET_FILE=" + filepath.Join(config.InstallRoot, "runtime", "secrets", "hermes.env"),
		"OPENLIA_SECRET_DIR=" + filepath.Join(config.InstallRoot, "runtime", "secrets"),
		"OPENLIA_BACKUP_ROOT=" + filepath.Join(config.InstallRoot, "runtime", "backups"),
		"OPENLIA_META_ROOT=" + filepath.Join(config.InstallRoot, "runtime", "meta"),
		"OPENLIA_OPERATION_LOCK=" + config.InstallRoot + ".operation.lock",
		"OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE=" + knownHosts,
		"OPENLIA_BACKUP_RECIPIENT=" + config.BackupRecipient,
		"OPENLIA_BACKUP_SCHEDULE=" + config.BackupSchedule,
		"OPENLIA_BACKUP_SCHEDULE_ENABLED=" + strconv.FormatBool(config.BackupScheduleEnabled),
		"OPENLIA_BACKUP_RETENTION=" + strconv.Itoa(config.BackupLocalRetention),
		"OPENLIA_BACKUP_MAX_BYTES=" + strconv.FormatInt(config.BackupLocalMaxBytes, 10),
		"OPENLIA_WORKSPACE_GIT_SCHEDULE=" + config.WorkspaceGitSchedule,
		"OPENLIA_WORKSPACE_GIT_ENABLED=" + strconv.FormatBool(config.WorkspaceGitEnabled),
		"OPENLIA_BACKUP_REMOTE_RETENTION_DAYS=" + strconv.Itoa(config.BackupRemoteRetentionDays),
		"OPENLIA_BACKUP_DESTINATIONS=" + renderBackupDestinationsJSON(config.BackupDestinations, config.InstallRoot),
		"OPENLIA_META_ROOT=" + filepath.Join(config.InstallRoot, "runtime", "meta"),
		"OPENLIA_COMPOSE_FILE=" + filepath.Join(operationRoot, "docker", "compose.yaml"),
		"OPENLIA_COMPOSE_PROJECT_DIR=" + filepath.Join(operationRoot, "docker"),
		"OPENLIA_GENERATED_COMPOSE=" + filepath.Join(operationRoot, "docker", "compose.generated.yaml"),
		"OPENLIA_ENABLED_SKILLS=" + strings.Join(config.EnabledSkills, ","),
		"OPENLIA_INGESTION_MAX_CONCURRENT_JOBS=" + strconv.Itoa(config.IngestionMaxConcurrentJobs),
		"OPENLIA_SKILLS_CONFIGURED=true",
		"OPENLIA_SERVICE_ROLES=" + renderServicesJSON(config.Services),
		"OPENLIA_CONFIGURED_HOSTS=" + configuredHosts(config.Services),
	}
}

func renderBackupDestinationsJSON(values []BackupDestinationConfig, installRoot string) string {
	destinations := make([]operator.BackupDestination, 0, len(values))
	for _, value := range values {
		destination := operator.BackupDestination{
			Name:               value.Name,
			Type:               value.Type,
			Endpoint:           value.Endpoint,
			Bucket:             value.Bucket,
			Prefix:             value.Prefix,
			Region:             value.Region,
			PathStyle:          value.PathStyle,
			RsyncTarget:        value.RsyncTarget,
			IdentityFile:       value.IdentityFile,
			CredentialsProfile: value.WriterAWSProfile,
		}
		if value.WriterCredentialsFile != "" {
			destination.CredentialsFile = filepath.Join(installRoot, "runtime", "backup-credentials", value.Name, "credentials")
		}
		destinations = append(destinations, destination)
	}
	data, err := json.Marshal(destinations)
	if err != nil {
		return "[]"
	}
	return string(data)
}

func renderFallbackProvidersJSON(values []FallbackProviderConfig) string {
	data, err := json.Marshal(values)
	if err != nil {
		return "[]"
	}
	return string(data)
}

func configuredHosts(services []ServiceHostConfig) string {
	if len(services) == 0 {
		return ""
	}
	hosts := make([]string, 0, len(services))
	for _, host := range services {
		if host.Name != "" {
			hosts = append(hosts, host.Name)
		}
	}
	return strings.Join(hosts, ",")
}

func renderServicesJSON(services []ServiceHostConfig) string {
	if len(services) == 0 {
		return "{}"
	}
	m := make(map[string]string)
	for _, host := range services {
		for svc, role := range host.Roles {
			m[svc] = role
			if host.Name != "" {
				m[host.Name+"."+svc] = role
			}
		}
	}
	data, err := json.Marshal(m)
	if err != nil {
		return "{}"
	}
	return string(data)
}

func (local Local) command(ctx context.Context, operationRoot, script string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, "bash", append([]string{filepath.Join(operationRoot, script)}, args...)...)
	command.Env = append(os.Environ(), operationEnvironment(local.Config, operationRoot)...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		detail := strings.TrimSpace(redact(stderr.String()))
		if detail != "" {
			return stdout.Bytes(), fmt.Errorf("local command failed: %s", detail)
		}
		return stdout.Bytes(), fmt.Errorf("local command failed: %w", err)
	}
	return stdout.Bytes(), nil
}

func (local Local) operation(ctx context.Context, script string, input []byte, args ...string) ([]byte, error) {
	unlock := func() {}
	if !remoteOperationReadOnly(script, args) {
		var err error
		unlock, err = acquireLocalOperationLock(ctx, local.Config)
		if err != nil {
			return nil, err
		}
	}
	defer unlock()
	if operatorArgs, ok := operatorArguments(script, args); ok {
		return local.operator(ctx, local.releasePath(), input, operatorArgs...)
	}
	if len(input) != 0 {
		return nil, fmt.Errorf("local legacy operations do not accept stdin")
	}
	return local.command(ctx, local.releasePath(), script, args...)
}

func (local Local) operator(ctx context.Context, operationRoot string, input []byte, args ...string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	previous := make(map[string]string)
	present := make(map[string]bool)
	for _, value := range operationEnvironment(local.Config, operationRoot) {
		key, item, ok := strings.Cut(value, "=")
		if !ok {
			continue
		}
		previous[key] = os.Getenv(key)
		_, present[key] = os.LookupEnv(key)
		if err := os.Setenv(key, item); err != nil {
			return nil, err
		}
	}
	defer func() {
		for key, value := range previous {
			if present[key] {
				_ = os.Setenv(key, value)
			} else {
				_ = os.Unsetenv(key)
			}
		}
	}()

	var stdout, stderr bytes.Buffer
	code := operator.RunContext(ctx, args, bytes.NewReader(input), &stdout, &stderr)
	if code != operator.ExitOK {
		detail := strings.TrimSpace(redact(stderr.String()))
		if parsed := operatorError(stdout.Bytes()); parsed != "" {
			detail = parsed
		} else if detail == "" {
			detail = strings.TrimSpace(redact(stdout.String()))
		}
		if detail == "" {
			detail = fmt.Sprintf("operator exited with status %d", code)
		}
		return stdout.Bytes(), fmt.Errorf("local operator failed: %s", detail)
	}
	return stdout.Bytes(), nil
}

func operatorError(data []byte) string {
	var payload struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(data, &payload) == nil && payload.Error != "" {
		return redact(payload.Error)
	}
	return ""
}

func (local Local) workspaceGit(ctx context.Context, action string) ([]byte, error) {
	return local.operation(ctx, "workspace-git", nil, workspaceGitArguments(action)...)
}

func (local Local) releasePath() string {
	return local.rootPath("releases", local.Config.Version)
}

func (local Local) releaseDigest(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	raw, err := os.ReadFile(local.rootPath("current", "release.sha256"))
	if err != nil {
		return "", err
	}
	return normalizeReleaseDigest(raw)
}

func (local Local) workspaceUIReleaseDigest(ctx context.Context) (string, error) {
	if local.Config.WorkspaceUIHost == "" {
		return "", nil
	}
	root := local.rootPath("current")
	base := filepath.Join(root, "docker", "compose.yaml")
	generated := filepath.Join(root, "docker", "compose.generated.yaml")
	args := []string{"docker", "compose", "--project-name", local.Config.Project, "--project-directory", filepath.Join(root, "docker"), "-f", base}
	if _, err := os.Stat(generated); err == nil {
		args = append(args, "-f", generated)
	}
	args = append(args, "exec", "-T", "workspace-ui", "bun", "-e", fmt.Sprintf("fetch('http://127.0.0.1:%d/health').then(async response => { if (!response.ok) process.exit(1); console.log(await response.text()) })", local.Config.WorkspaceUIPort))
	raw, err := local.run(ctx, args...)
	if err != nil {
		return "", err
	}
	return parseWorkspaceUIReleaseDigest(raw)
}

func (local Local) uploadRelease(ctx context.Context, archive []byte, digest string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !safeVersion(local.Config.Version) {
		return fmt.Errorf("invalid release version")
	}
	actual := sha256.Sum256(archive)
	if fmt.Sprintf("%x", actual) != digest {
		return fmt.Errorf("release archive digest mismatch")
	}
	release := local.releasePath()
	if err := os.MkdirAll(release, 0o700); err != nil {
		return fmt.Errorf("create local release: %w", err)
	}
	meta := local.rootPath("runtime", "meta")
	if err := os.MkdirAll(meta, 0o700); err != nil {
		return fmt.Errorf("create local metadata directory: %w", err)
	}
	marker := fmt.Sprintf("{\"schema\":1,\"install_root\":%q,\"project\":%q,\"network\":%q}\n", local.Config.InstallRoot, local.Config.Project, local.Config.Project+"-private")
	if err := os.WriteFile(filepath.Join(meta, "runtime.json"), []byte(marker), 0o600); err != nil {
		return fmt.Errorf("write local installation marker: %w", err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return fmt.Errorf("open release archive: %w", err)
	}
	defer reader.Close()
	tarReader := tar.NewReader(reader)
	for {
		header, nextErr := tarReader.Next()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			return fmt.Errorf("read release archive: %w", nextErr)
		}
		name := filepath.Clean(filepath.FromSlash(header.Name))
		if name == "." || filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return fmt.Errorf("release archive contains unsafe path")
		}
		destination := filepath.Join(release, name)
		if header.Typeflag != tar.TypeReg {
			return fmt.Errorf("release archive contains unsupported entry")
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return fmt.Errorf("create release directory: %w", err)
		}
		file, createErr := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode)&0o777)
		if createErr != nil {
			return fmt.Errorf("create release file: %w", createErr)
		}
		_, copyErr := io.Copy(file, tarReader)
		closeErr := file.Close()
		if copyErr != nil {
			return fmt.Errorf("write release file: %w", copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close release file: %w", closeErr)
		}
	}
	return os.WriteFile(filepath.Join(release, "release.sha256"), []byte(digest+"\n"), 0o600)
}

func (local Local) activateRelease(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(local.rootPath("releases"), 0o700); err != nil {
		return fmt.Errorf("create local releases directory: %w", err)
	}
	current := local.rootPath("current")
	if info, err := os.Lstat(current); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return fmt.Errorf("local current path is not a symlink")
		}
		if err := os.Remove(current); err != nil {
			return fmt.Errorf("replace local current link: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect local current path: %w", err)
	}
	if err := os.Symlink(local.releasePath(), current); err != nil {
		return err
	}
	return nil
}

func (local Local) bootstrap(ctx context.Context) ([]byte, error) {
	return local.operation(ctx, "bootstrap", nil, "--json")
}

func (local Local) deploy(ctx context.Context, action string, start bool, component string) ([]byte, error) {
	args := []string{action, "--json", "--component", component}
	if start {
		args = append(args, "--start")
	}
	return local.operation(ctx, "deploy", nil, args...)
}

func (local Local) health(ctx context.Context, allowStopped, providerCheck bool) ([]byte, error) {
	args := []string{"--json"}
	if allowStopped {
		args = append(args, "--allow-stopped")
	}
	if providerCheck {
		args = append(args, "--provider-check")
	}
	return local.operation(ctx, "healthcheck", nil, args...)
}

func (local Local) uninstall(ctx context.Context) ([]byte, error) {
	unlock, err := acquireLocalOperationLock(ctx, local.Config)
	if err != nil {
		return nil, err
	}
	result, err := local.operator(ctx, local.rootPath("current"), nil, "uninstall", "--json")
	unlock()
	if err != nil {
		return result, err
	}
	if err := os.Remove(local.Config.InstallRoot + ".operation.lock"); err != nil && !os.IsNotExist(err) {
		return result, fmt.Errorf("installation removed but operation lock cleanup failed: %w", err)
	}
	return result, nil
}

func acquireLocalOperationLock(ctx context.Context, config Config) (func(), error) {
	path := config.InstallRoot + ".operation.lock"
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open local operation lock: %w", err)
	}
	for {
		err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return func() {
				_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
				_ = file.Close()
			}, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			_ = file.Close()
			return nil, fmt.Errorf("acquire local operation lock: %w", err)
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			_ = file.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (local Local) composeLogs(ctx context.Context, follow bool) ([]byte, error) {
	base := filepath.Join(local.releasePath(), "docker", "compose.yaml")
	generated := filepath.Join(local.releasePath(), "docker", "compose.generated.yaml")
	args := []string{"docker", "compose", "--project-name", local.Config.Project, "--project-directory", filepath.Join(local.releasePath(), "docker"), "-f", base}
	if _, err := os.Stat(generated); err == nil {
		args = append(args, "-f", generated)
	}
	args = append(args, "logs", "--tail", "200")
	if follow {
		args = append(args, "--follow")
	}
	return local.run(ctx, args...)
}

func (local Local) run(ctx context.Context, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, args[0], args[1:]...)
	command.Env = append(os.Environ(), operationEnvironment(local.Config, local.releasePath())...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		detail := strings.TrimSpace(redact(stderr.String()))
		if detail != "" {
			return stdout.Bytes(), fmt.Errorf("local command failed: %s", detail)
		}
		return stdout.Bytes(), fmt.Errorf("local command failed: %w", err)
	}
	return stdout.Bytes(), nil
}

func (local Local) uploadFile(ctx context.Context, source, destination string, mode os.FileMode) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateAbsoluteRoot(destination, "upload destination"); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("read upload source: %w", err)
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return fmt.Errorf("create upload directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".openlia-upload-*")
	if err != nil {
		return fmt.Errorf("create upload temporary file: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(mode.Perm()); err != nil {
		temporary.Close()
		return err
	}
	if _, err := io.Copy(temporary, input); err != nil {
		temporary.Close()
		return fmt.Errorf("write upload: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, destination); err != nil {
		return fmt.Errorf("activate upload: %w", err)
	}
	return nil
}

func (local Local) downloadFile(ctx context.Context, source, destination string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	backupRoot := filepath.Join(local.Config.InstallRoot, "runtime", "backups")
	if !filepath.IsAbs(source) || !operatorPathWithin(source, backupRoot) {
		return fmt.Errorf("download source must be inside the OpenLia backup directory")
	}
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("download source must be a regular backup file")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil {
		_ = os.Remove(destination)
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil {
			return syncErr
		}
		return closeErr
	}
	return nil
}

func operatorPathWithin(path, root string) bool {
	path, pathErr := filepath.Abs(path)
	root, rootErr := filepath.Abs(root)
	if pathErr != nil || rootErr != nil {
		return false
	}
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func (local Local) removeFile(ctx context.Context, destination string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateAbsoluteRoot(destination, "local file"); err != nil {
		return err
	}
	if err := os.Remove(destination); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (remote Remote) removeFile(ctx context.Context, destination string) error {
	if err := validateAbsoluteRoot(destination, "remote file"); err != nil {
		return err
	}
	command := "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n rm -f -- " + shellQuote(destination) + "; else rm -f -- " + shellQuote(destination) + "; fi"
	_, err := remote.lockedSSH(ctx, command, nil)
	return err
}

func remoteContext() (context.Context, context.CancelFunc) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	ctx, timeoutCancel := context.WithTimeout(ctx, 30*time.Minute)
	return ctx, func() {
		timeoutCancel()
		stop()
	}
}

func runLocalCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("%s: %s", name, strings.TrimSpace(redact(stderr.String())))
	}
	return stdout.Bytes(), nil
}
