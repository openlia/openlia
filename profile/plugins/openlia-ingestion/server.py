"""Standalone HTTP/REST sidecar server for the OpenLia Ingestion Vault."""

from __future__ import annotations

import base64
import email.parser
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import threading
import time
import types
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .adapters import AdapterError, process_job
from .db import IngestionQueue
from .passwords import PasswordProfileError, PasswordProfiles
from .publication import PublicationError, VaultStore
from .references import (
    annotate_deleted_backlinks,
    build_markdown_citation,
    build_source_uri,
    find_backlinks,
    parse_source_uri,
)


LOGGER = logging.getLogger("openlia.ingestion.server")
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _resolve_auth_token(explicit_token: str | None = None) -> str | None:
    if explicit_token is not None:
        return explicit_token.strip() or None
    token_file = (os.environ.get("OPENLIA_INGESTION_TOKEN_FILE") or "").strip()
    if token_file:
        try:
            return Path(token_file).expanduser().read_text(encoding="utf-8").strip() or None
        except OSError:
            pass
    env_token = (os.environ.get("OPENLIA_INGESTION_TOKEN") or "").strip()
    return env_token or None


class StandaloneLLMClient:
    """Zero-dependency OpenAI-compatible LLM client for standalone Ingestion OCR and tagging."""

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str | None = None,
        vision_model: str | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.vision_model = vision_model or model
        self.api_key = api_key

    @classmethod
    def from_env(cls) -> StandaloneLLMClient | None:
        base_url = (os.environ.get("OPENLIA_INGESTION_LLM_BASE_URL") or "").strip()
        model = (
            os.environ.get("OPENLIA_INGESTION_LLM_MODEL")
            or os.environ.get("OPENLIA_MODEL")
            or ""
        ).strip()
        if not base_url or not model:
            return None
        api_key = (
            os.environ.get("OPENLIA_INGESTION_LLM_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or ""
        ).strip() or None
        vision_model = (os.environ.get("OPENLIA_INGESTION_VISION_MODEL") or "").strip() or None
        return cls(base_url=base_url, model=model, api_key=api_key, vision_model=vision_model)

    def complete_structured(
        self,
        *,
        task: str,
        instructions: str,
        input: list[dict[str, Any]],
        json_schema: dict[str, Any],
        max_tokens: int = 2048,
        timeout: int = 120,
        purpose: str = "",
    ) -> Any:
        user_content: list[dict[str, Any]] = []
        has_image = False
        for item in input:
            if item.get("type") == "image" and isinstance(item.get("data"), (bytes, bytearray)):
                has_image = True
                mime_type = item.get("mime_type") or "image/png"
                b64 = base64.b64encode(bytes(item["data"])).decode("ascii")
                user_content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{b64}"},
                    }
                )
            elif item.get("type") == "text":
                user_content.append({"type": "text", "text": str(item.get("text") or "")})

        target_model = self.vision_model if has_image else self.model
        schema_prompt = (
            f"{instructions}\n\n"
            f"Respond ONLY with valid JSON matching this schema:\n{json.dumps(json_schema)}"
        )
        payload = {
            "model": target_model,
            "messages": [
                {"role": "system", "content": schema_prompt},
                {"role": "user", "content": user_content},
            ],
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        endpoint = (
            f"{self.base_url}/chat/completions"
            if self.base_url.endswith("/v1")
            else f"{self.base_url}/v1/chat/completions"
        )
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        try:
            from openlia_usage import record_response
            record_response(types.SimpleNamespace(model=body.get("model") or target_model,
                usage=body.get("usage")), provider="custom", reference=getattr(self,"_usage_reference", ""))
        except ImportError:
            pass
        raw_content = (
            body.get("choices", [{}])[0].get("message", {}).get("content") or "{}"
        ).strip()
        if raw_content.startswith("```"):
            raw_content = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_content, flags=re.DOTALL).strip()
        parsed = json.loads(raw_content)
        return types.SimpleNamespace(parsed=parsed)


def _select_version(source: dict, version_id: str | None) -> dict | None:
    versions = source.get("versions") or []
    if version_id:
        selected = next((version for version in versions if version.get("id") == version_id), None)
        if selected is None:
            raise KeyError(f"version not found: {version_id}")
        return selected
    return versions[-1] if versions else None


def extract_page_slice(
    extracted_text: str, page: int | None, max_chars: int = 50000
) -> str | None:
    limit = max(100, min(int(max_chars or 50000), 200000))
    if not extracted_text:
        return None
    if page is not None and page > 0:
        marker = f"## Page {page}"
        if marker in extracted_text:
            parts = extracted_text.split(marker, 1)
            if len(parts) > 1:
                remainder = parts[1].split("\n## Page ", 1)[0]
                return f"{marker}{remainder}".strip()[:limit]
        form_pages = extracted_text.split("\f")
        if 1 <= page <= len(form_pages):
            return form_pages[page - 1].strip()[:limit]
    return extracted_text[:limit]


def build_page_outline(extracted_text: str) -> tuple[int, list[dict[str, Any]]]:
    if not extracted_text or not extracted_text.strip():
        return 0, []
    page_matches = list(re.finditer(r"(?:^|\n)## Page (\d+)\s*\n", extracted_text))
    if page_matches:
        outline: list[dict[str, Any]] = []
        for idx, match in enumerate(page_matches):
            page_no = int(match.group(1))
            start = match.end()
            end = (
                page_matches[idx + 1].start()
                if idx + 1 < len(page_matches)
                else len(extracted_text)
            )
            chunk = extracted_text[start:end].strip()
            lines = [ln.strip() for ln in chunk.splitlines() if ln.strip()]
            preview = lines[0][:140] if lines else "(empty page)"
            outline.append({"page": page_no, "preview": preview, "chars": len(chunk)})
        return len(outline), outline
    form_pages = [p.strip() for p in extracted_text.split("\f") if p.strip()]
    if len(form_pages) > 1:
        outline = []
        for idx, chunk in enumerate(form_pages, start=1):
            lines = [ln.strip() for ln in chunk.splitlines() if ln.strip()]
            preview = lines[0][:140] if lines else "(empty page)"
            outline.append({"page": idx, "preview": preview, "chars": len(chunk)})
        return len(outline), outline
    lines = [ln.strip() for ln in extracted_text.splitlines() if ln.strip()]
    preview = lines[0][:140] if lines else "(empty)"
    return 1, [{"page": 1, "preview": preview, "chars": len(extracted_text)}]


class IngestionVaultService:
    """Core service logic shared by the standalone HTTP server and embedded runtime."""

    def __init__(
        self,
        ingestion_root: Path,
        workspace_root: Path | None = None,
        llm: Any = None,
        concurrency: int = 1,
    ):
        self.ingestion_root = ingestion_root.expanduser().resolve()
        self.workspace_root = workspace_root.expanduser().resolve() if workspace_root else None
        self.queue = IngestionQueue(self.ingestion_root)
        self.vault = VaultStore(
            self.ingestion_root, workspace_root=self.workspace_root, db=self.queue
        )
        self.passwords = PasswordProfiles(self.ingestion_root)
        self.llm = llm
        self.concurrency = max(1, min(int(concurrency or 1), 8))
        self.instance_id = uuid.uuid4().hex
        self.stop_event = threading.Event()
        self.threads: list[threading.Thread] = []

    def start_workers(self) -> None:
        self.queue.recover()
        self.publish_status()
        for index in range(self.concurrency):
            thread = threading.Thread(
                target=self._worker_loop,
                name=f"openlia-ingestion-sidecar-{index}",
                daemon=True,
            )
            self.threads.append(thread)
            thread.start()
        status_thread = threading.Thread(
            target=self._status_loop,
            name="openlia-ingestion-status",
            daemon=True,
        )
        self.threads.append(status_thread)
        status_thread.start()

    def stop_workers(self) -> None:
        self.stop_event.set()
        for thread in self.threads:
            thread.join(timeout=2)
        self.threads.clear()

    def _status_loop(self) -> None:
        while not self.stop_event.is_set():
            self.publish_status()
            self.stop_event.wait(2)

    def _worker_loop(self) -> None:
        owner = f"{os.getpid()}-{uuid.uuid4().hex}"
        while not self.stop_event.is_set():
            job = self.queue.claim(owner)
            if not job:
                self.stop_event.wait(0.5)
                continue
            self.run_claimed_job(job, owner)
            self.publish_status()

    def run_claimed_job(self, job: dict, owner: str) -> None:
        alive = threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat, args=(job, owner, alive), daemon=True
        )
        heartbeat.start()
        try:
            result = process_job(job, self.vault, self.passwords, self.llm, db=self.queue)
            result.setdefault("status", "completed")
            result.setdefault("continuation", job.get("continuation", {}))
            self.queue.finish(job, result)
        except AdapterError as exc:
            if exc.code in {"password_required", "password_invalid", "unlock_failed"}:
                self.queue.block_for_password(job, exc.code, str(exc))
                self.update_failure(job, exc.code, str(exc), status="awaiting-unlock")
            else:
                self.queue.fail(job, exc.code, str(exc), exc.retryable)
                self.update_failure(job, exc.code, str(exc))
        except (PublicationError, OSError, ValueError) as exc:
            self.queue.fail(job, "publication_failed", str(exc), True)
            self.update_failure(job, "publication_failed", str(exc))
        except Exception:
            LOGGER.exception("ingestion job failed")
            self.queue.fail(job, "internal_failure", "ingestion worker failed", True)
            self.update_failure(job, "internal_failure", "ingestion worker failed")
        finally:
            alive.set()
            heartbeat.join(timeout=1)

    def _heartbeat(self, job: dict, owner: str, stop: threading.Event) -> None:
        while not stop.wait(15):
            if not self.queue.heartbeat(job["job_id"], owner, job["lease_generation"]):
                return

    def update_failure(self, job: dict, code: str, message: str, status: str = "failed") -> None:
        try:
            current_job = self.queue.get(job["job_id"])
            if current_job.get("state") == "cancelled":
                return
            retrying = current_job.get("state") == "retryable-failure"
            intake_status = "processing" if retrying else status
            source_status = "processing" if retrying else status
            if job.get("intake_id"):
                try:
                    intake = self.vault.load_intake(job["intake_id"])
                    intake["status"] = intake_status
                    intake["last_error"] = code
                    intake["retry_count"] = job.get("attempts", 0)
                    self.vault.update_intake(intake)
                except PublicationError:
                    pass
            source = self.vault.load_source(job["source_id"])
            source["status"] = source_status
            source.setdefault("processing", {})
            source["processing"]["status"] = source_status
            source["processing"]["error"] = message[:500]
            source["processing"]["error_code"] = code
            source["processing"]["error_summary"] = message[:500]
            source["processing"]["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            self.vault.update_source(source)
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
                processing_status=source_status,
                lifecycle=source.get("lifecycle", "active"),
                custom_fields=source.get("custom_fields"),
            )
        except Exception:
            LOGGER.warning("could not update failed source record", exc_info=True)

    def publish_status(self) -> dict:
        self.ingestion_root.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema": 1,
            "generated_at": time.time(),
            "instance_id": self.instance_id,
            **self.queue.live_status(),
        }
        temporary = self.ingestion_root / f".status-{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("w", encoding="utf-8") as output:
                json.dump(payload, output, ensure_ascii=False, sort_keys=True)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.ingestion_root / "status.json")
        except Exception:
            try:
                temporary.unlink()
            except OSError:
                pass
        return payload

    def suggestions_for_source(self, source_id: str) -> list[dict]:
        try:
            source = self.vault.load_source(source_id)
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

    def wait_for_job(self, job_id: str, wait_seconds: float) -> dict:
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
                    self.run_claimed_job(claimed, owner)
                    self.publish_status()
                    continue
            if time.time() >= deadline:
                return self.queue.get(job_id)
            time.sleep(0.05)

    def enrich_job_response(self, base_response: dict, job: dict) -> dict:
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
            out["password_suggestions"] = self.suggestions_for_source(str(source_id))
        elif job["state"] in {"completed", "partial"} and source_id:
            try:
                source = self.vault.load_source(str(source_id))
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

    def status_payload(
        self,
        *,
        job_id: str | None = None,
        intake_id: str | None = None,
        source_id: str | None = None,
    ) -> dict:
        if job_id:
            job = self.queue.get(job_id)
        elif intake_id:
            job = self.queue.get_by_intake(intake_id)
        elif source_id:
            job = self.queue.get_by_source(source_id)
        else:
            return {"ok": True, **self.queue.live_status()}

        payload: dict[str, Any] = {
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
            payload["password_suggestions"] = self.suggestions_for_source(job["source_id"])
        return payload

    def capture_and_enqueue(self, request: dict) -> dict:
        req = dict(request)
        continuation = dict(req.get("continuation") or {})
        continuation.setdefault("next_action", req.get("next_action") or "triage")
        continuation.setdefault("request_ref", req.get("request_ref"))
        req["continuation"] = continuation

        auto_selected_profile: str | None = None
        if req.get("auto_unlock") and not req.get("password_profile"):
            candidate_filename = req.get("filename")
            if not candidate_filename and req.get("file_path"):
                candidate_filename = Path(str(req["file_path"])).name
            suggestions = self.passwords.suggest(
                filename=str(candidate_filename or ""),
                title=str(req.get("title") or ""),
                correspondent=str(req.get("correspondent") or ""),
                message=str(req.get("request_ref") or ""),
            )
            if suggestions and suggestions[0]["score"] >= 70:
                auto_selected_profile = suggestions[0]["profile_id"]
                req["password_profile"] = auto_selected_profile

        if req.get("password_profile") and isinstance(req.get("content"), str):
            password = self.passwords.resolve(str(req["password_profile"]))
            req["content"] = req["content"].replace(
                password,
                f"[document password redacted; stored in profile {req['password_profile']}]",
            )
        elif req.get("password_profile"):
            self.passwords.resolve(str(req["password_profile"]))

        outputs = req.get("requested_outputs") or ["text"]
        idempotency = self._idempotency_key(req, outputs)
        wait_seconds = float(req.get("wait_seconds") or 0)
        existing = self.queue.get_by_idempotency(idempotency)
        if existing:
            source = self.queue.get_source(existing["source_id"]) or {}
            base_dup = {
                "ok": True,
                "schema": 1,
                "job_id": existing["job_id"],
                "intake_id": existing["intake_id"],
                "source_id": existing["source_id"],
                "version_id": existing.get("version_id"),
                "title": source.get("title") or req.get("title") or "Untitled source",
                "state": existing["state"],
                "durably_retained": True,
                "duplicate": True,
            }
            if wait_seconds > 0:
                waited = self.wait_for_job(existing["job_id"], wait_seconds)
                return self.enrich_job_response(base_dup, waited)
            return base_dup

        captured = self.vault.capture(req)
        source = captured["source"]
        intake = captured["intake"]
        job = self.queue.submit(
            {
                "idempotency_key": idempotency,
                "intake_id": intake["intake_id"],
                "source_id": source["id"],
                "version_id": intake["version_id"],
                "operation": req.get("operation", "extract"),
                "requested_outputs": outputs,
                "password_profile": req.get("password_profile"),
                "continuation": continuation,
            }
        )
        intake["job_id"] = job["job_id"]
        intake["status"] = "queued"
        self.vault.update_intake(intake)
        source.setdefault("processing", {})
        source["processing"]["status"] = "queued"
        source["processing"]["last_job_id"] = job["job_id"]
        self.vault.update_source(source)
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
        response: dict[str, Any] = {
            "ok": True,
            "schema": 1,
            "job_id": job["job_id"],
            "intake_id": intake["intake_id"],
            "source_id": source["id"],
            "version_id": intake["version_id"],
            "title": source["title"],
            "state": job["state"],
            "durably_retained": True,
        }
        if captured.get("replaced_existing"):
            response["replaced_existing"] = True
            response["purged_previous_versions"] = bool(captured.get("purged_previous_versions"))
            response["stale_backlinks"] = (
                find_backlinks(self.workspace_root, source["id"])
                if self.workspace_root and self.workspace_root.exists()
                else []
            )
        if auto_selected_profile:
            response["auto_selected_password_profile"] = auto_selected_profile
        if wait_seconds > 0:
            waited = self.wait_for_job(job["job_id"], wait_seconds)
            return self.enrich_job_response(response, waited)
        return response

    def _idempotency_key(self, request: dict, outputs: list[str]) -> str:
        payload = request.get("content")
        if isinstance(request.get("data"), (bytes, bytearray)):
            payload = hashlib.sha256(bytes(request["data"])).hexdigest()
        elif isinstance(request.get("data_base64"), str) and request.get("data_base64"):
            payload = hashlib.sha256(base64.b64decode(request["data_base64"])).hexdigest()
        elif request.get("file_path"):
            path = Path(str(request["file_path"])).expanduser()
            payload = hashlib.sha256(path.read_bytes()).hexdigest()
        material = {
            "kind": request.get("kind"),
            "source_id": request.get("source_id"),
            "purge_previous_versions": bool(request.get("purge_previous_versions")),
            "payload": payload,
            "url": request.get("url"),
            "operation": request.get("operation", "extract"),
            "outputs": outputs,
            "password_profile": request.get("password_profile"),
            "continuation": request.get("continuation") or {},
        }
        return hashlib.sha256(
            json.dumps(material, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()

    def get_document_payload(
        self,
        raw_id: str,
        *,
        version_id: str | None = None,
        page: int | None = None,
        include_content: bool = True,
        max_chars: int = 50000,
    ) -> dict:
        parsed = parse_source_uri(raw_id)
        source_id = parsed["source_id"] if parsed else raw_id.strip()
        resolved_page = page if page is not None else (parsed["page"] if parsed else None)
        resolved_version = version_id or (parsed.get("version_id") if parsed else None)

        source = self.vault.load_source(source_id)
        extracted_text = ""
        extractions = []
        selected_version = _select_version(source, resolved_version)
        if selected_version:
            ver_id = selected_version.get("id")
            for ext in reversed(selected_version.get("extractions", [])):
                ext_dir = self.vault.blobs / source_id / ver_id / "extractions" / ext
                extractions.append(
                    {
                        "extraction_id": ext,
                        "version_id": ver_id,
                        "path": f"blobs/{source_id}/{ver_id}/extractions/{ext}",
                    }
                )
                for candidate_name in ["text.md", "transcript.md", "tables.json"]:
                    candidate = ext_dir / candidate_name
                    if candidate.exists() and not extracted_text:
                        extracted_text = candidate.read_text(encoding="utf-8", errors="ignore")

        page_count, page_outline = build_page_outline(extracted_text)
        content = (
            extract_page_slice(extracted_text, resolved_page, max_chars=max_chars)
            if include_content
            else None
        )
        backlinks = (
            find_backlinks(self.workspace_root, source_id)
            if self.workspace_root and self.workspace_root.exists()
            else []
        )
        versions_list = source.get("versions") or []
        latest_ver_id = versions_list[-1].get("id") if versions_list else None
        stale_backlinks = [
            b
            for b in backlinks
            if b.get("pinned_version_id") and b.get("pinned_version_id") != latest_ver_id
        ]
        canonical_uri = build_source_uri(source_id, resolved_version, resolved_page)
        markdown_citation = build_markdown_citation(
            source, version_id=resolved_version, page=resolved_page
        )
        doc_response = {
            **source,
            "content": content,
            "page": resolved_page,
            "page_count": page_count,
            "page_outline": page_outline,
            "canonical_uri": canonical_uri,
            "markdown_citation": markdown_citation,
            "backlinks": backlinks,
            "stale_backlinks": stale_backlinks,
            "extractions": extractions,
        }
        return {
            "ok": True,
            "source": doc_response,
            "document": doc_response,
            "content": content,
            "page": resolved_page,
            "page_count": page_count,
            "page_outline": page_outline,
            "canonical_uri": canonical_uri,
            "markdown_citation": markdown_citation,
            "backlinks": backlinks,
            "stale_backlinks": stale_backlinks,
        }

    def delete_document(self, source_id: str, *, annotate_backlinks: bool = True) -> dict:
        parsed = parse_source_uri(source_id)
        clean_id = parsed["source_id"] if parsed else source_id.strip()
        # Verify source exists first
        self.vault.load_source(clean_id)
        backlinks = (
            find_backlinks(self.workspace_root, clean_id)
            if self.workspace_root and self.workspace_root.exists()
            else []
        )
        annotated_files = (
            annotate_deleted_backlinks(self.workspace_root, clean_id)
            if annotate_backlinks and self.workspace_root and self.workspace_root.exists()
            else []
        )
        cascade = self.vault.delete_source(clean_id)
        self.publish_status()
        return {
            "ok": True,
            "source_id": clean_id,
            "deleted": True,
            "backlinks": backlinks,
            "annotated_files": annotated_files,
            "cascade": cascade,
        }

    def update_document_payload(self, source_id: str, updates: dict) -> dict:
        source = self.vault.load_source(source_id)
        for field in [
            "title",
            "correspondent",
            "document_type",
            "document_date",
            "summary",
            "lifecycle",
            "password_profile",
        ]:
            if field in updates and updates[field] is not None:
                source[field] = updates[field]
        if "tags" in updates and isinstance(updates["tags"], list):
            source["tags"] = [str(t).strip().lower() for t in updates["tags"] if str(t).strip()]
        if "add_tags" in updates or "remove_tags" in updates:
            current_tags = list(source.get("tags") or [])
            add_tags = [
                str(t).strip().lower()
                for t in (updates.get("add_tags") or [])
                if str(t).strip()
            ]
            remove_tags = {
                str(t).strip().lower()
                for t in (updates.get("remove_tags") or [])
                if str(t).strip()
            }
            for t in add_tags:
                if t not in current_tags:
                    current_tags.append(t)
            source["tags"] = [t for t in current_tags if t not in remove_tags]
        if "custom_fields" in updates and isinstance(updates["custom_fields"], dict):
            merged_cf = dict(source.get("custom_fields") or {})
            for k, v in updates["custom_fields"].items():
                if v is None or v == "":
                    merged_cf.pop(str(k), None)
                else:
                    merged_cf[str(k)] = v
            source["custom_fields"] = merged_cf
        if "review" in updates and isinstance(updates["review"], dict):
            source.setdefault("review", {"status": "unreviewed", "reasons": []})
            if "status" in updates["review"]:
                source["review"]["status"] = updates["review"]["status"]
            if "reasons" in updates["review"]:
                source["review"]["reasons"] = updates["review"]["reasons"]
            if source["review"]["status"] == "reviewed":
                source["review"]["reviewed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if "review_status" in updates and updates["review_status"]:
            source.setdefault("review", {"status": "unreviewed", "reasons": []})
            source["review"]["status"] = updates["review_status"]
            if updates["review_status"] == "reviewed":
                source["review"]["reviewed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if "review_reasons" in updates and isinstance(updates["review_reasons"], list):
            source.setdefault("review", {"status": "unreviewed", "reasons": []})
            source["review"]["reasons"] = updates["review_reasons"]

        self.vault.update_source(source)
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
        return {
            "ok": True,
            "source_id": source_id,
            "updated": True,
            "tags": source.get("tags") or [],
            "document": source,
        }

    def retry_source_or_intake(
        self,
        *,
        source_id: str | None = None,
        intake_id: str | None = None,
        password_profile: str | None = None,
        wait_seconds: float = 0,
    ) -> dict:
        if password_profile:
            self.passwords.resolve(password_profile)
        job = None
        if intake_id:
            job = self.queue.get_by_intake(intake_id)
        elif source_id:
            job = self.queue.get_by_source(source_id)
        if not job:
            raise KeyError("job not found")

        updated_job = self.queue.requeue_job(job["job_id"], password_profile=password_profile)
        resolved_source_id = updated_job["source_id"]
        try:
            source = self.vault.load_source(resolved_source_id)
            if password_profile:
                source["password_profile"] = password_profile
            source["status"] = "queued"
            source.setdefault("processing", {})
            source["processing"]["status"] = "queued"
            source["processing"]["error"] = None
            source["processing"]["error_code"] = None
            source["processing"]["error_summary"] = None
            source["processing"]["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            self.vault.update_source(source)
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
        except PublicationError:
            pass
        if updated_job.get("intake_id"):
            try:
                intake = self.vault.load_intake(updated_job["intake_id"])
                intake["status"] = "queued"
                intake["last_error"] = None
                self.vault.update_intake(intake)
            except PublicationError:
                pass
        base_res = {
            "ok": True,
            "job_id": updated_job["job_id"],
            "intake_id": updated_job.get("intake_id"),
            "source_id": resolved_source_id,
            "state": "queued",
        }
        if wait_seconds and float(wait_seconds) > 0:
            waited = self.wait_for_job(updated_job["job_id"], float(wait_seconds))
            return self.enrich_job_response(base_res, waited)
        return base_res

    def recover_vault(self) -> dict:
        reclaimed = self.queue.recover()
        requeued = []
        for intake in self.vault.list_intakes():
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
            self.vault.update_intake(intake)
            requeued.append(intake["intake_id"])
        return {
            "ok": True,
            "reclaimed_jobs": reclaimed,
            "requeued_intakes": requeued,
            "message": "Ingestion Vault records remain the recovery source of truth.",
        }

    def rebuild_fts(self) -> dict:
        sources = self.vault.list_sources()
        indexed = 0
        for source in sources:
            source_id = source.get("id")
            if not source_id:
                continue
            doc = self.get_document_payload(source_id, include_content=True)
            self.queue.upsert_source_fts(
                source_id=source_id,
                title=source.get("title"),
                correspondent=source.get("correspondent"),
                document_type=source.get("document_type"),
                tags=source.get("tags"),
                summary=source.get("summary"),
                content=doc.get("content") or "",
                document_date=source.get("document_date"),
                review_status=source.get("review", {}).get("status", "unreviewed"),
                processing_status=source.get("processing", {}).get("status", "complete"),
                lifecycle=source.get("lifecycle", "active"),
                custom_fields=source.get("custom_fields"),
            )
            indexed += 1
        return {"ok": True, "indexed": indexed}

    def cancel_source(self, source_id: str, reason: str = "cancelled_by_user") -> dict:
        return self.vault.cancel_processing(source_id, reason=reason)


def _parse_multipart(content_type: str, body: bytes) -> dict:
    raw_headers = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    msg = email.parser.BytesParser().parsebytes(raw_headers + body)
    result: dict[str, Any] = {}
    if not msg.is_multipart():
        return result
    for part in msg.iter_parts():
        disposition = part.get("Content-Disposition", "")
        name_match = re.search(r'name="([^"]+)"', disposition)
        if not name_match:
            continue
        field_name = name_match.group(1)
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename or field_name in {"file", "files"}:
            result["data"] = payload
            result["filename"] = filename or "upload.bin"
            result["media_type"] = part.get_content_type()
        else:
            text_val = payload.decode("utf-8", errors="replace")
            if field_name in {"purge_previous_versions", "auto_unlock"}:
                result[field_name] = text_val.strip().lower() in {"1", "true", "yes"}
            else:
                result[field_name] = text_val
    return result


class _SidecarHTTPHandler(BaseHTTPRequestHandler):
    server_version = "OpenLiaIngestion/2.0"

    @property
    def service(self) -> IngestionVaultService:
        return self.server.service  # type: ignore[attr-defined]

    @property
    def auth_token(self) -> str | None:
        return getattr(self.server, "auth_token", None)

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.debug(format, *args)

    def _check_auth(self) -> bool:
        expected = self.auth_token
        if not expected:
            return True
        auth_header = (self.headers.get("Authorization") or "").strip()
        if auth_header.startswith("Bearer "):
            provided = auth_header[len("Bearer ") :].strip()
            if hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
                return True
        self._send_json(
            HTTPStatus.UNAUTHORIZED,
            {"ok": False, "error": "unauthorized", "message": "valid Bearer token required"},
        )
        return False

    def _send_json(self, status: int, payload: dict) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _stream_blob(
        self, blob_path: Path, media_type: str | None = None, filename: str | None = None
    ) -> None:
        if not blob_path.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "blob_not_found"})
            return
        total_size = blob_path.stat().st_size
        resolved_type = (
            media_type or mimetypes.guess_type(blob_path.name)[0] or "application/octet-stream"
        )
        range_header = self.headers.get("Range")
        if range_header:
            match = RANGE_RE.match(range_header.strip())
            if match:
                start_str, end_str = match.groups()
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else total_size - 1
                if start >= total_size or start > end:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{total_size}")
                    self.end_headers()
                    return
                end = min(end, total_size - 1)
                with blob_path.open("rb") as handle:
                    handle.seek(start)
                    chunk = handle.read(end - start + 1)
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Type", resolved_type)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", f"bytes {start}-{end}/{total_size}")
                self.send_header("Content-Length", str(len(chunk)))
                if filename:
                    self.send_header("Content-Disposition", f'inline; filename="{filename}"')
                self.end_headers()
                self.wfile.write(chunk)
                return

        data = blob_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", resolved_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition", f'inline; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(parsed.query)

        try:
            if path == "/health":
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "service": "openlia-ingestion",
                        "status": self.service.queue.live_status(),
                    },
                )
                return

            if not self._check_auth():
                return

            if path == "/v1/status":
                job_id = (query.get("job_id") or [None])[0]
                intake_id = (query.get("intake_id") or [None])[0]
                source_id = (query.get("source_id") or [None])[0]
                if job_id or intake_id or source_id:
                    self._send_json(
                        HTTPStatus.OK,
                        self.service.status_payload(
                            job_id=job_id, intake_id=intake_id, source_id=source_id
                        ),
                    )
                else:
                    self._send_json(HTTPStatus.OK, {"ok": True, **self.service.publish_status()})
                return

            if path == "/v1/jobs":
                self._send_json(HTTPStatus.OK, {"ok": True, **self.service.publish_status()})
                return

            if path.startswith("/v1/jobs/"):
                job_id = path.split("/v1/jobs/", 1)[1]
                job = self.service.queue.get(job_id)
                self._send_json(HTTPStatus.OK, {"ok": True, "job": job})
                return

            if path == "/v1/passwords":
                self._send_json(
                    HTTPStatus.OK,
                    {"ok": True, "profiles": self.service.passwords.list()},
                )
                return

            if path == "/v1/passwords/suggest":
                suggestions = self.service.passwords.suggest(
                    filename=(query.get("filename") or [None])[0],
                    title=(query.get("title") or [None])[0],
                    correspondent=(query.get("correspondent") or [None])[0],
                    message=(query.get("message") or [None])[0],
                )
                self._send_json(HTTPStatus.OK, {"ok": True, "suggestions": suggestions})
                return

            if path == "/v1/sources/search":
                q = (query.get("q") or query.get("query") or [None])[0]
                tags_raw = (query.get("tags") or [None])[0]
                tags = (
                    [t.strip() for t in tags_raw.split(",") if t.strip()] if tags_raw else None
                )
                res = self.service.queue.search_sources(
                    query=q,
                    tags=tags,
                    correspondent=(query.get("correspondent") or [None])[0],
                    document_type=(query.get("document_type") or [None])[0],
                    review_status=(query.get("review_status") or [None])[0],
                    processing_status=(query.get("processing_status") or [None])[0],
                    lifecycle=(query.get("lifecycle") or [None])[0],
                    date_from=(query.get("date_from") or [None])[0],
                    date_to=(query.get("date_to") or [None])[0],
                    offset=int((query.get("offset") or ["0"])[0]),
                    limit=min(int((query.get("limit") or ["20"])[0]), 100),
                )
                for item in res["matches"]:
                    item["canonical_uri"] = build_source_uri(item["source_id"])
                    item["markdown_citation"] = build_markdown_citation(item)
                self._send_json(HTTPStatus.OK, {"ok": True, "schema": 1, **res})
                return

            raw_match = re.match(
                r"^/v1/sources/([A-Za-z0-9._-]+)/(?:raw|blobs/([A-Za-z0-9._-]+)/original)$",
                path,
            )
            if raw_match:
                source_id = raw_match.group(1)
                version_id = raw_match.group(2) or (query.get("version_id") or [None])[0]
                source = self.service.vault.load_source(source_id)
                ver = _select_version(source, version_id)
                if not ver or not ver.get("original_ref"):
                    self._send_json(
                        HTTPStatus.NOT_FOUND, {"ok": False, "error": "original_not_found"}
                    )
                    return
                blob_path = self.service.vault.resolve_blob_path(str(ver["original_ref"]))
                self._stream_blob(
                    blob_path,
                    media_type=ver.get("media_type"),
                    filename=ver.get("filename") or blob_path.name,
                )
                return

            if path.startswith("/v1/sources/"):
                source_id = urllib.parse.unquote(path.split("/v1/sources/", 1)[1])
                page_val = (query.get("page") or [None])[0]
                max_chars_val = (query.get("max_chars") or [None])[0]
                version_val = (query.get("version_id") or [None])[0]
                include_content = (
                    (query.get("include_content") or ["true"])[0].lower() != "false"
                )
                payload = self.service.get_document_payload(
                    source_id,
                    version_id=version_val,
                    page=int(page_val) if page_val else None,
                    include_content=include_content,
                    max_chars=int(max_chars_val) if max_chars_val else 50000,
                )
                self._send_json(HTTPStatus.OK, payload)
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
        except (KeyError, PublicationError) as exc:
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"ok": False, "error": "not_found", "error_code": "not_found", "message": str(exc)},
            )
        except Exception as exc:
            LOGGER.exception("GET error")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "server_error", "message": str(exc)},
            )

    def do_POST(self) -> None:
        if not self._check_auth():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        body = self._read_body()
        content_type = self.headers.get("Content-Type") or "application/json"

        try:
            version_upload_match = re.match(r"^/v1/sources/([A-Za-z0-9._-]+)/versions$", path)
            if path == "/v1/sources/upload" or version_upload_match:
                if "multipart/form-data" in content_type:
                    req = _parse_multipart(content_type, body)
                else:
                    req = json.loads(body.decode("utf-8") or "{}")
                if version_upload_match:
                    req["source_id"] = version_upload_match.group(1)
                if not req.get("kind"):
                    ext = Path(str(req.get("filename") or "")).suffix.lower()
                    if ext == ".pdf":
                        req["kind"] = "pdf"
                    elif ext in {".xlsx", ".xls"}:
                        req["kind"] = "excel"
                    elif ext in {".csv", ".tsv", ".tab"}:
                        req["kind"] = "csv"
                    elif ext in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}:
                        req["kind"] = "image"
                    elif req.get("content") is not None or ext in {
                        ".txt",
                        ".md",
                        ".json",
                        ".log",
                        ".yaml",
                        ".yml",
                        ".vtt",
                        ".srt",
                        ".xml",
                        ".html",
                        ".htm",
                        ".toml",
                        ".ini",
                        ".cfg",
                        ".conf",
                        ".sql",
                        ".sh",
                        ".py",
                        ".js",
                        ".ts",
                    }:
                        req["kind"] = "text"
                    else:
                        req["kind"] = "file"
                res = self.service.capture_and_enqueue(req)
                self._send_json(HTTPStatus.OK, res)
                return

            if path == "/v1/passwords":
                req = json.loads(body.decode("utf-8") or "{}")
                raw_pw = req.get("password")
                saved = self.service.passwords.save(
                    str(req.get("profile_id") or ""),
                    str(req.get("label") or ""),
                    str(raw_pw) if raw_pw is not None and str(raw_pw) != "" else None,
                    description=req.get("description"),
                    hint=req.get("hint"),
                    patterns=req.get("patterns"),
                )
                self._send_json(HTTPStatus.OK, {"ok": True, **saved})
                return

            if path == "/v1/passwords/suggest":
                req = json.loads(body.decode("utf-8") or "{}") if body else {}
                suggestions = self.service.passwords.suggest(
                    filename=req.get("filename"),
                    title=req.get("title"),
                    correspondent=req.get("correspondent"),
                    message=req.get("message"),
                )
                self._send_json(HTTPStatus.OK, {"ok": True, "suggestions": suggestions})
                return

            if path == "/v1/rebuild-fts":
                self._send_json(HTTPStatus.OK, self.service.rebuild_fts())
                return

            if path == "/v1/recover":
                self._send_json(HTTPStatus.OK, self.service.recover_vault())
                return

            retry_match = re.match(r"^/v1/sources/([A-Za-z0-9._-]+)/retry$", path)
            if retry_match:
                target_id = retry_match.group(1)
                req = json.loads(body.decode("utf-8") or "{}") if body else {}
                profile_id = req.get("password_profile") or req.get("profile_id")
                if req.get("password") and profile_id:
                    self.service.passwords.save(
                        str(profile_id),
                        str(req.get("label") or f"Document unlock ({profile_id})"),
                        str(req["password"]),
                        description=req.get("description"),
                        hint=req.get("hint"),
                        patterns=req.get("patterns"),
                    )
                res = self.service.retry_source_or_intake(
                    source_id=target_id if not target_id.startswith("intake_") else None,
                    intake_id=target_id if target_id.startswith("intake_") else req.get("intake_id"),
                    password_profile=profile_id,
                    wait_seconds=float(req.get("wait_seconds") or 0),
                )
                self._send_json(HTTPStatus.OK, res)
                return

            cancel_match = re.match(r"^/v1/sources/([A-Za-z0-9._-]+)/cancel$", path)
            if cancel_match:
                target_id = cancel_match.group(1)
                req = json.loads(body.decode("utf-8") or "{}") if body else {}
                reason = str(req.get("reason") or "cancelled_by_user")
                res = self.service.cancel_source(target_id, reason=reason)
                self._send_json(HTTPStatus.OK, res)
                return

            cancel_job_match = re.match(r"^/v1/jobs/([A-Za-z0-9._-]+)/cancel$", path)
            if cancel_job_match:
                target_job_id = cancel_job_match.group(1)
                job = self.service.queue.get(target_job_id)
                res = self.service.cancel_source(job["source_id"])
                self._send_json(HTTPStatus.OK, res)
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
        except (PasswordProfileError, PublicationError, ValueError) as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "bad_request", "message": str(exc)},
            )
        except KeyError as exc:
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"ok": False, "error": "not_found", "message": str(exc)},
            )
        except Exception as exc:
            LOGGER.exception("POST error")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "server_error", "message": str(exc)},
            )

    def do_PATCH(self) -> None:
        if not self._check_auth():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        body = self._read_body()
        try:
            if path.startswith("/v1/sources/"):
                source_id = path.split("/v1/sources/", 1)[1]
                updates = json.loads(body.decode("utf-8") or "{}")
                res = self.service.update_document_payload(source_id, updates)
                self._send_json(HTTPStatus.OK, res)
                return
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
        except (KeyError, PublicationError) as exc:
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"ok": False, "error": "not_found", "message": str(exc)},
            )
        except Exception as exc:
            LOGGER.exception("PATCH error")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "server_error", "message": str(exc)},
            )

    def do_DELETE(self) -> None:
        if not self._check_auth():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(parsed.query)
        body = self._read_body()
        try:
            if path.startswith("/v1/passwords/"):
                profile_id = urllib.parse.unquote(path.split("/v1/passwords/", 1)[1])
                deleted = self.service.passwords.delete(profile_id)
                if not deleted:
                    self._send_json(
                        HTTPStatus.NOT_FOUND,
                        {"ok": False, "error": "not_found", "message": "password profile not found"},
                    )
                    return
                self._send_json(
                    HTTPStatus.OK,
                    {"ok": True, "profile_id": profile_id, "deleted": True},
                )
                return

            if path.startswith("/v1/sources/"):
                source_id = urllib.parse.unquote(path.split("/v1/sources/", 1)[1])
                annotate_param = (query.get("annotate_backlinks") or [None])[0]
                annotate_backlinks = True
                if annotate_param is not None:
                    annotate_backlinks = annotate_param.strip().lower() not in {"0", "false", "no"}
                elif body:
                    try:
                        parsed_body = json.loads(body.decode("utf-8"))
                        if isinstance(parsed_body, dict) and "annotate_backlinks" in parsed_body:
                            annotate_backlinks = bool(parsed_body["annotate_backlinks"])
                    except Exception:
                        pass
                res = self.service.delete_document(
                    source_id, annotate_backlinks=annotate_backlinks
                )
                self._send_json(HTTPStatus.OK, res)
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
        except (KeyError, PublicationError) as exc:
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"ok": False, "error": "not_found", "error_code": "not_found", "message": str(exc)},
            )
        except PasswordProfileError as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "bad_request", "message": str(exc)},
            )
        except Exception as exc:
            LOGGER.exception("DELETE error")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "server_error", "message": str(exc)},
            )


class IngestionSidecarServer:
    """Lifecycle wrapper around ThreadingHTTPServer + IngestionVaultService."""

    def __init__(
        self,
        ingestion_root: Path,
        workspace_root: Path | None = None,
        *,
        host: str = "127.0.0.1",
        port: int = 8933,
        llm: Any = None,
        concurrency: int = 1,
        start_workers: bool = True,
        auth_token: str | None = None,
    ):
        resolved_llm = llm if llm is not None else StandaloneLLMClient.from_env()
        self.service = IngestionVaultService(
            ingestion_root=ingestion_root,
            workspace_root=workspace_root,
            llm=resolved_llm,
            concurrency=concurrency,
        )
        self.start_workers = start_workers
        self.auth_token = _resolve_auth_token(auth_token)
        self.httpd = ThreadingHTTPServer((host, port), _SidecarHTTPHandler)
        self.httpd.service = self.service  # type: ignore[attr-defined]
        self.httpd.auth_token = self.auth_token  # type: ignore[attr-defined]
        self.host, self.port = self.httpd.server_address[:2]
        self.base_url = f"http://{self.host}:{self.port}"
        self._thread: threading.Thread | None = None

    def start(self) -> str:
        if self.start_workers:
            self.service.start_workers()
        self._thread = threading.Thread(
            target=self.httpd.serve_forever,
            name="openlia-ingestion-http",
            daemon=True,
        )
        self._thread.start()
        return self.base_url

    def stop(self) -> None:
        self.service.stop_workers()
        self.httpd.shutdown()
        self.httpd.server_close()
        if self._thread:
            self._thread.join(timeout=2)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    ingestion_root = Path(
        os.environ.get("OPENLIA_INGESTION_ROOT")
        or (Path(os.environ.get("HERMES_HOME", "/opt/data")).expanduser() / "ingestion")
    )
    workspace_root = Path(os.environ.get("OPENLIA_WORKSPACE_ROOT", "/opt/data/workspace")).expanduser()
    host = os.environ.get("OPENLIA_INGESTION_BIND", "0.0.0.0")
    port = int(os.environ.get("OPENLIA_INGESTION_PORT", "8933"))
    concurrency = int(os.environ.get("OPENLIA_INGESTION_CONCURRENCY", "2"))

    sidecar = IngestionSidecarServer(
        ingestion_root=ingestion_root,
        workspace_root=workspace_root,
        host=host,
        port=port,
        concurrency=concurrency,
        start_workers=True,
    )
    LOGGER.info("OpenLia Ingestion Sidecar listening on http://%s:%d", host, port)
    try:
        sidecar.httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        sidecar.stop()


if __name__ == "__main__":
    main()
