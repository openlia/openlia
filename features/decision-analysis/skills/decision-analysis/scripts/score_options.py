#!/usr/bin/env python3
"""Score decision options with explicit, weighted criteria."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number") from exc
    if not 0 <= number <= 10:
        raise ValueError(f"{label} must be between 0 and 10")
    return number


def _name(value: Any, label: str) -> str:
    name = str(value).strip() if value is not None else ""
    if not name:
        raise ValueError(f"{label} must have a name")
    return name


def _ensure_unique(names: list[str], kind: str) -> None:
    seen: set[str] = set()
    for name in names:
        key = name.casefold()
        if key in seen:
            raise ValueError(f"{kind} names must be unique: {name}")
        seen.add(key)


def score_options(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("input must be a JSON object")
    criteria = data.get("criteria", [])
    options = data.get("options", [])
    if not isinstance(criteria, list) or not criteria:
        raise ValueError("criteria must be a non-empty list")
    if not isinstance(options, list) or not options:
        raise ValueError("options must be a non-empty list")

    normalized_criteria: list[dict[str, Any]] = []
    criterion_names: list[str] = []
    missing_score_meanings: list[str] = []
    total_weight = 0.0
    for index, criterion in enumerate(criteria, start=1):
        if not isinstance(criterion, dict):
            raise ValueError(f"criterion {index} must have a name")
        name = _name(criterion.get("name"), f"criterion {index}")
        weight = _number(criterion.get("weight", 1), f"weight for {name}")
        if weight == 0:
            raise ValueError(f"weight for {name} must be greater than zero")
        score_meaning = str(criterion.get("score_meaning") or "").strip()
        if not score_meaning:
            missing_score_meanings.append(name)
        criterion_names.append(name)
        normalized_criteria.append(
            {"name": name, "weight": weight, "score_meaning": score_meaning}
        )
        total_weight += weight
    _ensure_unique(criterion_names, "criterion")

    ranked: list[dict[str, Any]] = []
    option_names: list[str] = []
    for index, option in enumerate(options, start=1):
        if not isinstance(option, dict):
            raise ValueError(f"option {index} must have a name")
        option_name = _name(option.get("name"), f"option {index}")
        option_names.append(option_name)
        scores = option.get("scores", {})
        if not isinstance(scores, dict):
            raise ValueError(f"scores for {option_name} must be an object")
        weighted_total = 0.0
        missing: list[str] = []
        details: dict[str, float] = {}
        for criterion in normalized_criteria:
            name = criterion["name"]
            if name not in scores:
                missing.append(name)
                value = 0.0
            else:
                value = _number(scores[name], f"score for {option_name} / {name}")
            details[name] = value
            weighted_total += value * criterion["weight"]
        ranked.append(
            {
                "name": option_name,
                "weighted_score": round(weighted_total / total_weight, 4),
                "scores": details,
                "missing_scores": missing,
                "risks": [str(risk) for risk in option.get("risks", [])] if isinstance(option.get("risks", []), list) else [],
            }
        )
    _ensure_unique(option_names, "option")
    ranked.sort(key=lambda option: (-option["weighted_score"], option["name"].casefold()))
    top_score = ranked[0]["weighted_score"]
    leaders = [option["name"] for option in ranked if option["weighted_score"] == top_score]
    has_missing_scores = any(option["missing_scores"] for option in ranked)
    incomplete = has_missing_scores or bool(missing_score_meanings)
    if incomplete:
        recommendation_status = "incomplete"
        missing_dimensions = []
        if missing_score_meanings:
            missing_dimensions.append("score meanings")
        if has_missing_scores:
            missing_dimensions.append("scores")
        recommendation_message = (
            "Provisional ranking; provide missing "
            + " and ".join(missing_dimensions)
            + " before treating it as a recommendation."
        )
    elif len(leaders) > 1:
        recommendation_status = "tie"
        recommendation_message = "Complete matrix has tied leaders; there is no single winner."
    else:
        recommendation_status = "clear"
        recommendation_message = "Complete matrix has one unique leader."
    return {
        "question": str(data.get("question") or ""),
        "criteria": sorted(normalized_criteria, key=lambda criterion: criterion["name"].casefold()),
        "options": ranked,
        "recommendation": {
            "status": recommendation_status,
            "leaders": leaders,
            "message": recommendation_message,
        },
        "missing_score_meanings": sorted(missing_score_meanings, key=str.casefold),
        "top_option": ranked[0]["name"] if recommendation_status == "clear" else None,
        "caveat": "Scores are decision support, not an automatic action.",
    }

def self_test() -> None:
    result = score_options(
        {
            "question": "Which path is clearer?",
            "criteria": [
                {"name": "fit", "weight": 2, "score_meaning": "0 = poor; 10 = excellent"},
                {"name": "cost", "weight": 1, "score_meaning": "0 = expensive; 10 = affordable"},
            ],
            "options": [
                {"name": "A", "scores": {"fit": 8, "cost": 5}},
                {"name": "B", "scores": {"fit": 5, "cost": 9}},
            ],
        }
    )
    assert result["top_option"] == "A"
    assert result["options"][0]["weighted_score"] == 7.0
    assert result["recommendation"]["status"] == "clear"
    assert result["missing_score_meanings"] == []

    tie = score_options(
        {
            "question": "Which path?",
            "criteria": [{"name": "fit", "weight": 1, "score_meaning": "0 = poor; 10 = excellent"}],
            "options": [{"name": "A", "scores": {"fit": 8}}, {"name": "B", "scores": {"fit": 8}}],
        }
    )
    assert tie["top_option"] is None
    assert tie["recommendation"]["status"] == "tie"
    assert tie["recommendation"]["leaders"] == ["A", "B"]

    incomplete = score_options(
        {
            "question": "Which path?",
            "criteria": [{"name": "fit", "weight": 1, "score_meaning": "0 = poor; 10 = excellent"}],
            "options": [{"name": "A", "scores": {"fit": 8}}, {"name": "B", "scores": {}}],
        }
    )
    assert incomplete["top_option"] is None
    assert incomplete["recommendation"]["status"] == "incomplete"
    assert incomplete["options"][1]["missing_scores"] == ["fit"]

    try:
        score_options(
            {
                "criteria": [
                    {"name": "fit", "weight": 1, "score_meaning": "0 = poor; 10 = excellent"},
                    {"name": "FIT", "weight": 1, "score_meaning": "0 = poor; 10 = excellent"},
                ],
                "options": [{"name": "A", "scores": {"fit": 8}}],
            }
        )
    except ValueError as exc:
        assert "criterion names must be unique" in str(exc)
    else:
        raise AssertionError("duplicate criterion names must fail")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, help="JSON decision matrix")
    parser.add_argument("--output", type=Path, help="Write the report to a file")
    parser.add_argument("--self-test", action="store_true", help="Run the built-in deterministic test")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        print("ok")
        return 0
    if args.input is None:
        parser.error("input is required unless --self-test is used")
    try:
        result = score_options(json.loads(args.input.read_text(encoding="utf-8")))
        rendered = json.dumps(result, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
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
