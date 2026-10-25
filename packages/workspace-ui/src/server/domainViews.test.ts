import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import YAML from "yaml";
import { validateOpenUIContent, validateProjectManifest } from "./validator";

const features = resolve(import.meta.dir, "../../../../features");
const workspaceTemplate = resolve(
  import.meta.dir,
  "../../../../workspace-template",
);
const domains = [
  "personal-finance",
  "travel",
  "shopping",
  "monitors",
  "people",
  "decision-analysis",
];

for (const baseDomain of ["tasks", "goals"]) {
  test(`workspace-template/${baseDomain}: shipped project-manifest.toml and ui.openui pass server diagnostics`, () => {
    const manifestPath = `${baseDomain}/project-manifest.toml`;
    const uiPath = `${baseDomain}/ui.openui`;
    const manifestResult = validateProjectManifest(
      workspaceTemplate,
      manifestPath,
      readFileSync(join(workspaceTemplate, manifestPath), "utf8"),
    );
    expect(manifestResult.errors).toEqual([]);
    const uiResult = validateOpenUIContent(
      workspaceTemplate,
      uiPath,
      readFileSync(join(workspaceTemplate, uiPath), "utf8"),
    );
    expect(uiResult.errors).toEqual([]);
  });
}

for (const domain of domains) {
  const root = join(features, domain, "workspace");
  const paths = readdirSync(root, { recursive: true }).map(String);
  test(`${domain}: shipped project-manifest.toml and OpenUI programs pass server diagnostics`, () => {
    const manifests = paths.filter((path) =>
      path.endsWith("project-manifest.toml"),
    );
    expect(manifests.length).toBeGreaterThan(0);
    for (const path of manifests) {
      const result = validateProjectManifest(
        root,
        path,
        readFileSync(join(root, path), "utf8"),
      );
      expect(result.errors).toEqual([]);
    }
    const layouts = paths.filter((path) => path.endsWith(".openui"));
    expect(layouts.length).toBeGreaterThan(0);
    for (const path of layouts) {
      const result = validateOpenUIContent(
        root,
        path,
        readFileSync(join(root, path), "utf8"),
      );
      expect(result.errors).toEqual([]);
    }
  });

  test(`${domain}: optional visual metadata does not invalidate legacy records`, () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    for (const path of paths.filter((path) =>
      path.endsWith("-template.schema.json"),
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
  const root = join(features, "travel", "workspace");
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
});
