"""Canonical version-aware reference builder, citation formatter, and backlink scanner."""

from __future__ import annotations

import os
import re
from pathlib import Path


SOURCE_URI_PATTERN = re.compile(
    r"^openlia://sources?/([A-Za-z0-9][A-Za-z0-9._-]*)(?:#(?:(?:([A-Za-z0-9][A-Za-z0-9._-]*)(?:/p(\d+))?)|p(\d+)))?$"
)


def build_source_uri(
    source_id: str,
    version_id: str | None = None,
    page: int | None = None,
) -> str:
    """Build a canonical, version-aware Openlia source URI."""
    clean_id = source_id.strip()
    if version_id and page is not None and page > 0:
        return f"openlia://source/{clean_id}#{version_id}/p{page}"
    if page is not None and page > 0:
        return f"openlia://source/{clean_id}#p{page}"
    if version_id:
        return f"openlia://source/{clean_id}#{version_id}"
    return f"openlia://source/{clean_id}"


def parse_source_uri(uri: str) -> dict | None:
    """Parse an openlia://source URI into component fields."""
    match = SOURCE_URI_PATTERN.match(uri.strip())
    if not match:
        return None
    source_id = match.group(1)
    version_or_empty = match.group(2)
    page_str = match.group(3) or match.group(4)
    page = int(page_str) if page_str else None
    return {
        "source_id": source_id,
        "version_id": version_or_empty or None,
        "page": page,
    }


def build_markdown_citation(
    source: dict | str,
    title: str | None = None,
    version_id: str | None = None,
    page: int | None = None,
) -> str:
    """Generate human-readable Markdown citation with canonical link."""
    if isinstance(source, dict):
        # If second arg was passed positionally as version_id (e.g. ver_...)
        if title and title.startswith("ver_") and version_id is None:
            if version_id is None:
                version_id = title
                title = None
        source_id = source.get("id") or source.get("source_id") or "unknown"
        doc_title = title or source.get("title") or "Source Document"
    else:
        source_id = str(source)
        doc_title = title or "Source Document"
    uri = build_source_uri(source_id, version_id, page)
    if version_id and page:
        return f"[{doc_title} (v. {version_id}), p. {page}]({uri})"
    elif version_id:
        return f"[{doc_title} (v. {version_id})]({uri})"
    elif page:
        return f"[{doc_title}, p. {page}]({uri})"
    return f"[{doc_title}]({uri})"


def find_backlinks(workspace_root: Path, source_id: str) -> list[dict]:
    """Scan workspace domain records (excluding sources/) for citations referencing this source."""
    root = workspace_root.resolve()
    backlinks: list[dict] = []
    if not root.exists():
        return backlinks

    target_tokens = [f"openlia://source/{source_id}", f"openlia://sources/{source_id}"]
    uri_re = re.compile(
        rf"openlia://sources?/{re.escape(source_id)}(?:#([A-Za-z0-9][A-Za-z0-9._-]*)(?:/p\d+)?)?"
    )

    for dirpath, dirnames, filenames in os.walk(root):
        # Exclude hidden dirs, sources/, node_modules, and legacy intake staging
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in {"sources", "node_modules"}]
        for filename in filenames:
            if not filename.endswith((".md", ".rem", ".hledger", ".journal", ".yaml", ".json")):
                continue
            filepath = Path(dirpath) / filename
            try:
                rel = filepath.relative_to(root).as_posix()
                if rel.startswith("inbox/ingestion/"):
                    continue
                text = filepath.read_text(encoding="utf-8", errors="ignore")
                if any(token in text for token in target_tokens):
                    # Determine domain from top-level directory
                    parts = rel.split("/")
                    domain = parts[0] if len(parts) > 1 else "workspace"
                    line_no = 1
                    pinned_version_id: str | None = None
                    line_excerpt = ""
                    for idx, line in enumerate(text.splitlines(), start=1):
                        if any(token in line for token in target_tokens):
                            line_no = idx
                            line_excerpt = line.strip()[:200]
                            match = uri_re.search(line)
                            if match and match.group(1) and not re.fullmatch(r"p\d+", match.group(1)):
                                pinned_version_id = match.group(1)
                            break
                    backlinks.append(
                        {
                            "path": rel,
                            "domain": domain,
                            "filename": filename,
                            "line_number": line_no,
                            "pinned_version_id": pinned_version_id,
                            "line_excerpt": line_excerpt,
                        }
                    )
            except OSError:
                continue

    return sorted(backlinks, key=lambda b: b["path"])


def annotate_deleted_backlinks(workspace_root: Path, source_id: str) -> list[str]:
    """Rewrite openlia://source/<id> citations in workspace files to non-clickable deleted-source markers."""
    root = workspace_root.resolve()
    if not root.exists():
        return []
    backlinks = find_backlinks(root, source_id)
    modified: list[str] = []
    escaped_id = re.escape(source_id)
    ledger_comment_re = re.compile(
        rf";\s*source:\s*openlia://sources?/{escaped_id}(?:#[^\s)]+)?"
    )
    md_link_re = re.compile(
        rf"\[([^\]]+)\]\(openlia://sources?/{escaped_id}(?:#[^)\s]+)?\)"
    )
    bare_uri_re = re.compile(
        rf"openlia://sources?/{escaped_id}(?:#[^\s)\"']+)?",
    )

    for item in backlinks:
        rel = item["path"]
        filepath = (root / rel).resolve()
        try:
            filepath.relative_to(root)
        except ValueError:
            continue
        if not filepath.is_file():
            continue
        try:
            original = filepath.read_text(encoding="utf-8")
            updated = original
            if filepath.suffix in {".hledger", ".journal"}:
                updated = ledger_comment_re.sub(f"; source-deleted: {source_id}", updated)
                updated = bare_uri_re.sub(f"(deleted source: {source_id})", updated)
            else:
                updated = md_link_re.sub(rf"[\1 (deleted source: {source_id})]", updated)
                updated = bare_uri_re.sub(f"(deleted source: {source_id})", updated)
            if updated != original:
                filepath.write_text(updated, encoding="utf-8")
                modified.append(rel)
        except OSError:
            continue

    return modified
