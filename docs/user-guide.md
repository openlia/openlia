# OpenLia End User Guide

> A guide to collaborating with your autonomous AI workspace assistant.

[← Back to Documentation Index](README.md)

OpenLia is a **self-hosted, AI-native workspace** for turning personal context into organized knowledge, decisions, and action—with **Hermes Agent** as its agent runtime. Chat, document editing, and interactive Mini-Projects share the same Git-versioned workspace. Profiles, features, and skills extend your workflows, while human approval boundaries keep consequential actions under your control.

---

## 1. Understanding Your Roles

When working with OpenLia, there are two distinct roles:

```text
+-------------------------------------------------------------------------+
|                            YOU (The Human)                              |
|                                                                         |
|  ┌───────────────────────────────────┐  ┌────────────────────────────┐  |
|  │        AS THE END USER            │  │      AS THE OPERATOR       │  |
|  │       (Daily Companion)           │  │   (System Administrator)   │  |
|  ├───────────────────────────────────┤  ├────────────────────────────┤  |
|  │ • Chat on Telegram or Workspace   │  │ • Runs `openlia` CLI       │  |
|  │ • Quick-capture notes & documents │  │ • Deploys & updates server │  |
|  │ • Explore Mini-Project dashboards │  │ • Rotates API keys         │  |
|  │ • Edit Markdown & OpenUI views    │  │ • Manages backups & health │  |
|  │ • Approve git checkpoints & plans │  │ • Installs template packs  │  |
|  └───────────────────────────────────┘  └────────────────────────────┘  |
+-------------------------------------------------------------------------+
```

- **The End User**: The person collaborating with Lia throughout the day to organize documents, build Mini-Projects, run domain workflows, and make decisions. **This guide is for this role.**
- **The Operator**: The person managing the underlying servers, Docker containers, API keys, and backups using the `openlia` command-line tool. If you are also managing your own server, see the [Operator Guide](operator-guide.md).

---

## 2. How You Interact With Lia

OpenLia supports multiple user interfaces depending on your preferred workflow:

### A. Workspace UI Chat (Browser Conversations)
Open the **Chat** tab at `http://localhost:8089/chat` (or your private Workspace UI address). No separate service or login is required beyond your Workspace UI session:
- Conversations and tool history are saved by Hermes and can be resumed at any time.
- Rename, pin, archive, or delete Workspace chats; other Hermes sessions (such as Telegram) are available as read-only history.
- Replies stream live with grouped tool activity, interactive approval controls, a **Stop** button, and the ability to send explicit guidance to a running agent. Navigating away or refreshing does not interrupt the running agent.
- Select a model route advertised by Hermes or leave **Hermes default** selected.

### B. Telegram (Mobile & Messaging Interface)
Telegram is the primary mobile channel for quick capture and notifications on the go:
- **Direct Messages (DMs)**: Chat one-on-one with your private bot. Send text messages, share links, upload PDFs/images/spreadsheets for durable ingestion, or record voice notes.
- **Home Channel / Group**: A dedicated Telegram channel (e.g., `"OpenLia Home"`) where Lia posts scheduled briefings, automated monitor alerts, and periodic reviews.
- **Interactive Approvals**: When an action requires confirmation, Lia prompts you in chat before executing.

### C. Workspace UI (Documents, Projects, Git Activity & Usage)
Accessible at `http://localhost:8089` (directly on loopback, via SSH tunnel, or via a private Locho connection):
- **Documents (`/files/<path>`)**: Web-based explorer and editor for your entire workspace. View Markdown files with live preview, edit YAML/JSON/TOML/CSV/code files with syntax highlighting, and see real-time schema validation diagnostics.
- **Projects (`/projects/<path>`)**: Interactive Mini-Project dashboards powered by `project-manifest.toml` and `ui.openui` for any domain folder in your workspace. See [Workspace Mini-Projects & Domain Views](workspace-domain-views.md).
- **Maintainer (`/maintainer`)**: Advisory workspace structure & schema health dashboard powered by **Workspace Maintainer**, offering guided fixes without blocking normal saves.
- **Git Activity**: Review frozen-snapshot diffs of your workspace changes and ask Lia to propose coherent commit groups (**Propose commits** → **Review & confirm** → **Confirm commits**).
- **Migration (`/migration`)**: Inspect and approve staged folder imports into your workspace.
- **Usage (`/usage`)**: Monitor estimated LLM token consumption and USD costs across Hermes, Ingestion, and Migration. See [LLM Usage Monitoring](usage-monitoring.md).

---

## 3. The Modular Workspace Model

Unlike traditional assistants where your context is locked away in vendor databases or ephemeral chat windows, OpenLia stores your context in a **versioned, plain-text workspace** (`/opt/data/workspace`).

### Ultra-Minimal Core Workspace
Every new workspace starts with a clean, unopinionated core structure (`workspace-template/`):

```text
workspace/
├── AGENTS.md               # Workspace-specific guidance and conventions for Lia
├── README.md               # Workspace overview
├── feature.schema.json     # Schema for modular feature manifests
├── inbox/                  # Unsorted captures and incoming items
│   └── ingestion/          # Durable intake records from uploaded files & links
└── sources/                # Retained original documents, extraction artifacts & passwords
    ├── artifacts/          # Immutable extracted text/tables from ingested files
    ├── records/            # Provenance records for ingested sources
    └── document-passwords.toml
```

### Public Templates Catalog (`https://github.com/openlia/templates.git`)
You can keep your workspace completely custom or install starter profiles, modular features, and workflow skills from **[`openlia/templates`](https://github.com/openlia/templates.git)**:

- **`personal-os` Profile (`openlia features install --profile personal-os`)**: Installs the full Personal OS suite (`goals`, `tasks`, `calendar`, `claims`, `daily-briefing`, and all 7 core productivity skills) in one command.
- **Modular Features (`openlia features install <id>`)**:

| Feature Package | Workspace Folders Added | Capabilities & Dependencies |
| :--- | :--- | :--- |
| **`goals`** | `goals/` | High-level outcomes and milestones with OpenUI dashboard |
| **`tasks`** | `tasks/` | Concrete action items with Kanban & table views |
| **`calendar`** | `calendar/` | Calendar Mini-Project with Month, Week, and event-duration Timeline views, local appointment creation, companion event notes, and `reminders.rem` (automatically installs `remind` CLI into `/opt/data/.local`) |
| **`claims`** | `knowledge/claims/`, `archive/` | Provenance-backed personal claim ledger with certainty and temporal validity |
| **`daily-briefing`** | `inbox/daily-briefing/` | Dated morning briefing reports and `/daily-briefing` skill |
| **`personal-finance`** | `finance/`, `finance/intake/`, `finance/accounts/`, `finance/portfolios/`, `finance/reviews/` | Read-only hledger dashboards and charts, structured account mappings, and the `personal-finance` skill (automatically installs agent-side `hledger` into `/opt/data/.local`) |
| **`personal-health`** | `health/`, `health/profiles/`, `health/history/`, `health/conditions/`, `health/treatments/`, `health/reviews/` | `personal-health` skill & structured medical templates |
| **`decision-analysis`** | `decisions/` | `decision-analysis` skill + option/criteria trade-off matrix |
| **`deep-research`** | `knowledge/research/` | `deep-research` skill + source rubric & brief templates |
| **`areas`**, **`ideas`**, **`monitors`**, **`people`**, **`shopping`**, **`travel`** | Domain folders & OpenUI Mini-Projects | Specialized personal & operational domains |

### Customizing Templates & Skills Safely
You can edit any installed template, schema, OpenUI view, or skill directly. OpenLia automatically detects your edits (`current_hash != base_hash`) as a local customization and preserves them with a 3-way rebase when you update upstream templates later.

### Structured Records and Schemas
Records in templated folders use standard Markdown with YAML frontmatter. Each folder's `*-template.md` declares a local `$schema` pointing to a JSON Schema file:

```markdown
---
$schema: ./goal-template.schema.json
title: Become proficient in distributed systems
status: active
target_date: "2026-12-31"
---

## Why This Matters
Build strong foundations for designing fault-tolerant services.

## Milestones
- [x] Read Designing Data-Intensive Applications
- [ ] Implement Raft consensus lab
```

Validation is **advisory**: the Workspace UI and Workspace Maintainer highlight structural or schema issues without blocking you from saving your notes. Ordinary nested folders without a local template remain free-form.

### Durable Ingestion (`sources/` & `inbox/ingestion/`)
When you send Lia a PDF, image, Excel spreadsheet, CSV, text file, or YouTube link:
1. The ingestion runtime retains the original file and extracted artifacts under `sources/`.
2. It creates a durable intake record in `inbox/ingestion/` and a source provenance record in `sources/records/`.
3. For password-protected PDFs or spreadsheets, you can store document-unlock passwords in `sources/document-passwords.toml`.

---

## 4. Trust, Safety, and Approvals

OpenLia is designed around **useful autonomy with a clear human approval boundary**. Consequential runtime permissions (`/opt/data/permissions.yaml`, configurable in Workspace UI under **Configuration**) govern destructive actions (`delete_records`, `overwrite_records`), external side effects (`send_messages`, `modify_external_calendar`, `purchases`, `financial_transactions`), and scheduled work (`scheduled_work`):

| Action Category | Default Authority | Behavior |
| :--- | :--- | :--- |
| **Reading & Analyzing Workspace** | Automatic | Lia reads notes, searches files, and synthesizes answers automatically. |
| **Writing to Inbox & Sources** | Standing delegation | Lia captures incoming notes/files to `inbox/` and `sources/`. |
| **Routine Workspace Updates** | Standing delegation | Routine updates to records and notes within authorized domains, preserving provenance. |
| **New Recurring Workspace Structure** | Scoped confirmation | Lia designs the folder, template, and optional Mini-Project (`project-manifest.toml` + `ui.openui`) and offers **Confirm, Adjust, or Cancel** before applying. |
| **Workspace Git Commits** | Explicit confirmation | Lia proposes grouped commits from a frozen diff snapshot; you confirm them in the UI. |
| **External Communications (Email/Chat)** | Always ask | Lia drafts messages and waits for your explicit approval before sending. |
| **Financial Transactions & Purchases** | Always ask | Local bookkeeping is separate from external money movement, which always requires approval. |
| **Destructive Actions / Deletions** | Always ask | Lia never permanently deletes records or rewrites Git history without confirmation. |
