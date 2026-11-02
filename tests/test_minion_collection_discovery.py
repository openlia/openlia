"""Minions are discoverable apps, not recursive generic record sources."""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "profile/system-skills/workspace-template-customization/scripts/workspace_registry.py"
spec = importlib.util.spec_from_file_location("minion_collection_registry", SCRIPT)
registry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry)


class MinionCollectionDiscoveryTests(unittest.TestCase):
    def test_app_internals_are_pruned_and_exports_remain_discoverable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "minions/gym-tracker"
            app.mkdir(parents=True)
            (app / "README.md").write_text(
                "---\nname: Gym Tracker\ndescription: Workout app\n---\n# Gym\n"
            )
            (app / "main.py").write_text("raise RuntimeError('never execute during discovery')\n")
            for folder in ("data/history", "scripts", "tests", "node_modules/pkg", ".venv/pkg"):
                nested = app / folder
                nested.mkdir(parents=True)
                (nested / "record-template.md").write_text("# Not a collection\n")
                (nested / "example.md").write_text("# Not a record\n")
            export = root / "reports/fitness"
            export.mkdir(parents=True)
            (export / "2026-11-02.md").write_text("# Workout review\n")
            # Verify pruning, not merely filtering paths after traversing an app.
            import os
            walked = []
            original_walk = os.walk

            def record_walk(*args, **kwargs):
                for item in original_walk(*args, **kwargs):
                    walked.append(Path(item[0]))
                    yield item

            with patch.object(registry.os, "walk", side_effect=record_walk):
                result = registry.load_registry(root)
            by_path = {item["path"]: item for item in result["domains"]}
            self.assertEqual([p for p in by_path if p.startswith("minions")], ["minions/gym-tracker"])
            self.assertTrue(by_path["minions/gym-tracker"]["minion"])
            self.assertEqual(by_path["minions/gym-tracker"]["label"], "Gym Tracker")
            self.assertFalse(by_path["minions/gym-tracker"]["include_in_briefing"])
            self.assertFalse(any(p == app or app in p.parents for p in walked))
            sources = {item["path"] for item in registry.briefing_sources(result)}
            self.assertIn("reports/fitness", sources)
            self.assertFalse(any(p.startswith("minions") for p in sources))

    def test_invalid_ids_symlinks_and_dependencies_are_not_collections(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for folder in ("minions/Invalid_ID", "minions/.hidden", "node_modules/pkg", "notes/__pycache__"):
                nested = root / folder
                nested.mkdir(parents=True)
                (nested / "example.md").write_text("# Not a collection\n")
            outside = root / ".outside"
            outside.mkdir()
            (outside / "example.md").write_text("# Private\n")
            (root / "minions/linked-app").symlink_to(outside, target_is_directory=True)
            (root / "linked-records").symlink_to(outside, target_is_directory=True)
            by_path = {item["path"] for item in registry.discover_domains(root)}
            self.assertFalse(any(p.startswith("minions") for p in by_path))
            self.assertNotIn("node_modules", by_path)
            self.assertNotIn("notes/__pycache__", by_path)
            self.assertNotIn("linked-records", by_path)


if __name__ == "__main__":
    unittest.main()
