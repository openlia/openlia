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

	"golang.org/x/term"
	"openlia/operator"
)

func Run(args []string, assets fs.FS) int {
	options, remaining, err := splitCommonFlags(args)
	if err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}
	if options.ConfigPath != "" {
		prevConfig, hadPrev := os.LookupEnv("OPENLIA_CONFIG")
		_ = os.Setenv("OPENLIA_CONFIG", expandTilde(options.ConfigPath))
		defer func() {
			if hadPrev {
				_ = os.Setenv("OPENLIA_CONFIG", prevConfig)
			} else {
				_ = os.Unsetenv("OPENLIA_CONFIG")
			}
		}()
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
	case "auth":
		return commandAuth(options, remaining[1:])
	case "status":
		return commandHealth(options, remaining[1:], false)
	case "deploy", "start", "stop", "restart":
		return commandLifecycle(options, remaining[0], remaining[1:], assets)
	case "uninstall":
		return commandUninstall(options, remaining[1:])
	case "logs":
		return commandLogs(options, remaining[1:])
	case "attachments":
		return commandAttachments(options, remaining[1:])
	case "backup":
		return commandBackup(options, remaining[1:])
	case "locho-host":
		return commandLochoHost(options, remaining[1:])
	case "browser":
		return commandOpenLiaBrowser(options, remaining[1:], assets)
	default:
		return fail(options, ExitUsage, fmt.Sprintf("unknown command %q", remaining[0]), map[string]any{"hint": "run openlia --help"})
	}
}

func splitCommonFlags(args []string) (Options, []string, error) {
	options := Options{}
	remaining := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--json":
			options.JSON = true
		case arg == "--non-interactive":
			options.NonInteractive = true
		case arg == "--release":
			options.Release = true
		case arg == "--follow":
			options.Follow = true
		case arg == "--check-providers":
			options.ProviderCheck = true
		case arg == "--config" || arg == "-config":
			if i+1 >= len(args) || strings.TrimSpace(args[i+1]) == "" {
				return options, nil, errors.New("missing value for --config")
			}
			i++
			options.ConfigPath = strings.TrimSpace(args[i])
		case strings.HasPrefix(arg, "--config="):
			val := strings.TrimSpace(strings.TrimPrefix(arg, "--config="))
			if val == "" {
				return options, nil, errors.New("missing value for --config")
			}
			options.ConfigPath = val
		case arg == "--help" || arg == "-h":
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
		return Config{}, fail(options, ExitPrereq, fmt.Sprintf("OpenLia configuration not found at %s; create config.toml or specify path with --config", configPath()), map[string]any{"config": configPath()})
	}
	return Config{}, fail(options, ExitFailure, err.Error(), nil)
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
	if action == "deploy" {
		if config.SecretSource != "" {
			if err := validateProtectedSourcePath(config.SecretSource, "secret source"); err != nil {
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
		for _, host := range config.Services {
			if host.Source != "" && host.Name != "" {
				if err := validateProtectedSourcePath(host.Source, "attachment source"); err != nil {
					return fail(options, ExitUsage, err.Error(), nil)
				}
			}
		}
		origRecipient := config.BackupRecipient
		origIdentityFile := config.BackupIdentityFile
		if err := ensureBackupIdentity(&config); err != nil {
			return fail(options, ExitFailure, "backup encryption key setup failed: "+err.Error(), nil)
		}
		if config.BackupRecipient != origRecipient || config.BackupIdentityFile != origIdentityFile {
			if err := saveConfig(config); err != nil {
				return fail(options, ExitInternal, "could not save operator config: "+err.Error(), nil)
			}
		}
		if err := validateConfig(config); err != nil {
			return fail(options, ExitUsage, err.Error(), nil)
		}
	}

	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	var bundled releaseIdentity
	var installedBefore string
	var shouldPublish bool

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
		isInitialBootstrap := installedBefore == ""
		shouldPublish = options.Release || isInitialBootstrap

		if !shouldPublish && installedBefore != "" && installedBefore != bundled.SHA256 {
			fmt.Fprintf(os.Stderr, "openlia deploy: local release %s differs from installed release %s; applying configuration only. Use openlia deploy --release to publish it.\n", bundled.SHA256, installedBefore)
		}

		if shouldPublish {
			if !targetOperatorAssetsAvailable() {
				return fail(options, ExitPrereq, "OpenLia release deployment requires Linux operator artifacts; run `make build` first", nil)
			}
			if _, err := publishOpenLiaRelease(ctx, deployment, assets); err != nil {
				return fail(options, ExitFailure, "release publication failed: "+err.Error(), nil)
			}
		}

		origLochoStateDir := config.LochoHostStateDir
		if err := ensureLochoHostState(ctx, deployment, &config); err != nil {
			return fail(options, ExitFailure, "locho-host state setup failed: "+err.Error(), nil)
		}
		if config.LochoHostStateDir != origLochoStateDir {
			_ = saveConfig(config)
		}
		if config.SecretSource != "" {
			if err := syncSecretSource(ctx, deployment, config.SecretSource); err != nil {
				return fail(options, ExitFailure, "could not stage secret source: "+err.Error(), nil)
			}
		}
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
		if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage backup writer credentials: "+err.Error(), nil)
		}
		if shouldPublish {
			if _, err := deployment.bootstrap(ctx); err != nil {
				return fail(options, ExitFailure, "runtime bootstrap failed: "+err.Error(), nil)
			}
			if _, err := deployment.operation(ctx, "deploy", nil, "profile", "--json"); err != nil {
				return fail(options, ExitFailure, "profile deployment failed: "+err.Error(), nil)
			}
		}
		if _, err := deployment.operation(ctx, "attachments", nil, "generate", "--json"); err != nil {
			return fail(options, ExitFailure, "attachment Compose generation failed: "+err.Error(), nil)
		}
	}
	if action == "start" || action == "restart" {
		if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage backup writer credentials: "+err.Error(), nil)
		}
		if err := syncLochoSources(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage Locho relay configuration: "+err.Error(), nil)
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
			return fail(options, ExitFailure, "profile synchronization failed: "+err.Error(), map[string]any{"action": action})
		}
	}
	if action != "deploy" {
		return renderRemote(options, raw, "openlia "+action+": "+redact(string(raw)))
	}

	releaseReport, verifyErr := collectDeploymentReleaseReport(ctx, deployment, config, bundled.SHA256, installedBefore, shouldPublish)
	if verifyErr != nil {
		return fail(options, ExitFailure, "deployment completed but release verification failed: "+verifyErr.Error(), releaseReport.fields())
	}
	human := "openlia deploy: release=" + releaseReport.InstalledAfter
	if !shouldPublish && !releaseReport.BundledActive {
		human += "; local bundled release is not active, use `openlia deploy --release` to publish it"
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
}

func (report deploymentReleaseReport) fields() map[string]any {
	return map[string]any{
		"bundled_release_sha256":  report.BundledSHA256,
		"installed_before_sha256": report.BeforeSHA256,
		"installed_after_sha256":  report.InstalledAfter,
		"release_published":       report.Published,
		"bundled_release_active":  report.BundledActive,
	}
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
	if published && !report.BundledActive {
		return report, fmt.Errorf("active release %s does not match bundled release %s", installedAfter, bundledDigest)
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
	if err != nil || !strings.Contains(attachmentConfig, "capability = \"hermes-api:tcp:") || !strings.Contains(attachmentConfig, "capability = \"hermes-dashboard:tcp:") {
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
		"services": []string{"hermes-api", "hermes-dashboard"},
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

func syncSecretSource(ctx context.Context, deployment deployment, source string) error {
	if err := validateProtectedSourcePath(source, "secret source"); err != nil {
		return err
	}
	remotePath := deployment.rootPath("runtime", "meta", ".openlia-incoming")
	if err := deployment.uploadFile(ctx, source, remotePath, 0o600); err != nil {
		return err
	}
	defer deployment.removeFile(context.Background(), remotePath)
	_, err := deployment.operation(ctx, "auth", nil, "rotate", "--source", remotePath, "--json")
	return err
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

func commandAuth(options Options, args []string) int {
	set := newFlagSet("auth")
	oidcMode := set.Bool("oidc", false, "configure OpenID Connect (GCP OAuth / Auth0) instead of Basic Auth")
	usernameFlag := set.String("username", "", "Hermes Dashboard Basic Auth username")
	passwordStdin := set.Bool("password-stdin", false, "read Hermes Dashboard Basic Auth password from stdin")
	issuerFlag := set.String("issuer", "", "OIDC issuer URL (e.g. https://accounts.google.com or https://tenant.us.auth0.com)")
	clientIDFlag := set.String("client-id", "", "OIDC Client ID")
	clientSecretStdin := set.Bool("client-secret-stdin", false, "read OIDC Client Secret from stdin")
	scopesFlag := set.String("scopes", "", "OIDC scopes (default: openid profile email)")
	publicURLFlag := set.String("public-url", "", "Hermes Dashboard external public URL (e.g. http://127.0.0.1:9119 or https://hermes.example.com)")
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if set.NArg() != 0 {
		return fail(options, ExitUsage, "auth does not accept positional arguments", nil)
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	secretPath := expandTilde(strings.TrimSpace(config.SecretSource))
	if secretPath == "" {
		return fail(options, ExitUsage, "secrets.source is not configured in config.toml", map[string]any{"config": configPath()})
	}
	if err := validateProtectedSourcePath(secretPath, "secret source"); err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}

	reader := bufio.NewReader(os.Stdin)
	if *oidcMode {
		return configureOIDCAuth(options, secretPath, reader, strings.TrimSpace(*issuerFlag), strings.TrimSpace(*clientIDFlag), *clientSecretStdin, strings.TrimSpace(*scopesFlag), strings.TrimSpace(*publicURLFlag))
	}

	defaultUser := readSecretEnvValue(secretPath, "HERMES_DASHBOARD_BASIC_AUTH_USERNAME")
	if defaultUser == "" {
		defaultUser = "admin"
	}

	username := strings.TrimSpace(*usernameFlag)
	var password string

	if *passwordStdin {
		if username == "" {
			username = defaultUser
		}
		line, err := reader.ReadString('\n')
		if err != nil && len(line) == 0 {
			return fail(options, ExitUsage, "could not read password from stdin", nil)
		}
		password = strings.TrimRight(line, "\r\n")
	} else {
		if options.NonInteractive {
			return fail(options, ExitUsage, "non-interactive auth requires --username and --password-stdin", nil)
		}
		if username == "" {
			fmt.Fprintf(os.Stderr, "Hermes Dashboard username [%s]: ", defaultUser)
			line, err := reader.ReadString('\n')
			if err != nil && len(line) == 0 {
				return fail(options, ExitFailure, "could not read username", nil)
			}
			username = strings.TrimSpace(line)
			if username == "" {
				username = defaultUser
			}
		}
		var err error
		password, err = readConfirmedDashboardPassword(reader)
		if err != nil {
			return fail(options, ExitUsage, err.Error(), nil)
		}
	}

	if err := validateDashboardCredentials(username, password); err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}

	if err := mutateSecretSourceVars(secretPath, []struct{ key, value string }{
		{"HERMES_DASHBOARD_BASIC_AUTH_USERNAME", username},
		{"HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", password},
	}, []string{
		"HERMES_DASHBOARD_OIDC_ISSUER",
		"HERMES_DASHBOARD_OIDC_CLIENT_ID",
		"HERMES_DASHBOARD_OIDC_CLIENT_SECRET",
		"HERMES_DASHBOARD_OIDC_SCOPES",
	}); err != nil {
		return fail(options, ExitFailure, "could not update secret source: "+err.Error(), nil)
	}

	return writeResult(options, map[string]any{
		"schema":        1,
		"ok":            true,
		"action":        "auth",
		"mode":          "basic",
		"secret_source": secretPath,
		"username":      username,
		"keys": []string{
			"HERMES_DASHBOARD_BASIC_AUTH_USERNAME",
			"HERMES_DASHBOARD_BASIC_AUTH_PASSWORD",
		},
	}, fmt.Sprintf("openlia auth: updated HERMES_DASHBOARD_BASIC_AUTH_USERNAME (%s) and HERMES_DASHBOARD_BASIC_AUTH_PASSWORD in %s", username, secretPath))
}

func configureOIDCAuth(options Options, secretPath string, reader *bufio.Reader, issuer, clientID string, secretStdin bool, scopes, publicURL string) int {
	defaultIssuer := readSecretEnvValue(secretPath, "HERMES_DASHBOARD_OIDC_ISSUER")
	if defaultIssuer == "" {
		defaultIssuer = "https://accounts.google.com"
	}
	defaultClientID := readSecretEnvValue(secretPath, "HERMES_DASHBOARD_OIDC_CLIENT_ID")
	defaultPublicURL := readSecretEnvValue(secretPath, "HERMES_DASHBOARD_PUBLIC_URL")
	if defaultPublicURL == "" {
		defaultPublicURL = "http://127.0.0.1:9119"
	}

	var clientSecret string
	if secretStdin {
		line, err := reader.ReadString('\n')
		if err != nil && len(line) == 0 {
			return fail(options, ExitUsage, "could not read client secret from stdin", nil)
		}
		clientSecret = strings.TrimRight(line, "\r\n")
	} else if !options.NonInteractive {
		if issuer == "" {
			fmt.Fprintf(os.Stderr, "OIDC Issuer URL [%s]: ", defaultIssuer)
			line, err := reader.ReadString('\n')
			if err != nil && len(line) == 0 {
				return fail(options, ExitFailure, "could not read OIDC issuer", nil)
			}
			issuer = strings.TrimSpace(line)
			if issuer == "" {
				issuer = defaultIssuer
			}
		}
		if clientID == "" {
			if defaultClientID != "" {
				fmt.Fprintf(os.Stderr, "OIDC Client ID [%s]: ", defaultClientID)
			} else {
				fmt.Fprint(os.Stderr, "OIDC Client ID: ")
			}
			line, err := reader.ReadString('\n')
			if err != nil && len(line) == 0 {
				return fail(options, ExitFailure, "could not read OIDC client ID", nil)
			}
			clientID = strings.TrimSpace(line)
			if clientID == "" {
				clientID = defaultClientID
			}
		}
		fd := int(os.Stdin.Fd())
		fmt.Fprint(os.Stderr, "OIDC Client Secret (required for GCP OAuth; leave empty for public PKCE client): ")
		if term.IsTerminal(fd) {
			raw, err := term.ReadPassword(fd)
			fmt.Fprintln(os.Stderr)
			if err != nil {
				return fail(options, ExitFailure, "could not read OIDC client secret", nil)
			}
			clientSecret = strings.TrimSpace(string(raw))
		} else {
			line, err := reader.ReadString('\n')
			if err != nil && len(line) == 0 {
				return fail(options, ExitFailure, "could not read OIDC client secret", nil)
			}
			clientSecret = strings.TrimRight(line, "\r\n")
		}
		if publicURL == "" {
			fmt.Fprintf(os.Stderr, "Dashboard Public URL [%s]: ", defaultPublicURL)
			line, err := reader.ReadString('\n')
			if err != nil && len(line) == 0 {
				return fail(options, ExitFailure, "could not read Dashboard public URL", nil)
			}
			publicURL = strings.TrimSpace(line)
			if publicURL == "" {
				publicURL = defaultPublicURL
			}
		}
	}

	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	if issuer == "" || (!strings.HasPrefix(issuer, "https://") && !strings.HasPrefix(issuer, "http://127.0.0.1") && !strings.HasPrefix(issuer, "http://localhost")) {
		return fail(options, ExitUsage, "OIDC issuer must be an https:// URL (or http://localhost for local testing)", nil)
	}
	if clientID == "" || strings.ContainsAny(clientID, " \t\r\n\x00") {
		return fail(options, ExitUsage, "OIDC client_id is required and must not contain whitespace", nil)
	}
	if strings.ContainsAny(clientSecret, "\r\n\x00") {
		return fail(options, ExitUsage, "OIDC client_secret must not contain newlines or null bytes", nil)
	}
	publicURL = strings.TrimRight(strings.TrimSpace(publicURL), "/")

	updates := []struct{ key, value string }{
		{"HERMES_DASHBOARD_OIDC_ISSUER", issuer},
		{"HERMES_DASHBOARD_OIDC_CLIENT_ID", clientID},
	}
	keys := []string{"HERMES_DASHBOARD_OIDC_ISSUER", "HERMES_DASHBOARD_OIDC_CLIENT_ID"}
	removals := []string{
		"HERMES_DASHBOARD_BASIC_AUTH_USERNAME",
		"HERMES_DASHBOARD_BASIC_AUTH_PASSWORD",
	}
	if clientSecret != "" {
		updates = append(updates, struct{ key, value string }{"HERMES_DASHBOARD_OIDC_CLIENT_SECRET", clientSecret})
		keys = append(keys, "HERMES_DASHBOARD_OIDC_CLIENT_SECRET")
	} else {
		removals = append(removals, "HERMES_DASHBOARD_OIDC_CLIENT_SECRET")
	}
	if scopes != "" {
		updates = append(updates, struct{ key, value string }{"HERMES_DASHBOARD_OIDC_SCOPES", scopes})
		keys = append(keys, "HERMES_DASHBOARD_OIDC_SCOPES")
	} else {
		removals = append(removals, "HERMES_DASHBOARD_OIDC_SCOPES")
	}
	if publicURL != "" {
		updates = append(updates, struct{ key, value string }{"HERMES_DASHBOARD_PUBLIC_URL", publicURL})
		keys = append(keys, "HERMES_DASHBOARD_PUBLIC_URL")
	}

	if err := mutateSecretSourceVars(secretPath, updates, removals); err != nil {
		return fail(options, ExitFailure, "could not update secret source: "+err.Error(), nil)
	}
	callbackURL := "/auth/callback"
	if publicURL != "" {
		callbackURL = publicURL + "/auth/callback"
	}
	return writeResult(options, map[string]any{
		"schema":        1,
		"ok":            true,
		"action":        "auth",
		"mode":          "oidc",
		"secret_source": secretPath,
		"issuer":        issuer,
		"client_id":     clientID,
		"callback_url":  callbackURL,
		"keys":          keys,
	}, fmt.Sprintf("openlia auth: configured OIDC (issuer=%s, client_id=%s, callback=%s) in %s", issuer, clientID, callbackURL, secretPath))
}

func readConfirmedDashboardPassword(reader *bufio.Reader) (string, error) {
	fd := int(os.Stdin.Fd())
	isTTY := term.IsTerminal(fd)
	readOne := func(prompt string) (string, error) {
		fmt.Fprint(os.Stderr, prompt)
		if isTTY {
			raw, err := term.ReadPassword(fd)
			fmt.Fprintln(os.Stderr)
			if err != nil {
				return "", fmt.Errorf("could not read password: %w", err)
			}
			return string(raw), nil
		}
		line, err := reader.ReadString('\n')
		if err != nil && len(line) == 0 {
			return "", errors.New("could not read password")
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	first, err := readOne("Hermes Dashboard password: ")
	if err != nil {
		return "", err
	}
	if first == "" {
		return "", errors.New("password must not be empty")
	}
	second, err := readOne("Confirm Hermes Dashboard password: ")
	if err != nil {
		return "", err
	}
	if first != second {
		return "", errors.New("passwords do not match")
	}
	return first, nil
}

func validateDashboardCredentials(username, password string) error {
	if username == "" {
		return errors.New("username must not be empty")
	}
	if strings.ContainsAny(username, " \t\r\n\x00=") {
		return errors.New("username must not contain whitespace, '=', or control characters")
	}
	if password == "" {
		return errors.New("password must not be empty")
	}
	if strings.ContainsAny(password, "\r\n\x00") {
		return errors.New("password must not contain newlines or null bytes")
	}
	return nil
}

func readSecretEnvValue(path, key string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSuffix(rawLine, "\r")
		if line == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if ok && strings.TrimSpace(k) == key {
			return v
		}
	}
	return ""
}

func mutateSecretSourceVars(path string, updates []struct{ key, value string }, removals []string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	rawLines := strings.Split(string(data), "\n")
	if len(rawLines) > 0 && rawLines[len(rawLines)-1] == "" {
		rawLines = rawLines[:len(rawLines)-1]
	}
	seen := make(map[string]bool, len(updates))
	updateMap := make(map[string]string, len(updates))
	for _, item := range updates {
		updateMap[item.key] = item.value
	}
	removeMap := make(map[string]bool, len(removals))
	for _, key := range removals {
		removeMap[key] = true
	}
	filtered := make([]string, 0, len(rawLines)+len(updates))
	for _, rawLine := range rawLines {
		line := strings.TrimSuffix(rawLine, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			filtered = append(filtered, line)
			continue
		}
		k, _, ok := strings.Cut(line, "=")
		if !ok {
			filtered = append(filtered, line)
			continue
		}
		key := strings.TrimSpace(k)
		if removeMap[key] {
			continue
		}
		if newVal, exists := updateMap[key]; exists {
			filtered = append(filtered, key+"="+newVal)
			seen[key] = true
			continue
		}
		filtered = append(filtered, line)
	}
	for _, item := range updates {
		if !seen[item.key] {
			filtered = append(filtered, item.key+"="+item.value)
		}
	}
	content := strings.Join(filtered, "\n") + "\n"
	return writePrivateFileAtomic(path, []byte(content))
}
