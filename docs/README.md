# OpenLia Documentation

Welcome to the OpenLia documentation hub. OpenLia is a **lean, self-hosted deployment and connectivity control plane** on top of [Hermes Agent](https://hermes-agent.nousresearch.com/). It provisions Hermes Agent locally or over SSH, wires private [Locho](https://github.com/trchopan/locho) tunnels for the Hermes API Server (`:8642`), Hermes Web Dashboard (`:9119`), and attached services, manages Age-encrypted local and S3/rsync backups, and provides the `openlia-browser` Playwright MCP relay.

Choose a guide below based on your role or what you want to accomplish.

---

## 1. By Role

### 📖 For End Users (Daily Companion)
Use this guide when interacting with your deployed Hermes Agent day-to-day over Telegram, the Hermes Web Dashboard, or the Hermes API Server.

- **[End User Guide](user-guide.md)**: Interacting via Telegram, the Hermes Web Dashboard (`:9119` / `:19119` via Locho, authenticated with Basic Auth or Google/Auth0 OIDC), the Hermes API Server (`:8642` / `:18642`), managing `/opt/data/workspace` and `/opt/data/memories`, and approval boundaries.

### 🛠️ For Operators (Self-Hosters & System Administrators)
Use these guides when deploying, configuring authentication, tunneling, backing up, or troubleshooting an OpenLia stack on your local workstation or a remote Linux server.

- **[Operator Guide](operator-guide.md)**: Complete administrative handbook—machine roles, `config.toml` & `--config`, `openlia auth` (Basic Auth & OIDC with GCP OAuth / Auth0), Telegram bot setup, Locho private networking (`locho-host` & `attachments`), `openlia-browser` hosts, and Age-encrypted S3/rsync backups.
- **[End-to-End Verification Drills](e2e-drills.md)**: Repeatable operational runbook and troubleshooting field guide for testing disposable or remote deployments (`openlia_dev`).

### 💻 For Developers & Contributors
Use these guides when onboarding to the codebase, building from source, or contributing changes to the CLI, operator, or browser relay.

- **[Contributing & Onboarding Guide](../CONTRIBUTING.md)**: Development prerequisites, 5-minute local setup, component workflows, test suites, and pull request conventions.
- **[System Architecture & Codebase Tour](architecture.md)**: Full-stack architectural overview covering the Go CLI (`cli/`), target operator (`operator/`), `openlia-browser` Playwright MCP relay (`packages/openlia-browser/`), Docker images (`docker/`), and release manifest pinning (`release/manifest.json`).

---

## 2. Package & Component Reference Docs

| Component | Path | Description |
| :--- | :--- | :--- |
| **OpenLia Browser** | [`packages/openlia-browser/README.md`](../packages/openlia-browser/README.md) | Host-local Playwright MCP supervisor, Streamable HTTP `/mcp` relay, FIFO session leases, and Locho attachment setup. |
| **Locho Host Attachments** | [`examples/locho/hosts/example/README.md`](../examples/locho/hosts/example/README.md) | Template and instructions for configuring per-host `attachments.toml`, relay configs, and service roles (`openlia-browser`, `openai-gateway`). |
| **Dev Profile Templates** | [`examples/profiles/dev/`](../examples/profiles/dev) | Starter `config.toml.example` and `openlia_dev.env.example` templates for operator profiles. |
| **Smoke Test Suite** | [`tests/README.md`](../tests/README.md) | Running synthetic (`--mode cli`), local Docker (`--mode local`), and credential-backed (`--mode live`) smoke tests. |
| **Security Policy** | [`SECURITY.md`](../SECURITY.md) | Supported versions, private vulnerability reporting, security scope, and disclosure process. |
| **Third-Party Notices** | [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) | Pinned upstream dependencies, container base images, and license inventory. |
