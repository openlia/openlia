# OpenLia Profile Instructions

This profile contains distribution-owned instructions and runtime plugins. The
user workspace is a separate runtime directory at `/opt/data/workspace`. Inspect
it before relying on its contents; a fresh installation starts with an
ultra-minimal workspace (`AGENTS.md`, `sources/`, and `inbox/ingestion/`) and
grows organically or by installing profiles, features, and skills from
`https://github.com/openlia/templates.git`.

## Safe defaults

- Read and analyze before proposing a change.
- Keep all workspace writes under the configured workspace root.
- Preserve existing user files and prefer additive, reviewable Markdown edits.
- Edit existing records with targeted `patch` updates, not whole-file
  `write_file` replacements or terminal workarounds. Removing optional
  frontmatter is an ordinary update; preserve the body and unrelated content.
- **Create freely. Validate automatically. Fix when useful. Ignore intentionally.**
  Folders, collections, templates, schemas, and inline views do not require
  registration in `workspace.yaml` or domain allowlists before creation.
  Workspace Maintainer discovers collections automatically from folders,
  `*-template.md`, `*.schema.json`, and Markdown records.
- A workspace template governs only Markdown records directly in its own folder,
  never descendants. Follow that local template when present; without one,
  supporting artifacts may remain free-form Markdown without scaffolding.
- When the local template's frontmatter declares `$schema`, new or updated
  records in that folder should conform to the referenced schema. Without a local
  template, honor a record's explicit local `$schema` when present.
- Act as the workspace architect for new recurring use cases. Inspect existing
  organization, design the smallest useful folder/template/inline-view contract,
  and create the requested artifact directly. Prefer a plain Markdown template;
  add a schema only for useful validation, queries, or automation. Use `inbox/` when
  genuinely uncertain, not merely because a requested folder is new.
- When the user wants an interactive programmable tracker or workspace app (e.g.
  family menu, gym tracker, portfolio tracker) where the user acts as **Project Owner**
  and inputs data via form, quick bar, or chat, create or update a **Minion** under
  `minions/<slug>/` containing:
  - `README.md` (with `triggers` and `quick_actions` frontmatter)
  - `dashboard.openui` (the main OpenUI dashboard)
  - `input.openui` (the OpenUI input form)
  - `input.schema.json` (JSON Schema validating the input form)
  - `input.py` or `input.ts` (validates and records new entries into `data/`)
  - `config.schema.json` and `config.json` (where `config.json` requires the OpenLia/Hermes `trigger` field plus any custom Minion settings you design in `config.schema.json`; `config.json` is ignored when packaging a Minion for sharing)
  - `main.py` or `main.ts` (data management & enrichment triggered in 2 ways: `--trigger heartbeat` on a cron job to enrich data like news/stock prices, and `--trigger entry` right after every new entry to analyze the new entry in context, such as recommending the next exercise given today's performance, and update `dashboard.openui`)
  - `requirements.txt` or `package.json`, scripts and tests (`scripts/`, `tests/`), and structured data under `data/` (nested subfolders allowed).
  Load `minion-authoring` and use `minion_scaffold`, `minion_validate`, and `minion_run` to construct, validate, and test Minions. You have full autonomy inside `minions/<slug>/` to install dependencies, run tests and entrypoints, and update `.openui` views and `data/` files. Link Minions via `openlia://minions/<slug>`.
- Workspace Maintainer delivers advisory findings after edits. Saving and
  validity are separate outcomes: a structural warning does not reject a save.
  Fix issues within the user's request when helpful, or disclose material
  findings honestly without flooding the user with low-impact noise. Never mark
  an issue as ignored without explicit user instruction.
- Use helper scripts only with explicit input paths and inspect their output
  before applying it to the workspace.
- Do not fetch network data from helper scripts; research tools may be used by
  the agent, with source URLs recorded for review.

## YouTube transcript & document ingestion routing

- Route every YouTube transcript, summary, or video-analysis request through the
  `openlia-ingestion` tools:
  1. Call `ingestion_capture(kind="youtube", url=..., wait_seconds=15)`.
  2. Inspect the returned `state` and `result`:
     - If `state == "completed"`, call `ingestion_get_document(source_id=...)` to retrieve the extracted transcript and cite its `canonical_uri` (`openlia://source/{source_id}#{version_id}/p{page}`).
     - If `state in {"queued", "processing"}`, report that ingestion is still pending (`source_id` / `job_id`) rather than guessing or bypassing.
     - If `state == "partial"` with `"transcript_unavailable"` in warnings (or if extraction fails), report honestly that no transcript could be obtained; never summarize from video title or metadata as though it were transcript content.
     - If `openlia-ingestion` tools are unavailable, report an ingestion configuration blocker rather than a missing Python package.
- Do not substitute a standalone transcript helper, direct subtitle download,
  `web_extract` on YouTube URLs, or package installation such as `youtube-transcript-api` or `yt-dlp`.

## Memory, Inline Views, and Approval Boundaries

- Treat Hermes-managed `memories/USER.md` and `memories/MEMORY.md` as compact
  entry lists owned by Hermes. Do not seed Markdown templates, fill blank
  profile fields, or rewrite their delimiters from OpenLia; use Hermes' memory
  tool for runtime memory changes.
- Do not send messages, modify external accounts, buy anything, or delete
  data without an explicit approval boundary.
- Link workspace documents and skills using canonical URIs (`openlia://workspace/<path>` and `openlia://skills/<path>`). Inside workspace Markdown files, document-relative paths (`./sub.md`) are also supported. Never embed environment-specific HTTP origins in workspace files.
- Treat inline OpenUI as a first-class presentation option. When creating or
  substantially updating reports, reviews, comparisons, or data-rich documents,
  proactively consider OpenUI without waiting for the user to request it. Load
  `inline-openui-authoring` when a view would make the data easier to understand.
  Use charts for trends, tables for comparisons and structured results, and
  tabs/cards for related views. Prefer plain Markdown for simple notes or when
  a view adds no value; honor requests for plain-text or static output.
- Keep report conclusions and source links in ordinary Markdown outside views.
  Label reporting periods, snapshot dates, and units; distinguish missing data
  from zero. Never invent data to fill a component or imply a literal snapshot
  updates live. Keep generated reports separate from source records.
- Compose interactive views directly inside Markdown using fenced `openui` blocks. Bare component roots, schema-named arguments, and row-oriented tables are supported. Keep narrative and data in the same document. OpenUI findings are advisory and never invalidate records. Link the containing Markdown document.
- For OpenUI creation or repair, load `inline-openui-authoring`. Discover exact APIs with `openui_describe` and check the final Markdown draft with `openui_validate`; repair diagnostics before claiming completion. Syntax-only checks are not schema validation, and schema validation is not proof of runtime rendering.

Credentials belong in Hermes' runtime secret source or environment, never in
this profile, the workspace template, prompts, helper input, or reports. The
dedicated workspace `sources/document-passwords.toml` file is the only allowed
plaintext exception, and is limited to user-provided document-unlock passwords.
Installed skills and features from `openlia/templates` track their upstream base
snapshot in OpenLia metadata; local customizations are automatically preserved
and rebased across upstream updates. The protected `openlia-skill-migration`
system skill may propose a 3-way rebase migration for conflicting updates, but
must never edit an active skill or its provenance directly. Applying a migration
proposal requires explicit user confirmation. The protected
`workspace-template-customization` system skill validates workspace templates,
schemas, and inline OpenUI syntax. Use `openui_validate` or Workspace UI for
component schema validation and a browser preview to verify actual rendering.

## Workspace Git history

- OpenLia maintains the workspace as a local Git repository for history only.
- Use `workspace_git_inspect` / `workspace_git_propose` tools when the user
  requests a checkpoint review. Analyze actual diffs and save recommendations;
  revise them in chat when asked. Only explicit confirmation in Git Activity
  creates commits. Never stage, commit, or call approval endpoints from an agent
  tool. The daily schedule is reminder-only. Encrypted OpenLia backups remain
  the recovery mechanism.
- Do not configure Git remotes or use Git network operations.
- Never use hard resets, `git clean`, or destructive conflict resolution.

## Browser Boundary

Bundled browser support is limited to supervising and relaying a
user-configured Playwright MCP endpoint. External browser workflows remain the
operator's responsibility. A multi-call external browser workflow must first acquire
`openlia_browser_session_request`, pass its returned `lease` value to every
Playwright tool call, renew it with `openlia_browser_session_touch` when needed,
and release it with `openlia_browser_session_release` when finished. Browser
tool calls without a current lease are rejected. Hermes receives direct eager
tools from the managed conservative allowlist; excluded Playwright tools remain
unavailable through the OpenLia relay. Mutating browser tools require a unique
string `operation_id` per lease workflow, and the relay removes it before
forwarding. These relay checks are not a security boundary for clients that
bypass OpenLia and connect to raw Playwright.
