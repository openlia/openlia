#!/usr/bin/env bash
set -Eeuo pipefail

secret_file=${OPENLIA_SECRET_FILE_IN_CONTAINER:-/run/secrets/hermes-env}
case "$secret_file" in
    /*) ;;
    *) exit 1 ;;
esac
case "$secret_file" in
    *$'\n'*|*$'\r'*|*/../*|*/..|*/./*|*/.) exit 1 ;;
esac

if [[ ! -f "$secret_file" || ! -r "$secret_file" ]]; then
    exit 1
fi

# Emit only dotenv-shaped assignments. Values are intentionally written to
# stdout because Hermes consumes this process output; this helper never logs.
while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    [[ -z "$line" || "$line" == \#* ]] && continue
    case "$line" in
        *=*) ;;
        *) exit 1 ;;
    esac

    key=${line%%=*}
    value=${line#*=}
    case "$key" in
        ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) exit 1 ;;
    esac
    [[ -n "$value" ]] || continue
    case "$key" in
        BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|PATH|PYTHONPATH|NODE_OPTIONS|SHELL|\
        HERMES_HOME|HERMES_ENV|HERMES_CONFIG|HERMES_TIMEZONE|HERMES_YOLO_MODE|HERMES_INTERACTIVE|HERMES_EXEC_ASK) exit 1 ;;
    esac
    if [[ "$key" == COPILOT_GITHUB_TOKEN ]]; then
        case "$value" in
            gho_*|github_pat_*|ghu_*) ;;
            *) exit 1 ;;
        esac
    fi
    printf '%s=%s\n' "$key" "$value"
done < "$secret_file"
