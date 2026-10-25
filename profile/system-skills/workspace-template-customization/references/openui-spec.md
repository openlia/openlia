# OpenUI Lang (`openui-lang`) Specification for OpenLia

This document is the reference specification for **OpenUI Lang** programs (`*-dashboard.openui` and `*-record.openui`) in OpenLia workspace domains.

---

## 1. Syntax & Core Execution Model

1. **Statement-based**: Each statement defines an identifier:
   ```openui
   identifier = Expression
   ```
2. **Entry point**: Every program must define `root`:
   ```openui
   root = Stack([child1, child2])
   ```
3. **Expressions**: strings (`"..."`), numbers, booleans (`true`/`false`), `null`, arrays (`[...]`), objects (`{...}`), component calls `TypeName(arg1, arg2, ...)`, function calls `@FunctionName(arg1, arg2)`, or action steps `@ActionName(arg1)`.
4. **Positional Arguments**: Component and function parameters in OpenUI Lang are positional, ordered by the component's property definitions.
5. **Hoisting & Streaming**: References can be used before they are defined. Always define `root = Stack(...)` first so the UI frame renders immediately during streaming.

---

## 2. Component Catalog

### Layout & Containers
- **`Stack(children: any[], direction?: "row" | "column", gap?: "none" | "xs" | "s" | "m" | "l" | "xl" | "2xl", align?: "start" | "center" | "end" | "stretch" | "baseline", justify?: "start" | "center" | "end" | "between" | "around" | "evenly", wrap?: boolean)`**
- **`Tabs(items: TabItem[])`**
- **`TabItem(value: string, trigger: string, content: any[])`**
- **`Accordion(items: AccordionItem[])`**
- **`AccordionItem(value: string, trigger: string, content: any[])`**
- **`Separator(orientation?: "horizontal" | "vertical")`**
- **`Modal(title: string, open?: $binding<boolean>, children: any[], size?: "sm" | "md" | "lg")`**

### OpenLia Domain Components
- **`DomainHeader(title: string, description?: string, recordCount?: number)`**
  Domain overview hero header with title, description, record count badge, `+ New Record` button, and `Edit UI (.openui)` shortcut.
- **`MetricCard(label: string, value: string | number, subtext?: string, tone?: "neutral" | "primary" | "success" | "warning" | "error")`**
  Single KPI metric card displaying headline number and semantic tone.
- **`RecordKanban(groupBy?: string, columns?: string[], title?: string)`**
  Interactive Kanban board grouping domain records by any frontmatter enum field (default: `"status"`). Supports click-to-open and quick status transitions.
- **`RecordTable(filterStatus?: string, filterPriority?: string, limit?: number, title?: string)`**
  Tabular list of domain records with status/priority badges, tags, and clickable links to open records.
- **`RecordHeaderCard(title?: string, status?: string, priority?: string, dueDate?: string)`**
  Record-level hero card showing title, validation status, key dates, and badges.
- **`FrontmatterEditorCard(title?: string, fields?: string[])`**
  Schema-aware interactive editor for frontmatter properties. Edits are saved with revision concurrency safety.
- **`ChecklistSection(heading: string, title?: string, allowAdd?: boolean)`**
  Interactive task checklist bound to Markdown `- [ ]` / `- [x]` items under `## <heading>`. Toggling items writes updates directly to disk.
- **`MarkdownSectionCard(heading: string, title?: string)`**
  Renders the Markdown content of a specific `## <heading>` section with an inline `+ Add Section` fallback if missing.
- **`ClaimProvenanceCard(kind?: string, status?: string, confidence?: string | number, sourceRef?: string, validFrom?: string, validUntil?: string, reviewAfter?: string)`**
  Structured card for claims ledger provenance and temporal validity.
- **`DecisionMatrixCard(chosenOption?: string, recommendation?: string, options?: string[])`**
  Visual decision summary displaying recommendation, chosen option badge, and evaluated options.

### General UI Components
- **`Card(children: any[], variant?: "card" | "sunk" | "clear")`**
- **`CardHeader(title: string, subtitle?: string)`**
- **`TextContent(text: string)`**
- **`MarkDownRenderer(content: string)`**
- **`Callout(title: string, body: string, variant?: "info" | "success" | "warning" | "error")`**
- **`BarChart(data: any[], xKey: string, series: Series[])`**
- **`PieChart(data: any[], nameKey: string, dataKey: string)`**
- **`LineChart(data: any[], xKey: string, series: Series[])`**

---

## 3. Functions & Actions

### Functions
- **`@CountBy(field: string, value: any)`** — Returns count of domain records matching `field == value`.
- **`@GroupCount(field: string)`** — Returns `{ label, count }[]` grouped by frontmatter field.
- **`@FilterRecords(field: string, value: any)`** — Returns array of matching domain records.
- **`@SumBy(field: string)`** — Returns numeric sum across records.
- **`@Section(heading: string)`** — Extracts raw markdown string under `## <heading>`.
- **`@Checklist(heading: string)`** — Returns list of checklist items under `## <heading>`.

### Actions
- **`@OpenRecord(path: string)`** — Navigates to a record inside Workspace UI (`/files/<path>`).
- **`@CreateDomainRecord(domain: string)`** — Opens `CreateFileDialog` pre-populated for `domain`.
- **`@UpdateFrontmatter(path: string, field: string, value: any)`** — Updates a record frontmatter key.
- **`@ToggleChecklistItem(path: string, heading: string, lineIndex: number, checked?: boolean)`** — Toggles a markdown checklist item.

---

## 4. Contract Safety & Modification Rules

When updating or customizing a domain UI:
1. **Pure UI Changes (`.openui` only)**:
   - Modifying layout, changing charts, reordering cards, or grouping by a different field NEVER invalidates `*.md` records on disk.
   - Referenced frontmatter properties must exist in `*.schema.json`.
   - Referenced `@Section` / `@Checklist` headings must exist in `*-template.md`.
2. **Adding New Frontmatter Fields**:
   - In `*.schema.json`, new fields SHOULD be optional/nullable (i.e. `type: ["string", "null"]` and NOT added to `required`) so existing records remain completely valid without requiring migrations.
3. **Adding New Required Fields or Headings**:
   - If a new `## Heading` is added to `*-template.md` or a new field is added to `schema.required`, existing records drift.
   - Propose an approved Git-backed migration batch or prompt the user to use the **"Fix All in Migrations"** banner in Workspace UI.
