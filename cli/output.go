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
}

var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`\b(?:sk|ghp|gho|ghu|github_pat)_[A-Za-z0-9_\-]+`),
	regexp.MustCompile(`(?i)([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*)[^\s,;]+`),
	regexp.MustCompile(`(?i)(capabilit(?:y|ies)["']?\s*[:=]\s*["']?)[^\s,"']+`),
	regexp.MustCompile(`(?i)(\$argon2(?:id|i|d)\$v=\d+\$)[^\s]+`),
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
	fmt.Fprintln(out, `openlia - a thin Hermes Agent operations control plane

Run this CLI on the operator machine. In local mode it runs the agent on that
machine; with --target it uses SSH to install and control the agent on another
machine. The same pattern applies to openlia browser: the browser service is
managed locally or on its selected SSH target.

Usage:
  openlia init [--local|--target user@host] [--root /path] [--project NAME]
                [--timezone Asia/Ho_Chi_Minh] [--model MODEL] [--provider PROVIDER]
                [--external-network NAME] [--api] [--api-host 127.0.0.1]
                [--open-webui] [--open-webui-port 8090] [--locho-host]
  openlia status [--json]
  openlia doctor [--json]
  openlia deploy [--release] | start | stop | restart
  openlia uninstall [--local|--target user@host] [--project NAME] [--root /path]
  openlia logs [--follow]
  openlia update [openlia|hermes|locho|open-webui]
  openlia skills list|show|test
  openlia skills status|fork|migrate|enable|disable
  openlia auth list|setup|rotate
  openlia attachments list
  openlia attachments map <host> <service> --role <role>
  openlia attachments rotate <host> --source PATH
  openlia backup create|push|status|list|keygen|schedule install|remove
  openlia backup restore [--archive PATH.age|--from NAME --latest|--object NAME]
  openlia backup rollback-restore --archive PATH
  openlia workspace serve [<path>] [--port 8089] [--bind 127.0.0.1] [--open] [--skills PATH]
  openlia workspace export [PATH.zip]
  openlia workspace git setup|status
  openlia workspace migrate [<path>|upload <path>|status [id]|merge [id]|list] [--dry-run]  (beta)
  openlia instructions status [NAME]
  openlia instructions diff|merge|keep|reset NAME
  openlia workspace-ui password
  openlia locho-host share [--output PATH]
  openlia browser configure --local|--target user@host --root PATH --extension-token-file PATH [--ssh-port PORT]
  openlia browser install|start|stop|restart|status|logs|uninstall
  openlia telegram id [--token TOKEN]

Global flags: --json, --non-interactive, --version, --help, --release

openlia deploy applies configuration using the release already installed on
the target. Use openlia deploy --release to upload and activate the release
bundled in this CLI before applying configuration.

workspace-ui password prompts without echo and prints only an Argon2id hash.
Copy it into [workspace-ui].password_hash in config.toml, then run openlia deploy.

Secrets are accepted only through protected files or Hermes' configured secret source.`)
}
