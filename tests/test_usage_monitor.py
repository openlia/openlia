"""Usage collection contract tests; no Hermes installation or provider calls."""
import importlib.util
import json
import os
import sqlite3
import tempfile
import time
import unittest
import asyncio
from contextvars import ContextVar
from dataclasses import dataclass
from decimal import Decimal
from types import ModuleType, SimpleNamespace
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("openlia_usage", Path(__file__).resolve().parents[1] / "docker/openlia_usage.py")
usage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(usage)


@contextmanager
def source_db(path):
    db = sqlite3.connect(path)
    try:
        with db:
            yield db
    finally:
        db.close()


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.root = self.home / "usage"
        self.collector = usage.Collector(self.root, self.home)
        with usage.connect(self.root):
            pass
        with source_db(self.home / "state.db") as db:
            db.executescript("""
              CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT);
              INSERT INTO sessions VALUES ('s','telegram'),('m','openlia-migration');
              CREATE TABLE session_model_usage (
                session_id TEXT,model TEXT,billing_provider TEXT,billing_base_url TEXT,
                billing_mode TEXT,task TEXT,input_tokens INTEGER,output_tokens INTEGER,
                cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,
                estimated_cost_usd REAL,cost_status TEXT,first_seen REAL,last_seen REAL);
            """)

    def tearDown(self):
        self.temp.cleanup()

    def row(self, session="s", task="", first=1):
        with source_db(self.home / "state.db") as db:
            db.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (session,"model","provider","https://proxy.invalid?api_key=secret","api",task,100,20,80,0,10,0.2,"estimated",first,time.time()))

    def events(self):
        with usage.connect(self.root) as db:
            return db.execute("SELECT activity,tokens,historical FROM usage_events").fetchall()

    def poll(self):
        with usage.connect(self.root) as db:
            self.collector.import_hermes(db)

    def test_idempotent_import_and_restore_high_water(self):
        self.row()
        self.poll(); self.poll()
        self.assertEqual(len(self.events()),1)
        self.assertEqual(self.events()[0][2],1)
        with source_db(self.home / "state.db") as db:
            db.execute("UPDATE session_model_usage SET input_tokens=150")
        self.poll()
        self.assertEqual(json.loads(self.events()[1][1])["input_tokens"],50)
        with source_db(self.home / "state.db") as db:
            db.execute("UPDATE session_model_usage SET input_tokens=100")
        self.poll()
        with source_db(self.home / "state.db") as db:
            db.execute("UPDATE session_model_usage SET input_tokens=150")
        self.poll()
        self.assertEqual(len(self.events()),2)

    def test_category_ownership_and_no_sensitive_metadata(self):
        self.row();self.row("m");self.row(task="openlia_ingestion_ocr");self.row(task="openlia_document_tagger")
        self.poll()
        self.assertEqual(sorted(e[0] for e in self.events()),["hermes","ingestion","ingestion","migration"])
        with usage.connect(self.root) as db:
            self.assertNotIn("secret",str(db.execute("SELECT * FROM usage_events").fetchall()))
            self.assertNotIn("proxy.invalid",str(db.execute("SELECT * FROM usage_checkpoints").fetchall()))

    def report(self, name="run", amount=100, cumulative=True):
        reports=self.root/"reports";reports.mkdir(exist_ok=True)
        path=reports/f"{time.time_ns()}.json"
        path.write_text(json.dumps(dict(id=name,activity="migration",provider="p",model="m",cumulative=cumulative,tokens={"input_tokens":amount},complete=True)))
        with usage.connect(self.root) as db:
            self.collector.import_reports(db)

    def test_cumulative_migration_reports_out_of_order(self):
        self.report(amount=150);self.report(amount=100);self.report(amount=150);self.report(amount=200)
        self.assertEqual(sum(json.loads(e[1])["input_tokens"] for e in self.events()),200)
        self.assertEqual(list((self.root/"reports").glob("*.json")),[])

    def test_event_report_replay(self):
        self.report(cumulative=False);self.report(cumulative=False)
        self.assertEqual(len(self.events()),1)

    def test_new_rows_have_observation_date_not_historical(self):
        self.row(first=time.time()+1);self.poll()
        self.assertEqual(self.events()[0][2],0)

    def test_bad_report_is_retained(self):
        reports=self.root/"reports";reports.mkdir()
        (reports/"broken.json").write_text("not json")
        with usage.connect(self.root) as db:self.collector.import_reports(db)
        self.assertTrue((reports/"broken.json").exists())

    def test_unknown_usage_not_zero_known(self):
        with usage.connect(self.root) as db:
            usage.insert_event(db,dict(id="missing",activity="ingestion",complete=False))
            row=db.execute("SELECT complete,fallback_cost FROM usage_events").fetchone()
            self.assertEqual(row,(0,None))

    def test_prices_cached_and_last_known_retained(self):
        self.row();self.poll()
        pricing = ModuleType("agent.usage_pricing")
        entry = SimpleNamespace(input_cost_per_million=Decimal("0.00001"),output_cost_per_million=Decimal("2"),cache_read_cost_per_million=Decimal("0.1"),cache_write_cost_per_million=None,source="official_docs_snapshot")
        pricing.get_pricing_entry = lambda *a,**kw:entry
        with patch.dict("sys.modules", {"agent":ModuleType("agent"),"agent.usage_pricing":pricing}):
            with usage.connect(self.root) as db:
                self.collector.refresh_prices(db)
                first=db.execute("SELECT rates FROM usage_prices").fetchone()[0]
                self.assertEqual(json.loads(first)["input_tokens"],"0.00001")
                def fail(*args,**kwargs):raise RuntimeError("offline")
                pricing.get_pricing_entry=fail
                # Fresh cache: resolver is not consulted.
                self.collector.refresh_prices(db)
                self.assertEqual(db.execute("SELECT error FROM usage_prices").fetchone()[0],0)
                db.execute("UPDATE usage_prices SET checked_at=0")
                self.collector.refresh_prices(db)
                self.assertEqual(db.execute("SELECT rates,error FROM usage_prices").fetchone(),(first,1))
                pricing.get_pricing_entry=lambda *a,**kw:None
                db.execute("UPDATE usage_prices SET checked_at=0")
                self.collector.refresh_prices(db)
                self.assertEqual(db.execute("SELECT rates,error FROM usage_prices").fetchone(),(first,1))

    def test_provider_cost_is_preserved_even_when_reported_later(self):
        self.row()
        with source_db(self.home/"state.db") as db:db.execute("ALTER TABLE session_model_usage ADD COLUMN actual_cost_usd REAL")
        self.poll()
        with source_db(self.home/"state.db") as db:db.execute("UPDATE session_model_usage SET actual_cost_usd=0.15")
        self.poll();self.poll()
        with usage.connect(self.root) as db:
            self.assertAlmostEqual(db.execute("SELECT SUM(provider_cost) FROM usage_events").fetchone()[0],0.15)
            self.assertAlmostEqual(db.execute("SELECT SUM(fallback_cost) FROM usage_events").fetchone()[0],0.2)

    def test_ingestion_observed_before_parsing_failure(self):
        @dataclass
        class Canonical:
            input_tokens: int = 100
            output_tokens: int = 20
        pricing=ModuleType("agent.usage_pricing")
        pricing.normalize_usage=lambda raw,**kw:Canonical()
        facade=ModuleType("agent.plugin_llm")
        class PluginLlm:
            def __init__(self, plugin_id="ingestion",policy_loader=None):
                self._plugin_id=plugin_id;self._policy_loader=policy_loader
            def _invoke_sync(self, kw):
                return "openai","model",SimpleNamespace(model="model",usage={"prompt_tokens":100,"completion_tokens":20})
            def complete_structured(self):
                self._invoke_sync({"task":"openlia_document_tagger"})
                raise ValueError("invalid JSON response")
        facade.PluginLlm=PluginLlm
        with patch.dict("sys.modules",{"agent":ModuleType("agent"),"agent.usage_pricing":pricing,"agent.plugin_llm":facade}),patch.dict(os.environ,{"OPENLIA_USAGE_ROOT":str(self.root)}):
            client=PluginLlm()
            observed=usage.monitored_llm(client,"intake-1")
            self.assertIsNot(observed,client)
            with self.assertRaises(ValueError):observed.complete_structured()
            with usage.connect(self.root) as db:
                self.assertEqual(db.execute("SELECT activity,reference,complete FROM usage_events").fetchone(),("ingestion","intake-1",1))
            with self.assertRaises(ValueError):client.complete_structured()
            self.assertEqual(len(self.events()),1)  # original facade was not patched

    def test_ingestion_spools_when_sqlite_is_unavailable(self):
        with patch.dict(os.environ,{"OPENLIA_USAGE_ROOT":str(self.root)}), patch.object(usage,"connect",side_effect=sqlite3.OperationalError("locked")):
            self.assertTrue(usage.record_response(SimpleNamespace(model="model",usage=None),reference="intake-locked"))
        reports=list((self.root/"reports").glob("*.json"))
        self.assertEqual(len(reports),1)
        with usage.connect(self.root) as db:
            self.collector.import_reports(db)
            row=db.execute("SELECT reference,complete,tokens FROM usage_events").fetchone()
            self.assertEqual(row,("intake-locked",0,"{}"))

    def test_real_locked_usage_db_does_not_block_ingestion(self):
        with source_db(self.root/"usage.sqlite") as blocker:
            blocker.execute("BEGIN IMMEDIATE")
            start=time.monotonic()
            with patch.dict(os.environ,{"OPENLIA_USAGE_ROOT":str(self.root)}):
                self.assertTrue(usage.record_response(SimpleNamespace(model="model",usage=None),reference="locked"))
            self.assertLess(time.monotonic()-start,1)
            self.assertEqual(len(list((self.root/"reports").glob("*.json"))),1)
        with usage.connect(self.root) as db:
            self.collector.import_reports(db)
            self.assertEqual(db.execute("SELECT reference FROM usage_events").fetchall(),[("locked",)])

    def test_ingestion_fallback_and_async_single_ownership(self):
        accounting=ModuleType("agent.aux_accounting")
        active=ContextVar("test_accounting",default=True)
        accounting.set_accounting_context=lambda *args:active.set(False)
        accounting.reset_accounting_context=active.reset
        def record(*args,**kwargs):
            if active.get():self.row(task="openlia_ingestion_ocr",first=time.time()+1)
        accounting.record_aux_usage=record
        facade=ModuleType("agent.plugin_llm")
        response=SimpleNamespace(model="model",usage={"prompt_tokens":100,"completion_tokens":20})
        class PluginLlm:
            def __init__(self,plugin_id="ingestion",policy_loader=None):
                self._plugin_id=plugin_id;self._policy_loader=policy_loader
            def _invoke_sync(self,kw):
                record(response,kw["task"])
                return "provider","model",response
            async def _invoke_async(self,kw):
                await asyncio.sleep(0)
                return self._invoke_sync(kw)
        facade.PluginLlm=PluginLlm
        with patch.dict("sys.modules",{"agent":ModuleType("agent"),"agent.aux_accounting":accounting,"agent.plugin_llm":facade}),patch.dict(os.environ,{"OPENLIA_USAGE_ROOT":str(self.root)}):
            observed=usage.monitored_llm(PluginLlm(),"intake-async")
            # Both durable paths unavailable: restored ambient Hermes context owns fallback.
            with patch.object(usage,"record_response",return_value=False):
                observed._invoke_sync({"task":"openlia_ingestion_ocr"})
            self.poll()
            self.assertEqual([row[0] for row in self.events()],["ingestion"])
            # Success suppresses ambient accounting during the async request.
            with patch.object(usage,"record_response",return_value=True) as recorder:
                asyncio.run(observed._invoke_async({"task":"openlia_ingestion_ocr"}))
                recorder.assert_called_once()
            self.poll()
            self.assertEqual(len(self.events()),1)
            self.assertTrue(active.get())

    def test_shared_migration_report_and_poll_are_not_double_counted(self):
        self.row(session="m",first=time.time()+1)
        with source_db(self.home/"state.db") as db:
            db.execute("UPDATE sessions SET source='openlia-migration:migration-id' WHERE id='m'")
        source={"session_id":"m","model":"model","billing_provider":"provider","billing_base_url":"https://proxy.invalid?api_key=secret","billing_mode":"api","task":""}
        self.poll()
        report=dict(id="handoff",source_checkpoint=usage.source_key(source),cumulative=True,activity="migration",provider="provider",model="model",reference="migration-id",tokens={"input_tokens":100,"output_tokens":20,"cache_read_tokens":80,"reasoning_tokens":10},complete=True,fallback_cost=0.2)
        reports=self.root/"reports";reports.mkdir()
        (reports/"handoff.json").write_text(json.dumps(report))
        with usage.connect(self.root) as db:
            self.collector.import_reports(db)
            self.assertEqual(db.execute("SELECT reference FROM usage_events").fetchall(),[("migration-id",)])
        self.poll()
        self.assertEqual(len(self.events()),1)
        # Now reverse the order for a subsequent increment: report first, poll second.
        report["tokens"]["input_tokens"]=150
        report["fallback_cost"]=0.3
        (reports/"next.json").write_text(json.dumps(report))
        with usage.connect(self.root) as db:self.collector.import_reports(db)
        with source_db(self.home/"state.db") as db:db.execute("UPDATE session_model_usage SET input_tokens=150,estimated_cost_usd=0.3")
        self.poll()
        self.assertEqual(sum(json.loads(row[1])["input_tokens"] for row in self.events()),150)

    def test_v1_schema_upgrade_preserves_overrides_and_baselines_ingestion(self):
        legacy=Path(self.temp.name)/"legacy";legacy.mkdir()
        with source_db(legacy/"usage.sqlite") as db:
            db.executescript(usage.SCHEMA.replace(", provider_cost REAL", ""))
            db.execute("INSERT INTO usage_meta VALUES ('started_at','1')")
            db.execute("INSERT INTO usage_overrides VALUES ('p','m','{}')")
        self.row(task="openlia_ingestion_ocr")
        with usage.connect(legacy) as db:
            self.assertIn("provider_cost",{row[1] for row in db.execute("PRAGMA table_info(usage_events)")})
            self.assertEqual(db.execute("SELECT rates FROM usage_overrides").fetchone()[0],"{}")
            usage.Collector(legacy,self.home).import_hermes(db)
            self.assertEqual(db.execute("SELECT count(*) FROM usage_events").fetchone()[0],0)
        with source_db(self.home/"state.db") as db:db.execute("UPDATE session_model_usage SET input_tokens=150")
        with usage.connect(legacy) as db:
            usage.Collector(legacy,self.home).import_hermes(db)
            self.assertEqual(json.loads(db.execute("SELECT tokens FROM usage_events").fetchone()[0])["input_tokens"],50)


if __name__ == "__main__":
    unittest.main()
