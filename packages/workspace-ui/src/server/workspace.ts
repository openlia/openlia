import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
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
import YAML from "yaml";
import {
  mutateRecordFrontmatter,
  parseMarkdownRecord,
  updateRecordSectionContent,
} from "../client/openui/recordMutator";
import type {
  WorkspaceActivityResponse,
  WorkspaceCommit,
  WorkspaceCommitChange,
  WorkspaceDeleteResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceDomainInfo,
  WorkspaceDomainRecordSummary,
  WorkspaceDomainRecordsResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceFileValidation,
  WorkspaceGitStatus,
  WorkspaceMoveResponse,
  WorkspaceRenameResponse,
  WorkspaceSettings,
  WorkspaceTreeResponse,
  WorkspaceUncommittedChange,
  WorkspaceWriteResponse,
} from "../shared/api";
import {
  BUILTIN_DOMAIN_CONTRACTS,
  getBuiltinDomainContract,
  mergeBuiltinSchemaProperties,
} from "../shared/domainContracts";
import { MEMORY_DOCUMENT_PREFIX } from "../shared/memory";
import { evaluateFileFindings, MaintainerService } from "./maintainer/engine";
import {
  extractHeadings,
  findDomainTemplate,
  parseRecordFrontmatter,
  validateEntireWorkspace,
  validateRecordContent,
} from "./validator";

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

const minionCodeExtensions = new Set([".py", ".ts", ".js", ".sh", ".bash"]);

function isEditablePath(relativePath: string): boolean {
  const ext = fileExtension(relativePath);
  if (editableExtensions.has(ext)) return true;
  if (relativePath.startsWith("minions/") && minionCodeExtensions.has(ext)) {
    return true;
  }
  return false;
}

const protectedDirectoryNames = new Set([
  "browser-profile",
  "cache",
  "logs",
  "mcp-tokens",
  "node_modules",
  "pairing",
  "sessions",
  "__pycache__",
  ".venv",
  ".pytest_cache",
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
  if (normalized.startsWith("minions/")) return false;
  const basename = normalized.split("/").at(-1) ?? "";
  return (
    basename.endsWith("-template.md") ||
    basename.endsWith(".schema.json") ||
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
  if (hiddenFromNavigator(normalized, settings)) {
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
      const contractFindings = openFindings.filter(
        (f) => f.rule_code !== "openui_syntax_error",
      );
      const warnings = openFindings
        .filter((f) => f.rule_code === "openui_syntax_error")
        .map((f) => f.message);
      return {
        valid: contractFindings.length === 0,
        errors: contractFindings.map((f) => f.message),
        ...(warnings.length ? { warnings } : {}),
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
          entries.push({
            path,
            kind: "directory",
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
    createOnly = false,
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

    if (!isEditablePath(path)) {
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
      if (createOnly)
        throw new WorkspaceError(
          "destination already exists",
          409,
          "destination_exists",
        );
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
      if (createOnly) {
        // Publish a complete file atomically, without replacing even a concurrent empty file.
        linkSync(temporary, absolute);
        unlinkSync(temporary);
      } else renameSync(temporary, absolute);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      if (createOnly && asNodeError(error).code === "EEXIST")
        throw new WorkspaceError(
          "destination already exists",
          409,
          "destination_exists",
        );
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
    if (!isEditablePath(destinationPath)) {
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
    if (!isEditablePath(destinationPath)) {
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

            byPath.set(domainPath, {
              path: domainPath,
              label: typeof item.label === "string" ? item.label : domainPath,
              purpose:
                typeof item.purpose === "string" ? item.purpose : undefined,
              template_path: templateRel,
              ...(info?.schemaRelativePath
                ? { schema_path: info.schemaRelativePath }
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
        col.record_count === 0
      ) {
        continue;
      }
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
        kind: col.kind === "core" ? "core" : "extension",
      });
    }

    if (byPath.size > 0) {
      return [...byPath.values()];
    }

    return DEFAULT_CREATABLE_DOMAINS;
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
      };
    } else {
      const schRel = templateInfo?.schemaRelativePath ?? builtin?.schema_path;
      domainInfo = {
        ...domainInfo,
        ...(schRel && !domainInfo.schema_path ? { schema_path: schRel } : {}),
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
        ...(tplInfo?.schemaRelativePath
          ? { schema_path: tplInfo.schemaRelativePath }
          : builtin?.schema_path
            ? { schema_path: builtin.schema_path }
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
      baseFilename.endsWith(".schema.json")
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

    // Prefill frontmatter from domain schema (if present on disk) for any missing schema properties
    if (
      typeof options?.content !== "string" &&
      options?.starter_id !== "blank-note"
    ) {
      let schemaAbsolute: string | null = null;
      if (matchedDomain.schema_path) {
        const candidate = resolve(
          this.workspaceRoot,
          matchedDomain.schema_path,
        );
        if (this.insideWorkspace(candidate) && existsSync(candidate)) {
          schemaAbsolute = candidate;
        }
      }
      if (!schemaAbsolute) {
        const tplInfo = findDomainTemplate(this.workspaceRoot, relativePath);
        if (
          tplInfo?.schemaAbsolutePath &&
          existsSync(tplInfo.schemaAbsolutePath)
        ) {
          schemaAbsolute = tplInfo.schemaAbsolutePath;
        }
      }
      if (!schemaAbsolute) {
        const domainDirAbs = resolve(this.workspaceRoot, matchedDomain.path);
        if (this.insideWorkspace(domainDirAbs) && existsSync(domainDirAbs)) {
          try {
            const schemaEntries = readdirSync(domainDirAbs, {
              withFileTypes: true,
            }).filter(
              (entry) =>
                entry.isFile() &&
                entry.name.endsWith(".schema.json") &&
                !entry.name.startsWith("."),
            );
            if (schemaEntries.length === 1 && schemaEntries[0]) {
              schemaAbsolute = join(domainDirAbs, schemaEntries[0].name);
            }
          } catch {}
        }
      }

      if (schemaAbsolute && existsSync(schemaAbsolute)) {
        try {
          const parsedSchema = JSON.parse(
            readFileSync(schemaAbsolute, "utf-8"),
          );
          if (
            parsedSchema &&
            typeof parsedSchema === "object" &&
            !Array.isArray(parsedSchema) &&
            parsedSchema.properties &&
            typeof parsedSchema.properties === "object" &&
            !Array.isArray(parsedSchema.properties)
          ) {
            const parsedRecord = parseMarkdownRecord(templateContent);
            const existingMeta = parsedRecord.metadata;
            const schemaDefaults: Record<string, unknown> = {};

            if (!existingMeta.$schema) {
              const relSchemaRaw = relative(
                dirname(absolute),
                schemaAbsolute,
              ).replaceAll("\\", "/");
              schemaDefaults.$schema = relSchemaRaw.startsWith(".")
                ? relSchemaRaw
                : `./${relSchemaRaw}`;
            }

            const requiredSet = new Set<string>(
              Array.isArray(parsedSchema.required)
                ? parsedSchema.required.filter(
                    (r: unknown): r is string => typeof r === "string",
                  )
                : [],
            );
            const allowsType = (
              prop: Record<string, unknown>,
              target: string,
            ): boolean => {
              if (typeof prop.type === "string") return prop.type === target;
              if (Array.isArray(prop.type)) return prop.type.includes(target);
              return false;
            };
            const allowsNull = (prop: Record<string, unknown>): boolean => {
              if (!prop.type) return true;
              if (allowsType(prop, "null")) return true;
              if (Array.isArray(prop.enum) && prop.enum.includes(null))
                return true;
              return false;
            };

            const props = parsedSchema.properties as Record<string, unknown>;
            for (const [propKey, rawProp] of Object.entries(props)) {
              if (propKey === "$schema" || existingMeta[propKey] !== undefined)
                continue;
              if (
                !rawProp ||
                typeof rawProp !== "object" ||
                Array.isArray(rawProp)
              ) {
                schemaDefaults[propKey] = null;
                continue;
              }
              const prop = rawProp as Record<string, unknown>;
              if (prop.default !== undefined) {
                schemaDefaults[propKey] = prop.default;
              } else if (
                builtin?.template_defaults &&
                propKey in builtin.template_defaults &&
                (builtin.template_defaults[propKey] !== null ||
                  allowsNull(prop))
              ) {
                schemaDefaults[propKey] = builtin.template_defaults[propKey];
              } else if (Array.isArray(prop.enum) && prop.enum.length > 0) {
                if (requiredSet.has(propKey) || !allowsNull(prop)) {
                  schemaDefaults[propKey] =
                    prop.enum.find((v) => v !== null) ?? prop.enum[0];
                } else {
                  schemaDefaults[propKey] = null;
                }
              } else if (allowsType(prop, "array")) {
                schemaDefaults[propKey] = [];
              } else if (allowsNull(prop)) {
                schemaDefaults[propKey] = null;
              } else if (allowsType(prop, "boolean")) {
                schemaDefaults[propKey] = false;
              } else if (
                allowsType(prop, "number") ||
                allowsType(prop, "integer")
              ) {
                schemaDefaults[propKey] = 0;
              } else {
                schemaDefaults[propKey] = "";
              }
            }

            if (Object.keys(schemaDefaults).length > 0) {
              templateContent = mutateRecordFrontmatter(
                templateContent,
                schemaDefaults,
              );
            }
          }
        } catch {}
      }
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

  /** Narrow read-only access to a collection's hidden local contract, not arbitrary hidden files. */
  collectionContract(collection: string): {
    templatePath: string;
    schemaPath: string;
    template: string;
    schema: string;
    revision: string;
  } {
    validateRelativePath(`${collection}/record.md`, this.settings());
    this.assertNoSymlink(`${collection}/record.md`);
    const info = findDomainTemplate(
      this.workspaceRoot,
      `${collection}/record.md`,
    );
    if (!info || info.error || !info.schemaRelativePath)
      throw new WorkspaceError(
        "The local collection contract is missing or invalid.",
        422,
        "contract_unavailable",
      );
    if (
      protectedPath(info.schemaRelativePath) ||
      !info.schemaRelativePath.startsWith(`${collection}/`) ||
      !info.schemaRelativePath.endsWith(".schema.json")
    )
      throw new WorkspaceError(
        "Contract schemas must be local to the collection.",
        422,
        "contract_unavailable",
      );
    const read = (path: string) => {
      const absolute = this.assertNoSymlink(path);
      const stats = lstatSync(absolute);
      if (!stats.isFile() || stats.size > 64 * 1024)
        throw new WorkspaceError(
          "Contract exceeds the supported size.",
          422,
          "contract_unavailable",
        );
      return readFileSync(absolute, "utf8");
    };
    const template = read(info.templateRelativePath);
    const schema = read(info.schemaRelativePath);
    return {
      templatePath: info.templateRelativePath,
      schemaPath: info.schemaRelativePath,
      template,
      schema,
      revision: revision(
        new TextEncoder().encode(
          `${info.templateRelativePath}\0${template}\0${info.schemaRelativePath}\0${schema}`,
        ),
      ),
    };
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
        isEditablePath(relativePath) && info.size <= this.maxEditableBytes,
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
