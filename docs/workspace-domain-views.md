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

Public snapshots render self-contained literal views without authenticated
workspace reads, writes, or chat capabilities. Data-backed components display
an unavailable state; snapshots do not fetch live private data.

## Hard break from Mini-Projects

The Projects tab, `/projects` routes, project API endpoints, manifest-backed
record aggregation, and legacy record widgets are removed. `project-manifest.toml`
and standalone `.openui` files are no longer interpreted as presentation
contracts. Existing files are not automatically removed or migrated.

Move supported expressions into a Markdown `openui` fence, replace old query and
record bindings with explicit data, and link the containing document via
`openlia://workspace/<path>`. Record templates and schemas remain folder-local
and independent of presentation.

See the [syntax reference](../profile/system-skills/workspace-template-customization/references/openui-spec.md),
[Calendar](calendar-ui.md), and [Finance](finance-ui.md).
