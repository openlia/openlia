#!/usr/bin/env python3
"""Read and resolve the user-owned OpenLia workspace registry."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
import yaml


REGISTRY_FILENAME = "workspace.yaml"
REGISTRY_SCHEMA_FILENAME = "workspace.schema.json"
POLICY_FILENAME = "assistant-policy.yaml"
POLICY_SCHEMA_FILENAME = "assistant-policy.schema.json"
FEATURE_SCHEMA_FILENAME = "feature.schema.json"
REGISTRY_VERSION = 1
CORE_ROOTS = {
    "inbox",
    "goals",
    "projects",
    "knowledge",
    "tasks",
    "calendar",
    "archive",
}
ROUTES = {"task", "event", "decision", "idea", "research", "claim", "finance", "archive", "review"}
BRIEFING_CATEGORIES = {
    "calendar",
    "tasks",
    "projects",
    "goals",
    "decisions",
    "monitors",
    "claims",
    "finance",
    "inbox",
    "extension",
}
PATH_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$")


class UniqueKeySafeLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects duplicate mapping keys."""


def _construct_unique_mapping(
    loader: UniqueKeySafeLoader,
    node: yaml.nodes.MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            if key in mapping:
                raise ValueError(f"duplicate YAML key: {key}")
        except TypeError as exc:
            raise ValueError("YAML mapping keys must be scalar values") from exc
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeySafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_unique_mapping
)


def _normalize(value: Any, active: set[int] | None = None) -> Any:
    if active is None:
        active = set()
    if isinstance(value, dict):
        identity = id(value)
        if identity in active:
            raise ValueError("recursive YAML aliases are not supported")
        active.add(identity)
        try:
            return {key: _normalize(item, active) for key, item in value.items()}
        finally:
            active.remove(identity)
    if isinstance(value, list):
        identity = id(value)
        if identity in active:
            raise ValueError("recursive YAML aliases are not supported")
        active.add(identity)
        try:
            return [_normalize(item, active) for item in value]
        finally:
            active.remove(identity)
    return value


def _safe_relative_path(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or not PATH_PATTERN.fullmatch(value):
        raise ValueError(f"{field} must be a relative slash-separated workspace path")
    parts = value.split("/")
    if any(part in {".", ".."} or part.startswith(".") for part in parts):
        raise ValueError(f"{field} must not contain hidden or parent path segments")
    return value


def registry_path(workspace: Path) -> Path:
    return workspace / REGISTRY_FILENAME


def schema_path(workspace: Path) -> Path:
    return workspace / REGISTRY_SCHEMA_FILENAME


def policy_path(workspace: Path) -> Path:
    return workspace / POLICY_FILENAME


def policy_schema_path(workspace: Path) -> Path:
    return workspace / POLICY_SCHEMA_FILENAME


def feature_schema_path(workspace: Path) -> Path:
    return workspace / FEATURE_SCHEMA_FILENAME


def _path_is_within(path: Any, parent: Any) -> bool:
    """Return whether two relative workspace paths have a safe containment relationship."""
    if not isinstance(path, str) or not isinstance(parent, str):
        return False
    if path.startswith("/") or parent.startswith("/"):
        return False
    path_parts = path.strip("/").split("/")
    parent_parts = parent.strip("/").split("/")
    if not path_parts or not parent_parts:
        return False
    if any(not part or part in {".", ".."} for part in path_parts + parent_parts):
        return False
    return path_parts[: len(parent_parts)] == parent_parts


def _load_registry_schema(workspace: Path) -> dict[str, Any]:
    path = schema_path(workspace)
    try:
        schema = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(schema, dict):
            raise ValueError("workspace registry schema must contain an object")
        Draft202012Validator.check_schema(schema)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"invalid workspace registry schema: {exc}") from exc
    return schema


def load_registry(workspace: str | Path, *, required: bool = False) -> dict[str, Any] | None:
    """Load a registry and perform structural checks without writing files."""
    root = Path(workspace).expanduser().resolve()
    path = registry_path(root)
    if not path.exists():
        if required:
            raise ValueError(f"workspace registry is missing: {REGISTRY_FILENAME}")
        return None
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"workspace registry is not a regular file: {REGISTRY_FILENAME}")
    try:
        data = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeySafeLoader)
        registry = _normalize(data)
    except (OSError, UnicodeError, yaml.YAMLError, ValueError, RecursionError) as exc:
        raise ValueError(f"invalid workspace registry: {exc}") from exc
    if not isinstance(registry, dict):
        raise ValueError("workspace registry must contain a mapping")
    if set(registry) - {"$schema", "version", "domains"}:
        raise ValueError("workspace registry contains unsupported top-level fields")
    if registry.get("$schema") != f"./{REGISTRY_SCHEMA_FILENAME}":
        raise ValueError(
            f"workspace registry $schema must be ./{REGISTRY_SCHEMA_FILENAME}"
        )
    registry_schema = schema_path(root)
    if registry_schema.is_symlink() or not registry_schema.is_file():
        raise ValueError(
            f"workspace registry schema is missing or not a regular file: {REGISTRY_SCHEMA_FILENAME}"
        )
    registry_schema_data = _load_registry_schema(root)
    if registry.get("version") != REGISTRY_VERSION:
        raise ValueError(f"workspace registry version must be {REGISTRY_VERSION}")
    domains = registry.get("domains")
    if not isinstance(domains, list):
        raise ValueError("workspace registry domains must be a list")
    schema_errors = sorted(
        Draft202012Validator(registry_schema_data).iter_errors(registry),
        key=lambda error: tuple(str(part) for part in error.absolute_path),
    )
    if schema_errors:
        raise ValueError(f"workspace registry does not match its schema: {schema_errors[0].message}")

    seen: set[str] = set()
    for index, domain in enumerate(domains, start=1):
        if not isinstance(domain, dict):
            raise ValueError(f"workspace registry domain {index} must be a mapping")
        path_value = _safe_relative_path(domain.get("path"), f"domain {index} path")
        if path_value in seen:
            raise ValueError(f"duplicate workspace registry path: {path_value}")
        seen.add(path_value)
        kind = domain.get("kind")
        if kind not in {"core", "extension"}:
            raise ValueError(f"domain {path_value} kind must be core or extension")
        for field in ("label", "purpose"):
            if not isinstance(domain.get(field), str) or not domain[field].strip():
                raise ValueError(f"domain {path_value} {field} must be a non-empty string")
        route = domain.get("route")
        if route is not None and (not isinstance(route, str) or route not in ROUTES):
            raise ValueError(f"domain {path_value} has unsupported route: {route}")
        tags = domain.get("tags", [])
        if not isinstance(tags, list) or any(not isinstance(tag, str) or not tag for tag in tags):
            raise ValueError(f"domain {path_value} tags must be a list of non-empty strings")
        if len(set(tags)) != len(tags):
            raise ValueError(f"domain {path_value} tags must be unique")
        if not isinstance(domain.get("include_in_briefing", False), bool):
            raise ValueError(f"domain {path_value} include_in_briefing must be boolean")
        category = domain.get("briefing_category")
        if category is not None and (not isinstance(category, str) or category not in BRIEFING_CATEGORIES):
            raise ValueError(f"domain {path_value} has unsupported briefing category: {category}")
        if domain.get("include_in_briefing", False) and category is None:
            raise ValueError(
                f"domain {path_value} needs briefing_category when included in briefings"
            )
        template = domain.get("template")
        if template is not None:
            template_path = root / _safe_relative_path(
                template, f"domain {path_value} template"
            )
            if template_path.is_symlink() or not template_path.is_file():
                raise ValueError(
                    f"domain {path_value} template does not resolve to a regular workspace file"
                )
        lifecycle = domain.get("lifecycle")
        if kind == "extension" and (not isinstance(lifecycle, str) or not lifecycle.strip()):
            raise ValueError(f"extension domain {path_value} needs a lifecycle")
        if kind == "extension" and route is not None and not tags:
            raise ValueError(
                f"extension domain {path_value} needs tags when it declares a route"
            )
        skills = domain.get("skills", [])
        if not isinstance(skills, list) or any(
            not isinstance(skill, str) or not skill.strip() for skill in skills
        ):
            raise ValueError(f"domain {path_value} skills must be a list of non-empty strings")
        if len(set(skills)) != len(skills):
            raise ValueError(f"domain {path_value} skills must be unique")
        feature = domain.get("feature")
        if feature is not None and (not isinstance(feature, str) or not feature.strip()):
            raise ValueError(f"domain {path_value} feature must be a non-empty string")
    missing_core = sorted(CORE_ROOTS - {path for path in seen if "/" not in path})
    if missing_core:
        raise ValueError(f"workspace registry is missing core domains: {', '.join(missing_core)}")
    core_kinds = {
        domain["path"]: domain["kind"]
        for domain in domains
        if "/" not in domain["path"]
    }
    non_core_roots = sorted(
        root_name for root_name in CORE_ROOTS if core_kinds.get(root_name) != "core"
    )
    if non_core_roots:
        raise ValueError(
            f"workspace registry core domains must remain kind core: {', '.join(non_core_roots)}"
        )
    extra_core = sorted(
        domain["path"]
        for domain in domains
        if domain["kind"] == "core" and domain["path"] not in CORE_ROOTS
    )
    if extra_core:
        raise ValueError(
            f"non-core domains must use kind extension: {', '.join(extra_core)}"
        )
    # Organizational ancestors need not be semantic domains. Register the
    # extension contract, not every intermediate folder.
    for path_value in seen:
        root_name = path_value.split("/", 1)[0]
        if root_name not in seen:
            raise ValueError(
                f"workspace registry path {path_value} has unregistered root {root_name}"
            )
    briefing_paths = {
        domain["path"]
        for domain in domains
        if domain.get("include_in_briefing", False)
    }
    for path_value in briefing_paths:
        if any(
            other != path_value
            and path_value.startswith(other.rstrip("/") + "/")
            for other in briefing_paths
        ):
            raise ValueError(
                f"workspace registry briefing paths may not overlap: {path_value}"
            )
    return registry


def load_policy(
    workspace: str | Path,
    *,
    registry: dict[str, Any] | None = None,
    required: bool = False,
) -> dict[str, Any] | None:
    """Load the user-owned delegation policy without modifying the workspace."""
    root = Path(workspace).expanduser().resolve()
    path = policy_path(root)
    if not path.exists():
        if required:
            raise ValueError(f"assistant policy is missing: {POLICY_FILENAME}")
        return None
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"assistant policy is not a regular file: {POLICY_FILENAME}")
    try:
        data = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeySafeLoader)
        policy = _normalize(data)
    except (OSError, UnicodeError, yaml.YAMLError, ValueError, RecursionError) as exc:
        raise ValueError(f"invalid assistant policy: {exc}") from exc
    if not isinstance(policy, dict):
        raise ValueError("assistant policy must contain a mapping")
    if policy.get("$schema") != f"./{POLICY_SCHEMA_FILENAME}":
        raise ValueError(f"assistant policy $schema must be ./{POLICY_SCHEMA_FILENAME}")

    schema_file = policy_schema_path(root)
    if schema_file.is_symlink() or not schema_file.is_file():
        raise ValueError(
            f"assistant policy schema is missing or not a regular file: {POLICY_SCHEMA_FILENAME}"
        )
    try:
        schema = json.loads(schema_file.read_text(encoding="utf-8"))
        if not isinstance(schema, dict):
            raise ValueError("assistant policy schema must contain an object")
        Draft202012Validator.check_schema(schema)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"invalid assistant policy schema: {exc}") from exc
    schema_errors = sorted(
        Draft202012Validator(schema).iter_errors(policy),
        key=lambda error: tuple(str(part) for part in error.absolute_path),
    )
    if schema_errors:
        raise ValueError(
            f"assistant policy does not match its schema: {schema_errors[0].message}"
        )

    active_registry = registry if registry is not None else load_registry(root)
    registered = (
        {domain["path"] for domain in domains(active_registry)}
        if active_registry is not None
        else set(CORE_ROOTS)
    )
    for configured in policy["delegation"]["workspace"]["allowed_domains"]:
        if configured not in registered:
            raise ValueError(
                f"assistant policy allowed domain is not registered: {configured}"
            )
    workspace_policy = policy["delegation"]["workspace"]
    scheduled_policy = policy["scheduled_work"]
    if not set(scheduled_policy["allowed_actions"]).issubset(
        set(workspace_policy["allowed_actions"])
    ):
        raise ValueError(
            "assistant policy scheduled actions must be allowed by workspace delegation"
        )
    report_destination = scheduled_policy["report_destination"]
    if not any(_path_is_within(report_destination, allowed) for allowed in registered):
        raise ValueError(
            "assistant policy scheduled report destination is outside registered workspace domains: "
            f"{report_destination}"
        )
    if not any(
        _path_is_within(report_destination, allowed)
        for allowed in workspace_policy["allowed_domains"]
    ):
        raise ValueError(
            "assistant policy scheduled report destination is outside allowed workspace domains"
        )
    return policy


def policy_allows(
    policy: dict[str, Any] | None,
    action: str,
    destination: str | None = None,
    *,
    scheduled: bool = False,
) -> bool:
    """Return whether a policy grants a local action in the requested scope."""
    if not policy:
        return False
    if scheduled:
        section = policy.get("scheduled_work", {})
        if not section.get("enabled") or action not in section.get("allowed_actions", []):
            return False
        workspace_section = policy.get("delegation", {}).get("workspace", {})
        if (
            not workspace_section.get("enabled")
            or action not in workspace_section.get("allowed_actions", [])
        ):
            return False
    else:
        section = policy.get("delegation", {}).get("workspace", {})
        if not section.get("enabled") or action not in section.get("allowed_actions", []):
            return False
    if destination is None:
        return True
    allowed_paths = section.get(
        "allowed_domains",
        policy.get("delegation", {}).get("workspace", {}).get("allowed_domains", []),
    )
    if scheduled and action == "generate_reports":
        allowed_paths = [section.get("report_destination")]
    return any(
        _path_is_within(destination, allowed)
        for allowed in allowed_paths
    )


def domains(registry: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not registry:
        return []
    return [domain for domain in registry.get("domains", []) if isinstance(domain, dict)]


def allowed_root_domains(registry: dict[str, Any] | None) -> set[str]:
    return {domain["path"].split("/", 1)[0] for domain in domains(registry)}


def resolve_route_destination(
    registry: dict[str, Any] | None,
    route: str,
    tags: list[str] | None = None,
) -> str | None:
    """Resolve a route, preferring the most-specific matching registered tags."""
    if not registry:
        return None
    normalized_tags = {str(tag).strip().lower() for tag in tags or [] if str(tag).strip()}
    candidates = []
    for domain in domains(registry):
        if domain.get("route") != route:
            continue
        required_tags = {str(tag).strip().lower() for tag in domain.get("tags", [])}
        if not required_tags.issubset(normalized_tags):
            continue
        candidates.append((len(required_tags), domain.get("kind") == "core", domain["path"]))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (-item[0], not item[1], item[2]))
    return candidates[0][2]


def briefing_sources(registry: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Return registered sources explicitly opted into daily briefings."""
    sources = []
    for domain in domains(registry):
        if not domain.get("include_in_briefing", False):
            continue
        sources.append(
            {
                "path": domain["path"],
                "heading": domain.get("label") or domain["path"],
                "category": domain.get("briefing_category") or "extension",
            }
        )
    return sources
