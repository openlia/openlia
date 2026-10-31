import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openUIDiagnostics, openUIErrors } from "../shared/openui";
import {
  describeOpenUI,
  MAX_OPENUI_INPUT,
  openUIAuthoringRequest,
  validateOpenUI,
} from "../shared/openuiAuthoring";
import { openUIRecipes } from "../shared/openuiRecipes";

test("distributed instructions proactively consider OpenUI for data-rich documents", () => {
  for (const path of ["profile/AGENTS.md", "workspace-template/AGENTS.md"]) {
    const instructions = readFileSync(
      new URL(`../../../../${path}`, import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    for (const guidance of [
      "first-class presentation option",
      "reports, reviews, comparisons, or data-rich documents",
      "proactively consider OpenUI without waiting for the user to request it",
      "Prefer plain Markdown",
      "honor requests for plain-text or static output",
      "conclusions and source links in ordinary Markdown outside views",
      "distinguish missing data from zero",
      "Never invent data",
      "openui_describe",
      "openui_validate",
    ])
      expect(instructions, `${path}: ${guidance}`).toContain(guidance);
  }
});

test("the protected authoring skill supports report selection and ships its example", () => {
  const skill = readFileSync(
    new URL(
      "../../../../profile/system-skills/inline-openui-authoring/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  ).replace(/\s+/g, " ");
  for (const guidance of [
    "even without an explicit UI request",
    "Choose a useful presentation",
    "plain Markdown",
    "never invent values",
    "snapshot, not a live binding",
    "references/report-example.md",
    'format: "markdown"',
    "schema-valid",
  ])
    expect(skill, guidance).toContain(guidance);
  const distribution = readFileSync(
    new URL("../../../../profile/distribution.yaml", import.meta.url),
    "utf8",
  );
  expect(distribution).toContain("system-skills/inline-openui-authoring/");
});

test("the published report example validates every view against component schemas", () => {
  const report = readFileSync(
    new URL(
      "../../../../profile/system-skills/inline-openui-authoring/references/report-example.md",
      import.meta.url,
    ),
    "utf8",
  );
  const result = validateOpenUI(report, "markdown");
  expect(result).toMatchObject({
    status: "ok",
    valid: true,
    validationLevel: "schema",
    blockCount: 2,
    renderingVerified: false,
  });
  for (const block of result.blocks) expect(block.diagnostics).toEqual([]);
});

test("every published authoring recipe validates through the UI implementation", () => {
  for (const recipe of openUIRecipes) {
    expect(openUIDiagnostics(recipe.code), recipe.name).toEqual([]);
    const result = validateOpenUI(recipe.code, "openui");
    expect(result.valid).toBe(true);
    expect(result.blockCount).toBe(1);
    expect(result.renderingVerified).toBe(false);
    expect(openUIErrors(recipe.code)).toEqual([]);
  }
});

test("discovery is schema-derived, bounded, and includes Table shorthand", () => {
  expect(describeOpenUI().components).toContain("ChartPanel");
  const tabs = describeOpenUI("Tabs");
  if (!("positionalOrder" in tabs))
    throw new Error("Missing component description");
  expect(tabs.positionalOrder).toEqual(["items"]);
  expect(tabs.referencedComponents).toContain("TabItem");
  expect(tabs.recipes?.length).toBeGreaterThan(0);
  expect(describeOpenUI("Table")).toHaveProperty("rowTable");
  expect(describeOpenUI("NotAComponent").status).toBe("error");
  expect(JSON.stringify(describeOpenUI("Card")).length).toBeLessThan(10_000);
});

test("Markdown validation retains original block locations and actionable errors", () => {
  const draft =
    '# Menu\n\n```openui\nCardHeader(title: "Healthy")\n```\n\n```openui\nCardHeader(titel: "Typo")\n```\n';
  const result = validateOpenUI(draft, "markdown");
  expect(result.valid).toBe(false);
  expect(result.blockCount).toBe(2);
  expect(result.blocks[0]?.startLine).toBe(4);
  expect(result.blocks[0]?.diagnostics).toEqual([]);
  expect(result.blocks[1]).toMatchObject({
    block: 2,
    startLine: 8,
    locationScope: "block",
    diagnostics: [
      { code: "unknown-property", component: "CardHeader", path: "/titel" },
    ],
  });
  expect(result.blocks[1]?.diagnostics[0]?.hint).toContain("title");
  expect(
    validateOpenUI(draft.replace("titel:", "title:"), "markdown").valid,
  ).toBe(true);
});

test("schema errors preserve component and expected field details", () => {
  expect(openUIDiagnostics("TextContent(text: 12)")).toMatchObject([
    { code: "type-mismatch", component: "TextContent", path: "/text" },
  ]);
  expect(openUIDiagnostics("TextContent(text: missing)")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "unresolved-reference" }),
    ]),
  );
  for (const source of [
    "Tabs(children: [])",
    'Stack(children: [], gap: "medium")',
    'CardHeader(title: "one", title: "two")',
    'TextContent("one", size: "small")',
    'Table(columns: [{key: "a", label: "A"}], rows: [{a: {nested: true}}])',
    'UnknownWidget("Old")',
    'Card(children: [TextContent(text: "unfinished")]',
  ])
    expect(openUIDiagnostics(source).length, source).toBeGreaterThan(0);
});

test("escaping, comments, multiple assignments, and independent fences remain supported", () => {
  const code =
    'root = Stack(children: [TextContent(text: "Phở \\"quoted\\"\\nhttps://example.com/#section"), CardHeader(title: "Notes")]) // comment';
  expect(openUIDiagnostics(code)).toEqual([]);
  expect(
    openUIDiagnostics('heading = "Hello"\nroot = TextContent(text: heading)'),
  ).toEqual([]);
  const document = `> \`\`\`openui\n> ${code}\n> \`\`\`\n\n~~~openui\nTextContent(text: heading)\n~~~`;
  const result = validateOpenUI(document, "markdown");
  expect(result.blockCount).toBe(2);
  expect(result.blocks[0]?.diagnostics).toEqual([]);
  expect(result.blocks[1]?.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "unresolved-reference" }),
    ]),
  );
});

test("empty Markdown checks and request errors cannot masquerade as checked views", () => {
  const empty = validateOpenUI("No interactive views", "markdown");
  expect(empty.blockCount).toBe(0);
  expect(empty.valid).toBeNull();
  expect(empty.validationLevel).toBe("none");
  expect(empty.note).toContain("no views were validated");
  expect(validateOpenUI("", "openui").valid).toBe(false);
  for (const request of [
    null,
    [],
    { action: "write" },
    { action: "describe", component: 12 },
    { action: "validate", content: "x", format: "javascript" },
    {
      action: "validate",
      content: "x".repeat(MAX_OPENUI_INPUT + 1),
      format: "openui",
    },
  ])
    expect(() => openUIAuthoringRequest(request)).toThrow();
});

test("JSON stdin CLI validates drafts without touching the workspace", async () => {
  const process = Bun.spawn(["bun", "scripts/openui-authoring.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdin: new Blob([
      JSON.stringify({
        action: "validate",
        format: "openui",
        content: 'CardHeader(title: "Hello")',
      }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const response = JSON.parse(await new Response(process.stdout).text());
  expect(await process.exited).toBe(0);
  expect(response).toMatchObject({
    status: "ok",
    valid: true,
    validationLevel: "schema",
    renderingVerified: false,
  });
});

test("the release bundle works offline outside the source tree without node_modules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openlia-openui-"));
  try {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL("../../scripts/openui-authoring.ts", import.meta.url),
        ),
      ],
      target: "bun",
    });
    expect(build.success).toBe(true);
    const bundle = join(directory, "authoring.js");
    const output = build.outputs[0];
    if (!output) throw new Error("No bundled authoring output");
    await Bun.write(bundle, output);
    const process = Bun.spawn([Bun.which("bun") ?? "bun", bundle], {
      cwd: directory,
      stdin: new Blob(['{"action":"describe","component":"Tabs"}']),
      stdout: "pipe",
      stderr: "pipe",
    });
    const response = JSON.parse(await new Response(process.stdout).text());
    expect(await process.exited).toBe(0);
    expect(response.status).toBe("ok");
    expect(response.positionalOrder).toEqual(["items"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
