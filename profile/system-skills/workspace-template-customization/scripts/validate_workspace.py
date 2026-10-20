#!/usr/bin/env python3
"""Validate workspace records and workspace/skill templates against local schemas."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yaml
from jsonschema import Draft202012Validator, FormatChecker

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from workspace_registry import (
    load_policy,
    load_registry,
    policy_allows,
    policy_schema_path,
    policy_path,
    registry_path,
)


FRONT_MATTER = re.compile(
    r"\A---[ \t]*\r?\n(?P<metadata>.*?)(?:\r?\n)---[ \t]*(?:\r?\n|\Z)",
    re.DOTALL,
)
MARKDOWN_HEADING = re.compile(r"^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
CODE_FENCE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
TEMPLATE_SUFFIX = "-template.md"


class UniqueKeySafeLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects ambiguous duplicate mapping keys."""


def _construct_unique_mapping(
    loader: UniqueKeySafeLoader,
    node: yaml.nodes.MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise ValueError("YAML mapping keys must be scalar values") from exc
        if duplicate:
            raise ValueError(f"duplicate YAML key: {key}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeySafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_unique_mapping
)


def _normalize_yaml(value: Any, active: set[int] | None = None) -> Any:
    if active is None:
        active = set()
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        identity = id(value)
        if identity in active:
            raise ValueError("recursive YAML aliases are not supported")
        active.add(identity)
        try:
            return {key: _normalize_yaml(item, active) for key, item in value.items()}
        finally:
            active.remove(identity)
    if isinstance(value, list):
        identity = id(value)
        if identity in active:
            raise ValueError("recursive YAML aliases are not supported")
        active.add(identity)
        try:
            return [_normalize_yaml(item, active) for item in value]
        finally:
            active.remove(identity)
    return value


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Return normalized frontmatter and body, requiring a YAML object."""
    match = FRONT_MATTER.match(text)
    if not match:
        raise ValueError("file must begin with YAML frontmatter")
    try:
        metadata = yaml.load(match.group("metadata"), Loader=UniqueKeySafeLoader)
    except (yaml.YAMLError, ValueError, RecursionError) as exc:
        raise ValueError(f"invalid YAML frontmatter: {exc}") from exc
    if not isinstance(metadata, dict):
        raise ValueError("YAML frontmatter must contain an object")
    if any(not isinstance(key, str) for key in metadata):
        raise ValueError("frontmatter keys must be strings")
    try:
        normalized = _normalize_yaml(metadata)
    except RecursionError as exc:
        raise ValueError("invalid YAML frontmatter: nesting is too deep") from exc
    return normalized, text[match.end() :]


def parse_optional_frontmatter(text: str) -> tuple[dict[str, Any] | None, str]:
    """Parse frontmatter when present, otherwise return the complete Markdown body."""
    if FRONT_MATTER.match(text):
        metadata, body = parse_frontmatter(text)
        return metadata, body
    if text.startswith("---"):
        # A leading frontmatter delimiter that is malformed must not silently
        # turn into an ordinary Markdown paragraph.
        return parse_frontmatter(text)
    return None, text


def validate_frontmatter(metadata: Any, schema: dict[str, Any]) -> list[str]:
    """Return sorted JSON Schema errors with stable field paths."""
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = []
    for error in sorted(
        validator.iter_errors(metadata),
        key=lambda item: tuple(str(part) for part in item.absolute_path),
    ):
        location = "$"
        for part in error.absolute_path:
            location += f"[{part}]" if isinstance(part, int) else f".{part}"
        errors.append(f"frontmatter {location}: {error.message}")
    return errors


def extract_headings(body: str) -> list[tuple[int, str]]:
    """Extract Markdown headings while ignoring fenced code blocks."""
    headings: list[tuple[int, str]] = []
    fence_character: str | None = None
    fence_length = 0
    for line in body.splitlines():
        fence_match = CODE_FENCE.match(line)
        if fence_character is not None:
            if (
                fence_match
                and fence_match.group(1)[0] == fence_character
                and len(fence_match.group(1)) >= fence_length
            ):
                fence_character = None
                fence_length = 0
            continue
        if fence_match:
            fence_character = fence_match.group(1)[0]
            fence_length = len(fence_match.group(1))
            continue
        heading = MARKDOWN_HEADING.match(line)
        if heading:
            title = re.sub(r"[ \t]+#+[ \t]*$", "", heading.group(2)).strip()
            headings.append((len(heading.group(1)), title))
    return headings


def validate_template_structure(body: str) -> list[str]:
    """Check that a customizable template retains one Markdown title."""
    headings = extract_headings(body)
    titles = [heading for level, heading in headings if level == 1]
    if len(titles) != 1 or not titles[0]:
        return ["template body must contain exactly one non-empty level-one title"]
    return []


def levenshtein_distance(s1: str, s2: str) -> int:
    a, b = s1.lower(), s2.lower()
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    return dp[m][n]


def is_similar_heading(expected: str, actual: str) -> bool:
    e, a = expected.lower().strip(), actual.lower().strip()
    if e == a:
        return True
    dist = levenshtein_distance(e, a)
    max_len = max(len(e), len(a))
    if max_len == 0:
        return True
    return dist <= 2 or (1.0 - dist / max_len) >= 0.75


def _schema_refs_are_local(value: Any) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "$ref" and (not isinstance(item, str) or not item.startswith("#")):
                return False
            if not _schema_refs_are_local(item):
                return False
    elif isinstance(value, list):
        return all(_schema_refs_are_local(item) for item in value)
    return True


def load_schema(path: Path) -> dict[str, Any]:
    """Load a local JSON Schema and reject remote references/network resolution."""
    try:
        schema = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot load schema: {exc}") from exc
    if not isinstance(schema, dict):
        raise ValueError("schema must contain a JSON object")
    try:
        Draft202012Validator.check_schema(schema)
    except Exception as exc:
        raise ValueError(f"invalid JSON Schema: {exc}") from exc
    if not _schema_refs_are_local(schema):
        raise ValueError("schema references must be local; remote references are disabled")
    return schema


def _relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _resolve_template_schema(
    reference: Any, template: Path, root: Path
) -> Path:
    """Resolve a template's local $schema path without allowing root escapes."""
    if not isinstance(reference, str) or not reference.strip():
        raise ValueError("frontmatter $schema must be a non-empty relative path")
    if reference != reference.strip():
        raise ValueError("frontmatter $schema must not have surrounding whitespace")
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("frontmatter $schema must be a local relative path")
    if "\\" in reference:
        raise ValueError("frontmatter $schema must use forward-slash path separators")
    relative_schema = Path(reference)
    if relative_schema.is_absolute():
        raise ValueError("frontmatter $schema must be a local relative path")

    schema_path = template.parent / relative_schema
    if schema_path.is_symlink():
        raise ValueError("frontmatter $schema must not reference a symbolic link")
    try:
        resolved = schema_path.resolve()
        resolved.relative_to(root.resolve())
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("frontmatter $schema resolves outside the template root") from exc
    if not resolved.is_file():
        raise ValueError(f"frontmatter $schema file does not exist: {reference}")
    return resolved


def _without_schema_directive(metadata: dict[str, Any]) -> dict[str, Any]:
    """Return frontmatter data without the reserved schema-location directive."""
    return {key: value for key, value in metadata.items() if key != "$schema"}


def _validate_template(
    path: Path,
    root: Path,
    *,
    require_frontmatter: bool,
    schema_root: Path | None = None,
) -> tuple[list[str], dict[str, Any] | None, Path | None]:
    """Validate a Markdown template and return its loaded schema, if any."""
    relative = _relative(path, root)
    if path.is_symlink():
        return [f"{relative}: symbolic links are not validated"], None, None
    try:
        text = path.read_text(encoding="utf-8")
        metadata, body = parse_optional_frontmatter(text)
    except (OSError, UnicodeError, ValueError) as exc:
        return [f"{relative}: {exc}"], None, None

    errors: list[str] = []
    schema: dict[str, Any] | None = None
    schema_path: Path | None = None
    if metadata is None:
        if require_frontmatter:
            errors.append(f"{relative}: template must begin with YAML frontmatter")
    else:
        if "$schema" not in metadata:
            errors.append(f"{relative}: frontmatter must include $schema")
        else:
            try:
                schema_path = _resolve_template_schema(
                    metadata["$schema"], path, schema_root or root
                )
                schema = load_schema(schema_path)
            except ValueError as exc:
                errors.append(f"{relative}: {exc}")
            if schema is not None:
                errors.extend(
                    f"{relative}: {error}"
                    for error in validate_frontmatter(
                        _without_schema_directive(metadata), schema
                    )
                )

    errors.extend(
        f"{relative}: {error}" for error in validate_template_structure(body)
    )
    return errors, schema, schema_path


def _validate_document(
    path: Path,
    schema: dict[str, Any],
    root: Path,
    template_path: Path | None = None,
) -> list[str]:
    relative = _relative(path, root)
    if path.is_symlink():
        return [f"{relative}: symbolic links are not validated"]
    try:
        metadata, body = parse_frontmatter(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        return [f"{relative}: {exc}"]
    errors = [
        f"{relative}: {error}"
        for error in validate_frontmatter(_without_schema_directive(metadata), schema)
    ]
    if template_path is not None and template_path.is_file():
        try:
            template_headings = extract_headings(template_path.read_text(encoding="utf-8"))
            expected_sections = [
                h.strip() for l, h in template_headings if l == 2 and h.strip()
            ]
            record_headings = extract_headings(body)
            titles = [h for l, h in record_headings if l == 1 and h.strip()]
            if not titles:
                errors.append(f"{relative}: file must contain a level-one title ('# ...')")
            file_sections = [h.strip() for l, h in record_headings if l == 2]
            for expected in expected_sections:
                if not any(expected.lower() == s.lower() for s in file_sections):
                    typo = next(
                        (s for s in file_sections if is_similar_heading(expected, s)),
                        None,
                    )
                    if typo:
                        errors.append(
                            f"{relative}: heading: missing section '## {expected}' "
                            f"(found misspelled '## {typo}')"
                        )
                    else:
                        errors.append(
                            f"{relative}: heading: missing required section '## {expected}'"
                        )
        except Exception:
            pass
    return errors


def _validate_unreferenced_schemas(
    paths: list[Path], referenced: set[Path], root: Path
) -> list[str]:
    errors: list[str] = []
    for schema_path in paths:
        relative = _relative(schema_path, root)
        if schema_path.is_symlink():
            errors.append(f"{relative}: symbolic links are not validated")
            continue
        resolved = schema_path.resolve()
        if resolved not in referenced:
            errors.append(f"{relative}: schema is not referenced by a template $schema field")
    return errors


def validate_workspace_registry(workspace_root: Path) -> tuple[list[str], set[Path]]:
    """Validate the optional user-owned workspace registry and its local schema."""
    root = workspace_root.expanduser().resolve()
    path = registry_path(root)
    if not path.exists():
        return [], set()
    relative = _relative(path, root)
    referenced: set[Path] = set()
    try:
        registry = load_registry(root, required=True)
        schema_reference = registry.get("$schema") if registry else None
        registry_schema = _resolve_template_schema(schema_reference, path, root)
        schema = load_schema(registry_schema)
    except (OSError, UnicodeError, ValueError) as exc:
        return [f"{relative}: {exc}"], referenced
    referenced.add(registry_schema)
    return [f"{relative}: {error}" for error in validate_frontmatter(registry, schema)], referenced


def validate_workspace_policy(workspace_root: Path) -> tuple[list[str], set[Path]]:
    """Validate the optional user-owned delegation policy and its schema."""
    root = workspace_root.expanduser().resolve()
    path = policy_path(root)
    referenced: set[Path] = set()
    if not path.exists():
        return [], referenced
    schema_file = policy_schema_path(root)
    if schema_file.exists():
        referenced.add(schema_file.resolve())
    relative = _relative(path, root)
    try:
        load_policy(root)
    except (OSError, UnicodeError, ValueError) as exc:
        return [f"{relative}: {exc}"], referenced
    return [], referenced


def validate_workspace(workspace_root: Path) -> list[str]:
    """Validate workspace templates and Markdown records in their domains."""
    root = workspace_root.expanduser().resolve()
    if not root.is_dir():
        return [f"workspace root is not a directory: {root}"]

    errors: list[str] = []
    registry_errors, referenced_registry_schemas = validate_workspace_registry(root)
    errors.extend(registry_errors)
    policy_errors, referenced_policy_schemas = validate_workspace_policy(root)
    errors.extend(policy_errors)
    templates = sorted(root.rglob(f"*{TEMPLATE_SUFFIX}"))
    if not templates:
        return errors + ["no ordinary *-template.md files found; no schemas or records were validated"]
    templates_by_domain: dict[Path, list[Path]] = {}
    schemas_by_template: dict[Path, dict[str, Any]] = {}
    referenced_schemas: set[Path] = set(referenced_registry_schemas)
    referenced_schemas.update(referenced_policy_schemas)

    for template in templates:
        relative = _relative(template, root)
        if template.is_symlink():
            errors.append(f"{relative}: symbolic links are not validated")
            continue
        relative_parts = template.relative_to(root).parts
        if len(relative_parts) < 2:
            errors.append(f"{relative}: templates must be inside a domain directory")
            continue
        domain = template.parent
        templates_by_domain.setdefault(domain, []).append(template)
        template_errors, schema, schema_path = _validate_template(
            template, root, require_frontmatter=True
        )
        errors.extend(template_errors)
        if schema_path is not None:
            referenced_schemas.add(schema_path)
        if schema is not None:
            schemas_by_template[template] = schema

    # A template owns its containing directory and descendants. If a nested
    # directory has its own template, that more-specific pair owns its subtree.
    for domain, domain_templates in sorted(templates_by_domain.items()):
        if len(domain_templates) != 1:
            names = ", ".join(_relative(path, root) for path in domain_templates)
            errors.append(
                f"{_relative(domain, root)}: expected one workspace template per domain directory; "
                f"found {names}"
            )
            continue

        template = domain_templates[0]
        schema = schemas_by_template.get(template)
        if schema is None:
            # Frontmatter and schema errors were reported alongside the template.
            continue
        for record in sorted(domain.rglob("*.md")):
            if record.name.endswith(TEMPLATE_SUFFIX):
                continue
            if any(
                nested_domain != domain
                and domain in nested_domain.parents
                and record.is_relative_to(nested_domain)
                for nested_domain in templates_by_domain
            ):
                continue
            if record.is_symlink():
                errors.append(f"{_relative(record, root)}: symbolic links are not validated")
                continue
            errors.extend(_validate_document(record, schema, root, template_path=template))

    schema_paths = sorted(root.rglob("*.schema.json"))
    errors.extend(_validate_unreferenced_schemas(schema_paths, referenced_schemas, root))

    return sorted(set(errors))


def validate_skill_templates(skill_root: Path) -> list[str]:
    """Validate Markdown templates under each installed skill's templates directory."""
    root = skill_root.expanduser().resolve()
    if not root.is_dir():
        return [f"skill templates root is not a directory: {root}"]

    templates = sorted(root.glob("*/templates/*.md"))
    if not templates:
        return ["no skill templates found under */templates/*.md"]

    errors: list[str] = []
    referenced_schemas: set[Path] = set()
    for template in templates:
        template_errors, _, schema_path = _validate_template(
            template,
            root,
            require_frontmatter=False,
            schema_root=template.parents[1],
        )
        errors.extend(template_errors)
        if schema_path is not None:
            referenced_schemas.add(schema_path)

    schema_paths = sorted(
        schema_path
        for templates_dir in root.glob("*/templates")
        for schema_path in templates_dir.rglob("*.schema.json")
    )
    errors.extend(_validate_unreferenced_schemas(schema_paths, referenced_schemas, root))
    return sorted(set(errors))


def self_test() -> None:
    """Exercise workspace and skill-template validation without user files."""
    from tempfile import TemporaryDirectory

    try:
        parse_frontmatter("---\nstatus: active\nstatus: done\n---\n")
    except ValueError as exc:
        assert "duplicate YAML key" in str(exc)
    else:
        raise AssertionError("duplicate YAML keys must be rejected")
    try:
        parse_frontmatter("---\nloop: &loop [*loop]\n---\n")
    except ValueError as exc:
        assert "recursive YAML aliases" in str(exc)
    else:
        raise AssertionError("recursive YAML aliases must be rejected")
    remote_ref = {"properties": {"x": {"$ref": "https://example.invalid/schema"}}}
    assert not _schema_refs_are_local(remote_ref)

    with TemporaryDirectory(prefix="openlia-workspace-validation-") as directory:
        root = Path(directory)
        domain = root / "goals"
        domain.mkdir()
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {"status": {"enum": ["active", "done"]}},
            "required": ["status"],
            "additionalProperties": False,
        }
        shared_schemas = root / "schemas"
        shared_schemas.mkdir()
        (shared_schemas / "goal.json").write_text(
            json.dumps(schema), encoding="utf-8"
        )
        template = domain / "goal-template.md"
        template.write_text(
            "---\n$schema: ../schemas/goal.json\nstatus: active\n---\n"
            "# <Goal>\n\n## Outcome\n",
            encoding="utf-8",
        )
        record = domain / "career.md"
        record.write_text(
            "---\n$schema: ../schemas/goal.json\nstatus: active\n---\n# Career\n\n## Outcome\n",
            encoding="utf-8",
        )
        nested_record = domain / "active" / "quarterly.md"
        nested_record.parent.mkdir()
        nested_record.write_text(
            "---\nstatus: active\n---\n# Quarterly goal\n\n## Outcome\n", encoding="utf-8"
        )

        claims_domain = root / "knowledge" / "claims"
        claims_domain.mkdir(parents=True)
        claims_schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {"status": {"enum": ["candidate", "active"]}},
            "required": ["status"],
            "additionalProperties": False,
        }
        (claims_domain / "claim-template.schema.json").write_text(
            json.dumps(claims_schema), encoding="utf-8"
        )
        (claims_domain / "claim-template.md").write_text(
            "---\n$schema: ./claim-template.schema.json\nstatus: candidate\n---\n"
            "# <Claim Record>\n\n## Claim\n",
            encoding="utf-8",
        )
        claim = claims_domain / "example.md"
        claim.write_text("---\nstatus: active\n---\n# Claim Record\n\n## Claim\nA claim.\n", encoding="utf-8")
        unrelated_knowledge = root / "knowledge" / "reference.md"
        unrelated_knowledge.write_text("# A knowledge reference without frontmatter\n", encoding="utf-8")
        (root / "workspace.schema.json").write_text(
            json.dumps(
                {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "properties": {
                        "$schema": {"const": "./workspace.schema.json"},
                        "version": {"const": 1},
                        "domains": {"type": "array", "minItems": 1},
                    },
                    "required": ["$schema", "version", "domains"],
                    "additionalProperties": False,
                }
            ),
            encoding="utf-8",
        )
        core_roots = (
            "inbox",
            "goals",
            "areas",
            "projects",
            "knowledge",
            "ideas",
            "decisions",
            "monitors",
            "tasks",
            "calendar",
            "people",
            "shopping",
            "travel",
            "finance",
            "archive",
        )
        registry_lines = ["$schema: ./workspace.schema.json", "version: 1", "domains:"]
        for root_name in core_roots:
            registry_lines.extend(
                [
                    f"  - path: {root_name}",
                    "    kind: core",
                    f"    label: {root_name.title()}",
                    f"    purpose: {root_name.title()} records",
                ]
            )
        (root / "workspace.yaml").write_text(
            "\n".join(registry_lines) + "\n", encoding="utf-8"
        )
        assert load_registry(root) is not None
        assert validate_workspace(root) == []

        record.write_text("---\nstatus: unknown\nextra: true\n---\n# Career\n\n## Outcome\n", encoding="utf-8")
        errors = validate_workspace(root)
        assert any("career.md" in error and "status" in error for error in errors)
        assert any("career.md" in error and "extra" in error for error in errors)
        assert any("knowledge/claims/example.md" in error for error in errors) is False
        assert record.read_text(encoding="utf-8").startswith("---\nstatus: unknown")

        record.write_text("---\nstatus: active\n---\n# Career\n\n## Outcoome\n", encoding="utf-8")
        errors = validate_workspace(root)
        assert any("career.md" in error and "misspelled '## Outcoome'" in error for error in errors)

        record.write_text("---\nstatus: active\n---\n# Career\n\n## Outcome\n", encoding="utf-8")

        claim.write_text("---\nstatus: unknown\n---\n# Claim Record\n\n## Claim\nA claim.\n", encoding="utf-8")
        errors = validate_workspace(root)
        assert any("knowledge/claims/example.md" in error and "status" in error for error in errors)
        assert not any("knowledge/reference.md" in error for error in errors)

    with TemporaryDirectory(prefix="openlia-skill-template-validation-") as directory:
        root = Path(directory)
        plain_templates = root / "plain-skill" / "templates"
        plain_templates.mkdir(parents=True)
        (plain_templates / "plain.md").write_text("# Plain Template\n", encoding="utf-8")

        metadata_templates = root / "metadata-skill" / "templates"
        metadata_templates.mkdir(parents=True)
        (metadata_templates / "record.schema.json").write_text(
            json.dumps(
                {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "properties": {"status": {"enum": ["active", "done"]}},
                    "required": ["status"],
                    "additionalProperties": False,
                }
            ),
            encoding="utf-8",
        )
        metadata_template = metadata_templates / "record.md"
        metadata_template.write_text(
            "---\n$schema: ./record.schema.json\nstatus: active\n---\n# Record\n",
            encoding="utf-8",
        )
        assert validate_skill_templates(root) == []

        metadata_template.write_text(
            "---\n$schema: https://example.invalid/schema.json\nstatus: active\n---\n"
            "# Record\n",
            encoding="utf-8",
        )
        errors = validate_skill_templates(root)
        assert any("local relative path" in error for error in errors)

        metadata_template.write_text(
            "---\n$schema: ../../outside.schema.json\nstatus: active\n---\n# Record\n",
            encoding="utf-8",
        )
        errors = validate_skill_templates(root)
        assert any("outside the template root" in error for error in errors)

        metadata_template.write_text(
            "---\n$schema: /tmp/outside.schema.json\nstatus: active\n---\n# Record\n",
            encoding="utf-8",
        )
        errors = validate_skill_templates(root)
        assert any("local relative path" in error for error in errors)

        metadata_template.write_text(
            "---\n$schema: ./missing.schema.json\nstatus: active\n---\n# Record\n",
            encoding="utf-8",
        )
        errors = validate_skill_templates(root)
        assert any("file does not exist" in error for error in errors)

        (metadata_templates / "record.schema.json").write_text("{invalid", encoding="utf-8")
        metadata_template.write_text(
            "---\n$schema: ./record.schema.json\nstatus: active\n---\n# Record\n",
            encoding="utf-8",
        )
        errors = validate_skill_templates(root)
        assert any("cannot load schema" in error for error in errors)

        (metadata_templates / "record.schema.json").write_text(
            json.dumps(
                {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "properties": {"status": {"enum": ["active", "done"]}},
                    "required": ["status"],
                    "additionalProperties": False,
                }
            ),
            encoding="utf-8",
        )
        metadata_template.write_text(
            "---\n$schema: ./record.schema.json\nstatus: invalid\n---\n# Record\n",
            encoding="utf-8",
        )
        errors = validate_skill_templates(root)
        assert any("frontmatter $.status" in error for error in errors)

        linked_schema = metadata_templates / "linked.schema.json"
        try:
            linked_schema.symlink_to(metadata_templates / "record.schema.json")
        except OSError:
            pass
        else:
            metadata_template.write_text(
                "---\n$schema: ./linked.schema.json\nstatus: active\n---\n# Record\n",
                encoding="utf-8",
            )
            errors = validate_skill_templates(root)
            assert any("symbolic link" in error for error in errors)
            linked_schema.unlink()

        metadata_template.write_text(
            "---\nstatus: active\n---\n# Record\n", encoding="utf-8"
        )
        errors = validate_skill_templates(root)
        assert any("frontmatter must include $schema" in error for error in errors)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace-root", type=Path, help="workspace to validate")
    parser.add_argument(
        "--skill-templates-root",
        type=Path,
        help="installed skills root containing <skill>/templates/*.md",
    )
    parser.add_argument("--json", action="store_true", help="write machine-readable results")
    parser.add_argument("--self-test", action="store_true", help="run built-in tests")
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        print("ok")
        return 0
    if args.workspace_root is None and args.skill_templates_root is None:
        parser.error("at least one of --workspace-root or --skill-templates-root is required")

    errors: list[str] = []
    validated: list[str] = []
    if args.workspace_root is not None:
        errors.extend(validate_workspace(args.workspace_root))
        validated.append(f"workspace templates and records under {args.workspace_root}")
    if args.skill_templates_root is not None:
        errors.extend(validate_skill_templates(args.skill_templates_root))
        validated.append(f"skill templates under {args.skill_templates_root}")
    errors = sorted(set(errors))
    if args.json:
        print(json.dumps({"valid": not errors, "errors": errors}, indent=2))
    elif errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
    else:
        print(f"Validated {' and '.join(validated)}.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
