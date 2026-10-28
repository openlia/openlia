import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("install_remind", ROOT / "docker/install-remind.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallRemindTests(unittest.TestCase):
    def test_release_pin_is_complete_and_exact(self):
        pin = installer.load_pin(ROOT / "release/manifest.json")
        self.assertEqual(pin["version"], "06.03.06")
        self.assertEqual(pin["source_sha256"], "19518dfa6ab3695749e74b26b664a7134b573ddd03f0a7a6fee3867868d6fd58")

    def test_checksum_failure_cannot_extract_or_execute(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "bad.tar.gz"
            archive.write_bytes(b"not the pinned source")
            prefix = root / "install"
            with patch.object(installer.subprocess, "run") as execute:
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    installer.install(ROOT / "release/manifest.json", prefix, archive)
                execute.assert_not_called()
            self.assertFalse(prefix.exists())

    def test_extraction_rejects_traversal_links_and_special_files(self):
        for name, kind, link in [("../outside", tarfile.REGTYPE, ""), ("remind-06.03.06/link", tarfile.SYMTYPE, "/outside"), ("remind-06.03.06/hard", tarfile.LNKTYPE, "../outside"), ("remind-06.03.06/pipe", tarfile.FIFOTYPE, "")]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive = root / "source.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    entry = tarfile.TarInfo(name)
                    entry.type, entry.linkname = kind, link
                    entry.size = 1 if kind == tarfile.REGTYPE else 0
                    tar.addfile(entry, io.BytesIO(b"x") if entry.size else None)
                pin = {"version": "06.03.06", "source_sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
                destination = root / "source"
                destination.mkdir()
                with self.assertRaises(ValueError):
                    installer.extract_source(archive, destination, pin)
                self.assertFalse((root / "outside").exists())

    def test_unmanaged_existing_prefix_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            prefix = Path(temp) / "existing"
            prefix.mkdir()
            sentinel = prefix / "user-file"
            sentinel.write_text("preserve")
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                installer.install(ROOT / "release/manifest.json", prefix)
            self.assertEqual(sentinel.read_text(), "preserve")

    def test_wrong_binary_version_fails_before_smoke_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "remind"
            binary.write_text("#!/bin/sh\nprintf '%s\\n' '04.03.01'\n")
            binary.chmod(0o700)
            with self.assertRaisesRegex(ValueError, "version mismatch"):
                installer.verify_binary(binary, "06.03.06")

    def test_invalid_release_source_pin_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "manifest.json"
            path.write_text(json.dumps({"remind": {"version": "latest", "source_url": "http://untrusted.invalid/source", "source_sha256": ""}}))
            with self.assertRaises(ValueError):
                installer.load_pin(path)


if __name__ == "__main__":
    unittest.main()
