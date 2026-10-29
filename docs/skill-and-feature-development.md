# Skill & Feature Package Development Guide

> How to create, customize, validate, and test workspace profiles, modular Feature Packages, and skills for OpenLia and [`openlia/templates`](https://github.com/openlia/templates.git).

[← Back to Documentation Index](README.md)

OpenLia separates its core runtime from installable domain templates:
1. **Public Templates Repository ([`https://github.com/openlia/templates.git`](https://github.com/openlia/templates.git))**: Hosts starter **Profiles** (`profiles/<id>/`), modular **Feature Packages** (`features/<id>/`), and standalone **Skills** (`skills/<id>/`). Anyone can also point OpenLia to a custom Git repository, local directory, or `.zip` package.
2. **Core System Skills (`profile/system-skills/<name>/`)**: Read-only system skills bundled in the OpenLia core repository (`openlia-skill-migration` and `workspace-template-customization`).

---

## 1. Standalone & Feature-Bundled Skills (`SKILL.md`)

Skills follow a standard directory layout (either under `skills/<name>/` in `openlia/templates` or inside a feature at `features/<id>/skills/<name>/`):

```text
<skill-name>/
├── SKILL.md               # Required: YAML frontmatter + workflow instructions
├── requirements.txt       # Optional: Python dependencies installed into /opt/data/.local/envs/python/
├── package.json           # Optional: Bun dependencies installed into /opt/data/.local/envs/bun/
├── scripts/               # Optional: deterministic Python/shell helper scripts
├── templates/             # Optional: Markdown report/output templates
└── references/            # Optional: domain rubrics or reference guides
```

### Declaring Skill Dependencies (`requires` Frontmatter)
Skills can declare system tools, Python packages, and Bun packages in their `SKILL.md` frontmatter (under `requires` or `metadata.openlia.requires`):

```yaml
---
name: calendar
description: Manage Remind (.rem) schedules and event notes.
requires:
  tools:
    - remind
  python: requirements.txt
---
```

When a skill is installed via `openlia skills install` (or as part of a feature), OpenLia automatically provisions declared dependencies into `/opt/data/.local/{bin,tools,envs}` and records `/opt/data/.local/manifests/skill-<id>.json`.

### Authoring Guidelines
- **Deterministic Helpers (`scripts/*.py`)**: Any Python helper script under `scripts/` must support a deterministic, offline `--self-test` flag so the test suite (`make skills-test` or `openlia skills test <name>`) can verify it without network access or live credentials.
- **Templates**: If the skill outputs structured Markdown files, place starter templates under `templates/` so template validation checks their headings and optional `$schema` references.

---

## 2. Core System Skills (`profile/system-skills/`)

Protected system skills live under `profile/system-skills/` in the core repository and are mounted read-only into the runtime:
- **`openlia-skill-migration`**: Analyzes an upstream skill or feature update alongside a user's local customization patch and stages a reviewable conflict-resolution proposal.
- **`workspace-template-customization`**: Validates workspace JSON Schemas, Markdown templates, OpenUI definitions (`references/openui-spec.md`), and scoped workspace structure extensions.

System skills are distribution-owned and cannot be forked or modified by Hermes at runtime.

---

## 3. Modular Feature Packages (`features/<id>/`)

Feature packages bundle workspace directories, Markdown templates and inline OpenUI views, JSON Schemas, skills, and tool dependencies into a single installable unit.

### Anatomy of a Feature Package
```text
features/<feature-id>/
├── feature.yaml           # Required: Feature manifest (id, version, title, requires, paths, skills, policy)
├── requirements.txt       # Optional: Feature-scoped Python dependencies
├── skills/                # Optional: Domain skills installed when the feature is enabled
│   └── <skill-name>/
│       ├── SKILL.md
│       └── scripts/
└── workspace/             # Workspace directories, templates, schemas & OpenUI views
    └── <domain>/
        ├── <domain>-template.md
        ├── <domain>-template.schema.json
        └── overview.md             # Optional: narrative with inline OpenUI blocks
```

### Declaring `requires` in `feature.yaml`
`feature.yaml` validates against [`workspace-template/feature.schema.json`](../workspace-template/feature.schema.json) and supports `requires.tools`, `requires.python`, and `requires.bun`:

```yaml
id: personal-finance
version: 1.0.0
title: Personal Finance
description: Plain-text accounting with hledger journals and periodic review records.
requires:
  tools:
    - hledger
paths:
  - finance
skills:
  - personal-finance
```

Supported curated tools in `internal/toolcatalog`:
- `hledger` (pinned static binary release with SHA-256 verification)
- `remind` (built from pinned upstream release tarball into `/opt/data/.local/tools/remind/`)
- `jq` (pinned static binary release with SHA-256 verification)
- `sqlite3` (provisioned into `/opt/data/.local/tools/sqlite3/`)

### Creating, Packaging & Installing a Feature Package
1. **Define `feature.yaml`**: Validate it against [`workspace-template/feature.schema.json`](../workspace-template/feature.schema.json).
2. **Author Workspace Templates & Schemas**:
   - Every frontmatter template (`*-template.md`) declares `$schema: ./<name>-template.schema.json` as a local relative path.
   - Only one `*-template.md` is permitted per directory.
   - Put interactive views in fenced `openui` blocks inside Markdown. See [Inline OpenUI Views](workspace-domain-views.md).
3. **Sync, Install, Package, or Import via CLI**:
   ```bash
   # Sync the catalog from https://github.com/openlia/templates.git
   ./openlia features sync

   # List available catalog and installed features
   ./openlia features list

   # Install a profile or feature from the catalog (or a local path)
   ./openlia features install --profile personal-os
   ./openlia features install personal-finance

   # Package a custom feature directory into a portable .zip archive
   ./openlia features package ./path/to/feature --output my-feature.zip

   # Import a packaged .zip feature archive
   ./openlia features import my-feature.zip
   ```

---

## 4. Automatic Fork Detection & 3-Way Rebase

When a feature or skill is installed, OpenLia saves a clean upstream snapshot under `<MetaRoot>/managed/features/<id>/base/` or `<MetaRoot>/managed/skills/<id>/base/`.

- **Automatic Forking**: Users do not need to run `openlia skills fork` before editing a skill or template. Whenever a managed file is modified (`current_hash != base_hash`), OpenLia automatically detects the customization (`status: forked`) and computes `customization.patch`.
- **3-Way Rebase on Update**: Running `openlia features update [id]` or `openlia skills update [id]` performs a 3-way merge (`old-base` vs. `current-fork` vs. `new-base`):
  - Clean, non-overlapping upstream changes merge automatically while preserving local customizations.
  - Overlapping conflicts leave the live workspace untouched and stage a migration directory under `/opt/data/.openlia/migrations/<id>` for review and Hermes-assisted resolution.

---

## 5. Browser Boundary & Workflow Leases

OpenLia does not ship autonomous browser crawlers in its default skills. Instead, the optional `openlia-browser` package acts as a Playwright MCP supervisor and Streamable HTTP `/mcp` relay (`packages/openlia-browser/`).

When developing an operator-authorized skill or workflow that uses the attached browser:
1. **Acquire a Session Lease**: Reserve exclusive access via `openlia_browser_session_request`, pass the active `lease` token to every Playwright call, renew it during long reasoning (`openlia_browser_session_touch`), and release it when finished (`openlia_browser_session_release`).
2. **Supply `operation_id` on Mutating Calls**: Mutating browser tools (`browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_select_option`, `browser_handle_dialog`, `browser_close`) require a string `operation_id`.
3. **Respect the Eager Allowlist**: Arbitrary JS evaluation, file upload/drop, network inspection, and console tools are excluded by default through the OpenLia relay.
