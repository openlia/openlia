# Smoke Tests

The smoke runner (`tests/smoke.py`) has three documented modes:

- `--mode cli` exercises the local CLI, embedded release assets, Compose syntax, and shell syntax with synthetic data.
- `--mode local` deploys the current checkout locally via Docker Compose, exercises the lifecycle (`deploy`, `status`, `stop`, `start`, `uninstall`), and removes the disposable installation.
- `--mode live` deploys the current checkout to an explicitly named disposable target and waits for manual Telegram confirmation. Add `--local` to use the local CLI backend. See [`docs/e2e-drills.md`](../docs/e2e-drills.md) for a step-by-step operational runbook using `openlia_dev`.

The runner reports `PASS`, `FAIL`, or `N/A`. `N/A` means a prerequisite or interactive confirmation was unavailable; it is not evidence that the check passed. The process exit code fails only when a case is `FAIL`.

---

## Local Smoke

Run the safe local gate from the repository root:

```sh
python3 tests/smoke.py --mode cli
# Or:
make smoke
```

The CLI gate does not contact a provider, Telegram, or Locho.

Run the real local deployment smoke with Docker Engine on Linux or Docker Desktop on macOS:

```sh
python3 tests/smoke.py --mode local \
  --root /tmp/openlia_smoke \
  --project openlia_smoke
# Or:
make smoke-local
```

This invokes `openlia deploy`, checks health (`openlia status`), stops and starts the stack, checks the bundled secret helper and runtime environment inside Hermes, and invokes `openlia uninstall --local`. It uses an empty synthetic secret source and does not contact a provider or Telegram.

The root must not already exist. Local mode always attempts cleanup after the run; if deployment or uninstall fails, the root is left in place for inspection rather than being removed by the Python harness. Docker images and build cache are preserved.

---

## Live Smoke

Live mode requires every deployment input. It has no target, project, root, or Locho-host defaults. Remote mode requires `--target`; local mode requires `--local`. The only optional behavior is `--cleanup`, which defaults to `false`.

The source files contain credentials and Locho capabilities. The runner changes both source files to mode `0600`, stages protected temporary copies outside the checkout, and never prints their values. The source files must be regular files outside the checkout. Reports are redacted but may still contain operational data; keep them outside the repository.

The current live smoke configuration uses Copilot as its primary provider and requires `COPILOT_GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_USERS`. Do not include `OPENAI_BASE_URL`; gateway URLs belong in the configured `fallback_providers` entries instead.

Run against a disposable Linux target with external local inputs:

```sh
python3 tests/smoke.py --mode live \
  --target user@example.invalid \
  --project openlia_smoke \
  --root /srv/openlia-smoke \
  --env-file "$HOME/.config/openlia/dev/openlia_dev.env" \
  --attachments-file "$HOME/.config/openlia/dev/locho-attachments.toml" \
  --locho-host genai
```

The same provider-backed checks can use the local backend:

```sh
make smoke-local-live \
  OPENLIA_SMOKE_ENV_FILE="$HOME/.config/openlia/dev/openlia_dev.env" \
  OPENLIA_SMOKE_ATTACHMENTS_FILE="$HOME/.config/openlia/dev/locho-attachments.toml" \
  OPENLIA_SMOKE_LOCHO_HOST=genai
```

---

## Deployment Uninstall

Use `openlia uninstall` when removing an existing deployment outside a smoke run. It removes Compose containers, the project network, and the marked OpenLia installation root. Docker images and build cache are preserved.

```sh
openlia uninstall --config ~/.config/openlia/dev/config.toml --non-interactive --json
```

Uninstall refuses broad paths, symlink roots, and roots without the OpenLia runtime marker.
