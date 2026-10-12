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
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceGitStatus,
  WorkspaceMoveResponse,
  WorkspaceRenameResponse,
  WorkspaceSettings,
  WorkspaceTreeResponse,
  WorkspaceUncommittedChange,
  WorkspaceWriteResponse,
} from "../shared/api";
import { validateEntireWorkspace, validateRecordContent } from "./validator";
import YAML from "yaml";
import { MEMORY_DOCUMENT_PREFIX } from "../shared/memory";

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
  "projects/project-template.md",
  "shopping/item-template.md",
  "tasks/task-template.md",
  "travel/trip-template.md",
]);

const configurationBasenames = new Set([
  "assistant-policy.schema.json",
  "assistant-policy.yaml",
  "workspace.schema.json",
  "workspace.yaml",
  WORKSPACE_SETTINGS_FILE,
]);

export interface WorkspaceServiceOptions {
  workspaceRoot: string;
  maxEditableBytes?: number;
  maxDownloadBytes?: number;
  maxTreeEntries?: number;
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

  constructor(options: WorkspaceServiceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.maxEditableBytes =
      options.maxEditableBytes ?? DEFAULT_MAX_EDITABLE_BYTES;
    this.maxDownloadBytes =
      options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.maxTreeEntries = options.maxTreeEntries ?? DEFAULT_MAX_TREE_ENTRIES;
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
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
          entries.push({ path, kind: "directory" });
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
    const validation = validateRecordContent(this.workspaceRoot, path, text);
    return {
      schema: 1,
      content: text,
      revision: revision(contents),
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
    const validation = validateRecordContent(
      this.workspaceRoot,
      path,
      contentValue,
    );
    return {
      schema: 1,
      ok: true,
      revision: revision(contents),
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
    return validateEntireWorkspace(this.workspaceRoot);
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

    const validation = validateRecordContent(
      this.workspaceRoot,
      destinationPath,
      textContent,
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
    return this.fileMetadata(file.absolute, file.path);
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
