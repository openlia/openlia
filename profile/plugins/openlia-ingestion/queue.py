"""Unified SQLite queue and vault re-exports for backward compatibility."""

from __future__ import annotations

from .db import (
    IngestionDatabase,
    IngestionQueue,
    LEASE_SECONDS,
    MAX_ATTEMPTS,
    iso_now,
    new_id,
    now,
    resolve_db_path,
    sanitize_fts_query,
)

__all__ = [
    "IngestionDatabase",
    "IngestionQueue",
    "LEASE_SECONDS",
    "MAX_ATTEMPTS",
    "iso_now",
    "new_id",
    "now",
    "resolve_db_path",
    "sanitize_fts_query",
]
