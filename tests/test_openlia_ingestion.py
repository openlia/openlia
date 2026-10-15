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
                job = queue.claim("integration-worker")
                self.assertIsNotNone(job)
                self.assertEqual(job["job_id"], uploaded["job_id"])
                self.assertEqual(job["lease_generation"], 1)
                intake = self.publisher.load_intake(job["intake_id"])
                self.assertEqual(intake["source_id"], uploaded["source_id"])
                self.assertEqual(intake["status"], "queued")
                result = self.adapters.process_job(
                    job, self.publisher, self.passwords, None, db=queue,
                )
                self.assertEqual(result["status"], "completed")
                self.assertIsNotNone(queue.finish(job, result))
                source = self.publisher.load_source(uploaded["source_id"])
                self.assertEqual(source["processing"]["status"], "complete")
                self.assertTrue(source["versions"][0]["extractions"])
                self.assertEqual(queue.get(job["job_id"])["state"], "completed")

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
            (self.workspace / "sources/artifacts" / captured["source"]["id"] / captured["version"]["id"] / "original.txt").exists()
        )

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

    def test_continuation_action_is_durable_and_idempotent(self):
        first = self.queue.begin_action("ingestion:evt_1", "evt_1", "intake_1")
        second = self.queue.begin_action("ingestion:evt_1", "evt_1", "intake_1")
        self.assertEqual(first["status"], "started")
        self.assertEqual(second["status"], "started")
        self.assertTrue(self.queue.complete_action("ingestion:evt_1", ["tasks/task_1.md"]))
        self.assertFalse(self.queue.complete_action("ingestion:evt_1", ["tasks/task_1.md"]))

    def test_password_profile_never_returns_value_from_listing(self):
        result = self.passwords.save("bank_a", "Bank A statement", TEST_DOC_KEY)  # ggignore
        self.assertEqual(result["profile_id"], "bank_a")
        self.assertEqual(self.passwords.resolve("bank_a"), TEST_DOC_KEY)
        self.assertEqual(self.passwords.list(), [{"profile_id": "bank_a", "label": "Bank A statement"}])
        mode = stat.S_IMODE(self.passwords.path.stat().st_mode)
        self.assertEqual(mode, 0o600)
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

        # Check extracted markdown artifact
        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/text.md"))
        self.assertTrue(len(extraction_file) == 1)
        self.assertIn("Hermes Agent ingestion runtime", extraction_file[0].read_text(encoding="utf-8"))

    def test_job_uses_requested_version_instead_of_latest(self):
        captured = self.publisher.capture(
            {"kind": "text", "title": "Versioned text", "content": "old version"}
        )
        source = captured["source"]
        new_version_id = "ver_new"
        new_ref = f"sources/artifacts/{source['id']}/{new_version_id}/original.txt"
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
        old_text = list(self.workspace.glob(f"sources/artifacts/{source['id']}/{captured['version']['id']}/extractions/*/text.md"))[0]
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
        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/tables.json"))
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
        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/tables.json"))
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

        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/tables.json"))
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

        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/tables.json"))
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

        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/text.md"))
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

        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/text.md"))
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

        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/text.md"))
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
        self.assertIn("Text page one", published_text)
        self.assertIn("OCR page two", published_text)

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

                extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/text.md"))
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
        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/transcript.md"))
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
        extraction_file = list(self.workspace.glob(f"sources/artifacts/{captured['source']['id']}/**/transcript.md"))
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

        # 1. ingestion_capture
        fixture_path = self._copy_fixture("sample.csv")
        capture_resp = json.loads(
            runtime.capture({"kind": "csv", "title": "Tool Capture", "file_path": str(fixture_path)})
        )
        self.assertTrue(capture_resp["ok"])
        self.assertEqual(capture_resp["state"], "queued")
        job_id = capture_resp["job_id"]
        intake_id = capture_resp["intake_id"]

        # 2. ingestion_status
        status_resp = json.loads(runtime.status({"job_id": job_id}))
        self.assertTrue(status_resp["ok"])
        self.assertEqual(status_resp["state"], "queued")

        # 3. Simulate worker execution
        job = self.queue.claim("test-tool-worker")
        result = self.adapters.process_job(job, self.publisher, self.passwords, None)
        event_id = self.queue.finish(job, result)
        self.assertIsNotNone(event_id)

        # 4. Status after completion
        status_after = json.loads(runtime.status({"intake_id": intake_id}))
        self.assertEqual(status_after["state"], "completed")

        # 5. ingestion_acknowledge
        ack_resp = json.loads(
            runtime.acknowledge({"event_id": event_id, "intake_id": intake_id, "action_id": "act_test_1"})
        )
        self.assertTrue(ack_resp["ok"])
        self.assertTrue(ack_resp["acknowledged"])

        # 6. ingestion_complete_action
        complete_resp = json.loads(
            runtime.complete_action({"action_id": "act_test_1", "record_refs": ["knowledge/note.md"]})
        )
        self.assertTrue(complete_resp["ok"])
        self.assertTrue(complete_resp["completed"])

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
            b"latest extraction content",
            {"complete": True},
        )
        latest_doc = json.loads(
            self.runtime_mod.IngestionRuntime(MockHermesContext()).get_document(
                {"source_id": source_id}
            )
        )
        self.assertEqual(latest_doc["content"], "latest extraction content")

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

        # ingestion_update_document tool
        tool_update_resp = json.loads(runtime.update_document({
            "source_id": source_id,
            "correspondent": "ACME Corp",
            "document_type": "contract",
            "review": {"status": "reviewed", "reasons": []}
        }))
        self.assertTrue(tool_update_resp["ok"])
        self.assertEqual(tool_update_resp["document"]["correspondent"], "ACME Corp")
        self.assertEqual(tool_update_resp["document"]["document_type"], "contract")
        self.assertEqual(tool_update_resp["document"]["review"]["status"], "reviewed")
        self.assertEqual(self.queue.search_sources(query="revenue audit")["total"], 1)

        # ingestion_get_document tool
        tool_get_resp = json.loads(runtime.get_document({"source_id": source_id}))
        self.assertTrue(tool_get_resp["ok"])
        self.assertEqual(tool_get_resp["document"]["id"], source_id)
        self.assertEqual(tool_get_resp["document"]["correspondent"], "ACME Corp")
        self.assertEqual(len(tool_get_resp["document"]["backlinks"]), 1)
        self.assertEqual(tool_get_resp["document"]["backlinks"][0]["path"], "tasks/audit-task.md")
        self.assertTrue(len(tool_get_resp["document"]["extractions"]) >= 1)


if __name__ == "__main__":
    unittest.main()
