# Minion data views (development contract, schema 1)

One trusted runtime service supplies bounded, structured reads for Dashboard,
Hermes, and briefing. Do not parse generated OpenUI, execute app code, run a
heartbeat, install app dependencies, or scan `data/` as a fallback.

## Package contract

List `data.views.json` in `minion.package.json`. Both UI and Hermes scaffolds
start with `{"schema":1,"views":[]}`: no data is exposed implicitly.

```json
{
  "schema": 1,
  "views": [{
    "id": "sessions",
    "label": "Workout sessions",
    "reader": "json",
    "path": "data/items.json",
    "fields": ["item", "date", "status"],
    "title_field": "item",
    "date_field": "date",
    "max_records": 20
  }]
}
```

The authoritative validator is `src/shared/minionViews.ts`. Readers:

- `json`: one bounded JSON file containing an array of records.
- `markdown`: one file or bounded directory of frontmatter records; `title`
  defaults to the first Markdown H1. Raw bodies are never exposed.
- `calendar`: a native Remind source, using the existing CalendarService safe
  snapshot, timezone, include, output, timeout, and occurrence handling. Its
  existing safety ceilings apply (32 files, 2 MiB, bounded native output);
  a view's smaller file/byte limits narrow those ceilings.

Only declared scalar fields are returned. Optional `id_field` selects a stable
record ID; otherwise Markdown uses its path and JSON uses a content hash. Identical
JSON rows without IDs are indistinguishable: use explicit IDs for durable records.
`required_filters` requires explicit scalar filters such as `person_id`, and all
such fields must be declared. There are at most eight views. Non-calendar scans
are capped by `max_files` (default 100, ceiling 200), `max_bytes` (default 2 MiB,
ceiling 4 MiB), and 1000 directory entries. Exceeding scan limits is unavailable,
not a partial result presented as complete. Selection happens before result
limiting. Result limits are at most 100 records; scalar strings are capped by
`max_field_chars` (default 300, ceiling 1000).

## Local participation and scope

Add optional `data_views` to the app's config schema. It is local instance state,
never a package credential or shared recipient setting:

```json
{"data_views":{"briefing":["follow-ups"],"scopes":{"follow-ups":{"person_id":"person-001"}}}}
```

Installing a declaration does not opt into automatic disclosure. Fresh installers
clear default briefing participation and scopes when these defaults are present.
Absent settings mean no briefing participation; malformed settings fail closed.
Scopes apply to every query, including interactive ones, and cannot be widened
by request filters. Scheduled Hermes queries require `purpose: "briefing"` and
scheduled-work permission. Interactive reading does not opt a view into scheduling.
All of this is a query boundary, not a sandbox preventing filesystem-owning code
from reading workspace files directly.

## Shared interfaces

- `GET /api/minion-views`: discover Minion views and diagnostics.
- `GET /api/minion-views/:id`: describe one app.
- `POST /api/minion-views/query`: authenticated, same-origin bounded query.
- Hermes tools: `minion_describe(id?)` and `minion_query(...)`.
- Trusted bundled CLI `/usr/local/lib/openlia/minion-views.js`: JSON on stdin,
  `action` is `list`, `describe`, or `query`; never a workspace-controlled command.

```json
{"action":"query","query":{"id":"gym-tracker","view":"sessions","purpose":"briefing","from":"2026-10-01","to":"2026-10-08","limit":8}}
```

Date ranges have an exclusive end and cover 1–31 days. Responses include
`observed_at`, source `revision`, canonical record URIs, matched count,
`unknown_dates`, and `truncated`. No successful match is distinct from unavailable
data. Observation time means the time of the read, not the freshness of an app's
external enrichment. These initial readers read canonical records, not caches.

The Dashboard's Shared data views panel uses the same query endpoint. Its visible
tab, selected page, or hidden columns are not access settings. The Python briefing
collector delegates to the bundled CLI and does not suppress ordinary collections
just because a Minion exposes a similar category. Consumers must avoid counting
the same canonical record twice.

Test runtime/catalog commit pairs before promotion. An unset `requires.openlia`
is not a compatibility guarantee. Do not change the production catalog pin merely
to preview this contract. Advanced hledger report views and cache-backed enrichment
freshness policies are not implemented by these initial readers.
