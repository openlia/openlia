# OpenLia

> A personal operating system running on Hermes Agent.

OpenLia is an opinionated personal operating system and operations layer built on top of [Hermes Agent](https://hermes-agent.nousresearch.com/). It provides a structured, file-based personal workspace, verifiable memory with provenance, and proactive workflows to help you turn thoughts and goals into clear decisions and deliberate actions—while keeping you in complete control.

---

## The Two Roles: Operator vs. End User

To use and understand OpenLia, it is essential to distinguish between **two distinct roles** (even though one person often fulfills both):

```
+-------------------------------------------------------------------------------+
|                                YOU (The Human)                                |
|                                                                               |
|  ┌───────────────────────────────────┐     ┌───────────────────────────────┐  |
|  │          THE END USER             │     │         THE OPERATOR          │  |
|  │        (Daily Companion)          │     │    (System Administrator)     │  |
|  ├───────────────────────────────────┤     ├───────────────────────────────┤  |
|  │ • Telegram (Bot DM / Home Channel)│     │ • Workstation `openlia` CLI   │  |
|  │ • Workspace UI Chat (Browser)     │     │ • Deployment (Local / SSH VM) │  |
|  │ • Workspace UI (Document Editor)  │     │ • Secret rotation & API keys  │  |
|  │ • Morning briefings & quick-notes │     │ • Encrypted backups & restore │  |
|  │ • Project, goal & finance reviews │     │ • System health & updates     │  |
|  │ • Policy boundaries & approvals   │     │ • Skill customizations & sync │  |
|  └─────────────────▲─────────────────┘     └───────────────┬───────────────┘  |
+--------------------┼───────────────────────────────────────┼------------------+
                     │ interacts daily                       │ manages & provisions
                     │                                       │
        ┌────────────┴───────────────────────────────────────▼───────────┐
        │                     OPENLIA RUNTIME PLANE                      │
        │   (Hermes Gateway + Docker Compose + Durable Git Workspace)    │
        └────────────────────────────────────────────────────────────────┘
```

| Dimension            | The End User                                                                    | The Operator                                                                       |
| :------------------- | :------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------- |
| **Primary Tool**     | Telegram, Workspace UI Chat and Editor                                          | `openlia` CLI (terminal on workstation)                                            |
| **Responsibilities** | Daily goals, quick capture, meeting prep, financial ledger, decision trade-offs | Deployment, VM setup, API keys, rotation, backups, updates, system health          |
| **Data Handled**     | Personal journal, projects, health records, knowledge claims, calendar notes    | SSH credentials, LLM API keys, Docker containers, disk mounts, Age encryption keys |
| **Policy Control**   | `assistant-policy.yaml` (delegated autonomy vs. explicit user confirmations)    | System resource limits, required ingestion dependencies, network topology            |
| **Cadence**          | Multiple times daily                                                            | Setup once; periodic updates, secret rotation, and backup monitoring               |

> [!TIP]
> **Are you self-hosting OpenLia for yourself?**
> You are both! You wear the **Operator** hat once to deploy and maintain the stack with the `openlia` CLI, and wear the **End User** hat every day when chatting with Lia on Telegram or reviewing your morning briefing.

---

## Documentation Map

- 📖 **[End User Guide](docs/USER_GUIDE.md)**: The complete guide for daily life with Lia—user interfaces (Telegram, Workspace UI), personal workspace structure, review loops, claim ledger, and delegation policies.
- 🛠️ **[Operator Guide](docs/OPERATOR_GUIDE.md)**: The operational handbook for administrators—`openlia` CLI reference, local vs. remote SSH deployments, secret rotation, encrypted backups, and system maintenance.
- 🧪 **[End-to-End Drills](docs/E2E_DRILLS.md)**: Operational runbook for executing verification drills against disposable or remote environments.
- 🧠 **[Skill Development](docs/SKILL_DEVELOPMENT.md)**: Guide for creating, testing, and customizing bundled workflow skills.

---

## Repository Purpose

The first milestone is a reproducible single-user deployment on a local machine
or a remote Linux VM:

- Docker runs the Hermes gateway with persistent state.
- A workspace template organizes personal information around durable concepts.
- A claim ledger records reusable personal context with evidence and lifecycle
  metadata rather than treating every model inference as a fact.
- Bundled Hermes skills provide workflows that operate across those concepts.
- Locho attachments provide private access to selected external services.
- Authentication is kept outside Git and supports provider credential rotation.
- A derived image makes `bun` and `uv` available to Hermes and its skills.

This repository is not a fork of Hermes and does not replace Hermes' own
configuration, memory, gateway, or skill systems. It supplies an opinionated
template around them.

## Deployment Shape

```text
OpenLia repository/release
        |
        v
Operator machine
        |
        | openlia CLI: deployment, operations, diagnostics
        +-- Local mode
        |     `-- Agent machine (same machine)
        |           `-- Docker Compose (runtime plane)
        `-- SSH -> Remote agent machine
              `-- Docker Compose (runtime plane)

Both agent runtime planes contain:
  +-- Hermes gateway container
  +-- one Locho attachment container per host
  +-- persistent Hermes data (/opt/data)
  +-- runtime-only secrets
  `-- Personal OS workspace
```

The default deployment uses one Hermes profile and one supervised gateway
container. The dashboard and API remain private by default and are reached
through SSH or a private network such as Tailscale. Locho services are exposed
to Hermes over an internal Docker network, not the public VM interface.

OpenLia itself is the operator control plane, not a long-running Compose
service. The `openlia` CLI runs on the operator machine and either invokes local
operations directly or uses SSH for a remote target. The default Compose stack
contains only the Hermes and Locho runtime services. When a browser attachment
is configured, Hermes connects to the host-local `openlia-browser` service for
the supervised Playwright MCP proxy. The optional Workspace UI is disabled unless a
`[workspace-ui]` section is present in `config.toml`. It includes browser Chat
and document editing in the same platform.

### Machine Roles

The full `openlia` CLI is installed and run on the **operator machine**. It is
the control plane, not a service that must be installed on the agent machine.
For a remote deployment, the CLI connects over SSH, uploads the release and a
small target-side operator artifact, and starts the runtime there. The remote
agent machine does not need an OpenLia checkout or the user-facing `openlia`
CLI.

| Machine          | Responsibility                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Operator machine | Runs `openlia`, stores the operator config, and supplies protected source files.                                     |
| Agent machine    | Runs Hermes Agent, Docker Compose, Locho, the workspace, and persistent runtime state.                               |
| Browser machine  | Runs `openlia-browser`, Playwright MCP, the browser, and its browser profile when browser tools use a separate host. |

Local mode means the agent or browser service runs on the operator machine.
Remote mode means the operator CLI uses SSH to manage that component on the
selected target. The agent target and browser target are independent, so the
browser can run on the agent machine, on the operator machine, or on a third
machine.

```text
Operator machine
  openlia CLI
      |
      +-- SSH -> Agent machine
      |          Hermes + Docker Compose + workspace/state
      |
      `-- SSH -> Browser machine (optional)
                 openlia-browser + Playwright + browser profile

Agent machine -- Locho attachment --> Browser machine
```

Run the commands in this README from the operator machine unless a command is
explicitly marked as running on the agent or browser machine. The default
operator config is `~/.config/openlia/config.toml`; set `OPENLIA_CONFIG` to
use a different config for another deployment. Configured secret and
attachment source paths are also read from the operator machine and uploaded
to the selected runtime when required.

Browser tools are configured independently from the Hermes deployment target:

```toml
[openlia-browser]
mode = "ssh"
target = "user@browser-host"
ssh_port = 22
root = "<path_to_openlia_browser_root>"
extension_token_file = "<path_to_extension_token_file>"
```

Manage the selected browser host with `openlia browser configure`,
`install`, `start`, `stop`, `restart`, `status`, `logs`, and `uninstall`.

For a browser on the same machine:

```toml
[openlia-browser]
mode = "local"
target = ""
root = "<path_to_openlia_browser_root>"
extension_token_file = "<path_to_extension_token_file>"
```

The token file must be owned by the browser user and protected with mode `0600`.
Raw Playwright MCP uses port `8931` on loopback; `openlia-browser` uses port
`8932` and is the only endpoint that should be attached to OpenLia through
Locho. OpenLia provides no browser workflows or crawler jobs. External skills
and MCP clients explicitly given this attachment control the browser and are
responsible for their own actions. The shared authenticated profile is
single-owner: external workflows must acquire and carry a browser session lease
for their complete multi-call workflow. Hermes receives direct eager tools from
the conservative relay allowlist; excluded Playwright tools remain unavailable
through the OpenLia relay. Mutating browser tools require a string
`operation_id`, which the relay strips before forwarding. These checks do not
secure raw Playwright for external clients that bypass the relay.

Local mode changes where OpenLia manages the openlia-browser process; it does not
bypass Locho. Configure an openlia-browser Locho attachment for both local and
remote browser hosts. See [`packages/openlia-browser/README.md`](packages/openlia-browser/README.md)
for the short connection guide.

The target repository layout is:

```text
docker/                 Derived Hermes image and Compose files
operator/               Typed Go deployment and runtime operations
cmd/operator/           Cross-compiled target operator entrypoint
profile/                Hermes profile template and distribution metadata
profile/skills/         Workflow skills and deterministic helper scripts
workspace-template/     Initial Personal OS directories and instructions
locho/hosts/            Per-host attachments.toml templates
```

Secrets, Hermes state, memories, sessions, logs, OAuth data, and real Locho
capabilities belong only on the VM's runtime storage. They must never be
committed to this repository.

## Why Lia?

**Lia** is a classic Italian form of **Leah**. In Dante's _Purgatorio_, Leah
represents the active life: she gathers flowers and makes a garland, while her
sister Rachel represents the contemplative life.

That is the idea behind OpenLia. It should help turn reflection into movement:
goals into plans, plans into decisions, and decisions into deliberate action.

## Vision

OpenLia should continuously help a person operate their digital life. It can
observe relevant information, remember context, research and reason about
options, make recommendations, and carry out approved actions.

```text
Digital life
     |
  Observe
     |
 Understand
     |
  Remember
     |
   Reason
     |
 Recommend
     |
  +--+----------------+
  |                   |
Wait for approval    Act
                      |
                Update state
```

The goal is not maximum autonomy. The goal is useful autonomy with a clear
approval boundary.

## The Personal Model

OpenLia organizes information around durable concepts rather than around the
services where information happens to live.

```text
PERSONAL MODEL
|-- Inbox
|-- Goals
|-- Areas
|-- Projects
|-- Knowledge
|-- Ideas
|-- Decisions
|-- Monitors
|-- Tasks
|-- Calendar
|-- People
|-- Shopping
|-- Travel
|-- Finance
`-- Archive
```

These concepts are intentionally independent from any particular email
provider, bank, calendar, browser, or note-taking application. Services may
change; the model of the person's life should remain stable.

### Goals

Goals provide the reason behind the work. They connect high-level direction
to concrete outcomes:

```text
Goal: Become proficient in distributed systems
  -> Learning plan
  -> Projects
  -> Tasks
```

### Areas

Areas are the ongoing parts of life that need attention, such as health,
learning, career, family, home, finance, and personal responsibilities.

### Projects

A task is something to do. A project is something to accomplish. Projects can
contain objectives, milestones, tasks, people, documents, decisions, risks,
deadlines, and status.

### Decisions

Decisions are first-class records, not disposable conversations. A decision
can retain its question, context, options, constraints, evidence, trade-offs,
chosen outcome, date, and later result.

### Monitors

Monitors express a desire to watch for change rather than perform a one-time
task. They can track prices, flights, portfolios, news, software releases, job
listings, websites, research topics, subscriptions, or calendar changes.

### Inbox

The inbox is the universal intake point. A person should be able to capture
something without deciding its final category first:

```text
New information
      |
   OpenLia
      |
  +---+---------+----------+
  |             |          |
 Task        Decision   Idea / Research
  |             |          |
Project      Evidence   Knowledge
```

OpenLia can organize and classify captured information later, when there is
enough context to do so well.

### Claim Memory

Reusable personal context belongs in `knowledge/claims/` as Markdown records.
Start from `knowledge/claims/claim-template.md`; its `$schema` frontmatter
property points to the JSON Schema that validates record metadata. Keep the
human-readable claim under `## Claim`, with source and provenance references,
status, and temporal scope. A confidence score never replaces evidence. Review
`valid_until` and `review_after` dates directly when reviewing records.

The workspace claim ledger is the canonical long-term record. Hermes runtime
memory may cache claim IDs and summaries for retrieval, but Hermes-only memory
must not override an active workspace claim or become durable truth without a
source reference and review. Conflicting claims remain visible as contested or
superseded records rather than being silently overwritten.

### Workspace Growth

The starter workspace keeps a stable core of 15 top-level domains. Each copied
workspace also contains a user-owned `workspace.yaml` registry for semantic
extensions and routing contracts. Ordinary nested folders need no registration.
For a new recurring use case, the assistant inspects the workspace, designs a
suitable location and template, and presents **Confirm, Adjust, or Cancel**.
Schemas are optional. A scoped confirmation covers the proposed structure and
original requested artifact; the agent applies, validates, and continues the
task using the protected `workspace-template-customization` flow. It does not
grant general permission to reorganize the workspace or change delegation.

Existing workspace instructions remain user-owned and are preserved on update.
If they still require registering every folder, include their scoped instruction
update in an approved customization proposal rather than overwriting them with
the bundled defaults.

## Cross-Domain Capabilities

Domains describe _what_ matters in a person's life. Capabilities describe
_how_ OpenLia can work with it.

### Observe

- Read relevant email and messages
- Inspect calendars and files
- Browse websites and connected services
- Collect financial, travel, or research information

### Understand and Remember

- Extract facts, commitments, dates, and relationships
- Preserve reusable claims with source, provenance, temporal scope, and status
- Connect new information to goals, projects, and people
- Maintain useful personal context without forcing premature categorization

### Reason and Recommend

- Research and compare options
- Analyze spending, schedules, and portfolios
- Prioritize work and identify follow-ups
- Forecast, plan, and explain trade-offs

### Act

- Create or update tasks, projects, notes, and calendar events
- Draft messages and documents
- Schedule work and send notifications
- Use browser automation and external APIs when explicitly authorized

Examples of cross-domain workflows include:

```text
Finance + Research              = investment analysis
Shopping + Finance              = purchase decision
Calendar + Projects             = execution planning
Ideas + Knowledge               = idea development
Travel + Finance + Calendar     = trip planning
Email + Tasks + Calendar        = follow-up management
Health + Calendar + Habits      = realistic fitness planning
```

## Review Loops

OpenLia is designed to be useful between questions, not only when prompted.
Periodic reviews keep the personal model current and turn scattered signals
into timely attention.

```text
Daily      Calendar, urgent tasks, follow-ups, important messages, monitors
Weekly     Projects, finance, learning, ideas, shopping watches, next week
Monthly    Spending, portfolio, goals, habits, projects, major decisions
Quarterly  Goals, career, finance, learning, projects, long-term direction
```

## Trust and Approval

OpenLia should be able to do low-risk observation and analysis automatically,
while preserving human control over consequential changes.

| Operation                             | Default    |
| ------------------------------------- | ---------- |
| Read email or research a product      | Automatic  |
| Analyze spending or check a portfolio | Automatic  |
| Add a calendar event or update a task | Ask        |
| Send an email or buy a product        | Ask        |
| Place a trade or transfer money       | Always ask |
| Delete important data                 | Always ask |

The assistant should explain what it found, what it recommends, and what will
happen before it crosses an approval boundary.

## Workflows, Not Isolated Assistants

OpenLia skills should represent meaningful workflows rather than disconnected
feature areas. Possible workflows include:

- Daily briefing
- Weekly review
- Inbox triage
- Deep research
- Investment research
- Portfolio review
- Spending review
- Personal finance
- Study planning and study sessions
- Idea capture and idea review
- Project review
- Meeting preparation
- Travel planning
- Shopping research
- Price monitoring
- Decision analysis
- Personal review

Each workflow can combine multiple capabilities and domains while keeping the
underlying personal model consistent.

## Project Status

The first implementation is a thin operations layer, not a new agent runtime.
It provides a Go operator CLI, pinned Docker/Compose assets, a file-based
Personal OS template, bundled workflow skills, credential rotation, Locho
attachments, and backup/recovery operations for local or remote deployments.

The initial implementation will establish:

1. A durable personal model for goals, areas, projects, knowledge, decisions,
   monitors, tasks, people, and the inbox, with a provenance-aware claim ledger.
2. A versioned Hermes workspace template with `SOUL.md`, `AGENTS.md`, skills,
   and optional review automations.
3. Docker deployment with persistent state, pinned runtime dependencies, and
   operational commands for update, backup, restore, health checks, and local
   workspace Git history tracking.
4. Credential rotation for OpenAI-compatible endpoints and GitHub Copilot
   without placing secrets in Git.
5. Locho attachment management for multiple hosts and multiple services per
   host.

Later work can add more integrations, richer interfaces, and additional
automations without changing the underlying Personal OS model.

## Design Principles

- **Life domains over app silos:** finance, learning, travel, and shopping are
  domains, not separate assistants.
- **Goals before tasks:** actions should retain the context of what they serve.
- **Capture first, organize later:** the inbox should make recording frictionless.
- **Decisions deserve memory:** preserve evidence, reasoning, and outcomes.
- **Claims need provenance:** preserve evidence, temporal scope, uncertainty, and
  lifecycle status for reusable personal context.
- **Observe before acting:** recommendations should be grounded in current
  context.
- **Human control matters:** consequential actions require explicit approval.
- **Stable concepts, replaceable integrations:** external services are adapters,
  not the foundation of the personal model.
- **Thin operations layer:** use Hermes features before introducing custom
  services or runtime code.
- **Secrets stay outside Git:** credentials and service capabilities are
  injected at deployment time and rotated operationally.
- **Explicit deployment boundaries:** the VM, Hermes container, Locho
  attachments, and Personal OS workspace have separate responsibilities.

## Name and Direction

OpenLia is meant to be both reflective and practical: a system for thinking
clearly, remembering context, and acting intentionally in the world.

The practical first step is an opinionated Hermes deployment that can be
recreated, updated, backed up, and moved to another VM without losing the
Personal OS structure or its durable state.

## Prerequisites

| Use case                  | Required runtime                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------- |
| CLI/static smoke          | Go 1.26+, Python 3 with `requirements-dev.txt`, Bash, Docker CLI for Compose validation |
| Local deployment on Linux | Go 1.26+, Docker Engine with Compose v2                                                 |
| Local deployment on macOS | Go 1.26+, Docker Desktop with a Linux engine                                            |
| Remote deployment         | Go 1.26+ locally; SSH, Linux, Docker, and Compose v2 on the target                      |

New deployments use the Go operator and do not require host-target Bash or
Python. Bash and Python remain development and test requirements for the
bundled legacy helpers, smoke runner, and deterministic skill checks. A
release without a target operator artifact automatically uses those legacy
helpers when available.

The first deployment builds pinned Linux images and therefore requires network
access to the configured image registries and release downloads. The pinned
images and bundled binaries support `amd64` and `arm64`. Local Docker roots must
be on a filesystem shared with Docker Desktop on macOS.

For a remote agent machine, verify before initialization that:

- the operator machine has the `openlia` release CLI and an SSH key or other
  configured SSH authentication for `user@host`;
- the agent machine is Linux with Docker Engine and Compose v2;
- the SSH user can run Docker, either directly or through the supported
  passwordless-sudo path; and
- the agent machine can reach the required image registries and release
  downloads.

The remote agent machine does not need Go, Bun, the OpenLia repository, or the
full user-facing `openlia` CLI. The release carries the target-side operator
artifact and runtime files over SSH.

## Source Builds and Releases

The supported installation route is a published OpenLia release: use its
release binaries and container images. The JavaScript, server, and Workspace UI
files under `packages/*/dist/` are generated release inputs and are intentionally
not committed to the source repository.

To build a release from a checkout, install the pinned Bun toolchain and run:

```sh
make build
```

This generates the ignored package distributions, embeds them in the host CLI,
and builds the Linux operator binaries. The release CLI then carries the
generated runtime and UI files to the deployment target. Docker image builds
must run after this generation step because the runtime Dockerfiles consume the
generated files rather than compiling package source.

Clean-checkout builds and CI must use this release build path. A direct

## Quick Start

Setting up OpenLia as a self-hoster involves two steps: **the Operator step** (provisioning the runtime) followed by **the End User step** (connecting and interacting with Lia).

### Step 1: Operator Setup (Provisioning the Runtime)

1. Build the Bun artifacts, host CLI, and Linux target operators with Bun and Go 1.26 or newer:

   ```sh
   make build
   ```

2. Configure your primary LLM provider and fallback chain in `~/.config/openlia/config.toml`:

```toml
[openlia]
provider = "copilot"
model = "copilot-model"
output_language = "en"

[workspace-ui]
host = "127.0.0.1"
port = 8089

[[fallback_providers]]
provider = "custom"
model = "gateway-model"
base_url = "http://locho-laptop:11434/v1"
key_env = "OPENAI_GATEWAY_API_KEY"

[[fallback_providers]]
provider = "openai-api"
model = "official-openai-model"
```

The `fallback_providers` table order is the failover order. Use the actual
Locho Compose hostname, service port, and model IDs for your deployment.

### Ingestion Runtime

The Hermes image includes the required ingestion runtime. It supports chat text,
text files, PDF, images, modern and legacy Excel, CSV, and YouTube metadata or
transcripts. It retains originals under the registered `sources/` library and
uses the configured vision-capable LLM for scanned pages and images. No optional
tools configuration is needed.

```toml
[ingestion]
max_concurrent_jobs = 1
```

The concurrency setting defaults to one and must be a positive integer. Higher
values increase CPU, memory, disk, network, and workspace publication contention.
YouTube transcript availability depends on the source; the first version does
not support Google Docs, Word, arbitrary URLs, Facebook, or TikTok.

Managed Hermes image names include the project, base-image identity, and the
required ingestion dependency revision. This prevents two OpenLia projects on
one Docker host from replacing each other's ingestion image. Custom
`components.hermes_image` values remain the operator's responsibility to keep
isolated between projects.

Add a `[workspace-ui]` section with `host = "127.0.0.1"` to keep the Workspace
Editor private, or use `host = "0.0.0.0"` to publish it on all interfaces. A
public binding requires an Argon2id `password_hash`; generate one with:

```sh
./openlia workspace-ui password
```

The command prompts for the password twice without echo and prints only the
hash to stdout; prompts go to stderr. Passwords have no minimum length, and the
command never accepts a password as an argument. It works without an existing
configuration. Copy the output into your `config.toml`:

```toml
[workspace-ui]
host = "0.0.0.0"
password_hash = "$argon2id$..."
```

Run `openlia deploy` to apply the configured hash. To rotate the password,
generate a new hash, replace `password_hash`, and deploy again. The hash is
mounted into only the Workspace UI container. Omit the section to disable the
UI. For a remote target, use an SSH tunnel with the loopback setting:

```sh
ssh -L 8089:127.0.0.1:8089 user@host
```

The first editor milestone supports workspace browsing, Markdown/text editing,
preview, local diffs, downloads, Git status, and revision-checked atomic saves.
It does not expose runtime secrets, the Docker socket, or Hermes sessions.

All-interface mode uses password sessions with `HttpOnly` and `SameSite=Strict`
cookies. Sessions are stored in a dedicated SQLite database under the runtime
root, use a seven-day idle timeout, and expire after thirty days. Private HTTP
is supported for a trusted LAN or VPN, but it does not encrypt passwords,
sessions, or workspace contents; use HTTPS through a reverse proxy when the
network is not fully trusted. `/health` remains public for container health
checks, while workspace APIs require authentication.

When a service is mapped to the `openlia-browser` role, OpenLia registers its
Streamable HTTP MCP endpoint at `/mcp` directly with Hermes and disables Hermes'
native `agent-browser` toolset, disables tool search for that server, and
exposes only the managed eager allowlist. Legacy `/sse` and `/messages` requests
are rejected. This prevents two browser runtimes from competing for the same
session; it is not a security boundary for clients that bypass the relay.

### Workspace UI Chat

**For everyday chat, use the built-in Chat page in Workspace UI (`/chat`).** It
uses Hermes' persistent sessions and private API, with no extra container or login.
See [native chat](packages/workspace-ui/README.md#native-chat) for supported
features, shared-history access, and upgrade instructions. Everyone allowed into
the workspace shares its chat history. Workspace UI automatically enables the
private Hermes API without publishing its port or exposing its credential to the browser.

Enable it in `config.toml`:

```toml
[workspace-ui]
host = "127.0.0.1"
port = 8089
```

Then initialize and deploy the runtime:

```sh
# Run on the operator machine. Hermes runs on this same machine.
./openlia init --local --root "$HOME/.openlia"
./openlia deploy
```

### Step 2: End User Connection (Interacting with Lia)

Once the deployment is running:

1. **Via Workspace UI Chat**:
   Open [http://localhost:8089/chat](http://localhost:8089/chat) in your browser and use your Workspace UI login, if configured.
   - Try: `"Good morning! Run /daily-briefing."`
   - Try: `"Capture this idea: research local community solar options."`

2. **Via Telegram (Mobile & Messaging)**:
   If configured with your `TELEGRAM_BOT_TOKEN`, open Telegram on your phone or desktop, search for your bot, and send `/start`.
   - Send quick notes, links, or voice messages on the go.
   - Lia will notify you in your Home Channel with morning briefings and monitor alerts.

3. **Via Workspace UI (Document Explorer & Editor)**:
   Open [http://localhost:8089](http://localhost:8089) to inspect, view diffs, and edit your personal Markdown files, goals, projects, and structured claim records.

👉 For detailed day-to-day routines, see the **[End User Guide](docs/USER_GUIDE.md)**.  
👉 For operational commands, backups, and maintenance, see the **[Operator Guide](docs/OPERATOR_GUIDE.md)**.

### Locho Host Bundle

To access Workspace UI privately, initialize OpenLia with its built-in Locho host bundle:

```sh
./openlia init --target user@server --root /srv/openlia --locho-host
```

The flag enables Workspace UI on the server's loopback interface at port `8089`
and a private `locho-host` container. The Locho host
exports only Workspace UI over the encrypted Locho connection; it does
not publish a Docker or Locho application port on the server. The host resolves
the private Workspace UI Compose address at startup and allows no other service
endpoints. OpenLia prompts for the normal
Workspace UI password and stores its Argon2id verifier in the existing protected
configuration path.
Non-interactive initialization requires an existing valid `password_hash` in the
operator config.

After the deployment is running, create a client attachment file on the
operator machine:

```sh
./openlia locho-host share --output openlia-attachments.toml
```

Install [Locho `1.3.0-beta.2`](https://github.com/trchopan/locho/releases/tag/v1.3.0-beta.2)
on any client machine, transfer the generated
mode-`0600` file through a trusted channel, and start the local listener:

```sh
locho attach --config openlia-attachments.toml
```

Locho `1.3.0-beta.2` also supports custom relay transports and configurable HTTP
timeouts. Set `relay_config` in a `[locho]` section to a protected relay TOML
file and, when needed, set `relay_secrets` there to a separate mode-0600 dotenv file. The
relay file is mounted into OpenLia's Locho containers; relay bearer tokens are
injected only into Locho processes and never written to generated Compose or
OpenLia configuration. Clients must export matching `token_env` variables and
use the same relay file with `--relay-config`. Attachment HTTP services may set
`http_timeout_secs = 1..300` per service; the default remains 60 seconds.

Then open `http://127.0.0.1:8089` for Workspace UI, including Chat. The attachment file contains service
capabilities equivalent to passwords. Do not commit it, email it, or place it in
shared logs. OpenLia does not yet expose host-capability rotation; follow Locho's
documented stop/rotate/start requirement before redistributing a newly generated
attachment file. Normal OpenLia durable backups intentionally exclude the host
identity and its capabilities. UI-only updates automatically recreate the Locho
host so it resolves the replacement UI containers before accepting attachments.

`make build` writes the ignored Linux amd64 and arm64 operator artifacts under
`dist/`; the host CLI includes them in release archives when they are present.
It also generates the ignored package distributions required by the embedded
release payload.

On macOS, Docker Desktop provides the Linux container engine used by the local
deployment. On Linux, a local Docker Engine with Compose v2 is supported.
Remote deployment remains available:

```sh
# Run on the operator machine. Hermes runs on user@host.
./openlia init --target user@host --root /srv/openlia
```

`init` installs the pinned OpenLia release at the selected root, initializes the
workspace only when it is empty, starts the Compose stack on the selected agent
machine, and runs health checks. The `--root` path is on that agent machine;
the full `openlia` CLI remains on the operator machine. Provider credentials
are never accepted as command-line values.
Configure a protected dotenv source path in the operator config:

```toml
[secrets]
source = "/path/outside/this/repository/hermes.env"
```

The source must already exist as a regular file outside the checkout with mode
`0600` on the operator machine:

```sh
chmod 600 "$HOME/.config/openlia/dev/openlia_dev.env"
```

Local deployments preserve host-file ownership; the Linux containers use the
invoking user's UID/GID for shared runtime files. Remote deployments use
UID/GID `10000` when the operator runs with passwordless sudo, and the SSH
user's UID/GID when it runs without sudo. No manual host-side `chown` is
required.

The configured source is used by `init` and subsequent credential rotations:

```sh
./openlia auth rotate
```

Credential rotation keeps the previous secret in a protected runtime backup so
it can be restored if container recreation fails. Remove the deployment or its
runtime backups when that recovery point is no longer needed.

`init` and `auth rotate` use the configured source; source paths are not accepted
as command-line arguments.

The source file may contain `COPILOT_GITHUB_TOKEN`, `OPENAI_GATEWAY_API_KEY`,
`OPENAI_API_KEY`, and numbered OpenAI key siblings.
Classic `ghp_*` tokens are not valid for Copilot. Hermes reads the file through
its `secrets.command` source; its values are never printed by OpenLia.

Telegram home-channel settings belong in this same protected dotenv source. Use
the numeric chat ID shown by `openlia telegram id`:

```dotenv
TELEGRAM_HOME_CHANNEL=-1001234567890
TELEGRAM_HOME_CHANNEL_NAME="OpenLia home"
```

`TELEGRAM_HOME_CHANNEL` may be a private-chat ID or a group/channel ID. Group
and supergroup IDs are normally negative. The bot must have received an update
from the chat before `openlia telegram id` can discover its ID. After editing
the source, run `openlia auth rotate`; if Hermes is running, OpenLia recreates
it automatically. The setting survives OpenLia updates.

Do not set `OPENAI_BASE_URL` for this provider chain. Assign the Locho service
the `openai-gateway` role and declare its explicit `/v1` URL in the matching
`fallback_providers` entry. Hermes keeps `openai-api` pointed at official OpenAI.

OpenLia initializes the workspace as a local Git repository and records an
initial commit. Use local Git history to track approved workspace changes; do
not configure a Git remote or use Git network operations. Encrypted OpenLia
backups preserve the workspace, including its local Git history, and are the
recovery mechanism. See the backup section below for scheduling and remote
destinations.

The Hermes agent uses `Asia/Ho_Chi_Minh` by default. Set another IANA timezone
per target during initialization:

```sh
./openlia init --target user@host --timezone America/New_York
```

The timezone is stored in the operator `config.toml` and applied to Hermes
through its documented `HERMES_TIMEZONE` setting, with `TZ` also set for
system-level libraries. OpenLia's operational timestamps remain in UTC. When
managing multiple targets, use a separate `OPENLIA_CONFIG` file for each target
so each agent can have its own timezone.

Set the agent's default response language in the operator `config.toml` with a
BCP 47 language tag:

```toml
[openlia]
output_language = "vi"
```

The default is `en`. Run `openlia restart` after changing this value; OpenLia
updates the managed Hermes language instruction before restarting while
preserving the stored conversation history. An explicit language request in a
user message takes precedence for that response. CLI, Workspace UI, and raw
tool output are not localized by this setting.

## Operations

Run these commands on the operator machine. For a remote deployment, the CLI
uses the target saved in the operator config and performs the operation over
SSH; you do not need to install or invoke the full `openlia` CLI on the agent
machine.

```text
openlia status --json
openlia doctor --json
openlia logs --follow
openlia stop
openlia start
openlia restart
openlia uninstall
openlia uninstall --target user@host --project NAME --root /path
openlia backup create
openlia backup keygen
openlia backup status
openlia backup list
openlia backup push [--archive FILENAME.age]
openlia backup restore --non-interactive --archive /path/to/backup.tar.gz.age
openlia backup restore --non-interactive --from primary --latest
openlia backup schedule install|remove
openlia backup rollback-restore --non-interactive --archive /path/to/rollback.tar.gz
openlia workspace git status
openlia workspace git setup
```

### User-approved workspace checkpoints

Ask Lia to “review my workspace changes and propose commits,” or select
**Propose commits** in **Git Activity**. Hermes analyzes a frozen snapshot of the
diffs and recommends coherent commit groups with messages, rationale, and excluded
files. Use **Revise in chat** to change the recommendation. No agent tool creates
commits: review the diffs and select **Review & confirm**, then **Confirm commits**
in the UI. Approval applies only to that proposal revision and reviewed content.
Changed files or a changed HEAD require a refreshed proposal and another review.

The `[workspace_git]` schedule (default `0 4 * * *`) is now **reminder-only**;
upgrades replace the old automatic-commit prompt. Clean workspaces need no reminder.
Legacy `local_git_commits` delegation does not bypass checkpoint confirmation.
Checkpoints stay local; encrypted backups remain the durable recovery mechanism.
The executor preserves unrelated staging and never rewrites workspace files.
Resolve partial staging on selected files before confirmation. File-level groups
are supported; splitting one file across commits is not supported yet. Checkpoint
review requires Python 3 and Git (bundled in the managed Workspace UI image).
If you maintain a customized Hermes `config.yaml`, enable the bundled
`openlia-workspace-git` plugin under `plugins.enabled`; managed configurations
receive it automatically on deployment.
Reviews are bounded to 500 changed paths, 8 MiB of file content, and 2 MiB of
combined diffs. Individual files over 2 MiB are explicitly excluded rather than
preventing review of smaller records. Symlinks and unresolved conflicts fail closed.
Local review snapshots and proposal revisions are retained under
`.git/openlia-checkpoints` (including dismissed reviews); inspecting changes may
also write unreferenced Git blobs, but never advances HEAD or stages files.

Use a separate operator config when managing another deployment:

```sh
OPENLIA_CONFIG="$HOME/.config/openlia/remote.toml" openlia status
```

`openlia deploy` applies configuration using the release already installed on
the target. After changing OpenLia or Workspace UI source, use
`openlia deploy --release` to upload and activate the release bundled in the
local CLI before reconciling services. The deploy result reports release and
Workspace UI build identities.

Maintenance commands use the selected operator config by default. `uninstall`
shows the resolved deployment before confirmation; repeated `--local`,
`--target`, `--root`, or `--project` values are assertions and must match the
config. If no config exists, provide a complete explicit selection. Conflicting
arguments are rejected rather than silently selecting another deployment.

`openlia backup create` creates an encrypted durable backup of the workspace,
workspace Git history, Hermes agent state, profile-managed files, metadata, and
custom skills. The operator machine holds the age private identity;
the target receives only its public recipient and can encrypt but cannot
decrypt. `openlia init` creates the operator identity at
`~/.config/openlia/backup-identity.txt`; `openlia backup keygen` creates it for
an existing deployment. Keep a separate recovery copy of the private identity.
The archive excludes bundled image skills, rebuildable caches and
environments, logs, releases, Docker images, secrets, and Locho capability
files. Manual capture stops the running Hermes gateway and optional Workspace
UI while it creates and validates a consistent archive, then restarts them
before remote upload. Its retained local archive and any S3/rsync copies are
ciphertext.

New installations start a Compose backup-scheduler sidecar with a daily
schedule defaulting to 04:20 in the configured IANA timezone. The sidecar is
used for both remote Linux and local macOS deployments and is managed entirely
through Compose. Change `[backup].schedule` with a five-field cron expression
(for example `"0 2 * * 1"` for Mondays at 02:00), set
`schedule_enabled = false` to disable it, and run `openlia backup schedule
install` after changing the schedule. Scheduled capture is live and
best-effort: Hermes remains available, but files being changed during capture
may be retried or cause that backup run to fail. Missed schedule occurrences
are coalesced into at most one run when the target returns.

Configure zero, one, or both remote destinations under `[[backup.destinations]]`:

```toml
[backup]
schedule = "20 4 * * *"
schedule_enabled = true
local_retention = 5
local_max_size = "10 GiB"
remote_retention_days = 30
# Optional target-side SSH known-hosts file used by the backup sidecar.
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

`local_max_size` accepts quoted binary or decimal sizes such as `"10 GiB"`,
`"500 MiB"`, or `"10 GB"`.

S3 credential paths are relative to the selected profile's `config.toml`
directory. Files must be regular mode-`0600` files outside the checkout and use
the standard AWS shared-credentials format. OpenLia uses the reader file only
for local listing/downloads, and deploys only the selected writer profile to the
target for uploads and retention. The private age recovery identity is never
deployed. Re-run deployment or `openlia backup push` after rotating a writer
file. If these fields are absent, the existing AWS environment/shared-file
credential chain remains active. The operator machine also needs reader access
to retrieve remote backups. For rsync, provision the target-side SSH key at
`identity_file` outside `runtime/secrets` and the Hermes data directory so the
agent container cannot read it. Pin the host in the configured target
`known_hosts` file, and configure `operator_identity_file` (or an operator-side
SSH agent) for recovery. Remote retention defaults to 30 elapsed days per
destination; local retention keeps five durable archives and applies a 10 GiB
soft budget to archive and metadata pairs. The newest verified archive is
preserved even if it alone exceeds the budget. If no verified local archive
exists, cleanup stops and reports an error. `openlia backup status` shows
retention usage, budget, cleanup errors, the latest local archive, and the last
upload result; `openlia backup list` lists remote archives.
Remote pruning also preserves the newest remote archive, even when it is older
than the configured retention window.
If one destination fails, the encrypted local archive remains and the other
destination is still attempted. Retry the newest artifact with
`openlia backup push`, or select one retained encrypted archive with
`--archive FILENAME.age`. On versioned S3 buckets, configure lifecycle expiry
for noncurrent object versions and incomplete multipart uploads as well; OpenLia
prunes visible current objects older than the configured age under its
configured prefix.

`openlia backup restore` accepts a local `.tar.gz.age` archive or retrieves one
from a configured destination with `--from NAME --latest` (or `--object NAME`).
The operator CLI verifies and decrypts it locally, then transfers the archive
over SSH and invokes the existing transactional restore. Durable restore
accepts encrypted `.tar.gz.age` archives only; there is no plaintext archive
migration or unencrypted durable-restore path. Internal operation-scoped
rollback snapshots keep their existing protected local behavior and are not uploaded.
Restore replaces durable Hermes and metadata trees, removes stale durable
files, normalizes restored ownership, preserves destination secrets and
attachments, and leaves runtime services stopped for verification before
`openlia start` or `openlia restart`.

Uninstall removes local archives and the target schedule but never deletes
remote objects. Before confirming uninstall, inspect the displayed destination
status and ensure a remote backup is available if you may need recovery. Keep
the operator identity and read credentials; uninstall leaves them on the
operator machine so remote ciphertext remains recoverable.

`openlia update` is read-only without a component. `openlia update openlia`
synchronizes the Go operator, profile, templates, and bundled skills.
The Hermes and Locho commands reconcile only their pinned runtime
boundaries; they do not silently replace desired digests.

OpenLia tracks provenance for `profile/AGENTS.md`, `profile/SOUL.md`, and
`workspace/AGENTS.md`. Unchanged profile instructions update automatically.
Customized profile instructions and workspace-template changes remain active
and are staged for explicit review:

```sh
openlia instructions status
openlia instructions diff workspace/AGENTS.md
openlia instructions merge workspace/AGENTS.md
openlia instructions keep workspace/AGENTS.md
openlia instructions reset workspace/AGENTS.md
```

`merge`, `keep`, and `reset` require exact interactive confirmation, create a
backup, and reject the operation if either reviewed file changed in the
meantime. `keep` preserves the local instruction while acknowledging the new
upstream baseline. `reset` installs the upstream instruction. `merge` only
applies a conflict-free three-way merge; structural or overlapping edits remain
unchanged for manual review. The managed output-language block in `SOUL.md` is
excluded from customization detection and continues to follow `config.toml`.

Profile synchronization tracks distribution-owned skill provenance in
`meta/managed/skills/<skill>.json`, including the upstream base version, source
identifier, content hash, base snapshot, customization patch, and timestamps.
It updates an unchanged managed skill and preserves forked skills. Fork a skill
before customizing it:

```sh
openlia skills fork daily-briefing
```

When a fork has an upstream update, `openlia update openlia` leaves the active
fork untouched and stages a migration context for Hermes. The protected
`openlia-skill-migration` system skill can create a migration proposal when you
ask for the migration in chat. It uses the old base, customization patch, and
new upstream base from the staged context. Do not run `migrate prepare` after an
update has already staged that context. The active skill is not changed until
the proposal is reviewed and applied through the host CLI:

```sh
openlia skills migrate show PROPOSAL_ID
openlia skills migrate apply PROPOSAL_ID
```

`openlia skills migrate prepare SKILL` is only a manual context-staging command
when an update has not already prepared the context; it does not create a
proposal.

Migration patches are internal tooling artifacts. Users review the proposed
behavior and conflict summary rather than editing patch files directly. The
system resolver skill cannot be forked or edited by Hermes and is updated only
by OpenLia profile synchronization.

Skills are workflow-oriented rather than domain-specific:

```text
  openlia skills list --json
  openlia skills show daily-briefing
  openlia skills status daily-briefing
  openlia skills test deep-research
```

OpenLia currently provides the bundled skills and supports local customization
of bundled skills through `openlia skills fork` and `openlia skills migrate`.
Git-repository-based external skill import and update commands have been
removed; a replacement design will be documented separately. See
[`docs/SKILL_DEVELOPMENT.md`](docs/SKILL_DEVELOPMENT.md) for bundled skill
development.

## Security Boundaries

- Hermes runs inside the derived image as the upstream unprivileged runtime user.
- `/opt/data` is the only mutable Hermes volume.
- The OpenLia migration resolver is distribution-owned and mounted read-only;
  it can propose migrations but cannot edit active skills.
- The default Compose stack has no public ports and no Docker socket mount.
- Workspace UI all-interface bindings require an Argon2id password and protect
  workspace APIs with expiring in-memory sessions; direct HTTP should only be
  used on a trusted private network.
- Locho listeners use the private Compose network and are never published.
- Workspace initialization is copy-once; later deployments preserve user files.
- Durable backups exclude secret files, OAuth state, bundled image
  skills, rebuildable caches, and Locho capabilities. Protected
  durable archive files are encrypted to an operator-held age identity before
  retention or remote upload. Operation-scoped rollback snapshots contain only
  the specific files required to undo an approved mutation; they remain
  local-only protected files and are not part of the remote backup format.
- Dangerous unattended actions are denied and skill writes are staged for review.
- Local workspace Git history does not require credentials or a remote.

## Local Verification

Run `make build` first from a clean checkout so the generated package
distributions exist for the Go embedding step. Then run the checks below:

```sh
go test ./...
go vet ./...
python3 tests/smoke.py --mode cli
python3 tests/smoke.py --mode local --root /tmp/openlia_smoke
python3 tests/smoke.py --mode workspace-ui --root /tmp/openlia_workspace_ui_smoke
make smoke-local-live \
  OPENLIA_SMOKE_ENV_FILE="$HOME/.config/openlia/dev/openlia_dev.env" \
  OPENLIA_SMOKE_ATTACHMENTS_FILE="$HOME/.config/openlia/dev/locho-attachments.toml" \
  OPENLIA_SMOKE_LOCHO_HOST=genai
make compose-config
```

The CLI smoke gate uses synthetic data. The local deployment smoke starts the
real Compose stack, checks the local lifecycle, and removes its disposable root
when complete. Its root must not already exist; an existing root is never
cleaned automatically. Provider requests, OAuth, Locho connectivity, VM reboot
behavior, external exposure scans, and recovery tests require disposable
credentials or a disposable target. They must be reported as `N/A` when those
prerequisites are absent.

For a credential-backed local deployment that remains available for manual
conversation, use `--mode live --local` and omit `--cleanup`. Telegram checks
are `N/A` without an interactive terminal; they do not claim that Telegram was
tested. See [`tests/README.md`](tests/README.md) for the complete command and
the explicit uninstall command.

For the explicit live Telegram and Personal Finance smoke test, see
[`tests/README.md`](tests/README.md). It requires all deployment paths and
identifiers as arguments and leaves the development target running unless
`--cleanup` is supplied.

For an operational guide on running disposable development drills, Telegram checks,
and Locho tunneling with `openlia_dev`, see [`docs/E2E_DRILLS.md`](docs/E2E_DRILLS.md).

## Contributing and License

Development requirements and local checks are documented in
[`CONTRIBUTING.md`](CONTRIBUTING.md). OpenLia source files are available under
the MIT License; see [`LICENSE`](LICENSE). Runtime images and external tools
remain subject to their respective upstream licenses.
