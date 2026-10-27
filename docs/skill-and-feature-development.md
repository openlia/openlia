# Skill & Feature Package Development Guide

> How to create, customize, validate, and test bundled skills and À La Carte Feature Packages in OpenLia.

[← Back to Documentation Index](README.md)

OpenLia distributes workflow capabilities in two ways:
1. **Core Bundled Skills (`profile/skills/<name>/`)**: Always-installed workflows that operate across the Lean Productivity Base (e.g., `daily-briefing`, `weekly-review`, `inbox-triage`, `workspace-organize`, `workspace-git`, `calendar`, `document-intelligence`).
2. **À La Carte Feature Packages (`features/<id>/`)**: Self-contained domain bundles that combine workspace folder templates, JSON Schemas, OpenUI dashboards, and domain skills (e.g., `personal-finance`, `personal-health`, `decision-analysis`, `deep-research`, `areas`, `ideas`, `monitors`, `people`, `shopping`, `travel`).

---

## 1. Core Bundled Skills (`profile/skills/`)

Bundled skills live at `profile/skills/<name>/` and follow a standard directory layout:

```text
profile/skills/<name>/
├── SKILL.md               # Required: YAML frontmatter + workflow instructions
├── requirements.txt       # Optional: only for dependencies explicitly bundled in Docker
├── scripts/               # Optional: deterministic Python/shell helper scripts
├── templates/             # Optional: Markdown report/output templates
└── references/            # Optional: domain rubrics or reference guides
```

### Authoring Guidelines
- **Frontmatter & Structure**: Follow the YAML frontmatter conventions used by neighboring skills in `profile/skills/`.
- **Deterministic Helpers (`scripts/*.py`)**: Any Python helper script under `scripts/` must support a deterministic, offline `--self-test` flag so the repository test suite (`make test` and `make skills-test`) can verify it without network access or live credentials.
- **Templates**: If the skill outputs structured Markdown files, place starter templates under `templates/` so `make workspace-templates-test` validates their headings and optional `$schema` references.

### Testing Bundled Skills Locally
Run the offline skill test suite from the repository root:

```bash
make venv
make skills-test
# Or test an individual skill through the Go CLI:
go run . skills test SKILL_NAME
```

---

## 2. System Skills (`profile/system-skills/`)

Protected system skills live under `profile/system-skills/` and are mounted read-only into the runtime:
- **`openlia-skill-migration`**: Analyzes an upstream skill update alongside a user's local skill fork patch and stages a reviewable migration proposal.
- **`workspace-template-customization`**: Validates workspace JSON Schemas, Markdown templates, OpenUI definitions (`references/openui-spec.md`), and scoped workspace structure extensions.

System skills are distribution-owned and cannot be forked or modified by Hermes at runtime.

---

## 3. À La Carte Feature Packages (`features/`)

Specialized domains ship under `features/<id>/` so users can keep a lean workspace and install only the domains they need.

### Anatomy of a Feature Package
```text
features/<feature-id>/
├── feature.yaml           # Required: Feature manifest (id, version, title, paths, skills, policy)
├── skills/                # Optional: Domain skills installed when the feature is enabled
│   └── <skill-name>/
│       ├── SKILL.md
│       └── scripts/
└── workspace/             # Workspace directories, templates, schemas & OpenUI views
    └── <domain>/
        ├── <domain>-template.md
        ├── <domain>-template.schema.json
        ├── project-manifest.toml   # Optional: Mini-Project configuration
        └── ui.openui               # Optional: OpenUI dashboard layout
```

### Creating or Updating a Feature Package
1. **Define `feature.yaml`**: Validate it against [`workspace-template/feature.schema.json`](../workspace-template/feature.schema.json). Declare the workspace directories, starter templates, bundled skills, and any default delegation/policy metadata.
2. **Author Workspace Templates & Schemas**:
   - Every frontmatter template (`*-template.md`) declares `$schema: ./<name>-template.schema.json` as a local relative path.
   - Only one `*-template.md` is permitted per directory.
   - If the domain includes a dedicated **Projects** view (`/projects/<path>`), include `project-manifest.toml` and `ui.openui`. See [Workspace Mini-Projects & Domain Views](workspace-domain-views.md).
3. **Validate Templates, Schemas & Scripts**:
   ```bash
   make workspace-templates-test
   make skills-test
   ```
4. **Package & Install via CLI**:
   ```bash
   # List available bundled and installed features
   ./openlia features list

   # Install a bundled feature into the active deployment
   ./openlia features install <feature-id>

   # Package a custom feature directory into a portable .zip archive
   ./openlia features package ./path/to/feature --output my-feature.zip

   # Import a packaged .zip feature archive
   ./openlia features import my-feature.zip
   ```

---

## 4. Browser Boundary & Workflow Leases

OpenLia does not ship autonomous browser crawlers in its default skills. Instead, the optional `openlia-browser` package acts as a Playwright MCP supervisor and Streamable HTTP `/mcp` relay (`packages/openlia-browser/`).

When developing an operator-authorized skill or workflow that uses the attached browser:
1. **Acquire a Session Lease**: Because the attached browser uses a single shared authenticated profile, multi-call workflows must reserve exclusive access via `openlia_browser_session_request`, pass the active `lease` token to every Playwright call, renew it during long reasoning or human handoff (`openlia_browser_session_touch`), and release it when finished (`openlia_browser_session_release`).
2. **Supply `operation_id` on Mutating Calls**: Mutating browser tools (`browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_select_option`, `browser_handle_dialog`, `browser_close`) require a string `operation_id`. The relay strips `operation_id` before forwarding and prevents duplicate mutations on retry.
3. **Respect the Eager Allowlist**: Arbitrary JS evaluation, file upload/drop, network inspection, and console tools are excluded by default through the OpenLia relay.

Run the browser relay test suite with:
```bash
make skills-verify
```

---

## 5. Runtime Dependencies & Supply-Chain Safety

### Adding Python or System Dependencies
Adding a `requirements.txt` inside `profile/skills/<name>/` does **not** cause Docker to install arbitrary packages automatically at runtime. The derived Hermes image (`docker/Dockerfile`) installs only explicitly pinned dependencies.

If a bundled skill or plugin requires a new runtime dependency:
1. Add the pinned dependency to the relevant `requirements.txt` and explicit Docker build inputs (`docker/Dockerfile`, `docker/install-tools.sh`).
2. Add it to `requirements-dev.txt` for local testing (`make venv`).
3. Document the component and its license in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
4. Add unit/self-tests and rebuild the runtime image before testing in Hermes.

### Safety Rules
- Keep all unit and skill self-tests **deterministic and offline**.
- Never write test output to `/opt/data/workspace`, active chats, or real user records; always use temporary directories (`t.TempDir()` or `tempfile.TemporaryDirectory()`).
- Never commit credentials, protected dotenv files, runtime caches, or private host identifiers.
- Treat skill instructions (`SKILL.md`), helper scripts, and dependencies as executable supply-chain code.

---

## 6. Customizing & Migrating Skills in Production

Bundled skill changes are synchronized to deployments via `openlia update openlia`.
- If an operator wants to customize a bundled skill on their deployment, they should first fork it:
  ```bash
  openlia skills fork daily-briefing
  ```
- During future `openlia update openlia` runs, unchanged managed skills update automatically, while forked skills are preserved untouched and a migration context is staged for review via `openlia skills migrate show|apply`.
