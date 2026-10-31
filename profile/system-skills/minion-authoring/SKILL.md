---
name: minion-authoring
description: Design, scaffold, customize, validate, and run autonomous Workspace Minions in minions/<slug>/ with dashboard.openui, input.openui, input.schema.json, config.schema.json, config.json, input.py/input.ts, and dual-triggered main.py/main.ts.
version: 0.1.0
system: true
forkable: false
protected: true
---

# Workspace Minion Authoring (`minions/<slug>/`)

This is a protected OpenLia system skill. Use it whenever the user asks to create, customize, configure, debug, or run a **Workspace Minion** in `minions/<slug>/`.

As the Project Owner's technical partner, you are responsible for designing the Minion's data model, input form, configuration schema, post-entry analysis logic, and heartbeat enrichment logic without asking the user to write JSON Schemas or OpenUI code manually.

## Canonical Minion File Architecture

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
   - Stores the user's local Minion settings alongside `trigger` (e.g., `news_url`, `stock_endpoint`, `calendar_rem_path`). Ignored when packaging the Minion for sharing.
8. **`main.py` or `main.ts`** (Required — Dual-Triggered Data & Enrichment Engine):
   - Reads `config.json` (or `OPENLIA_MINION_CONFIG_JSON`) and `data/`, and supports **two trigger modes**:
     - **Post-Entry Trigger (`--trigger entry --entry '<json>'`)**: Runs automatically right after `input.py` / `input.ts` records a new entry (when `config.json`'s `trigger` enables `on_new_entry`). Analyzes the new entry in context (e.g., recommending the next exercise given today's logged performance, checking budget impact, or updating streaks), writes `data/context.json`, and refreshes `dashboard.openui`.
     - **Heartbeat Trigger (`--trigger heartbeat`)**: Runs on the cron schedule in `config.json` (`trigger.cron`) or manual trigger. Enriches `data/` and `data/context.json` (e.g., fetching news, retrieving latest stock prices, reading workspace calendar `.rem` files, or computing periodic rollups) and refreshes `dashboard.openui`.
9. **`data/`** & **`tests/`**:
   - `data/`: Structured JSON/CSV/YAML/Markdown data files (`data/items.json`, `data/context.json`, nested subfolders).
   - `tests/`: Unit tests (`tests/test_main.py` for Python or `tests/main.test.ts` for TypeScript) verifying `input` schema validation, `config.json` loading, and `dashboard.openui` generation.

## Hermes Tools for Constructing Minions

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
