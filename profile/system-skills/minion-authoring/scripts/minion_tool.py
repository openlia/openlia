#!/usr/bin/env python3
"""Deterministic scaffolding, validation, and execution helper for OpenLia Minions."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import jsonschema

SCRIPT_DIR = Path(__file__).resolve().parent
VALIDATE_WORKSPACE_DIR = (
    SCRIPT_DIR.parent.parent / "workspace-template-customization" / "scripts"
)
if str(VALIDATE_WORKSPACE_DIR) not in sys.path:
    sys.path.insert(0, str(VALIDATE_WORKSPACE_DIR))

from openui_validation import validate_openui_source  # noqa: E402

MINION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DEFAULT_HEARTBEAT_SCHEDULE = "0 */6 * * *"
OPENUI_FIELD_NAME_RE = re.compile(
    r'\b(?:Input|Select)\s*\([^)]*?\bname\s*:\s*"([^"]+)"'
)


def humanize_minion_id(minion_id: str) -> str:
    return " ".join(
        part.capitalize() for part in re.split(r"[-_]+", minion_id) if part
    )


def validate_minion_id(minion_id: str) -> str:
    cleaned = (minion_id or "").strip()
    if not MINION_ID_RE.match(cleaned):
        raise ValueError(
            "invalid minion id (expected lowercase alphanumeric and hyphens)"
        )
    return cleaned


def validate_trigger_spec(
    trigger_val: Any,
    fallback_schedule: str = DEFAULT_HEARTBEAT_SCHEDULE,
) -> tuple[bool, list[str], dict[str, Any]]:
    if trigger_val is None:
        return (
            False,
            ["missing required property 'trigger'"],
            {"after_entry": True, "heartbeat_schedule": fallback_schedule},
        )

    if isinstance(trigger_val, str):
        trimmed = trigger_val.strip()
        if trimmed == "entry":
            return True, [], {"after_entry": True}
        if trimmed == "cron":
            return (
                True,
                [],
                {"after_entry": False, "heartbeat_schedule": fallback_schedule},
            )
        if trimmed == "both":
            return (
                True,
                [],
                {"after_entry": True, "heartbeat_schedule": fallback_schedule},
            )
        return (
            False,
            ["trigger string must be one of 'entry', 'cron', or 'both'"],
            {"after_entry": True, "heartbeat_schedule": fallback_schedule},
        )

    if isinstance(trigger_val, dict):
        errors: list[str] = []
        for key in trigger_val:
            if key not in ("on_new_entry", "cron"):
                errors.append(
                    f"trigger.{key}: unrecognized property (allowed: 'on_new_entry', 'cron')"
                )
        has_entry = "on_new_entry" in trigger_val and trigger_val["on_new_entry"] is not None
        has_cron = "cron" in trigger_val and trigger_val["cron"] is not None
        if not has_entry and not has_cron:
            errors.append(
                "trigger must specify 'on_new_entry' (boolean) and/or 'cron' (non-empty string)"
            )
        after_entry = False
        if has_entry:
            if not isinstance(trigger_val["on_new_entry"], bool):
                errors.append("trigger.on_new_entry must be a boolean")
            else:
                after_entry = trigger_val["on_new_entry"]
        heartbeat_schedule: str | None = None
        if has_cron:
            if not isinstance(trigger_val["cron"], str) or not trigger_val["cron"].strip():
                errors.append("trigger.cron must be a non-empty cron expression string")
            else:
                heartbeat_schedule = trigger_val["cron"].strip()
        resolved: dict[str, Any] = {"after_entry": after_entry}
        if heartbeat_schedule:
            resolved["heartbeat_schedule"] = heartbeat_schedule
        return len(errors) == 0, errors, resolved

    return (
        False,
        [
            "trigger must be 'entry' | 'cron' | 'both' or an object with 'on_new_entry' and/or 'cron'"
        ],
        {"after_entry": True, "heartbeat_schedule": fallback_schedule},
    )


def validate_minion_config(
    config_obj: Any,
    config_schema: dict[str, Any] | None = None,
    fallback_schedule: str = DEFAULT_HEARTBEAT_SCHEDULE,
) -> tuple[bool, list[str], dict[str, Any]]:
    if not isinstance(config_obj, dict):
        return (
            False,
            ["config root must be a JSON object"],
            {"after_entry": True, "heartbeat_schedule": fallback_schedule},
        )

    errors: list[str] = []
    trigger_ok, trigger_errors, resolved_triggers = validate_trigger_spec(
        config_obj.get("trigger"), fallback_schedule
    )
    if not trigger_ok:
        errors.extend(trigger_errors)

    if isinstance(config_schema, dict):
        try:
            validator_cls = jsonschema.validators.validator_for(config_schema)
            validator_cls.check_schema(config_schema)
            validator = validator_cls(
                config_schema, format_checker=jsonschema.FormatChecker()
            )
            for err in sorted(validator.iter_errors(config_obj), key=str):
                if (
                    err.validator == "required"
                    and "'trigger'" in err.message
                    and not trigger_ok
                ):
                    continue
                loc = ".".join(str(p) for p in err.absolute_path) or "config"
                errors.append(f"{loc}: {err.message}")
        except Exception as exc:
            errors.append(f"config.schema.json validation error: {exc}")

    return len(errors) == 0, errors, resolved_triggers


def extract_openui_input_field_names(openui_code: str) -> list[str]:
    seen: list[str] = []
    for match in OPENUI_FIELD_NAME_RE.finditer(openui_code):
        name = match.group(1).strip()
        if name and name not in seen:
            seen.append(name)
    return seen


def scaffold_minion(
    workspace_root: Path | str,
    minion_id: str,
    name: str = "",
    description: str = "",
    runtime: str = "python",
    heartbeat_schedule: str = DEFAULT_HEARTBEAT_SCHEDULE,
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    valid_id = validate_minion_id(minion_id)
    display_name = name.strip() if isinstance(name, str) and name.strip() else humanize_minion_id(valid_id)
    desc = (
        description.strip()
        if isinstance(description, str) and description.strip()
        else f"Track {display_name.lower()} entries with structured input validation, post-entry analysis, and heartbeat enrichment."
    )
    rt = "typescript" if runtime == "typescript" else "python"
    schedule = (
        heartbeat_schedule.strip()
        if isinstance(heartbeat_schedule, str) and heartbeat_schedule.strip()
        else DEFAULT_HEARTBEAT_SCHEDULE
    )

    minion_dir = (root / "minions" / valid_id).resolve()
    if not str(minion_dir).startswith(str((root / "minions").resolve()) + os.sep):
        raise ValueError("invalid minion path")
    if minion_dir.exists():
        raise FileExistsError(f"minion already exists: minions/{valid_id}")

    (minion_dir / "data").mkdir(parents=True, exist_ok=True)
    (minion_dir / "scripts").mkdir(parents=True, exist_ok=True)
    (minion_dir / "tests").mkdir(parents=True, exist_ok=True)

    input_cmd = (
        "python3 input.py --data '{\"item\": \"...\"}'"
        if rt == "python"
        else "bun input.ts --data '{\"item\": \"...\"}'"
    )
    main_hb_cmd = (
        "python3 main.py --trigger heartbeat"
        if rt == "python"
        else "bun main.ts --trigger heartbeat"
    )
    main_entry_cmd = (
        "python3 main.py --trigger entry --entry '{\"item\": \"...\"}'"
        if rt == "python"
        else "bun main.ts --trigger entry --entry '{\"item\": \"...\"}'"
    )

    readme_content = f"""---
name: {json.dumps(display_name)}
description: {json.dumps(desc)}
triggers:
  after_entry: true
  heartbeat_schedule: {json.dumps(schedule)}
quick_actions:
  - id: add
    label: Add Entry
    placeholder: {json.dumps(f"Add new item to {display_name}...")}
  - id: heartbeat
    label: Run Heartbeat
    description: Enrich data and refresh dashboard.openui on heartbeat trigger
---
# {display_name}

{desc}

## Architecture

- **Dashboard (`dashboard.openui`)**: Main dashboard view rendered from `data/items.json` and `data/context.json`.
- **Input Form (`input.openui`)**: OpenUI input form validated against `input.schema.json` and processed by `{"input.py" if rt == "python" else "input.ts"}`.
- **Input Schema (`input.schema.json`)**: JSON Schema contract for new entries.
- **Configuration (`config.json` & `config.schema.json`)**: `config.json` holds local instance configuration with the required OpenLia/Hermes `trigger` field plus any Minion-specific settings (validated by `config.schema.json`; when packaged for sharing, `config.json` is ignored and only `config.schema.json` is packaged).
- **Data & Enrichment (`{"main.py" if rt == "python" else "main.ts"}`)**: Triggered in two ways:
  1. **Post-entry trigger (`{main_entry_cmd}`)**: Runs automatically after every new entry to analyze the entry in context and refresh `dashboard.openui`.
  2. **Heartbeat trigger (`{main_hb_cmd}`)**: Runs on a cron job (`{schedule}`) or manual trigger to enrich data and refresh `dashboard.openui`.

## CLI Usage

- **Record Input**: `{input_cmd}`
- **Post-Entry Analysis**: `{main_entry_cmd}`
- **Heartbeat Enrichment**: `{main_hb_cmd}`
"""
    (minion_dir / "README.md").write_text(readme_content, encoding="utf-8")

    config_schema_obj = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": f"{display_name} Configuration",
        "type": "object",
        "required": ["trigger"],
        "additionalProperties": True,
        "properties": {
            "trigger": {
                "description": "OpenLia/Hermes trigger configuration for main entrypoint",
                "oneOf": [
                    {
                        "type": "string",
                        "enum": ["entry", "cron", "both"],
                    },
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "on_new_entry": {
                                "type": "boolean",
                                "default": True,
                                "description": "Run main right after input.py/input.ts records a new entry",
                            },
                            "cron": {
                                "type": "string",
                                "description": "5-field cron expression for periodic heartbeat trigger",
                            },
                        },
                    },
                ],
            }
        },
    }
    (minion_dir / "config.schema.json").write_text(
        json.dumps(config_schema_obj, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    config_obj = {
        "trigger": {
            "on_new_entry": True,
            "cron": schedule,
        }
    }
    (minion_dir / "config.json").write_text(
        json.dumps(config_obj, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    input_schema_obj = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": f"{display_name} Input",
        "type": "object",
        "additionalProperties": False,
        "required": ["item"],
        "properties": {
            "date": {
                "type": "string",
                "format": "date",
                "title": "Date",
                "description": "Entry date (YYYY-MM-DD)",
            },
            "item": {
                "type": "string",
                "minLength": 1,
                "title": "Entry",
                "description": "Primary activity, metric, or note to record",
            },
            "category": {
                "type": "string",
                "title": "Category",
                "default": "general",
            },
            "value": {
                "type": ["number", "string"],
                "title": "Performance / Value",
                "description": "Optional numeric score, weight, amount, or performance metric",
            },
            "status": {
                "type": "string",
                "enum": ["active", "completed", "planned"],
                "default": "active",
                "title": "Status",
            },
            "notes": {
                "type": "string",
                "title": "Notes",
                "description": "Optional context or observations",
            },
        },
    }
    (minion_dir / "input.schema.json").write_text(
        json.dumps(input_schema_obj, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    input_openui = "\n".join(
        [
            "Card(children: [",
            f'  CardHeader(title: {json.dumps(f"Record {display_name} Entry")}, subtitle: "Validated by input.schema.json -> saved via input handler -> analyzed by main"),',
            '  Form(name: "minionInput", fields: [',
            '    FormControl(label: "Entry", input: Input(name: "item", placeholder: "Describe performance, activity, or item...", rules: {required: true})),',
            '    FormControl(label: "Category", input: Input(name: "category", placeholder: "general")),',
            '    FormControl(label: "Performance / Value", input: Input(name: "value", type: "number", placeholder: "Optional metric or score")),',
            '    FormControl(label: "Status", input: Select(name: "status", placeholder: "Select status...", items: [SelectItem(value: "active", label: "Active"), SelectItem(value: "completed", label: "Completed"), SelectItem(value: "planned", label: "Planned")])),',
            '    FormControl(label: "Notes", input: Input(name: "notes", placeholder: "Optional context or observations"))',
            "  ], buttons: Buttons(buttons: [",
            '    Button(label: "Submit Entry", variant: "primary")',
            "  ]))",
            "])",
            "",
        ]
    )
    (minion_dir / "input.openui").write_text(input_openui, encoding="utf-8")

    today_iso = dt.date.today().isoformat()
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    initial_rec = "Log your next entry to generate a tailored recommendation based on today's performance."
    starter_items = [
        {
            "date": today_iso,
            "item": f"Sample {display_name} entry",
            "category": "general",
            "status": "active",
            "recommendation": initial_rec,
        }
    ]
    (minion_dir / "data" / "items.json").write_text(
        json.dumps(starter_items, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    starter_context = {
        "last_trigger": "init",
        "updated_at": now_iso,
        "summary": "1 total entry (1 active).",
        "latest_recommendation": initial_rec,
        "enrichment": {
            "status": "ready",
            "last_heartbeat_at": now_iso,
            "note": "Heartbeat enriches context (e.g., news, prices, or periodic summaries).",
        },
    }
    (minion_dir / "data" / "context.json").write_text(
        json.dumps(starter_context, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    callout_desc = f"{starter_context['summary']} Next recommendation: {starter_context['latest_recommendation']}"
    cols = '[{"key": "date", "label": "Date"}, {"key": "item", "label": "Item"}, {"key": "category", "label": "Category"}, {"key": "status", "label": "Status"}, {"key": "recommendation", "label": "Recommendation"}]'
    dashboard_openui = (
        "Stack(children: [\n"
        f'  Callout(variant: "info", title: "Context & Recommendations", description: {json.dumps(callout_desc)}),\n'
        f"  Table(title: {json.dumps(display_name)}, columns: {cols}, rows: {json.dumps(starter_items, ensure_ascii=False)})\n"
        "])\n"
    )
    (minion_dir / "dashboard.openui").write_text(dashboard_openui, encoding="utf-8")

    if rt == "python":
        (minion_dir / "requirements.txt").write_text(
            "# Add Python dependencies for this Minion\n", encoding="utf-8"
        )
        input_py = """#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "items.json"
SCHEMA_FILE = ROOT / "input.schema.json"


def load_schema() -> dict[str, Any]:
    if not SCHEMA_FILE.exists():
        return {}
    return json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))


def load_items() -> list[dict[str, Any]]:
    if not DATA_FILE.exists():
        return []
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def save_items(items: list[dict[str, Any]]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(
        json.dumps(items, indent=2, ensure_ascii=False) + "\\n",
        encoding="utf-8",
    )


def validate_payload(payload: dict[str, Any], schema: dict[str, Any] | None = None) -> dict[str, Any]:
    active_schema = schema if schema is not None else load_schema()
    if not isinstance(payload, dict):
        raise ValueError("Input payload must be a JSON object")

    props = active_schema.get("properties", {}) if isinstance(active_schema, dict) else {}
    required = active_schema.get("required", []) if isinstance(active_schema, dict) else []
    additional_ok = active_schema.get("additionalProperties", True) if isinstance(active_schema, dict) else True

    cleaned: dict[str, Any] = {}
    for key, val in payload.items():
        if val is None or (isinstance(val, str) and val.strip() == "" and key not in required):
            continue
        cleaned[key] = val.strip() if isinstance(val, str) else val

    for key, prop_spec in props.items():
        if key not in cleaned and isinstance(prop_spec, dict) and "default" in prop_spec:
            cleaned[key] = prop_spec["default"]

    for req_key in required:
        val = cleaned.get(req_key)
        if val is None or (isinstance(val, str) and not val.strip()):
            raise ValueError(f"Missing required field: '{req_key}'")

    if additional_ok is False and props:
        unknown = [k for k in cleaned if k not in props]
        if unknown:
            raise ValueError(f"Unrecognized input field(s): {', '.join(unknown)}")

    for key, val in list(cleaned.items()):
        prop_spec = props.get(key)
        if not isinstance(prop_spec, dict):
            continue
        enum_vals = prop_spec.get("enum")
        if isinstance(enum_vals, list) and val not in enum_vals:
            raise ValueError(f"Invalid value for '{key}': expected one of {enum_vals}")

    return cleaned


def record_entry(raw_payload: dict[str, Any], today: str | None = None) -> dict[str, Any]:
    validated = validate_payload(raw_payload)
    entry: dict[str, Any] = {
        "date": str(validated.get("date") or today or dt.date.today().isoformat()),
        "item": str(validated["item"]).strip(),
        "category": str(validated.get("category") or "general"),
        "status": str(validated.get("status") or "active"),
    }
    if "value" in validated and validated["value"] not in (None, ""):
        entry["value"] = validated["value"]
    if "notes" in validated and validated["notes"]:
        entry["notes"] = str(validated["notes"])
    for extra_key, extra_val in validated.items():
        if extra_key not in entry:
            entry[extra_key] = extra_val

    items = load_items()
    items.append(entry)
    save_items(items)
    return entry


def parse_cli_payload(data_arg: str = "", input_arg: str = "") -> dict[str, Any]:
    raw_json = data_arg.strip() or os.environ.get("OPENLIA_MINION_INPUT_JSON", "").strip()
    if raw_json:
        parsed = json.loads(raw_json)
        if not isinstance(parsed, dict):
            raise ValueError("Expected JSON object for --data")
        return parsed
    text = input_arg.strip() or os.environ.get("OPENLIA_MINION_INPUT", "").strip()
    if text:
        if text.startswith("{") and text.endswith("}"):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
        return {"item": text}
    raise ValueError("No input payload provided (pass --data '<json>' or --input '<text>')")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate and record a new Minion entry")
    parser.add_argument("--data", default="", help="JSON object conforming to input.schema.json")
    parser.add_argument("--input", default="", help="Quick text entry mapped to item")
    args = parser.parse_args()

    payload = parse_cli_payload(args.data, args.input)
    entry = record_entry(payload)
    items = load_items()
    print(f"Added entry ({len(items)} total): {entry.get('item', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
"""
        (minion_dir / "input.py").write_text(input_py, encoding="utf-8")

        main_py = f"""#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
from typing import Any

import input as minion_input

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "items.json"
CONTEXT_FILE = ROOT / "data" / "context.json"
CONFIG_FILE = ROOT / "config.json"
CONFIG_SCHEMA_FILE = ROOT / "config.schema.json"
DASHBOARD_FILE = ROOT / "dashboard.openui"
LEGACY_UI_FILE = ROOT / "ui.openui"
TITLE = {json.dumps(display_name)}


def load_config() -> dict[str, Any]:
    raw_env = os.environ.get("OPENLIA_MINION_CONFIG_JSON", "").strip()
    if raw_env:
        try:
            parsed = json.loads(raw_env)
            if isinstance(parsed, dict) and "trigger" in parsed:
                return parsed
        except Exception:
            pass
    if not CONFIG_FILE.exists():
        return {{"trigger": {{"on_new_entry": True, "cron": {json.dumps(schedule)}}}}}
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    if not isinstance(cfg, dict) or "trigger" not in cfg:
        raise ValueError("config.json must be a JSON object containing 'trigger'")
    return cfg


def load_items() -> list[dict[str, Any]]:
    return minion_input.load_items()


def save_items(items: list[dict[str, Any]]) -> None:
    minion_input.save_items(items)


def load_context() -> dict[str, Any]:
    if not CONTEXT_FILE.exists():
        return {{}}
    try:
        return json.loads(CONTEXT_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {{}}


def save_context(context: dict[str, Any]) -> None:
    CONTEXT_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONTEXT_FILE.write_text(
        json.dumps(context, indent=2, ensure_ascii=False) + "\\n",
        encoding="utf-8",
    )


def build_recommendation(entry: dict[str, Any], items: list[dict[str, Any]]) -> str:
    today = str(entry.get("date") or dt.date.today().isoformat())
    today_items = [row for row in items if str(row.get("date")) == today]
    category = str(entry.get("category") or "general")
    value = entry.get("value")
    if value not in (None, ""):
        return (
            f"Recorded {{entry.get('item')}} (metric: {{value}}) in '{{category}}'. "
            f"{{len(today_items)}} entry(s) logged on {{today}}—consider progressive overload or a complementary recovery/follow-up session next."
        )
    return (
        f"Logged '{{entry.get('item')}}' under '{{category}}' ({{len(today_items)}} today, {{len(items)}} total). "
        f"Next step: review progress or schedule your next '{{category}}' follow-up."
    )


def render_dashboard(
    items: list[dict[str, Any]],
    context: dict[str, Any] | None = None,
) -> str:
    ctx = context if context is not None else load_context()
    active_count = sum(1 for row in items if row.get("status", "active") == "active")
    summary = str(ctx.get("summary") or f"{{len(items)}} total entries ({{active_count}} active).")
    latest_rec = str(
        ctx.get("latest_recommendation")
        or (items[-1].get("recommendation") if items else "")
        or "Log an entry or run heartbeat to update recommendations."
    )
    callout_desc = f"{{summary}} Next recommendation: {{latest_rec}}"
    cols = '[{{"key": "date", "label": "Date"}}, {{"key": "item", "label": "Item"}}, {{"key": "category", "label": "Category"}}, {{"key": "status", "label": "Status"}}, {{"key": "recommendation", "label": "Recommendation"}}]'
    rows = json.dumps(items, ensure_ascii=False)
    content = (
        "Stack(children: [\\n"
        f'  Callout(variant: "info", title: "Context & Recommendations", description: {{json.dumps(callout_desc)}}),\\n'
        f"  Table(title: {{json.dumps(TITLE)}}, columns: {{cols}}, rows: {{rows}})\\n"
        "])\\n"
    )
    DASHBOARD_FILE.write_text(content, encoding="utf-8")
    if LEGACY_UI_FILE.exists():
        LEGACY_UI_FILE.write_text(content, encoding="utf-8")
    return content


def render_ui(items: list[dict[str, Any]]) -> str:
    return render_dashboard(items)


def analyze_new_entry(
    entry: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    active_config = config if isinstance(config, dict) else load_config()
    items = load_items()
    target = entry if isinstance(entry, dict) and entry else (items[-1] if items else {{}})
    recommendation = build_recommendation(target, items)
    if items:
        items[-1]["recommendation"] = recommendation
        save_items(items)

    active_count = sum(1 for row in items if row.get("status", "active") == "active")
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    ctx = load_context()
    ctx.update({{
        "last_trigger": "entry",
        "updated_at": now_iso,
        "trigger_config": active_config.get("trigger"),
        "summary": f"{{len(items)}} total entries ({{active_count}} active).",
        "latest_entry": target,
        "latest_recommendation": recommendation,
    }})
    save_context(ctx)
    render_dashboard(items, ctx)
    return ctx


def run_heartbeat(config: dict[str, Any] | None = None) -> dict[str, Any]:
    active_config = config if isinstance(config, dict) else load_config()
    items = load_items()
    active_count = sum(1 for row in items if row.get("status", "active") == "active")
    completed_count = sum(1 for row in items if row.get("status") == "completed")
    categories = sorted({{str(row.get("category") or "general") for row in items}})
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()

    ctx = load_context()
    latest_rec = str(
        ctx.get("latest_recommendation")
        or (items[-1].get("recommendation") if items else "")
        or "All caught up. Add a new entry to trigger post-entry analysis."
    )
    ctx.update({{
        "last_trigger": "heartbeat",
        "updated_at": now_iso,
        "trigger_config": active_config.get("trigger"),
        "summary": f"{{len(items)}} total entries ({{active_count}} active, {{completed_count}} completed).",
        "latest_recommendation": latest_rec,
        "enrichment": {{
            "status": "enriched",
            "last_heartbeat_at": now_iso,
            "categories": categories,
            "total_entries": len(items),
            "active_entries": active_count,
        }},
    }})
    save_context(ctx)
    render_dashboard(items, ctx)
    return ctx


def add_entry(text: str, today: str | None = None) -> list[dict[str, Any]]:
    entry = minion_input.record_entry({{"item": text.strip()}}, today=today)
    analyze_new_entry(entry)
    return load_items()


def main() -> int:
    parser = argparse.ArgumentParser(description=TITLE)
    parser.add_argument("--trigger", choices=["heartbeat", "entry"], default="")
    parser.add_argument("--entry", default="", help="JSON payload of the newly recorded entry")
    parser.add_argument("--action", default="")
    parser.add_argument("--input", default="")
    args = parser.parse_args()

    direct_input = args.input.strip()
    trigger = (
        args.trigger.strip()
        or os.environ.get("OPENLIA_MINION_TRIGGER", "").strip()
        or ("heartbeat" if args.action.strip() == "heartbeat" else "")
    )

    if direct_input and trigger != "entry":
        items = add_entry(direct_input)
        print(f"Added entry ({{len(items)}} total): {{direct_input}}")
        return 0

    if trigger == "entry":
        raw_entry = args.entry.strip() or os.environ.get("OPENLIA_MINION_ENTRY_JSON", "").strip()
        parsed_entry: dict[str, Any] | None = None
        if raw_entry:
            try:
                candidate = json.loads(raw_entry)
                if isinstance(candidate, dict):
                    parsed_entry = candidate
            except Exception:
                parsed_entry = None
        ctx = analyze_new_entry(parsed_entry)
        items = load_items()
        print(f"Post-entry analysis complete ({{len(items)}} total): {{ctx.get('latest_recommendation', '')}}")
        return 0

    ctx = run_heartbeat()
    items = load_items()
    print(f"Heartbeat enrichment complete ({{len(items)}} entries): {{ctx.get('summary', '')}}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
"""
        (minion_dir / "main.py").write_text(main_py, encoding="utf-8")

        test_py = """import unittest
import input as minion_input
import main


class MinionTests(unittest.TestCase):
    def test_load_and_render_dashboard(self):
        items = main.load_items()
        self.assertIsInstance(items, list)
        ui = main.render_dashboard(items)
        self.assertIn("Table(", ui)
        self.assertIn("Callout(", ui)

    def test_schema_validation(self):
        schema = minion_input.load_schema()
        self.assertEqual(schema.get("type"), "object")
        validated = minion_input.validate_payload({"item": "Test workout"}, schema)
        self.assertEqual(validated["item"], "Test workout")
        with self.assertRaises(ValueError):
            minion_input.validate_payload({}, schema)

    def test_config_contract(self):
        cfg = main.load_config()
        self.assertIsInstance(cfg, dict)
        self.assertIn("trigger", cfg)


if __name__ == "__main__":
    unittest.main()
"""
        (minion_dir / "tests" / "test_main.py").write_text(test_py, encoding="utf-8")
    else:
        (minion_dir / "package.json").write_text(
            json.dumps(
                {
                    "name": f"minion-{valid_id}",
                    "version": "0.1.0",
                    "private": True,
                    "type": "module",
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        input_ts = """import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MinionItem {
  date: string;
  item: string;
  category?: string;
  value?: number | string;
  status: string;
  notes?: string;
  recommendation?: string;
  [key: string]: unknown;
}

const ROOT = import.meta.dir;
export const DATA_FILE = join(ROOT, "data", "items.json");
export const SCHEMA_FILE = join(ROOT, "input.schema.json");

export function loadSchema(): Record<string, unknown> {
  if (!existsSync(SCHEMA_FILE)) return {};
  return JSON.parse(readFileSync(SCHEMA_FILE, "utf-8")) as Record<string, unknown>;
}

export function loadItems(): MinionItem[] {
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8")) as MinionItem[];
}

export function saveItems(items: MinionItem[]): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(items, null, 2) + "\\n", "utf-8");
}

export function validatePayload(
  payload: Record<string, unknown>,
  schema: Record<string, unknown> = loadSchema(),
): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Input payload must be a JSON object");
  }
  const props =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  const additionalOk = schema.additionalProperties !== false;

  const cleaned: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (
      val === undefined ||
      val === null ||
      (typeof val === "string" && val.trim() === "" && !required.includes(key))
    ) {
      continue;
    }
    cleaned[key] = typeof val === "string" ? val.trim() : val;
  }

  for (const [key, propSpec] of Object.entries(props)) {
    if (!(key in cleaned) && propSpec && "default" in propSpec) {
      cleaned[key] = propSpec.default;
    }
  }

  for (const reqKey of required) {
    const val = cleaned[reqKey];
    if (val === undefined || val === null || (typeof val === "string" && !val.trim())) {
      throw new Error(`Missing required field: '${reqKey}'`);
    }
  }

  if (!additionalOk && Object.keys(props).length > 0) {
    const unknown = Object.keys(cleaned).filter((k) => !(k in props));
    if (unknown.length > 0) {
      throw new Error(`Unrecognized input field(s): ${unknown.join(", ")}`);
    }
  }

  for (const [key, val] of Object.entries(cleaned)) {
    const propSpec = props[key];
    if (propSpec && Array.isArray(propSpec.enum) && !propSpec.enum.includes(val)) {
      throw new Error(`Invalid value for '${key}': expected one of ${propSpec.enum.join(", ")}`);
    }
  }

  return cleaned;
}

export function recordEntry(
  rawPayload: Record<string, unknown>,
  today?: string,
): MinionItem {
  const validated = validatePayload(rawPayload);
  const entry: MinionItem = {
    date: String(validated.date || today || new Date().toISOString().slice(0, 10)),
    item: String(validated.item).trim(),
    category: String(validated.category || "general"),
    status: String(validated.status || "active"),
  };
  if (validated.value !== undefined && validated.value !== "") {
    entry.value = validated.value as number | string;
  }
  if (validated.notes) {
    entry.notes = String(validated.notes);
  }
  for (const [k, v] of Object.entries(validated)) {
    if (!(k in entry)) entry[k] = v;
  }
  const items = loadItems();
  items.push(entry);
  saveItems(items);
  return entry;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dataIdx = args.indexOf("--data");
  const inputIdx = args.indexOf("--input");
  const rawData =
    (dataIdx >= 0 ? args[dataIdx + 1] : process.env.OPENLIA_MINION_INPUT_JSON) ?? "";
  const rawInput =
    (inputIdx >= 0 ? args[inputIdx + 1] : process.env.OPENLIA_MINION_INPUT) ?? "";

  let payload: Record<string, unknown>;
  if (rawData.trim()) {
    payload = JSON.parse(rawData) as Record<string, unknown>;
  } else if (rawInput.trim()) {
    payload = { item: rawInput.trim() };
  } else {
    throw new Error("No input payload provided (pass --data '<json>' or --input '<text>')");
  }

  const entry = recordEntry(payload);
  const items = loadItems();
  console.log(`Added entry (${items.length} total): ${entry.item}`);
}
"""
        (minion_dir / "input.ts").write_text(input_ts, encoding="utf-8")

        main_ts = f"""import {{ existsSync, mkdirSync, readFileSync, writeFileSync }} from "node:fs";
import {{ dirname, join }} from "node:path";
import {{
  loadItems as loadInputItems,
  type MinionItem,
  recordEntry,
  saveItems as saveInputItems,
}} from "./input";

export type {{ MinionItem }};

const ROOT = import.meta.dir;
const CONTEXT_FILE = join(ROOT, "data", "context.json");
const CONFIG_FILE = join(ROOT, "config.json");
const DASHBOARD_FILE = join(ROOT, "dashboard.openui");
const LEGACY_UI_FILE = join(ROOT, "ui.openui");
const TITLE = {json.dumps(display_name)};

export function loadConfig(): Record<string, unknown> {{
  const rawEnv = (process.env.OPENLIA_MINION_CONFIG_JSON ?? "").trim();
  if (rawEnv) {{
    try {{
      const parsed = JSON.parse(rawEnv) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "trigger" in parsed) {{
        return parsed;
      }}
    }} catch {{}}
  }}
  if (!existsSync(CONFIG_FILE)) {{
    return {{ trigger: {{ on_new_entry: true, cron: {json.dumps(schedule)} }} }};
  }}
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || !("trigger" in cfg)) {{
    throw new Error("config.json must be a JSON object containing 'trigger'");
  }}
  return cfg;
}}

export function loadItems(): MinionItem[] {{
  return loadInputItems();
}}

export function saveItems(items: MinionItem[]): void {{
  saveInputItems(items);
}}

export function loadContext(): Record<string, unknown> {{
  if (!existsSync(CONTEXT_FILE)) return {{}};
  try {{
    return JSON.parse(readFileSync(CONTEXT_FILE, "utf-8")) as Record<string, unknown>;
  }} catch {{
    return {{}};
  }}
}}

export function saveContext(ctx: Record<string, unknown>): void {{
  mkdirSync(dirname(CONTEXT_FILE), {{ recursive: true }});
  writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2) + "\\n", "utf-8");
}}

export function buildRecommendation(entry: Partial<MinionItem>, items: MinionItem[]): string {{
  const today = String(entry.date || new Date().toISOString().slice(0, 10));
  const todayItems = items.filter((r) => r.date === today);
  const category = String(entry.category || "general");
  if (entry.value !== undefined && entry.value !== "") {{
    return `Recorded ${{entry.item}} (metric: ${{entry.value}}) in '${{category}}'. ${{todayItems.length}} entry(s) logged on ${{today}}—consider progressive overload or a complementary follow-up next.`;
  }}
  return `Logged '${{entry.item}}' under '${{category}}' (${{todayItems.length}} today, ${{items.length}} total). Next step: review progress or schedule your next '${{category}}' follow-up.`;
}}

export function renderDashboard(
  items: MinionItem[],
  context: Record<string, unknown> = loadContext(),
): string {{
  const activeCount = items.filter((r) => (r.status || "active") === "active").length;
  const summary = String(
    context.summary || `${{items.length}} total entries (${{activeCount}} active).`,
  );
  const latestRec = String(
    context.latest_recommendation ||
      items.at(-1)?.recommendation ||
      "Log an entry or run heartbeat to update recommendations.",
  );
  const calloutDesc = `${{summary}} Next recommendation: ${{latestRec}}`;
  const cols =
    '[{{key: "date", label: "Date"}}, {{key: "item", label: "Item"}}, {{key: "category", label: "Category"}}, {{key: "status", label: "Status"}}, {{key: "recommendation", label: "Recommendation"}}]';
  const content = [
    "Stack(children: [",
    `  Callout(variant: "info", title: "Context & Recommendations", description: ${{JSON.stringify(calloutDesc)}}),`,
    `  Table(title: ${{JSON.stringify(TITLE)}}, columns: ${{cols}}, rows: ${{JSON.stringify(items)}})`,
    "])",
    "",
  ].join("\\n");
  writeFileSync(DASHBOARD_FILE, content, "utf-8");
  if (existsSync(LEGACY_UI_FILE)) {{
    writeFileSync(LEGACY_UI_FILE, content, "utf-8");
  }}
  return content;
}}

export function renderUi(items: MinionItem[]): string {{
  return renderDashboard(items);
}}

export function analyzeNewEntry(
  entry?: Partial<MinionItem>,
  config: Record<string, unknown> = loadConfig(),
): Record<string, unknown> {{
  const items = loadItems();
  const target = entry && Object.keys(entry).length > 0 ? entry : (items.at(-1) ?? {{}});
  const recommendation = buildRecommendation(target, items);
  if (items.length > 0) {{
    items[items.length - 1]!.recommendation = recommendation;
    saveItems(items);
  }}
  const activeCount = items.filter((r) => (r.status || "active") === "active").length;
  const nowIso = new Date().toISOString();
  const ctx: Record<string, unknown> = {{
    ...loadContext(),
    last_trigger: "entry",
    updated_at: nowIso,
    trigger_config: config.trigger,
    summary: `${{items.length}} total entries (${{activeCount}} active).`,
    latest_entry: target,
    latest_recommendation: recommendation,
  }};
  saveContext(ctx);
  renderDashboard(items, ctx);
  return ctx;
}}

export function runHeartbeat(
  config: Record<string, unknown> = loadConfig(),
): Record<string, unknown> {{
  const items = loadItems();
  const activeCount = items.filter((r) => (r.status || "active") === "active").length;
  const completedCount = items.filter((r) => r.status === "completed").length;
  const categories = Array.from(
    new Set(items.map((r) => String(r.category || "general"))),
  ).sort();
  const nowIso = new Date().toISOString();
  const prev = loadContext();
  const latestRec = String(
    prev.latest_recommendation ||
      items.at(-1)?.recommendation ||
      "All caught up. Add a new entry to trigger post-entry analysis.",
  );
  const ctx: Record<string, unknown> = {{
    ...prev,
    last_trigger: "heartbeat",
    updated_at: nowIso,
    trigger_config: config.trigger,
    summary: `${{items.length}} total entries (${{activeCount}} active, ${{completedCount}} completed).`,
    latest_recommendation: latestRec,
    enrichment: {{
      status: "enriched",
      last_heartbeat_at: nowIso,
      categories,
      total_entries: items.length,
      active_entries: activeCount,
    }},
  }};
  saveContext(ctx);
  renderDashboard(items, ctx);
  return ctx;
}}

if (import.meta.main) {{
  const args = process.argv.slice(2);
  const triggerIdx = args.indexOf("--trigger");
  const entryIdx = args.indexOf("--entry");
  const inputIdx = args.indexOf("--input");
  const trigger =
    (triggerIdx >= 0 ? args[triggerIdx + 1] : process.env.OPENLIA_MINION_TRIGGER) ?? "";
  const rawEntry =
    (entryIdx >= 0 ? args[entryIdx + 1] : process.env.OPENLIA_MINION_ENTRY_JSON) ?? "";
  const directInput =
    (inputIdx >= 0 ? args[inputIdx + 1] : "") ?? "";

  if (directInput.trim() && trigger !== "entry") {{
    const entry = recordEntry({{ item: directInput.trim() }});
    analyzeNewEntry(entry);
    const items = loadItems();
    console.log(`Added entry (${{items.length}} total): ${{directInput.trim()}}`);
  }} else if (trigger === "entry") {{
    let parsedEntry: Partial<MinionItem> | undefined;
    if (rawEntry.trim()) {{
      try {{
        parsedEntry = JSON.parse(rawEntry) as Partial<MinionItem>;
      }} catch {{}}
    }}
    const ctx = analyzeNewEntry(parsedEntry);
    const items = loadItems();
    console.log(`Post-entry analysis complete (${{items.length}} total): ${{String(ctx.latest_recommendation ?? "")}}`);
  }} else {{
    const ctx = runHeartbeat();
    const items = loadItems();
    console.log(`Heartbeat enrichment complete (${{items.length}} entries): ${{String(ctx.summary ?? "")}}`);
  }}
}}
"""
        (minion_dir / "main.ts").write_text(main_ts, encoding="utf-8")

        test_ts = """import { expect, test } from "bun:test";
import { loadSchema, validatePayload } from "../input";
import { loadConfig, loadItems, renderDashboard } from "../main";

test("loads items and renders OpenUI dashboard", () => {
  const items = loadItems();
  expect(Array.isArray(items)).toBe(true);
  const ui = renderDashboard(items);
  expect(ui).toContain("Table(");
  expect(ui).toContain("Callout(");
});

test("validates input against input.schema.json", () => {
  const schema = loadSchema();
  expect(schema.type).toBe("object");
  const valid = validatePayload({ item: "Morning run" }, schema);
  expect(valid.item).toBe("Morning run");
  expect(() => validatePayload({}, schema)).toThrow();
});

test("loads config.json with required trigger", () => {
  const cfg = loadConfig();
  expect(typeof cfg).toBe("object");
  expect("trigger" in cfg).toBe(true);
});
"""
        (minion_dir / "tests" / "main.test.ts").write_text(test_ts, encoding="utf-8")

    return {
        "ok": True,
        "status": "ok",
        "id": valid_id,
        "path": f"minions/{valid_id}",
        "name": display_name,
        "runtime": rt,
        "config": config_obj,
        "canonical_uri": f"openlia://minions/{valid_id}",
        "files": sorted(
            str(p.relative_to(minion_dir)).replace("\\", "/")
            for p in minion_dir.rglob("*")
            if p.is_file()
        ),
    }


def validate_minion(workspace_root: Path | str, minion_id: str) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    valid_id = validate_minion_id(minion_id)
    minion_dir = (root / "minions" / valid_id).resolve()
    if not minion_dir.exists() or not minion_dir.is_dir():
        return {
            "status": "error",
            "valid": False,
            "id": valid_id,
            "path": f"minions/{valid_id}",
            "errors": [f"Minion directory minions/{valid_id} does not exist"],
            "warnings": [],
        }

    errors: list[str] = []
    warnings: list[str] = []

    readme_path = minion_dir / "README.md"
    if not readme_path.is_file():
        errors.append("README.md: missing required Minion README.md")

    has_main_py = (minion_dir / "main.py").is_file()
    has_main_ts = (minion_dir / "main.ts").is_file()
    if not has_main_py and not has_main_ts:
        errors.append("main entrypoint: missing required main.py or main.ts")
    runtime = "python" if has_main_py else "typescript"

    has_input_py = (minion_dir / "input.py").is_file()
    has_input_ts = (minion_dir / "input.ts").is_file()
    if not has_input_py and not has_input_ts:
        warnings.append(
            "input entrypoint: missing input.py or input.ts (recommended for structured form input)"
        )

    dashboard_path = minion_dir / "dashboard.openui"
    legacy_ui_path = minion_dir / "ui.openui"
    if not dashboard_path.is_file() and not legacy_ui_path.is_file():
        errors.append("dashboard.openui: missing required dashboard.openui")

    input_ui_path = minion_dir / "input.openui"
    if not input_ui_path.is_file():
        warnings.append("input.openui: missing input.openui form view")

    # Validate config.schema.json and config.json
    config_schema_path = minion_dir / "config.schema.json"
    config_schema: dict[str, Any] | None = None
    if config_schema_path.is_file():
        try:
            parsed_cs = json.loads(config_schema_path.read_text(encoding="utf-8"))
            if not isinstance(parsed_cs, dict):
                errors.append("config.schema.json: root must be a JSON object")
            else:
                validator_cls = jsonschema.validators.validator_for(parsed_cs)
                validator_cls.check_schema(parsed_cs)
                config_schema = parsed_cs
        except Exception as exc:
            errors.append(f"config.schema.json: {exc}")
    else:
        warnings.append(
            "config.schema.json: missing config.schema.json (required for packaging Minions)"
        )

    config_path = minion_dir / "config.json"
    resolved_triggers: dict[str, Any] = {"after_entry": True}
    if config_path.is_file():
        try:
            parsed_cfg = json.loads(config_path.read_text(encoding="utf-8"))
            cfg_ok, cfg_errors, resolved_triggers = validate_minion_config(
                parsed_cfg, config_schema
            )
            if not cfg_ok:
                for err in cfg_errors:
                    errors.append(f"config.json: {err}")
        except Exception as exc:
            errors.append(f"config.json: {exc}")
    else:
        warnings.append(
            "config.json: missing config.json (recommended with required 'trigger' field)"
        )

    # Validate input.schema.json and alignment with input.openui
    input_schema_path = minion_dir / "input.schema.json"
    input_schema: dict[str, Any] | None = None
    if input_schema_path.is_file():
        try:
            parsed_is = json.loads(input_schema_path.read_text(encoding="utf-8"))
            if not isinstance(parsed_is, dict):
                errors.append("input.schema.json: root must be a JSON object")
            else:
                validator_cls = jsonschema.validators.validator_for(parsed_is)
                validator_cls.check_schema(parsed_is)
                input_schema = parsed_is
        except Exception as exc:
            errors.append(f"input.schema.json: {exc}")
    elif has_input_py or has_input_ts or input_ui_path.is_file():
        errors.append("input.schema.json: missing input.schema.json")

    if input_ui_path.is_file() and isinstance(input_schema, dict):
        ui_code = input_ui_path.read_text(encoding="utf-8")
        field_names = extract_openui_input_field_names(ui_code)
        schema_props = input_schema.get("properties")
        if (
            isinstance(schema_props, dict)
            and schema_props
            and input_schema.get("additionalProperties") is False
        ):
            unknown_fields = [f for f in field_names if f not in schema_props]
            if unknown_fields:
                errors.append(
                    f"input.openui: form field(s) {unknown_fields} are not defined in input.schema.json properties ({list(schema_props.keys())})"
                )
        req_fields = input_schema.get("required")
        if isinstance(req_fields, list) and field_names:
            missing_req = [
                r
                for r in req_fields
                if isinstance(r, str)
                and r not in field_names
                and not (
                    isinstance(schema_props, dict)
                    and isinstance(schema_props.get(r), dict)
                    and "default" in schema_props[r]
                )
            ]
            if missing_req:
                warnings.append(
                    f"input.openui: required input.schema.json field(s) {missing_req} have no matching Input/Select control in input.openui"
                )

    # Check .openui syntax on all .openui files
    openui_files: list[str] = []
    for openui_file in sorted(minion_dir.rglob("*.openui")):
        rel_ui = str(openui_file.relative_to(minion_dir)).replace("\\", "/")
        openui_files.append(rel_ui)
        raw_ui = openui_file.read_text(encoding="utf-8")
        for syn_err in validate_openui_source(raw_ui):
            errors.append(f"{rel_ui}: {syn_err}")

    return {
        "ok": len(errors) == 0,
        "status": "ok" if not errors else "error",
        "valid": len(errors) == 0,
        "id": valid_id,
        "path": f"minions/{valid_id}",
        "runtime": runtime,
        "triggers": resolved_triggers,
        "openui_files": openui_files,
        "errors": errors,
        "warnings": warnings,
    }


def _resolve_python_bin(minion_dir: Path) -> str:
    local_venv = minion_dir / ".venv" / "bin" / "python"
    if local_venv.exists():
        return str(local_venv)
    hermes_py = Path("/opt/hermes/.venv/bin/python")
    if hermes_py.exists():
        return str(hermes_py)
    return sys.executable or "python3"


def _run_subprocess(
    cmd: list[str],
    cwd: Path,
    extra_env: dict[str, str],
    timeout: float = 15.0,
) -> dict[str, Any]:
    started = time.time()
    env = {**os.environ, **extra_env}
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
        )
        return {
            "exit_code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "duration_ms": int((time.time() - started) * 1000),
        }
    except subprocess.TimeoutExpired:
        return {
            "exit_code": 124,
            "stdout": "",
            "stderr": f"Timed out after {timeout}s",
            "duration_ms": int((time.time() - started) * 1000),
        }


def run_minion(
    workspace_root: Path | str,
    minion_id: str,
    mode: str = "heartbeat",
    data: dict[str, Any] | None = None,
    input_text: str = "",
    timeout: float = 15.0,
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    valid_id = validate_minion_id(minion_id)
    minion_dir = (root / "minions" / valid_id).resolve()
    if not minion_dir.is_dir():
        raise FileNotFoundError(f"Minion not found: minions/{valid_id}")

    has_main_py = (minion_dir / "main.py").is_file()
    runtime = "python" if has_main_py else "typescript"
    entrypoint = "main.py" if has_main_py else "main.ts"
    input_entrypoint = (
        "input.py"
        if (minion_dir / "input.py").is_file()
        else ("input.ts" if (minion_dir / "input.ts").is_file() else "")
    )
    runner_bin = _resolve_python_bin(minion_dir) if runtime == "python" else "bun"

    config_path = minion_dir / "config.json"
    config_json_str = ""
    after_entry = True
    if config_path.is_file():
        try:
            cfg_obj = json.loads(config_path.read_text(encoding="utf-8"))
            config_json_str = json.dumps(cfg_obj)
            _, _, resolved = validate_trigger_spec(cfg_obj.get("trigger"))
            after_entry = bool(resolved.get("after_entry", True))
        except Exception:
            pass

    base_env: dict[str, str] = {
        "OPENLIA_WORKSPACE_ROOT": str(root),
        "OPENLIA_MINION_ID": valid_id,
        "PYTHONPATH": str(minion_dir),
    }
    if config_json_str:
        base_env["OPENLIA_MINION_CONFIG_JSON"] = config_json_str

    if mode == "test":
        if runtime == "python":
            start_dir = "tests" if (minion_dir / "tests").is_dir() else "."
            res = _run_subprocess(
                [runner_bin, "-m", "unittest", "discover", "-s", start_dir, "-p", "test*.py"],
                minion_dir,
                base_env,
                timeout=timeout,
            )
        else:
            res = _run_subprocess(["bun", "test"], minion_dir, base_env, timeout=timeout)
        return {
            "status": "ok" if res["exit_code"] == 0 else "error",
            "ok": res["exit_code"] == 0,
            "mode": "test",
            **res,
        }

    if mode == "input":
        payload = data if isinstance(data, dict) else ({"item": input_text.strip()} if input_text.strip() else {})
        serialized = json.dumps(payload, ensure_ascii=False)
        steps: list[dict[str, Any]] = []
        if input_entrypoint:
            in_bin = _resolve_python_bin(minion_dir) if input_entrypoint.endswith(".py") else "bun"
            in_res = _run_subprocess(
                [in_bin, input_entrypoint, "--data", serialized],
                minion_dir,
                {
                    **base_env,
                    "OPENLIA_MINION_TRIGGER": "input",
                    "OPENLIA_MINION_INPUT_JSON": serialized,
                },
                timeout=timeout,
            )
            steps.append({"step": "input", "script": input_entrypoint, **in_res})
            if in_res["exit_code"] == 0 and after_entry:
                post_res = _run_subprocess(
                    [runner_bin, entrypoint, "--trigger", "entry", "--entry", serialized],
                    minion_dir,
                    {
                        **base_env,
                        "OPENLIA_MINION_TRIGGER": "entry",
                        "OPENLIA_MINION_ENTRY_JSON": serialized,
                    },
                    timeout=timeout,
                )
                steps.append({"step": "post_entry_main", "script": entrypoint, **post_res})
        else:
            direct_res = _run_subprocess(
                [runner_bin, entrypoint, "--trigger", "entry", "--entry", serialized],
                minion_dir,
                {
                    **base_env,
                    "OPENLIA_MINION_TRIGGER": "entry",
                    "OPENLIA_MINION_ENTRY_JSON": serialized,
                },
                timeout=timeout,
            )
            steps.append({"step": "input", "script": entrypoint, **direct_res})

        final_code = next((s["exit_code"] for s in steps if s["exit_code"] != 0), 0)
        return {
            "status": "ok" if final_code == 0 else "error",
            "ok": final_code == 0,
            "mode": "input",
            "exit_code": final_code,
            "stdout": "\n".join(s["stdout"].strip() for s in steps if s["stdout"].strip()),
            "stderr": "\n".join(s["stderr"].strip() for s in steps if s["stderr"].strip()),
            "duration_ms": sum(s["duration_ms"] for s in steps),
            "steps": steps,
        }

    # Default mode: heartbeat
    hb_res = _run_subprocess(
        [runner_bin, entrypoint, "--trigger", "heartbeat"],
        minion_dir,
        {
            **base_env,
            "OPENLIA_MINION_TRIGGER": "heartbeat",
            "OPENLIA_MINION_ACTION": "heartbeat",
        },
        timeout=timeout,
    )
    return {
        "status": "ok" if hb_res["exit_code"] == 0 else "error",
        "ok": hb_res["exit_code"] == 0,
        "mode": "heartbeat",
        **hb_res,
        "steps": [{"step": "heartbeat", "script": entrypoint, **hb_res}],
    }


def run_self_test() -> int:
    tmpdir = Path(tempfile.mkdtemp(prefix="openlia-minion-tool-test-"))
    try:
        scaffold_res = scaffold_minion(
            tmpdir,
            minion_id="fitness-coach",
            name="Fitness Coach",
            runtime="python",
            heartbeat_schedule="0 */4 * * *",
        )
        assert scaffold_res["status"] == "ok", scaffold_res
        val_res = validate_minion(tmpdir, "fitness-coach")
        assert val_res["valid"] is True, val_res
        assert val_res["triggers"] == {
            "after_entry": True,
            "heartbeat_schedule": "0 */4 * * *",
        }, val_res

        # Test custom agent-defined config fields in config.schema.json + config.json
        minion_dir = tmpdir / "minions" / "fitness-coach"
        cs = json.loads((minion_dir / "config.schema.json").read_text(encoding="utf-8"))
        cs["properties"]["calendar_rem_path"] = {"type": "string"}
        cs["required"] = ["trigger", "calendar_rem_path"]
        (minion_dir / "config.schema.json").write_text(
            json.dumps(cs, indent=2) + "\n", encoding="utf-8"
        )
        # Missing calendar_rem_path should fail validation
        invalid_val = validate_minion(tmpdir, "fitness-coach")
        assert invalid_val["valid"] is False, invalid_val

        # Providing calendar_rem_path + trigger passes validation
        (minion_dir / "config.json").write_text(
            json.dumps(
                {
                    "trigger": {"on_new_entry": True, "cron": "0 */4 * * *"},
                    "calendar_rem_path": "calendar/reminders.rem",
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        valid_after = validate_minion(tmpdir, "fitness-coach")
        assert valid_after["valid"] is True, valid_after

        # Run test, input, and heartbeat modes
        test_res = run_minion(tmpdir, "fitness-coach", mode="test")
        assert test_res["ok"] is True, test_res

        in_res = run_minion(
            tmpdir,
            "fitness-coach",
            mode="input",
            data={"item": "Deadlift 5x5", "category": "strength", "value": 140},
        )
        assert in_res["ok"] is True, in_res
        assert len(in_res["steps"]) == 2, in_res

        hb_res = run_minion(tmpdir, "fitness-coach", mode="heartbeat")
        assert hb_res["ok"] is True, hb_res
        print("minion_tool self-test passed.")
        return 0
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="OpenLia Minion CLI tool")
    parser.add_argument("--self-test", action="store_true", help="Run offline self-test")
    parser.add_argument("--workspace-root", default="/opt/data/workspace")
    parser.add_argument(
        "--action",
        choices=["scaffold", "validate", "run"],
        default="validate",
    )
    parser.add_argument("--id", default="")
    parser.add_argument("--name", default="")
    parser.add_argument("--description", default="")
    parser.add_argument("--runtime", choices=["python", "typescript"], default="python")
    parser.add_argument("--heartbeat-schedule", default=DEFAULT_HEARTBEAT_SCHEDULE)
    parser.add_argument("--mode", choices=["input", "heartbeat", "test"], default="heartbeat")
    parser.add_argument("--data", default="")
    parser.add_argument("--input", default="")
    args = parser.parse_args()

    if args.self_test:
        return run_self_test()

    if args.action == "scaffold":
        res = scaffold_minion(
            args.workspace_root,
            minion_id=args.id,
            name=args.name,
            description=args.description,
            runtime=args.runtime,
            heartbeat_schedule=args.heartbeat_schedule,
        )
        print(json.dumps(res, indent=2, ensure_ascii=False))
        return 0

    if args.action == "validate":
        res = validate_minion(args.workspace_root, args.id)
        print(json.dumps(res, indent=2, ensure_ascii=False))
        return 0 if res.get("valid") else 1

    data_obj = json.loads(args.data) if args.data.strip() else None
    res = run_minion(
        args.workspace_root,
        args.id,
        mode=args.mode,
        data=data_obj,
        input_text=args.input,
    )
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
