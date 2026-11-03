# Distributing Minions through features

Minions use the existing feature installer and managed CLI update/rebase flow.
They do not need a separate catalog or installer. This contract distributes
reviewed app source, not a copy of someone's running app instance.

## Package layout

Declare each app as an exact `minions/<slug>` domain in `feature.yaml`:

```yaml
schema: 1
id: fitness
name: Fitness
version: 1.0.0
description: A workout tracker.
domains:
  - path: minions/gym-tracker
    kind: extension
    label: Gym Tracker
    purpose: Record workouts and review progress.
    lifecycle: active -> archived
```

Place distributable files under `workspace/minions/gym-tracker/`. Each app needs
`minion.package.json`, with an explicit, reviewed file list:

```json
{
  "schema": 1,
  "files": [
    "README.md",
    "dashboard.openui",
    "input.openui",
    "input.schema.json",
    "config.schema.json",
    "input.py",
    "main.py",
    "requirements.txt",
    "scripts/summary.py",
    "tests/test_main.py",
    "tests/fixtures/example.json"
  ]
}
```

The manifest itself is included implicitly. Paths name individual files, not
directories or globs, and must stay within the app without symlinks. Include the
README, both OpenUI views, both schemas, exactly one main runtime and its matching
input entrypoint, and tests. Helpers, dependency manifests, lockfiles, templates,
and deliberately reviewed fixtures can be listed too. Scaffolding supplies a
starter manifest; maintain it as the app evolves. Older local apps can still run
without one, but must add one before sharing.

## Source versus instance state

Export never includes `config.json`, `data/`, `state/`, caches, logs, uploads,
temporary directories, virtual environments, installed dependencies, build
outputs, hidden paths, or credential-like filenames—even with `--include-records`
or `include_records: true`. List reviewed test inputs under `tests/fixtures/`,
not a reserved `data/` directory.

A catalog/import package is stricter than a live app: its app directories must
contain only declared portable files. Do not ship local config, state, or
undeclared assets alongside the manifest. Package a live workspace through the
exporter first, rather than treating its app directory as a clean package.

Both exporters reject missing files, unsafe paths, symlinks, oversized files,
and recognized credential patterns. This is **not a privacy guarantee or code
sandbox**: code, tests, README text, schema defaults, and generated dashboards can
still contain personal information. Review every declared file, scrub generated
view snapshots, and inspect the actual archive before sharing. No app scripts,
tests, or app dependency-install hooks run during feature installation.

## Recipient configuration

`config.schema.json` must be a Draft 2020-12 object schema requiring `trigger`.
Schema-local references are supported; external references are not fetched.
On a fresh installation:

1. Resolve explicit root/property defaults and direct nested object properties.
   Defaults inside `$ref` or alternative branches are not inferred.
2. Set `trigger` to `{"on_new_entry": false}` without a cron schedule, regardless
   of the author's trigger default.
3. Write a local `config.json` exclusively, only if those settings validate.
4. Otherwise leave configuration pending. The install response reports
   `minions: [{"id": "gym-tracker", "configuration_required": true}]`.

The recipient supplies missing settings in the app's Configuration tab. Input,
heartbeat, and direct main execution through Workspace UI or the Hermes Minion
tool require valid local configuration. Tests remain an explicit user action.
Automatic trigger preferences are not authorization for external side effects.

## Updates, collisions, and removal

- Browser installation only accepts fresh app destinations. Existing local or
  managed apps are rejected before planned feature writes; use the managed CLI.
- CLI update and repeated install/import use 3-way rebase for managed app code.
  Local configuration and reserved state paths never enter the upstream base or
  merge. Older bases containing those paths are filtered before rebasing.
- Settings are preserved byte-for-byte, even if a new schema requires repair.
  Missing/deleted settings are not regenerated on update. Configure the app
  explicitly before using it; newly added apps on an update may also need setup.
- Code conflicts stage a migration proposal instead of replacing live code.
  Intentional local code deletions are not reseeded after a successful merge;
  obsolete, unconflicted upstream code is removed without deleting app records.
- Feature removal preserves the entire app directory. It does **not** disable
  manual app execution or delete settings/data. Automatic scheduling and a full
  enable/disable lifecycle are separate work; do not claim they are implemented.

CLI archives use a flat feature root. Browser downloads may wrap the feature in
one directory; CLI import accepts either layout and rejects mixed roots,
duplicate entries, traversal, and symlinks.

## Validation and rollout

Run `minion_validate` and app tests before publishing; file-list checks do not
prove that code is correct or safe. The paired templates integration runner
includes Go/TypeScript archive round trips and state-preserving rebase checks.
Before the first stable release, coordinated development previews intentionally
leave `requires.openlia` unset and test exact runtime/catalog commit SHAs together.
This provides no minimum-version guard or compatibility guarantee. For stable
catalog releases, declare the actual first compatible **released** runtime; never
substitute a development version or assumed release number, or move a published
version tag. Do not change a production catalog pin merely to test a local app.
See [development compatibility policy](template-compatibility.md#development-before-the-first-stable-release).

Automatic cron registration, scheduling permissions, retries, concurrency, and
pilot apps remain the next rollout phase. A cron expression in config is not a
registered schedule. See [skill and feature development](skill-and-feature-development.md).
