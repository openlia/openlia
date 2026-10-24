#!/usr/bin/env python3
"""Build a deterministic evidence matrix from researcher-supplied source notes."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


WEIGHTS = {"authority": 0.4, "quality": 0.3, "recency": 0.1, "relevance": 0.2}
SCORE_FIELDS = tuple(WEIGHTS)


def _score(source: dict[str, Any], key: str) -> float:
    value = source.get(key)
    if value is None:
        return 0.0
    if isinstance(value, bool):
        raise ValueError(f"{key} score must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} score must be a number") from exc
    if not math.isfinite(number) or not 0 <= number <= 5:
        raise ValueError(f"{key} score must be a finite number between 0 and 5")
    return number


def _text(source: dict[str, Any], key: str) -> str:
    value = source.get(key)
    if value is None:
        return ""
    return str(value).strip()


def _source_id(source: dict[str, Any], index: int) -> str:
    identifier = _text(source, "id") or f"source-{index:03d}"
    if not identifier:
        raise ValueError(f"source {index} id must not be empty")
    return identifier


def build_matrix(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("input must be a JSON object")
    sources = data.get("sources", [])
    if not isinstance(sources, list) or not all(isinstance(source, dict) for source in sources):
        raise ValueError("sources must be a list of objects")

    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, source in enumerate(sources, start=1):
        identifier = _source_id(source, index)
        if identifier in seen_ids:
            raise ValueError(f"duplicate source id: {identifier}")
        seen_ids.add(identifier)
        scores = {key: _score(source, key) for key in SCORE_FIELDS}
        missing = [key for key in SCORE_FIELDS if source.get(key) is None]
        total = round(sum(scores[key] * WEIGHTS[key] for key in SCORE_FIELDS), 3)
        rows.append(
            {
                "id": identifier,
                "title": _text(source, "title") or f"Source {index}",
                "url": _text(source, "url"),
                "publisher": _text(source, "publisher"),
                "source_type": _text(source, "source_type") or "unspecified",
                "published_at": _text(source, "published_at"),
                "effective_at": _text(source, "effective_at"),
                "accessed_at": _text(source, "accessed_at"),
                "claim": _text(source, "claim"),
                "counterevidence": _text(source, "counterevidence"),
                "score": total,
                "scores": scores,
                "missing_dimensions": missing,
                "notes": _text(source, "notes"),
            }
        )
    rows.sort(key=lambda row: (-row["score"], row["title"].casefold(), row["id"]))

    gaps: list[str] = []
    if not rows:
        gaps.append("No sources were supplied.")
    if rows and all(row["score"] < 3 for row in rows):
        gaps.append("No source reached a weighted confidence score of 3.0.")
    if any(row["missing_dimensions"] for row in rows):
        gaps.append("One or more source dimensions are missing; verify before relying on the ranking.")
    if any(not row["url"] for row in rows):
        gaps.append("One or more sources has no stable URL or reference; preserve a local source reference before relying on it.")
    if any(not row["accessed_at"] for row in rows):
        gaps.append("One or more sources has no access date; freshness cannot be checked.")
    if any(not row["claim"] for row in rows):
        gaps.append("One or more sources has no stated claim; connect each source to a specific question.")

    return {
        "question": _text(data, "question"),
        "sources": rows,
        "evidence_gaps": gaps,
        "method": "Weighted source notes only; this helper does not fetch, verify, or follow URLs.",
    }


def self_test() -> None:
    result = build_matrix(
        {
            "question": "What evidence is strongest?",
            "sources": [
                {
                    "id": "primary",
                    "title": "Primary source",
                    "url": "https://example.invalid/primary",
                    "publisher": "Accountable institution",
                    "source_type": "official",
                    "published_at": "2026-10-01",
                    "effective_at": "2026-10-02",
                    "accessed_at": "2026-10-08",
                    "claim": "The stated result.",
                    "authority": 5,
                    "quality": 4,
                    "recency": 4,
                    "relevance": 5,
                },
                {"id": "partial", "title": "Partial source", "authority": 2, "quality": 2, "relevance": 2},
            ],
        }
    )
    assert result["sources"][0]["title"] == "Primary source"
    assert "recency" in result["sources"][1]["missing_dimensions"]
    assert "access date" in " ".join(result["evidence_gaps"])
    assert result["sources"][0]["claim"] == "The stated result."
    assert result["method"].startswith("Weighted source notes")
    assert result["sources"][0]["published_at"] == "2026-10-01"
    assert result["sources"][0]["effective_at"] == "2026-10-02"

    try:
        build_matrix({"sources": [{"id": "same"}, {"id": "same"}]})
    except ValueError as exc:
        assert str(exc) == "duplicate source id: same"
    else:
        raise AssertionError("duplicate source IDs must be rejected")

    try:
        build_matrix({"sources": [{"authority": True}]})
    except ValueError as exc:
        assert str(exc) == "authority score must be a number"
    else:
        raise AssertionError("boolean scores must be rejected")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, help="JSON source notes")
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
            build_matrix(json.loads(args.input.read_text(encoding="utf-8"))),
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
