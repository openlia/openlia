from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_PATH = REPO_ROOT / "profile/plugins/openlia-policy/__init__.py"
HELPER_PATH = (
    REPO_ROOT
    / "profile/system-skills/workspace-template-customization/scripts/workspace_registry.py"
)
TEMPLATE_ROOT = REPO_ROOT / "workspace-template"


def load_plugin():
    spec = importlib.util.spec_from_file_location("openlia_policy_test", PLUGIN_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class PolicyPluginTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tempdir.name) / "workspace"
        shutil.copytree(TEMPLATE_ROOT, self.workspace)
        self.module = load_plugin()
        self.policy = self.module.PolicyEnforcer(self.workspace, HELPER_PATH)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_read_only_research_does_not_require_policy(self):
        policy = self.policy

        self.assertIsNone(policy.pre_tool_call("web_search", {"query": "Kyoto itinerary"}))
        self.assertIsNone(policy.pre_tool_call("read_file", {"path": "travel/trip.md"}))

    def test_delegated_tasks_create_is_allowed(self):
        policy = self.policy

        self.assertIsNone(
            policy.pre_tool_call(
                "write_file", {"path": "tasks/kyoto-trip.md", "content": "draft"}
            )
        )

    def test_uninstalled_feature_domain_is_blocked_without_registry_batch(self):
        policy = self.policy
        decision = policy.pre_tool_call(
            "write_file", {"path": "travel/kyoto-trip.md", "content": "draft"}
        )
        self.assertEqual(decision["action"], "block")
        self.assertIn("outside registered domains", decision["message"])

    def test_ordinary_nested_folder_does_not_need_registration(self):
        self.assertIsNone(
            self.policy.pre_tool_call(
                "write_file", {"path": "goals/daily-menu/2026-10-23.md", "content": "# Menu"}
            )
        )

    def test_structure_is_approved_as_one_exact_batch_not_delegated(self):
        args = {
            "mode": "patch",
            "patch": (
                "*** Update File: workspace.yaml\n@@\n+  # proposed menu extension\n"
                "*** Add File: goals/daily-menu/menu-template.md\n+# Menu\n+## Lunch\n"
                "*** Add File: goals/daily-menu/2026-10-23.md\n+# Friday\n+## Lunch\n"
            ),
        }
        decision = self.policy.pre_tool_call("patch", args)
        self.assertEqual(decision["action"], "approve")
        self.assertTrue(decision["rule_key"].startswith("openlia.policy.workspace_structure."))
        changed = {**args, "patch": args["patch"].replace("Friday", "Saturday")}
        self.assertNotEqual(
            decision["rule_key"], self.policy.pre_tool_call("patch", changed)["rule_key"]
        )
        # Model-supplied approval cannot bypass the trusted Hermes gate.
        self.assertEqual(
            self.policy.pre_tool_call("patch", {**args, "approved": True})["action"], "approve"
        )
        directory = self.workspace / "goals/daily-menu"
        self.assertFalse(directory.exists())  # Proposing never applies changes.
        directory.mkdir()
        (directory / "2026-10-23.md").write_text("newer user work")
        self.assertNotEqual(
            decision["rule_key"], self.policy.pre_tool_call("patch", args)["rule_key"]
        )

    def test_template_and_schema_changes_require_approval(self):
        for path in (
            "goals/goal-template.md", "goals/goal-template.schema.json",
            "goals/AGENTS.md", "workspace.yaml",
        ):
            decision = self.policy.pre_tool_call(
                "patch", {
                    "mode": "patch", "patch": f"*** Update File: {path}\n@@\n+reviewed change\n"
                }
            )
            self.assertEqual(decision["action"], "approve", path)

    def test_new_top_level_extension_needs_registry_batch(self):
        path = "menus/2026-10-23.md"
        decision = self.policy.pre_tool_call("write_file", {"path": path, "content": "# Menu"})
        self.assertEqual(decision["action"], "block")
        args = {
            "mode": "patch",
            "patch": (
                "*** Update File: workspace.yaml\n@@\n+  # proposed extension\n"
                f"*** Add File: {path}\n+# Menu\n"
            ),
        }
        self.assertEqual(self.policy.pre_tool_call("patch", args)["action"], "approve")
        # No follow-on capability was granted by requesting or approving a batch.
        follow_on = self.policy.pre_tool_call(
            "write_file", {"path": "menus/other.md", "content": "other"}
        )
        self.assertEqual(follow_on["action"], "block")

    def test_structural_batch_preserves_safety_boundaries(self):
        prefix = "*** Update File: workspace.yaml\n@@\n+  # extension\n"
        (self.workspace / "goals/escape").symlink_to(self.workspace.parent, target_is_directory=True)
        for path in (
            "../outside.md", ".git/config", "assistant-policy.yaml", "goals/escape/outside.md"
        ):
            decision = self.policy.pre_tool_call(
                "patch", {"mode": "patch", "patch": prefix + f"*** Add File: {path}\n+no\n"}
            )
            self.assertEqual(decision["action"], "block", path)
        self.policy.on_session_start(session_id="scheduled", platform="cron")
        decision = self.policy.pre_tool_call(
            "patch", {"mode": "patch", "patch": prefix}, session_id="scheduled"
        )
        self.assertEqual(decision["action"], "block")

    def test_structural_batch_cannot_override_destructive_deny(self):
        path = self.workspace / "assistant-policy.yaml"
        path.write_text(path.read_text().replace("delete_records: ask", "delete_records: deny"))
        decision = self.policy.pre_tool_call(
            "patch", {
                "mode": "patch",
                "patch": (
                    "*** Update File: workspace.yaml\n@@\n+  # extension\n"
                    "*** Delete File: goals/goal-template.md\n"
                ),
            }
        )
        self.assertEqual(decision["action"], "block")
        path.write_text(path.read_text().replace("overwrite_records: ask", "overwrite_records: deny"))
        decision = self.policy.pre_tool_call(
            "write_file", {"path": "goals/goal-template.md", "content": "replacement"}
        )
        self.assertEqual(decision["action"], "block")

    def test_move_cannot_bypass_structural_approval(self):
        decision = self.policy.pre_tool_call(
            "patch", {
                "mode": "patch",
                "patch": "*** Move File: goals/note.md -> goals/menu-template.md\n",
            }
        )
        self.assertEqual(decision["action"], "block")

    def test_patch_update_is_allowed_but_direct_overwrite_requires_approval(self):
        policy = self.policy
        target = self.workspace / "tasks" / "kyoto-trip.md"
        target.write_text("existing\n", encoding="utf-8")

        overwrite = policy.pre_tool_call(
            "write_file", {"path": "tasks/kyoto-trip.md", "content": "replacement"}
        )
        self.assertEqual(overwrite["action"], "approve")
        self.assertIn("overwrite_records", overwrite["message"])

        patch = policy.pre_tool_call(
            "patch",
            {
                "mode": "patch",
                "patch": "*** Update File: tasks/kyoto-trip.md\n@@\n-existing\n+updated\n",
            },
        )
        self.assertIsNone(patch)

    def test_delete_requires_approval(self):
        policy = self.policy
        target = self.workspace / "tasks" / "old-trip.md"
        target.write_text("old\n", encoding="utf-8")

        decision = policy.pre_tool_call(
            "patch",
            {
                "mode": "patch",
                "patch": "*** Delete File: tasks/old-trip.md\n",
            },
        )
        self.assertEqual(decision["action"], "approve")
        self.assertEqual(decision["rule_key"], "openlia.policy.delete_records")

    def test_removing_optional_menu_frontmatter_is_a_delegated_update(self):
        directory = self.workspace / "goals/daily-menu"
        directory.mkdir()
        (directory / "2026-10-24.md").write_text("---\nstatus: draft\n---\n# Menu\n")
        decision = self.policy.pre_tool_call("patch", {
            "mode": "patch",
            "patch": "*** Update File: goals/daily-menu/2026-10-24.md\n@@\n----\n-status: draft\n----\n # Menu\n",
        })
        self.assertIsNone(decision)

    def test_path_escape_is_blocked(self):
        policy = self.policy

        decision = policy.pre_tool_call(
            "write_file", {"path": "../outside.md", "content": "no"}
        )
        self.assertEqual(decision["action"], "block")
        self.assertIn("unsafe workspace path", decision["message"])

    def test_scheduled_report_uses_report_destination(self):
        policy = self.policy
        policy.on_pre_llm_call(session_id="cron-session", platform="cron")
        path = self.workspace / "inbox/daily-briefing/2026-10-08.md"

        self.assertIsNone(
            policy.pre_tool_call(
                "write_file",
                {"path": str(path), "content": "briefing"},
                session_id="cron-session",
            )
        )

    def test_external_message_requires_approval(self):
        policy = self.policy

        decision = policy.pre_tool_call(
            "send_message", {"recipient": "user@example.com", "body": "hello"}
        )
        self.assertEqual(decision["action"], "approve")
        self.assertEqual(decision["rule_key"], "openlia.policy.send_messages")

    def test_missing_policy_falls_back_to_approval(self):
        policy = self.policy
        (self.workspace / "assistant-policy.yaml").unlink()

        decision = policy.pre_tool_call(
            "write_file", {"path": "tasks/new-trip.md", "content": "draft"}
        )
        self.assertEqual(decision["action"], "approve")
        self.assertEqual(decision["rule_key"], "openlia.policy.missing")

    def test_invalid_policy_fails_closed(self):
        policy = self.policy
        (self.workspace / "assistant-policy.yaml").write_text("not: [valid", encoding="utf-8")

        decision = policy.pre_tool_call(
            "write_file", {"path": "tasks/new-trip.md", "content": "draft"}
        )
        self.assertEqual(decision["action"], "block")
        self.assertIn("failed closed", decision["message"])

    def test_terminal_read_is_allowed_and_unknown_write_requires_approval(self):
        policy = self.policy

        self.assertIsNone(policy.pre_tool_call("terminal", {"command": "git status"}))
        decision = policy.pre_tool_call("terminal", {"command": "python3 build.py"})
        self.assertEqual(decision["action"], "approve")
        self.assertEqual(decision["rule_key"], "openlia.policy.terminal_write")

    def test_protected_validation_is_read_only_without_extra_approval(self):
        script = HELPER_PATH.parent / "validate_workspace.py"
        command = f"/opt/hermes/.venv/bin/python {script} --workspace-root {self.workspace} --json"
        self.assertIsNone(self.policy.pre_tool_call("terminal", {"command": command}))
        for unsafe in (command + "; touch bad", command + " > output.json", command.replace(str(script), "other.py"), command + " --self-test"):
            self.assertIsNotNone(self.policy.pre_tool_call("terminal", {"command": unsafe}), unsafe)
        (self.workspace / "workspace.yaml").write_text("not: [valid")
        self.assertIsNone(self.policy.pre_tool_call("terminal", {"command": command}))

    def test_unclassified_mutating_tool_requires_approval(self):
        decision = self.policy.pre_tool_call("skill_manage", {"action": "patch"})
        self.assertEqual(decision["action"], "approve")
        self.assertEqual(decision["rule_key"], "openlia.policy.unknown_mutation")

    def test_ingestion_password_tools_policy_classification(self):
        self.assertIsNone(
            self.policy.pre_tool_call("list_document_password_profiles", {})
        )
        self.assertIsNone(
            self.policy.pre_tool_call(
                "ingestion_suggest_passwords", {"filename": "statement.pdf"}
            )
        )
        del_decision = self.policy.pre_tool_call(
            "delete_document_password_profile", {"profile_id": "old_profile"}
        )
        self.assertEqual(del_decision["action"], "approve")
        self.assertEqual(del_decision["rule_key"], "openlia.policy.delete_records")

    def test_ingestion_delete_document_policy_classification(self):
        del_decision = self.policy.pre_tool_call(
            "ingestion_delete_document", {"source_id": "src_12345678"}
        )
        self.assertEqual(del_decision["action"], "approve")
        self.assertEqual(del_decision["rule_key"], "openlia.policy.delete_records")
        self.assertIn("delete_records on sources", del_decision["message"])

    def test_youtube_bypass_is_blocked_while_ingestion_is_allowed(self):
        # 1. ingestion_capture with kind="youtube" is allowed under delegated capture
        self.assertIsNone(
            self.policy.pre_tool_call(
                "ingestion_capture",
                {
                    "kind": "youtube",
                    "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                    "wait_seconds": 15,
                },
            )
        )

        # 2. web_extract on YouTube URLs is blocked
        for yt_url in (
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "https://youtu.be/jNQXAC9IVRw",
            "https://m.youtube.com/watch?v=jNQXAC9IVRw",
        ):
            web_decision = self.policy.pre_tool_call("web_extract", {"url": yt_url})
            self.assertIsNotNone(web_decision)
            self.assertEqual(web_decision["action"], "block")
            self.assertIn("ingestion_capture", web_decision["message"])

        # Non-YouTube web_extract remains allowed
        self.assertIsNone(
            self.policy.pre_tool_call("web_extract", {"url": "https://example.com/article"})
        )

        # 3. Terminal YouTube transcript helpers or package installs are blocked
        for cmd in (
            "yt-dlp --write-subs https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "pip install youtube-transcript-api",
            "python3 -c 'import youtube_transcript_api'",
            "curl -s https://www.youtube.com/watch?v=jNQXAC9IVRw",
        ):
            term_decision = self.policy.pre_tool_call("terminal", {"command": cmd})
            self.assertIsNotNone(term_decision)
            self.assertEqual(term_decision["action"], "block")
            self.assertIn("ingestion_capture", term_decision["message"])
