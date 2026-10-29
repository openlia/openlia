"""Dependency-free advisory syntax checks for Markdown OpenUI fences.

The UI/server own schema validation and desugaring. This offline checker accepts
bare roots, named arguments, and row tables without executing document code.
"""
from __future__ import annotations

import re


def _syntax_errors(code: str) -> list[str]:
    stack: list[str] = []
    clean: list[str] = []
    quote = ""
    escaped = False
    comment = False
    for index, char in enumerate(code):
        if comment:
            if char == "\n":
                comment = False
            clean.append("\n" if char == "\n" else " ")
            continue
        if quote:
            clean.append(" ")
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            continue
        if char in "\"'":
            quote = char
            clean.append("0")  # preserve the presence of a string value
        elif char == "#" or code[index:index + 2] == "//":
            comment = True
            clean.append(" ")
        else:
            clean.append(char)
            if char in "([{":
                stack.append(char)
            elif char in ")]}":
                if not stack or stack.pop() != {")": "(", "]": "[", "}": "{"}[char]:
                    return ["Mismatched OpenUI delimiters"]
    if quote:
        return ["Unterminated OpenUI string"]
    if stack:
        return ["Unclosed OpenUI delimiter"]
    source = "".join(clean).strip()
    if not source:
        return ["Empty OpenUI block"]
    if not re.match(r"(?:[A-Za-z_]\w*\s*=|[A-Z]\w*\s*\()", source):
        return ["Expected an assignment program or bare component expression"]
    if re.search(r":\s*[,}\])]|,\s*,", source):
        return ["Missing OpenUI argument or object value"]
    removed = re.search(r"\b(?:DomainHeader|MetricCard|RecordKanban|RecordTable|Grid)\s*\(|@(?:CountBy|GroupCount|FilterRecords|SumBy|GetQuery|Query)\s*\(", source)
    if removed:
        return ["Removed Mini-Project component or function"]
    return []


def validate_inline_openui(markdown: str) -> list[str]:
    """Return advisory messages with 1-based document line locations."""
    findings: list[str] = []
    marker = ""
    language = ""
    lines: list[str] = []
    start = 0

    def finish() -> None:
        if language in {"openui", "openui-lang"}:
            findings.extend(
                f"openui_syntax_error: line {start}: {message}"
                for message in _syntax_errors("\n".join(lines))
            )

    for number, raw in enumerate(markdown.splitlines(), 1):
        # Strip blockquote prefixes; list indentation is accepted conservatively.
        line = re.sub(r"^(?: {0,3}> ?)+", "", raw)
        if not marker:
            match = re.match(r"^ {0,3}(`{3,}|~{3,})([^\n]*)$", line)
            if match:
                marker = match[1]
                language = (match[2].strip().split() or [""])[0].lower()
                lines = []
                start = number + 1
        elif re.fullmatch(r"\s*" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}\s*", line):
            finish()
            marker = ""
        else:
            lines.append(line)
    if marker:
        finish()
    return findings
