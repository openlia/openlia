"""Check sharing manifests and the Hermes-side configuration execution gate."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "profile/system-skills/minion-authoring/scripts/minion_tool.py"
spec = importlib.util.spec_from_file_location("minion_distribution_tool", SCRIPT)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class MinionDistributionToolTests(unittest.TestCase):
    def test_shared_portable_path_contract(self):
        cases = json.loads((ROOT / "tests/fixtures/minion-package-paths.json").read_text())
        for path in cases["allowed"]:
            self.assertTrue(tool.portable_distribution_path(path), path)
        for path in cases["rejected"]:
            self.assertFalse(tool.portable_distribution_path(path), path)

    def test_scaffolds_reviewable_distribution_without_state(self):
        for runtime in ("python", "typescript"):
            with self.subTest(runtime=runtime), tempfile.TemporaryDirectory() as directory:
                tool.scaffold_minion(directory, "demo", "Demo", "Test app", runtime=runtime)
                app = Path(directory) / "minions/demo"
                self.assertEqual(tool.validate_distribution_manifest(app), [])
                manifest = json.loads((app / "minion.package.json").read_text())
                self.assertNotIn("config.json", manifest["files"])
                self.assertFalse(any(path.startswith("data/") for path in manifest["files"]))
                manifest["files"].append("data/items.json")
                (app / "minion.package.json").write_text(json.dumps(manifest))
                self.assertTrue(tool.validate_distribution_manifest(app))

    def test_pending_or_invalid_config_never_executes_code(self):
        with tempfile.TemporaryDirectory() as directory:
            tool.scaffold_minion(directory, "demo", "Demo", "Test app", runtime="python")
            app = Path(directory) / "minions/demo"
            config = app / "config.json"
            config.unlink()
            with patch.object(tool, "_run_subprocess") as execute:
                for mode in ("input", "heartbeat"):
                    with self.assertRaises(ValueError):
                        tool.run_minion(directory, "demo", mode=mode)
                config.write_text('{"trigger":{"on_new_entry":"not a boolean"}}')
                with self.assertRaises(tool.jsonschema.ValidationError):
                    tool.run_minion(directory, "demo")
                execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
