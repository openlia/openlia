import { execFile } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import YAML from "yaml";
import type {
  MinionConfig,
  MinionCreateRequest,
  MinionDetail,
  MinionDetailResponse,
  MinionExecutionStep,
  MinionQuickAction,
  MinionRunRequest,
  MinionRunResponse,
  MinionRuntime,
  MinionSummary,
  MinionsListResponse,
  MinionTriggerSpec,
  MinionTriggersConfig,
  WorkspaceFileMetadata,
} from "../shared/api";
import { openUIDiagnostics } from "../shared/openui";
import { extractHeadings, parseRecordFrontmatter } from "./validator";
import {
  DEFAULT_MAX_EDITABLE_BYTES,
  protectedPath,
  revision,
  WorkspaceError,
} from "./workspace";

const MINION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_HEARTBEAT_SCHEDULE = "0 */6 * * *";
const IGNORED_MINION_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".venv",
  ".pytest_cache",
  ".git",
]);

const DATA_EXTENSIONS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".hledger",
  ".journal",
  ".rem",
  ".remind",
  ".md",
  ".markdown",
  ".txt",
]);

const CODE_EXTENSIONS = new Set([".py", ".ts", ".js", ".mjs", ".sh", ".bash"]);

export interface MinionServiceOptions {
  workspaceRoot: string;
  maxEditableBytes?: number | undefined;
  timeoutMs?: number | undefined;
}

export function validateMinionId(id: unknown): string {
  if (typeof id !== "string" || !MINION_ID_PATTERN.test(id.trim())) {
    throw new WorkspaceError(
      "invalid minion identifier (expected lowercase alphanumeric and hyphens)",
      400,
      "invalid_minion_id",
    );
  }
  return id.trim();
}

function humanizeMinionId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isTestFilePath(relFromMinion: string): boolean {
  const normalized = relFromMinion.replaceAll("\\", "/");
  const base = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (normalized.startsWith("tests/")) return true;
  return (
    base.startsWith("test_") ||
    base.endsWith("_test.py") ||
    base.endsWith(".test.ts") ||
    base.endsWith(".test.js") ||
    base.endsWith(".spec.ts")
  );
}

function isRegularFile(absPath: string): boolean {
  try {
    if (!existsSync(absPath)) return false;
    const st = lstatSync(absPath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

function parseReadmeMetadata(
  readmeContent: string,
  fallbackId: string,
): {
  name: string;
  description: string;
  icon?: string | undefined;
  quickActions: MinionQuickAction[];
  triggers: MinionTriggersConfig;
} {
  const fallbackName = humanizeMinionId(fallbackId);
  let name = fallbackName;
  let description = `Autonomous Minion in minions/${fallbackId}`;
  let icon: string | undefined;
  const quickActions: MinionQuickAction[] = [];
  const triggers: MinionTriggersConfig = {
    after_entry: true,
  };

  const { metadata, body } = parseRecordFrontmatter(readmeContent);
  if (metadata) {
    if (typeof metadata.name === "string" && metadata.name.trim()) {
      name = metadata.name.trim();
    }
    if (
      typeof metadata.description === "string" &&
      metadata.description.trim()
    ) {
      description = metadata.description.trim();
    }
    if (typeof metadata.icon === "string" && metadata.icon.trim()) {
      icon = metadata.icon.trim();
    }
    if (
      typeof metadata.heartbeat_schedule === "string" &&
      metadata.heartbeat_schedule.trim()
    ) {
      triggers.heartbeat_schedule = metadata.heartbeat_schedule.trim();
    }
    if (
      metadata.triggers &&
      typeof metadata.triggers === "object" &&
      !Array.isArray(metadata.triggers)
    ) {
      const rawTriggers = metadata.triggers as Record<string, unknown>;
      if (typeof rawTriggers.after_entry === "boolean") {
        triggers.after_entry = rawTriggers.after_entry;
      }
      if (
        typeof rawTriggers.heartbeat_schedule === "string" &&
        rawTriggers.heartbeat_schedule.trim()
      ) {
        triggers.heartbeat_schedule = rawTriggers.heartbeat_schedule.trim();
      }
    }
    if (Array.isArray(metadata.quick_actions)) {
      for (const raw of metadata.quick_actions) {
        if (
          raw &&
          typeof raw === "object" &&
          typeof (raw as Record<string, unknown>).id === "string" &&
          typeof (raw as Record<string, unknown>).label === "string"
        ) {
          const item = raw as Record<string, unknown>;
          quickActions.push({
            id: String(item.id).trim(),
            label: String(item.label).trim(),
            ...(typeof item.description === "string"
              ? { description: item.description }
              : {}),
            ...(typeof item.placeholder === "string"
              ? { placeholder: item.placeholder }
              : {}),
            ...(Array.isArray(item.args)
              ? { args: item.args.map((a) => String(a)) }
              : {}),
          });
        }
      }
    }
  }

  const headings = extractHeadings(body);
  const h1 = headings.find((h) => h.level === 1);
  if (name === fallbackName && h1?.text.trim()) {
    name = h1.text.trim();
  }
  if (description.startsWith("Autonomous Minion in ")) {
    const paragraph = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          l.length > 0 &&
          !l.startsWith("#") &&
          !l.startsWith("```") &&
          !l.startsWith("---"),
      );
    if (paragraph) description = paragraph;
  }

  return { name, description, icon, quickActions, triggers };
}

function uiFileSortPriority(name: string): number {
  if (name === "dashboard.openui") return 0;
  if (name === "input.openui") return 1;
  if (name === "ui.openui") return 2;
  return 3;
}

export function validateMinionTriggerSpec(
  triggerVal: unknown,
  fallbackSchedule: string = DEFAULT_HEARTBEAT_SCHEDULE,
): {
  valid: boolean;
  errors: string[];
  resolved: MinionTriggersConfig;
} {
  if (triggerVal === undefined || triggerVal === null) {
    return {
      valid: false,
      errors: ["missing required property 'trigger'"],
      resolved: { after_entry: true, heartbeat_schedule: fallbackSchedule },
    };
  }

  if (typeof triggerVal === "string") {
    const trimmed = triggerVal.trim();
    if (trimmed === "entry") {
      return {
        valid: true,
        errors: [],
        resolved: { after_entry: true },
      };
    }
    if (trimmed === "cron") {
      return {
        valid: true,
        errors: [],
        resolved: { after_entry: false, heartbeat_schedule: fallbackSchedule },
      };
    }
    if (trimmed === "both") {
      return {
        valid: true,
        errors: [],
        resolved: { after_entry: true, heartbeat_schedule: fallbackSchedule },
      };
    }
    return {
      valid: false,
      errors: ["trigger string must be one of 'entry', 'cron', or 'both'"],
      resolved: { after_entry: true, heartbeat_schedule: fallbackSchedule },
    };
  }

  if (typeof triggerVal === "object" && !Array.isArray(triggerVal)) {
    const obj = triggerVal as Record<string, unknown>;
    const errors: string[] = [];
    for (const key of Object.keys(obj)) {
      if (key !== "on_new_entry" && key !== "cron") {
        errors.push(
          `trigger.${key}: unrecognized property (allowed: 'on_new_entry', 'cron')`,
        );
      }
    }
    const hasOnNewEntry =
      "on_new_entry" in obj && obj.on_new_entry !== undefined;
    const hasCron = "cron" in obj && obj.cron !== undefined;

    if (!hasOnNewEntry && !hasCron) {
      errors.push(
        "trigger must specify 'on_new_entry' (boolean) and/or 'cron' (non-empty string)",
      );
    }

    let afterEntry = false;
    if (hasOnNewEntry) {
      if (typeof obj.on_new_entry !== "boolean") {
        errors.push("trigger.on_new_entry must be a boolean");
      } else {
        afterEntry = obj.on_new_entry;
      }
    }

    let heartbeatSchedule: string | undefined;
    if (hasCron) {
      if (typeof obj.cron !== "string" || !obj.cron.trim()) {
        errors.push("trigger.cron must be a non-empty cron expression string");
      } else {
        heartbeatSchedule = obj.cron.trim();
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      resolved: {
        after_entry: afterEntry,
        ...(heartbeatSchedule ? { heartbeat_schedule: heartbeatSchedule } : {}),
      },
    };
  }

  return {
    valid: false,
    errors: [
      "trigger must be 'entry' | 'cron' | 'both' or an object with 'on_new_entry' and/or 'cron'",
    ],
    resolved: { after_entry: true, heartbeat_schedule: fallbackSchedule },
  };
}

export function validateMinionConfigObject(
  configObj: unknown,
  configSchema?: Record<string, unknown> | undefined,
  fallbackSchedule: string = DEFAULT_HEARTBEAT_SCHEDULE,
): {
  valid: boolean;
  errors: string[];
  config?: MinionConfig | undefined;
  resolvedTriggers: MinionTriggersConfig;
} {
  if (!configObj || typeof configObj !== "object" || Array.isArray(configObj)) {
    return {
      valid: false,
      errors: ["config root must be a JSON object"],
      resolvedTriggers: {
        after_entry: true,
        heartbeat_schedule: fallbackSchedule,
      },
    };
  }

  const record = configObj as Record<string, unknown>;
  const errors: string[] = [];

  const triggerCheck = validateMinionTriggerSpec(
    record.trigger,
    fallbackSchedule,
  );
  if (!triggerCheck.valid) {
    errors.push(...triggerCheck.errors);
  }

  if (configSchema) {
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      const validate = ajv.compile(configSchema);
      if (!validate(record)) {
        for (const err of validate.errors ?? []) {
          const loc = err.instancePath ? `config${err.instancePath}` : "config";
          if (
            err.keyword === "required" &&
            err.params &&
            "missingProperty" in err.params
          ) {
            const prop = String(err.params.missingProperty);
            if (prop === "trigger" && !triggerCheck.valid) {
              continue;
            }
            errors.push(`${loc}: missing required property '${prop}'`);
          } else if (
            err.keyword === "additionalProperties" &&
            err.params &&
            "additionalProperty" in err.params
          ) {
            errors.push(
              `${loc}: unrecognized property '${String(err.params.additionalProperty)}'`,
            );
          } else {
            errors.push(`${loc}: ${err.message ?? "schema validation error"}`);
          }
        }
      }
    } catch (err) {
      errors.push(
        err instanceof Error
          ? err.message
          : "failed to validate against config.schema.json",
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    ...(errors.length === 0
      ? {
          config: {
            ...record,
            trigger: record.trigger as MinionTriggerSpec,
          },
        }
      : {}),
    resolvedTriggers: triggerCheck.resolved,
  };
}

export class MinionService {
  readonly workspaceRoot: string;
  readonly maxEditableBytes: number;
  readonly timeoutMs: number;

  constructor(options: MinionServiceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.maxEditableBytes =
      options.maxEditableBytes ?? DEFAULT_MAX_EDITABLE_BYTES;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private minionsRoot(): string {
    return join(this.workspaceRoot, "minions");
  }

  private resolveMinionDir(id: string): string {
    const validId = validateMinionId(id);
    const dir = resolve(this.minionsRoot(), validId);
    if (!dir.startsWith(this.minionsRoot() + sep)) {
      throw new WorkspaceError(
        "invalid minion path",
        400,
        "invalid_minion_path",
      );
    }
    return dir;
  }

  private fileMetadata(absPath: string): WorkspaceFileMetadata | null {
    try {
      const info: Stats = lstatSync(absPath);
      if (info.isSymbolicLink() || !info.isFile()) return null;
      const rel = relative(this.workspaceRoot, absPath).replaceAll("\\", "/");
      if (protectedPath(rel)) return null;
      const bytes = readFileSync(absPath);
      return {
        path: rel,
        size: info.size,
        modified_at: info.mtime.toISOString(),
        editable: info.size <= this.maxEditableBytes,
        revision: revision(bytes),
      };
    } catch {
      return null;
    }
  }

  private collectDirectoryFiles(
    dirAbs: string,
    minionRootAbs: string,
  ): Array<{ relToMinion: string; meta: WorkspaceFileMetadata }> {
    const results: Array<{ relToMinion: string; meta: WorkspaceFileMetadata }> =
      [];
    if (!existsSync(dirAbs)) return results;
    let entries: Dirent<string>[] = [];
    try {
      entries = readdirSync(dirAbs, { encoding: "utf8", withFileTypes: true });
    } catch {
      return results;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED_MINION_DIRS.has(entry.name)) {
        continue;
      }
      const abs = join(dirAbs, entry.name);
      try {
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          results.push(...this.collectDirectoryFiles(abs, minionRootAbs));
        } else if (st.isFile()) {
          const meta = this.fileMetadata(abs);
          if (meta) {
            const relToMinion = relative(minionRootAbs, abs).replaceAll(
              "\\",
              "/",
            );
            results.push({ relToMinion, meta });
          }
        }
      } catch {}
    }
    return results;
  }

  private inspectMinion(id: string, dirAbs: string): MinionDetail | null {
    try {
      const st = lstatSync(dirAbs);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch {
      return null;
    }

    const readmeAbs = join(dirAbs, "README.md");
    const mainPyAbs = join(dirAbs, "main.py");
    const mainTsAbs = join(dirAbs, "main.ts");
    const hasReadme = isRegularFile(readmeAbs);
    const hasMainPy = isRegularFile(mainPyAbs);
    const hasMainTs = isRegularFile(mainTsAbs);

    if (!hasReadme || (!hasMainPy && !hasMainTs)) {
      return null;
    }

    const runtime: MinionRuntime = hasMainPy ? "python" : "typescript";
    const entrypoint: "main.py" | "main.ts" = hasMainPy ? "main.py" : "main.ts";

    const hasInputPy = isRegularFile(join(dirAbs, "input.py"));
    const hasInputTs = isRegularFile(join(dirAbs, "input.ts"));
    let inputEntrypoint: "input.py" | "input.ts" | undefined;
    if (runtime === "python") {
      if (hasInputPy) inputEntrypoint = "input.py";
      else if (hasInputTs) inputEntrypoint = "input.ts";
    } else {
      if (hasInputTs) inputEntrypoint = "input.ts";
      else if (hasInputPy) inputEntrypoint = "input.py";
    }

    let dependencyFile: "requirements.txt" | "package.json" | undefined;
    if (isRegularFile(join(dirAbs, "requirements.txt"))) {
      dependencyFile = "requirements.txt";
    } else if (isRegularFile(join(dirAbs, "package.json"))) {
      dependencyFile = "package.json";
    }

    const readmeContent = readFileSync(readmeAbs, "utf-8");
    const parsedMeta = parseReadmeMetadata(readmeContent, id);

    const allFiles = this.collectDirectoryFiles(dirAbs, dirAbs);
    const uiFiles: string[] = [];
    const uiContents: Record<string, string> = {};
    const renderErrors: string[] = [];
    const dataFiles: WorkspaceFileMetadata[] = [];
    const codeFiles: WorkspaceFileMetadata[] = [];
    const testFiles: WorkspaceFileMetadata[] = [];

    let inputSchemaFile: string | undefined;
    let inputSchemaContent: string | undefined;
    let inputSchema: Record<string, unknown> | undefined;
    const inputSchemaAbs = join(dirAbs, "input.schema.json");
    if (isRegularFile(inputSchemaAbs)) {
      inputSchemaFile = "input.schema.json";
      try {
        inputSchemaContent = readFileSync(inputSchemaAbs, "utf-8");
        const parsedSchema = JSON.parse(inputSchemaContent);
        if (
          !parsedSchema ||
          typeof parsedSchema !== "object" ||
          Array.isArray(parsedSchema)
        ) {
          renderErrors.push(
            "input.schema.json: schema root must be a JSON object",
          );
        } else {
          const ajv = new Ajv2020({ allErrors: true, strict: false });
          addFormats(ajv);
          ajv.compile(parsedSchema);
          inputSchema = parsedSchema as Record<string, unknown>;
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "invalid JSON Schema syntax";
        renderErrors.push(`input.schema.json: ${msg}`);
      }
    }

    let configSchemaFile: string | undefined;
    let configSchemaContent: string | undefined;
    let configSchema: Record<string, unknown> | undefined;
    const configSchemaAbs = join(dirAbs, "config.schema.json");
    if (isRegularFile(configSchemaAbs)) {
      configSchemaFile = "config.schema.json";
      try {
        configSchemaContent = readFileSync(configSchemaAbs, "utf-8");
        const parsedConfigSchema = JSON.parse(configSchemaContent);
        if (
          !parsedConfigSchema ||
          typeof parsedConfigSchema !== "object" ||
          Array.isArray(parsedConfigSchema)
        ) {
          renderErrors.push(
            "config.schema.json: schema root must be a JSON object",
          );
        } else {
          const ajv = new Ajv2020({ allErrors: true, strict: false });
          addFormats(ajv);
          ajv.compile(parsedConfigSchema);
          configSchema = parsedConfigSchema as Record<string, unknown>;
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "invalid JSON Schema syntax";
        renderErrors.push(`config.schema.json: ${msg}`);
      }
    }

    let configFile: string | undefined;
    let configContent: string | undefined;
    let configObj: MinionConfig | undefined;
    let effectiveTriggers: MinionTriggersConfig = parsedMeta.triggers;
    const configAbs = join(dirAbs, "config.json");
    if (isRegularFile(configAbs)) {
      configFile = "config.json";
      try {
        configContent = readFileSync(configAbs, "utf-8");
        const parsedConfig = JSON.parse(configContent);
        const validation = validateMinionConfigObject(
          parsedConfig,
          configSchema,
          parsedMeta.triggers.heartbeat_schedule ?? DEFAULT_HEARTBEAT_SCHEDULE,
        );
        effectiveTriggers = validation.resolvedTriggers;
        if (!validation.valid) {
          for (const err of validation.errors) {
            renderErrors.push(`config.json: ${err}`);
          }
        }
        if (
          parsedConfig &&
          typeof parsedConfig === "object" &&
          !Array.isArray(parsedConfig)
        ) {
          configObj = parsedConfig as MinionConfig;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid JSON syntax";
        renderErrors.push(`config.json: ${msg}`);
      }
    }

    for (const { relToMinion, meta } of allFiles) {
      const lower = relToMinion.toLowerCase();
      const ext = lower.includes(".")
        ? lower.slice(lower.lastIndexOf("."))
        : "";

      if (lower.endsWith(".openui")) {
        uiFiles.push(relToMinion);
        try {
          const rawUi = readFileSync(join(dirAbs, relToMinion), "utf-8");
          uiContents[relToMinion] = rawUi;
          for (const diag of openUIDiagnostics(rawUi)) {
            const detail = diag.hint
              ? `${diag.code}: ${diag.message} (${diag.hint})`
              : `${diag.code}: ${diag.message}`;
            renderErrors.push(`${relToMinion}: ${detail}`);
          }
        } catch {}
        continue;
      }

      if (isTestFilePath(relToMinion)) {
        testFiles.push(meta);
        continue;
      }

      if (
        relToMinion === "main.py" ||
        relToMinion === "main.ts" ||
        relToMinion === "input.py" ||
        relToMinion === "input.ts" ||
        relToMinion === "input.schema.json" ||
        relToMinion === "config.json" ||
        relToMinion === "config.schema.json" ||
        relToMinion === "requirements.txt" ||
        relToMinion === "package.json" ||
        relToMinion.startsWith("scripts/") ||
        CODE_EXTENSIONS.has(ext)
      ) {
        codeFiles.push(meta);
        continue;
      }

      if (lower === "readme.md") {
        continue;
      }

      if (
        relToMinion.startsWith("data/") ||
        (DATA_EXTENSIONS.has(ext) &&
          lower !== "package-lock.json" &&
          lower !== "tsconfig.json" &&
          !lower.endsWith(".schema.json") &&
          !lower.endsWith("-template.md"))
      ) {
        dataFiles.push(meta);
      }
    }

    uiFiles.sort((a, b) => {
      const pa = uiFileSortPriority(a);
      const pb = uiFileSortPriority(b);
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });

    const dashboardUiFile = uiFiles.includes("dashboard.openui")
      ? "dashboard.openui"
      : uiFiles.includes("ui.openui")
        ? "ui.openui"
        : (uiFiles.find((f) => f !== "input.openui") ?? uiFiles[0]);
    const inputUiFile = uiFiles.includes("input.openui")
      ? "input.openui"
      : undefined;
    const primaryUiFile = dashboardUiFile ?? uiFiles[0];
    const renderable = uiFiles.length > 0 && renderErrors.length === 0;

    return {
      id,
      path: `minions/${id}`,
      name: parsedMeta.name,
      description: parsedMeta.description,
      ...(parsedMeta.icon ? { icon: parsedMeta.icon } : {}),
      runtime,
      entrypoint,
      ...(inputEntrypoint ? { input_entrypoint: inputEntrypoint } : {}),
      ...(inputSchemaFile ? { input_schema_file: inputSchemaFile } : {}),
      ...(configFile ? { config_file: configFile } : {}),
      ...(configSchemaFile ? { config_schema_file: configSchemaFile } : {}),
      ...(dependencyFile ? { dependency_file: dependencyFile } : {}),
      ui_files: uiFiles,
      ...(primaryUiFile ? { primary_ui_file: primaryUiFile } : {}),
      ...(dashboardUiFile ? { dashboard_ui_file: dashboardUiFile } : {}),
      ...(inputUiFile ? { input_ui_file: inputUiFile } : {}),
      triggers: effectiveTriggers,
      data_file_count: dataFiles.length,
      script_file_count: codeFiles.length,
      test_file_count: testFiles.length,
      renderable,
      ...(renderErrors.length > 0 ? { render_errors: renderErrors } : {}),
      quick_actions: parsedMeta.quickActions,
      readme_content: readmeContent,
      ui_contents: uiContents,
      ...(inputSchema ? { input_schema: inputSchema } : {}),
      ...(inputSchemaContent !== undefined
        ? { input_schema_content: inputSchemaContent }
        : {}),
      ...(configObj ? { config: configObj } : {}),
      ...(configContent !== undefined ? { config_content: configContent } : {}),
      ...(configSchema ? { config_schema: configSchema } : {}),
      ...(configSchemaContent !== undefined
        ? { config_schema_content: configSchemaContent }
        : {}),
      data_files: dataFiles,
      code_files: codeFiles,
      test_files: testFiles,
    };
  }

  private toSummary(detail: MinionDetail): MinionSummary {
    const {
      readme_content: _r,
      ui_contents: _u,
      input_schema: _is,
      input_schema_content: _isc,
      config: _cfg,
      config_content: _cfgc,
      config_schema: _cs,
      config_schema_content: _csc,
      data_files: _d,
      code_files: _c,
      test_files: _t,
      ...summary
    } = detail;
    return summary;
  }

  listMinions(): MinionsListResponse {
    const root = this.minionsRoot();
    if (!existsSync(root)) {
      return { schema: 1, minions: [] };
    }
    let entries: Dirent<string>[] = [];
    try {
      entries = readdirSync(root, { encoding: "utf8", withFileTypes: true });
    } catch {
      return { schema: 1, minions: [] };
    }
    const minions: MinionSummary[] = [];
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        !MINION_ID_PATTERN.test(entry.name) ||
        !entry.isDirectory()
      ) {
        continue;
      }
      const detail = this.inspectMinion(entry.name, join(root, entry.name));
      if (detail) {
        minions.push(this.toSummary(detail));
      }
    }
    return { schema: 1, minions };
  }

  getMinion(id: string): MinionDetailResponse {
    const dir = this.resolveMinionDir(id);
    const detail = this.inspectMinion(validateMinionId(id), dir);
    if (!detail) {
      throw new WorkspaceError("minion not found", 404, "minion_not_found");
    }
    return { schema: 1, minion: detail };
  }

  createMinion(req: Partial<MinionCreateRequest>): MinionDetailResponse {
    const id = validateMinionId(req.id);
    const name =
      typeof req.name === "string" && req.name.trim()
        ? req.name.trim()
        : humanizeMinionId(id);
    const description =
      typeof req.description === "string" && req.description.trim()
        ? req.description.trim()
        : `Track ${name.toLowerCase()} entries with structured input validation, post-entry analysis, and heartbeat enrichment.`;
    const runtime: MinionRuntime =
      req.runtime === "typescript" ? "typescript" : "python";
    const heartbeatSchedule =
      typeof req.heartbeat_schedule === "string" &&
      req.heartbeat_schedule.trim()
        ? req.heartbeat_schedule.trim()
        : DEFAULT_HEARTBEAT_SCHEDULE;

    const dir = this.resolveMinionDir(id);
    if (existsSync(dir)) {
      throw new WorkspaceError(
        "minion already exists",
        409,
        "minion_already_exists",
      );
    }

    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });

    const readmeFrontmatter = YAML.stringify({
      name,
      description,
      triggers: {
        after_entry: true,
        heartbeat_schedule: heartbeatSchedule,
      },
      quick_actions: [
        {
          id: "add",
          label: "Add Entry",
          placeholder: `Add new item to ${name}...`,
        },
        {
          id: "heartbeat",
          label: "Run Heartbeat",
          description:
            "Enrich data and refresh dashboard.openui on heartbeat trigger",
        },
      ],
    }).trim();

    const inputCmd =
      runtime === "python"
        ? `python3 input.py --data '{"item": "..."}'`
        : `bun input.ts --data '{"item": "..."}'`;
    const mainHeartbeatCmd =
      runtime === "python"
        ? "python3 main.py --trigger heartbeat"
        : "bun main.ts --trigger heartbeat";
    const mainEntryCmd =
      runtime === "python"
        ? `python3 main.py --trigger entry --entry '{"item": "..."}'`
        : `bun main.ts --trigger entry --entry '{"item": "..."}'`;

    const readmeContent = `---\n${readmeFrontmatter}\n---\n# ${name}\n\n${description}\n\n## Architecture\n\n- **Dashboard (\`dashboard.openui\`)**: Main dashboard view rendered from \`data/items.json\` and \`data/context.json\`.\n- **Input Form (\`input.openui\`)**: OpenUI input form validated against \`input.schema.json\` and processed by \`${runtime === "python" ? "input.py" : "input.ts"}\`.\n- **Input Schema (\`input.schema.json\`)**: JSON Schema contract for new entries.\n- **Configuration (\`config.json\` & \`config.schema.json\`)**: \`config.json\` holds local instance configuration with the required OpenLia/Hermes \`trigger\` field plus any Minion-specific settings (validated by \`config.schema.json\`; when packaged for sharing, \`config.json\` is ignored and only \`config.schema.json\` is packaged).\n- **Data & Enrichment (\`${runtime === "python" ? "main.py" : "main.ts"}\`)**: Triggered in two ways:\n  1. **Post-entry trigger (\`${mainEntryCmd}\`)**: Runs automatically after every new entry to analyze the entry in context (e.g., recommending the next exercise or action given today's recorded performance) and refresh \`dashboard.openui\`.\n  2. **Heartbeat trigger (\`${mainHeartbeatCmd}\`)**: Runs on a cron job (\`${heartbeatSchedule}\`) or manual trigger to enrich data (e.g., fetching news, latest stock prices, or periodic summaries) and refresh \`dashboard.openui\`.\n\n## CLI Usage\n\n- **Record Input**: \`${inputCmd}\`\n- **Post-Entry Analysis**: \`${mainEntryCmd}\`\n- **Heartbeat Enrichment**: \`${mainHeartbeatCmd}\`\n`;
    writeFileSync(join(dir, "README.md"), readmeContent, "utf-8");

    const configSchemaObj = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `${name} Configuration`,
      type: "object",
      required: ["trigger"],
      additionalProperties: true,
      properties: {
        trigger: {
          description:
            "OpenLia/Hermes trigger configuration for main entrypoint",
          oneOf: [
            {
              type: "string",
              enum: ["entry", "cron", "both"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                on_new_entry: {
                  type: "boolean",
                  default: true,
                  description:
                    "Run main right after input.py/input.ts records a new entry",
                },
                cron: {
                  type: "string",
                  description:
                    "5-field cron expression for periodic heartbeat trigger",
                },
              },
            },
          ],
        },
      },
    };
    writeFileSync(
      join(dir, "config.schema.json"),
      `${JSON.stringify(configSchemaObj, null, 2)}\n`,
      "utf-8",
    );

    const configObj: MinionConfig = {
      trigger: {
        on_new_entry: true,
        cron: heartbeatSchedule,
      },
    };
    writeFileSync(
      join(dir, "config.json"),
      `${JSON.stringify(configObj, null, 2)}\n`,
      "utf-8",
    );

    const inputSchemaObj = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `${name} Input`,
      type: "object",
      additionalProperties: false,
      required: ["item"],
      properties: {
        date: {
          type: "string",
          format: "date",
          title: "Date",
          description: "Entry date (YYYY-MM-DD)",
        },
        item: {
          type: "string",
          minLength: 1,
          title: "Entry",
          description: "Primary activity, metric, or note to record",
        },
        category: {
          type: "string",
          title: "Category",
          default: "general",
        },
        value: {
          type: ["number", "string"],
          title: "Performance / Value",
          description:
            "Optional numeric score, weight, amount, or performance metric",
        },
        status: {
          type: "string",
          enum: ["active", "completed", "planned"],
          default: "active",
          title: "Status",
        },
        notes: {
          type: "string",
          title: "Notes",
          description: "Optional context or observations",
        },
      },
    };
    writeFileSync(
      join(dir, "input.schema.json"),
      `${JSON.stringify(inputSchemaObj, null, 2)}\n`,
      "utf-8",
    );

    const inputOpenUi = [
      "Card(children: [",
      `  CardHeader(title: ${JSON.stringify(`Record ${name} Entry`)}, subtitle: "Validated by input.schema.json -> saved via input handler -> analyzed by main"),`,
      '  Form(name: "minionInput", fields: [',
      '    FormControl(label: "Entry", input: Input(name: "item", placeholder: "Describe performance, activity, or item...", rules: {required: true})),',
      '    FormControl(label: "Category", input: Input(name: "category", placeholder: "general")),',
      '    FormControl(label: "Performance / Value", input: Input(name: "value", type: "number", placeholder: "Optional metric or score")),',
      '    FormControl(label: "Status", input: Select(name: "status", placeholder: "Select status...", items: [SelectItem(value: "active", label: "Active"), SelectItem(value: "completed", label: "Completed"), SelectItem(value: "planned", label: "Planned")])),',
      '    FormControl(label: "Notes", input: Input(name: "notes", placeholder: "Optional context or observations"))',
      "  ], buttons: Buttons(buttons: [",
      '    Button(label: "Submit Entry", variant: "primary")',
      "  ]))",
      "])",
      "",
    ].join("\n");
    writeFileSync(join(dir, "input.openui"), inputOpenUi, "utf-8");

    const todayIso = new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();
    const initialRecommendation =
      "Log your next entry to generate a tailored recommendation based on today's performance.";
    const starterItems = [
      {
        date: todayIso,
        item: `Sample ${name} entry`,
        category: "general",
        status: "active",
        recommendation: initialRecommendation,
      },
    ];
    writeFileSync(
      join(dir, "data", "items.json"),
      `${JSON.stringify(starterItems, null, 2)}\n`,
      "utf-8",
    );

    const starterContext = {
      last_trigger: "init",
      updated_at: nowIso,
      summary: "1 total entry (1 active).",
      latest_recommendation: initialRecommendation,
      enrichment: {
        status: "ready",
        last_heartbeat_at: nowIso,
        note: "Heartbeat enriches context (e.g., news, prices, or periodic summaries).",
      },
    };
    writeFileSync(
      join(dir, "data", "context.json"),
      `${JSON.stringify(starterContext, null, 2)}\n`,
      "utf-8",
    );

    const starterCalloutDesc = `${starterContext.summary} Next recommendation: ${starterContext.latest_recommendation}`;
    const dashboardCols =
      '[{key: "date", label: "Date"}, {key: "item", label: "Item"}, {key: "category", label: "Category"}, {key: "status", label: "Status"}, {key: "recommendation", label: "Recommendation"}]';
    const starterDashboardUi = [
      "Stack(children: [",
      `  Callout(variant: "info", title: "Context & Recommendations", description: ${JSON.stringify(starterCalloutDesc)}),`,
      `  Table(title: ${JSON.stringify(name)}, columns: ${dashboardCols}, rows: ${JSON.stringify(starterItems)})`,
      "])",
      "",
    ].join("\n");
    writeFileSync(join(dir, "dashboard.openui"), starterDashboardUi, "utf-8");

    if (runtime === "python") {
      writeFileSync(
        join(dir, "requirements.txt"),
        "# Add Python dependencies for this Minion\n",
        "utf-8",
      );

      const inputPy = `#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "items.json"
SCHEMA_FILE = ROOT / "input.schema.json"


def load_schema() -> dict[str, Any]:
    if not SCHEMA_FILE.exists():
        return {}
    return json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))


def load_items() -> list[dict[str, Any]]:
    if not DATA_FILE.exists():
        return []
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def save_items(items: list[dict[str, Any]]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(
        json.dumps(items, indent=2, ensure_ascii=False) + "\\n",
        encoding="utf-8",
    )


def validate_payload(payload: dict[str, Any], schema: dict[str, Any] | None = None) -> dict[str, Any]:
    active_schema = schema if schema is not None else load_schema()
    if not isinstance(payload, dict):
        raise ValueError("Input payload must be a JSON object")

    props = active_schema.get("properties", {}) if isinstance(active_schema, dict) else {}
    required = active_schema.get("required", []) if isinstance(active_schema, dict) else []
    additional_ok = active_schema.get("additionalProperties", True) if isinstance(active_schema, dict) else True

    cleaned: dict[str, Any] = {}
    for key, val in payload.items():
        if val is None or (isinstance(val, str) and val.strip() == "" and key not in required):
            continue
        cleaned[key] = val.strip() if isinstance(val, str) else val

    for key, prop_spec in props.items():
        if key not in cleaned and isinstance(prop_spec, dict) and "default" in prop_spec:
            cleaned[key] = prop_spec["default"]

    for req_key in required:
        val = cleaned.get(req_key)
        if val is None or (isinstance(val, str) and not val.strip()):
            raise ValueError(f"Missing required field: '{req_key}'")

    if additional_ok is False and props:
        unknown = [k for k in cleaned if k not in props]
        if unknown:
            raise ValueError(f"Unrecognized input field(s): {', '.join(unknown)}")

    for key, val in list(cleaned.items()):
        prop_spec = props.get(key)
        if not isinstance(prop_spec, dict):
            continue
        enum_vals = prop_spec.get("enum")
        if isinstance(enum_vals, list) and val not in enum_vals:
            raise ValueError(f"Invalid value for '{key}': expected one of {enum_vals}")

    return cleaned


def record_entry(raw_payload: dict[str, Any], today: str | None = None) -> dict[str, Any]:
    validated = validate_payload(raw_payload)
    entry: dict[str, Any] = {
        "date": str(validated.get("date") or today or dt.date.today().isoformat()),
        "item": str(validated["item"]).strip(),
        "category": str(validated.get("category") or "general"),
        "status": str(validated.get("status") or "active"),
    }
    if "value" in validated and validated["value"] not in (None, ""):
        entry["value"] = validated["value"]
    if "notes" in validated and validated["notes"]:
        entry["notes"] = str(validated["notes"])
    for extra_key, extra_val in validated.items():
        if extra_key not in entry:
            entry[extra_key] = extra_val

    items = load_items()
    items.append(entry)
    save_items(items)
    return entry


def parse_cli_payload(data_arg: str = "", input_arg: str = "") -> dict[str, Any]:
    raw_json = data_arg.strip() or os.environ.get("OPENLIA_MINION_INPUT_JSON", "").strip()
    if raw_json:
        parsed = json.loads(raw_json)
        if not isinstance(parsed, dict):
            raise ValueError("Expected JSON object for --data")
        return parsed
    text = input_arg.strip() or os.environ.get("OPENLIA_MINION_INPUT", "").strip()
    if text:
        if text.startswith("{") and text.endswith("}"):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
        return {"item": text}
    raise ValueError("No input payload provided (pass --data '<json>' or --input '<text>')")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate and record a new Minion entry")
    parser.add_argument("--data", default="", help="JSON object conforming to input.schema.json")
    parser.add_argument("--input", default="", help="Quick text entry mapped to item")
    args, _ = parser.parse_known_args()

    payload = parse_cli_payload(args.data, args.input)
    entry = record_entry(payload)
    items = load_items()
    print(f"Added entry ({len(items)} total): {entry.get('item', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
      writeFileSync(join(dir, "input.py"), inputPy, "utf-8");

      const mainPy = `#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
from typing import Any

import input as minion_input

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "items.json"
CONTEXT_FILE = ROOT / "data" / "context.json"
CONFIG_FILE = ROOT / "config.json"
CONFIG_SCHEMA_FILE = ROOT / "config.schema.json"
DASHBOARD_FILE = ROOT / "dashboard.openui"
LEGACY_UI_FILE = ROOT / "ui.openui"
TITLE = ${JSON.stringify(name)}


def load_config() -> dict[str, Any]:
    raw_env = os.environ.get("OPENLIA_MINION_CONFIG_JSON", "").strip()
    if raw_env:
        try:
            parsed = json.loads(raw_env)
            if isinstance(parsed, dict) and "trigger" in parsed:
                return parsed
        except Exception:
            pass
    if not CONFIG_FILE.exists():
        return {"trigger": {"on_new_entry": True, "cron": ${JSON.stringify(heartbeatSchedule)}}}
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    if not isinstance(cfg, dict) or "trigger" not in cfg:
        raise ValueError("config.json must be a JSON object containing 'trigger'")
    return cfg


def load_items() -> list[dict[str, Any]]:
    return minion_input.load_items()


def save_items(items: list[dict[str, Any]]) -> None:
    minion_input.save_items(items)


def load_context() -> dict[str, Any]:
    if not CONTEXT_FILE.exists():
        return {}
    try:
        return json.loads(CONTEXT_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_context(context: dict[str, Any]) -> None:
    CONTEXT_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONTEXT_FILE.write_text(
        json.dumps(context, indent=2, ensure_ascii=False) + "\\n",
        encoding="utf-8",
    )


def build_recommendation(entry: dict[str, Any], items: list[dict[str, Any]]) -> str:
    today = str(entry.get("date") or dt.date.today().isoformat())
    today_items = [row for row in items if str(row.get("date")) == today]
    category = str(entry.get("category") or "general")
    value = entry.get("value")
    if value not in (None, ""):
        return (
            f"Recorded {entry.get('item')} (metric: {value}) in '{category}'. "
            f"{len(today_items)} entry(s) logged on {today}—consider progressive overload or a complementary recovery/follow-up session next."
        )
    return (
        f"Logged '{entry.get('item')}' under '{category}' ({len(today_items)} today, {len(items)} total). "
        f"Next step: review progress or schedule your next '{category}' follow-up."
    )


def render_dashboard(
    items: list[dict[str, Any]],
    context: dict[str, Any] | None = None,
) -> str:
    ctx = context if context is not None else load_context()
    active_count = sum(1 for row in items if row.get("status", "active") == "active")
    summary = str(ctx.get("summary") or f"{len(items)} total entries ({active_count} active).")
    latest_rec = str(
        ctx.get("latest_recommendation")
        or (items[-1].get("recommendation") if items else "")
        or "Log an entry or run heartbeat to update recommendations."
    )
    callout_desc = f"{summary} Next recommendation: {latest_rec}"
    cols = '[{key: "date", label: "Date"}, {key: "item", label: "Item"}, {key: "category", label: "Category"}, {key: "status", label: "Status"}, {key: "recommendation", label: "Recommendation"}]'
    rows = json.dumps(items, ensure_ascii=False)
    content = (
        "Stack(children: [\\n"
        f'  Callout(variant: "info", title: "Context & Recommendations", description: {json.dumps(callout_desc)}),\\n'
        f"  Table(title: {json.dumps(TITLE)}, columns: {cols}, rows: {rows})\\n"
        "])\\n"
    )
    DASHBOARD_FILE.write_text(content, encoding="utf-8")
    if LEGACY_UI_FILE.exists():
        LEGACY_UI_FILE.write_text(content, encoding="utf-8")
    return content


def render_ui(items: list[dict[str, Any]]) -> str:
    return render_dashboard(items)


def analyze_new_entry(
    entry: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    active_config = config if isinstance(config, dict) else load_config()
    items = load_items()
    target = entry if isinstance(entry, dict) and entry else (items[-1] if items else {})
    recommendation = build_recommendation(target, items)
    if items:
        items[-1]["recommendation"] = recommendation
        save_items(items)

    active_count = sum(1 for row in items if row.get("status", "active") == "active")
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    ctx = load_context()
    ctx.update({
        "last_trigger": "entry",
        "updated_at": now_iso,
        "trigger_config": active_config.get("trigger"),
        "summary": f"{len(items)} total entries ({active_count} active).",
        "latest_entry": target,
        "latest_recommendation": recommendation,
    })
    save_context(ctx)
    render_dashboard(items, ctx)
    return ctx


def run_heartbeat(config: dict[str, Any] | None = None) -> dict[str, Any]:
    active_config = config if isinstance(config, dict) else load_config()
    items = load_items()
    active_count = sum(1 for row in items if row.get("status", "active") == "active")
    completed_count = sum(1 for row in items if row.get("status") == "completed")
    categories = sorted({str(row.get("category") or "general") for row in items})
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()

    ctx = load_context()
    latest_rec = str(
        ctx.get("latest_recommendation")
        or (items[-1].get("recommendation") if items else "")
        or "All caught up. Add a new entry to trigger post-entry analysis."
    )
    ctx.update({
        "last_trigger": "heartbeat",
        "updated_at": now_iso,
        "trigger_config": active_config.get("trigger"),
        "summary": f"{len(items)} total entries ({active_count} active, {completed_count} completed).",
        "latest_recommendation": latest_rec,
        "enrichment": {
            "status": "enriched",
            "last_heartbeat_at": now_iso,
            "categories": categories,
            "total_entries": len(items),
            "active_entries": active_count,
        },
    })
    save_context(ctx)
    render_dashboard(items, ctx)
    return ctx


def add_entry(text: str, today: str | None = None) -> list[dict[str, Any]]:
    entry = minion_input.record_entry({"item": text.strip()}, today=today)
    analyze_new_entry(entry)
    return load_items()


def main() -> int:
    parser = argparse.ArgumentParser(description=TITLE)
    parser.add_argument("--trigger", choices=["heartbeat", "entry"], default="")
    parser.add_argument("--entry", default="", help="JSON payload of the newly recorded entry")
    parser.add_argument("--action", default="")
    parser.add_argument("--input", default="")
    args, _ = parser.parse_known_args()

    direct_input = args.input.strip()
    trigger = (
        args.trigger.strip()
        or os.environ.get("OPENLIA_MINION_TRIGGER", "").strip()
        or ("heartbeat" if args.action.strip() == "heartbeat" else "")
    )

    if direct_input and trigger != "entry":
        items = add_entry(direct_input)
        print(f"Added entry ({len(items)} total): {direct_input}")
        return 0

    if trigger == "entry":
        raw_entry = args.entry.strip() or os.environ.get("OPENLIA_MINION_ENTRY_JSON", "").strip()
        parsed_entry: dict[str, Any] | None = None
        if raw_entry:
            try:
                candidate = json.loads(raw_entry)
                if isinstance(candidate, dict):
                    parsed_entry = candidate
            except Exception:
                parsed_entry = None
        ctx = analyze_new_entry(parsed_entry)
        items = load_items()
        print(f"Post-entry analysis complete ({len(items)} total): {ctx.get('latest_recommendation', '')}")
        return 0

    ctx = run_heartbeat()
    items = load_items()
    print(f"Heartbeat enrichment complete ({len(items)} entries): {ctx.get('summary', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
      writeFileSync(join(dir, "main.py"), mainPy, "utf-8");

      const testPy = `import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

import input as minion_input
import main

ROOT = Path(__file__).resolve().parent.parent


def _validate_openui_file(path: Path) -> list[str]:
    cli_candidates = [
        os.environ.get("OPENLIA_OPENUI_AUTHORING_CLI", "").strip(),
        "/usr/local/lib/openlia/openui-authoring.js",
    ]
    bun_bin = shutil.which("bun")
    cli_path = next((Path(p) for p in cli_candidates if p and Path(p).is_file()), None)
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        return ["Empty OpenUI file"]
    if cli_path and bun_bin:
        proc = subprocess.run(
            [bun_bin, str(cli_path)],
            input=json.dumps({"action": "validate", "content": raw, "format": "openui"}),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            res = json.loads(proc.stdout)
            if res.get("status") == "ok" and res.get("valid") is False:
                return [
                    f"{d.get('code', 'error')}: {d.get('message', '')}"
                    for b in res.get("blocks", [])
                    for d in b.get("diagnostics", [])
                ]
    return []


class MinionTests(unittest.TestCase):
    def test_load_and_render_dashboard(self):
        items = main.load_items()
        self.assertIsInstance(items, list)
        ui = main.render_dashboard(items)
        self.assertIn("Table(", ui)
        self.assertIn("Callout(", ui)

    def test_openui_views_pass_schema_validation(self):
        main.run_heartbeat()
        for ui_name in ("dashboard.openui", "input.openui"):
            ui_path = ROOT / ui_name
            if ui_path.is_file():
                errors = _validate_openui_file(ui_path)
                self.assertEqual(errors, [], f"{ui_name} has OpenUI schema errors: {errors}")

    def test_schema_validation(self):
        schema = minion_input.load_schema()
        self.assertEqual(schema.get("type"), "object")
        validated = minion_input.validate_payload({"item": "Test workout"}, schema)
        self.assertEqual(validated["item"], "Test workout")
        with self.assertRaises(ValueError):
            minion_input.validate_payload({}, schema)

    def test_config_contract(self):
        cfg = main.load_config()
        self.assertIsInstance(cfg, dict)
        self.assertIn("trigger", cfg)


if __name__ == "__main__":
    unittest.main()
`;
      writeFileSync(join(dir, "tests", "test_main.py"), testPy, "utf-8");
    } else {
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify(
          {
            name: `minion-${id}`,
            version: "0.1.0",
            private: true,
            type: "module",
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const inputTs = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MinionItem {
  date: string;
  item: string;
  category?: string;
  value?: number | string;
  status: string;
  notes?: string;
  recommendation?: string;
  [key: string]: unknown;
}

const ROOT = import.meta.dir;
export const DATA_FILE = join(ROOT, "data", "items.json");
export const SCHEMA_FILE = join(ROOT, "input.schema.json");

export function loadSchema(): Record<string, unknown> {
  if (!existsSync(SCHEMA_FILE)) return {};
  return JSON.parse(readFileSync(SCHEMA_FILE, "utf-8")) as Record<string, unknown>;
}

export function loadItems(): MinionItem[] {
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8")) as MinionItem[];
}

export function saveItems(items: MinionItem[]): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(items, null, 2) + "\\n", "utf-8");
}

export function validatePayload(
  payload: Record<string, unknown>,
  schema: Record<string, unknown> = loadSchema(),
): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Input payload must be a JSON object");
  }
  const props =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  const additionalOk = schema.additionalProperties !== false;

  const cleaned: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (
      val === undefined ||
      val === null ||
      (typeof val === "string" && val.trim() === "" && !required.includes(key))
    ) {
      continue;
    }
    cleaned[key] = typeof val === "string" ? val.trim() : val;
  }

  for (const [key, propSpec] of Object.entries(props)) {
    if (!(key in cleaned) && propSpec && "default" in propSpec) {
      cleaned[key] = propSpec.default;
    }
  }

  for (const reqKey of required) {
    const val = cleaned[reqKey];
    if (val === undefined || val === null || (typeof val === "string" && !val.trim())) {
      throw new Error(\`Missing required field: '\${reqKey}'\`);
    }
  }

  if (!additionalOk && Object.keys(props).length > 0) {
    const unknown = Object.keys(cleaned).filter((k) => !(k in props));
    if (unknown.length > 0) {
      throw new Error(\`Unrecognized input field(s): \${unknown.join(", ")}\`);
    }
  }

  for (const [key, val] of Object.entries(cleaned)) {
    const propSpec = props[key];
    if (propSpec && Array.isArray(propSpec.enum) && !propSpec.enum.includes(val)) {
      throw new Error(\`Invalid value for '\${key}': expected one of \${propSpec.enum.join(", ")}\`);
    }
  }

  return cleaned;
}

export function recordEntry(
  rawPayload: Record<string, unknown>,
  today?: string,
): MinionItem {
  const validated = validatePayload(rawPayload);
  const entry: MinionItem = {
    date: String(validated.date || today || new Date().toISOString().slice(0, 10)),
    item: String(validated.item).trim(),
    category: String(validated.category || "general"),
    status: String(validated.status || "active"),
  };
  if (validated.value !== undefined && validated.value !== "") {
    entry.value = validated.value as number | string;
  }
  if (validated.notes) {
    entry.notes = String(validated.notes);
  }
  for (const [k, v] of Object.entries(validated)) {
    if (!(k in entry)) entry[k] = v;
  }
  const items = loadItems();
  items.push(entry);
  saveItems(items);
  return entry;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dataIdx = args.indexOf("--data");
  const inputIdx = args.indexOf("--input");
  const rawData =
    (dataIdx >= 0 ? args[dataIdx + 1] : process.env.OPENLIA_MINION_INPUT_JSON) ?? "";
  const rawInput =
    (inputIdx >= 0 ? args[inputIdx + 1] : process.env.OPENLIA_MINION_INPUT) ?? "";

  let payload: Record<string, unknown>;
  if (rawData.trim()) {
    payload = JSON.parse(rawData) as Record<string, unknown>;
  } else if (rawInput.trim()) {
    payload = { item: rawInput.trim() };
  } else {
    throw new Error("No input payload provided (pass --data '<json>' or --input '<text>')");
  }

  const entry = recordEntry(payload);
  const items = loadItems();
  console.log(\`Added entry (\${items.length} total): \${entry.item}\`);
}
`;
      writeFileSync(join(dir, "input.ts"), inputTs, "utf-8");

      const mainTs = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  loadItems as loadInputItems,
  type MinionItem,
  recordEntry,
  saveItems as saveInputItems,
} from "./input";

export type { MinionItem };

const ROOT = import.meta.dir;
const CONTEXT_FILE = join(ROOT, "data", "context.json");
const CONFIG_FILE = join(ROOT, "config.json");
const DASHBOARD_FILE = join(ROOT, "dashboard.openui");
const LEGACY_UI_FILE = join(ROOT, "ui.openui");
const TITLE = ${JSON.stringify(name)};

export function loadConfig(): Record<string, unknown> {
  const rawEnv = (process.env.OPENLIA_MINION_CONFIG_JSON ?? "").trim();
  if (rawEnv) {
    try {
      const parsed = JSON.parse(rawEnv) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "trigger" in parsed) {
        return parsed;
      }
    } catch {}
  }
  if (!existsSync(CONFIG_FILE)) {
    return { trigger: { on_new_entry: true, cron: ${JSON.stringify(heartbeatSchedule)} } };
  }
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || !("trigger" in cfg)) {
    throw new Error("config.json must be a JSON object containing 'trigger'");
  }
  return cfg;
}

export function loadItems(): MinionItem[] {
  return loadInputItems();
}

export function saveItems(items: MinionItem[]): void {
  saveInputItems(items);
}

export function loadContext(): Record<string, unknown> {
  if (!existsSync(CONTEXT_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONTEXT_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function saveContext(ctx: Record<string, unknown>): void {
  mkdirSync(dirname(CONTEXT_FILE), { recursive: true });
  writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2) + "\\n", "utf-8");
}

export function buildRecommendation(entry: Partial<MinionItem>, items: MinionItem[]): string {
  const today = String(entry.date || new Date().toISOString().slice(0, 10));
  const todayItems = items.filter((r) => r.date === today);
  const category = String(entry.category || "general");
  if (entry.value !== undefined && entry.value !== "") {
    return \`Recorded \${entry.item} (metric: \${entry.value}) in '\${category}'. \${todayItems.length} entry(s) logged on \${today}—consider progressive overload or a complementary follow-up next.\`;
  }
  return \`Logged '\${entry.item}' under '\${category}' (\${todayItems.length} today, \${items.length} total). Next step: review progress or schedule your next '\${category}' follow-up.\`;
}

export function renderDashboard(
  items: MinionItem[],
  context: Record<string, unknown> = loadContext(),
): string {
  const activeCount = items.filter((r) => (r.status || "active") === "active").length;
  const summary = String(
    context.summary || \`\${items.length} total entries (\${activeCount} active).\`,
  );
  const latestRec = String(
    context.latest_recommendation ||
      items.at(-1)?.recommendation ||
      "Log an entry or run heartbeat to update recommendations.",
  );
  const calloutDesc = \`\${summary} Next recommendation: \${latestRec}\`;
  const cols =
    '[{key: "date", label: "Date"}, {key: "item", label: "Item"}, {key: "category", label: "Category"}, {key: "status", label: "Status"}, {key: "recommendation", label: "Recommendation"}]';
  const content = [
    "Stack(children: [",
    \`  Callout(variant: "info", title: "Context & Recommendations", description: \${JSON.stringify(calloutDesc)}),\`,
    \`  Table(title: \${JSON.stringify(TITLE)}, columns: \${cols}, rows: \${JSON.stringify(items)})\`,
    "])",
    "",
  ].join("\\n");
  writeFileSync(DASHBOARD_FILE, content, "utf-8");
  if (existsSync(LEGACY_UI_FILE)) {
    writeFileSync(LEGACY_UI_FILE, content, "utf-8");
  }
  return content;
}

export function renderUi(items: MinionItem[]): string {
  return renderDashboard(items);
}

export function analyzeNewEntry(
  entry?: Partial<MinionItem>,
  config: Record<string, unknown> = loadConfig(),
): Record<string, unknown> {
  const items = loadItems();
  const target = entry && Object.keys(entry).length > 0 ? entry : (items.at(-1) ?? {});
  const recommendation = buildRecommendation(target, items);
  if (items.length > 0) {
    items[items.length - 1]!.recommendation = recommendation;
    saveItems(items);
  }
  const activeCount = items.filter((r) => (r.status || "active") === "active").length;
  const nowIso = new Date().toISOString();
  const ctx: Record<string, unknown> = {
    ...loadContext(),
    last_trigger: "entry",
    updated_at: nowIso,
    trigger_config: config.trigger,
    summary: \`\${items.length} total entries (\${activeCount} active).\`,
    latest_entry: target,
    latest_recommendation: recommendation,
  };
  saveContext(ctx);
  renderDashboard(items, ctx);
  return ctx;
}

export function runHeartbeat(
  config: Record<string, unknown> = loadConfig(),
): Record<string, unknown> {
  const items = loadItems();
  const activeCount = items.filter((r) => (r.status || "active") === "active").length;
  const completedCount = items.filter((r) => r.status === "completed").length;
  const categories = Array.from(
    new Set(items.map((r) => String(r.category || "general"))),
  ).sort();
  const nowIso = new Date().toISOString();
  const prev = loadContext();
  const latestRec = String(
    prev.latest_recommendation ||
      items.at(-1)?.recommendation ||
      "All caught up. Add a new entry to trigger post-entry analysis.",
  );
  const ctx: Record<string, unknown> = {
    ...prev,
    last_trigger: "heartbeat",
    updated_at: nowIso,
    trigger_config: config.trigger,
    summary: \`\${items.length} total entries (\${activeCount} active, \${completedCount} completed).\`,
    latest_recommendation: latestRec,
    enrichment: {
      status: "enriched",
      last_heartbeat_at: nowIso,
      categories,
      total_entries: items.length,
      active_entries: activeCount,
    },
  };
  saveContext(ctx);
  renderDashboard(items, ctx);
  return ctx;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const triggerIdx = args.indexOf("--trigger");
  const entryIdx = args.indexOf("--entry");
  const inputIdx = args.indexOf("--input");
  const trigger =
    (triggerIdx >= 0 ? args[triggerIdx + 1] : process.env.OPENLIA_MINION_TRIGGER) ?? "";
  const rawEntry =
    (entryIdx >= 0 ? args[entryIdx + 1] : process.env.OPENLIA_MINION_ENTRY_JSON) ?? "";
  const directInput =
    (inputIdx >= 0 ? args[inputIdx + 1] : "") ?? "";

  if (directInput.trim() && trigger !== "entry") {
    const entry = recordEntry({ item: directInput.trim() });
    analyzeNewEntry(entry);
    const items = loadItems();
    console.log(\`Added entry (\${items.length} total): \${directInput.trim()}\`);
  } else if (trigger === "entry") {
    let parsedEntry: Partial<MinionItem> | undefined;
    if (rawEntry.trim()) {
      try {
        parsedEntry = JSON.parse(rawEntry) as Partial<MinionItem>;
      } catch {}
    }
    const ctx = analyzeNewEntry(parsedEntry);
    const items = loadItems();
    console.log(\`Post-entry analysis complete (\${items.length} total): \${String(ctx.latest_recommendation ?? "")}\`);
  } else {
    const ctx = runHeartbeat();
    const items = loadItems();
    console.log(\`Heartbeat enrichment complete (\${items.length} entries): \${String(ctx.summary ?? "")}\`);
  }
}
`;
      writeFileSync(join(dir, "main.ts"), mainTs, "utf-8");

      const testTs = `import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSchema, validatePayload } from "../input";
import { loadConfig, loadItems, renderDashboard, runHeartbeat } from "../main";

const ROOT = join(import.meta.dir, "..");

function validateOpenUIFile(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf-8");
  if (!raw.trim()) return ["Empty OpenUI file"];
  const candidates = [
    process.env.OPENLIA_OPENUI_AUTHORING_CLI ?? "",
    "/usr/local/lib/openlia/openui-authoring.js",
  ].filter(Boolean);
  const cliPath = candidates.find((p) => existsSync(p));
  if (!cliPath) return [];
  const proc = Bun.spawnSync(["bun", cliPath], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ action: "validate", content: raw, format: "openui" }),
    ),
  });
  if (proc.exitCode === 0) {
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (out) {
      const parsed = JSON.parse(out) as Record<string, any>;
      if (parsed.status === "ok" && parsed.valid === false) {
        return (parsed.blocks ?? []).flatMap((b: any) =>
          (b.diagnostics ?? []).map((d: any) => \`\${d.code}: \${d.message}\`),
        );
      }
    }
  }
  return [];
}

test("loads items and renders OpenUI dashboard", () => {
  const items = loadItems();
  expect(Array.isArray(items)).toBe(true);
  const ui = renderDashboard(items);
  expect(ui).toContain("Table(");
  expect(ui).toContain("Callout(");
});

test("dashboard.openui and input.openui pass OpenUI schema validation", () => {
  runHeartbeat();
  for (const name of ["dashboard.openui", "input.openui"]) {
    const p = join(ROOT, name);
    if (existsSync(p)) {
      expect(validateOpenUIFile(p)).toEqual([]);
    }
  }
});

test("validates input against input.schema.json", () => {
  const schema = loadSchema();
  expect(schema.type).toBe("object");
  const valid = validatePayload({ item: "Morning run" }, schema);
  expect(valid.item).toBe("Morning run");
  expect(() => validatePayload({}, schema)).toThrow();
});

test("loads config.json with required trigger", () => {
  const cfg = loadConfig();
  expect(typeof cfg).toBe("object");
  expect("trigger" in cfg).toBe(true);
});
`;
      writeFileSync(join(dir, "tests", "main.test.ts"), testTs, "utf-8");
    }

    return this.getMinion(id);
  }

  updateMinionConfig(id: string, rawBody: unknown): MinionDetailResponse {
    const dir = this.resolveMinionDir(id);
    const { minion: before } = this.getMinion(id);

    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new WorkspaceError(
        "config payload must be a JSON object",
        400,
        "invalid_minion_config",
      );
    }

    const bodyRecord = rawBody as Record<string, unknown>;
    const candidateConfig =
      "config" in bodyRecord &&
      !("trigger" in bodyRecord) &&
      bodyRecord.config &&
      typeof bodyRecord.config === "object" &&
      !Array.isArray(bodyRecord.config)
        ? (bodyRecord.config as Record<string, unknown>)
        : bodyRecord;

    const validation = validateMinionConfigObject(
      candidateConfig,
      before.config_schema,
      before.triggers?.heartbeat_schedule ?? DEFAULT_HEARTBEAT_SCHEDULE,
    );
    if (!validation.valid) {
      throw new WorkspaceError(
        `Config validation failed against ${before.config_schema_file ?? "config.schema.json"}: ${validation.errors.join("; ")}`,
        400,
        "invalid_minion_config",
      );
    }

    writeFileSync(
      join(dir, "config.json"),
      `${JSON.stringify(candidateConfig, null, 2)}\n`,
      "utf-8",
    );

    return this.getMinion(id);
  }

  private resolvePythonBin(dirAbs: string): string {
    const localVenvPy = join(dirAbs, ".venv", "bin", "python");
    if (existsSync(localVenvPy)) return localVenvPy;
    const hermesPy = "/opt/hermes/.venv/bin/python";
    if (existsSync(hermesPy)) return hermesPy;
    return "python3";
  }

  private execSubprocess(
    cmd: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }> {
    const start = Date.now();
    return new Promise((resolvePromise) => {
      execFile(
        cmd,
        args,
        {
          cwd,
          env: {
            ...process.env,
            ...extraEnv,
          },
          timeout: this.timeoutMs,
          maxBuffer: 256 * 1024,
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - start;
          if (!err) {
            resolvePromise({
              exitCode: 0,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              durationMs,
            });
            return;
          }
          const anyErr = err as {
            code?: number | string;
            killed?: boolean;
            message?: string;
          };
          const exitCode = anyErr.killed
            ? 124
            : typeof anyErr.code === "number"
              ? anyErr.code
              : 1;
          const stderrStr = String(stderr ?? "");
          resolvePromise({
            exitCode,
            stdout: String(stdout ?? ""),
            stderr:
              stderrStr ||
              (typeof anyErr.message === "string"
                ? anyErr.message
                : "execution_failed"),
            durationMs,
          });
        },
      );
    });
  }

  private normalizeAndValidateInputData(
    minion: MinionDetail,
    rawPayload: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema = minion.input_schema;
    if (!schema) {
      return { ...rawPayload };
    }

    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((k): k is string => typeof k === "string")
        : [],
    );

    const normalized: Record<string, unknown> = {};
    for (const [key, rawVal] of Object.entries(rawPayload)) {
      if (rawVal === undefined || rawVal === null) {
        continue;
      }
      if (
        typeof rawVal === "string" &&
        rawVal.trim() === "" &&
        !required.has(key)
      ) {
        continue;
      }

      const propSpec = properties[key];
      const propType = propSpec?.type;
      const typeList = Array.isArray(propType)
        ? propType
        : typeof propType === "string"
          ? [propType]
          : [];

      if (typeof rawVal === "string") {
        const trimmed = rawVal.trim();
        if (
          (typeList.includes("number") || typeList.includes("integer")) &&
          trimmed !== "" &&
          !Number.isNaN(Number(trimmed))
        ) {
          const num = Number(trimmed);
          if (!typeList.includes("integer") || Number.isInteger(num)) {
            normalized[key] = num;
            continue;
          }
        }
        if (
          typeList.includes("boolean") &&
          !typeList.includes("string") &&
          (trimmed === "true" || trimmed === "false")
        ) {
          normalized[key] = trimmed === "true";
          continue;
        }
        normalized[key] = trimmed;
      } else {
        normalized[key] = rawVal;
      }
    }

    for (const [key, propSpec] of Object.entries(properties)) {
      if (!(key in normalized) && propSpec && "default" in propSpec) {
        normalized[key] = propSpec.default;
      }
    }

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    if (!validate(normalized)) {
      const messages = (validate.errors ?? []).map((err) => {
        const path = err.instancePath ? `input${err.instancePath}` : "input";
        if (
          err.keyword === "required" &&
          err.params &&
          "missingProperty" in err.params
        ) {
          return `${path}: missing required property '${String(err.params.missingProperty)}'`;
        }
        if (
          err.keyword === "additionalProperties" &&
          err.params &&
          "additionalProperty" in err.params
        ) {
          return `${path}: unrecognized property '${String(err.params.additionalProperty)}'`;
        }
        return `${path}: ${err.message ?? "validation error"}`;
      });
      throw new WorkspaceError(
        `Input validation failed against ${minion.input_schema_file ?? "input.schema.json"}: ${messages.join("; ")}`,
        400,
        "invalid_minion_input",
      );
    }

    return normalized;
  }

  private buildInputPayloadFromRequest(
    minion: MinionDetail,
    req: {
      data?: Record<string, unknown> | undefined;
      input?: string | undefined;
    },
  ): Record<string, unknown> {
    if (req.data && typeof req.data === "object" && !Array.isArray(req.data)) {
      return { ...req.data };
    }
    if (typeof req.input === "string" && req.input.trim()) {
      const trimmed = req.input.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {}
      }
      const schemaProps =
        minion.input_schema?.properties &&
        typeof minion.input_schema.properties === "object"
          ? (minion.input_schema.properties as Record<string, unknown>)
          : {};
      const requiredFields = Array.isArray(minion.input_schema?.required)
        ? (minion.input_schema.required as string[])
        : [];
      if (
        !("item" in schemaProps) &&
        requiredFields.length === 1 &&
        typeof requiredFields[0] === "string"
      ) {
        return { [requiredFields[0]]: trimmed };
      }
      return { item: trimmed };
    }
    return {};
  }

  async installMinionDependencies(id: string): Promise<MinionRunResponse> {
    const dir = this.resolveMinionDir(id);
    const { minion: before } = this.getMinion(id);

    let result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    };

    if (before.runtime === "python") {
      const reqFile = join(dir, "requirements.txt");
      if (!existsSync(reqFile)) {
        result = {
          exitCode: 0,
          stdout: "No requirements.txt found; nothing to install.",
          stderr: "",
          durationMs: 0,
        };
      } else {
        const lines = readFileSync(reqFile, "utf-8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("#"));
        if (lines.length === 0) {
          result = {
            exitCode: 0,
            stdout: "requirements.txt has no active package specifiers.",
            stderr: "",
            durationMs: 0,
          };
        } else {
          const venvDir = join(dir, ".venv");
          if (!existsSync(join(venvDir, "bin", "pip"))) {
            await this.execSubprocess("python3", ["-m", "venv", ".venv"], dir);
          }
          const pipBin = existsSync(join(venvDir, "bin", "pip"))
            ? join(venvDir, "bin", "pip")
            : "pip3";
          result = await this.execSubprocess(
            pipBin,
            ["install", "-r", "requirements.txt"],
            dir,
          );
        }
      }
    } else {
      const pkgFile = join(dir, "package.json");
      if (!existsSync(pkgFile)) {
        result = {
          exitCode: 0,
          stdout: "No package.json found; nothing to install.",
          stderr: "",
          durationMs: 0,
        };
      } else {
        result = await this.execSubprocess("bun", ["install"], dir);
      }
    }

    const { minion } = this.getMinion(id);
    return {
      schema: 1,
      ok: result.exitCode === 0,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
      minion,
    };
  }

  async submitMinionInput(
    id: string,
    req: MinionRunRequest = {},
  ): Promise<MinionRunResponse> {
    const dir = this.resolveMinionDir(id);
    const { minion: before } = this.getMinion(id);

    const rawPayload = this.buildInputPayloadFromRequest(before, req);
    const validatedPayload = this.normalizeAndValidateInputData(
      before,
      rawPayload,
    );
    const serializedPayload = JSON.stringify(validatedPayload);
    const textInput =
      typeof validatedPayload.item === "string"
        ? validatedPayload.item
        : typeof req.input === "string"
          ? req.input.trim()
          : "";

    const serializedConfig = before.config ? JSON.stringify(before.config) : "";

    const cmd =
      before.runtime === "python" ? this.resolvePythonBin(dir) : "bun";

    if (!before.input_entrypoint) {
      // Legacy Minion fallback: pass --input directly to main.py / main.ts
      const legacyArgs: string[] = [];
      if (typeof req.action === "string" && req.action.trim()) {
        legacyArgs.push("--action", req.action.trim());
      }
      if (textInput) {
        legacyArgs.push("--input", textInput);
      }
      const res = await this.execSubprocess(
        cmd,
        [before.entrypoint, ...legacyArgs],
        dir,
        {
          OPENLIA_WORKSPACE_ROOT: this.workspaceRoot,
          OPENLIA_MINION_ID: before.id,
          OPENLIA_MINION_TRIGGER: "entry",
          OPENLIA_MINION_INPUT: textInput,
          OPENLIA_MINION_INPUT_JSON: serializedPayload,
          ...(serializedConfig
            ? { OPENLIA_MINION_CONFIG_JSON: serializedConfig }
            : {}),
        },
      );
      const { minion } = this.getMinion(id);
      return this.finalizeRunWithValidation(
        minion,
        res.exitCode,
        res.stdout,
        res.stderr,
        res.durationMs,
        [
          {
            step: "input",
            script: before.entrypoint,
            exit_code: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            duration_ms: res.durationMs,
          },
        ],
      );
    }

    const inputCmd = before.input_entrypoint.endsWith(".py")
      ? this.resolvePythonBin(dir)
      : "bun";
    const inputArgs = [
      before.input_entrypoint,
      "--data",
      serializedPayload,
    ];
    const inputRes = await this.execSubprocess(inputCmd, inputArgs, dir, {
      OPENLIA_WORKSPACE_ROOT: this.workspaceRoot,
      OPENLIA_MINION_ID: before.id,
      OPENLIA_MINION_TRIGGER: "input",
      OPENLIA_MINION_INPUT: textInput,
      OPENLIA_MINION_INPUT_JSON: serializedPayload,
      ...(serializedConfig
        ? { OPENLIA_MINION_CONFIG_JSON: serializedConfig }
        : {}),
    });

    const steps: MinionExecutionStep[] = [
      {
        step: "input",
        script: before.input_entrypoint,
        exit_code: inputRes.exitCode,
        stdout: inputRes.stdout,
        stderr: inputRes.stderr,
        duration_ms: inputRes.durationMs,
      },
    ];

    let finalExitCode = inputRes.exitCode;
    const stdoutParts = [inputRes.stdout.trim()].filter(Boolean);
    const stderrParts = [inputRes.stderr.trim()].filter(Boolean);
    let totalDurationMs = inputRes.durationMs;

    const shouldTriggerPostEntryMain =
      inputRes.exitCode === 0 &&
      !req.skip_post_entry_main &&
      (before.triggers?.after_entry ?? true);

    if (shouldTriggerPostEntryMain) {
      const mainRes = await this.execSubprocess(
        cmd,
        [before.entrypoint, "--trigger", "entry", "--entry", serializedPayload],
        dir,
        {
          OPENLIA_WORKSPACE_ROOT: this.workspaceRoot,
          OPENLIA_MINION_ID: before.id,
          OPENLIA_MINION_TRIGGER: "entry",
          OPENLIA_MINION_ENTRY_JSON: serializedPayload,
          OPENLIA_MINION_INPUT: textInput,
          OPENLIA_MINION_INPUT_JSON: serializedPayload,
          ...(serializedConfig
            ? { OPENLIA_MINION_CONFIG_JSON: serializedConfig }
            : {}),
        },
      );
      steps.push({
        step: "post_entry_main",
        script: before.entrypoint,
        exit_code: mainRes.exitCode,
        stdout: mainRes.stdout,
        stderr: mainRes.stderr,
        duration_ms: mainRes.durationMs,
      });
      if (mainRes.stdout.trim()) stdoutParts.push(mainRes.stdout.trim());
      if (mainRes.stderr.trim()) stderrParts.push(mainRes.stderr.trim());
      totalDurationMs += mainRes.durationMs;
      if (mainRes.exitCode !== 0) {
        finalExitCode = mainRes.exitCode;
      }
    }

    const { minion } = this.getMinion(id);
    return this.finalizeRunWithValidation(
      minion,
      finalExitCode,
      stdoutParts.length > 0 ? `${stdoutParts.join("\n")}\n` : "",
      stderrParts.length > 0 ? `${stderrParts.join("\n")}\n` : "",
      totalDurationMs,
      steps,
    );
  }

  async runMinionHeartbeat(
    id: string,
    req: MinionRunRequest = {},
  ): Promise<MinionRunResponse> {
    const dir = this.resolveMinionDir(id);
    const { minion: before } = this.getMinion(id);

    const cliArgs: string[] = [];
    if (before.input_entrypoint || req.trigger === "heartbeat") {
      cliArgs.push("--trigger", "heartbeat");
    }
    if (Array.isArray(req.args)) {
      for (const arg of req.args) {
        if (typeof arg === "string") cliArgs.push(arg);
      }
    }

    const serializedConfig = before.config ? JSON.stringify(before.config) : "";
    const cmd =
      before.runtime === "python" ? this.resolvePythonBin(dir) : "bun";
    const result = await this.execSubprocess(
      cmd,
      [before.entrypoint, ...cliArgs],
      dir,
      {
        OPENLIA_WORKSPACE_ROOT: this.workspaceRoot,
        OPENLIA_MINION_ID: before.id,
        OPENLIA_MINION_TRIGGER: "heartbeat",
        OPENLIA_MINION_ACTION: "heartbeat",
        ...(serializedConfig
          ? { OPENLIA_MINION_CONFIG_JSON: serializedConfig }
          : {}),
      },
    );

    const { minion } = this.getMinion(id);
    return this.finalizeRunWithValidation(
      minion,
      result.exitCode,
      result.stdout,
      result.stderr,
      result.durationMs,
      [
        {
          step: "heartbeat",
          script: before.entrypoint,
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
        },
      ],
    );
  }

  async runMinion(
    id: string,
    req: MinionRunRequest = {},
  ): Promise<MinionRunResponse> {
    const dir = this.resolveMinionDir(id);
    const { minion: before } = this.getMinion(id);

    if (req.trigger === "heartbeat" || req.action === "heartbeat") {
      return this.runMinionHeartbeat(id, req);
    }

    const hasInputData =
      (req.data &&
        typeof req.data === "object" &&
        !Array.isArray(req.data) &&
        Object.keys(req.data).length > 0) ||
      (typeof req.input === "string" && req.input.trim().length > 0);

    if (
      hasInputData &&
      req.trigger !== "entry" &&
      (before.input_entrypoint || before.input_schema)
    ) {
      return this.submitMinionInput(id, req);
    }

    const cliArgs: string[] = [];
    if (req.trigger === "entry") {
      cliArgs.push("--trigger", "entry");
      if (req.data && typeof req.data === "object") {
        cliArgs.push("--entry", JSON.stringify(req.data));
      }
    }
    if (typeof req.action === "string" && req.action.trim()) {
      cliArgs.push("--action", req.action.trim());
    }
    if (typeof req.input === "string" && req.input.trim()) {
      cliArgs.push("--input", req.input.trim());
    }
    if (Array.isArray(req.args)) {
      for (const arg of req.args) {
        if (typeof arg === "string") cliArgs.push(arg);
      }
    }

    const effectiveTrigger =
      req.trigger ?? (hasInputData ? "entry" : "heartbeat");
    const serializedConfig = before.config ? JSON.stringify(before.config) : "";
    const extraEnv: Record<string, string> = {
      OPENLIA_WORKSPACE_ROOT: this.workspaceRoot,
      OPENLIA_MINION_ID: before.id,
      OPENLIA_MINION_TRIGGER: effectiveTrigger,
      ...(typeof req.action === "string"
        ? { OPENLIA_MINION_ACTION: req.action }
        : {}),
      ...(typeof req.input === "string"
        ? { OPENLIA_MINION_INPUT: req.input }
        : {}),
      ...(req.data && typeof req.data === "object"
        ? { OPENLIA_MINION_ENTRY_JSON: JSON.stringify(req.data) }
        : {}),
      ...(serializedConfig
        ? { OPENLIA_MINION_CONFIG_JSON: serializedConfig }
        : {}),
    };

    const cmd =
      before.runtime === "python" ? this.resolvePythonBin(dir) : "bun";
    const result = await this.execSubprocess(
      cmd,
      [before.entrypoint, ...cliArgs],
      dir,
      extraEnv,
    );

    const { minion } = this.getMinion(id);
    return this.finalizeRunWithValidation(
      minion,
      result.exitCode,
      result.stdout,
      result.stderr,
      result.durationMs,
      [
        {
          step: effectiveTrigger === "entry" ? "post_entry_main" : "heartbeat",
          script: before.entrypoint,
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
        },
      ],
    );
  }

  private finalizeRunWithValidation(
    minion: MinionDetail,
    exitCode: number,
    stdout: string,
    stderr: string,
    durationMs: number,
    steps: MinionExecutionStep[] = [],
  ): MinionRunResponse {
    const finalSteps = [...steps];
    let finalExitCode = exitCode;
    let finalStderr = stderr;
    const renderErrors = minion.render_errors ?? [];
    if (renderErrors.length > 0) {
      const valErrorText = `OpenUI & Minion contract validation errors:\n${renderErrors.join("\n")}`;
      finalSteps.push({
        step: "heartbeat",
        script: "openui_validation",
        exit_code: 1,
        stdout: "",
        stderr: valErrorText,
        duration_ms: 0,
      });
      if (finalExitCode === 0) {
        finalExitCode = 1;
      }
      finalStderr = finalStderr.trim()
        ? `${finalStderr.trimEnd()}\n${valErrorText}\n`
        : `${valErrorText}\n`;
    }
    return {
      schema: 1,
      ok: finalExitCode === 0,
      exit_code: finalExitCode,
      stdout,
      stderr: finalStderr,
      duration_ms: durationMs,
      ...(finalSteps.length > 0 ? { steps: finalSteps } : {}),
      minion,
    };
  }

  async testMinion(id: string): Promise<MinionRunResponse> {
    const dir = this.resolveMinionDir(id);
    const { minion: before } = this.getMinion(id);

    const extraEnv: Record<string, string> = {
      OPENLIA_WORKSPACE_ROOT: this.workspaceRoot,
      OPENLIA_MINION_ID: before.id,
      PYTHONPATH: dir,
    };

    let result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    };

    if (before.runtime === "python") {
      const pyBin = this.resolvePythonBin(dir);
      const startDir = existsSync(join(dir, "tests")) ? "tests" : ".";
      result = await this.execSubprocess(
        pyBin,
        ["-m", "unittest", "discover", "-s", startDir, "-p", "test*.py"],
        dir,
        extraEnv,
      );
    } else {
      result = await this.execSubprocess("bun", ["test"], dir, extraEnv);
    }

    const { minion } = this.getMinion(id);
    return this.finalizeRunWithValidation(
      minion,
      result.exitCode,
      result.stdout,
      result.stderr,
      result.durationMs,
    );
  }
}
