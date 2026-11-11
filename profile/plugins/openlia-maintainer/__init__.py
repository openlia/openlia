"""Workspace Maintainer and inline OpenUI authoring tools for OpenLia.

Provides read-only OpenUI discovery/validation (`openui_describe`, `openui_validate`),
Workspace Maintainer inspection/triage (`maintainer_status`, `maintainer_audit`,
`maintainer_triage_issue`), and non-blocking post-mutation structural advisory feedback.
Security and tool approvals are handled natively by Hermes.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any


def _load_maintainer_bridge_cls() -> Any:
    try:
        from .maintainer_bridge import MaintainerBridge  # type: ignore[import-not-found]

        return MaintainerBridge
    except Exception:
        bridge_path = Path(__file__).resolve().parent / "maintainer_bridge.py"
        spec = importlib.util.spec_from_file_location(
            "openlia_maintainer_bridge", bridge_path
        )
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load maintainer_bridge: {bridge_path}")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.MaintainerBridge


MaintainerBridge = _load_maintainer_bridge_cls()

LOGGER = logging.getLogger("openlia.maintainer")
PLUGIN_NAME = "openlia-maintainer"
DEFAULT_WORKSPACE = Path("/opt/data/workspace")
OPENUI_CLI = "/usr/local/lib/openlia/openui-authoring.js"
MAX_OPENUI_INPUT = 262_144

_PATCH_FILE_HEADER = re.compile(
    r"^\*\*\*\s*(?P<operation>Update|Add|Delete)\s+File:\s*(?P<path>.+?)\s*$",
    re.MULTILINE,
)
_PATCH_MOVE_HEADER = re.compile(
    r"^\*\*\*\s*Move\s+File:\s*(?P<source>.+?)\s*->\s*(?P<target>.+?)\s*$",
    re.MULTILINE,
)
_PATCH_MOVE_TO_HEADER = re.compile(
    r"^\*\*\*\s*Move\s+File:\s*(?P<source>.+?)\s*$\n\*\*\*\s*Move\s+to:\s*(?P<target>.+?)\s*$",
    re.MULTILINE,
)


def _openui_request(request: dict[str, Any]) -> str:
    """Invoke the bundled UI implementation, never a shell or document code."""
    try:
        result = subprocess.run(
            ["/usr/local/bin/bun", OPENUI_CLI],
            cwd=str(Path(OPENUI_CLI).parent),
            input=json.dumps(request, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
        response = json.loads(result.stdout)
        if not isinstance(response, dict) or "status" not in response:
            raise ValueError("invalid authoring service response")
        if result.returncode and response.get("status") == "ok":
            raise ValueError("authoring service exited unsuccessfully")
        return json.dumps(response, ensure_ascii=False)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return json.dumps({
            "status": "unavailable",
            "validationLevel": "none",
            "message": "The bundled OpenUI authoring validator is unavailable. Do not claim schema validation or rendering success; report the blocker and use Workspace UI preview.",
        })


def _workspace_root() -> Path:
    configured = os.environ.get("OPENLIA_WORKSPACE_ROOT")
    if configured:
        return Path(configured)
    if DEFAULT_WORKSPACE.is_dir():
        return DEFAULT_WORKSPACE
    return Path.cwd()


def _safe_workspace_target(
    workspace_root: Path, raw_path: Any
) -> tuple[str, bool] | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = workspace_root / candidate
    try:
        resolved = candidate.resolve(strict=False)
        relative = resolved.relative_to(workspace_root).as_posix()
    except (OSError, ValueError):
        return None
    if not relative or relative == "." or relative.startswith("../"):
        return None
    current = workspace_root
    for part in relative.split("/"):
        current = current / part
        if current.is_symlink():
            return None
    return relative, os.path.lexists(resolved)


def _patch_operations(args: dict[str, Any]) -> list[tuple[str, str, str | None]]:
    """Return ``(operation, path, second_path)`` records from a Hermes patch."""
    mode = args.get("mode") or "replace"
    if mode != "patch":
        path = args.get("path")
        return [("replace", path, None)] if isinstance(path, str) else []
    body = args.get("patch") or ""
    if not isinstance(body, str):
        return []
    operations = [
        (match.group("operation").lower(), match.group("path").strip(), None)
        for match in _PATCH_FILE_HEADER.finditer(body)
    ]
    operations.extend(
        ("move", match.group("source").strip(), match.group("target").strip())
        for match in _PATCH_MOVE_HEADER.finditer(body)
    )
    operations.extend(
        ("move", match.group("source").strip(), match.group("target").strip())
        for match in _PATCH_MOVE_TO_HEADER.finditer(body)
    )
    return operations


class MaintainerPlugin:
    """Provide Workspace Maintainer and inline OpenUI authoring tools and post-mutation feedback."""

    def __init__(
        self,
        workspace_root: Path | None = None,
        maintainer_root: Path | None = None,
    ) -> None:
        self.workspace_root = (workspace_root or _workspace_root()).expanduser().resolve()
        self.maintainer = MaintainerBridge(
            self.workspace_root, maintainer_root=maintainer_root
        )

    def _mutated_workspace_paths(
        self, tool_name: str, args: dict[str, Any] | None
    ) -> list[str]:
        if not isinstance(args, dict):
            return []
        if tool_name == "write_file":
            raw = args.get("path")
            target = _safe_workspace_target(self.workspace_root, raw)
            return [target[0]] if target else []
        if tool_name == "patch":
            rels: list[str] = []
            for op, path, second in _patch_operations(args):
                candidate_raw = second if op == "move" and second else path
                target = _safe_workspace_target(self.workspace_root, candidate_raw)
                if target:
                    rels.append(target[0])
            return rels
        return []

    def post_tool_call(
        self,
        tool_name: str,
        args: dict[str, Any] | None = None,
        status: str | None = None,
        error_type: str | None = None,
        **_: Any,
    ) -> dict[str, str] | None:
        if error_type or (status and status not in {"ok", "success", "completed"}):
            return None
        advisories: list[str] = []
        if tool_name in {"write_file", "patch"}:
            try:
                mutated = self._mutated_workspace_paths(tool_name, args)
                if mutated:
                    advisory = self.maintainer.format_post_mutation_feedback(mutated)
                    if advisory:
                        advisories.append(advisory)
            except Exception as exc:
                LOGGER.warning("maintainer post-tool validation failed: %s", exc)
        if advisories:
            combined = "\n".join(advisories)
            return {"advisory": combined, "message": combined}
        return None

    @staticmethod
    def _unpack_tool_args(
        first_arg: Any = None,
        kwargs: dict[str, Any] | None = None,
        primary_key: str | None = None,
    ) -> dict[str, Any]:
        merged: dict[str, Any] = {}
        if isinstance(first_arg, dict):
            merged.update(first_arg)
        elif first_arg is not None and primary_key:
            merged[primary_key] = first_arg
        if kwargs:
            merged.update(kwargs)
        return merged

    def tool_maintainer_status(
        self,
        path: Any = None,
        state: str | None = None,
        **kwargs: Any,
    ) -> str:
        params = self._unpack_tool_args(path, kwargs, primary_key="path")
        rel_path = params.get("path")
        state_val = params.get("state", state)
        res = self.maintainer.status(
            relative_path=rel_path if isinstance(rel_path, str) else None,
            state=state_val if isinstance(state_val, str) else None,
        )
        return json.dumps(res, ensure_ascii=False, sort_keys=True)

    def tool_openui_describe(self, component: Any = None, **kwargs: Any) -> str:
        params = self._unpack_tool_args(component, kwargs, primary_key="component")
        comp = params.get("component")
        if comp is not None and (not isinstance(comp, str) or len(comp) > 100):
            return json.dumps({"status": "error", "message": "component must be a string of at most 100 characters"})
        return _openui_request({"action": "describe", "component": comp} if comp is not None else {"action": "describe"})

    def tool_openui_validate(self, content: Any = None, format: str = "markdown", **kwargs: Any) -> str:
        params = self._unpack_tool_args(content, kwargs, primary_key="content")
        raw_content = params.get("content")
        fmt = params.get("format", format)
        if not isinstance(raw_content, str) or len(raw_content) > MAX_OPENUI_INPUT:
            return json.dumps({"status": "error", "validationLevel": "none", "message": f"content must be a string of at most {MAX_OPENUI_INPUT} characters"})
        if not isinstance(fmt, str) or fmt not in {"markdown", "openui"}:
            return json.dumps({"status": "error", "validationLevel": "none", "message": "format must be markdown or openui"})
        return _openui_request({"action": "validate", "content": raw_content, "format": fmt})

    def tool_maintainer_audit(self, *_: Any, **__: Any) -> str:
        res = self.maintainer.run_audit()
        return json.dumps(res, ensure_ascii=False, sort_keys=True)

    def tool_maintainer_triage_issue(
        self,
        issue_id: Any = None,
        action: str | None = None,
        reason: str | None = None,
        **kwargs: Any,
    ) -> str:
        params = self._unpack_tool_args(issue_id, kwargs, primary_key="issue_id")
        resolved_issue_id = str(params.get("issue_id") or "")
        resolved_action = str(params.get("action") or action or "")
        resolved_reason = params.get("reason", reason)
        res = self.maintainer.triage_issue(
            issue_id=resolved_issue_id,
            action=resolved_action,
            actor="agent",
            reason=resolved_reason if isinstance(resolved_reason, str) else None,
        )
        return json.dumps(res, ensure_ascii=False, sort_keys=True)


def register(ctx: Any) -> None:
    plugin = MaintainerPlugin()
    ctx.register_hook("post_tool_call", plugin.post_tool_call)
    if hasattr(ctx, "register_tool"):
        for name, description, parameters, handler in [
            (
                "openui_describe",
                "Discover supported inline OpenUI components, or inspect one component's runtime schema, exact property names, enums, argument order, and tested recipes. Read-only and offline.",
                {"type": "object", "properties": {"component": {"type": "string", "maxLength": 100}}, "additionalProperties": False},
                plugin.tool_openui_describe,
            ),
            (
                "openui_validate",
                "Validate an unsaved Markdown draft's OpenUI fences (or a raw block) using the UI normalizer and component schemas. Returns block locations and repair diagnostics. Read-only; does not verify runtime rendering or live data. Validate the final document before claiming completion.",
                {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "maxLength": MAX_OPENUI_INPUT, "description": "Exact final Markdown draft or raw OpenUI source; not a file path."},
                        "format": {"type": "string", "enum": ["markdown", "openui"], "default": "markdown"},
                    },
                    "required": ["content"],
                    "additionalProperties": False,
                },
                plugin.tool_openui_validate,
            ),
        ]:
            ctx.register_tool(
                name=name, toolset=PLUGIN_NAME,
                schema={"name": name, "description": description, "parameters": parameters},
                handler=handler, is_async=False, description=description,
            )
        status_schema = {
            "name": "maintainer_status",
            "description": "Inspect Workspace Maintainer open, ignored, and resolved structural findings for the workspace or a specific relative file path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Optional relative file path (e.g. 'family-menu/2026-10-26.md') to filter findings.",
                    },
                    "state": {
                        "type": "string",
                        "enum": ["open", "ignored", "resolved"],
                        "description": "Optional finding state filter.",
                    },
                },
                "additionalProperties": False,
            },
        }
        ctx.register_tool(
            name="maintainer_status",
            toolset=PLUGIN_NAME,
            schema=status_schema,
            handler=plugin.tool_maintainer_status,
            is_async=False,
            description=status_schema["description"],
        )
        audit_schema = {
            "name": "maintainer_audit",
            "description": "Run an on-demand non-destructive Workspace Maintainer audit across the workspace and return active, ignored, and resolved findings.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        }
        ctx.register_tool(
            name="maintainer_audit",
            toolset=PLUGIN_NAME,
            schema=audit_schema,
            handler=plugin.tool_maintainer_audit,
            is_async=False,
            description=audit_schema["description"],
        )
        triage_schema = {
            "name": "maintainer_triage_issue",
            "description": "Ignore or restore a specific Workspace Maintainer finding by exact issue_id in its file.",
            "parameters": {
                "type": "object",
                "required": ["issue_id", "action"],
                "properties": {
                    "issue_id": {
                        "type": "string",
                        "description": "Exact finding issue_id (wm_...).",
                    },
                    "action": {
                        "type": "string",
                        "enum": ["ignore", "restore"],
                        "description": "Whether to ignore or restore the warning.",
                    },
                    "path": {
                        "type": "string",
                        "description": "Relative file path for context.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Optional user reason for ignoring the finding.",
                    },
                },
                "additionalProperties": False,
            },
        }
        ctx.register_tool(
            name="maintainer_triage_issue",
            toolset=PLUGIN_NAME,
            schema=triage_schema,
            handler=plugin.tool_maintainer_triage_issue,
            is_async=False,
            description=triage_schema["description"],
        )
