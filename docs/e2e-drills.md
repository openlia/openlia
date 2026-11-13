# OpenLia End-to-End (E2E) Development Drills

> A repeatable operational runbook for executing end-to-end verification drills against disposable or remote development environments using the `openlia_dev` profile.

[← Back to Documentation Index](README.md) · [Operator Guide](operator-guide.md) · [Smoke Tests (`tests/README.md`)](../tests/README.md)

---

## Overview & Architecture

OpenLia separates its operator control plane from the agent runtime:
- **Operator Machine**: Your local workstation where you run the `openlia` CLI and manage profile configurations (`~/.config/openlia/<profile>/`).
- **Target Machine**: The machine where the Hermes Agent stack runs inside Docker containers (`/opt/<project>/`), managed over SSH (or locally with `mode = "local"`).
- **Secure Communication**:
  - Outbound commands and chat arrive via messaging platforms (e.g., Telegram).
  - Hermes Web Dashboard (`:9119` -> `:19119`) and Hermes API Server (`:8642` -> `:18642`) are accessible privately over encrypted tunnels via [Locho](https://github.com/trchopan/locho).

```text
Operator Workstation                       Target Host (e.g. root@test-host)
┌─────────────────────────┐               ┌─────────────────────────────────┐
│ openlia CLI             │ ──(SSH)──────>│ /opt/openlia_dev/               │
│ ~/.config/openlia/dev/  │               │   ├── hermes (:8642 & :9119)    │
│   ├── config.toml       │               │   └── locho-host (Sidecar)      │
│   └── openlia_dev.env   │               │                                 │
│                         │               │                                 │
│ locho attach            │ <──(Locho)───>│                                 │
│  :18642 -> hermes-api   │               │                                 │
│  :19119 -> dashboard    │               │                                 │
└─────────────────────────┘               └─────────────────────────────────┘
```

---

## Prerequisites

On your operator machine:
- Go 1.26+
- Bun (`bun --version`, 1.2.22+)
- Python 3 (`python3 --version`, 3.9+)
- SSH access with public-key authentication to the target machine (`ssh root@<target-ip>`)
- [Locho](https://github.com/trchopan/locho) CLI installed (`which locho`)

On the target machine:
- Linux (`x86_64` or `aarch64`)
- Docker Engine with Compose v2 (`docker compose version`)

---

## Profile Setup (`~/.config/openlia/dev`)

Starter templates are provided under [`examples/profiles/dev/`](../examples/profiles/dev).

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
   - Set `target = "root@your-host"` to your target SSH connection.
   - Adjust `model`, `output_language`, and `timezone` as desired.
   - Keep `schema = 2`.

4. Edit `~/.config/openlia/dev/openlia_dev.env`:
   - Provide your `COPILOT_GITHUB_TOKEN` (must start with `gho_`, `ghu_`, or `github_pat_`).
   - Provide your dedicated test bot token in `TELEGRAM_BOT_TOKEN`.
   - Provide your Telegram numeric user ID in `TELEGRAM_ALLOWED_USERS`.

5. Configure Hermes Dashboard authentication (`openlia auth`):
   ```bash
   # Option A: Basic Auth (username & password)
   openlia auth --config ~/.config/openlia/dev/config.toml

   # Option B: OIDC (GCP OAuth or Auth0)
   openlia auth --oidc --config ~/.config/openlia/dev/config.toml
   ```

> [!WARNING]
> **Token Validation Rules**:
> OpenLia's runtime secret helper (`docker/secret-source.sh`) enforces strict validation. For example, `COPILOT_GITHUB_TOKEN` **must** begin with `gho_`, `ghu_`, or `github_pat_`. If any assignment fails validation, the helper exits with code 1 and Hermes drops **all** secrets. Comment out or remove any unused keys.

---

## Step-by-Step Drill Sequence

### Drill 1: Build & Install `openlia`
Compile the `openlia-browser` bundle, cross-compiled Linux operator binaries, and host CLI, and install to `~/.local/bin`:

```bash
make install
openlia --version
```

---

### Drill 2: Pre-Flight & Remote Deployment
1. Verify the target directory is clean before first deployment (or uninstall an old test run first):
   ```bash
   ssh root@test-host "test ! -e /opt/openlia_dev && echo 'Target directory is clean'"
   ```

2. Deploy and initialize the stack:
   ```bash
   openlia deploy --config ~/.config/openlia/dev/config.toml
   ```
   *(If updating an already-deployed target after rebuilding the CLI/operator, pass `--release`)*:
   ```bash
   openlia deploy --release --config ~/.config/openlia/dev/config.toml
   ```

3. Inspect stack status and runtime health checks:
   ```bash
   openlia status --config ~/.config/openlia/dev/config.toml
   ```
   **Pass Criteria**: Reports `"ok": true` across all checks (`service:hermes`, `service:locho-host`, `locho_host_upstreams: hermes_reachable`, `hermes_runtimes: hermes_bun_uv_git_available`, `hermes_config: valid`, `workspace: initialized`, `secret_source: mode_0600`).

4. Run live provider diagnostics:
   ```bash
   openlia status --check-providers --config ~/.config/openlia/dev/config.toml
   ```
   **Pass Criteria**: `hermes_doctor` reports `healthy` and `provider_request` reports `completed`.

---

### Drill 3: Locho Host, Hermes Dashboard & API Verification
When `[locho-host] enabled = true` is configured, `locho-host` exposes `hermes-api` (`:8642` -> `:18642`) and `hermes-dashboard` (`:9119` -> `:19119`):

1. Export client attachment credentials:
   ```bash
   openlia locho-host share \
     --output ~/.config/openlia/dev/locho-attachments.toml \
     --config ~/.config/openlia/dev/config.toml
   ```

2. Start the Locho tunnel on your local machine:
   ```bash
   set -a && source ~/.config/openlia/locho/relay.env && set +a
   locho attach \
     --config ~/.config/openlia/dev/locho-attachments.toml \
     --relay-config ~/.config/openlia/locho/relay.toml
   ```

3. Verify endpoints locally:
   - **Hermes API Server (`http://127.0.0.1:18642`)**:
     ```bash
     curl -fsS http://127.0.0.1:18642/health
     ```
   - **Hermes Web Dashboard (`http://127.0.0.1:19119`)**:
     - Check configured authentication providers:
       ```bash
       curl -fsS http://127.0.0.1:19119/api/auth/providers
       ```
     - Verify unauthenticated session requests are rejected (`401` / `"error": "unauthenticated"`):
       ```bash
       curl -s http://127.0.0.1:19119/api/auth/session
       ```
     - Open [http://127.0.0.1:19119](http://127.0.0.1:19119) in your browser and sign in via Basic Auth or your configured OIDC provider (Google / Auth0).

---

### Drill 4: Telegram Bot Interactive Verification
1. Confirm the Telegram gateway is connected inside the Hermes container:
   ```bash
   openlia logs --config ~/.config/openlia/dev/config.toml | tail -n 30
   ```

2. Open Telegram and send test prompts to your bot:
   - **Persona & Language Check**:
     > `Xin chào, bạn là ai?`
     *Expected*: Agent responds in the configured `output_language` (`vi`).
   - **Workspace Check**:
     > `Kiểm tra các file trong /opt/data/workspace`
     *Expected*: Agent inspects `/opt/data/workspace` and summarizes its contents.

---

### Drill 5: Encrypted Backup & Restore Check
1. Create an Age-encrypted backup archive:
   ```bash
   openlia backup create --config ~/.config/openlia/dev/config.toml
   openlia backup status --config ~/.config/openlia/dev/config.toml
   ```
   **Pass Criteria**: A `.tar.gz.age` archive and `.sha256` digest are created under `/opt/openlia_dev/runtime/backups`.

---

### Drill 6: Complete Teardown & Post-Flight Cleanup
When testing is complete, tear down all resources to leave the target machine clean:

1. Stop your local `locho attach` process (`Ctrl+C`).
2. Run non-interactive uninstallation:
   ```bash
   openlia uninstall --non-interactive --json --config ~/.config/openlia/dev/config.toml
   ```
3. Verify remote host cleanup:
   ```bash
   ssh root@test-host "test ! -e /opt/openlia_dev && docker ps -a --filter name=openlia_dev"
   ```
   **Pass Criteria**: `/opt/openlia_dev` is removed, all `openlia_dev-*` containers are stopped and removed, and the `openlia_dev-private` network is deleted.

---

## Troubleshooting Field Guide

| Symptom / Error | Root Cause | Solution |
| :--- | :--- | :--- |
| `unsupported config schema 1` | OpenLia requires configuration schema `2`. | Ensure `schema = 2` is set under `[openlia]` in `config.toml`. |
| `[secrets:command] helper failed; resolving no value: code=1` | An environment variable in `hermes.env` failed `secret-source.sh` validation. | Verify `COPILOT_GITHUB_TOKEN` starts with `gho_`, `ghu_`, or `github_pat_`. Comment out any unused or malformed token variables. |
| `locho-host is disabled` | Running `locho-host share` when `locho-host.enabled = false`. | Set `[locho-host] enabled = true` in `config.toml` and run `openlia deploy` before sharing. |
| `backup encryption key setup failed: operator recovery identity is not ready` | `backup.recipient` is set in `config.toml` but the matching private key file does not exist on disk. | Clear `recipient = ""` in `config.toml` so `openlia deploy` automatically generates a matching pair at `backup.identity_file`. |
| OIDC login shows `redirect_uri_mismatch` | The callback URL in Google Cloud / Auth0 does not match the browser URL or `HERMES_DASHBOARD_PUBLIC_URL`. | Register `<your-dashboard-url>/auth/callback` in your OAuth provider and re-run `openlia auth --oidc --config <path>` followed by `openlia deploy`. |
