#!/usr/bin/env python3
"""Deterministic checks and batch commit grouping for the workspace-git skill."""

from __future__ import annotations

import json
import re
import sys
from typing import Any


SAFE_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")

DOMAIN_MESSAGES: dict[str, str] = {
    "tasks": "docs(tasks): update task records",
    "goals": "docs(goals): update goal records",
    "inbox": "docs(inbox): file intake records",
    "knowledge": "feat(knowledge): update research and claims",
    "reports": "docs(reports): archive generated reports",
    "decisions": "docs(decisions): record decision log",
    "areas": "docs(areas): update area standards",
    "people": "docs(people): update relationships and context",
    "shopping": "docs(shopping): update purchase targets",
    "finance": "docs(finance): update financial records",
    "health": "docs(health): update medical history",
    "calendar": "docs(calendar): update event notes",
    "ideas": "docs(ideas): update ideas and exploration",
    "sources": "docs(sources): update retained source artifacts",
    "archive": "chore(archive): archive stale records",
    "workspace": "chore(workspace): update workspace configuration",
}


def is_safe_workspace_path(value: str) -> bool:
    if not value or value.startswith("/") or ".." in value:
        return False
    if not SAFE_PATH.fullmatch(value):
        return False
    blocked = (".env", ".pem", ".key", ".p12", ".pfx", "auth.json")
    if value.endswith(blocked) or value == "auth.json" or "/auth.json" in value:
        return False
    blocked_prefixes = ("sessions/", "logs/", "cache/", "browser-profile/", "mcp-tokens/", "pairing/")
    return not any(value.startswith(prefix) for prefix in blocked_prefixes)


def categorize_workspace_path(path: str) -> str:
    parts = path.strip("/").split("/", 1)
    if len(parts) > 1 and parts[0] in DOMAIN_MESSAGES:
        return parts[0]
    return "workspace"


def group_workspace_changes(paths: list[str]) -> list[dict[str, Any]]:
    """Group changed workspace files into multiple logical commit batches.

    Returns an empty list if there are no changes or no safe changes (no-op).
    """
    safe_files = [path for path in paths if is_safe_workspace_path(path)]
    if not safe_files:
        return []

    domains: dict[str, list[str]] = {}
    for path in sorted(safe_files):
        domain = categorize_workspace_path(path)
        domains.setdefault(domain, []).append(path)

    plan = []
    for domain, files in sorted(domains.items()):
        message = DOMAIN_MESSAGES.get(domain, f"chore({domain}): update records")
        plan.append({
            "domain": domain,
            "message": message,
            "files": files,
        })
    return plan


def self_test() -> None:
    assert is_safe_workspace_path("goals/example.md")
    assert not is_safe_workspace_path(".env")
    assert not is_safe_workspace_path("people/../secret.md")
    assert not is_safe_workspace_path("logs/gateway.log")
    assert not is_safe_workspace_path("auth.json")

    assert categorize_workspace_path("tasks/do-thing.md") == "tasks"
    assert categorize_workspace_path("inbox/capture.md") == "inbox"
    assert categorize_workspace_path("workspace.yaml") == "workspace"
    assert categorize_workspace_path("sources/records/src_example.md") == "sources"

    # Clean workspace -> empty plan (no commit)
    assert group_workspace_changes([]) == []
    assert group_workspace_changes([".env", "logs/app.log"]) == []

    # Dirty workspace -> multiple grouped commits
    sample_changes = [
        "tasks/today.md",
        "tasks/sub/urgent.md",
        "inbox/quick-note.md",
        "workspace.yaml",
        ".env",
    ]
    plan = group_workspace_changes(sample_changes)
    assert len(plan) == 3
    domains = [entry["domain"] for entry in plan]
    assert domains == ["inbox", "tasks", "workspace"]
    tasks_batch = next(entry for entry in plan if entry["domain"] == "tasks")
    assert tasks_batch["files"] == ["tasks/sub/urgent.md", "tasks/today.md"]
    assert tasks_batch["message"] == "docs(tasks): update task records"


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        self_test()
        print("ok")
        sys.exit(0)
    elif len(sys.argv) >= 2 and sys.argv[1] == "--plan":
        raw_paths = sys.argv[2:] if len(sys.argv) > 2 else sys.stdin.read().splitlines()
        clean_paths = [p.strip() for p in raw_paths if p.strip()]
        result = group_workspace_changes(clean_paths)
        print(json.dumps(result, indent=2))
        sys.exit(0)
    else:
        raise SystemExit("usage: check_workspace_git.py --self-test | --plan [paths...]")
