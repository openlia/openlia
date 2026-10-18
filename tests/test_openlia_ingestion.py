from __future__ import annotations

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = REPO_ROOT / "profile/plugins/openlia-ingestion"
FIXTURES_DIR = REPO_ROOT / "tests/fixtures/ingestion"
TEST_DOC_KEY = "openlia"
WRONG_DOC_KEY = "wrong"


def load_plugin_package():
    name = "openlia_ingestion_test"
    spec = importlib.util.spec_from_file_location(
        name,
        PLUGIN_ROOT / "__init__.py",
        submodule_search_locations=[str(PLUGIN_ROOT)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return name


class MockVisionResult:
    def __init__(self, text: str, warnings: list[str] | None = None):
        self.parsed = {"text": text, "warnings": warnings or []}


class MockVisionLLM:
    def __init__(self, text: str = "Extracted document OCR text", warnings: list[str] | None = None):
        self.text = text
        self.warnings = warnings or []
        self.calls = []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        return MockVisionResult(self.text, self.warnings)


class MockMetadataLLM:
    def __init__(self, parsed):
        self.parsed = parsed
        self.calls = []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        return type("MetadataResult", (), {"parsed": self.parsed})()


class MockHermesContext:
    def __init__(self, llm=None):
        self.tools = {}
        self.llm = llm
        self.injected_messages = []
        self.configs = {"max_concurrent_jobs": 1}

    def register_tool(self, name, toolset, schema, handler, is_async, description):
        self.tools[name] = handler

    def register_auxiliary_task(self, name, display_name, description, defaults):
        pass

    def get_config(self, key, default):
        return self.configs.get(key, default)

    def inject_message(self, message, role="user", session_key=None):
        self.injected_messages.append({"message": message, "role": role, "session_key": session_key})
        return True


class IngestionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.workspace = self.root / "workspace"
        self.runtime_dir = self.root / "runtime"
        self.ingestion_dir = self.runtime_dir / "ingestion"
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.ingestion_dir.mkdir(parents=True, exist_ok=True)

        os.environ["HERMES_HOME"] = str(self.runtime_dir)
        os.environ["OPENLIA_WORKSPACE_ROOT"] = str(self.workspace)
        os.environ["OPENLIA_UPLOAD_ROOT"] = str(self.root)

        self.package = load_plugin_package()
        self.publication = sys.modules[f"{self.package}.publication"]
        self.queue_mod = sys.modules[f"{self.package}.queue"]
        self.passwords_mod = sys.modules[f"{self.package}.passwords"]
        self.adapters = sys.modules[f"{self.package}.adapters"]
        self.metadata = importlib.import_module(f"{self.package}.metadata")
        self.runtime_mod = sys.modules[f"{self.package}.runtime"]

        self.publisher = self.publication.WorkspacePublisher(self.workspace)
        self.queue = self.queue_mod.IngestionQueue(self.ingestion_dir)
        self.passwords = self.passwords_mod.PasswordProfiles(self.workspace)

    def tearDown(self):
        os.environ.pop("HERMES_HOME", None)
        os.environ.pop("OPENLIA_WORKSPACE_ROOT", None)
        os.environ.pop("OPENLIA_UPLOAD_ROOT", None)
        self.tempdir.cleanup()

    def _copy_fixture(self, name: str) -> Path:
        source = FIXTURES_DIR / name
        self.assertTrue(source.exists(), f"Fixture file {name} is missing")
        target = self.root / name
        shutil.copy2(source, target)
        return target

    def test_metadata_extraction_preserves_custom_document_type(self):
        llm = MockMetadataLLM(
            {
                "title": "April 2021 Payslip",
                "document_type": "payslip",
                "correspondent": None,
                "document_date": None,
                "tags": ["finance", "payroll"],
                "summary": "Monthly payslip.",
                "review_reasons": [],
            }
        )

        result = self.metadata.extract_document_metadata(
            llm, "Monthly payroll statement for April 2021", "payslip.pdf", "pdf"
        )

        self.assertEqual(result["document_type"], "payslip")
        self.assertNotIn("enum", llm.calls[0]["json_schema"]["properties"]["document_type"])

    # =========================================================================
    # Queue, Leases, and Continuation Tests
    # =========================================================================

    @unittest.skipUnless(shutil.which("bun"), "Bun is required for UI/worker integration")
    def test_ui_upload_is_processed_by_worker_in_either_startup_order(self):
        for worker_first in (True, False):
            with self.subTest(worker_first=worker_first):
                ingestion_dir = self.root / ("worker-first" if worker_first else "ui-first")
                if worker_first:
                    self.queue_mod.IngestionQueue(ingestion_dir)
                script = f"""
                    import {{ IngestionService }} from './packages/workspace-ui/src/server/ingestion.ts';
                    const service = new IngestionService({{
                        workspaceRoot: {json.dumps(str(self.workspace))},
                        ingestionRoot: {json.dumps(str(ingestion_dir))},
                    }});
                    console.log(JSON.stringify(service.upload({{
                        name: 'agreement.txt',
                        data: new TextEncoder().encode('Service agreement terms for 2026'),
                    }})));
                """
                completed = subprocess.run(
                    ["bun", "-e", script], cwd=REPO_ROOT,
                    capture_output=True, text=True, check=True,
                )
                uploaded = json.loads(completed.stdout)
                queue = self.queue_mod.IngestionQueue(ingestion_dir)
                publisher = self.publication.VaultStore(ingestion_dir, workspace_root=self.workspace)
                job = queue.claim("integration-worker")
                self.assertIsNotNone(job)
                self.assertEqual(job["job_id"], uploaded["job_id"])
                self.assertEqual(job["lease_generation"], 1)
                intake = publisher.load_intake(job["intake_id"])
                self.assertEqual(intake["source_id"], uploaded["source_id"])
                self.assertEqual(intake["status"], "queued")
                result = self.adapters.process_job(
                    job, publisher, self.passwords, None, db=queue,
                )
                self.assertEqual(result["status"], "completed")
                self.assertIsNotNone(queue.finish(job, result))
                source = publisher.load_source(uploaded["source_id"])
                self.assertEqual(source["processing"]["status"], "complete")
                self.assertTrue(source["versions"][0]["extractions"])
                self.assertEqual(queue.get(job["job_id"])["state"], "completed")
                # Zero workspace footprint check
                self.assertFalse((self.workspace / "sources").exists())
                self.assertFalse((self.workspace / "inbox" / "ingestion").exists())

    @unittest.skipUnless(shutil.which("bun"), "Bun is required for UI/worker integration")
    def test_ui_created_legacy_database_gains_worker_lease_fence(self):
        import sqlite3

        ingestion_dir = self.root / "legacy-ui"
        ingestion_dir.mkdir()
        with sqlite3.connect(ingestion_dir / "queue.sqlite") as db:
            db.execute("""CREATE TABLE jobs (
                job_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE,
                intake_id TEXT, source_id TEXT, version_id TEXT, operation TEXT,
                requested_outputs TEXT, state TEXT, lease_owner TEXT,
                lease_expires_at REAL, attempts INTEGER, next_attempt_at REAL,
                error_code TEXT, error_summary TEXT, password_profile TEXT,
                continuation TEXT, result TEXT, heartbeat_at REAL,
                created_at REAL, updated_at REAL
            )""")
        subprocess.run(
            ["bun", "-e", f"""
                import {{ IngestionService }} from './packages/workspace-ui/src/server/ingestion.ts';
                new IngestionService({{
                    workspaceRoot: {json.dumps(str(self.workspace))},
                    ingestionRoot: {json.dumps(str(ingestion_dir))},
                }}).upload({{ name: 'legacy.txt', data: new TextEncoder().encode('Legacy queue') }});
            """], cwd=REPO_ROOT, capture_output=True, text=True, check=True,
        )
        queue = self.queue_mod.IngestionQueue(ingestion_dir)
        job = queue.claim("legacy-worker")
        self.assertIsNotNone(job)
        self.assertEqual(job["lease_generation"], 1)

    def test_capture_and_idempotent_submission(self):
        captured = self.publisher.capture(
            {"kind": "text", "title": "Example", "content": "one\ntwo"}
        )
        request = {
            "idempotency_key": "same-request",
            "intake_id": captured["intake"]["intake_id"],
            "source_id": captured["source"]["id"],
            "version_id": captured["version"]["id"],
            "operation": "extract",
            "requested_outputs": ["text"],
            "continuation": {},
        }
        first = self.queue.submit(request)
        second = self.queue.submit(request)
        self.assertEqual(first["job_id"], second["job_id"])
        self.assertTrue(
            (self.ingestion_dir / "blobs" / captured["source"]["id"] / captured["version"]["id"] / "original.txt").exists()
        )
        self.assertFalse((self.workspace / "sources").exists())

    def test_idempotency_includes_continuation_context(self):
        runtime = self.runtime_mod.IngestionRuntime(MockHermesContext())
        first = json.loads(runtime.capture({"kind": "text", "content": "same content", "next_action": "create task"}))
        second = json.loads(runtime.capture({"kind": "text", "content": "same content", "next_action": "review finance"}))
        self.assertNotEqual(first["job_id"], second["job_id"])

    def test_lease_generation_fences_second_worker(self):
        captured = self.publisher.capture(
            {"kind": "text", "title": "Example", "content": "one"}
        )
        self.queue.submit(
            {
                "idempotency_key": "lease",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "requested_outputs": ["text"],
                "continuation": {},
            }
        )
        claimed = self.queue.claim("worker-a")
        self.assertIsNotNone(claimed)
        self.assertTrue(self.queue.heartbeat(claimed["job_id"], "worker-a", claimed["lease_generation"]))
        self.assertFalse(self.queue.heartbeat(claimed["job_id"], "worker-b", claimed["lease_generation"]))

    def test_vault_sqlite_source_and_version_persistence(self):
        captured = self.publisher.capture(
            {"kind": "text", "title": "Persistent Vault Doc", "content": "vault content"}
        )
        source_id = captured["source"]["id"]
        loaded = self.publisher.load_source(source_id)
        self.assertEqual(loaded["title"], "Persistent Vault Doc")
        self.assertEqual(len(loaded["versions"]), 1)
        self.assertFalse((self.workspace / "sources").exists())

    def test_password_profile_never_returns_value_from_listing(self):
        result = self.passwords.save("bank_a", "Bank A statement", TEST_DOC_KEY)  # ggignore
        self.assertEqual(result["profile_id"], "bank_a")
        self.assertEqual(self.passwords.resolve("bank_a"), TEST_DOC_KEY)
        self.assertEqual(self.passwords.list(), [{"profile_id": "bank_a", "label": "Bank A statement"}])
        mode = stat.S_IMODE(self.passwords.path.stat().st_mode)
        self.assertEqual(mode, 0o600)
        self.assertEqual(self.passwords.path.parent, self.ingestion_dir.resolve())
        self.assertFalse((self.workspace / "sources" / "document-passwords.toml").exists())
        self.assertNotIn(TEST_DOC_KEY, str(self.passwords.list()))

    # =========================================================================
    # Supported File Formats Tests (Fixtures)
    # =========================================================================

    def test_text_fixture_extraction(self):
        fixture_path = self._copy_fixture("sample.txt")
        captured = self.publisher.capture(
            {"kind": "text", "title": "Text Note", "file_path": str(fixture_path)}
        )
        job = self.queue.submit(
            {
                "idempotency_key": "job-text-file",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "requested_outputs": ["text"],
                "continuation": {},
            }
        )
        claimed = self.queue.claim("worker-text")
        result = self.adapters.process_job(claimed, self.publisher, self.passwords, None)
        self.assertEqual(result["status"], "completed")
        self.assertGreater(result["summary"]["lines"], 3)

        # Check extracted markdown artifact in Vault blobs
        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/text.md"))
        self.assertTrue(len(extraction_file) == 1)
        self.assertIn("Hermes Agent ingestion runtime", extraction_file[0].read_text(encoding="utf-8"))

    def test_job_uses_requested_version_instead_of_latest(self):
        captured = self.publisher.capture(
            {"kind": "text", "title": "Versioned text", "content": "old version"}
        )
        source = captured["source"]
        new_version_id = "ver_new"
        new_ref = f"blobs/{source['id']}/{new_version_id}/original.txt"
        self.publisher.publish_bytes(new_ref, b"new version")
        source["versions"].append(
            {
                "id": new_version_id,
                "original_artifact_id": "art_new",
                "content_sha256": "0" * 64,
                "media_type": "text/plain",
                "original_ref": new_ref,
                "received_at": source["captured_at"],
                "retained": True,
                "extractions": [],
            }
        )
        self.publisher.update_source(source)
        result = self.adapters._text(
            source,
            {},
            {"version_id": captured["version"]["id"], "continuation": {}},
            self.publisher,
        )
        self.assertEqual(result["status"], "completed")
        old_text = list(self.ingestion_dir.glob(f"blobs/{source['id']}/{captured['version']['id']}/extractions/*/text.md"))[0]
        self.assertEqual(old_text.read_text(encoding="utf-8"), "old version")

    def test_csv_fixture_extraction(self):
        fixture_path = self._copy_fixture("sample.csv")
        captured = self.publisher.capture(
            {"kind": "csv", "title": "Sample Expenses", "file_path": str(fixture_path)}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-csv",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "requested_outputs": ["tables"],
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-csv")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["summary"]["rows"], 4)  # header + 3 data rows

        # Check extracted JSON tables
        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/tables.json"))
        self.assertTrue(len(extraction_file) == 1)
        table_data = json.loads(extraction_file[0].read_text(encoding="utf-8"))
        self.assertEqual(table_data["delimiter"], ",")
        self.assertEqual(table_data["rows"][0]["values"], ["date", "category", "item", "amount", "currency"])

    def test_xlsx_fixture_extraction(self):
        fixture_path = self._copy_fixture("sample.xlsx")
        captured = self.publisher.capture(
            {"kind": "excel", "title": "Workbook", "file_path": str(fixture_path)}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-xlsx",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "requested_outputs": ["tables"],
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-xlsx")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["summary"]["sheets"], 2)

        # Check extracted JSON sheets
        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/tables.json"))
        self.assertTrue(len(extraction_file) == 1)
        data = json.loads(extraction_file[0].read_text(encoding="utf-8"))
        sheet_names = [s["name"] for s in data["sheets"]]
        self.assertEqual(sheet_names, ["Summary", "Expenses"])
        # Check formula preservation
        expenses_rows = data["sheets"][1]["rows"]
        total_row = expenses_rows[3]["values"]
        self.assertEqual(total_row[1]["formula"], "=SUM(B2:B3)")

    def test_xls_legacy_fixture_extraction(self):
        fixture_path = self._copy_fixture("sample.xls")
        captured = self.publisher.capture(
            {"kind": "excel", "title": "Legacy Workbook", "file_path": str(fixture_path)}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-xls",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "requested_outputs": ["tables"],
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-xls")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["summary"]["sheets"], 1)

        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/tables.json"))
        self.assertTrue(len(extraction_file) == 1)
        data = json.loads(extraction_file[0].read_text(encoding="utf-8"))
        self.assertEqual(data["sheets"][0]["name"], "Quarterly")
        self.assertEqual(data["sheets"][0]["rows"][0]["values"], ["Quarter", "Revenue"])

    def test_encrypted_xlsx_with_password_profile(self):
        fixture_path = self._copy_fixture("sample_protected.xlsx")
        self.passwords.save("excel_cred", "Quarterly secret", TEST_DOC_KEY)  # ggignore

        captured = self.publisher.capture(
            {"kind": "excel", "title": "Protected Workbook", "file_path": str(fixture_path), "password_profile": "excel_cred"}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-enc-xlsx",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "password_profile": "excel_cred",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-enc-xlsx")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(result["status"], "completed")

        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/tables.json"))
        self.assertTrue(len(extraction_file) == 1)
        data = json.loads(extraction_file[0].read_text(encoding="utf-8"))
        self.assertEqual(data["sheets"][0]["name"], "Confidential")
        self.assertEqual(data["sheets"][0]["rows"][1]["values"][0]["value"], "Checking")

    def test_encrypted_xlsx_missing_password_error(self):
        fixture_path = self._copy_fixture("sample_protected.xlsx")
        captured = self.publisher.capture(
            {"kind": "excel", "title": "Protected Workbook", "file_path": str(fixture_path)}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-enc-xlsx-nopass",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-enc-xlsx-nopass")
        with self.assertRaises(self.adapters.AdapterError) as ctx:
            self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(ctx.exception.code, "password_required")

    def test_encrypted_xlsx_wrong_password_error(self):
        fixture_path = self._copy_fixture("sample_protected.xlsx")
        self.passwords.save("wrong_cred", "Wrong password", WRONG_DOC_KEY)  # ggignore
        captured = self.publisher.capture(
            {"kind": "excel", "title": "Protected Workbook", "file_path": str(fixture_path), "password_profile": "wrong_cred"}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-enc-xlsx-wrong",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "password_profile": "wrong_cred",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-enc-xlsx-wrong")
        with self.assertRaises(self.adapters.AdapterError) as ctx:
            self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertIn(ctx.exception.code, {"password_invalid", "unlock_failed"})

    def test_text_pdf_fixture_extraction(self):
        fixture_path = self._copy_fixture("sample_text.pdf")
        captured = self.publisher.capture(
            {"kind": "pdf", "title": "PDF Report", "file_path": str(fixture_path)}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-pdf-text",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "requested_outputs": ["text"],
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-pdf")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(result["status"], "completed")

        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/text.md"))
        self.assertTrue(len(extraction_file) == 1)
        self.assertIn("Hermes Agent Ingestion Report", extraction_file[0].read_text(encoding="utf-8"))

    def test_encrypted_pdf_with_password_profile(self):
        fixture_path = self._copy_fixture("sample_protected.pdf")
        self.passwords.save("pdf_cred", "PDF unlock code", TEST_DOC_KEY)  # ggignore
        captured = self.publisher.capture(
            {"kind": "pdf", "title": "Encrypted PDF", "file_path": str(fixture_path), "password_profile": "pdf_cred"}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-pdf-enc",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "password_profile": "pdf_cred",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-pdf-enc")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(result["status"], "completed")

        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/text.md"))
        self.assertTrue(len(extraction_file) == 1)
        self.assertIn("Hermes Agent Ingestion Report", extraction_file[0].read_text(encoding="utf-8"))

    def test_encrypted_pdf_missing_password_error(self):
        fixture_path = self._copy_fixture("sample_protected.pdf")
        captured = self.publisher.capture(
            {"kind": "pdf", "title": "Encrypted PDF", "file_path": str(fixture_path)}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-pdf-enc-nopass",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-pdf-enc-nopass")
        with self.assertRaises(self.adapters.AdapterError) as ctx:
            self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(ctx.exception.code, "password_required")

    def test_scanned_pdf_vision_fallback(self):
        fixture_path = self._copy_fixture("sample_scanned.pdf")
        captured = self.publisher.capture(
            {"kind": "pdf", "title": "Scanned Document", "file_path": str(fixture_path)}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-scanned-pdf",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-scanned-pdf")
        mock_llm = MockVisionLLM(text="Scanned Invoice Line Items")
        result = self.adapters.process_job(job, self.publisher, self.passwords, mock_llm)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(mock_llm.calls), 2)
        self.assertEqual(mock_llm.calls[0].get("task"), "openlia_ingestion_ocr")
        self.assertEqual(mock_llm.calls[1].get("task"), "openlia_document_tagger")

        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/text.md"))
        self.assertTrue(len(extraction_file) == 1)
        self.assertIn("Scanned Invoice Line Items", extraction_file[0].read_text(encoding="utf-8"))

    def test_scanned_pdf_requires_vision_model(self):
        fixture_path = self._copy_fixture("sample_scanned.pdf")
        captured = self.publisher.capture(
            {"kind": "pdf", "title": "Scanned Document", "file_path": str(fixture_path)}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-scanned-pdf-nollm",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-scanned-pdf-nollm")
        with self.assertRaises(self.adapters.AdapterError) as ctx:
            self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(ctx.exception.code, "vision_unavailable")

    def test_mixed_pdf_ocr_only_fills_pages_without_text(self):
        fixture_path = self._copy_fixture("sample_text.pdf")
        source = self.publisher.capture({"kind": "pdf", "title": "Mixed PDF", "file_path": str(fixture_path)})["source"]
        published = []

        class ExtractionPublisher:
            def publish_extraction(self, *args, **kwargs):
                published.append(args)
                return {
                    "artifact_id": "art_mixed",
                    "extraction_id": "ext_mixed",
                    "warnings": [],
                    "complete": True,
                }

        publisher = ExtractionPublisher()
        mock_llm = MockVisionLLM(text="OCR page two")
        image_data = (FIXTURES_DIR / "sample.png").read_bytes()

        def mock_command(command, code):
            if command[0] == "pdftotext":
                return "Text page one\f"
            output = Path(command[-1] + ".png")
            output.write_bytes(image_data)
            return ""

        with patch.object(self.adapters, "_pdf_pages", return_value=2), patch.object(self.adapters, "_command", side_effect=mock_command):
            result = self.adapters._pdf(
                source,
                {},
                {"version_id": source["versions"][0]["id"], "continuation": {}},
                publisher,
                self.passwords,
                mock_llm,
            )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(mock_llm.calls), 1)
        self.assertEqual(len(published), 1)
        published_text = published[0][6].decode("utf-8")
        self.assertIn("## Page 1\n\nText page one", published_text)
        self.assertIn("## Page 2\n\nOCR page two", published_text)

    def test_image_png_and_jpg_extraction(self):
        mock_llm = MockVisionLLM(text="OpenLia Visual Capture: Total Due $99.95")
        for ext in ["sample.png", "sample.jpg"]:
            with self.subTest(file=ext):
                fixture_path = self._copy_fixture(ext)
                captured = self.publisher.capture(
                    {"kind": "image", "title": f"Image {ext}", "file_path": str(fixture_path)}
                )
                self.queue.submit(
                    {
                        "idempotency_key": f"job-img-{ext}",
                        "intake_id": captured["intake"]["intake_id"],
                        "source_id": captured["source"]["id"],
                        "version_id": captured["version"]["id"],
                        "operation": "extract",
                        "continuation": {},
                    }
                )
                job = self.queue.claim(f"worker-{ext}")
                result = self.adapters.process_job(job, self.publisher, self.passwords, mock_llm)
                self.assertEqual(result["status"], "completed")

                extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/text.md"))
                self.assertTrue(len(extraction_file) == 1)
                self.assertIn("Total Due $99.95", extraction_file[0].read_text(encoding="utf-8"))

    def test_generic_file_kind_dispatch(self):
        # A file captured with generic kind='file' should automatically resolve
        # to its proper adapter (e.g. PDF, CSV)
        fixture_path = self._copy_fixture("sample_text.pdf")
        captured = self.publisher.capture(
            {"kind": "file", "title": "Generic File PDF", "file_path": str(fixture_path)}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-generic-file",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-generic")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["extraction_refs"])

    # =========================================================================
    # YouTube Ingestion Tests (Offline & Live)
    # =========================================================================

    def test_youtube_offline_fixture_extraction(self):
        url = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        captured = self.publisher.capture({"kind": "youtube", "title": "Me at the zoo", "url": url})
        self.queue.submit(
            {
                "idempotency_key": "job-yt-offline",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["intake"]["version_id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-yt-offline")

        metadata_fixture = (FIXTURES_DIR / "sample_youtube_metadata.json").read_text(encoding="utf-8")
        vtt_fixture = (FIXTURES_DIR / "sample_subtitles.vtt").read_text(encoding="utf-8")

        def mock_command(command, code):
            if any("dump-single-json" in str(arg) for arg in command):
                return metadata_fixture
            return ""

        def mock_subprocess_run(command, *args, **kwargs):
            # When yt-dlp attempts to write subtitles into temporary directory, write fixture vtt
            out_pattern = None
            for idx, arg in enumerate(command):
                if arg == "--output" and idx + 1 < len(command):
                    out_pattern = command[idx + 1]
                    break
            if out_pattern:
                out_path = Path(out_pattern.replace("%(ext)s", "en.vtt"))
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(vtt_fixture, encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with patch.object(self.adapters, "_command", side_effect=mock_command), \
             patch.object(self.adapters.subprocess, "run", side_effect=mock_subprocess_run):
            result = self.adapters.process_job(job, self.publisher, self.passwords, None)

        self.assertEqual(result["status"], "completed")
        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/transcript.md"))
        self.assertTrue(len(extraction_file) == 1)
        transcript_content = extraction_file[0].read_text(encoding="utf-8")
        self.assertIn("Welcome to OpenLia", transcript_content)
        self.assertNotIn("WEBVTT", transcript_content)
        self.assertNotIn("Kind:", transcript_content)

    def test_youtube_missing_subtitles_partial_status(self):
        url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
        captured = self.publisher.capture({"kind": "youtube", "title": "Big Buck Bunny", "url": url})
        self.queue.submit(
            {
                "idempotency_key": "job-yt-nosubs",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["intake"]["version_id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-yt-nosubs")

        metadata_fixture = json.dumps({"id": "aqz-KE-bpKQ", "title": "Big Buck Bunny", "channel": "Blender", "webpage_url": url, "duration": 60})

        with patch.object(self.adapters, "_command", return_value=metadata_fixture), \
             patch.object(self.adapters.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            result = self.adapters.process_job(job, self.publisher, self.passwords, None)

        self.assertEqual(result["status"], "partial")
        self.assertIn("transcript_unavailable", result["summary"]["warnings"])

    def test_youtube_live_extraction(self):
        # Sample video: "Me at the zoo" (first YouTube video, 19 seconds, permanent captions)
        sample_url = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        try:
            req = urllib.request.Request(sample_url, headers={"User-Agent": "OpenLia-Test"})
            with urllib.request.urlopen(req, timeout=5):
                pass
        except Exception as exc:
            self.skipTest(f"Live YouTube network test skipped (network unreachable: {exc})")

        captured = self.publisher.capture(
            {"kind": "youtube", "title": "Me at the zoo Live", "url": sample_url}
        )
        self.queue.submit(
            {
                "idempotency_key": "job-yt-live",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["intake"]["version_id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-yt-live")
        try:
            result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        except self.adapters.AdapterError as exc:
            self.skipTest(f"Live yt-dlp extraction skipped due to provider rate limit/environment: {exc}")

        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["extraction_refs"])
        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/transcript.md"))
        self.assertTrue(len(extraction_file) == 1)
        transcript = extraction_file[0].read_text(encoding="utf-8")
        self.assertIn("elephants", transcript.lower())

    # =========================================================================
    # Hermes Agent Runtime Tools Integration Tests
    # =========================================================================

    def test_runtime_tools_full_workflow(self):
        ctx = MockHermesContext()
        runtime = self.runtime_mod.IngestionRuntime(ctx)
        runtime.register_tools()

        # Verify Mid-Session Hijacking tools are removed
        self.assertNotIn("ingestion_acknowledge", ctx.tools)
        self.assertNotIn("ingestion_complete_action", ctx.tools)

        # 1. ingestion_capture
        fixture_path = self._copy_fixture("sample.csv")
        capture_resp = json.loads(
            runtime.capture({"kind": "csv", "title": "Tool Capture", "file_path": str(fixture_path)})
        )
        self.assertTrue(capture_resp["ok"])
        self.assertEqual(capture_resp["state"], "queued")
        job_id = capture_resp["job_id"]
        intake_id = capture_resp["intake_id"]
        source_id = capture_resp["source_id"]

        # 2. ingestion_status
        status_resp = json.loads(runtime.status({"job_id": job_id}))
        self.assertTrue(status_resp["ok"])
        self.assertEqual(status_resp["state"], "queued")

        # 3. Simulate worker execution
        job = self.queue.claim("test-tool-worker")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None, db=self.queue)
        event_id = self.queue.finish(job, result)
        self.assertIsNotNone(event_id)

        # 4. Status after completion (by intake_id and source_id)
        status_after = json.loads(runtime.status({"intake_id": intake_id}))
        self.assertEqual(status_after["state"], "completed")
        status_by_source = json.loads(runtime.status({"source_id": source_id}))
        self.assertEqual(status_by_source["state"], "completed")

        # 5. Pull-based reference lookup via ingestion_get_document
        doc_resp = json.loads(runtime.get_document({"source_id": source_id}))
        self.assertTrue(doc_resp["ok"])
        self.assertEqual(doc_resp["document"]["id"], source_id)
        self.assertFalse((self.workspace / "sources").exists())

    def test_runtime_publishes_sanitized_live_status_snapshot(self):
        runtime = self.runtime_mod.IngestionRuntime(MockHermesContext())
        capture_resp = json.loads(
            runtime.capture(
                {
                    "kind": "text",
                    "content": "status snapshot",
                    "next_action": "private-follow-up",
                    "request_ref": "private-request",
                }
            )
        )
        runtime._publish_status()

        snapshot_path = self.ingestion_dir / "status.json"
        self.assertTrue(snapshot_path.exists())
        snapshot_text = snapshot_path.read_text(encoding="utf-8")
        snapshot = json.loads(snapshot_text)
        self.assertEqual(snapshot["schema"], 1)
        self.assertEqual(snapshot["job_counts"]["queued"], 1)
        self.assertEqual(snapshot["jobs"][0]["intake_id"], capture_resp["intake_id"])
        self.assertNotIn("continuation", snapshot_text)
        self.assertNotIn("private-follow-up", snapshot_text)
        self.assertNotIn("private-request", snapshot_text)

    def test_terminal_failure_updates_source_processing_status(self):
        runtime = self.runtime_mod.IngestionRuntime(MockHermesContext())
        captured = self.publisher.capture({"kind": "text", "content": "failure status"})
        job = self.queue.submit(
            {
                "idempotency_key": "job-terminal-failure",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "requested_outputs": ["text"],
                "continuation": {},
            }
        )
        claimed = self.queue.claim("failure-worker")
        self.assertIsNotNone(claimed)
        self.queue.fail(claimed, "unsupported_kind", "unsupported source", False)
        runtime._update_failure(claimed, "unsupported_kind", "unsupported source")
        source = self.publisher.load_source(captured["source"]["id"])
        intake = self.publisher.load_intake(captured["intake"]["intake_id"])
        self.assertEqual(source["status"], "failed")
        self.assertEqual(source["processing"]["status"], "failed")
        self.assertEqual(source["processing"]["error"], "unsupported source")
        self.assertEqual(intake["status"], "failed")

    def test_runtime_password_management_tools(self):
        ctx = MockHermesContext()
        runtime = self.runtime_mod.IngestionRuntime(ctx)
        runtime.register_tools()

        # save_document_password
        save_resp = json.loads(
            runtime.save_password({"profile_id": "fin_2026", "label": "Tax documents 2026", "password": TEST_DOC_KEY})  # ggignore
        )
        self.assertTrue(save_resp["ok"])
        self.assertEqual(save_resp["profile_id"], "fin_2026")

        # list_document_password_profiles (must not reveal password)
        list_resp = json.loads(runtime.list_passwords({}))
        self.assertTrue(list_resp["ok"])
        self.assertEqual(list_resp["profiles"], [{"label": "Tax documents 2026", "profile_id": "fin_2026"}])
        self.assertNotIn(TEST_DOC_KEY, json.dumps(list_resp))

        # retry_ingestion_with_password_profile
        fixture_path = self._copy_fixture("sample_protected.xlsx")
        captured = self.publisher.capture({"kind": "excel", "title": "Locked", "file_path": str(fixture_path)})
        self.queue.submit(
            {
                "idempotency_key": "job-retry-test",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-fail")
        self.queue.block_for_password(job, "password_required", "need password")

        retry_resp = json.loads(
            runtime.retry_with_password({"intake_id": captured["intake"]["intake_id"], "profile_id": "fin_2026"})
        )
        self.assertTrue(retry_resp["ok"])
        self.assertEqual(retry_resp["state"], "queued")

    def test_search_tagging_and_references(self):
        references_mod = sys.modules[f"{self.package}.references"]

        # 1. Capture document
        captured = self.publisher.capture(
            {"kind": "text", "title": "Contract Agreement", "content": "Quarterly Financial Agreement for ACME Corp revenue audit"}
        )
        source_id = captured["source"]["id"]
        version_id = captured["version"]["id"]

        # 2. Process job with DB sync
        self.queue.submit(
            {
                "idempotency_key": "job-agreement-1",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": source_id,
                "version_id": version_id,
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-agreement")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None, db=self.queue)
        self.assertEqual(result["status"], "completed")

        source = self.publisher.load_source(source_id)
        intake = self.publisher.load_intake(captured["intake"]["intake_id"])
        self.publisher.publish_extraction(
            source,
            intake,
            version_id,
            "text",
            "text/markdown",
            ".md",
            b"## Page 1\n\nFirst page content\n\n## Page 2\n\nSecond page content",
            {"complete": True},
        )
        runtime_inst = self.runtime_mod.IngestionRuntime(MockHermesContext())
        latest_doc = json.loads(runtime_inst.get_document({"source_id": source_id}))
        self.assertIn("First page content", latest_doc["content"])

        # Test page slicing
        page_2_doc = json.loads(runtime_inst.get_document({"source_id": source_id, "page": 2}))
        self.assertEqual(page_2_doc["page"], 2)
        self.assertIn("Second page content", page_2_doc["content"])
        self.assertNotIn("First page content", page_2_doc["content"])

        # 3. Reference builder & parser
        uri = references_mod.build_source_uri(source_id, version_id, page=2)
        self.assertEqual(uri, f"openlia://source/{source_id}#{version_id}/p2")
        parsed = references_mod.parse_source_uri(uri)
        self.assertEqual(parsed["source_id"], source_id)
        self.assertEqual(parsed["version_id"], version_id)
        self.assertEqual(parsed["page"], 2)
        version_uri = references_mod.build_source_uri(source_id, version_id)
        self.assertEqual(references_mod.parse_source_uri(version_uri)["version_id"], version_id)

        citation = references_mod.build_markdown_citation(source_id, "Contract Agreement", version_id=version_id, page=2)
        self.assertIn("[Contract Agreement (v. ", citation)
        self.assertIn(f"({uri})", citation)

        # 4. Backlinks discovery
        task_dir = self.workspace / "tasks"
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "audit-task.md").write_text(
            f"# Follow up on audit\nCheck agreement at [{citation}] and verify.", encoding="utf-8"
        )
        backlinks = references_mod.find_backlinks(self.workspace, source_id)
        self.assertEqual(len(backlinks), 1)
        self.assertEqual(backlinks[0]["path"], "tasks/audit-task.md")
        self.assertEqual(backlinks[0]["line_number"], 2)

        # 5. Search via queue.search_sources
        search_res = self.queue.search_sources(query="revenue audit")
        self.assertEqual(search_res["total"], 1)
        self.assertEqual(search_res["matches"][0]["source_id"], source_id)
        self.assertIn("<mark>", search_res["matches"][0]["snippet"])

        # 6. Runtime tools (Hermes agent interface)
        ctx = MockHermesContext()
        runtime = self.runtime_mod.IngestionRuntime(ctx)
        runtime.register_tools()

        # ingestion_search tool
        tool_search_resp = json.loads(runtime.search({"query": "revenue"}))
        self.assertTrue(tool_search_resp["ok"])
        self.assertEqual(tool_search_resp["total"], 1)
        self.assertEqual(tool_search_resp["matches"][0]["source_id"], source_id)
        self.assertIn("openlia://source/", tool_search_resp["matches"][0]["canonical_uri"])
        self.assertIn(source_id, tool_search_resp["matches"][0]["markdown_citation"])

        # ingestion_tag tool
        tool_tag_resp = json.loads(runtime.tag_document({"source_id": source_id, "tags": ["finance", "audit_2026"]}))
        self.assertTrue(tool_tag_resp["ok"])
        self.assertIn("audit_2026", tool_tag_resp["tags"])

        # ingestion_update_document tool (including custom_fields)
        tool_update_resp = json.loads(runtime.update_document({
            "source_id": source_id,
            "correspondent": "ACME Corp",
            "document_type": "contract",
            "custom_fields": {"invoice_number": "INV-9001", "total_amount": 1250.50, "currency": "USD"},
            "review": {"status": "reviewed", "reasons": []}
        }))
        self.assertTrue(tool_update_resp["ok"])
        self.assertEqual(tool_update_resp["document"]["correspondent"], "ACME Corp")
        self.assertEqual(tool_update_resp["document"]["document_type"], "contract")
        self.assertEqual(tool_update_resp["document"]["custom_fields"]["invoice_number"], "INV-9001")
        self.assertEqual(tool_update_resp["document"]["review"]["status"], "reviewed")
        self.assertEqual(self.queue.search_sources(query="INV-9001")["total"], 1)

        # ingestion_get_document tool
        tool_get_resp = json.loads(runtime.get_document({"source_id": source_id}))
        self.assertTrue(tool_get_resp["ok"])
        self.assertEqual(tool_get_resp["document"]["id"], source_id)
        self.assertEqual(tool_get_resp["document"]["correspondent"], "ACME Corp")
        self.assertEqual(len(tool_get_resp["document"]["backlinks"]), 1)
        self.assertEqual(tool_get_resp["document"]["backlinks"][0]["path"], "tasks/audit-task.md")
        self.assertTrue(len(tool_get_resp["document"]["extractions"]) >= 1)

    def test_custom_fields_extraction_and_standalone_http_sidecar(self):
        server_mod = sys.modules[f"{self.package}.server"]
        sidecar = server_mod.IngestionSidecarServer(
            self.ingestion_dir,
            workspace_root=self.workspace,
            host="127.0.0.1",
            port=0,
            start_workers=False,
        )
        base_url = sidecar.start()
        service = sidecar.service
        try:
            # 1. Health check
            with urllib.request.urlopen(f"{base_url}/health", timeout=5) as resp:
                health = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(health["ok"])

            # 2. Upload invoice text via HTTP sidecar
            invoice_text = "INVOICE #INV-2026-77\nVendor: CloudHost Inc\nTotal Due: $420.00\nDue Date: 2026-11-15\n"
            req = urllib.request.Request(
                f"{base_url}/v1/sources/upload",
                data=json.dumps({
                    "filename": "invoice-77.txt",
                    "title": "CloudHost Invoice",
                    "content": invoice_text,
                }).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                uploaded = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(uploaded["ok"])
                source_id = uploaded["source_id"]

            # 3. Process the queued job
            job = service.queue.claim("sidecar-worker")
            self.assertIsNotNone(job)
            result = self.adapters.process_job(job, service.vault, service.passwords, None, db=service.queue)
            service.queue.finish(job, result)

            # 4. Verify heuristic custom_fields were extracted and indexed
            with urllib.request.urlopen(f"{base_url}/v1/sources/{source_id}", timeout=5) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
                doc = payload.get("document") or payload
                self.assertEqual(doc["id"], source_id)
                self.assertEqual(doc["custom_fields"].get("invoice_number"), "INV-2026-77")
                self.assertEqual(doc["custom_fields"].get("due_date"), "2026-11-15")
                self.assertEqual(doc["custom_fields"].get("total_amount"), 420.0)

            # 5. Verify HTTP Range streaming on /v1/sources/{id}/raw
            range_req = urllib.request.Request(
                f"{base_url}/v1/sources/{source_id}/raw",
                headers={"Range": "bytes=0-6"},
                method="GET",
            )
            with urllib.request.urlopen(range_req, timeout=5) as resp:
                self.assertEqual(resp.status, 206)
                self.assertEqual(resp.read(), b"INVOICE")

            # 6. Verify remote proxy mode via OPENLIA_INGESTION_URL
            with patch.dict(os.environ, {"OPENLIA_INGESTION_URL": base_url}):
                proxy_runtime = self.runtime_mod.IngestionRuntime(MockHermesContext())
                search_payload = json.loads(proxy_runtime.search({"query": "INV-2026-77"}))
                self.assertTrue(search_payload["ok"])
                self.assertEqual(search_payload["total"], 1)
                self.assertEqual(search_payload["matches"][0]["source_id"], source_id)
        finally:
            sidecar.stop()

    def test_legacy_workspace_sources_migration(self):
        # Create a legacy workspace source record + artifact
        legacy_records = self.workspace / "sources" / "records"
        legacy_artifacts = self.workspace / "sources" / "artifacts" / "src_legacy01" / "ver_001"
        legacy_records.mkdir(parents=True, exist_ok=True)
        legacy_artifacts.mkdir(parents=True, exist_ok=True)
        (legacy_artifacts / "original.txt").write_text("Legacy statement body", encoding="utf-8")
        legacy_doc = {
            "schema": 1,
            "id": "src_legacy01",
            "kind": "text",
            "title": "Legacy Statement",
            "status": "extracted",
            "captured_at": "2026-10-01T00:00:00Z",
            "versions": [
                {
                    "id": "ver_001",
                    "original_ref": "sources/artifacts/src_legacy01/ver_001/original.txt",
                    "media_type": "text/plain",
                    "extractions": [],
                }
            ],
        }
        (legacy_records / "src_legacy01.md").write_text(
            f"# Legacy Statement\n\n```json\n{json.dumps(legacy_doc, indent=2)}\n```\n",
            encoding="utf-8",
        )
        migrated_vault_dir = self.root / "migrated-vault"
        vault = self.publication.VaultStore(migrated_vault_dir, workspace_root=self.workspace)
        loaded = vault.load_source("src_legacy01")
        self.assertEqual(loaded["title"], "Legacy Statement")
        blob_path = vault.resolve_blob_path(loaded["versions"][0]["original_ref"])
        self.assertTrue(blob_path.exists())
        self.assertEqual(blob_path.read_text(encoding="utf-8"), "Legacy statement body")

    def test_password_profile_metadata_and_source_fallback(self):
        # 1. Test saving profile with description, hint, and patterns
        saved = self.passwords.save(
            "bank_vault",
            "Acme Bank Statements",
            TEST_DOC_KEY,
            description="Used for monthly Acme Bank checking statements",
            hint="Last 4 digits of SSN (1234)",
            patterns=["*protected*", "*acme*"],
        )
        self.assertEqual(saved["profile_id"], "bank_vault")
        self.assertEqual(saved["hint"], "Last 4 digits of SSN (1234)")
        self.assertEqual(saved["patterns"], ["*protected*", "*acme*"])

        # Verify list() returns metadata without revealing the password
        profiles = self.passwords.list()
        target = next((p for p in profiles if p["profile_id"] == "bank_vault"), None)
        self.assertIsNotNone(target)
        self.assertEqual(target["label"], "Acme Bank Statements")
        self.assertEqual(target["hint"], "Last 4 digits of SSN (1234)")
        self.assertEqual(target["description"], "Used for monthly Acme Bank checking statements")
        self.assertEqual(target["patterns"], ["*protected*", "*acme*"])
        self.assertNotIn("password", target)

        # 2. Test fallback: job does NOT have password_profile, but source DOES have password_profile
        fixture_path = self._copy_fixture("sample_protected.pdf")
        captured = self.publisher.capture(
            {"kind": "pdf", "title": "Encrypted PDF", "file_path": str(fixture_path), "password_profile": "bank_vault"}
        )
        # Intentionally omit password_profile from job submit
        self.queue.submit(
            {
                "idempotency_key": "job-pdf-source-fallback",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": captured["source"]["id"],
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "continuation": {},
            }
        )
        job = self.queue.claim("worker-pdf-fallback")
        self.assertIsNone(job.get("password_profile"))
        result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        self.assertEqual(result["status"], "completed")

        extraction_file = list(self.ingestion_dir.glob(f"blobs/{captured['source']['id']}/**/text.md"))
        self.assertEqual(len(extraction_file), 1)
        self.assertIn("Hermes Agent Ingestion Report", extraction_file[0].read_text(encoding="utf-8"))

    def test_password_suggestion_and_metadata_preserving_update(self):
        self.passwords.save(
            "vcb_statement",
            "Vietcombank Statements",
            TEST_DOC_KEY,
            description="Monthly Vietcombank credit card and checking PDF statements",
            hint="6-digit DOB DDMMYY",
            patterns=["*VCB*.pdf", "*vietcombank*"],
        )
        self.passwords.save(
            "payroll_slip",
            "Company Payslip",
            "secret-pay",
            description="Monthly salary payslip from HR portal",
            hint="Employee ID + birth year",
            patterns=["*payslip*.pdf"],
        )

        # 1. Exact glob match
        glob_matches = self.passwords.suggest(filename="2026_10_VCB_CreditCard.pdf")
        self.assertGreaterEqual(len(glob_matches), 1)
        self.assertEqual(glob_matches[0]["profile_id"], "vcb_statement")
        self.assertGreaterEqual(glob_matches[0]["score"], 80)

        # 2. Levenshtein fuzzy match on typo in correspondent/title
        fuzzy_matches = self.passwords.suggest(
            filename="statement_oct.pdf",
            correspondent="Vietcombnk",
            message="Please check my credit card statement",
        )
        self.assertGreaterEqual(len(fuzzy_matches), 1)
        self.assertEqual(fuzzy_matches[0]["profile_id"], "vcb_statement")
        self.assertGreaterEqual(fuzzy_matches[0]["score"], 40)

        # 3. Keyword overlap on message/description
        kw_matches = self.passwords.suggest(
            filename="doc_001.pdf",
            message="Here is my monthly salary payslip from HR",
        )
        self.assertGreaterEqual(len(kw_matches), 1)
        self.assertEqual(kw_matches[0]["profile_id"], "payroll_slip")

        # 4. Metadata-only update (password=None) preserves secret and existing fields
        updated = self.passwords.save(
            "vcb_statement",
            "VCB Updated Label",
            None,
            hint="Updated safe hint",
        )
        self.assertEqual(updated["label"], "VCB Updated Label")
        self.assertEqual(updated["hint"], "Updated safe hint")
        self.assertEqual(
            updated["description"],
            "Monthly Vietcombank credit card and checking PDF statements",
        )
        self.assertEqual(updated["patterns"], ["*VCB*.pdf", "*vietcombank*"])
        self.assertEqual(self.passwords.resolve("vcb_statement"), TEST_DOC_KEY)

        # 5. Delete profile
        self.assertTrue(self.passwords.delete("payroll_slip"))
        self.assertFalse(self.passwords.delete("payroll_slip"))
        remaining_ids = [p["profile_id"] for p in self.passwords.list()]
        self.assertEqual(remaining_ids, ["vcb_statement"])

    def test_embedded_single_turn_capture_auto_unlock_and_page_outline(self):
        ctx = MockHermesContext()
        runtime = self.runtime_mod.IngestionRuntime(ctx)
        self.passwords.save(
            "protected_pdf_key",
            "Protected Report Key",
            TEST_DOC_KEY,
            description="Password for sample_protected.pdf reports",
            hint="Default test key",
            patterns=["*sample_protected*"],
        )

        # 1. Capture without auto_unlock and wait_seconds=5 -> awaiting-unlock with password_suggestions
        fixture_1 = self._copy_fixture("sample_protected.pdf")
        locked_target = self.root / "sample_protected_locked.pdf"
        shutil.copy2(fixture_1, locked_target)
        res_locked = json.loads(
            runtime.capture(
                {
                    "kind": "pdf",
                    "file_path": str(locked_target),
                    "title": "Locked PDF Report",
                    "wait_seconds": 5,
                    "auto_unlock": False,
                }
            )
        )
        self.assertTrue(res_locked["ok"])
        self.assertEqual(res_locked["state"], "awaiting-unlock")
        self.assertTrue(len(res_locked.get("password_suggestions") or []) >= 1)
        self.assertEqual(
            res_locked["password_suggestions"][0]["profile_id"], "protected_pdf_key"
        )

        # 2. Retry with password profile and wait_seconds=5 -> completed in single turn
        res_retried = json.loads(
            runtime.retry_with_password(
                {
                    "source_id": res_locked["source_id"],
                    "profile_id": "protected_pdf_key",
                    "wait_seconds": 5,
                }
            )
        )
        self.assertTrue(res_retried["ok"])
        self.assertEqual(res_retried["state"], "completed")
        self.assertIn("openlia://source/", res_retried["canonical_uri"])

        # 3. Capture with auto_unlock=True and wait_seconds=5 -> unlocked & completed in single call
        fixture_2 = self._copy_fixture("sample_protected.pdf")
        res_auto = json.loads(
            runtime.capture(
                {
                    "kind": "pdf",
                    "file_path": str(fixture_2),
                    "title": "Auto Unlocked PDF",
                    "wait_seconds": 5,
                    "auto_unlock": True,
                }
            )
        )
        self.assertTrue(res_auto["ok"])
        self.assertEqual(res_auto["state"], "completed")
        self.assertEqual(
            res_auto.get("auto_selected_password_profile"), "protected_pdf_key"
        )

        # 4. Multi-page document outline and max_chars slicing
        multipage_md = (
            "## Page 1\nFirst page intro and summary details.\n\n"
            "## Page 2\nSecond page transaction table and balances.\n"
        )
        res_multi = json.loads(
            runtime.capture(
                {
                    "kind": "text",
                    "title": "Multi-page Statement",
                    "content": multipage_md,
                    "wait_seconds": 5,
                }
            )
        )
        self.assertEqual(res_multi["state"], "completed")
        doc_res = json.loads(
            runtime.get_document({"source_id": res_multi["source_id"], "page": 2})
        )
        self.assertTrue(doc_res["ok"])
        self.assertEqual(doc_res["page_count"], 2)
        self.assertEqual(len(doc_res["page_outline"]), 2)
        self.assertEqual(doc_res["page_outline"][0]["page"], 1)
        self.assertEqual(doc_res["page_outline"][1]["page"], 2)
        self.assertIn("Second page transaction table", doc_res["content"])
        self.assertNotIn("First page intro", doc_res["content"])

    def test_standalone_remote_full_tool_parity_and_bearer_auth(self):
        server_mod = sys.modules[f"{self.package}.server"]
        remote_vault_dir = self.root / "remote-standalone-vault"
        remote_vault_dir.mkdir(parents=True, exist_ok=True)
        token = "standalone-secret-token-999"

        sidecar = server_mod.IngestionSidecarServer(
            remote_vault_dir,
            workspace_root=None,
            host="127.0.0.1",
            port=0,
            start_workers=True,
            auth_token=token,
        )
        base_url = sidecar.start()
        try:
            # 1. Health endpoint is public, but /v1/* requires Bearer token
            with urllib.request.urlopen(f"{base_url}/health", timeout=5) as resp:
                self.assertEqual(resp.status, 200)

            unauth_req = urllib.request.Request(f"{base_url}/v1/passwords", method="GET")
            with self.assertRaises(urllib.error.HTTPError) as ctx_err:
                urllib.request.urlopen(unauth_req, timeout=5)
            self.assertEqual(ctx_err.exception.code, 401)

            # 2. Initialize Hermes plugin in Remote Proxy Mode
            with patch.dict(
                os.environ,
                {
                    "OPENLIA_INGESTION_URL": base_url,
                    "OPENLIA_INGESTION_TOKEN": token,
                },
            ):
                proxy_runtime = self.runtime_mod.IngestionRuntime(MockHermesContext())
                self.assertEqual(proxy_runtime.threads, [])

                # Save, list, suggest passwords over HTTP
                save_pw = json.loads(
                    proxy_runtime.save_password(
                        {
                            "profile_id": "remote_bank",
                            "label": "Remote Bank Key",
                            "password": TEST_DOC_KEY,
                            "description": "Remote standalone PDF unlock key",
                            "hint": "Remote test key",
                            "patterns": ["*sample_protected*"],
                        }
                    )
                )
                self.assertTrue(save_pw["ok"])

                list_pw = json.loads(proxy_runtime.list_passwords({}))
                self.assertTrue(list_pw["ok"])
                self.assertEqual(len(list_pw["profiles"]), 1)

                suggest_pw = json.loads(
                    proxy_runtime.suggest_passwords({"filename": "sample_protected.pdf"})
                )
                self.assertTrue(suggest_pw["ok"])
                self.assertEqual(suggest_pw["suggestions"][0]["profile_id"], "remote_bank")

                # Capture local file from Hermes host -> remote standalone server with auto_unlock + wait_seconds
                fixture_path = self._copy_fixture("sample_protected.pdf")
                capture_res = json.loads(
                    proxy_runtime.capture(
                        {
                            "kind": "pdf",
                            "file_path": str(fixture_path),
                            "title": "Remote Protected PDF",
                            "wait_seconds": 10,
                            "auto_unlock": True,
                        }
                    )
                )
                self.assertTrue(capture_res["ok"])
                self.assertEqual(capture_res["state"], "completed")
                source_id = capture_res["source_id"]

                # Create local workspace file citing the remote source_id to verify local backlink merging
                tasks_dir = self.workspace / "tasks"
                tasks_dir.mkdir(parents=True, exist_ok=True)
                (tasks_dir / "verify-remote.md").write_text(
                    f"# Verify Remote Source\nSee [PDF](openlia://source/{source_id}).\n",
                    encoding="utf-8",
                )

                doc_res = json.loads(proxy_runtime.get_document({"source_id": source_id}))
                self.assertTrue(doc_res["ok"])
                self.assertIn("Hermes Agent Ingestion Report", doc_res["content"])
                self.assertEqual(len(doc_res["backlinks"]), 1)
                self.assertEqual(doc_res["backlinks"][0]["path"], "tasks/verify-remote.md")

                # Tag, update, status, search, delete_password, recover over HTTP
                tag_res = json.loads(
                    proxy_runtime.tag_document(
                        {"source_id": source_id, "add_tags": ["finance", "remote_ok"]}
                    )
                )
                self.assertTrue(tag_res["ok"])
                self.assertIn("remote_ok", tag_res["tags"])

                upd_res = json.loads(
                    proxy_runtime.update_document(
                        {
                            "source_id": source_id,
                            "correspondent": "Remote Bank Corp",
                            "review": {"status": "reviewed", "reasons": []},
                        }
                    )
                )
                self.assertTrue(upd_res["ok"])
                self.assertEqual(upd_res["document"]["correspondent"], "Remote Bank Corp")

                status_res = json.loads(proxy_runtime.status({"source_id": source_id}))
                self.assertTrue(status_res["ok"])
                self.assertEqual(status_res["state"], "completed")

                search_res = json.loads(
                    proxy_runtime.search({"query": "Hermes", "tags": ["remote_ok"]})
                )
                self.assertTrue(search_res["ok"])
                self.assertEqual(search_res["total"], 1)

                del_pw = json.loads(
                    proxy_runtime.delete_password({"profile_id": "remote_bank"})
                )
                self.assertTrue(del_pw["ok"])
                self.assertTrue(del_pw["deleted"])

                rec_res = json.loads(proxy_runtime.recover({}))
                self.assertTrue(rec_res["ok"])

                # Delete document over HTTP with annotate_backlinks
                del_doc_res = json.loads(
                    proxy_runtime.delete_document(
                        {"source_id": source_id, "annotate_backlinks": True}
                    )
                )
                self.assertTrue(del_doc_res["ok"])
                self.assertTrue(del_doc_res["deleted"])
                self.assertIn("tasks/verify-remote.md", del_doc_res["annotated_files"])
                annotated_note = (tasks_dir / "verify-remote.md").read_text(encoding="utf-8")
                self.assertIn("(deleted source:", annotated_note)

                # Verify source is gone
                gone_res = json.loads(proxy_runtime.get_document({"source_id": source_id}))
                self.assertFalse(gone_res["ok"])
        finally:
            sidecar.stop()

    def test_document_version_replacement_and_soft_archive(self):
        ctx = MockHermesContext()
        runtime = self.runtime_mod.IngestionRuntime(ctx)
        runtime.register_tools()

        # 1. Ingest initial document
        fixture_path = self._copy_fixture("sample.txt")
        captured = self.publisher.capture(
            {
                "kind": "text",
                "file_path": str(fixture_path),
                "title": "Original Contract v1",
                "tags": ["legal", "contract"],
                "correspondent": "MegaCorp",
            }
        )
        source_id = captured["source"]["id"]
        self.queue.upsert_source_fts(
            source_id=source_id,
            title="Original Contract v1",
            correspondent="MegaCorp",
            document_type="contract",
            tags=["legal", "contract"],
            summary="",
            content="Original Contract text terms",
            document_date="2026-10-18",
            review_status="unreviewed",
            processing_status="completed",
            lifecycle="active",
        )
        source_doc = self.queue.get_source(source_id)
        self.assertIsNotNone(source_doc)
        self.assertEqual(len(source_doc["versions"]), 1)
        self.assertEqual(source_doc["versions"][0]["id"], "ver_001")
        self.assertEqual(source_doc["lifecycle"], "active")

        # 2. Test Soft Archiving and Search Filtering
        self.assertEqual(self.queue.search_sources(query="Original Contract")["total"], 1)
        upd_arch = json.loads(
            runtime.update_document({"source_id": source_id, "lifecycle": "archived"})
        )
        self.assertTrue(upd_arch["ok"])
        self.assertEqual(self.queue.search_sources(query="Original Contract")["total"], 0)
        self.assertEqual(
            self.queue.search_sources(query="Original Contract", lifecycle="archived")["total"], 1
        )
        self.assertEqual(
            self.queue.search_sources(query="Original Contract", lifecycle="all")["total"], 1
        )
        upd_act = json.loads(
            runtime.update_document({"source_id": source_id, "lifecycle": "active"})
        )
        self.assertTrue(upd_act["ok"])
        self.assertEqual(self.queue.search_sources(query="Original Contract")["total"], 1)

        # 3. Version Replacement without purge:
        blobs_dir = self.publisher.blobs / source_id
        ver_001_dir = blobs_dir / "ver_001"
        self.assertTrue(ver_001_dir.exists())

        v2_path = self.root / "contract_v2.txt"
        v2_path.write_text("Updated contract terms v2", encoding="utf-8")
        self.publisher.capture(
            {
                "kind": "text",
                "file_path": str(v2_path),
                "title": "Updated Contract v2",
                "target_source_id": source_id,
                "purge_previous_versions": False,
            }
        )
        updated_doc = self.queue.get_source(source_id)
        self.assertEqual(len(updated_doc["versions"]), 2)
        self.assertEqual(updated_doc["versions"][-1]["id"], "ver_002")
        self.assertEqual(updated_doc["correspondent"], "MegaCorp")
        self.assertIn("contract", updated_doc["tags"])
        ver_002_dir = blobs_dir / "ver_002"
        self.assertTrue(ver_001_dir.exists())
        self.assertTrue(ver_002_dir.exists())

        # 4. Version Replacement with purge_previous_versions=True:
        v3_path = self.root / "contract_v3.txt"
        v3_path.write_text("Final contract terms v3", encoding="utf-8")
        self.publisher.capture(
            {
                "kind": "text",
                "file_path": str(v3_path),
                "title": "Final Contract v3",
                "target_source_id": source_id,
                "purge_previous_versions": True,
            }
        )
        doc_v3 = self.queue.get_source(source_id)
        self.assertEqual(len(doc_v3["versions"]), 1)
        self.assertEqual(doc_v3["versions"][0]["id"], "ver_003")
        self.assertFalse(ver_001_dir.exists())
        self.assertFalse(ver_002_dir.exists())
        self.assertTrue((blobs_dir / "ver_003").exists())

    def test_document_delete_cascade_and_backlinks_annotation(self):
        ctx = MockHermesContext()
        runtime = self.runtime_mod.IngestionRuntime(ctx)
        runtime.register_tools()

        # Ingest a text file
        doc_path = self.root / "invoice_to_delete.txt"
        doc_path.write_text("Vendor Invoice 98765 amount $500", encoding="utf-8")
        captured = self.publisher.capture(
            {
                "kind": "text",
                "file_path": str(doc_path),
                "title": "Vendor Invoice 98765",
            }
        )
        source_id = captured["source"]["id"]

        blobs_dir = self.publisher.blobs / source_id
        self.assertTrue(blobs_dir.exists())

        # Create markdown and journal files with backlinks
        notes_dir = self.workspace / "finances"
        notes_dir.mkdir(parents=True, exist_ok=True)
        note_file = notes_dir / "october.md"
        note_file.write_text(
            f"# Finances\n- Ref: [Invoice](openlia://source/{source_id})\n",
            encoding="utf-8",
        )
        journal_file = notes_dir / "ledger.journal"
        journal_file.write_text(
            f"2026-10-18 MegaCorp\n    expenses:office  $500\n    assets:checking\n    ; source: openlia://source/{source_id}#ver_001\n",
            encoding="utf-8",
        )

        # Call ingestion_delete_document tool with annotate_backlinks=True
        del_resp = json.loads(
            runtime.delete_document({
                "source_id": source_id,
                "annotate_backlinks": True,
            })
        )
        self.assertTrue(del_resp["ok"])
        self.assertTrue(del_resp["deleted"])
        self.assertEqual(len(del_resp["backlinks"]), 2)
        self.assertIn("finances/october.md", del_resp["annotated_files"])
        self.assertIn("finances/ledger.journal", del_resp["annotated_files"])

        # Verify vault blobs directory on disk was completely purged
        self.assertFalse(blobs_dir.exists())

        # Verify database record is gone
        self.assertIsNone(self.queue.get_source(source_id))
        self.assertEqual(
            self.queue.search_sources(query="Vendor Invoice", lifecycle="all")["total"], 0
        )

        # Verify note and journal content were annotated
        annotated_note = note_file.read_text(encoding="utf-8")
        self.assertIn(f"[Invoice (deleted source: {source_id})]", annotated_note)
        annotated_journal = journal_file.read_text(encoding="utf-8")
        self.assertIn(f"; source-deleted: {source_id}", annotated_journal)

    def test_queued_document_cancellation_and_resumption(self):
        ctx = MockHermesContext()
        runtime = self.runtime_mod.IngestionRuntime(ctx)
        runtime.register_tools()

        # Ingest a text file
        doc_path = self.root / "queued_doc.txt"
        doc_path.write_text("Pending extraction content", encoding="utf-8")
        captured = self.publisher.capture(
            {
                "kind": "text",
                "file_path": str(doc_path),
                "title": "Queued Report",
            }
        )
        source_id = captured["source"]["id"]
        job = self.queue.submit(
            {
                "idempotency_key": "job-queued-doc",
                "intake_id": captured["intake"]["intake_id"],
                "source_id": source_id,
                "version_id": captured["version"]["id"],
                "operation": "extract",
                "requested_outputs": ["text"],
            }
        )
        job_id = job["job_id"]

        # Verify job is queued
        job_before = self.queue.get(job_id)
        self.assertEqual(job_before["state"], "queued")

        # Cancel processing via runtime tool
        cancel_resp = json.loads(
            runtime.cancel_document({
                "source_id": source_id,
                "reason": "cancelled_by_user",
            })
        )
        self.assertTrue(cancel_resp["ok"])
        self.assertEqual(cancel_resp["schema"], 1)
        self.assertEqual(cancel_resp["source_id"], source_id)
        self.assertTrue(cancel_resp["cancelled"])
        self.assertEqual(cancel_resp["cancelled_jobs"], [job_id])
        self.assertEqual(cancel_resp["state"], "cancelled")
        self.assertEqual(cancel_resp["jobs_cancelled"], 1)

        # Verify job is now cancelled
        job_after = self.queue.get(job_id)
        self.assertEqual(job_after["state"], "cancelled")
        self.assertEqual(job_after["error_code"], "cancelled_by_user")

        # Verify source status in db is cancelled
        source_rec = self.queue.get_source(source_id)
        self.assertEqual(source_rec["processing"]["status"], "cancelled")
        self.assertEqual(source_rec["processing"]["error_code"], "cancelled_by_user")

        # Verify raw Vault blob directory STILL EXISTS (preserved, not deleted)
        blobs_dir = self.publisher.blobs / source_id
        self.assertTrue(blobs_dir.exists())

        # Verify comma-separated processing_status search
        search_res = self.queue.search_sources(processing_status="queued,cancelled")
        self.assertEqual(search_res["total"], 1)
        self.assertEqual(search_res["matches"][0]["source_id"], source_id)

        # Resume extraction by requeuing job
        requeued = self.queue.requeue_job(job_id)
        self.assertIsNotNone(requeued)
        self.assertEqual(requeued["state"], "queued")


if __name__ == "__main__":
    unittest.main()
