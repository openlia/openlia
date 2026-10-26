# Smoke Tests

The smoke runner has three documented purposes:

- `--mode cli` exercises the local CLI, bundled skills, Compose syntax, and
  shell syntax with synthetic data.
- `--mode local` deploys the current checkout locally, exercises the lifecycle,
  and removes the disposable installation.
- `--mode live` deploys the current checkout to an explicitly named disposable
  target and waits for manual Telegram confirmation. Add `--local` to use the
  local CLI backend. See [`docs/E2E_DRILLS.md`](../docs/E2E_DRILLS.md) for a
  step-by-step operational runbook using `openlia_dev`.

The runner reports `PASS`, `FAIL`, or `N/A`. `N/A` means a prerequisite or
interactive confirmation was unavailable; it is not evidence that the check
passed. The process exit code fails only when a case is `FAIL`.

## Local Smoke

Run the safe local gate from the repository root:

```sh
python3 tests/smoke.py --mode cli
```

The local gate does not contact a provider, Telegram, or Locho.

Run the real local deployment smoke with Docker Engine on Linux or Docker
Desktop on macOS:

```sh
python3 tests/smoke.py --mode local \
  --root /tmp/openlia_smoke \
  --project openlia_smoke
```

The optional Workspace UI proof uses a separate disposable mode. It enables a
`[workspace-ui]` section on an available loopback port, checks loopback health, edits a
Markdown file, verifies revision conflicts, exercises restart and backup/restore,
then disables the UI. Loopback mode does not require a password; an all-interface
smoke configuration must provision `password_hash` and authenticate before
accessing workspace APIs:

```sh
python3 tests/smoke.py --mode workspace-ui \
  --root /tmp/openlia_workspace_ui_smoke \
  --project openlia_workspace_ui_smoke
```

This invokes `openlia init --local`, checks health, stops and starts the stack,
checks the bundled helper and the installed runtime skill inside Hermes, and
invokes `openlia uninstall --local`. It uses an empty synthetic secret source
and does not contact a provider or Telegram.

The operator tests also cover the provider-free skill lifecycle: forking a
managed skill, preserving it across an OpenLia update, staging a migration
context, applying an approved proposal, and restoring its provenance metadata.

The root must not already exist. Local mode always attempts cleanup after the
run; if initialization or uninstall fails, the root is left in place for
inspection rather than being removed by the Python harness. Docker images and
build cache are preserved.

## Live Smoke

Live mode requires every deployment input. It has no target, project, root, or
Locho-host defaults. Remote mode requires `--target`; local mode requires
`--local`. The only optional behavior is `--cleanup`, which defaults to `false`.

The source files contain credentials and Locho capabilities. The runner changes
both source files to mode `0600`, stages protected temporary copies outside the
checkout, and never prints their values. The source files must be regular files
outside the checkout. Reports are redacted but may still contain operational
data; keep them outside the repository.

The current live smoke configuration uses Copilot as its primary provider and
requires `COPILOT_GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, and
`TELEGRAM_ALLOWED_USERS`. Do not include `OPENAI_BASE_URL`; gateway URLs belong
in the configured `fallback_providers` entries instead.

## Workspace Git

The provider-free CLI and local smoke checks validate the bundled workspace Git
history skill, image tooling, protected workspace template, and local repository
initialization. Workspace Git is local-only; encrypted OpenLia backups provide
recovery and off-machine copies.

Run against a disposable Linux target with external local inputs. Replace the
target and root placeholders with values for your own environment:

```sh
python3 tests/smoke.py --mode live \
  --target user@example.invalid \
  --project openlia_smoke \
  --root /srv/openlia-smoke \
  --env-file "$HOME/.config/openlia/dev/openlia_dev.env" \
  --attachments-file "$HOME/.config/openlia/dev/locho-attachments.toml" \
  --locho-host genai
```

Run live mode from an interactive terminal so the two Telegram confirmations
can be answered. A non-interactive invocation records those manual cases as
`N/A` rather than claiming that Telegram was tested.

The `--locho-host` value must match the host and service names in your
attachment configuration. The installation root must not already exist; this
keeps the optional cleanup operation scoped to a deployment created by this run.

The runner performs these live checks:

- Upload and initialize the current OpenLia release.
- Rotate the `genai` Locho attachment and reconcile its sidecar.
- Run the provider-backed Hermes health check.
- Confirm the `personal-finance` skill exists in the runtime.
- Ask for manual confirmation that Telegram delivered a reply.
- Ask for manual confirmation that the reply followed the finance workflow.

The same provider-backed checks can use the local backend. Omit `--cleanup` to
leave the local agent running for manual conversation:

```sh
python3 tests/smoke.py --mode live --local \
  --project openlia_smoke \
  --root /tmp/openlia_smoke \
  --env-file "$HOME/.config/openlia/dev/openlia_dev.env" \
  --attachments-file "$HOME/.config/openlia/dev/locho-attachments.toml" \
  --locho-host genai
```

The equivalent Make target accepts credential paths through environment
variables and also leaves the deployment running:

```sh
make smoke-local-live \
  OPENLIA_SMOKE_ENV_FILE="$HOME/.config/openlia/dev/openlia_dev.env" \
  OPENLIA_SMOKE_ATTACHMENTS_FILE="$HOME/.config/openlia/dev/locho-attachments.toml" \
  OPENLIA_SMOKE_LOCHO_HOST=genai
```

When prompted, send this exact message to the configured Telegram bot:

```text
I spent 15,000 VND on a Banh Mi today
```

The finance skill should not silently create a journal entry. Because the
message does not identify a journal, a safe response may request the journal
path or approval before making a write.

The report is written to a temporary directory outside the checkout unless
`--report` is supplied. Reports redact credential-shaped output, but reports may
still contain paths, project names, health details, and other operational data.
Report files are written with mode `0600`.

## Optional Cleanup

The default live command leaves the specified installation root running for manual
inspection. To uninstall the deployment after the interactive checks, add
`--cleanup`. This invokes the same root-aware uninstall operation described
below:

```sh
python3 tests/smoke.py --mode live \
  --target user@example.invalid \
  --project openlia_smoke \
  --root /srv/openlia-smoke \
  --env-file "$HOME/.config/openlia/dev/openlia_dev.env" \
  --attachments-file "$HOME/.config/openlia/dev/locho-attachments.toml" \
  --locho-host genai \
  --cleanup
```

Cleanup is not attempted when the installation root pre-exists or cannot be
proven to be reachable before deployment. A failed cleanup is reported as a
failed case and the root is retained for manual inspection.

## Deployment Uninstall

Use `openlia uninstall` when removing an existing deployment outside a smoke
run. It removes Compose containers, the project network, and the marked
OpenLia installation root. Docker images and build cache are preserved.

The command requires every deployment identifier and asks for confirmation:

```sh
go run . uninstall \
  --target user@example.invalid \
  --project openlia_smoke \
  --root /srv/openlia-smoke
```

For an approved non-interactive removal:

```sh
go run . uninstall \
  --target user@example.invalid \
  --project openlia_smoke \
  --root /srv/openlia-smoke \
  --non-interactive \
  --json
```

For a local deployment, use the same command with `--local`:

```sh
go run . uninstall \
  --local \
  --project openlia_smoke \
  --root /tmp/openlia_smoke \
  --non-interactive \
  --json
```

Uninstall refuses broad paths, symlink roots, and roots without the OpenLia
runtime marker.

## Other Verification

Validate the bundled workspace starters against their frontmatter `$schema`
references, validate skill-template structure and optional frontmatter schemas,
and check the shipped Markdown title/section headings:

```sh
make workspace-templates-test
```

This uses the development Python dependencies installed by `make venv`. The
same validator is bundled with Hermes and can check a deployed workspace and
installed skill templates in one invocation. Workspace schemas apply to every
non-template Markdown file in a domain, while skill templates without
frontmatter receive Markdown structure checks only.

From a clean checkout, run `make build` first to generate the ignored package
distributions embedded by the Go CLI. The broader local checks then remain:

```sh
go test ./...
go vet ./...
python3 -m py_compile tests/smoke.py
make compose-config
```

`make compose-config` validates the guarded base Compose file. The default
`backup create` archive is encrypted durable-state-only: it preserves the
workspace, agent state, profile metadata, and customized skills while omitting
Bundled image skills, caches, environments, secrets, and Locho
capabilities. The operator machine holds the decryption identity; targets and
remote stores retain only the public recipient and encrypted archive.
