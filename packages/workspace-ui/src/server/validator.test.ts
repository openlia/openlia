import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    "---\n$schema: ./record-template.schema.json\nstatus: posted\n---\n# <Template Title>\n\n## Context\nSome context\n",
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
