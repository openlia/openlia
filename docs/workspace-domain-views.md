# Inline OpenUI workspace views

Interactive views live in ordinary Markdown documents, rendered in **Documents**
at `/files/<path>`. Combine narrative and one or more fenced `openui` blocks:

````markdown
# Thực đơn ngày 29/10/2026

```openui
Table(title: "Thực đơn", columns: [{key: "dish", label: "Món ăn"}], rows: [{dish: "Phở bò"}])
```
````

Bare component roots, schema-named arguments, and literal row tables are
normalized by a shared browser/server syntax layer. Upstream positional syntax
and column tables remain supported. Calendar, Finance, ChartPanel, and
SankeyDiagram are available alongside upstream components. Relative data paths
resolve from the Markdown document's parent directory.

### Configurable and responsive tables

Row tables retain their default pagination of 10 rows. Set `pageSize` to choose a
different page size, `pagination: {enabled: false}` to show every row, or
`showAllOption: true` to let readers switch between paged and full views. Wide
tables retain horizontal scrolling; `wrapText` keeps long cell values from
forcing a very wide table, and `expandLongText` adds controls for long text.
Absolute HTTP(S) URLs render as concise external links; other strings remain text.

```openui
Table(
  title: "Weekly meals",
  columns: [
    {key: "day", label: "Day"},
    {key: "meal", label: "Meal"},
    {key: "ingredients", label: "Ingredients"},
    {key: "instructions", label: "Cooking method"},
    {key: "recipe", label: "Recipe"}
  ],
  rows: [
    {day: "Monday", meal: "Lunch", ingredients: "Rice noodles, herbs, and slow-cooked beef", instructions: "Prepare the broth in advance, then cook the noodles just before serving.", recipe: "https://youtu.be/example"},
    {day: "Monday", meal: "Dinner", ingredients: "Chicken, rice, seasonal vegetables, and aromatics", instructions: "Roast the chicken until cooked through; serve with rice and vegetables.", recipe: "https://www.youtube.com/watch?v=example"}
  ],
  pagination: {enabled: false},
  layout: {horizontalScroll: true, wrapText: true, expandLongText: true}
)
```

For a 14-meal week, the same table can use `pageSize: 14` instead of disabling
pagination. Row spans and column spans are not supported; repeat group values in
each row to keep the table data and layout straightforward.

Each block is isolated. Syntax errors show diagnostics and raw source; runtime
errors preserve source and do not break the rest of the document. Inline
diagnostics are advisory and separate from template/schema validity.

## Reliable agent authoring

OpenUI is a first-class presentation option for reports, reviews, comparisons,
and data-rich documents. Lia should proactively consider a useful view without
requiring you to ask for OpenUI: charts for trends, tables for structured results,
and tabs/cards for related perspectives. Simple notes and narrative documents
remain plain Markdown when a view adds no value. You can also request plain-text
or static output explicitly.

Reports should retain conclusions, caveats, and source links in ordinary
Markdown outside views, with clear reporting periods, snapshot dates, and units.
Missing values are not zero, and literal data does not refresh automatically.
Generated reports stay separate from their source records. See the
[illustrative report](../profile/system-skills/inline-openui-authoring/references/report-example.md)
for narrative, a chart, and an exact-value table in one document; its counts are
explicitly fictional, not data to reuse in real reports.

The protected `inline-openui-authoring` skill guides agents to discover exact
component APIs with `openui_describe` and check the final Markdown draft with
`openui_validate`. Both tools are read-only and offline, using a bundled copy of
the same TypeScript normalizer and component schemas as the preview. They do not
need a running Workspace UI service. Describe calls return current schemas,
argument order, and tested recipes; validation returns per-block locations and
structured repair diagnostics. No document code is executed.

Validation success means schema-valid, not visually verified or connected to
live data. Zero extracted blocks means no views were checked. The Python workspace
checker remains syntax-only. If the bundled tool is unavailable, agents must
report that limitation rather than claim schema validation succeeded.

For local diagnostics, build with `bun run --cwd packages/workspace-ui bundle:openui`
and send a JSON request on stdin to
`bun packages/workspace-ui/dist/openui-authoring.js`:

```json
{"action":"validate","format":"openui","content":"CardHeader(title: \"Hello\")"}
```

Use `{"action":"describe","component":"ChartPanel"}` for a component reference,
or `format: "markdown"` to validate every OpenUI fence in a complete draft.

Public snapshots render self-contained literal views without authenticated
workspace reads, writes, or chat capabilities. Data-backed components display
an unavailable state; snapshots do not fetch live private data.

See the [syntax reference](../profile/system-skills/workspace-template-customization/references/openui-spec.md),
[Calendar](calendar-ui.md), and [Finance](finance-ui.md).

