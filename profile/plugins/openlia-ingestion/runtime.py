"""Hermes-facing tools and the persistent ingestion vault / sidecar client."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .adapters import AdapterError, process_job
from .db import IngestionQueue
from .passwords import PasswordProfileError, PasswordProfiles
from .publication import PublicationError, VaultStore
from .references import build_markdown_citation, build_source_uri, find_backlinks, parse_source_uri
from .server import (
    IngestionSidecarServer,
    _resolve_auth_token,
    build_page_outline,
    extract_page_slice,
)


LOGGER = logging.getLogger("openlia.ingestion")


def _runtime_root() -> Path:
    if os.environ.get("OPENLIA_INGESTION_ROOT"):
        return Path(os.environ["OPENLIA_INGESTION_ROOT"]).expanduser()
    return Path(os.environ.get("HERMES_HOME", "/opt/data")).expanduser() / "ingestion"


def _workspace_root() -> Path:
    return Path(os.environ.get("OPENLIA_WORKSPACE_ROOT", "/opt/data/workspace")).expanduser()


def _sidecar_url() -> str | None:
    url = (os.environ.get("OPENLIA_INGESTION_URL") or "").strip().rstrip("/")
    return url or None


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
        self.remote_url = _sidecar_url()
        self.auth_token = _resolve_auth_token()
        self.queue = IngestionQueue(self.runtime_root)
        self.publisher = VaultStore(
            self.runtime_root, workspace_root=self.workspace_root, db=self.queue
        )
        self.passwords = PasswordProfiles(self.runtime_root)
        self.stop_event = threading.Event()
        self.threads: list[threading.Thread] = []
        self.sidecar_server: IngestionSidecarServer | None = None
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
            ctx.register_auxiliary_task(
                "openlia_ingestion_ocr",
                display_name="OpenLia ingestion OCR",
                description="Multilingual document and image reading",
                defaults={"timeout": 120},
            )
            self.ocr_task_registered = True
        except Exception:
            LOGGER.warning("could not register the ingestion OCR auxiliary task")
        self.tagger_task_registered = False
        try:
            ctx.register_auxiliary_task(
                "openlia_document_tagger",
                display_name="OpenLia document intelligence tagger",
                description="Automated document classification and metadata extraction",
                defaults={"timeout": 60},
            )
            self.tagger_task_registered = True
        except Exception:
            LOGGER.warning("could not register the document tagger auxiliary task")

    def register_tools(self):
        self._register(
            "ingestion_capture",
            self.capture,
            {
                "name": "ingestion_capture",
                "description": "Durably capture text, a local attachment, a PDF, image, Excel, CSV, or YouTube URL into the standalone Ingestion Vault. Pass wait_seconds (e.g. 15) in interactive chat turns to process and return extracted metadata in a single call, and auto_unlock=true to automatically apply a high-confidence saved password profile.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["chat", "text", "file", "pdf", "image", "excel", "csv", "youtube"],
                        },
                        "title": {"type": "string"},
                        "content": {"type": "string"},
                        "file_path": {"type": "string"},
                        "url": {"type": "string"},
                        "requested_outputs": {"type": "array", "items": {"type": "string"}},
                        "password_profile": {"type": "string"},
                        "auto_unlock": {
                            "type": "boolean",
                            "description": "Automatically select a high-confidence matching password profile if password_profile is omitted.",
                        },
                        "wait_seconds": {
                            "type": "number",
                            "description": "Optional seconds to wait for extraction completion before returning (default 0; use 15 for interactive chat turns).",
                        },
                        "next_action": {"type": "string"},
                        "request_ref": {"type": "string"},
                        "tags": {"type": "array", "items": {"type": "string"}},
                        "correspondent": {"type": "string"},
                        "document_type": {"type": "string"},
                        "document_date": {"type": "string"},
                        "custom_fields": {"type": "object"},
                    },
                    "required": ["kind"],
                },
            },
        )
        self._register(
            "ingestion_status",
            self.status,
            {
                "name": "ingestion_status",
                "description": "Read sanitized durable ingestion status by job_id, intake_id, or source_id. Includes ranked password_suggestions when a document is awaiting-unlock.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "intake_id": {"type": "string"},
                        "source_id": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
            },
        )
        self._register(
            "ingestion_retry",
            self.retry,
            {
                "name": "ingestion_retry",
                "description": "Explicitly retry a failed or blocked ingestion job by source_id or intake_id.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "source_id": {"type": "string"},
                        "intake_id": {"type": "string"},
                        "password_profile": {"type": "string"},
                        "wait_seconds": {
                            "type": "number",
                            "description": "Optional seconds to wait for retry completion before returning.",
                        },
                    },
                },
            },
        )
        self._register(
            "ingestion_recover",
            self.recover,
            {
                "name": "ingestion_recover",
                "description": "Recover expired ingestion leases and report durable intakes needing attention.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        )
        self._register(
            "save_document_password",
            self.save_password,
            {
                "name": "save_document_password",
                "description": "Save or update a document-unlock password profile in the Ingestion Vault with optional description, safe hint, and filename glob patterns. Never repeat the password.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "profile_id": {"type": "string"},
                        "label": {"type": "string"},
                        "password": {
                            "type": "string",
                            "description": "Document password secret (required for new profiles; omit when only updating metadata on an existing profile).",
                        },
                        "description": {
                            "type": "string",
                            "description": "Usage context describing which documents use this password.",
                        },
                        "hint": {
                            "type": "string",
                            "description": "Safe reminder of the password format (never the raw secret itself).",
                        },
                        "patterns": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Filename glob patterns for automatic matching (e.g. ['*chase*.pdf', 'statement_*.pdf']).",
                        },
                    },
                    "required": ["profile_id", "label"],
                },
            },
        )
        self._register(
            "list_document_password_profiles",
            self.list_passwords,
            {
                "name": "list_document_password_profiles",
                "description": "List document-password profile IDs, labels, descriptions, safe hints, and filename glob patterns without secret password values.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        )
        self._register(
            "delete_document_password_profile",
            self.delete_password,
            {
                "name": "delete_document_password_profile",
                "description": "Delete a saved document-password profile by profile_id from the Ingestion Vault.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "profile_id": {"type": "string"},
                    },
                    "required": ["profile_id"],
                    "additionalProperties": False,
                },
            },
        )
        self._register(
            "ingestion_suggest_passwords",
            self.suggest_passwords,
            {
                "name": "ingestion_suggest_passwords",
                "description": "Suggest matching document-password profiles for a locked document using filename glob patterns, tokenized Levenshtein similarity, and description/hint keywords.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "source_id": {
                            "type": "string",
                            "description": "Optional source_id to inspect for filename, title, and correspondent.",
                        },
                        "filename": {"type": "string"},
                        "title": {"type": "string"},
                        "correspondent": {"type": "string"},
                        "message": {"type": "string"},
                    },
                },
            },
        )
        self._register(
            "retry_ingestion_with_password_profile",
            self.retry_with_password,
            {
                "name": "retry_ingestion_with_password_profile",
                "description": "Associate an existing blocked source or intake with a document-password profile and requeue it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "source_id": {"type": "string"},
                        "intake_id": {"type": "string"},
                        "profile_id": {"type": "string"},
                        "wait_seconds": {
                            "type": "number",
                            "description": "Optional seconds to wait for extraction completion before returning.",
                        },
                    },
                    "required": ["profile_id"],
                },
            },
        )
        self._register(
            "ingestion_search",
            self.search,
            {
                "name": "ingestion_search",
                "description": "Full-text and faceted search across all ingested documents, extracted OCR text, custom fields, transcripts, and metadata in the Ingestion Vault. Returns matching sources, summaries, snippets, and canonical openlia://source/... reference URIs.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Free text search keywords"},
                        "tags": {"type": "array", "items": {"type": "string"}, "description": "Filter by tags"},
                        "correspondent": {"type": "string", "description": "Filter by sender/organization"},
                        "document_type": {
                            "type": "string",
                            "description": "Filter by document type (e.g. invoice, receipt, bank_statement, contract)",
                        },
                        "review_status": {
                            "type": "string",
                            "enum": ["unreviewed", "needs-review", "reviewed"],
                            "description": "Filter by review status",
                        },
                        "processing_status": {"type": "string", "description": "Filter by processing status"},
                        "lifecycle": {
                            "type": "string",
                            "enum": ["active", "archived"],
                            "description": "Filter by lifecycle",
                        },
                        "date_from": {"type": "string", "description": "Earliest document date (YYYY-MM-DD)"},
                        "date_to": {"type": "string", "description": "Latest document date (YYYY-MM-DD)"},
                        "limit": {"type": "integer", "description": "Max results to return (default 10, max 50)"},
                    },
                },
            },
        )
        self._register(
            "ingestion_get_document",
            self.get_document,
            {
                "name": "ingestion_get_document",
                "description": "Retrieve an ingested document's complete metadata, page_count, page_outline, custom_fields, tags, extractions, canonical citation URIs, and dynamic workspace backlinks by source ID or openlia://source/... URI.",
                "parameters": {
                    "type": "object",
                    "required": ["source_id"],
                    "properties": {
                        "source_id": {
                            "type": "string",
                            "description": "Source ID (src_...) or canonical openlia://source/... URI",
                        },
                        "version_id": {"type": "string", "description": "Optional specific version ID"},
                        "include_content": {
                            "type": "boolean",
                            "description": "Whether to include extracted text (default true)",
                        },
                        "page": {"type": "integer", "description": "Specific page number excerpt to retrieve"},
                        "max_chars": {
                            "type": "integer",
                            "description": "Maximum characters of extracted text to return (default 50000)",
                        },
                    },
                },
            },
        )
        self._register(
            "ingestion_update_document",
            self.update_document,
            {
                "name": "ingestion_update_document",
                "description": "Update metadata attributes (title, correspondent, document_type, document_date, tags, summary, custom_fields, password_profile, review_status, review_reasons, lifecycle) on an existing source record in the Ingestion Vault.",
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
                        "password_profile": {"type": "string"},
                        "review_status": {
                            "type": "string",
                            "enum": ["unreviewed", "needs-review", "reviewed"],
                        },
                        "review_reasons": {"type": "array", "items": {"type": "string"}},
                        "lifecycle": {"type": "string", "enum": ["active", "archived"]},
                        "custom_fields": {"type": "object"},
                    },
                },
            },
        )
        self._register(
            "ingestion_tag",
            self.tag_document,
            {
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
            },
        )

    def _register(self, name, handler, schema):
        self.ctx.register_tool(
            name=name,
            toolset="openlia-ingestion",
            schema=schema,
            handler=handler,
            is_async=False,
            description=schema["description"],
        )

    def start(self):
        if self.remote_url:
            return
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

        # Start embedded HTTP sidecar endpoint if no external OPENLIA_INGESTION_URL is configured
        if not self.remote_url:
            bind_host = os.environ.get("OPENLIA_INGESTION_BIND", "127.0.0.1")
            bind_port = int(os.environ.get("OPENLIA_INGESTION_PORT", "8933"))
            try:
                self.sidecar_server = IngestionSidecarServer(
                    ingestion_root=self.runtime_root,
                    workspace_root=self.workspace_root,
                    host=bind_host,
                    port=bind_port,
                    llm=self.ctx.llm if (self.ocr_task_registered or self.tagger_task_registered) else None,
                    concurrency=self.concurrency,
                    start_workers=False,
                )
                self.sidecar_server.start()
            except OSError:
                LOGGER.debug("Ingestion HTTP port %d already bound", bind_port)

        for index in range(self.concurrency):
            thread = threading.Thread(
                target=self._worker_loop, name=f"openlia-ingestion-{index}", daemon=True
            )
            self.threads.append(thread)
            thread.start()
        status_thread = threading.Thread(
            target=self._status_loop, name="openlia-ingestion-status", daemon=True
        )
        self.threads.append(status_thread)
        status_thread.start()

    def stop(self):
        self.stop_event.set()
        if self.sidecar_server:
            self.sidecar_server.stop()
            self.sidecar_server = None
        for thread in self.threads:
            thread.join(timeout=2)
        if self.worker_lock:
            self.worker_lock.close()
            self.worker_lock = None

    def _http_request(
        self,
        method: str,
        path: str,
        payload: dict | None = None,
        *,
        timeout: float = 30.0,
    ) -> dict | None:
        if not self.remote_url:
            return None
        url = f"{self.remote_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers: dict[str, str] = {}
        if data is not None:
            headers["Content-Type"] = "application/json"
        token = _resolve_auth_token(self.auth_token)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw_err = exc.read().decode("utf-8", errors="ignore")
            try:
                parsed_err = json.loads(raw_err)
                if isinstance(parsed_err, dict):
                    parsed_err.setdefault("ok", False)
                    return parsed_err
            except Exception:
                pass
            raise

    def _suggestions_for_source(self, source_id: str) -> list[dict]:
        try:
            source = self.publisher.load_source(source_id)
            versions = source.get("versions") or []
            filename = versions[-1].get("filename") if versions else None
            return self.passwords.suggest(
                filename=filename,
                title=source.get("title"),
                correspondent=source.get("correspondent"),
                message=source.get("origin", {}).get("request_ref"),
            )
        except Exception:
            return []

    def _run_single_job_inline(self, job: dict, owner: str | None = None) -> None:
        owner = owner or f"inline-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        alive = threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat, args=(job, owner, alive), daemon=True
        )
        heartbeat.start()
        try:
            guarded_publisher = _LeasePublisher(
                self.publisher,
                lambda: self.queue.owns(job["job_id"], owner, job["lease_generation"])
                and self._publication_allowed(),
            )
            result = process_job(
                job,
                guarded_publisher,
                self.passwords,
                self.ctx.llm
                if (
                    self.ocr_task_registered
                    or getattr(self, "tagger_task_registered", False)
                )
                else None,
                db=self.queue,
            )
            result.setdefault("status", "completed")
            result.setdefault("continuation", job.get("continuation", {}))
            self.queue.finish(job, result)
        except AdapterError as exc:
            if exc.code in {"password_required", "password_invalid", "unlock_failed"}:
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

    def _wait_for_job_local(self, job_id: str, wait_seconds: float) -> dict:
        deadline = time.time() + max(0.0, min(float(wait_seconds), 120.0))
        terminal_states = {"completed", "partial", "awaiting-unlock", "failed"}
        while True:
            job = self.queue.get(job_id)
            if job["state"] in terminal_states:
                return job
            if not self.threads and job["state"] == "queued":
                owner = f"inline-{os.getpid()}-{uuid.uuid4().hex[:8]}"
                claimed = self.queue.claim(owner)
                if claimed:
                    self._run_single_job_inline(claimed, owner=owner)
                    self._publish_status()
                    continue
            if time.time() >= deadline:
                return self.queue.get(job_id)
            time.sleep(0.05)

    def _enrich_job_response_local(self, base_response: dict, job: dict) -> dict:
        out = dict(base_response)
        out["state"] = job["state"]
        if job.get("error_code"):
            out["error_code"] = job["error_code"]
        if job.get("error_summary"):
            out["error_summary"] = job["error_summary"]
        if job.get("result") is not None:
            out["result"] = job["result"]
        source_id = job.get("source_id") or out.get("source_id")
        if job["state"] == "awaiting-unlock" and source_id:
            out["password_suggestions"] = self._suggestions_for_source(str(source_id))
        elif job["state"] in {"completed", "partial"} and source_id:
            try:
                source = self.publisher.load_source(str(source_id))
                out["title"] = source.get("title")
                out["document_type"] = source.get("document_type")
                out["correspondent"] = source.get("correspondent")
                out["document_date"] = source.get("document_date")
                out["tags"] = source.get("tags") or []
                out["summary"] = source.get("summary")
                out["custom_fields"] = source.get("custom_fields") or {}
                out["review_status"] = source.get("review", {}).get("status", "unreviewed")
                out["canonical_uri"] = build_source_uri(str(source_id), job.get("version_id"))
                out["markdown_citation"] = build_markdown_citation(
                    source, version_id=job.get("version_id")
                )
            except Exception:
                pass
        return out

    def capture(self, args: dict, **kwargs) -> str:
        try:
            session_key, session_id = _session_context()
            continuation = {
                "next_action": args.get("next_action") or "triage",
                "request_ref": args.get("request_ref"),
                "conversation_ref": session_key,
                "session_id": session_id,
            }
            request = dict(args)
            request["continuation"] = continuation
            wait_seconds = float(request.get("wait_seconds") or 0)
            if self.remote_url:
                if request.get("file_path"):
                    candidate = Path(str(request["file_path"])).expanduser().resolve()
                    request["data_base64"] = base64.b64encode(candidate.read_bytes()).decode("ascii")
                    request["filename"] = candidate.name
                    request.pop("file_path", None)
                remote_res = self._http_request(
                    "POST",
                    "/v1/sources/upload",
                    request,
                    timeout=max(30.0, wait_seconds + 15.0),
                )
                if remote_res is not None:
                    return _json(remote_res)

            auto_selected_profile: str | None = None
            if request.get("auto_unlock") and not request.get("password_profile"):
                candidate_filename = request.get("filename")
                if not candidate_filename and request.get("file_path"):
                    candidate_filename = Path(str(request["file_path"])).name
                suggestions = self.passwords.suggest(
                    filename=str(candidate_filename or ""),
                    title=str(request.get("title") or ""),
                    correspondent=str(request.get("correspondent") or ""),
                    message=str(request.get("request_ref") or ""),
                )
                if suggestions and suggestions[0]["score"] >= 70:
                    auto_selected_profile = suggestions[0]["profile_id"]
                    request["password_profile"] = auto_selected_profile

            if request.get("password_profile") and isinstance(request.get("content"), str):
                try:
                    password = self.passwords.resolve(request["password_profile"])
                    request["content"] = request["content"].replace(
                        password,
                        f"[document password redacted; stored in profile {request['password_profile']}]",
                    )
                except PasswordProfileError:
                    return _json(
                        {
                            "ok": False,
                            "error_code": "password_profile_invalid",
                            "message": "selected document-password profile was not found",
                        }
                    )
            elif request.get("password_profile"):
                try:
                    self.passwords.resolve(request["password_profile"])
                except PasswordProfileError:
                    return _json(
                        {
                            "ok": False,
                            "error_code": "password_profile_invalid",
                            "message": "selected document-password profile was not found",
                        }
                    )

            outputs = request.get("requested_outputs") or ["text"]
            idempotency = self._idempotency_key(request, outputs)
            existing = self.queue.get_by_idempotency(idempotency)
            if existing:
                dup_resp = {
                    "ok": True,
                    "job_id": existing["job_id"],
                    "intake_id": existing["intake_id"],
                    "source_id": existing["source_id"],
                    "version_id": existing.get("version_id"),
                    "state": existing["state"],
                    "durably_retained": True,
                    "duplicate": True,
                }
                if wait_seconds > 0:
                    waited = self._wait_for_job_local(existing["job_id"], wait_seconds)
                    dup_resp = self._enrich_job_response_local(dup_resp, waited)
                return _json(dup_resp)

            captured = self.publisher.capture(request)
            source = captured["source"]
            intake = captured["intake"]
            job = self.queue.submit(
                {
                    "idempotency_key": idempotency,
                    "intake_id": intake["intake_id"],
                    "source_id": source["id"],
                    "version_id": intake["version_id"],
                    "operation": request.get("operation", "extract"),
                    "requested_outputs": outputs,
                    "password_profile": request.get("password_profile"),
                    "continuation": continuation,
                }
            )
            intake["job_id"] = job["job_id"]
            intake["status"] = "queued"
            self.publisher.update_intake(intake)
            source.setdefault("processing", {})
            source["processing"]["status"] = "queued"
            source["processing"]["last_job_id"] = job["job_id"]
            self.publisher.update_source(source)
            self.queue.upsert_source_fts(
                source_id=source["id"],
                title=source.get("title"),
                correspondent=source.get("correspondent"),
                document_type=source.get("document_type"),
                tags=source.get("tags"),
                summary=source.get("summary"),
                content=self.queue.get_source_fts_content(source["id"]),
                document_date=source.get("document_date"),
                review_status=source.get("review", {}).get("status", "unreviewed"),
                processing_status="queued",
                lifecycle=source.get("lifecycle", "active"),
                custom_fields=source.get("custom_fields"),
            )
            base_resp: dict[str, Any] = {
                "ok": True,
                "job_id": job["job_id"],
                "intake_id": intake["intake_id"],
                "source_id": source["id"],
                "version_id": intake["version_id"],
                "state": job["state"],
                "durably_retained": True,
            }
            if auto_selected_profile:
                base_resp["auto_selected_password_profile"] = auto_selected_profile
            if wait_seconds > 0:
                waited = self._wait_for_job_local(job["job_id"], wait_seconds)
                base_resp = self._enrich_job_response_local(base_resp, waited)
            return _json(base_resp)
        except (PublicationError, PasswordProfileError, OSError, ValueError) as exc:
            return _json({"ok": False, "error_code": "capture_failed", "message": str(exc)})

    def _idempotency_key(self, request: dict, outputs: list[str]) -> str:
        payload = request.get("content")
        if request.get("file_path"):
            path = Path(str(request["file_path"])).expanduser()
            payload = hashlib.sha256(path.read_bytes()).hexdigest()
        material = {
            "kind": request.get("kind"),
            "payload": payload,
            "url": request.get("url"),
            "operation": request.get("operation", "extract"),
            "outputs": outputs,
            "password_profile": request.get("password_profile"),
            "continuation": request.get("continuation") or {},
        }
        return hashlib.sha256(_json(material).encode()).hexdigest()

    def status(self, args: dict, **kwargs) -> str:
        try:
            if self.remote_url:
                params: dict[str, str] = {}
                for k in ("job_id", "intake_id", "source_id"):
                    if args.get(k):
                        params[k] = str(args[k])
                qs = f"?{urllib.parse.urlencode(params)}" if params else ""
                remote_res = self._http_request("GET", f"/v1/status{qs}")
                if remote_res is not None:
                    if not remote_res.get("ok") and remote_res.get("error_code") == "not_found":
                        return _json({"ok": False, "error_code": "job_not_found"})
                    return _json(remote_res)

            if args.get("job_id"):
                job = self.queue.get(args["job_id"])
            elif args.get("intake_id"):
                job = self.queue.get_by_intake(args["intake_id"])
            elif args.get("source_id"):
                job = self.queue.get_by_source(args["source_id"])
            else:
                return _json({"ok": True, **self.queue.live_status()})
            resp: dict[str, Any] = {
                "ok": True,
                "job_id": job["job_id"],
                "intake_id": job["intake_id"],
                "source_id": job["source_id"],
                "state": job["state"],
                "attempts": job["attempts"],
                "error_code": job.get("error_code"),
                "error_summary": job.get("error_summary"),
                "result": job.get("result"),
            }
            if job["state"] == "awaiting-unlock" or job.get("error_code") in {
                "password_required",
                "password_invalid",
                "unlock_failed",
            }:
                resp["password_suggestions"] = self._suggestions_for_source(job["source_id"])
            return _json(resp)
        except (KeyError, TypeError):
            return _json({"ok": False, "error_code": "job_not_found"})

    def retry(self, args: dict, **kwargs) -> str:
        if args.get("password_profile"):
            return self.retry_with_password(
                {
                    "intake_id": args.get("intake_id"),
                    "source_id": args.get("source_id"),
                    "profile_id": args.get("password_profile"),
                    "wait_seconds": args.get("wait_seconds"),
                },
                **kwargs,
            )
        return self._requeue(
            intake_id=args.get("intake_id"),
            source_id=args.get("source_id"),
            wait_seconds=float(args.get("wait_seconds") or 0),
        )

    def retry_with_password(self, args: dict, **kwargs) -> str:
        try:
            if not self.remote_url:
                self.passwords.resolve(args["profile_id"])
            return self._requeue(
                intake_id=args.get("intake_id"),
                source_id=args.get("source_id"),
                profile_id=args["profile_id"],
                wait_seconds=float(args.get("wait_seconds") or 0),
            )
        except (KeyError, PasswordProfileError) as exc:
            return _json(
                {"ok": False, "error_code": "password_profile_invalid", "message": str(exc)}
            )

    def _requeue(
        self,
        intake_id: str | None = None,
        profile_id: str | None = None,
        *,
        source_id: str | None = None,
        wait_seconds: float = 0,
    ) -> str:
        try:
            if self.remote_url and (source_id or intake_id):
                target = source_id or intake_id
                remote_res = self._http_request(
                    "POST",
                    f"/v1/sources/{target}/retry",
                    {
                        "password_profile": profile_id,
                        "intake_id": intake_id,
                        "wait_seconds": wait_seconds,
                    },
                    timeout=max(30.0, float(wait_seconds or 0) + 15.0),
                )
                if remote_res is not None:
                    if not remote_res.get("ok"):
                        msg = str(remote_res.get("message") or "")
                        if "password profile" in msg.lower():
                            return _json(
                                {
                                    "ok": False,
                                    "error_code": "password_profile_invalid",
                                    "message": msg,
                                }
                            )
                        return _json({"ok": False, "error_code": "job_not_found", "message": msg})
                    return _json(remote_res)

            job = (
                self.queue.get_by_intake(intake_id)
                if intake_id
                else self.queue.get_by_source(str(source_id))
            )
            updated = self.queue.requeue_job(job["job_id"], password_profile=profile_id)
            if profile_id:
                try:
                    source = self.publisher.load_source(updated["source_id"])
                    source["password_profile"] = profile_id
                    self.publisher.update_source(source)
                except Exception:
                    pass
            base_resp: dict[str, Any] = {
                "ok": True,
                "job_id": updated["job_id"],
                "intake_id": updated.get("intake_id") or intake_id,
                "source_id": updated["source_id"],
                "state": "queued",
            }
            if wait_seconds and float(wait_seconds) > 0:
                waited = self._wait_for_job_local(updated["job_id"], float(wait_seconds))
                base_resp = self._enrich_job_response_local(base_resp, waited)
            return _json(base_resp)
        except KeyError:
            return _json({"ok": False, "error_code": "job_not_found"})

    def recover(self, args: dict, **kwargs) -> str:
        if self.remote_url:
            remote_res = self._http_request("POST", "/v1/recover", {})
            if remote_res is not None:
                return _json(remote_res)

        reclaimed = self.queue.recover()
        requeued = []
        for intake in self.publisher.list_intakes():
            if intake.get("status") not in {"captured", "queued", "processing", "partial"}:
                continue
            try:
                self.queue.get_by_intake(intake["intake_id"])
                continue
            except KeyError:
                pass
            job = self.queue.submit(
                {
                    "idempotency_key": f"recovery:{intake['intake_id']}",
                    "intake_id": intake["intake_id"],
                    "source_id": intake["source_id"],
                    "version_id": intake.get("version_id"),
                    "operation": intake.get("operation") or "extract",
                    "requested_outputs": intake.get("requested_outputs") or ["text"],
                    "continuation": intake.get("continuation") or {},
                }
            )
            intake["job_id"] = job["job_id"]
            intake["status"] = "queued"
            self.publisher.update_intake(intake)
            requeued.append(intake["intake_id"])
        return _json(
            {
                "ok": True,
                "reclaimed_jobs": reclaimed,
                "requeued_intakes": requeued,
                "message": "Ingestion Vault records remain the recovery source of truth.",
            }
        )

    def save_password(self, args: dict, **kwargs) -> str:
        try:
            if self.remote_url:
                remote_res = self._http_request("POST", "/v1/passwords", args)
                if remote_res is not None:
                    if not remote_res.get("ok"):
                        return _json(
                            {
                                "ok": False,
                                "error_code": "password_profile_rejected",
                                "message": remote_res.get("message") or "password profile rejected",
                            }
                        )
                    return _json(remote_res)
            raw_pw = args.get("password")
            return _json(
                {
                    "ok": True,
                    **self.passwords.save(
                        args["profile_id"],
                        args["label"],
                        str(raw_pw) if raw_pw is not None and str(raw_pw) != "" else None,
                        description=args.get("description"),
                        hint=args.get("hint"),
                        patterns=args.get("patterns"),
                    ),
                }
            )
        except (KeyError, PasswordProfileError) as exc:
            return _json(
                {"ok": False, "error_code": "password_profile_rejected", "message": str(exc)}
            )

    def list_passwords(self, args: dict, **kwargs) -> str:
        try:
            if self.remote_url:
                remote_res = self._http_request("GET", "/v1/passwords")
                if remote_res is not None:
                    return _json(remote_res)
            return _json({"ok": True, "profiles": self.passwords.list()})
        except PasswordProfileError as exc:
            return _json(
                {"ok": False, "error_code": "password_profiles_invalid", "message": str(exc)}
            )

    def delete_password(self, args: dict, **kwargs) -> str:
        try:
            profile_id = str(args.get("profile_id") or "").strip()
            if self.remote_url:
                remote_res = self._http_request(
                    "DELETE", f"/v1/passwords/{urllib.parse.quote(profile_id)}"
                )
                if remote_res is not None:
                    if not remote_res.get("ok"):
                        return _json(
                            {
                                "ok": False,
                                "error_code": "password_profile_not_found",
                                "message": remote_res.get("message") or "password profile not found",
                            }
                        )
                    return _json(remote_res)
            deleted = self.passwords.delete(profile_id)
            if not deleted:
                return _json(
                    {
                        "ok": False,
                        "error_code": "password_profile_not_found",
                        "message": "password profile was not found",
                    }
                )
            return _json({"ok": True, "profile_id": profile_id, "deleted": True})
        except PasswordProfileError as exc:
            return _json(
                {"ok": False, "error_code": "password_profile_invalid", "message": str(exc)}
            )

    def suggest_passwords(self, args: dict, **kwargs) -> str:
        try:
            filename = args.get("filename")
            title = args.get("title")
            correspondent = args.get("correspondent")
            message = args.get("message")
            source_id = args.get("source_id")

            if self.remote_url:
                if source_id and not (filename or title):
                    doc_res = self._http_request("GET", f"/v1/sources/{source_id}?include_content=false")
                    if doc_res and doc_res.get("ok"):
                        doc = doc_res.get("document") or doc_res.get("source") or {}
                        title = title or doc.get("title")
                        correspondent = correspondent or doc.get("correspondent")
                        versions = doc.get("versions") or []
                        if versions and not filename:
                            filename = versions[-1].get("filename")
                remote_res = self._http_request(
                    "POST",
                    "/v1/passwords/suggest",
                    {
                        "filename": filename,
                        "title": title,
                        "correspondent": correspondent,
                        "message": message,
                    },
                )
                if remote_res is not None:
                    return _json(remote_res)

            if source_id and not (filename or title):
                try:
                    source = self.publisher.load_source(str(source_id))
                    title = title or source.get("title")
                    correspondent = correspondent or source.get("correspondent")
                    versions = source.get("versions") or []
                    if versions and not filename:
                        filename = versions[-1].get("filename")
                except Exception:
                    pass

            suggestions = self.passwords.suggest(
                filename=filename,
                title=title,
                correspondent=correspondent,
                message=message,
            )
            return _json({"ok": True, "suggestions": suggestions})
        except Exception as exc:
            return _json(
                {"ok": False, "error_code": "suggest_passwords_failed", "message": str(exc)}
            )

    def search(self, args: dict, **kwargs) -> str:
        try:
            if self.remote_url:
                params: dict[str, Any] = {}
                if args.get("query"):
                    params["q"] = args["query"]
                if args.get("tags"):
                    params["tags"] = ",".join(args["tags"])
                for k in (
                    "correspondent",
                    "document_type",
                    "review_status",
                    "processing_status",
                    "lifecycle",
                    "date_from",
                    "date_to",
                    "offset",
                    "limit",
                ):
                    if args.get(k) is not None:
                        params[k] = args[k]
                qs = urllib.parse.urlencode(params)
                remote_res = self._http_request("GET", f"/v1/sources/search?{qs}")
                if remote_res is not None:
                    return _json(remote_res)

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
            page = (
                int(args["page"])
                if args.get("page") is not None
                else (parsed["page"] if parsed else None)
            )
            version_id = args.get("version_id") or (parsed.get("version_id") if parsed else None)
            max_chars = int(args.get("max_chars") or 50000)

            if self.remote_url:
                params: dict[str, Any] = {}
                if version_id:
                    params["version_id"] = version_id
                if page is not None:
                    params["page"] = page
                if args.get("include_content") is False:
                    params["include_content"] = "false"
                if args.get("max_chars") is not None:
                    params["max_chars"] = max_chars
                qs = f"?{urllib.parse.urlencode(params)}" if params else ""
                remote_res = self._http_request("GET", f"/v1/sources/{source_id}{qs}")
                if remote_res is not None:
                    if not remote_res.get("ok"):
                        return _json(
                            {
                                "ok": False,
                                "error_code": "document_not_found",
                                "message": remote_res.get("message") or "document not found",
                            }
                        )
                    backlinks = find_backlinks(self.workspace_root, source_id)
                    remote_res["backlinks"] = backlinks
                    if isinstance(remote_res.get("document"), dict):
                        remote_res["document"]["backlinks"] = backlinks
                    if isinstance(remote_res.get("source"), dict):
                        remote_res["source"]["backlinks"] = backlinks
                    return _json(remote_res)

            source = self.publisher.load_source(source_id)
            extracted_text = ""
            selected_version = _select_version(source, version_id)
            if selected_version:
                ver_id = selected_version.get("id")
                for ext in reversed(selected_version.get("extractions", [])):
                    ext_dir = self.publisher.artifacts / source_id / ver_id / "extractions" / ext
                    for candidate_name in ["text.md", "transcript.md", "tables.json"]:
                        candidate = ext_dir / candidate_name
                        if candidate.exists():
                            extracted_text = candidate.read_text(
                                encoding="utf-8", errors="ignore"
                            )
                            break
                    if extracted_text:
                        break
            page_count, page_outline = build_page_outline(extracted_text)
            content = (
                extract_page_slice(extracted_text, page, max_chars=max_chars)
                if args.get("include_content", True)
                else None
            )

            backlinks = find_backlinks(self.workspace_root, source_id)
            extractions = []
            if selected_version:
                ver_id = selected_version.get("id")
                for ext in reversed(selected_version.get("extractions", [])):
                    ext_dir = self.publisher.artifacts / source_id / ver_id / "extractions" / ext
                    extractions.append(
                        {"extraction_id": ext, "version_id": ver_id, "path": str(ext_dir)}
                    )

            doc_response = {
                **source,
                "content": content,
                "page": page,
                "page_count": page_count,
                "page_outline": page_outline,
                "canonical_uri": build_source_uri(source_id, version_id, page),
                "markdown_citation": build_markdown_citation(
                    source, version_id=version_id, page=page
                ),
                "backlinks": backlinks,
                "extractions": extractions,
            }

            return _json(
                {
                    "ok": True,
                    "source": doc_response,
                    "document": doc_response,
                    "content": content,
                    "page": page,
                    "page_count": page_count,
                    "page_outline": page_outline,
                    "canonical_uri": build_source_uri(source_id, version_id, page),
                    "markdown_citation": build_markdown_citation(
                        source, version_id=version_id, page=page
                    ),
                    "backlinks": backlinks,
                }
            )
        except Exception as exc:
            LOGGER.exception("ingestion_get_document error")
            return _json(
                {"ok": False, "error_code": "document_not_found", "message": str(exc)}
            )

    def update_document(self, args: dict, **kwargs) -> str:
        try:
            source_id = str(args.get("source_id") or "").strip()
            if self.remote_url:
                remote_res = self._http_request("PATCH", f"/v1/sources/{source_id}", args)
                if remote_res is not None:
                    return _json(remote_res)

            source = self.publisher.load_source(source_id)
            for field in [
                "title",
                "correspondent",
                "document_type",
                "document_date",
                "summary",
                "lifecycle",
                "password_profile",
            ]:
                if field in args and args[field] is not None:
                    source[field] = args[field]
            if "tags" in args and isinstance(args["tags"], list):
                source["tags"] = [
                    str(t).strip().lower() for t in args["tags"] if str(t).strip()
                ]
            if "custom_fields" in args and isinstance(args["custom_fields"], dict):
                merged_cf = dict(source.get("custom_fields") or {})
                for k, v in args["custom_fields"].items():
                    if v is None or v == "":
                        merged_cf.pop(str(k), None)
                    else:
                        merged_cf[str(k)] = v
                source["custom_fields"] = merged_cf
            if "review" in args and isinstance(args["review"], dict):
                source.setdefault("review", {"status": "unreviewed", "reasons": []})
                if "status" in args["review"]:
                    source["review"]["status"] = args["review"]["status"]
                if "reasons" in args["review"]:
                    source["review"]["reasons"] = args["review"]["reasons"]
                if source["review"]["status"] == "reviewed":
                    source["review"]["reviewed_at"] = time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                    )
            if "review_status" in args and args["review_status"]:
                source.setdefault("review", {"status": "unreviewed", "reasons": []})
                source["review"]["status"] = args["review_status"]
                if args["review_status"] == "reviewed":
                    source["review"]["reviewed_at"] = time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                    )
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
                content=self.queue.get_source_fts_content(source["id"]),
                document_date=source.get("document_date"),
                review_status=source.get("review", {}).get("status", "unreviewed"),
                processing_status=source.get("processing", {}).get("status", "complete"),
                lifecycle=source.get("lifecycle", "active"),
                custom_fields=source.get("custom_fields"),
            )
            return _json(
                {"ok": True, "source_id": source_id, "updated": True, "document": source}
            )
        except Exception as exc:
            LOGGER.exception("ingestion_update_document error")
            return _json({"ok": False, "error_code": "update_failed", "message": str(exc)})

    def tag_document(self, args: dict, **kwargs) -> str:
        try:
            source_id = str(args.get("source_id") or "").strip()
            add_tags = [
                str(t).strip().lower()
                for t in (args.get("add_tags") or args.get("tags") or [])
                if str(t).strip()
            ]
            remove_tags = [
                str(t).strip().lower()
                for t in (args.get("remove_tags") or [])
                if str(t).strip()
            ]
            if self.remote_url:
                remote_res = self._http_request(
                    "PATCH",
                    f"/v1/sources/{source_id}",
                    {"add_tags": add_tags, "remove_tags": remove_tags},
                )
                if remote_res is not None:
                    if not remote_res.get("ok"):
                        return _json(
                            {
                                "ok": False,
                                "error_code": "tag_failed",
                                "message": remote_res.get("message") or "tag update failed",
                            }
                        )
                    return _json(
                        {
                            "ok": True,
                            "source_id": source_id,
                            "tags": remote_res.get("tags")
                            or (remote_res.get("document") or {}).get("tags")
                            or [],
                        }
                    )

            source = self.publisher.load_source(source_id)
            current_tags = list(source.get("tags") or [])
            remove_set = set(remove_tags)
            for t in add_tags:
                if t not in current_tags:
                    current_tags.append(t)
            current_tags = [t for t in current_tags if t not in remove_set]
            source["tags"] = current_tags
            self.publisher.update_source(source)
            self.queue.upsert_source_fts(
                source_id=source["id"],
                title=source.get("title"),
                correspondent=source.get("correspondent"),
                document_type=source.get("document_type"),
                tags=source.get("tags"),
                summary=source.get("summary"),
                content=self.queue.get_source_fts_content(source["id"]),
                document_date=source.get("document_date"),
                review_status=source.get("review", {}).get("status", "unreviewed"),
                processing_status=source.get("processing", {}).get("status", "complete"),
                lifecycle=source.get("lifecycle", "active"),
                custom_fields=source.get("custom_fields"),
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
            self._run_single_job_inline(job, owner=owner)

    def _heartbeat(self, job: dict, owner: str, stop: threading.Event):
        while not stop.wait(15):
            if not self.queue.heartbeat(job["job_id"], owner, job["lease_generation"]):
                return

    def _publication_allowed(self) -> bool:
        helper_path = Path(
            os.environ.get(
                "OPENLIA_POLICY_HELPER",
                "/opt/data/skills/workspace-template-customization/scripts/workspace_registry.py",
            )
        )
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
            allowed_actions = (
                policy.get("delegation", {})
                .get("workspace", {})
                .get("allowed_actions", [])
            )
            return "capture" in allowed_actions or bool(
                helper.policy_allows(policy, "capture", "sources")
            )
        except Exception:
            return True

    def _update_failure(self, job: dict, code: str, message: str, status: str = "failed"):
        try:
            if not self._publication_allowed():
                return
            current_job = self.queue.get(job["job_id"])
            retrying = current_job.get("state") == "retryable-failure"
            intake_status = "processing" if retrying else status
            source_status = "processing" if retrying else status
            if job.get("intake_id"):
                try:
                    intake = self.publisher.load_intake(job["intake_id"])
                    intake["status"] = intake_status
                    intake["last_error"] = code
                    intake["retry_count"] = job.get("attempts", 0)
                    self.publisher.update_intake(intake)
                except PublicationError:
                    pass
            source = self.publisher.load_source(job["source_id"])
            source["status"] = source_status
            source.setdefault("processing", {})["status"] = source_status
            source["processing"]["error"] = message[:500]
            source["processing"]["error_code"] = code
            source["processing"]["error_summary"] = message[:500]
            source["processing"]["updated_at"] = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
            )
            self.publisher.update_source(source)
        except Exception:
            LOGGER.warning("could not update failed intake record", exc_info=True)

    def _status_loop(self):
        while not self.stop_event.is_set():
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


def _select_version(source: dict, version_id: str | None) -> dict | None:
    versions = source.get("versions") or []
    if version_id:
        selected = next(
            (version for version in versions if version.get("id") == version_id), None
        )
        if selected is None:
            raise KeyError(f"version not found: {version_id}")
        return selected
    return versions[-1] if versions else None
