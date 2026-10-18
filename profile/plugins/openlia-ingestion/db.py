"""Unified SQLite WAL Vault & Job Queue for OpenLia Ingestion."""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOGGER = logging.getLogger("openlia.ingestion.db")
LEASE_SECONDS = 90
MAX_ATTEMPTS = 4


def now() -> float:
    return time.time()


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def sanitize_fts_query(query: str) -> str:
    """Sanitize free text into a safe SQLite FTS5 query with prefix matching."""
    tokens = re.findall(r"[A-Za-z0-9_\-\u00C0-\u024F\u1EA0-\u1EF9]+", query)
    if not tokens:
        return ""
    terms = []
    for token in tokens:
        clean = token.strip("-")
        if clean:
            terms.append(f'"{clean}"*')
    return " AND ".join(terms)


def resolve_db_path(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    legacy_path = root / "queue.sqlite"
    vault_path = root / "vault.sqlite"
    if legacy_path.exists() and not vault_path.exists():
        return legacy_path
    return vault_path


class IngestionQueue:
    """Unified SQLite store for sources, versions, extractions, intakes, jobs, and FTS5."""

    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.path = resolve_db_path(self.root)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    @contextmanager
    def _database(self):
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._database() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS sources (
                    source_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    document_type TEXT,
                    correspondent TEXT,
                    document_date TEXT,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    summary TEXT,
                    custom_fields_json TEXT NOT NULL DEFAULT '{}',
                    processing_status TEXT NOT NULL DEFAULT 'captured',
                    last_job_id TEXT,
                    processing_error_code TEXT,
                    processing_error_summary TEXT,
                    review_status TEXT NOT NULL DEFAULT 'unreviewed',
                    review_reasons_json TEXT NOT NULL DEFAULT '[]',
                    reviewed_at TEXT,
                    lifecycle TEXT NOT NULL DEFAULT 'active',
                    sensitivity TEXT NOT NULL DEFAULT 'personal',
                    origin_json TEXT NOT NULL DEFAULT '{}',
                    password_profile TEXT,
                    record_json TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sources_captured ON sources(captured_at DESC);

                CREATE TABLE IF NOT EXISTS source_versions (
                    source_id TEXT NOT NULL,
                    version_id TEXT NOT NULL,
                    original_artifact_id TEXT,
                    filename TEXT,
                    content_sha256 TEXT,
                    media_type TEXT,
                    size_bytes INTEGER,
                    blob_relpath TEXT,
                    received_at TEXT,
                    PRIMARY KEY (source_id, version_id)
                );

                CREATE TABLE IF NOT EXISTS extractions (
                    extraction_id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    version_id TEXT NOT NULL,
                    artifact_id TEXT,
                    role TEXT NOT NULL,
                    media_type TEXT,
                    blob_relpath TEXT,
                    manifest_relpath TEXT,
                    content_text TEXT,
                    coverage_json TEXT NOT NULL DEFAULT '{}',
                    warnings_json TEXT NOT NULL DEFAULT '[]',
                    complete INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS extractions_source ON extractions(source_id, version_id);

                CREATE TABLE IF NOT EXISTS intakes (
                    intake_id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    version_id TEXT,
                    kind TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    status TEXT NOT NULL,
                    job_id TEXT,
                    last_error TEXT,
                    record_json TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS intakes_source ON intakes(source_id);
                CREATE INDEX IF NOT EXISTS intakes_captured ON intakes(captured_at DESC);

                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    intake_id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    version_id TEXT,
                    operation TEXT NOT NULL,
                    requested_outputs TEXT NOT NULL,
                    password_profile TEXT,
                    continuation TEXT NOT NULL,
                    state TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    lease_owner TEXT,
                    lease_generation INTEGER NOT NULL DEFAULT 0,
                    lease_expires_at REAL,
                    heartbeat_at REAL,
                    next_attempt_at REAL,
                    error_code TEXT,
                    error_summary TEXT,
                    result TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, next_attempt_at);
                CREATE INDEX IF NOT EXISTS jobs_source ON jobs(source_id);

                CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
                    source_id UNINDEXED,
                    title,
                    correspondent,
                    document_type,
                    tags,
                    summary,
                    content,
                    document_date UNINDEXED,
                    review_status UNINDEXED,
                    processing_status UNINDEXED,
                    lifecycle UNINDEXED,
                    tokenize = 'porter unicode61'
                );
                """
            )
            columns = {
                row["name"]
                for row in db.execute("PRAGMA table_info(jobs)").fetchall()
            }
            if "lease_generation" not in columns:
                db.execute(
                    "ALTER TABLE jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0"
                )
            if "intake_id" not in columns:
                db.execute(
                    "ALTER TABLE jobs ADD COLUMN intake_id TEXT NOT NULL DEFAULT ''"
                )

    # -------------------------------------------------------------------------
    # Vault Entities (Sources, Versions, Extractions, Intakes)
    # -------------------------------------------------------------------------

    def save_source(self, source: dict) -> None:
        source_id = str(source["id"])
        updated_at = iso_now()
        processing = source.get("processing") or {}
        review = source.get("review") or {}
        tags = source.get("tags") or []
        custom_fields = source.get("custom_fields") or {}
        origin = source.get("origin") or {}
        captured_at = str(source.get("captured_at") or updated_at)

        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                """INSERT INTO sources (
                    source_id, kind, title, document_type, correspondent, document_date,
                    tags_json, summary, custom_fields_json, processing_status, last_job_id,
                    processing_error_code, processing_error_summary, review_status,
                    review_reasons_json, reviewed_at, lifecycle, sensitivity, origin_json,
                    password_profile, record_json, captured_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_id) DO UPDATE SET
                    kind=excluded.kind,
                    title=excluded.title,
                    document_type=excluded.document_type,
                    correspondent=excluded.correspondent,
                    document_date=excluded.document_date,
                    tags_json=excluded.tags_json,
                    summary=excluded.summary,
                    custom_fields_json=excluded.custom_fields_json,
                    processing_status=excluded.processing_status,
                    last_job_id=excluded.last_job_id,
                    processing_error_code=excluded.processing_error_code,
                    processing_error_summary=excluded.processing_error_summary,
                    review_status=excluded.review_status,
                    review_reasons_json=excluded.review_reasons_json,
                    reviewed_at=excluded.reviewed_at,
                    lifecycle=excluded.lifecycle,
                    sensitivity=excluded.sensitivity,
                    origin_json=excluded.origin_json,
                    password_profile=excluded.password_profile,
                    record_json=excluded.record_json,
                    updated_at=excluded.updated_at
                """,
                (
                    source_id,
                    str(source.get("kind") or "file"),
                    str(source.get("title") or "Untitled source"),
                    source.get("document_type"),
                    source.get("correspondent"),
                    source.get("document_date"),
                    json.dumps(tags, ensure_ascii=False),
                    source.get("summary"),
                    json.dumps(custom_fields, ensure_ascii=False, sort_keys=True),
                    str(processing.get("status") or source.get("status") or "captured"),
                    processing.get("last_job_id"),
                    processing.get("error_code"),
                    processing.get("error_summary") or processing.get("error"),
                    str(review.get("status") or "unreviewed"),
                    json.dumps(review.get("reasons") or [], ensure_ascii=False),
                    review.get("reviewed_at"),
                    str(source.get("lifecycle") or "active"),
                    str(source.get("sensitivity") or "personal"),
                    json.dumps(origin, ensure_ascii=False, sort_keys=True),
                    source.get("password_profile"),
                    json.dumps(source, ensure_ascii=False, sort_keys=True),
                    captured_at,
                    updated_at,
                ),
            )
            for ver in source.get("versions") or []:
                if not isinstance(ver, dict) or not ver.get("id"):
                    continue
                db.execute(
                    """INSERT INTO source_versions (
                        source_id, version_id, original_artifact_id, filename,
                        content_sha256, media_type, size_bytes, blob_relpath, received_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(source_id, version_id) DO UPDATE SET
                        original_artifact_id=excluded.original_artifact_id,
                        filename=COALESCE(excluded.filename, source_versions.filename),
                        content_sha256=excluded.content_sha256,
                        media_type=excluded.media_type,
                        size_bytes=COALESCE(excluded.size_bytes, source_versions.size_bytes),
                        blob_relpath=excluded.blob_relpath,
                        received_at=excluded.received_at
                    """,
                    (
                        source_id,
                        str(ver["id"]),
                        ver.get("original_artifact_id"),
                        ver.get("filename"),
                        ver.get("content_sha256"),
                        ver.get("media_type"),
                        ver.get("size_bytes"),
                        ver.get("original_ref"),
                        ver.get("received_at") or captured_at,
                    ),
                )
            db.execute("COMMIT")

    def get_source(self, source_id: str) -> dict | None:
        with self._database() as db:
            row = db.execute(
                "SELECT record_json FROM sources WHERE source_id = ?", (source_id,)
            ).fetchone()
        if row is None:
            return None
        return _decode_json(row["record_json"], None)

    def list_sources(self) -> list[dict]:
        with self._database() as db:
            rows = db.execute(
                "SELECT record_json FROM sources ORDER BY captured_at DESC"
            ).fetchall()
        result = []
        for row in rows:
            decoded = _decode_json(row["record_json"], None)
            if isinstance(decoded, dict):
                result.append(decoded)
        return result

    def save_extraction(
        self,
        *,
        extraction_id: str,
        source_id: str,
        version_id: str,
        artifact_id: str,
        role: str,
        media_type: str,
        blob_relpath: str,
        manifest_relpath: str,
        content_text: str | None,
        coverage: dict,
        warnings: list[str],
        complete: bool,
    ) -> None:
        created_at = iso_now()
        with self._database() as db:
            db.execute(
                """INSERT INTO extractions (
                    extraction_id, source_id, version_id, artifact_id, role,
                    media_type, blob_relpath, manifest_relpath, content_text,
                    coverage_json, warnings_json, complete, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(extraction_id) DO UPDATE SET
                    blob_relpath=excluded.blob_relpath,
                    manifest_relpath=excluded.manifest_relpath,
                    content_text=excluded.content_text,
                    coverage_json=excluded.coverage_json,
                    warnings_json=excluded.warnings_json,
                    complete=excluded.complete
                """,
                (
                    extraction_id,
                    source_id,
                    version_id,
                    artifact_id,
                    role,
                    media_type,
                    blob_relpath,
                    manifest_relpath,
                    content_text,
                    json.dumps(coverage or {}, ensure_ascii=False, sort_keys=True),
                    json.dumps(warnings or [], ensure_ascii=False),
                    1 if complete else 0,
                    created_at,
                ),
            )

    def list_extractions(self, source_id: str, version_id: str | None = None) -> list[dict]:
        with self._database() as db:
            if version_id:
                rows = db.execute(
                    """SELECT * FROM extractions
                       WHERE source_id = ? AND version_id = ?
                       ORDER BY created_at DESC, rowid DESC""",
                    (source_id, version_id),
                ).fetchall()
            else:
                rows = db.execute(
                    """SELECT * FROM extractions
                       WHERE source_id = ?
                       ORDER BY created_at DESC, rowid DESC""",
                    (source_id,),
                ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["coverage"] = _decode_json(item.pop("coverage_json", "{}"), {})
            item["warnings"] = _decode_json(item.pop("warnings_json", "[]"), [])
            item["complete"] = bool(item.get("complete", 1))
            result.append(item)
        return result

    def save_intake(self, intake: dict) -> None:
        intake_id = str(intake["intake_id"])
        updated_at = iso_now()
        captured_at = str(intake.get("captured_at") or updated_at)
        with self._database() as db:
            db.execute(
                """INSERT INTO intakes (
                    intake_id, source_id, version_id, kind, operation,
                    status, job_id, last_error, record_json, captured_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(intake_id) DO UPDATE SET
                    version_id=excluded.version_id,
                    status=excluded.status,
                    job_id=excluded.job_id,
                    last_error=excluded.last_error,
                    record_json=excluded.record_json,
                    updated_at=excluded.updated_at
                """,
                (
                    intake_id,
                    str(intake.get("source_id") or ""),
                    intake.get("version_id"),
                    str(intake.get("kind") or "file"),
                    str(intake.get("operation") or "extract"),
                    str(intake.get("status") or "captured"),
                    intake.get("job_id"),
                    intake.get("last_error"),
                    json.dumps(intake, ensure_ascii=False, sort_keys=True),
                    captured_at,
                    updated_at,
                ),
            )

    def get_intake(self, intake_id: str) -> dict | None:
        with self._database() as db:
            row = db.execute(
                "SELECT record_json FROM intakes WHERE intake_id = ?", (intake_id,)
            ).fetchone()
        if row is None:
            return None
        return _decode_json(row["record_json"], None)

    def get_intake_by_source(self, source_id: str) -> dict | None:
        with self._database() as db:
            row = db.execute(
                "SELECT record_json FROM intakes WHERE source_id = ? ORDER BY captured_at DESC LIMIT 1",
                (source_id,),
            ).fetchone()
        if row is None:
            return None
        return _decode_json(row["record_json"], None)

    def list_intakes(self) -> list[dict]:
        with self._database() as db:
            rows = db.execute(
                "SELECT record_json FROM intakes ORDER BY captured_at DESC"
            ).fetchall()
        result = []
        for row in rows:
            decoded = _decode_json(row["record_json"], None)
            if isinstance(decoded, dict):
                result.append(decoded)
        return result

    # -------------------------------------------------------------------------
    # Job Queue & Leases
    # -------------------------------------------------------------------------

    def submit(self, request: dict) -> dict:
        timestamp = now()
        job_id = request.get("job_id") or new_id("job")
        continuation = dict(request.get("continuation") or {})
        idempotency_key = request["idempotency_key"]
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT * FROM jobs WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
            if existing:
                db.execute("COMMIT")
                return self._decode_job(dict(existing))
            db.execute(
                """INSERT INTO jobs (
                    job_id, idempotency_key, intake_id, source_id, version_id, operation,
                    requested_outputs, password_profile, continuation, state, next_attempt_at,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)""",
                (
                    job_id,
                    idempotency_key,
                    request.get("intake_id") or "",
                    request["source_id"],
                    request.get("version_id"),
                    request.get("operation", "extract"),
                    json.dumps(request.get("requested_outputs", ["text"]), sort_keys=True),
                    request.get("password_profile"),
                    json.dumps(continuation, sort_keys=True),
                    timestamp,
                    timestamp,
                    timestamp,
                ),
            )
            db.execute("COMMIT")
        return self.get(job_id)

    submit_job = submit

    def get(self, job_id: str) -> dict:
        with self._database() as db:
            row = db.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            raise KeyError("job not found")
        return self._decode_job(dict(row))

    get_job = get

    def get_by_intake(self, intake_id: str) -> dict:
        with self._database() as db:
            row = db.execute(
                "SELECT * FROM jobs WHERE intake_id = ? ORDER BY created_at DESC LIMIT 1",
                (intake_id,),
            ).fetchone()
        if row is None:
            raise KeyError("intake job not found")
        return self._decode_job(dict(row))

    def get_by_source(self, source_id: str) -> dict:
        with self._database() as db:
            row = db.execute(
                "SELECT * FROM jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1",
                (source_id,),
            ).fetchone()
        if row is None:
            raise KeyError("source job not found")
        return self._decode_job(dict(row))

    def get_by_idempotency(self, idempotency_key: str) -> dict | None:
        with self._database() as db:
            row = db.execute(
                "SELECT * FROM jobs WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
        return self._decode_job(dict(row)) if row is not None else None

    def live_status(self, job_limit: int = 200, **kwargs) -> dict:
        """Return a sanitized, bounded view for the workspace UI snapshot."""
        job_limit = max(1, min(job_limit, 1000))
        with self._database() as db:
            counts = {
                row["state"]: int(row["count"])
                for row in db.execute("SELECT state, COUNT(*) AS count FROM jobs GROUP BY state")
            }
            jobs = [
                {
                    "job_id": row["job_id"],
                    "intake_id": row["intake_id"],
                    "source_id": row["source_id"],
                    "version_id": row["version_id"],
                    "operation": row["operation"],
                    "requested_outputs": _decode_json(row["requested_outputs"], []),
                    "state": row["state"],
                    "attempts": row["attempts"],
                    "error_code": row["error_code"],
                    "error_summary": row["error_summary"],
                    "next_attempt_at": row["next_attempt_at"],
                    "heartbeat_at": row["heartbeat_at"],
                    "lease_expires_at": row["lease_expires_at"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
                for row in db.execute(
                    """SELECT job_id, intake_id, source_id, version_id, operation,
                              requested_outputs, state, attempts, error_code,
                              error_summary, next_attempt_at, heartbeat_at,
                              lease_expires_at, created_at, updated_at
                         FROM jobs ORDER BY updated_at DESC LIMIT ?""",
                    (job_limit,),
                ).fetchall()
            ]
        return {
            "job_counts": counts,
            "jobs": jobs,
            "events": [],
            "actions": [],
            "truncated": {
                "jobs": len(jobs) >= job_limit,
                "events": False,
                "actions": False,
            },
        }

    def claim(self, owner: str) -> dict | None:
        timestamp = now()
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            self._reclaim_locked(db, timestamp)
            row = db.execute(
                """SELECT job_id FROM jobs
                   WHERE state IN ('queued', 'retryable-failure')
                     AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                   ORDER BY created_at LIMIT 1""",
                (timestamp,),
            ).fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            generation = (
                int(
                    db.execute(
                        "SELECT lease_generation FROM jobs WHERE job_id = ?",
                        (row["job_id"],),
                    ).fetchone()[0]
                    or 0
                )
                + 1
            )
            db.execute(
                """UPDATE jobs SET state='running', attempts=attempts+1,
                   lease_owner=?, lease_generation=?, lease_expires_at=?, heartbeat_at=?, updated_at=?
                   WHERE job_id=? AND state IN ('queued', 'retryable-failure')""",
                (owner, generation, timestamp + LEASE_SECONDS, timestamp, timestamp, row["job_id"]),
            )
            db.execute("COMMIT")
        return self.get(row["job_id"])

    def heartbeat(self, job_id: str, owner: str, generation: int) -> bool:
        timestamp = now()
        with self._database() as db:
            result = db.execute(
                """UPDATE jobs SET lease_expires_at=?, heartbeat_at=?, updated_at=?
                   WHERE job_id=? AND state='running' AND lease_owner=? AND lease_generation=?""",
                (timestamp + LEASE_SECONDS, timestamp, timestamp, job_id, owner, generation),
            )
        return result.rowcount == 1

    def owns(self, job_id: str, owner: str, generation: int) -> bool:
        with self._database() as db:
            row = db.execute(
                "SELECT 1 FROM jobs WHERE job_id=? AND state='running' AND lease_owner=? AND lease_generation=?",
                (job_id, owner, generation),
            ).fetchone()
        return row is not None

    def finish(self, job: dict, result: dict) -> str | None:
        timestamp = now()
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            valid = db.execute(
                "SELECT 1 FROM jobs WHERE job_id=? AND state='running' AND lease_owner=? AND lease_generation=?",
                (job["job_id"], job["lease_owner"], job["lease_generation"]),
            ).fetchone()
            if valid is None:
                db.execute("ROLLBACK")
                return None
            db.execute(
                "UPDATE jobs SET state=?, result=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE job_id=?",
                (
                    "completed" if result.get("status") == "completed" else "partial",
                    json.dumps(result, sort_keys=True),
                    timestamp,
                    job["job_id"],
                ),
            )
            db.execute("COMMIT")
        return job["job_id"]

    def fail(self, job: dict, code: str, summary: str, retryable: bool) -> bool:
        timestamp = now()
        should_retry = retryable and job["attempts"] < MAX_ATTEMPTS
        state = "retryable-failure" if should_retry else "failed"
        delay = min(300, 2 ** max(0, job["attempts"] - 1))
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            result = db.execute(
                """UPDATE jobs SET state=?, error_code=?, error_summary=?, next_attempt_at=?,
                   lease_owner=NULL, lease_expires_at=NULL, updated_at=?
                   WHERE job_id=? AND state='running' AND lease_owner=? AND lease_generation=?""",
                (
                    state,
                    code,
                    summary[:500],
                    timestamp + delay if should_retry else None,
                    timestamp,
                    job["job_id"],
                    job["lease_owner"],
                    job["lease_generation"],
                ),
            )
            db.execute("COMMIT")
        return result.rowcount == 1

    def block_for_password(self, job: dict, code: str, summary: str) -> bool:
        timestamp = now()
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            result = db.execute(
                """UPDATE jobs SET state='awaiting-unlock', error_code=?, error_summary=?,
                   lease_owner=NULL, lease_expires_at=NULL, updated_at=?
                   WHERE job_id=? AND state='running' AND lease_owner=? AND lease_generation=?""",
                (
                    code,
                    summary[:500],
                    timestamp,
                    job["job_id"],
                    job["lease_owner"],
                    job["lease_generation"],
                ),
            )
            db.execute("COMMIT")
        return result.rowcount == 1

    def requeue_job(self, job_id: str, password_profile: str | None = None) -> dict:
        timestamp = now()
        with self._database() as db:
            db.execute(
                """UPDATE jobs SET
                   state='queued',
                   password_profile=COALESCE(?, password_profile),
                   error_code=NULL,
                   error_summary=NULL,
                   next_attempt_at=?,
                   updated_at=?
                   WHERE job_id=?
                     AND state IN ('failed','partial','awaiting-unlock','waiting-for-password','retryable-failure','completed')""",
                (password_profile, timestamp, timestamp, job_id),
            )
        return self.get(job_id)

    def recover(self) -> int:
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            count = self._reclaim_locked(db, now())
            db.execute("COMMIT")
        return count

    def _reclaim_locked(self, db: sqlite3.Connection, timestamp: float) -> int:
        result = db.execute(
            """UPDATE jobs SET state='queued', lease_owner=NULL, lease_expires_at=NULL,
               next_attempt_at=?, error_code='worker_lost', error_summary='worker lease expired', updated_at=?
               WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?""",
            (timestamp, timestamp, timestamp),
        )
        return result.rowcount

    # -------------------------------------------------------------------------
    # Full-Text Search (SQLite FTS5)
    # -------------------------------------------------------------------------

    def upsert_source_fts(
        self,
        source_id: str,
        title: str | None,
        correspondent: str | None,
        document_type: str | None,
        tags: list[str] | None,
        summary: str | None,
        content: str | None,
        document_date: str | None,
        review_status: str | None,
        processing_status: str | None,
        lifecycle: str | None,
        custom_fields: dict[str, Any] | None = None,
    ) -> None:
        tags_text = " ".join(tags or [])
        clean_title = title or ""
        clean_correspondent = correspondent or ""
        clean_doc_type = document_type or ""
        clean_summary = summary or ""
        clean_content = content or ""
        if custom_fields:
            cf_tokens = " ".join(f"{k}: {v}" for k, v in custom_fields.items() if v is not None and v != "")
            if cf_tokens and cf_tokens not in clean_content:
                clean_content = f"{clean_content}\n{cf_tokens}".strip()
        clean_date = document_date or ""
        clean_review = review_status or "unreviewed"
        clean_processing = processing_status or "captured"
        clean_lifecycle = lifecycle or "active"

        with self._database() as db:
            db.execute("DELETE FROM source_fts WHERE source_id = ?", (source_id,))
            db.execute(
                """INSERT INTO source_fts (
                    source_id, title, correspondent, document_type, tags,
                    summary, content, document_date, review_status, processing_status, lifecycle
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    source_id,
                    clean_title,
                    clean_correspondent,
                    clean_doc_type,
                    tags_text,
                    clean_summary,
                    clean_content,
                    clean_date,
                    clean_review,
                    clean_processing,
                    clean_lifecycle,
                ),
            )

    def delete_source_fts(self, source_id: str) -> None:
        with self._database() as db:
            db.execute("DELETE FROM source_fts WHERE source_id = ?", (source_id,))

    def get_source_fts_content(self, source_id: str) -> str:
        """Return indexed extracted content so metadata updates can preserve it."""
        with self._database() as db:
            row = db.execute(
                "SELECT content FROM source_fts WHERE source_id = ? LIMIT 1",
                (source_id,),
            ).fetchone()
        return str(row["content"] or "") if row is not None else ""

    def search_sources(
        self,
        query: str | None = None,
        tags: list[str] | None = None,
        correspondent: str | None = None,
        document_type: str | None = None,
        review_status: str | None = None,
        processing_status: str | None = None,
        lifecycle: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> dict:
        sanitized_query = sanitize_fts_query(query) if query and query.strip() else None

        conditions = []
        params: list[object] = []

        if sanitized_query:
            conditions.append("source_fts MATCH ?")
            params.append(sanitized_query)
        if correspondent:
            conditions.append("correspondent LIKE ?")
            params.append(f"%{correspondent}%")
        if document_type:
            conditions.append("document_type = ?")
            params.append(document_type)
        if processing_status:
            conditions.append("processing_status = ?")
            params.append(processing_status)
        if lifecycle:
            conditions.append("lifecycle = ?")
            params.append(lifecycle)
        if date_from:
            conditions.append("document_date >= ?")
            params.append(date_from)
        if date_to:
            conditions.append("document_date <= ?")
            params.append(date_to)
        if tags:
            for tag in tags:
                clean_tag = tag.strip().lower()
                if clean_tag:
                    conditions.append("tags LIKE ?")
                    params.append(f"%{clean_tag}%")

        review_facet_conditions = list(conditions)
        review_facet_params = list(params)

        if review_status:
            if review_status.strip() == "needs-review":
                conditions.append("review_status IN (?, ?)")
                params.extend(["needs-review", "unreviewed"])
            else:
                conditions.append("review_status = ?")
                params.append(review_status.strip())

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        review_facet_where = (
            f"WHERE {' AND '.join(review_facet_conditions)}" if review_facet_conditions else ""
        )

        count_sql = f"SELECT COUNT(*) AS total FROM source_fts {where_clause}"
        select_snippet = (
            "snippet(source_fts, -1, '<mark>', '</mark>', '...', 20) AS snippet, bm25(source_fts) AS rank"
            if sanitized_query
            else "'' AS snippet, 0 AS rank"
        )
        order_clause = "ORDER BY rank ASC, document_date DESC" if sanitized_query else "ORDER BY rowid DESC"
        data_sql = f"""SELECT source_id, title, correspondent, document_type, tags, summary,
                              document_date, review_status, processing_status, lifecycle,
                              {select_snippet}
                       FROM source_fts {where_clause} {order_clause} LIMIT ? OFFSET ?"""

        with self._database() as db:
            total_row = db.execute(count_sql, params).fetchone()
            total = int(total_row["total"]) if total_row else 0
            rows = db.execute(data_sql, params + [limit, offset]).fetchall()

            facet_rows = db.execute(
                f"""SELECT tags, correspondent, document_type, review_status, processing_status, lifecycle
                    FROM source_fts {where_clause}""",
                params,
            ).fetchall()
            review_rows = db.execute(
                f"""SELECT review_status, COUNT(*) AS count
                    FROM source_fts {review_facet_where}
                    GROUP BY review_status""",
                review_facet_params,
            ).fetchall()

        tag_counts: dict[str, int] = {}
        correspondent_counts: dict[str, int] = {}
        type_counts: dict[str, int] = {}
        review_counts: dict[str, int] = {}
        processing_counts: dict[str, int] = {}

        for row in facet_rows:
            if row["tags"]:
                for t in str(row["tags"]).split():
                    clean = t.strip()
                    if clean:
                        tag_counts[clean] = tag_counts.get(clean, 0) + 1
            if row["correspondent"]:
                c = str(row["correspondent"]).strip()
                if c:
                    correspondent_counts[c] = correspondent_counts.get(c, 0) + 1
            if row["document_type"]:
                dt = str(row["document_type"]).strip()
                if dt:
                    type_counts[dt] = type_counts.get(dt, 0) + 1
            p_st = str(row["processing_status"] or "captured").strip()
            processing_counts[p_st] = processing_counts.get(p_st, 0) + 1

        for row in review_rows:
            r_st = str(row["review_status"] or "unreviewed").strip()
            review_counts[r_st] = int(row["count"])

        matches = []
        for row in rows:
            matches.append(
                {
                    "source_id": row["source_id"],
                    "title": row["title"],
                    "correspondent": row["correspondent"] or None,
                    "document_type": row["document_type"] or None,
                    "document_date": row["document_date"] or None,
                    "tags": str(row["tags"]).split() if row["tags"] else [],
                    "summary": row["summary"] or None,
                    "review_status": row["review_status"],
                    "processing_status": row["processing_status"],
                    "lifecycle": row["lifecycle"],
                    "snippet": row["snippet"] or None,
                    "rank": float(row["rank"]),
                }
            )

        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "matches": matches,
            "facets": {
                "tags": tag_counts,
                "correspondents": correspondent_counts,
                "document_types": type_counts,
                "review_status": review_counts,
                "processing_status": processing_counts,
            },
        }

    @staticmethod
    def _decode_job(job: dict) -> dict:
        for key in ("requested_outputs", "continuation", "result"):
            if job.get(key):
                try:
                    job[key] = json.loads(job[key])
                except (TypeError, json.JSONDecodeError):
                    job[key] = {} if key != "requested_outputs" else []
        return job


IngestionDatabase = IngestionQueue


def _decode_json(value: object, fallback: object) -> Any:
    try:
        return json.loads(str(value)) if value else fallback
    except (TypeError, json.JSONDecodeError):
        return fallback
