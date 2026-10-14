"""SQLite-backed disposable execution state for durable ingestion."""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


LEASE_SECONDS = 90
MAX_ATTEMPTS = 4


def now() -> float:
    return time.time()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class IngestionQueue:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = root / "queue.sqlite"
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
                    intake_id TEXT NOT NULL,
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

    def submit(self, request: dict) -> dict:
        timestamp = now()
        job_id = new_id("job")
        continuation = dict(request.get("continuation") or {})
        idempotency_key = request["idempotency_key"]
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM jobs WHERE idempotency_key = ?", (idempotency_key,)).fetchone()
            if existing:
                db.execute("COMMIT")
                return dict(existing)
            db.execute(
                """INSERT INTO jobs (
                    job_id, idempotency_key, intake_id, source_id, version_id, operation,
                    requested_outputs, password_profile, continuation, state, next_attempt_at,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)""",
                (
                    job_id,
                    idempotency_key,
                    request["intake_id"],
                    request["source_id"],
                    request.get("version_id"),
                    request["operation"],
                    json.dumps(request.get("requested_outputs", []), sort_keys=True),
                    request.get("password_profile"),
                    json.dumps(continuation, sort_keys=True),
                    timestamp,
                    timestamp,
                    timestamp,
                ),
            )
            db.execute("COMMIT")
        return self.get(job_id)

    def get(self, job_id: str) -> dict:
        with self._database() as db:
            row = db.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            raise KeyError("job not found")
        return self._decode_job(dict(row))

    def get_by_intake(self, intake_id: str) -> dict:
        with self._database() as db:
            row = db.execute("SELECT * FROM jobs WHERE intake_id = ? ORDER BY created_at DESC LIMIT 1", (intake_id,)).fetchone()
        if row is None:
            raise KeyError("intake job not found")
        return self._decode_job(dict(row))

    def get_by_idempotency(self, idempotency_key: str) -> dict | None:
        with self._database() as db:
            row = db.execute("SELECT * FROM jobs WHERE idempotency_key = ?", (idempotency_key,)).fetchone()
        return self._decode_job(dict(row)) if row is not None else None

    def live_status(self, job_limit: int = 200, event_limit: int = 400, action_limit: int = 400) -> dict:
        """Return a sanitized, bounded view for the workspace UI snapshot."""
        job_limit = max(1, min(job_limit, 1000))
        event_limit = max(1, min(event_limit, 2000))
        action_limit = max(1, min(action_limit, 2000))
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
            events = [
                {
                    "event_id": row["event_id"],
                    "job_id": row["job_id"],
                    "event_type": row["event_type"],
                    "delivery_state": row["delivery_state"],
                    "attempts": row["attempts"],
                    "last_error": row["last_error"],
                    "delivered_at": row["delivered_at"],
                    "acknowledged_at": row["acknowledged_at"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
                for row in db.execute(
                    """SELECT event_id, job_id, event_type, delivery_state,
                              attempts, last_error, delivered_at, acknowledged_at,
                              created_at, updated_at
                         FROM events ORDER BY updated_at DESC LIMIT ?""",
                    (event_limit,),
                ).fetchall()
            ]
            actions = [
                {
                    "action_id": row["action_id"],
                    "event_id": row["event_id"],
                    "intake_id": row["intake_id"],
                    "status": row["status"],
                    "record_refs": _decode_json(row["record_refs"], []),
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
                for row in db.execute(
                    """SELECT action_id, event_id, intake_id, status,
                              record_refs, created_at, updated_at
                         FROM actions ORDER BY updated_at DESC LIMIT ?""",
                    (action_limit,),
                ).fetchall()
            ]
        return {
            "job_counts": counts,
            "jobs": jobs,
            "events": events,
            "actions": actions,
            "truncated": {
                "jobs": len(jobs) >= job_limit,
                "events": len(events) >= event_limit,
                "actions": len(actions) >= action_limit,
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
            generation = db.execute("SELECT lease_generation FROM jobs WHERE job_id = ?", (row["job_id"],)).fetchone()[0] + 1
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
            row = db.execute("SELECT 1 FROM jobs WHERE job_id=? AND state='running' AND lease_owner=? AND lease_generation=?", (job_id, owner, generation)).fetchone()
        return row is not None

    def finish(self, job: dict, result: dict) -> str | None:
        timestamp = now()
        event_id = new_id("evt")
        payload = dict(result)
        payload.update({"event_id": event_id, "job_id": job["job_id"], "intake_id": job["intake_id"], "source_id": job["source_id"], "version_id": job.get("version_id")})
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
                ("completed" if result.get("status") == "completed" else "partial", json.dumps(result, sort_keys=True), timestamp, job["job_id"]),
            )
            db.execute(
                """INSERT INTO events (event_id, job_id, event_type, payload, delivery_state, next_attempt_at, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)""",
                (event_id, job["job_id"], f"ingestion.{result.get('status', 'failed')}", json.dumps(payload, sort_keys=True), timestamp, timestamp, timestamp),
            )
            db.execute("COMMIT")
        return event_id

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
                (state, code, summary[:500], timestamp + delay if should_retry else None, timestamp, job["job_id"], job["lease_owner"], job["lease_generation"]),
            )
            if result.rowcount == 1 and not should_retry:
                event_id = new_id("evt")
                payload = {"event_id": event_id, "status": "failed", "job_id": job["job_id"], "intake_id": job["intake_id"], "source_id": job["source_id"], "version_id": job.get("version_id"), "error_code": code, "continuation": job.get("continuation", {}), "action": "Review the durable intake record and retry explicitly."}
                db.execute("INSERT INTO events (event_id, job_id, event_type, payload, delivery_state, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'ingestion.failed', ?, 'pending', ?, ?, ?)", (event_id, job["job_id"], json.dumps(payload, sort_keys=True), timestamp, timestamp, timestamp))
            db.execute("COMMIT")
        return result.rowcount == 1

    def block_for_password(self, job: dict, code: str, summary: str) -> bool:
        timestamp = now()
        with self._database() as db:
            db.execute("BEGIN IMMEDIATE")
            result = db.execute("UPDATE jobs SET state='awaiting-unlock', error_code=?, error_summary=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE job_id=? AND state='running' AND lease_owner=? AND lease_generation=?", (code, summary[:500], timestamp, job["job_id"], job["lease_owner"], job["lease_generation"]))
            if result.rowcount == 1:
                event_id = new_id("evt")
                payload = {"event_id": event_id, "status": "awaiting-unlock", "job_id": job["job_id"], "intake_id": job["intake_id"], "source_id": job["source_id"], "version_id": job.get("version_id"), "error_code": code, "continuation": job.get("continuation", {}), "action": "Select or configure a document unlock profile, then retry the intake."}
                db.execute("INSERT INTO events (event_id, job_id, event_type, payload, delivery_state, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'ingestion.awaiting-unlock', ?, 'pending', ?, ?, ?)", (event_id, job["job_id"], json.dumps(payload, sort_keys=True), timestamp, timestamp, timestamp))
            db.execute("COMMIT")
        return result.rowcount == 1

    def due_events(self) -> list[dict]:
        timestamp = now()
        with self._database() as db:
            rows = db.execute(
                "SELECT * FROM events WHERE delivery_state IN ('pending', 'awaiting_ack') AND next_attempt_at <= ? ORDER BY created_at LIMIT 20",
                (timestamp,),
            ).fetchall()
        return [self._decode_event(dict(row)) for row in rows]

    def mark_event(self, event_id: str, delivered: bool, error: str | None = None) -> None:
        timestamp = now()
        if delivered:
            state, delay, delivered_at = "awaiting_ack", 900, timestamp
        else:
            state, delivered_at = "pending", None
        with self._database() as db:
            current = db.execute("SELECT attempts FROM events WHERE event_id=?", (event_id,)).fetchone()
            attempts = int(current[0]) if current else 0
            delay = min(900, 2 ** min(8, attempts)) if not delivered else 900
            db.execute(
                """UPDATE events SET delivery_state=?, attempts=attempts+1, next_attempt_at=?,
                   last_error=?, delivered_at=COALESCE(delivered_at, ?), updated_at=? WHERE event_id=?""",
                (state, timestamp + delay, error[:500] if error else None, delivered_at, timestamp, event_id),
            )

    def acknowledge(self, event_id: str) -> bool:
        timestamp = now()
        with self._database() as db:
            result = db.execute("UPDATE events SET delivery_state='acknowledged', acknowledged_at=?, updated_at=? WHERE event_id=? AND delivery_state != 'acknowledged'", (timestamp, timestamp, event_id))
        return result.rowcount == 1

    def begin_action(self, action_id: str, event_id: str, intake_id: str) -> dict:
        timestamp = now()
        with self._database() as db:
            db.execute("INSERT OR IGNORE INTO actions (action_id, event_id, intake_id, status, created_at, updated_at) VALUES (?, ?, ?, 'started', ?, ?)", (action_id, event_id, intake_id, timestamp, timestamp))
            row = db.execute("SELECT action_id, status, record_refs FROM actions WHERE action_id=?", (action_id,)).fetchone()
        decoded = dict(row)
        try:
            decoded["record_refs"] = json.loads(decoded["record_refs"])
        except (TypeError, json.JSONDecodeError):
            decoded["record_refs"] = []
        return decoded

    def complete_action(self, action_id: str, record_refs: list[str]) -> bool:
        with self._database() as db:
            result = db.execute("UPDATE actions SET status='completed', record_refs=?, updated_at=? WHERE action_id=? AND status != 'completed'", (json.dumps(record_refs, sort_keys=True), now(), action_id))
        return result.rowcount == 1

    def create_event(self, job_id: str, event_type: str, payload: dict) -> str:
        event_id = new_id("evt")
        timestamp = now()
        payload = {**payload, "event_id": event_id, "job_id": job_id}
        with self._database() as db:
            db.execute("INSERT INTO events (event_id, job_id, event_type, payload, delivery_state, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)", (event_id, job_id, event_type, json.dumps(payload, sort_keys=True), timestamp, timestamp, timestamp))
        return event_id

    def event_exists(self, event_id: str) -> bool:
        with self._database() as db:
            row = db.execute("SELECT 1 FROM events WHERE event_id=?", (event_id,)).fetchone()
        return row is not None

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
        import re

        sanitized_query = None
        if query and query.strip():
            tokens = re.findall(r"[A-Za-z0-9_\-\u00C0-\u024F\u1EA0-\u1EF9]+", query)
            terms = [f'"{token.strip("-")}"*' for token in tokens if token.strip("-")]
            if terms:
                sanitized_query = " AND ".join(terms)

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

    @staticmethod
    def _decode_job(job: dict) -> dict:
        for key in ("requested_outputs", "continuation", "result"):
            if job.get(key):
                try:
                    job[key] = json.loads(job[key])
                except (TypeError, json.JSONDecodeError):
                    job[key] = {} if key != "requested_outputs" else []
        return job

    @staticmethod
    def _decode_event(event: dict) -> dict:
        try:
            event["payload"] = json.loads(event["payload"])
        except (KeyError, TypeError, json.JSONDecodeError):
            event["payload"] = {}
        return event


def _decode_json(value: object, fallback: object) -> object:
    try:
        return json.loads(value) if value else fallback
    except (TypeError, json.JSONDecodeError):
        return fallback
