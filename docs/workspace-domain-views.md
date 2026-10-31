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

## Workspace Minions (`minions/<slug>/`)

In addition to inline `openui` blocks inside Markdown documents, OpenLia supports
**Minions** (`minions/<slug>/`) — autonomous programmable workspace apps rendered
in the **Minions** tab (`/minions/<slug>` or `openlia://minions/<slug>`) that
OpenLia develops and maintains with the user as **Project Owner**:

- `README.md`: project overview, usage instructions, and optional `quick_actions` frontmatter.
- `main.py` or `main.ts`: entrypoint executed by the Minion service or Hermes CLI.
- `requirements.txt` or `package.json`: Python or TypeScript/Bun dependencies.
- `scripts/` and `tests/`: helper scripts and automated tests.
- `ui.openui` (or `*.openui`): standalone OpenUI dashboard view rendered in the Minions tab.
- `data/`: freely structured data and document files (`.json`, `.yaml`/`.yml`, `.csv`, `.hledger`/`.journal`, `.rem`/`.remind`, `.md`), including nested subfolders.
