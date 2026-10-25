import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createParser } from "@openuidev/lang-core";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import YAML from "yaml";
import type {
  WorkspaceDiagnosticIssue,
  WorkspaceDiagnosticsResponse,
  WorkspaceFileValidation,
} from "../shared/api";
import { isConfigurationPath, protectedPath } from "./workspace";

const OPENUI_KNOWN_COMPONENTS = new Set([
  // @openuidev/react-ui built-in components
  "Stack",
  "Card",
  "CardHeader",
  "TextContent",
  "MarkDownRenderer",
  "Callout",
  "TextCallout",
  "InlineHeader",
  "Table",
  "Col",
  "EditableTable",
  "BarChart",
  "LineChart",
  "AreaChart",
  "RadarChart",
  "HorizontalBarChart",
  "Series",
  "PieChart",
  "RadialChart",
  "SingleStackedBarChart",
  "Slice",
  "Form",
  "FormControl",
  "Label",
  "Input",
  "TextArea",
  "Select",
  "SelectItem",
  "DatePicker",
  "Slider",
  "CheckBoxGroup",
  "CheckBoxItem",
  "RadioGroup",
  "RadioItem",
  "SwitchGroup",
  "SwitchItem",
  "Chips",
  "ChipItem",
  "Button",
  "Buttons",
  "IconButton",
  "Tabs",
  "TabItem",
  "Accordion",
  "AccordionItem",
  "Steps",
  "StepsItem",
  "Separator",
  "TagBlock",
  "Tag",
  "EntityList",
  "ListBlock",
  "ListItem",
  "Text",
  "BoldText",
  "IconText",
  "MetricIndicatorInline",
  "OverviewCardBlock",
  "OverviewCardItem",
  "Modal",
  // OpenLia custom components
  "DomainHeader",
  "MetricCard",
  "RecordKanban",
  "RecordTable",
  "RecordHeaderCard",
  "FrontmatterEditorCard",
  "ChecklistSection",
  "MarkdownSectionCard",
  "ClaimProvenanceCard",
  "DecisionMatrixCard",
  // Built-in OpenUI expressions
  "Query",
  "Mutation",
  "Action",
]);

const OPENUI_KNOWN_FUNCTIONS = new Set([
  // Built-in OpenUI functions
  "Count",
  "Sum",
  "Avg",
  "Min",
  "Max",
  "First",
  "Last",
  "Sort",
  "Filter",
  "Pluck",
  "Each",
  "Round",
  "Abs",
  "Upper",
  "Lower",
  "Trim",
  "Join",
  "Split",
  "Default",
  "Length",
  "Contains",
  "Keys",
  "Values",
  // OpenLia custom functions
  "CountBy",
  "GroupCount",
  "FilterRecords",
  "SumBy",
  "Section",
  "Checklist",
]);

const openuiSchemaDefs = Object.fromEntries(
  [...OPENUI_KNOWN_COMPONENTS].map((name) => [name, { type: "object" }]),
);
const openuiParser = createParser({ $defs: openuiSchemaDefs });

export function validateOpenUIContent(
  workspaceRoot: string,
  relativePath: string,
  content: string,
): WorkspaceFileValidation {
  const normalized = relativePath.replaceAll("\\", "/");
  const errors: string[] = [];
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      errors: ["OpenUI file must not be empty"],
      valid: false,
    };
  }

  const parseResult = openuiParser.parse(content);
  for (const err of parseResult.meta.errors) {
    errors.push(`openui(${err.code}): ${err.message}`);
  }
  if (!parseResult.root) {
    errors.push("openui: missing required 'root = ...' statement");
  }

  // Check unknown @Function(...) calls
  for (const match of content.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const fnName = match[1];
    if (fnName && !OPENUI_KNOWN_FUNCTIONS.has(fnName)) {
      errors.push(`openui(unknown-function): Unknown function '@${fnName}'`);
    }
  }

  // Discover domain template and schema for cross-contract validation
  const domain = findDomainTemplate(workspaceRoot, normalized);
  let schemaProps: Set<string> | null = null;
  let templateSections: Set<string> | null = null;

  if (domain?.schemaAbsolutePath && existsSync(domain.schemaAbsolutePath)) {
    try {
      const rawSchema = JSON.parse(
        readFileSync(domain.schemaAbsolutePath, "utf-8"),
      );
      if (rawSchema?.properties && typeof rawSchema.properties === "object") {
        schemaProps = new Set(Object.keys(rawSchema.properties));
      }
    } catch {}
  }

  if (domain?.templateRelativePath) {
    const tplAbs = resolve(workspaceRoot, domain.templateRelativePath);
    if (existsSync(tplAbs)) {
      try {
        const tplContent = readFileSync(tplAbs, "utf-8");
        const headings = extractHeadings(
          parseRecordFrontmatter(tplContent).body,
        );
        templateSections = new Set(
          headings
            .filter((h) => h.level === 2)
            .map((h) => h.text.trim().toLowerCase())
            .filter(Boolean),
        );
      } catch {}
    }
  }

  if (schemaProps && schemaProps.size > 0) {
    // Check $record.frontmatter.<key> references
    for (const match of content.matchAll(
      /\$[A-Za-z0-9_]+\.frontmatter\.([A-Za-z0-9_-]+)/g,
    )) {
      const key = match[1];
      if (key && key !== "$schema" && !schemaProps.has(key)) {
        errors.push(
          `contract(schema): frontmatter field '${key}' is not defined in ${domain?.schemaRelativePath ?? "domain schema"}`,
        );
      }
    }

    // Check FrontmatterEditorCard($record, ["field1", "field2"])
    for (const match of content.matchAll(
      /FrontmatterEditorCard\s*\([^,]+,\s*\[([^\]]*)\]/g,
    )) {
      const listRaw = match[1] ?? "";
      for (const strMatch of listRaw.matchAll(/"([^"]+)"|'([^']+)'/g)) {
        const field = strMatch[1] ?? strMatch[2];
        if (field && field !== "$schema" && !schemaProps.has(field)) {
          errors.push(
            `contract(schema): FrontmatterEditorCard field '${field}' is not defined in ${domain?.schemaRelativePath ?? "domain schema"}`,
          );
        }
      }
    }

    // Check RecordKanban($records.records, "groupField", ...)
    for (const match of content.matchAll(
      /RecordKanban\s*\([^,]+,\s*(?:"([^"]+)"|'([^']+)')/g,
    )) {
      const groupField = match[1] ?? match[2];
      if (
        groupField &&
        groupField !== "$schema" &&
        !schemaProps.has(groupField)
      ) {
        errors.push(
          `contract(schema): RecordKanban group field '${groupField}' is not defined in ${domain?.schemaRelativePath ?? "domain schema"}`,
        );
      }
    }

    // Check @CountBy / @GroupCount / @FilterRecords / @SumBy field argument
    for (const match of content.matchAll(
      /@(?:CountBy|GroupCount|FilterRecords|SumBy)\s*\([^,]+,\s*(?:"([^"]+)"|'([^']+)')/g,
    )) {
      const field = match[1] ?? match[2];
      if (
        field &&
        field !== "$schema" &&
        field !== "title" &&
        field !== "filename" &&
        field !== "path" &&
        !schemaProps.has(field)
      ) {
        errors.push(
          `contract(schema): query function field '${field}' is not defined in ${domain?.schemaRelativePath ?? "domain schema"}`,
        );
      }
    }
  }

  if (templateSections && templateSections.size > 0) {
    // Check @Section(..., "Heading") and @Checklist(..., "Heading")
    for (const match of content.matchAll(
      /@(?:Section|Checklist)\s*\([^,]+,\s*(?:"([^"]+)"|'([^']+)')/g,
    )) {
      const heading = (match[1] ?? match[2] ?? "").trim();
      if (heading && !templateSections.has(heading.toLowerCase())) {
        errors.push(
          `contract(template): section '## ${heading}' is not defined in ${domain?.templateRelativePath ?? "domain template"}`,
        );
      }
    }
  }

  return {
    errors,
    ...(domain?.schemaRelativePath
      ? { schema_path: domain.schemaRelativePath }
      : {}),
    ...(domain?.templateRelativePath
      ? { template_path: domain.templateRelativePath }
      : {}),
    valid: errors.length === 0,
  };
}

const compiledValidators = new Map<
  string,
  { content: string; validate: ValidateFunction }
>();

export function parseRecordFrontmatter(content: string): {
  metadata: Record<string, unknown> | null;
  body: string;
  hasFrontmatter: boolean;
} {
  if (!content.startsWith("---")) {
    return { body: content, hasFrontmatter: false, metadata: null };
  }

  const match = content.match(
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!match || match[1] === undefined) {
    return { body: content, hasFrontmatter: false, metadata: null };
  }

  const rawYaml = match[1].trim();
  try {
    const parsed = YAML.parse(rawYaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        body: match[2] ?? "",
        hasFrontmatter: true,
        metadata: parsed as Record<string, unknown>,
      };
    }
  } catch {
    return { body: match[2] ?? "", hasFrontmatter: true, metadata: null };
  }

  return { body: match[2] ?? "", hasFrontmatter: true, metadata: null };
}

export interface MarkdownHeading {
  level: number;
  text: string;
}

export function extractHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let inCodeBlock = false;
  let codeFenceChar = "";
  let codeFenceLen = 0;

  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (inCodeBlock) {
      if (
        fenceMatch &&
        fenceMatch[1] &&
        fenceMatch[1][0] === codeFenceChar &&
        fenceMatch[1].length >= codeFenceLen
      ) {
        inCodeBlock = false;
        codeFenceChar = "";
        codeFenceLen = 0;
      }
      continue;
    }
    if (fenceMatch && fenceMatch[1] && fenceMatch[1].length > 0) {
      inCodeBlock = true;
      codeFenceChar = fenceMatch[1][0] ?? "";
      codeFenceLen = fenceMatch[1].length;
      continue;
    }

    const headingMatch = line.match(
      /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/,
    );
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
      headings.push({ level, text });
    }
  }

  return headings;
}

export function levenshteinDistance(a: string, b: string): number {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  return dp[m]![n]!;
}

export function isSimilarHeading(expected: string, actual: string): boolean {
  const e = expected.toLowerCase().trim();
  const a = actual.toLowerCase().trim();
  if (e === a) return true;
  const dist = levenshteinDistance(e, a);
  const maxLen = Math.max(e.length, a.length);
  if (maxLen === 0) return true;
  const similarity = 1 - dist / maxLen;
  return dist <= 2 || similarity >= 0.75;
}

export interface DomainTemplateInfo {
  templateRelativePath: string;
  schemaRelativePath?: string;
  schemaAbsolutePath?: string;
  error?: string;
}

function resolveLocalSchema(
  root: string,
  document: string,
  reference: unknown,
): string {
  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    reference !== reference.trim() ||
    /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(reference) ||
    /[\\?#]/.test(reference)
  ) {
    throw new Error("frontmatter $schema must be a local relative path");
  }
  const path = resolve(dirname(document), reference);
  if (!path.startsWith(root + sep))
    throw new Error("frontmatter $schema resolves outside the template root");
  if (lstatSync(path).isSymbolicLink())
    throw new Error("frontmatter $schema must not reference a symbolic link");
  const actual = realpathSync(path);
  if (!actual.startsWith(realpathSync(root) + sep))
    throw new Error("frontmatter $schema resolves outside the template root");
  return path;
}

function templateInfo(
  root: string,
  templateAbsolute: string,
): DomainTemplateInfo {
  const templateRelativePath = relative(root, templateAbsolute).replaceAll(
    "\\",
    "/",
  );
  const info: DomainTemplateInfo = { templateRelativePath };
  const content = readFileSync(templateAbsolute, "utf-8");
  const { hasFrontmatter, metadata, body } = parseRecordFrontmatter(content);
  const titles = extractHeadings(body).filter((heading) => heading.level === 1);
  if (titles.length !== 1 || !titles[0]?.text.trim()) {
    return {
      ...info,
      error: `Template body must contain exactly one non-empty level-one title: ${templateRelativePath}`,
    };
  }
  if (!hasFrontmatter) {
    return content.startsWith("---")
      ? {
          ...info,
          error: `Malformed template frontmatter: ${templateRelativePath}`,
        }
      : info;
  }
  if (
    !metadata ||
    typeof metadata.$schema !== "string" ||
    !metadata.$schema.trim()
  ) {
    return {
      ...info,
      error: `Invalid template frontmatter or missing $schema: ${templateRelativePath}`,
    };
  }
  let schemaAbsolutePath: string;
  try {
    schemaAbsolutePath = resolveLocalSchema(
      root,
      templateAbsolute,
      metadata.$schema,
    );
  } catch {
    return {
      ...info,
      error: `Invalid or missing local template schema: ${templateRelativePath}`,
    };
  }
  const schemaRelativePath = relative(root, schemaAbsolutePath).replaceAll(
    "\\",
    "/",
  );
  const validator = getCompiledValidator(schemaAbsolutePath);
  if (!validator)
    return {
      ...info,
      error: `Failed to load schema from ${schemaRelativePath}`,
    };
  if (
    !validator(
      Object.fromEntries(
        Object.entries(metadata).filter(([key]) => key !== "$schema"),
      ),
    )
  ) {
    return {
      ...info,
      error: `Invalid template frontmatter: ${templateRelativePath}`,
    };
  }
  return {
    ...info,
    schemaAbsolutePath,
    schemaRelativePath,
  };
}

export function findDomainTemplate(
  workspaceRoot: string,
  recordRelativePath: string,
): DomainTemplateInfo | null {
  const root = resolve(workspaceRoot);
  const normalized = recordRelativePath.replaceAll("\\", "/");
  const recordAbsolute = resolve(root, normalized);
  const directory = dirname(recordAbsolute);
  if (!directory.startsWith(root + sep) || !existsSync(directory)) return null;
  const templates = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) =>
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.endsWith("-template.md") &&
      !entry.name.startsWith("."),
  );
  const first = templates[0];
  if (!first) return null;
  const templateRelativePath = relative(
    root,
    join(directory, first.name),
  ).replaceAll("\\", "/");
  if (templates.length !== 1)
    return {
      templateRelativePath,
      error: "Expected one workspace template per directory",
    };
  if (first.isSymbolicLink())
    return {
      templateRelativePath,
      error: "Symbolic link templates are not validated",
    };
  return templateInfo(root, join(directory, first.name));
}

function getCompiledValidator(schemaPath: string): ValidateFunction | null {
  const absolutePath = resolve(schemaPath);
  try {
    const raw = readFileSync(absolutePath, "utf-8");
    const cached = compiledValidators.get(absolutePath);
    if (cached?.content === raw) return cached.validate;

    // Isolate schema IDs across paths and discard old registrations on edits.
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const jsonSchema = JSON.parse(raw);
    if (
      !jsonSchema ||
      typeof jsonSchema !== "object" ||
      Array.isArray(jsonSchema)
    )
      return null;
    const localRefs = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return true;
      return Object.entries(value).every(
        ([key, item]) =>
          (key !== "$ref" ||
            (typeof item === "string" && item.startsWith("#"))) &&
          localRefs(item),
      );
    };
    if (!localRefs(jsonSchema)) return null;
    const validate = ajv.compile(jsonSchema);
    compiledValidators.set(absolutePath, { content: raw, validate });
    return validate;
  } catch (_err) {
    compiledValidators.delete(absolutePath);
    return null;
  }
}

function configurationSchemaPath(
  workspaceRoot: string,
  relativePath: string,
): string | null {
  const normalized = relativePath.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  if (lower.endsWith("/workspace-ui.yaml") || lower === "workspace-ui.yaml")
    return null;
  if (lower.endsWith(".schema.json")) return resolve(workspaceRoot, normalized);
  if (!isConfigurationPath(normalized)) return null;
  if (!lower.endsWith(".yaml") && !lower.endsWith(".yml")) return null;
  return resolve(
    workspaceRoot,
    normalized.replace(/\.(yaml|yml)$/i, ".schema.json"),
  );
}

function schemaValidation(
  workspaceRoot: string,
  data: unknown,
  schemaPath: string,
  location: string,
): WorkspaceFileValidation {
  const validator = getCompiledValidator(schemaPath);
  const schemaRelativePath = relative(
    resolve(workspaceRoot),
    schemaPath,
  ).replaceAll("\\", "/");
  if (!validator) {
    return {
      errors: [`Failed to load schema from ${schemaRelativePath}`],
      schema_path: schemaRelativePath,
      valid: false,
    };
  }
  if (validator(data)) {
    return { errors: [], schema_path: schemaRelativePath, valid: true };
  }
  const errors = (validator.errors ?? []).map((error) => {
    const path = error.instancePath
      ? `${location}${error.instancePath}`
      : location;
    return `${path}: ${error.message ?? "validation error"}`;
  });
  return {
    errors: errors.length > 0 ? errors : [`${location} does not match schema`],
    schema_path: schemaRelativePath,
    valid: false,
  };
}

function schemaDocumentValidation(
  workspaceRoot: string,
  schemaPath: string,
): WorkspaceFileValidation {
  const schemaRelativePath = relative(
    resolve(workspaceRoot),
    schemaPath,
  ).replaceAll("\\", "/");
  return getCompiledValidator(schemaPath)
    ? { errors: [], schema_path: schemaRelativePath, valid: true }
    : {
        errors: [`File is not a valid JSON Schema`],
        schema_path: schemaRelativePath,
        valid: false,
      };
}

export function validateRecordContent(
  workspaceRoot: string,
  recordRelativePath: string,
  content: string,
): WorkspaceFileValidation {
  const normalized = recordRelativePath.replaceAll("\\", "/");
  if (protectedPath(normalized)) {
    return { errors: [], valid: true };
  }

  const configurationSchema = configurationSchemaPath(
    workspaceRoot,
    normalized,
  );
  if (
    configurationSchema &&
    normalized.toLowerCase().endsWith(".schema.json")
  ) {
    try {
      JSON.parse(content);
      return schemaDocumentValidation(workspaceRoot, configurationSchema);
    } catch {
      return {
        errors: ["File is not valid JSON"],
        schema_path: normalized,
        valid: false,
      };
    }
  }
  if (configurationSchema) {
    let parsed: unknown;
    try {
      parsed = YAML.parse(content);
    } catch {
      return {
        errors: ["File is not valid YAML"],
        schema_path: relative(
          resolve(workspaceRoot),
          configurationSchema,
        ).replaceAll("\\", "/"),
        valid: false,
      };
    }
    return schemaValidation(
      workspaceRoot,
      parsed,
      configurationSchema,
      "document",
    );
  }

  if (normalized.toLowerCase().endsWith(".openui")) {
    return validateOpenUIContent(workspaceRoot, normalized, content);
  }

  if (!normalized.toLowerCase().endsWith(".md")) {
    return { errors: [], valid: true };
  }

  const domain = findDomainTemplate(workspaceRoot, normalized);
  if (!domain) {
    const { hasFrontmatter, metadata } = parseRecordFrontmatter(content);
    if (
      (hasFrontmatter && !metadata) ||
      (!hasFrontmatter && content.startsWith("---"))
    ) {
      return {
        errors: ["YAML frontmatter is malformed or not a valid object"],
        valid: false,
      };
    }
    if (hasFrontmatter && metadata && "$schema" in metadata) {
      const recordAbsolute = resolve(workspaceRoot, normalized);
      try {
        const schemaAbsolute = resolveLocalSchema(
          resolve(workspaceRoot),
          recordAbsolute,
          metadata.$schema,
        );
        const schemaRelative = relative(
          resolve(workspaceRoot),
          schemaAbsolute,
        ).replaceAll("\\", "/");
        const validator = getCompiledValidator(schemaAbsolute);
        if (!validator) {
          return {
            errors: [`Failed to load schema from ${schemaRelative}`],
            schema_path: schemaRelative,
            valid: false,
          };
        }
        const dataWithoutSchema: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(metadata)) {
          if (key !== "$schema") dataWithoutSchema[key] = val;
        }
        const isValid = validator(dataWithoutSchema);
        if (isValid) {
          return { errors: [], schema_path: schemaRelative, valid: true };
        }
        const errors: string[] = [];
        if (validator.errors) {
          for (const error of validator.errors) {
            const location = error.instancePath
              ? `frontmatter${error.instancePath}`
              : "frontmatter";
            errors.push(`${location}: ${error.message ?? "validation error"}`);
          }
        }
        return {
          errors:
            errors.length > 0 ? errors : ["Frontmatter does not match schema"],
          schema_path: schemaRelative,
          valid: false,
        };
      } catch {
        return {
          errors: ["Invalid or missing local record $schema"],
          valid: false,
        };
      }
    }
    return { errors: [], valid: true };
  }

  const { hasFrontmatter, metadata } = parseRecordFrontmatter(content);
  if (domain.error) {
    return {
      errors: [domain.error],
      template_path: domain.templateRelativePath,
      valid: false,
    };
  }
  if (domain.schemaAbsolutePath && !hasFrontmatter) {
    return {
      errors: [
        `File must begin with YAML frontmatter conforming to ${domain.templateRelativePath}`,
      ],
      ...(domain.schemaRelativePath
        ? { schema_path: domain.schemaRelativePath }
        : {}),
      template_path: domain.templateRelativePath,
      valid: false,
    };
  }

  if (
    (hasFrontmatter && metadata === null) ||
    (!hasFrontmatter && /^---\r?\n/.test(content))
  ) {
    return {
      errors: ["YAML frontmatter is malformed or not a valid object"],
      ...(domain.schemaRelativePath
        ? { schema_path: domain.schemaRelativePath }
        : {}),
      template_path: domain.templateRelativePath,
      valid: false,
    };
  }

  const validator = domain.schemaAbsolutePath
    ? getCompiledValidator(domain.schemaAbsolutePath)
    : null;
  if (domain.schemaAbsolutePath && !validator) {
    return {
      errors: [`Failed to load schema from ${domain.schemaRelativePath}`],
      ...(domain.schemaRelativePath
        ? { schema_path: domain.schemaRelativePath }
        : {}),
      template_path: domain.templateRelativePath,
      valid: false,
    };
  }

  const dataWithoutSchema: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(metadata ?? {})) {
    if (key !== "$schema") dataWithoutSchema[key] = val;
  }

  const isValid = validator ? validator(dataWithoutSchema) : true;
  const errors: string[] = [];
  if (!isValid && validator?.errors) {
    for (const error of validator.errors) {
      const location = error.instancePath
        ? `frontmatter${error.instancePath}`
        : "frontmatter";
      if (
        error.keyword === "required" &&
        error.params &&
        "missingProperty" in error.params
      ) {
        errors.push(
          `${location}: missing required property '${String(error.params.missingProperty)}'`,
        );
      } else if (
        error.keyword === "additionalProperties" &&
        error.params &&
        "additionalProperty" in error.params
      ) {
        errors.push(
          `${location}: unrecognized property '${String(error.params.additionalProperty)}'`,
        );
      } else {
        errors.push(`${location}: ${error.message ?? "validation error"}`);
      }
    }
  }

  const fileHeadings = extractHeadings(parseRecordFrontmatter(content).body);
  if (normalized.endsWith("-template.md")) {
    const titles = fileHeadings.filter((h) => h.level === 1);
    if (titles.length !== 1 || !titles[0]?.text.trim()) {
      errors.push(
        "template body must contain exactly one non-empty level-one title",
      );
    }
  } else {
    const templateAbsolute = resolve(
      workspaceRoot,
      domain.templateRelativePath,
    );
    if (existsSync(templateAbsolute)) {
      try {
        const templateContent = readFileSync(templateAbsolute, "utf-8");
        const templateHeadings = extractHeadings(
          parseRecordFrontmatter(templateContent).body,
        );
        const expectedSections = templateHeadings
          .filter((h) => h.level === 2)
          .map((h) => h.text.trim())
          .filter(Boolean);

        const titles = fileHeadings.filter((h) => h.level === 1);
        if (titles.length === 0 || !titles[0]?.text.trim()) {
          errors.push("file must contain a level-one title ('# ...')");
        }

        const fileSections = fileHeadings.filter((h) => h.level === 2);
        for (const expected of expectedSections) {
          const exactMatch = fileSections.some(
            (h) => h.text.trim().toLowerCase() === expected.toLowerCase(),
          );
          if (!exactMatch) {
            const typo = fileSections.find((h) =>
              isSimilarHeading(expected, h.text.trim()),
            );
            if (typo) {
              errors.push(
                `heading: missing section '## ${expected}' (found misspelled '## ${typo.text.trim()}')`,
              );
            } else {
              errors.push(`heading: missing required section '## ${expected}'`);
            }
          }
        }
      } catch {}
    }
  }

  return {
    errors,
    ...(domain.schemaRelativePath
      ? { schema_path: domain.schemaRelativePath }
      : {}),
    template_path: domain.templateRelativePath,
    valid: errors.length === 0,
  };
}

export function validateEntireWorkspace(
  workspaceRoot: string,
): WorkspaceDiagnosticsResponse {
  const root = resolve(workspaceRoot);
  const issues: WorkspaceDiagnosticIssue[] = [];

  const visit = (directory: string): void => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relPath = relative(root, absolute).replaceAll("\\", "/");

      if (protectedPath(relPath)) continue;

      let info: ReturnType<typeof statSync> | undefined;
      try {
        info = statSync(absolute);
      } catch {
        continue;
      }
      if (!info || info.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        visit(absolute);
      } else if (
        entry.isFile() &&
        (relPath.toLowerCase().endsWith(".md") ||
          relPath.toLowerCase().endsWith(".openui") ||
          isConfigurationPath(relPath))
      ) {
        try {
          const content = readFileSync(absolute, "utf-8");
          const validation = validateRecordContent(root, relPath, content);
          if (!validation.valid) {
            issues.push({
              errors: validation.errors,
              path: relPath,
              ...(validation.schema_path
                ? { schema_path: validation.schema_path }
                : {}),
              ...(validation.template_path
                ? { template_path: validation.template_path }
                : {}),
            });
          }
        } catch {}
      }
    }
  };

  visit(root);
  issues.sort((a, b) => a.path.localeCompare(b.path));

  return {
    issues,
    schema: 1,
    valid: issues.length === 0,
  };
}
