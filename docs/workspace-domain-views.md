# Specialized workspace domain views

Feature-owned `*-dashboard.openui` and `*-record.openui` files use the normal
OpenUI library and can be edited in the browser. Existing records remain valid:
new frontmatter properties are optional, old lifecycle values are retained, and
unstructured Markdown is rendered without requiring a migration. Broken custom
layouts can still be bypassed with the synthesized view.

## Optional metadata

| Domain | Fields |
| --- | --- |
| Travel | `alerts: ["Passport expires soon"]` |
| Shopping | Numeric `budget`, `target_price`, `actual_price`; `currency`; `vendor_url` |
| Monitors | `last_checked` as an ISO 8601 timestamp with timezone |
| People | `last_contacted` as YYYY-MM-DD; `linked_records` as workspace-relative paths |
| Finance / accounts / reviews | `journal_path` as a workspace-relative path |

Shopping adds `wishlist`, people adds `client`, and decisions adds `under-review`
and `accepted`. Existing values such as `watching-price`, `decided`, and
`abandoned` are not renamed. Purchase columns follow the domain schema. Missing
monitor check times and contact dates display as unknown, not healthy/recent.
Monitor lifecycle and observed health are separate: active monitors become stale
after their configured interval; triggered monitors display alerting.

## Structured Markdown conventions

Keep the existing H2 headings. Within them, use ordinary Markdown lists or GFM
tables. `RecordSectionView` renders these as schedules, booking cards, comparison
tables, or timelines and offers a section editor. Prose remains supported.

Under `## Itinerary Outline`:

```markdown
| Date | Time | Activity | Location |
| --- | --- | --- | --- |
| 2026-11-01 | 09:00 | Flight | SFO |
```

Under `## Reservations & Confirmations`:

```markdown
- Flight: Example Air, Nov 1, 09:00. Confirmation: ABC123.
- Hotel: Example Hotel, Nov 1–3. Confirmation: XYZ789.
```

Under shopping's `## Candidate Options`:

```markdown
| Option | Price | Vendor | Pros | Cons |
| --- | --- | --- | --- | --- |
| Model A | 120 USD | [Vendor](https://example.com/a) | Light | Limited ports |
```

Use a specification/value table in `## Decision Criteria`. For decisions, use
an option/benefits/costs/risks table in `## Options Considered` and a
criterion/weight/option-score table in `## Criteria And Weights`. These are
record-backed comparisons, not automatic decision approval or invented scores.

Interaction notes, observations, and review outcomes retain their existing
headings and can contain dated list entries. Packing and reconciliation use
standard `- [ ]` items. For accounts, add those items under `## Reconciliation`;
checking them records review progress only, never posts or clears transactions.

## Finance limitations and scope

The dashboard's default journal is `finance/journal.hledger`; change its
`FinanceOverview` argument to select another workspace-relative journal. Record
views require explicit `journal_path`. The preview resolves simple recursive
includes, reports missing/unsupported paths, and suppresses totals when includes
are incomplete. Choose a month and currency in the widget. Net assets use
asset/liability book balances through that month; cashflow and categories use
that month only. Account history uses the record's `ledger_account`.

Calculations reuse the existing journal preview parser, **not an authoritative
hledger validation**. Unsupported syntax may be omitted. Commodities/currencies
are never combined or converted; securities are not market-valued. A preview
must not be treated as a certified net-worth statement or a balanced-journal
check. Open the journal for editing or authoritative accounting checks.

Visual edits use the existing revision-aware workspace file API. Save failures
remain visible; section drafts remain available to retry. YAML edits preserve
comments and unrelated Markdown, and checklist mutations ignore code examples.

## Authoritative journal checks (separate from preview calculations)

`FinanceOverview` offers an explicit **Check journal / Recheck journal** action.
The authenticated server runs the built-in `hledger check` command against an
isolated snapshot, not the live workspace. The result includes the engine
version, completion timestamp, content fingerprint, dependency revisions, and
diagnostics linked back to workspace files. Successful validation means only
**hledger check passed for that snapshot**; it does not certify the client-side
preview metrics, market values, tax treatment, or reconciliation completeness.

The service supports UTF-8 `.hledger` / `.journal` files with literal relative
plain-journal includes with unquoted filenames. It resolves includes within the workspace, rejects
symlinks and protected paths, and blocks cycles, globs, environment/home
expansion, absolute paths, and format-prefixed includes (including CSV rules).
Include-looking lines inside block comments are inspected conservatively too.
Unsupported input is **blocked**, never silently omitted from validation.

Checks use a ten-second process budget, a 32-KiB per-process diagnostic limit,
and snapshots limited to 50 files (also counting repeated include expansions),
32 include levels, 1 MiB per file, and 4 MiB
total. Only one check runs at a time per workspace-handler instance. Source files
are never modified; the service cannot post, import, add, clear, or reconcile
transactions. It invokes a fixed argument array without a shell, strips inherited
ledger/config settings, and disables config files on engines supporting them.

Docker includes hledger. Other environments show **unavailable** if it cannot be
run. Administrators may configure `OPENLIA_HLEDGER_BIN` to a trusted executable;
clients cannot choose commands or flags. A failed journal, unavailable engine,
timeout, output/resource limit, stale snapshot, and infrastructure error have
separate outcomes.

Results are not cached or persisted. Known saves of captured files invalidate
the card immediately. While visible, the card checks content freshness every
15 seconds and on window focus/tab visibility changes, without rerunning
hledger. External edits are therefore not detected instantaneously: always use
**Recheck journal** when current validation is required. Changes detected during
the native check also prevent a passing current-state result.

API endpoints (both authenticated and same-origin):
- `POST /api/workspace/finance/check` with `{ "path": "finance/main.journal" }`
- `POST /api/workspace/finance/check-status` with `{ "path": "finance/main.journal", "fingerprint": "sha256:..." }`

The freshness endpoint only compares snapshot fingerprints; it never executes
hledger. Both APIs are read-only with respect to the workspace.
