"""Checkpoint contracts without Hermes, network access, or provider calls."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "profile/plugins/openlia-workspace-git/git_proposals.py"
spec = importlib.util.spec_from_file_location("git_proposals", MODULE)
git_proposals = importlib.util.module_from_spec(spec)
spec.loader.exec_module(git_proposals)


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Tester")
        self.git("config", "user.email", "test@localhost")
        self.write("note.md", "original\n")
        self.git("add", ".")
        self.git("commit", "-m", "initial")
        self.engine = git_proposals.Checkpoints(self.root)

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.PIPE)

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def propose(self, groups=None):
        snapshot = self.engine.inspect()
        if groups is None:
            groups = [{"message": "backup: update records", "rationale": "Save the reviewed changes", "files": [f["path"] for f in snapshot["files"]]}]
        return self.engine.propose(snapshot["snapshot_id"], groups)

    def test_proposal_does_not_commit_or_stage_and_approval_is_idempotent(self):
        before = self.git("rev-parse", "HEAD")
        self.write("note.md", "reviewed\n")
        index = (self.root / ".git/index").read_bytes()
        proposal = self.propose()
        self.assertEqual(before, self.git("rev-parse", "HEAD"))
        self.assertEqual(index, (self.root / ".git/index").read_bytes())
        self.assertIn("+reviewed", proposal["files"][0]["diff"])
        applied = self.engine.approve(proposal["id"], 1)
        self.assertEqual(applied["status"], "applied")
        self.assertEqual(self.git("status", "--porcelain"), b"")
        self.assertEqual(self.git("show", "HEAD:note.md"), b"reviewed\n")
        self.assertEqual(self.engine.approve(proposal["id"], 1)["hashes"], applied["hashes"])

    def test_multiple_groups_exclusions_and_unrelated_staging(self):
        self.write("note.md", "changed\n")
        self.write("tasks/café space\t\n.md", "task\n")
        self.write("untouched.md", "leave staged\n")
        self.git("add", "untouched.md")
        proposal = self.propose([
            {"message": "backup: note", "rationale": "Note", "files": ["note.md"]},
            {"message": "backup: task", "rationale": "Task", "files": ["tasks/café space\t\n.md"]},
        ])
        self.assertIn("untouched.md", proposal["excluded"])
        applied = self.engine.approve(proposal["id"], 1)
        self.assertEqual(len(applied["hashes"]), 2)
        self.assertEqual(self.git("diff", "--cached", "--name-only").strip(), b"untouched.md")
        self.assertEqual(self.git("show", "HEAD:tasks/café space\t\n.md"), b"task\n")

    def test_stale_content_and_head_are_rejected(self):
        self.write("note.md", "reviewed\n")
        proposal = self.propose()
        self.write("note.md", "later\n")
        with self.assertRaisesRegex(git_proposals.ProposalError, "proposal_stale"):
            self.engine.approve(proposal["id"], 1)
        self.write("note.md", "reviewed\n")
        self.git("commit", "--allow-empty", "-m", "elsewhere")
        with self.assertRaisesRegex(git_proposals.ProposalError, "proposal_stale"):
            self.engine.approve(proposal["id"], 1)

    def test_revisions_and_dismissal(self):
        self.write("note.md", "reviewed\n")
        proposal = self.propose()
        revised = self.engine.propose(proposal["snapshot_id"], [{"message": "backup: revised message", "rationale": "User feedback", "files": ["note.md"]}], proposal["id"], 1)
        self.assertEqual(revised["revision"], 2)
        with self.assertRaisesRegex(git_proposals.ProposalError, "proposal_revision_conflict"):
            self.engine.approve(proposal["id"], 1)
        self.engine.dismiss(proposal["id"], 2)
        with self.assertRaisesRegex(git_proposals.ProposalError, "proposal_not_pending"):
            self.engine.approve(proposal["id"], 2)

    def test_deletions_and_renames(self):
        (self.root / "note.md").rename(self.root / "renamed.md")
        proposal = self.propose()
        self.engine.approve(proposal["id"], 1)
        self.assertEqual(self.git("status", "--porcelain"), b"")
        self.assertEqual(self.git("show", "HEAD:renamed.md"), b"original\n")

    def test_protected_files_and_password_redaction(self):
        for path in (".env.production", "nested/.env", "thing.secret.toml", "auth.json", "logs/log.txt", "nested/token.key"):
            self.write(path, "SUPER_SECRET")
        self.write("sources/document-passwords.toml", 'password = "SUPER_SECRET"')
        snapshot = self.engine.inspect()
        self.assertNotIn("SUPER_SECRET", json.dumps(snapshot))
        self.assertEqual(len(snapshot["excluded"]), 6)
        self.assertEqual(len(snapshot["files"]), 1)

    def test_large_artifact_is_explicitly_excluded_without_blocking_notes(self):
        (self.root / "large.pdf").write_bytes(b"x" * (2 * 1024 * 1024 + 1))
        self.write("note.md", "reviewed\n")
        proposal = self.propose()
        self.assertEqual(proposal["excluded"], ["large.pdf"])
        self.assertIn("2 MiB", proposal["exclusion_reasons"]["large.pdf"])
        self.engine.approve(proposal["id"], 1)
        self.assertEqual(self.git("status", "--porcelain").strip(), b"?? large.pdf")

    def test_reminder_summary_does_not_read_contents_or_create_snapshots(self):
        self.assertFalse(self.engine.summary()["dirty"])
        self.write("note.md", "private content not needed for reminders")
        with patch.object(self.engine, "entry", side_effect=AssertionError("must not read files")):
            result = self.engine.summary()
        self.assertEqual(result["changed_count"], 1)
        self.assertNotIn("private content", json.dumps(result))
        self.assertEqual(list(self.engine.store.glob("snapshot-*.json")), [])

    def test_partial_staging_is_preserved_and_rejected(self):
        self.write("note.md", "staged\n")
        self.git("add", "note.md")
        self.write("note.md", "unstaged\n")
        proposal = self.propose()
        index = (self.root / ".git/index").read_bytes()
        with self.assertRaisesRegex(git_proposals.ProposalError, "selected_file_partially_staged"):
            self.engine.approve(proposal["id"], 1)
        self.assertEqual(index, (self.root / ".git/index").read_bytes())
        self.assertFalse((self.root / ".git/index.lock").exists())

    def test_symlinks_conflicts_and_empty_proposals_fail(self):
        os.symlink("note.md", self.root / "link.md")
        with self.assertRaisesRegex(git_proposals.ProposalError, "symlink_not_supported"):
            self.engine.inspect()
        (self.root / "link.md").unlink()
        snapshot = self.engine.inspect()
        self.assertEqual(snapshot["files"], [])
        with self.assertRaises(git_proposals.ProposalError):
            self.engine.propose(snapshot["snapshot_id"], [])

    def test_index_busy_and_duplicate_paths_fail(self):
        self.write("note.md", "reviewed\n")
        proposal = self.propose()
        (self.root / ".git/index.lock").write_text("not ours")
        with self.assertRaisesRegex(git_proposals.ProposalError, "git_index_busy"):
            self.engine.approve(proposal["id"], 1)
        self.assertEqual((self.root / ".git/index.lock").read_text(), "not ours")
        with self.assertRaisesRegex(git_proposals.ProposalError, "invalid_or_duplicate"):
            self.engine.propose(proposal["snapshot_id"], proposal["commits"] * 2)

    def test_failure_before_publication_is_atomic(self):
        self.write("note.md", "reviewed\n")
        self.write("other.md", "other\n")
        proposal = self.propose([
            {"message": "backup: one", "rationale": "one", "files": ["note.md"]},
            {"message": "backup: two", "rationale": "two", "files": ["other.md"]},
        ])
        before = self.git("rev-parse", "HEAD")
        real_git = self.engine.git
        count = 0
        def fail(*args, **kwargs):
            nonlocal count
            if args[0] == "commit-tree":
                count += 1
                if count == 2:
                    raise git_proposals.ProposalError("injected_failure")
            return real_git(*args, **kwargs)
        with patch.object(self.engine, "git", side_effect=fail):
            with self.assertRaises(git_proposals.ProposalError):
                self.engine.approve(proposal["id"], 1)
        self.assertEqual(before, self.git("rev-parse", "HEAD"))
        self.assertFalse((self.root / ".git/index.lock").exists())

    def test_recovery_after_ref_publication_finishes_index_without_duplicate_commits(self):
        self.write("note.md", "reviewed\n")
        proposal = self.propose()
        real_replace = os.replace
        def crash(source, dest):
            if Path(dest).resolve() == (self.root / ".git/index").resolve():
                raise OSError("simulated crash after ref publication")
            return real_replace(source, dest)
        with patch.object(git_proposals.os, "replace", side_effect=crash):
            with self.assertRaises(OSError):
                self.engine.approve(proposal["id"], 1)
        published = self.git("rev-parse", "HEAD").decode().strip()
        self.assertTrue((self.root / ".git/index.lock").exists())
        applied = self.engine.approve(proposal["id"], 1)
        self.assertEqual(applied["hashes"], [published])
        self.assertEqual(self.git("status", "--porcelain"), b"")

    def test_failed_ref_publication_can_be_retried_safely(self):
        self.write("note.md", "reviewed\n")
        proposal = self.propose()
        real_git = self.engine.git
        def fail(*args, **kwargs):
            if args[0] == "update-ref":
                raise git_proposals.ProposalError("simulated_ref_failure")
            return real_git(*args, **kwargs)
        with patch.object(self.engine, "git", side_effect=fail):
            with self.assertRaises(git_proposals.ProposalError):
                self.engine.approve(proposal["id"], 1)
        self.assertTrue((self.root / ".git/index.lock").exists())
        applied = self.engine.approve(proposal["id"], 1)
        self.assertEqual(applied["status"], "applied")
        self.assertEqual(self.git("rev-list", "--count", "HEAD").strip(), b"2")

    def test_binary_executable_and_fully_staged_files(self):
        (self.root / "binary.dat").write_bytes(b"\0\xff\x01binary")
        self.write("run.sh", "#!/bin/sh\necho test\n")
        (self.root / "run.sh").chmod(0o755)
        self.git("add", "binary.dat", "run.sh")
        proposal = self.propose()
        self.assertIn("Binary files", next(f["diff"] for f in proposal["files"] if f["path"] == "binary.dat"))
        self.engine.approve(proposal["id"], 1)
        self.assertIn(b"100755", self.git("ls-tree", "HEAD", "run.sh"))
        self.assertEqual(self.git("show", "HEAD:binary.dat"), b"\0\xff\x01binary")
        self.assertEqual(self.git("status", "--porcelain"), b"")

    def test_proposed_paths_do_not_include_later_unrelated_edits(self):
        self.write("note.md", "reviewed\n")
        proposal = self.propose()
        self.write("later.md", "not reviewed\n")
        self.engine.approve(proposal["id"], 1)
        self.assertEqual(self.git("status", "--porcelain").strip(), b"?? later.md")

    def test_concurrent_confirmations_create_only_one_batch(self):
        self.write("note.md", "reviewed\n")
        proposal = self.propose()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.engine.approve(proposal["id"], 1), range(2)))
        self.assertEqual(results[0]["hashes"], results[1]["hashes"])
        self.assertEqual(self.git("rev-list", "--count", "HEAD").strip(), b"2")

    def test_checkpoint_after_empty_workspace_initialization(self):
        empty = self.root / "empty"
        empty.mkdir()
        def git(*args):
            return subprocess.check_output(["git", "-C", str(empty), *args], stderr=subprocess.PIPE)
        git("init", "-b", "main")
        git("config", "user.name", "Tester")
        git("config", "user.email", "test@localhost")
        git("commit", "--allow-empty", "-m", "initial")
        (empty / "first.md").write_text("first record")
        engine = git_proposals.Checkpoints(empty)
        snapshot = engine.inspect()
        proposal = engine.propose(snapshot["snapshot_id"], [{"message": "backup: first record", "rationale": "First checkpoint", "files": ["first.md"]}])
        engine.approve(proposal["id"], 1)
        self.assertEqual(git("status", "--porcelain"), b"")

    def test_plugin_exposes_only_review_tools(self):
        plugin_spec = importlib.util.spec_from_file_location("checkpoint_plugin_test", MODULE.parent / "__init__.py", submodule_search_locations=[str(MODULE.parent)])
        plugin = importlib.util.module_from_spec(plugin_spec)
        import sys
        sys.modules[plugin_spec.name] = plugin
        self.addCleanup(sys.modules.pop, plugin_spec.name, None)
        plugin_spec.loader.exec_module(plugin)
        tools = {}
        class Context:
            def register_tool(self, **kwargs):
                tools[kwargs["name"]] = kwargs["handler"]
        plugin.register(Context())
        self.assertEqual(set(tools), {"workspace_git_inspect", "workspace_git_proposals", "workspace_git_propose"})
        self.write("note.md", "reviewed\n")
        before = self.git("rev-parse", "HEAD")
        with patch.dict(os.environ, {"OPENLIA_WORKSPACE_ROOT": str(self.root)}):
            snapshot = json.loads(tools["workspace_git_inspect"]({}))
            self.assertTrue(snapshot["ok"])
            proposal = json.loads(tools["workspace_git_propose"]({"snapshot_id": snapshot["snapshot_id"], "commits": [{"message": "backup: note", "rationale": "Reviewed", "files": ["note.md"]}]}))
            self.assertEqual(proposal["status"], "pending")
            listed = json.loads(tools["workspace_git_proposals"]({}))
            self.assertEqual(listed["proposals"][0]["id"], proposal["id"])
        self.assertEqual(self.git("rev-parse", "HEAD"), before)


if __name__ == "__main__":
    unittest.main()
