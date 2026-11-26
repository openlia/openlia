# OpenLia Agent Instructions

This deployment runs Hermes Agent with persistent state under `/opt/data` and user workspace files under `/opt/data/workspace`.

## Safe defaults

- Read and analyze relevant files before proposing or making changes.
- Keep workspace file writes under `/opt/data/workspace` unless the user explicitly asks otherwise.
- Preserve existing user files and prefer targeted, reviewable edits over whole-file replacements.
- Use canonical URIs for document links: `openlia://workspace/<path>` for workspace files and `openlia://skills/<path>` for Hermes skills. Relative Markdown links resolve within the current scope. Never embed environment-specific HTTP origins in workspace or skill files.
- Treat Hermes-managed `memories/USER.md` and `memories/MEMORY.md` as compact entry lists managed via Hermes's native memory tools.
- Never place raw API keys, passwords, or private keys into workspace documents or prompts; credentials belong in the runtime environment or secret store.
- Require explicit user confirmation before sending external messages, modifying external accounts, making purchases, or deleting user data.

<!-- BEGIN OPENLIA MANAGED OPENUI -->

## Inline OpenUI in Markdown (`openui` blocks)

Workspace UI renders fenced ` ```openui ` code blocks inside Markdown files as interactive components:

- **Calendar views**: `CalendarMonth(...)`, `CalendarWeek(...)`, `CalendarGantt(...)` (alias `GanttChart(...)`), and `Calendar(children: [...], ...)`.
  - Support inline `events: [{ id, title, start, end, allDay?, location?, agenda?, attendees?, group? }]` (or `items` on `CalendarGantt`), external Remind files (`source: "./schedule.rem"`), or external JSON files (`source: "./events.json"`).
- **Chart views**: `ChartBar(...)`, `ChartLine(...)`, `ChartPie(...)`, `ChartSankey(...)` (alias `SankeyDiagram(...)`), and `ChartPanel(...)`.
  - Support inline data (`labels` + `series`/`values`, `slices`, or `nodes` + `links`) or external JSON files (`source: "./data.json"`).
- **Layout & Table views**: `Table(title: "...", columns: [{ key, label }], rows: [{ ... }])`, `Card`, `CardHeader`, `Stack`, `Tabs`, `TabItem`, `TextContent`, `Callout`, etc.
- Bare root expressions (e.g., `CalendarMonth(...)`, `ChartBar(...)`) and named arguments (`prop: value`) are supported.
- Load the `openui-authoring` skill (`openlia://skills/openui-authoring/SKILL.md`) or run `openlia-openui describe [Component]` and `openlia-openui validate --file <path.md>` to inspect component schemas and validate Markdown drafts.

<!-- END OPENLIA MANAGED OPENUI -->
