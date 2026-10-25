import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import YAML from "yaml";
import { validateOpenUIContent } from "./validator";

const features = resolve(import.meta.dir, "../../../../features");
const domains = [
  "personal-finance",
  "travel",
  "shopping",
  "monitors",
  "people",
  "decision-analysis",
];

for (const domain of domains) {
  const root = join(features, domain, "workspace");
  const paths = readdirSync(root, { recursive: true }).map(String);
  test(`${domain}: shipped OpenUI programs pass server diagnostics`, () => {
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

test("section and Kanban bindings are checked against the feature contract", () => {
  const root = join(features, "travel", "workspace");
  expect(
    validateOpenUIContent(
      root,
      "travel/trip-record.openui",
      'root = RecordSectionView("Missing section", "schedule")',
    ).errors.some((error) => error.startsWith("contract(template)")),
  ).toBe(true);
  expect(
    validateOpenUIContent(
      root,
      "travel/trip-dashboard.openui",
      'root = RecordKanban("missing_status")',
    ).errors.some((error) => error.startsWith("contract(schema)")),
  ).toBe(true);
});
