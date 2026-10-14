"""Automated LLM document metadata extraction, classification, and heuristic fallback."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any


LOGGER = logging.getLogger("openlia.ingestion.metadata")

KNOWN_DOCUMENT_TYPES = [
    "invoice",
    "receipt",
    "bank_statement",
    "contract",
    "tax_document",
    "medical_record",
    "id_document",
    "manual",
    "note",
    "video_transcript",
    "other",
]

ISO_DATE_PATTERN = re.compile(r"\b(20\d\d[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01]))\b")
YEAR_MONTH_PATTERN = re.compile(r"\b(20\d\d[-/](?:0[1-9]|1[0-2]))\b")


def extract_document_metadata(
    llm: Any,
    text: str,
    filename: str,
    kind: str,
    existing_title: str | None = None,
) -> dict:
    """Extract semantic title, correspondent, document type, document date, tags, and summary."""
    clean_text = (text or "").strip()
    # If LLM is available, attempt structured extraction
    if llm is not None and hasattr(llm, "complete_structured") and len(clean_text) > 30:
        try:
            return _llm_extract(llm, clean_text[:6000], filename, kind, existing_title)
        except Exception as exc:
            LOGGER.warning("LLM metadata extraction failed, falling back to heuristic: %s", exc)

    return _heuristic_extract(clean_text, filename, kind, existing_title)


def _llm_extract(
    llm: Any,
    excerpt: str,
    filename: str,
    kind: str,
    existing_title: str | None = None,
) -> dict:
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["title", "document_type", "tags", "summary"],
        "properties": {
            "title": {"type": "string", "description": "Concise, descriptive document title (e.g. 'March 2026 Chase Statement' or 'Electric Utility Invoice')"},
            "document_type": {
                "type": "string",
                "enum": KNOWN_DOCUMENT_TYPES,
                "description": "Category of the document",
            },
            "correspondent": {"type": ["string", "null"], "description": "Sender, institution, bank, merchant, or organization (e.g. 'Chase Bank', 'Apple', 'IRS')"},
            "document_date": {"type": ["string", "null"], "description": "Explicit date stated inside the document (YYYY-MM-DD or null)"},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "2 to 6 lowercase semantic tags"},
            "summary": {"type": "string", "description": "1 to 2 sentence summary of what the document contains"},
            "review_reasons": {"type": "array", "items": {"type": "string"}, "description": "Any anomalies or uncertain details requiring human attention"},
        },
    }

    instructions = (
        "You are OpenLia's Document Intelligence assistant. Analyze this document text and extract structured metadata.\n"
        f"Input filename: {filename}\n"
        f"Input source kind: {kind}\n"
        "Instructions:\n"
        "1. Extract a clear title. If existing title is good, you may refine it.\n"
        "2. Identify the correspondent (the external party: bank, vendor, government, author).\n"
        "3. Detect the document type from the enum.\n"
        "4. Find the primary document date inside the text (YYYY-MM-DD). If no clear date is found, output null.\n"
        "5. Generate 2 to 5 clean, lowercase tags (e.g. ['finance', 'tax', '2026']).\n"
        "6. Provide a concise 1-2 sentence factual summary.\n"
        "7. If text is blurry, truncated, or has uncertain dates or numbers, list them in review_reasons."
    )

    result = llm.complete_structured(
        task="openlia_document_tagger",
        instructions=instructions,
        input=[{"type": "text", "text": excerpt}],
        json_schema=schema,
        max_tokens=1024,
        timeout=60,
        purpose="document_metadata_tagger",
    )

    parsed = getattr(result, "parsed", None)
    if isinstance(parsed, dict) and isinstance(parsed.get("title"), str):
        # Normalize tags
        raw_tags = parsed.get("tags") or []
        clean_tags = []
        for tag in raw_tags:
            clean = re.sub(r"[^a-z0-9_-]+", "", str(tag).strip().lower())
            if clean and clean not in clean_tags:
                clean_tags.append(clean)

        doc_type = parsed.get("document_type")
        if doc_type not in KNOWN_DOCUMENT_TYPES:
            doc_type = "other"

        return {
            "title": parsed["title"].strip()[:200],
            "document_type": doc_type,
            "correspondent": (parsed.get("correspondent") or "").strip()[:100] or None,
            "document_date": _clean_date(parsed.get("document_date")),
            "tags": clean_tags[:8],
            "summary": (parsed.get("summary") or "").strip()[:500] or None,
            "review_reasons": [str(r) for r in parsed.get("review_reasons", []) if str(r).strip()],
        }

    return _heuristic_extract(excerpt, filename, kind, existing_title)


def _heuristic_extract(
    text: str,
    filename: str,
    kind: str,
    existing_title: str | None = None,
) -> dict:
    """Deterministic fallback metadata extraction when LLM is offline."""
    base_name = Path(filename).stem
    clean_title = existing_title or re.sub(r"[-_.]+", " ", base_name).strip().title()
    if not clean_title or clean_title == "Source":
        clean_title = f"{kind.capitalize()} document"

    # Infer document type
    lower = text.lower()
    lower_name = filename.lower()
    doc_type = "other"
    tags = []

    if any(k in lower_name or k in lower for k in ["invoice", "bill to", "tax invoice", "amount due"]):
        doc_type = "invoice"
        tags.extend(["finance", "invoice"])
    elif any(k in lower_name or k in lower for k in ["receipt", "order confirmation", "total paid"]):
        doc_type = "receipt"
        tags.extend(["finance", "receipt"])
    elif any(k in lower_name or k in lower for k in ["statement", "account balance", "checking account", "bank"]):
        doc_type = "bank_statement"
        tags.extend(["finance", "statement"])
    elif any(k in lower_name or k in lower for k in ["contract", "agreement", "terms of service", "signed"]):
        doc_type = "contract"
        tags.extend(["legal", "contract"])
    elif any(k in lower_name or k in lower for k in ["tax return", "w-2", "1099", "internal revenue"]):
        doc_type = "tax_document"
        tags.extend(["finance", "tax"])
    elif any(k in lower_name or k in lower for k in ["medical", "patient", "prescription", "clinic"]):
        doc_type = "medical_record"
        tags.extend(["health", "medical"])
    elif kind == "youtube":
        doc_type = "video_transcript"
        tags.extend(["media", "transcript"])
    elif kind in {"chat", "text"}:
        doc_type = "note"
        tags.extend(["note"])

    # Detect date in text or filename
    doc_date = None
    date_match = ISO_DATE_PATTERN.search(filename) or ISO_DATE_PATTERN.search(text[:2000])
    if date_match:
        doc_date = date_match.group(1).replace("/", "-")
    else:
        ym_match = YEAR_MONTH_PATTERN.search(filename) or YEAR_MONTH_PATTERN.search(text[:2000])
        if ym_match:
            doc_date = f"{ym_match.group(1).replace('/', '-')}-01"

    # Add kind as tag if appropriate
    if kind in {"pdf", "image", "excel", "csv"} and kind not in tags:
        tags.append(kind)

    # Summary from first lines
    first_lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
    summary = " ".join(first_lines[:2])[:240] if first_lines else f"Ingested {kind} document."

    return {
        "title": clean_title[:200],
        "document_type": doc_type,
        "correspondent": None,
        "document_date": doc_date,
        "tags": list(dict.fromkeys(tags)),
        "summary": summary,
        "review_reasons": ["unreviewed_upload"],
    }


def _clean_date(value: Any) -> str | None:
    if not value or not isinstance(value, str):
        return None
    val = value.strip().replace("/", "-")
    match = ISO_DATE_PATTERN.match(val)
    if match:
        return match.group(1)
    return None
