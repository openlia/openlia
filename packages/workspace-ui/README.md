# Workspace UI

The Workspace UI is a React client and Bun HTTP server for browsing and editing
workspace documents. The client has an explicit `WorkspaceApi` boundary so
frontend work does not require OpenLia, Hermes, Go, or Docker.

The client is built on TanStack Start, TanStack Router, and TanStack Query.
TanStack Start owns the SSR request, typed route tree, and server-function
transport. The existing REST endpoints remain available for compatibility and
for browser-native binary uploads and downloads.

## Requirements

- Bun `1.2.22` or newer

Install dependencies from the repository root once:

```sh
bun install
```

## Frontend Development

The default development mode uses a stateful in-memory API. It requires no
backend process and is safe to use for normal UI development:

```sh
cd packages/workspace-ui
bun run dev
```

Open `http://127.0.0.1:5173`. The mock supports editing, saving, Git status,
and the default document flow. Use a scenario when working on a specific UI
state:

```sh
VITE_WORKSPACE_UI_SCENARIO=auth bun run dev
VITE_WORKSPACE_UI_SCENARIO=conflict bun run dev
```

The available scenarios are `auth`, `conflict`, `empty`, `error`, and
`loading`. The query parameter takes precedence over the environment variable,
so scenarios can be switched without restarting Vite:

```text
http://127.0.0.1:5173/?scenario=conflict
```

The file navigator hides workspace scaffolding such as `.gitkeep`, OS metadata,
and the canonical starter templates. Empty workspace folders remain visible so
the workspace structure is still discoverable. Search expands matching folders;
use `Cmd+S` on macOS or `Ctrl+S` elsewhere to save an edited document.

Markdown files use the Preview/Edit document views. Other editable text files,
including YAML, JSON, TOML, CSV, and plain text, open directly in the syntax-
highlighted code editor. The editor detects the language from the file
extension; unsupported extensions use plain text. Files under
`knowledge/chatgpt/` follow the same ordinary YAML behavior as every other
workspace file.

### User profile and assistant memory

In **Configuration → Advanced editing**, enable **Enable user profile and memory
editing** to show `USER.md` and `MEMORY.md` in the **Assistant memory** group in
Documents. These use the same Markdown editor, save shortcuts, and draft/conflict
handling as workspace documents. Missing files are created on the first explicit
save. The files have fixed names and cannot be renamed, moved, or deleted here.

These are the live files under Hermes' `memories/` directory, not copies inside
the workspace. Production Compose mounts that directory at `/memories`; standalone
servers should set `OPENLIA_MEMORIES_ROOT` to the directory containing the two
files. Editing is disabled by default and persisted in `workspace-ui.yaml` as
`enable_memory_editing`. Changes are loaded into new assistant sessions.

The editor enforces Hermes' default direct-file budgets: `USER.md` is limited to
1,375 characters and `MEMORY.md` to 2,200 characters. Hermes-compatible memory
file locks (`USER.md.lock` and `MEMORY.md.lock`) are honored during saves, and a
busy lock fails after a bounded wait rather than overwriting a concurrent update.

The mock includes sample memories. `dev:real` uses `.dev-memories/` unless
`OPENLIA_MEMORIES_ROOT` or `HERMES_HOME` supplies a real directory; `preview`
uses `.preview-memories/` by default. Memory links use `/memory/USER.md` and
`openlia://memory/USER.md` (likewise for `MEMORY.md`).

For an existing deployment, regenerate the generated Compose attachment and
recreate `workspace-ui` after upgrading so the `/memories` bind mount is added.
If the memories directory is unavailable, enabling the setting is rejected and
ordinary workspace documents remain usable.

## Real Backend Development

To exercise the actual Bun filesystem server against a disposable workspace:

```sh
cd packages/workspace-ui
bun run dev:real
```

This starts Vite on port `5173`, the API server on port `8089`, and creates
`.dev-workspace/` if no `OPENLIA_WORKSPACE_ROOT` is supplied. Override the
ports or workspace when needed:

```sh
OPENLIA_WORKSPACE_UI_PORT=8090 \
OPENLIA_WORKSPACE_UI_DEV_PORT=5174 \
bun run dev:real
```

The Vite proxy keeps the browser same-origin with the API, matching production
authentication and origin behavior.

To use a local workspace snapshot for real-data development, copy it into the
ignored development root:

```sh
rsync -a --delete /path/to/mock-workspace/ .dev-workspace/
bun run dev:real
```

The source workspace remains outside this repository. `.dev-workspace/` is
local-only and must not be committed.

## Playwright Screenshots

Install the local Chromium and WebKit browsers once:

```sh
bunx playwright install chromium webkit
```

Run the mock visual catalog:

```sh
bun run screenshots
bun run screenshots:headed
```

Screenshots are written to `.playwright/screenshots/`, with separate desktop
and mobile directories. The suite covers populated, selected, edited, filtered,
empty, authentication, conflict, loading, and error states.

Run the same automation against the ignored copied workspace:

```sh
bun run screenshots:real
```

The real-data suite uses `.dev-workspace/` and covers the populated tree,
filtering, and opening a real document. Reports, traces, videos, temporary
results, screenshots, and copied workspace data are all ignored by Git. They
may contain personal workspace data and should remain local.

## Checks and Builds

Run these from this directory:

```sh
bun run test
bun run test:watch
bun run check
bun run build
bun run preview
```

`preview` builds the client and server, then serves the production layout on
port `8089` using `.preview-workspace/`. Set
`OPENLIA_WORKSPACE_ROOT` and `OPENLIA_WORKSPACE_UI_PORT` to use another root or
port.

The production build emits a bundled `dist/server.js` launcher, Start's SSR
bundle under `dist/server/`, and browser assets under `dist/client/assets/`.
The launcher serves browser assets, Start routes, `/health`, and the compatible
`/api/*` endpoints from one Bun process.

The OpenLia root scripts remain available for full-repository checks and
release packaging. They delegate Workspace UI build, typecheck, and test
commands to this package.

## Workspace Migration (Beta)

The Workspace UI includes a **Migration** section for reviewing folder imports
created by `openlia workspace migrate <folder>`. It reads migration state and
artifacts from the deployment's migration storage; it does not create a second
review database.

The migration list and detail views expose source eligibility and progress,
published revisions, proposal Git diffs, validation findings, feedback, and
worker status. A detail page has **Overview**, **Changes**, **Sources**, and
**Discussion** tabs. Review actions include:

- Wake the worker when it is sleeping.
- Stop or resume processing, or discard a migration.
- Submit an overall or path-scoped comment with **Reject with Comment** to
  request changes.
- Approve and apply a selected revision.

The browser uses the existing Workspace UI authentication and origin boundary.
The CLI does not launch a separate migration server, open a browser, print a
temporary migration URL, or require the terminal to remain attached while a
migration is being reviewed. The UI is beta: after requesting changes, verify
that a new revision and diff have been published before approving it.

For remote deployments, access the existing Workspace UI through the normal
deployment access method (for example, the SSH tunnel described in the
operator guide), then navigate to `/migration`.
