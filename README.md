# OpenLia

> A personal operating system and operations layer built on [Hermes Agent](https://hermes-agent.nousresearch.com/).

OpenLia turns scattered thoughts, documents, and goals into clear decisions and deliberate actions. Rather than locking your life context inside proprietary app silos or ephemeral chat logs, OpenLia provides a **versioned, plain-text personal workspace**, a **provenance-backed claim ledger**, **modular domain features**, and a **decoupled operator control plane**—keeping you in complete control.

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
|  │ • Morning briefings & quick-notes │     │ • Secret rotation & API keys  │  |
|  │ • Project, goal & finance reviews │     │ • Encrypted backups & restore │  |
|  │ • Git checkpoints & approvals     │     │ • Updates, features & skills  │  |
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
| **Responsibilities** | Daily goals, quick capture, document intake, reviews, approvals | Deployment, VM/Docker setup, API keys, backups, updates |
| **Data Handled** | Goals, tasks, claims, calendar, financial journals, health notes | SSH keys, LLM API keys, Age recovery keys, Locho capabilities |
| **Cadence** | Multiple times daily | Initial setup + periodic updates, secret rotation & backup checks |

> [!TIP]
> **Self-hosting OpenLia for yourself?**
> You wear the **Operator** hat once to deploy and maintain the stack with the `openlia` CLI, and wear the **End User** hat every day when chatting with Lia or reviewing your workspace.

---

## Documentation Map

Browse the full documentation in **[`docs/README.md`](docs/README.md)**:

| Audience | Guide | What It Covers |
| :--- | :--- | :--- |
| **End Users** | 📖 **[End User Guide](docs/user-guide.md)** | Daily workflows, Telegram & Workspace UI, Lean Productivity Base, À La Carte Features, Claim Ledger, and approval rules. |
| **End Users** | 📊 **[Workspace Mini-Projects](docs/workspace-domain-views.md)** | Interactive domain views (`/projects/<path>`), `project-manifest.toml`, `ui.openui`, and authoritative `hledger` checks. |
| **Operators** | 🛠️ **[Operator Guide](docs/operator-guide.md)** | Complete `openlia` CLI handbook, `config.toml` & `secrets.env`, Locho & Browser hosts, migrations, and Age-encrypted backups. |
| **Operators** | 📈 **[LLM Usage Monitoring](docs/usage-monitoring.md)** | Token and USD cost tracking across Hermes, Ingestion, and Migration, plus custom pricing overrides. |
| **Operators / QA** | 🧪 **[End-to-End Drills](docs/e2e-drills.md)** | Repeatable verification runbook and troubleshooting guide for disposable or remote deployments. |
| **Contributors** | 🤝 **[Contributing Guide](CONTRIBUTING.md)** | Developer prerequisites, 5-minute setup, component workflows, test suites, and PR conventions. |
| **Contributors** | 🏗️ **[System Architecture](docs/architecture.md)** | Full-stack codebase tour: Go CLI/operator, TypeScript/Bun UI & Browser Relay, Python plugins, and Docker runtime. |
| **Contributors** | 🧠 **[Skill & Feature Development](docs/skill-and-feature-development.md)** | Authoring and testing bundled skills (`profile/skills/`) and À La Carte Feature Packages (`features/`). |

---

## Key Capabilities & Personal OS Model

### 1. Lean Productivity Base + À La Carte Feature Packages
Every workspace starts with a clean **Lean Productivity Base**:
- `inbox/` (quick captures, `daily-briefing/`, and `ingestion/` records)
- `sources/` (retained original PDFs, images, spreadsheets, YouTube transcripts, and extraction artifacts)
- `goals/`, `tasks/`, `calendar/` (`reminders.rem`), `knowledge/claims/`, and `archive/`

Install specialized life domains on demand via `openlia features install <id>` or the Workspace UI:
- **`personal-finance`** (`hledger` journals, Sankey cashflow charts, account reconciliation)
- **`personal-health`** (profiles, medical history, conditions, treatments, reviews)
- **`decision-analysis`** (structured trade-off matrices and decision logs)
- **`deep-research`** (source rubrics and cited research briefs)
- **`areas`**, **`ideas`**, **`monitors`**, **`people`**, **`shopping`**, and **`travel`**

### 2. Verifiable Claim Ledger (`knowledge/claims/`)
Instead of treating transient LLM inferences as truth, OpenLia records durable personal context as Markdown records validated by JSON Schema—tracking **evidence references**, **certainty** (direct report vs. observation vs. inference), **lifecycle status** (`active`, `contested`, `superseded`), and **temporal validity** (`valid_until`, `review_after`).

### 3. Durable Multi-Format Ingestion
Send chat text, PDFs, images (processed via your configured vision LLM), Excel spreadsheets, CSVs, or YouTube links. OpenLia retains the originals under `sources/` and creates structured provenance and intake records automatically.

### 4. Built-in Workspace UI & Native Chat
When `[workspace-ui]` is enabled, a single Bun service provides:
- **Native Chat (`/chat`)**: Streaming conversations over Hermes' private `/v1/runs` API with live tool activity, inline approvals, and detached execution.
- **Document Explorer & Editor (`/files`)**: Markdown preview, CodeMirror editor, and advisory schema validation.
- **Mini-Projects (`/projects`)**: OpenUI dashboards for tasks, goals, finance, travel, shopping, decisions, monitors, and people.
- **Git Checkpoints & Folder Migration (`/migration`)**: Review and confirm AI-grouped Git commits or staged folder imports before they touch your live workspace.

---

## Architecture & Deployment Shape

OpenLia is not a fork of Hermes Agent; it is a thin, reproducible operations and workspace layer around Hermes.

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
      |                           `-- /opt/data (Workspace Git repo + SQLite state)
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

4. **Initialize and deploy**:
   ```bash
   # Local deployment on this machine:
   ./openlia init --local --root "$HOME/.openlia"
   ./openlia deploy

   # Or remote deployment over SSH:
   # ./openlia init --target user@host --root /srv/openlia
   ```

### Step 2: Connect & Use Lia (End User Step)

1. **Workspace UI Chat**: Open [http://localhost:8089/chat](http://localhost:8089/chat) and try:
   - `"Good morning! Run /daily-briefing."`
   - `"Capture this note: compare home solar battery quotes before Q4."`
2. **Workspace UI Editor & Projects**: Open [http://localhost:8089](http://localhost:8089) to browse your Markdown files, install feature packages, or inspect financial and project views.
3. **Telegram**: If configured, message `/start` to your bot on Telegram for mobile capture and daily briefings.

👉 Next steps: Read the **[End User Guide](docs/user-guide.md)** and **[Operator Guide](docs/operator-guide.md)**.

---

## Security Boundaries

- **Out-of-Repo Secrets**: Credentials, OAuth state, and Locho capabilities live outside Git in mode-`0600` files and are injected at runtime (`openlia auth rotate`).
- **Private-by-Default Listeners**: The default Compose stack exposes no public ports and mounts no Docker socket. Remote access uses SSH tunnels or encrypted [Locho](https://github.com/trchopan/locho) attachments (`--locho-host`). Binding Workspace UI to `0.0.0.0` requires an Argon2id `password_hash`.
- **Unprivileged Runtime & Scoped Mounts**: Hermes runs as an unprivileged user with `/opt/data` as its mutable volume; system skills are mounted read-only.
- **Human-in-the-Loop Approvals**: Consequential actions, external side effects, skill migrations, folder imports, and workspace Git commits require explicit confirmation.
- **Client-Side Encrypted Backups**: Durable backups (`openlia backup create`) are encrypted with Age using a public recipient on the target while the private recovery key remains strictly on the operator machine.

To report a security vulnerability, see **[`SECURITY.md`](SECURITY.md)**.

---

## Contributing & License

We welcome contributions across the Go CLI/operator, Workspace UI, Browser Relay, bundled skills, and documentation!

```bash
make venv    # Set up Python virtualenv (.venv)
make build   # Build Bun packages, host CLI, and Linux operator binaries
make test    # Run Go, TypeScript, Python, template, and skill test suites
make lint    # Run Biome, gofmt, and ShellCheck
```

- Start with the **[Contributing & Onboarding Guide](CONTRIBUTING.md)** and **[System Architecture](docs/architecture.md)**.
- OpenLia source code is licensed under the **[MIT License](LICENSE)**. Third-party component licenses and pins are documented in **[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)**.
