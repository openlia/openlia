import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractHeadings,
  isSimilarHeading,
  validateRecordContent,
} from "./validator";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlia-validator-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeDomain(directory: string, status: string) {
  mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(
    join(root, directory, "record-template.md"),
    `---\n$schema: ./record-template.schema.json\nstatus: ${status}\n---\n# <Template Title>\n\n## Context\nSome context\n`,
  );
  writeFileSync(
    join(root, directory, "record-template.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:openlia:test:record",
      type: "object",
      required: ["status"],
      properties: { status: { const: status } },
    }),
  );
}

const content =
  "---\nstatus: posted\n---\n# Record\n\n## Context\nContext here\n";

test("reuses a schema for repeated reads and multiple records", () => {
  writeDomain("finance/intake", "posted");
  for (const path of ["first.md", "first.md", "second.md", "first.md"]) {
    expect(
      validateRecordContent(root, `finance/intake/${path}`, content),
    ).toEqual({
      errors: [],
      schema_path: "finance/intake/record-template.schema.json",
      template_path: "finance/intake/record-template.md",
      valid: true,
    });
  }
});

test("recompiles edited schemas and recovers after an invalid edit", () => {
  writeDomain("finance", "posted");
  const validate = () =>
    validateRecordContent(root, "finance/record.md", content);
  expect(validate().valid).toBe(true);

  writeDomain("finance", "pending");
  expect(validate().errors).toEqual([
    "frontmatter/status: must be equal to constant",
  ]);
  expect(validate().valid).toBe(false);

  writeFileSync(join(root, "finance/record-template.schema.json"), "{");
  expect(validate().errors).toEqual([
    "Failed to load schema from finance/record-template.schema.json",
  ]);

  writeDomain("finance", "posted");
  expect(validate().valid).toBe(true);
});

test("isolates schemas with the same ID at different paths", () => {
  writeDomain("finance", "posted");
  writeDomain("reviews", "pending");
  expect(validateRecordContent(root, "finance/record.md", content).valid).toBe(
    true,
  );
  expect(
    validateRecordContent(root, "reviews/record.md", content).errors,
  ).toEqual(["frontmatter/status: must be equal to constant"]);
  expect(validateRecordContent(root, "finance/record.md", content).valid).toBe(
    true,
  );
});

test("plain menu template governs only its own folder", () => {
  writeDomain("projects", "active");
  mkdirSync(join(root, "projects/daily-menu"));
  writeFileSync(
    join(root, "projects/daily-menu/menu-template.md"),
    "# Daily Menu\n\n## Lunch\n\n## Dinner\n",
  );
  const result = validateRecordContent(
    root,
    "projects/daily-menu/2026-10-23.md",
    "# Friday\n\n## Lunch\nRice\n\n## Dinner\nSoup\n",
  );
  expect(result.valid).toBe(true);
  expect(result.schema_path).toBeUndefined();
  expect(result.template_path).toBe("projects/daily-menu/menu-template.md");
  expect(
    validateRecordContent(root, "projects/ordinary/note.md", "# No metadata")
      .valid,
  ).toBe(true);
  expect(
    validateRecordContent(
      root,
      "projects/daily-menu/2026-10-24.md",
      "# Missing sections",
    ).valid,
  ).toBe(false);
});

test("missing or invalid nested schema does not fall back to parent", () => {
  writeDomain("projects", "posted");
  mkdirSync(join(root, "projects/daily-menu"));
  writeFileSync(
    join(root, "projects/daily-menu/menu-template.md"),
    "---\n$schema: ./missing.schema.json\n---\n# Menu\n\n## Lunch\n",
  );
  const result = validateRecordContent(
    root,
    "projects/daily-menu/day.md",
    content,
  );
  expect(result.valid).toBe(false);
  expect(result.errors).toContain(
    "Invalid or missing local template schema: projects/daily-menu/menu-template.md",
  );
  writeFileSync(
    join(root, "projects/daily-menu/menu-template.md"),
    "---\nstatus: draft\n---\n# Menu\n",
  );
  expect(
    validateRecordContent(root, "projects/daily-menu/day.md", content).valid,
  ).toBe(false);
});

test("removing optional menu frontmatter needs no scaffolding or registry change", () => {
  writeDomain("projects", "active");
  mkdirSync(join(root, "projects/daily-menu"));
  writeFileSync(
    join(root, "workspace.yaml"),
    "domains:\n  - path: projects/daily-menu\n    template: projects/record-template.md\n",
  );
  const body = "# Menu\n\n## Lunch\nRice\n";
  for (const text of [
    `---\nstatus: draft\nmenu_date: 2026-10-24\n---\n${body}`,
    body,
  ]) {
    expect(
      validateRecordContent(root, "projects/daily-menu/day.md", text),
    ).toEqual({ errors: [], valid: true });
  }
  expect(validateRecordContent(root, "projects/record.md", body).valid).toBe(
    false,
  );
});

test("grandchildren do not inherit a plain local template", () => {
  mkdirSync(join(root, "menus/drafts"), { recursive: true });
  writeFileSync(join(root, "menus/menu-template.md"), "# Menu\n\n## Lunch\n");
  expect(
    validateRecordContent(root, "menus/day.md", "# Missing sections").valid,
  ).toBe(false);
  expect(
    validateRecordContent(root, "menus/drafts/day.md", "Free-form").valid,
  ).toBe(true);
});

test("multiple templates and malformed local contracts are errors", () => {
  writeDomain("projects", "posted");
  writeFileSync(join(root, "projects/other-template.md"), "# Other\n");
  expect(
    validateRecordContent(root, "projects/day.md", content).errors,
  ).toContain("Expected one workspace template per directory");
});

test("explicit record schemas are checked without a local template and cannot escape", () => {
  mkdirSync(join(root, "notes"));
  writeFileSync(
    join(root, "notes/note.schema.json"),
    JSON.stringify({ type: "object", required: ["date"] }),
  );
  const validate = (metadata: string) =>
    validateRecordContent(
      root,
      "notes/note.md",
      `---\n${metadata}\n---\n# Note\n`,
    );
  expect(validate("$schema: ./note.schema.json\ndate: 2026-10-24").valid).toBe(
    true,
  );
  expect(validate("$schema: ./note.schema.json").valid).toBe(false);
  for (const ref of [
    "../missing.json",
    "../../outside.json",
    "https://example.invalid/schema.json",
    "/etc/passwd",
  ]) {
    expect(validate(`$schema: ${ref}`).valid).toBe(false);
  }
});

test("a record directive cannot override its local plain template", () => {
  mkdirSync(join(root, "menus"));
  writeFileSync(join(root, "menus/menu-template.md"), "# Menu\n\n## Lunch\n");
  const metadata = "---\n$schema: ./missing.schema.json\n---\n";
  expect(
    validateRecordContent(
      root,
      "menus/day.md",
      `${metadata}# Menu\n\n## Lunch\n`,
    ).valid,
  ).toBe(true);
  expect(
    validateRecordContent(
      root,
      "menus/day.md",
      `${metadata}# Missing sections\n`,
    ).valid,
  ).toBe(false);
});

test("explicit record schemas reject symlinks and remote refs", () => {
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "notes/schema.json"), '{"type":"object"}');
  symlinkSync(join(root, "notes/schema.json"), join(root, "notes/linked.json"));
  const validate = (ref: string) =>
    validateRecordContent(
      root,
      "notes/note.md",
      `---\n$schema: ${ref}\n---\n# Note\n`,
    );
  expect(validate("./linked.json").valid).toBe(false);
  writeFileSync(
    join(root, "notes/schema.json"),
    '{"$ref":"https://example.invalid/schema"}',
  );
  expect(validate("./schema.json").valid).toBe(false);
});

test("invalid local template structure never becomes a freeform contract", () => {
  mkdirSync(join(root, "menus"));
  writeFileSync(join(root, "menus/menu-template.md"), "## No title\n");
  expect(validateRecordContent(root, "menus/day.md", "# Menu\n").valid).toBe(
    false,
  );
});

test("detects misspelled template section headings in records", () => {
  writeDomain("tasks", "posted");
  const typoContent =
    "---\nstatus: posted\n---\n# My Task\n\n## Conteext\nSome notes\n";
  const result = validateRecordContent(root, "tasks/task-1.md", typoContent);
  expect(result.valid).toBe(false);
  expect(result.template_path).toBe("tasks/record-template.md");
  expect(result.errors).toContain(
    "heading: missing section '## Context' (found misspelled '## Conteext')",
  );
});

test("detects completely missing template sections in records", () => {
  writeDomain("tasks", "posted");
  const missingContent =
    "---\nstatus: posted\n---\n# My Task\n\nNo sections here\n";
  const result = validateRecordContent(root, "tasks/task-1.md", missingContent);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain(
    "heading: missing required section '## Context'",
  );
});

test("requires level-one title in records and templates", () => {
  writeDomain("tasks", "posted");
  const noTitleContent = "---\nstatus: posted\n---\n## Context\nSome notes\n";
  const result = validateRecordContent(root, "tasks/task-1.md", noTitleContent);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain(
    "file must contain a level-one title ('# ...')",
  );
});

test("extracts headings ignoring fenced code blocks", () => {
  const md =
    "# Title\n\n```markdown\n# Not a title\n## Not a section\n```\n\n## Real Section\n";
  const headings = extractHeadings(md);
  expect(headings).toEqual([
    { level: 1, text: "Title" },
    { level: 2, text: "Real Section" },
  ]);
});

test("isSimilarHeading identifies close typos", () => {
  expect(isSimilarHeading("Context", "Conteext")).toBe(true);
  expect(isSimilarHeading("Definition of Done", "Definition of Dne")).toBe(
    true,
  );
  expect(isSimilarHeading("Context", "Milestones")).toBe(false);
});
