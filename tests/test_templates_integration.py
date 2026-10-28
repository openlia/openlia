import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/test_templates_integration.py"
spec = importlib.util.spec_from_file_location("templates_integration", SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class TemplatesIntegrationRunnerTests(unittest.TestCase):
    def test_environment_does_not_select_live_deployments(self):
        with patch.dict(os.environ, {
            "OPENLIA_WORKSPACE_ROOT": "/real/user/workspace",
            "HERMES_HOME": "/real/user/home",
            "LOCHO_HOST": "production",
            "WORKSPACE_UI_E2E_MODE": "mock",
            "EXAMPLE_API_KEY": "secret",
            "GH_TOKEN": "secret",
            "AWS_ACCESS_KEY_ID": "secret",
            "GIT_DIR": "/real/user/repository/.git",
            "SSH_AUTH_SOCK": "/real/ssh-agent.sock",
            "PATH": "/safe/bin",
        }, clear=True):
            self.assertEqual(runner.child_environment(), {"PATH": "/safe/bin"})

    def test_checkout_identity_distinguishes_dirty_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)

            def git(*args):
                subprocess.run(["git", "-C", str(root), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", *args], check=True, capture_output=True)

            git("init", "-q")
            (root / "tracked.txt").write_text("original")
            git("add", ".")
            git("commit", "-qm", "initial")
            clean = runner.checkout_identity(root)
            self.assertFalse(clean["dirty"])
            (root / "tracked.txt").write_text("local changes")
            dirty = runner.checkout_identity(root)
            self.assertTrue(dirty["dirty"])
            self.assertEqual(dirty["revision"], clean["revision"])
            self.assertNotEqual(dirty["working_tree_sha256"], clean["working_tree_sha256"])
            self.assertEqual(dirty, runner.checkout_identity(root))


if __name__ == "__main__":
    unittest.main()
