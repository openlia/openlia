import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import YAML from "yaml";
import type {
  WorkspaceDiagnosticIssue,
  WorkspaceDiagnosticsResponse,
  WorkspaceFileValidation,
} from "../shared/api";
import { extractMarkdownOpenUIBlocks, openUIErrors } from "../shared/openui";
import { isConfigurationPath, protectedPath } from "./workspace";

export function validateMarkdownOpenUIBlocks(content: string): string[] {
  return extractMarkdownOpenUIBlocks(content).flatMap((block) =>
    openUIErrors(block.code).map(
      (error) => `openui_syntax_error: line ${block.startLine}: ${error}`,
    ),
  );
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
  const match = content.match(
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!match || match[1] === undefined)
    return { body: content, hasFrontmatter: false, metadata: null };
  try {
    const parsed = YAML.parse(match[1].trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return {
        body: match[2] ?? "",
        hasFrontmatter: true,
        metadata: parsed as Record<string, unknown>,
      };
  } catch {}
  return { body: match[2] ?? "", hasFrontmatter: true, metadata: null };
}

export interface MarkdownHeading {
  level: number;
  text: string;
}

export function extractHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence = "";
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (
        match?.[1] &&
        match[1][0] === fence[0] &&
        match[1].length >= fence.length
      )
        fence = "";
      continue;
    }
    if (match?.[1]) {
      fence = match[1];
      continue;
    }
    const heading = line.match(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (heading?.[1] && heading[2])
      headings.push({
        level: heading[1].length,
        text: heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim(),
      });
  }
  return headings;
}

export function levenshteinDistance(a: string, b: string): number {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  const dp: number[][] = Array.from({ length: s1.length + 1 }, () =>
    new Array(s2.length + 1).fill(0),
  );
  for (let i = 0; i <= s1.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= s2.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= s1.length; i++)
    for (let j = 1; j <= s2.length; j++)
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (s1[i - 1] === s2[j - 1] ? 0 : 1),
      );
  return dp[s1.length]![s2.length]!;
}

export function isSimilarHeading(expected: string, actual: string): boolean {
  const e = expected.toLowerCase().trim();
  const a = actual.toLowerCase().trim();
  const distance = levenshteinDistance(e, a);
  return (
    e === a ||
    distance <= 2 ||
    1 - distance / Math.max(e.length, a.length) >= 0.75
  );
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
  )
    throw new Error("frontmatter $schema must be a local relative path");
  const path = resolve(dirname(document), reference);
  if (!path.startsWith(root + sep))
    throw new Error("frontmatter $schema resolves outside the template root");
  if (lstatSync(path).isSymbolicLink())
    throw new Error("frontmatter $schema must not reference a symbolic link");
  if (!realpathSync(path).startsWith(realpathSync(root) + sep))
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
  if (titles.length !== 1 || !titles[0]?.text.trim())
    return {
      ...info,
      error: `Template body must contain exactly one non-empty level-one title: ${templateRelativePath}`,
    };
  if (!hasFrontmatter)
    return content.startsWith("---")
      ? {
          ...info,
          error: `Malformed template frontmatter: ${templateRelativePath}`,
        }
      : info;
  if (
    !metadata ||
    typeof metadata.$schema !== "string" ||
    !metadata.$schema.trim()
  )
    return {
      ...info,
      error: `Invalid template frontmatter or missing $schema: ${templateRelativePath}`,
    };
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
  )
    return {
      ...info,
      error: `Invalid template frontmatter: ${templateRelativePath}`,
    };
  return { ...info, schemaAbsolutePath, schemaRelativePath };
}

export function findDomainTemplate(
  workspaceRoot: string,
  recordRelativePath: string,
): DomainTemplateInfo | null {
  const root = resolve(workspaceRoot);
  const directory = dirname(
    resolve(root, recordRelativePath.replaceAll("\\", "/")),
  );
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
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const jsonSchema = JSON.parse(raw);
    if (
      !jsonSchema ||
      typeof jsonSchema !== "object" ||
      Array.isArray(jsonSchema)
    )
      return null;
    const localRefs = (value: unknown): boolean =>
      !value ||
      typeof value !== "object" ||
      Object.entries(value).every(
        ([key, item]) =>
          (key !== "$ref" ||
            (typeof item === "string" && item.startsWith("#"))) &&
          localRefs(item),
      );
    if (!localRefs(jsonSchema)) return null;
    const validate = ajv.compile(jsonSchema);
    compiledValidators.set(absolutePath, { content: raw, validate });
    return validate;
  } catch {
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
  if (
    !isConfigurationPath(normalized) ||
    (!lower.endsWith(".yaml") && !lower.endsWith(".yml"))
  )
    return null;
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
  const schema_path = relative(resolve(workspaceRoot), schemaPath).replaceAll(
    "\\",
    "/",
  );
  if (!validator)
    return {
      errors: [`Failed to load schema from ${schema_path}`],
      schema_path,
      valid: false,
    };
  if (validator(data)) return { errors: [], schema_path, valid: true };
  const errors = (validator.errors ?? []).map(
    (error) =>
      `${error.instancePath ? `${location}${error.instancePath}` : location}: ${error.message ?? "validation error"}`,
  );
  return {
    errors: errors.length ? errors : [`${location} does not match schema`],
    schema_path,
    valid: false,
  };
}

function validateRecordStructure(
  workspaceRoot: string,
  recordRelativePath: string,
  content: string,
): WorkspaceFileValidation {
  const normalized = recordRelativePath.replaceAll("\\", "/");
  if (protectedPath(normalized)) return { errors: [], valid: true };
  const configurationSchema = configurationSchemaPath(
    workspaceRoot,
    normalized,
  );
  if (
    configurationSchema &&
    normalized.toLowerCase().endsWith(".schema.json")
  ) {
    const schema_path = relative(
      resolve(workspaceRoot),
      configurationSchema,
    ).replaceAll("\\", "/");
    try {
      JSON.parse(content);
      return getCompiledValidator(configurationSchema)
        ? { errors: [], schema_path, valid: true }
        : {
            errors: ["File is not a valid JSON Schema"],
            schema_path,
            valid: false,
          };
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
  if (!normalized.toLowerCase().endsWith(".md"))
    return { errors: [], valid: true };
  const { hasFrontmatter, metadata, body } = parseRecordFrontmatter(content);
  const domain = findDomainTemplate(workspaceRoot, normalized);
  if (!domain) {
    if (
      (hasFrontmatter && !metadata) ||
      (!hasFrontmatter && content.startsWith("---"))
    )
      return {
        errors: ["YAML frontmatter is malformed or not a valid object"],
        valid: false,
      };
    if (hasFrontmatter && metadata && "$schema" in metadata) {
      try {
        const schemaAbsolute = resolveLocalSchema(
          resolve(workspaceRoot),
          resolve(workspaceRoot, normalized),
          metadata.$schema,
        );
        return schemaValidation(
          workspaceRoot,
          Object.fromEntries(
            Object.entries(metadata).filter(([key]) => key !== "$schema"),
          ),
          schemaAbsolute,
          "frontmatter",
        );
      } catch {
        return {
          errors: ["Invalid or missing local record $schema"],
          valid: false,
        };
      }
    }
    return { errors: [], valid: true };
  }
  const paths = {
    template_path: domain.templateRelativePath,
    ...(domain.schemaRelativePath
      ? { schema_path: domain.schemaRelativePath }
      : {}),
  };
  if (domain.error)
    return {
      errors: [domain.error],
      template_path: domain.templateRelativePath,
      valid: false,
    };
  if (domain.schemaAbsolutePath && !hasFrontmatter)
    return {
      errors: [
        `File must begin with YAML frontmatter conforming to ${domain.templateRelativePath}`,
      ],
      ...paths,
      valid: false,
    };
  if (
    (hasFrontmatter && metadata === null) ||
    (!hasFrontmatter && /^---\r?\n/.test(content))
  )
    return {
      errors: ["YAML frontmatter is malformed or not a valid object"],
      ...paths,
      valid: false,
    };
  const validator = domain.schemaAbsolutePath
    ? getCompiledValidator(domain.schemaAbsolutePath)
    : null;
  if (domain.schemaAbsolutePath && !validator)
    return {
      errors: [`Failed to load schema from ${domain.schemaRelativePath}`],
      ...paths,
      valid: false,
    };
  const data = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => key !== "$schema"),
  );
  const isValid = validator ? validator(data) : true;
  const errors: string[] = [];
  if (!isValid && validator?.errors)
    for (const error of validator.errors) {
      const location = error.instancePath
        ? `frontmatter${error.instancePath}`
        : "frontmatter";
      if (error.keyword === "required" && "missingProperty" in error.params)
        errors.push(
          `${location}: missing required property '${String(error.params.missingProperty)}'`,
        );
      else if (
        error.keyword === "additionalProperties" &&
        "additionalProperty" in error.params
      )
        errors.push(
          `${location}: unrecognized property '${String(error.params.additionalProperty)}'`,
        );
      else errors.push(`${location}: ${error.message ?? "validation error"}`);
    }
  const fileHeadings = extractHeadings(body);
  if (normalized.endsWith("-template.md")) {
    const titles = fileHeadings.filter((h) => h.level === 1);
    if (titles.length !== 1 || !titles[0]?.text.trim())
      errors.push(
        "template body must contain exactly one non-empty level-one title",
      );
  } else {
    const templateAbsolute = resolve(
      workspaceRoot,
      domain.templateRelativePath,
    );
    if (existsSync(templateAbsolute))
      try {
        const templateHeadings = extractHeadings(
          parseRecordFrontmatter(readFileSync(templateAbsolute, "utf-8")).body,
        );
        const expectedSections = templateHeadings
          .filter((h) => h.level === 2)
          .map((h) => h.text.trim())
          .filter(Boolean);
        const titles = fileHeadings.filter((h) => h.level === 1);
        if (!titles.length || !titles[0]?.text.trim())
          errors.push("file must contain a level-one title ('# ...')");
        const sections = fileHeadings.filter((h) => h.level === 2);
        for (const expected of expectedSections)
          if (
            !sections.some(
              (h) => h.text.trim().toLowerCase() === expected.toLowerCase(),
            )
          ) {
            const typo = sections.find((h) =>
              isSimilarHeading(expected, h.text.trim()),
            );
            errors.push(
              typo
                ? `heading: missing section '## ${expected}' (found misspelled '## ${typo.text.trim()}')`
                : `heading: missing required section '## ${expected}'`,
            );
          }
      } catch {}
  }
  return { errors, ...paths, valid: errors.length === 0 };
}

export function validateRecordContent(
  workspaceRoot: string,
  recordRelativePath: string,
  content: string,
): WorkspaceFileValidation {
  const validation = validateRecordStructure(
    workspaceRoot,
    recordRelativePath,
    content,
  );
  if (
    protectedPath(recordRelativePath) ||
    !recordRelativePath.toLowerCase().endsWith(".md")
  )
    return validation;
  // Presentation findings are advisory and do not invalidate a record's contract.
  const warnings = validateMarkdownOpenUIBlocks(content);
  return warnings.length ? { ...validation, warnings } : validation;
}

export function validateEntireWorkspace(
  workspaceRoot: string,
): WorkspaceDiagnosticsResponse {
  const root = resolve(workspaceRoot);
  const issues: WorkspaceDiagnosticIssue[] = [];
  const visit = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (protectedPath(path)) continue;
      try {
        if (lstatSync(absolute).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        (path.toLowerCase().endsWith(".md") || isConfigurationPath(path))
      )
        try {
          const validation = validateRecordContent(
            root,
            path,
            readFileSync(absolute, "utf-8"),
          );
          if (!validation.valid || validation.warnings?.length)
            issues.push({
              path,
              errors: validation.errors,
              ...(validation.warnings ? { warnings: validation.warnings } : {}),
              ...(validation.schema_path
                ? { schema_path: validation.schema_path }
                : {}),
              ...(validation.template_path
                ? { template_path: validation.template_path }
                : {}),
            });
        } catch {}
    }
  };
  visit(root);
  issues.sort((a, b) => a.path.localeCompare(b.path));
  return {
    issues,
    schema: 1,
    valid: issues.every((issue) => !issue.errors.length),
  };
}
