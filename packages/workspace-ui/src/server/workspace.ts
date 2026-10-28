import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  WorkspaceActivityResponse,
  WorkspaceCommit,
  WorkspaceCommitChange,
  WorkspaceDeleteResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceDomainInfo,
  WorkspaceDomainRecordsResponse,
  WorkspaceDomainRecordSummary,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceFileValidation,
  WorkspaceGitStatus,
  WorkspaceMoveResponse,
  WorkspaceProjectResponse,
  WorkspaceProjectsResponse,
  WorkspaceRenameResponse,
  WorkspaceSettings,
  WorkspaceTreeResponse,
  WorkspaceUncommittedChange,
  WorkspaceWriteResponse,
} from "../shared/api";
import {
  DEFAULT_PROJECT_UI_ENTRY,
  PROJECT_MANIFEST_FILENAME,
  type ProjectManifest,
  type ProjectQueryDefinition,
  type ProjectSummary,
} from "../shared/project";
import {
  extractHeadings,
  findDomainTemplate,
  parseProjectManifest,
  parseRecordFrontmatter,
  validateEntireWorkspace,
  validateOpenUIContent,
  validateProjectManifest,
  validateRecordContent,
} from "./validator";
import YAML from "yaml";
import { MEMORY_DOCUMENT_PREFIX } from "../shared/memory";
import {
  BUILTIN_DOMAIN_CONTRACTS,
  getBuiltinDomainContract,
  mergeBuiltinSchemaProperties,
} from "../shared/domainContracts";
import {
  mutateRecordFrontmatter,
  parseMarkdownRecord,
  updateRecordSectionContent,
} from "../client/openui/recordMutator";
import { evaluateFileFindings, MaintainerService } from "./maintainer/engine";

export const DEFAULT_MAX_EDITABLE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_TREE_ENTRIES = 10_000;
export const WORKSPACE_SETTINGS_FILE = "workspace-ui.yaml";
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  enable_memory_editing: false,
  hide_configuration_files: true,
  hide_template_schema_files: true,
  schema: 1,
};

const editableExtensions = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".csv",
  ".journal",
  ".hledger",
  ".rem",
  ".remind",
  ".openui",
]);

const protectedDirectoryNames = new Set([
  "browser-profile",
  "cache",
  "logs",
  "mcp-tokens",
  "pairing",
  "sessions",
]);

const navigationHiddenBasenames = new Set([
  ".ds_store",
  ".gitkeep",
  "desktop.ini",
  "thumbs.db",
]);

const templatePaths = new Set([
  "areas/area-template.md",
  "calendar/event-note-template.md",
  "decisions/decision-template.md",
  "finance/finance-template.md",
  "goals/goal-template.md",
  "ideas/idea-template.md",
  "monitors/monitor-template.md",
  "people/person-template.md",
  "shopping/item-template.md",
  "tasks/task-template.md",
  "travel/trip-template.md",
]);

const configurationBasenames = new Set([
  "assistant-policy.schema.json",
  "assistant-policy.yaml",
  "feature.schema.json",
  "workspace.schema.json",
  "workspace.yaml",
  WORKSPACE_SETTINGS_FILE,
]);

export const creationDisallowedDomains = new Set([
  "archive",
  "inbox",
  "inbox/daily-briefing",
  "inbox/ingestion",
  "sources",
]);

export const DEFAULT_CREATABLE_DOMAINS: WorkspaceDomainInfo[] = [
  {
    path: "knowledge",
    label: "Knowledge",
    template_path: "knowledge/project-note",
    purpose:
      "Obsidian-style free-form PKM vault for notes, project pages (e.g. project-apollo.md), and subfolders.",
  },
  {
    path: "tasks",
    label: "Tasks",
    template_path: "tasks/task-template.md",
    schema_path: "tasks/task-template.schema.json",
    purpose: "Concrete actions that can be completed.",
  },
  {
    path: "goals",
    label: "Goals",
    template_path: "goals/goal-template.md",
    schema_path: "goals/goal-template.schema.json",
    purpose: "Outcomes and the reasons they matter.",
  },
  {
    path: "decisions",
    label: "Decisions",
    template_path: "decisions/decision-template.md",
    schema_path: "decisions/decision-template.schema.json",
    purpose: "Questions, options, trade-offs, and outcomes.",
  },
  {
    path: "calendar",
    label: "Calendar",
    template_path: "calendar/event-note-template.md",
    purpose: "Remind appointments and companion event notes.",
  },
];

export interface WorkspaceServiceOptions {
  workspaceRoot: string;
  maxEditableBytes?: number;
  maxDownloadBytes?: number;
  maxTreeEntries?: number;
  maintainer?: MaintainerService | undefined;
  maintainerRoot?: string | undefined;
  maintainerDatabasePath?: string | undefined;
}

export class WorkspaceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly currentRevision?: string;

  constructor(
    message: string,
    status: number,
    code: string,
    currentRevision?: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.status = status;
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
  }
}

export function revision(contents: Uint8Array): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

export function protectedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const lowerPath = normalized.toLowerCase();
  const parts = lowerPath.split("/");
  const basename = parts.at(-1) ?? "";
  return (
    lowerPath === MEMORY_DOCUMENT_PREFIX.slice(0, -1) ||
    lowerPath.startsWith(MEMORY_DOCUMENT_PREFIX) ||
    lowerPath === "sources/document-passwords.toml" ||
    lowerPath === ".env" ||
    lowerPath.startsWith(".env.") ||
    lowerPath.endsWith(".env") ||
    lowerPath.includes(".secret") ||
    lowerPath.endsWith(".pem") ||
    lowerPath.endsWith(".key") ||
    lowerPath.endsWith(".p12") ||
    lowerPath.endsWith(".pfx") ||
    basename === "auth.json" ||
    parts.some((part) => protectedDirectoryNames.has(part)) ||
    basename === ".gitignore" ||
    parts.some(
      (part) => part === ".git" || part === ".env" || part.startsWith(".env."),
    ) ||
    basename === "agents.md" ||
    basename === "claude.md" ||
    basename === ".cursorrules"
  );
}

export function isTemplateOrSchemaPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  return (
    basename.endsWith("-template.md") ||
    basename.endsWith(".schema.json") ||
    basename.endsWith(".openui") ||
    basename === PROJECT_MANIFEST_FILENAME ||
    templatePaths.has(normalized)
  );
}

export function isConfigurationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  return configurationBasenames.has(basename);
}

export function hiddenFromNavigator(
  path: string,
  settings: WorkspaceSettings = DEFAULT_WORKSPACE_SETTINGS,
): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  return (
    navigationHiddenBasenames.has(basename) ||
    basename.startsWith("._") ||
    (settings.hide_template_schema_files && isTemplateOrSchemaPath(path)) ||
    (settings.hide_configuration_files && isConfigurationPath(path))
  );
}

function validateRelativePath(
  value: unknown,
  settings: WorkspaceSettings = DEFAULT_WORKSPACE_SETTINGS,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0")
  ) {
    throw new WorkspaceError("invalid workspace path", 400, "invalid_path");
  }
  if (value.startsWith("/") || value.includes("\\")) {
    throw new WorkspaceError("invalid workspace path", 400, "invalid_path");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new WorkspaceError("invalid workspace path", 400, "invalid_path");
  }
  const normalized = parts.join("/");
  if (protectedPath(normalized)) {
    throw new WorkspaceError(
      "workspace path is protected",
      403,
      "protected_path",
    );
  }
  // Layouts and project manifests stay hidden in the navigator by default when
  // hide_template_schema_files is enabled, but project rendering and editing
  // must still be able to read/write them.
  const lowerNormalized = normalized.toLowerCase();
  const accessSettings =
    lowerNormalized.endsWith(".openui") ||
    lowerNormalized === PROJECT_MANIFEST_FILENAME ||
    lowerNormalized.endsWith(`/${PROJECT_MANIFEST_FILENAME}`)
      ? { ...settings, hide_template_schema_files: false }
      : settings;
  if (hiddenFromNavigator(normalized, accessSettings)) {
    throw new WorkspaceError(
      "workspace path is not available in the navigator",
      403,
      "hidden_path",
    );
  }
  return normalized;
}

function fileExtension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash ? path.slice(lastDot).toLowerCase() : "";
}

function getRecordFieldValue(
  record: WorkspaceDomainRecordSummary,
  field: string,
): unknown {
  if (field === "title") return record.title;
  if (field === "filename") return record.filename;
  if (field === "path") return record.path;
  return record.frontmatter[field];
}

function matchesExpectedValue(
  actual: unknown,
  expected: string | number | boolean | Array<string | number | boolean>,
): boolean {
  if (Array.isArray(expected)) {
    return expected.some((item) => matchesExpectedValue(actual, item));
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => String(item) === String(expected));
  }
  if (actual === undefined || actual === null) return false;
  return String(actual) === String(expected);
}

export function evaluateProjectQueries(
  records: WorkspaceDomainRecordSummary[],
  queries?: Record<string, ProjectQueryDefinition>,
): Record<string, unknown> {
  if (!queries) return {};
  const results: Record<string, unknown> = {};

  for (const [name, q] of Object.entries(queries)) {
    const filtered = q.where
      ? records.filter((rec) =>
          Object.entries(q.where ?? {}).every(([f, exp]) =>
            matchesExpectedValue(getRecordFieldValue(rec, f), exp),
          ),
        )
      : records;

    if (q.type === "filter") {
      if (q.field && q.value !== undefined) {
        results[name] = filtered.filter((rec) =>
          matchesExpectedValue(getRecordFieldValue(rec, q.field!), q.value!),
        );
      } else {
        results[name] = filtered;
      }
    } else if (q.type === "count") {
      if (q.field && q.value !== undefined) {
        results[name] = filtered.filter((rec) =>
          matchesExpectedValue(getRecordFieldValue(rec, q.field!), q.value!),
        ).length;
      } else if (q.field) {
        results[name] = filtered.filter((rec) => {
          const val = getRecordFieldValue(rec, q.field!);
          return val !== undefined && val !== null && val !== "";
        }).length;
      } else {
        results[name] = filtered.length;
      }
    } else if (q.type === "group_count") {
      const counts: Record<string, number> = {};
      if (q.field) {
        for (const rec of filtered) {
          const val = getRecordFieldValue(rec, q.field);
          if (Array.isArray(val)) {
            for (const item of val) {
              const key = String(item || "unset");
              counts[key] = (counts[key] ?? 0) + 1;
            }
          } else {
            const key =
              val === undefined || val === null || val === ""
                ? "unset"
                : String(val);
            counts[key] = (counts[key] ?? 0) + 1;
          }
        }
      }
      results[name] = counts;
    } else if (q.type === "sum") {
      let total = 0;
      if (q.field) {
        for (const rec of filtered) {
          const val = Number(getRecordFieldValue(rec, q.field));
          if (Number.isFinite(val)) total += val;
        }
      }
      results[name] = total;
    }
  }

  return results;
}

function asNodeError(error: unknown): { code?: string } {
  return error instanceof Error ? (error as Error & { code?: string }) : {};
}

export class WorkspaceService {
  readonly workspaceRoot: string;
  readonly maxEditableBytes: number;
  readonly maxDownloadBytes: number;
  readonly maxTreeEntries: number;
  readonly maintainer: MaintainerService;

  constructor(options: WorkspaceServiceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.maxEditableBytes =
      options.maxEditableBytes ?? DEFAULT_MAX_EDITABLE_BYTES;
    this.maxDownloadBytes =
      options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.maxTreeEntries = options.maxTreeEntries ?? DEFAULT_MAX_TREE_ENTRIES;
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });

    if (options.maintainer) {
      this.maintainer = options.maintainer;
    } else if (options.maintainerDatabasePath) {
      this.maintainer = new MaintainerService({
        workspaceRoot: this.workspaceRoot,
        dbPath: options.maintainerDatabasePath,
      });
    } else if (options.maintainerRoot || process.env.OPENLIA_MAINTAINER_ROOT) {
      this.maintainer = new MaintainerService({
        workspaceRoot: this.workspaceRoot,
        maintainerRoot:
          options.maintainerRoot ?? process.env.OPENLIA_MAINTAINER_ROOT,
      });
    } else {
      const wsBase = this.workspaceRoot.split(sep).at(-1) ?? "workspace";
      const defaultDbPath =
        wsBase === "workspace"
          ? join(dirname(this.workspaceRoot), "maintainer", "maintainer.sqlite")
          : join(
              dirname(this.workspaceRoot),
              ".openlia-maintainer",
              `${createHash("sha256").update(this.workspaceRoot).digest("hex").slice(0, 12)}.sqlite`,
            );
      this.maintainer = new MaintainerService({
        workspaceRoot: this.workspaceRoot,
        dbPath: defaultDbPath,
      });
    }
  }

  private validateWithMaintainer(
    relativePath: string,
    content: string,
    checkedRev?: string,
  ): WorkspaceFileValidation {
    const rawVal = validateRecordContent(
      this.workspaceRoot,
      relativePath,
      content,
    );
    const rev = checkedRev ?? revision(new TextEncoder().encode(content));
    const candidates = evaluateFileFindings(
      this.workspaceRoot,
      this.maintainer.workspaceId,
      relativePath,
      content,
      rev,
    );
    const reconciled = this.maintainer.db.reconcileFileFindings(
      this.maintainer.workspaceId,
      relativePath,
      rev,
      candidates,
    );
    const presentFindings = reconciled.filter((f) => f.present);
    const openFindings = presentFindings.filter((f) => f.state === "open");
    const ignoredFindings = presentFindings.filter(
      (f) => f.state === "ignored",
    );

    if (presentFindings.length > 0) {
      return {
        valid: openFindings.length === 0,
        errors: openFindings.map((f) => f.message),
        ...(rawVal.schema_path ? { schema_path: rawVal.schema_path } : {}),
        ...(rawVal.template_path
          ? { template_path: rawVal.template_path }
          : {}),
        findings: presentFindings,
        ignored_count: ignoredFindings.length,
      };
    }

    return {
      ...rawVal,
      findings: [],
      ignored_count: 0,
    };
  }

  settings(): WorkspaceSettings {
    const absolute = join(this.workspaceRoot, WORKSPACE_SETTINGS_FILE);
    if (!existsSync(absolute)) return { ...DEFAULT_WORKSPACE_SETTINGS };
    try {
      const parsed: unknown = YAML.parse(readFileSync(absolute, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).schema === 1 &&
        typeof (parsed as Record<string, unknown>)
          .hide_template_schema_files === "boolean" &&
        typeof (parsed as Record<string, unknown>).hide_configuration_files ===
          "boolean"
      ) {
        const values = parsed as Record<string, unknown>;
        return {
          enable_memory_editing: values.enable_memory_editing === true,
          hide_configuration_files: values.hide_configuration_files as boolean,
          hide_template_schema_files:
            values.hide_template_schema_files as boolean,
          schema: 1,
        };
      }
    } catch {}
    return { ...DEFAULT_WORKSPACE_SETTINGS };
  }

  updateSettings(value: unknown): WorkspaceSettings {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new WorkspaceError(
        "workspace settings must be an object",
        400,
        "invalid_settings",
      );
    }
    const values = value as Record<string, unknown>;
    if (
      (values.enable_memory_editing !== undefined &&
        typeof values.enable_memory_editing !== "boolean") ||
      typeof values.hide_template_schema_files !== "boolean" ||
      typeof values.hide_configuration_files !== "boolean"
    ) {
      throw new WorkspaceError(
        "workspace visibility settings must be boolean values",
        400,
        "invalid_settings",
      );
    }

    const next: WorkspaceSettings = {
      enable_memory_editing:
        (values.enable_memory_editing as boolean | undefined) ??
        this.settings().enable_memory_editing,
      hide_configuration_files: values.hide_configuration_files,
      hide_template_schema_files: values.hide_template_schema_files,
      schema: 1,
    };
    const absolute = join(this.workspaceRoot, WORKSPACE_SETTINGS_FILE);
    const temporary = join(
      this.workspaceRoot,
      `.${WORKSPACE_SETTINGS_FILE}.openlia-${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporary, YAML.stringify(next), {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, absolute);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw this.mapFilesystemError(
        error,
        "workspace settings could not be saved",
      );
    }
    return next;
  }

  tree(): WorkspaceTreeResponse {
    const settings = this.settings();
    const entries: WorkspaceTreeResponse["entries"] = [];
    let truncated = false;
    const visit = (directory: string): void => {
      let directoryEntries: Dirent<string>[] = [];
      try {
        directoryEntries = readdirSync(directory, {
          encoding: "utf8",
          withFileTypes: true,
        });
      } catch {
        return;
      }
      for (const entry of directoryEntries) {
        if (entries.length >= this.maxTreeEntries) {
          truncated = true;
          return;
        }
        const absolute = join(directory, entry.name);
        const path = relative(this.workspaceRoot, absolute)
          .split(sep)
          .join("/");
        if (protectedPath(path)) continue;
        let info: Stats | undefined;
        try {
          info = lstatSync(absolute);
        } catch {
          continue;
        }
        if (info.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const hasProjectManifest = existsSync(
            join(absolute, PROJECT_MANIFEST_FILENAME),
          );
          entries.push({
            path,
            kind: "directory",
            ...(hasProjectManifest ? { project: true } : {}),
          });
          visit(absolute);
        } else if (entry.isFile()) {
          if (hiddenFromNavigator(path, settings)) continue;
          try {
            entries.push({
              kind: "file",
              ...this.fileMetadata(absolute, path),
            });
          } catch {}
        }
      }
    };

    visit(this.workspaceRoot);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return {
      schema: 1,
      entries,
      truncated,
    };
  }

  read(pathValue: unknown): WorkspaceFile {
    const path = validateRelativePath(pathValue, this.settings());
    const absolute = this.assertNoSymlink(path);
    let info: Stats | undefined;
    try {
      info = lstatSync(absolute);
    } catch (error) {
      throw this.mapFilesystemError(error, "workspace file was not found");
    }
    if (!info.isFile())
      throw new WorkspaceError(
        "workspace path is not a file",
        400,
        "not_a_file",
      );
    if (info.size > this.maxEditableBytes) {
      throw new WorkspaceError(
        "file is too large to edit",
        413,
        "file_too_large",
      );
    }
    let contents: Uint8Array;
    try {
      contents = readFileSync(absolute);
    } catch (error) {
      throw this.mapFilesystemError(error, "workspace file was not found");
    }
    if (contents.includes(0)) {
      throw new WorkspaceError(
        "binary files are not editable",
        415,
        "binary_file",
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      throw new WorkspaceError("file is not valid UTF-8", 415, "invalid_utf8");
    }
    const fileRev = revision(contents);
    const validation = this.validateWithMaintainer(path, text, fileRev);
    return {
      schema: 1,
      content: text,
      revision: fileRev,
      validation,
      ...this.fileMetadata(absolute, path),
    };
  }

  write(
    pathValue: unknown,
    contentValue: unknown,
    expectedValue: unknown,
  ): WorkspaceWriteResponse {
    const path = validateRelativePath(pathValue, this.settings());
    if (typeof contentValue !== "string") {
      throw new WorkspaceError(
        "content must be a string",
        400,
        "invalid_content",
      );
    }
    const contents = new TextEncoder().encode(contentValue);
    if (contents.byteLength > this.maxEditableBytes) {
      throw new WorkspaceError(
        "file is too large to edit",
        413,
        "file_too_large",
      );
    }
    if (contents.includes(0)) {
      throw new WorkspaceError(
        "binary content is not editable",
        415,
        "binary_content",
      );
    }

    if (!editableExtensions.has(fileExtension(path))) {
      throw new WorkspaceError(
        "file type is not editable",
        415,
        "not_editable",
      );
    }

    const absolute = this.assertNoSymlink(path);
    const parent = dirname(absolute);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    let current = new Uint8Array();
    let mode = 0o600;
    if (existsSync(absolute)) {
      const info = lstatSync(absolute);
      if (!info.isFile())
        throw new WorkspaceError(
          "workspace path is not a regular file",
          400,
          "not_a_file",
        );
      if (info.size > this.maxEditableBytes) {
        throw new WorkspaceError(
          "file is too large to edit",
          413,
          "file_too_large",
        );
      }
      current = readFileSync(absolute);
      mode = info.mode & 0o777;
    }
    const currentRevision = revision(current);
    if (
      typeof expectedValue !== "string" ||
      expectedValue !== currentRevision
    ) {
      throw new WorkspaceError(
        "revision conflict",
        409,
        "revision_conflict",
        currentRevision,
      );
    }

    const temporary = join(
      parent,
      `.${absolute.split(sep).at(-1)}.openlia-${randomUUID()}.tmp`,
    );
    const descriptor = openSync(temporary, "wx", mode);
    try {
      writeSync(descriptor, contents);
      fsyncSync(descriptor);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    } finally {
      closeSync(descriptor);
    }

    try {
      const beforeReplace = existsSync(absolute)
        ? readFileSync(absolute)
        : new Uint8Array();
      if (revision(beforeReplace) !== currentRevision) {
        throw new WorkspaceError(
          "revision conflict",
          409,
          "revision_conflict",
          revision(beforeReplace),
        );
      }
      renameSync(temporary, absolute);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    const nextRev = revision(contents);
    const validation = this.validateWithMaintainer(path, contentValue, nextRev);
    // Revalidate dependent records/views in the same folder when a contract changes
    if (isTemplateOrSchemaPath(path)) {
      this.maintainer.validateAndReconcilePaths([path]);
    }
    return {
      schema: 1,
      ok: true,
      revision: nextRev,
      validation,
      ...this.fileMetadata(absolute, path),
    };
  }

  delete(pathValue: unknown, expectedValue: unknown): WorkspaceDeleteResponse {
    const path = validateRelativePath(pathValue, this.settings());
    if (isTemplateOrSchemaPath(path)) {
      throw new WorkspaceError(
        "template and schema files are protected",
        403,
        "protected_path",
      );
    }
    const absolute = this.assertNoSymlink(path);
    let info: Stats;
    try {
      info = lstatSync(absolute);
    } catch (error) {
      throw this.mapFilesystemError(error, "workspace file was not found");
    }
    if (!info.isFile())
      throw new WorkspaceError(
        "workspace path is not a regular file",
        400,
        "not_a_file",
      );

    let contents: Uint8Array;
    try {
      contents = readFileSync(absolute);
    } catch (error) {
      throw this.mapFilesystemError(error, "workspace file was not found");
    }
    const currentRevision = revision(contents);
    if (
      typeof expectedValue !== "string" ||
      expectedValue !== currentRevision
    ) {
      throw new WorkspaceError(
        "revision conflict",
        409,
        "revision_conflict",
        currentRevision,
      );
    }

    try {
      const beforeDelete = readFileSync(absolute);
      const beforeDeleteRevision = revision(beforeDelete);
      if (beforeDeleteRevision !== currentRevision) {
        throw new WorkspaceError(
          "revision conflict",
          409,
          "revision_conflict",
          beforeDeleteRevision,
        );
      }
      unlinkSync(absolute);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw this.mapFilesystemError(error, "workspace file was not found");
    }

    this.maintainer.db.markFileDeleted(this.maintainer.workspaceId, path);
    return { schema: 1, ok: true, path };
  }

  rename(
    pathValue: unknown,
    newNameValue: unknown,
    expectedValue: unknown,
  ): WorkspaceRenameResponse {
    const settings = this.settings();
    const sourcePath = validateRelativePath(pathValue, settings);
    if (typeof newNameValue !== "string" || !newNameValue.trim()) {
      throw new WorkspaceError("invalid new file name", 400, "invalid_path");
    }
    const cleanName = newNameValue.trim();
    if (
      cleanName.includes("/") ||
      cleanName.includes("\\") ||
      cleanName.includes("\0")
    ) {
      throw new WorkspaceError(
        "new file name must not contain path separators",
        400,
        "invalid_path",
      );
    }
    if (isTemplateOrSchemaPath(sourcePath)) {
      throw new WorkspaceError(
        "template and schema files are protected",
        403,
        "protected_path",
      );
    }
    const parts = sourcePath.split("/");
    parts[parts.length - 1] = cleanName;
    const destinationPath = parts.join("/");
    if (isTemplateOrSchemaPath(destinationPath)) {
      throw new WorkspaceError(
        "cannot rename to a template or schema name",
        403,
        "protected_path",
      );
    }
    validateRelativePath(destinationPath, settings);
    if (!editableExtensions.has(fileExtension(destinationPath))) {
      throw new WorkspaceError(
        "file type is not editable",
        415,
        "not_editable",
      );
    }
    return this.executeMoveOrRename(sourcePath, destinationPath, expectedValue);
  }

  move(
    sourcePathValue: unknown,
    destPathValue: unknown,
    expectedValue: unknown,
  ): WorkspaceMoveResponse {
    const settings = this.settings();
    const sourcePath = validateRelativePath(sourcePathValue, settings);
    const destinationPath = validateRelativePath(destPathValue, settings);
    if (sourcePath === destinationPath) {
      throw new WorkspaceError(
        "source and destination paths are identical",
        400,
        "invalid_path",
      );
    }
    if (isTemplateOrSchemaPath(sourcePath)) {
      throw new WorkspaceError(
        "template and schema files are protected",
        403,
        "protected_path",
      );
    }
    if (isTemplateOrSchemaPath(destinationPath)) {
      throw new WorkspaceError(
        "cannot move to a template or schema path",
        403,
        "protected_path",
      );
    }
    if (!editableExtensions.has(fileExtension(destinationPath))) {
      throw new WorkspaceError(
        "file type is not editable",
        415,
        "not_editable",
      );
    }
    return this.executeMoveOrRename(sourcePath, destinationPath, expectedValue);
  }

  diagnostics(): WorkspaceDiagnosticsResponse {
    const overview = this.maintainer.runWorkspaceAudit();
    const rawDiag = validateEntireWorkspace(this.workspaceRoot);
    const byPath = new Map<
      string,
      {
        errors: string[];
        schema_path?: string | undefined;
        template_path?: string | undefined;
      }
    >();

    for (const f of overview.open_findings) {
      const existing = byPath.get(f.relative_path) ?? { errors: [] };
      existing.errors.push(f.message);
      if (f.contract_path) {
        if (f.contract_path.endsWith(".schema.json")) {
          existing.schema_path = f.contract_path;
        } else if (f.contract_path.endsWith("-template.md")) {
          existing.template_path = f.contract_path;
        }
      }
      byPath.set(f.relative_path, existing);
    }

    // Preserve any legacy configuration file diagnostics not handled by Maintainer
    for (const issue of rawDiag.issues) {
      if (isConfigurationPath(issue.path) && !byPath.has(issue.path)) {
        byPath.set(issue.path, {
          errors: issue.errors,
          ...(issue.schema_path ? { schema_path: issue.schema_path } : {}),
          ...(issue.template_path
            ? { template_path: issue.template_path }
            : {}),
        });
      }
    }

    const issues = [...byPath.entries()]
      .map(([path, val]) => ({
        path,
        errors: val.errors,
        ...(val.schema_path ? { schema_path: val.schema_path } : {}),
        ...(val.template_path ? { template_path: val.template_path } : {}),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      schema: 1,
      valid: issues.length === 0,
      issues,
    };
  }

  creatableDomains(): WorkspaceDomainInfo[] {
    const byPath = new Map<string, WorkspaceDomainInfo>();

    const isDisallowed = (domainPath: string): boolean =>
      !domainPath ||
      creationDisallowedDomains.has(domainPath) ||
      domainPath.startsWith("sources/") ||
      domainPath.startsWith("inbox/") ||
      domainPath.startsWith("archive/") ||
      protectedPath(domainPath);

    // 1. Legacy workspace.yaml if present
    const workspaceYamlPath = join(this.workspaceRoot, "workspace.yaml");
    if (existsSync(workspaceYamlPath)) {
      try {
        const raw = readFileSync(workspaceYamlPath, "utf-8");
        const parsed = YAML.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          Array.isArray(parsed.domains)
        ) {
          for (const item of parsed.domains) {
            if (
              !item ||
              typeof item !== "object" ||
              typeof item.path !== "string"
            )
              continue;
            const domainPath = item.path
              .replaceAll("\\", "/")
              .replace(/^\/+/, "")
              .replace(/\/+$/, "");
            if (isDisallowed(domainPath)) continue;

            let templateRel =
              typeof item.template === "string"
                ? item.template.replaceAll("\\", "/")
                : undefined;
            const info = findDomainTemplate(
              this.workspaceRoot,
              `${domainPath}/dummy.md`,
            );
            if (!templateRel && info) {
              templateRel = info.templateRelativePath;
            }
            if (!templateRel) continue;

            const openuiPaths = this.findDomainOpenUIPaths(domainPath);
            byPath.set(domainPath, {
              path: domainPath,
              label: typeof item.label === "string" ? item.label : domainPath,
              purpose:
                typeof item.purpose === "string" ? item.purpose : undefined,
              template_path: templateRel,
              ...(info?.schemaRelativePath
                ? { schema_path: info.schemaRelativePath }
                : {}),
              ...(openuiPaths.dashboard_openui_path
                ? { dashboard_openui_path: openuiPaths.dashboard_openui_path }
                : {}),
              ...(openuiPaths.record_openui_path
                ? { record_openui_path: openuiPaths.record_openui_path }
                : {}),
              ...(item.kind === "core" || item.kind === "extension"
                ? { kind: item.kind }
                : {}),
              ...(typeof item.lifecycle === "string"
                ? { lifecycle: item.lifecycle }
                : {}),
              ...(typeof item.feature === "string"
                ? { feature: item.feature }
                : {}),
              ...(Array.isArray(item.skills) ? { skills: item.skills } : {}),
            });
          }
        }
      } catch {}
    }

    // 2. Discover collections from filesystem via Maintainer
    for (const col of this.maintainer.discoverCollections()) {
      if (isDisallowed(col.path) || byPath.has(col.path)) continue;
      const builtin = getBuiltinDomainContract(col.path);
      if (
        col.path !== "knowledge" &&
        !col.template_path &&
        !col.manifest_path &&
        col.record_count === 0
      ) {
        continue;
      }
      const openuiPaths = this.findDomainOpenUIPaths(col.path);
      const resolvedTemplatePath = col.template_path ?? builtin?.template_path;
      const resolvedSchemaPath = col.schema_path ?? builtin?.schema_path;
      byPath.set(col.path, {
        path: col.path,
        label: col.label,
        purpose: col.inferred_purpose,
        ...(resolvedTemplatePath
          ? { template_path: resolvedTemplatePath }
          : {}),
        ...(resolvedSchemaPath ? { schema_path: resolvedSchemaPath } : {}),
        ...(openuiPaths.dashboard_openui_path
          ? { dashboard_openui_path: openuiPaths.dashboard_openui_path }
          : {}),
        ...(openuiPaths.record_openui_path
          ? { record_openui_path: openuiPaths.record_openui_path }
          : {}),
        kind: col.kind === "core" ? "core" : "extension",
      });
    }

    if (byPath.size > 0) {
      return [...byPath.values()];
    }

    return DEFAULT_CREATABLE_DOMAINS;
  }

  private findDomainOpenUIPaths(domainPath: string): {
    dashboard_openui_path?: string | undefined;
    record_openui_path?: string | undefined;
  } {
    const dirAbs = resolve(this.workspaceRoot, domainPath);
    if (!this.insideWorkspace(dirAbs) || !existsSync(dirAbs)) return {};
    try {
      const uiPath = join(dirAbs, DEFAULT_PROJECT_UI_ENTRY);
      if (existsSync(uiPath) && lstatSync(uiPath).isFile()) {
        return {
          dashboard_openui_path: `${domainPath}/${DEFAULT_PROJECT_UI_ENTRY}`,
        };
      }
      return {};
    } catch {
      return {};
    }
  }

  domainOverview(domainPathValue: unknown): WorkspaceDomainRecordsResponse {
    if (typeof domainPathValue !== "string" || !domainPathValue.trim()) {
      throw new WorkspaceError(
        "domain path is required",
        400,
        "invalid_domain",
      );
    }
    const domainPath = domainPathValue
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (
      !domainPath ||
      domainPath.includes("..") ||
      domainPath.includes("\0") ||
      protectedPath(domainPath)
    ) {
      throw new WorkspaceError("invalid domain path", 400, "invalid_domain");
    }

    const builtin = getBuiltinDomainContract(domainPath);
    const dirAbs = this.assertNoSymlink(domainPath);
    const dirExists = existsSync(dirAbs) && lstatSync(dirAbs).isDirectory();
    if (!dirExists && !builtin) {
      throw new WorkspaceError(
        `domain "${domainPath}" was not found`,
        404,
        "not_found",
      );
    }

    const allDomains = this.creatableDomains();
    let domainInfo: WorkspaceDomainInfo | undefined = allDomains.find(
      (d) => d.path === domainPath,
    );

    const templateInfo = dirExists
      ? findDomainTemplate(this.workspaceRoot, `${domainPath}/dummy.md`)
      : null;
    const openuiPaths = dirExists ? this.findDomainOpenUIPaths(domainPath) : {};

    if (!domainInfo) {
      const label =
        builtin?.label ||
        (domainPath.split("/").at(-1) ?? domainPath)
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()) ||
        domainPath;
      const tplRel =
        templateInfo?.templateRelativePath ?? builtin?.template_path;
      const schRel = templateInfo?.schemaRelativePath ?? builtin?.schema_path;
      domainInfo = {
        path: domainPath,
        label,
        ...(builtin?.purpose ? { purpose: builtin.purpose } : {}),
        ...(tplRel ? { template_path: tplRel } : {}),
        ...(schRel ? { schema_path: schRel } : {}),
        ...(openuiPaths.dashboard_openui_path
          ? { dashboard_openui_path: openuiPaths.dashboard_openui_path }
          : {}),
        ...(openuiPaths.record_openui_path
          ? { record_openui_path: openuiPaths.record_openui_path }
          : {}),
      };
    } else {
      const schRel = templateInfo?.schemaRelativePath ?? builtin?.schema_path;
      domainInfo = {
        ...domainInfo,
        ...(schRel && !domainInfo.schema_path ? { schema_path: schRel } : {}),
        ...(openuiPaths.dashboard_openui_path &&
        !domainInfo.dashboard_openui_path
          ? { dashboard_openui_path: openuiPaths.dashboard_openui_path }
          : {}),
        ...(openuiPaths.record_openui_path && !domainInfo.record_openui_path
          ? { record_openui_path: openuiPaths.record_openui_path }
          : {}),
      };
    }

    let schemaJson: Record<string, unknown> | undefined;
    if (
      templateInfo?.schemaAbsolutePath &&
      existsSync(templateInfo.schemaAbsolutePath)
    ) {
      try {
        const parsed = JSON.parse(
          readFileSync(templateInfo.schemaAbsolutePath, "utf-8"),
        );
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          schemaJson = parsed as Record<string, unknown>;
        }
      } catch {}
    }
    schemaJson = mergeBuiltinSchemaProperties(domainPath, schemaJson);

    let templateHeadings: string[] | undefined;
    let templateContent: string | undefined;
    let templateDefaults: Record<string, unknown> | undefined;
    let templateSections: Record<string, string> | undefined;

    if (templateInfo?.templateRelativePath) {
      const tplAbs = resolve(
        this.workspaceRoot,
        templateInfo.templateRelativePath,
      );
      if (existsSync(tplAbs)) {
        try {
          const tplRaw = readFileSync(tplAbs, "utf-8");
          templateContent = tplRaw;
          const parsedTpl = parseMarkdownRecord(tplRaw);
          templateHeadings = extractHeadings(parsedTpl.body)
            .filter((h) => h.level === 2)
            .map((h) => h.text.trim())
            .filter(Boolean);
          const defaults: Record<string, unknown> = {
            ...(builtin?.template_defaults ?? {}),
          };
          for (const [k, v] of Object.entries(parsedTpl.metadata)) {
            if (k !== "$schema") defaults[k] = v;
          }
          templateDefaults = defaults;
          templateSections = {
            ...(builtin?.template_sections ?? {}),
            ...parsedTpl.sections,
          };
        } catch {}
      }
    }

    if (!templateHeadings && builtin) {
      templateHeadings = builtin.template_headings;
    }
    if (!templateContent && builtin) {
      templateContent = builtin.template_content;
    }
    if (!templateDefaults && builtin) {
      templateDefaults = builtin.template_defaults;
    }
    if (!templateSections && builtin) {
      templateSections = builtin.template_sections;
    }

    let dashboardOpenui: string | undefined;
    if (domainInfo.dashboard_openui_path) {
      const dashAbs = resolve(
        this.workspaceRoot,
        domainInfo.dashboard_openui_path,
      );
      if (this.insideWorkspace(dashAbs) && existsSync(dashAbs)) {
        try {
          dashboardOpenui = readFileSync(dashAbs, "utf-8");
        } catch {}
      }
    }

    let recordOpenui: string | undefined;
    if (domainInfo.record_openui_path) {
      const recAbs = resolve(this.workspaceRoot, domainInfo.record_openui_path);
      if (this.insideWorkspace(recAbs) && existsSync(recAbs)) {
        try {
          recordOpenui = readFileSync(recAbs, "utf-8");
        } catch {}
      }
    }

    const records: WorkspaceDomainRecordSummary[] = [];
    let invalidCount = 0;

    const collectDirectoryRecords = (
      scanAbs: string,
      relPrefix: string,
      allowSubfolders: boolean,
    ): void => {
      let entries: Dirent<string>[] = [];
      try {
        entries = readdirSync(scanAbs, {
          encoding: "utf8",
          withFileTypes: true,
        });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fname = entry.name;
        if (fname.startsWith(".")) continue;
        if (entry.isDirectory() && allowSubfolders) {
          const childRel = `${relPrefix}/${fname}`;
          const childAbs = join(scanAbs, fname);
          if (
            !protectedPath(childRel) &&
            !existsSync(join(childAbs, PROJECT_MANIFEST_FILENAME)) &&
            !findDomainTemplate(this.workspaceRoot, `${childRel}/dummy.md`)
          ) {
            collectDirectoryRecords(childAbs, childRel, false);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (!fname.toLowerCase().endsWith(".md")) continue;
        if (fname.toLowerCase().endsWith("-template.md")) continue;
        if (fname.toLowerCase() === "readme.md") continue;

        const relPath = `${relPrefix}/${fname}`;
        if (protectedPath(relPath) || isTemplateOrSchemaPath(relPath)) continue;

        const absPath = join(scanAbs, fname);
        try {
          const info = lstatSync(absPath);
          if (info.isSymbolicLink() || !info.isFile()) continue;
          const rawBytes = readFileSync(absPath);
          const content = new TextDecoder("utf-8").decode(rawBytes);
          const parsed = parseRecordFrontmatter(content);
          const headings = extractHeadings(parsed.body);
          const l1 = headings.find((h) => h.level === 1)?.text.trim();
          const title =
            l1 ||
            (typeof parsed.metadata?.title === "string"
              ? parsed.metadata.title
              : "") ||
            fname.replace(/\.md$/i, "");
          const sections = headings
            .filter((h) => h.level === 2)
            .map((h) => h.text.trim())
            .filter(Boolean);

          const excerptLines = parsed.body
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(
              (l) =>
                l.length > 0 &&
                !l.startsWith("#") &&
                !l.startsWith("---") &&
                !l.startsWith("```"),
            );
          const excerpt = excerptLines.slice(0, 2).join(" ").slice(0, 220);

          const recRev = revision(rawBytes);
          const validation = this.validateWithMaintainer(
            relPath,
            content,
            recRev,
          );
          if (!validation.valid) {
            invalidCount++;
          }

          const fm: Record<string, unknown> = {};
          if (parsed.metadata) {
            for (const [k, v] of Object.entries(parsed.metadata)) {
              if (k !== "$schema") fm[k] = v;
            }
          }

          records.push({
            path: relPath,
            filename:
              relPrefix === domainPath
                ? fname
                : `${relPrefix.slice(domainPath.length + 1)}/${fname}`,
            title,
            modified_at: info.mtime.toISOString(),
            size: info.size,
            revision: recRev,
            frontmatter: fm,
            sections,
            excerpt,
            validation,
          });
        } catch {}
      }
    };

    if (dirExists) {
      collectDirectoryRecords(dirAbs, domainPath, domainPath === "knowledge");
    }

    records.sort((a, b) => a.path.localeCompare(b.path));

    domainInfo = {
      ...domainInfo,
      record_count: records.length,
      invalid_record_count: invalidCount,
    };

    return {
      schema: 1,
      domain: domainInfo,
      records,
      ...(schemaJson ? { schema_json: schemaJson } : {}),
      ...(templateHeadings ? { template_headings: templateHeadings } : {}),
      ...(templateContent !== undefined
        ? { template_content: templateContent }
        : {}),
      ...(templateDefaults ? { template_defaults: templateDefaults } : {}),
      ...(templateSections ? { template_sections: templateSections } : {}),
      ...(builtin?.starter_templates
        ? { starter_templates: builtin.starter_templates }
        : {}),
      ...(dashboardOpenui !== undefined
        ? { dashboard_openui: dashboardOpenui }
        : {}),
      ...(recordOpenui !== undefined ? { record_openui: recordOpenui } : {}),
    };
  }

  listProjects(): WorkspaceProjectsResponse {
    const projects: ProjectSummary[] = [];

    const visit = (directory: string): void => {
      let entries: Dirent<string>[] = [];
      try {
        entries = readdirSync(directory, {
          encoding: "utf8",
          withFileTypes: true,
        });
      } catch {
        return;
      }

      const hasManifest = entries.some(
        (e) => e.isFile() && e.name === PROJECT_MANIFEST_FILENAME,
      );
      if (hasManifest && directory !== this.workspaceRoot) {
        const relDir = relative(this.workspaceRoot, directory)
          .split(sep)
          .join("/");
        if (!protectedPath(relDir)) {
          try {
            const summary = this.buildProjectSummary(
              directory,
              relDir,
              entries,
            );
            if (summary) projects.push(summary);
          } catch {}
        }
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const abs = join(directory, entry.name);
        const rel = relative(this.workspaceRoot, abs).split(sep).join("/");
        if (protectedPath(rel)) continue;
        try {
          const info = lstatSync(abs);
          if (info.isSymbolicLink()) continue;
          visit(abs);
        } catch {}
      }
    };

    visit(this.workspaceRoot);
    projects.sort((a, b) => a.path.localeCompare(b.path));

    return {
      schema: 1,
      projects,
    };
  }

  private buildProjectSummary(
    dirAbs: string,
    projectPath: string,
    entries?: Dirent<string>[],
  ): ProjectSummary | null {
    const manifestRel = `${projectPath}/${PROJECT_MANIFEST_FILENAME}`;
    const manifestAbs = join(dirAbs, PROJECT_MANIFEST_FILENAME);
    if (!existsSync(manifestAbs)) return null;

    const raw = readFileSync(manifestAbs, "utf-8");
    const parsedManifest = parseProjectManifest(raw);
    const fallbackName =
      (projectPath.split("/").at(-1) ?? projectPath)
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase()) || projectPath;
    const manifest: ProjectManifest = parsedManifest.manifest ?? {
      version: 1,
      project: {
        id: projectPath.split("/").at(-1) ?? projectPath,
        name: fallbackName,
      },
      data: {},
      ui: { entry: DEFAULT_PROJECT_UI_ENTRY },
    };

    const renderErrors: string[] = [...parsedManifest.errors];
    const uiEntry = manifest.ui.entry || DEFAULT_PROJECT_UI_ENTRY;
    const uiRel = `${projectPath}/${uiEntry}`;
    const uiAbs = resolve(dirAbs, uiEntry);
    if (!uiAbs.startsWith(dirAbs + sep) || !existsSync(uiAbs)) {
      renderErrors.push(`UI entry '${uiEntry}' is missing in '${projectPath}'`);
    } else {
      try {
        const uiRaw = readFileSync(uiAbs, "utf8");
        const uiVal = validateOpenUIContent(this.workspaceRoot, uiRel, uiRaw);
        for (const err of uiVal.errors) {
          if (err.startsWith("openui")) {
            renderErrors.push(err);
          }
        }
      } catch {}
    }

    const dirEntries =
      entries ??
      readdirSync(dirAbs, {
        encoding: "utf8",
        withFileTypes: true,
      });

    const excluded = new Set(
      (manifest.data.exclude ?? ["README.md"]).map((s) => s.toLowerCase()),
    );
    let recordCount = 0;
    let invalidCount = 0;

    for (const entry of dirEntries) {
      if (!entry.isFile()) continue;
      const fname = entry.name;
      if (fname.startsWith(".")) continue;
      const lower = fname.toLowerCase();
      if (!lower.endsWith(".md")) continue;
      if (lower.endsWith("-template.md") || lower === "readme.md") continue;
      if (excluded.has(lower)) continue;
      if (
        manifest.data.template &&
        lower === manifest.data.template.toLowerCase()
      ) {
        continue;
      }

      recordCount++;
      try {
        const content = readFileSync(join(dirAbs, fname), "utf-8");
        const v = this.validateWithMaintainer(
          `${projectPath}/${fname}`,
          content,
        );
        if (!v.valid) invalidCount++;
      } catch {}
    }

    const templateInfo = findDomainTemplate(
      this.workspaceRoot,
      `${projectPath}/dummy.md`,
    );
    const templatePath = manifest.data.template
      ? `${projectPath}/${manifest.data.template}`
      : templateInfo?.templateRelativePath;
    const schemaPath = manifest.data.schema
      ? `${projectPath}/${manifest.data.schema}`
      : templateInfo?.schemaRelativePath;

    return {
      path: projectPath,
      id: manifest.project.id,
      name: manifest.project.name,
      ...(manifest.project.description
        ? { description: manifest.project.description }
        : {}),
      ...(manifest.project.icon ? { icon: manifest.project.icon } : {}),
      manifest_path: manifestRel,
      ui_path: uiRel,
      ...(templatePath ? { template_path: templatePath } : {}),
      ...(schemaPath ? { schema_path: schemaPath } : {}),
      skills: manifest.logic?.skills ?? [],
      record_count: recordCount,
      invalid_record_count: invalidCount,
      renderable: renderErrors.length === 0,
      ...(renderErrors.length > 0 ? { render_errors: renderErrors } : {}),
    };
  }

  loadProject(projectPathValue: unknown): WorkspaceProjectResponse {
    if (typeof projectPathValue !== "string" || !projectPathValue.trim()) {
      throw new WorkspaceError(
        "project path is required",
        400,
        "invalid_project",
      );
    }
    const projectPath = projectPathValue
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (
      !projectPath ||
      projectPath.includes("..") ||
      projectPath.includes("\0") ||
      protectedPath(projectPath)
    ) {
      throw new WorkspaceError("invalid project path", 400, "invalid_project");
    }

    const dirAbs = this.assertNoSymlink(projectPath);
    if (!existsSync(dirAbs) || !lstatSync(dirAbs).isDirectory()) {
      throw new WorkspaceError(
        `project "${projectPath}" was not found`,
        404,
        "not_found",
      );
    }

    const manifestRel = `${projectPath}/${PROJECT_MANIFEST_FILENAME}`;
    const manifestAbs = join(dirAbs, PROJECT_MANIFEST_FILENAME);
    if (!existsSync(manifestAbs)) {
      throw new WorkspaceError(
        `directory "${projectPath}" does not have a ${PROJECT_MANIFEST_FILENAME}`,
        404,
        "not_a_project",
      );
    }

    const manifestRaw = readFileSync(manifestAbs, "utf-8");
    const parsedManifest = parseProjectManifest(manifestRaw);
    const fallbackName =
      (projectPath.split("/").at(-1) ?? projectPath)
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase()) || projectPath;
    const manifest: ProjectManifest = parsedManifest.manifest ?? {
      version: 1,
      project: {
        id: projectPath.split("/").at(-1) ?? projectPath,
        name: fallbackName,
      },
      data: {},
      ui: { entry: DEFAULT_PROJECT_UI_ENTRY },
    };

    const renderErrors: string[] = [];
    const manifestVal = validateProjectManifest(
      this.workspaceRoot,
      manifestRel,
      manifestRaw,
    );
    this.validateWithMaintainer(manifestRel, manifestRaw);
    for (const err of parsedManifest.errors) {
      renderErrors.push(`manifest: ${err}`);
    }
    for (const err of manifestVal.errors) {
      const formatted = `manifest: ${err}`;
      if (!renderErrors.includes(formatted)) {
        renderErrors.push(formatted);
      }
    }

    const uiEntry = manifest.ui.entry || DEFAULT_PROJECT_UI_ENTRY;
    const uiRel = `${projectPath}/${uiEntry}`;
    const uiAbs = resolve(dirAbs, uiEntry);
    let uiContent = "";
    if (uiAbs.startsWith(dirAbs + sep) && existsSync(uiAbs)) {
      try {
        uiContent = readFileSync(uiAbs, "utf-8");
        const uiVal = this.validateWithMaintainer(uiRel, uiContent);
        for (const err of uiVal.errors) {
          if (err.startsWith("openui") || err.includes("must not be empty")) {
            renderErrors.push(`ui: ${err}`);
          }
        }
      } catch {}
    } else {
      renderErrors.push(
        `ui: entry file '${uiEntry}' is missing in '${projectPath}'`,
      );
    }
    const renderable = renderErrors.length === 0 && Boolean(uiContent.trim());

    const templateInfo = findDomainTemplate(
      this.workspaceRoot,
      `${projectPath}/dummy.md`,
    );
    const templateRel = manifest.data.template
      ? `${projectPath}/${manifest.data.template}`
      : templateInfo?.templateRelativePath;
    const schemaRel = manifest.data.schema
      ? `${projectPath}/${manifest.data.schema}`
      : templateInfo?.schemaRelativePath;

    let schemaJson: Record<string, unknown> | undefined;
    if (schemaRel) {
      const schemaAbs = resolve(this.workspaceRoot, schemaRel);
      if (this.insideWorkspace(schemaAbs) && existsSync(schemaAbs)) {
        try {
          const parsed = JSON.parse(readFileSync(schemaAbs, "utf-8"));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            schemaJson = parsed as Record<string, unknown>;
          }
        } catch {}
      }
    }

    let templateHeadings: string[] | undefined;
    if (templateRel) {
      const tplAbs = resolve(this.workspaceRoot, templateRel);
      if (this.insideWorkspace(tplAbs) && existsSync(tplAbs)) {
        try {
          const tplRaw = readFileSync(tplAbs, "utf-8");
          const { body } = parseRecordFrontmatter(tplRaw);
          templateHeadings = extractHeadings(body)
            .filter((h) => h.level === 2)
            .map((h) => h.text.trim())
            .filter(Boolean);
        } catch {}
      }
    }

    const excluded = new Set(
      (manifest.data.exclude ?? ["README.md"]).map((s) => s.toLowerCase()),
    );
    const records: WorkspaceDomainRecordSummary[] = [];
    const projectFiles: WorkspaceFileMetadata[] = [];
    let invalidCount = 0;

    let entries: Dirent<string>[] = [];
    try {
      entries = readdirSync(dirAbs, { encoding: "utf8", withFileTypes: true });
    } catch {}

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fname = entry.name;
      if (fname.startsWith(".")) continue;
      const relPath = `${projectPath}/${fname}`;
      if (protectedPath(relPath)) continue;

      const absPath = join(dirAbs, fname);
      let info: Stats;
      try {
        info = lstatSync(absPath);
        if (info.isSymbolicLink() || !info.isFile()) continue;
      } catch {
        continue;
      }

      const lower = fname.toLowerCase();
      const isTemplateFile =
        lower.endsWith("-template.md") ||
        (manifest.data.template &&
          lower === manifest.data.template.toLowerCase());
      const isExcludedMd =
        lower === "readme.md" || excluded.has(lower) || isTemplateFile;

      if (!lower.endsWith(".md") || isExcludedMd) {
        try {
          const rawBytes = readFileSync(absPath);
          projectFiles.push({
            ...this.fileMetadata(absPath, relPath),
            revision: revision(rawBytes),
          });
        } catch {}
        continue;
      }

      try {
        const rawBytes = readFileSync(absPath);
        const content = new TextDecoder("utf-8").decode(rawBytes);
        const parsed = parseRecordFrontmatter(content);
        const headings = extractHeadings(parsed.body);
        const l1 = headings.find((h) => h.level === 1)?.text.trim();
        const title =
          l1 ||
          (typeof parsed.metadata?.title === "string"
            ? parsed.metadata.title
            : "") ||
          fname.replace(/\.md$/i, "");
        const sections = headings
          .filter((h) => h.level === 2)
          .map((h) => h.text.trim())
          .filter(Boolean);

        const excerptLines = parsed.body
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(
            (l) =>
              l.length > 0 &&
              !l.startsWith("#") &&
              !l.startsWith("---") &&
              !l.startsWith("```"),
          );
        const excerpt = excerptLines.slice(0, 2).join(" ").slice(0, 220);

        const recRev = revision(rawBytes);
        const validation = this.validateWithMaintainer(
          relPath,
          content,
          recRev,
        );
        if (!validation.valid) {
          invalidCount++;
        }

        const fm: Record<string, unknown> = {};
        if (parsed.metadata) {
          for (const [k, v] of Object.entries(parsed.metadata)) {
            if (k !== "$schema") fm[k] = v;
          }
        }

        records.push({
          path: relPath,
          filename: fname,
          title,
          modified_at: info.mtime.toISOString(),
          size: info.size,
          revision: recRev,
          frontmatter: fm,
          sections,
          excerpt,
          validation,
        });
      } catch {}
    }

    if (manifest.data.default_sort?.field) {
      const sortField = manifest.data.default_sort.field;
      const dir = manifest.data.default_sort.direction === "desc" ? -1 : 1;
      records.sort((a, b) => {
        const va = getRecordFieldValue(a, sortField);
        const vb = getRecordFieldValue(b, sortField);
        if (va === undefined || va === null || va === "") return 1;
        if (vb === undefined || vb === null || vb === "") return -1;
        return String(va).localeCompare(String(vb)) * dir;
      });
    } else {
      records.sort((a, b) => a.path.localeCompare(b.path));
    }

    projectFiles.sort((a, b) => a.path.localeCompare(b.path));

    const queries = evaluateProjectQueries(records, manifest.data.queries);

    const summary: ProjectSummary = {
      path: projectPath,
      id: manifest.project.id,
      name: manifest.project.name,
      ...(manifest.project.description
        ? { description: manifest.project.description }
        : {}),
      ...(manifest.project.icon ? { icon: manifest.project.icon } : {}),
      manifest_path: manifestRel,
      ui_path: uiRel,
      ...(templateRel ? { template_path: templateRel } : {}),
      ...(schemaRel ? { schema_path: schemaRel } : {}),
      skills: manifest.logic?.skills ?? [],
      record_count: records.length,
      invalid_record_count: invalidCount,
      renderable,
      ...(renderErrors.length > 0 ? { render_errors: renderErrors } : {}),
    };

    return {
      schema: 1,
      project: summary,
      manifest,
      manifest_raw: manifestRaw,
      ui_content: uiContent,
      records,
      queries,
      ...(schemaJson ? { schema_json: schemaJson } : {}),
      ...(templateHeadings ? { template_headings: templateHeadings } : {}),
      project_files: projectFiles,
      renderable,
      ...(renderErrors.length > 0 ? { render_errors: renderErrors } : {}),
    };
  }

  createFile(
    domainValue: unknown,
    nameValue: unknown,
    options?: {
      starter_id?: string | undefined;
      title?: string | undefined;
      frontmatter?: Record<string, unknown> | undefined;
      sections?: Record<string, string> | undefined;
      content?: string | undefined;
    },
  ): WorkspaceFile {
    if (typeof domainValue !== "string" || !domainValue.trim()) {
      throw new WorkspaceError(
        "domain must be a non-empty string",
        400,
        "invalid_domain",
      );
    }
    const domain = domainValue
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (
      domain.includes("..") ||
      domain
        .split("/")
        .some((seg) => !seg || seg.startsWith(".") || seg === ".openlia")
    ) {
      throw new WorkspaceError(
        `domain "${domain}" does not allow file creation`,
        403,
        "domain_not_allowed",
      );
    }
    if (creationDisallowedDomains.has(domain)) {
      throw new WorkspaceError(
        `domain "${domain}" does not allow file creation`,
        403,
        "domain_not_allowed",
      );
    }
    const builtin = getBuiltinDomainContract(domain);
    const allowed = this.creatableDomains();
    let matchedDomain = allowed.find((d) => d.path === domain);
    if (!matchedDomain) {
      const manifestAbs = resolve(
        this.workspaceRoot,
        domain,
        PROJECT_MANIFEST_FILENAME,
      );
      if (this.insideWorkspace(manifestAbs) && existsSync(manifestAbs)) {
        try {
          const { manifest } = parseProjectManifest(
            readFileSync(manifestAbs, "utf-8"),
          );
          if (manifest) {
            matchedDomain = {
              path: domain,
              label: manifest.project.name,
              ...(manifest.data.template
                ? { template_path: `${domain}/${manifest.data.template}` }
                : {}),
            };
          }
        } catch {}
      }
    }
    if (!matchedDomain) {
      const tplInfo = findDomainTemplate(
        this.workspaceRoot,
        `${domain}/placeholder.md`,
      );
      matchedDomain = {
        path: domain,
        label: builtin?.label ?? domain.split("/").at(-1) ?? domain,
        ...(tplInfo
          ? { template_path: tplInfo.templateRelativePath }
          : builtin?.template_path
            ? { template_path: builtin.template_path }
            : {}),
      };
    }

    if (typeof nameValue !== "string" || !nameValue.trim()) {
      throw new WorkspaceError(
        "name must be a non-empty string",
        400,
        "invalid_filename",
      );
    }
    let filename = nameValue.trim().replace(/^\/+|\/+$/g, "");
    const allowNestedPath = matchedDomain.path === "knowledge";
    if (
      filename.includes("\\") ||
      filename.includes("..") ||
      (!allowNestedPath && filename.includes("/")) ||
      (allowNestedPath &&
        filename
          .split("/")
          .some((seg) => !seg || seg === "." || seg.startsWith(".")))
    ) {
      throw new WorkspaceError(
        "filename cannot contain path separators",
        400,
        "invalid_filename",
      );
    }
    const baseFilename = filename.split("/").at(-1) ?? filename;
    if (
      baseFilename.endsWith("-template.md") ||
      baseFilename.endsWith(".schema.json") ||
      baseFilename.endsWith(".openui")
    ) {
      throw new WorkspaceError(
        "filename cannot use protected template or schema name",
        400,
        "invalid_filename",
      );
    }
    if (!filename.toLowerCase().endsWith(".md")) {
      filename = `${filename}.md`;
    }

    const relativePath = `${matchedDomain.path}/${filename}`;
    const absolute = resolve(this.workspaceRoot, relativePath);
    if (existsSync(absolute)) {
      throw new WorkspaceError(
        `file "${relativePath}" already exists`,
        409,
        "destination_exists",
      );
    }

    // Determine template content
    let templateContent = "";
    let templateAbsolute: string | null = null;
    if (matchedDomain.template_path) {
      const candidate = resolve(
        this.workspaceRoot,
        matchedDomain.template_path,
      );
      if (existsSync(candidate)) {
        templateAbsolute = candidate;
      }
    }
    if (!templateAbsolute) {
      const info = findDomainTemplate(this.workspaceRoot, relativePath);
      if (info) {
        templateAbsolute = resolve(
          this.workspaceRoot,
          info.templateRelativePath,
        );
      }
    }

    const defaultTitle =
      options?.title?.trim() ||
      (filename.split("/").at(-1) ?? filename).replace(/\.md$/i, "");

    if (typeof options?.content === "string" && options.content.trim()) {
      templateContent = options.content;
    } else if (options?.starter_id && builtin?.starter_templates) {
      const starter = builtin.starter_templates.find(
        (s) => s.id === options.starter_id,
      );
      templateContent =
        starter?.template_content ??
        builtin.template_content ??
        `# ${defaultTitle}\n`;
    } else if (templateAbsolute && existsSync(templateAbsolute)) {
      templateContent = readFileSync(templateAbsolute, "utf-8");
    } else if (builtin?.template_content) {
      templateContent = builtin.template_content;
    } else {
      templateContent = `# ${defaultTitle}\n`;
    }

    // Replace H1 title if explicitly provided (or when using a built-in starter with a placeholder H1)
    if (options?.title?.trim() || templateContent.includes("# <")) {
      templateContent = templateContent.replace(
        /^([ \t]{0,3}#[ \t]+)(.+?)$/m,
        `$1${defaultTitle}`,
      );
    }

    // Apply structured frontmatter overrides if provided
    if (
      options?.frontmatter &&
      typeof options.frontmatter === "object" &&
      !Array.isArray(options.frontmatter) &&
      Object.keys(options.frontmatter).length > 0 &&
      options?.starter_id !== "blank-note"
    ) {
      templateContent = mutateRecordFrontmatter(
        templateContent,
        options.frontmatter,
      );
    }

    // Apply structured section overrides if provided
    if (
      options?.sections &&
      typeof options.sections === "object" &&
      !Array.isArray(options.sections)
    ) {
      for (const [heading, body] of Object.entries(options.sections)) {
        if (typeof body === "string") {
          templateContent = updateRecordSectionContent(
            templateContent,
            heading,
            body,
          );
        }
      }
    }

    // Perform atomic write with expectedRevision for empty file
    const emptyRevision = revision(new Uint8Array());
    this.write(relativePath, templateContent, emptyRevision);
    return this.read(relativePath);
  }

  private executeMoveOrRename(
    sourcePath: string,
    destinationPath: string,
    expectedValue: unknown,
  ): WorkspaceMoveResponse {
    const sourceAbsolute = this.assertNoSymlink(sourcePath);
    const destAbsolute = this.assertNoSymlink(destinationPath);

    let info: Stats;
    try {
      info = lstatSync(sourceAbsolute);
    } catch (error) {
      throw this.mapFilesystemError(error, "source file was not found");
    }
    if (!info.isFile()) {
      throw new WorkspaceError(
        "workspace path is not a regular file",
        400,
        "not_a_file",
      );
    }

    if (existsSync(destAbsolute)) {
      throw new WorkspaceError(
        "destination file already exists",
        409,
        "destination_exists",
      );
    }

    let contents: Uint8Array;
    try {
      contents = readFileSync(sourceAbsolute);
    } catch (error) {
      throw this.mapFilesystemError(error, "source file was not found");
    }
    const currentRevision = revision(contents);
    if (
      typeof expectedValue !== "string" ||
      expectedValue !== currentRevision
    ) {
      throw new WorkspaceError(
        "revision conflict",
        409,
        "revision_conflict",
        currentRevision,
      );
    }

    const destParent = dirname(destAbsolute);
    mkdirSync(destParent, { recursive: true, mode: 0o700 });

    try {
      const beforeMove = readFileSync(sourceAbsolute);
      if (revision(beforeMove) !== currentRevision) {
        throw new WorkspaceError(
          "revision conflict",
          409,
          "revision_conflict",
          revision(beforeMove),
        );
      }
      renameSync(sourceAbsolute, destAbsolute);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw this.mapFilesystemError(error, "operation failed");
    }

    let textContent = "";
    try {
      textContent = new TextDecoder("utf-8").decode(contents);
    } catch {}

    this.maintainer.db.markFileDeleted(this.maintainer.workspaceId, sourcePath);
    const validation = this.validateWithMaintainer(
      destinationPath,
      textContent,
      currentRevision,
    );

    return {
      schema: 1,
      ok: true,
      previous_path: sourcePath,
      revision: currentRevision,
      validation,
      ...this.fileMetadata(destAbsolute, destinationPath),
    };
  }

  download(pathValue: unknown): {
    path: string;
    absolute: string;
    filename: string;
    size: number;
  } {
    const path = validateRelativePath(pathValue, this.settings());
    const absolute = this.assertNoSymlink(path);
    let info: Stats | undefined;
    try {
      info = lstatSync(absolute);
    } catch (error) {
      throw this.mapFilesystemError(error, "workspace file was not found");
    }
    if (!info.isFile())
      throw new WorkspaceError(
        "workspace path is not a file",
        400,
        "not_a_file",
      );
    if (info.size > this.maxDownloadBytes) {
      throw new WorkspaceError(
        "file is too large to download",
        413,
        "download_too_large",
      );
    }
    return {
      path,
      absolute,
      filename: (path.split("/").at(-1) ?? "download").replaceAll(
        /["\r\n]/g,
        "",
      ),
      size: info.size,
    };
  }

  metadata(pathValue: unknown): WorkspaceFileMetadata {
    const file = this.download(pathValue);
    const contents = readFileSync(file.absolute);
    return {
      ...this.fileMetadata(file.absolute, file.path),
      revision: revision(contents),
    };
  }

  async gitStatus(): Promise<WorkspaceGitStatus> {
    if (!existsSync(join(this.workspaceRoot, ".git")))
      return { schema: 1, configured: false };
    const result = Bun.spawnSync(
      ["git", "-C", this.workspaceRoot, "status", "--short", "--branch"],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    if (result.exitCode !== 0) return { schema: 1, configured: false };
    const status = new TextDecoder().decode(result.stdout).trim();
    const lines = status ? status.split("\n") : [];
    const branch = lines[0]?.replace(/^##\s*/, "") ?? "";
    return {
      schema: 1,
      configured: true,
      branch,
      dirty: lines.some((line) => /^\s*[MADRCU?!]/.test(line)),
    };
  }

  async activity(limit = 20): Promise<WorkspaceActivityResponse> {
    const settings = this.settings();
    const gitDir = join(this.workspaceRoot, ".git");
    const gitConfigured = existsSync(gitDir);
    let branch: string | undefined;
    const uncommitted: WorkspaceUncommittedChange[] = [];
    const commits: WorkspaceCommit[] = [];

    if (gitConfigured) {
      const statusResult = Bun.spawnSync(
        ["git", "-C", this.workspaceRoot, "status", "--short", "--branch"],
        {
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      if (statusResult.exitCode === 0) {
        const statusOutput = new TextDecoder()
          .decode(statusResult.stdout)
          .trim();
        const lines = statusOutput ? statusOutput.split("\n") : [];
        if (lines[0]?.startsWith("##")) {
          branch = lines[0]
            .replace(/^##\s*/, "")
            .split("...")[0]
            ?.trim();
        }
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]?.trimEnd();
          if (!line) continue;
          const statusChar = line.slice(0, 2).trim();
          const filePath = line
            .slice(3)
            .trim()
            .replace(/^"(.*)"$/, "$1");
          if (
            protectedPath(filePath) ||
            hiddenFromNavigator(filePath, settings)
          )
            continue;
          let status: WorkspaceUncommittedChange["status"] = "modified";
          if (statusChar === "??" || statusChar === "A") status = "added";
          else if (statusChar === "D") status = "deleted";
          else if (
            statusChar === "M" ||
            statusChar === "MM" ||
            statusChar === "AM"
          )
            status = "modified";
          else status = "untracked";
          uncommitted.push({ path: filePath, status });
        }
      }

      const logResult = Bun.spawnSync(
        [
          "git",
          "-C",
          this.workspaceRoot,
          "log",
          `-n${limit}`,
          "--name-status",
          "--format=openlia-commit:%H%x00%h%x00%an%x00%aI%x00%s",
        ],
        {
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      if (logResult.exitCode === 0) {
        const logOutput = new TextDecoder().decode(logResult.stdout);
        const rawBlocks = logOutput.split("openlia-commit:").filter(Boolean);
        for (const block of rawBlocks) {
          const lines = block.split("\n");
          const header = lines[0];
          if (!header) continue;
          const [hash, shortHash, author, timestamp, message] =
            header.split("\0");
          if (!hash || !shortHash || !message || !timestamp) continue;
          const files: WorkspaceCommitChange[] = [];
          for (let j = 1; j < lines.length; j++) {
            const line = lines[j]?.trim();
            if (!line) continue;
            const parts = line.split(/\t+/);
            const statusType = parts[0]?.trim();
            const filePath = (parts[1] || "").replace(/^"(.*)"$/, "$1");
            if (!statusType || !filePath) continue;
            if (
              protectedPath(filePath) ||
              hiddenFromNavigator(filePath, settings)
            )
              continue;
            let fileStatus: WorkspaceCommitChange["status"] = "modified";
            if (statusType.startsWith("A")) fileStatus = "added";
            else if (statusType.startsWith("D")) fileStatus = "deleted";
            else if (statusType.startsWith("R")) fileStatus = "renamed";
            files.push({ path: filePath, status: fileStatus });
          }
          commits.push({
            author: author || "Unknown",
            files,
            hash,
            message,
            shortHash,
            timestamp,
          });
        }
      }
    }

    const tree = this.tree();
    const filesOnly: WorkspaceFileMetadata[] = [];
    for (const entry of tree.entries) {
      if (entry.kind === "file") {
        filesOnly.push({
          editable: entry.editable,
          modified_at: entry.modified_at,
          path: entry.path,
          size: entry.size,
        });
      }
    }
    filesOnly.sort(
      (a, b) =>
        new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime(),
    );
    const recentFiles = filesOnly.slice(0, limit);

    const response: WorkspaceActivityResponse = {
      commits,
      gitConfigured,
      recentFiles,
      schema: 1,
      uncommitted,
    };
    if (branch !== undefined) response.branch = branch;
    return response;
  }

  private fileMetadata(path: string, relativePath: string) {
    const info = statSync(path);
    return {
      path: relativePath,
      size: info.size,
      modified_at: info.mtime.toISOString(),
      editable:
        editableExtensions.has(fileExtension(relativePath)) &&
        info.size <= this.maxEditableBytes,
    };
  }

  private assertNoSymlink(relativePath: string): string {
    const absolute = resolve(this.workspaceRoot, relativePath);
    if (!this.insideWorkspace(absolute)) {
      throw new WorkspaceError(
        "workspace path is outside the workspace",
        400,
        "invalid_path",
      );
    }
    let current = this.workspaceRoot;
    for (const part of relativePath.split("/")) {
      current = join(current, part);
      if (!existsSync(current)) continue;
      const info = lstatSync(current);
      if (info.isSymbolicLink()) {
        throw new WorkspaceError(
          "workspace symlinks are not supported",
          403,
          "symlink_not_allowed",
        );
      }
    }
    return absolute;
  }

  private insideWorkspace(path: string): boolean {
    const candidate = resolve(path);
    return (
      candidate === this.workspaceRoot ||
      candidate.startsWith(this.workspaceRoot + sep)
    );
  }

  private mapFilesystemError(error: unknown, fallback: string): WorkspaceError {
    const code = asNodeError(error).code;
    if (code === "ENOENT")
      return new WorkspaceError(fallback, 404, "not_found");
    if (code === "EACCES" || code === "EPERM")
      return new WorkspaceError(
        "workspace access denied",
        403,
        "access_denied",
      );
    return new WorkspaceError(
      "workspace operation failed",
      500,
      "workspace_operation_failed",
    );
  }
}
