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
    def test_browser_projects_do_not_share_pending_proposals(self):
        with tempfile.TemporaryDirectory() as temp:
            scratch = Path(temp)
            source = scratch / "installed/workspace"
            source.mkdir(parents=True)
            (source / "starter.md").write_text("# Starter\n")
            desktop = runner.prepare_browser_workspace(source, scratch, "desktop")
            pending = desktop / "minions/personal-finance/data/pending"
            pending.mkdir(parents=True)
            (pending / "abandoned.json").write_text('{"status":"pending"}')
            mobile = runner.prepare_browser_workspace(source, scratch, "mobile")
            self.assertFalse((mobile / "minions/personal-finance/data/pending").exists())
            self.assertFalse((source / "minions").exists())
            self.assertEqual((mobile / "starter.md").read_text(), "# Starter\n")

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
