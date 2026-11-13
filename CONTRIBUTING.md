# Contributing to OpenLia

Thank you for your interest in contributing to OpenLia! OpenLia is a **lean, self-hosted deployment and connectivity control plane** on top of [Hermes Agent](https://hermes-agent.nousresearch.com/).

We value changes that are **small, reviewable, deterministic to test, and explicit about their operational and security boundaries**.

---

## 1. Where to Start

| If you want to work on... | Read this first | Key directories |
| :--- | :--- | :--- |
| **Overall system & codebase layout** | [System Architecture (`docs/architecture.md`)](docs/architecture.md) | Root, `cli/`, `operator/`, `packages/openlia-browser/`, `profile/` |
| **Go CLI & target operator** | [System Architecture (`docs/architecture.md`)](docs/architecture.md) | `main.go`, `cli/`, `operator/`, `cmd/`, `internal/` |
| **Playwright MCP Browser Relay** | [`packages/openlia-browser/README.md`](packages/openlia-browser/README.md) | `packages/openlia-browser/` |
| **End-to-end & smoke verification** | [`tests/README.md`](tests/README.md) & [E2E Drills (`docs/e2e-drills.md`)](docs/e2e-drills.md) | `tests/`, `examples/profiles/dev/` |

---

## 2. Development Prerequisites

- **Go**: `1.26` or newer
- **Bun**: `1.2.22` or newer (for `packages/openlia-browser`)
- **Python**: `3.9` or newer (for `tests/smoke.py`)
- **Docker & Compose v2**: Required for `make compose-config` and local deployment smoke tests
- **Bash & ShellCheck**: Required for container script linting (`make lint`)

> [!IMPORTANT]
> Live credentials, personal workspace data, runtime state, Locho capabilities, and private hostnames must **never** be committed to the repository or test fixtures.

---

## 3. 5-Minute Developer Setup

From a fresh clone of the repository:

```bash
# 1. Install JS dependencies and build the openlia-browser bundle, Linux operator binaries, and openlia CLI
bun install
make build

# 2. Run the full offline test suite (release manifest, Bun/TS tests, Go tests)
make test

# 3. Run code formatters and linters (Biome, TypeScript typecheck, gofmt, go vet, bash -n, shellcheck)
make lint

# 4. Run CLI smoke verification
make smoke
```

Note: Clean-checkout builds and Go tests require `make build` (or `bun run verify-dist`) first because `main.go` embeds `packages/openlia-browser/dist/server.js` via `//go:embed`.

---

## 4. Component Development Workflows

### A. Go CLI & Operator (`cli/`, `operator/`, `cmd/`, `internal/`)
```bash
go test ./...     # Run all Go unit tests
make format       # Format TS/JS with Biome and Go files with `gofmt -w`
make lint         # Check formatting, `go vet`, TypeScript, and shell scripts
```
- Keep unit tests fast, hermetic, and offline using `fstest.MapFS{}` and `recordedRunner`.
- Always sanitize file and archive paths to prevent path traversal outside workspace or backup roots.

### B. OpenLia Browser Relay (`packages/openlia-browser/`)
```bash
bun run build:openlia-browser  # Bundle packages/openlia-browser/dist/server.js
bun run test                   # Run Playwright MCP relay & lease unit tests
bun run typecheck              # TypeScript typechecking
```
See [`packages/openlia-browser/README.md`](packages/openlia-browser/README.md) for lease and idempotency semantics.

### C. Release Manifest & Version Pins (`release/manifest.json`)
Runtime component pins have a single source of truth in [`release/manifest.json`](release/manifest.json).
- After editing `release/manifest.json`, synchronize the managed Docker/Compose files and verify:
  ```bash
  go run ./cmd/release-manifest sync
  go run ./cmd/release-manifest check
  ```
- For local experiments with a custom Hermes image tag/digest, use a local `config.toml` override instead of editing `release/manifest.json`:
  ```toml
  [components]
  hermes_tag = "v2026.9.14"
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

# 4. Live credential-backed smoke test (opt-in; requires external env & attachment files)
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
- [ ] `make test`, `make lint`, and `make smoke` pass locally.
- [ ] Documentation in `docs/` or `README.md` is updated to reflect user- or operator-facing changes.
- [ ] `git status` and `git diff --staged` are reviewed to confirm no local configs, secrets, or generated test artifacts are staged.

### Commit Message Convention
Use concise [Conventional Commits](https://www.conventionalcommits.org/) for repository changes:

```text
<type>: <imperative summary>
```

- Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`.
- Use a lowercase type, imperative mood, and no trailing period.
- Keep one logical change per commit and include a commit body when operational impact or design trade-offs are not obvious from the diff.
