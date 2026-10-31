# Runtime and templates compatibility

The runtime and `openlia/templates` remain separate repositories. Changes that
span both should share a parent issue, delivery owner, acceptance criteria, and
reciprocal PR links. See the templates repository's
[contributor guide](https://github.com/openlia/templates/blob/main/CONTRIBUTING.md)
for the authoring and local-development workflow.

## Minimum runtime contract

Features, profiles, and skill frontmatter can declare:

```yaml
requires:
  openlia: ">=1.2.3"
```

This is an example, not a claim about an existing release. Only a single minimum
stable release (`>=MAJOR.MINOR.PATCH`) is supported initially. Malformed declared
requirements fail validation. An absent requirement retains legacy behavior.

Before installation/import/update, the operator preflights runtime requirements
across the affected feature dependency graph and bundled skills. Profile install
checks all selected features and skills before starting installation. Direct
installation/update of a feature-bundled skill checks its owning feature too.
Dependency cycles are rejected instead of recursing indefinitely.

The deployed Workspace UI image includes `/opt/openlia/runtime-release.json`,
copied at build time from `release/manifest.json`. The target operator reads that
file using `docker compose exec -T workspace-ui cat ...` with a bounded timeout.
It does not trust `OPENLIA_VERSION`, the caller's CLI version, or the currently
selected source checkout as evidence of the running image's capabilities.
Prereleases sort below the corresponding stable release; build metadata does
not affect compatibility.

Content with a requirement is blocked if the target is older, stopped,
unreachable, or lacks a valid release identity. Deploy/rebuild a compatible
Workspace UI image before retrying. There is no version-override bypass. Content
without a requirement does not need this target probe.

The browser's feature-install API applies the same minimum-version and dependency
preflight rules before copying any workspace or skill files. It reads its own
baked release identity directly, without Docker access or a version environment
override. Local server development without that identity can still install
legacy content, but deliberately cannot bypass declared runtime requirements.

Browser installation is **new-skill-only**: the whole dependency graph is checked
before any copying, and an active or disabled destination causes a 409 response
directing the operator to the managed CLI. The browser never overwrites or
re-enables an existing skill. New destinations are reserved exclusively to avoid
merging into a directory created after preflight. Updates/forks/rebases remain
managed CLI operations.

Feature manifests, profiles, and skill requirements use typed, full YAML decoding
(including block/flow syntax, aliases, and merge keys). `requires.python` and
`requires.bun` are relative **manifest paths**, not arrays of package names.
The catalog schema now matches those existing environment-manifest semantics;
unsupported arrays fail explicitly instead of disappearing during CLI parsing.

Rejected compatibility checks do not alter installed workspace files, skills,
imported packages, or provenance. Catalog discovery/sync and temporary extraction
may happen before a check. Preflight is not a general transaction: subsequent
I/O/provisioning failures still follow existing operation behavior.

## Release and rollout checklist

1. Choose a new OpenLia release version when introducing capabilities that newer
   templates require. Do not reuse a version that older incompatible images also
   report. Update `release/manifest.json` through the normal release process and
   run `make versions-generate` / `make versions-check`.
2. Build and deploy the enforcing, compatible Workspace UI runtime first. Old
   images do not contain the baked identity; a newer CLI alone cannot fix that.
3. Add the actual first compatible version to the affected template manifests,
   update the generated catalog, and publish the template change.
4. Test the exact runtime/templates revisions together using a disposable
   workspace, including rejection against an older target and successful install
   against a compatible one.
5. Install/update templates using the normal preservation/rebase workflow, then
   rerun deployment acceptance before closing the parent issue.

Old operators can ignore new metadata. This guard therefore does not retroactively
protect deployments consuming template `main` through old clients.

## Reproducible catalog selection

`release/manifest.json` now records the official catalog repository and a full
40-character commit SHA. `make versions-generate` updates the Go binding;
`make versions-check` rejects missing/floating pins. With no explicit templates
configuration, sync uses this immutable revision, not `main` or an accidentally
present sibling checkout. The initial pin is
`2ae32cab7f9ad32b164ccb83b9bd711bff0224fe` (merged templates#3, Calendar 0.2.0 and Personal Finance
0.4.0). It is a tested source pairing, not a new OpenLia release announcement.

Supported selections in the deployment's `config.toml`:

```toml
# Development: use the live checkout, including uncommitted edits.
[templates]
repo = "/absolute/path/to/openlia_templates"
# Leave ref unset. A local path on the CLI machine is not an SSH-target path.
```

```toml
# Explicit preview: opt into a moving branch, tag, or full commit SHA.
[templates]
repo = "https://github.com/openlia/templates.git"
ref = "main"
```

A local Git repository with an explicit ref is fetched as a detached immutable
snapshot rather than read live. Custom remote repositories must specify a ref.
Remove old explicit `ref = "main"` overrides to adopt the release default.

`openlia features sync` fetches into a fresh staging directory, validates the
catalog, and only then replaces the cache. Changing source/ref does not pull into
an old repository. Invalid refs, failed fetches, invalid manifests, cycles, stale
feature indexes, or unsafe links leave the previous cache usable. Syncs are
serialized; hooks, interactive credential prompts, and Git's executable `ext::` transport
are disabled. Catalog scripts are never executed by production sync.

Install/update operations hold a shared cache lock across preflight and copying;
a concurrent sync cannot swap in different content after compatibility checks.
Live development checkouts remain intentionally mutable.

Sync persists `.openlia-catalog.json` in the cache. JSON sync/status/install
results expose source, requested ref, resolved revision, content SHA-256, mode,
and dirty state. A local worktree is clearly identified and has a content digest;
its HEAD alone is not evidence of the tested/installed content. Feature and skill
provenance retains the catalog identity used at installation; feature status
separates `installed_catalog` from the currently available `catalog`.

A preserved fork/customized skill does not advance its installed catalog
provenance. Standalone install results expose `outcome`, the managed `skill`
result, installed `catalog`, and `available_catalog`. Feature/profile results
include `skill_results`; a blocked or update-available skill is not reported as
newly installed or reprovisioned.

Before installation, legacy/unidentified caches and caches for a different
configured ref are resynchronized. Existing installed user files are not silently
upgraded by syncing or by changing the release pin.

### Docker bind mounts and previous snapshots

A changed catalog replaces the cache directory. Existing Docker bind mounts keep
the old inode. Sync reports `ui_refresh_required: true` and `previous_cache_dir`;
the old directory is retained so already-running containers do not see deleted
files. Identical-content syncs do not replace the directory, but **do not clear an
outstanding refresh**. Pending state is persisted and cleared only after the
configured running UI reports the active catalog content digest. If Docker/the
UI cannot be verified, the requirement stays outstanding.

Activation uses a flushed journal containing the owned staging/previous paths and
their expected content hashes. Startup/install and sync recover interrupted
activation without a Git fetch: restore the old directory if the replacement
was interrupted, or finish publication/refresh bookkeeping if it completed.
Ambiguous, modified, or unsafe recovery paths fail closed and are left intact for
inspection. Boundary tests cover interruption before/after both renames and
repeated recovery. This is process-interruption recovery, not a guarantee of
transactional durability of every catalog file after filesystem/hardware failure.

Recreate the Workspace UI container using the target deployment's Compose files
and environment (on that target), for example:

```sh
docker compose <the deployment's existing global options> up -d --no-deps --force-recreate workspace-ui
```

A plain `docker restart` is insufficient to replace a bind mount. Retired
`.templates-previous-*` directories can be removed individually **only after**
containers using them have been recreated and the operator no longer needs them
for recovery. Sync never deletes these potentially still-mounted snapshots.

To enforce an operational retention policy after **all** consumers have released
retired mounts, explicitly prune identified, content-verified snapshots:

```sh
openlia features cache-prune --keep 2 --confirm-unmounted
```

At least two retired generations are retained. Pruning takes the exclusive
catalog lock, never targets the active cache, and skips unknown/modified/symlink
directories. The flag is the operator's explicit confirmation about *all*
consumers; it is not an automatic Docker-unmount check. There is intentionally no
background deletion that could invalidate another container's bind mount.

## One-command paired integration

Prerequisites: Go/Bun, installed locked JavaScript dependencies, Python validation
dependencies, native `remind`, and Playwright Chromium. No provider credentials,
Docker deployment, or real workspace is needed.

```sh
python3 -m pip install -r requirements-templates-integration.txt
python3 docker/install-remind.py --prefix "$PWD/.artifacts/remind/06.03.06"
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/workspace-ui browser:install
make templates-integration TEMPLATES_ROOT=../openlia_templates \
  TEMPLATES_INTEGRATION_ARGS="--remind-binary $PWD/.artifacts/remind/06.03.06/bin/remind"
```

Pass `TEMPLATES_INTEGRATION_ARGS="--remind-binary $PWD/.artifacts/remind/06.03.06/bin/remind"`
to Make if the installed binary is not on PATH. The source installer reads the
version/HTTPS URL/SHA-256 from `release/manifest.json`, verifies before extracting
or executing, and builds only the native CLI with no optional Readline linkage.
It requires Python, a C compiler, make, libc/libm, and timezone data; it never
installs a distro Remind package. `--archive` permits an offline source archive
but still requires the exact checksum. An existing unrecognized/corrupt prefix
is never overwritten.

CI, Workspace UI, and Hermes use the same installer and release pin (06.03.06).
Each Docker builder uses its own runtime base to avoid cross-libc assumptions;
no compiler is added to the final image by this build. Both images contain the
exact source archive, license, and build recipe described in THIRD_PARTY_NOTICES.
The provisioner validates available Remind executables and its wrapper rechecks
the version when run; it does not silently accept a different distro binary.
If no executable is available, tool-store registration remains a fail-closed
placeholder, not proof of native installation. Restores migrate old Remind
registration versions to the current release pin.

The runner records the actual executable path/version/hash and verifies native
JSON/NOQUEUE/metadata behavior before acceptance. A wrong version fails early;
the Calendar native server tests run explicitly rather than being skipped. The
report separately records whether a matching corresponding-source archive is
present; a reported version alone is not proof of source provenance.

Alternatively call `python3 scripts/test_templates_integration.py --templates-root
../openlia_templates`. `--remind-binary /path/to/remind` can select an isolated
test dependency without installing it globally.

The runtime-owned runner:

1. Records both HEAD SHAs, dirty states, and working-tree content digests.
2. Copies templates into a temporary directory and validates the catalog/index.
   Runs the actual Go operator against that catalog: sync, every feature and
   skill installation, each profile, and feature package/archive import. Tool
   registration is verified; this does not claim every tool binary was executed.
   Target release identity is simulated without modifying production behavior.
3. Separately installs every feature through the browser service and runs runtime
   OpenUI diagnostics. Both implementations are exercised.
4. Confirms the enforcing implementation rejects a synthetic older target
   identity before changing installed state, using scratch Calendar content.
   This does not claim that old pre-guard binaries enforce new metadata.
5. Validates the installed Calendar workspace, builds/serves the production
   Workspace UI bundle (not a Vite/watch development server), and runs its native real-backend
   create/cancel/reload/reopen browser journey on desktop and mobile using the
actual catalog layout, not the runtime's duplicated fixture.

Add `--docker` to the Python command (or
`TEMPLATES_INTEGRATION_ARGS=--docker` to Make) to verify real bind-mount
replacement/repeated-sync/recreation behavior using an isolated, uniquely named
Compose project with a digest-pinned Alpine consumer and no network/host ports.
It mounts only temporary test data, and removes its own containers afterward.
The paired GitHub workflow enables this check. It is not a full Workspace UI
image build or a production deployment test.

The runner strips deployment-selection/credential environment variables, uses
isolated state directories and ephemeral ports, and refuses to reuse an existing
test server. Temporary workspaces are cleaned up. Its JSON report is at
`.artifacts/templates-integration/report.json`; browser evidence is under
`packages/workspace-ui/.playwright/templates-*`.

`--skip-browser` is an explicitly labeled contract-only run, not UI acceptance.
These tests are local/CI pairing evidence, not a Docker image or production
deployment acceptance claim.

### Paired-revision GitHub workflow

`.github/workflows/templates-integration.yml` runs against the release-pinned
catalog for relevant runtime PRs/pushes. Once available on the default branch,
manually dispatch **Runtime and templates integration** with `runtime_ref` and
`templates_ref` to test two unmerged branches/PR heads together. For example:

```sh
gh workflow run templates-integration.yml --repo openlia/openlia \
  -f runtime_ref=refs/pull/181/head \
  -f templates_ref=refs/pull/1/head
```

Replace those example refs with the actual proposed pair. A blank templates ref
uses the selected runtime's release pin. Checkout resolves the requested refs to
SHAs; the report and Actions summary record what actually ran. Link the same run
from both PRs. The workflow has read-only repository permission, no persisted Git
credentials or deployment secrets, and uploads only synthetic test evidence.
It does not publish, merge, install into a deployment, or update release pins.

## Tests

```sh
go test ./operator -run 'TestCompatibility|TestRuntimeMeetsMinimum|TestParseOpenLiaRequirement'
go test ./...
bun run --cwd packages/workspace-ui test:server
```

The tests use synthetic catalogs and a fake Docker executable; no live deployment
or user workspace is touched. They cover version semantics, strict requirement
parsing, target identity, dependency/profile preflight, imports, updates, and
preservation of installed data and metadata on rejection. They are not evidence
of a real Docker image build or production UI acceptance. Sync regression tests
use temporary local Git repositories, not network access. The separate paired
runner above exercises actual catalog content and native browser behavior.
