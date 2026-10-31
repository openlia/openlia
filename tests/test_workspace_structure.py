from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "profile/system-skills/workspace-template-customization/scripts/validate_workspace.py"
spec = importlib.util.spec_from_file_location("structure_validator", SCRIPT)
assert spec and spec.loader
validator = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = validator
spec.loader.exec_module(validator)


class WorkspaceStructureTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tempdir.name) / "workspace"
        shutil.copytree(ROOT / "workspace-template", self.workspace)

    def tearDown(self):
        self.tempdir.cleanup()

    def menu(self, folder="goals/daily-menu"):
        directory = self.workspace / folder
        directory.mkdir(parents=True)
        (directory / "menu-template.md").write_text("# Daily Menu\n\n## Lunch\n\n## Dinner\n")
        (directory / "2026-10-23.md").write_text("# Friday\n\n## Lunch\nRice\n\n## Dinner\nSoup\n")
        return directory

    def test_daily_menu_structure_and_requested_file_validate_without_schema(self):
        self.menu()
        self.assertEqual(validator.validate_workspace(self.workspace), [])

    def test_template_boundary_does_not_disable_parent_contract(self):
        directory = self.menu()
        (self.workspace / "goals/goal-template.md").write_text("# <Goal>\n\n## Outcome\n")
        (self.workspace / "goals/invalid.md").write_text("# Missing goal metadata\n")
        errors = validator.validate_workspace(self.workspace)
        self.assertTrue(any("goals/invalid.md" in error for error in errors))
        self.assertFalse(any("daily-menu" in error for error in errors))
        (directory / "2026-10-24.md").write_text("# Missing sections\n")
        self.assertTrue(any("2026-10-24.md" in error for error in validator.validate_workspace(self.workspace)))

    def test_organizational_ancestors_need_no_registration(self):
        self.menu("goals/family/plans/daily-menu")
        self.assertEqual(validator.validate_workspace(self.workspace), [])

    def test_invalid_nested_schema_remains_an_error(self):
        directory = self.menu()
        (directory / "menu-template.md").write_text("---\n$schema: ./missing.schema.json\n---\n# Menu\n")
        errors = validator.validate_workspace(self.workspace)
        self.assertTrue(any("missing.schema.json" in error for error in errors))

    def test_frontmatter_removal_in_supporting_folder_needs_no_template(self):
        directory = self.workspace / "goals/daily-menu"
        directory.mkdir(parents=True)
        record = directory / "2026-10-24.md"
        body = "# Daily Menu\n\n## Lunch\nRice\n\n## Dinner\nSoup\n"
        record.write_text("---\nmenu_date: 2026-10-24\nstatus: draft\n---\n" + body)
        self.assertEqual(validator.validate_workspace(self.workspace), [])
        record.write_text(body)
        self.assertEqual(validator.validate_workspace(self.workspace), [])
        self.assertEqual(record.read_text(), body)

    def test_grandchildren_and_registry_do_not_inherit_contracts(self):
        directory = self.menu()
        nested = directory / "drafts"
        nested.mkdir()
        (nested / "next-week.md").write_text("Free-form supporting text\n")
        self.assertEqual(validator.validate_workspace(self.workspace), [])

    def test_multiple_local_templates_are_an_error(self):
        directory = self.menu()
        (directory / "other-template.md").write_text("# Other\n")
        self.assertTrue(any("expected one workspace template" in error for error in validator.validate_workspace(self.workspace)))

    def test_explicit_record_schema_without_local_template(self):
        directory = self.workspace / "goals/notes"
        directory.mkdir(parents=True)
        (directory / "note.schema.json").write_text('{"type":"object","required":["date"],"properties":{"date":{"type":"string"}}}')
        record = directory / "note.md"
        record.write_text("---\n$schema: ./note.schema.json\ndate: 2026-10-24\n---\n# Note\n")
        self.assertEqual(validator.validate_workspace(self.workspace), [])
        record.write_text("---\n$schema: ./note.schema.json\n---\n# Note\n")
        self.assertTrue(any("date" in error for error in validator.validate_workspace(self.workspace)))
        record.write_text("---\n$schema: ../../../../outside.json\n---\n# Note\n")
        self.assertTrue(any("outside" in error for error in validator.validate_workspace(self.workspace)))

    def test_local_plain_contract_cannot_be_overridden_by_record_directive(self):
        directory = self.menu()
        record = directory / "2026-10-23.md"
        record.write_text("---\n$schema: ./missing.schema.json\n---\n# Menu\n\n## Lunch\n\n## Dinner\n")
        self.assertEqual(validator.validate_workspace(self.workspace), [])
        record.write_text("---\n$schema: ./missing.schema.json\n---\n# Missing sections\n")
        self.assertTrue(any("missing required section" in error for error in validator.validate_workspace(self.workspace)))

    def test_explicit_record_schema_rejects_symlinks_and_remote_refs(self):
        directory = self.workspace / "goals/notes"
        directory.mkdir(parents=True)
        schema = directory / "schema.json"
        schema.write_text('{"type":"object"}')
        (directory / "linked.json").symlink_to(schema)
        record = directory / "note.md"
        record.write_text("---\n$schema: ./linked.json\n---\n# Note\n")
        self.assertTrue(any("symbolic link" in error for error in validator.validate_workspace(self.workspace)))
        schema.write_text('{"$ref":"https://example.invalid/schema"}')
        record.write_text("---\n$schema: ./schema.json\n---\n# Note\n")
        self.assertTrue(any("remote references are disabled" in error for error in validator.validate_workspace(self.workspace)))

    def test_invalid_local_template_does_not_become_a_freeform_contract(self):
        directory = self.menu()
        (directory / "menu-template.md").write_text("## No title\n")
        self.assertTrue(any("exactly one non-empty level-one title" in error for error in validator.validate_workspace(self.workspace)))

    def test_top_level_unregistered_collection_is_discovered_automatically(self):
        self.menu("family-menu")
        reg = validator.load_registry(self.workspace)
        self.assertIsNotNone(reg)
        paths = {d["path"] for d in reg["domains"]}
        self.assertIn("family-menu", paths)
        self.assertEqual(validator.validate_workspace(self.workspace), [])

    def test_inline_openui_warnings_are_advisory(self):
        tasks_dir = self.workspace / "tasks"
        tasks_dir.mkdir(parents=True, exist_ok=True)
        (tasks_dir / "task-template.schema.json").write_text(
            '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"status":{"type":"string"},"priority":{"type":"string"}}}'
        )
        (tasks_dir / "task-template.md").write_text(
            "---\n$schema: ./task-template.schema.json\nstatus: todo\npriority: medium\n---\n# <Task>\n\n## Outcome\n"
        )
        note = self.workspace / "menu.md"
        note.write_text('# Menu\n\n```openui\nTable(title: "Menu", columns: [{key: "dish", label: "Dish"}], rows: [{dish: "Phở"}])\n```\n')
        self.assertEqual(validator.inline_openui_warnings(self.workspace), [])
        self.assertEqual(validator.validate_workspace(self.workspace), [])
        note.write_text('# Menu\n\n```openui\nTable(columns: [{key: "dish", label: "Dish"}], rows: [{dish: }])\n```\n')
        warnings = validator.inline_openui_warnings(self.workspace)
        self.assertTrue(any("openui_syntax_error: line 4:" in warning for warning in warnings))
        self.assertEqual(validator.validate_workspace(self.workspace), [])

    def test_minion_discovery_validation_and_nested_data_support(self):
        minion_dir = self.workspace / "minions" / "gym-tracker"
        (minion_dir / "data" / "2026" / "october").mkdir(parents=True)
        (minion_dir / "tests").mkdir(parents=True)
        (minion_dir / "node_modules" / "pkg").mkdir(parents=True)
        (minion_dir / "node_modules" / "pkg" / "broken.schema.json").write_text("{not-json")
        (minion_dir / "README.md").write_text("# Gym Tracker\n\nTrack workouts and personal records.\n")
        (minion_dir / "main.py").write_text("print('ok')\n")
        (minion_dir / "requirements.txt").write_text("pyyaml>=6.0\n")
        (minion_dir / "ui.openui").write_text(
            'Table(title: "Workouts", columns: [{key: "lift", label: "Lift"}], rows: [{lift: "Squat"}])\n'
        )
        (minion_dir / "data" / "workouts.json").write_text('[{"lift": "Squat"}]')
        (minion_dir / "data" / "2026" / "october" / "notes.md").write_text("# October PRs\n")
        (minion_dir / "tests" / "test_main.py").write_text("def test_ok(): assert True\n")

        self.assertEqual(validator.validate_workspace(self.workspace), [])
        self.assertEqual(validator.inline_openui_warnings(self.workspace), [])

        reg = validator.load_registry(self.workspace)
        self.assertIsNotNone(reg)
        by_path = {d["path"]: d for d in reg["domains"]}
        self.assertIn("minions/gym-tracker", by_path)
        self.assertTrue(by_path["minions/gym-tracker"].get("minion"))
        self.assertEqual(by_path["minions/gym-tracker"].get("entrypoint"), "main.py")
        self.assertEqual(by_path["minions/gym-tracker"].get("label"), "Gym Tracker")

        (minion_dir / "ui.openui").write_text("Table(columns: [)\n")
        warnings = validator.inline_openui_warnings(self.workspace)
        self.assertTrue(any("minions/gym-tracker/ui.openui: openui_syntax_error:" in w for w in warnings))

        (minion_dir / "main.py").unlink()
        errors = validator.validate_workspace(self.workspace)
        self.assertTrue(any("minions/gym-tracker: minion requires a main.py or main.ts entrypoint" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
