---
name: inline-openui-authoring
description: Present data in workspace reports, reviews, comparisons, and documents with inline OpenUI when useful, without requiring an explicit UI request. Choose tables, charts, cards, or tabs; discover exact component APIs, validate drafts, and repair views.
version: 0.2.0
system: true
forkable: false
protected: true
---

# Inline OpenUI Authoring

Use this skill for reports, reviews, comparisons, and data-rich workspace
documents when a view would improve understanding, even without an explicit UI
request, and whenever creating, editing, or repairing fenced `openui` views.
OpenUI is a first-class presentation option, not a requirement for every document.
Plain Markdown is preferable when a view adds no value; honor requests for
plain-text or static output. Do not create manifests, standalone `.openui` entry
files, React/JSX, or executable JavaScript.

## Choose a useful presentation

- Trends over time: a line chart; comparisons across categories: a bar chart.
  Use a table when exact values or mixed fields matter more than a visual trend.
- Structured results, options, or comparisons: a table with concise columns.
  A small Markdown table is enough when an OpenUI table adds no value.
- Related perspectives: tabs; grouped summaries: cards. Keep the main conclusion
  outside tabs so readers do not have to interact to find it. Do not turn a
  simple report into a dashboard merely to use more components.
- Simple notes, prose, short lists, and sparse or unsuitable data: plain Markdown.
  No OpenUI block or OpenUI validation is needed for a prose-only document.

Keep conclusions, caveats, and source links in ordinary Markdown outside views.
Label reporting periods, snapshot dates, and units. Preserve provenance with
canonical source/workspace links or document-relative paths; keep generated
reports separate from source records. Distinguish missing data from zero, and
never invent values to fill a component. Literal chart/table data is a snapshot,
not a live binding; do not promise automatic refresh or embed fetch code.
Only use Calendar/Finance when the relevant workspace data and capabilities exist.

See [the sample report](references/report-example.md) for narrative, a trend
chart, and an exact-value table in one document. Its data is explicitly fictional;
replace it with inspected source data, never reuse it as a real report.

## Authoring workflow

1. Read the target document, relevant existing data, and folder-local template
   and schema when present. Preserve narrative, unrelated content, and record
   contracts. A presentation edit does not authorize weakening validation.
2. Call `openui_describe()` to discover components, then request each unfamiliar
   component by exact name. Use its runtime schema and tested recipes, not
   remembered APIs from other UI libraries. Referenced types such as `TabItem`
   or `Series` can also be described. `Table` has a special literal row shorthand.
3. Compose small, self-contained blocks. Prefer **all named arguments** and bare
   component roots. Do not mix named and positional arguments within a call.
   Keep ordinary narrative outside the fence. Blocks cannot share variables.
4. Call `openui_validate(content: <draft>, format: "markdown")` on the complete
   final Markdown, not just a simplified example. For quick isolated checks use
   `format: "openui"`. Require `status: "ok"`, `validationLevel: "schema"`,
   `valid: true`, and `blockCount` matching the expected number of views. Zero
   blocks returns `valid: null` and means no view was validated.
5. Repair diagnostics using the exact component schema, then validate again.
   Make at most three repair passes. If still failing, disclose the remaining
   issue; never silently delete a view or substitute fabricated data.
6. Save requested edits using targeted patches and link the containing document
   with `openlia://workspace/<path>`. Validation is read-only and does not save.
   Any change to OpenUI after validation requires another check.

Do not ask the user to design schemas or component arguments. Folders and views
need no registry or structural approval merely to be created. Existing user
approval boundaries still apply to consequential actions.

## Reliable defaults and common mistakes

- Use `Card(children: [...])`, `CardHeader(title: "...")`, and
  `TextContent(text: "...")`. Do not invent `Card(title: ...)` or `TextContent(content: ...)`.
- Layout: `Stack(children: [...], direction: "row", gap: "m", wrap: true)`.
  Gap tokens are not arbitrary CSS values. Look up accepted enums.
- Tabs use `Tabs(items: [TabItem(value: "summary", trigger: "Summary",
  content: [TextContent(text: "Overview")])])`, **not** `Tabs(children: ...)`.
- Prefer `ChartPanel` for simple bar, line, and pie charts. Bar/line charts use
  `labels` and `series: [{category: "Name", values: [...]}]`; pie charts use
  `labels` and `values`. Keep data lengths aligned. Obtain tested recipes with
  `openui_describe(component: "ChartPanel")`.
- Row tables require literal columns `{key, label}` and literal object rows.
  Cells are strings, numbers, booleans, or null, not nested objects or components.
  See the syntax reference below for a complete Markdown example.
- Quote and escape strings correctly, especially multiline text, quotes, and
  backslashes. Do not embed fetch calls, JavaScript maps, or invented query tools.
- Reuse upstream components only when present in `openui_describe`. Removed
  record widgets, `Grid`, `MetricCard`, and manifest-backed aggregation do not work.

## Validation boundaries

`openui_validate` uses the same normalizer and component schemas as Workspace UI,
offline, without running document code. Success means **schema-valid**, not
visually verified. Browser preview is needed to verify rendering, layout, and
interactions. Never claim to have previewed a view without doing so.

If authoring tools are unavailable, report that schema validation was unavailable.
The workspace Python checker is syntax-only; it cannot certify components or
properties. Saving remains separate from validity; OpenUI findings are advisory
and never invalidate record contracts.

Calendar views and Finance views require their respective parent containers.
Source-backed Calendar and Finance require authenticated workspace capabilities.
For self-contained, read-only calendars, use `Calendar(events: [...], children:
[CalendarMonth(), CalendarWeek(), GanttChart()])` without `source`. Inline events
require unique `id`, `title`, `start`, and `end`; timed intervals need explicit ISO
offsets, all-day intervals use `allDay: true` with date-only exclusive ends. An
empty `events: []` stays inline; omitting both `events` and `source` loads the
default Remind file. Inline calendars do not load/save through the calendar API
or need private capabilities. Discover the full event schema and examples with
`openui_describe(component: "Calendar")`, then validate the complete Markdown.
Relative source/journal paths resolve from the containing
Markdown folder. Public snapshots can render literal views but do not inherit
private reads, mutations, navigation, or chat. An unavailable-data state is not a
syntax failure. Chat actions prepare a draft for user review, never send it.

For the shared syntax and security rules, read
`../workspace-template-customization/references/openui-spec.md`.
