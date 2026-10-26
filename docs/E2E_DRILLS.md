# OpenLia End-to-End (E2E) Development Drills

This document provides a battle-tested, repeatable operational runbook for executing end-to-end (E2E) verification drills against disposable or remote development environments using the `openlia_dev` profile.

---

## Overview & Architecture

OpenLia uses a thin control plane architecture:
- **Operator Machine**: Your local workstation where you run the `./openlia` CLI and manage profile configurations (`~/.config/openlia/<profile>/`).
- **Target Machine**: The machine where the Hermes Agent stack runs inside Docker containers (`/opt/<project>/`), managed over SSH (or locally with `--local`).
- **Secure Communication**:
  - Outbound commands and chat arrive via messaging platforms (e.g. Telegram).
  - Workspace UI (Chat and Editor) is accessible over encrypted P2P or relayed tunnels via [Locho](https://github.com/trchopan/locho).

```
Operator Workstation                       Target Host (e.g. user@test-host)
┌─────────────────────────┐               ┌─────────────────────────────────┐
│ ./openlia CLI           │ ──(SSH Init)─>│ /opt/openlia_dev/               │
│ ~/.config/openlia/dev/  │               │   ├── hermes (Agent Container)  │
│   ├── config.toml       │               │   ├── workspace-ui (Port 8089)  │
│   └── openlia_dev.env   │               │                                 │
│                         │               │   └── locho-host (Sidecar)      │
│ locho attach            │ <──(Locho)───>│                                 │
└─────────────────────────┘               └─────────────────────────────────┘
```

---

## Prerequisites

On your operator machine:
- Go 1.24+
- Bun (`bun --version`)
- Python 3 (`python3 --version`)
- SSH access with public-key authentication to the target machine (`ssh root@<target-ip>`)
- [Locho](https://github.com/trchopan/locho) CLI installed (`which locho`)

On the target machine:
- Linux (x86_64 or aarch64)
- Docker Engine with Compose v2 (`docker compose version`)

---

## Profile Setup (`~/.config/openlia/dev`)

Starter templates are provided under `examples/profiles/dev/`.

1. Create the dev profile directory:
   ```bash
   mkdir -p ~/.config/openlia/dev
   chmod 700 ~/.config/openlia/dev
   ```

2. Copy the example configuration:
   ```bash
   cp examples/profiles/dev/config.toml.example ~/.config/openlia/dev/config.toml
   cp examples/profiles/dev/openlia_dev.env.example ~/.config/openlia/dev/openlia_dev.env
   chmod 600 ~/.config/openlia/dev/openlia_dev.env
   ```

3. Edit `~/.config/openlia/dev/config.toml`:
   - Set `target = "user@your-host"` to your target SSH connection.
   - Adjust `model`, `output_language`, and `timezone` as desired.
   - Keep `schema = 2`.

4. Edit `~/.config/openlia/dev/openlia_dev.env`:
   - Provide your `COPILOT_GITHUB_TOKEN` (must start with `gho_`, `ghu_`, or `github_pat_`).
   - Provide your dedicated test bot token in `TELEGRAM_BOT_TOKEN`.
   - Provide your Telegram numeric user ID in `TELEGRAM_ALLOWED_USERS`.

> [!WARNING]
> **Token Validation Rules**:
> OpenLia's runtime secret helper (`docker/secret-source.sh`) enforces strict validation. For example, `COPILOT_GITHUB_TOKEN` **must** begin with `gho_`, `ghu_`, or `github_pat_`. If any assignment fails validation, the helper exits with code 1 and Hermes drops **all** secrets. Comment out or remove any unused keys.

---

## Step-by-Step Drill Sequence

### Drill 1: Build Host CLI & Target Operator
Before deploying any release, compile both the host CLI and the cross-compiled Linux operator artifact:

```bash
make build-cli build-operator-linux-amd64
```
*(Use `make build-operator-linux-arm64` if your target is an ARM64/Raspberry Pi host).*

Verify the compiled version:
```bash
./openlia --version
```

---

### Drill 2: Pre-flight & Remote Deployment
1. Verify the target directory is clean before initialization (or inspect existing deployment):
   ```bash
   ssh user@test-host "test ! -e /opt/openlia_dev && echo 'Target directory is clean'"
   ```

2. Deploy and initialize the stack:
   ```bash
   OPENLIA_CONFIG=~/.config/openlia/dev/config.toml ./openlia init --json
   ```
   If the stack is already initialized and you are applying configuration,
   secret, or attachment changes, use `./openlia deploy`:
   ```bash
   OPENLIA_CONFIG=~/.config/openlia/dev/config.toml ./openlia deploy
   ```
   If you rebuilt the OpenLia CLI and target operator and need to transfer
   those release assets to the target, use `./openlia update openlia` instead:
   ```bash
   OPENLIA_CONFIG=~/.config/openlia/dev/config.toml ./openlia update openlia
   ```

3. Inspect stack status and runtime components:
   ```bash
   OPENLIA_CONFIG=~/.config/openlia/dev/config.toml ./openlia status
   ```
   **Pass Criteria**: Checks include `hermes_ingestion` reporting `required_dependencies_available` and `hermes_runtimes` reporting `hermes_bun_uv_git_available`.

4. Run provider, ingestion, and runtime diagnostics:
   ```bash
   OPENLIA_CONFIG=~/.config/openlia/dev/config.toml ./openlia doctor --check-providers
   ```
   **Pass Criteria**: All checks report `ok: true`, `hermes_doctor` reports `healthy`, and `provider_request` reports `completed`.

5. Verify bundled skills catalog including new health and calendar skills:
   ```bash
   OPENLIA_CONFIG=~/.config/openlia/dev/config.toml ./openlia skills list --json
   ```
   **Pass Criteria**: Lists `personal-health`, `calendar`, `personal-finance`, and all standard bundled skills as enabled.

---

### Drill 3: Local Workspace Git & Scheduled Batch Commits
OpenLia maintains the workspace (`/opt/data/workspace`) as a local Git repository for history tracking without network remotes, with scheduled daily batch commits:

1. Check workspace git status:
   ```bash
   OPENLIA_CONFIG=~/.config/openlia/dev/config.toml ./openlia workspace git status
   ```
   **Pass Criteria**: Returns `{"ok":true,"workspace":"/opt/data/workspace","branch":"main","status":"## main"}`.

2. Inspect the scheduled workspace git cron batch job:
   ```bash
   ssh user@test-host "docker exec openlia_dev-hermes-1 crontab -l 2>/dev/null || true"
   ```
   Look for the scheduled daily commit entry configured by `[workspace_git] schedule`.

---

### Drill 4: Telegram Bot Interactive Verification
1. Confirm the Telegram poller is connected inside the Hermes container:
   ```bash
   ssh user@test-host "docker logs openlia_dev-hermes-1 2>&1 | tail -n 20"
   ```
   Look for: `[Telegram] Connected to Telegram (polling mode)`.

2. Open Telegram and send the following test prompts to your bot:
   - **Persona & Language Check**:
     > `Xin chào, bạn là ai?`
     *Expected*: Agent responds in Vietnamese (or configured language), identifying as OpenLia.
   - **Safe Personal Finance Workflow & Journal Creation**:
     > `I spent 15,000 VND on a Banh Mi today`
     *Expected*: Agent invokes the `personal-finance` skill and asks for confirmation or journal category, rather than blindly writing to disk. Upon approval, it initializes/appends to the financial journal (`finance/journal.journal`).
   - **Remind-backed Calendar Scheduling & Agenda Check**:
     > `Lên lịch nhắc nhở lúc 9h sáng mai họp đội ngũ`
     *Expected*: Agent uses the `calendar` skill and Remind syntax to record the event into `calendar/reminders.rem`.
     > `Kiểm tra lịch hôm nay`
     *Expected*: Agent queries today's agenda with native `remind` and returns scheduled items.
   - **Personal Health Record Workflow**:
     > `Ghi nhận hồ sơ sức khỏe: cân nặng 65kg, huyết áp 120/80`
     *Expected*: Agent recognizes the health workflow, validates against `health/` schemas, and safely logs or confirms the entry.
   - **Durable Ingestion Runtime & Tool Check**:
     > `Kiểm tra hàng đợi ingestion`
     *Expected*: Agent calls the Hermes ingestion tool `ingestion_status` and reports queue length and status.
   - **Workspace Notes Check**:
     > `Kiểm tra các ghi chú trong workspace`
     *Expected*: Agent reads and summarizes workspace template files.

---

### Drill 5: Locho Host & Web UI Verification
When `[locho-host] enabled = true` is configured, you can expose Workspace UI over an encrypted tunnel:

1. Generate client attachment credentials:
   ```bash
   OPENLIA_CONFIG=~/.config/openlia/dev/config.toml ./openlia locho-host share \
     --output ~/.config/openlia/dev/locho-attachments.toml
   ```

2. Start the Locho tunnel on your local machine:
   ```bash
   set -a && source ~/.config/openlia/locho/relay.env && set +a
   locho attach \
     --config ~/.config/openlia/dev/locho-attachments.toml \
     --relay-config ~/.config/openlia/locho/relay.toml
   ```

3. Test endpoints locally:
   - **Workspace UI**: [http://127.0.0.1:8089](http://127.0.0.1:8089)
     - Test authentication with the configured password.
     - **Hledger Journal & Sankey Diagram Flow**: Open any `.journal` or `.hledger` document (e.g. `finance/journal.journal`). Verify the visual preview renders:
       - `JournalHighlights` metric cards: Total Income, Total Expenses, Net Retained, Category Breakdown.
       - Interactive SVG `SankeyDiagram` visualizing money flow from sources to accounts and expenses.
       - Mode switcher toggles seamlessly between Visual Preview and CodeMirror code editor.
     - **Schema Validation & Document Toolbar**:
       - Verify toolbar actions (Validate, Rename, Delete).
       - Test schema validation endpoint: `curl -i -X POST http://127.0.0.1:8089/api/workspace/validate -H "Content-Type: application/json" -d '{"path":"inbox/proof.md","content":"# Proof\nContent"}'`.
     - **Ingestion & Sources Inspection**: Inspect `inbox/ingestion/` records and `sources/records/` in the file tree.
     - **Document Archive Export**: Test workspace document zip export: `curl -i http://127.0.0.1:8089/api/workspace/export -o /tmp/export.zip`.
     - **Chat**: Open [http://127.0.0.1:8089/chat](http://127.0.0.1:8089/chat), send a message, inspect streaming/tool activity, and verify the conversation survives a refresh.

---

### Drill 6: Complete Teardown & Post-Flight Cleanup
When testing is complete, tear down all resources to leave both local and target machines clean:

1. Stop your local `locho attach` process (Ctrl+C).
2. Clean up temporary attachment files:
   ```bash
   rm -f ~/.config/openlia/dev/locho-attachments.toml
   ```
3. Run non-interactive uninstallation:
   ```bash
   OPENLIA_CONFIG=~/.config/openlia/dev/config.toml ./openlia uninstall \
     --non-interactive \
     --json
   ```
4. Verify remote host cleanup:
   ```bash
   ssh user@test-host "test ! -e /opt/openlia_dev && docker ps -a --filter name=openlia_dev"
   ```
   **Pass Criteria**: `/opt/openlia_dev` is removed, all `openlia_dev-*` containers are stopped and removed, and the `openlia_dev-private` network is deleted.

---

## Troubleshooting Field Guide

| Symptom / Error | Root Cause | Solution |
| :--- | :--- | :--- |
| `unsupported config schema 1` | OpenLia bumped configuration schema to `2`. | Ensure `schema = 2` is set under `[openlia]` in `config.toml`. |
| `[workspace_git] invalid schedule` | Workspace Git batch tracking requires a valid cron expression. | Set `schedule = "0 4 * * *"` in `[workspace_git]` in `config.toml`. |
| `[secrets:command] helper failed; resolving no value: code=1` | An environment variable in `hermes.env` failed `secret-source.sh` regex validation. | Verify `COPILOT_GITHUB_TOKEN` starts with `gho_`, `ghu_`, or `github_pat_`. Comment out any unused or malformed token variables. |
| `locho-host is disabled` | Running `locho-host share` when `locho-host.enabled = false`. | Set `[locho-host] enabled = true` in `config.toml` and run `./openlia deploy` before sharing. |
| `backup encryption key setup failed: operator recovery identity is not ready` | `backup.recipient` is set in `config.toml` but the matching private key file does not exist on disk. | Clear `recipient = ""` in `config.toml` so `openlia init` automatically generates a matching pair at `backup.identity_file`. |
| `ingestion: password_required` or `password_invalid` | Encrypted document (PDF/XLSX) cannot be decrypted without a password. | Add the password under `[passwords]` in `sources/document-passwords.toml` matching the document label. |
| `No journal transactions detected` | Hledger file lacks standard posting format. | Ensure journal entries have `YYYY-MM-DD Description` followed by indented lines: `<account> <amount>`. |
| `env: '/opt/.../ops/healthcheck.sh': No such file or directory` | Attempting to run `status` or `doctor` before running `init`. | Run `openlia init` to stage the release files on the target first. |
