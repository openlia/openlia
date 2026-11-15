# OpenLia

> A lean, self-hosted deployment and connectivity control plane on top of [Hermes Agent](https://hermes-agent.nousresearch.com/).

OpenLia deploys and manages **Hermes Agent** on a local machine or a remote Linux host over SSH, wires private connectivity through **[Locho](https://github.com/trchopan/locho)** tunnels (for the Hermes API server, Hermes Dashboard, and external browser/service hosts), automates **Age-encrypted backups** (local + S3 or rsync), and provides the **`openlia-browser` Playwright MCP relay** for safe shared-profile browser automation.

---

## Core Responsibilities

1. **Zero-Fork Hermes Agent Deployment**:
   - Runs the official upstream `nousresearch/hermes-agent` container image with an injected mode-`0600` secret source wrapper (`/usr/local/bin/openlia-secret-source`).
   - Seeds a clean base `SOUL.md` and `AGENTS.md` on deployment, while letting upstream Hermes Agent manage its own `/opt/data/config.yaml` and native features.
2. **Locho Tunneling (`locho-host` & `attachments`)**:
   - **`locho-host`**: Exposes Hermes' built-in API Server (`127.0.0.1:8642` -> service `hermes-api`) and built-in Web Dashboard (`127.0.0.1:9119` -> service `hermes-dashboard`) over an outbound encrypted Locho relay—with zero public ports opened on the agent machine.
   - **`attachments`**: Connects Hermes to remote services (`openlia-browser`, private OpenAI-compatible gateways) through dedicated `locho-<host>` sidecar containers.
3. **Hermes Dashboard & API Authentication (`auth`)**:
   - Configures Hermes Dashboard Basic Auth (`openlia auth`) or OIDC / GCP OAuth / Auth0 (`openlia auth --oidc`) inside your protected mode-`0600` secret source file and propagates credentials to the runtime.
4. **Age-Encrypted Backups (`backup`)**:
   - Creates compressed, Age-encrypted snapshots of `/opt/data`, retaining the private Age recovery key strictly on the operator workstation while pushing encrypted archives to S3-compatible object storage or an SSH/rsync target.
5. **Playwright MCP Relay (`browser`)**:
   - Supervises a host-local Playwright MCP server (`127.0.0.1:8931`) and exposes a Streamable HTTP `/mcp` relay (`127.0.0.1:8932`) with single-owner FIFO workflow leases and mutating-call idempotency.

---

## Architecture Overview

```text
Operator Machine (macOS / Linux Workstation)
  openlia CLI + ~/.config/openlia/config.toml + protected secrets.env
      |
      +-- Local Mode --> Docker Compose on the same machine
      |
      +-- Remote Mode -> SSH -> Agent Machine (Linux VM, no checkout/Go needed)
      |                           |-- Hermes Agent container (:8642 API, :9119 Dashboard)
      |                           |-- Locho sidecars (locho-host & locho-<host> attachments)
      |                           |-- Backup scheduler sidecar
      |                           `-- /opt/data (Hermes state, SOUL.md, AGENTS.md, config.yaml)
      |
      `-- Optional ----> Local or SSH -> Browser Machine
                                           openlia-browser (:8932) + Playwright MCP (:8931)
```

---

## CLI Command Reference

All CLI commands accept `--config <path>` (or the `OPENLIA_CONFIG=<path>` environment variable) to select an operator configuration file (default: `~/.config/openlia/config.toml`).

### Lifecycle Commands

- `openlia deploy [--release] [--wait]` — Provision and bootstrap uninitialized targets, sync configuration/secrets, and start or update the Compose stack asynchronously (`--release` uploads and activates the bundled release on existing targets; `--wait` waits for consolidation to finish).
- `openlia start [--wait]` / `openlia stop [--wait]` / `openlia restart [--wait]` — Control the deployed Compose stack via the single target consolidation runner.
- `openlia status [--live] [--check-providers]` — Inspect container health, active/last consolidation state, secret permissions, runtime directories, and optional live provider reachability (`--check-providers`).
- `openlia logs [--follow]` — Tail or stream container logs.
- `openlia uninstall` — Tear down containers and remove the installation root while preserving remote backups and local Age recovery keys.

### Authentication & Capability Commands

- `openlia auth [--oidc]` — Configure Hermes Dashboard Basic Auth (`openlia auth`) or OIDC / GCP OAuth / Auth0 (`openlia auth --oidc`) in your mode-`0600` secret source (run `openlia deploy` to apply).
- `openlia auth api-key-rotate` — Generate and store a new Hermes API key in your mode-`0600` secret source without printing it (run `openlia deploy` to apply).
- `openlia locho-host share --output <file>` — Export a mode-`0600` client attachment file for `hermes-api` (`:8642`) and `hermes-dashboard` (`:9119`).
- `openlia attachments <list|map>` — Inspect attached Locho hosts or map discovered services to roles (`openlia-browser`, `openai-gateway`) in `config.toml` (run `openlia deploy` to apply).
- `openlia backup <keygen|create|status|list|push|restore>` — Manage Age-encrypted backups and off-box S3/rsync replication.
- `openlia browser <configure|install|start|stop|restart|status|logs|uninstall>` — Manage the `openlia-browser` Playwright MCP relay service.

---

## Quick Start

### 1. Build and Install `openlia`

```bash
make install
```

Ensure `~/.local/bin` is on your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 2. Create Your Config & Protected Secrets File (`0600`)

```bash
mkdir -p ~/.config/openlia
chmod 700 ~/.config/openlia
cp examples/profiles/dev/config.toml.example ~/.config/openlia/config.toml
cat << 'EOF' > ~/.config/openlia/secrets.env
COPILOT_GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxx
# Optional Telegram integration:
# TELEGRAM_BOT_TOKEN=123456789:ABCDEFxxxxxxxxxxxxxxxxxxxx
# TELEGRAM_ALLOWED_USERS=123456789
EOF
chmod 600 ~/.config/openlia/secrets.env
```

### 3. Configure Hermes Dashboard Authentication

Configure Basic Auth (username & password):

```bash
openlia auth --config ~/.config/openlia/config.toml
```

Or configure OIDC (GCP OAuth or Auth0):

```bash
openlia auth --oidc --config ~/.config/openlia/config.toml
```

### 4. Deploy & Verify

```bash
openlia deploy --config ~/.config/openlia/config.toml
openlia status --check-providers --config ~/.config/openlia/config.toml
```

### 5. Connect to Hermes API & Dashboard via Locho (`locho-host`)

When `[locho-host] enabled = true` is set in `config.toml`, export client capabilities and attach locally:

```bash
openlia locho-host share --output ~/.config/openlia/locho-attachments.toml --config ~/.config/openlia/config.toml
locho attach --config ~/.config/openlia/locho-attachments.toml
# Hermes Dashboard: http://127.0.0.1:9119
# Hermes API Server: http://127.0.0.1:8642
```

---

## Development & Verification

```bash
make build   # Build openlia-browser bundle, Linux operator binaries, and openlia CLI
make install # Run tests, build all artifacts, and install to ~/.local/bin
make test    # Verify release manifest, Bun tests, and Go tests
make lint    # Run Biome, TypeScript typecheck, gofmt, go vet, and ShellCheck
make smoke   # Run CLI smoke verification
```

OpenLia is licensed under the **[MIT License](LICENSE)**. See the **[Documentation Hub](docs/README.md)** and **[System Architecture](docs/architecture.md)** for full operator, user, and developer guides.
