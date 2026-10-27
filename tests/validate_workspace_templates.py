#!/usr/bin/env python3
"""Check bundled workspace and skill templates against their user-facing contracts."""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ROOT = ROOT / "workspace-template"
FEATURES_ROOT = ROOT / "features"
SKILLS_ROOT = ROOT / "profile" / "skills"
INGESTION_TEMPLATE = BUNDLE_ROOT / "inbox" / "ingestion" / "ingestion-template.md"
SOURCE_TEMPLATE = BUNDLE_ROOT / "sources" / "records" / "source-template.md"
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


def _core_schema_errors() -> list[str]:
    errors: list[str] = []
    for rel_name, tpl_path in (
        ("inbox/ingestion/ingestion-template.md", INGESTION_TEMPLATE),
        ("sources/records/source-template.md", SOURCE_TEMPLATE),
    ):
        try:
            metadata, _ = validator.parse_frontmatter(tpl_path.read_text(encoding="utf-8"))
            schema_path = validator._resolve_template_schema(
                metadata.get("$schema"), tpl_path, BUNDLE_ROOT
            )
            schema = validator.load_schema(schema_path)
        except (OSError, ValueError) as exc:
            errors.append(f"{rel_name}: {exc}")
            continue

        base = validator._without_schema_directive(metadata)
        if validator.validate_frontmatter(base, schema):
            errors.append(f"{rel_name}: template frontmatter did not validate against its own schema")

        unsupported = dict(base)
        unsupported["legacy_field"] = "not allowed"
        if not validator.validate_frontmatter(unsupported, schema):
            errors.append(f"{rel_name}: schema accepted an unsupported frontmatter field")
    return errors


def _policy_errors() -> list[str]:
    errors: list[str] = []
    try:
        registry = validator.load_registry(BUNDLE_ROOT, required=True)
        policy = validator.load_policy(BUNDLE_ROOT, registry=registry, required=False)
        if not validator.policy_allows(
            policy,
            "generate_reports",
            "inbox/daily-briefing/2026-10-08.md",
            scheduled=True,
        ):
            errors.append("permissions rejected its configured scheduled report path")
        if not validator.policy_allows(
            policy,
            "create_records",
            "tasks/2026-10-08-review.md",
        ):
            errors.append("permissions rejected tasks record writes")
        if not validator.policy_allows(
            policy,
            "create_records",
            "family-menu/2026-10-08.md",
        ):
            errors.append("permissions rejected custom collection record writes")
        if validator.policy_allows(
            policy,
            "generate_reports",
            "inbox/other/2026-10-08.md",
            scheduled=True,
        ):
            errors.append("permissions allowed a scheduled report outside its destination")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append(f"permissions.yaml: {exc}")
    return errors


def validate_bundle() -> list[str]:
    errors = validator.validate_workspace(BUNDLE_ROOT)
    if SKILLS_ROOT.is_dir():
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
        errors.append(f"domain discovery: {exc}")
        expected = set()
    discovered = {
        path.relative_to(BUNDLE_ROOT).as_posix()
        for path in BUNDLE_ROOT.rglob("*-template.md")
    }
    if discovered != expected:
        missing = sorted(expected - discovered)
        unregistered = sorted(discovered - expected)
        if missing:
            errors.append(f"missing discovered templates: {', '.join(missing)}")
        if unregistered:
            errors.append(f"undiscovered template files: {', '.join(unregistered)}")

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
        if path.name not in {"feature.schema.json"}
    }
    if discovered_schemas != expected_schemas:
        missing = sorted(expected_schemas - discovered_schemas)
        unregistered = sorted(discovered_schemas - expected_schemas)
        if missing:
            errors.append(f"missing referenced template schemas: {', '.join(missing)}")
        if unregistered:
            errors.append(f"unregistered template schemas: {', '.join(unregistered)}")

    try:
        validator.load_schema(BUNDLE_ROOT / "feature.schema.json")
    except Exception as exc:
        errors.append(f"feature.schema.json: {exc}")

    if FEATURES_ROOT.is_dir():
        feature_schema = validator.load_schema(BUNDLE_ROOT / "feature.schema.json")
        for feature_dir in sorted(p for p in FEATURES_ROOT.iterdir() if p.is_dir()):
            manifest_path = feature_dir / "feature.yaml"
            if not manifest_path.is_file():
                errors.append(f"features/{feature_dir.name}: missing feature.yaml")
            else:
                try:
                    manifest_data = validator.yaml.safe_load(
                        manifest_path.read_text(encoding="utf-8")
                    )
                    if not isinstance(manifest_data, dict):
                        errors.append(
                            f"features/{feature_dir.name}/feature.yaml: must be a YAML mapping"
                        )
                    else:
                        for err in validator.validate_frontmatter(
                            manifest_data, feature_schema
                        ):
                            errors.append(
                                f"features/{feature_dir.name}/feature.yaml: {err}"
                            )
                except Exception as exc:
                    errors.append(f"features/{feature_dir.name}/feature.yaml: {exc}")
            feat_skills_root = feature_dir / "skills"
            if feat_skills_root.is_dir() and any(feat_skills_root.glob("*/templates/*.md")):
                errors.extend(validator.validate_skill_templates(feat_skills_root))
            feat_ws_root = feature_dir / "workspace"
            if feat_ws_root.is_dir():
                for tpl_path in sorted(feat_ws_root.rglob("*-template.md")):
                    tpl_errors, _, _ = validator._validate_template(
                        tpl_path, feat_ws_root, require_frontmatter=False
                    )
                    errors.extend(tpl_errors)

    errors.extend(_core_schema_errors())
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
    skill_template_count = (
        sum(1 for _ in SKILLS_ROOT.glob("*/templates/*.md"))
        if SKILLS_ROOT.is_dir()
        else 0
    )
    print(
        f"Validated {workspace_template_count} bundled workspace templates and "
        f"{skill_template_count} bundled skill templates."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
