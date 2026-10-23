#!/usr/bin/env python3
"""Check bundled workspace and skill templates against their user-facing contracts."""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ROOT = ROOT / "workspace-template"
SKILLS_ROOT = ROOT / "profile" / "skills"
CLAIM_TEMPLATE = BUNDLE_ROOT / "knowledge" / "claims" / "claim-template.md"
MONITOR_TEMPLATE = BUNDLE_ROOT / "monitors" / "monitor-template.md"
RUNTIME_VALIDATOR = (
    ROOT
    / "profile"
    / "system-skills"
    / "workspace-template-customization"
    / "scripts"
    / "validate_workspace.py"
)
_spec = importlib.util.spec_from_file_location("workspace_template_validator", RUNTIME_VALIDATOR)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"cannot load workspace validator: {RUNTIME_VALIDATOR}")
validator = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = validator
_spec.loader.exec_module(validator)


def _claim_schema_errors() -> list[str]:
    errors: list[str] = []
    try:
        metadata, _ = validator.parse_frontmatter(CLAIM_TEMPLATE.read_text(encoding="utf-8"))
        schema_path = validator._resolve_template_schema(
            metadata.get("$schema"), CLAIM_TEMPLATE, BUNDLE_ROOT
        )
        schema = validator.load_schema(schema_path)
    except (OSError, ValueError) as exc:
        return [f"knowledge/claims/claim-template.md: {exc}"]

    inferred = validator._without_schema_directive(metadata)
    inferred["kind"] = "inferred"
    inferred["confidence"] = "medium"
    inferred["confidence_basis"] = "Supported by repeated observations."
    if validator.validate_frontmatter(inferred, schema):
        errors.append("claim schema rejected an inferred candidate with confidence and basis")

    inferred["status"] = "active"
    if not validator.validate_frontmatter(inferred, schema):
        errors.append("claim schema accepted an active inference without review metadata")
    inferred["reviewed_at"] = "2026-10-06"
    inferred["reviewed_by"] = "user"
    if validator.validate_frontmatter(inferred, schema):
        errors.append("claim schema rejected an active inference with review metadata")

    unsupported = validator._without_schema_directive(metadata)
    unsupported["legacy_field"] = "not allowed"
    if not validator.validate_frontmatter(unsupported, schema):
        errors.append("claim schema accepted an unsupported frontmatter field")
    return errors


def _monitor_schema_errors() -> list[str]:
    errors: list[str] = []
    try:
        metadata, _ = validator.parse_frontmatter(MONITOR_TEMPLATE.read_text(encoding="utf-8"))
        schema_path = validator._resolve_template_schema(
            metadata.get("$schema"), MONITOR_TEMPLATE, BUNDLE_ROOT
        )
        schema = validator.load_schema(schema_path)
    except (OSError, ValueError) as exc:
        return [f"monitors/monitor-template.md: {exc}"]

    for frequency in ("hourly", "daily", "weekly", "monthly"):
        candidate = validator._without_schema_directive(metadata)
        candidate["check_frequency"] = frequency
        if validator.validate_frontmatter(candidate, schema):
            errors.append(f"monitor schema rejected check_frequency: {frequency}")

    unsupported = validator._without_schema_directive(metadata)
    unsupported["check_frequency"] = "yearly"
    if not validator.validate_frontmatter(unsupported, schema):
        errors.append("monitor schema accepted unsupported check_frequency: yearly")
    return errors


def _policy_errors() -> list[str]:
    errors: list[str] = []
    try:
        registry = validator.load_registry(BUNDLE_ROOT, required=True)
        policy = validator.load_policy(BUNDLE_ROOT, registry=registry, required=True)
        legacy_registry = {
            **registry,
            "domains": [
                domain
                for domain in registry["domains"]
                if domain["path"] != "inbox/daily-briefing"
            ],
        }
        validator.load_policy(BUNDLE_ROOT, registry=legacy_registry, required=True)
        if not validator.policy_allows(
            policy,
            "generate_reports",
            "inbox/daily-briefing/2026-10-08.md",
            scheduled=True,
        ):
            errors.append("assistant policy rejected its configured scheduled report path")
        if not validator.policy_allows(
            policy,
            "record_financial_data",
            "finance/intake/2026-10-08-statement.md",
        ):
            errors.append("assistant policy rejected delegated finance record writes")
        if validator.policy_allows(
            policy,
            "generate_reports",
            "inbox/other/2026-10-08.md",
            scheduled=True,
        ):
            errors.append("assistant policy allowed a scheduled report outside its destination")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append(f"assistant-policy.yaml: {exc}")
    return errors


def validate_bundle() -> list[str]:
    errors = validator.validate_workspace(BUNDLE_ROOT)
    errors.extend(validator.validate_skill_templates(SKILLS_ROOT))
    errors.extend(_policy_errors())
    try:
        registry = validator.load_registry(BUNDLE_ROOT, required=True)
        expected = {
            domain["template"]
            for domain in registry["domains"]
            if "template" in domain
        }
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append(f"workspace.yaml: {exc}")
        expected = set()
    discovered = {
        path.relative_to(BUNDLE_ROOT).as_posix()
        for path in BUNDLE_ROOT.rglob("*-template.md")
    }
    if discovered != expected:
        missing = sorted(expected - discovered)
        unregistered = sorted(discovered - expected)
        if missing:
            errors.append(f"missing registered templates: {', '.join(missing)}")
        if unregistered:
            errors.append(f"unregistered template files: {', '.join(unregistered)}")

    expected_schemas: set[str] = set()
    for path in BUNDLE_ROOT.rglob("*-template.md"):
        try:
            metadata, _ = validator.parse_optional_frontmatter(path.read_text(encoding="utf-8"))
            if metadata is None:
                continue
            schema_path = validator._resolve_template_schema(
                metadata.get("$schema"), path, BUNDLE_ROOT
            )
        except (OSError, ValueError) as exc:
            errors.append(f"{path.relative_to(BUNDLE_ROOT).as_posix()}: {exc}")
            continue
        expected_schemas.add(schema_path.relative_to(BUNDLE_ROOT).as_posix())
    discovered_schemas = {
        path.relative_to(BUNDLE_ROOT).as_posix()
        for path in BUNDLE_ROOT.rglob("*.schema.json")
        if path.name not in {"workspace.schema.json", "assistant-policy.schema.json"}
    }
    if discovered_schemas != expected_schemas:
        missing = sorted(expected_schemas - discovered_schemas)
        unregistered = sorted(discovered_schemas - expected_schemas)
        if missing:
            errors.append(f"missing referenced template schemas: {', '.join(missing)}")
        if unregistered:
            errors.append(f"unregistered template schemas: {', '.join(unregistered)}")

    discovered_skill_templates = {
        path.relative_to(SKILLS_ROOT).as_posix()
        for path in SKILLS_ROOT.glob("*/templates/*.md")
    }
    for relative in sorted(discovered_skill_templates):
        path = SKILLS_ROOT / relative
        try:
            _, body = validator.parse_optional_frontmatter(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            errors.append(f"{relative}: {exc}")
            continue
        if relative == "daily-briefing/templates/briefing.md" and ("{{" in body or "}}" in body):
            errors.append(
                f"{relative}: renderer-style placeholders are not allowed in direct-write templates"
            )

    errors.extend(_claim_schema_errors())
    errors.extend(_monitor_schema_errors())
    return sorted(set(errors))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run validator self-tests")
    args = parser.parse_args(argv)
    if args.self_test:
        validator.self_test()
        print("ok")
        return 0

    errors = validate_bundle()
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    workspace_template_count = sum(
        1 for _ in BUNDLE_ROOT.rglob("*-template.md")
    )
    skill_template_count = sum(1 for _ in SKILLS_ROOT.glob("*/templates/*.md"))
    print(
        f"Validated {workspace_template_count} bundled workspace templates and "
        f"{skill_template_count} bundled skill templates."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
