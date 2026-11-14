package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
)

const (
	ExitOK       = 0
	ExitFailure  = 1
	ExitUsage    = 2
	ExitPrereq   = 3
	ExitInternal = 4
)

type Options struct {
	JSON           bool
	NonInteractive bool
	Follow         bool
	ProviderCheck  bool
	Release        bool
	Wait           bool
	Async          bool
	Live           bool
	ConfigPath     string
}

var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`\b(?:sk|ghp|gho|ghu|github_pat)_[A-Za-z0-9_\-]+`),
	regexp.MustCompile(`(?i)([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*)[^\s,;]+`),
	regexp.MustCompile(`(?i)(capabilit(?:y|ies)["']?\s*[:=]\s*["']?)[^\s,"']+`),
	regexp.MustCompile(`(?i)(\$argon2(?:id|i|d)\$v=\d+\$)[^\s]+`),
	regexp.MustCompile(`(\$2[aby]\$)[0-9]{2}\$[./A-Za-z0-9]{53}`),
}

func redact(value string) string {
	for _, pattern := range secretPatterns {
		value = pattern.ReplaceAllString(value, `${1}[REDACTED]`)
	}
	return value
}

func writeJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func writeResult(options Options, value any, human string) int {
	if options.JSON {
		if err := writeJSON(value); err != nil {
			fmt.Fprintf(os.Stderr, "openlia: %s\n", redact(err.Error()))
			return ExitInternal
		}
		return ExitOK
	}
	if human != "" {
		fmt.Fprintln(os.Stdout, redact(human))
	}
	return ExitOK
}

func fail(options Options, code int, message string, fields map[string]any) int {
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

func usage(out io.Writer) {
	fmt.Fprintln(out, `openlia - manage your self-hosted Hermes Agent deployment

OpenLia deploys and manages Hermes Agent with Locho tunneling,
encrypted local and remote backups, and the openlia-browser relay.

Run this CLI on the operator machine to deploy and manage OpenLia
locally or over SSH. In local mode the runtime runs on that machine;
with --target it runs on the selected SSH target. The same pattern
applies to openlia browser: the browser service is managed locally
or on its selected SSH target.

Usage:
  openlia deploy [--release] [--wait] | start [--wait] | stop [--wait] | restart [--wait]
  openlia job [status|logs [JOB_ID]]
  openlia auth [--config PATH] [--username USER] [--password-stdin]
  openlia auth --oidc [--config PATH] [--issuer URL] [--client-id ID] [--client-secret-stdin] [--public-url URL]
  openlia status [--live] [--check-providers] [--json]
  openlia uninstall [--local|--target user@host] [--project NAME] [--root /path]
  openlia logs [--follow]
  openlia attachments list
  openlia attachments map <host> <service> --role <role>
  openlia attachments rotate <host> --source PATH [--wait]
  openlia backup create|push|status|list|keygen|schedule install|remove [--wait]
  openlia backup restore [--archive PATH.age|--from NAME --latest|--object NAME]
  openlia backup rollback-restore --archive PATH
  openlia locho-host share [--output PATH]
  openlia browser configure --local|--target user@host --root PATH --extension-token-file PATH [--ssh-port PORT]
  openlia browser install|start|stop|restart|status|logs|uninstall

Global flags: --config PATH, --json, --non-interactive, --version, --help, --release, --wait, --async, --live, --check-providers

openlia deploy provisions, bootstraps, and reconciles the deployment defined in
config.toml (or specified with --config). Use openlia deploy --release to upload
and activate the release bundled in this CLI before applying configuration.

Secrets are accepted only through protected files or Hermes' configured secret source.`)
}
