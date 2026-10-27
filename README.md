# OpenLia

> A self-hosted, AI-native workspace for turning personal context into organized knowledge, decisions, and action—with [Hermes Agent](https://hermes-agent.nousresearch.com/) as its agent runtime.

OpenLia helps you organize documents, connect projects and daily context, and act with a clear human approval boundary. Your information lives in a **Git-versioned plain-text workspace**, not proprietary app silos or a fixed domain layout. Start small and extend it with profiles, domain features, and workflow skills from the public **[`openlia/templates`](https://github.com/openlia/templates.git)** catalog.

**Hermes Agent** powers Lia, the assistant you collaborate with through chat and **Workspace UI**. **Durable multi-format ingestion** retains your sources, while **OpenUI Mini-Projects** provide interactive views over workspace records. An **on-demand dependency store**, private connectivity through **[Locho](https://github.com/trchopan/locho)**, and a **separate operator control plane** support deployment and ongoing operations.

---

## Why Lia?

**Lia** is a classic Italian form of **Leah**. In Dante's *Purgatorio*, Leah represents the active life: she gathers flowers and weaves a garland, while her sister Rachel represents the contemplative life.

OpenLia is built to bridge reflection and action:
```text
Observe -> Understand -> Remember -> Reason -> Recommend -> [Approve] -> Act -> Update State
```
The goal is not maximum unattended autonomy—the goal is **useful autonomy with a clear human approval boundary**.

---

## The Two Roles: End User vs. Operator

To use and understand OpenLia, distinguish between **two distinct roles** (even when one self-hoster fulfills both):

```text
+-------------------------------------------------------------------------------+
|                                YOU (The Human)                                |
|                                                                               |
|  ┌───────────────────────────────────┐     ┌───────────────────────────────┐  |
|  │          THE END USER             │     │         THE OPERATOR          │  |
|  │        (Daily Companion)          │     │    (System Administrator)     │  |
|  ├───────────────────────────────────┤     ├───────────────────────────────┤  |
|  │ • Workspace UI Chat & Editor      │     │ • Workstation `openlia` CLI   │  |
|  │ • Telegram (Bot DM / Home Channel)│     │ • Deployment (Local / SSH VM) │  |
|  │ • Quick-notes & document intake   │     │ • Secret rotation & API keys  │  |
|  │ • OpenUI Mini-Project dashboards  │     │ • Encrypted backups & restore │  |
|  │ • Git checkpoints & approvals     │     │ • Profiles, features & skills │  |
|  └─────────────────▲─────────────────┘     └───────────────┬───────────────┘  |
+--------------------┼───────────────────────────────────────┼------------------+
                     │ interacts daily                       │ manages & provisions
                     │                                       │
        ┌────────────┴───────────────────────────────────────▼───────────┐
        │                     OPENLIA RUNTIME PLANE                      │
        │   (Hermes Gateway + Workspace UI + Locho + Git Workspace)      │
        └────────────────────────────────────────────────────────────────┘
```

| Dimension | The End User | The Operator |
| :--- | :--- | :--- |
| **Primary Interface** | Workspace UI (`/chat`, `/files`, `/projects`) & Telegram | `openlia` CLI (terminal on operator workstation) |
| **Responsibilities** | Daily workflows, quick capture, document intake, reviews, approvals | Deployment, VM/Docker setup, API keys, backups, updates |
| **Data Handled** | Workspace documents, Mini-Project records, ingested sources | SSH keys, LLM API keys, Age recovery keys, Locho capabilities |
| **Cadence** | Multiple times daily | Initial setup + periodic updates, secret rotation & backup checks |

> [!TIP]
> **Self-hosting OpenLia for yourself?**
> You wear the **Operator** hat once to deploy and maintain the stack with the `openlia` CLI, and wear the **End User** hat every day when chatting with Lia or reviewing your workspace.

---

## Documentation Map

Browse the full documentation in **[`docs/README.md`](docs/README.md)**:

| Audience | Guide | What It Covers |
| :--- | :--- | :--- |
| **End Users** | 📖 **[End User Guide](docs/user-guide.md)** | Daily workflows, Telegram & Workspace UI, Minimal Core Workspace, Public Templates Catalog (`openlia/templates`), and approval rules. |
| **End Users** | 📊 **[Workspace Mini-Projects](docs/workspace-domain-views.md)** | Interactive domain views (`/projects/<path>`), `project-manifest.toml`, `ui.openui`, and structured Markdown records. |
| **Operators** | 🛠️ **[Operator Guide](docs/operator-guide.md)** | Complete `openlia` CLI handbook, `config.toml` & `secrets.env`, templates catalog & on-demand dependencies (`/opt/data/.local`), Locho & Browser hosts, migrations, and Age-encrypted backups. |
| **Operators** | 📈 **[LLM Usage Monitoring](docs/usage-monitoring.md)** | Token and USD cost tracking across Hermes, Ingestion, and Migration, plus custom pricing overrides. |
| **Operators / QA** | 🧪 **[End-to-End Drills](docs/e2e-drills.md)** | Repeatable verification runbook and troubleshooting guide for disposable or remote deployments. |
| **Contributors** | 🤝 **[Contributing Guide](CONTRIBUTING.md)** | Developer prerequisites, 5-minute setup, component workflows, test suites, and PR conventions. |
| **Contributors** | 🏗️ **[System Architecture](docs/architecture.md)** | Full-stack codebase tour: Go CLI/operator, TypeScript/Bun UI & Browser Relay, Python plugins, `/opt/data/.local` tool store, and Docker runtime. |
| **Contributors** | 🧠 **[Skill & Feature Development](docs/skill-and-feature-development.md)** | Authoring and testing workspace profiles, modular features, standalone skills, and `requires.{tools,python,bun}` manifests for [`openlia/templates`](https://github.com/openlia/templates.git). |

---

## Core Platform Capabilities

### 1. Ultra-Minimal Core Workspace + Public Templates Catalog (`openlia/templates`)
Every new OpenLia deployment starts with a clean, unopinionated core workspace (`workspace-template/`):
- `AGENTS.md` and `README.md` (workspace instructions and contracts)
- `inbox/ingestion/` (durable intake notes created from uploaded documents and links)
- `sources/` (`artifacts/`, `records/`, and `document-passwords.toml`)
- `feature.schema.json` (JSON Schema for modular feature manifests)

Install starter profiles, domain features, and standalone skills on demand from [`https://github.com/openlia/templates.git`](https://github.com/openlia/templates.git) (or your own template repository / local directory / `.zip` archive):
- **Starter Profiles**: `personal-os` (installs `goals`, `tasks`, `calendar`, `claims`, `daily-briefing`, and core productivity skills in one command)
- **Modular Features**: `goals`, `tasks`, `calendar`, `claims`, `daily-briefing`, `personal-finance`, `personal-health`, `decision-analysis`, `deep-research`, `areas`, `ideas`, `monitors`, `people`, `shopping`, `travel`
- **Standalone Skills**: `daily-briefing`, `weekly-review`, `inbox-triage`, `workspace-organize`, `workspace-git`, `calendar`, `document-intelligence`

### 2. On-Demand Tool & Dependency Store (`/opt/data/.local`)
 Core container images stay lean. Features (`feature.yaml`) and skills (`SKILL.md`) declare domain-specific dependencies under `requires`:
- **`requires.tools`**: Curated CLI binaries (`hledger`, `remind`, `jq`, `sqlite3`) downloaded from pinned checksums or installed into `/opt/data/.local/tools/<tool>/<version>/` and symlinked into `/opt/data/.local/bin/`.
- **`requires.python`**: Isolated Python virtual environments provisioned via `uv` under `/opt/data/.local/envs/python/<owner>/`.
- **`requires.bun`**: Isolated Bun package environments provisioned under `/opt/data/.local/envs/bun/<owner>/`.
- Because `/opt/data/.local/bin` is on the persistent volume and in Hermes's `PATH`, installed tools survive container rebuilds and host restarts without bloating the base Docker image.

### 3. Automatic Fork Detection & 3-Way Rebase
Customize any installed feature template or skill directly in your workspace—no manual `fork` command is required before editing. OpenLia stores the clean upstream snapshot at install time, automatically detects your local edits (`current_hash != base_hash`), and performs a 3-way rebase (`old-base` vs. `current-fork` vs. `new-base`) when upstream templates update.

### 4. Durable Multi-Format Ingestion
Send chat text, PDFs, images (processed via your configured vision LLM), Excel spreadsheets, CSVs, or YouTube links. OpenLia retains the originals under `sources/` and creates structured provenance and intake records automatically.

### 5. Built-in Workspace UI, Mini-Projects & OpenUI
When `[workspace-ui]` is enabled, a single Bun service provides:
- **Native Chat (`/chat`)**: Streaming conversations over Hermes' private `/v1/runs` API with live tool activity, inline approvals, and detached execution.
- **Document Explorer & Editor (`/files`)**: Markdown preview, CodeMirror editor, and advisory JSON Schema validation.
- **Mini-Projects (`/projects`)**: Interactive OpenUI dashboards powered by `project-manifest.toml` and `ui.openui` for any workspace folder.
- **Git Checkpoints & Folder Migration (`/migration`)**: Review and confirm AI-grouped Git commits or staged folder imports before they touch your live workspace.

---

## Architecture & Deployment Shape

OpenLia is not a fork of Hermes Agent. It uses Hermes as its agent runtime and adds a durable workspace, interactive apps, extensible workflows, and human approval boundaries. A separate operator control plane handles deployment, updates, credentials, and backups.

```text
Operator Machine (macOS / Linux Workstation)
  openlia CLI + ~/.config/openlia/config.toml + protected secrets.env
      |
      +-- Local Mode --> Docker Compose on the same machine
      |
      +-- Remote Mode -> SSH -> Agent Machine (Linux VM, no checkout/Go needed)
      |                           |-- Hermes Gateway container
      |                           |-- Workspace UI container (optional)
      |                           |-- Locho attachment sidecars (optional)
      |                           |-- Backup scheduler sidecar
      |                           `-- /opt/data (Workspace Git repo + .local tools + SQLite state)
      |
      `-- Optional ----> Local or SSH -> Browser Machine
                                           openlia-browser (:8932) + Playwright MCP (:8931)
```

---

## Quick Start

### Prerequisites

| Use Case | Required Runtime |
| :--- | :--- |
| **Source build & tests** | Go 1.26+, Bun 1.2.22+, Python 3.9+ (`make venv`), Bash, Docker CLI |
| **Local deployment** | Docker Engine with Compose v2 (Linux) or Docker Desktop (macOS) |
| **Remote deployment** | SSH access to a Linux host (`amd64` or `arm64`) with Docker Engine & Compose v2 |

### Step 1: Build & Configure (Operator Step)

1. **Build the release artifacts and `openlia` CLI**:
   ```bash
   make build
   ```

2. **Create your protected secrets file (`0600`) outside the repository**:
   ```bash
   mkdir -p ~/.config/openlia
   chmod 700 ~/.config/openlia
   cat << 'EOF' > ~/.config/openlia/secrets.env
   COPILOT_GITHUB_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxx
   # Optional Telegram integration:
   # TELEGRAM_BOT_TOKEN=123456789:ABCDEFxxxxxxxxxxxxxxxxxxxx
   # TELEGRAM_ALLOWED_USERS=123456789
   EOF
   chmod 600 ~/.config/openlia/secrets.env
   ```

3. **Create `~/.config/openlia/config.toml`**:
   ```toml
   [openlia]
   schema = 2
   provider = "copilot"
   model = "copilot-model"
   output_language = "en"
   timezone = "America/New_York"

   [ingestion]
   max_concurrent_jobs = 1

   [workspace-ui]
   host = "127.0.0.1"
   port = 8089

   [secrets]
   source = "/Users/yourname/.config/openlia/secrets.env"
   ```

4. **Initialize, deploy, and install optional templates**:
   ```bash
   # Local deployment on this machine:
   ./openlia init --local --root "$HOME/.openlia"
   ./openlia deploy

   # Optional: browse and install profiles/features/skills from openlia/templates
   ./openlia features sync
   ./openlia features install --profile personal-os
   # Or install individual features & skills:
   # ./openlia features install tasks
   # ./openlia skills install workspace-git
   ```

### Step 2: Connect & Use Lia (End User Step)

1. **Workspace UI Chat**: Open [http://localhost:8089/chat](http://localhost:8089/chat) and start collaborating with your agent.
2. **Workspace UI Editor & Projects**: Open [http://localhost:8089](http://localhost:8089) to browse your Markdown files, install feature packages, or inspect OpenUI Mini-Project dashboards.
3. **Telegram**: If configured, message `/start` to your bot on Telegram for mobile capture and notifications.

👉 Next steps: Read the **[End User Guide](docs/user-guide.md)** and **[Operator Guide](docs/operator-guide.md)**.

---

## Security Boundaries

- **Out-of-Repo Secrets**: Credentials, OAuth state, and Locho capabilities live outside Git in mode-`0600` files and are injected at runtime (`openlia auth rotate`).
- **Private-by-Default Listeners**: The default Compose stack exposes no public ports and mounts no Docker socket. Remote access uses SSH tunnels or encrypted [Locho](https://github.com/trchopan/locho) attachments (`--locho-host`). Binding Workspace UI to `0.0.0.0` requires an Argon2id `password_hash`.
- **Unprivileged Runtime & Scoped Mounts**: Hermes runs as an unprivileged user with `/opt/data` as its mutable volume; system skills are mounted read-only.
- **Human-in-the-Loop Approvals**: Consequential actions, external side effects, skill/feature conflict migrations, folder imports, and workspace Git commits require explicit confirmation.
- **Client-Side Encrypted Backups**: Durable backups (`openlia backup create`) are encrypted with Age using a public recipient on the target while the private recovery key remains strictly on the operator machine.

To report a security vulnerability, see **[`SECURITY.md`](SECURITY.md)**.

---

## Contributing & License

We welcome contributions across the Go CLI/operator, Workspace UI, Browser Relay, system skills, and documentation!

```bash
make venv    # Set up Python virtualenv (.venv)
make build   # Build Bun packages, host CLI, and Linux operator binaries
make test    # Run Go, TypeScript, Python, template, and skill test suites
make lint    # Run Biome, gofmt, and ShellCheck
```

- Start with the **[Contributing & Onboarding Guide](CONTRIBUTING.md)** and **[System Architecture](docs/architecture.md)**.
- OpenLia source code is licensed under the **[MIT License](LICENSE)**. Third-party component licenses and pins are documented in **[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)**.
