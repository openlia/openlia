from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_PATH = REPO_ROOT / "profile/plugins/openlia-maintainer/__init__.py"
TEMPLATE_ROOT = REPO_ROOT / "workspace-template"


def load_plugin():
    spec = importlib.util.spec_from_file_location("openlia_maintainer_test", PLUGIN_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class MaintainerPluginTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tempdir.name) / "workspace"
        shutil.copytree(TEMPLATE_ROOT, self.workspace)
        (self.workspace / "goals").mkdir(parents=True, exist_ok=True)
        (self.workspace / "goals/goal-template.md").write_text("# <Goal>\n", encoding="utf-8")
        (self.workspace / "tasks").mkdir(parents=True, exist_ok=True)
        self.module = load_plugin()
        self.plugin = self.module.MaintainerPlugin(self.workspace)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_openui_tools_use_fixed_read_only_json_protocol(self):
        with patch.object(self.module.subprocess, "run") as run:
            run.return_value.stdout = json.dumps({"status": "ok", "validationLevel": "schema", "valid": True})
            run.return_value.returncode = 0
            result = json.loads(self.plugin.tool_openui_validate('CardHeader(title: "Phở")', format="openui"))
            self.assertTrue(result["valid"])
            args, kwargs = run.call_args
            self.assertEqual(args[0], ["/usr/local/bin/bun", self.module.OPENUI_CLI])
            self.assertEqual(kwargs["cwd"], str(Path(self.module.OPENUI_CLI).parent))
            self.assertEqual(json.loads(kwargs["input"]), {"action": "validate", "format": "openui", "content": 'CardHeader(title: "Phở")'})
            self.assertFalse(kwargs.get("shell", False))
            self.assertEqual(kwargs["timeout"], 15)
            self.plugin.tool_openui_describe(component="Tabs")
            self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"action": "describe", "component": "Tabs"})

    def test_openui_tool_failure_never_claims_validation(self):
        with patch.object(self.module.subprocess, "run", side_effect=FileNotFoundError):
            result = json.loads(self.plugin.tool_openui_validate("draft"))
            self.assertEqual(result["status"], "unavailable")
            self.assertEqual(result["validationLevel"], "none")
            self.assertNotIn("valid", result)
        with patch.object(self.module.subprocess, "run") as run:
            run.return_value.stdout = "not json"
            result = json.loads(self.plugin.tool_openui_describe())
            self.assertEqual(result["status"], "unavailable")
        with patch.object(self.module.subprocess, "run") as run:
            self.assertEqual(json.loads(self.plugin.tool_openui_validate("x" * (self.module.MAX_OPENUI_INPUT + 1)))["status"], "error")
            self.assertEqual(json.loads(self.plugin.tool_openui_validate("x", format="js"))["status"], "error")
            self.assertEqual(json.loads(self.plugin.tool_openui_describe(component=12))["status"], "error")
            run.assert_not_called()

    def test_tools_and_hooks_registration_has_no_pre_tool_call_blocker(self):
        class Context:
            def __init__(self):
                self.hooks = {}
                self.tools = {}

            def register_hook(self, name, handler):
                self.hooks[name] = handler

            def register_tool(self, **tool):
                self.tools[tool["name"]] = tool

        context = Context()
        with patch.object(self.module, "MaintainerPlugin", return_value=self.plugin):
            self.module.register(context)
        self.assertNotIn("pre_tool_call", context.hooks)
        self.assertIn("post_tool_call", context.hooks)
        self.assertIn("openui_describe", context.tools)
        self.assertIn("openui_validate", context.tools)
        self.assertIn("maintainer_status", context.tools)
        self.assertIn("maintainer_audit", context.tools)
        self.assertIn("maintainer_triage_issue", context.tools)
        validate = context.tools["openui_validate"]
        self.assertEqual(validate["schema"]["parameters"]["required"], ["content"])
        self.assertFalse(validate["schema"]["parameters"]["additionalProperties"])
        self.assertFalse(validate["is_async"])

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

        post_res = self.plugin.post_tool_call(
            "write_file",
            args={"path": str(menu_file)},
            status="ok",
        )
        self.assertIsNotNone(post_res)
        self.assertIn("Saved successfully. 1 structural warning:", post_res["advisory"])
        self.assertIn("Missing template section '## Shopping'", post_res["advisory"])

        status_payload = json.loads(
            self.plugin.tool_maintainer_status(path="family-menu/2026-10-26.md")
        )
        self.assertEqual(status_payload["counts"]["open"], 1)
        issue_id = status_payload["open_findings"][0]["issue_id"]

        triage_payload = json.loads(
            self.plugin.tool_maintainer_triage_issue(
                issue_id=issue_id,
                action="ignore",
                reason="No shopping list this week",
            )
        )
        self.assertTrue(triage_payload["ok"])
        self.assertEqual(triage_payload["finding"]["state"], "ignored")

        suppressed = self.plugin.post_tool_call(
            "write_file",
            args={"path": str(menu_file)},
            status="ok",
        )
        self.assertIsNone(suppressed)

        tomorrow_file = menu_dir / "2026-10-27.md"
        tomorrow_file.write_text(
            "---\nweek_of: 2026-10-27\n---\n\n# Family Menu\n\n## Meals\n- Bun Cha\n",
            encoding="utf-8",
        )
        tomorrow_res = self.plugin.post_tool_call(
            "write_file",
            args={"path": str(tomorrow_file)},
            status="ok",
        )
        self.assertIsNotNone(tomorrow_res)
        self.assertIn("family-menu/2026-10-27.md", tomorrow_res["advisory"])

        restore_payload = json.loads(
            self.plugin.tool_maintainer_triage_issue(
                issue_id=issue_id,
                action="restore",
            )
        )
        self.assertTrue(restore_payload["ok"])
        self.assertEqual(restore_payload["finding"]["state"], "open")

    def test_openui_tools_validate_and_describe(self):
        with patch.object(self.module.subprocess, "run") as run:
            run.return_value.stdout = json.dumps(
                {"status": "ok", "validationLevel": "schema", "valid": True}
            )
            run.return_value.returncode = 0
            dict_openui_val = json.loads(
                self.plugin.tool_openui_validate(
                    {
                        "content": 'Callout(variant: "info", title: "Thực đơn", description: "Hợp lệ")',
                        "format": "openui",
                    }
                )
            )
            self.assertEqual(dict_openui_val["status"], "ok")
            self.assertTrue(dict_openui_val["valid"])
            self.plugin.tool_openui_describe({"component": "Callout"})
            self.assertEqual(
                json.loads(run.call_args.kwargs["input"]),
                {"action": "describe", "component": "Callout"},
            )


if __name__ == "__main__":
    unittest.main()
