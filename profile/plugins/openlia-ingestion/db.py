"""SQLite WAL database for execution queue and FTS5 document search."""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


LOGGER = logging.getLogger("openlia.ingestion.db")
LEASE_SECONDS = 90
MAX_ATTEMPTS = 4


def now() -> float:
    return time.time()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def sanitize_fts_query(query: str) -> str:
    """Sanitize free text into a safe SQLite FTS5 query with prefix matching."""
    tokens = re.findall(r"[A-Za-z0-9_\-\u00C0-\u024F\u1EA0-\u1EF9]+", query)
    if not tokens:
        return ""
    # Treat words as prefix queries or exact terms
    terms = []
    for token in tokens:
        clean = token.strip("-")
        if clean:
            terms.append(f'"{clean}"*')
    return " AND ".join(terms)


class IngestionDatabase:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "queue.sqlite"
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
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
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
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

                CREATE TABLE IF NOT EXISTS events (
                    event_id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    delivery_state TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at REAL NOT NULL,
                    last_error TEXT,
                    delivered_at REAL,
                    acknowledged_at REAL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS events_due ON events(delivery_state, next_attempt_at);

                CREATE TABLE IF NOT EXISTS actions (
                    action_id TEXT PRIMARY KEY,
                    event_id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    record_refs TEXT NOT NULL DEFAULT '[]',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

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

    # -------------------------------------------------------------------------
    # Job Queue
    # -------------------------------------------------------------------------

    def submit_job(self, request: dict) -> dict:
        timestamp = now()
        job_id = new_id("job")
        continuation = dict(request.get("continuation") or {})
        idempotency_key = request["idempotency_key"]
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM jobs WHERE idempotency_key = ?", (idempotency_key,)).fetchone()
            if existing:
                db.execute("COMMIT")
                return self._decode_job(dict(existing))
            db.execute(
                """INSERT INTO jobs (
                    job_id, idempotency_key, source_id, version_id, operation,
                    requested_outputs, password_profile, continuation, state, next_attempt_at,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)""",
                (
                    job_id,
                    idempotency_key,
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
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> dict:
        with self._database() as db:
            row = db.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(f"job not found: {job_id}")
        return self._decode_job(dict(row))

    def get_job_by_source(self, source_id: str) -> dict | None:
        with self._database() as db:
            row = db.execute("SELECT * FROM jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1", (source_id,)).fetchone()
        return self._decode_job(dict(row)) if row is not None else None

    def get_job_by_idempotency(self, idempotency_key: str) -> dict | None:
        with self._database() as db:
            row = db.execute("SELECT * FROM jobs WHERE idempotency_key = ?", (idempotency_key,)).fetchone()
        return self._decode_job(dict(row)) if row is not None else None

    def claim_job(self, owner: str) -> dict | None:
        timestamp = now()
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """SELECT * FROM jobs
                   WHERE state = 'queued' AND next_attempt_at <= ?
                   ORDER BY next_attempt_at ASC LIMIT 1""",
                (timestamp,),
            ).fetchone()
            if not row:
                db.execute("COMMIT")
                return None
            job = dict(row)
            lease_generation = int(job.get("lease_generation") or 0) + 1
            db.execute(
                """UPDATE jobs SET
                   state = 'running', lease_owner = ?, lease_generation = ?,
                   lease_expires_at = ?, heartbeat_at = ?, attempts = attempts + 1,
                   updated_at = ?
                   WHERE job_id = ?""",
                (owner, lease_generation, timestamp + LEASE_SECONDS, timestamp, timestamp, job["job_id"]),
            )
            db.execute("COMMIT")
        return self.get_job(job["job_id"])

    def heartbeat(self, job_id: str, owner: str) -> None:
        timestamp = now()
        with self._database() as db:
            db.execute(
                """UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
                   WHERE job_id = ? AND lease_owner = ? AND state = 'running'""",
                (timestamp, timestamp + LEASE_SECONDS, timestamp, job_id, owner),
            )

    def complete_job(self, job_id: str, owner: str, result: dict) -> None:
        timestamp = now()
        with self._database() as db:
            db.execute(
                """UPDATE jobs SET
                   state = 'completed', result = ?, lease_owner = NULL,
                   lease_expires_at = NULL, updated_at = ?
                   WHERE job_id = ? AND lease_owner = ?""",
                (json.dumps(result, sort_keys=True), timestamp, job_id, owner),
            )

    def fail_job(self, job_id: str, owner: str, code: str, summary: str, retryable: bool) -> None:
        timestamp = now()
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT attempts FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            attempts = int(row["attempts"]) if row else 1
            if retryable and attempts < MAX_ATTEMPTS:
                state = "retryable-failure"
                next_attempt = timestamp + (2 ** attempts) * 5
            elif code in {"password_required", "password_invalid", "unlock_failed"}:
                state = "waiting-for-password"
                next_attempt = timestamp + 86400 * 365
            else:
                state = "failed"
                next_attempt = timestamp + 86400 * 365
            db.execute(
                """UPDATE jobs SET
                   state = ?, error_code = ?, error_summary = ?,
                   lease_owner = NULL, lease_expires_at = NULL,
                   next_attempt_at = ?, updated_at = ?
                   WHERE job_id = ?""",
                (state, code, summary[:500], next_attempt, timestamp, job_id),
            )
            db.execute("COMMIT")

    def retry_job(self, job_id: str, password_profile: str | None = None) -> dict:
        timestamp = now()
        with self._database() as db:
            db.execute(
                """UPDATE jobs SET
                   state = 'queued', next_attempt_at = ?, error_code = NULL,
                   error_summary = NULL, password_profile = COALESCE(?, password_profile),
                   updated_at = ?
                   WHERE job_id = ?""",
                (timestamp, password_profile, timestamp, job_id),
            )
        return self.get_job(job_id)

    def recover(self) -> int:
        """Reclaim expired leases back to queued or failed."""
        timestamp = now()
        with self._database() as db:
            cursor = db.execute(
                """UPDATE jobs SET
                   state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
                   lease_owner = NULL, lease_expires_at = NULL,
                   next_attempt_at = ?, updated_at = ?
                   WHERE state = 'running' AND lease_expires_at < ?""",
                (MAX_ATTEMPTS, timestamp, timestamp, timestamp),
            )
            return cursor.rowcount

    # -------------------------------------------------------------------------
    # Events & Actions (Continuation support)
    # -------------------------------------------------------------------------

    def create_event(self, job_id: str, event_type: str, payload: dict) -> str:
        event_id = new_id("evt")
        timestamp = now()
        with self._database() as db:
            db.execute(
                """INSERT INTO events (
                    event_id, job_id, event_type, payload, delivery_state,
                    next_attempt_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)""",
                (event_id, job_id, event_type, json.dumps(payload, sort_keys=True), timestamp, timestamp, timestamp),
            )
        return event_id

    def acknowledge_event(self, event_id: str) -> None:
        timestamp = now()
        with self._database() as db:
            db.execute(
                """UPDATE events SET delivery_state = 'acknowledged', acknowledged_at = ?, updated_at = ?
                   WHERE event_id = ?""",
                (timestamp, timestamp, event_id),
            )

    def record_action(self, event_id: str, source_id: str, status: str, record_refs: list[str]) -> str:
        action_id = new_id("act")
        timestamp = now()
        with self._database() as db:
            db.execute(
                """INSERT INTO actions (
                    action_id, event_id, source_id, status, record_refs,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (action_id, event_id, source_id, status, json.dumps(record_refs), timestamp, timestamp),
            )
        return action_id

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
    ) -> None:
        tags_text = " ".join(tags or [])
        clean_title = title or ""
        clean_correspondent = correspondent or ""
        clean_doc_type = document_type or ""
        clean_summary = summary or ""
        clean_content = content or ""
        clean_date = document_date or ""
        clean_review = review_status or "unreviewed"
        clean_processing = processing_status or "captured"
        clean_lifecycle = lifecycle or "active"

        with self._database() as db:
            # Delete old entry if present
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
        """Perform FTS search with ranking, highlighting snippet, and facet counts."""
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
        if review_status:
            conditions.append("review_status = ?")
            params.append(review_status)
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

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        count_sql = f"SELECT COUNT(*) AS total FROM source_fts {where_clause}"
        select_snippet = (
            "snippet(source_fts, 5, '<mark>', '</mark>', '...', 20) AS snippet, bm25(source_fts) AS rank"
            if sanitized_query
            else "'' AS snippet, 0 AS rank"
        )
        order_clause = "ORDER BY rank ASC, document_date DESC" if sanitized_query else "ORDER BY document_date DESC"
        data_sql = f"""SELECT source_id, title, correspondent, document_type, tags, summary,
                              document_date, review_status, processing_status, lifecycle,
                              {select_snippet}
                       FROM source_fts {where_clause} {order_clause} LIMIT ? OFFSET ?"""

        with self._database() as db:
            total_row = db.execute(count_sql, params).fetchone()
            total = int(total_row["total"]) if total_row else 0
            rows = db.execute(data_sql, params + [limit, offset]).fetchall()

            # Facet calculations across active documents
            facet_rows = db.execute(
                """SELECT tags, correspondent, document_type, review_status, processing_status, lifecycle
                   FROM source_fts"""
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
            r_st = str(row["review_status"] or "unreviewed").strip()
            review_counts[r_st] = review_counts.get(r_st, 0) + 1
            p_st = str(row["processing_status"] or "captured").strip()
            processing_counts[p_st] = processing_counts.get(p_st, 0) + 1

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

    # -------------------------------------------------------------------------
    # Diagnostics & Snapshots
    # -------------------------------------------------------------------------

    def live_status(self) -> dict:
        with self._database() as db:
            counts = {row["state"]: int(row["count"]) for row in db.execute("SELECT state, COUNT(*) AS count FROM jobs GROUP BY state")}
            jobs = [self._decode_job(dict(r)) for r in db.execute("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 50")]
        return {
            "schema": 1,
            "generated_at": now(),
            "job_counts": counts,
            "jobs": jobs,
        }

    def _decode_job(self, row: dict) -> dict:
        for key in ("requested_outputs", "continuation", "result"):
            if key in row and isinstance(row[key], str):
                try:
                    row[key] = json.loads(row[key])
                except json.JSONDecodeError:
                    pass
        return row
