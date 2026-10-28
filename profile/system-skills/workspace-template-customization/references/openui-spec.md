# OpenUI Lang (`openui-lang`) & Mini-Project Specification for OpenLia

This document is the reference specification for **Mini-Projects** (`project-manifest.toml` + `ui.openui`) in OpenLia workspaces.

---

## 1. Mini-Project Contract (`project-manifest.toml`)

A folder becomes a Mini-Project only when it contains a valid `project-manifest.toml` and its referenced `ui.openui` entry file.

```toml
[project]
id = "tasks"
title = "Tasks"
description = "Actionable execution items with status, priority, due dates, and effort."
icon = "check-square"
version = 1

[data]
records_glob = "*.md"
template = "task-template.md"
schema = "task-template.schema.json"
primary_status_field = "status"
default_sort = "due_date:asc"

[data.queries.active_count]
op = "count"
where = { status = ["todo", "in-progress", "blocked"] }

[data.queries.by_status]
op = "group_count"
field = "status"

[ui]
entry = "ui.openui"

[logic]
skills = ["inbox-triage", "weekly-review"]

[logic.mutations]
status_field = "status"
editable_fields = ["status", "priority", "due_date"]

[[logic.prompts]]
id = "triage"
label = "Prioritize tasks"
prompt = "Review my tasks in tasks/ and suggest the top 3 priorities for today."
```

### Server-Evaluated Query Operations (`[data.queries.<name>]`)
- `op = "count"` — Counts records matching optional `where = { field = "val" | ["v1", "v2"] }`.
- `op = "sum"` — Sums numeric `field` across records matching optional `where`.
- `op = "group_count"` — Returns `[{ label, count }]` grouped by `field` across records matching optional `where`.
- `op = "records"` — Returns matching record summaries filtered by `where` and capped by optional `limit`.

---

## 2. Syntax & Core Execution Model (`ui.openui`)

1. **Statement-based**: Each statement defines an identifier:
   ```openui
   identifier = Expression
   ```
2. **Entry point**: Every program must define `root`:
   ```openui
   root = Stack([header, kpis, board], "column", "l")
   ```
3. **Expressions**: strings (`"..."`), numbers, booleans (`true`/`false`), `null`, arrays (`[...]`), objects (`{...}`), component calls `TypeName(arg1, arg2, ...)`, or function calls `@FunctionName(arg1, arg2)`.
4. **Positional Arguments**: Component and function parameters in OpenUI Lang are positional, ordered by the component's property definitions.
5. **Hoisting**: References can be used before they are defined. Always define `root = Stack(...)` first.

---

## 3. Component Catalog

### Layout & Containers
- **`Stack(children: any[], direction?: "row" | "column", gap?: "none" | "xs" | "s" | "m" | "l" | "xl" | "2xl", align?: "start" | "center" | "end" | "stretch" | "baseline", justify?: "start" | "center" | "end" | "between" | "around" | "evenly", wrap?: boolean)`**
- **`Tabs(items: TabItem[])`**
- **`TabItem(value: string, trigger: string, content: any[])`**
- **`Accordion(items: AccordionItem[])`**
- **`AccordionItem(value: string, trigger: string, content: any[])`**
- **`Separator(orientation?: "horizontal" | "vertical")`**

### OpenLia Project Components
- **`DomainHeader(title: string, description?: string, recordCount?: number)`**
  Project overview hero header with title, description, and total record count badge.
- **`MetricCard(label: string, value: string | number, subtext?: string, tone?: "neutral" | "primary" | "success" | "warning" | "error")`**
  Single KPI metric card displaying a headline number and semantic tone.
- **`RecordKanban(groupBy?: string, columns?: string[], title?: string)`**
  Interactive Kanban board grouping project records by any frontmatter enum field (default: `"status"`). Supports click-to-open and quick status transitions.
- **`RecordTable(filterStatus?: string, filterPriority?: string, limit?: number, title?: string, columns?: string[])`**
  Tabular list of project records with custom frontmatter columns, status/priority badges, tags, and clickable links to open records in Documents view.
- **`FinanceOverview(journalPath?: string, title?: string)`**
  Interactive hledger journal summary and authoritative `hledger check` runner for finance projects.
- **`TravelOverview(title?: string)`**
  Specialized trip readiness, alerts, and itinerary summary view.
- **`ShoppingComparison(title?: string)`**
  Product research comparison view with budget vs target vs actual price metrics.
- **`MonitorStatusBoard(title?: string)`**
  Standing monitor watch status and staleness board.
- **`PeopleDirectory(title?: string)`**
  Relationship cadence and open-loop directory view.
- **`DecisionOverview(title?: string)`**
  Decision analysis summary with options and recommendation badges.

### General UI & Chart Components
#### Calendar and event-duration timelines

- **`Calendar(children: any[], source?: string, timezone?: string)`**
  Loads native Remind occurrences for its child views and provides a shared
  selected date, display timezone, appointment details, and **New appointment**
  editor. `source` defaults to project-relative `reminders.rem`; `timezone`
  defaults to the server's configured calendar timezone. This is not a Markdown
  record collection: Remind remains the source of truth.
- **`CalendarMonth(title?: string)`** — Monday-first month grid, all-day spans,
  overflow disclosure, and event selection. Must be inside `Calendar`.
- **`CalendarWeek(title?: string)`** — Week time grid with overlap layout and an
  all-day lane. Must be inside `Calendar`.
- **`GanttChart(title?: string, items?: TimelineItem[], zoom?: "day" | "week" | "month", groupBy?: "none" | "source" | "location")`**
  Event-duration timeline, not project dependency planning. Inside `Calendar`,
  omitted `items` uses calendar occurrences and shared event selection. Standalone
  usage accepts `{id, title, start, end, group?}` items; dates are ISO date-only
  or offset-bearing timestamps. No dependencies, progress tracking, or drag edits.

```openui
root = Calendar([Tabs([
  TabItem("month", "Month", [CalendarMonth()]),
  TabItem("week", "Week", [CalendarWeek()]),
  TabItem("timeline", "Timeline", [GanttChart()])
])])
```

All-day ranges have exclusive end dates. Timed appointments store instants plus
their IANA timezone. Drafts are unsaved until confirmation; notification and
invitation delivery are unavailable and visibly off. New appointments use
`NOQUEUE`; existing source-defined notification behavior is not changed. The UI
supports one-off creation, not recurring-event editing or drag-to-reschedule.
Native evaluation accepts only bounded, literal calendar-local `.rem` includes;
dynamic/system/command includes are rejected rather than silently omitted.

- **`Card(children: any[], variant?: "card" | "sunk" | "clear")`**
- **`CardHeader(title: string, subtitle?: string)`**
- **`TextContent(text: string)`**
- **`MarkDownRenderer(content: string)`**
- **`Callout(title: string, body: string, variant?: "info" | "success" | "warning" | "error")`**
- **`BarChart(data: any[], xKey: string, series: Series[])`**
- **`PieChart(data: any[], nameKey: string, dataKey: string)`**
- **`LineChart(data: any[], xKey: string, series: Series[])`**

---

## 4. Functions & Actions

### Functions
- **`@Query(name: string)`** — Returns the pre-computed result of `[data.queries.<name>]` from `project-manifest.toml`.
- **`@CountBy(field: string, value: any)`** — Returns count of project records matching `field == value`.
- **`@GroupCount(field: string)`** — Returns `{ label, count }[]` grouped by frontmatter field.
- **`@FilterRecords(field: string, value: any)`** — Returns array of matching project records.
- **`@SumBy(field: string)`** — Returns numeric sum of `field` across project records.

### Actions
- **`@OpenRecord(path: string)`** — Navigates to a record inside the Documents view (`/files/<path>`).
- **`@CreateDomainRecord(domain: string)`** — Opens `CreateFileDialog` pre-populated for the project folder.
- **`@UpdateFrontmatter(path: string, field: string, value: any)`** — Updates a record frontmatter key.
- **`@RunSkillPrompt(prompt: string)`** — Hands off a prompt to the Chat view with OpenLia.

---

## 5. Contract Safety & Modification Rules

When updating or customizing a Mini-Project UI:
1. **Pure UI & Query Changes (`project-manifest.toml` + `ui.openui`)**:
   - Modifying layout, adding `[data.queries]`, changing charts, reordering cards, or grouping by a different field NEVER invalidates `*.md` records on disk.
   - Referenced frontmatter properties must exist in `*.schema.json`.
   - Referenced `@Query("<name>")` calls must exist under `[data.queries]` in `project-manifest.toml`.
2. **Adding New Frontmatter Fields**:
   - In `*.schema.json`, new fields SHOULD be optional/nullable (i.e. `type: ["string", "null"]` and NOT added to `required`) so existing records remain completely valid without requiring migrations.
3. **Adding New Required Fields or Headings**:
   - If a new `## Heading` is added to `*-template.md` or a new field is added to `schema.required`, existing records drift.
   - Propose an approved Git-backed migration batch or prompt the user to use the **"Fix All in Migrations"** banner in Workspace UI.
