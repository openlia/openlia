# Contributing to OpenLia

OpenLia is an early-stage operations and setup layer for Hermes Agent. Keep
changes small, reviewable, and explicit about their operational or security
impact.

## Development Requirements

- Go 1.26 or newer
- Bun 1.2.22 or newer for JavaScript packages
- Python 3.9 or newer (with virtual environment setup via `make venv`)
- Docker Compose v2 for Compose validation
- Bash and ShellCheck for the small container and cron adapters

Live credentials, personal workspace data, runtime state, Locho capabilities,
and private deployment identifiers must remain outside the repository.

## Local Checks

Run the relevant checks from the repository root:

```sh
make venv            # Sets up .venv/ and installs all dependencies (uses uv if present)
make test            # Runs Go, Python, and skill self-tests
make workspace-templates-test # Validates bundled workspace and skill templates
make skills-test     # Offline bundled skill self-test suite across bundled skills
make skills-verify   # Bundled skill tests and openlia-browser MCP relay tests
make lint
make compose-config
make versions-check
python3 tests/smoke.py --mode cli
python3 tests/smoke.py --mode local --root /tmp/openlia_smoke
make smoke-local-live \
  OPENLIA_SMOKE_ENV_FILE="$HOME/.config/openlia/dev/openlia_dev.env" \
  OPENLIA_SMOKE_ATTACHMENTS_FILE="$HOME/.config/openlia/dev/locho-attachments.toml" \
  OPENLIA_SMOKE_LOCHO_HOST=genai
```

For frontend-only work, the Workspace UI can be developed without Go, Docker,
Hermes, or an OpenLia deployment:

```sh
cd packages/workspace-ui
bun install
bun run dev          # Mock API, default
bun run dev:real     # Real Bun filesystem API and disposable workspace
```

See [`packages/workspace-ui/README.md`](packages/workspace-ui/README.md) for
package-local checks, scenarios, and preview commands.

For bundled skill development, see
[`docs/SKILL_DEVELOPMENT.md`](docs/SKILL_DEVELOPMENT.md).

The CLI smoke mode uses synthetic data and must not require provider
credentials, Telegram, Locho, SSH, or a remote target. The local deployment
smoke additionally requires a working Linux Docker engine, provided directly by
Docker Engine on Linux or Docker Desktop on macOS.

`make test` runs the Go operator and filesystem integration tests without a
provider. Run `make smoke-local` separately for an actual local Compose
deployment check.

The credential-backed local target is intentionally not part of the default
test suite. It starts a real agent with external credentials and leaves the
installation running unless `--cleanup` is supplied. Do not put those paths or
values in repository files.

## Changes

- Preserve the approval boundaries and secret-handling rules documented in the
  repository.
- Do not add credentials, personal records, generated runtime state, or private
  infrastructure details to source files, tests, examples, or documentation.
- Add or update tests for behavior changes.
- Keep pinned runtime versions and checksums synchronized with release metadata.
- Document operational assumptions and known limitations.

Runtime component pins have one source of truth in
[`release/manifest.json`](release/manifest.json). After changing that file, run
`make versions-generate`; the command updates generated bindings and checked-in
examples. `make versions-check` is required before building and fails if any
generated binding is stale. Do not edit
`internal/releaseinfo/generated.go` manually.

Development experiments do not need to change the stable manifest. Use an
explicit local `config.toml` override instead, keeping the image immutable:

```toml
[components]
hermes_tag = "v0.23.0-rc.1"
hermes_digest = "sha256:<Hermes image digest>"

[open-webui]
image = "ghcr.io/open-webui/open-webui:v0.13.0-rc.1@sha256:<Open WebUI image digest>"
```

These overrides accept prerelease tags while retaining normal image-reference
and digest validation. Keep experimental deployments isolated from production
data, especially when testing Open WebUI migrations.

Before submitting a change, review the complete staged file list and confirm
that no local or generated files are included.

## Commit Messages

Use a concise Conventional Commit subject for source repository changes:

```text
<type>: <imperative summary>
```

Common types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, and `ci`.
Keep one coherent change per commit, use a lowercase type, omit a trailing
period, and add a body only when the reason or operational impact is not clear
from the diff. Pull request numbers may be appended by the merge workflow.

The Personal OS workspace has a separate history policy. Its routine content
snapshots use `backup: <concise description>`; initialization and repository
maintenance use `chore:`, while explicitly requested structural documentation
changes may use `docs:`. A local workspace commit does not authorize a push.
