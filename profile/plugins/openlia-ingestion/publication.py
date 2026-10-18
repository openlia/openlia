"""Standalone Ingestion Vault capture, blob storage, and legacy workspace migration."""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .db import IngestionQueue


SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MAX_SOURCE_BYTES = 100 * 1024 * 1024


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _next_version_id(existing_versions: list[dict]) -> str:
    if not existing_versions:
        return "ver_001"
    max_num = len(existing_versions)
    for ver in existing_versions:
        if not isinstance(ver, dict):
            continue
        vid = str(ver.get("id") or "")
        match = re.fullmatch(r"ver_(\d+)", vid)
        if match:
            max_num = max(max_num, int(match.group(1)))
    return f"ver_{max_num + 1:03d}"



def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_name(value: str, fallback: str) -> str:
    base = Path(value or fallback).name
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")
    return base[:120] or fallback


class PublicationError(RuntimeError):
    pass


def _resolve_vault_and_workspace(
    root: Path, workspace_root: Path | None = None
) -> tuple[Path, Path | None]:
    resolved = root.expanduser().resolve()
    env_workspace = (
        workspace_root.expanduser().resolve()
        if workspace_root
        else (
            Path(os.environ["OPENLIA_WORKSPACE_ROOT"]).expanduser().resolve()
            if os.environ.get("OPENLIA_WORKSPACE_ROOT")
            else None
        )
    )
    env_ingestion = (
        Path(os.environ["OPENLIA_INGESTION_ROOT"]).expanduser().resolve()
        if os.environ.get("OPENLIA_INGESTION_ROOT")
        else None
    )
    if env_ingestion:
        return env_ingestion, env_workspace or (resolved if resolved != env_ingestion else None)
    if env_workspace and resolved == env_workspace:
        hermes_home = os.environ.get("HERMES_HOME")
        if hermes_home:
            return Path(hermes_home).expanduser().resolve() / "ingestion", env_workspace
        return resolved.parent / "ingestion", env_workspace
    if resolved.name == "workspace":
        hermes_home = os.environ.get("HERMES_HOME")
        if hermes_home:
            return Path(hermes_home).expanduser().resolve() / "ingestion", resolved
        return resolved.parent / "ingestion", resolved
    return resolved, env_workspace


def _normalize_blob_relpath(relative: str) -> str:
    clean = relative.strip().lstrip("/")
    if clean.startswith("sources/artifacts/"):
        return "blobs/" + clean[len("sources/artifacts/") :]
    return clean


class VaultStore:
    """Durable SQLite + immutable blob store inside OPENLIA_INGESTION_ROOT (zero workspace footprint)."""

    def __init__(
        self,
        root: Path,
        *,
        workspace_root: Path | None = None,
        db: IngestionQueue | None = None,
    ):
        vault_root, detected_workspace = _resolve_vault_and_workspace(root, workspace_root)
        self.root = vault_root
        self.vault_root = vault_root
        self.workspace_root = detected_workspace
        self.root.mkdir(parents=True, exist_ok=True)
        self.blobs = self.root / "blobs"
        self.blobs.mkdir(parents=True, exist_ok=True)
        # Keep .artifacts pointing to blobs/ so extraction lookups resolve inside the vault
        self.artifacts = self.blobs
        self.db = db or IngestionQueue(self.root)
        if self.workspace_root and self.workspace_root.exists():
            self.migrate_legacy_workspace_sources(self.workspace_root)

    def capture(self, request: dict) -> dict:
        kind = request.get("kind", "text")
        if kind not in {"chat", "text", "file", "pdf", "image", "excel", "csv", "youtube"}:
            raise PublicationError("unsupported ingestion kind")
        captured_at = timestamp()
        raw_source_id = request.get("source_id") or request.get("target_source_id")
        if raw_source_id is not None:
            source_id = str(raw_source_id).strip()
            if not SAFE_ID.fullmatch(source_id):
                raise PublicationError("invalid source id")
            existing_source = self.db.get_source(source_id)
        else:
            source_id = make_id("src")
            existing_source = None

        existing_versions = list((existing_source or {}).get("versions") or [])
        if request.get("version_id"):
            version_id = str(request["version_id"]).strip()
            if not SAFE_ID.fullmatch(version_id):
                raise PublicationError("invalid version id")
        else:
            version_id = _next_version_id(existing_versions)

        intake_id = str(request.get("intake_id") or make_id("intake"))
        default_title = (existing_source or {}).get("title") or "Untitled source"
        title = str(request.get("title") or default_title)[:240]
        origin = (existing_source or {}).get("origin") or {
            "channel": request.get("channel") or "chat",
            "source_url": request.get("url") if kind == "youtube" else None,
            "provider": "youtube" if kind == "youtube" else None,
            "provider_item_id": None,
            "message_id": request.get("message_id"),
            "request_ref": request.get("request_ref"),
        }
        version = None
        initial_content = ""
        if kind == "youtube":
            if not _youtube_url(request.get("url") or origin.get("source_url")):
                raise PublicationError("only YouTube URLs are supported")
        else:
            data, filename, media_type = self._input_bytes(request, kind)
            artifact_id = make_id("art")
            extension = Path(filename).suffix.lower()
            if not re.fullmatch(r"\.[a-z0-9]{1,12}", extension):
                extension = ".bin"
            relative = f"blobs/{source_id}/{version_id}/original{extension}"
            self._write_bytes(relative, data, immutable=True)
            if kind in {"chat", "text"} or extension in {".txt", ".md", ".json", ".csv"}:
                initial_content = data[:50000].decode("utf-8", errors="ignore")
            version = {
                "id": version_id,
                "original_artifact_id": artifact_id,
                "filename": filename,
                "content_sha256": sha256(data),
                "media_type": media_type,
                "size_bytes": len(data),
                "original_ref": relative,
                "received_at": captured_at,
                "retained": True,
                "extractions": [],
            }

        purge_previous = bool(request.get("purge_previous_versions"))
        if existing_source is not None:
            if purge_previous:
                for old_ver in existing_versions:
                    old_ver_id = str(old_ver.get("id") or "")
                    if old_ver_id and old_ver_id != version_id:
                        self.db.delete_version_cascade(source_id, old_ver_id)
                        shutil.rmtree(self.blobs / source_id / old_ver_id, ignore_errors=True)
                versions_list = [version] if version else []
            else:
                self.db.cancel_source_jobs(source_id, exclude_version_id=version_id)
                versions_list = [
                    v for v in existing_versions if v.get("id") != version_id
                ] + ([version] if version else [])

            raw_tags = request.get("tags")
            if raw_tags is not None:
                tags = [str(t).strip().lower() for t in raw_tags if str(t).strip()]
            else:
                tags = list(existing_source.get("tags") or [])

            merged_cf = dict(existing_source.get("custom_fields") or {})
            if isinstance(request.get("custom_fields"), dict):
                merged_cf.update(request["custom_fields"])

            review_block = {
                "status": "needs-review",
                "reasons": ["new_version_uploaded"],
                "reviewed_at": None,
                "reviewed_by": None,
            }
            source = {
                "$schema": "./source-template.schema.json",
                "id": source_id,
                "kind": kind or existing_source.get("kind") or "file",
                "title": title,
                "document_type": request.get("document_type")
                if request.get("document_type") is not None
                else existing_source.get("document_type"),
                "correspondent": request.get("correspondent")
                if request.get("correspondent") is not None
                else existing_source.get("correspondent"),
                "document_date": request.get("document_date")
                if request.get("document_date") is not None
                else existing_source.get("document_date"),
                "tags": tags,
                "summary": request.get("summary")
                if request.get("summary") is not None
                else existing_source.get("summary"),
                "status": "captured",
                "processing": {
                    "status": "captured",
                    "last_job_id": None,
                    "updated_at": captured_at,
                    "error": None,
                },
                "review": review_block,
                "lifecycle": existing_source.get("lifecycle") or "active",
                "captured_at": existing_source.get("captured_at") or captured_at,
                "sensitivity": request.get("sensitivity")
                or existing_source.get("sensitivity")
                or "personal",
                "custom_fields": merged_cf,
                "authorization": existing_source.get("authorization")
                or {
                    "scope": request.get("authorization_scope") or "ingestion",
                    "source": request.get("authorization_source") or "direct-request",
                },
                "origin": origin,
                "versions": versions_list,
                "password_profile": request.get("password_profile")
                if request.get("password_profile") is not None
                else existing_source.get("password_profile"),
            }
        else:
            source = {
                "$schema": "./source-template.schema.json",
                "id": source_id,
                "kind": kind,
                "title": title,
                "document_type": request.get("document_type"),
                "correspondent": request.get("correspondent"),
                "document_date": request.get("document_date"),
                "tags": [str(t).strip().lower() for t in (request.get("tags") or []) if str(t).strip()],
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
                "custom_fields": dict(request.get("custom_fields") or {}),
                "authorization": {
                    "scope": request.get("authorization_scope") or "ingestion",
                    "source": request.get("authorization_source") or "direct-request",
                },
                "origin": origin,
                "versions": [version] if version else [],
                "password_profile": request.get("password_profile"),
            }

        self.db.save_source(source)
        self.db.upsert_source_fts(
            source_id=source_id,
            title=source["title"],
            correspondent=source["correspondent"],
            document_type=source["document_type"],
            tags=source["tags"],
            summary=source["summary"],
            content=initial_content,
            document_date=source["document_date"],
            review_status=source["review"]["status"],
            processing_status="captured",
            lifecycle=source["lifecycle"],
            custom_fields=source["custom_fields"],
        )

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
            "authorization": {
                "scope": request.get("authorization_scope") or "ingestion",
                "source": request.get("authorization_source") or "direct-request",
            },
            "artifact_refs": [version["original_artifact_id"]] if version else [],
            "extraction_refs": [],
            "candidate_ids": [],
            "record_refs": [],
            "retry_count": 0,
            "last_error": None,
            "unresolved_questions": [],
            "callback": {"event_id": None, "delivery_status": "not_required"},
        }
        self.db.save_intake(intake)
        return {
            "source": source,
            "intake": intake,
            "version": version,
            "replaced_existing": existing_source is not None,
            "purged_previous_versions": bool(existing_source is not None and purge_previous),
        }

    def delete_source(self, source_id: str) -> dict:
        if not isinstance(source_id, str) or not SAFE_ID.fullmatch(source_id):
            raise PublicationError("invalid source id")
        cascade = self.db.delete_source_cascade(source_id)
        shutil.rmtree(self.blobs / source_id, ignore_errors=True)
        fallback_json = self.root / "sources" / f"{source_id}.json"
        if fallback_json.is_file():
            try:
                fallback_json.unlink()
            except OSError:
                pass
        if self.workspace_root and self.workspace_root.exists():
            legacy_rec = self.workspace_root / "sources" / "records" / f"{source_id}.md"
            if legacy_rec.is_file():
                try:
                    legacy_rec.unlink()
                except OSError:
                    pass
            legacy_art = self.workspace_root / "sources" / "artifacts" / source_id
            if legacy_art.is_dir():
                shutil.rmtree(legacy_art, ignore_errors=True)
        return {"source_id": source_id, **cascade}

    def cancel_processing(self, source_id: str, reason: str = "cancelled_by_user") -> dict:
        if not isinstance(source_id, str) or not SAFE_ID.fullmatch(source_id):
            raise PublicationError("invalid source id")
        try:
            return self.db.cancel_processing(source_id, reason=reason)
        except KeyError as exc:
            raise PublicationError(f"source record not found: {source_id}") from exc

    def load_source(self, source_id: str) -> dict:
        if not isinstance(source_id, str) or not SAFE_ID.fullmatch(source_id):
            raise PublicationError("invalid source id")
        record = self.db.get_source(source_id)
        if record is None:
            raise PublicationError(f"source record not found: {source_id}")
        return record

    def load_intake(self, intake_id: str) -> dict:
        if not isinstance(intake_id, str) or not SAFE_ID.fullmatch(intake_id):
            raise PublicationError("invalid intake id")
        record = self.db.get_intake(intake_id)
        if record is None:
            raise PublicationError(f"intake record not found: {intake_id}")
        return record

    def list_intakes(self) -> list[dict]:
        return self.db.list_intakes()

    def list_sources(self) -> list[dict]:
        return self.db.list_sources()

    def update_source(self, source: dict) -> None:
        source_id = source.get("id")
        if not isinstance(source_id, str) or not SAFE_ID.fullmatch(source_id):
            raise PublicationError("invalid source id")
        self.db.save_source(source)

    def update_intake(self, intake: dict) -> None:
        intake_id = intake.get("intake_id")
        if not isinstance(intake_id, str) or not SAFE_ID.fullmatch(intake_id):
            raise PublicationError("invalid intake id")
        self.db.save_intake(intake)

    def publish_bytes(self, relative: str, data: bytes) -> None:
        normalized = _normalize_blob_relpath(relative)
        self._write_bytes(normalized, data, immutable=True)

    def resolve_blob_path(self, relative: str) -> Path:
        normalized = _normalize_blob_relpath(relative)
        candidate = self._safe_target(normalized)
        if candidate.exists():
            return candidate
        if self.workspace_root:
            legacy = (self.workspace_root / relative.lstrip("/")).resolve()
            if _within(legacy, self.workspace_root) and legacy.exists():
                return legacy
        return candidate

    def publish_extraction(
        self,
        source: dict,
        intake: dict,
        version_id: str,
        role: str,
        media_type: str,
        extension: str,
        data: bytes,
        metadata: dict,
    ) -> dict:
        extraction_id = metadata.get("extraction_id") or make_id("ext")
        artifact_id = make_id("art")
        relative = f"blobs/{source['id']}/{version_id}/extractions/{extraction_id}/{role}{extension}"
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
        manifest_relative = f"blobs/{source['id']}/{version_id}/extractions/{extraction_id}/manifest.json"
        self._write_bytes(
            manifest_relative,
            (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
            immutable=True,
        )
        content_text = data.decode("utf-8", errors="ignore")
        self.db.save_extraction(
            extraction_id=extraction_id,
            source_id=source["id"],
            version_id=version_id,
            artifact_id=artifact_id,
            role=role,
            media_type=media_type,
            blob_relpath=relative,
            manifest_relpath=manifest_relative,
            content_text=content_text[:100000],
            coverage=manifest["coverage"],
            warnings=manifest["warnings"],
            complete=bool(manifest["complete"]),
        )
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
        if intake:
            intake.setdefault("artifact_refs", [])
            intake.setdefault("extraction_refs", [])
            if artifact_id not in intake["artifact_refs"]:
                intake["artifact_refs"].append(artifact_id)
            if extraction_id not in intake["extraction_refs"]:
                intake["extraction_refs"].append(extraction_id)
            if intake.get("intake_id"):
                self.update_intake(intake)
        return {
            "artifact_id": artifact_id,
            "extraction_id": extraction_id,
            "path": relative,
            "manifest": manifest_relative,
            "warnings": manifest["warnings"],
            "complete": manifest["complete"],
        }

    def migrate_legacy_workspace_sources(self, workspace_root: Path) -> int:
        """One-time non-destructive import of legacy workspace/sources and inbox/ingestion records into the Vault."""
        ws = workspace_root.expanduser().resolve()
        if not ws.exists():
            return 0
        migrated = 0
        records_dir = ws / "sources" / "records"
        if records_dir.is_dir():
            for path in sorted(records_dir.glob("*.md")):
                if path.name.startswith("source-template"):
                    continue
                try:
                    record = self._read_frontmatter(path)
                except Exception:
                    continue
                source_id = record.get("id")
                if not isinstance(source_id, str) or not SAFE_ID.fullmatch(source_id):
                    continue
                if self.db.get_source(source_id) is not None:
                    continue

                extracted_text = ""
                for ver in record.get("versions") or []:
                    if not isinstance(ver, dict) or not ver.get("id"):
                        continue
                    ver_id = str(ver["id"])
                    orig_ref = str(ver.get("original_ref") or "")
                    if orig_ref:
                        legacy_orig = (ws / orig_ref.lstrip("/")).resolve()
                        new_rel = _normalize_blob_relpath(orig_ref)
                        if legacy_orig.is_file() and _within(legacy_orig, ws):
                            data = legacy_orig.read_bytes()
                            self._write_bytes(new_rel, data, immutable=True)
                            ver["size_bytes"] = len(data)
                            ver["filename"] = ver.get("filename") or legacy_orig.name
                        ver["original_ref"] = new_rel

                    legacy_ext_root = ws / "sources" / "artifacts" / source_id / ver_id / "extractions"
                    if legacy_ext_root.is_dir():
                        for ext_dir in sorted(legacy_ext_root.iterdir()):
                            if not ext_dir.is_dir() or not SAFE_ID.fullmatch(ext_dir.name):
                                continue
                            ext_id = ext_dir.name
                            manifest_path = ext_dir / "manifest.json"
                            manifest = {}
                            if manifest_path.is_file():
                                try:
                                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                                except Exception:
                                    manifest = {}
                            for child in sorted(ext_dir.iterdir()):
                                if not child.is_file():
                                    continue
                                rel_target = f"blobs/{source_id}/{ver_id}/extractions/{ext_id}/{child.name}"
                                raw_bytes = child.read_bytes()
                                self._write_bytes(rel_target, raw_bytes, immutable=True)
                                if child.name != "manifest.json":
                                    text_val = raw_bytes.decode("utf-8", errors="ignore")
                                    if not extracted_text:
                                        extracted_text = text_val
                                    self.db.save_extraction(
                                        extraction_id=ext_id,
                                        source_id=source_id,
                                        version_id=ver_id,
                                        artifact_id=str(manifest.get("artifact_id") or make_id("art")),
                                        role=str(manifest.get("role") or child.stem),
                                        media_type=str(manifest.get("media_type") or "text/markdown"),
                                        blob_relpath=rel_target,
                                        manifest_relpath=f"blobs/{source_id}/{ver_id}/extractions/{ext_id}/manifest.json",
                                        content_text=text_val[:100000],
                                        coverage=manifest.get("coverage") if isinstance(manifest.get("coverage"), dict) else {},
                                        warnings=manifest.get("warnings") if isinstance(manifest.get("warnings"), list) else [],
                                        complete=bool(manifest.get("complete", True)),
                                    )

                self.db.save_source(record)
                self.db.upsert_source_fts(
                    source_id=source_id,
                    title=record.get("title"),
                    correspondent=record.get("correspondent"),
                    document_type=record.get("document_type"),
                    tags=record.get("tags"),
                    summary=record.get("summary"),
                    content=extracted_text[:100000],
                    document_date=record.get("document_date"),
                    review_status=(record.get("review") or {}).get("status", "unreviewed"),
                    processing_status=(record.get("processing") or {}).get("status") or record.get("status") or "complete",
                    lifecycle=record.get("lifecycle", "active"),
                    custom_fields=record.get("custom_fields") if isinstance(record.get("custom_fields"), dict) else None,
                )
                migrated += 1

        intakes_dir = ws / "inbox" / "ingestion"
        if intakes_dir.is_dir():
            for path in sorted(intakes_dir.glob("intake_*.md")):
                try:
                    intake = self._read_frontmatter(path)
                except Exception:
                    continue
                intake_id = intake.get("intake_id")
                if not isinstance(intake_id, str) or not SAFE_ID.fullmatch(intake_id):
                    continue
                if self.db.get_intake(intake_id) is None:
                    self.db.save_intake(intake)

        return migrated

    def _input_bytes(self, request: dict, kind: str) -> tuple[bytes, str, str]:
        if isinstance(request.get("data"), (bytes, bytearray)):
            data = bytes(request["data"])
            filename = safe_name(str(request.get("filename") or "source.bin"), "source.bin")
        elif isinstance(request.get("data_base64"), str) and request.get("data_base64"):
            try:
                data = base64.b64decode(request["data_base64"])
            except Exception as exc:
                raise PublicationError("invalid base64 payload") from exc
            filename = safe_name(str(request.get("filename") or "source.bin"), "source.bin")
        elif kind in {"chat", "text"} and request.get("content") is not None:
            content = request.get("content")
            if not isinstance(content, str):
                raise PublicationError("text ingestion requires string content")
            data = content.encode("utf-8")
            filename = safe_name(str(request.get("filename") or "source.txt"), "source.txt")
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
            allowed_roots = [
                Path("/tmp").resolve(),
                Path(os.environ.get("OPENLIA_UPLOAD_ROOT", "/tmp")).expanduser().resolve(),
                self.root,
            ]
            if self.workspace_root:
                allowed_roots.append(self.workspace_root)
            if not any(_within(resolved, allowed) for allowed in allowed_roots):
                raise PublicationError("input file is outside the configured upload root")
            if candidate.stat().st_size > MAX_SOURCE_BYTES:
                raise PublicationError("input file exceeds the source size limit")
            data, filename = candidate.read_bytes(), candidate.name

        if len(data) > MAX_SOURCE_BYTES:
            raise PublicationError("input file exceeds the source size limit")
        media_type = (
            request.get("media_type")
            or mimetypes.guess_type(filename)[0]
            or {
                "pdf": "application/pdf",
                "image": "image/png",
                "excel": "application/vnd.ms-excel",
                "csv": "text/csv",
            }.get(kind, "text/plain")
        )
        return data, filename, str(media_type)

    def _read_frontmatter(self, path: Path) -> dict:
        text = path.read_text(encoding="utf-8")
        if text.startswith("---\n") or text.startswith("---\r\n"):
            _, frontmatter, _ = text.split("---", 2)
            data = yaml.safe_load(frontmatter)
            if isinstance(data, dict):
                return data
        codeblock_match = re.search(r"```json\s*([\s\S]*?)```", text)
        if codeblock_match:
            data = json.loads(codeblock_match.group(1))
            if isinstance(data, dict):
                return data
        raise PublicationError(f"record has no valid frontmatter or JSON block: {path.name}")

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
            raise PublicationError("vault path escapes root") from exc
        current = self.root
        for part in Path(relative).parts[:-1]:
            current = current / part
            if current.exists() and current.is_symlink():
                raise PublicationError("vault path contains a symbolic link")
        return candidate


WorkspacePublisher = VaultStore


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
