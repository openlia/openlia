---
name: minion-authoring
description: Design, scaffold, customize, validate, and run autonomous Workspace Minions in minions/<slug>/ with dashboard.openui, input.openui, input.schema.json, config.schema.json, config.json, input.py/input.ts, and dual-triggered main.py/main.ts.
version: 0.3.0
system: true
forkable: false
protected: true
---

# Workspace Minion Authoring (`minions/<slug>/`)

This is a protected OpenLia system skill. Use it whenever the user asks to create, customize, configure, debug, or run a **Workspace Minion** in `minions/<slug>/`.

As the Project Owner's technical partner, you are responsible for designing the Minion's data model, input form, configuration schema, post-entry analysis logic, and heartbeat enrichment logic without asking the user to write JSON Schemas or OpenUI code manually.

## Canonical Minion File Architecture

Keep Minions distinct from ordinary document collections and workflow skills.
Use inline OpenUI in Markdown for document presentation; do not create an app
merely to display notes. Preserve one authoritative location per dataset instead
of copying existing task, calendar, ledger, or clinical records into app state.
Generic discovery excludes Minion internals. Declare named structured views in
`data.views.json` for bounded read-only queries shared by Dashboard, Hermes and
briefing. Use `minion_describe` to discover views and `minion_query` to read them;
never execute `main.py` or a heartbeat simply to read data. Local config opts into
scheduled inclusion with `data_views.briefing` (default empty), and
`data_views.scopes` restricts all queries. Require explicit person/account scope
for sensitive views. Dashboard pagination or hidden columns are not permissions.

Every Minion lives in `minions/<slug>/` (`^[a-z0-9][a-z0-9-]*$`) and consists of:

1. **`README.md`** (Required):
   - Documents the Minion's purpose, architecture, configuration fields, CLI usage, and optional YAML frontmatter (`name`, `description`, `quick_actions`).
2. **`dashboard.openui`** (Required):
   - The main OpenUI dashboard rendered from `data/` and `data/context.json` (using `Stack`, `Callout`, `Card`, `Table`, `ChartPanel`, `Tabs`, etc.).
3. **`input.openui`** (Required for interactive entry):
   - OpenUI input form (`Form(name: "minionInput", fields: [FormControl(label: "...", input: Input(name: "...", ...))], buttons: Buttons(...))`) rendered in the **Input Form** tab.
   - Every `Input(name: "<field>")` or `Select(name: "<field>")` inside `input.openui` **must** correspond to a property in `input.schema.json`.
4. **`input.schema.json`** (Required):
   - Draft 2020-12 JSON Schema validating every new entry before `input.py` / `input.ts` records it.
5. **`input.py` or `input.ts`** (Required):
   - Input entrypoint invoked via `--data '<json>'` (or `OPENLIA_MINION_INPUT_JSON`). Validates the payload against `input.schema.json` and persists the new record into `data/`.
6. **`config.schema.json`** (Required — Packaged Contract):
   - Draft 2020-12 JSON Schema for `config.json`.
   - **Standardized `trigger` Requirement**: Must require `"trigger"` at the root following the OpenLia/Hermes trigger format.
   - **Agent-Designed Custom Fields**: You (the OpenLia/Hermes agent) decide what additional properties belong in `config.schema.json` for each specific Minion (e.g., `news_url`, `stock_endpoint`, `api_key_env`, `calendar_rem_path`, `target_calories`, etc.).
   - **Packaging Rule**: When a Minion is packaged to share between users, `config.schema.json` is packaged while `config.json` is ignored. Always include clear `title`, `description`, and sensible `default` values in `config.schema.json` so recipients know how to configure the Minion.
7. **`config.json`** (Required — Local Instance Config):
   - Local instance configuration validated against `config.schema.json`.
   - Must include `"trigger"` (standardized by OpenLia/Hermes so the platform knows how to trigger `main.py` / `main.ts`):
     ```json
     {
       "trigger": {
         "on_new_entry": true,
         "cron": "0 */6 * * *"
       }
     }
     ```
      (`trigger` may also be the shorthand string `"entry"`, `"cron"`, or `"both"`).
    - A cron setting describes the intended cadence; it does not by itself
      register or enable a scheduler. Verify actual registration and execution.
      Respect scheduled-work permissions and external-effect approvals; the
      Minion directory is not a process sandbox.
    - Local settings are never exported. A fresh feature install derives safe
      defaults from the schema and turns automatic triggers off. If settings
      remain missing, configuration is pending and entry/main/heartbeat execution
      is blocked until valid config is saved. Updates preserve local config,
      including intentionally deleted config; never invent recipient settings.
8. **`main.py` or `main.ts`** (Required — Dual-Triggered Data & Enrichment Engine):
   - Reads `config.json` (or `OPENLIA_MINION_CONFIG_JSON`) and `data/`, and supports **two trigger modes**:
     - **Post-Entry Trigger (`--trigger entry --entry '<json>'`)**: Runs automatically right after `input.py` / `input.ts` records a new entry (when `config.json`'s `trigger` enables `on_new_entry`). Analyzes the new entry in context (e.g., recommending the next exercise given today's logged performance, checking budget impact, or updating streaks), writes `data/context.json`, and refreshes `dashboard.openui`.
     - **Heartbeat Trigger (`--trigger heartbeat`)**: Runs on the cron schedule in `config.json` (`trigger.cron`) or manual trigger. Enriches `data/` and `data/context.json` (e.g., fetching news, retrieving latest stock prices, reading workspace calendar `.rem` files, or computing periodic rollups) and refreshes `dashboard.openui`.
9. **`data/`** & **`tests/`**:
   - `data/`: Structured JSON/CSV/YAML/Markdown data files (`data/items.json`, `data/context.json`, nested subfolders).
    - `tests/`: Unit tests (`tests/test_main.py` for Python or `tests/main.test.ts` for TypeScript) verifying `input` schema validation, `config.json` loading, and `dashboard.openui` generation.
10. **`minion.package.json`** (Required for Sharing):
    - Scaffolding supplies `{"schema": 1, "files": [...]}` with explicit relative
      source-file paths. Maintain this reviewed list when adding code, views,
      schemas, dependencies, helpers, or tests. The manifest itself is implicit.
    - Never list local config, `data/`, state, hidden files, environments, installed
      dependencies, caches, logs, or credentials, even when including records.
      Reviewed test fixtures may live in `tests/fixtures/`.
    - Package a live app through feature export; clean catalog/import packages
      may contain only declared portable files. Both browser and CLI enforce the
      contract. Browser installs reject existing apps; CLI updates/reimports use
      code-only 3-way rebase and preserve local state.
    - Review every declared file and the final archive before sharing. Generated
      dashboards and source code can contain personal data; a file list and
      credential scan do not prove privacy or code safety. Feature removal keeps
      the app directory intact; it does not disable manual app execution.

## Hermes Tools for Constructing Minions

Optional `data.views.json` contains `schema: 1` and up to eight named views.
Declare only canonical `data/` paths, approved readers (`markdown`, `json`,
`calendar`), explicit scalar `fields`, `title_field`, and `date_field`. Add this
file to `minion.package.json`. Keep automatic participation off in distributed
config defaults (`data_views.briefing: []`, `data_views.scopes: {}`). Require
`person_id` or account filters for sensitive views; do not infer identity.
`minion_validate` checks declarations through the trusted runtime. Use
`minion_describe(id=...)` and `minion_query(id=..., view=..., from=..., to=...)`
to preview read-only results. Dates use an exclusive end and a 1–31 day range.
Queries return canonical links, revisions, observation times and truncation;
unavailable or unknown-date evidence is not proof of zero activity.

Always use the built-in Hermes Minion and OpenUI tools rather than hand-crafting boilerplate from scratch:

1. **`minion_scaffold`**:
   - Call `minion_scaffold(id="<slug>", name="<Display Name>", description="...", runtime="python" | "typescript", heartbeat_schedule="0 */6 * * *")` to create the complete baseline folder in `minions/<slug>/`.
2. **`openui_describe` & `openui_validate`**:
   - Call `openui_describe(component="Form")` to inspect the `Form` / `FormControl` / `Input` / `Select` schema and the `minion-input-form` recipe before customizing `input.openui`.
   - Call `openui_describe(component="Table")`, `openui_describe(component="ChartPanel")`, `openui_describe(component="Callout")`, etc. when designing `dashboard.openui`.
   - **Common OpenUI Component Signatures (Never Guess Property Names)**:
     - `Callout(variant: "info" | "warning" | "error" | "success", title: "...", description: "...")` — **use `variant`, never `tone`**.
     - `CardHeader(title: "...", subtitle: "...")`
     - `Table(title: "...", columns: [{key: "...", label: "..."}], rows: [{...}])`
     - `Form(name: "minionInput", fields: [FormControl(label: "...", input: Input(name: "...", placeholder: "...", rules: {required: true}))], buttons: Buttons(buttons: [Button(label: "...", variant: "primary")]))`
3. **`minion_validate`**:
   - Call `minion_validate(id="<slug>")` after editing any Minion file. It deterministically checks:
     - Required files (`README.md`, `dashboard.openui`, `input.openui`, `input.schema.json`, `config.schema.json`, `config.json`, `input.py`/`input.ts`, `main.py`/`main.ts`).
     - `config.schema.json` validity and `config.json` conformance (including the OpenLia/Hermes `trigger` contract).
     - `input.schema.json` validity and field-name alignment between `input.openui` controls (`Input` / `Select`) and `input.schema.json` `properties`.
     - Full OpenUI component schema validation on both `dashboard.openui` and `input.openui`.
4. **`minion_run`**:
   - Call `minion_run(id="<slug>", mode="test")` to run the Minion's unit test suite (`tests/`).
   - Call `minion_run(id="<slug>", mode="input", data={...})` to test recording an entry via `input.py`/`input.ts` followed by `main.py`/`main.ts --trigger entry`.
   - Call `minion_run(id="<slug>", mode="heartbeat")` to test `main.py`/`main.ts --trigger heartbeat` enrichment and verify `dashboard.openui` updates cleanly.

## Step-by-Step Construction Workflow

1. **Scaffold**: Run `minion_scaffold` with the chosen `id`, `name`, `runtime`, and `heartbeat_schedule`.
2. **Design `config.schema.json` & `config.json`**:
   - Keep `"trigger"` required at the top level of `config.schema.json` and `config.json`.
   - Add only the custom configuration properties that `main.py` / `main.ts` actually needs for this Minion (for example, `news_url`, `stock_symbols`, `calendar_rem_path`, or domain thresholds).
3. **Design `input.schema.json`, `input.openui`, and `input.py`/`input.ts`**:
   - Define the domain fields in `input.schema.json`.
   - Update `input.openui` so every `Input(name: ...)` / `Select(name: ...)` matches a property in `input.schema.json`.
   - Update `input.py` or `input.ts` if custom normalization or derived fields are needed when saving to `data/` (accept `--data` and `--input`, and use `parser.parse_known_args()` in Python).
4. **Implement `main.py`/`main.ts` & `dashboard.openui`**:
   - Must accept `--trigger` (`entry` or `heartbeat`) AND `--entry` (`<json>`) via CLI flags (use `parser.parse_known_args()` in Python so post-entry execution `main.py --trigger entry --entry '<json>'` never fails with `unrecognized arguments`).
   - Implement `analyze_new_entry` (`--trigger entry`) to analyze the newly recorded entry with existing context and `load_config()` (`config.json`) and produce actionable recommendations.
   - Implement `run_heartbeat` (`--trigger heartbeat`) using settings from `load_config()` (`config.json`) to enrich data and refresh `dashboard.openui`.
   - Update `tests/` to cover your customized schema and logic.
5. **Validate & Test (Mandatory Self-Repair)**:
   - Run `minion_validate(id="<slug>")` and `minion_run(id="<slug>", mode="test")`.
   - Both `minion_validate` and `minion_run` (as well as `post_tool_call` advisories) run full OpenUI component & property schema validation (`openui-authoring.js`) on `dashboard.openui` and `input.openui`.
   - If any OpenUI diagnostic appears (e.g., `unknown-property: Unknown Callout argument 'tone'`), immediately fix the `.openui` file and the generator in `main.py` / `main.ts`, then re-run `minion_run(id="<slug>", mode="heartbeat")` and `minion_run(id="<slug>", mode="test")` until `ok: true` with zero validation errors.
   - Link the user to the Minion with `[<Minion Name>](openlia://minions/<slug>)`.
