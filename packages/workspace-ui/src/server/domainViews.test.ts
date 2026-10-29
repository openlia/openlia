import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateFileFindings } from "./maintainer/engine";
import {
  validateEntireWorkspace,
  validateMarkdownOpenUIBlocks,
  validateRecordContent,
} from "./validator";

test("workspace-template passes entire workspace validation", () => {
  const result = validateEntireWorkspace(
    resolve(import.meta.dir, "../../../../workspace-template"),
  );
  expect(result.issues).toEqual([]);
  expect(result.valid).toBe(true);
});

test("inline OpenUI supports bare roots, named arguments, and row tables", () => {
  expect(
    validateMarkdownOpenUIBlocks(
      '# Menu\n\n```openui\nTable(title: "Thực đơn ngày 29/10/2026", columns: [{key: "dish", label: "Món ăn"}], rows: [{dish: "Phở bò"}])\n```',
    ),
  ).toEqual([]);
});

test("inline diagnostics preserve frontmatter line offsets and remain advisory", () => {
  const root = mkdtempSync(join(tmpdir(), "openlia-inline-"));
  try {
    const content =
      "---\ntitle: Menu\n---\n# Menu\n\n```openui\nUnknownWidget()\n```";
    writeFileSync(join(root, "menu.md"), content);
    const validation = validateRecordContent(root, "menu.md", content);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings?.[0]).toContain("openui_syntax_error: line 7:");
    const overview = validateEntireWorkspace(root);
    expect(overview.valid).toBe(true);
    expect(overview.issues[0]?.warnings).toEqual(validation.warnings);
    const findings = evaluateFileFindings(
      root,
      "test",
      "menu.md",
      content,
      "revision",
    );
    expect(
      findings.some(
        (finding) =>
          finding.rule_code === "openui_syntax_error" &&
          finding.severity === "warning",
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record contracts are still checked independently of presentation", () => {
  const root = mkdtempSync(join(tmpdir(), "openlia-inline-contract-"));
  try {
    mkdirSync(join(root, "notes"));
    writeFileSync(
      join(root, "notes/note-template.md"),
      "# Note\n\n## Details\n",
    );
    const result = validateRecordContent(
      root,
      "notes/item.md",
      "# Item\n\n```openui\nUnknownWidget()\n```\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("Details");
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(validateRecordContent(root, "notes/ui.openui", "broken").valid).toBe(
      true,
    );
    expect(
      validateRecordContent(root, "notes/project-manifest.toml", "broken")
        .valid,
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
