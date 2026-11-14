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

| Machine | Responsibility | Requirements |
| :--- | :--- | :--- |
| **Operator Machine** | Runs the `openlia` CLI, stores operator config (`config.toml`), holds the private Age backup recovery key, and supplies protected source `.env` and attachment files. | Go 1.26+, Bun 1.2.22+, Python 3.9+ (for building from source) or an installed `openlia` release binary. |
| **Agent Machine** | Runs Hermes Agent (`gateway`, `api-server`, `dashboard`), Locho sidecars (`locho-host` & `locho-<host>`), backup scheduler, and persistent workspace data (`/opt/data`). | Linux (`amd64` or `arm64`) with Docker Engine & Compose v2 (or macOS with Docker Desktop in local mode). Remote targets need SSH access (direct Docker permission or passwordless `sudo`), **not** Go, Bun, or the `openlia` checkout. |
| **Browser Machine** *(Optional)* | Runs `openlia-browser` and Playwright MCP with an authenticated browser profile. | Node.js with `npx`, browser binary, and Playwright token file. Can be the Operator machine, Agent machine, or a third host. |

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

Hermes Agent includes a built-in Web Dashboard (`127.0.0.1:9119`, exposed via Locho as `hermes-dashboard`) and an OpenAI-compatible API Server (`127.0.0.1:8642`, exposed via Locho as `hermes-api`). All credentials are stored exclusively in your mode-`0600` `secrets.source` file—never in `config.toml`.

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
Hermes Dashboard includes a built-in `SelfHostedOIDCProvider` (`Authorization Code + PKCE` at `/auth/callback`). Configure it interactively:
```bash
openlia auth --oidc --config ~/.config/openlia/prod/config.toml
```
This sets `HERMES_DASHBOARD_OIDC_ISSUER`, `HERMES_DASHBOARD_OIDC_CLIENT_ID`, `HERMES_DASHBOARD_OIDC_CLIENT_SECRET`, `HERMES_DASHBOARD_OIDC_SCOPES`, and `HERMES_DASHBOARD_PUBLIC_URL` in `secrets.source` (and removes Basic Auth credentials unless `--keep-basic-auth` is passed, so the Dashboard auto-redirects straight to your identity provider).

- **Google Cloud (GCP OAuth)**:
  - **Issuer**: `https://accounts.google.com`
  - **Authorized Redirect URI**: `<your-dashboard-url>/auth/callback` (e.g., `http://127.0.0.1:19119/auth/callback` for local Locho attach, or `https://dashboard.example.com/auth/callback` behind a reverse proxy).
  - **Client Secret**: Required for Google Web Application OAuth clients even with PKCE.
  - **User Access Control**: Keep your Google Auth Platform OAuth consent screen in **Testing** mode and add only your email under **Audience → Test users** (or set Audience to **Internal** on Google Workspace). Do not publish a consumer `@gmail.com` app to **In production**, or any Google account would be able to sign in.
- **Auth0**:
  - **Issuer**: `https://<your-tenant>.<region>.auth0.com`
  - **Allowed Callback URL**: `<your-dashboard-url>/auth/callback`
  - **User Access Control**: Disable Public Signups on the Auth0 database connection or add an Auth0 Post-Login Action that checks `event.user.email` against an allowlist.

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
TELEGRAM_BOT_TOKEN=123456789:ABCDEFxxxxxxxxxxxxxxxxxxxx
TELEGRAM_ALLOWED_USERS=987654321
TELEGRAM_HOME_CHANNEL=-1001234567890
TELEGRAM_HOME_CHANNEL_NAME="OpenLia Home"
```

> [!WARNING]
> `docker/secret-source.sh` strictly validates secret formats. If any variable in `secrets.env` is malformed, the helper exits with code `1` and Hermes drops all secrets. Comment out or remove unused variables.

### Rotating Secrets
Whenever you update `secrets.env` (via `openlia auth` or manual edits), apply the new credentials to the target:
```bash
openlia auth rotate --config ~/.config/openlia/prod/config.toml
# Or run a full deploy:
openlia deploy --config ~/.config/openlia/prod/config.toml
```
Credential rotation backs up the previous secret on the runtime target and rolls back automatically if container recreation fails.

---

## 3. Telegram Integration Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram to create a bot and obtain `TELEGRAM_BOT_TOKEN`.
2. Send `/start` to your new bot on Telegram.
3. *(Optional)* Create a dedicated **Home Channel** or group, add your bot as an administrator, and post a test message in the channel.
4. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (comma-separated numeric Telegram user IDs), `TELEGRAM_HOME_CHANNEL`, and `TELEGRAM_HOME_CHANNEL_NAME` to your mode-`0600` `secrets.env` file, then apply:
   ```bash
   openlia auth rotate --config ~/.config/openlia/prod/config.toml
   ```

---

## 4. Private Networking, Locho & Browser Host

### Built-in Locho Host Bundle (`locho-host`)
To access the Hermes API Server (`:8642`) and Hermes Web Dashboard (`:9119`) privately from client machines without opening public ports on a remote server, enable `locho-host` in `config.toml`:

```toml
[locho-host]
enabled = true
```

Then run `openlia deploy`. This starts a private `locho-host` sidecar that exports two services over an outbound encrypted Locho tunnel:
- `hermes-api` -> `hermes:8642` (default client local port: `18642`)
- `hermes-dashboard` -> `hermes:9119` (default client local port: `19119`)

After deployment, export a mode-`0600` client attachment file on the operator machine:
```bash
openlia locho-host share --output openlia-attachments.toml
```

To rotate capabilities for `all`, `hermes-api`, or `hermes-dashboard`:
```bash
openlia locho-host rotate --service all
```

Install [Locho `1.3.0`](https://github.com/trchopan/locho/releases/tag/v1.3.0) on your client machine, copy `openlia-attachments.toml` over a trusted channel, and start the local listener:
```bash
locho attach --config openlia-attachments.toml
```

Configure `relay_config` and optional `relay_secrets` (mode `0600`) under `[locho]` in `config.toml`. See [`examples/locho/hosts/example/README.md`](../examples/locho/hosts/example/README.md) for relay templates and service-role mapping (`openlia attachments rotate|map|list`).

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

By default, `openlia deploy` stages the desired-state bundle in a single pass and starts a detached operation job on the target, returning immediately with `job_id` and `status` so SSH disconnects cannot interrupt container image builds or rollouts. Pass `--wait` to block and poll until the job finishes, or inspect progress anytime with `openlia job` / `openlia status`.

On first deployment to a clean target (`installed_before == ""`), `openlia deploy` automatically uploads and activates the bundled release, bootstraps the runtime directory structure (`0700`), seeds base `SOUL.md` and `AGENTS.md` if missing, reconciles `/opt/data/config.yaml`, creates the operator Age backup identity (`backup-identity.txt`) if needed, stages secrets and Locho relays, builds the container images, and starts the Compose stack.

### Service Lifecycle Controls & Health Checks
```bash
openlia status [--live] [--check-providers] [--json] [--config <path>]
openlia job [status|logs [JOB_ID]] [--json] [--config <path>]
openlia logs [--follow] [--config <path>]
openlia stop [--config <path>]
openlia start [--config <path>]
openlia restart [--config <path>]
```
`openlia status` reads the target's cached health snapshot (`runtime/meta/health.json`) and active/latest job status (`runtime/meta/current-job.json`) by default for an immediate response; pass `--live` or `--check-providers` to run live container and provider checks. Use `openlia job logs [JOB_ID]` to inspect secret-redacted diagnostic output captured during detached target jobs. When the stack is in the `running` state, `openlia-operator reconcile --daemon` runs as a singleton background daemon on the target host to keep `runtime/meta/health.json` fresh and self-heal stopped services or stale `locho-host` upstreams.

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
- Durable archives capture `/opt/data` (workspace files, Hermes SQLite state, memories, `SOUL.md`, `AGENTS.md`, `config.yaml`, and skills)—excluding secrets, Locho capabilities, and caches.

### Manual & Scheduled Backups
```bash
# Generate an operator recovery key (also created automatically by `openlia deploy`)
openlia backup keygen

# Create a consistent encrypted archive (dispatches an async target job; pass --wait to block)
openlia backup create [--wait]

# Inspect local retention, budget usage, and remote upload status
openlia backup status

# List archives in remote destinations
openlia backup list

# Retry uploading the latest or a specific encrypted archive (async by default; pass --wait to block)
openlia backup push [--archive FILENAME.age] [--wait]

# Manage the live Compose backup-scheduler sidecar
openlia backup schedule install
openlia backup schedule remove
```

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

# Internal operation-scoped rollback restore (local unencrypted rollback snapshots only)
openlia backup rollback-restore --non-interactive --archive /path/to/rollback.tar.gz
```
After `backup restore` completes and normalizes file ownership, verify the state and run `openlia start` (or `openlia restart`) to bring services back online.
