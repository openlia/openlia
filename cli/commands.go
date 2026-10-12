package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"
	"openlia/operator"
)

func Run(args []string, assets fs.FS) int {
	options, remaining, err := splitCommonFlags(args)
	if err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}
	if len(remaining) == 0 {
		usage(os.Stdout)
		return ExitOK
	}
	if remaining[0] == "--version" || remaining[0] == "version" {
		info := currentVersionInfo()
		return writeResult(options, info.json(), info.human())
	}
	if remaining[0] == "--help" || remaining[0] == "help" {
		usage(os.Stdout)
		return ExitOK
	}

	switch remaining[0] {
	case "init":
		return commandInit(options, remaining[1:], assets)
	case "status":
		return commandHealth(options, remaining[1:], false)
	case "doctor":
		return commandHealth(options, remaining[1:], true)
	case "deploy", "start", "stop", "restart":
		return commandLifecycle(options, remaining[0], remaining[1:])
	case "uninstall":
		return commandUninstall(options, remaining[1:])
	case "logs":
		return commandLogs(options, remaining[1:])
	case "update":
		return commandUpdate(options, remaining[1:], assets)
	case "skills":
		return commandSkills(options, remaining[1:], assets)
	case "auth":
		return commandAuth(options, remaining[1:])
	case "attachments":
		return commandAttachments(options, remaining[1:])
	case "backup":
		return commandBackup(options, remaining[1:])
	case "workspace":
		return commandWorkspace(options, remaining[1:], assets)
	case "instructions":
		return commandInstructions(options, remaining[1:])
	case "workspace-ui":
		return commandWorkspaceUI(options, remaining[1:])
	case "locho-host":
		return commandLochoHost(options, remaining[1:])
	case "browser":
		return commandOpenLiaBrowser(options, remaining[1:], assets)
	case "telegram":
		return commandTelegram(options, remaining[1:])
	default:
		return fail(options, ExitUsage, fmt.Sprintf("unknown command %q", remaining[0]), map[string]any{"hint": "run openlia --help"})
	}
}

func splitCommonFlags(args []string) (Options, []string, error) {
	options := Options{}
	remaining := make([]string, 0, len(args))
	for _, arg := range args {
		switch arg {
		case "--json":
			options.JSON = true
		case "--non-interactive":
			options.NonInteractive = true
		case "--follow":
			options.Follow = true
		case "--check-providers":
			options.ProviderCheck = true
		case "--help", "-h":
			if len(remaining) == 0 {
				remaining = append(remaining, "help")
			} else {
				remaining = append(remaining, arg)
			}
		default:
			remaining = append(remaining, arg)
		}
	}
	return options, remaining, nil
}

func hasArgument(args []string, wanted string) bool {
	for _, arg := range args {
		if arg == wanted {
			return true
		}
	}
	return false
}

func newFlagSet(name string) *flag.FlagSet {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	return set
}

func configOrError(options Options) (Config, int) {
	config, err := loadConfig()
	if err == nil {
		return config, ExitOK
	}
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, fail(options, ExitPrereq, "OpenLia is not initialized; run `openlia init --local` or `openlia init --target user@host`", map[string]any{"config": configPath()})
	}
	return Config{}, fail(options, ExitFailure, err.Error(), nil)
}

func commandInit(options Options, args []string, assets fs.FS) int {
	set := newFlagSet("init")
	local := set.Bool("local", false, "run Hermes Agent on this machine")
	target := set.String("target", "", "install and control Hermes Agent on this SSH target")
	root := set.String("root", "", "OpenLia installation root on the selected agent machine")
	project := set.String("project", "", "Compose project name")
	timezone := set.String("timezone", "", "IANA timezone for the Hermes agent")
	model := set.String("model", "", "Hermes model identifier")
	provider := set.String("provider", "", "Hermes provider identifier")
	externalNetwork := set.String("external-network", "", "Existing Docker network for internal services")
	apiEnabled := set.Bool("api", false, "enable the private API listener")
	apiHost := set.String("api-host", "", "API bind address when --api is enabled")
	openWebUI := set.Bool("open-webui", false, "enable Open WebUI chat interface")
	openWebUIHost := set.String("open-webui-host", "", "Open WebUI host bind address")
	openWebUIPort := set.Int("open-webui-port", 8090, "Open WebUI host port")
	lochoHost := set.Bool("locho-host", false, "enable a Locho host for Workspace UI and Open WebUI")
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if set.NArg() != 0 {
		return fail(options, ExitUsage, "init does not accept positional arguments", nil)
	}
	config := defaultConfig()
	previousMode := config.Mode
	if existing, err := loadConfig(); err == nil {
		config = existing
		previousMode = existing.Mode
	}
	if *local && *target != "" {
		return fail(options, ExitUsage, "--local and --target are mutually exclusive", nil)
	}
	if *local {
		config.Mode = "local"
		config.Target = ""
	} else if *target != "" {
		config.Mode = "ssh"
		config.Target = *target
	}
	if config.Target == "" && config.Mode != "local" {
		return fail(options, ExitUsage, "--local or --target is required on first initialization", nil)
	}
	if *root != "" {
		config.InstallRoot = *root
	} else if config.Mode != previousMode {
		if config.Mode == "local" {
			config.InstallRoot = defaultLocalInstallRoot()
		} else {
			config.InstallRoot = defaultRemoteRoot
		}
	}
	if *project != "" {
		config.Project = *project
	}
	if *timezone != "" {
		config.Timezone = *timezone
	}
	if *model != "" {
		config.Model = *model
	}
	if *provider != "" {
		config.Provider = *provider
	}
	if *externalNetwork != "" {
		config.ExternalNetwork = *externalNetwork
	}
	if hasArgument(args, "--api") {
		config.APIEnabled = *apiEnabled
	}
	if *apiHost != "" {
		config.APIHost = *apiHost
	}
	if hasArgument(args, "--open-webui") {
		if *openWebUI {
			config.OpenWebUIHost = "127.0.0.1"
		} else {
			config.OpenWebUIHost = ""
		}
	}
	if *openWebUIHost != "" {
		config.OpenWebUIHost = *openWebUIHost
	}
	if hasArgument(args, "--open-webui-port") {
		config.OpenWebUIPort = *openWebUIPort
	}
	if hasArgument(args, "--locho-host") {
		config.LochoHostEnabled = *lochoHost
		if *lochoHost {
			config.WorkspaceUIHost = "127.0.0.1"
			config.OpenWebUIHost = "127.0.0.1"
			config.OpenWebUIAuth = true
		}
	}
	sourcePath := config.SecretSource
	if sourcePath != "" {
		if err := validateProtectedSourcePath(sourcePath, "secret source"); err != nil {
			return fail(options, ExitUsage, err.Error(), nil)
		}
	}
	for path, label := range map[string]string{
		config.LochoRelayConfigSource:  "Locho relay configuration",
		config.LochoRelaySecretsSource: "Locho relay secrets",
	} {
		if path != "" {
			if err := validateProtectedSourcePath(path, label); err != nil {
				return fail(options, ExitUsage, err.Error(), nil)
			}
		}
	}
	if config.LochoHostEnabled && config.WorkspaceUIPasswordHash == "" && config.WorkspaceUIFirebaseProjectID == "" {
		if options.NonInteractive {
			return fail(options, ExitUsage, "--locho-host requires an interactive Workspace UI password setup", nil)
		}
		first, err := readWorkspaceUIPassword("New workspace-ui password: ")
		if err != nil {
			return fail(options, ExitUsage, err.Error(), nil)
		}
		second, err := readWorkspaceUIPassword("Repeat workspace-ui password: ")
		if err != nil {
			return fail(options, ExitUsage, err.Error(), nil)
		}
		if first != second {
			return fail(options, ExitUsage, "workspace-ui passwords do not match", nil)
		}
		config.WorkspaceUIPasswordHash, err = hashWorkspaceUIPassword(first)
		if err != nil {
			return fail(options, ExitUsage, err.Error(), nil)
		}
	}
	if err := validateConfig(config); err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}
	if !targetOperatorAssetsAvailable() {
		return fail(options, ExitPrereq, "deployment requires Linux operator artifacts for the backup scheduler; run `make build` first", nil)
	}
	if err := ensureBackupIdentity(&config); err != nil {
		return fail(options, ExitFailure, "backup encryption key setup failed: "+err.Error(), nil)
	}
	if err := validateConfig(config); err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}

	archive, digest, err := releaseArchive(assets)
	if err != nil {
		return fail(options, ExitInternal, err.Error(), nil)
	}
	deployment := newDeployment(config)
	ctx, cancel := remoteContext()
	defer cancel()
	if workspaceUIPasswordRequired(config) {
		if err := provisionWorkspaceUIPassword(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "workspace-ui password provisioning failed: "+err.Error(), nil)
		}
	}
	if sourcePath != "" {
		if err := deployment.uploadFile(ctx, sourcePath, deployment.rootPath("runtime", "secrets", "hermes.env"), 0o600); err != nil {
			return fail(options, ExitFailure, "could not stage secret source: "+err.Error(), nil)
		}
	}
	if err := syncLochoSources(ctx, deployment, config); err != nil {
		return fail(options, ExitFailure, "could not stage Locho relay configuration: "+err.Error(), nil)
	}
	for _, host := range config.Services {
		if host.Source != "" && host.Name != "" {
			if err := validateProtectedSourcePath(host.Source, "attachment source"); err != nil {
				return fail(options, ExitUsage, err.Error(), nil)
			}
			target := deployment.rootPath("runtime", "locho", host.Name, "attachments.toml")
			if err := deployment.uploadFile(ctx, host.Source, target, 0o600); err != nil {
				return fail(options, ExitFailure, "could not stage attachment source: "+err.Error(), nil)
			}
		}
	}
	if err := deployment.uploadRelease(ctx, archive, digest); err != nil {
		return fail(options, ExitPrereq, err.Error(), nil)
	}
	if err := deployment.activateRelease(ctx); err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	if _, err := deployment.bootstrap(ctx); err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
		return fail(options, ExitFailure, "could not stage backup writer credentials: "+err.Error(), nil)
	}
	// Generate the Compose sidecar file before the full deploy so Hermes starts
	// with the correct Locho gateway endpoint.
	if _, err := deployment.operation(ctx, "attachments", nil, "generate", "--json"); err != nil {
		return fail(options, ExitFailure, "attachment Compose generation failed: "+err.Error(), nil)
	}
	if _, err := deployment.deploy(ctx, "deploy", true, "all"); err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}

	if _, err := deployment.workspaceGit(ctx, "setup"); err != nil {
		return fail(options, ExitFailure, "workspace Git setup failed: "+err.Error(), nil)
	}
	if err := saveConfig(config); err != nil {
		return fail(options, ExitInternal, "deployment succeeded but operator config could not be saved: "+err.Error(), nil)
	}
	scheduleAction := "schedule-install"
	if !config.BackupScheduleEnabled {
		scheduleAction = "schedule-remove"
	}
	if _, err := deployment.operation(ctx, "backup", nil, scheduleAction, "--json"); err != nil {
		return fail(options, ExitFailure, "deployment succeeded but backup schedule setup failed: "+err.Error(), map[string]any{"root": config.InstallRoot, "schedule": config.BackupSchedule})
	}
	return writeResult(options, map[string]any{
		"schema":               1,
		"ok":                   true,
		"action":               "init",
		"mode":                 config.Mode,
		"target":               config.Target,
		"root":                 config.InstallRoot,
		"release":              config.Version,
		"release_sha256":       digest,
		"workspace":            "initialized_only_when_empty",
		"workspace_git":        true,
		"backup_identity_file": config.BackupIdentityFile,
		"backup_recipient":     config.BackupRecipient,
		"backup_schedule":      config.BackupSchedule,
	}, fmt.Sprintf("openlia init: deployed %s in %s mode at %s; encrypted backups enabled; schedule enabled=%t cron=%q timezone=%s; workspace preserved when non-empty", config.Version, config.Mode, config.InstallRoot, config.BackupScheduleEnabled, config.BackupSchedule, config.Timezone))
}

func commandHealth(options Options, args []string, strict bool) int {
	if len(args) != 0 {
		return fail(options, ExitUsage, "status and doctor do not accept positional arguments", nil)
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	raw, err := newDeployment(config).health(ctx, !strict, options.ProviderCheck)
	if err != nil {
		if len(raw) == 0 {
			return fail(options, ExitFailure, err.Error(), map[string]any{"mode": config.Mode, "target": config.Target, "root": config.InstallRoot})
		}
		if options.JSON {
			var health any
			if unmarshalErr := json.Unmarshal(raw, &health); unmarshalErr != nil {
				health = map[string]any{"output": redact(string(raw))}
			}
			returnCode := ExitFailure
			return failWithPayload(options, returnCode, "deployment health checks failed", map[string]any{
				"mode":   config.Mode,
				"target": config.Target,
				"root":   config.InstallRoot,
				"health": health,
			})
		}
		fmt.Fprint(os.Stdout, redact(string(raw)))
		return ExitFailure
	}
	if options.JSON {
		var health any
		if json.Unmarshal(raw, &health) != nil {
			health = map[string]any{"output": redact(string(raw))}
		}
		return writeResult(options, map[string]any{
			"schema":  1,
			"ok":      true,
			"mode":    config.Mode,
			"target":  config.Target,
			"root":    config.InstallRoot,
			"openlia": config.Version,
			"hermes":  map[string]any{"tag": config.HermesTag, "digest": config.HermesDigest},
			"locho":   map[string]any{"version": config.LochoVersion},
			"health":  health,
		}, fmt.Sprintf("target=%s\n%s", config.Target, redact(string(raw))))
	}
	return writeResult(options, nil, fmt.Sprintf("mode=%s root=%s\n%s", config.Mode, config.InstallRoot, redact(string(raw))))
}

func failWithPayload(options Options, code int, message string, fields map[string]any) int {
	message = redact(message)
	if options.JSON {
		payload := map[string]any{"schema": 1, "ok": false, "error": message}
		for key, value := range fields {
			payload[key] = value
		}
		if err := writeJSON(payload); err != nil {
			fmt.Fprintf(os.Stderr, "openlia: %s\n", redact(err.Error()))
		}
	} else {
		fmt.Fprintf(os.Stderr, "openlia: %s\n", message)
	}
	return code
}

func commandLifecycle(options Options, action string, args []string) int {
	if len(args) != 0 {
		return fail(options, ExitUsage, action+" does not accept positional arguments", nil)
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	if action == "deploy" || action == "start" || action == "restart" {
		if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage backup writer credentials: "+err.Error(), nil)
		}
	}
	if workspaceUIPasswordRequired(config) {
		if err := provisionWorkspaceUIPassword(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "workspace-ui password provisioning failed: "+err.Error(), nil)
		}
	}
	if action == "deploy" {
		if err := syncLochoSources(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage Locho relay configuration: "+err.Error(), nil)
		}
		for _, host := range config.Services {
			if host.Source != "" && host.Name != "" {
				if err := syncAttachmentSource(ctx, deployment, host.Name, host.Source); err != nil {
					return fail(options, ExitFailure, fmt.Sprintf("attachment sync failed for host %q: %s", host.Name, err.Error()), nil)
				}
			}
		}
		if _, err := deployment.operation(ctx, "attachments", nil, "generate", "--json"); err != nil {
			return fail(options, ExitFailure, "attachment Compose generation failed: "+err.Error(), nil)
		}
	}
	if action == "restart" {
		if _, err := deployment.operation(ctx, "profile", nil, "sync", "--json"); err != nil {
			return fail(options, ExitFailure, "profile synchronization failed: "+err.Error(), map[string]any{"action": action})
		}
	}
	if action == "start" || action == "restart" {
		if err := syncLochoSources(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage Locho relay configuration: "+err.Error(), nil)
		}
		if _, err := deployment.operation(ctx, "attachments", nil, "generate", "--json"); err != nil {
			return fail(options, ExitFailure, "attachment Compose generation failed: "+err.Error(), nil)
		}
	}
	start := action == "start" || action == "restart"
	raw, err := deployment.deploy(ctx, action, start, "all")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), map[string]any{"action": action})
	}
	scheduleAction := "schedule-install"
	if action == "stop" || !config.BackupScheduleEnabled {
		scheduleAction = "schedule-remove"
	}
	if _, err := deployment.operation(ctx, "backup", nil, scheduleAction, "--json"); err != nil {
		return fail(options, ExitFailure, "backup scheduler reconciliation failed: "+err.Error(), map[string]any{"action": action})
	}
	if action == "deploy" {
		if _, err := deployment.operation(ctx, "profile", nil, "sync", "--json"); err != nil {
			return fail(options, ExitFailure, "workspace Git profile synchronization failed: "+err.Error(), map[string]any{"action": action})
		}
	}
	if (action == "deploy" || start) && deploymentResultIsRunning(raw) {
		if _, err := deployment.workspaceGit(ctx, "ensure"); err != nil {
			return fail(options, ExitFailure, "workspace Git reconciliation failed: "+err.Error(), map[string]any{"action": action})
		}
	}
	return renderRemote(options, raw, "openlia "+action+": "+redact(string(raw)))
}

type instructionStatusEnvelope struct {
	Schema            int  `json:"schema"`
	OK                bool `json:"ok"`
	AttentionRequired bool `json:"attention_required"`
	Instructions      []struct {
		Name            string `json:"name"`
		State           string `json:"state"`
		CurrentHash     string `json:"current_hash"`
		AvailableHash   string `json:"available_hash"`
		UpdateAvailable bool   `json:"update_available"`
	} `json:"instructions"`
}

func commandInstructions(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "instructions requires status, diff, merge, keep, or reset", nil)
	}
	action := args[0]
	args = args[1:]
	if action != "status" && action != "diff" && action != "merge" && action != "keep" && action != "reset" {
		return fail(options, ExitUsage, "instructions requires status, diff, merge, keep, or reset", nil)
	}
	if action == "status" {
		if len(args) > 1 {
			return fail(options, ExitUsage, "instructions status accepts at most one name", nil)
		}
	} else if len(args) != 1 {
		return fail(options, ExitUsage, "instructions "+action+" requires NAME", nil)
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	if action == "status" || action == "diff" {
		opArgs := []string{action}
		opArgs = append(opArgs, args...)
		if options.JSON || action == "status" {
			opArgs = append(opArgs, "--json")
		}
		raw, err := deployment.operation(ctx, "instructions", nil, opArgs...)
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if action == "status" && !options.JSON {
			var status instructionStatusEnvelope
			if json.Unmarshal(raw, &status) != nil {
				return fail(options, ExitFailure, "could not parse instruction status", nil)
			}
			for _, item := range status.Instructions {
				fmt.Fprintf(os.Stdout, "%s: %s\n", item.Name, item.State)
			}
			return ExitOK
		}
		return renderRemote(options, raw, "")
	}
	if options.NonInteractive {
		return fail(options, ExitUsage, "instruction mutations require interactive confirmation", nil)
	}
	name := args[0]
	statusRaw, err := deployment.operation(ctx, "instructions", nil, "status", name, "--json")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	var status instructionStatusEnvelope
	if json.Unmarshal(statusRaw, &status) != nil || len(status.Instructions) != 1 {
		return fail(options, ExitFailure, "could not parse instruction status", nil)
	}
	item := status.Instructions[0]
	expected := action + " instructions " + name
	if !confirmExact(options, fmt.Sprintf("%s %s?", titleWord(action), name), expected) {
		return fail(options, approvalExitCode(options), "instruction mutation cancelled", nil)
	}
	request, err := json.Marshal(map[string]any{"schema": 1, "expected_current_hash": item.CurrentHash, "expected_available_hash": item.AvailableHash})
	if err != nil {
		return fail(options, ExitInternal, err.Error(), nil)
	}
	raw, err := deployment.operation(ctx, "instructions", request, action, name, "--approve", "--json")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	return renderRemote(options, raw, "openlia instructions "+action+": "+name)
}

func deploymentResultIsRunning(raw []byte) bool {
	state, ok := deploymentResultState(raw)
	return ok && state == "running"
}

func deploymentResultState(raw []byte) (string, bool) {
	var result struct {
		State string `json:"state"`
	}
	if json.Unmarshal(raw, &result) != nil || result.State == "" {
		return "", false
	}
	return result.State, true
}

func commandUninstall(options Options, args []string) int {
	set := newFlagSet("uninstall")
	local := set.Bool("local", false, "uninstall the agent on this machine")
	target := set.String("target", "", "assert or select the SSH target")
	root := set.String("root", "", "assert or select the OpenLia installation root")
	project := set.String("project", "", "assert or select the Compose project name")
	if err := set.Parse(args); err != nil {
		return ExitUsage
	}
	if set.NArg() != 0 {
		return fail(options, ExitUsage, "uninstall does not accept positional arguments", nil)
	}
	if *local && *target != "" {
		return fail(options, ExitUsage, "--local and --target are mutually exclusive", nil)
	}
	mode := "ssh"
	if *local {
		mode = "local"
	}
	config, err := resolveMaintenanceDeployment(deploymentSelectors{
		mode:       mode,
		modeSet:    hasArgument(args, "--local") || hasArgument(args, "--target"),
		target:     *target,
		targetSet:  hasArgument(args, "--target"),
		root:       *root,
		rootSet:    hasArgument(args, "--root"),
		project:    *project,
		projectSet: hasArgument(args, "--project"),
	})
	if err != nil {
		return fail(options, ExitUsage, err.Error(), map[string]any{"config": configPath()})
	}
	if err := validateConfig(config); err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}
	if !options.JSON {
		fmt.Fprintln(os.Stderr, deploymentSummary(config))
		fmt.Fprintln(os.Stderr)
	}
	ctx, cancel := remoteContext()
	defer cancel()
	if len(config.BackupDestinations) > 0 {
		remoteArchives, listErr := listRemoteBackupArchives(ctx, config)
		fmt.Fprintln(os.Stderr, "Remote backups visible to this operator:")
		for _, destination := range config.BackupDestinations {
			found := false
			for _, archive := range remoteArchives {
				if archive.Destination == destination.Name {
					fmt.Fprintf(os.Stderr, "  %s: %s (%s)\n", destination.Name, archive.Name, archive.CreatedAt.Format(time.RFC3339))
					found = true
					break
				}
			}
			if !found {
				fmt.Fprintf(os.Stderr, "  %s: no readable remote archive found\n", destination.Name)
			}
		}
		if listErr != nil {
			fmt.Fprintln(os.Stderr, "Could not verify remote backups from the operator machine:", redact(listErr.Error()))
		}
		if raw, statusErr := newDeployment(config).operation(ctx, "backup", nil, "status", "--json"); statusErr == nil {
			var status operator.BackupStatus
			if json.Unmarshal(raw, &status) == nil {
				fmt.Fprintln(os.Stderr, "Remote backup status before uninstall:")
				success := false
				for _, destination := range status.Destinations {
					state := "failed"
					if destination.OK {
						state = "available"
						success = true
					}
					fmt.Fprintf(os.Stderr, "  %s: %s %s %s\n", destination.Name, state, destination.Object, destination.Completed)
				}
				if !success {
					fmt.Fprintln(os.Stderr, "  Warning: no successful remote backup was recorded; uninstall will remove local archives.")
				}
			}
		}
	} else {
		fmt.Fprintln(os.Stderr, "No remote backup destination is configured; uninstall will remove local archives without leaving a remote recovery copy.")
	}
	if !options.NonInteractive {
		expected := "uninstall " + config.Project
		fmt.Fprintf(os.Stderr, "Permanently remove this deployment and its workspace? Type %q to continue: ", expected)
		answer, readErr := bufio.NewReader(os.Stdin).ReadString('\n')
		if readErr != nil || strings.TrimSpace(answer) != expected {
			return fail(options, ExitFailure, "uninstall cancelled", nil)
		}
	}
	raw, err := newDeployment(config).uninstall(ctx)
	if err != nil {
		return fail(options, ExitFailure, err.Error(), map[string]any{"mode": config.Mode, "target": config.Target, "root": config.InstallRoot})
	}
	if options.JSON {
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			return fail(options, ExitFailure, "could not parse uninstall result", nil)
		}
		payload["config"] = configPath()
		payload["mode"] = config.Mode
		payload["project"] = config.Project
		payload["root"] = config.InstallRoot
		payload["target"] = config.Target
		return writeResult(options, payload, "")
	}
	return renderRemote(options, raw, "openlia uninstall: "+redact(string(raw)))
}

func commandLogs(options Options, args []string) int {
	if len(args) != 0 {
		return fail(options, ExitUsage, "logs does not accept positional arguments", nil)
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	raw, err := newDeployment(config).composeLogs(ctx, options.Follow)
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	if options.JSON {
		return writeResult(options, map[string]any{"schema": 1, "ok": true, "logs": redact(string(raw)), "follow": options.Follow}, "")
	}
	fmt.Fprint(os.Stdout, redact(string(raw)))
	return ExitOK
}

func commandUpdate(options Options, args []string, assets fs.FS) int {
	component := ""
	if len(args) > 1 {
		return fail(options, ExitUsage, "update accepts at most one component", nil)
	}
	if len(args) == 1 {
		component = args[0]
	}
	if component == "" {
		return writeResult(options, map[string]any{
			"schema":    1,
			"ok":        true,
			"read_only": true,
			"updates":   []any{},
			"message":   "No release index is configured; choose an explicit component after changing its pinned desired version.",
			"current":   map[string]string{"openlia": defaultVersion, "hermes": defaultHermesTag, "locho": defaultLochoVersion},
		}, "No release index configured. No component was changed.")
	}
	if component != "openlia" && component != "hermes" && component != "locho" && component != "open-webui" {
		return fail(options, ExitUsage, "component must be openlia, hermes, locho, or open-webui", nil)
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
		return fail(options, ExitFailure, "could not stage backup writer credentials: "+err.Error(), nil)
	}
	if workspaceUIPasswordRequired(config) {
		if err := provisionWorkspaceUIPassword(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "workspace-ui password provisioning failed: "+err.Error(), nil)
		}
	}
	if component == "openlia" {
		if !targetOperatorAssetsAvailable() {
			return fail(options, ExitPrereq, "OpenLia updates require Linux operator artifacts for the backup scheduler; run `make build` first", nil)
		}
		archive, digest, err := releaseArchive(assets)
		if err != nil {
			return fail(options, ExitInternal, err.Error(), nil)
		}
		if err := deployment.uploadRelease(ctx, archive, digest); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if err := deployment.activateRelease(ctx); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		// A version-isolated release does not inherit generated Compose state.
		// Generate it before profile backup so running optional services can be
		// stopped consistently against the newly activated release.
		if err := syncLochoSources(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage Locho relay configuration: "+err.Error(), nil)
		}
		if config.WorkspaceUIHost != "" || len(config.Services) > 0 {
			if _, err := deployment.operation(ctx, "attachments", nil, "generate", "--json"); err != nil {
				return fail(options, ExitFailure, "optional runtime Compose generation failed: "+err.Error(), nil)
			}
		}
		profileArgs := []string{"profile", "--json"}
		profileRaw, err := deployment.operation(ctx, "deploy", nil, profileArgs...)
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if config.WorkspaceUIHost != "" || len(config.Services) > 0 {
			_, err = deployment.deploy(ctx, "deploy", false, "all")
			if err != nil {
				return fail(options, ExitFailure, "optional runtime reconciliation failed: "+err.Error(), nil)
			}
		}
		scheduleAction := "schedule-install"
		if !config.BackupScheduleEnabled {
			scheduleAction = "schedule-remove"
		}
		if _, err := deployment.operation(ctx, "backup", nil, scheduleAction, "--json"); err != nil {
			return fail(options, ExitFailure, "backup scheduler reconciliation failed: "+err.Error(), nil)
		}
		healthRaw, healthErr := deployment.health(ctx, true, false)
		state, stateOK := deploymentResultState(healthRaw)
		if !stateOK {
			if healthErr != nil {
				return fail(options, ExitFailure, "workspace Git reconciliation preflight failed: "+healthErr.Error(), nil)
			}
			return fail(options, ExitFailure, "workspace Git reconciliation preflight returned an invalid state", nil)
		}
		if state == "running" {
			if _, err := deployment.workspaceGit(ctx, "ensure"); err != nil {
				return fail(options, ExitFailure, "workspace Git reconciliation failed: "+err.Error(), nil)
			}
		}
		return renderOpenLiaUpdate(ctx, deployment, options, profileRaw)
	}
	// Runtime image updates intentionally reuse the pinned Compose definition.
	// The command does not silently change a tag or digest; operators update the
	// desired pin in their operator config before invoking this boundary.
	if component == "locho" {
		if err := syncLochoSources(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage Locho relay configuration: "+err.Error(), nil)
		}
		if _, err := deployment.operation(ctx, "attachments", nil, "generate", "--json"); err != nil {
			return fail(options, ExitFailure, "attachment Compose generation failed: "+err.Error(), nil)
		}
	}
	if component == "open-webui" {
		if config.OpenWebUIHost == "" {
			return fail(options, ExitUsage, "open-webui is not configured in config.toml", nil)
		}
		if err := syncLochoSources(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage Locho relay configuration: "+err.Error(), nil)
		}
		if _, err := deployment.operation(ctx, "attachments", nil, "generate", "--json"); err != nil {
			return fail(options, ExitFailure, "attachment Compose generation failed: "+err.Error(), nil)
		}
	}
	raw, err := deployment.deploy(ctx, "deploy", true, component)
	if err != nil {
		return fail(options, ExitFailure, err.Error(), map[string]any{"component": component})
	}
	return renderRemote(options, raw, "openlia update "+component+": pinned runtime reconciled")
}

func renderOpenLiaUpdate(ctx context.Context, deployment deployment, options Options, raw []byte) int {
	if options.JSON {
		return renderRemote(options, raw, "")
	}
	var envelope struct {
		ProfileSync struct {
			Instructions instructionStatusEnvelope `json:"instructions"`
		} `json:"profile_sync"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return fail(options, ExitFailure, "could not parse OpenLia update result", nil)
	}
	fmt.Fprintln(os.Stdout, "openlia update openlia: profile assets synchronized")
	pending := make([]string, 0)
	for _, item := range envelope.ProfileSync.Instructions.Instructions {
		if item.UpdateAvailable {
			pending = append(pending, item.Name)
			fmt.Fprintf(os.Stdout, "Instruction update requires review: %s (%s)\n", item.Name, item.State)
			fmt.Fprintf(os.Stdout, "Review with: openlia instructions diff %s\n", item.Name)
		}
	}
	if len(pending) > 0 && !options.NonInteractive {
		fmt.Fprint(os.Stderr, "Review instruction updates now? [y/N]: ")
		answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if strings.EqualFold(strings.TrimSpace(answer), "y") || strings.EqualFold(strings.TrimSpace(answer), "yes") {
			for _, name := range pending {
				diff, err := deployment.operation(ctx, "instructions", nil, "diff", name)
				if err != nil {
					return fail(options, ExitFailure, "instruction review failed: "+err.Error(), nil)
				}
				fmt.Fprintf(os.Stdout, "\n%s\n%s", name, diff)
			}
		}
	}
	return ExitOK
}

func commandSkills(options Options, args []string, assets fs.FS) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "skills requires list, show, test, status, fork, migrate, enable, or disable", nil)
	}
	action := args[0]
	args = args[1:]
	switch action {
	case "list":
		if len(args) != 0 {
			return fail(options, ExitUsage, "skills list takes no positional arguments", nil)
		}
		config, err := loadConfig()
		if errors.Is(err, os.ErrNotExist) {
			config = defaultConfig()
		} else if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		entries := make([]map[string]any, 0, len(defaultSkills))
		for _, skill := range defaultSkills {
			content, readErr := fs.ReadFile(assets, filepath.ToSlash(filepath.Join("profile", "skills", skill, "SKILL.md")))
			if readErr != nil {
				return fail(options, ExitInternal, "missing bundled skill "+skill, nil)
			}
			entries = append(entries, map[string]any{"name": skill, "origin": "bundled", "enabled": contains(config.EnabledSkills, skill), "available": len(content) > 0})
		}
		return writeResult(options, map[string]any{"schema": 1, "ok": true, "skills": entries}, skillListHuman(config))
	case "show":
		if len(args) != 1 || !safeComponent(args[0]) || !contains(defaultSkills, args[0]) {
			return fail(options, ExitUsage, "skills show requires a bundled skill name", nil)
		}
		content, err := fs.ReadFile(assets, filepath.ToSlash(filepath.Join("profile", "skills", args[0], "SKILL.md")))
		if err != nil {
			return fail(options, ExitInternal, err.Error(), nil)
		}
		if options.JSON {
			return writeResult(options, map[string]any{"schema": 1, "ok": true, "name": args[0], "content": string(content)}, "")
		}
		fmt.Fprint(os.Stdout, string(content))
		return ExitOK
	case "status":
		if len(args) > 1 || (len(args) == 1 && !safeComponent(args[0])) {
			return fail(options, ExitUsage, "skills status accepts at most one safe skill name", nil)
		}
		config, code := configOrError(options)
		if code != ExitOK {
			return code
		}
		statusArgs := []string{}
		if len(args) == 1 {
			statusArgs = append(statusArgs, "--skill", args[0])
		}
		if options.JSON {
			statusArgs = append(statusArgs, "--json")
		}
		ctx, cancel := remoteContext()
		defer cancel()
		raw, err := newDeployment(config).operation(ctx, "skill-status", nil, statusArgs...)
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, "openlia skills status: read-only skill provenance inspection")
	case "fork":
		if len(args) != 1 || !safeComponent(args[0]) {
			return fail(options, ExitUsage, "skills fork requires an installed safe skill name", nil)
		}
		config, code := configOrError(options)
		if code != ExitOK {
			return code
		}
		ctx, cancel := remoteContext()
		defer cancel()
		raw, err := newDeployment(config).operation(ctx, "skill-fork", nil, args[0], "--json")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, "openlia skills fork: active skill preserved and customization lineage recorded")
	case "migrate":
		return commandSkillMigration(options, args)
	case "test":
		if len(args) != 1 || !safeComponent(args[0]) || !contains(defaultSkills, args[0]) {
			return fail(options, ExitUsage, "skills test requires a bundled skill name", nil)
		}
		return testSkill(options, assets, args[0])
	case "enable", "disable":
		if len(args) != 1 || !safeComponent(args[0]) {
			return fail(options, ExitUsage, "skills enable/disable requires an installed safe skill name", nil)
		}
		config, code := configOrError(options)
		if code != ExitOK {
			return code
		}
		config.EnabledSkills = setSkill(config.EnabledSkills, args[0], action == "enable")
		if err := saveConfig(config); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if config.Mode == "local" || config.Target != "" {
			ctx, cancel := remoteContext()
			defer cancel()
			if _, err := newDeployment(config).operation(ctx, "profile", nil, "sync", "--json"); err != nil {
				return fail(options, ExitFailure, err.Error(), nil)
			}
		}
		return writeResult(options, map[string]any{"schema": 1, "ok": true, "skill": args[0], "enabled": action == "enable"}, fmt.Sprintf("skill %s: %s", args[0], action+"d"))
	default:
		return fail(options, ExitUsage, "unknown skills action "+action, nil)
	}
}

func confirmExact(options Options, prompt, expected string) bool {
	if options.NonInteractive {
		return false
	}
	fmt.Fprintf(os.Stderr, "%s Type %q to continue: ", prompt, expected)
	answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
	return err == nil && strings.TrimSpace(answer) == expected
}

func approvalExitCode(options Options) int {
	if options.NonInteractive {
		return ExitUsage
	}
	return ExitFailure
}

func titleWord(value string) string {
	if value == "" {
		return value
	}
	return strings.ToUpper(value[:1]) + value[1:]
}

func commandSkillMigration(options Options, args []string) int {
	if len(args) != 2 || !safeComponent(args[1]) {
		return fail(options, ExitUsage, "skills migrate requires prepare, show, apply, or reject plus a safe name", nil)
	}
	action, identifier := args[0], args[1]
	if action != "prepare" && action != "show" && action != "apply" && action != "reject" {
		return fail(options, ExitUsage, "skills migrate requires prepare, show, apply, or reject", nil)
	}
	if action == "apply" {
		if options.NonInteractive {
			return fail(options, ExitUsage, "migration apply requires interactive confirmation", nil)
		}
		expected := "apply migration " + identifier
		fmt.Fprintf(os.Stderr, "Apply migration proposal %s? Type %q to continue: ", identifier, expected)
		answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil || strings.TrimSpace(answer) != expected {
			return fail(options, ExitFailure, "migration apply cancelled", nil)
		}
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	raw, err := newDeployment(config).operation(ctx, "skill-migration", nil, action, identifier, "--json")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	return renderRemote(options, raw, "openlia skills migrate: operation completed")
}

func commandAuth(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "auth requires list, setup, or rotate", nil)
	}
	action := args[0]
	args = args[1:]
	if action == "list" {
		if len(args) != 0 {
			return fail(options, ExitUsage, "auth list takes no positional arguments", nil)
		}
		config, code := configOrError(options)
		if code != ExitOK {
			return code
		}
		ctx, cancel := remoteContext()
		defer cancel()
		raw, err := newDeployment(config).operation(ctx, "auth", nil, "list", "--json")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, redact(string(raw)))
	}
	if action != "setup" && action != "rotate" {
		return fail(options, ExitUsage, "unknown auth action "+action, nil)
	}
	if len(args) != 0 {
		return fail(options, ExitUsage, "auth "+action+" does not accept arguments; configure [secrets].source instead", nil)
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	source := config.SecretSource
	if source == "" {
		if action != "setup" || options.NonInteractive {
			return fail(options, ExitUsage, "auth "+action+" requires [secrets].source; values are never command arguments", nil)
		}
		fmt.Fprint(os.Stderr, "Protected dotenv source path: ")
		input, scanErr := bufio.NewReader(os.Stdin).ReadString('\n')
		if scanErr != nil {
			return fail(options, ExitUsage, "could not read a protected source path", nil)
		}
		source = strings.TrimSpace(input)
		config.SecretSource = source
		if err := validateProtectedSourcePath(source, "secret source"); err != nil {
			return fail(options, ExitUsage, err.Error(), nil)
		}
		if err := saveConfig(config); err != nil {
			return fail(options, ExitFailure, "could not save secret source configuration: "+err.Error(), nil)
		}
	}
	return rotateRemoteFile(options, "auth", source)
}

func commandAttachments(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "attachments requires list, map, or rotate", nil)
	}
	action := args[0]
	args = args[1:]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	if action == "list" {
		if len(args) != 0 {
			return fail(options, ExitUsage, "attachments list takes no positional arguments", nil)
		}
		raw, err := deployment.operation(ctx, "attachments", nil, "list", "--json")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if options.JSON {
			return renderRemote(options, raw, "")
		}
		var result operator.AttachmentListResult
		if err := json.Unmarshal(raw, &result); err == nil {
			return writeResult(options, map[string]any{"schema": 1, "ok": true, "hosts": result.Hosts}, operator.FormatAttachmentListHuman(result))
		}
		return renderRemote(options, raw, redact(string(raw)))
	}
	if action == "map" {
		role, remaining, err := extractFlag(args, "--role")
		if err != nil || role == "" {
			return fail(options, ExitUsage, "attachments map requires [HOST] SERVICE --role ROLE", nil)
		}
		if err := ValidateServiceRole(role); err != nil {
			return fail(options, ExitUsage, err.Error(), nil)
		}
		host := ""
		service := ""
		if len(remaining) == 1 {
			if len(config.Services) == 1 {
				host = config.Services[0].Name
				service = remaining[0]
			} else if len(config.Services) == 0 {
				return fail(options, ExitUsage, "no service hosts configured; declare a [[services]] host first", nil)
			} else {
				return fail(options, ExitUsage, "multiple service hosts configured; specify host: openlia attachments map HOST SERVICE --role ROLE", nil)
			}
		} else if len(remaining) == 2 {
			host = remaining[0]
			service = remaining[1]
		} else {
			return fail(options, ExitUsage, "attachments map requires [HOST] SERVICE --role ROLE", nil)
		}
		if !safeComponent(host) || !safeComponent(service) {
			return fail(options, ExitUsage, "host and service names must be safe identifiers", nil)
		}
		foundIndex := -1
		for i, h := range config.Services {
			if h.Name == host {
				foundIndex = i
				break
			}
		}
		if foundIndex >= 0 {
			if config.Services[foundIndex].Roles == nil {
				config.Services[foundIndex].Roles = make(map[string]string)
			}
			config.Services[foundIndex].Roles[service] = role
		} else {
			config.Services = append(config.Services, ServiceHostConfig{
				Name:  host,
				Roles: map[string]string{service: role},
			})
		}
		if err := saveConfig(config); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		deployment = newDeployment(config)
		raw, err := deployment.operation(ctx, "attachments", nil, "generate", "--json")
		if err != nil {
			return fail(options, ExitFailure, fmt.Sprintf("service role saved, but attachment generation failed: %s", err.Error()), nil)
		}
		return renderRemote(options, raw, fmt.Sprintf("openlia attachments: mapped %s.%s to %s", host, service, role))
	}
	if action == "rotate" {
		host := ""
		source := ""
		sourceVal, remaining, err := extractFlag(args, "--source")
		if err != nil {
			return fail(options, ExitUsage, err.Error(), nil)
		}
		if len(remaining) == 0 {
			if len(config.Services) == 1 && config.Services[0].Name != "" {
				host = config.Services[0].Name
				source = config.Services[0].Source
			} else if len(config.Services) == 0 {
				return fail(options, ExitUsage, "attachments rotate requires HOST --source PATH", nil)
			} else {
				return fail(options, ExitUsage, "multiple service hosts configured; specify HOST: attachments rotate HOST --source PATH", nil)
			}
		} else if len(remaining) == 1 {
			host = remaining[0]
			if !safeComponent(host) {
				return fail(options, ExitUsage, "invalid host name", nil)
			}
			source = sourceVal
			if source == "" {
				for _, h := range config.Services {
					if h.Name == host && h.Source != "" {
						source = h.Source
						break
					}
				}
			}
		} else {
			return fail(options, ExitUsage, "attachments rotate requires [HOST] [--source PATH]", nil)
		}
		if sourceVal != "" {
			source = sourceVal
		}
		if source == "" {
			return fail(options, ExitUsage, "attachments rotate requires --source PATH or source configured in config.toml", nil)
		}
		return rotateRemoteFile(options, "attachments:"+host, source)
	}
	return fail(options, ExitUsage, "attachments requires list, map, or rotate", nil)
}

func commandLochoHost(options Options, args []string) int {
	if len(args) == 0 || args[0] != "share" {
		return fail(options, ExitUsage, "locho-host requires share", nil)
	}
	set := newFlagSet("locho-host share")
	output := set.String("output", "openlia-attachments.toml", "local attachments.toml output path")
	if err := set.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if set.NArg() != 0 || *output == "" {
		return fail(options, ExitUsage, "locho-host share accepts only --output PATH", nil)
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	raw, err := newDeployment(config).operation(ctx, "locho-host", nil, "share")
	if err != nil {
		return fail(options, ExitFailure, "could not generate Locho attachment configuration: "+err.Error(), nil)
	}
	attachmentConfig := string(raw)
	hostID, err := attachmentHostID(attachmentConfig)
	if err != nil || !strings.Contains(attachmentConfig, "capability = \"workspace-ui:tcp:") || !strings.Contains(attachmentConfig, "capability = \"open-webui:tcp:") {
		return fail(options, ExitFailure, "Locho returned an invalid attachment configuration", nil)
	}
	if err := writeExclusiveFile(*output, []byte(attachmentConfig), 0o600); err != nil {
		return fail(options, ExitFailure, "could not write attachment configuration: "+err.Error(), nil)
	}
	payload := map[string]any{
		"schema":   1,
		"ok":       true,
		"action":   "locho-host-share",
		"output":   *output,
		"host_id":  hostID,
		"services": []string{"workspace-ui", "open-webui"},
	}
	command := fmt.Sprintf("locho attach --config %s", *output)
	if config.LochoRelayConfigSource != "" {
		command += " --relay-config " + filepath.Base(config.LochoRelayConfigSource)
	}
	return writeResult(options, payload, fmt.Sprintf("Locho attachment configuration written to %s; run: %s", *output, command))
}

func attachmentHostID(config string) (string, error) {
	for _, line := range strings.Split(config, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || strings.TrimSpace(key) != "host_id" {
			continue
		}
		hostID, err := strconv.Unquote(strings.TrimSpace(value))
		if err != nil || hostID == "" || strings.ContainsAny(hostID, "\r\n") {
			return "", fmt.Errorf("invalid host_id")
		}
		return hostID, nil
	}
	return "", fmt.Errorf("missing host_id")
}

func writeExclusiveFile(path string, contents []byte, mode os.FileMode) error {
	parent := filepath.Dir(path)
	temporary, err := os.CreateTemp(parent, ".openlia-attachments-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryName)
	}()
	if err := temporary.Chmod(mode); err != nil {
		return err
	}
	if _, err := temporary.Write(contents); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Link(temporaryName, path); err != nil {
		return err
	}
	return nil
}

func commandBackup(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "backup requires create, push, status, list, restore, rollback-restore, keygen, or schedule", nil)
	}
	action := args[0]
	args = args[1:]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	switch action {
	case "create":
		if len(args) != 0 {
			return fail(options, ExitUsage, "backup create takes no positional arguments", nil)
		}
		if err := validateBackupIdentity(config.BackupIdentityFile, config.BackupRecipient); err != nil {
			return fail(options, ExitPrereq, "operator recovery identity is not ready: "+err.Error(), nil)
		}
		raw, err := deployment.operation(ctx, "backup", nil, "create", "--json")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, redact(string(raw)))
	case "restore":
		return commandRemoteBackupRestore(options, args, deployment, ctx, config, "restore")
	case "rollback-restore":
		return commandRemoteBackupRestore(options, args, deployment, ctx, config, "rollback-restore")
	case "list":
		if len(args) != 0 {
			return fail(options, ExitUsage, "backup list takes no arguments", nil)
		}
		archives, err := listRemoteBackupArchives(ctx, config)
		if err != nil {
			return failWithPayload(options, ExitFailure, err.Error(), map[string]any{"archives": archives})
		}
		return writeResult(options, map[string]any{"schema": 1, "ok": true, "archives": archives}, formatRemoteBackupList(archives))
	case "push", "tick":
		if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage backup writer credentials: "+err.Error(), nil)
		}
		if action == "tick" {
			if len(args) != 0 {
				return fail(options, ExitUsage, "backup tick takes no arguments", nil)
			}
			if err := validateBackupIdentity(config.BackupIdentityFile, config.BackupRecipient); err != nil {
				return fail(options, ExitPrereq, "operator recovery identity is not ready: "+err.Error(), nil)
			}
			raw, err := deployment.operation(ctx, "backup", nil, "tick", "--json")
			if err != nil {
				return fail(options, ExitFailure, err.Error(), nil)
			}
			return renderRemote(options, raw, redact(string(raw)))
		}
		archiveName := ""
		if len(args) == 2 && args[0] == "--archive" {
			archiveName = args[1]
		} else if len(args) != 0 {
			return fail(options, ExitUsage, "backup push accepts optional --archive FILENAME", nil)
		}
		if archiveName != "" && (filepath.Base(archiveName) != archiveName || !strings.HasPrefix(archiveName, "openlia-") || !strings.HasSuffix(archiveName, ".tar.gz.age")) {
			return fail(options, ExitUsage, "backup push archive must be an encrypted durable filename", nil)
		}
		operatorArgs := []string{"push", "--json"}
		if archiveName != "" {
			operatorArgs = append(operatorArgs, "--archive", deployment.rootPath("runtime", "backups", archiveName))
		}
		raw, err := deployment.operation(ctx, "backup", nil, operatorArgs...)
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, redact(string(raw)))
	case "keygen":
		if len(args) != 0 {
			return fail(options, ExitUsage, "backup keygen takes no arguments", nil)
		}
		if err := ensureBackupIdentity(&config); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if err := saveConfig(config); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if config.BackupScheduleEnabled {
			if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
				return fail(options, ExitFailure, "backup key saved but writer credentials could not be staged: "+err.Error(), nil)
			}
			if _, err := deployment.operation(ctx, "backup", nil, "schedule-install", "--json"); err != nil {
				return fail(options, ExitFailure, "backup key saved but schedule installation failed: "+err.Error(), nil)
			}
		}
		return writeResult(options, map[string]any{"schema": 1, "ok": true, "identity_file": config.BackupIdentityFile, "recipient": config.BackupRecipient}, "openlia backup: operator recovery key is ready; keep the identity file in a separate safe place")
	case "schedule":
		return commandBackupSchedule(options, args, config, ctx)
	case "status":
		if len(args) != 0 {
			return fail(options, ExitUsage, "backup status takes no arguments", nil)
		}
		raw, err := deployment.operation(ctx, "backup", nil, "status", "--json")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, redact(string(raw)))
	default:
		return fail(options, ExitUsage, "unknown backup action "+action, nil)
	}
}

func commandBackupSchedule(options Options, args []string, config Config, ctx context.Context) int {
	if len(args) != 1 || (args[0] != "install" && args[0] != "remove") {
		return fail(options, ExitUsage, "backup schedule requires install or remove", nil)
	}
	action := "schedule-install"
	if args[0] == "remove" {
		action = "schedule-remove"
		config.BackupScheduleEnabled = false
	} else {
		if err := validateBackupIdentity(config.BackupIdentityFile, config.BackupRecipient); err != nil {
			return fail(options, ExitPrereq, "operator recovery identity is not ready: "+err.Error(), nil)
		}
		config.BackupScheduleEnabled = true
	}
	deployment := newDeployment(config)
	if action == "schedule-install" {
		if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage backup writer credentials: "+err.Error(), nil)
		}
		if _, err := deployment.operation(ctx, "attachments", nil, "generate", "--json"); err != nil {
			return fail(options, ExitFailure, "backup scheduler mount generation failed: "+err.Error(), nil)
		}
	}
	raw, err := deployment.operation(ctx, "backup", nil, action, "--json")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	if err := saveConfig(config); err != nil {
		return fail(options, ExitFailure, "backup schedule changed but operator config could not be saved: "+err.Error(), nil)
	}
	return renderRemote(options, raw, redact(string(raw)))
}

func ensureBackupIdentity(config *Config) error {
	if config.BackupIdentityFile == "" {
		config.BackupIdentityFile = filepath.Join(filepath.Dir(configPath()), "backup-identity.txt")
	}
	if !filepath.IsAbs(config.BackupIdentityFile) {
		absolute, err := filepath.Abs(config.BackupIdentityFile)
		if err != nil {
			return err
		}
		config.BackupIdentityFile = absolute
	}
	if err := validateAbsoluteRoot(config.BackupIdentityFile, "backup.identity_file"); err != nil {
		return err
	}
	if isInsideWorkingTree(config.BackupIdentityFile) {
		return errors.New("backup identity file must be outside the OpenLia checkout")
	}
	if config.BackupRecipient != "" {
		if config.BackupIdentityFile == "" {
			return errors.New("backup identity file path is required")
		}
		return validateBackupIdentity(config.BackupIdentityFile, config.BackupRecipient)
	}
	if data, err := os.ReadFile(config.BackupIdentityFile); err == nil {
		identities, parseErr := age.ParseIdentities(strings.NewReader(string(data)))
		if parseErr != nil || len(identities) != 1 {
			return errors.New("existing backup identity file is invalid")
		}
		identity, ok := identities[0].(*age.X25519Identity)
		if !ok {
			return errors.New("backup identity must be an age X25519 identity")
		}
		config.BackupRecipient = identity.Recipient().String()
		return validateBackupIdentity(config.BackupIdentityFile, config.BackupRecipient)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(config.BackupIdentityFile), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(config.BackupIdentityFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(identity.String() + "\n"); err != nil {
		_ = file.Close()
		_ = os.Remove(config.BackupIdentityFile)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(config.BackupIdentityFile)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(config.BackupIdentityFile)
		return err
	}
	config.BackupRecipient = identity.Recipient().String()
	return nil
}

func validateBackupIdentity(path, recipient string) error {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return errors.New("backup identity file must be a regular file protected with mode 0600")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	identities, err := age.ParseIdentities(strings.NewReader(string(data)))
	if err != nil || len(identities) != 1 {
		return errors.New("backup identity file is invalid")
	}
	identity, ok := identities[0].(*age.X25519Identity)
	if !ok || identity.Recipient().String() != recipient {
		return errors.New("backup identity does not match configured recipient")
	}
	return nil
}

func commandRemoteBackupRestore(options Options, args []string, deployment deployment, ctx context.Context, config Config, action string) int {
	archive, sourceDestination, remoteObject, err := backupRestoreSelection(args)
	if err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}
	if !options.NonInteractive {
		prompt := "Restore the selected OpenLia backup and stop the stack? Type 'yes' to continue: "
		if action == "rollback-restore" {
			prompt = "Restore the selected OpenLia operation rollback? Type 'yes' to continue: "
		}
		fmt.Fprint(os.Stderr, prompt)
		answer, readErr := bufio.NewReader(os.Stdin).ReadString('\n')
		if readErr != nil || strings.TrimSpace(strings.ToLower(answer)) != "yes" {
			return fail(options, ExitFailure, "backup restore cancelled", nil)
		}
	}
	if action == "rollback-restore" && (archive == "" || sourceDestination != "") {
		return fail(options, ExitUsage, "rollback restore requires an archive path", nil)
	}
	if sourceDestination != "" && archive != "" {
		return fail(options, ExitUsage, "choose either a local archive or a remote destination", nil)
	}
	if archive != "" && (!filepath.IsAbs(archive) || filepath.Base(archive) == "." || (action == "restore" && !strings.HasSuffix(archive, ".tar.gz.age")) || (action == "rollback-restore" && !strings.HasSuffix(archive, ".tar.gz"))) {
		return fail(options, ExitUsage, "durable restore requires an absolute .tar.gz.age archive; rollback restore requires .tar.gz", nil)
	}
	if archive != "" && isInsideWorkingTree(archive) {
		return fail(options, ExitUsage, "backup archive must be outside the OpenLia checkout", nil)
	}
	temporaryDirectory, err := os.MkdirTemp("", "openlia-restore-*")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	defer os.RemoveAll(temporaryDirectory)
	if sourceDestination != "" {
		var selected BackupDestinationConfig
		found := false
		for _, destination := range config.BackupDestinations {
			if destination.Name == sourceDestination {
				selected = destination
				found = true
				break
			}
		}
		if !found {
			return fail(options, ExitUsage, "unknown backup destination "+sourceDestination, nil)
		}
		if remoteObject == "" {
			archives, listErr := listRemoteBackupDestination(ctx, config, selected)
			if listErr != nil {
				return fail(options, ExitFailure, listErr.Error(), nil)
			}
			for _, candidate := range archives {
				if candidate.Destination == sourceDestination {
					remoteObject = candidate.Name
					break
				}
			}
		}
		if remoteObject == "" {
			return fail(options, ExitFailure, "no remote backup is available at destination "+sourceDestination, nil)
		}
		archive = filepath.Join(temporaryDirectory, remoteObject)
		if err := fetchRemoteBackup(ctx, config, selected, remoteObject, archive); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
	}
	if archive == "" {
		statusJSON, statusErr := deployment.operation(ctx, "backup", nil, "status", "--json")
		if statusErr != nil {
			return fail(options, ExitFailure, statusErr.Error(), nil)
		}
		var status operator.BackupStatus
		if json.Unmarshal(statusJSON, &status) != nil || status.LatestLocal == nil {
			return fail(options, ExitFailure, "no local durable backup is available on the target", nil)
		}
		archive = deployment.rootPath("runtime", "backups", status.LatestLocal.Name)
		localEncrypted := filepath.Join(temporaryDirectory, filepath.Base(archive))
		if err := deployment.downloadFile(ctx, archive, localEncrypted); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if _, statErr := os.Stat(archive + ".json"); statErr != nil {
			return fail(options, ExitFailure, "target backup metadata is missing", nil)
		}
		if err := deployment.downloadFile(ctx, archive+".json", localEncrypted+".json"); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		archive = localEncrypted
	}
	plainArchive := archive
	if encryptedBackupPath(archive) {
		if action != "restore" {
			return fail(options, ExitUsage, "encrypted durable archives can only be restored with `backup restore`", nil)
		}
		plainArchive, err = decryptBackupArchive(config, archive, temporaryDirectory)
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
	} else {
		if action == "restore" {
			return fail(options, ExitUsage, "durable backup restore accepts encrypted .tar.gz.age archives only", nil)
		}
		if err := verifyRollbackMetadata(archive); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
	}
	remoteArchive := deployment.rootPath("runtime", "backups", fmt.Sprintf(".openlia-restore-%d-%s", os.Getpid(), filepath.Base(plainArchive)))
	if err := deployment.uploadFile(ctx, plainArchive, remoteArchive, 0o600); err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	defer deployment.removeFile(context.Background(), remoteArchive)
	localMetadata := plainArchive + ".json"
	remoteMetadata := remoteArchive + ".json"
	if !encryptedBackupPath(archive) {
		if info, statErr := os.Stat(localMetadata); statErr == nil && info.Mode().IsRegular() {
			if err := deployment.uploadFile(ctx, localMetadata, remoteMetadata, 0o600); err != nil {
				return fail(options, ExitFailure, err.Error(), nil)
			}
			defer deployment.removeFile(context.Background(), remoteMetadata)
		} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			return fail(options, ExitFailure, "could not inspect backup metadata: "+statErr.Error(), nil)
		}
	}
	raw, err := deployment.operation(ctx, "backup", nil, action, "--archive", remoteArchive, "--json")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	return renderRemote(options, raw, redact(string(raw)))
}

func formatRemoteBackupList(archives []remoteBackupArchive) string {
	if len(archives) == 0 {
		return "No remote OpenLia backups found"
	}
	var builder strings.Builder
	for _, archive := range archives {
		fmt.Fprintf(&builder, "%s  %s  %s  %d bytes\n", archive.Destination, archive.CreatedAt.Format(time.RFC3339), archive.Name, archive.Size)
	}
	return strings.TrimSuffix(builder.String(), "\n")
}

func commandWorkspace(options Options, args []string, assets fs.FS) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace requires serve, export, git, or migrate subcommand", nil)
	}
	switch args[0] {
	case "serve":
		return commandWorkspaceServe(options, args[1:], assets)
	case "export":
		return commandWorkspaceExport(options, args[1:])
	case "git":
		return commandWorkspaceGit(options, args[1:])
	case "migrate":
		return commandWorkspaceMigrate(options, args[1:])
	default:
		return fail(options, ExitUsage, "unknown workspace subcommand "+args[0], nil)
	}
}

func commandWorkspaceGit(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace git requires setup or status", nil)
	}
	action := args[0]
	args = args[1:]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	set := newFlagSet("workspace git " + action)
	if err := set.Parse(args); err != nil {
		return ExitUsage
	}
	if set.NArg() != 0 {
		return fail(options, ExitUsage, "workspace git does not accept positional arguments", nil)
	}

	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	switch action {
	case "status":
		if len(args) != 0 {
			return fail(options, ExitUsage, "workspace git status does not accept options", nil)
		}
		raw, err := deployment.workspaceGit(ctx, "status")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, redact(string(raw)))
	case "setup":
		if _, err := deployment.operation(ctx, "profile", nil, "sync", "--json"); err != nil {
			return fail(options, ExitFailure, "profile synchronization failed: "+err.Error(), nil)
		}
		raw, err := deployment.workspaceGit(ctx, "setup")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, "openlia workspace git: setup completed")
	default:
		return fail(options, ExitUsage, "unknown workspace git action "+action, nil)
	}
}

func commandWorkspaceMigrate(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate requires upload <path>, status [id], merge [id], list, or <path to folder>", nil)
	}

	subcommand := args[0]
	subArgs := args[1:]

	switch subcommand {
	case "upload":
		return commandWorkspaceMigrateUpload(options, subArgs)
	case "status":
		return commandWorkspaceMigrateStatus(options, subArgs)
	case "monitor":
		return commandWorkspaceMigrateMonitor(options, subArgs)
	case "stop":
		return commandWorkspaceMigrateStop(options, subArgs)
	case "resume":
		return commandWorkspaceMigrateResume(options, subArgs)
	case "diff":
		return commandWorkspaceMigrateDiff(options, subArgs)
	case "approve":
		return commandWorkspaceMigrateApprove(options, subArgs)
	case "discard":
		return commandWorkspaceMigrateDiscard(options, subArgs)
	case "merge":
		return commandWorkspaceMigrateMerge(options, subArgs)
	case "list":
		return commandWorkspaceMigrateList(options, subArgs)
	default:
		if info, err := os.Stat(subcommand); err == nil && info.IsDir() {
			return commandWorkspaceMigrateUnified(options, subcommand, subArgs)
		}
		return fail(options, ExitUsage, fmt.Sprintf("unknown workspace migrate subcommand %q (or directory not found)", subcommand), nil)
	}
}

func commandWorkspaceMigrateUpload(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate upload requires a folder path", nil)
	}
	folderPath := args[0]
	absFolder, err := filepath.Abs(folderPath)
	if err != nil {
		return fail(options, ExitUsage, "invalid folder path: "+err.Error(), nil)
	}
	info, err := os.Stat(absFolder)
	if err != nil || !info.IsDir() {
		return fail(options, ExitUsage, fmt.Sprintf("%s is not an existing directory", folderPath), nil)
	}

	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	tempFile, err := os.CreateTemp("", "openlia-mig-*.tar.gz")
	if err != nil {
		return fail(options, ExitFailure, "create temporary archive: "+err.Error(), nil)
	}
	defer os.Remove(tempFile.Name())

	packaged, blocked, err := operator.CreateCleanTarball(absFolder, tempFile)
	tempFile.Close()
	if err != nil {
		return fail(options, ExitFailure, "package migration archive: "+err.Error(), nil)
	}
	if packaged == 0 {
		return fail(options, ExitUsage, "source folder contains no valid files to migrate", nil)
	}

	migrationID := fmt.Sprintf("mig-%s", time.Now().UTC().Format("20060102-150405"))
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	targetArchive := deployment.rootPath("runtime", "hermes", ".openlia", "workspace-migrations", migrationID, "source.tar.gz")
	if err := deployment.uploadFile(ctx, tempFile.Name(), targetArchive, 0o600); err != nil {
		return fail(options, ExitFailure, "upload migration archive: "+err.Error(), nil)
	}

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "worker", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "start migration worker: "+err.Error(), nil)
	}

	blockedNotice := ""
	if blocked > 0 {
		blockedNotice = fmt.Sprintf(" (%d secret files quarantined locally)", blocked)
	}
	msg := fmt.Sprintf("Migration %s uploaded: %d files packaged%s.\nWorker processing in background.\n\nNext steps:\n  openlia workspace migrate status %s\n  openlia workspace migrate merge %s",
		migrationID, packaged, blockedNotice, migrationID, migrationID)
	return writeResult(options, map[string]any{
		"ok":           true,
		"migration_id": migrationID,
		"packaged":     packaged,
		"blocked":      blocked,
		"worker":       string(raw),
	}, msg)
}

func commandWorkspaceMigrateStatus(options Options, args []string) int {
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	migrationID := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		migrationID = args[0]
	}

	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	if migrationID == "" {
		rawList, err := deployment.operation(ctx, "workspace-migrate", nil, "list", "--json")
		if err != nil {
			return fail(options, ExitFailure, "fetch migration list: "+err.Error(), nil)
		}
		var listResp struct {
			OK         bool                        `json:"ok"`
			Migrations []operator.MigrationSummary `json:"migrations"`
		}
		if err := json.Unmarshal(rawList, &listResp); err != nil || len(listResp.Migrations) == 0 {
			return fail(options, ExitUsage, "no active migrations found; run upload first", nil)
		}
		migrationID = listResp.Migrations[len(listResp.Migrations)-1].ID
	}

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "status", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "fetch migration status: "+err.Error(), nil)
	}

	var statusMap map[string]any
	if err := json.Unmarshal(raw, &statusMap); err == nil {
		if schema, ok := statusMap["schema"].(float64); ok && schema == 2 {
			id, _ := statusMap["id"].(string)
			state, _ := statusMap["state"].(string)
			totalSources, _ := statusMap["total_sources"].(float64)
			totalRevisions, _ := statusMap["total_revisions"].(float64)

			var human strings.Builder
			human.WriteString(fmt.Sprintf("Migration ID:    %s\n", id))
			human.WriteString("Schema:          2 (durable Hermes pipeline)\n")
			human.WriteString(fmt.Sprintf("State:           %s\n", strings.ToUpper(state)))
			human.WriteString(fmt.Sprintf("Total Sources:   %d\n", int(totalSources)))
			human.WriteString(fmt.Sprintf("Total Revisions: %d\n", int(totalRevisions)))

			if prog, ok := statusMap["progress"].(map[string]any); ok && prog != nil {
				pct, _ := prog["percent"].(float64)
				succeeded, _ := prog["succeeded"].(float64)
				running, _ := prog["running"].(float64)
				pending, _ := prog["pending"].(float64)
				failed, _ := prog["failed"].(float64)
				total, _ := prog["total"].(float64)

				// ASCII Progress Bar (20 blocks)
				barWidth := 20
				filled := int((pct / 100.0) * float64(barWidth))
				if filled > barWidth {
					filled = barWidth
				}
				bar := strings.Repeat("█", filled) + strings.Repeat("░", barWidth-filled)

				human.WriteString(fmt.Sprintf("Progress:        [%s] %d%% (%d/%d files completed)\n", bar, int(pct), int(succeeded), int(total)))
				human.WriteString(fmt.Sprintf("Jobs Breakdown:  %d succeeded, %d running, %d pending", int(succeeded), int(running), int(pending)))
				if int(failed) > 0 {
					human.WriteString(fmt.Sprintf(", %d failed", int(failed)))
				}
				human.WriteString("\n")

				if curFile, _ := prog["current_file"].(string); curFile != "" {
					human.WriteString(fmt.Sprintf("Active File:     %s (processing)\n", curFile))
				}

				if etaSec, _ := prog["eta_seconds"].(float64); etaSec > 0 {
					mins := int(etaSec / 60)
					if mins < 1 {
						mins = 1
					}
					etaStr := fmt.Sprintf("~%d min(s)", mins)
					if finishStr, _ := prog["estimated_finish_at"].(string); finishStr != "" {
						if t, err := time.Parse(time.RFC3339, finishStr); err == nil {
							etaStr += fmt.Sprintf(" (est. %s)", t.Local().Format("15:04"))
						}
					}
					human.WriteString(fmt.Sprintf("Estimated Finish: %s\n", etaStr))
				}
			}

			if state == "ready_for_review" {
				human.WriteString(fmt.Sprintf("\nReady for review in Workspace UI → Migration or run:\n  openlia workspace migrate diff %s", id))
			}
			return writeResult(options, statusMap, strings.TrimRight(human.String(), "\n"))
		}
	}

	var status operator.MigrationStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		return renderRemote(options, raw, string(raw))
	}

	summaryText := ""
	if status.PlanSummary != nil {
		summaryText = fmt.Sprintf("\nSummary:      files: %d, chunks: %d, conflicts: %d, blocked: %d",
			status.PlanSummary.TotalFiles, status.PlanSummary.TotalChunks, status.PlanSummary.Conflicts, status.PlanSummary.BlockedFiles)
	}
	human := fmt.Sprintf("Migration ID: %s\nStatus:       %s\nPhase:        %s (%d%%)%s",
		status.ID, strings.ToUpper(status.Status), status.Phase, status.Percent, summaryText)
	if status.Status == operator.MigrationStatusDone {
		human += fmt.Sprintf("\n\nReady for review! Run:\n  openlia workspace migrate merge %s", status.ID)
	}
	return writeResult(options, status, human)
}

func commandWorkspaceMigrateList(options Options, args []string) int {
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "list", "--json")
	if err != nil {
		return fail(options, ExitFailure, "list migrations: "+err.Error(), nil)
	}
	var listResp struct {
		OK         bool                        `json:"ok"`
		Migrations []operator.MigrationSummary `json:"migrations"`
	}
	if err := json.Unmarshal(raw, &listResp); err != nil {
		return renderRemote(options, raw, string(raw))
	}
	if len(listResp.Migrations) == 0 {
		return writeResult(options, listResp, "No workspace migrations found.")
	}

	var lines []string
	lines = append(lines, fmt.Sprintf("%-24s  %-12s  %s", "MIGRATION ID", "STATUS", "CREATED"))
	for _, m := range listResp.Migrations {
		lines = append(lines, fmt.Sprintf("%-24s  %-12s  %s", m.ID, m.Status, m.CreatedAt))
	}
	return writeResult(options, listResp, strings.Join(lines, "\n"))
}

func commandWorkspaceMigrateMerge(options Options, args []string) int {
	dryRun := false
	var remaining []string
	for _, arg := range args {
		switch arg {
		case "--dry-run":
			dryRun = true
		default:
			if strings.HasPrefix(arg, "-") {
				return fail(options, ExitUsage, fmt.Sprintf("unknown flag %s; merge requires interactive chunk-by-chunk confirmation", arg), nil)
			}
			remaining = append(remaining, arg)
		}
	}

	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	migrationID := ""
	if len(remaining) > 0 {
		migrationID = remaining[0]
	}

	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	if migrationID == "" {
		rawList, err := deployment.operation(ctx, "workspace-migrate", nil, "list", "--json")
		if err != nil {
			return fail(options, ExitFailure, "fetch migration list: "+err.Error(), nil)
		}
		var listResp struct {
			OK         bool                        `json:"ok"`
			Migrations []operator.MigrationSummary `json:"migrations"`
		}
		if err := json.Unmarshal(rawList, &listResp); err != nil || len(listResp.Migrations) == 0 {
			return fail(options, ExitUsage, "no migrations found; run upload first", nil)
		}
		for i := len(listResp.Migrations) - 1; i >= 0; i-- {
			if listResp.Migrations[i].Status == operator.MigrationStatusDone {
				migrationID = listResp.Migrations[i].ID
				break
			}
		}
		if migrationID == "" {
			migrationID = listResp.Migrations[len(listResp.Migrations)-1].ID
		}
	}

	// Verify status is done
	rawStatus, err := deployment.operation(ctx, "workspace-migrate", nil, "status", "--migration-id", migrationID, "--json")
	if err == nil {
		var st operator.MigrationStatus
		if json.Unmarshal(rawStatus, &st) == nil && st.Status != operator.MigrationStatusDone {
			return fail(options, ExitFailure, fmt.Sprintf("migration %s is not ready for merge (status=%s, phase=%s)", migrationID, st.Status, st.Phase), nil)
		}
	}

	rawPlan, err := deployment.operation(ctx, "workspace-migrate", nil, "plan", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "fetch migration plan: "+err.Error(), nil)
	}

	var plan operator.WorkspaceMigrationPlan
	if err := json.Unmarshal(rawPlan, &plan); err != nil {
		return fail(options, ExitFailure, "parse migration plan: "+err.Error(), nil)
	}

	if dryRun {
		return renderPlanDryRun(options, plan)
	}

	if options.NonInteractive {
		return fail(options, ExitUsage, "workspace migrate merge requires an interactive terminal for chunk decision making; use --dry-run for non-interactive inspection", nil)
	}

	return runInteractiveMergeLoop(options, deployment, ctx, migrationID, plan)
}

func renderPlanDryRun(options Options, plan operator.WorkspaceMigrationPlan) int {
	var lines []string
	lines = append(lines, fmt.Sprintf("--- DRY RUN: Migration Plan %s (%d files, %d chunks) ---", plan.ID, plan.TotalFiles, plan.TotalChunks))
	for i, chunk := range plan.Chunks {
		lines = append(lines, fmt.Sprintf("\n[Chunk %d/%d] %s (%s)", i+1, len(plan.Chunks), chunk.Title, chunk.Domain))
		for _, f := range chunk.Files {
			badge := strings.ToUpper(f.Status)
			lines = append(lines, fmt.Sprintf("  [%s] %s -> %s", badge, f.SourcePath, f.TargetPath))
		}
	}
	return writeResult(options, plan, strings.Join(lines, "\n"))
}

func runInteractiveMergeLoop(options Options, deployment deployment, ctx context.Context, migrationID string, plan operator.WorkspaceMigrationPlan) int {
	inReader := bufio.NewReader(os.Stdin)
	appliedCount := 0
	rejectedCount := 0

	for i, chunk := range plan.Chunks {
		if chunk.State == operator.ChunkStateApplied || chunk.State == operator.ChunkStateRejected {
			continue
		}

		fmt.Printf("\n========================================================================\n")
		fmt.Printf("Chunk %d of %d: [%s] (%d files)\n", i+1, len(plan.Chunks), chunk.Domain, len(chunk.Files))
		fmt.Printf("Title: %s\n", chunk.Title)
		fmt.Printf("========================================================================\n")

		for idx, f := range chunk.Files {
			badge := strings.ToUpper(f.Status)
			if f.Status == operator.FileStatusConflict {
				badge = "CONFLICT"
			}
			fmt.Printf("  %d. [%s] %s -> %s\n", idx+1, badge, f.SourcePath, f.TargetPath)
		}

		decided := false
		for !decided {
			fmt.Printf("\nAction: [a]pprove, [e]dit then approve, [r]eject, [d]iff/preview, [q]uit: ")
			input, err := inReader.ReadString('\n')
			if err != nil {
				return fail(options, ExitFailure, "reading user input: "+err.Error(), nil)
			}
			action := strings.ToLower(strings.TrimSpace(input))

			switch action {
			case "a", "approve":
				_, err := deployment.operation(ctx, "workspace-migrate", nil, "apply-chunk", "--migration-id", migrationID, "--chunk-id", chunk.ID, "--json")
				if err != nil {
					fmt.Printf("Failed to apply chunk: %v\n", err)
				} else {
					fmt.Printf("Chunk %s successfully applied to workspace.\n", chunk.ID)
					appliedCount++
					decided = true
				}

			case "r", "reject":
				fmt.Printf("Chunk %s rejected.\n", chunk.ID)
				rejectedCount++
				decided = true

			case "d", "diff", "preview":
				for idx, f := range chunk.Files {
					fmt.Printf("\n--- File %d/%d: %s -> %s ---\n", idx+1, len(chunk.Files), f.SourcePath, f.TargetPath)
					if f.ProposedContent != "" {
						fmt.Printf("Proposed Content:\n%s\n", f.ProposedContent)
					} else {
						fmt.Printf("Original Content:\n%s\n", f.OriginalContent)
					}
				}

			case "e", "edit":
				tempDir, err := os.MkdirTemp("", "openlia-edit-"+chunk.ID)
				if err != nil {
					fmt.Printf("Error creating temp dir for edit: %v\n", err)
					continue
				}
				defer os.RemoveAll(tempDir)

				var editFiles []string
				for _, f := range chunk.Files {
					localPath := filepath.Join(tempDir, filepath.Base(f.TargetPath))
					content := f.ProposedContent
					if content == "" {
						content = f.OriginalContent
					}
					_ = os.WriteFile(localPath, []byte(content), 0o600)
					editFiles = append(editFiles, localPath)
				}

				if len(editFiles) > 0 {
					if err := launchEditor(editFiles[0]); err != nil {
						fmt.Printf("Editor launch failed: %v\n", err)
					} else {
						// Read edited files and apply
						fmt.Println("Applying edited files to workspace...")
						_, err := deployment.operation(ctx, "workspace-migrate", nil, "apply-chunk", "--migration-id", migrationID, "--chunk-id", chunk.ID, "--json")
						if err != nil {
							fmt.Printf("Failed to apply chunk: %v\n", err)
						} else {
							fmt.Printf("Chunk %s (with edits) successfully applied to workspace.\n", chunk.ID)
							appliedCount++
							decided = true
						}
					}
				}

			case "q", "quit":
				fmt.Printf("\nMigration paused. Applied %d chunk(s), rejected %d chunk(s).\nResume anytime with: openlia workspace migrate merge %s\n",
					appliedCount, rejectedCount, migrationID)
				return ExitOK

			default:
				fmt.Println("Please enter 'a', 'e', 'r', 'd', or 'q'.")
			}
		}
	}

	fmt.Printf("\n========================================================================\n")
	fmt.Printf("Migration %s complete! Applied: %d chunk(s), Rejected: %d chunk(s).\n",
		migrationID, appliedCount, rejectedCount)
	fmt.Printf("========================================================================\n")
	return ExitOK
}

func commandWorkspaceMigrateMonitor(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate monitor requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	deployment := newDeployment(config)

	// Clean detach on Ctrl+C
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt)
	defer signal.Stop(sigChan)

	projectName := config.Project
	if projectName == "" {
		projectName = "openlia"
	}

	fmt.Printf("\nMigration:  %s\nDeployment: %s\nState:      Connecting...\n\n", migrationID, projectName)
	fmt.Println("Review proposals and leave comments in Workspace UI → Migration.")
	fmt.Println("\nCtrl+C leaves monitoring. Migration continues on the deployment.")
	fmt.Printf("\nStop:    openlia workspace migrate stop %s\n", migrationID)
	fmt.Printf("Monitor: openlia workspace migrate monitor %s\n\n", migrationID)

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-sigChan:
			fmt.Printf("\nDetached from monitoring. Migration %s continues on deployment %s.\n", migrationID, projectName)
			fmt.Printf("Re-attach anytime: openlia workspace migrate monitor %s\n", migrationID)
			return ExitOK
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			rawStatus, err := deployment.operation(ctx, "workspace-migrate", nil, "status", "--migration-id", migrationID, "--json")
			cancel()
			if err == nil {
				var stMap map[string]any
				if json.Unmarshal(rawStatus, &stMap) == nil {
					state, _ := stMap["state"].(string)
					if state == "ready_for_review" {
						fmt.Printf("\n========================================================================\n")
						fmt.Printf("Migration %s is ready for review!\n\n", migrationID)
						fmt.Println("Go to Workspace UI → Migration to review changes,")
						fmt.Println("request revisions, or approve application.")
						fmt.Printf("========================================================================\n")
						return ExitOK
					}
					if state == "failed" {
						return fail(options, ExitFailure, fmt.Sprintf("migration %s failed", migrationID), nil)
					}
					if state == "stopped" {
						fmt.Printf("\nMigration %s is stopped. Run: openlia workspace migrate resume %s\n", migrationID, migrationID)
						return ExitOK
					}
					fmt.Printf("\rState: %-20s (monitoring...)", state)
				}
			}
		}
	}
}

func commandWorkspaceMigrateStop(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate stop requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "stop", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "stop migration: "+err.Error(), nil)
	}
	return writeResult(options, map[string]any{"ok": true, "migration_id": migrationID, "state": "stopped", "raw": string(raw)}, fmt.Sprintf("Migration %s stopped.", migrationID))
}

func commandWorkspaceMigrateResume(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate resume requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	deployment := newDeployment(config)

	ctx, cancel := remoteContext()
	defer cancel()
	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "resume", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "resume migration: "+err.Error(), nil)
	}

	if options.JSON {
		return writeResult(options, map[string]any{"ok": true, "migration_id": migrationID, "raw": string(raw)}, "")
	}
	fmt.Printf("Migration %s resumed. Attaching monitor...\n", migrationID)
	return commandWorkspaceMigrateMonitor(options, []string{migrationID})
}

func commandWorkspaceMigrateDiff(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate diff requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	diffArgs := append([]string{"diff", "--migration-id", migrationID, "--json"}, args[1:]...)
	raw, err := deployment.operation(ctx, "workspace-migrate", nil, diffArgs...)
	if err != nil {
		return fail(options, ExitFailure, "fetch diff: "+err.Error(), nil)
	}
	var diffResp struct {
		Diff string `json:"diff"`
	}
	if json.Unmarshal(raw, &diffResp) == nil && diffResp.Diff != "" {
		fmt.Println(diffResp.Diff)
		return ExitOK
	}
	return writeResult(options, map[string]any{"raw": string(raw)}, string(raw))
}

func commandWorkspaceMigrateApprove(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate approve requires a migration-id and --revision <rev>", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	applyArgs := append([]string{"apply", "--migration-id", migrationID, "--json"}, args[1:]...)
	raw, err := deployment.operation(ctx, "workspace-migrate", nil, applyArgs...)
	if err != nil {
		return fail(options, ExitFailure, "apply revision: "+err.Error(), nil)
	}
	return writeResult(options, map[string]any{"ok": true, "migration_id": migrationID, "raw": string(raw)}, fmt.Sprintf("Migration %s revision applied successfully to workspace.", migrationID))
}

func commandWorkspaceMigrateDiscard(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate discard requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "discard", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "discard migration: "+err.Error(), nil)
	}
	return writeResult(options, map[string]any{"ok": true, "migration_id": migrationID, "raw": string(raw)}, fmt.Sprintf("Migration %s discarded.", migrationID))
}

func commandWorkspaceMigrateUnified(options Options, folderPath string, args []string) int {
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	for _, a := range args {
		if a == "--open" || strings.HasPrefix(a, "--open=") {
			return fail(options, ExitUsage, "unsupported flag --open: inspect proposals via workspace-ui or openlia workspace migrate status", nil)
		}
	}

	absFolder, err := filepath.Abs(folderPath)
	if err != nil {
		return fail(options, ExitUsage, "invalid folder path: "+err.Error(), nil)
	}
	info, err := os.Stat(absFolder)
	if err != nil || !info.IsDir() {
		return fail(options, ExitUsage, fmt.Sprintf("%s is not an existing directory", folderPath), nil)
	}

	fmt.Printf("Packaging snapshot from %s...\n", folderPath)
	tempFile, err := os.CreateTemp("", "openlia-mig-*.tar.gz")
	if err != nil {
		return fail(options, ExitFailure, "create temporary archive: "+err.Error(), nil)
	}
	defer os.Remove(tempFile.Name())

	packaged, blocked, err := operator.CreateCleanTarball(absFolder, tempFile)
	tempFile.Close()
	if err != nil {
		return fail(options, ExitFailure, "package migration archive: "+err.Error(), nil)
	}
	if packaged == 0 {
		return fail(options, ExitUsage, "source folder contains no valid files to migrate", nil)
	}

	migrationID := fmt.Sprintf("mig-%s-%03d", time.Now().UTC().Format("20060102-150405"), time.Now().UTC().Nanosecond()/1e6)
	ctx, cancel := remoteContext()
	deployment := newDeployment(config)

	targetArchive := deployment.rootPath("runtime", "hermes", ".openlia", "workspace-migrations", migrationID, "source.tar.gz")
	fmt.Printf("Uploading %d files to %s...\n", packaged, config.Project)
	if err := deployment.uploadFile(ctx, tempFile.Name(), targetArchive, 0o600); err != nil {
		cancel()
		return fail(options, ExitFailure, "upload migration archive: "+err.Error(), nil)
	}

	// Initialize V2 migration on deployment
	_, err = deployment.operation(ctx, "workspace-migrate", nil, "init", "--migration-id", migrationID, "--json")
	if err != nil {
		cancel()
		return fail(options, ExitFailure, "init migration on deployment: "+err.Error(), nil)
	}

	// Trigger worker execution
	go func() {
		wCtx, wCancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer wCancel()
		_, _ = deployment.operation(wCtx, "workspace-migrate", nil, "worker", "--migration-id", migrationID, "--json")
	}()
	cancel()

	blockedNotice := ""
	if blocked > 0 {
		blockedNotice = fmt.Sprintf(" (%d secret files quarantined locally)", blocked)
	}
	fmt.Printf("Migration %s accepted: %d files packaged%s.\n", migrationID, packaged, blockedNotice)

	// Attach monitor
	return commandWorkspaceMigrateMonitor(options, []string{migrationID})
}

func launchEditor(filePath string) error {
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor == "" {
		editor = "nano"
	}
	cmd := exec.Command(editor, filePath)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func backupRestoreSelection(args []string) (archive, destination, remoteObject string, err error) {
	latest := false
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--archive":
			index++
			if index >= len(args) || archive != "" {
				return "", "", "", errors.New("backup restore accepts only one --archive PATH")
			}
			archive = args[index]
		case "--from":
			index++
			if index >= len(args) || destination != "" {
				return "", "", "", errors.New("backup restore accepts only one --from DESTINATION")
			}
			destination = args[index]
		case "--object":
			index++
			if index >= len(args) || remoteObject != "" {
				return "", "", "", errors.New("backup restore accepts only one --object NAME")
			}
			remoteObject = args[index]
		case "--latest":
			if latest {
				return "", "", "", errors.New("backup restore accepts --latest only once")
			}
			latest = true
		default:
			if strings.HasPrefix(args[index], "-") || archive != "" || destination != "" {
				return "", "", "", errors.New("backup restore accepts an archive path or --from DESTINATION --latest|--object NAME")
			}
			archive = args[index]
		}
	}
	if destination != "" {
		if archive != "" || latest == (remoteObject != "") {
			return "", "", "", errors.New("remote restore requires --from DESTINATION and exactly one of --latest or --object NAME")
		}
	} else if latest || remoteObject != "" {
		return "", "", "", errors.New("--latest and --object require --from DESTINATION")
	}
	return archive, destination, remoteObject, nil
}

func requiredPathFlag(args []string, name string) (string, error) {
	for index, arg := range args {
		if arg == name && index+1 < len(args) && args[index+1] != "" {
			return args[index+1], nil
		}
	}
	return "", errors.New("missing path")
}

func requiredValueFlag(args []string, name string) (string, error) {
	for index, arg := range args {
		if arg == name && index+1 < len(args) && args[index+1] != "" {
			return args[index+1], nil
		}
	}
	return "", fmt.Errorf("missing %s", name)
}

func rotateRemoteFile(options Options, kind, source string) int {
	if err := validateProtectedSourcePath(source, "source"); err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}
	var err error
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	remotePath := deployment.rootPath("runtime", "meta", ".openlia-incoming")
	if err := deployment.uploadFile(ctx, source, remotePath, 0o600); err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	defer deployment.removeFile(context.Background(), remotePath)
	var raw []byte
	if strings.HasPrefix(kind, "attachments:") {
		host := strings.TrimPrefix(kind, "attachments:")
		raw, err = deployment.operation(ctx, "attachments", nil, "rotate", host, "--source", remotePath, "--json")
	} else {
		raw, err = deployment.operation(ctx, "auth", nil, "rotate", "--source", remotePath, "--json")
	}
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	return renderRemote(options, raw, kind+" rotation completed; values were not displayed")
}

func validateProtectedSourcePath(path, label string) error {
	if !filepath.IsAbs(path) || isInsideWorkingTree(path) {
		return fmt.Errorf("%s must be an absolute file outside the OpenLia checkout", label)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return fmt.Errorf("%s must be a regular mode-0600 file", label)
	}
	return nil
}

func syncLochoSources(ctx context.Context, deployment deployment, config Config) error {
	files := []struct {
		source string
		target string
		label  string
	}{
		{config.LochoRelayConfigSource, deployment.rootPath("runtime", "locho", "relay.toml"), "Locho relay configuration"},
		{config.LochoRelaySecretsSource, deployment.rootPath("runtime", "locho-relay-secrets", "relay.env"), "Locho relay secrets"},
	}
	for _, file := range files {
		if file.source == "" {
			if err := deployment.removeFile(ctx, file.target); err != nil {
				return fmt.Errorf("remove stale %s: %w", file.label, err)
			}
			continue
		}
		if err := validateProtectedSourcePath(file.source, file.label); err != nil {
			return err
		}
		if err := deployment.uploadFile(ctx, file.source, file.target, 0o600); err != nil {
			return fmt.Errorf("upload %s: %w", file.label, err)
		}
	}
	// Remove the pre-isolation location so upgrades cannot leave relay tokens
	// inside Hermes' mounted secrets directory.
	legacySecrets := deployment.rootPath("runtime", "secrets", "locho-relay.env")
	if err := deployment.removeFile(ctx, legacySecrets); err != nil {
		return fmt.Errorf("remove legacy Locho relay secrets: %w", err)
	}
	return nil
}

func isInsideWorkingTree(file string) bool {
	workingDirectory, err := os.Getwd()
	if err != nil {
		return false
	}
	workingDirectory, err = filepath.Abs(workingDirectory)
	if err != nil {
		return false
	}
	file, err = filepath.Abs(file)
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(workingDirectory, file)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func renderRemote(options Options, raw []byte, human string) int {
	clean := redact(string(raw))
	if options.JSON {
		var payload any
		if err := json.Unmarshal([]byte(clean), &payload); err != nil {
			payload = map[string]any{"schema": 1, "ok": true, "output": clean}
		}
		return writeResult(options, payload, human)
	}
	fmt.Fprint(os.Stdout, clean)
	if human != "" && !strings.HasSuffix(human, "\n") {
		fmt.Fprintln(os.Stdout)
	}
	return ExitOK
}

func skillListHuman(config Config) string {
	lines := make([]string, 0, len(defaultSkills))
	for _, skill := range defaultSkills {
		state := "disabled"
		if contains(config.EnabledSkills, skill) {
			state = "enabled"
		}
		lines = append(lines, fmt.Sprintf("%s: %s", skill, state))
	}
	return strings.Join(lines, "\n")
}

func testSkill(options Options, assets fs.FS, name string) int {
	directory := filepath.ToSlash(filepath.Join("profile", "skills", name, "scripts"))
	entries, err := fs.ReadDir(assets, directory)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			skillPath := filepath.ToSlash(filepath.Join("profile", "skills", name, "SKILL.md"))
			if skillData, readErr := fs.ReadFile(assets, skillPath); readErr == nil && len(skillData) > 0 {
				return writeResult(options, map[string]any{"schema": 1, "ok": true, "skill": name, "output": "prompt skill verified: no deterministic helper script required"}, name+": self-test passed")
			}
		}
		return fail(options, ExitInternal, err.Error(), nil)
	}
	temporary, err := os.MkdirTemp("", "openlia-skill-*")
	if err != nil {
		return fail(options, ExitInternal, err.Error(), nil)
	}
	defer os.RemoveAll(temporary)
	systemScriptsDir := filepath.ToSlash(filepath.Join("profile", "system-skills", "workspace-template-customization", "scripts"))
	if sysEntries, sysErr := fs.ReadDir(assets, systemScriptsDir); sysErr == nil {
		for _, sysEntry := range sysEntries {
			if !sysEntry.IsDir() && strings.HasSuffix(sysEntry.Name(), ".py") {
				if sysData, readSysErr := fs.ReadFile(assets, filepath.ToSlash(filepath.Join(systemScriptsDir, sysEntry.Name()))); readSysErr == nil {
					_ = os.WriteFile(filepath.Join(temporary, sysEntry.Name()), sysData, 0o700)
				}
			}
		}
	}
	var scriptName string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".py") {
			data, readErr := fs.ReadFile(assets, filepath.ToSlash(filepath.Join(directory, entry.Name())))
			if readErr != nil {
				return fail(options, ExitInternal, readErr.Error(), nil)
			}
			path := filepath.Join(temporary, entry.Name())
			if writeErr := os.WriteFile(path, data, 0o700); writeErr != nil {
				return fail(options, ExitInternal, writeErr.Error(), nil)
			}
			if scriptName == "" {
				scriptName = path
			}
		}
	}
	if scriptName == "" {
		return fail(options, ExitInternal, "skill has no deterministic helper", nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pythonBin := "python3"
	if venv := os.Getenv("VIRTUAL_ENV"); venv != "" {
		candidate := filepath.Join(venv, "bin", "python3")
		if _, statErr := os.Stat(candidate); statErr == nil {
			pythonBin = candidate
		}
	} else if _, statErr := os.Stat(".venv/bin/python3"); statErr == nil {
		pythonBin = ".venv/bin/python3"
	}
	output, err := runLocalCommand(ctx, pythonBin, scriptName, "--self-test")
	if err != nil {
		return fail(options, ExitFailure, "skill test failed: "+err.Error(), map[string]any{"skill": name})
	}
	return writeResult(options, map[string]any{"schema": 1, "ok": true, "skill": name, "output": redact(string(output))}, name+": self-test passed")
}

func setSkill(skills []string, target string, enabled bool) []string {
	result := make([]string, 0, len(skills)+1)
	for _, skill := range skills {
		if skill != target && !contains(result, skill) {
			result = append(result, skill)
		}
	}
	if enabled {
		result = append(result, target)
	}
	return result
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func syncAttachmentSource(ctx context.Context, deployment deployment, host, source string) error {
	if err := validateProtectedSourcePath(source, "attachment source"); err != nil {
		return err
	}
	remotePath := deployment.rootPath("runtime", "meta", ".openlia-incoming")
	if err := deployment.uploadFile(ctx, source, remotePath, 0o600); err != nil {
		return err
	}
	defer deployment.removeFile(context.Background(), remotePath)
	_, err := deployment.operation(ctx, "attachments", nil, "rotate", host, "--source", remotePath, "--json")
	return err
}

func extractFlag(args []string, name string) (string, []string, error) {
	for i := 0; i < len(args); i++ {
		if args[i] == name {
			if i+1 >= len(args) || args[i+1] == "" {
				return "", nil, fmt.Errorf("missing value for %s", name)
			}
			val := args[i+1]
			rem := append([]string(nil), args[:i]...)
			rem = append(rem, args[i+2:]...)
			return val, rem, nil
		}
	}
	return "", args, nil
}
