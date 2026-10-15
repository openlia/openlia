"""Initial bounded adapters for the supported ingestion formats."""

from __future__ import annotations

import csv
import io
import json
import mimetypes
import os
import re
import subprocess
import tempfile
import uuid
from pathlib import Path


class AdapterError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def process_job(job: dict, publisher, password_store, llm, db=None) -> dict:
    source = publisher.load_source(job["source_id"])
    intake = publisher.load_intake(job["intake_id"]) if job.get("intake_id") else None
    kind = source.get("kind")
    if kind == "file":
        version = _version_for_job(source, job.get("version_id"))
        ext = Path(version.get("original_ref", "")).suffix.lower() if version else ""
        if ext == ".pdf":
            kind = "pdf"
        elif ext in {".xlsx", ".xls"}:
            kind = "excel"
        elif ext == ".csv":
            kind = "csv"
        elif ext in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}:
            kind = "image"
        elif ext in {".txt", ".md", ".json", ".log", ".yaml", ".yml", ".py", ".sh"}:
            kind = "text"
    if intake:
        intake["status"] = "processing"
        intake["last_error"] = None
        publisher.update_intake(intake)
    source.setdefault("processing", {})
    source["status"] = "processing"
    source["processing"]["status"] = "processing"
    source["processing"]["last_job_id"] = job.get("job_id")
    source["processing"]["error"] = None
    publisher.update_source(source)
    if kind in {"chat", "text"}:
        result = _text(source, intake or {}, job, publisher)
    elif kind == "csv":
        result = _csv(source, intake or {}, job, publisher)
    elif kind == "excel":
        result = _excel(source, intake or {}, job, publisher, password_store)
    elif kind == "pdf":
        result = _pdf(source, intake or {}, job, publisher, password_store, llm)
    elif kind == "image":
        result = _image(source, intake or {}, job, publisher, llm)
    elif kind == "youtube":
        result = _youtube(source, intake or {}, job, publisher)
    else:
        raise AdapterError("unsupported_kind", "source kind is not supported")
    if intake:
        intake["status"] = "complete" if result["status"] == "completed" else "partial"
        intake["last_error"] = None
        intake["retry_count"] = max(intake.get("retry_count") or 0, job.get("attempts", 0))
        publisher.update_intake(intake)

    # Reload updated source to inspect extractions
    source = publisher.load_source(job["source_id"])
    source.setdefault("processing", {})
    source["processing"]["status"] = "complete" if result["status"] == "completed" else "partial"

    # Extract text from latest extraction for LLM metadata tagging
    extracted_text = ""
    try:
        version = _version_for_job(source, job.get("version_id"))
        if version:
            ver_id = version.get("id")
            for ext in reversed(version.get("extractions", [])):
                ext_dir = publisher.artifacts / source["id"] / ver_id / "extractions" / ext
                for candidate_name in ["text.md", "transcript.md", "tables.json"]:
                    candidate = ext_dir / candidate_name
                    if candidate.exists():
                        extracted_text = candidate.read_text(encoding="utf-8", errors="ignore")
                        break
                if extracted_text:
                    break
    except Exception:
        pass

    try:
        from .metadata import extract_document_metadata
        meta = extract_document_metadata(
            llm=llm,
            text=extracted_text,
            filename=source.get("title") or "document",
            kind=kind,
            existing_title=source.get("title"),
        )
        if meta.get("title") and (not source.get("title") or source["title"] in {"Untitled source", "Source", "source.txt"}):
            source["title"] = meta["title"]
        if meta.get("document_type") and not source.get("document_type"):
            source["document_type"] = meta["document_type"]
        if meta.get("correspondent") and not source.get("correspondent"):
            source["correspondent"] = meta["correspondent"]
        if meta.get("document_date") and not source.get("document_date"):
            source["document_date"] = meta["document_date"]
        if meta.get("tags"):
            existing_tags = list(source.get("tags") or [])
            for t in meta["tags"]:
                if t not in existing_tags:
                    existing_tags.append(t)
            source["tags"] = existing_tags
        if meta.get("summary") and not source.get("summary"):
            source["summary"] = meta["summary"]
        if meta.get("review_reasons"):
            source.setdefault("review", {"status": "unreviewed", "reasons": []})
            for r in meta["review_reasons"]:
                if r not in source["review"]["reasons"]:
                    source["review"]["reasons"].append(r)
    except Exception:
        pass

    publisher.update_source(source)

    # Sync to SQLite FTS5 if db provided
    if db is not None:
        try:
            db.upsert_source_fts(
                source_id=source["id"],
                title=source.get("title"),
                correspondent=source.get("correspondent"),
                document_type=source.get("document_type"),
                tags=source.get("tags"),
                summary=source.get("summary"),
                content=extracted_text[:100000],
                document_date=source.get("document_date"),
                review_status=source.get("review", {}).get("status", "unreviewed"),
                processing_status=source.get("processing", {}).get("status", "complete"),
                lifecycle=source.get("lifecycle", "active"),
            )
        except Exception:
            pass

    return result


def _original(source: dict, version_id: str | None = None) -> tuple[bytes, dict]:
    versions = source.get("versions") or []
    if not versions:
        raise AdapterError("original_missing", "retained original is not available")
    if version_id:
        version = next((item for item in versions if item.get("id") == version_id), None)
        if version is None:
            raise AdapterError("version_not_found", "requested source version is not available")
    else:
        version = versions[-1]
    path = Path(os.environ.get("OPENLIA_WORKSPACE_ROOT", "/opt/data/workspace")) / version["original_ref"]
    try:
        return path.read_bytes(), version
    except OSError as exc:
        raise AdapterError("original_unreadable", "retained original cannot be read") from exc


def _version_for_job(source: dict, version_id: str | None) -> dict | None:
    versions = source.get("versions") or []
    if version_id:
        version = next((item for item in versions if item.get("id") == version_id), None)
        if version is None:
            raise AdapterError("version_not_found", "requested source version is not available")
        return version
    return versions[-1] if versions else None


def _text(source, intake, job, publisher) -> dict:
    data, version = _original(source, job.get("version_id"))
    text = data.decode("utf-8", errors="replace")
    result = publisher.publish_extraction(source, intake, version["id"], "text", "text/markdown", ".md", text.encode("utf-8"), {"input_artifact_id": version.get("original_artifact_id"), "coverage": {"lines": len(text.splitlines())}})
    return {"status": "completed", "artifact_refs": [result["artifact_id"]], "extraction_refs": [result["extraction_id"]], "summary": {"lines": len(text.splitlines()), "warnings": result["warnings"]}, "continuation": job.get("continuation", {})}


def _csv(source, intake, job, publisher) -> dict:
    data, version = _original(source, job.get("version_id"))
    text = data.decode("utf-8-sig", errors="replace")
    try:
        dialect = csv.Sniffer().sniff(text[:8192])
    except csv.Error:
        dialect = csv.excel
    rows = []
    for index, row in enumerate(csv.reader(io.StringIO(text), dialect), start=1):
        if index > 100_000:
            raise AdapterError("row_limit", "CSV exceeds the row limit")
        rows.append({"row": index, "values": row})
    encoded = json.dumps({"encoding": "utf-8", "delimiter": dialect.delimiter, "rows": rows}, ensure_ascii=False, indent=2).encode("utf-8")
    result = publisher.publish_extraction(source, intake, version["id"], "tables", "application/json", ".json", encoded, {"input_artifact_id": version.get("original_artifact_id"), "coverage": {"rows": len(rows)}})
    return {"status": "completed", "artifact_refs": [result["artifact_id"]], "extraction_refs": [result["extraction_id"]], "summary": {"rows": len(rows), "warnings": result["warnings"]}, "continuation": job.get("continuation", {})}


def _excel(source, intake, job, publisher, password_store) -> dict:
    data, version = _original(source, job.get("version_id"))
    profile = job.get("password_profile")
    if not profile and _office_is_encrypted(data):
        raise AdapterError("password_required", "encrypted workbook requires a document-password profile")
    data = _decrypt_office(data, profile, password_store)
    suffix = Path(version["original_ref"]).suffix.lower()
    try:
        if suffix == ".xls":
            import xlrd
            workbook = xlrd.open_workbook(file_contents=data, encoding_override="utf-8", on_demand=True)
            sheets = []
            for sheet in workbook.sheets():
                rows = []
                for row_index in range(min(sheet.nrows, 100_000)):
                    rows.append({"row": row_index + 1, "values": sheet.row_values(row_index)})
                sheets.append({"name": sheet.name, "rows": rows})
        else:
            import openpyxl
            with tempfile.NamedTemporaryFile(suffix=suffix or ".xlsx") as temporary:
                temporary.write(data)
                temporary.flush()
                workbook = openpyxl.load_workbook(temporary.name, read_only=True, data_only=False, keep_links=False)
                sheets = []
                for sheet in workbook.worksheets:
                    rows = []
                    for row_index, row in enumerate(sheet.iter_rows(values_only=False), start=1):
                        if row_index > 100_000:
                            raise AdapterError("row_limit", "workbook exceeds the row limit")
                        values = []
                        for cell in row:
                            value = cell.value
                            values.append({"value": value, "formula": value if isinstance(value, str) and value.startswith("=") else None})
                        rows.append({"row": row_index, "values": values})
                    sheets.append({"name": sheet.title, "rows": rows})
    except AdapterError:
        raise
    except Exception as exc:
        if profile:
            raise AdapterError("unlock_failed", "workbook could not be opened with the selected password profile") from exc
        raise AdapterError("workbook_unreadable", "workbook could not be opened") from exc
    encoded = json.dumps({"sheets": sheets}, ensure_ascii=False, indent=2, default=str).encode("utf-8")
    result = publisher.publish_extraction(source, intake, version["id"], "tables", "application/json", ".json", encoded, {"input_artifact_id": version.get("original_artifact_id"), "coverage": {"sheets": len(sheets)}})
    return {"status": "completed", "artifact_refs": [result["artifact_id"]], "extraction_refs": [result["extraction_id"]], "summary": {"sheets": len(sheets), "warnings": result["warnings"]}, "continuation": job.get("continuation", {})}


def _pdf(source, intake, job, publisher, password_store, llm) -> dict:
    data, version = _original(source, job.get("version_id"))
    path = Path(version["original_ref"])
    absolute = Path(os.environ.get("OPENLIA_WORKSPACE_ROOT", "/opt/data/workspace")) / path
    password = password_store.resolve(job["password_profile"]) if job.get("password_profile") else None
    pages = _pdf_pages(absolute, password)
    if pages > 100:
        raise AdapterError("page_limit", "PDF exceeds the page limit")
    text_command = ["pdftotext"] + (["-opw", password] if password else []) + ["-layout", str(absolute), "-"]
    text = _command(text_command, "pdf_text")
    page_texts = _split_pdf_pages(text, pages)
    missing_pages = [page for page, page_text in enumerate(page_texts, start=1) if not page_text.strip()]
    if not missing_pages:
        result = publisher.publish_extraction(source, intake, version["id"], "text", "text/markdown", ".md", text.encode("utf-8"), {"input_artifact_id": version.get("original_artifact_id"), "coverage": {"text_layer": True}})
        return {"status": "completed", "artifact_refs": [result["artifact_id"]], "extraction_refs": [result["extraction_id"]], "summary": {"warnings": result["warnings"]}, "continuation": job.get("continuation", {})}
    if llm is None:
        raise AdapterError("vision_unavailable", "scanned PDF requires a configured vision model", retryable=False)
    extracted = []
    warnings = []
    with tempfile.TemporaryDirectory(prefix="openlia-pdf-") as temporary:
        for page in range(1, pages + 1):
            page_text = page_texts[page - 1]
            if page_text.strip():
                extracted.append(f"## Page {page}\n\n{page_text.strip()}\n")
                continue
            output = Path(temporary) / f"page-{page}"
            ppm_command = ["pdftoppm"] + (["-opw", password] if password else []) + ["-f", str(page), "-l", str(page), "-png", "-r", "150", "-singlefile", str(absolute), str(output)]
            _command(ppm_command, "pdf_render")
            page_text, page_warnings = _vision(llm, output.with_suffix(".png").read_bytes(), "image/png", f"Read page {page} exactly. Preserve source language and mark uncertain text.")
            extracted.append(f"## Page {page}\n\n{page_text}\n")
            warnings.extend(page_warnings)
    result = publisher.publish_extraction(source, intake, version["id"], "text", "text/markdown", ".md", "\n".join(extracted).encode("utf-8"), {"input_artifact_id": version.get("original_artifact_id"), "coverage": {"pages": pages}, "warnings": warnings, "complete": not warnings})
    status = "completed" if result["complete"] else "partial"
    return {"status": status, "artifact_refs": [result["artifact_id"]], "extraction_refs": [result["extraction_id"]], "summary": {"pages": pages, "warnings": warnings}, "continuation": job.get("continuation", {})}


def _image(source, intake, job, publisher, llm) -> dict:
    data, version = _original(source, job.get("version_id"))
    if llm is None:
        raise AdapterError("vision_unavailable", "image ingestion requires a configured vision model")
    try:
        from PIL import Image
        image = Image.open(io.BytesIO(data))
        image.thumbnail((2400, 2400))
        normalized = io.BytesIO()
        image.convert("RGB").save(normalized, format="PNG")
        text, warnings = _vision(llm, normalized.getvalue(), "image/png", "Read this image exactly. Preserve source language, describe layout briefly, and mark uncertain text.")
    except AdapterError:
        raise
    except Exception as exc:
        raise AdapterError("image_unreadable", "image could not be normalized") from exc
    result = publisher.publish_extraction(source, intake, version["id"], "text", "text/markdown", ".md", text.encode("utf-8"), {"input_artifact_id": version.get("original_artifact_id"), "coverage": {"image": True}, "warnings": warnings, "complete": not warnings})
    return {"status": "completed" if result["complete"] else "partial", "artifact_refs": [result["artifact_id"]], "extraction_refs": [result["extraction_id"]], "summary": {"warnings": warnings}, "continuation": job.get("continuation", {})}


def _youtube(source, intake, job, publisher) -> dict:
    url = source.get("origin", {}).get("source_url")
    if not isinstance(url, str):
        raise AdapterError("url_missing", "YouTube URL is missing")
    with tempfile.TemporaryDirectory(prefix="openlia-youtube-") as temporary:
        metadata = json.loads(_command(["yt-dlp", "--no-warnings", "--skip-download", "--dump-single-json", url], "youtube_metadata"))
        original = json.dumps({"id": metadata.get("id"), "title": metadata.get("title"), "channel": metadata.get("channel"), "webpage_url": metadata.get("webpage_url"), "duration": metadata.get("duration")}, ensure_ascii=False, indent=2).encode("utf-8")
        version_id = job.get("version_id") or source.get("versions", [{}])[-1].get("id")
        if not version_id:
            raise AdapterError("version_missing", "YouTube version was not allocated")
        version = next((item for item in source.get("versions", []) if item.get("id") == version_id), None)
        if version is None:
            version = {"id": version_id, "original_artifact_id": f"art_{uuid.uuid4().hex}", "content_sha256": __import__("hashlib").sha256(original).hexdigest(), "media_type": "application/json", "original_ref": f"sources/artifacts/{source['id']}/{version_id}/original.json", "received_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(), "retained": True, "extractions": []}
            source["versions"] = [*source.get("versions", []), version]
            publisher.update_source(source)
        publisher.publish_bytes(f"sources/artifacts/{source['id']}/{version_id}/original.json", original)
        transcript = None
        try:
            subprocess.run(["yt-dlp", "--no-warnings", "--ignore-errors", "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en.*,en,orig,default", "--sub-format", "vtt", "--output", str(Path(temporary) / "video.%(ext)s"), url], capture_output=True, text=True, timeout=60)
            subtitle_files = sorted(Path(temporary).glob("*.vtt"))
            if not subtitle_files:
                subprocess.run(["yt-dlp", "--no-warnings", "--ignore-errors", "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "all,-live_chat", "--sub-format", "vtt", "--output", str(Path(temporary) / "video.%(ext)s"), url], capture_output=True, text=True, timeout=60)
                subtitle_files = sorted(Path(temporary).glob("*.vtt"))
        except (OSError, subprocess.SubprocessError):
            subtitle_files = sorted(Path(temporary).glob("*.vtt"))
        if subtitle_files:
            direct_en = [f for f in subtitle_files if f.name == "video.en.vtt" or f.name.startswith("video.en.") or f.name.startswith("video.en-")]
            chosen = direct_en[0] if direct_en else subtitle_files[0]
            transcript = _vtt_text(chosen.read_text(encoding="utf-8", errors="replace"))
        if transcript:
            result = publisher.publish_extraction(source, intake, version_id, "transcript", "text/markdown", ".md", transcript.encode("utf-8"), {"input_artifact_id": version.get("original_artifact_id"), "coverage": {"transcript": True}, "complete": True})
            status, warnings = "completed", result["warnings"]
        else:
            warnings = ["transcript_unavailable"]
            result = publisher.publish_extraction(source, intake, version_id, "transcript", "text/markdown", ".md", b"Transcript unavailable; the source did not provide a retained transcript.", {"input_artifact_id": version.get("original_artifact_id"), "coverage": {"transcript": False}, "warnings": warnings, "complete": False})
            status = "partial"
    return {"status": status, "artifact_refs": [result["artifact_id"]], "extraction_refs": [result["extraction_id"]], "summary": {"warnings": warnings}, "continuation": job.get("continuation", {})}


def _vtt_text(value: str) -> str:
    lines = []
    for line in value.splitlines():
        clean = line.strip()
        if (
            not clean
            or clean == "WEBVTT"
            or "-->" in clean
            or clean.isdigit()
            or clean.startswith("NOTE")
            or clean.startswith("Kind:")
            or clean.startswith("Language:")
        ):
            continue
        clean = re.sub(r"<[^>]+>", "", clean)
        if not lines or lines[-1] != clean:
            lines.append(clean)
    return "\n".join(lines).strip()


def _command(command: list[str], code: str) -> str:
    try:
        completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=300)
    except subprocess.CalledProcessError as exc:
        detail = ((exc.stderr or "") + " " + (exc.stdout or "")).lower()
        if "password" in detail or "encrypted" in detail:
            raise AdapterError("password_required" if len(command) < 2 or "-opw" not in command else "password_invalid", "document password is required or was rejected") from exc
        raise AdapterError(code, f"{code} failed", retryable=True) from exc
    except (OSError, subprocess.SubprocessError) as exc:
        raise AdapterError(code, f"{code} failed", retryable=True) from exc
    return completed.stdout


def _pdf_pages(path: Path, password: str | None = None) -> int:
    output = _command(["pdfinfo"] + (["-opw", password] if password else []) + [str(path)], "pdf_info")
    match = re.search(r"^Pages:\s+(\d+)", output, re.MULTILINE)
    if not match:
        raise AdapterError("pdf_pages_unknown", "PDF page count was unavailable")
    return int(match.group(1))


def _split_pdf_pages(text: str, pages: int) -> list[str]:
    """Split pdftotext output while accounting for its trailing form feed."""
    page_texts = text.split("\f")
    if len(page_texts) > pages and not page_texts[-1].strip():
        page_texts.pop()
    if len(page_texts) < pages:
        page_texts.extend([""] * (pages - len(page_texts)))
    return page_texts[:pages]


def _decrypt_office(data: bytes, profile: str | None, password_store) -> bytes:
    if not profile:
        return data
    try:
        import msoffcrypto
        source = io.BytesIO(data)
        office = msoffcrypto.OfficeFile(source)
        if not office.is_encrypted():
            return data
        password = password_store.resolve(profile)
        office.load_key(password=password)
        output = io.BytesIO()
        office.decrypt(output)
        return output.getvalue()
    except AdapterError:
        raise
    except Exception as exc:
        raise AdapterError("password_invalid", "workbook password was rejected") from exc


def _office_is_encrypted(data: bytes) -> bool:
    try:
        import msoffcrypto
        return bool(msoffcrypto.OfficeFile(io.BytesIO(data)).is_encrypted())
    except Exception:
        return False


def _vision(llm, data: bytes, mime_type: str, instructions: str) -> tuple[str, list[str]]:
    schema = {"type": "object", "additionalProperties": False, "required": ["text", "warnings"], "properties": {"text": {"type": "string"}, "warnings": {"type": "array", "items": {"type": "string"}}}}
    try:
        result = llm.complete_structured(task="openlia_ingestion_ocr", instructions=instructions, input=[{"type": "image", "data": data, "mime_type": mime_type}], json_schema=schema, max_tokens=4096, timeout=120, purpose="ingestion_ocr")
        parsed = getattr(result, "parsed", None)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("text"), str):
            raise AdapterError("vision_invalid_output", "vision model returned no structured text", retryable=True)
        warnings = parsed.get("warnings") if isinstance(parsed.get("warnings"), list) else []
        return parsed["text"], [str(item) for item in warnings]
    except AdapterError:
        raise
    except Exception as exc:
        raise AdapterError("vision_failed", "vision extraction failed", retryable=True) from exc
