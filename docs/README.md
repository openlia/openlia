# OpenLia Documentation

Welcome to the OpenLia documentation hub. OpenLia is an opinionated personal operating system and operations layer built on top of [Hermes Agent](https://hermes-agent.nousresearch.com/).

Choose a guide below based on your role or what you want to accomplish.

---

## 1. By Role

### 📖 For End Users (Daily Companion)
Use these guides when interacting with Lia day-to-day over Telegram or the Workspace UI to capture notes, manage goals and projects, review briefings, and organize your personal workspace.

- **[End User Guide](user-guide.md)**: Daily life with Lia—interfaces (Telegram, Workspace UI Chat, Document Editor, Mini-Projects), the Lean Productivity Base, À La Carte Feature Packages, review loops, the Claim Ledger, and delegation boundaries.
- **[Workspace Mini-Projects & Domain Views](workspace-domain-views.md)**: Reference for interactive domain views (`/projects/<path>`), `project-manifest.toml`, `ui.openui`, structured Markdown tables/checklists, and authoritative `hledger` financial checks.

### 🛠️ For Operators (Self-Hosters & System Administrators)
Use these guides when deploying, configuring, updating, backing up, or troubleshooting an OpenLia stack on your local workstation or a remote Linux server.

- **[Operator Guide](operator-guide.md)**: The complete administrative handbook—machine roles, `config.toml` & `secrets.env`, Telegram bot setup, Locho private networking, `openlia-browser` hosts, updates & skill/instruction merges, workspace Git checkpoints, folder migrations, and Age-encrypted S3/rsync backups.
- **[LLM Usage Monitoring](usage-monitoring.md)**: How OpenLia tracks estimated token usage and USD costs across Hermes, Ingestion, and Migration, including pricing overrides and operational boundaries.
- **[End-to-End Verification Drills](e2e-drills.md)**: Repeatable operational runbook and troubleshooting field guide for testing disposable or remote deployments (`openlia_dev`).

### 💻 For Developers & Contributors
Use these guides when onboarding to the codebase, building from source, adding CLI commands or UI features, or authoring new skills and feature packages.

- **[Contributing & Onboarding Guide](../CONTRIBUTING.md)**: Development prerequisites, 5-minute local setup, component-specific workflows, test suites, and pull request conventions.
- **[System Architecture & Codebase Tour](architecture.md)**: Full-stack architectural overview covering the Go CLI & target operator, TypeScript/Bun Workspace UI & Browser Relay, Python Hermes plugins, Docker images, and release manifest pinning.
- **[Skill & Feature Package Development](skill-and-feature-development.md)**: How to author, validate, and test bundled skills (`profile/skills/`), system skills (`profile/system-skills/`), and installable À La Carte Feature Packages (`features/`).

---

## 2. Package & Component Reference Docs

Several subdirectories contain focused README files for package-local workflows and templates:

| Component | Path | Description |
| :--- | :--- | :--- |
| **Workspace UI** | [`packages/workspace-ui/README.md`](../packages/workspace-ui/README.md) | React + TanStack Start + Bun server development, mock scenarios, native Chat, memory editing, and Playwright visual checks. |
| **OpenLia Browser** | [`packages/openlia-browser/README.md`](../packages/openlia-browser/README.md) | Host-local Playwright MCP supervisor, Streamable HTTP `/mcp` relay, FIFO session leases, and Locho attachment setup. |
| **Personal OS Template** | [`workspace-template/README.md`](../workspace-template/README.md) | Canonical starter directories, JSON Schema frontmatter rules, delegated actions, and workspace growth contracts. |
| **Locho Host Attachments** | [`examples/locho/hosts/example/README.md`](../examples/locho/hosts/example/README.md) | Template and instructions for configuring per-host `attachments.toml`, relay configs, and service roles (`openlia-browser`, `openai-gateway`). |
| **Scheduled Cron Jobs** | [`profile/cron/README.md`](../profile/cron/README.md) | Safety rules and review workflow for scheduling recurring Hermes cron jobs. |
| **Smoke Test Suite** | [`tests/README.md`](../tests/README.md) | Running synthetic (`--mode cli`), local Docker (`--mode local`), Workspace UI (`--mode workspace-ui`), and credential-backed (`--mode live`) smoke tests. |
| **Security Policy** | [`SECURITY.md`](../SECURITY.md) | Supported versions, private vulnerability reporting, security scope, and disclosure process. |
| **Third-Party Notices** | [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) | Pinned upstream dependencies, container base images, and license inventory. |
