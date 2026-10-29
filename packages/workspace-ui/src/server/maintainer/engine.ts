import type { Dirent } from "node:fs";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
  extractHeadings,
  findDomainTemplate,
  isSimilarHeading,
  parseRecordFrontmatter,
  validateMarkdownOpenUIBlocks,
} from "../validator";
import { protectedPath, revision } from "../workspace";
import {
  type MaintainerCandidateFinding,
  type MaintainerCategory,
  MaintainerDB,
  type MaintainerFindingRecord,
  type MaintainerFixStrategy,
  type MaintainerScanStateRecord,
  type MaintainerSeverity,
} from "./db";
import {
  computeContractFingerprint,
  computeIssueId,
  sha256Hex,
} from "./fingerprint";

export interface DiscoveredCollection {
  path: string;
  label: string;
  kind: "core" | "template" | "freeform";
  template_path?: string | undefined;
  schema_path?: string | undefined;
  inferred_purpose: string;
  record_count: number;
  open_finding_count: number;
  ignored_finding_count: number;
}

export interface MaintainerOverviewResult {
  schema: 1;
  workspace_id: string;
  counts: {
    open: number;
    ignored: number;
    resolved: number;
    suggestions: number;
    collections: number;
  };
  scan_state: MaintainerScanStateRecord;
  collections: DiscoveredCollection[];
  open_findings: MaintainerFindingRecord[];
  ignored_findings: MaintainerFindingRecord[];
  resolved_findings: MaintainerFindingRecord[];
  suggestions: MaintainerFindingRecord[];
}

const CORE_DOMAIN_PURPOSES: Record<string, { label: string; purpose: string }> =
  {
    inbox: {
      label: "Inbox",
      purpose: "Quick captures and incoming items awaiting triage.",
    },
    "inbox/daily-briefing": {
      label: "Daily Briefing",
      purpose: "Daily briefings and workspace synthesis summaries.",
    },
    "inbox/ingestion": {
      label: "Ingestion",
      purpose: "Source ingestion intake notes.",
    },
    tasks: {
      label: "Tasks",
      purpose: "Concrete actions that can be completed.",
    },
    goals: {
      label: "Goals",
      purpose: "Outcomes and the reasons they matter.",
    },
    calendar: {
      label: "Calendar",
      purpose: "Remind appointments and companion event notes.",
    },
    knowledge: {
      label: "Knowledge",
      purpose:
        "Obsidian-style free-form PKM vault for notes, project pages (e.g. project-apollo.md), and subfolders.",
    },
    decisions: {
      label: "Decisions",
      purpose: "Questions, options, trade-offs, and outcomes.",
    },
    sources: {
      label: "Sources",
      purpose: "Source documents and provenance records.",
    },
    archive: {
      label: "Archive",
      purpose: "Completed or retired workspace records.",
    },
  };

const compiledSchemaCache = new Map<
  string,
  { raw: string; parsed: Record<string, unknown>; validate: ValidateFunction }
>();

function loadCompiledSchema(schemaAbsPath: string): {
  parsed: Record<string, unknown>;
  validate: ValidateFunction;
} | null {
  const abs = resolve(schemaAbsPath);
  try {
    const raw = readFileSync(abs, "utf8");
    const cached = compiledSchemaCache.get(abs);
    if (cached && cached.raw === raw) {
      return { parsed: cached.parsed, validate: cached.validate };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const localRefs = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return true;
      return Object.entries(value).every(
        ([key, item]) =>
          (key !== "$ref" ||
            (typeof item === "string" && item.startsWith("#"))) &&
          localRefs(item),
      );
    };
    if (!localRefs(parsed)) return null;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(parsed);
    const entry = {
      raw,
      parsed: parsed as Record<string, unknown>,
      validate,
    };
    compiledSchemaCache.set(abs, entry);
    return { parsed: entry.parsed, validate: entry.validate };
  } catch {
    compiledSchemaCache.delete(abs);
    return null;
  }
}

function resolveLocalSchemaSafe(
  root: string,
  documentAbs: string,
  reference: unknown,
): string | null {
  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    reference !== reference.trim() ||
    /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(reference) ||
    /[\\?#]/.test(reference)
  ) {
    return null;
  }
  try {
    const candidate = resolve(dirname(documentAbs), reference);
    if (!candidate.startsWith(root + sep)) return null;
    if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) {
      return null;
    }
    const actual = realpathSync(candidate);
    if (!actual.startsWith(realpathSync(root) + sep)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function makeCandidate(params: {
  workspaceId: string;
  relativePath: string;
  ruleCode: string;
  severity: MaintainerSeverity;
  category?: MaintainerCategory | undefined;
  subject: string;
  message: string;
  explanation: string;
  contractPath?: string | undefined;
  contractFingerprint: string;
  fixStrategy: MaintainerFixStrategy;
  checkedRevision: string;
}): MaintainerCandidateFinding {
  const issue_id = computeIssueId({
    workspaceId: params.workspaceId,
    relativePath: params.relativePath,
    ruleCode: params.ruleCode,
    subject: params.subject,
    contractFingerprint: params.contractFingerprint,
  });
  return {
    issue_id,
    workspace_id: params.workspaceId,
    relative_path: params.relativePath,
    rule_code: params.ruleCode,
    severity: params.severity,
    category: params.category ?? "contract",
    subject: params.subject,
    message: params.message,
    explanation: params.explanation,
    ...(params.contractPath ? { contract_path: params.contractPath } : {}),
    contract_fingerprint: params.contractFingerprint,
    fix_strategy: params.fixStrategy,
    checked_revision: params.checkedRevision,
  };
}

/**
 * Evaluates all structural findings for a single workspace file.
 * Findings are strictly advisory and never block saving.
 */
export function evaluateFileFindings(
  workspaceRoot: string,
  workspaceId: string,
  relativePath: string,
  content: string,
  checkedRevision: string,
): MaintainerCandidateFinding[] {
  const root = resolve(workspaceRoot);
  const normalized = relativePath.replaceAll("\\", "/");
  if (protectedPath(normalized)) return [];

  const lower = normalized.toLowerCase();
  const findings: MaintainerCandidateFinding[] = [];

  // 1. JSON Schema files (*.schema.json)
  if (lower.endsWith(".schema.json")) {
    const abs = resolve(root, normalized);
    let validJson = false;
    try {
      JSON.parse(content);
      validJson = true;
    } catch {}
    if (!validJson || !loadCompiledSchema(abs)) {
      const fp = computeContractFingerprint({
        ruleCode: "WM-SCHEMA-INVALID",
        subject: "schema",
      });
      findings.push(
        makeCandidate({
          workspaceId,
          relativePath: normalized,
          ruleCode: "WM-SCHEMA-INVALID",
          severity: "error",
          subject: "schema",
          message: validJson
            ? "File is not a valid JSON Schema"
            : "File is not valid JSON",
          explanation:
            "JSON Schema files must be valid JSON and compile under Draft 2020-12 with local-only $ref targets.",
          contractPath: normalized,
          contractFingerprint: fp,
          fixStrategy: "agent",
          checkedRevision,
        }),
      );
    }
    return findings;
  }

  if (lower.endsWith(".md")) {
    for (const message of validateMarkdownOpenUIBlocks(content)) {
      const subject = message;
      findings.push(
        makeCandidate({
          workspaceId,
          relativePath: normalized,
          ruleCode: "openui_syntax_error",
          severity: "warning",
          subject,
          message,
          explanation:
            "Fix this inline OpenUI block. Presentation diagnostics do not invalidate Markdown records or block saving.",
          contractFingerprint: computeContractFingerprint({
            ruleCode: "openui_syntax_error",
            subject,
          }),
          fixStrategy: "agent",
          checkedRevision,
        }),
      );
    }
  }

  // 4. Markdown files (*.md)
  if (
    !lower.endsWith(".md") ||
    lower.endsWith("/readme.md") ||
    lower === "readme.md"
  ) {
    return findings;
  }

  const domain = findDomainTemplate(root, normalized);
  const { hasFrontmatter, metadata, body } = parseRecordFrontmatter(content);

  // Check malformed frontmatter on any Markdown file
  if (
    (hasFrontmatter && metadata === null) ||
    (!hasFrontmatter && content.startsWith("---"))
  ) {
    const fp = computeContractFingerprint({
      ruleCode: "WM-FM-MALFORMED",
      subject: "frontmatter",
    });
    findings.push(
      makeCandidate({
        workspaceId,
        relativePath: normalized,
        ruleCode: "WM-FM-MALFORMED",
        severity: "error",
        subject: "frontmatter",
        message: "YAML frontmatter is malformed or not a valid object",
        explanation:
          "YAML frontmatter between leading --- fences must parse as a key-value mapping.",
        contractPath: domain?.templateRelativePath,
        contractFingerprint: fp,
        fixStrategy: "agent",
        checkedRevision,
      }),
    );
    return findings;
  }

  // Free-form Markdown without a folder template
  if (!domain) {
    if (hasFrontmatter && metadata && "$schema" in metadata) {
      const recordAbs = resolve(root, normalized);
      const schemaAbs = resolveLocalSchemaSafe(
        root,
        recordAbs,
        metadata.$schema,
      );
      if (!schemaAbs) {
        const fp = computeContractFingerprint({
          ruleCode: "WM-SCHEMA-MISSING-REF",
          subject: "$schema",
        });
        findings.push(
          makeCandidate({
            workspaceId,
            relativePath: normalized,
            ruleCode: "WM-SCHEMA-MISSING-REF",
            severity: "error",
            subject: "$schema",
            message: "Invalid or missing local record $schema",
            explanation:
              "Frontmatter $schema must resolve to an existing non-symlink JSON Schema file inside the workspace.",
            contractFingerprint: fp,
            fixStrategy: "agent",
            checkedRevision,
          }),
        );
        return findings;
      }
      const schemaRel = relative(root, schemaAbs).replaceAll("\\", "/");
      const compiled = loadCompiledSchema(schemaAbs);
      if (!compiled) {
        const fp = computeContractFingerprint({
          ruleCode: "WM-SCHEMA-INVALID",
          subject: schemaRel,
        });
        findings.push(
          makeCandidate({
            workspaceId,
            relativePath: normalized,
            ruleCode: "WM-SCHEMA-INVALID",
            severity: "error",
            subject: schemaRel,
            message: `Failed to load schema from ${schemaRel}`,
            explanation: `The referenced schema (${schemaRel}) is not a valid JSON Schema.`,
            contractPath: schemaRel,
            contractFingerprint: fp,
            fixStrategy: "agent",
            checkedRevision,
          }),
        );
        return findings;
      }
      appendAjvFindings({
        findings,
        workspaceId,
        relativePath: normalized,
        metadata,
        compiled,
        schemaRel,
        templateMetadata: null,
        checkedRevision,
      });
    }
    return findings;
  }

  // Domain template has a structural error itself
  if (domain.error) {
    const isMultiple = domain.error.includes("Expected one workspace template");
    const ruleCode = isMultiple
      ? "WM-TEMPLATE-MULTIPLE"
      : "WM-TEMPLATE-INVALID";
    const fp = computeContractFingerprint({
      ruleCode,
      subject: domain.templateRelativePath,
    });
    findings.push(
      makeCandidate({
        workspaceId,
        relativePath: normalized,
        ruleCode,
        severity: isMultiple ? "warning" : "error",
        subject: domain.templateRelativePath,
        message: domain.error,
        explanation: isMultiple
          ? "Keep a single *-template.md per directory so records have an unambiguous structural contract."
          : "The governing template or its referenced schema has a structural error.",
        contractPath: domain.templateRelativePath,
        contractFingerprint: fp,
        fixStrategy: isMultiple ? "manual" : "agent",
        checkedRevision,
      }),
    );
    return findings;
  }

  const templateAbs = resolve(root, domain.templateRelativePath);
  let templateContent = "";
  let templateMetadata: Record<string, unknown> | null = null;
  let templateSections: string[] = [];
  if (existsSync(templateAbs)) {
    try {
      templateContent = readFileSync(templateAbs, "utf8");
      const parsedTpl = parseRecordFrontmatter(templateContent);
      templateMetadata = parsedTpl.metadata;
      templateSections = extractHeadings(parsedTpl.body)
        .filter((h) => h.level === 2)
        .map((h) => h.text.trim())
        .filter(Boolean);
    } catch {}
  }

  // Missing frontmatter when domain template requires a schema
  if (domain.schemaAbsolutePath && !hasFrontmatter) {
    const fp = computeContractFingerprint({
      ruleCode: "WM-FM-MISSING",
      subject: "frontmatter",
      templateSchemaRef: domain.schemaRelativePath,
    });
    findings.push(
      makeCandidate({
        workspaceId,
        relativePath: normalized,
        ruleCode: "WM-FM-MISSING",
        severity: "warning",
        subject: "frontmatter",
        message: `File must begin with YAML frontmatter conforming to ${domain.templateRelativePath}`,
        explanation: `Records in this folder use ${domain.templateRelativePath} and its schema (${domain.schemaRelativePath ?? "schema"}).`,
        contractPath: domain.schemaRelativePath ?? domain.templateRelativePath,
        contractFingerprint: fp,
        fixStrategy: "deterministic",
        checkedRevision,
      }),
    );
  } else if (domain.schemaAbsolutePath && hasFrontmatter && metadata) {
    const compiled = loadCompiledSchema(domain.schemaAbsolutePath);
    const schemaRel = domain.schemaRelativePath ?? domain.templateRelativePath;
    if (!compiled) {
      const fp = computeContractFingerprint({
        ruleCode: "WM-SCHEMA-INVALID",
        subject: schemaRel,
      });
      findings.push(
        makeCandidate({
          workspaceId,
          relativePath: normalized,
          ruleCode: "WM-SCHEMA-INVALID",
          severity: "error",
          subject: schemaRel,
          message: `Failed to load schema from ${schemaRel}`,
          explanation: `The referenced schema (${schemaRel}) could not be compiled.`,
          contractPath: schemaRel,
          contractFingerprint: fp,
          fixStrategy: "agent",
          checkedRevision,
        }),
      );
    } else {
      appendAjvFindings({
        findings,
        workspaceId,
        relativePath: normalized,
        metadata,
        compiled,
        schemaRel,
        templateMetadata,
        checkedRevision,
      });
    }
  }

  const fileHeadings = extractHeadings(body);
  if (lower.endsWith("-template.md")) {
    const titles = fileHeadings.filter((h) => h.level === 1);
    if (titles.length !== 1 || !titles[0]?.text.trim()) {
      const fp = computeContractFingerprint({
        ruleCode: "WM-TEMPLATE-TITLE",
        subject: "h1",
      });
      findings.push(
        makeCandidate({
          workspaceId,
          relativePath: normalized,
          ruleCode: "WM-TEMPLATE-TITLE",
          severity: "warning",
          subject: "h1",
          message:
            "template body must contain exactly one non-empty level-one title",
          explanation:
            "Workspace templates require a single '# Title' heading in the Markdown body.",
          contractPath: normalized,
          contractFingerprint: fp,
          fixStrategy: "deterministic",
          checkedRevision,
        }),
      );
    }
  } else {
    const titles = fileHeadings.filter((h) => h.level === 1);
    if (titles.length === 0 || !titles[0]?.text.trim()) {
      const fp = computeContractFingerprint({
        ruleCode: "WM-TEMPLATE-TITLE",
        subject: "h1",
        templateSchemaRef: domain.schemaRelativePath,
        templateSections,
      });
      findings.push(
        makeCandidate({
          workspaceId,
          relativePath: normalized,
          ruleCode: "WM-TEMPLATE-TITLE",
          severity: "warning",
          subject: "h1",
          message: "file must contain a level-one title ('# ...')",
          explanation: `Records governed by ${domain.templateRelativePath} should include a level-one '# Title' heading.`,
          contractPath: domain.templateRelativePath,
          contractFingerprint: fp,
          fixStrategy: "deterministic",
          checkedRevision,
        }),
      );
    }

    const fileSections = fileHeadings.filter((h) => h.level === 2);
    for (const expected of templateSections) {
      const exactMatch = fileSections.some(
        (h) => h.text.trim().toLowerCase() === expected.toLowerCase(),
      );
      if (!exactMatch) {
        const typo = fileSections.find((h) =>
          isSimilarHeading(expected, h.text.trim()),
        );
        const message = typo
          ? `heading: missing section '## ${expected}' (found misspelled '## ${typo.text.trim()}')`
          : `heading: missing required section '## ${expected}'`;
        const fp = computeContractFingerprint({
          ruleCode: "WM-TEMPLATE-SECTION-MISSING",
          subject: expected,
          templateSections,
        });
        findings.push(
          makeCandidate({
            workspaceId,
            relativePath: normalized,
            ruleCode: "WM-TEMPLATE-SECTION-MISSING",
            severity: "warning",
            subject: expected,
            message,
            explanation: typo
              ? `Section '## ${typo.text.trim()}' appears to be a typo for '## ${expected}' defined in ${domain.templateRelativePath}.`
              : `This record is missing section '## ${expected}' defined in ${domain.templateRelativePath}.`,
            contractPath: domain.templateRelativePath,
            contractFingerprint: fp,
            fixStrategy: "deterministic",
            checkedRevision,
          }),
        );
      }
    }
  }

  return findings;
}

function appendAjvFindings(params: {
  findings: MaintainerCandidateFinding[];
  workspaceId: string;
  relativePath: string;
  metadata: Record<string, unknown>;
  compiled: { parsed: Record<string, unknown>; validate: ValidateFunction };
  schemaRel: string;
  templateMetadata: Record<string, unknown> | null;
  checkedRevision: string;
}): void {
  const {
    findings,
    workspaceId,
    relativePath,
    metadata,
    compiled,
    schemaRel,
    templateMetadata,
    checkedRevision,
  } = params;

  const dataWithoutSchema: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(metadata)) {
    if (key !== "$schema") dataWithoutSchema[key] = val;
  }

  const valid = compiled.validate(dataWithoutSchema);
  if (valid || !compiled.validate.errors) return;

  const schemaProps =
    compiled.parsed.properties &&
    typeof compiled.parsed.properties === "object" &&
    !Array.isArray(compiled.parsed.properties)
      ? (compiled.parsed.properties as Record<string, unknown>)
      : {};

  for (const error of compiled.validate.errors) {
    const location = error.instancePath
      ? `frontmatter${error.instancePath}`
      : "frontmatter";

    if (
      error.keyword === "required" &&
      error.params &&
      "missingProperty" in error.params
    ) {
      const prop = String(error.params.missingProperty);
      const propSchema = schemaProps[prop] as
        | Record<string, unknown>
        | undefined;
      const hasDefault =
        (templateMetadata && prop in templateMetadata) ||
        (propSchema &&
          ("default" in propSchema ||
            (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) ||
            propSchema.type === "string" ||
            propSchema.type === "array" ||
            propSchema.type === "boolean" ||
            propSchema.type === "number" ||
            propSchema.type === "integer"));
      const fp = computeContractFingerprint({
        ruleCode: "WM-SCHEMA-REQUIRED",
        subject: prop,
        schemaPropertyRule: { required: true, prop },
      });
      findings.push(
        makeCandidate({
          workspaceId,
          relativePath,
          ruleCode: "WM-SCHEMA-REQUIRED",
          severity: "warning",
          subject: prop,
          message: `${location}: missing required property '${prop}'`,
          explanation: `Property '${prop}' is required by ${schemaRel}.`,
          contractPath: schemaRel,
          contractFingerprint: fp,
          fixStrategy: hasDefault ? "deterministic" : "agent",
          checkedRevision,
        }),
      );
    } else if (
      error.keyword === "additionalProperties" &&
      error.params &&
      "additionalProperty" in error.params
    ) {
      const prop = String(error.params.additionalProperty);
      const fp = computeContractFingerprint({
        ruleCode: "WM-SCHEMA-ADDITIONAL",
        subject: prop,
        schemaPropertyRule: { additionalProperties: false },
      });
      findings.push(
        makeCandidate({
          workspaceId,
          relativePath,
          ruleCode: "WM-SCHEMA-ADDITIONAL",
          severity: "warning",
          subject: prop,
          message: `${location}: unrecognized property '${prop}'`,
          explanation: `Property '${prop}' is not defined in ${schemaRel} (additionalProperties: false).`,
          contractPath: schemaRel,
          contractFingerprint: fp,
          fixStrategy: "agent",
          checkedRevision,
        }),
      );
    } else if (error.keyword === "enum") {
      const prop = error.instancePath.replace(/^\//, "") || "frontmatter";
      const propSchema = schemaProps[prop] as
        | Record<string, unknown>
        | undefined;
      const fp = computeContractFingerprint({
        ruleCode: "WM-SCHEMA-ENUM",
        subject: prop,
        schemaPropertyRule: propSchema?.enum ?? error.params,
      });
      findings.push(
        makeCandidate({
          workspaceId,
          relativePath,
          ruleCode: "WM-SCHEMA-ENUM",
          severity: "warning",
          subject: prop,
          message: `${location}: ${error.message ?? "must be equal to one of the allowed values"}`,
          explanation: `Value for '${prop}' must match one of the allowed enum values in ${schemaRel}.`,
          contractPath: schemaRel,
          contractFingerprint: fp,
          fixStrategy: "agent",
          checkedRevision,
        }),
      );
    } else {
      const prop = error.instancePath.replace(/^\//, "") || "frontmatter";
      const propSchema = schemaProps[prop] as
        | Record<string, unknown>
        | undefined;
      const fp = computeContractFingerprint({
        ruleCode: "WM-SCHEMA-TYPE",
        subject: prop,
        schemaPropertyRule: propSchema ?? error.keyword,
      });
      findings.push(
        makeCandidate({
          workspaceId,
          relativePath,
          ruleCode: "WM-SCHEMA-TYPE",
          severity: "warning",
          subject: prop,
          message: `${location}: ${error.message ?? "validation error"}`,
          explanation: `Field '${prop}' does not satisfy the type or format constraint in ${schemaRel}.`,
          contractPath: schemaRel,
          contractFingerprint: fp,
          fixStrategy: "agent",
          checkedRevision,
        }),
      );
    }
  }
}

function humanizeDomainLabel(domainPath: string): string {
  return domainPath
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    )
    .join(" ");
}

export class MaintainerService {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly db: MaintainerDB;

  constructor(options: {
    workspaceRoot: string;
    maintainerRoot?: string | undefined;
    dbPath?: string | undefined;
  }) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.workspaceId = `ws_${sha256Hex(this.workspaceRoot).slice(0, 12)}`;
    const dbPath =
      options.dbPath ??
      join(
        options.maintainerRoot ??
          process.env.OPENLIA_MAINTAINER_ROOT ??
          resolve(this.workspaceRoot, "..", "maintainer"),
        "maintainer.sqlite",
      );
    this.db = new MaintainerDB(dbPath);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Expands a list of changed relative paths to include any files in the same folder
   * whose validation depends on them (e.g. changing a template or schema revalidates
   * Markdown records in that folder).
   */
  expandDependentPaths(changedRelativePaths: string[]): string[] {
    const expanded = new Set<string>();
    for (const raw of changedRelativePaths) {
      const clean = raw.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
      if (!clean || protectedPath(clean)) continue;
      expanded.add(clean);

      const lower = clean.toLowerCase();
      const folderRel = dirname(clean).replaceAll("\\", "/");
      const folderAbs =
        folderRel === "."
          ? this.workspaceRoot
          : resolve(this.workspaceRoot, folderRel);

      if (lower.endsWith("-template.md") || lower.endsWith(".schema.json")) {
        if (existsSync(folderAbs)) {
          try {
            const entries = readdirSync(folderAbs, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isFile() || entry.name.startsWith(".")) continue;
              const childRel =
                folderRel === "." ? entry.name : `${folderRel}/${entry.name}`;
              if (!protectedPath(childRel)) {
                expanded.add(childRel);
              }
            }
          } catch {}
        }
      }
    }
    return [...expanded].sort();
  }

  /**
   * Validates and reconciles findings for the given paths (and their dependents)
   * with a revision-race guard so stale reads never overwrite newer file state.
   */
  validateAndReconcilePaths(
    changedRelativePaths: string[],
  ): MaintainerFindingRecord[] {
    const targets = this.expandDependentPaths(changedRelativePaths);
    const updatedRecords: MaintainerFindingRecord[] = [];
    const nowIso = new Date().toISOString();

    for (const relPath of targets) {
      const absPath = resolve(this.workspaceRoot, relPath);
      if (
        !absPath.startsWith(this.workspaceRoot + sep) ||
        !existsSync(absPath)
      ) {
        this.db.markFileDeleted(this.workspaceId, relPath, nowIso);
        continue;
      }

      let reconciledForFile: MaintainerFindingRecord[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const info = lstatSync(absPath);
          if (info.isSymbolicLink() || !info.isFile()) {
            this.db.markFileDeleted(this.workspaceId, relPath, nowIso);
            break;
          }
          const bytes = readFileSync(absPath);
          if (bytes.includes(0)) break;
          const checkedRev = revision(bytes);
          const content = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
          const candidates = evaluateFileFindings(
            this.workspaceRoot,
            this.workspaceId,
            relPath,
            content,
            checkedRev,
          );

          // Revision-race check: verify file did not change while validating
          const afterBytes = readFileSync(absPath);
          if (revision(afterBytes) !== checkedRev) {
            continue;
          }

          reconciledForFile = this.db.reconcileFileFindings(
            this.workspaceId,
            relPath,
            checkedRev,
            candidates,
            nowIso,
          );
          break;
        } catch {
          break;
        }
      }
      updatedRecords.push(...reconciledForFile);
    }

    return updatedRecords;
  }

  /**
   * Discovers collections/domains from workspace folders, local templates,
   * schemas, and Markdown records without requiring workspace.yaml.
   */
  discoverCollections(): DiscoveredCollection[] {
    const collections: DiscoveredCollection[] = [];
    const seenPaths = new Set<string>();
    const allFindings = this.db.listFindings({
      workspaceId: this.workspaceId,
      category: "contract",
    });

    const openByFolder = new Map<string, number>();
    const ignoredByFolder = new Map<string, number>();
    for (const f of allFindings) {
      if (!f.present) continue;
      const folder = dirname(f.relative_path).replaceAll("\\", "/");
      if (f.state === "open") {
        openByFolder.set(folder, (openByFolder.get(folder) ?? 0) + 1);
      } else if (f.state === "ignored") {
        ignoredByFolder.set(folder, (ignoredByFolder.get(folder) ?? 0) + 1);
      }
    }

    const inspectDirectory = (dirAbs: string, relDir: string): void => {
      let entries: Dirent<string>[] = [];
      try {
        entries = readdirSync(dirAbs, {
          encoding: "utf8",
          withFileTypes: true,
        });
      } catch {
        return;
      }

      if (relDir !== ".") {
        const templates = entries.filter(
          (e) =>
            e.isFile() &&
            !e.name.startsWith(".") &&
            e.name.toLowerCase().endsWith("-template.md"),
        );
        const schemas = entries.filter(
          (e) =>
            e.isFile() &&
            !e.name.startsWith(".") &&
            e.name.toLowerCase().endsWith(".schema.json"),
        );
        const mdRecords = entries.filter(
          (e) =>
            e.isFile() &&
            !e.name.startsWith(".") &&
            e.name.toLowerCase().endsWith(".md") &&
            !e.name.toLowerCase().endsWith("-template.md") &&
            e.name.toLowerCase() !== "readme.md",
        );
        const isCore = relDir in CORE_DOMAIN_PURPOSES;
        const isTopLevel = !relDir.includes("/");

        if (
          isCore ||
          templates.length > 0 ||
          schemas.length > 0 ||
          mdRecords.length > 0 ||
          isTopLevel
        ) {
          seenPaths.add(relDir);
          const coreMeta = CORE_DOMAIN_PURPOSES[relDir];
          const label = coreMeta?.label ?? humanizeDomainLabel(relDir);
          let inferredPurpose =
            coreMeta?.purpose ?? `Workspace collection in ${relDir}.`;

          const templateInfo = findDomainTemplate(
            this.workspaceRoot,
            `${relDir}/dummy.md`,
          );
          const templatePath =
            templateInfo?.templateRelativePath ??
            (templates[0] ? `${relDir}/${templates[0].name}` : undefined);
          const schemaPath =
            templateInfo?.schemaRelativePath ??
            (schemas[0] ? `${relDir}/${schemas[0].name}` : undefined);

          const kind: DiscoveredCollection["kind"] = isCore
            ? "core"
            : templatePath
              ? "template"
              : "freeform";

          if (!coreMeta) {
            if (templatePath) {
              inferredPurpose = `Structured records governed by ${templatePath} (suggested description).`;
            } else {
              inferredPurpose = `Free-form workspace folder (${mdRecords.length} record${mdRecords.length === 1 ? "" : "s"}).`;
            }
          }

          collections.push({
            path: relDir,
            label,
            kind,
            ...(templatePath ? { template_path: templatePath } : {}),
            ...(schemaPath ? { schema_path: schemaPath } : {}),
            inferred_purpose: inferredPurpose,
            record_count: mdRecords.length,
            open_finding_count: openByFolder.get(relDir) ?? 0,
            ignored_finding_count: ignoredByFolder.get(relDir) ?? 0,
          });
        }
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const childAbs = join(dirAbs, entry.name);
        const childRel =
          relDir === "." ? entry.name : `${relDir}/${entry.name}`;
        if (protectedPath(childRel)) continue;
        try {
          const st = lstatSync(childAbs);
          if (st.isSymbolicLink()) continue;
          inspectDirectory(childAbs, childRel);
        } catch {}
      }
    };

    inspectDirectory(this.workspaceRoot, ".");
    collections.sort((a, b) => a.path.localeCompare(b.path));
    return collections;
  }

  /**
   * Runs a full non-destructive workspace audit, reconciling all findings,
   * tracking scan coverage, and generating optional organizational suggestions.
   */
  runWorkspaceAudit(): MaintainerOverviewResult {
    const nowIso = new Date().toISOString();
    let filesScanned = 0;
    let filesSkipped = 0;
    const scanErrors: string[] = [];
    const seenFilePaths = new Set<string>();

    const walk = (dirAbs: string, relDir: string): void => {
      let entries: Dirent<string>[] = [];
      try {
        entries = readdirSync(dirAbs, {
          encoding: "utf8",
          withFileTypes: true,
        });
      } catch (err) {
        scanErrors.push(
          `Failed to read directory ${relDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      const mdRecordsInFolder: string[] = [];
      let hasTemplate = false;

      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const abs = join(dirAbs, entry.name);
        const rel = relDir === "." ? entry.name : `${relDir}/${entry.name}`;
        if (protectedPath(rel)) continue;

        let info: ReturnType<typeof lstatSync>;
        try {
          info = lstatSync(abs);
        } catch (err) {
          filesSkipped++;
          scanErrors.push(
            `Failed to stat ${rel}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }

        if (info.isSymbolicLink()) {
          filesSkipped++;
          continue;
        }

        if (info.isDirectory()) {
          walk(abs, rel);
          continue;
        }

        if (!info.isFile()) continue;

        const lower = entry.name.toLowerCase();
        if (lower.endsWith("-template.md")) {
          hasTemplate = true;
        } else if (lower.endsWith(".md") && lower !== "readme.md") {
          mdRecordsInFolder.push(rel);
        }

        const shouldValidate =
          lower.endsWith(".md") || lower.endsWith(".schema.json");

        if (!shouldValidate) continue;

        try {
          const bytes = readFileSync(abs);
          if (bytes.includes(0)) {
            filesSkipped++;
            continue;
          }
          const checkedRev = revision(bytes);
          const content = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
          const candidates = evaluateFileFindings(
            this.workspaceRoot,
            this.workspaceId,
            rel,
            content,
            checkedRev,
          );
          this.db.reconcileFileFindings(
            this.workspaceId,
            rel,
            checkedRev,
            candidates,
            nowIso,
          );
          seenFilePaths.add(rel);
          filesScanned++;
        } catch (err) {
          // A scan error is NEVER proof of resolution; leave existing findings untouched
          filesSkipped++;
          scanErrors.push(
            `Failed to scan ${rel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Optional organizational suggestion: if a non-core folder has >= 5 Markdown records and no template
      if (
        relDir !== "." &&
        !(relDir in CORE_DOMAIN_PURPOSES) &&
        !hasTemplate &&
        mdRecordsInFolder.length >= 5
      ) {
        const anchorPath = mdRecordsInFolder[0]!;
        const fp = computeContractFingerprint({
          ruleCode: "WM-SUGGEST-TEMPLATE",
          subject: relDir,
        });
        const suggestion = makeCandidate({
          workspaceId: this.workspaceId,
          relativePath: relDir,
          ruleCode: "WM-SUGGEST-TEMPLATE",
          severity: "info",
          category: "suggestion",
          subject: relDir,
          message: `Collection '${relDir}' has ${mdRecordsInFolder.length} Markdown records without a local *-template.md`,
          explanation: `Adding a local template in '${relDir}/' is optional, but can help keep sections and frontmatter consistent across records (${anchorPath}, etc.).`,
          contractFingerprint: fp,
          fixStrategy: "agent",
          checkedRevision: `count:${mdRecordsInFolder.length}`,
        });
        this.db.reconcileFileFindings(
          this.workspaceId,
          relDir,
          `count:${mdRecordsInFolder.length}`,
          [suggestion],
          nowIso,
        );
        seenFilePaths.add(relDir);
      } else if (relDir !== ".") {
        this.db.reconcileFileFindings(
          this.workspaceId,
          relDir,
          "count:0",
          [],
          nowIso,
        );
      }
    };

    walk(this.workspaceRoot, ".");

    // Mark findings for files that were deleted while offline as resolved (only if scan had no directory errors)
    if (scanErrors.length === 0) {
      const activeFindings = this.db.listFindings({
        workspaceId: this.workspaceId,
      });
      for (const f of activeFindings) {
        if (f.present && !seenFilePaths.has(f.relative_path)) {
          const abs = resolve(this.workspaceRoot, f.relative_path);
          if (!existsSync(abs)) {
            this.db.markFileDeleted(this.workspaceId, f.relative_path, nowIso);
          }
        }
      }
    }

    this.db.recordScanState({
      workspace_id: this.workspaceId,
      last_scan_at: nowIso,
      coverage_status: scanErrors.length > 0 ? "partial" : "complete",
      files_scanned: filesScanned,
      files_skipped: filesSkipped,
      scan_errors: scanErrors,
    });

    return this.getOverview();
  }

  getFileFindings(relativePath: string): MaintainerFindingRecord[] {
    return this.db.listFindings({
      workspaceId: this.workspaceId,
      relativePath,
      category: "contract",
    });
  }

  getOverview(): MaintainerOverviewResult {
    let scanState = this.db.getScanState(this.workspaceId);
    if (!scanState) {
      return this.runWorkspaceAudit();
    }

    const all = this.db.listFindings({ workspaceId: this.workspaceId });
    const contractFindings = all.filter((f) => f.category === "contract");
    const suggestions = all.filter(
      (f) => f.category === "suggestion" && f.state === "open",
    );

    const openFindings = contractFindings.filter((f) => f.state === "open");
    const ignoredFindings = contractFindings.filter(
      (f) => f.state === "ignored",
    );
    const resolvedFindings = contractFindings.filter(
      (f) => f.state === "resolved",
    );
    const collections = this.discoverCollections();

    return {
      schema: 1,
      workspace_id: this.workspaceId,
      counts: {
        open: openFindings.length,
        ignored: ignoredFindings.length,
        resolved: resolvedFindings.length,
        suggestions: suggestions.length,
        collections: collections.length,
      },
      scan_state: scanState,
      collections,
      open_findings: openFindings,
      ignored_findings: ignoredFindings,
      resolved_findings: resolvedFindings,
      suggestions,
    };
  }
}
