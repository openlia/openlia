# Contributing to OpenLia

Thank you for your interest in contributing to OpenLia! OpenLia is a **self-hosted, AI-native workspace** for turning personal context into organized knowledge, decisions, and action—with [Hermes Agent](https://hermes-agent.nousresearch.com/) as its agent runtime. Profiles, features, and skills extend the workspace; `personal-os` is an optional starter profile, not a fixed product layout.

We value changes that are **small, reviewable, deterministic to test, and explicit about their operational and security boundaries**.

---

## 1. Where to Start

| If you want to work on... | Read this first | Key directories |
| :--- | :--- | :--- |
| **Overall system & codebase layout** | [System Architecture (`docs/architecture.md`)](docs/architecture.md) | Root, `cli/`, `operator/`, `packages/`, `profile/` |
| **Go CLI & target operator** | [System Architecture §3 (`docs/architecture.md`)](docs/architecture.md#3-go-control-plane--operator-cli--operator) | `main.go`, `cli/`, `operator/`, `cmd/`, `internal/` |
| **Workspace UI (React / TanStack / Bun)** | [`packages/workspace-ui/README.md`](packages/workspace-ui/README.md) | `packages/workspace-ui/` |
| **Playwright MCP Browser Relay** | [`packages/openlia-browser/README.md`](packages/openlia-browser/README.md) | `packages/openlia-browser/` |
| **Skills & À La Carte Feature Packages** | [Skill & Feature Development (`docs/skill-and-feature-development.md`)](docs/skill-and-feature-development.md) | `profile/skills/`, `features/`, `workspace-template/` |
| **End-to-end & smoke verification** | [`tests/README.md`](tests/README.md) & [E2E Drills (`docs/e2e-drills.md`)](docs/e2e-drills.md) | `tests/`, `examples/profiles/dev/` |

---

## 2. Development Prerequisites

- **Go**: `1.26` or newer
- **Bun**: `1.2.22` or newer (for `packages/workspace-ui` and `packages/openlia-browser`)
- **Python**: `3.9` or newer (configured via `make venv`; uses `uv` automatically if installed)
- **Docker & Compose v2**: Required for `make compose-config` and local deployment smoke tests
- **Bash & ShellCheck**: Required for container script linting (`make lint`)

> [!IMPORTANT]
> Live credentials, personal workspace data, runtime state, Locho capabilities, and private hostnames must **never** be committed to the repository or test fixtures.

---

## 3. 5-Minute Developer Setup

From a fresh clone of the repository:

```bash
# 1. Create the Python virtualenv (.venv) and install dev requirements
make venv

# 2. Build Bun distributions, the host CLI (`./openlia`), and Linux operator binaries
make build

# 3. Run the full offline test suite (templates, Bun/TS, Go race tests, Python plugins, skill self-tests)
make test

# 4. Run code formatters and linters (Biome, gofmt, go vet, bash -n, shellcheck)
make lint
```

Note: Clean-checkout builds and Go tests require `make build` (or `make bun-build`) first because `main.go` embeds the generated `packages/*/dist/` assets via `//go:embed`.

---

## 4. Component Development Workflows

### A. Go CLI & Operator (`cli/`, `operator/`, `cmd/`, `internal/`)
```bash
make test-go     # Runs `go test -race ./...` and `go vet ./...`
make format-go   # Formats Go files with `gofmt -s -w`
make lint-go     # Checks formatting and `go vet`
```
- Keep unit tests fast, hermetic, and offline using `fstest.MapFS{}` and `recordedRunner`.
- Always sanitize file and archive paths to prevent path traversal outside workspace or backup roots.

### B. Workspace UI (`packages/workspace-ui/`)
You can develop the Workspace UI frontend without Go, Docker, or a running Hermes instance:

```bash
cd packages/workspace-ui
bun install
bun run dev          # Starts Vite on http://127.0.0.1:5173 with in-memory mock API
bun run dev:real     # Starts Vite + real Bun filesystem API against disposable .dev-workspace/
bun run storybook    # Reviews isolated UI components at http://127.0.0.1:6006
bun run test:storybook # Builds Storybook and checks every story on desktop/mobile
bun run check        # Runs Biome lint/format and TypeScript typechecking
bun run test         # Runs Vitest suite
```
Switch UI states instantly in mock mode with `?scenario=auth`, `?scenario=conflict`, `?scenario=empty`, `?scenario=error`, or `?scenario=loading`. See [`packages/workspace-ui/README.md`](packages/workspace-ui/README.md) for details.

For component-focused work, use [Storybook](docs/storybook.md) with synthetic
fixtures and no live backend. Add stories for new exported UI components;
`bun run storybook:coverage` checks the inventory and is included in `bun run check`.

### C. Skills, Templates & Feature Packages (`profile/skills/`, `features/`, `workspace-template/`)
```bash
make workspace-templates-test  # Validates JSON schemas, frontmatter, and Markdown headings
make skills-test               # Runs offline self-tests across all bundled skills
make skills-verify             # Runs bundled skill tests + openlia-browser MCP relay tests
```
See [Skill & Feature Package Development](docs/skill-and-feature-development.md) for authoring conventions.

For changes spanning `openlia/openlia` and `openlia/templates`, follow the
[runtime/templates compatibility contract and rollout checklist](docs/template-compatibility.md).
Run `make templates-integration TEMPLATES_ROOT=../openlia_templates` to check
both working trees together, including actual-catalog Calendar desktop/mobile
acceptance. The **Runtime and templates integration** workflow accepts two PR
refs and records the resolved SHAs for linked review evidence.

### D. Release Manifest & Version Pins (`release/manifest.json`)
Runtime component pins have a single source of truth in [`release/manifest.json`](release/manifest.json).
- After editing `release/manifest.json`, run:
  ```bash
  make versions-generate
  make versions-check
  ```
- Never edit `internal/releaseinfo/generated.go` by hand.
- For local experiments with a prerelease Hermes image, do not modify `release/manifest.json`; use a local `config.toml` override instead:
  ```toml
  [components]
  hermes_tag = "v0.23.0-rc.1"
  hermes_digest = "sha256:<Hermes image digest>"
  ```

---

## 5. Smoke & Integration Testing

In addition to `make test`, verify operational changes with the smoke runner:

```bash
# 1. Safe static & CLI smoke check (uses synthetic data; no Docker containers or credentials needed)
make smoke
# Equivalent to: python3 tests/smoke.py --mode cli

# 2. Validate Docker Compose configuration syntax
make compose-config

# 3. Full local Docker lifecycle smoke test (deploys & tears down a provider-free stack in /tmp/openlia_smoke)
make smoke-local

# 4. Workspace UI end-to-end smoke test against a disposable local stack
python3 tests/smoke.py --mode workspace-ui --root /tmp/openlia_workspace_ui_smoke

# 5. Live credential-backed smoke test (opt-in; requires external env & attachment files)
make smoke-local-live \
  OPENLIA_SMOKE_ENV_FILE="$HOME/.config/openlia/dev/openlia_dev.env" \
  OPENLIA_SMOKE_ATTACHMENTS_FILE="$HOME/.config/openlia/dev/locho-attachments.toml" \
  OPENLIA_SMOKE_LOCHO_HOST=genai
```
See [`tests/README.md`](tests/README.md) and [`docs/e2e-drills.md`](docs/e2e-drills.md) for complete verification procedures.

---

## 6. Pull Request & Commit Guidelines

### Checklist Before Submitting
- [ ] Approval boundaries and secret-handling safeguards are preserved.
- [ ] Automated tests are added or updated for any behavior change.
- [ ] `make versions-check`, `make test`, and `make lint` pass locally.
- [ ] Documentation in `docs/` or package `README.md` files is updated to reflect user- or operator-facing changes.
- [ ] `git status` and `git diff --staged` are reviewed to confirm no local configs, `.dev-workspace/`, screenshots, or generated artifacts are staged.

### Commit Message Convention
Use concise [Conventional Commits](https://www.conventionalcommits.org/) for repository changes:

```text
<type>: <imperative summary>
```

- Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`.
- Use a lowercase type, imperative mood, and no trailing period.
- Keep one logical change per commit and include a commit body when operational impact or design trade-offs are not obvious from the diff.
- *(Note: The user's runtime OpenLia workspace at `/opt/data/workspace` uses a separate commit convention—`backup: <description>` for snapshots, `chore:` for setup, and `docs:` for structural updates).*
