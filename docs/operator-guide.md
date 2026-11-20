# OpenLia Operator Guide

> A complete handbook for provisioning, configuring, authenticating, backing up, and securing OpenLia with the `openlia` CLI.

[← Back to Documentation Index](README.md)

The **Operator** is responsible for the infrastructure control plane: deploying the Hermes Agent runtime, configuring Hermes Dashboard & API authentication (`openlia auth`), setting up model failover chains, managing private Locho and browser attachments, and maintaining Age-encrypted backups.

---

## 1. Architecture & Machine Roles

OpenLia uses a decoupled control-plane architecture. The `openlia` CLI runs on your **Operator Machine** (workstation) and manages the runtime either locally via Docker or remotely over SSH:

```text
Operator Machine (Local Laptop / Workstation)
  openlia CLI
  ~/.config/openlia/config.toml (or --config <path>)
  ~/.config/openlia/backup-identity.txt (Age private key)
  Protected Secrets (.env, mode 0600)
       |
       +--- [Local Mode] ---> Docker Engine on same machine
       |
       +--- [Remote Mode] --> SSH -> Agent Machine (Linux VM)
       |                             Docker Compose + Hermes (:8642 API, :9119 Dashboard) + Locho
       |
       `--- [Optional] -----> Local or SSH -> Browser Machine
                                              openlia-browser (:8932) + Playwright MCP (:8931)
```

| Machine                          | Responsibility                                                                                                                                                           | Requirements                                                                                                                                                                                                                           |
| :------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator Machine**             | Runs the `openlia` CLI, stores operator config (`config.toml`), holds the private Age backup recovery key, and supplies protected source `.env` and attachment files.    | Go 1.26+, Bun 1.2.22+, Python 3.9+ (for building from source) or an installed `openlia` release binary.                                                                                                                                |
| **Agent Machine**                | Runs Hermes Agent (`gateway`, `api-server`, `dashboard`), Locho sidecars (`locho-host` & `locho-<host>`), backup scheduler, and persistent workspace data (`/opt/data`). | Linux (`amd64` or `arm64`) with Docker Engine & Compose v2 (or macOS with Docker Desktop in local mode). Remote targets need SSH access (direct Docker permission or passwordless `sudo`), **not** Go, Bun, or the `openlia` checkout. |
| **Browser Machine** _(Optional)_ | Runs `openlia-browser` and Playwright MCP with an authenticated browser profile.                                                                                         | Node.js with `npx`, browser binary, and Playwright token file. Can be the Operator machine, Agent machine, or a third host.                                                                                                            |

### Runtime File Ownership (UID/GID)

- **Local deployments** preserve host-file ownership; Linux containers run with the invoking user's UID/GID for shared runtime files.
- **Remote SSH deployments** use UID/GID `10000` when the operator connects with passwordless `sudo`, and the SSH user's UID/GID when running without `sudo`. No manual host-side `chown` is required.

---

## 2. Configuration, Authentication & Secret Management

The default operator configuration file lives at `~/.config/openlia/config.toml`. You can select any profile config file on any command using `--config <path>` or `OPENLIA_CONFIG`:

```bash
openlia status --config ~/.config/openlia/dev/config.toml
# Or via environment variable:
export OPENLIA_CONFIG="$HOME/.config/openlia/dev/config.toml"
```

### Complete `config.toml` Reference

```toml
[openlia]
schema = 2
version = "0.1.0"
mode = "ssh" # "ssh" or "local"
target = "user@my-vps.example.com"
root = "/srv/openlia"
project = "openlia"
provider = "copilot"
model = "gpt-5.6-luna"
# Default response language (BCP 47 tag, default "en"). Run `openlia restart` after changing.
output_language = "en"
# Agent timezone (IANA timezone, default "Asia/Ho_Chi_Minh"). Operational logs remain UTC.
timezone = "Asia/Ho_Chi_Minh"
external_network = ""

[locho-host]
enabled = true
state_dir = "/Users/username/.config/openlia/prod/locho-host"

[locho]
relay_config = "/Users/username/.config/openlia/locho/relay.toml"
relay_secrets = "/Users/username/.config/openlia/locho/relay.env"

[api]
enabled = false
host = "127.0.0.1"

# Workspace UI listens on port 8089 inside the private Compose network.
# Leave host empty to avoid publishing a host port; Locho access still works.
[workspace-ui]
host = ""
port = 8089
# Set only when accessed through an HTTPS reverse proxy with a stable public origin.
public_origin = ""

# Path to protected mode-0600 dotenv file on the operator machine
[secrets]
source = "/Users/username/.config/openlia/prod/secrets.env"

# Primary LLM fallback chain (evaluated in table order)
[[fallback_providers]]
provider = "custom"
model = "gateway-model"
base_url = "http://locho-laptop:11434/v1"
key_env = "OPENAI_GATEWAY_API_KEY"

[[fallback_providers]]
provider = "openai-api"
model = "gpt-4o"
```

> [!NOTE]
> Do not set `OPENAI_BASE_URL` in `secrets.env` for custom gateways. Instead, assign the Locho service the `openai-gateway` role and declare its explicit `/v1` URL in `[[fallback_providers]]`. Hermes keeps `openai-api` pointed at official OpenAI.

### Hermes Dashboard & API Authentication (`openlia auth`)

Hermes Agent includes a built-in Web Dashboard (`127.0.0.1:9119`, exposed via Locho as `hermes-dashboard`) and an OpenAI-compatible API Server (`127.0.0.1:8642`, exposed via Locho as `hermes-api`). The Workspace UI reuses the configured Dashboard Basic Auth or OIDC credentials. All credentials are stored exclusively in your mode-`0600` `secrets.source` file—never in `config.toml`.

Generate a new API bearer key in the local secret source:

```bash
openlia auth api-key-rotate --config ~/.config/openlia/prod/config.toml
openlia deploy --config ~/.config/openlia/prod/config.toml
```

The command stores the key in the configured mode-`0600` `secrets.source` file without printing it. Run `openlia deploy` (and check `openlia status` or pass `--wait`) to apply the updated secret source to the target. Send it as `Authorization: Bearer <API_SERVER_KEY>` to the OpenAI-compatible API.

#### Option A: Basic Auth (Username & Password)

Prompt interactively for a username and hidden password (with confirmation):

```bash
openlia auth --config ~/.config/openlia/prod/config.toml
```

Or non-interactively via stdin:

```bash
printf '%s\n' "$PASSWORD" | openlia auth --config ~/.config/openlia/prod/config.toml --username admin --password-stdin
```

This writes `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` and `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` to `secrets.source`. During deployment, OpenLia automatically generates and persists `HERMES_DASHBOARD_BASIC_AUTH_SECRET` in `runtime/secrets/api-server.env` so session cookies remain valid across restarts.

#### Option B: OIDC Single Sign-On (GCP OAuth or Auth0)

Hermes Dashboard includes a built-in `SelfHostedOIDCProvider` (`Authorization Code + PKCE` at `/auth/callback`). Configure it interactively (or pass `--allowed-emails`):

```bash
openlia auth --oidc --config ~/.config/openlia/prod/config.toml --allowed-emails "user@example.com,admin@example.com"
```

This sets `HERMES_DASHBOARD_OIDC_ISSUER`, `HERMES_DASHBOARD_OIDC_CLIENT_ID`, `HERMES_DASHBOARD_OIDC_CLIENT_SECRET`, `HERMES_DASHBOARD_OIDC_SCOPES`, `HERMES_DASHBOARD_PUBLIC_URL`, and `OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS` in `secrets.source` (and removes Basic Auth credentials unless `--keep-basic-auth` is passed, so the Dashboard auto-redirects straight to your identity provider). When `--allowed-emails` is provided, OpenLia enforces this email whitelist on both Workspace UI (`:8089`) and Hermes Dashboard (`:9119`), rejecting any unlisted or unverified email with HTTP 403 Forbidden.

- **Google Cloud (GCP OAuth)**:
  - **Issuer**: `https://accounts.google.com`
  - **Authorized Redirect URI**: `<your-dashboard-url>/auth/callback` and `<your-workspace-ui-url>/auth/callback` (e.g., `http://127.0.0.1:9119/auth/callback` and `http://127.0.0.1:8089/auth/callback` for local Locho attach, or `https://dashboard.example.com/auth/callback` behind a reverse proxy).
  - **Client Secret**: Required for Google Web Application OAuth clients even with PKCE.
  - **User Access Control**: Whitelist allowed emails using `--allowed-emails`. For additional defense-in-depth, you can also keep your Google Auth Platform OAuth consent screen in **Testing** mode and add your email under **Audience → Test users** (or set Audience to **Internal** on Google Workspace).
- **Auth0**:
  - **Issuer**: `https://<your-tenant>.<region>.auth0.com`
  - **Allowed Callback URL**: `<your-dashboard-url>/auth/callback` and `<your-workspace-ui-url>/auth/callback`
  - **User Access Control**: Whitelist allowed emails using `--allowed-emails`. Optionally disable Public Signups on the Auth0 database connection or add an Auth0 Post-Login Action.

### Protected Secrets (`secrets.env`)

Secrets are **never** committed to Git, stored in `config.toml`, or passed on the command line. Maintain a regular file outside the repository with mode `0600`:

```bash
chmod 600 ~/.config/openlia/prod/secrets.env
```

Example `secrets.env`:

```dotenv
# Must start with gho_, ghu_, or github_pat_ (classic ghp_* tokens are not valid for Copilot)
COPILOT_GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxx
OPENAI_GATEWAY_API_KEY=sk-gateway-xxxxxxxxxxxxxxxxxxxx
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxx

# Messaging gateways (configure Telegram, Discord, or both simultaneously):
TELEGRAM_BOT_TOKEN=123456789:ABCDEFxxxxxxxxxxxxxxxxxxxx
TELEGRAM_ALLOWED_USERS=987654321
TELEGRAM_HOME_CHANNEL=-1001234567890
TELEGRAM_HOME_CHANNEL_NAME="OpenLia Home"

DISCORD_BOT_TOKEN=your_discord_bot_token_here
DISCORD_ALLOWED_USERS=123456789012345678
DISCORD_HOME_CHANNEL=987654321098765432
DISCORD_HOME_CHANNEL_NAME="openlia-home"
```

> [!WARNING]
> `docker/secret-source.sh` strictly validates secret formats. If any variable in `secrets.env` has an invalid format (such as an unsupported `COPILOT_GITHUB_TOKEN` prefix), the helper exits with code `1` and Hermes drops all secrets. Comment out, remove, or leave empty any unused platform variables.

### Applying Secret Changes

Whenever you update `secrets.env` (via `openlia auth` or manual edits), apply the new credentials to the target with `openlia deploy`:

```bash
openlia deploy --config ~/.config/openlia/prod/config.toml
openlia status --config ~/.config/openlia/prod/config.toml
```

`openlia deploy` stages the configured secret source and starts the target consolidation; pass `--wait` or check `openlia status` before relying on the updated credentials.

---

## 3. Messaging Integration Setup (Telegram & Discord)

Hermes Agent's gateway (`hermes gateway run`) automatically connects any messaging platform whose bot token is present in `secrets.env`. You can configure **Telegram only**, **Discord only**, or **both platforms simultaneously**.

### 3.1 Telegram Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram to create a bot and obtain `TELEGRAM_BOT_TOKEN`.
2. Send `/start` to your new bot on Telegram.
3. _(Optional)_ Create a dedicated **Home Channel** or group, add your bot as an administrator, and post a test message in the channel (or run `/sethome` in the chat).
4. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (comma-separated numeric Telegram user IDs), and optionally `TELEGRAM_HOME_CHANNEL` and `TELEGRAM_HOME_CHANNEL_NAME` to your mode-`0600` `secrets.env` file.

### 3.2 Discord Setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), click **New Application**, and go to the **Bot** tab to create a bot and copy `DISCORD_BOT_TOKEN`.
2. Still on the **Bot** tab under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** _(Required so the bot can read message text)_
   - **Server Members Intent** _(Recommended for user and role allowlist resolution)_
3. Invite the bot to your Discord server under **OAuth2 → URL Generator** (or **Installation**):
   - **Scopes**: `bot`, `applications.commands`
   - **Bot Permissions**: `View Channels`, `Send Messages`, `Read Message History`, `Embed Links`, `Attach Files`
4. In the Discord app, enable **User Settings → Advanced → Developer Mode**:
   - Right-click your profile and select **Copy User ID** for `DISCORD_ALLOWED_USERS` (comma-separated numeric Discord user IDs; Hermes is fail-closed by default and ignores messages if no allowlist is set).
   - _(Optional)_ Right-click your preferred notification channel and select **Copy Channel ID** for `DISCORD_HOME_CHANNEL` (and optionally set `DISCORD_HOME_CHANNEL_NAME`), or run `/sethome` inside the Discord channel.
   - _(Optional)_ By default in server channels, the bot responds when `@mentioned` (`DISCORD_REQUIRE_MENTION=true`; DMs never require a mention). You can list channel IDs in `DISCORD_FREE_RESPONSE_CHANNELS` where the bot should reply to every message without requiring a mention.
5. Add your chosen `TELEGRAM_*` and/or `DISCORD_*` variables to your mode-`0600` `secrets.env` file, then apply:

   ```bash
   openlia deploy --config ~/.config/openlia/prod/config.toml
   ```

---

## 4. Private Networking, Locho & Browser Host

### Built-in Locho Host Bundle (`locho-host`)

To access the Hermes API Server (`:8642`) and Hermes Web Dashboard (`:9119`) privately from client machines without opening public ports on a remote server, enable `locho-host` in `config.toml`:

```toml
[locho-host]
enabled = true
```

Then run `openlia deploy`. This starts the private `locho-host` sidecar and Workspace UI, exporting three services over an outbound encrypted Locho tunnel:

- `hermes-api` -> `hermes:8642` (default client local port: `8642`)
- `hermes-dashboard` -> `hermes:9119` (default client local port: `9119`)
- `workspace-ui` -> `workspace-ui:8089` (default client local port: `8089`)

After deployment, export a mode-`0600` client attachment file on the operator machine:

```bash
openlia locho-host share --output openlia-attachments.toml
```

To export a least-privilege attachment containing only specific services (or custom local listen ports for a shared reverse-proxy host such as Caddy), pass `--services`:

```bash
# Export only Workspace UI on local port 19119 for a reverse proxy
openlia locho-host share --services workspace-ui:19119 --output caddy-attachments.toml

# Export only Hermes API for an external API client
openlia locho-host share --services hermes-api --output api-attachments.toml
```

Install [Locho `1.3.0`](https://github.com/trchopan/locho/releases/tag/v1.3.0) on your client machine, copy `openlia-attachments.toml` over a trusted channel, and start the local listener:

```bash
locho attach --config openlia-attachments.toml
```

With the attachment active, open <http://127.0.0.1:8089> to browse and edit `/opt/data/workspace` and Hermes skills in `/opt/data/skills`. Skill edits change instructions and resources used by Hermes. Folder deletion is recursive and confirmed; it is refused if the target contains protected directories or symlinks. The UI service is not published on a host port by default; leave `[workspace-ui].host` empty to keep access on the private Locho tunnel. Set `host = "127.0.0.1"` only if you also want a local host port, or `host = "0.0.0.0"` to publish it on all host interfaces. Configure `public_origin` only when the UI is served through a stable HTTPS reverse-proxy origin (for example, for OIDC callbacks and secure cookies).

Configure `relay_config` and optional `relay_secrets` (mode `0600`) under `[locho]` in `config.toml`. See [`examples/locho/hosts/example/README.md`](../examples/locho/hosts/example/README.md) for relay templates and service-role mapping (`openlia attachments map|list`).

### Browser Host (`openlia-browser`)

OpenLia can attach a supervised Playwright MCP proxy (`openlia-browser`) running on the operator machine, agent machine, or a dedicated browser host:

```toml
[openlia-browser]
mode = "ssh" # or "local"
target = "user@browser-host"
ssh_port = 22
root = "<path_to_openlia_browser_root>"
extension_token_file = "<path_to_extension_token_file>"
```

Manage the browser host lifecycle from the operator workstation:

```bash
openlia browser configure --target "user@browser-host" --root "<root>" --extension-token-file "<token-file>"
openlia browser install
openlia browser start
openlia browser status
openlia browser logs
openlia browser restart
openlia browser stop
openlia browser uninstall
```

Raw Playwright MCP listens on `127.0.0.1:8931`; `openlia-browser` listens on `127.0.0.1:8932` and is the only port that should be attached through Locho and mapped via `openlia attachments map <host> openlia-browser --role openlia-browser`. See [`packages/openlia-browser/README.md`](../packages/openlia-browser/README.md) for lease semantics and setup details.

---

## 5. Deployment Lifecycle & Health Diagnostics

### Provisioning & Updating (`openlia deploy`)

`openlia deploy` is the single command for both initial target provisioning and subsequent updates:

```bash
# Provision an uninitialized target, or sync config/secrets/attachments on an existing target
openlia deploy [--wait] [--config <path>]

# Publish and activate a newly built CLI/operator release bundle on an existing target
openlia deploy --release [--wait] [--config <path>]
```

By default, `openlia deploy` stages the desired-state bundle in a single pass and starts a detached consolidation on the target (`runtime/meta/reconcile.json`), returning immediately with `status` so SSH disconnects cannot interrupt container image builds or rollouts. Only one consolidation may run at a time; concurrent mutating requests are rejected while a consolidation is active. Pass `--wait` to block and poll until consolidation finishes, or inspect progress anytime with `openlia status`.

On first deployment to a clean target (`installed_before == ""`), `openlia deploy` automatically uploads and activates the bundled release, bootstraps the runtime directory structure (`0700`), seeds base `SOUL.md` and `AGENTS.md` if missing, reconciles `/opt/data/config.yaml`, creates the operator Age backup identity (`backup-identity.txt`) if needed, stages secrets and Locho relays, builds the container images, and starts the Compose stack.

### Service Lifecycle Controls & Health Checks

```bash
openlia status [--live] [--check-providers] [--json] [--config <path>]
openlia logs [--follow] [--config <path>]
openlia stop [--wait] [--config <path>]
openlia start [--wait] [--config <path>]
openlia restart [--wait] [--config <path>]
```

`openlia status` reads the target's cached health snapshot (`runtime/meta/health.json`) and active/latest consolidation state (`runtime/meta/reconcile.json`, including `log_tail` on failure) by default for an immediate response; pass `--live` or `--check-providers` to run live container and provider checks. When the stack is in the `running` state, `openlia-operator reconcile --daemon` runs as a singleton background daemon on the target host to keep `runtime/meta/health.json` fresh and self-heal stopped services or stale `locho-host` upstreams.

### Uninstalling (`openlia uninstall`)

```bash
openlia uninstall [--config <path>]
# Or non-interactively with explicit target assertions:
openlia uninstall --non-interactive --target user@host --project NAME --root /srv/openlia
```

`uninstall` stops and removes Compose containers, the project network, the installation root, and local backup archives/schedules, while preserving remote S3/rsync backups and the operator's local Age private key.

---

## 6. Encrypted Backups & Disaster Recovery

OpenLia uses client-side [Age](https://age-encryption.org/) encryption for durable backups.

- The **Operator Machine** holds the private recovery key (`backup-identity.txt`).
- The **Agent Machine** receives only the public recipient and can encrypt archives, never decrypt them.
- **Included in Durable Backups (`/opt/data` $\rightarrow$ `hermes/`)**:
  - Workspace files (`/opt/data/workspace/**`)
  - Hermes session and state SQLite databases (`state.db`, `state.db-wal`) and Kanban databases (`kanban.db`, `kanban/boards/*/kanban.db`)
  - Persistent memories (`memories/MEMORY.md`, `memories/USER.md`)
  - Persona and operating instructions (`SOUL.md`, `AGENTS.md`), which are seeded **once** when missing on initial deployment, preserved across subsequent `openlia deploy` runs, and backed up/restored naturally
  - Hermes runtime configuration (`config.yaml`), with OpenLia's managed `model`, `secrets.command`, and `fallback_providers` blocks reconciled to the target host on restore while preserving all user/Hermes settings
  - All Hermes skills (`/opt/data/skills/**`, including both custom skills and bundled skills edited via Workspace UI)
  - Scheduled cron job definitions (`cron/jobs.json`) and named agent profiles (`profiles/**`)
- **Excluded from Durable Backups**:
  - Secrets (`runtime/secrets/*`, `.env`, `*.secret`, `auth.json`), Locho attachment capabilities (`attachments.toml`), and Workspace UI login sessions (`sessions.sqlite`)
  - Historical cron execution logs (`cron/output/**`) and service logs (`logs/**`)
  - Transient SQLite shared-memory/journal files (`*-shm`, `*.db-journal`, `*.tmp`) and runtime sockets/locks (`*.sock`, `*.pid`, `*.lock`)
  - Rebuildable dependency and cache trees (`node_modules`, `.venv`, `venv`, `__pycache__`, `*.pyc`, `*.pyo`, `.curator_backups`, `.cache`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.DS_Store`, `.bundled_manifest`)

### Manual & Scheduled Backups

```bash
# Generate an operator recovery key (also created automatically by `openlia deploy`)
openlia backup keygen

# Create a consistent encrypted archive (dispatches an async target consolidation; pass --wait to block)
openlia backup create [--wait]

# Inspect local retention, budget usage, and remote upload status
openlia backup status

# List archives in remote destinations
openlia backup list

# Retry uploading the latest or a specific encrypted archive (async by default; pass --wait to block)
openlia backup push [--archive FILENAME.age] [--wait]
```

The automated backup scheduler sidecar is reconciled declaratively from `[backup] schedule_enabled` in `config.toml` whenever you run `openlia deploy`, `openlia start`, `openlia restart`, or `openlia stop`.

### Configuring Retention & Remote Destinations (S3 & Rsync)

```toml
[backup]
schedule = "20 4 * * *"
schedule_enabled = true
local_retention = 5
local_max_size = "10 GiB"
remote_retention_days = 30
# Optional target-side SSH known_hosts for rsync sidecar
# known_hosts = "/root/.ssh/known_hosts"

[[backup.destinations]]
name = "primary"
type = "s3"
endpoint = "https://s3.example.net"
bucket = "openlia-backups"
prefix = "personal"
region = "us-east-1"
path_style = true
reader_credentials_file = "s3-reader-credentials"
reader_aws_profile = "reader"
writer_credentials_file = "s3-writer-credentials"
writer_aws_profile = "writer"

[[backup.destinations]]
name = "nas"
type = "rsync"
rsync_target = "backup@nas.example.net:/srv/backups/openlia"
identity_file = "/srv/openlia/operator-secrets/backup-rsync-key"
operator_identity_file = "/Users/me/.ssh/openlia-backup-read"
```

- **S3 Reader/Writer Separation**: `reader_credentials_file` and `writer_credentials_file` (mode `0600`, resolved relative to `config.toml`'s directory) use standard AWS shared-credentials INI format. Only the selected writer profile is deployed to the target; reader credentials remain on the operator machine for `backup list` and `backup restore`.

### Restoring from Backup

```bash
# Restore from a local encrypted archive
openlia backup restore --non-interactive --archive /path/to/backup.tar.gz.age

# Or download, decrypt, and restore the latest archive from a remote destination
openlia backup restore --non-interactive --from primary --latest
```

After `backup restore` completes and normalizes file ownership, verify the state and run `openlia start` (or `openlia restart`) to bring services back online.
