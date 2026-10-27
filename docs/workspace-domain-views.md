# Workspace Mini-Projects (`project-manifest.toml` + `ui.openui`)

[← Back to Documentation Index](README.md) · [End User Guide](user-guide.md) · [Skill & Feature Development](skill-and-feature-development.md)

Any workspace folder—whether created by you, designed by Lia, or installed from [`openlia/templates`](https://github.com/openlia/templates.git) (`tasks`, `goals`, `finance`, `travel`, `shopping`, `monitors`, `decisions`, `people`)—can include a `project-manifest.toml` and `ui.openui` file to power a dedicated **Projects** view (`/projects/<path>`).

Existing Markdown records remain valid: visual frontmatter properties are optional, and the **Documents** view (`/files/<path>`) remains a fast, clean Markdown preview and editor without OpenUI overhead.

---

## 1. How Mini-Projects Work

A Mini-Project is defined by two files in a workspace directory:

1. **`project-manifest.toml`**: Declares project metadata (`[project]`), record matching and queries (`[data]`), UI entrypoint (`[ui]`), and optional interactive mutations/prompts (`[logic]`).
2. **`ui.openui`**: Declares the dashboard layout using OpenUI components (`Stack`, `Grid`, `DomainHeader`, `MetricCard`, `RecordKanban`, `RecordTable`, charts, and tables) bound to manifest queries (`@Query("...")`).

### Example `project-manifest.toml`

```toml
version = 1

[project]
id = "tasks"
name = "Tasks"
description = "Actionable work items and status tracking"

[data]
records_glob = "*.md"
exclude = ["README.md", "task-template.md"]
template = "task-template.md"
schema = "task-template.schema.json"
status_field = "status"

[data.queries.open_count]
type = "count"
field = "status"
value = "todo"

[ui]
entry = "ui.openui"

[logic.mutations]
editable_fields = ["status", "priority", "due_date"]
```

### Example `ui.openui`

```openui
root = Stack([header, metrics, kanban, table])
header = DomainHeader("Tasks", "Track active work items")
metrics = Grid([MetricCard("Open Tasks", @Query("open_count"))], 3)
kanban = RecordKanban("status")
table = RecordTable(["title", "status", "priority", "due_date"])
```

---

## 2. Optional Visual Metadata in `openlia/templates`

When using domain features from [`openlia/templates`](https://github.com/openlia/templates.git), the following optional frontmatter fields enrich Mini-Project views without invalidating older records:

| Domain | Optional Fields |
| --- | --- |
| **Travel** | `alerts: ["Passport expires soon"]` |
| **Shopping** | Numeric `budget`, `target_price`, `actual_price`; `currency`; `vendor_url` |
| **Monitors** | `last_checked` as an ISO 8601 timestamp with timezone |
| **People** | `last_contacted` as `YYYY-MM-DD`; `linked_records` as workspace-relative paths |
| **Finance** | `journal_path` as a workspace-relative path to an `.hledger` / `.journal` file |

Missing monitor check times and contact dates display as unknown rather than healthy/recent. Active monitors become stale after their configured interval; triggered monitors display as alerting.

---

## 3. Structured Markdown Conventions

Within a record's H2 sections (`## ...`), use ordinary Markdown lists, checklists (`- [ ]`), or GFM tables. Visual edits in the Projects view use the revision-aware workspace file API:
- Save failures remain visible so drafts can be retried.
- YAML frontmatter edits preserve comments and unrelated Markdown body content.
- Checklist mutations (`[logic.mutations].checklist_sections`) ignore fenced code examples.

### Examples from `openlia/templates`

Under `## Itinerary Outline` (`travel`):

```markdown
| Date | Time | Activity | Location |
| --- | --- | --- | --- |
| 2026-11-01 | 09:00 | Flight | SFO |
```

Under `## Candidate Options` (`shopping`):

```markdown
| Option | Price | Vendor | Pros | Cons |
| --- | --- | --- | --- | --- |
| Model A | 120 USD | [Vendor](https://example.com/a) | Light | Limited ports |
```

Under `## Options Considered` and `## Criteria And Weights` (`decision-analysis`), use GFM tables for option trade-offs and weighted criteria comparisons.
