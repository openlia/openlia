import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const [name, content, expectedError] of [
  ["missing document", undefined, "missing inline OpenUI view"],
  ["plain Markdown", "# Calendar\n", "missing inline OpenUI view"],
  [
    "invalid inline component",
    "# Calendar\n\n```openui\nUnknownWidget()\n```\n",
    "UnknownWidget",
  ],
  [
    "inline Calendar",
    "# Calendar\n\n```openui\nCalendar([CalendarMonth()])\n```\n",
    undefined,
  ],
] as const) {
  test(`catalog contract checks ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "openlia-catalog-views-"));
    try {
      const templates = join(root, "templates");
      const calendar = join(templates, "features/calendar");
      mkdirSync(join(calendar, "workspace/calendar"), { recursive: true });
      writeFileSync(
        join(calendar, "feature.yaml"),
        "schema: 1\nid: calendar\nname: Calendar\nversion: 0.3.0\ndescription: Test calendar\n",
      );
      if (content !== undefined) {
        writeFileSync(
          join(calendar, "workspace/calendar/overview.md"),
          content,
        );
      }
      const result = Bun.spawnSync(
        [
          process.execPath,
          "scripts/check-templates.ts",
          templates,
          join(root, "installed"),
        ],
        { cwd: resolve(import.meta.dir, "../..") },
      );
      if (expectedError) {
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(expectedError);
      } else {
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
        const report = JSON.parse(result.stdout.toString());
        expect(report.features).toEqual([
          { id: "calendar", version: "0.3.0", diagnostics: 1 },
        ]);
        expect(report.older_target_guard).toContain("passed");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
