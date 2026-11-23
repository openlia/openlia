# Changelog

All notable changes to OpenLia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-23

### Breaking Changes

- **Lean Zero-Fork Control Plane**: Retired the legacy `0.1.0` `workspace-template` starter files, `openlia/minions` catalog, 3-way workspace migration engine (`openlia workspace migrate`, `openlia features`, `openlia skills`), custom Python Hermes ingestion/maintainer plugins, `/opt/data/.local` tool store, and Remind source builder in favor of upstream `nousresearch/hermes-agent` (`v2026.9.14`).
- **Unified Deployment Command**: Consolidated initial target bootstrap (`openlia init`) and ongoing updates under `openlia deploy [--release] [--wait]`.

### Added

- **Workspace UI (`packages/workspace-ui`)**:
  - Rebuilt browser workspace application with three dedicated scopes—**Workspace** (`/opt/data/workspace`), **Skills** (`/opt/data/skills`), and **Agent** (`SOUL.md`, `AGENTS.md`, `/opt/data/memories`)—and a responsive scope switcher.
  - Added Hermes skill browsing and authoring (`SKILL.md` frontmatter rendering, creation, editing, and safe confirmed directory deletion).
  - Added standalone foreground server command `openlia workspace-ui serve [--root ~/.hermes] [--port 8089] [--host 127.0.0.1] [--public-origin <url>] [--env-file <path>] [--no-auth]` for running Workspace UI directly against any local Hermes home directory.
  - Added canonical `openlia://workspace/<path>` and `openlia://skills/<path>` link rewriting across outbound messaging gateways and Workspace UI markdown previews.
- **Unified Authentication & OIDC Email Allowlist (`openlia auth`)**:
  - Added `openlia auth` for Hermes Dashboard & Workspace UI Basic Auth and `openlia auth --oidc` for GCP OAuth / Auth0 OIDC provisioning.
  - Added `--allowed-emails` and `--clear-allowed-emails` flags on `openlia auth --oidc` to enforce verified email allowlists across both Hermes Dashboard and Workspace UI (`HERMES_DASHBOARD_ALLOWED_EMAILS` / `OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS`).
  - Added `openlia auth api-key-rotate` for rotating `API_SERVER_KEY` in the mode-`0600` secret source.
- **Async Target Consolidation & Host Reconciler**:
  - Added single-pass bundle synchronization (`syncBundle`), persisted target operator configuration (`runtime/meta/operator-config.json`), serialized async target consolidation (`openlia-operator reconcile --action <action>`), and `--wait` polling across lifecycle and backup commands.
  - Added singleton background host reconciler daemon (`openlia-operator reconcile --daemon`) to self-heal stopped services, refresh health snapshots (`runtime/meta/health.json`), and reconcile `locho-host` upstream endpoints (`hermes-api`, `hermes-dashboard`, `workspace-ui`).
- **Messaging & Connectivity**:
  - Added first-class Discord bot gateway support (`DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS`, `DISCORD_HOME_CHANNEL`) alongside Telegram.
  - Added support for single-file authenticated Locho relay configurations with inline `token` (pinned to Locho `1.3.1`).
  - Added global `--config <path>` flag (and `OPENLIA_CONFIG` environment variable) across all CLI commands.
- **Durable Backups**:
  - Expanded Age-encrypted backups to include all Hermes skills (`/opt/data/skills`, excluding transient virtualenvs/`node_modules`/`__pycache__`) and `/opt/data/config.yaml`, with automatic runtime configuration reconciliation on `openlia backup restore`.

### Changed

- Pinned upstream runtime dependencies in `release/manifest.json`:
  - `nousresearch/hermes-agent`: `v2026.9.14` (`sha256:99641e57ec762c59e54cb44aa6746b7fc68c18b3c5ddb088af54234c613d9294`)
  - `trchopan/locho`: `1.3.1`
  - `oven-sh/bun`: `1.2.22`
- Hardened Workspace UI for public exposure with strict `publicOrigin` mutation origin validation, PKCE + JWKS rotation handling, login rate limiting, and proxy-aware client IP resolution (`OPENLIA_WORKSPACE_UI_TRUST_PROXY`).
- Integrated Markdown formatting (`prettier`) and linting (`markdownlint-cli2`) into `make fmt`, `make lint`, and git pre-commit hooks.

### Fixed

- Fixed `openlia deploy` to automatically recreate containers when secrets (`hermes.env` / `api-server.env`) or Locho attachment configurations change.
- Eliminated duplicate action buttons and headers in Workspace UI artifact details drawers.

## [0.1.0] - 2026-10-28

### Added

- Initial release of the OpenLia self-hosted deployment and connectivity control plane for Hermes Agent over local Docker Compose and remote SSH targets.
- Private Locho tunneling (`locho-host` and `locho-<host>` service attachments).
- Client-side Age-encrypted backups with local retention and off-box S3 and rsync replication (`openlia backup`).
- `openlia-browser` Playwright MCP supervisor and Streamable HTTP `/mcp` relay with single-owner FIFO workflow leases and mutating-call idempotency.
