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
