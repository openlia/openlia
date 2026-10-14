"""Runtime enforcement for the user-owned OpenLia workspace policy.

The policy file remains user-owned and is loaded at tool-dispatch time. This
plugin deliberately treats the model's intent as untrusted: read-only tools
are allowed, while writes and side effects must either be delegated by the
policy or pass through Hermes' existing approval gate.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any


LOGGER = logging.getLogger("openlia.policy")
PLUGIN_NAME = "openlia-policy"
DEFAULT_HELPER = Path(
    "/opt/data/skills/workspace-template-customization/scripts/workspace_registry.py"
)
DEFAULT_WORKSPACE = Path("/opt/data/workspace")

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
_REDIRECT = re.compile(r"(?<!>)>(?!>)")
_COMMAND_SPLIT = re.compile(r"&&|\|\||[;|]")

_READ_ONLY_TOOLS = {
    "read_file",
    "search_files",
    "session_search",
    "skill_view",
    "skills_list",
    "web_extract",
    "web_search",
    "vision_analyze",
    "ingestion_search",
    "ingestion_get_document",
    "ingestion_status",
}
_READ_ONLY_COMMANDS = {
    "basename",
    "cat",
    "cut",
    "date",
    "dirname",
    "du",
    "file",
    "find",
    "git-diff",
    "git-log",
    "git-show",
    "grep",
    "head",
    "ls",
    "pwd",
    "readlink",
    "remind",
    "rg",
    "sed",
    "sort",
    "stat",
    "tail",
    "test",
    "tr",
    "uniq",
    "wc",
    "which",
    "whoami",
}
_GIT_READ_COMMANDS = {"status", "log", "diff", "show", "branch", "rev-parse"}
_BROWSER_READ_TOOLS = {
    "browser_back",
    "browser_get_images",
    "browser_navigate",
    "browser_snapshot",
    "browser_vision",
}
_BROWSER_MUTATING_TOOLS = {
    "browser_click",
    "browser_press",
    "browser_scroll",
    "browser_type",
}
_UNKNOWN_MUTATION = re.compile(
    r"\b(?:archive|commit|create|delete|execute|fork|generate|install|manage|modify|move|remove|save|submit|update|upload|write)\b",
    re.IGNORECASE,
)


class PolicyLoadError(RuntimeError):
    """The policy or workspace registry could not be trusted."""


@dataclass(frozen=True)
class Authority:
    helper: ModuleType
    registry: dict[str, Any]
    policy: dict[str, Any] | None


class AuthorityStore:
    """Load policy state atomically and refresh it when user files change."""

    def __init__(self, workspace_root: Path, helper_path: Path | None = None) -> None:
        self.workspace_root = workspace_root.expanduser().resolve()
        self.helper_path = helper_path or Path(
            os.environ.get("OPENLIA_POLICY_HELPER", str(DEFAULT_HELPER))
        )
        self._lock = threading.RLock()
        self._signature: tuple[Any, ...] | None = None
        self._authority: Authority | None = None

    def _file_signature(self) -> tuple[Any, ...]:
        paths = (
            self.workspace_root / "workspace.yaml",
            self.workspace_root / "workspace.schema.json",
            self.workspace_root / "assistant-policy.yaml",
            self.workspace_root / "assistant-policy.schema.json",
        )
        signature: list[Any] = []
        for path in paths:
            try:
                stat = path.stat()
            except OSError:
                signature.append((str(path), None))
            else:
                signature.append((str(path), stat.st_mtime_ns, stat.st_size))
        return tuple(signature)

    def _load_helper(self) -> ModuleType:
        if self.helper_path.is_symlink() or not self.helper_path.is_file():
            raise PolicyLoadError(f"policy helper is unavailable: {self.helper_path}")
        spec = importlib.util.spec_from_file_location(
            "openlia_workspace_registry", self.helper_path
        )
        if spec is None or spec.loader is None:
            raise PolicyLoadError(f"policy helper cannot be loaded: {self.helper_path}")
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as exc:  # pragma: no cover - exact dependency errors vary by runtime
            raise PolicyLoadError(f"policy helper failed to load: {exc}") from exc
        return module

    def load(self) -> Authority:
        signature = self._file_signature()
        with self._lock:
            if self._authority is not None and signature == self._signature:
                return self._authority
            helper = self._load_helper()
            try:
                registry = helper.load_registry(self.workspace_root, required=True)
                policy = helper.load_policy(
                    self.workspace_root, registry=registry, required=False
                )
            except Exception as exc:
                raise PolicyLoadError(str(exc)) from exc
            if not isinstance(registry, dict):
                raise PolicyLoadError("workspace registry did not contain a mapping")
            if policy is not None and not isinstance(policy, dict):
                raise PolicyLoadError("assistant policy did not contain a mapping")
            self._authority = Authority(helper, registry, policy)
            self._signature = signature
            return self._authority


def _workspace_root() -> Path:
    configured = os.environ.get("OPENLIA_WORKSPACE_ROOT")
    if configured:
        return Path(configured)
    if DEFAULT_WORKSPACE.is_dir():
        return DEFAULT_WORKSPACE
    return Path.cwd()


def _directive(action: str, message: str, rule_key: str | None = None) -> dict[str, str]:
    result = {"action": action, "message": message}
    if rule_key:
        result["rule_key"] = rule_key
    return result


def _block(message: str) -> dict[str, str]:
    return _directive("block", message)


def _approve(message: str, rule_key: str) -> dict[str, str]:
    return _directive("approve", message, rule_key)


def _within(path: str, parent: str) -> bool:
    if not isinstance(path, str) or not isinstance(parent, str):
        return False
    path_parts = path.strip("/").split("/")
    parent_parts = parent.strip("/").split("/")
    if not path_parts or not parent_parts:
        return False
    if any(not part or part in {".", ".."} for part in path_parts + parent_parts):
        return False
    return path_parts[: len(parent_parts)] == parent_parts


def _policy_path_allowed(authority: Authority, relative_path: str) -> bool:
    policy = authority.policy
    if not policy:
        return False
    workspace = policy.get("delegation", {}).get("workspace", {})
    if not workspace.get("enabled"):
        return False
    return any(
        _within(relative_path, allowed)
        for allowed in workspace.get("allowed_domains", [])
    )


def _registered_path(authority: Authority, relative_path: str) -> bool:
    domains = authority.helper.domains(authority.registry)
    return any(_within(relative_path, domain.get("path")) for domain in domains)


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
    return relative, os.path.lexists(resolved)


def _external_action(tool_name: str) -> str | None:
    name = tool_name.lower().replace("-", "_")
    if any(word in name for word in ("purchase", "checkout", "buy", "order")):
        return "purchases"
    if any(
        word in name
        for word in ("transfer", "payment", "pay", "financial", "transaction")
    ):
        return "financial_transactions"
    if "calendar" in name and any(
        word in name for word in ("create", "update", "modify", "delete", "move", "add")
    ):
        return "modify_external_calendar"
    if any(
        word in name
        for word in ("send", "message", "email", "notify", "post", "reply", "dm")
    ):
        return "send_messages"
    return None


def _patch_operations(args: dict[str, Any]) -> list[tuple[str, str, str | None]]:
    """Return ``(operation, path, second_path)`` records from an Hermes patch."""
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


class PolicyEnforcer:
    """Translate Hermes tool calls into OpenLia policy decisions."""

    def __init__(
        self,
        workspace_root: Path | None = None,
        helper_path: Path | None = None,
    ) -> None:
        self.workspace_root = (workspace_root or _workspace_root()).expanduser().resolve()
        self.store = AuthorityStore(self.workspace_root, helper_path)
        self._scheduled_sessions: set[str] = set()
        self._session_lock = threading.Lock()

    def _set_scheduled(self, session_id: Any, platform: Any) -> None:
        if not isinstance(session_id, str) or not session_id:
            return
        with self._session_lock:
            if str(platform).lower() == "cron":
                self._scheduled_sessions.add(session_id)
            else:
                self._scheduled_sessions.discard(session_id)

    def _is_scheduled(self, session_id: Any) -> bool:
        with self._session_lock:
            return isinstance(session_id, str) and session_id in self._scheduled_sessions

    def on_session_start(self, session_id: str = "", platform: str = "", **_: Any) -> None:
        self._set_scheduled(session_id, platform)

    def on_pre_llm_call(
        self, session_id: str = "", platform: str = "", **_: Any
    ) -> None:
        # pre_tool_call does not carry platform, so retain the trusted Hermes
        # surface classification for scheduled-work path restrictions.
        self._set_scheduled(session_id, platform)

    def on_session_end(self, session_id: str = "", **_: Any) -> None:
        with self._session_lock:
            self._scheduled_sessions.discard(session_id)

    def _load(self) -> Authority:
        return self.store.load()

    def _workspace_action(
        self,
        authority: Authority,
        action: str,
        relative_path: str,
        scheduled: bool,
    ) -> dict[str, str] | None:
        if not _registered_path(authority, relative_path):
            return _block(
                f"OpenLia policy blocked {action}: {relative_path} is outside registered workspace domains."
            )
        policy = authority.policy
        if policy is None:
            return _approve(
                f"No assistant policy delegates {action} for {relative_path}; approval is required.",
                "openlia.policy.missing",
            )
        scheduled_policy = policy.get("scheduled_work", {})
        if scheduled:
            if not scheduled_policy.get("enabled"):
                return _block("OpenLia policy blocked scheduled work: scheduled_work is disabled.")
            if action not in scheduled_policy.get("allowed_actions", []):
                return _block(
                    f"OpenLia policy blocked scheduled action {action} for {relative_path}."
                )
            destination = scheduled_policy.get("report_destination")
            if action == "generate_reports" and not _within(relative_path, destination):
                return _block(
                    "OpenLia policy blocked the scheduled report: its path is outside "
                    f"scheduled_work.report_destination ({destination})."
                )
        try:
            delegated = authority.helper.policy_allows(
                policy, action, relative_path, scheduled=scheduled
            )
        except Exception as exc:
            raise PolicyLoadError(f"policy authorization failed: {exc}") from exc
        if delegated:
            return None
        return _approve(
            f"OpenLia policy does not delegate {action} for {relative_path}; approval is required.",
            f"openlia.policy.{action}",
        )

    def _destructive_action(
        self, authority: Authority, key: str, relative_path: str
    ) -> dict[str, str] | None:
        policy = authority.policy
        if policy is None:
            return _approve(
                f"No assistant policy authorizes destructive action {key} on {relative_path}.",
                f"openlia.policy.{key}",
            )
        decision = policy.get("delegation", {}).get("destructive", {}).get(key)
        if decision == "deny":
            return _block(f"OpenLia policy denies {key} for {relative_path}.")
        if decision == "ask":
            return _approve(
                f"OpenLia policy requires approval for {key} on {relative_path}.",
                f"openlia.policy.{key}",
            )
        raise PolicyLoadError(f"invalid destructive policy decision for {key}: {decision!r}")

    def _external_decision(
        self, authority: Authority, key: str, tool_name: str
    ) -> dict[str, str] | None:
        policy = authority.policy
        if policy is None:
            return _approve(
                f"No assistant policy authorizes external action {key} ({tool_name}).",
                f"openlia.policy.{key}",
            )
        decision = policy.get("delegation", {}).get("external", {}).get(key)
        if decision == "allow":
            return None
        if decision == "deny":
            return _block(f"OpenLia policy denies external action {key} ({tool_name}).")
        if decision == "ask":
            return _approve(
                f"OpenLia policy requires approval for external action {key} ({tool_name}).",
                f"openlia.policy.{key}",
            )
        raise PolicyLoadError(f"invalid external policy decision for {key}: {decision!r}")

    def _workspace_tool_decision(
        self, authority: Authority, tool_name: str, args: dict[str, Any], scheduled: bool
    ) -> dict[str, str] | None:
        operations = _patch_operations(args) if tool_name == "patch" else [
            ("replace", args.get("path"), None)
        ]
        if not operations or any(not isinstance(path, str) for _, path, _ in operations):
            return _block(f"OpenLia policy could not determine the target path for {tool_name}.")

        pending: dict[str, str] | None = None
        for operation, raw_path, second_path in operations:
            target = _safe_workspace_target(self.workspace_root, raw_path)
            if target is None:
                return _block(f"OpenLia policy blocked unsafe workspace path: {raw_path}.")
            relative_path, exists = target
            if not _registered_path(authority, relative_path):
                return _block(
                    f"OpenLia policy blocked workspace path outside registered domains: {relative_path}."
                )

            if operation == "delete":
                if authority.policy is not None and not _policy_path_allowed(authority, relative_path):
                    return _block(
                        f"OpenLia policy blocked deletion outside allowed domains: {relative_path}."
                    )
                decision = self._destructive_action(authority, "delete_records", relative_path)
            elif operation == "move":
                if not isinstance(second_path, str):
                    return _block("OpenLia policy blocked a move with no destination path.")
                destination = _safe_workspace_target(self.workspace_root, second_path)
                if destination is None:
                    return _block(f"OpenLia policy blocked unsafe move destination: {second_path}.")
                destination_path, _ = destination
                if not _registered_path(authority, destination_path):
                    return _block(
                        f"OpenLia policy blocked move destination outside registered domains: {destination_path}."
                    )
                action = "archive_records" if _within(destination_path, "archive") else "update_records"
                decision = self._workspace_action(authority, action, relative_path, scheduled)
                if decision is None:
                    decision = self._workspace_action(authority, action, destination_path, scheduled)
            else:
                report_destination = (
                    authority.policy or {}
                ).get("scheduled_work", {}).get("report_destination")
                is_report = isinstance(report_destination, str) and _within(
                    relative_path, report_destination
                )
                if operation == "add" and exists:
                    decision = self._destructive_action(
                        authority, "overwrite_records", relative_path
                    )
                elif operation == "add" or (operation == "replace" and not exists):
                    action = "generate_reports" if is_report else "create_records"
                    decision = self._workspace_action(authority, action, relative_path, scheduled)
                elif operation == "update":
                    action = "generate_reports" if is_report else "update_records"
                    decision = self._workspace_action(authority, action, relative_path, scheduled)
                else:
                    decision = self._workspace_action(
                        authority,
                        "generate_reports" if is_report else "update_records",
                        relative_path,
                        scheduled,
                    )
                    if decision is None:
                        decision = self._destructive_action(
                            authority, "overwrite_records", relative_path
                        )
            if decision is not None and decision.get("action") == "block":
                return decision
            if decision is not None:
                pending = pending or decision
        return pending

    def _terminal_decision(
        self, authority: Authority, args: dict[str, Any], scheduled: bool
    ) -> dict[str, str] | None:
        command = args.get("command") or args.get("cmd")
        if not isinstance(command, str) or not command.strip():
            return _block("OpenLia policy blocked a terminal call with no command.")
        lowered = command.lower()
        external_key = None
        if re.search(r"\b(?:curl|wget)\b.*(?:-x\s*(?:post|put|patch|delete)|--data|--form)", lowered):
            external_key = "send_messages"
        elif re.search(r"\b(?:git\s+push|gh\s+(?:pr|issue)\s+(?:create|comment)|npm\s+publish)\b", lowered):
            external_key = "send_messages"
        if external_key:
            return self._external_decision(authority, external_key, "terminal")

        if re.search(r"\bgit\s+(?:add|commit)\b", lowered):
            explicit_cwd = args.get("cwd")
            if isinstance(explicit_cwd, str) and explicit_cwd.strip():
                cwd = Path(explicit_cwd).expanduser()
                if not cwd.is_absolute():
                    cwd = self.workspace_root / cwd
                try:
                    cwd.resolve(strict=False).relative_to(self.workspace_root)
                except (OSError, ValueError):
                    return _block("OpenLia policy blocked Git writes outside the workspace.")
            policy = authority.policy
            if policy is None:
                return _approve(
                    "No assistant policy delegates local Git commits; approval is required.",
                    "openlia.policy.local_git_commits",
                )
            delegated = authority.helper.policy_allows(
                policy, "local_git_commits", scheduled=scheduled
            )
            if scheduled and not policy.get("scheduled_work", {}).get("enabled"):
                return _block("OpenLia policy blocked scheduled Git work: scheduled_work is disabled.")
            if scheduled and "local_git_commits" not in policy.get("scheduled_work", {}).get("allowed_actions", []):
                return _block("OpenLia policy blocked scheduled local Git commits.")
            return None if delegated else _approve(
                "OpenLia policy does not delegate local Git commits; approval is required.",
                "openlia.policy.local_git_commits",
            )

        if re.search(r"\b(?:rm|rmdir)\b", lowered):
            return self._destructive_action(authority, "delete_records", "terminal target")
        if re.search(r"\bgit\s+(?:clean|reset|restore|checkout)\b", lowered):
            return self._destructive_action(authority, "overwrite_records", "terminal target")
        if _REDIRECT.search(command) or re.search(
            r"\b(?:cp|install|mkdir|mv|tee|touch|truncate|shred|dd)\b", lowered
        ) or re.search(r"\b(?:python|python3|node|bun|ruby|perl)\b", lowered):
            return _approve(
                "This terminal command may modify workspace state; Hermes approval is required.",
                "openlia.policy.terminal_write",
            )

        segments = [segment.strip() for segment in _COMMAND_SPLIT.split(command) if segment.strip()]
        if segments and all(self._read_only_command(segment) for segment in segments):
            return None
        return _approve(
            "OpenLia policy cannot classify this terminal command as read-only; approval is required.",
            "openlia.policy.terminal_unknown",
        )

    @staticmethod
    def _read_only_command(segment: str) -> bool:
        tokens = segment.split()
        if not tokens:
            return True
        while tokens and (tokens[0] in {"sudo", "env", "timeout"} or tokens[0].startswith("-")):
            tokens.pop(0)
        if not tokens:
            return True
        command = tokens[0].split("/")[-1]
        if command == "git":
            return len(tokens) > 1 and tokens[1] in _GIT_READ_COMMANDS
        return command in _READ_ONLY_COMMANDS

    def decide(
        self,
        tool_name: str,
        args: dict[str, Any] | None,
        *,
        session_id: str = "",
    ) -> dict[str, str] | None:
        args = args if isinstance(args, dict) else {}
        if tool_name in _READ_ONLY_TOOLS or tool_name in _BROWSER_READ_TOOLS:
            return None
        authority = self._load()
        scheduled = self._is_scheduled(session_id)

        if tool_name in {"write_file", "patch"}:
            return self._workspace_tool_decision(authority, tool_name, args, scheduled)
        if tool_name in {
            "ingestion_capture",
            "save_document_password",
            "ingestion_retry",
            "retry_ingestion_with_password_profile",
            "ingestion_acknowledge",
            "ingestion_complete_action",
            "ingestion_recover",
            "ingestion_update_document",
            "ingestion_tag",
        }:
            action = "capture" if tool_name in {"ingestion_capture", "save_document_password"} else "update_records"
            relative_path = "sources/document-passwords.toml" if tool_name == "save_document_password" else "sources"
            return self._workspace_action(authority, action, relative_path, scheduled)
        if tool_name == "terminal":
            return self._terminal_decision(authority, args, scheduled)
        if tool_name in _BROWSER_MUTATING_TOOLS:
            return _approve(
                f"Browser action {tool_name} may affect an external service; approval is required.",
                "openlia.policy.browser_mutation",
            )
        if tool_name in {"cronjob_manage", "manage_connections"}:
            return _approve(
                f"Hermes tool {tool_name} changes external or scheduled state; approval is required.",
                "openlia.policy.external_control",
            )

        external_key = _external_action(tool_name)
        if external_key:
            return self._external_decision(authority, external_key, tool_name)

        if tool_name.startswith("mcp_") or tool_name.startswith("connectors__"):
            lower = tool_name.lower()
            if re.search(r"(?:search|query|get|list|read|fetch|lookup|find)", lower):
                return None
            return _approve(
                f"External tool {tool_name} is not classified as read-only; approval is required.",
                "openlia.policy.external_unknown",
            )
        if tool_name.startswith("browser_"):
            return _approve(
                f"Browser tool {tool_name} is not classified as read-only; approval is required.",
                "openlia.policy.browser_unknown",
            )
        if _UNKNOWN_MUTATION.search(tool_name.replace("_", " ")):
            return _approve(
                f"Tool {tool_name} may change state and is not classified by OpenLia; approval is required.",
                "openlia.policy.unknown_mutation",
            )
        return None

    def pre_tool_call(
        self,
        tool_name: str,
        args: dict[str, Any] | None = None,
        session_id: str = "",
        **_: Any,
    ) -> dict[str, str] | None:
        try:
            decision = self.decide(tool_name, args, session_id=session_id)
        except Exception as exc:
            LOGGER.error("OpenLia policy evaluation failed for %s: %s", tool_name, exc)
            return _block(f"OpenLia policy evaluation failed closed: {exc}")
        if decision:
            LOGGER.info(
                "policy decision=%s tool=%s rule=%s",
                decision.get("action"),
                tool_name,
                decision.get("rule_key", ""),
            )
        return decision

    @staticmethod
    def post_tool_call(
        tool_name: str,
        status: str | None = None,
        error_type: str | None = None,
        **_: Any,
    ) -> None:
        LOGGER.info(
            "policy tool result tool=%s status=%s error_type=%s",
            tool_name,
            status or "unknown",
            error_type or "",
        )


def register(ctx: Any) -> None:
    enforcer = PolicyEnforcer()
    ctx.register_hook("on_session_start", enforcer.on_session_start)
    ctx.register_hook("pre_llm_call", enforcer.on_pre_llm_call)
    ctx.register_hook("on_session_end", enforcer.on_session_end)
    ctx.register_hook("pre_tool_call", enforcer.pre_tool_call)
    ctx.register_hook("post_tool_call", enforcer.post_tool_call)
