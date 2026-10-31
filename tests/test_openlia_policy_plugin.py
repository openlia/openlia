from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
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
        self.permissions_file = Path(self.tempdir.name) / "permissions.yaml"
        shutil.copytree(TEMPLATE_ROOT, self.workspace)
        (self.workspace / "goals").mkdir(parents=True, exist_ok=True)
        (self.workspace / "goals/goal-template.md").write_text("# <Goal>\n", encoding="utf-8")
        (self.workspace / "tasks").mkdir(parents=True, exist_ok=True)
        self.permissions_file.write_text(
            "version: 1\n"
            "destructive:\n"
            "  delete_records: ask\n"
            "  overwrite_records: ask\n"
            "external:\n"
            "  send_messages: ask\n"
            "  modify_external_calendar: ask\n"
            "  purchases: ask\n"
            "  financial_transactions: ask\n"
            "scheduled_work:\n"
            "  enabled: true\n"
            "  report_destination: inbox/daily-briefing\n",
            encoding="utf-8",
        )
        self.module = load_plugin()
        self.policy = self.module.PolicyEnforcer(
            self.workspace, HELPER_PATH, permissions_file=self.permissions_file
        )

    def tearDown(self):
        self.tempdir.cleanup()

    def test_read_only_research_does_not_require_policy(self):
        policy = self.policy

        self.assertIsNone(policy.pre_tool_call("web_search", {"query": "Kyoto itinerary"}))
        self.assertIsNone(policy.pre_tool_call("read_file", {"path": "travel/trip.md"}))

    def test_openui_tools_use_fixed_read_only_json_protocol(self):
        self.assertIsNone(self.policy.pre_tool_call("openui_describe", {}))
        self.assertIsNone(self.policy.pre_tool_call("openui_validate", {"content": "draft"}))
        with patch.object(self.module.subprocess, "run") as run:
            run.return_value.stdout = json.dumps({"status": "ok", "validationLevel": "schema", "valid": True})
            run.return_value.returncode = 0
            result = json.loads(self.policy.tool_openui_validate('CardHeader(title: "Phở")', format="openui"))
            self.assertTrue(result["valid"])
            args, kwargs = run.call_args
            self.assertEqual(args[0], ["/usr/local/bin/bun", self.module.OPENUI_CLI])
            self.assertEqual(kwargs["cwd"], str(Path(self.module.OPENUI_CLI).parent))
            self.assertEqual(json.loads(kwargs["input"]), {"action": "validate", "format": "openui", "content": 'CardHeader(title: "Phở")'})
            self.assertFalse(kwargs.get("shell", False))
            self.assertEqual(kwargs["timeout"], 15)
            self.policy.tool_openui_describe(component="Tabs")
            self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"action": "describe", "component": "Tabs"})

    def test_openui_tool_failure_never_claims_validation(self):
        with patch.object(self.module.subprocess, "run", side_effect=FileNotFoundError):
            result = json.loads(self.policy.tool_openui_validate("draft"))
            self.assertEqual(result["status"], "unavailable")
            self.assertEqual(result["validationLevel"], "none")
            self.assertNotIn("valid", result)
        with patch.object(self.module.subprocess, "run") as run:
            run.return_value.stdout = "not json"
            result = json.loads(self.policy.tool_openui_describe())
            self.assertEqual(result["status"], "unavailable")
        with patch.object(self.module.subprocess, "run") as run:
            self.assertEqual(json.loads(self.policy.tool_openui_validate("x" * (self.module.MAX_OPENUI_INPUT + 1)))["status"], "error")
            self.assertEqual(json.loads(self.policy.tool_openui_validate("x", format="js"))["status"], "error")
            self.assertEqual(json.loads(self.policy.tool_openui_describe(component=12))["status"], "error")
            run.assert_not_called()

    def test_openui_tools_are_registered_with_read_only_draft_schemas(self):
        class Context:
            def __init__(self):
                self.tools = {}

            def register_hook(self, *_):
                pass

            def register_tool(self, **tool):
                self.tools[tool["name"]] = tool

        context = Context()
        with patch.object(self.module, "PolicyEnforcer", return_value=self.policy):
            self.module.register(context)
        self.assertIn("openui_describe", context.tools)
        validate = context.tools["openui_validate"]
        self.assertEqual(validate["schema"]["parameters"]["required"], ["content"])
        self.assertFalse(validate["schema"]["parameters"]["additionalProperties"])
        self.assertFalse(validate["is_async"])

    def test_checkpoint_proposals_are_interactive_and_commits_are_ui_only(self):
        self.assertIsNone(self.policy.pre_tool_call("workspace_git_inspect", {}))
        self.assertIsNone(self.policy.pre_tool_call("workspace_git_proposals", {}))
        self.assertIsNone(self.policy.pre_tool_call("workspace_git_propose", {}))
        self.policy.on_session_start(session_id="scheduled", platform="cron")
        decision = self.policy.pre_tool_call("workspace_git_propose", {}, session_id="scheduled")
        self.assertEqual(decision["action"], "block")
        for command in ("git add note.md", "git commit -m backup", "git -C /opt/data/workspace commit -m backup", "git update-ref refs/heads/main HEAD"):
            decision = self.policy.pre_tool_call("terminal", {"command": command})
            self.assertEqual(decision["action"], "block")
            self.assertIn("Git Activity", decision["message"])
        self.assertIsNone(self.policy.pre_tool_call("terminal", {"command": "git diff -- tasks/add.md"}))

    def test_tasks_and_new_top_level_domains_create_freely_without_registration(self):
        policy = self.policy

        self.assertIsNone(
            policy.pre_tool_call(
                "write_file", {"path": "tasks/kyoto-trip.md", "content": "draft"}
            )
        )
        self.assertIsNone(
            policy.pre_tool_call(
                "write_file", {"path": "travel/kyoto-trip.md", "content": "draft"}
            )
        )
        self.assertIsNone(
            policy.pre_tool_call(
                "write_file", {"path": "family-menu/2026-10-26.md", "content": "# Menu"}
            )
        )

    def test_ordinary_nested_folder_does_not_need_registration(self):
        self.assertIsNone(
            self.policy.pre_tool_call(
                "write_file", {"path": "goals/daily-menu/2026-10-23.md", "content": "# Menu"}
            )
        )

    def test_family_menu_inline_view_scaffolding_succeeds_without_structural_approval(self):
        args = {
            "mode": "patch",
            "patch": (
                "*** Add File: family-menu/menu-template.md\n+# Menu\n+## Lunch\n"
                "*** Add File: family-menu/menu.schema.json\n+{\"type\": \"object\"}\n"
                '*** Add File: family-menu/2026-10-26.md\n+# Monday\n+## Lunch\n+```openui\n+CardHeader(title: "Menu")\n+```\n'
            ),
        }
        self.assertIsNone(self.policy.pre_tool_call("patch", args))

    def test_inline_openui_findings_are_advisory_and_resolve_after_repair(self):
        path = "family-menu/menu.md"
        folder = self.workspace / "family-menu"
        folder.mkdir()
        target = self.workspace / path
        target.write_text('# Menu\n\n```openui\nTable(columns: [], rows: [{dish: }])\n```\n')
        findings = self.policy.maintainer.validate_and_reconcile_paths([path])
        inline = [finding for finding in findings if finding["rule_code"] == "openui_syntax_error"]
        self.assertTrue(inline)
        self.assertTrue(all(finding["severity"] == "warning" for finding in inline))
        target.write_text('# Menu\n\n```openui\nTable(columns: [{key: "dish", label: "Dish"}], rows: [{dish: "Phở"}])\n```\n')
        repaired = self.policy.maintainer.validate_and_reconcile_paths([path])
        self.assertFalse(any(finding["rule_code"] == "openui_syntax_error" and finding["present"] for finding in repaired))

    def test_template_and_schema_updates_are_allowed_while_agents_md_is_protected(self):
        for path in ("goals/goal-template.md", "goals/goal-template.schema.json"):
            decision = self.policy.pre_tool_call(
                "patch",
                {
                    "mode": "patch",
                    "patch": f"*** Update File: {path}\n@@\n+updated contract\n",
                },
            )
            self.assertIsNone(decision, path)

        for protected in ("AGENTS.md", "goals/AGENTS.md", "SOUL.md", "permissions.yaml"):
            decision = self.policy.pre_tool_call(
                "patch",
                {
                    "mode": "patch",
                    "patch": f"*** Update File: {protected}\n@@\n+blocked change\n",
                },
            )
            self.assertIsNotNone(decision, protected)
            self.assertEqual(decision["action"], "block", protected)

    def test_safety_boundaries_and_symlinks_are_blocked(self):
        (self.workspace / "goals/escape").symlink_to(
            self.workspace.parent, target_is_directory=True
        )
        for path in (
            "../outside.md",
            ".git/config",
            ".env",
            "sources/document-passwords.toml",
            "goals/escape/outside.md",
        ):
            decision = self.policy.pre_tool_call(
                "patch", {"mode": "patch", "patch": f"*** Add File: {path}\n+no\n"}
            )
            self.assertEqual(decision["action"], "block", path)

    def test_destructive_deny_blocks_delete_and_overwrite(self):
        self.permissions_file.write_text(
            self.permissions_file.read_text(encoding="utf-8")
            .replace("delete_records: ask", "delete_records: deny")
            .replace("overwrite_records: ask", "overwrite_records: deny"),
            encoding="utf-8",
        )
        decision = self.policy.pre_tool_call(
            "patch",
            {
                "mode": "patch",
                "patch": "*** Delete File: goals/goal-template.md\n",
            },
        )
        self.assertEqual(decision["action"], "block")
        decision = self.policy.pre_tool_call(
            "write_file", {"path": "goals/goal-template.md", "content": "replacement"}
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
        decision = self.policy.pre_tool_call(
            "patch",
            {
                "mode": "patch",
                "patch": "*** Update File: goals/daily-menu/2026-10-24.md\n@@\n----\n-status: draft\n----\n # Menu\n",
            },
        )
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
        outside = policy.pre_tool_call(
            "write_file",
            {"path": str(self.workspace / "tasks/cron-task.md"), "content": "no"},
            session_id="cron-session",
        )
        self.assertEqual(outside["action"], "block")

    def test_external_message_requires_approval(self):
        policy = self.policy

        decision = policy.pre_tool_call(
            "send_message", {"recipient": "user@example.com", "body": "hello"}
        )
        self.assertEqual(decision["action"], "approve")
        self.assertEqual(decision["rule_key"], "openlia.policy.send_messages")

    def test_missing_permissions_file_uses_safe_defaults(self):
        policy = self.policy
        self.permissions_file.unlink()

        self.assertIsNone(
            policy.pre_tool_call(
                "write_file", {"path": "tasks/new-trip.md", "content": "draft"}
            )
        )
        del_decision = policy.pre_tool_call(
            "patch",
            {"mode": "patch", "patch": "*** Delete File: tasks/new-trip.md\n"},
        )
        self.assertEqual(del_decision["action"], "approve")

    def test_invalid_permissions_file_fails_closed(self):
        policy = self.policy
        self.permissions_file.write_text("not: [valid", encoding="utf-8")

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
        for unsafe in (
            command + "; touch bad",
            command + " > output.json",
            command.replace(str(script), "other.py"),
            command + " --self-test",
        ):
            self.assertIsNotNone(
                self.policy.pre_tool_call("terminal", {"command": unsafe}), unsafe
            )

    def test_maintainer_tools_permissions(self):
        self.assertIsNone(self.policy.pre_tool_call("maintainer_status", {}))
        self.assertIsNone(self.policy.pre_tool_call("maintainer_audit", {}))
        self.assertIsNone(
            self.policy.pre_tool_call(
                "maintainer_triage_issue",
                {"action": "restore", "issue_id": "iss_1", "path": "tasks/a.md"},
            )
        )
        ignore_decision = self.policy.pre_tool_call(
            "maintainer_triage_issue",
            {"action": "ignore", "issue_id": "iss_1", "path": "tasks/a.md"},
        )
        self.assertEqual(ignore_decision["action"], "approve")
        self.assertEqual(ignore_decision["rule_key"], "openlia.policy.maintainer_ignore")

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

        for yt_url in (
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "https://youtu.be/jNQXAC9IVRw",
            "https://m.youtube.com/watch?v=jNQXAC9IVRw",
        ):
            web_decision = self.policy.pre_tool_call("web_extract", {"url": yt_url})
            self.assertIsNotNone(web_decision)
            self.assertEqual(web_decision["action"], "block")
            self.assertIn("ingestion_capture", web_decision["message"])

        self.assertIsNone(
            self.policy.pre_tool_call("web_extract", {"url": "https://example.com/article"})
        )

        for cmd in (
            "yt-dlp --write-subs https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "pip install youtube-transcript-api",
            "python3 -c 'import youtube_transcript_api'",
            "curl -s https://www.youtube.com/watch?v=jNQXAC9IVRw",
        ):
            term_decision = self.policy.pre_tool_call("terminal", {"command": cmd})
            self.assertIsNotNone(term_decision)
            self.assertEqual(term_decision["action"], "block")

    def test_post_mutation_advisory_feedback_and_ignore_suppression(self):
        menu_dir = self.workspace / "family-menu"
        menu_dir.mkdir(parents=True, exist_ok=True)
        (menu_dir / "menu-template.md").write_text(
            "---\nweek_of: 2026-10-26\n---\n\n# Family Menu\n\n## Meals\n\n## Shopping\n",
            encoding="utf-8",
        )
        menu_file = menu_dir / "2026-10-26.md"
        menu_file.write_text(
            "---\nweek_of: 2026-10-26\n---\n\n# Family Menu\n\n## Meals\n- Pho\n",
            encoding="utf-8",
        )

        # Post-tool call returns non-blocking advisory warning for missing Shopping section
        post_res = self.policy.post_tool_call(
            "write_file",
            args={"path": str(menu_file)},
            status="ok",
        )
        self.assertIsNotNone(post_res)
        self.assertIn("Saved successfully. 1 structural warning:", post_res["advisory"])
        self.assertIn("Missing template section '## Shopping'", post_res["advisory"])

        # Inspect via maintainer_status tool
        import json

        status_payload = json.loads(
            self.policy.tool_maintainer_status(path="family-menu/2026-10-26.md")
        )
        self.assertEqual(status_payload["counts"]["open"], 1)
        issue_id = status_payload["open_findings"][0]["issue_id"]

        # Ignore the exact issue in this file
        triage_payload = json.loads(
            self.policy.tool_maintainer_triage_issue(
                issue_id=issue_id,
                action="ignore",
                reason="No shopping list this week",
            )
        )
        self.assertTrue(triage_payload["ok"])
        self.assertEqual(triage_payload["finding"]["state"], "ignored")

        # Subsequent post-tool call does NOT re-inject the ignored warning
        suppressed = self.policy.post_tool_call(
            "write_file",
            args={"path": str(menu_file)},
            status="ok",
        )
        self.assertIsNone(suppressed)

        # Tomorrow's menu with the same missing section still surfaces the warning
        tomorrow_file = menu_dir / "2026-10-27.md"
        tomorrow_file.write_text(
            "---\nweek_of: 2026-10-27\n---\n\n# Family Menu\n\n## Meals\n- Bun Cha\n",
            encoding="utf-8",
        )
        tomorrow_res = self.policy.post_tool_call(
            "write_file",
            args={"path": str(tomorrow_file)},
            status="ok",
        )
        self.assertIsNotNone(tomorrow_res)
        self.assertIn("family-menu/2026-10-27.md", tomorrow_res["advisory"])

        # Restoring the ignored warning makes it active again
        restore_payload = json.loads(
            self.policy.tool_maintainer_triage_issue(
                issue_id=issue_id,
                action="restore",
            )
        )
        self.assertTrue(restore_payload["ok"])
        self.assertEqual(restore_payload["finding"]["state"], "open")

    def test_minion_full_autonomy_for_files_dependencies_and_execution(self):
        minion_dir = self.workspace / "minions" / "gym-tracker"
        (minion_dir / "data" / "nested").mkdir(parents=True)
        (minion_dir / "main.py").write_text("print('v1')\n", encoding="utf-8")
        (minion_dir / "ui.openui").write_text('CardHeader(title: "Gym")\n', encoding="utf-8")

        # Overwriting existing files inside minions/<slug>/ is allowed without overwrite_records approval
        self.assertIsNone(
            self.policy.pre_tool_call(
                "write_file",
                {"path": "minions/gym-tracker/main.py", "content": "print('v2')\n"},
            )
        )
        self.assertIsNone(
            self.policy.pre_tool_call(
                "write_file",
                {"path": "minions/gym-tracker/data/nested/workouts.json", "content": "[]"},
            )
        )

        # Running entrypoint, input handler, triggers, tests, and installing dependencies inside minions/<slug>/ is allowed autonomously
        autonomous_commands = [
            "python3 minions/gym-tracker/input.py --data '{\"item\": \"Squat 100kg\", \"notes\": \"w/ belt\"}'",
            "python3 minions/gym-tracker/main.py --trigger entry --entry '{\"item\": \"Squat 100kg\"}'",
            "python3 minions/gym-tracker/main.py --trigger heartbeat",
            "python3 minions/gym-tracker/main.py --input 'Squat 100kg'",
            "pytest minions/gym-tracker/tests",
            "python3 -m venv minions/gym-tracker/.venv && minions/gym-tracker/.venv/bin/pip install -r minions/gym-tracker/requirements.txt",
            "uv pip install -r minions/gym-tracker/requirements.txt",
            "cd minions/gym-tracker && bun install && bun test && bun main.ts --trigger heartbeat",
            "bun install --cwd=minions/gym-tracker",
        ]
        for cmd in autonomous_commands:
            self.assertIsNone(
                self.policy.pre_tool_call("terminal", {"command": cmd}),
                cmd,
            )

        # Scheduled cron heartbeat runs for minions are also allowed when scheduled_work is enabled
        self.policy.on_session_start(session_id="cron-minion-hb", platform="cron")
        self.assertIsNone(
            self.policy.pre_tool_call(
                "terminal",
                {"command": "python3 minions/gym-tracker/main.py --trigger heartbeat"},
                session_id="cron-minion-hb",
            )
        )
        self.assertIsNone(
            self.policy.pre_tool_call(
                "write_file",
                {"path": "minions/gym-tracker/dashboard.openui", "content": 'CardHeader(title: "Gym")\n'},
                session_id="cron-minion-hb",
            )
        )
        # Structural schema edits remain blocked during scheduled runs
        scheduled_schema = self.policy.pre_tool_call(
            "write_file",
            {"path": "minions/gym-tracker/input.schema.json", "content": "{}"},
            session_id="cron-minion-hb",
        )
        self.assertIsNotNone(scheduled_schema)
        self.assertEqual(scheduled_schema["action"], "block")

        # Commands escaping minions/<slug>/ or running arbitrary python outside minions still require approval
        non_minion_commands = [
            "python3 outside.py",
            "cd minions/gym-tracker && python3 ../../outside.py",
            "python3 -c 'import os'",
        ]
        for cmd in non_minion_commands:
            decision = self.policy.pre_tool_call("terminal", {"command": cmd})
            self.assertIsNotNone(decision, cmd)
            self.assertEqual(decision["action"], "approve", cmd)


if __name__ == "__main__":
    unittest.main()
