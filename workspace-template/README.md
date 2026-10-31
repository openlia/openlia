# OpenLia Workspace

This directory is the minimal starter workspace for OpenLia — a self-hosted,
AI-native workspace for turning personal context into organized knowledge,
decisions, and action, with **Hermes Agent** as its agent runtime. It is copied
into an empty runtime workspace; later profile syncs seed missing starter files
without replacing existing workspace files.

**Workspace Maintainer** discovers collections automatically from workspace
folders, local `*-template.md` templates, referenced `*.schema.json` schemas,
and Markdown records. Structural findings are advisory and
never block saving content.

Consequential runtime permissions live in `/opt/data/permissions.yaml` and
control destructive actions (`delete_records`, `overwrite_records`), external
side effects (`send_messages`, `modify_external_calendar`, `purchases`,
`financial_transactions`), and scheduled work (`scheduled_work`).

## Minimal Core Directories

Every workspace starts with a clean, unopinionated foundation:

- `inbox/`: universal intake point for uncategorized captures waiting for review.
- `inbox/ingestion/`: durable ingestion intake records that survive runtime queue
  cleanup (`inbox/ingestion/ingestion-template.md`).
- `knowledge/`: free-form Obsidian-style PKM vault for notes, project pages, and
  linked knowledge.
- `minions/<slug>/` (optional): autonomous programmable workspace apps with
  `README.md`, `dashboard.openui` (main dashboard), `input.openui` +
  `input.schema.json` + `input.py` or `input.ts` (structured input form &
  validation), `main.py` or `main.ts` (data management & enrichment triggered
  both on cron heartbeats and right after every new entry), `requirements.txt`
  or `package.json`, scripts and tests, and freely structured `data/` files
  (with nested subfolders supported) that OpenLia programs with the user as
  Project Owner.
- `sources/`: retained originals, source records, immutable extraction artifacts,
  and evidence manifests created by durable ingestion (`sources/records/source-template.md`).

## Templates Catalog: Profiles, Features, and Skills

Optional profiles, domain features, inline views, and skills live in the
community templates repository (`https://github.com/openlia/templates.git`) and
can be synced, installed, imported, or packaged on demand via `openlia features`
/ `openlia skills` or the Workspace UI:

- **Profiles** (e.g. `personal-os`): curated bundles of agent instructions,
  features, and skills.
- **Features** (e.g. `tasks`, `goals`, `calendar`, `daily-briefing`,
  `personal-finance`, `personal-health`, `decision-analysis`, `deep-research`,
  `travel`, `shopping`, `areas`, `ideas`, `monitors`, `people`): self-contained
  packages with `feature.yaml`, `workspace/` templates/schemas/OpenUI views,
  `skills/`, and on-demand `/opt/data/.local` tool/Python/Bun dependencies.
- **Standalone Skills** (e.g. `document-intelligence`,
  `workspace-organize`, `workspace-git`, `weekly-review`).

Users can also package custom workspace domains and skills into a portable
`.zip` feature archive with `openlia features package` and import shared
features with `openlia features import`.

## Starter template format

Starter files use YAML frontmatter for structured record metadata. Every
frontmatter template declares its JSON Schema in `$schema`, as a local relative
path from that template (for example, `inbox/ingestion/ingestion-template.md`
uses `$schema: ./ingestion-template.schema.json`). The referenced schema must
remain inside the workspace root. That schema applies only to non-template
Markdown files directly in the same directory, never subdirectories. Without a
local template, Markdown is free-form. A plain Markdown template makes
frontmatter optional but requires its section headings. A record's explicit
local `$schema` is honored when there is no local template. Only one
`*-template.md` is allowed per folder; invalid contracts are errors, not
permission to silently skip validation.

Validate on demand with the protected `workspace-template-customization` system
skill, or run this in Hermes:

```sh
/opt/hermes/.venv/bin/python /opt/data/skills/workspace-template-customization/scripts/validate_workspace.py \
  --workspace-root /opt/data/workspace \
  --skill-templates-root /opt/data/skills
```

## Inline OpenUI

Add fenced `openui` blocks to Markdown documents for interactive tables, cards,
charts, Calendar, or Finance views. Workspace UI renders them inline in Documents
(and renders standalone `dashboard.openui` and `input.openui` views for Minions under `minions/<slug>/`).
Public snapshots render literal views without granting access to live private
workspace data or mutations.

This template contains no personal records. Keep credentials, tokens, private
exports, session logs, and service caches outside the tracked template.
