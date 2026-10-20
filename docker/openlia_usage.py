"""Best-effort usage monitoring. No prompts, responses, or credentials are persisted."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

LOG = logging.getLogger("openlia.usage")
TOKENS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens")
SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_events (
 id TEXT PRIMARY KEY, activity TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
 timestamp REAL NOT NULL, historical INTEGER NOT NULL, reference TEXT NOT NULL,
 tokens TEXT NOT NULL, complete INTEGER NOT NULL, fallback_cost REAL, provider_cost REAL
);
CREATE INDEX IF NOT EXISTS usage_time ON usage_events(timestamp);
CREATE INDEX IF NOT EXISTS usage_reference ON usage_events(reference);
CREATE TABLE IF NOT EXISTS usage_checkpoints (id TEXT PRIMARY KEY, counters TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_prices (
 provider TEXT NOT NULL, model TEXT NOT NULL, rates TEXT, source TEXT NOT NULL,
 checked_at REAL NOT NULL, error INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider,model)
);
CREATE TABLE IF NOT EXISTS usage_overrides (
 provider TEXT NOT NULL, model TEXT NOT NULL, rates TEXT NOT NULL, PRIMARY KEY(provider,model)
);
"""


def root():
    return Path(os.environ.get("OPENLIA_USAGE_ROOT") or Path(os.environ.get("HERMES_HOME", "/opt/data")) / "usage")


@contextmanager
def connect(directory=None, *, timeout=3):
    directory = Path(directory or root())
    directory.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(directory / "usage.sqlite", timeout=timeout)
    try:
        os.chmod(directory / "usage.sqlite", 0o600)
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        if "provider_cost" not in {row[1] for row in db.execute("PRAGMA table_info(usage_events)")}:
            db.execute("ALTER TABLE usage_events ADD COLUMN provider_cost REAL")
            db.execute("INSERT OR IGNORE INTO usage_meta VALUES ('ingestion_ownership_since',?)", (str(time.time()),))
        db.execute("INSERT OR IGNORE INTO usage_meta VALUES ('started_at', ?)", (str(time.time()),))
        db.commit()
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def counters(value):
    return {key: max(0, int(value.get(key) or 0)) for key in TOKENS}


def source_key(row):
    values = [row.get(k) or "" for k in ("session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task")]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def publish_report(report):
    """Durable fallback when a transient SQLite lock prevents direct reporting."""
    import tempfile
    directory = root() / "reports"
    directory.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, prefix=".usage-", delete=False) as stream:
            name = stream.name
            json.dump(report, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, directory / (str(report["id"]) + ".json"))
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def insert_event(db, report):
    activity = report.get("activity")
    if activity not in ("hermes", "ingestion", "migration"):
        raise ValueError("invalid usage activity")
    cost = report.get("fallback_cost")
    if cost is not None:
        import math
        cost = float(cost)
        if not math.isfinite(cost) or cost < 0:
            cost = None
    provider_cost = report.get("provider_cost")
    if provider_cost is not None:
        import math
        provider_cost = float(provider_cost)
        if not math.isfinite(provider_cost) or provider_cost < 0:
            provider_cost = None
    db.execute("INSERT OR IGNORE INTO usage_events (id,activity,provider,model,timestamp,historical,reference,tokens,complete,fallback_cost,provider_cost) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
        str(report["id"])[:512], activity, str(report.get("provider") or "unknown")[:256],
        str(report.get("model") or "unknown")[:256], float(report.get("timestamp") or time.time()),
        int(bool(report.get("historical"))), str(report.get("reference") or "")[:512],
        json.dumps(counters(report.get("tokens") or {})) if report.get("tokens") else "{}", int(bool(report.get("complete"))), cost, provider_cost,
    ))


def record_response(response, *, provider="unknown", reference="", task=""):
    """Called at the ingestion response boundary, before structured-output validation."""
    try:
        raw = getattr(response, "usage", None)
        def field(name):
            return raw.get(name) if isinstance(raw, dict) else getattr(raw, name, None)
        chat_shape = raw is not None and field("prompt_tokens") is not None
        complete = raw is not None
        try:
            from agent.usage_pricing import normalize_usage
            from dataclasses import asdict
            # Hermes' auxiliary Anthropic shim returns chat-shaped counts and
            # omits cache details. Do not interpret those as native Messages usage.
            tokens = asdict(normalize_usage(raw, provider=None if chat_shape else provider)) if complete else {}
            if chat_shape and provider == "anthropic":
                complete = False
        except ImportError:
            # Standalone ingestion has no Hermes dependency. OpenAI-shaped basic
            # counts remain usable, but omitted detail is explicitly incomplete.
            tokens = {"input_tokens": field("prompt_tokens") or field("input_tokens") or 0,
                      "output_tokens": field("completion_tokens") or field("output_tokens") or 0} if raw is not None else {}
            complete = False
        report = dict(id=uuid.uuid4().hex, activity="ingestion", provider=provider,
            model=getattr(response, "model", None), timestamp=time.time(), reference=reference,
            tokens=tokens, complete=complete, provider_cost=field("cost"))
        try:
            with connect(timeout=0.2) as db:
                insert_event(db, report)
        except (OSError, sqlite3.Error):
            publish_report(report)
        return True
    except Exception:
        LOG.warning("Ingestion usage reporting unavailable", exc_info=True)
        return False


@contextmanager
def ingestion_accounting():
    """Only one path owns a response. Restore Hermes accounting for fallback."""
    reset = token = None
    try:
        from agent.aux_accounting import reset_accounting_context, set_accounting_context
        reset = reset_accounting_context
        token = set_accounting_context(None, None)
    except ImportError:
        pass
    try:
        yield
    finally:
        if reset is not None:
            reset(token)


def finish_ingestion(response, provider, reference, task):
    if not record_response(response, provider=provider, reference=reference, task=task):
        try:
            from agent.aux_accounting import record_aux_usage
            record_aux_usage(response, task, provider=provider)
        except Exception:
            LOG.warning("Hermes ingestion usage fallback unavailable")


def monitored_llm(llm, reference):
    """A job-local facade, never a global patch. Host trust/routing remains unchanged."""
    if llm is None:
        return None
    try:
        from agent.plugin_llm import PluginLlm
        if isinstance(llm, PluginLlm):
            class MonitoredLlm(PluginLlm):
                def _invoke_sync(self, kw):
                    with ingestion_accounting():
                        provider, model, response = llm._invoke_sync(kw)
                    finish_ingestion(response, provider, reference, kw.get("task"))
                    return provider, model, response

                async def _invoke_async(self, kw):
                    with ingestion_accounting():
                        provider, model, response = await llm._invoke_async(kw)
                    finish_ingestion(response, provider, reference, kw.get("task"))
                    return provider, model, response
            return MonitoredLlm(plugin_id=llm._plugin_id, policy_loader=llm._policy_loader)
    except ImportError:
        pass
    # Standalone clients report raw usage before parsing, with job attribution.
    import copy
    client = copy.copy(llm)
    client._usage_reference = reference
    return client


class Collector:
    def __init__(self, directory=None, home=None):
        self.directory = Path(directory or root())
        self.home = Path(home or os.environ.get("HERMES_HOME", "/opt/data"))
        self.stop_event = threading.Event()

    def import_hermes(self, db):
        path = self.home / "state.db"
        if not path.exists():
            return
        started = float(db.execute("SELECT value FROM usage_meta WHERE key='started_at'").fetchone()[0])
        source = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)
        source.row_factory = sqlite3.Row
        try:
            rows = source.execute("SELECT u.*, s.source AS session_source FROM session_model_usage u LEFT JOIN sessions s ON s.id=u.session_id ORDER BY u.last_seen DESC LIMIT 10000").fetchall()
        finally:
            source.close()
        for row in rows:
            row = dict(row)
            # The job-local observer suppresses Hermes accounting only for calls
            # it owns. Rows present here are fallback/legacy ingestion usage.
            ingestion = row.get("task") in ("openlia_ingestion_ocr", "openlia_document_tagger")
            identity = json.dumps([row.get(k) for k in ("session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task")])
            legacy_key = hashlib.sha256(identity.encode()).hexdigest()
            key = source_key(row)
            old = db.execute("SELECT counters FROM usage_checkpoints WHERE id=?", (key,)).fetchone()
            if old is None:
                old = db.execute("SELECT counters FROM usage_checkpoints WHERE id=?", (legacy_key,)).fetchone()
            current = counters(row)
            previous = json.loads(old[0]) if old else {k: 0 for k in TOKENS}
            delta = {k: max(0, current[k] - previous[k]) for k in TOKENS}
            # High-water marks tolerate restoring an older Hermes DB without replaying spend.
            high = {k: max(current[k], previous[k]) for k in TOKENS}
            cost = max(0, float(row.get("estimated_cost_usd") or 0))
            old_cost = previous.get("cost", 0)
            high["cost"] = max(cost, old_cost)
            actual = row.get("actual_cost_usd")
            high["provider_cost"] = max(float(actual or 0), previous.get("provider_cost", 0))
            ownership = db.execute("SELECT value FROM usage_meta WHERE key='ingestion_ownership_since'").fetchone() if ingestion else None
            if ingestion and not old and ownership and float(row.get("first_seen") or 0) < float(ownership[0]):
                # Earlier releases explicitly recorded these rows but had no
                # ownership checkpoints. Baseline legacy rows once on upgrade.
                db.execute("INSERT OR REPLACE INTO usage_checkpoints VALUES (?,?)", (key,json.dumps(high)))
                continue
            if any(delta.values()) or cost > old_cost or high["provider_cost"] > previous.get("provider_cost",0):
                event_id = key + ":" + hashlib.sha256(json.dumps(high, sort_keys=True).encode()).hexdigest()
                historical = not old and float(row.get("first_seen") or 0) < started
                session_source = row.get("session_source") or ""
                migration = session_source == "openlia-migration" or session_source.startswith("openlia-migration:")
                reference = session_source.removeprefix("openlia-migration:") if session_source.startswith("openlia-migration:") else row.get("session_id")
                insert_event(db, dict(id=event_id, activity="ingestion" if ingestion else "migration" if migration else "hermes", provider=row.get("billing_provider"),
                    model=row.get("model"), timestamp=time.time(), historical=historical,
                    reference=reference, tokens=delta, complete=True,
                    provider_cost=max(0, float(actual)-previous.get("provider_cost",0)) if actual is not None else None,
                    fallback_cost=max(0, cost-old_cost) if row.get("cost_status") in ("estimated", "actual", "included") else None))
            db.execute("INSERT OR REPLACE INTO usage_checkpoints VALUES (?,?)", (key, json.dumps(high)))
        db.execute("INSERT OR REPLACE INTO usage_meta VALUES ('hermes_updated_at',?)", (str(time.time()),))

    def import_reports(self, db):
        reports = self.directory / "reports"
        if not reports.exists():
            return
        for path in list(reports.glob("*.json"))[:1000]:
            if path.is_symlink() or path.stat().st_size > 65536:
                continue
            try:
                report = json.loads(path.read_text())
                if not isinstance(report, dict):
                    raise ValueError("invalid usage report")
                if report.get("cumulative"):
                    shared = report.get("source_checkpoint")
                    key = shared if isinstance(shared,str) and len(shared)==64 and all(c in "0123456789abcdef" for c in shared) else "report:" + str(report["id"])
                    old = db.execute("SELECT counters FROM usage_checkpoints WHERE id=?", (key,)).fetchone()
                    previous = json.loads(old[0]) if old else {}
                    current = counters(report.get("tokens") or {})
                    delta = {k: max(0, current[k]-previous.get(k, 0)) for k in TOKENS}
                    high = {k: max(current[k], previous.get(k, 0)) for k in TOKENS}
                    cost = report.get("fallback_cost")
                    high["cost"] = max(cost or 0, previous.get("cost", 0))
                    actual = report.get("provider_cost")
                    high["provider_cost"] = max(actual or 0, previous.get("provider_cost",0))
                    report["tokens"] = delta
                    report["fallback_cost"] = max(0, cost-previous.get("cost",0)) if cost is not None else None
                    report["provider_cost"] = max(0, actual-previous.get("provider_cost",0)) if actual is not None else None
                    report["id"] = key + ":" + hashlib.sha256(json.dumps(high,sort_keys=True).encode()).hexdigest()
                    if any(delta.values()) or (cost or 0) > previous.get("cost",0) or (actual or 0) > previous.get("provider_cost",0):
                        insert_event(db, report)
                    db.execute("INSERT OR REPLACE INTO usage_checkpoints VALUES (?,?)", (key,json.dumps(high)))
                else:
                    insert_event(db, report)
                db.commit()  # acknowledge only after durable import; IDs make retries harmless
                path.unlink()
            except (OSError, ValueError, KeyError, TypeError, OverflowError, sqlite3.Error):
                db.rollback()
                LOG.warning("Could not import usage report %s", path.name)

    def refresh_prices(self, db):
        from agent.usage_pricing import get_pricing_entry
        # Public metadata from the configured endpoint is usable without storing
        # its URL/credentials. Do not replay arbitrary historical endpoint URLs.
        configured_model = {}
        try:
            from hermes_cli.config import load_config_readonly
            configured_model = (load_config_readonly() or {}).get("model") or {}
            if not isinstance(configured_model, dict):
                configured_model = {}
        except Exception:
            pass
        rows = db.execute("""SELECT DISTINCT e.provider,e.model FROM usage_events e
            LEFT JOIN usage_prices p USING(provider,model)
            WHERE p.checked_at IS NULL OR p.checked_at < ? LIMIT 25""", (time.time()-86400,)).fetchall()
        for provider, model in rows:
            try:
                endpoint = configured_model.get("base_url") if configured_model.get("provider") == provider else None
                entry = get_pricing_entry(model, provider=provider, **({"base_url": endpoint} if endpoint else {}))
                if entry is None and db.execute("SELECT 1 FROM usage_prices WHERE provider=? AND model=? AND rates IS NOT NULL", (provider,model)).fetchone():
                    db.execute("UPDATE usage_prices SET error=1,checked_at=? WHERE provider=? AND model=?", (time.time(),provider,model))
                    continue
                names = ("input_cost_per_million", "output_cost_per_million", "cache_read_cost_per_million", "cache_write_cost_per_million")
                rates = {k: format(getattr(entry, name), "f") if getattr(entry, name, None) is not None else None for k, name in zip(TOKENS, names)} if entry else None
                # A flat rate would misrepresent context-tiered pricing; keep the Hermes estimate.
                if entry and getattr(entry, "tier_threshold_tokens", None):
                    rates = None
                db.execute("INSERT OR REPLACE INTO usage_prices VALUES (?,?,?,?,?,0)",
                    (provider, model, json.dumps(rates) if rates else None, str(entry.source) if entry else "unavailable", time.time()))
            except Exception:
                db.execute("""INSERT INTO usage_prices VALUES (?,?,NULL,'unavailable',?,1)
                    ON CONFLICT(provider,model) DO UPDATE SET error=1,checked_at=excluded.checked_at""", (provider,model,time.time()))
                LOG.warning("Usage pricing refresh unavailable for %s", model)
            finally:
                # Never hold a SQLite write lock across the next network lookup.
                db.commit()

    def tick(self):
        with connect(self.directory) as db:
            self.import_reports(db)
            try:
                self.import_hermes(db)
                db.execute("DELETE FROM usage_meta WHERE key='collection_error'")
            except Exception:
                db.execute("INSERT OR REPLACE INTO usage_meta VALUES ('collection_error','Hermes statistics temporarily unavailable')")
                LOG.warning("Hermes usage import unavailable", exc_info=True)
            db.commit()
            try:
                self.refresh_prices(db)
            except ImportError:
                pass
            db.execute("INSERT OR REPLACE INTO usage_meta VALUES ('updated_at',?)", (str(time.time()),))

    def run(self):
        # Several Hermes CLI processes can load plugins concurrently. Only the
        # gateway/one process owns collection; short-lived callers never race it.
        import fcntl
        self.directory.mkdir(parents=True, exist_ok=True)
        lock = open(self.directory / "collector.lock", "a")
        while not self.stop_event.is_set():
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                self.stop_event.wait(60)
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                LOG.warning("Usage collector temporarily unavailable", exc_info=True)
            self.stop_event.wait(60)
        lock.close()

    def start(self):
        self.thread = threading.Thread(target=self.run, name="openlia-usage", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=3)
