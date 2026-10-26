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
	"path/filepath"
	"strconv"
	"strings"
	"time"

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
	if options.Release && remaining[0] != "deploy" {
		return fail(options, ExitUsage, "--release is only supported by deploy", nil)
	}

	switch remaining[0] {
	case "init":
		return commandInit(options, remaining[1:], assets)
	case "status":
		return commandHealth(options, remaining[1:], false)
	case "doctor":
		return commandHealth(options, remaining[1:], true)
	case "deploy", "start", "stop", "restart":
		return commandLifecycle(options, remaining[0], remaining[1:], assets)
	case "uninstall":
		return commandUninstall(options, remaining[1:])
	case "logs":
		return commandLogs(options, remaining[1:])
	case "update":
		return commandUpdate(options, remaining[1:], assets)
	case "skills":
		return commandSkills(options, remaining[1:], assets)
	case "features":
		return commandFeatures(options, remaining[1:], assets)
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
		case "--release":
			options.Release = true
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
	lochoHost := set.Bool("locho-host", false, "enable a Locho host for Workspace UI Chat and Editor")
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
	if hasArgument(args, "--locho-host") {
		config.LochoHostEnabled = *lochoHost
		if *lochoHost {
			config.WorkspaceUIHost = "127.0.0.1"
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
	if err := ensureLochoHostState(ctx, deployment, &config); err != nil {
		return fail(options, ExitFailure, "locho-host state setup failed: "+err.Error(), nil)
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
	deployment := newDeployment(config)
	raw, err := deployment.health(ctx, !strict, options.ProviderCheck)
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
		release := map[string]any{"configured_version": config.Version}
		if digest, digestErr := deployment.releaseDigest(ctx); digestErr == nil {
			release["active_sha256"] = digest
		} else {
			release["active_sha256_error"] = redact(digestErr.Error())
		}
		return writeResult(options, map[string]any{
			"schema":  1,
			"ok":      true,
			"mode":    config.Mode,
			"target":  config.Target,
			"root":    config.InstallRoot,
			"openlia": config.Version,
			"release": release,
			"hermes":  map[string]any{"tag": config.HermesTag, "digest": config.HermesDigest},
			"locho":   map[string]any{"version": config.LochoVersion},
			"health":  health,
		}, fmt.Sprintf("target=%s\n%s", config.Target, redact(string(raw))))
	}
	digest, digestErr := deployment.releaseDigest(ctx)
	releaseStatus := "unknown"
	if digestErr == nil {
		releaseStatus = digest
	}
	return writeResult(options, nil, fmt.Sprintf("mode=%s root=%s release=%s\n%s", config.Mode, config.InstallRoot, releaseStatus, redact(string(raw))))
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

func commandLifecycle(options Options, action string, args []string, assets fs.FS) int {
	if len(args) != 0 {
		return fail(options, ExitUsage, action+" does not accept positional arguments", nil)
	}
	if options.Release && action != "deploy" {
		return fail(options, ExitUsage, "--release is only supported by deploy", nil)
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	var bundled releaseIdentity
	var installedBefore string
	if action == "deploy" {
		if assets == nil {
			return fail(options, ExitInternal, "deploy requires bundled release assets", nil)
		}
		identity, err := bundledReleaseIdentity(assets)
		if err != nil {
			return fail(options, ExitInternal, "could not calculate bundled release identity: "+err.Error(), nil)
		}
		bundled = identity
		installedBefore, _ = deployment.releaseDigest(ctx)
		if !options.Release && installedBefore != "" && installedBefore != bundled.SHA256 {
			fmt.Fprintf(os.Stderr, "openlia deploy: local release %s differs from installed release %s; applying configuration only. Use openlia deploy --release to publish it.\n", bundled.SHA256, installedBefore)
		}
	}
	if options.Release {
		if !targetOperatorAssetsAvailable() {
			return fail(options, ExitPrereq, "OpenLia release deployment requires Linux operator artifacts; run `make build` first", nil)
		}
		if _, err := publishOpenLiaRelease(ctx, deployment, assets); err != nil {
			return fail(options, ExitFailure, "release publication failed: "+err.Error(), nil)
		}
		if err := syncLochoSources(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage Locho relay configuration: "+err.Error(), nil)
		}
		if _, err := deployment.operation(ctx, "attachments", nil, "generate", "--json"); err != nil {
			return fail(options, ExitFailure, "attachment Compose generation failed: "+err.Error(), nil)
		}
		if _, err := deployment.operation(ctx, "deploy", nil, "profile", "--json"); err != nil {
			return fail(options, ExitFailure, "profile deployment failed: "+err.Error(), nil)
		}
	}
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
	if action != "deploy" {
		return renderRemote(options, raw, "openlia "+action+": "+redact(string(raw)))
	}

	releaseReport, verifyErr := collectDeploymentReleaseReport(ctx, deployment, config, bundled.SHA256, installedBefore, options.Release)
	if verifyErr != nil {
		return fail(options, ExitFailure, "deployment completed but release verification failed: "+verifyErr.Error(), releaseReport.fields())
	}
	human := "openlia deploy: release=" + releaseReport.InstalledAfter
	if !options.Release && !releaseReport.BundledActive {
		human += "; local bundled release is not active, use `openlia deploy --release` to publish it"
	} else if releaseReport.UIError != nil {
		human += "; Workspace UI build identity unavailable: " + releaseReport.UIError.Error()
	} else {
		human += "; release verified"
	}
	return renderLifecycleResult(options, raw, releaseReport.fields(), human)
}

func publishOpenLiaRelease(ctx context.Context, deployment deployment, assets fs.FS) (releaseIdentity, error) {
	archive, digest, err := releaseArchive(assets)
	if err != nil {
		return releaseIdentity{}, fmt.Errorf("package bundled release: %w", err)
	}
	if err := deployment.uploadRelease(ctx, archive, digest); err != nil {
		return releaseIdentity{}, fmt.Errorf("upload release: %w", err)
	}
	if err := deployment.activateRelease(ctx); err != nil {
		return releaseIdentity{}, fmt.Errorf("activate release: %w", err)
	}
	return releaseIdentity{Version: defaultVersion, SHA256: digest}, nil
}

type deploymentReleaseReport struct {
	BundledSHA256  string
	BeforeSHA256   string
	InstalledAfter string
	Published      bool
	BundledActive  bool
	WorkspaceUI    string
	UIVerified     bool
	UIError        error
}

func (report deploymentReleaseReport) fields() map[string]any {
	fields := map[string]any{
		"bundled_release_sha256":  report.BundledSHA256,
		"installed_before_sha256": report.BeforeSHA256,
		"installed_after_sha256":  report.InstalledAfter,
		"release_published":       report.Published,
		"bundled_release_active":  report.BundledActive,
	}
	if report.WorkspaceUI != "" || report.UIError != nil {
		fields["workspace_ui_sha256"] = report.WorkspaceUI
		fields["workspace_ui_verified"] = report.UIVerified
	}
	if report.UIError != nil {
		fields["workspace_ui_verification_error"] = report.UIError.Error()
	}
	return fields
}

func collectDeploymentReleaseReport(ctx context.Context, deployment deployment, config Config, bundledDigest, beforeDigest string, published bool) (deploymentReleaseReport, error) {
	report := deploymentReleaseReport{
		BeforeSHA256:  beforeDigest,
		BundledSHA256: bundledDigest,
		Published:     published,
	}
	installedAfter, err := deployment.releaseDigest(ctx)
	if err != nil {
		return report, err
	}
	report.InstalledAfter = installedAfter
	report.BundledActive = installedAfter == bundledDigest
	if config.WorkspaceUIHost != "" {
		report.WorkspaceUI, report.UIError = deployment.workspaceUIReleaseDigest(ctx)
		report.UIVerified = report.UIError == nil && report.WorkspaceUI == installedAfter
	}
	if published && !report.BundledActive {
		return report, fmt.Errorf("active release %s does not match bundled release %s", installedAfter, bundledDigest)
	}
	if published && config.WorkspaceUIHost != "" {
		if report.UIError != nil {
			return report, fmt.Errorf("Workspace UI build identity unavailable: %w", report.UIError)
		}
		if !report.UIVerified {
			return report, fmt.Errorf("Workspace UI release %s does not match active release %s", report.WorkspaceUI, installedAfter)
		}
	}
	return report, nil
}

func renderLifecycleResult(options Options, raw []byte, report map[string]any, human string) int {
	if !options.JSON {
		return renderRemote(options, raw, human)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(redact(string(raw))), &payload); err != nil {
		payload = map[string]any{"schema": 1, "ok": true, "output": redact(string(raw))}
	}
	payload["release"] = report
	return writeResult(options, payload, human)
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
	if component != "openlia" && component != "hermes" && component != "locho" {
		return fail(options, ExitUsage, "component must be openlia, hermes, or locho", nil)
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
			return fail(options, ExitPrereq, "OpenLia updates require Linux operator artifacts; run `make build` first", nil)
		}
		installedBefore, _ := deployment.releaseDigest(ctx)
		release, err := publishOpenLiaRelease(ctx, deployment, assets)
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		digest := release.SHA256
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
		releaseReport, verifyErr := collectDeploymentReleaseReport(ctx, deployment, config, digest, installedBefore, true)
		if verifyErr != nil {
			return fail(options, ExitFailure, "release update completed but verification failed: "+verifyErr.Error(), releaseReport.fields())
		}
		return renderOpenLiaUpdate(ctx, deployment, options, profileRaw, releaseReport.fields())
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
	raw, err := deployment.deploy(ctx, "deploy", true, component)
	if err != nil {
		return fail(options, ExitFailure, err.Error(), map[string]any{"component": component})
	}
	return renderRemote(options, raw, "openlia update "+component+": pinned runtime reconciled")
}

func renderOpenLiaUpdate(ctx context.Context, deployment deployment, options Options, raw []byte, releaseReport map[string]any) int {
	if options.JSON {
		return renderLifecycleResult(options, raw, releaseReport, "")
	}
	var envelope struct {
		ProfileSync struct {
			Instructions instructionStatusEnvelope `json:"instructions"`
		} `json:"profile_sync"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return fail(options, ExitFailure, "could not parse OpenLia update result", nil)
	}
	fmt.Fprintf(os.Stdout, "openlia update openlia: profile assets synchronized; release=%v verified\n", releaseReport["installed_after_sha256"])
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
	deployment := newDeployment(config)
	hadStateDir := config.LochoHostStateDir != ""
	if err := ensureLochoHostState(ctx, deployment, &config); err != nil {
		return fail(options, ExitFailure, "could not persist Locho host state: "+err.Error(), nil)
	}
	if !hadStateDir && config.LochoHostStateDir != "" {
		if err := saveConfig(config); err != nil {
			return fail(options, ExitFailure, "could not save Locho host state directory: "+err.Error(), nil)
		}
	}
	raw, err := deployment.operation(ctx, "locho-host", nil, "share")
	if err != nil {
		return fail(options, ExitFailure, "could not generate Locho attachment configuration: "+err.Error(), nil)
	}
	attachmentConfig := string(raw)
	hostID, err := attachmentHostID(attachmentConfig)
	if err != nil || !strings.Contains(attachmentConfig, "capability = \"workspace-ui:tcp:") {
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
		"services": []string{"workspace-ui"},
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
	if err := syncLochoHostState(ctx, deployment, &config); err != nil {
		return err
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
