# Inline OpenUI in Markdown

Write rich views in fenced `openui` blocks inside ordinary Markdown. The same
document contains narrative, literal data, and interactive components. Workspace
Documents and public snapshots render these blocks inline.

````markdown
# Thực đơn ngày 29/10/2026

Thực đơn hôm nay:

```openui
Table(
  title: "Thực đơn",
  columns: [{key: "meal", label: "Bữa ăn"}, {key: "dish", label: "Món ăn"}],
  rows: [{meal: "Bữa sáng", dish: "Phở bò"}, {meal: "Bữa trưa", dish: "Cơm gà"}]
)
```
````

## Syntax

- A bare component expression becomes `root = <expression>`. Existing assignment
  programs with a root continue to work.
- Arguments are positional (upstream syntax) or all named. Named arguments use
  component schema property names; unknown/duplicate names and mixed modes fail.
- Row `Table(columns, rows, title?)` and named `Table(title: ..., columns: ...,
  rows: ...)` accept literal column definitions `{key, label}` and object rows.
  They become upstream `Table([Col(label, data), ...])`; a title adds a Card header.
  Missing/null cells are empty; string, number, and boolean cells are supported.
- Upstream column tables, such as `Table([Col("Dish", ["Phở"])])`, are unchanged.
- Nested components, escaped strings, and line comments are supported. Do not
  embed executable JavaScript, network requests, or computed expressions in row
  table literals. Use ordinary assignment programs for upstream expressions.

## Components and scope

Use upstream Card, CardHeader, Stack, Tabs, Table, and chart components, plus:

- `ChartPanel`, `SankeyDiagram`
- `Calendar([CalendarMonth(), CalendarWeek(), GanttChart()], source?, timezone?)`
- `Finance([FinanceOverview(), FinanceChart("spending", "bar"), FinanceAccounts()], journal?)`

Calendar/Finance data paths are relative to the containing document's folder.
Each block has its own renderer state. Workspace capabilities are supplied only
in authenticated document previews. Public snapshots render literal views but
do not inherit workspace reads, mutations, navigation, or chat capabilities;
data-backed components show an unavailable state.

Chat actions prepare a draft for review, never send automatically. No generic
query/mutation tool provider is exposed to inline documents.

## Validation and compatibility

For agent authoring, load `inline-openui-authoring`. Use `openui_describe` for
schema-derived properties/enums and tested recipes, and `openui_validate` for
read-only checks of complete Markdown drafts or isolated blocks. Fix diagnostics
and revalidate after changes. Confirm the expected block count; no fences means
no views were checked. Schema validity does not verify rendering or live data.

Browser and server use shared normalization and component schemas. Invalid
blocks show diagnostics and raw source without breaking surrounding Markdown.
Workspace validation reports advisory `openui_syntax_error` warnings with the
block's document line. Python tools perform lightweight syntax checks offline;
use `openui_validate` or Workspace UI for component/property validation, and
browser preview for actual rendering and interactions.

Link the containing document: `openlia://workspace/family-menu/menu.md`, or a
Minion dashboard (`minions/<slug>/ui.openui`): `openlia://minions/family-menu`.
