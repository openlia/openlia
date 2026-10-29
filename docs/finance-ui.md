# Finance UI and reusable charts

The runtime provides chart components, a read-only native hledger adapter, and
structured account-mapping creation. The optional `personal-finance` feature in
`openlia/templates` owns the Finance Markdown/OpenUI composition and account
templates. Runtime upgrades do not seed or overwrite financial records.

## Composition

```openui
root = Finance([Tabs([
  TabItem("overview", "Overview", [FinanceOverview(), FinanceChart("income-expenses", "bar")]),
  TabItem("flows", "Flows", [FinanceChart("flows", "sankey")]),
  TabItem("spending", "Spending", [FinanceChart("spending", "bar"), FinanceChart("spending", "pie")]),
  TabItem("trends", "Trends", [FinanceChart("balances", "line")]),
  TabItem("accounts", "Accounts", [FinanceAccounts()])
])])
```

`Finance(children, journal?)` uses the containing Markdown document's folder. An optional journal
argument is document-folder-relative; otherwise only one reliably discovered include root
is auto-selected. Ambiguous independent journals require explicit selection.
Included source files are labelled as partial scopes, not silently combined with
other ledgers.

`FinanceOverview`, `FinanceChart`, and `FinanceAccounts` consume the shared scoped
context. The Finance chart adapter has no accounting parser: it transforms exact
native report rows into data for the existing OpenUI BarChart, LineChart, PieChart,
or the generic Sankey. Reusable `ChartPanel` and `SankeyDiagram` components also
accept ordinary data outside Finance and provide keyboard-accessible exact tables.
Finance permits bar/line for income or balance time series, bar/pie for spending
categories, and Sankey for posting flows. Incompatible combinations fail visibly;
balances across months are never pie slices of a financial whole.
Inline Markdown and Storybook rendering use the upstream dark theme so tab labels, axes,
legends, and tooltips match the workspace rather than defaulting to light tokens.

### Chart color identity

Shared tokens in `client/openui/charts/palette.ts` tune categorical charts for the
dark workspace without changing application branding or sequential heatmap ramps.
Finance supplies emerald income, orange expense, and violet balance-series
colors explicitly; renderers never infer financial meaning from label text.

Pie slices use a complete expense-account domain from the selected ledger, so
filtering, input reordering, or changes in slice values do not change existing
category colors while that domain is unchanged. The adapter accounts for OpenUI's
descending pie sort and midpoint palette distribution. Generic callers can pass
`colors` in input series/slice order and `colorDomain` containing hidden categories;
without a domain, identity hashing is stable but colors can repeat.

Sankey nodes use identity keys rather than input positions. Finance gives both
credit and debit representations of an account the same identity, uses native
revenue/expense types for semantic hues, and keeps posting groups neutral. Links
have restrained source-to-target gradients and a brighter hover state. These are
presentation changes only: signs, values, quantities, and accounting rules do not
change. Legends, labels, and exact tables remain essential; color alone does not
encode good/bad credit/debit meaning or establish accessibility compliance.

## Account creation boundary

Open the Finance Markdown overview in Documents, then Accounts → New account.

The editor reads the **installed** local `accounts/` template and JSON schema
through a bounded contract API, even when those files are hidden in Documents.
Fields, defaults, required keys, notes, and the schema are inspectable without
creating a template shell. Primitive fields have structured controls; complex
custom fields retain JSON input and template defaults. Local required sections
are preserved and validated, never removed to make a save pass.

**Validate draft (no save)** performs server-side validation without creating a
record. Save performs the same preflight and validates again at the write
boundary. Client-side schema code generation is deliberately not used: it would
require weakening the application's script CSP with `unsafe-eval`.

Only a complete Markdown record at `PROJECT/accounts/UUID.md` is created, using
the existing workspace validation/revision machinery and exclusive atomic
publication. Existing files, including concurrently created empty files, are not
replaced. Replaying an identical request is idempotent; differing content at the
same destination conflicts. Contract changes invalidate stale drafts. Duplicate
scope/account bindings are warned about, not merged.

Saving never creates a journal, adds an `account` directive, posts an opening
balance, schedules a payment, or touches an external bank/broker account. An
opening-balance date is metadata only. Missing or invalid journals do not prevent
otherwise valid mapping records from being saved.

### Ledger scope, not source-file ownership

```text
finance/main.journal
  include payslips-company-A.hledger
  include bank-B.hledger
```

Both included files can reference `assets:bank:B`. One mapping binds that name to
`finance/main.journal`; native reports include both files. Identical names in two
independent scopes are not globally merged. A payslip and a bank deposit describing
the same salary must still be reconciled; including both files does not deduplicate
real-world events.

Record lifecycle (`active`, `closed`, `archived`) is separate from computed link
state: linked/used, linked/declared without postings, not yet present, no journal
configured, or unverified. Balances are shown only for the verified selected scope
and one commodity. No ledger evidence is shown as **No ledger data**, never an
invented zero balance.

## Native report semantics and safety

- `hledger check` must succeed before financial reports are exposed.
- Reports cover at most 24 whole calendar months, with an exclusive end date and
  an optional escaped literal account-prefix query.
- Regular actual postings only: no `--auto`, `--forecast`, budget generation,
  cost conversion, market valuation, or external price fetching is enabled.
- Revenue (`R`) amounts are inverted for net income; expenses (`X`) keep their
  sign, so refunds reduce spending. Transfers and repayments are not counted as
  extra income/expense. Unknown native types are not guessed; categorized charts
  are withheld when unclassified amounts exist in the selected commodity.
- Historical balance series include postings before the selected start date.
  Asset/cash/liability quantities are labelled unvalued, not market-valued net
  worth or investment performance.
- Commodities are kept separate. Native JSON numeric tokens are read losslessly;
  fixed-point BigInt arithmetic preserves exact decimal totals. Values beyond the
  chart coordinate range use an explicit error plus an exact table, not rounded
  authoritative totals.
- Sankey uses credit accounts → transaction groups → debit accounts. A split
  transaction never invents a unique payer-to-payee allocation. Counterpart accounts
  from matching transactions can appear outside the account-prefix filter; this is
  stated in the caption. Flow graphs are withheld for unsupported commodity-level
  balancing/cost models or excessive size, while complete balance reports remain
  available. Pie slices must be non-negative; negative net expense categories use
  bars/tables instead.

Transactions sharing the same directed account set are aggregated into a posting
group with exact per-account totals. This keeps repeated salary/purchase patterns
readable without inventing direct source-to-destination pairings.

Native evaluation uses a private temporary snapshot, a stripped environment,
fixed commands/argument arrays, no shell, and execution/output limits. Only literal
unquoted `.journal`/`.hledger` includes within the project folder are supported,
resolved relative to their containing file. Cycles, repeated files, symlinks,
external paths, globs, and other readers fail visibly. Limits are 32 files / 4 MiB,
8 seconds / 8 MiB per command, 1,000 report rows, and 300 transactions / 200 nodes /
400 links for flows. Detailed transaction bodies are never returned to the UI or
logged. Scope, source paths, warnings, and fixed command provenance are inspectable.
The workspace's configured per-file read limit also applies to snapshot inputs.
Displayed commands use equivalent workspace-relative paths; execution takes place
only in the confined snapshot.

## API

- `GET /api/workspace/finance?path=finance`: account contract, mappings, journal
  candidates, known included files, and unambiguous suggested root.
- `GET /api/workspace/finance/report?path=finance&journal=finance/main.journal&from=2026-10-01&to=2026-11-01&accountPrefix=`:
  validated exact aggregate reports and bounded, explicitly modelled flows.
- `POST /api/workspace/finance/accounts/validate`: read-only contract/destination
  validation. Returns validity and controlled errors, not a saved shell.
- `POST /api/workspace/finance/accounts`: schema-validated mapping creation only.

Authentication and same-origin mutation checks apply. Contract access is confined
to the collection; it is not a general hidden-file read bypass. No source journal
or full export is included in normal responses.

## Review, deployment, and verification

Use Storybook's **Charts / Reusable charts** and **Finance / Dashboard and
mappings** groups. Fixtures are synthetic, including independent ledgers,
unclassified accounts, refunds, precision limits, and unavailable journals.

The workspace-ui image installs hledger; local development uses `hledger` on PATH
or server-only `OPENLIA_HLEDGER_BINARY`. Native tests were exercised with hledger
1.52.4. Unsupported native report shapes/precision fail explicitly. Deploy the
runtime before updating Personal Finance 0.4.0 through the feature's normal
review/rebase update flow.

```sh
bun run --cwd packages/workspace-ui check
bun test packages/workspace-ui/src/server/finance.test.ts
bun run --cwd packages/workspace-ui test -- src/client/openui/finance/finance.test.tsx
bun run --cwd packages/workspace-ui test:storybook
WORKSPACE_UI_E2E_MODE=real bun run --cwd packages/workspace-ui e2e -- e2e/finance.spec.ts
```

Native cases require hledger; browser tests use disposable synthetic fixtures.
Acceptance checks include normal navigation, pre-save inspection, cancellation,
read-only validation, save/reload/reopen, all four chart families, unchanged
journals, and future journal paths remaining absent. These local checks do not
establish a pass on the deployment reported in issue #184; rerun that journey after
the runtime and feature have both been deployed.
