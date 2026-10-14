"""Hermes-facing tools and the persistent ingestion worker supervisor."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path

from .adapters import AdapterError, process_job
from .passwords import PasswordProfileError, PasswordProfiles
from .publication import PublicationError, WorkspacePublisher
from .queue import IngestionQueue
from .references import build_markdown_citation, build_source_uri, find_backlinks, parse_source_uri


LOGGER = logging.getLogger("openlia.ingestion")


def _runtime_root() -> Path:
    return Path(os.environ.get("HERMES_HOME", "/opt/data")).expanduser() / "ingestion"


def _workspace_root() -> Path:
    return Path(os.environ.get("OPENLIA_WORKSPACE_ROOT", "/opt/data/workspace")).expanduser()


def _session_context() -> tuple[str | None, str | None]:
    try:
        from gateway.session_context import get_session_env

        key = get_session_env("HERMES_SESSION_KEY", "")
        session_id = get_session_env("HERMES_SESSION_ID", "")
        return (key or None, session_id or None)
    except Exception:
        return None, None


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class IngestionRuntime:
    def __init__(self, ctx):
        self.ctx = ctx
        self.runtime_root = _runtime_root()
        self.workspace_root = _workspace_root()
        self.queue = IngestionQueue(self.runtime_root)
        self.publisher = WorkspacePublisher(self.workspace_root)
        self.passwords = PasswordProfiles(self.workspace_root)
        self.stop_event = threading.Event()
        self.threads: list[threading.Thread] = []
        self.worker_lock = None
        self.instance_id = uuid.uuid4().hex
        try:
            configured = int(ctx.get_config("max_concurrent_jobs", 1))
        except (TypeError, ValueError):
            configured = 0
        if configured <= 0:
            raise ValueError("openlia-ingestion max_concurrent_jobs must be a positive integer")
        self.concurrency = min(configured, 8)
        self.ocr_task_registered = False
        try:
            ctx.register_auxiliary_task("openlia_ingestion_ocr", display_name="OpenLia ingestion OCR", description="Multilingual document and image reading", defaults={"timeout": 120})
            self.ocr_task_registered = True
        except Exception:
            LOGGER.warning("could not register the ingestion OCR auxiliary task")
        self.tagger_task_registered = False
        try:
            ctx.register_auxiliary_task("openlia_document_tagger", display_name="OpenLia document intelligence tagger", description="Automated document classification and metadata extraction", defaults={"timeout": 60})
            self.tagger_task_registered = True
        except Exception:
            LOGGER.warning("could not register the document tagger auxiliary task")

    def register_tools(self):
        self._register("ingestion_capture", self.capture, {
            "name": "ingestion_capture",
            "description": "Durably capture text, a local attachment, a PDF, image, Excel, CSV, or YouTube URL and queue asynchronous extraction.",
            "parameters": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["chat", "text", "file", "pdf", "image", "excel", "csv", "youtube"]}, "title": {"type": "string"}, "content": {"type": "string"}, "file_path": {"type": "string"}, "url": {"type": "string"}, "requested_outputs": {"type": "array", "items": {"type": "string"}}, "password_profile": {"type": "string"}, "next_action": {"type": "string"}, "request_ref": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}, "correspondent": {"type": "string"}, "document_type": {"type": "string"}, "document_date": {"type": "string"}}, "required": ["kind"]},
        })
        self._register("ingestion_status", self.status, {"name": "ingestion_status", "description": "Read sanitized durable ingestion status.", "parameters": {"type": "object", "properties": {"job_id": {"type": "string"}, "intake_id": {"type": "string"}}, "additionalProperties": False}})
        self._register("ingestion_retry", self.retry, {"name": "ingestion_retry", "description": "Explicitly retry a failed or blocked ingestion job.", "parameters": {"type": "object", "properties": {"intake_id": {"type": "string"}, "password_profile": {"type": "string"}}, "required": ["intake_id"]}})
        self._register("ingestion_acknowledge", self.acknowledge, {"name": "ingestion_acknowledge", "description": "Acknowledge an ingestion completion event before applying continuation work.", "parameters": {"type": "object", "properties": {"event_id": {"type": "string"}, "intake_id": {"type": "string"}, "action_id": {"type": "string"}}, "required": ["event_id", "intake_id"]}})
        self._register("ingestion_complete_action", self.complete_action, {"name": "ingestion_complete_action", "description": "Mark an idempotent continuation action complete after its domain records are durably written.", "parameters": {"type": "object", "properties": {"action_id": {"type": "string"}, "record_refs": {"type": "array", "items": {"type": "string"}}}, "required": ["action_id"]}})
        self._register("ingestion_recover", self.recover, {"name": "ingestion_recover", "description": "Recover expired ingestion leases and report durable intakes needing attention.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}})
        self._register("save_document_password", self.save_password, {"name": "save_document_password", "description": "Save a user-provided document-unlock password under a named profile. Never repeat the password.", "parameters": {"type": "object", "properties": {"profile_id": {"type": "string"}, "label": {"type": "string"}, "password": {"type": "string"}}, "required": ["profile_id", "label", "password"]}})
        self._register("list_document_password_profiles", self.list_passwords, {"name": "list_document_password_profiles", "description": "List document-password profile IDs and labels without values.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}})
        self._register("retry_ingestion_with_password_profile", self.retry_with_password, {"name": "retry_ingestion_with_password_profile", "description": "Associate an existing blocked intake with a document-password profile and requeue it.", "parameters": {"type": "object", "properties": {"intake_id": {"type": "string"}, "profile_id": {"type": "string"}}, "required": ["intake_id", "profile_id"]}})
        self._register("ingestion_search", self.search, {
            "name": "ingestion_search",
            "description": "Full-text and faceted search across all ingested documents, extracted OCR text, transcripts, and metadata. Returns matching sources, summaries, snippets, and canonical openlia://source/... reference URIs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Free text search keywords"},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Filter by tags"},
                    "correspondent": {"type": "string", "description": "Filter by sender/organization"},
                    "document_type": {"type": "string", "description": "Filter by document type (e.g. invoice, receipt, statement, contract)"},
                    "review_status": {"type": "string", "enum": ["unreviewed", "needs-review", "reviewed"], "description": "Filter by review status"},
                    "processing_status": {"type": "string", "description": "Filter by processing status"},
                    "lifecycle": {"type": "string", "enum": ["active", "archived"], "description": "Filter by lifecycle"},
                    "date_from": {"type": "string", "description": "Earliest document date (YYYY-MM-DD)"},
                    "date_to": {"type": "string", "description": "Latest document date (YYYY-MM-DD)"},
                    "limit": {"type": "integer", "description": "Max results to return (default 10, max 50)"},
                },
            },
        })
        self._register("ingestion_get_document", self.get_document, {
            "name": "ingestion_get_document",
            "description": "Retrieve an ingested document's complete metadata, tags, extractions, canonical citation URIs, and dynamic backlinks by source ID or openlia://source/... URI.",
            "parameters": {
                "type": "object",
                "required": ["source_id"],
                "properties": {
                    "source_id": {"type": "string", "description": "Source ID (src_...) or canonical openlia://source/... URI"},
                    "version_id": {"type": "string", "description": "Optional specific version ID"},
                    "include_content": {"type": "boolean", "description": "Whether to include full extracted text (default true)"},
                    "page": {"type": "integer", "description": "Specific page number excerpt to retrieve"},
                },
            },
        })
        self._register("ingestion_update_document", self.update_document, {
            "name": "ingestion_update_document",
            "description": "Update metadata attributes (title, correspondent, document_type, document_date, tags, summary, review_status, review_reasons, lifecycle) on an existing source record.",
            "parameters": {
                "type": "object",
                "required": ["source_id"],
                "properties": {
                    "source_id": {"type": "string", "description": "Source ID (src_...)"},
                    "title": {"type": "string"},
                    "correspondent": {"type": "string"},
                    "document_type": {"type": "string"},
                    "document_date": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "summary": {"type": "string"},
                    "review_status": {"type": "string", "enum": ["unreviewed", "needs-review", "reviewed"]},
                    "review_reasons": {"type": "array", "items": {"type": "string"}},
                    "lifecycle": {"type": "string", "enum": ["active", "archived"]},
                    "custom_fields": {"type": "object"},
                },
            },
        })
        self._register("ingestion_tag", self.tag_document, {
            "name": "ingestion_tag",
            "description": "Add or remove tags on an ingested source record.",
            "parameters": {
                "type": "object",
                "required": ["source_id"],
                "properties": {
                    "source_id": {"type": "string", "description": "Source ID (src_...)"},
                    "add_tags": {"type": "array", "items": {"type": "string"}},
                    "remove_tags": {"type": "array", "items": {"type": "string"}},
                },
            },
        })

    def _register(self, name, handler, schema):
        self.ctx.register_tool(name=name, toolset="openlia-ingestion", schema=schema, handler=handler, is_async=False, description=schema["description"])

    def start(self):
        self.queue.recover()
        self._publish_status()
        if os.environ.get("HERMES_CONTAINER") != "1":
            return
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        lock_path = self.runtime_root / "worker.lock"
        try:
            import fcntl

            self.worker_lock = open(lock_path, "a+")
            os.chmod(lock_path, 0o600)
            fcntl.flock(self.worker_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, ImportError):
            if self.worker_lock:
                self.worker_lock.close()
            self.worker_lock = None
            return
        for index in range(self.concurrency):
            thread = threading.Thread(target=self._worker_loop, name=f"openlia-ingestion-{index}", daemon=True)
            self.threads.append(thread)
            thread.start()
        dispatcher = threading.Thread(target=self._event_loop, name="openlia-ingestion-events", daemon=True)
        self.threads.append(dispatcher)
        dispatcher.start()

    def stop(self):
        self.stop_event.set()
        for thread in self.threads:
            thread.join(timeout=2)
        if self.worker_lock:
            self.worker_lock.close()
            self.worker_lock = None

    def capture(self, args: dict, **kwargs) -> str:
        try:
            session_key, session_id = _session_context()
            continuation = {"next_action": args.get("next_action") or "triage", "request_ref": args.get("request_ref"), "conversation_ref": session_key, "session_id": session_id}
            request = dict(args)
            request["continuation"] = continuation
            if request.get("password_profile") and isinstance(request.get("content"), str):
                try:
                    password = self.passwords.resolve(request["password_profile"])
                    request["content"] = request["content"].replace(password, f"[document password redacted; stored in profile {request['password_profile']}]")
                except PasswordProfileError:
                    return _json({"ok": False, "error_code": "password_profile_invalid", "message": "selected document-password profile was not found"})
            outputs = request.get("requested_outputs") or ["text"]
            idempotency = self._idempotency_key(request, outputs)
            existing = self.queue.get_by_idempotency(idempotency)
            if existing:
                return _json({"ok": True, "job_id": existing["job_id"], "intake_id": existing["intake_id"], "source_id": existing["source_id"], "version_id": existing.get("version_id"), "state": existing["state"], "durably_retained": True, "duplicate": True})
            captured = self.publisher.capture(request)
            source = captured["source"]
            intake = captured["intake"]
            job = self.queue.submit({"idempotency_key": idempotency, "intake_id": intake["intake_id"], "source_id": source["id"], "version_id": intake["version_id"], "operation": request.get("operation", "extract"), "requested_outputs": outputs, "password_profile": request.get("password_profile"), "continuation": continuation})
            intake["job_id"] = job["job_id"]
            intake["status"] = "queued"
            self.publisher.update_intake(intake)
            return _json({"ok": True, "job_id": job["job_id"], "intake_id": intake["intake_id"], "source_id": source["id"], "version_id": intake["version_id"], "state": job["state"], "durably_retained": True})
        except (PublicationError, PasswordProfileError, OSError, ValueError) as exc:
            return _json({"ok": False, "error_code": "capture_failed", "message": str(exc)})

    def _idempotency_key(self, request: dict, outputs: list[str]) -> str:
        payload = request.get("content")
        if request.get("file_path"):
            path = Path(str(request["file_path"])).expanduser()
            payload = hashlib.sha256(path.read_bytes()).hexdigest()
        material = {"kind": request.get("kind"), "payload": payload, "url": request.get("url"), "operation": request.get("operation", "extract"), "outputs": outputs, "password_profile": request.get("password_profile")}
        return hashlib.sha256(_json(material).encode()).hexdigest()

    def status(self, args: dict, **kwargs) -> str:
        try:
            job = self.queue.get(args.get("job_id")) if args.get("job_id") else self.queue.get_by_intake(args.get("intake_id"))
            return _json({"ok": True, "job_id": job["job_id"], "intake_id": job["intake_id"], "state": job["state"], "attempts": job["attempts"], "error_code": job.get("error_code"), "error_summary": job.get("error_summary"), "result": job.get("result")})
        except (KeyError, TypeError):
            return _json({"ok": False, "error_code": "job_not_found"})

    def retry(self, args: dict, **kwargs) -> str:
        return self.retry_with_password({"intake_id": args.get("intake_id"), "profile_id": args.get("password_profile")}, **kwargs) if args.get("password_profile") else self._requeue(args.get("intake_id"))

    def retry_with_password(self, args: dict, **kwargs) -> str:
        try:
            self.passwords.resolve(args["profile_id"])
            return self._requeue(args["intake_id"], args["profile_id"])
        except (KeyError, PasswordProfileError) as exc:
            return _json({"ok": False, "error_code": "password_profile_invalid", "message": str(exc)})

    def _requeue(self, intake_id: str, profile_id: str | None = None) -> str:
        try:
            job = self.queue.get_by_intake(intake_id)
            if profile_id:
                job["password_profile"] = profile_id
            # Re-submission preserves the original idempotency identity but the queue's
            # state transition is intentionally explicit and only applies to this job.
            with self.queue._database() as db:
                db.execute("UPDATE jobs SET state='queued', password_profile=COALESCE(?, password_profile), error_code=NULL, error_summary=NULL, next_attempt_at=?, updated_at=? WHERE job_id=? AND state IN ('failed','partial','awaiting-unlock','waiting-for-password','retryable-failure')", (profile_id, time.time(), time.time(), job["job_id"]))
            return _json({"ok": True, "job_id": job["job_id"], "intake_id": intake_id, "state": "queued"})
        except KeyError:
            return _json({"ok": False, "error_code": "job_not_found"})

    def acknowledge(self, args: dict, **kwargs) -> str:
        try:
            acknowledged = self.queue.acknowledge(args["event_id"])
            action = None
            if args.get("action_id"):
                action = self.queue.begin_action(args["action_id"], args["event_id"], args["intake_id"])
            intake = self.publisher.load_intake(args["intake_id"])
            intake.setdefault("callback", {})["event_id"] = args["event_id"]
            intake["callback"]["delivery_status"] = "acknowledged"
            self.publisher.update_intake(intake)
            return _json({"ok": True, "event_id": args["event_id"], "acknowledged": acknowledged, "action": action})
        except (KeyError, PublicationError) as exc:
            return _json({"ok": False, "error_code": "acknowledge_failed", "message": str(exc)})

    def complete_action(self, args: dict, **kwargs) -> str:
        try:
            completed = self.queue.complete_action(args["action_id"], args.get("record_refs") or [])
            return _json({"ok": True, "action_id": args["action_id"], "completed": completed})
        except (KeyError, TypeError):
            return _json({"ok": False, "error_code": "action_invalid"})

    def recover(self, args: dict, **kwargs) -> str:
        reclaimed = self.queue.recover()
        requeued = []
        restored_events = []
        for intake in self.publisher.list_intakes():
            callback = intake.get("callback") or {}
            if intake.get("status") in {"complete", "partial"} and callback.get("delivery_status") not in {"acknowledged"} and intake.get("job_id") and not (callback.get("event_id") and self.queue.event_exists(callback["event_id"] ) ):
                event_id = self.queue.create_event(intake["job_id"], f"ingestion.{intake['status']}", {"status": intake["status"], "intake_id": intake["intake_id"], "source_id": intake.get("source_id"), "version_id": intake.get("version_id"), "artifact_refs": intake.get("artifact_refs", []), "extraction_refs": intake.get("extraction_refs", []), "continuation": intake.get("continuation") or {}, "summary": {"recovered": True}})
                intake.setdefault("callback", {})["event_id"] = event_id
                intake["callback"]["delivery_status"] = "pending"
                self.publisher.update_intake(intake)
                restored_events.append(event_id)
                continue
            if intake.get("status") not in {"captured", "queued", "processing", "partial"}:
                continue
            try:
                self.queue.get_by_intake(intake["intake_id"])
                continue
            except KeyError:
                pass
            job = self.queue.submit({
                "idempotency_key": f"recovery:{intake['intake_id']}",
                "intake_id": intake["intake_id"],
                "source_id": intake["source_id"],
                "version_id": intake.get("version_id"),
                "operation": intake.get("operation") or "extract",
                "requested_outputs": intake.get("requested_outputs") or ["text"],
                "continuation": intake.get("continuation") or {},
            })
            intake["job_id"] = job["job_id"]
            intake["status"] = "queued"
            self.publisher.update_intake(intake)
            requeued.append(intake["intake_id"])
        return _json({"ok": True, "reclaimed_jobs": reclaimed, "requeued_intakes": requeued, "restored_events": restored_events, "message": "Durable intake records remain the recovery source of truth."})

    def save_password(self, args: dict, **kwargs) -> str:
        try:
            return _json({"ok": True, **self.passwords.save(args["profile_id"], args["label"], args["password"])})
        except PasswordProfileError as exc:
            return _json({"ok": False, "error_code": "password_profile_rejected", "message": str(exc)})

    def list_passwords(self, args: dict, **kwargs) -> str:
        try:
            return _json({"ok": True, "profiles": self.passwords.list()})
        except PasswordProfileError as exc:
            return _json({"ok": False, "error_code": "password_profiles_invalid", "message": str(exc)})

    def search(self, args: dict, **kwargs) -> str:
        try:
            result = self.queue.search_sources(
                query=args.get("query"),
                tags=args.get("tags"),
                correspondent=args.get("correspondent"),
                document_type=args.get("document_type"),
                review_status=args.get("review_status"),
                processing_status=args.get("processing_status"),
                lifecycle=args.get("lifecycle"),
                date_from=args.get("date_from"),
                date_to=args.get("date_to"),
                offset=int(args.get("offset") or 0),
                limit=min(int(args.get("limit") or 10), 50),
            )
            for item in result["matches"]:
                item["canonical_uri"] = build_source_uri(item["source_id"])
                item["markdown_citation"] = build_markdown_citation(item)
            return _json({"ok": True, **result})
        except Exception as exc:
            LOGGER.exception("ingestion_search error")
            return _json({"ok": False, "error_code": "search_failed", "message": str(exc)})

    def get_document(self, args: dict, **kwargs) -> str:
        try:
            raw_id = str(args.get("source_id") or "").strip()
            parsed = parse_source_uri(raw_id)
            source_id = parsed["source_id"] if parsed else raw_id
            page = int(args["page"]) if args.get("page") is not None else (parsed["page"] if parsed else None)
            version_id = args.get("version_id") or (parsed.get("version_id") if parsed else None)

            source = self.publisher.load_source(source_id)
            content = None
            if args.get("include_content", True):
                extracted_text = ""
                versions = source.get("versions") or []
                selected_version = next((v for v in versions if v.get("id") == version_id), versions[-1] if versions else None)
                if selected_version:
                    ver_id = selected_version.get("id")
                    for ext in selected_version.get("extractions", []):
                        ext_dir = self.publisher.artifacts / source_id / ver_id / "extractions" / ext
                        for candidate_name in ["text.md", "transcript.md", "tables.json"]:
                            candidate = ext_dir / candidate_name
                            if candidate.exists():
                                extracted_text = candidate.read_text(encoding="utf-8", errors="ignore")
                                break
                        if extracted_text:
                            break
                if page and extracted_text and f"## Page {page}" in extracted_text:
                    parts = extracted_text.split(f"## Page {page}")
                    if len(parts) > 1:
                        content = f"## Page {page}" + parts[1].split("## Page ")[0]
                else:
                    content = extracted_text[:50000] if extracted_text else None

            backlinks = find_backlinks(self.workspace_root, source_id)
            extractions = []
            versions = source.get("versions") or []
            selected_version = next((v for v in versions if v.get("id") == version_id), versions[-1] if versions else None)
            if selected_version:
                ver_id = selected_version.get("id")
                for ext in selected_version.get("extractions", []):
                    ext_dir = self.publisher.artifacts / source_id / ver_id / "extractions" / ext
                    extractions.append({"extraction_id": ext, "version_id": ver_id, "path": str(ext_dir)})

            doc_response = {
                **source,
                "content": content,
                "canonical_uri": build_source_uri(source_id, version_id, page),
                "markdown_citation": build_markdown_citation(source, version_id=version_id, page=page),
                "backlinks": backlinks,
                "extractions": extractions,
            }

            return _json({
                "ok": True,
                "source": doc_response,
                "document": doc_response,
                "content": content,
                "canonical_uri": build_source_uri(source_id, version_id, page),
                "markdown_citation": build_markdown_citation(source, version_id=version_id, page=page),
                "backlinks": backlinks,
            })
        except Exception as exc:
            LOGGER.exception("ingestion_get_document error")
            return _json({"ok": False, "error_code": "document_not_found", "message": str(exc)})

    def update_document(self, args: dict, **kwargs) -> str:
        try:
            source_id = str(args.get("source_id") or "").strip()
            source = self.publisher.load_source(source_id)
            for field in ["title", "correspondent", "document_type", "document_date", "summary", "lifecycle"]:
                if field in args and args[field] is not None:
                    source[field] = args[field]
            if "tags" in args and isinstance(args["tags"], list):
                source["tags"] = [str(t).strip().lower() for t in args["tags"] if str(t).strip()]
            if "custom_fields" in args and isinstance(args["custom_fields"], dict):
                source.setdefault("custom_fields", {}).update(args["custom_fields"])
            if "review" in args and isinstance(args["review"], dict):
                source.setdefault("review", {"status": "unreviewed", "reasons": []})
                if "status" in args["review"]:
                    source["review"]["status"] = args["review"]["status"]
                if "reasons" in args["review"]:
                    source["review"]["reasons"] = args["review"]["reasons"]
                if source["review"]["status"] == "reviewed":
                    source["review"]["reviewed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            if "review_status" in args and args["review_status"]:
                source.setdefault("review", {"status": "unreviewed", "reasons": []})
                source["review"]["status"] = args["review_status"]
                if args["review_status"] == "reviewed":
                    source["review"]["reviewed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            if "review_reasons" in args and isinstance(args["review_reasons"], list):
                source.setdefault("review", {"status": "unreviewed", "reasons": []})
                source["review"]["reasons"] = args["review_reasons"]

            self.publisher.update_source(source)
            self.queue.upsert_source_fts(
                source_id=source["id"],
                title=source.get("title"),
                correspondent=source.get("correspondent"),
                document_type=source.get("document_type"),
                tags=source.get("tags"),
                summary=source.get("summary"),
                content="",
                document_date=source.get("document_date"),
                review_status=source.get("review", {}).get("status", "unreviewed"),
                processing_status=source.get("processing", {}).get("status", "complete"),
                lifecycle=source.get("lifecycle", "active"),
            )
            return _json({"ok": True, "source_id": source_id, "updated": True, "document": source})
        except Exception as exc:
            LOGGER.exception("ingestion_update_document error")
            return _json({"ok": False, "error_code": "update_failed", "message": str(exc)})

    def tag_document(self, args: dict, **kwargs) -> str:
        try:
            source_id = str(args.get("source_id") or "").strip()
            source = self.publisher.load_source(source_id)
            current_tags = list(source.get("tags") or [])
            add_tags = [str(t).strip().lower() for t in (args.get("add_tags") or args.get("tags") or []) if str(t).strip()]
            remove_tags = set(str(t).strip().lower() for t in args.get("remove_tags") or [])
            for t in add_tags:
                if t not in current_tags:
                    current_tags.append(t)
            current_tags = [t for t in current_tags if t not in remove_tags]
            source["tags"] = current_tags
            self.publisher.update_source(source)
            self.queue.upsert_source_fts(
                source_id=source["id"],
                title=source.get("title"),
                correspondent=source.get("correspondent"),
                document_type=source.get("document_type"),
                tags=source.get("tags"),
                summary=source.get("summary"),
                content="",
                document_date=source.get("document_date"),
                review_status=source.get("review", {}).get("status", "unreviewed"),
                processing_status=source.get("processing", {}).get("status", "complete"),
                lifecycle=source.get("lifecycle", "active"),
            )
            return _json({"ok": True, "source_id": source_id, "tags": current_tags})
        except Exception as exc:
            return _json({"ok": False, "error_code": "tag_failed", "message": str(exc)})

    def _worker_loop(self):
        owner = f"{os.getpid()}-{uuid.uuid4().hex}"
        while not self.stop_event.is_set():
            job = self.queue.claim(owner)
            if not job:
                time.sleep(1)
                continue
            alive = threading.Event()
            heartbeat = threading.Thread(target=self._heartbeat, args=(job, owner, alive), daemon=True)
            heartbeat.start()
            try:
                guarded_publisher = _LeasePublisher(self.publisher, lambda: self.queue.owns(job["job_id"], owner, job["lease_generation"]) and self._publication_allowed())
                result = process_job(job, guarded_publisher, self.passwords, self.ctx.llm if (self.ocr_task_registered or getattr(self, "tagger_task_registered", False)) else None, db=self.queue)
                result.setdefault("status", "completed")
                result.setdefault("continuation", job.get("continuation", {}))
                event_id = self.queue.finish(job, result)
                if event_id:
                    try:
                        intake = self.publisher.load_intake(job["intake_id"])
                        intake.setdefault("callback", {})["event_id"] = event_id
                        intake["callback"]["delivery_status"] = "pending"
                        self.publisher.update_intake(intake)
                    except Exception:
                        LOGGER.warning("could not update completion callback metadata", exc_info=True)
            except AdapterError as exc:
                if exc.code in {"password_required", "password_invalid"}:
                    self.queue.block_for_password(job, exc.code, str(exc))
                    self._update_failure(job, exc.code, str(exc), status="awaiting-unlock")
                else:
                    self.queue.fail(job, exc.code, str(exc), exc.retryable)
                    self._update_failure(job, exc.code, str(exc))
            except (PublicationError, OSError, ValueError) as exc:
                self.queue.fail(job, "publication_failed", str(exc), True)
                self._update_failure(job, "publication_failed", str(exc))
            except Exception:
                LOGGER.exception("ingestion job failed")
                self.queue.fail(job, "internal_failure", "ingestion worker failed", True)
                self._update_failure(job, "internal_failure", "ingestion worker failed")
            finally:
                alive.set()
                heartbeat.join(timeout=1)

    def _heartbeat(self, job: dict, owner: str, stop: threading.Event):
        while not stop.wait(15):
            if not self.queue.heartbeat(job["job_id"], owner, job["lease_generation"]):
                return

    def _publication_allowed(self) -> bool:
        helper_path = Path(os.environ.get("OPENLIA_POLICY_HELPER", "/opt/data/skills/workspace-template-customization/scripts/workspace_registry.py"))
        if not helper_path.is_file():
            return True
        try:
            spec = importlib.util.spec_from_file_location("openlia_ingestion_policy", helper_path)
            if spec is None or spec.loader is None:
                return False
            helper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helper)
            registry = helper.load_registry(self.workspace_root, required=True)
            policy = helper.load_policy(self.workspace_root, registry=registry, required=True)
            return bool(helper.policy_allows(policy, "capture", "sources"))
        except Exception:
            return False

    def _update_failure(self, job: dict, code: str, message: str, status: str = "failed"):
        try:
            if not self._publication_allowed():
                return
            intake = self.publisher.load_intake(job["intake_id"])
            intake["status"] = status
            intake["last_error"] = code
            intake["retry_count"] = job.get("attempts", 0)
            self.publisher.update_intake(intake)
        except Exception:
            LOGGER.warning("could not update failed intake record", exc_info=True)

    def _event_loop(self):
        while not self.stop_event.is_set():
            for event in self.queue.due_events():
                self._deliver(event)
            self._publish_status()
            self.stop_event.wait(2)

    def _publish_status(self):
        """Publish live queue state without exposing queue payloads or secrets."""
        try:
            self.runtime_root.mkdir(parents=True, exist_ok=True)
            payload = {
                "schema": 1,
                "generated_at": time.time(),
                "instance_id": self.instance_id,
                **self.queue.live_status(),
            }
            temporary = self.runtime_root / f".status-{uuid.uuid4().hex}.tmp"
            with temporary.open("w", encoding="utf-8") as output:
                json.dump(payload, output, ensure_ascii=False, sort_keys=True)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.runtime_root / "status.json")
        except Exception:
            LOGGER.warning("could not publish ingestion status snapshot", exc_info=True)
            try:
                temporary.unlink()
            except (NameError, OSError):
                pass

    def _deliver(self, event: dict):
        payload = event.get("payload") or {}
        continuation = payload.get("continuation") or {}
        session_key = continuation.get("conversation_ref")
        if not session_key:
            self.queue.mark_event(event["event_id"], False, "conversation_unavailable")
            return
        message = _json({"event": event["event_type"], "event_id": event["event_id"], "action_id": f"ingestion:{event['event_id']}", "job_id": payload.get("job_id"), "intake_id": payload.get("intake_id"), "source_id": payload.get("source_id"), "version_id": payload.get("version_id"), "status": payload.get("status"), "artifact_refs": payload.get("artifact_refs", []), "extraction_refs": payload.get("extraction_refs", []), "summary": payload.get("summary", {}), "action": "Call ingestion_acknowledge before applying continuation work, then call ingestion_complete_action after durable domain writes."})
        try:
            delivered = bool(self.ctx.inject_message(message, role="user", session_key=session_key))
            self.queue.mark_event(event["event_id"], delivered, None if delivered else "gateway_unavailable")
        except Exception:
            self.queue.mark_event(event["event_id"], False, "callback_failed")


class _LeasePublisher:
    """Reject publication after a worker loses its lease."""

    def __init__(self, publisher, owns):
        self._publisher = publisher
        self._owns = owns

    def _check(self):
        if not self._owns():
            raise PublicationError("worker lease was lost before publication")

    def __getattr__(self, name):
        return getattr(self._publisher, name)

    def update_source(self, source):
        self._check()
        return self._publisher.update_source(source)

    def update_intake(self, intake):
        self._check()
        return self._publisher.update_intake(intake)

    def publish_bytes(self, relative, data):
        self._check()
        return self._publisher.publish_bytes(relative, data)

    def publish_extraction(self, *args, **kwargs):
        self._check()
        return self._publisher.publish_extraction(*args, **kwargs)
