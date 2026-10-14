"""Durable workspace capture and idempotent artifact publication."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml


SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MAX_SOURCE_BYTES = 100 * 1024 * 1024


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_name(value: str, fallback: str) -> str:
    base = Path(value or fallback).name
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")
    return base[:120] or fallback


class PublicationError(RuntimeError):
    pass


class WorkspacePublisher:
    def __init__(self, workspace: Path):
        self.root = workspace.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.sources = self.root / "sources"
        self.records = self.sources / "records"
        self.artifacts = self.sources / "artifacts"
        self.intakes = self.root / "inbox" / "ingestion"
        for directory in (self.records, self.artifacts, self.intakes):
            directory.mkdir(parents=True, exist_ok=True)

    def capture(self, request: dict) -> dict:
        kind = request.get("kind", "text")
        if kind not in {"chat", "text", "file", "pdf", "image", "excel", "csv", "youtube"}:
            raise PublicationError("unsupported ingestion kind")
        captured_at = timestamp()
        source_id = make_id("src")
        version_id = make_id("ver")
        intake_id = make_id("intake")
        title = str(request.get("title") or "Untitled source")[:240]
        origin = {
            "channel": request.get("channel") or "chat",
            "source_url": request.get("url") if kind == "youtube" else None,
            "provider": "youtube" if kind == "youtube" else None,
            "provider_item_id": None,
            "message_id": request.get("message_id"),
        }
        version = None
        if kind == "youtube":
            if not _youtube_url(origin["source_url"]):
                raise PublicationError("only YouTube URLs are supported")
        else:
            data, filename, media_type = self._input_bytes(request, kind)
            artifact_id = make_id("art")
            extension = Path(filename).suffix.lower()
            if not re.fullmatch(r"\.[a-z0-9]{1,12}", extension):
                extension = ".bin"
            relative = f"sources/artifacts/{source_id}/{version_id}/original{extension}"
            self._write_bytes(relative, data, immutable=True)
            version = {
                "id": version_id,
                "original_artifact_id": artifact_id,
                "content_sha256": sha256(data),
                "media_type": media_type,
                "original_ref": relative,
                "received_at": captured_at,
                "retained": True,
                "extractions": [],
            }
        origin["request_ref"] = request.get("request_ref")
        source = {
            "$schema": "./source-template.schema.json",
            "id": source_id,
            "kind": kind,
            "title": title,
            "document_type": request.get("document_type"),
            "correspondent": request.get("correspondent"),
            "document_date": request.get("document_date"),
            "tags": request.get("tags") or [],
            "summary": request.get("summary"),
            "status": "captured",
            "processing": {
                "status": "captured",
                "last_job_id": None,
                "updated_at": captured_at,
                "error": None,
            },
            "review": {
                "status": "unreviewed",
                "reasons": [],
                "reviewed_at": None,
                "reviewed_by": None,
            },
            "lifecycle": "active",
            "captured_at": captured_at,
            "sensitivity": request.get("sensitivity") or "personal",
            "custom_fields": request.get("custom_fields") or {},
            "authorization": {
                "scope": request.get("authorization_scope") or "ingestion",
                "source": request.get("authorization_source") or "direct-request",
            },
            "origin": origin,
            "versions": [version] if version else [],
            "password_profile": request.get("password_profile"),
        }
        self._write_record(f"sources/records/{source_id}.md", source, "# Source Record\n")
        continuation = dict(request.get("continuation") or {})
        continuation.setdefault("next_action", "triage")
        continuation.setdefault("request_ref", request.get("request_ref"))
        intake = {
            "$schema": "./ingestion-template.schema.json",
            "intake_id": intake_id,
            "source_id": source_id,
            "version_id": version_id,
            "captured_at": captured_at,
            "kind": kind,
            "operation": request.get("operation") or "extract",
            "requested_outputs": request.get("requested_outputs") or ["text"],
            "status": "captured",
            "job_id": None,
            "continuation": {
                "next_action": continuation.get("next_action"),
                "conversation_ref": continuation.get("conversation_ref"),
                "request_ref": continuation.get("request_ref"),
            },
            "authorization": {"scope": request.get("authorization_scope") or "ingestion", "source": request.get("authorization_source") or "direct-request"},
            "artifact_refs": [version["original_artifact_id"]] if version else [],
            "extraction_refs": [],
            "candidate_ids": [],
            "record_refs": [],
            "retry_count": 0,
            "last_error": None,
            "unresolved_questions": [],
            "callback": {"event_id": None, "delivery_status": "pending"},
        }
        self._write_record(f"inbox/ingestion/{intake_id}.md", intake, "# Ingestion Intake\n")
        return {"source": source, "intake": intake, "version": version}

    def load_source(self, source_id: str) -> dict:
        path = self.records / f"{source_id}.md"
        return self._read_record(path)

    def load_intake(self, intake_id: str) -> dict:
        return self._read_record(self.intakes / f"{intake_id}.md")

    def list_intakes(self) -> list[dict]:
        records = []
        for path in sorted(self.intakes.glob("intake_*.md")):
            try:
                records.append(self._read_record(path))
            except (OSError, PublicationError):
                continue
        return records

    def update_source(self, source: dict) -> None:
        source_id = source.get("id")
        if not isinstance(source_id, str) or not SAFE_ID.fullmatch(source_id):
            raise PublicationError("invalid source id")
        self._write_record(f"sources/records/{source_id}.md", source, "# Source Record\n")

    def update_intake(self, intake: dict) -> None:
        intake_id = intake.get("intake_id")
        if not isinstance(intake_id, str) or not SAFE_ID.fullmatch(intake_id):
            raise PublicationError("invalid intake id")
        self._write_record(f"inbox/ingestion/{intake_id}.md", intake, "# Ingestion Intake\n")

    def publish_bytes(self, relative: str, data: bytes) -> None:
        self._write_bytes(relative, data, immutable=True)

    def publish_extraction(self, source: dict, intake: dict, version_id: str, role: str, media_type: str, extension: str, data: bytes, metadata: dict) -> dict:
        extraction_id = metadata.get("extraction_id") or make_id("ext")
        artifact_id = make_id("art")
        relative = f"sources/artifacts/{source['id']}/{version_id}/extractions/{extraction_id}/{role}{extension}"
        self._write_bytes(relative, data, immutable=True)
        manifest = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "schema_version": 1,
            "artifact_id": artifact_id,
            "source_id": source["id"],
            "version_id": version_id,
            "extraction_id": extraction_id,
            "role": role,
            "path": relative,
            "sha256": sha256(data),
            "media_type": media_type,
            "size_bytes": len(data),
            "extractor": metadata.get("extractor", "openlia-ingestion"),
            "extractor_version": metadata.get("extractor_version", "1"),
            "input_artifact_id": metadata.get("input_artifact_id"),
            "coverage": metadata.get("coverage", {}),
            "warnings": metadata.get("warnings", []),
            "complete": metadata.get("complete", True),
        }
        manifest_relative = f"sources/artifacts/{source['id']}/{version_id}/extractions/{extraction_id}/manifest.json"
        self._write_bytes(manifest_relative, (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), immutable=True)
        version = next((item for item in source.get("versions", []) if item.get("id") == version_id), None)
        if version is None:
            raise PublicationError("version record is missing")
        version.setdefault("extractions", [])
        if extraction_id not in version["extractions"]:
            version["extractions"].append(extraction_id)
        source["status"] = "complete" if manifest["complete"] else "partial"
        source.setdefault("processing", {})
        source["processing"]["status"] = "complete" if manifest["complete"] else "partial"
        source["processing"]["updated_at"] = timestamp()
        if manifest.get("warnings"):
            source.setdefault("review", {"status": "unreviewed", "reasons": []})
            for w in manifest["warnings"]:
                if w not in source["review"]["reasons"]:
                    source["review"]["reasons"].append(w)
            if source["review"].get("status") == "reviewed":
                source["review"]["status"] = "needs-review"
        self.update_source(source)
        intake.setdefault("artifact_refs", [])
        intake.setdefault("extraction_refs", [])
        if artifact_id not in intake["artifact_refs"]:
            intake["artifact_refs"].append(artifact_id)
        if extraction_id not in intake["extraction_refs"]:
            intake["extraction_refs"].append(extraction_id)
        return {"artifact_id": artifact_id, "extraction_id": extraction_id, "path": relative, "manifest": manifest_relative, "warnings": manifest["warnings"], "complete": manifest["complete"]}

    def _input_bytes(self, request: dict, kind: str) -> tuple[bytes, str, str]:
        if kind in {"chat", "text"} and request.get("content") is not None:
            content = request.get("content")
            if not isinstance(content, str):
                raise PublicationError("text ingestion requires string content")
            data, filename = content.encode("utf-8"), "source.txt"
        else:
            path = request.get("file_path")
            if not isinstance(path, str) or not path:
                if kind in {"chat", "text"}:
                    raise PublicationError("text ingestion requires content or file_path")
                raise PublicationError("file ingestion requires a file handle")
            candidate = Path(path).expanduser()
            if candidate.is_symlink() or not candidate.is_file():
                raise PublicationError("input file is not a regular file")
            resolved = candidate.resolve()
            allowed_roots = [Path("/tmp").resolve(), Path(os.environ.get("OPENLIA_UPLOAD_ROOT", "/tmp")).expanduser().resolve(), self.root]
            if not any(_within(resolved, allowed) for allowed in allowed_roots):
                raise PublicationError("input file is outside the configured upload root")
            if candidate.stat().st_size > MAX_SOURCE_BYTES:
                raise PublicationError("input file exceeds the source size limit")
            data, filename = candidate.read_bytes(), candidate.name
        media_type = mimetypes.guess_type(filename)[0] or {
            "pdf": "application/pdf", "image": "image/*", "excel": "application/vnd.ms-excel", "csv": "text/csv"
        }.get(kind, "text/plain")
        return data, filename, media_type

    def _write_record(self, relative: str, metadata: dict, body: str) -> None:
        text = "---\n" + yaml.safe_dump(metadata, sort_keys=False, allow_unicode=True) + "---\n" + body
        self._write_bytes(relative, text.encode("utf-8"), immutable=False)

    def _read_record(self, path: Path) -> dict:
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            raise PublicationError(f"record has no frontmatter: {path.name}")
        _, frontmatter, _ = text.split("---", 2)
        data = yaml.safe_load(frontmatter)
        if not isinstance(data, dict):
            raise PublicationError(f"record frontmatter is not an object: {path.name}")
        return data

    def _write_bytes(self, relative: str, data: bytes, immutable: bool = False) -> None:
        target = self._safe_target(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            if target.exists() and immutable:
                if target.read_bytes() != data:
                    raise PublicationError(f"immutable artifact conflict: {relative}")
                os.unlink(temporary)
                return
            os.replace(temporary, target)
            directory = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _safe_target(self, relative: str) -> Path:
        candidate = (self.root / relative).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise PublicationError("workspace path escapes root") from exc
        current = self.root
        for part in Path(relative).parts[:-1]:
            current = current / part
            if current.exists() and current.is_symlink():
                raise PublicationError("workspace path contains a symbolic link")
        return candidate


def _youtube_url(value: object) -> bool:
    return isinstance(value, str) and (
        value.startswith("https://www.youtube.com/")
        or value.startswith("https://youtube.com/")
        or value.startswith("https://m.youtube.com/")
        or value.startswith("https://youtu.be/")
        or value.startswith("http://www.youtube.com/")
        or value.startswith("http://youtube.com/")
        or value.startswith("http://youtu.be/")
    )


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
