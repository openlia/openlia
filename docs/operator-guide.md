# OpenLia Operator Guide

> A complete handbook for provisioning, configuring, updating, backing up, and securing OpenLia with the `openlia` CLI.

[← Back to Documentation Index](README.md)

The **Operator** is responsible for the infrastructure control plane: deploying the Hermes Agent runtime, injecting credentials, configuring model failover chains, managing private Locho and browser attachments, reviewing skill/instruction updates, and maintaining encrypted backups.

---

## 1. Architecture & Machine Roles

OpenLia uses a decoupled control-plane architecture. The `openlia` CLI runs on your **Operator Machine** (workstation) and manages the runtime either locally via Docker or remotely over SSH:

```text
Operator Machine (Local Laptop / Workstation)
  openlia CLI
  ~/.config/openlia/config.toml
  ~/.config/openlia/backup-identity.txt (Age private key)
  Protected Secrets (.env, mode 0600)
       |
       +--- [Local Mode] ---> Docker Engine on same machine
       |
       +--- [Remote Mode] --> SSH -> Agent Machine (Linux VM)
       |                             Docker Compose + Hermes + Workspace UI + Locho
       |
       `--- [Optional] -----> Local or SSH -> Browser Machine
                                              openlia-browser + Playwright MCP
```

| Machine | Responsibility | Requirements |
| :--- | :--- | :--- |
| **Operator Machine** | Runs the `openlia` CLI, stores operator config (`config.toml`), holds the private Age backup recovery key, and supplies protected source `.env` and attachment files. | Go 1.26+, Bun 1.2.22+, Python 3.9+ (for building from source) or a published `openlia` release binary. |
| **Agent Machine** | Runs Hermes Gateway, optional Workspace UI, Locho sidecars, backup scheduler, and persistent workspace data (`/opt/data`). | Linux (`amd64` or `arm64`) with Docker Engine & Compose v2 (or macOS with Docker Desktop in local mode). Remote targets need SSH access (direct Docker permission or passwordless `sudo`), **not** Go, Bun, or the `openlia` checkout. |
| **Browser Machine** *(Optional)* | Runs `openlia-browser` and Playwright MCP with an authenticated browser profile. | Node.js with `npx`, browser binary, and Playwright token file. Can be the Operator machine, Agent machine, or a third host. |

### Runtime File Ownership (UID/GID)
- **Local deployments** preserve host-file ownership; Linux containers run with the invoking user's UID/GID for shared runtime files.
- **Remote SSH deployments** use UID/GID `10000` when the operator connects with passwordless `sudo`, and the SSH user's UID/GID when running without `sudo`. No manual host-side `chown` is required.

---

## 2. Configuration & Secret Management

The default operator configuration file lives at `~/.config/openlia/config.toml`. Manage multiple environments (e.g., `dev` and `prod`) by setting `OPENLIA_CONFIG`:

```bash
export OPENLIA_CONFIG="$HOME/.config/openlia/prod/config.toml"
```

### Complete `config.toml` Reference

```toml
[openlia]
schema = 2
# Target host: empty for local Docker, or user@remote-host for SSH
target = "user@my-vps.example.com"
root = "/srv/openlia"
provider = "copilot"
model = "copilot-model"
# Default response language (BCP 47 tag, default "en"). Run `openlia restart` after changing.
output_language = "en"
# Agent timezone (IANA timezone, default "Asia/Ho_Chi_Minh"). Operational logs remain UTC.
timezone = "America/New_York"

# Required durable ingestion worker concurrency (positive integer, default 1)
[ingestion]
max_concurrent_jobs = 1

# Optional Workspace UI (Chat, Document Editor with inline OpenUI, Migration, Usage)
[workspace-ui]
host = "127.0.0.1"
port = 8089
# Required when host = "0.0.0.0" or when using --locho-host:
# password_hash = "$argon2id$..."

# Path to protected mode-0600 dotenv file on the operator machine
[secrets]
source = "/Users/username/.config/openlia/prod/secrets.env"

# Reminder schedule for user-approved workspace Git checkpoints (default "0 4 * * *")
[workspace_git]
schedule = "0 4 * * *"

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

### Workspace UI Authentication & Listener Policy
- **Loopback (`host = "127.0.0.1"`)**: Private by default; accessible locally or via SSH tunnel.
- **All interfaces (`host = "0.0.0.0"`) or `--locho-host`**: Requires an Argon2id `password_hash` (or Firebase authentication). Generate a password verifier interactively (prompts on stderr, prints hash to stdout, never takes passwords as CLI arguments):
  ```bash
  openlia workspace-ui password
  ```
  Paste `password_hash = "$argon2id$..."` under `[workspace-ui]` and run `openlia deploy`.
- Sessions use `HttpOnly`, `SameSite=Strict` cookies backed by SQLite with a 7-day idle timeout and 30-day maximum lifetime. Use HTTPS via a reverse proxy or encrypted Locho tunnel when accessing over untrusted networks.

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
Whenever you update `secrets.env`, apply the new credentials to the target:
```bash
openlia auth rotate
```
Credential rotation backs up the previous secret on the runtime target and rolls back automatically if container recreation fails.

---

## 3. Telegram Integration Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram to create a bot and obtain `TELEGRAM_BOT_TOKEN`.
2. Send `/start` to your new bot on Telegram.
3. *(Optional)* Create a dedicated **Home Channel** or group, add your bot as an administrator, and post a test message in the channel.
4. On your operator workstation, discover the numeric User ID and Channel ID:
   ```bash
   openlia telegram id --token 123456789:ABCDEFxxxxxxxxxxxxxxxxxxxx
   ```
5. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_HOME_CHANNEL`, and `TELEGRAM_HOME_CHANNEL_NAME` to your `0600` `secrets.env` file, then apply:
   ```bash
   openlia auth rotate
   ```

---

## 4. Private Networking, Locho & Browser Host

### Built-in Locho Host Bundle (`--locho-host`)
To access Workspace UI (Editor and Chat) privately from client machines without opening public ports on a remote server, initialize with `--locho-host`:

```bash
openlia init --target user@server --root /srv/openlia --locho-host
```

This binds Workspace UI to loopback (`127.0.0.1:8089`) and starts a private `locho-host` sidecar that exports only Workspace UI over an encrypted Locho tunnel.

After deployment, export a mode-`0600` client attachment file on the operator machine:
```bash
openlia locho-host share --output openlia-attachments.toml
```

Install [Locho `1.3.0-beta.2`](https://github.com/trchopan/locho/releases/tag/v1.3.0-beta.2)
on your client machine, copy `openlia-attachments.toml` over a trusted channel, and start the local listener:
```bash
locho attach --config openlia-attachments.toml
```

Locho `1.3.0-beta.2` also supports custom relay transports and configurable HTTP
timeouts. Configure `relay_config` and optional `relay_secrets` (mode `0600`) under `[locho]` in `config.toml`. See [`examples/locho/hosts/example/README.md`](../examples/locho/hosts/example/README.md) for relay templates and service-role mapping (`openlia attachments rotate|map|list`).

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

### Initialization (`openlia init`)
```bash
# Local deployment (Docker on the operator machine)
openlia init --local --root "$HOME/.openlia"

# Remote deployment (over SSH)
openlia init --target user@server --root /srv/openlia --timezone America/New_York
```

`init` installs the pinned release at `--root`, seeds the initial workspace template only if the workspace is empty, starts the Compose stack, creates the operator Age backup identity at `~/.config/openlia/backup-identity.txt` if needed, and runs health checks.

### Deploying, Starting & Stopping
```bash
# Reconcile current config.toml, secrets, and attachments using the installed target release
openlia deploy

# Upload and activate the release bundled in this CLI binary, then apply config and start
openlia deploy --release

# Service lifecycle controls
openlia status [--json]
openlia doctor [--check-providers] [--json]
openlia logs [--follow]
openlia stop
openlia start
openlia restart
```

### Uninstalling (`openlia uninstall`)
```bash
openlia uninstall
# Or with explicit target assertions:
openlia uninstall --target user@host --project NAME --root /srv/openlia
```
`uninstall` stops and removes Compose containers, the project network, the installation root, and local backup archives/schedules, while preserving remote S3/rsync backups and the operator's local Age private key.

---

## 6. Updates, Instructions, Skills & Features

### Release and Component Updates
```bash
# Read-only inspection of current release pins
openlia update

# Upload and activate a newly built OpenLia release (operator, profile, templates, bundled skills)
openlia update openlia

# Reconcile a single pinned runtime component
openlia update hermes
openlia update locho
```

### Instruction Provenance & 3-Way Merge
OpenLia tracks provenance for `profile/AGENTS.md`, `profile/SOUL.md`, and `workspace/AGENTS.md`. Unchanged files update automatically during `openlia update openlia`. If you have customized an instruction file, your changes remain active and the upstream update is staged for review:

```bash
openlia instructions status
openlia instructions diff workspace/AGENTS.md
openlia instructions merge workspace/AGENTS.md  # Conflict-free 3-way merge
openlia instructions keep workspace/AGENTS.md   # Keep local file and acknowledge new upstream base
openlia instructions reset workspace/AGENTS.md  # Replace with upstream file (creates backup)
```

### Templates Catalog, Automatic Forking, & 3-Way Rebase
OpenLia discovers starter profiles, modular features, and standalone skills from [`https://github.com/openlia/templates.git`](https://github.com/openlia/templates.git) (configurable under `[templates]` in `config.toml` or via `OPENLIA_TEMPLATES_REPO`).

```bash
# Sync the templates catalog from https://github.com/openlia/templates.git
openlia features sync

# List catalog and installed profiles/features/skills
openlia features list [--json]
openlia skills list [--json]

# Install a full profile, an individual feature, or a standalone skill
openlia features install --profile personal-os
openlia features install personal-finance
openlia skills install daily-briefing

# Inspect customization status and 3-way rebase against upstream template updates
openlia features status [FEATURE]
openlia features update [FEATURE]
openlia skills status [SKILL]
openlia skills update [SKILL]

# Package or import portable feature archives
openlia features package <feature-dir> --output my-feature.zip
openlia features import my-feature.zip
```

- **Automatic Fork Detection**: You do not need to run `openlia skills fork` before customizing a skill or feature template. OpenLia stores a clean upstream snapshot at install time and automatically detects any local edits (`current_hash != base_hash`).
- **3-Way Rebase & Conflict Staging**: Running `openlia features update` or `openlia skills update` performs a 3-way rebase (`old-base` vs. `current-fork` vs. `new-base`). Non-overlapping upstream changes merge automatically; overlapping conflicts leave the live workspace untouched and stage a migration directory under `/opt/data/.openlia/migrations/<id>` for review via `openlia skills migrate show|apply`.
- **On-Demand `/opt/data/.local` Tool Store**: When a feature or skill declares `requires.tools` (such as `hledger`, `remind`, `jq`, or `sqlite3`), `requires.python`, or `requires.bun`, OpenLia provisions them into `/opt/data/.local/{bin,tools,envs}` and records `/opt/data/.local/manifests/<owner>.json`. Backups capture the manifests and automatically re-materialize the tools and virtual environments on `openlia backup restore`.

---

## 7. Workspace Git Checkpoints & Folder Migration

### Local Workspace Git & User-Approved Checkpoints
OpenLia initializes `/opt/data/workspace` as a local-only Git repository (never push to a remote; use encrypted OpenLia backups for off-machine recovery).

```bash
openlia workspace git status
openlia workspace git setup
```

- **User-Approved Checkpoints**: When a user asks Lia to propose commits or clicks **Propose commits** in Workspace UI (**Git Activity**), the `openlia-workspace-git` plugin analyzes a frozen snapshot of diffs (bounded to 500 paths, 8 MiB content, 2 MiB diffs; single files >2 MiB excluded) and proposes logical commit groups. Commits are only created when the user clicks **Review & confirm** → **Confirm commits** in the UI.
- **`[workspace_git]` Schedule**: Defaults to `"0 4 * * *"` and acts as a **reminder-only** prompt when the workspace has uncommitted changes.

### Workspace Folder Migration (Beta)
Import an external folder of notes/ledgers into an isolated proposal repository for review before touching the live workspace:

```bash
# Package, upload, scan eligibility, start sequential Hermes processing, and monitor
openlia workspace migrate ./my-notes

# Inspect or control an active migration
openlia workspace migrate list
openlia workspace migrate status mig-...
openlia workspace migrate monitor mig-...
openlia workspace migrate stop mig-...
openlia workspace migrate resume mig-...
openlia workspace migrate discard mig-...

# Review diffs and approve an exact revision from the CLI (or via Workspace UI at /migration)
openlia workspace migrate diff mig-... --to-revision 1
openlia workspace migrate approve mig-... --revision rev-1-mig-...
```
Detected credentials, VCS metadata, and path traversals are blocked automatically during intake. Imported files are treated as data, never overriding active `AGENTS.md` or deployment policy.

---

## 8. Encrypted Backups & Disaster Recovery

OpenLia uses client-side [Age](https://age-encryption.org/) encryption for durable backups.
- The **Operator Machine** holds the private recovery key (`~/.config/openlia/backup-identity.txt`).
- The **Agent Machine** receives only the public recipient and can encrypt archives, never decrypt them.
- Durable archives include the workspace (with local Git history), Hermes state, usage monitoring state, profile metadata, and forked skills—excluding secrets, Locho capabilities, and caches.

### Manual & Scheduled Backups
```bash
# Generate an operator recovery key (created automatically by `openlia init`)
openlia backup keygen

# Create a consistent encrypted archive (briefly stops Hermes & Workspace UI during capture)
openlia backup create

# Inspect local retention, budget usage, and remote upload status
openlia backup status

# List archives in remote destinations
openlia backup list

# Retry uploading the latest or a specific encrypted archive
openlia backup push [--archive FILENAME.age]

# Manage the live best-effort Compose backup-scheduler sidecar
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
