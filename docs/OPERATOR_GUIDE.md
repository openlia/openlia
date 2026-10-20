# OpenLia Operator Guide

> A complete handbook for provisioning, configuring, updating, and securing OpenLia with the `openlia` CLI.

The **Operator** is responsible for the infrastructure control plane: deploying the Hermes Agent runtime, injecting credentials, configuring model failover chains, managing encrypted backups, and keeping the system healthy.

---

## 1. Architecture & Machine Roles

OpenLia uses a decoupled control-plane architecture:

```text
Operator Machine (Local Laptop / Workstation)
  openlia CLI
  ~/.config/openlia/config.toml
  Protected Secrets (.env, mode 0600)
       |
       +--- [Local Mode] ---> Docker Engine on same machine
       |
       +--- [Remote Mode] --> SSH -> Remote Linux VM (Agent Machine)
       |                             Docker Compose + Hermes + Locho
       |
       `--- (Optional) ------> SSH -> Browser Machine (Playwright MCP)
```

| Machine | Responsibility | Requirements |
| :--- | :--- | :--- |
| **Operator Machine** | Runs the `openlia` CLI, stores master configs, holds encryption keys and protected source `.env` files. | Go 1.24+, Bun, Python 3 (for local builds) or published `openlia` release binary. |
| **Agent Machine** | Runs Hermes Gateway, Locho attachment sidecars, Docker Compose, and holds persistent workspace data (`/opt/data`). | Linux (`x86_64` or `aarch64`), Docker Engine with Compose v2, SSH access with sudo or docker group. **Does NOT need Go, Bun, or `openlia` CLI.** |
| **Browser Machine** *(Optional)* | Runs `openlia-browser` and Playwright for headless browser automation. | Can be the Agent machine, Operator machine, or an independent host. |

---

## 2. Configuration & Secret Management

The default operator configuration file lives at `~/.config/openlia/config.toml`. You can manage multiple environments (e.g. dev and production) by setting the `OPENLIA_CONFIG` environment variable:
```bash
export OPENLIA_CONFIG="$HOME/.config/openlia/prod/config.toml"
```

### Example `config.toml`

```toml
[openlia]
# Target host: empty for local Docker, or user@remote-host for SSH
target = "root@my-vps.example.com"
root = "/opt/openlia"
provider = "copilot"
model = "gpt-5.6-luna"
output_language = "en"
timezone = "America/New_York"

# Required durable ingestion worker concurrency
[ingestion]
max_concurrent_jobs = 1

# Web chat interface
[open-webui]
host = "127.0.0.1"
port = 8090

# Personal workspace web editor
[workspace-ui]
host = "127.0.0.1"
port = 8089

# Path to protected dotenv file on the operator machine
[secrets]
source = "/Users/username/.config/openlia/prod/secrets.env"

# Primary LLM fallback chain
[[fallback_providers]]
provider = "openai-api"
model = "gpt-4o"

[[fallback_providers]]
provider = "custom"
model = "local-llama"
base_url = "http://locho-laptop:11434/v1"
key_env = "OPENAI_GATEWAY_API_KEY"
```

### Protected Secrets (`secrets.env`)
Secrets are **never** committed to Git or stored in `config.toml`. The operator maintains a protected file on the operator machine:

```bash
chmod 600 ~/.config/openlia/prod/secrets.env
```

Contents of `secrets.env`:
```dotenv
COPILOT_GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxx
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_TOKEN=123456789:ABCDEFxxxxxxxxxxxxxxxxxxxx
TELEGRAM_ALLOWED_USERS=987654321
TELEGRAM_HOME_CHANNEL=-1001234567890
```

### Rotating Secrets
Whenever you modify `secrets.env`, safely rotate credentials into the running deployment:
```bash
openlia auth rotate
```
*Note: Credential rotation backs up the previous runtime secret before applying changes. If container recreation fails, it rolls back safely.*

---

## 3. Telegram Integration Setup

To connect Lia to Telegram:
1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot to receive your `TELEGRAM_BOT_TOKEN`.
2. Send a `/start` message to your new bot on Telegram.
3. If you want a dedicated **Home Channel** or group, create one, add your bot as an administrator, and send a message into the channel.
4. On your operator workstation, run the `openlia telegram id` helper:
   ```bash
   openlia telegram id --token 123456789:ABCDEFxxxxxxxxxxxxxxxxxxxx
   ```
   This displays your discovered **Telegram User ID** and **Channel / Chat IDs**.
5. Add these values to your protected `secrets.env`:
   ```dotenv
   TELEGRAM_BOT_TOKEN=123456789:ABCDEFxxxxxxxxxxxxxxxxxxxx
   TELEGRAM_ALLOWED_USERS=123456789
   TELEGRAM_HOME_CHANNEL=-1001234567890
   TELEGRAM_HOME_CHANNEL_NAME="OpenLia Home"
   ```
6. Apply the secrets:
   ```bash
   openlia auth rotate
   ```

---

## 4. Deployment Lifecycle

### Initialization (`openlia init`)

**Local Deployment (Docker on same machine):**
```bash
openlia init --local --open-webui
```

**Remote VPS Deployment (over SSH):**
```bash
openlia init --target user@server-ip --timezone America/New_York --open-webui
```

Key flags for `openlia init`:
- `--target <user@host>`: Remote SSH destination (omit or use `--local` for local Docker).
- `--root <path>`: Runtime directory on the target (default `/opt/openlia`).
- `--timezone <tz>`: IANA timezone (e.g. `UTC`, `America/New_York`, `Asia/Ho_Chi_Minh`).
- `--open-webui`: Automatically configure Open WebUI chat container.
- `--non-interactive`: Scriptable mode without terminal prompts.

### Deploying & Starting
```bash
# Apply configuration and start all services using the installed release
openlia deploy

# Publish this CLI's bundled release, then apply configuration and start
openlia deploy --release

# Lifecycle control
openlia stop
openlia start
openlia restart
```

### Health Diagnostics & Logs
```bash
# Quick health summary
openlia status

# Strict system validation (Docker daemon, disk space, network, permissions)
openlia doctor

# Stream live container logs
openlia logs -f
```

---

## 5. Updates and Upgrades

OpenLia separates release updates from runtime deployment. `openlia deploy`
applies the current operator configuration to the full stack using the
currently installed OpenLia release: it synchronizes
protected runtime inputs, regenerates configured attachments, builds the
configured images, and reconciles the services. Use it after changing
configuration, secrets, ports, or attachments.

Use `openlia deploy --release` after changing OpenLia source or Workspace UI
code. It uploads and activates the release bundled in the local CLI before
applying configuration. The command reports the bundled release digest, the
active target digest, and the Workspace UI build digest so a healthy container
cannot be mistaken for newly deployed code.

`openlia update` without a component is read-only. It prints release
information and does not change the deployment. Explicit component updates use
the versions and digests already configured in `config.toml`; they do not
silently select newer versions.

```bash
# Inspect release pins without changing the deployment
openlia update

# Upload and activate a newly built OpenLia release, including the target
# operator, profile, templates, and bundled skills
openlia update openlia

# Reconcile one pinned runtime component
openlia update hermes
openlia update locho
openlia update open-webui

# Inspect managed and forked skill provenance
openlia skills status

# Review and apply a staged bundled-skill migration
openlia skills migrate show PROPOSAL_ID
openlia skills migrate apply PROPOSAL_ID
```

`openlia update openlia` preserves the workspace and leaves customized or
forked skills active until their changes are explicitly reviewed. If an update
has not already staged migration context, it can be prepared manually with
`openlia skills migrate prepare SKILL`.

---

## 6. Workspace Folder Migration (Beta)

Workspace migration imports a local folder into an isolated proposal workspace.
The recommended folder form is a schema-v2 workflow: the source archive is
uploaded to the deployment, source files are recorded in a durable SQLite
ledger, and eligible files are processed sequentially by Hermes against a
proposal Git repository. The live workspace is not changed until an operator
applies a reviewed revision.

### Submit and monitor an import

Run the folder form from the operator machine:

```bash
# Package, upload, initialize, start processing, and monitor
openlia workspace migrate ./export

# Inspect or reconnect to an existing migration
openlia workspace migrate list
openlia workspace migrate status mig-...
openlia workspace migrate monitor mig-...
```

The command returns a migration ID and the deployment processes one eligible
source job at a time. `Ctrl+C` detaches the terminal monitor; it is not a
replacement for `stop`. Use an explicit stop or the Workspace UI control when
processing must be halted, and use `resume` to continue a stopped migration:

```bash
openlia workspace migrate stop mig-...
openlia workspace migrate resume mig-...
openlia workspace migrate discard mig-...
```

`status` reports source/job progress, revisions, and the durable migration
state. A migration is ready for review only after its proposal revision has
been published. The legacy `upload`/`merge` flow remains available for older
migrations; use the folder form for new schema-v2 imports.

### Review and apply

Open the existing Workspace UI and select **Migration**. The migration page
provides:

- Overview and progress, including eligible, skipped, blocked, and failed
  sources.
- Source metadata such as relative path, hash, encoding, detected type, and
  include dependencies.
- The proposal Git diff, including added and modified files, revision
  summaries, and validation findings.
- Persistent discussion comments and **Reject with Comment**, which requests
  another proposal revision in the beta workflow.
- Worker wake, stop/resume, discard, and **Approve & Apply** controls.

The CLI can inspect the proposal and apply a specific revision:

```bash
openlia workspace migrate diff mig-... --to-revision 1
openlia workspace migrate diff mig-... --from-revision 1 --to-revision 2
openlia workspace migrate approve mig-... --revision rev-1-mig-...
```

Approval is bound to the selected revision and its patch hash. Before writing,
the operator checks affected live-file hashes and expected absence of new
files. A stale proposal is rejected rather than overwriting a live change.
Application uses a durable journal and rollback material; inspect and resolve
`recovery_required` before allowing another conflicting workspace mutation.

### Intake and safety rules

The intake manifest preserves source-relative paths, byte hashes, sizes,
encoding, detected type, eligibility, skip/block reasons, and discovered
dependencies. UTF-8 and UTF-8 BOM plus UTF-16 BOM text are supported. Common
Markdown, plain text, JSON, YAML, TOML, XML, CSV/TSV, hledger, and Remind files
are recognized. Credentials and detected secret content are blocked; generated
directories, VCS metadata, and unsupported binary files are skipped or marked
unsupported. Archive extraction validates paths against traversal.

Source content is data, not workspace policy. Hermes reads the captured
proposal workspace and its active instructions, but an imported `AGENTS.md` or
other instruction-looking file must not replace the active deployment policy.
Financial and calendar imports must still be reviewed for duplicate
transactions, transfers, journal includes, calendar includes, and validation
findings. A balanced ledger or syntactically valid calendar does not by itself
mean that an import is reconciled or correct.

Migration artifacts are retained under the deployment's
`.openlia/workspace-migrations/<migration-id>/` directory, including the
source snapshot, `migration.sqlite`, baseline manifest, proposal repository,
request/runtime records, revisions, and apply journal. Treat this directory as
workspace data and protect its permissions; it can contain imported personal
information even when secrets were blocked.

This feature is beta. The legacy terminal chunk flow, the schema-v2 durable
workflow, and the Workspace UI are distinct compatibility paths. Do not assume
that a saved comment has produced a new proposal until a new revision and diff
are visible, and do not treat a completed processing status as approval.

---

## 7. Backups and Disaster Recovery

OpenLia features an end-to-end encrypted backup system using [Age](https://age-encryption.org/) cryptography.

### Creating an Encrypted Backup
```bash
# Create an encrypted snapshot of the persistent workspace and state
openlia backup create
```

### Scheduling Automated Backups
You can enable the automated backup scheduler sidecar:
```bash
openlia backup schedule install
```

The default policy is five local encrypted archives with a 10 GiB soft budget
and 30 elapsed days of remote retention. Configure it in the selected profile:

```toml
[backup]
schedule = "20 4 * * *"
schedule_enabled = true
local_retention = 5
local_max_size = "10 GiB"
remote_retention_days = 30
```

`local_max_size` uses a quoted human-readable size. Binary units such as
`"10 GiB"` and `"500 MiB"`, plus decimal units such as `"10 GB"`, are accepted.

Local pruning removes the oldest archive and metadata pairs after the count and
size limits are applied. The newest verified archive is preserved if it alone
exceeds the soft budget. If no verified local archive exists, cleanup stops and reports
an error. `openlia backup status` reports usage, budget overruns, and retention
cleanup errors. Remote pruning runs after a successful upload; if
uploads stop, expired remote objects remain until the next successful upload.
The newest remote archive is preserved even when it is older than the retention
window.

### Remote Backup Storage (S3 / SSH)
S3 destinations can use separate reader credentials on the operator machine and
writer credentials on the deployment target. Credential paths are resolved
relative to the directory containing the selected profile's `config.toml`.

```toml
[[backup.destinations]]
name = "archive"
type = "s3"
endpoint = "https://s3.example.test"
bucket = "my-openlia-backups"
region = "us-east-1"
path_style = true
reader_credentials_file = "s3-reader-credentials"
reader_aws_profile = "reader"
writer_credentials_file = "s3-writer-credentials"
writer_aws_profile = "writer"
```

The credential files use the standard AWS shared-credentials format. Keep them
outside the OpenLia checkout with mode `0600`:

```ini
[reader]
aws_access_key_id = ...
aws_secret_access_key = ...
```

Each configured AWS profile must be paired with its credentials file; omit all
four fields to use the existing AWS SDK discovery behavior.

The writer file may contain multiple profiles, but OpenLia deploys only the
configured writer profile to the target. It is stored below the target's
runtime directory with mode `0600`. The scheduler mounts that directory
read-only and copies the writer file into private tmpfs before running as the
runtime user. Re-run `openlia deploy`, `openlia update openlia`, or
`openlia backup push` after rotating the local writer file.

Reader credentials are used only for local `backup list`, `backup restore`, and
remote downloads. Writer credentials are used only for target uploads and
remote retention. The private age recovery identity is never deployed.

Credential precedence is:

1. An explicitly configured credentials file and profile (the profile defaults to `default`).
2. Existing AWS SDK discovery through environment variables and shared files.

When explicit references are absent, existing AWS behavior is unchanged. A
configured credentials file must be a regular mode-`0600` file. Missing files,
profiles, or incomplete access keys stop the operation with an error that does
not include secret values.

For an existing destination, migrate by adding the reader and writer fields,
creating the two protected files, and running deployment once. The writer file
is filtered during deployment, so reader credentials and unrelated profiles are
not sent to the target.

For SSH destinations, continue to use the existing `identity_file` and
`operator_identity_file` fields. S3 credential fields are not accepted on SSH
destinations.

Example legacy form:
```toml
[[backup.destinations]]
name = "archive"
type = "s3"
bucket = "my-openlia-backups"
region = "us-east-1"
prefix = "backups"
```
When configured, encrypted backups are automatically synchronized to offsite storage.

### Restoring from Backup
To restore a deployment after machine failure:
```bash
openlia backup restore --file /path/to/backup-2026-10-09.tar.gz.age
```

---

## 8. Accessing Web Interfaces Remotely

If OpenLia is running on a remote VPS with `host = "127.0.0.1"`, access the Web UIs securely through an SSH tunnel:

```bash
# Forward Open WebUI (8090) and Workspace Editor (8089)
ssh -L 8090:127.0.0.1:8090 -L 8089:127.0.0.1:8089 user@server-ip
```

Then visit:
- **Open WebUI**: [http://localhost:8090](http://localhost:8090)
- **Workspace UI**: [http://localhost:8089](http://localhost:8089)
