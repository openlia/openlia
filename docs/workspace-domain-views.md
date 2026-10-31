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

- `README.md`: project overview, usage instructions, `triggers` (`after_entry: true`, `heartbeat_schedule`), and optional `quick_actions` frontmatter.
- `dashboard.openui`: the main OpenUI dashboard view rendered in the Minions tab (with fallback support for legacy `ui.openui`).
- `input.openui`: the OpenUI input form (`Form(name: "minionInput", ...)`).
- `input.schema.json`: JSON Schema contract validating input form submissions.
- `input.py` or `input.ts`: input handler executed to validate and record new entries into `data/`.
- `config.schema.json` & `config.json`: `config.json` holds the required OpenLia/Hermes `trigger` (`on_new_entry` and/or `cron`) plus any Minion-specific settings designed by the agent (validated by `config.schema.json`; when packaged for sharing, `config.json` is ignored and only `config.schema.json` is packaged).
- `main.py` or `main.ts`: data management and enrichment entrypoint triggered in **two ways**:
  1. **Heartbeat trigger (`--trigger heartbeat`)** at a cron job or manual run to enrich data (e.g., fetching news, retrieving latest stock prices, computing summaries) and update `dashboard.openui`.
  2. **Post-entry trigger (`--trigger entry`)** right after every new entry recorded by `input.py` / `input.ts` to analyze the new entry alongside existing context (e.g., recommending the next exercise given today's recorded performance) and update `dashboard.openui`.
- `requirements.txt` or `package.json`: Python or TypeScript/Bun dependencies.
- `scripts/` and `tests/`: helper scripts and automated tests.
- `data/`: freely structured data and document files (`.json`, `.yaml`/`.yml`, `.csv`, `.hledger`/`.journal`, `.rem`/`.remind`, `.md`), including nested subfolders.
