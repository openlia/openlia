---
name: openui-authoring
description: Author and validate inline OpenUI views (CalendarMonth, CalendarWeek, CalendarGantt, ChartBar, ChartLine, ChartPie, ChartSankey, Table, Card, Stack, Tabs) inside Markdown files using inline data, Remind (.rem) files, or external JSON (.json) files.
version: 0.2.0
---

# Inline OpenUI Authoring in Markdown

Workspace UI renders fenced ` ```openui ` blocks inside Markdown documents (`.md`) as interactive views. Both bare top-level component calls (such as `CalendarMonth(...)` or `ChartBar(...)`) and `root = ...` programs with schema-named arguments are supported.

## Core Components

### 1. Calendar Components

All Calendar views can be used **standalone** at the top level of an ` ```openui ` block or grouped inside `Calendar(children: [...], ...)`:

- **`CalendarMonth(title?, timezone?, date?, events?, source?)`**
  - Month grid view with navigation (`←`, `Today`, `→`), display timezone selector, and appointment details modal.
- **`CalendarWeek(title?, timezone?, date?, events?, source?)`**
  - 7-day 24-hour time grid with overlap layout and sticky all-day lane.
- **`CalendarGantt(title?, timezone?, date?, zoom?, groupBy?, items?, events?, source?)`** _(alias: **`GanttChart`**)_
  - Duration timeline with `zoom: "day" | "week" | "month"` and `groupBy: "none" | "source" | "location" | "group"`.
- **`Calendar(children, timezone?, date?, events?, source?)`**
  - Shared wrapper when combining multiple views (`CalendarMonth`, `CalendarWeek`, `CalendarGantt`) over the same data source.

#### Calendar Data Sources (pick one per component)

1. **Inline events (`events` or `items`)**:
   - Timed events require ISO 8601 timestamps with UTC offset (`"2026-11-03T09:00:00+07:00"`).
   - All-day events (`allDay: true`) require `YYYY-MM-DD` dates with exclusive `end`.
2. **External Remind file (`source: "./reminders.rem"`)**:
   - Evaluated by the server's pinned upstream `remind` CLI (supports recurrence, `THROUGH`, `DURATION`, `INFO` headers, and safe local `INCLUDE`s).
3. **External JSON file (`source: "./events.json"`)**:
   - JSON array of event/timeline objects or `{ "timezone"?: "...", "date"?: "...", "events": [...] }`.

---

### 2. Chart Components

All Chart views include an accessible header, unit badge, deterministic colors, and a collapsible **Exact data table**:

- **`ChartBar(title?, unit?, caption?, labels?, series?, values?, variant?, colors?, colorDomain?, source?)`**
  - Grouped (`variant: "grouped"`) or stacked (`variant: "stacked"`) bar chart. Accepts multi-series `series: [{ category, values }]`, single-series `values: [...]`, or `source: "./data.json"`.
- **`ChartLine(title?, unit?, caption?, labels?, series?, values?, variant?, colors?, colorDomain?, source?)`**
  - Line chart (`variant: "linear" | "natural" | "step"`). Accepts `labels` + `series`/`values` or `source: "./data.json"`.
- **`ChartPie(title?, unit?, caption?, labels?, values?, slices?, variant?, colors?, colorDomain?, source?)`**
  - Donut (`variant: "donut"`, default) or pie (`variant: "pie"`) chart. Accepts `labels` + `values`, `slices: [{ label, value }]`, or `source: "./data.json"`.
- **`ChartSankey(title?, unit?, caption?, height?, nodes?, links?, source?)`** _(alias: **`SankeyDiagram`**)_
  - Directed, non-negative Sankey diagram (`nodes: [{ id, label }]`, `links: [{ source, target, value }]`) or `source: "./flows.json"`.

#### External Chart JSON Formats

- **Bar / Line JSON**:
  - Object: `{ "title"?: "...", "unit"?: "USD", "labels": ["Jan", "Feb"], "series": [{ "category": "Income", "values": [6200, 6400] }] }`
  - Row array: `[ { "month": "Jan", "Income": 6200, "Expenses": 4100 }, { "month": "Feb", "Income": 6400, "Expenses": 4350 } ]`
- **Pie JSON**:
  - `{ "labels": ["Rent", "Food"], "values": [1200, 450] }`, `{ "slices": [{ "label": "Rent", "value": 1200 }] }`, or `[ { "label": "Rent", "value": 1200 } ]`
- **Sankey JSON**:
  - `{ "nodes": [{ "id": "income", "label": "Income" }, { "id": "savings", "label": "Savings" }], "links": [{ "source": "income", "target": "savings", "value": 1500 }] }`

---

### 3. Standard Layout & Data Components

- **`Table`**: Supports row-oriented literal shorthand:

  ```openui
  Table(
    title: "Weekly Menu",
    columns: [{ key: "day", label: "Day" }, { key: "dish", label: "Dish" }],
    rows: [{ day: "Monday", dish: "Phở bò" }, { day: "Tuesday", dish: "Bún chả" }]
  )
  ```

- **Layout & Content**: `Stack`, `Card`, `CardHeader`, `Tabs`, `TabItem`, `TextContent`, `Callout`, `Badge`, `Separator`, `Accordion`, `Steps`.

---

## Discovery & Validation CLI (`openlia-openui`)

Before finishing a Markdown file that uses ` ```openui ` blocks, validate it with `openlia-openui`:

1. **List all available components and recipes**:

   ```bash
   openlia-openui describe
   ```

2. **Inspect a specific component's schema and prop order**:

   ```bash
   openlia-openui describe CalendarMonth
   openlia-openui describe ChartBar
   ```

3. **Validate a Markdown file**:

   ```bash
   openlia-openui validate --file /opt/data/workspace/reports/monthly-review.md
   ```

   Require `"valid": true` and zero diagnostics before reporting completion.

See [references/examples.md](references/examples.md) for complete copy-ready examples.
