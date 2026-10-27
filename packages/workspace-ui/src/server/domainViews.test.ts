import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import YAML from "yaml";
import {
  validateEntireWorkspace,
  validateOpenUIContent,
  validateProjectManifest,
} from "./validator";

const workspaceTemplate = resolve(
  import.meta.dir,
  "../../../../workspace-template",
);
const siblingTemplatesFeatures = resolve(
  import.meta.dir,
  "../../../../../openlia_templates/features",
);

test("workspace-template passes entire workspace validation", () => {
  const result = validateEntireWorkspace(workspaceTemplate);
  expect(result.issues).toEqual([]);
  expect(result.valid).toBe(true);
});

test("synthetic project-manifest.toml and ui.openui pass server diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "openlia-domain-views-"));
  try {
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(
      join(root, "projects/item-template.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["title", "status"],
        properties: {
          title: { type: "string" },
          status: { type: "string", enum: ["todo", "in-progress", "done"] },
        },
        additionalProperties: false,
      }),
    );
    writeFileSync(
      join(root, "projects/item-template.md"),
      `---
$schema: "./item-template.schema.json"
title: "Sample Item"
status: "todo"
---
# Sample Item

## Notes
`,
    );
    const manifestContent = `version = 1

[project]
id = "projects"
name = "Projects"

[data]
records_glob = "*.md"
exclude = ["README.md", "item-template.md"]
template = "item-template.md"
schema = "item-template.schema.json"
status_field = "status"

[data.queries.open_count]
type = "count"
field = "status"
value = "todo"

[ui]
entry = "ui.openui"
`;
    writeFileSync(
      join(root, "projects/project-manifest.toml"),
      manifestContent,
    );
    const uiContent = `root = Stack([header, metric, kanban])
header = DomainHeader("Projects", "Track items")
metric = MetricCard("Open", @Query("open_count"))
kanban = RecordKanban("status")
`;
    writeFileSync(join(root, "projects/ui.openui"), uiContent);

    const manifestResult = validateProjectManifest(
      root,
      "projects/project-manifest.toml",
      manifestContent,
    );
    expect(manifestResult.errors).toEqual([]);
    const uiResult = validateOpenUIContent(
      root,
      "projects/ui.openui",
      uiContent,
    );
    expect(uiResult.errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (existsSync(siblingTemplatesFeatures)) {
  const domains = readdirSync(siblingTemplatesFeatures, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const domain of domains) {
    const root = join(siblingTemplatesFeatures, domain, "workspace");
    if (!existsSync(root)) continue;
    const paths = readdirSync(root, { recursive: true }).map(String);
    const manifests = paths.filter((path) =>
      path.endsWith("project-manifest.toml"),
    );
    const layouts = paths.filter((path) => path.endsWith(".openui"));
    if (manifests.length === 0 && layouts.length === 0) continue;

    test(`openlia_templates/${domain}: shipped project-manifest.toml and OpenUI programs pass server diagnostics`, () => {
      for (const path of manifests) {
        const result = validateProjectManifest(
          root,
          path,
          readFileSync(join(root, path), "utf8"),
        );
        expect(result.errors).toEqual([]);
      }
      for (const path of layouts) {
        const result = validateOpenUIContent(
          root,
          path,
          readFileSync(join(root, path), "utf8"),
        );
        expect(result.errors).toEqual([]);
      }
    });

    test(`openlia_templates/${domain}: optional visual metadata does not invalidate legacy records`, () => {
      const ajv = new Ajv2020({ strict: false });
      addFormats(ajv);
      for (const path of paths.filter((p) =>
        p.endsWith("-template.schema.json"),
      )) {
        const schema = JSON.parse(readFileSync(join(root, path), "utf8"));
        const template = readFileSync(
          join(root, path.replace(".schema.json", ".md")),
          "utf8",
        );
        const metadata = YAML.parse(template.split("---")[1] ?? "");
        delete metadata.$schema;
        for (const key of [
          "alerts",
          "budget",
          "target_price",
          "actual_price",
          "currency",
          "vendor_url",
          "last_checked",
          "last_contacted",
          "linked_records",
          "journal_path",
        ])
          delete metadata[key];
        const validate = ajv.compile(schema);
        expect(validate(metadata), JSON.stringify(validate.errors)).toBe(true);
      }
    });
  }
}

test("specialized component diagnostics reject invalid property contracts", () => {
  for (const program of [
    'root = DomainCollection("unsupported")',
    'root = RecordSectionView("Notes", "unsupported")',
    'root = RecordProfile("unsupported")',
  ]) {
    expect(
      validateOpenUIContent("/nonexistent", "custom.openui", program).valid,
    ).toBe(false);
  }
});

test("manifest queries and Kanban bindings are checked against the feature contract", () => {
  const root = mkdtempSync(join(tmpdir(), "openlia-domain-contract-"));
  try {
    mkdirSync(join(root, "travel"), { recursive: true });
    writeFileSync(
      join(root, "travel/trip-template.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["title", "status"],
        properties: {
          title: { type: "string" },
          status: { type: "string", enum: ["planned", "active", "done"] },
        },
      }),
    );
    writeFileSync(
      join(root, "travel/trip-template.md"),
      `---
$schema: "./trip-template.schema.json"
title: "Sample Trip"
status: "planned"
---
# Sample Trip
`,
    );
    writeFileSync(
      join(root, "travel/project-manifest.toml"),
      `version = 1
[project]
id = "travel"
name = "Travel"
[data]
template = "trip-template.md"
schema = "trip-template.schema.json"
status_field = "status"
[ui]
entry = "ui.openui"
`,
    );
    expect(
      validateOpenUIContent(
        root,
        "travel/ui.openui",
        'root = MetricCard("Bad", @Query("missing_query"))',
      ).errors.some((error) => error.startsWith("contract(manifest)")),
    ).toBe(true);
    expect(
      validateOpenUIContent(
        root,
        "travel/ui.openui",
        'root = RecordKanban("missing_status")',
      ).errors.some((error) => error.startsWith("contract(schema)")),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
