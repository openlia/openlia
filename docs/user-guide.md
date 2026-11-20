# OpenLia End User Guide

> A guide to collaborating with your self-hosted [Hermes Agent](https://hermes-agent.nousresearch.com/) deployed via OpenLia.

[← Back to Documentation Index](README.md)

OpenLia deploys and manages **Hermes Agent** with persistent state under `/opt/data`, a plain-text workspace under `/opt/data/workspace`, private connectivity through **[Locho](https://github.com/trchopan/locho)** tunnels, and optional shared-browser automation via **`openlia-browser`**.

---

## 1. Understanding Your Roles

When working with OpenLia, there are two complementary roles:

```text
+-------------------------------------------------------------------------+
|                            YOU (The Human)                              |
|                                                                         |
|  ┌───────────────────────────────────┐  ┌────────────────────────────┐  |
|  │        AS THE END USER            │  │      AS THE OPERATOR       │  |
|  │       (Daily Companion)           │  │   (System Administrator)   │  |
|  ├───────────────────────────────────┤  ├────────────────────────────┤  |
|  │ • Chat on Telegram / Discord      │  │ • Runs `openlia` CLI       │  |
|  │ • Use Hermes Web Dashboard        │  │ • Deploys & updates server │  |
|  │ • Connect clients to Hermes API   │  │ • Configures Auth / OIDC   │  |
|  │ • Organize `/opt/data/workspace`  │  │ • Manages Locho & backups  │  |
|  │ • Review & approve agent actions  │  │ • Supervises browser relay │  |
|  └───────────────────────────────────┘  └────────────────────────────┘  |
+-------------------------------------------------------------------------+
```

- **The End User**: Collaborates with the agent day-to-day over Telegram, Discord, the Hermes Web Dashboard, or API clients. **This guide is for this role.**
- **The Operator**: Manages servers, Docker containers, authentication (`openlia auth`), Locho tunnels, and encrypted backups using the `openlia` CLI. See the [Operator Guide](operator-guide.md).

---

## 2. How You Interact With Your Agent

### A. Messaging Channels — Telegram & Discord (Mobile & Desktop Interface)

You can connect **Telegram**, **Discord**, or **both simultaneously** as your mobile and desktop messaging channels:

- **Direct Messages & Server Channels**: Chat one-on-one with your private bot on Telegram or Discord, or interact in Discord server channels and threads, sharing links and files and running skills or workspace tasks.
- **Home Channel / Group**: A dedicated Telegram channel (`TELEGRAM_HOME_CHANNEL`) and/or Discord channel (`DISCORD_HOME_CHANNEL`, e.g., `"OpenLia Home"`) where the agent posts scheduled cron briefings and proactive notifications.
- **Workspace and Skill Links**: The agent uses `openlia://workspace/<path>` for workspace documents and `openlia://skills/<path>` for Hermes skills. When `[workspace-ui].public_origin` is configured, outbound messages rewrite these to `/files/<path>` and `/skills/<path>` at that origin; without a public origin, canonical URIs are preserved.
- **Interactive Approvals**: When a command or external action requires confirmation (`HERMES_EXEC_ASK=1`), the agent prompts you in chat before executing.

### B. Workspace UI (Normal User Document Workspace)

The **Workspace UI** provides a browser interface for documents and Hermes skills:

- **Access**: Served at your configured `[workspace-ui].public_origin` domain (behind an HTTPS reverse proxy attached to `workspace-ui`) or privately at <http://127.0.0.1:8089> via `locho attach`.
- **Workspace**: Browse, preview, edit, create, upload, move, rename, and delete documents in `/opt/data/workspace`.
- **Skills**: Browse and author files in `/opt/data/skills`; changes modify the instructions and resources Hermes uses for those skills. Skill and workspace links open in their corresponding UI scopes.
- **Folder deletion**: Deleting a folder removes its contents after confirmation. Folders containing protected directories or symlinks are rejected to avoid deleting hidden runtime data.
- **Authentication**: Reuses the configured Basic Auth or OIDC credentials (with optional email allowlist enforcement for Hermes Dashboard and Workspace UI, configured with `openlia auth --oidc --allowed-emails ...` and removed with `--clear-allowed-emails`).

### C. Hermes Web Dashboard (`:9119` via Locho — Advanced User / Operator)

Hermes Agent includes a full-featured Web Dashboard running on `127.0.0.1:9119` inside the container (exposed privately via `locho-host` as `hermes-dashboard`, bound to `http://127.0.0.1:9119` on your operator machine):

- **Authentication**: Protected by Basic Auth (`openlia auth`) or Single Sign-On via GCP OAuth / Auth0 (`openlia auth --oidc`).
- **Capabilities**:
  - **Status & Sessions**: Inspect active and historical chat sessions across Telegram, Discord, and API clients.
  - **Analytics & Usage**: View token consumption, model usage, and tool execution metrics.
  - **Logs**: Inspect live agent and gateway logs.
  - **Cron**: View and manage scheduled recurring agent tasks.
  - **Skills & Memory**: Browse installed Hermes skills (`/opt/data/skills`) and persistent memory entries (`memories/MEMORY.md` and `memories/USER.md`).
  - **Configuration**: Inspect runtime settings in `/opt/data/config.yaml`.

### D. Hermes API Server (`:8642` via Locho — Advanced User Integrations)

Hermes Agent provides an OpenAI-compatible HTTP API server on `127.0.0.1:8642` (exposed privately via `locho-host` as `hermes-api`, bound to `http://127.0.0.1:8642` on your client machine) for connecting external tools such as OpenWebUI:

- Authenticate requests with `Authorization: Bearer <API_SERVER_KEY>`.
- Exposes `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/runs`, and `/health`.

---

## 3. Workspace, Persona, Memory & Skills

All persistent agent state lives under `/opt/data` on the agent machine and is captured by OpenLia's Age-encrypted backups:

```text
/opt/data/
├── config.yaml        # Hermes runtime configuration (managed model/secrets block + custom settings)
├── SOUL.md            # Agent persona, tone, and managed default output language (seeded once)
├── AGENTS.md          # Global operating instructions and safety boundaries (seeded once)
├── state.db           # Hermes conversation sessions and runtime SQLite state
├── kanban.db          # Hermes Kanban boards and multi-agent task state (plus kanban/boards/*)
├── cron/jobs.json     # Scheduled recurring cron task definitions (cron/output/ logs excluded from backup)
├── memories/          # Hermes-managed MEMORY.md and USER.md
├── skills/            # All Hermes skills (custom and bundled/edited; venv/node_modules/__pycache__ excluded from backup)
└── workspace/         # Your plain-text files, projects, notes, and scripts
```

- **Persona & Instructions (`SOUL.md` & `AGENTS.md`)**: Seeded **once** on initial bootstrap from `profile/SOUL.md` and `profile/AGENTS.md` when missing. Subsequent `openlia deploy` runs never overwrite your or the agent's edits (only the bounded `output_language` block in `SOUL.md` and `openlia://` link guidance block in `AGENTS.md` are reconciled). Both files are backed up and restored naturally with `/opt/data`.
- **Workspace (`/opt/data/workspace`)**: The agent's default working directory. Keep your notes, scripts, and project files here; you can organize subdirectories freely or maintain local Git repositories inside your workspace.
- **Memories (`/opt/data/memories`)**: Managed through Hermes' native memory tools (`MEMORY.md` and `USER.md`) and editable in the Hermes Web Dashboard.

---

## 4. Trust, Safety, and Approvals

OpenLia configures Hermes Agent with conservative defaults (`profile/AGENTS.md` and `docker/compose.yaml`):

| Boundary                                    | Behavior                                                                                                                                                                                            |
| :------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace Scope**                         | File writes default to `/opt/data/workspace` unless you explicitly ask otherwise.                                                                                                                   |
| **Command Execution (`HERMES_EXEC_ASK=1`)** | Potentially consequential shell commands prompt for approval through the active session notifier.                                                                                                   |
| **Secret Isolation**                        | Credentials live in `/run/openlia-secrets/hermes.env` (`0600`) and are resolved via `/usr/local/bin/openlia-secret-source`; they are never written into workspace files or backups.                 |
| **Shared Browser (`openlia-browser`)**      | Browser automation requires an active FIFO workflow lease (`openlia_browser_session_request`) and filters out unsafe Playwright tools (such as arbitrary JS evaluation or file uploads) by default. |
| **External Actions & Deletions**            | Sending external messages, modifying external accounts, making purchases, or deleting user data requires explicit user confirmation.                                                                |
