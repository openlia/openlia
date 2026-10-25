import { describe, expect, it } from "vitest";
import {
  addRecordChecklistItem,
  extractMarkdownChecklist,
  extractMarkdownSection,
  mutateRecordFrontmatter,
  parseMarkdownRecord,
  toggleRecordChecklistItem,
  updateRecordSectionContent,
} from "./recordMutator";

describe("recordMutator", () => {
  const sampleMarkdown = `---
status: todo
priority: high
tags:
  - work
  - urgent
---

# Buy Solar Panels

## Action
Research installers and compare quotes.

## Subtasks
- [ ] Call Company A
- [x] Check roof measurements
- [ ] Review subsidy terms

## Notes
Roof was inspected last month.
`;

  it("parses markdown frontmatter, title, sections, and checklists", () => {
    const parsed = parseMarkdownRecord(sampleMarkdown);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.metadata.status).toBe("todo");
    expect(parsed.metadata.priority).toBe("high");
    expect(parsed.title).toBe("Buy Solar Panels");
    expect(parsed.sections.Action).toBe(
      "Research installers and compare quotes.",
    );
    expect(parsed.sections.Notes).toBe("Roof was inspected last month.");

    const subtasks = parsed.checklists.Subtasks;
    expect(subtasks).toHaveLength(3);
    expect(subtasks![0]?.text).toBe("Call Company A");
    expect(subtasks![0]?.checked).toBe(false);
    expect(subtasks![1]?.text).toBe("Check roof measurements");
    expect(subtasks![1]?.checked).toBe(true);
  });

  it("extracts markdown sections and checklists safely", () => {
    expect(extractMarkdownSection(sampleMarkdown, "Action")).toBe(
      "Research installers and compare quotes.",
    );
    expect(extractMarkdownSection(sampleMarkdown, "Missing")).toBe("");

    const items = extractMarkdownChecklist(sampleMarkdown, "Subtasks");
    expect(items).toHaveLength(3);
    expect(items[0]?.text).toBe("Call Company A");

    const nonExistent = extractMarkdownChecklist(sampleMarkdown, "NonExistent");
    expect(nonExistent).toEqual([]);
  });

  it("mutates record frontmatter while preserving body and formatting", () => {
    const updated = mutateRecordFrontmatter(sampleMarkdown, {
      status: "in-progress",
      due_date: "2026-11-01",
    });
    expect(updated).toContain("status: in-progress");
    expect(updated).toContain("due_date: 2026-11-01");
    expect(updated).toContain("# Buy Solar Panels");
    expect(updated).toContain("## Action");
  });

  it("toggles markdown checklist items in-place", () => {
    const toggled = toggleRecordChecklistItem(
      sampleMarkdown,
      "Subtasks",
      0,
      true,
    );
    expect(toggled).toContain("- [x] Call Company A");

    const uncheck = toggleRecordChecklistItem(toggled, "Subtasks", 1, false);
    expect(uncheck).toContain("- [ ] Check roof measurements");
  });

  it("adds checklist items to existing section", () => {
    const withItem = addRecordChecklistItem(
      sampleMarkdown,
      "Subtasks",
      "Sign installation contract",
    );
    expect(withItem).toContain("- [ ] Sign installation contract");
  });

  it("adds checklist items to new section if missing", () => {
    const withNewSec = addRecordChecklistItem(
      sampleMarkdown,
      "Follow-up",
      "Schedule inspection",
    );
    expect(withNewSec).toContain("## Follow-up");
    expect(withNewSec).toContain("- [ ] Schedule inspection");
  });

  it("updates markdown section content", () => {
    const updated = updateRecordSectionContent(
      sampleMarkdown,
      "Notes",
      "Updated roof inspection details.",
    );
    expect(updated).toContain("Updated roof inspection details.");
  });
});
