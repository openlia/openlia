#!/usr/bin/env python3
"""Build deterministic weekly review data from explicit JSON inputs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _list(data: dict[str, Any], key: str) -> list[dict[str, Any]]:
    values = data.get(key, [])
    if not isinstance(values, list) or not all(isinstance(value, dict) for value in values):
        raise ValueError(f"{key} must be a list of objects")
    return values


def _title(item: dict[str, Any]) -> str:
    return str(item.get("title") or item.get("name") or item.get("claim") or "Untitled")


def _ordered(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(values, key=lambda value: (_title(value).casefold(), str(value.get("id") or "")))


def build_review(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("input must be a JSON object")
    goals = _list(data, "goals")
    tasks = _list(data, "tasks")
    decisions = _list(data, "decisions")
    claims = _list(data, "claims")
    finance = _list(data, "finance")
    health = _list(data, "health")
    completed = [task for task in tasks if str(task.get("status", "")).lower() in {"done", "completed"}]
    closed_tasks = [
        task
        for task in tasks
        if str(task.get("status", "")).lower() in {"cancelled", "canceled", "archived"}
    ]
    open_tasks = [
        task
        for task in tasks
        if str(task.get("status", "")).lower()
        not in {"done", "completed", "cancelled", "canceled", "archived"}
    ]
    active_goals = [
        goal
        for goal in goals
        if str(goal.get("status") or "active").lower() == "active"
    ]
    revisit = [
        decision
        for decision in decisions
        if decision.get("revisit") is True
        or str(decision.get("status") or "").lower() in {"proposed", "pending", ""}
    ]
    claim_review = [claim for claim in claims if claim.get("needs_review") is True or str(claim.get("status", "")).lower() in {"candidate", "stale", "contested"}]
    finance_open = [
        record
        for record in finance
        if str(record.get("status", "")).lower()
        in {"blocked", "needs-attention", "pending-review", "ready-to-post", "draft", "in-progress"}
        or str(record.get("reconciliation_status", "")).lower() == "discrepancy"
        or str(record.get("price_status", "")).lower() in {"partial", "missing"}
        or str(record.get("cost_basis_status", "")).lower() in {"partial", "missing"}
    ]
    health_open = [
        record
        for record in health
        if record.get("needs_review") is True
        or str(record.get("status", "")).lower() in {"draft", "unknown"}
        or str(record.get("verification_status", "")).lower() in {"unconfirmed", "provisional", "unknown"}
        or record.get("review_due") is True
        or record.get("next_review_due") is True
    ]

    return {
        "week": str(data.get("week") or "unspecified"),
        "completed": _ordered(completed),
        "closed_tasks": _ordered(closed_tasks),
        "active_goals": _ordered(active_goals),
        "open_tasks": _ordered(open_tasks),
        "decisions_to_revisit": _ordered(revisit),
        "claims_to_review": _ordered(claim_review),
        "finance_open": _ordered(finance_open),
        "health_open": _ordered(health_open),
    }


def self_test() -> None:
    review = build_review(
        {
            "week": "2026-W01",
            "goals": [
                {"title": "Active goal", "status": "active"},
                {"title": "Unspecified goal", "status": None},
                {"title": "Paused goal", "status": "paused"},
            ],
            "tasks": [
                {"title": "Finished task", "status": "done"},
                {"title": "Cancelled task", "status": "cancelled"},
                {"title": "Open task", "status": "open"},
            ],
            "decisions": [
                {"title": "Unresolved choice", "status": None},
                {"title": "Abandoned decision", "status": "abandoned"},
            ],
            "claims": [{"claim": "A stale preference", "status": "stale", "needs_review": True}],
            "finance": [
                {"title": "Unreconciled card", "status": "needs-attention"},
                {"title": "Complete review", "status": "final", "price_status": "complete"},
            ],
            "health": [
                {"title": "Unconfirmed diagnosis", "verification_status": "provisional"},
                {"title": "Final summary", "status": "final"},
            ],
        }
    )
    assert review["completed"][0]["title"] == "Finished task"
    assert review["closed_tasks"][0]["title"] == "Cancelled task"
    assert review["open_tasks"][0]["title"] == "Open task"
    assert review["decisions_to_revisit"][0]["title"] == "Unresolved choice"
    assert review["claims_to_review"][0]["claim"] == "A stale preference"
    assert review["finance_open"][0]["title"] == "Unreconciled card"
    assert review["health_open"][0]["title"] == "Unconfirmed diagnosis"
    assert {goal["title"] for goal in review["active_goals"]} == {
        "Active goal",
        "Unspecified goal",
    }
    assert all(goal.get("title") != "Paused goal" for goal in review["active_goals"])
    assert all(decision.get("title") != "Abandoned decision" for decision in review["decisions_to_revisit"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, help="JSON weekly review input")
    parser.add_argument("--output", type=Path, help="Write JSON output to a file")
    parser.add_argument("--self-test", action="store_true", help="Run the built-in deterministic test")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        print("ok")
        return 0
    if args.input is None:
        parser.error("input is required unless --self-test is used")
    try:
        rendered = json.dumps(
            build_review(json.loads(args.input.read_text(encoding="utf-8"))),
            indent=2,
            sort_keys=True,
            ensure_ascii=True,
        ) + "\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
