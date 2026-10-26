"""Runtime enforcement for OpenLia consequential permissions (/opt/data/permissions.yaml).

Ordinary workspace creation, record updates, templates, schemas, and mini-projects
are allowed without domain registration or structural batch gates. Consequential
permissions (destructive actions, external side effects, scheduled work) and
protected system/secret paths remain strictly enforced.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import shlex
import threading
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any


def _load_maintainer_bridge_cls() -> Any:
    try:
        from .maintainer_bridge import MaintainerBridge  # type: ignore[import-not-found]

        return MaintainerBridge
    except Exception:
        bridge_path = Path(__file__).resolve().parent / "maintainer_bridge.py"
        spec = importlib.util.spec_from_file_location(
            "openlia_policy_maintainer_bridge", bridge_path
        )
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load maintainer_bridge: {bridge_path}")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.MaintainerBridge


MaintainerBridge = _load_maintainer_bridge_cls()


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
    "list_document_password_profiles",
    "ingestion_suggest_passwords",
    "maintainer_status",
    "maintainer_audit",
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
_YOUTUBE_URL = re.compile(
    r"https?://(?:(?:www|m)\.)?(?:youtube\.com|youtu\.be)/",
    re.IGNORECASE,
)
_YOUTUBE_TERMINAL_BYPASS = re.compile(
    r"\b(?:yt-dlp|youtube-dl|youtube[_-]transcript[_-]api)\b",
    re.IGNORECASE,
)

_PROTECTED_ROOT_FILES = {
    "README.md",
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "DREAMS.md",
    "feature.schema.json",
    "permissions.yaml",
    "workspace.yaml",
    "workspace.schema.json",
    "assistant-policy.yaml",
    "assistant-policy.schema.json",
    "sources/document-passwords.toml",
}
_PROTECTED_BASENAMES = {
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "DREAMS.md",
}


class PolicyLoadError(RuntimeError):
    """The permissions configuration could not be trusted."""


@dataclass(frozen=True)
class Authority:
    helper: ModuleType
    permissions: dict[str, Any]

    @property
    def policy(self) -> dict[str, Any]:
        return self.permissions


class AuthorityStore:
    """Load consequential permissions atomically and refresh when the file changes."""

    def __init__(
        self,
        workspace_root: Path,
        helper_path: Path | None = None,
        permissions_file: Path | None = None,
    ) -> None:
        self.workspace_root = workspace_root.expanduser().resolve()
        self.helper_path = helper_path or Path(
            os.environ.get("OPENLIA_POLICY_HELPER", str(DEFAULT_HELPER))
        )
        self._explicit_permissions_file = permissions_file
        self._lock = threading.RLock()
        self._signature: tuple[Any, ...] | None = None
        self._authority: Authority | None = None

    @property
    def permissions_file(self) -> Path:
        if self._explicit_permissions_file is not None:
            return self._explicit_permissions_file.expanduser()
        configured = os.environ.get("OPENLIA_PERMISSIONS_FILE")
        if configured:
            return Path(configured).expanduser()
        return self.workspace_root.parent / "permissions.yaml"

    def _file_signature(self) -> tuple[Any, ...]:
        path = self.permissions_file
        try:
            stat = path.lstat()
        except OSError:
            return (str(path), None)
        return (str(path), stat.st_mode, stat.st_mtime_ns, stat.st_size)

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
        except Exception as exc:  # pragma: no cover
            raise PolicyLoadError(f"policy helper failed to load: {exc}") from exc
        return module

    def load(self) -> Authority:
        signature = self._file_signature()
        with self._lock:
            if self._authority is not None and signature == self._signature:
                return self._authority
            helper = self._load_helper()
            try:
                permissions = helper.load_permissions(
                    self.permissions_file, required=False
                )
            except Exception as exc:
                raise PolicyLoadError(str(exc)) from exc
            if not isinstance(permissions, dict):
                raise PolicyLoadError("permissions did not contain a mapping")
            self._authority = Authority(helper, permissions)
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


def _is_protected_workspace_path(relative_path: str) -> bool:
    if relative_path in _PROTECTED_ROOT_FILES:
        return True
    parts = relative_path.split("/")
    if any(part.startswith(".") for part in parts):
        return True
    if parts[-1] in _PROTECTED_BASENAMES:
        return True
    return False


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
    # Reject any symlink along the workspace path
    current = workspace_root
    for part in relative.split("/"):
        current = current / part
        if current.is_symlink():
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


class PolicyEnforcer:
    """Translate Hermes tool calls into OpenLia consequential permission decisions."""

    def __init__(
        self,
        workspace_root: Path | None = None,
        helper_path: Path | None = None,
        permissions_file: Path | None = None,
        maintainer_root: Path | None = None,
    ) -> None:
        self.workspace_root = (workspace_root or _workspace_root()).expanduser().resolve()
        self.store = AuthorityStore(
            self.workspace_root, helper_path, permissions_file=permissions_file
        )
        self.maintainer = MaintainerBridge(
            self.workspace_root, maintainer_root=maintainer_root
        )
        self._scheduled_sessions: set[str] = set()
        self._session_lock = threading.Lock()

    @property
    def permissions_file(self) -> Path:
        return self.store.permissions_file

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
        self._set_scheduled(session_id, platform)

    def on_session_end(self, session_id: str = "", **_: Any) -> None:
        with self._session_lock:
            self._scheduled_sessions.discard(session_id)

    def _load(self) -> Authority:
        return self.store.load()

    def _scheduled_path_decision(
        self, authority: Authority, action: str, relative_path: str
    ) -> dict[str, str] | None:
        scheduled_policy = authority.permissions.get("scheduled_work", {})
        if not scheduled_policy.get("enabled", True):
            return _block("OpenLia policy blocked scheduled work: scheduled_work is disabled.")
        if relative_path.endswith(("-template.md", ".schema.json", "project-manifest.toml", ".openui")):
            return _block(
                f"OpenLia policy blocked scheduled structural edit on {relative_path}."
            )
        destination = scheduled_policy.get("report_destination", "inbox/daily-briefing")
        if _within(relative_path, destination):
            return None
        if action in {"capture", "triage_inbox"} and (
            _within(relative_path, "inbox") or _within(relative_path, "sources")
        ):
            return None
        return _block(
            "OpenLia policy blocked the scheduled report: its path is outside "
            f"scheduled_work.report_destination ({destination})."
        )

    def _destructive_action(
        self, authority: Authority, key: str, relative_path: str
    ) -> dict[str, str] | None:
        decision = authority.permissions.get("destructive", {}).get(key, "ask")
        if decision == "deny":
            return _block(f"OpenLia policy denies {key} for {relative_path}.")
        if decision == "ask":
            return _approve(
                f"OpenLia policy requires approval for {key} on {relative_path}.",
                f"openlia.policy.{key}",
            )
        raise PolicyLoadError(f"invalid destructive permission decision for {key}: {decision!r}")

    def _external_decision(
        self, authority: Authority, key: str, tool_name: str
    ) -> dict[str, str] | None:
        decision = authority.permissions.get("external", {}).get(key, "ask")
        if decision == "allow":
            return None
        if decision == "deny":
            return _block(f"OpenLia policy denies external action {key} ({tool_name}).")
        if decision == "ask":
            return _approve(
                f"OpenLia policy requires approval for external action {key} ({tool_name}).",
                f"openlia.policy.{key}",
            )
        raise PolicyLoadError(f"invalid external permission decision for {key}: {decision!r}")

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

            if _is_protected_workspace_path(relative_path):
                return _block(
                    f"OpenLia policy blocked protected workspace path: {relative_path}."
                )

            decision: dict[str, str] | None = None
            if operation == "delete":
                if scheduled:
                    return _block(
                        f"OpenLia policy blocked scheduled deletion of {relative_path}."
                    )
                decision = self._destructive_action(authority, "delete_records", relative_path)
            elif operation == "move":
                if not isinstance(second_path, str):
                    return _block("OpenLia policy blocked a move with no destination path.")
                destination = _safe_workspace_target(self.workspace_root, second_path)
                if destination is None:
                    return _block(f"OpenLia policy blocked unsafe move destination: {second_path}.")
                destination_path, dest_exists = destination
                if _is_protected_workspace_path(destination_path):
                    return _block(
                        f"OpenLia policy blocked move to protected workspace path: {destination_path}."
                    )
                if scheduled:
                    return _block(
                        f"OpenLia policy blocked scheduled move from {relative_path} to {destination_path}."
                    )
                if dest_exists:
                    decision = self._destructive_action(
                        authority, "overwrite_records", destination_path
                    )
            else:
                if scheduled:
                    if exists and operation in {"add", "replace"}:
                        return _block(
                            f"OpenLia policy blocked scheduled overwrite of {relative_path}."
                        )
                    decision = self._scheduled_path_decision(
                        authority, "generate_reports", relative_path
                    )
                elif exists and operation in {"add", "replace"}:
                    decision = self._destructive_action(
                        authority, "overwrite_records", relative_path
                    )
                else:
                    # Ordinary file creation (write_file/patch add on new path) or
                    # targeted patch update on an existing non-protected file is allowed!
                    decision = None

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
        if _YOUTUBE_TERMINAL_BYPASS.search(command) or (
            _YOUTUBE_URL.search(command)
            and re.search(r"\b(?:curl|wget|python|python3|pip|pip3|uv)\b", command, re.IGNORECASE)
        ):
            return _block(
                "OpenLia policy blocked direct YouTube transcript extraction or helper installation in terminal. "
                "Use ingestion_capture(kind='youtube', url=..., wait_seconds=15) and ingestion_get_document(source_id=...) instead."
            )
        lowered = command.lower()
        external_key = None
        if re.search(r"\b(?:curl|wget)\b.*(?:-x\s*(?:post|put|patch|delete)|--data|--form)", lowered):
            external_key = "send_messages"
        elif re.search(r"\b(?:git\s+push|gh\s+(?:pr|issue)\s+(?:create|comment)|npm\s+publish)\b", lowered):
            external_key = "send_messages"
        if external_key:
            return self._external_decision(authority, external_key, "terminal")

        if self._git_checkpoint_write(command):
            return _block(
                "Workspace checkpoints require review and confirmation in Git Activity. "
                "Use workspace_git_inspect and workspace_git_propose instead of Git write commands."
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

    def _workspace_validation_command(self, command: str) -> bool:
        """Allow only the protected, read-only validator invocation, not Python generally."""
        if re.search(r"[;&|<>`$\n\r]", command):
            return False
        try:
            tokens = shlex.split(command)
        except ValueError:
            return False
        script = str(self.store.helper_path.parent / "validate_workspace.py")
        if (
            len(tokens) < 2
            or tokens[0] not in {"/opt/hermes/.venv/bin/python", "/opt/hermes/.venv/bin/python3"}
            or tokens[1] != script
        ):
            return False
        if len(tokens) < 5 or tokens[2] != "--workspace-root":
            return False
        if Path(tokens[3]).expanduser().resolve() != self.workspace_root:
            return False
        return tokens[4:] in (
            ["--json"],
            ["--skill-templates-root", "/opt/data/skills", "--json"],
        )

    @staticmethod
    def _git_checkpoint_write(command: str) -> bool:
        try:
            tokens = shlex.split(command)
        except ValueError:
            return False  # The general terminal gate still requires approval.
        for index, token in enumerate(tokens):
            if token.rsplit("/", 1)[-1] != "git":
                continue
            cursor = index + 1
            while cursor < len(tokens) and tokens[cursor].startswith("-"):
                cursor += 2 if tokens[cursor] in {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"} else 1
            if cursor < len(tokens) and tokens[cursor] in {"add", "commit", "commit-tree", "update-ref", "update-index", "write-tree"}:
                return True
        return False

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
        if tool_name in {"workspace_git_inspect", "workspace_git_proposals"}:
            return None
        if tool_name == "workspace_git_propose":
            if self._is_scheduled(session_id):
                return _block("Scheduled workspace Git runs are reminder-only; do not create proposals or commits.")
            return None
        if tool_name == "web_extract":
            raw_urls: list[str] = []
            if isinstance(args.get("url"), str):
                raw_urls.append(args["url"])
            if isinstance(args.get("urls"), list):
                raw_urls.extend(str(u) for u in args["urls"] if isinstance(u, str))
            if any(_YOUTUBE_URL.search(u) for u in raw_urls):
                return _block(
                    "OpenLia policy requires YouTube URLs to be processed through the Ingestion Vault. "
                    "Call ingestion_capture(kind='youtube', url=..., wait_seconds=15) and ingestion_get_document(source_id=...) instead."
                )
        if tool_name in _READ_ONLY_TOOLS or tool_name in _BROWSER_READ_TOOLS:
            return None
        if tool_name == "terminal":
            command = args.get("command") or args.get("cmd")
            if isinstance(command, str) and self._workspace_validation_command(command):
                return None
        authority = self._load()
        scheduled = self._is_scheduled(session_id)

        if tool_name == "maintainer_triage_issue":
            action = str(args.get("action") or "").lower()
            if action == "restore":
                return None
            issue_id = str(args.get("issue_id") or "")
            path = str(args.get("path") or "")
            return _approve(
                f"Approve ignoring Workspace Maintainer warning {issue_id} in {path}.",
                "openlia.policy.maintainer_ignore",
            )

        if tool_name in {"write_file", "patch"}:
            return self._workspace_tool_decision(authority, tool_name, args, scheduled)
        if tool_name == "delete_document_password_profile":
            return self._destructive_action(
                authority, "delete_records", "sources/document-passwords.toml"
            )
        if tool_name == "ingestion_delete_document":
            return self._destructive_action(
                authority, "delete_records", "sources"
            )
        if tool_name in {
            "ingestion_capture",
            "save_document_password",
            "ingestion_retry",
            "retry_ingestion_with_password_profile",
            "ingestion_recover",
            "ingestion_update_document",
            "ingestion_tag",
            "ingestion_cancel_document",
        }:
            if scheduled:
                return self._scheduled_path_decision(authority, "capture", "sources")
            return None
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
        LOGGER.info(
            "policy tool result tool=%s status=%s error_type=%s",
            tool_name,
            status or "unknown",
            error_type or "",
        )
        if error_type or (status and status not in {"ok", "success", "completed"}):
            return None
        if tool_name in {"write_file", "patch"}:
            try:
                mutated = self._mutated_workspace_paths(tool_name, args)
                if mutated:
                    advisory = self.maintainer.format_post_mutation_feedback(mutated)
                    if advisory:
                        return {"advisory": advisory, "message": advisory}
            except Exception as exc:
                LOGGER.warning("maintainer post-tool validation failed: %s", exc)
        return None

    def tool_maintainer_status(
        self,
        path: str | None = None,
        state: str | None = None,
        **_: Any,
    ) -> str:
        res = self.maintainer.status(relative_path=path, state=state)
        return json.dumps(res, ensure_ascii=False, sort_keys=True)

    def tool_maintainer_audit(self, **_: Any) -> str:
        res = self.maintainer.run_audit()
        return json.dumps(res, ensure_ascii=False, sort_keys=True)

    def tool_maintainer_triage_issue(
        self,
        issue_id: str,
        action: str,
        reason: str | None = None,
        **_: Any,
    ) -> str:
        res = self.maintainer.triage_issue(
            issue_id=issue_id,
            action=action,
            actor="agent",
            reason=reason,
        )
        return json.dumps(res, ensure_ascii=False, sort_keys=True)


def register(ctx: Any) -> None:
    enforcer = PolicyEnforcer()
    ctx.register_hook("on_session_start", enforcer.on_session_start)
    ctx.register_hook("pre_llm_call", enforcer.on_pre_llm_call)
    ctx.register_hook("on_session_end", enforcer.on_session_end)
    ctx.register_hook("pre_tool_call", enforcer.pre_tool_call)
    ctx.register_hook("post_tool_call", enforcer.post_tool_call)
    if hasattr(ctx, "register_tool"):
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
            toolset="openlia-policy",
            schema=status_schema,
            handler=enforcer.tool_maintainer_status,
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
            toolset="openlia-policy",
            schema=audit_schema,
            handler=enforcer.tool_maintainer_audit,
            is_async=False,
            description=audit_schema["description"],
        )
        triage_schema = {
            "name": "maintainer_triage_issue",
            "description": "Ignore or restore a specific Workspace Maintainer finding by exact issue_id in its file. Ignoring an issue requires user confirmation.",
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
                        "description": "Relative file path for context in approval prompts.",
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
            toolset="openlia-policy",
            schema=triage_schema,
            handler=enforcer.tool_maintainer_triage_issue,
            is_async=False,
            description=triage_schema["description"],
        )
