# Estimated LLM usage

Workspace UI's **Usage** page shows estimated model usage across **Hermes**,
**Ingestion**, and **Migration**. It is a monitoring tool, not an invoice or billing
ledger. No prompts, model responses, document content, or credentials are stored.

## Dashboard

- Defaults to **This month**, with date, activity, and model filters stored in the URL.
- Shows estimated USD cost, input/output tokens, a daily chart, activity totals,
  and expandable provider/model details.
- Dates and daily boundaries use **UTC**. Reasoning tokens are an output detail,
  never added to the total a second time.
- Refreshes once a minute while visible. Manual refresh reloads the latest stored
  statistics; it does not synchronously contact an LLM provider.
- Ingestion intake and migration detail screens show a contextual summary when
  attributable data is available, with a link to the filtered Usage page.

### Estimates and missing data

The runtime imports Hermes' existing model/task aggregates. At first collection,
previous usage is a **historical summary**, visible under **All time**, not assigned
to invented daily bars. Subsequent increases are dated when observed. Ingestion
responses and isolated migration reports provide more direct timestamps.

Missing token reports are explicitly marked **Unknown**, not zero. Mixed groups
show the reported subtotal with an incomplete-usage warning. Interrupted calls,
providers that omit token counts, and internal retries can
make totals incomplete. The dashboard indicates unpriced models, partial usage,
stale prices, and delayed collection. It never substitutes a free price for an
unknown price. Very small positive costs retain extra decimal places.

Some Hermes auxiliary adapters omit cache/reasoning details. Ingestion marks
known Anthropic chat-shaped adapter results incomplete rather than implying those
details were captured. Standalone ingestion can report basic counts when this
monitoring module is installed, but cannot resolve Hermes prices without Hermes.

## Pricing

Automatic prices are resolved by the pinned Hermes pricing resolver, using its
bundled provider prices and public model metadata where supported, including the
currently configured compatible endpoint when its provider matches. Dynamic prices
are cached and checked daily. A failed refresh retains the last known price and
marks it stale. Bundled rates are updated by upgrading Hermes; “checked” does not
mean their publication date changed.

The dashboard recalculates estimates using **current** rates. Hermes estimates
and provider-reported USD costs are preserved separately and shown in model
details. If a model cannot be priced, reported costs take precedence over Hermes
estimates as a fallback, using only the reported subset. Context-tiered rates
cannot be accurately applied to aggregate tokens;
these also use the Hermes estimate, or remain unavailable. Pricing and overrides
are deliberately scoped to provider/model, not arbitrary proxy URLs.
Endpoint-specific overrides are **not supported**. Use distinct provider
identifiers for proxies with different prices; otherwise one override affects
all of them. Endpoint-scoped API requests are rejected.

**Configuration → Advanced · Pricing overrides** supports custom contracts,
proxies, and local models. Select an observed provider/model or enter a custom
one. Enter non-negative **USD per million tokens** for input, output, cache read,
and cache write; blanks mean unavailable, not free. “Free / no API charge” sets
explicit zero rates. Save is explicit; **Reset to automatic** removes the override.
Changes also update displayed historical estimates, never provider billing.

## Runtime and upgrades

The bundled `openlia-usage` Hermes plugin collects independently of Workspace UI.
Its state lives under `$HERMES_HOME/usage` (normally `/opt/data/usage`):

- `usage.sqlite`: usage deltas, source checkpoints, cached prices, overrides.
- `reports/`: durable, metadata-only migration handoff reports, removed after import.
- `collector.lock`: ensures one collector owns polling across Hermes processes.

Ingestion reports at the raw-response boundary before structured-output
validation, including async calls. Its job-local observer temporarily suppresses
ambient Hermes auxiliary accounting for calls it owns. If the monitoring DB is
locked (200 ms write budget), a metadata-only report is durably spooled. If both
paths fail, restored Hermes accounting is used as fallback where a session
context exists. Hermes ingestion rows are imported as ingestion usage rather
than unconditionally discarded. On upgrading the earlier schema, old ingestion
aggregates are conservatively baselined once to avoid replaying already-reported
usage; subsequent increases are collected normally.

Isolated Docker migrations export cumulative model aggregates from their own
runtime database after each run, including failed runs. Host runs preserve the
active `HERMES_HOME` (or `~/.hermes`) and also emit a handoff without requiring a
concurrent collector. Tagged sessions carry the migration ID. Shared-home
reports and polling use identical checkpoints, so either may arrive first without
duplicating usage. Reports wait for the runtime collector when it is stopped.
Classification calls run in the already-running Hermes service and carry the
same migration-ID attribution. Migration DB reads use a 250 ms busy timeout and
a two-second export context; errors are logged without changing the run result.

After upgrading, rebuild/update the Hermes and Workspace UI images, regenerate
the deployment's generated Compose configuration, and recreate the services.
The profile enables `openlia-usage`; generated Workspace UI attachments mount
only the `usage` directory, not the rest of Hermes state. Both services use the
runtime UID/GID. `OPENLIA_USAGE_ROOT` overrides the directory for development or
custom installations; set it consistently for producer and reader.

The existing encrypted durable backup includes monitoring state and pending
reports. Consistent backups stop Hermes and Workspace UI; avoid running separate
migration supervisors during a snapshot, since they can publish handoff files.
SQLite `-shm` files and lock files are excluded. Monitoring state is not committed
to workspace Git.

### Operational limits

Each poll reads the latest 10,000 Hermes model/task aggregates, imports up to
1,000 reports, and refreshes up to 25 model prices. Migration export has no
arbitrary row cap: it reads in deterministic key order within its time budget.
Very large histories may be
incomplete; this feature targets personal deployments. The API caps output at
20,000 daily model groups and reports when truncated; the chart displays the
latest 90 active days. High-water marks avoid duplication after an older source
database is restored, but can undercount subsequent usage if source identities
are reused. No billing-grade completeness guarantee is made.

The ingestion adapter uses a job-local subclass of the pinned Hermes LLM facade
to observe the response before parsing. It does not patch global Hermes methods.
Revalidate this narrow compatibility and accounting-context boundary when
upgrading Hermes.
