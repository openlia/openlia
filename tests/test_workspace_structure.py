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

    def menu(self, folder="projects/daily-menu"):
        directory = self.workspace / folder
        directory.mkdir(parents=True)
        (directory / "menu-template.md").write_text("# Daily Menu\n\n## Lunch\n\n## Dinner\n")
        (directory / "2026-10-23.md").write_text("# Friday\n\n## Lunch\nRice\n\n## Dinner\nSoup\n")
        return directory

    def test_daily_menu_structure_and_requested_file_validate_without_schema(self):
        self.menu()
        registry = self.workspace / "workspace.yaml"
        registry.write_text(registry.read_text() + (
            "  - path: projects/daily-menu\n    kind: extension\n    label: Daily Menu\n"
            "    purpose: Family lunch and dinner plans.\n    lifecycle: Active until archived.\n"
            "    template: projects/daily-menu/menu-template.md\n"
        ))
        self.assertEqual(validator.validate_workspace(self.workspace), [])

    def test_template_boundary_does_not_disable_parent_contract(self):
        directory = self.menu()
        (self.workspace / "projects/invalid.md").write_text("# Missing project metadata\n")
        errors = validator.validate_workspace(self.workspace)
        self.assertTrue(any("projects/invalid.md" in error for error in errors))
        self.assertFalse(any("daily-menu" in error for error in errors))
        (directory / "2026-10-24.md").write_text("# Missing sections\n")
        self.assertTrue(any("2026-10-24.md" in error for error in validator.validate_workspace(self.workspace)))

    def test_organizational_ancestors_need_no_registration(self):
        self.menu("projects/family/plans/daily-menu")
        registry = self.workspace / "workspace.yaml"
        registry.write_text(registry.read_text() + (
            "  - path: projects/family/plans/daily-menu\n    kind: extension\n"
            "    label: Daily Menu\n    purpose: Family menus.\n    lifecycle: Until archived.\n"
            "    template: projects/family/plans/daily-menu/menu-template.md\n"
        ))
        self.assertEqual(validator.validate_workspace(self.workspace), [])

    def test_invalid_nested_schema_remains_an_error(self):
        directory = self.menu()
        (directory / "menu-template.md").write_text("---\n$schema: ./missing.schema.json\n---\n# Menu\n")
        errors = validator.validate_workspace(self.workspace)
        self.assertTrue(any("missing.schema.json" in error for error in errors))

    def test_routed_extension_still_requires_tags(self):
        self.menu()
        registry = self.workspace / "workspace.yaml"
        registry.write_text(registry.read_text() + (
            "  - path: projects/daily-menu\n    kind: extension\n    label: Daily Menu\n"
            "    purpose: Menus.\n    lifecycle: Until archived.\n    route: review\n"
        ))
        with self.assertRaisesRegex(ValueError, "needs tags"):
            validator.load_registry(self.workspace)


if __name__ == "__main__":
    unittest.main()
