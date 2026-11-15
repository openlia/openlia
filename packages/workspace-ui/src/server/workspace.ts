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
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  WorkspaceDeleteResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceMoveResponse,
  WorkspaceRenameResponse,
  WorkspaceTreeEntry,
  WorkspaceTreeResponse,
  WorkspaceUploadFileResponse,
  WorkspaceWriteResponse,
} from "../shared/api";

export const DEFAULT_MAX_EDITABLE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_TREE_ENTRIES = 10_000;

const editableExtensions = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
  ".json",
  ".jsonl",
  ".toml",
  ".csv",
  ".tsv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".ini",
  ".conf",
  ".cfg",
  ".env",
  ".log",
  ".rem",
  ".remind",
  ".journal",
  ".hledger",
]);

const binaryExtensions = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".flac",
  ".m4a",
  ".mp4",
  ".webm",
  ".mov",
  ".ogv",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".bin",
  ".iso",
  ".sqlite",
  ".db",
  ".wasm",
]);

const protectedDirectoryNames = new Set([
  ".git",
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

function fileExtension(relativePath: string): string {
  const base = relativePath.split("/").at(-1) ?? relativePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export function isKnownBinaryExtension(relativePath: string): boolean {
  const ext = fileExtension(relativePath);
  return binaryExtensions.has(ext);
}

export function isEditableExtension(relativePath: string): boolean {
  const ext = fileExtension(relativePath);
  if (binaryExtensions.has(ext)) return false;
  if (editableExtensions.has(ext)) return true;
  // Extensionless files (e.g. Makefile, Dockerfile, README) can be checked for UTF-8 text when read
  return ext === "";
}

function isValidUtf8Text(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function sha256Hex(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface WorkspaceServiceOptions {
  workspaceRoot: string;
  maxEditableBytes?: number | undefined;
  maxDownloadBytes?: number | undefined;
  maxTreeEntries?: number | undefined;
}

export class WorkspaceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly currentRevision?: string | undefined;

  constructor(
    message: string,
    status: number,
    code: string,
    currentRevision?: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.status = status;
    this.code = code;
    this.currentRevision = currentRevision;
  }
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
  }

  private normalizeRelativePath(rawPath: string): string {
    const trimmed = rawPath.trim().replace(/^\/+/, "");
    if (!trimmed) {
      throw new WorkspaceError("Path is required", 400, "invalid_path");
    }
    if (trimmed.includes("\0") || trimmed.includes("\\")) {
      throw new WorkspaceError("Invalid path characters", 400, "invalid_path");
    }
    const parts = trimmed.split("/");
    for (const part of parts) {
      if (!part || part === "." || part === "..") {
        throw new WorkspaceError(
          "Unsafe path component is not allowed",
          400,
          "invalid_path",
        );
      }
      if (protectedDirectoryNames.has(part.toLowerCase())) {
        throw new WorkspaceError(
          `Access to protected path "${part}" is not allowed`,
          403,
          "forbidden_path",
        );
      }
    }
    return parts.join("/");
  }

  private resolveSafePath(
    rawPath: string,
    options: { allowMissingLeaf?: boolean } = {},
  ): { relativePath: string; absolutePath: string } {
    const relativePath = this.normalizeRelativePath(rawPath);
    const absolutePath = resolve(this.workspaceRoot, relativePath);
    if (
      absolutePath !== this.workspaceRoot &&
      !absolutePath.startsWith(this.workspaceRoot + sep)
    ) {
      throw new WorkspaceError(
        "Path escapes workspace root",
        400,
        "invalid_path",
      );
    }

    if (existsSync(this.workspaceRoot)) {
      const rootStat = lstatSync(this.workspaceRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new WorkspaceError(
          "Workspace root must be a real directory",
          500,
          "invalid_workspace_root",
        );
      }
    }

    const parts = relativePath.split("/");
    let current = this.workspaceRoot;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? "";
      current = join(current, part);
      const isLeaf = i === parts.length - 1;
      if (!existsSync(current)) {
        if (isLeaf && options.allowMissingLeaf) {
          break;
        }
        continue;
      }
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new WorkspaceError(
          "Symlinks are not permitted in workspace paths",
          403,
          "symlink_forbidden",
        );
      }
      if (!isLeaf && !stat.isDirectory()) {
        throw new WorkspaceError(
          "Parent path component is not a directory",
          400,
          "invalid_path",
        );
      }
    }

    return { relativePath, absolutePath };
  }

  private isFileEditable(
    relativePath: string,
    stat: Stats,
    bytes?: Uint8Array,
  ): boolean {
    if (stat.size > this.maxEditableBytes) return false;
    if (isKnownBinaryExtension(relativePath)) return false;
    const ext = fileExtension(relativePath);
    if (editableExtensions.has(ext)) {
      return bytes ? isValidUtf8Text(bytes) : true;
    }
    if (bytes) {
      return isValidUtf8Text(bytes);
    }
    try {
      const fd = openSync(join(this.workspaceRoot, relativePath), "r");
      try {
        const sampleSize = Math.min(stat.size, 8192);
        const sample = new Uint8Array(sampleSize);
        const bytesRead = require("node:fs").readSync(
          fd,
          sample,
          0,
          sampleSize,
          0,
        ) as number;
        return isValidUtf8Text(sample.subarray(0, bytesRead));
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  listTree(): WorkspaceTreeResponse {
    const entries: WorkspaceTreeEntry[] = [];
    let truncated = false;

    if (!existsSync(this.workspaceRoot)) {
      return { schema: 1, ok: true, entries: [], truncated: false };
    }

    const walk = (dirAbsolute: string) => {
      if (truncated) return;
      let dirents: Dirent[];
      try {
        dirents = readdirSync(dirAbsolute, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));

      for (const dirent of dirents) {
        if (truncated) return;
        const name = dirent.name;
        const lower = name.toLowerCase();
        if (name.startsWith(".openlia-tmp-")) continue;
        if (navigationHiddenBasenames.has(lower)) continue;
        if (protectedDirectoryNames.has(lower)) continue;

        const fullPath = join(dirAbsolute, name);
        let stat: Stats;
        try {
          stat = lstatSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;

        const relPath = relative(this.workspaceRoot, fullPath)
          .split(sep)
          .join("/");

        if (stat.isDirectory()) {
          if (entries.length >= this.maxTreeEntries) {
            truncated = true;
            return;
          }
          entries.push({
            path: relPath,
            kind: "directory",
          });
          walk(fullPath);
        } else if (stat.isFile()) {
          if (entries.length >= this.maxTreeEntries) {
            truncated = true;
            return;
          }
          entries.push({
            path: relPath,
            kind: "file",
            size: stat.size,
            modified_at: stat.mtime.toISOString(),
            editable: this.isFileEditable(relPath, stat),
          });
        }
      }
    };

    walk(this.workspaceRoot);

    return {
      schema: 1,
      ok: true,
      entries,
      truncated,
    };
  }

  readFile(rawPath: string): WorkspaceFile {
    const { relativePath, absolutePath } = this.resolveSafePath(rawPath);
    if (!existsSync(absolutePath)) {
      throw new WorkspaceError("File not found", 404, "not_found");
    }
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) {
      throw new WorkspaceError("Target is not a regular file", 400, "not_file");
    }
    if (isKnownBinaryExtension(relativePath)) {
      throw new WorkspaceError(
        "Binary files are view-only and cannot be opened as text",
        415,
        "binary_file",
      );
    }
    if (stat.size > this.maxEditableBytes) {
      throw new WorkspaceError(
        `File exceeds maximum editable size (${this.maxEditableBytes} bytes)`,
        413,
        "file_too_large",
      );
    }
    const rawBytes = readFileSync(absolutePath);
    if (!isValidUtf8Text(rawBytes)) {
      throw new WorkspaceError(
        "File contains binary or non-UTF-8 content and is view-only",
        415,
        "binary_file",
      );
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    const revision = sha256Hex(rawBytes);

    return {
      schema: 1,
      ok: true,
      path: relativePath,
      content,
      size: stat.size,
      modified_at: stat.mtime.toISOString(),
      revision,
      editable: true,
    };
  }

  readFileMetadata(rawPath: string): WorkspaceFileMetadata {
    const { relativePath, absolutePath } = this.resolveSafePath(rawPath);
    if (!existsSync(absolutePath)) {
      throw new WorkspaceError("File not found", 404, "not_found");
    }
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) {
      throw new WorkspaceError("Target is not a regular file", 400, "not_file");
    }
    let revision = `${stat.size}:${stat.mtimeMs}`;
    let editable = false;
    if (stat.size <= this.maxEditableBytes) {
      const bytes = readFileSync(absolutePath);
      revision = sha256Hex(bytes);
      editable = this.isFileEditable(relativePath, stat, bytes);
    }
    return {
      schema: 1,
      ok: true,
      path: relativePath,
      size: stat.size,
      modified_at: stat.mtime.toISOString(),
      revision,
      editable,
    };
  }

  resolveDownloadFile(rawPath: string): {
    absolutePath: string;
    relativePath: string;
    size: number;
  } {
    const { relativePath, absolutePath } = this.resolveSafePath(rawPath);
    if (!existsSync(absolutePath)) {
      throw new WorkspaceError("File not found", 404, "not_found");
    }
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) {
      throw new WorkspaceError("Target is not a regular file", 400, "not_file");
    }
    if (stat.size > this.maxDownloadBytes) {
      throw new WorkspaceError(
        `File exceeds maximum download size (${this.maxDownloadBytes} bytes)`,
        413,
        "file_too_large",
      );
    }
    return { absolutePath, relativePath, size: stat.size };
  }

  writeFile(
    rawPath: string,
    content: string,
    expectedRevision: string,
  ): WorkspaceWriteResponse {
    const { relativePath, absolutePath } = this.resolveSafePath(rawPath);
    if (isKnownBinaryExtension(relativePath)) {
      throw new WorkspaceError(
        "Binary files are view-only and cannot be edited",
        403,
        "file_not_editable",
      );
    }
    if (!existsSync(absolutePath)) {
      throw new WorkspaceError("File not found", 404, "not_found");
    }
    const existingStat = lstatSync(absolutePath);
    if (!existingStat.isFile()) {
      throw new WorkspaceError("Target is not a regular file", 400, "not_file");
    }
    const existingBytes = readFileSync(absolutePath);
    if (!this.isFileEditable(relativePath, existingStat, existingBytes)) {
      throw new WorkspaceError(
        "File is view-only and cannot be edited",
        403,
        "file_not_editable",
      );
    }
    const currentRevision = sha256Hex(existingBytes);
    if (expectedRevision !== currentRevision) {
      throw new WorkspaceError(
        "File has changed on disk since it was loaded",
        409,
        "revision_conflict",
        currentRevision,
      );
    }

    const encoded = new TextEncoder().encode(content);
    if (encoded.byteLength > this.maxEditableBytes) {
      throw new WorkspaceError(
        `Content exceeds maximum editable size (${this.maxEditableBytes} bytes)`,
        413,
        "file_too_large",
      );
    }

    this.atomicWriteBytes(absolutePath, encoded);
    const updatedStat = lstatSync(absolutePath);
    const newRevision = sha256Hex(encoded);

    return {
      schema: 1,
      ok: true,
      path: relativePath,
      size: updatedStat.size,
      modified_at: updatedStat.mtime.toISOString(),
      revision: newRevision,
      editable: true,
    };
  }

  createFile(rawPath: string, content = ""): WorkspaceWriteResponse {
    const { relativePath, absolutePath } = this.resolveSafePath(rawPath, {
      allowMissingLeaf: true,
    });
    if (isKnownBinaryExtension(relativePath)) {
      throw new WorkspaceError(
        "Cannot create a binary file as text; use file upload instead",
        400,
        "file_not_editable",
      );
    }
    if (existsSync(absolutePath)) {
      throw new WorkspaceError(
        `File "${relativePath}" already exists`,
        409,
        "already_exists",
      );
    }
    const encoded = new TextEncoder().encode(content);
    if (encoded.byteLength > this.maxEditableBytes) {
      throw new WorkspaceError(
        `Content exceeds maximum editable size (${this.maxEditableBytes} bytes)`,
        413,
        "file_too_large",
      );
    }

    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    this.atomicWriteBytes(absolutePath, encoded);
    const stat = lstatSync(absolutePath);
    const revision = sha256Hex(encoded);

    return {
      schema: 1,
      ok: true,
      path: relativePath,
      size: stat.size,
      modified_at: stat.mtime.toISOString(),
      revision,
      editable: true,
    };
  }

  uploadFile(rawPath: string, bytes: Uint8Array): WorkspaceUploadFileResponse {
    const { relativePath, absolutePath } = this.resolveSafePath(rawPath, {
      allowMissingLeaf: true,
    });
    if (existsSync(absolutePath)) {
      throw new WorkspaceError(
        `File "${relativePath}" already exists`,
        409,
        "already_exists",
      );
    }
    if (bytes.byteLength > this.maxDownloadBytes) {
      throw new WorkspaceError(
        `Uploaded file exceeds maximum allowed size (${this.maxDownloadBytes} bytes)`,
        413,
        "file_too_large",
      );
    }

    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    this.atomicWriteBytes(absolutePath, bytes);
    const stat = lstatSync(absolutePath);
    const editable = this.isFileEditable(relativePath, stat, bytes);
    const revision =
      bytes.byteLength <= this.maxEditableBytes
        ? sha256Hex(bytes)
        : `${stat.size}:${stat.mtimeMs}`;

    return {
      schema: 1,
      ok: true,
      path: relativePath,
      size: stat.size,
      modified_at: stat.mtime.toISOString(),
      revision,
      editable,
    };
  }

  renameFile(rawPath: string, newName: string): WorkspaceRenameResponse {
    const { relativePath, absolutePath } = this.resolveSafePath(rawPath);
    if (!existsSync(absolutePath)) {
      throw new WorkspaceError("File not found", 404, "not_found");
    }
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) {
      throw new WorkspaceError("Target is not a regular file", 400, "not_file");
    }

    const cleanNewName = newName.trim();
    if (
      !cleanNewName ||
      cleanNewName.includes("/") ||
      cleanNewName.includes("\\") ||
      cleanNewName === "." ||
      cleanNewName === ".."
    ) {
      throw new WorkspaceError("Invalid new file name", 400, "invalid_path");
    }

    const parentDir = relativePath.includes("/")
      ? relativePath.slice(0, relativePath.lastIndexOf("/"))
      : "";
    const targetRelPath = parentDir
      ? `${parentDir}/${cleanNewName}`
      : cleanNewName;
    const { relativePath: newRelativePath, absolutePath: newAbsolutePath } =
      this.resolveSafePath(targetRelPath, { allowMissingLeaf: true });

    if (newRelativePath === relativePath) {
      return {
        schema: 1,
        ok: true,
        old_path: relativePath,
        new_path: newRelativePath,
      };
    }
    if (existsSync(newAbsolutePath)) {
      throw new WorkspaceError(
        `Destination "${newRelativePath}" already exists`,
        409,
        "already_exists",
      );
    }

    renameSync(absolutePath, newAbsolutePath);
    return {
      schema: 1,
      ok: true,
      old_path: relativePath,
      new_path: newRelativePath,
    };
  }

  moveFile(rawPath: string, destinationDir: string): WorkspaceMoveResponse {
    const { relativePath, absolutePath } = this.resolveSafePath(rawPath);
    if (!existsSync(absolutePath)) {
      throw new WorkspaceError("File not found", 404, "not_found");
    }
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) {
      throw new WorkspaceError("Target is not a regular file", 400, "not_file");
    }

    const fileName = relativePath.split("/").at(-1) ?? "";
    const cleanDestDir = destinationDir.trim().replace(/^\/+|\/+$/g, "");
    const targetRelPath = cleanDestDir
      ? `${cleanDestDir}/${fileName}`
      : fileName;
    const { relativePath: newRelativePath, absolutePath: newAbsolutePath } =
      this.resolveSafePath(targetRelPath, { allowMissingLeaf: true });

    if (newRelativePath === relativePath) {
      return {
        schema: 1,
        ok: true,
        old_path: relativePath,
        new_path: newRelativePath,
      };
    }
    if (existsSync(newAbsolutePath)) {
      throw new WorkspaceError(
        `Destination "${newRelativePath}" already exists`,
        409,
        "already_exists",
      );
    }

    mkdirSync(dirname(newAbsolutePath), { recursive: true, mode: 0o700 });
    renameSync(absolutePath, newAbsolutePath);
    return {
      schema: 1,
      ok: true,
      old_path: relativePath,
      new_path: newRelativePath,
    };
  }

  deleteFile(
    rawPath: string,
    expectedRevision?: string | undefined,
  ): WorkspaceDeleteResponse {
    const { relativePath, absolutePath } = this.resolveSafePath(rawPath);
    if (!existsSync(absolutePath)) {
      throw new WorkspaceError("File not found", 404, "not_found");
    }
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) {
      throw new WorkspaceError("Target is not a regular file", 400, "not_file");
    }
    if (expectedRevision && stat.size <= this.maxEditableBytes) {
      const currentBytes = readFileSync(absolutePath);
      const currentRevision = sha256Hex(currentBytes);
      if (expectedRevision !== currentRevision) {
        throw new WorkspaceError(
          "File has changed on disk since it was loaded",
          409,
          "revision_conflict",
          currentRevision,
        );
      }
    }
    unlinkSync(absolutePath);
    return {
      schema: 1,
      ok: true,
      path: relativePath,
      deleted: true,
    };
  }

  private atomicWriteBytes(destination: string, bytes: Uint8Array): void {
    const dir = dirname(destination);
    const tempPath = join(dir, `.openlia-tmp-${randomUUID()}`);
    const fd = openSync(tempPath, "wx", 0o600);
    try {
      writeSync(fd, bytes, 0, bytes.byteLength);
      fsyncSync(fd);
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore
      }
      throw err;
    }
    closeSync(fd);
    renameSync(tempPath, destination);
  }
}
