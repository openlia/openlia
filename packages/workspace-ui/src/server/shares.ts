import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import type {
  PublicShareFileEntry,
  PublicShareResponse,
  ShareCreateRequest,
  ShareDeleteResponse,
  ShareExpirationPreset,
  ShareKind,
  ShareListResponse,
  ShareMutationResponse,
  ShareSkillMetadata,
  ShareSummary,
  ShareSyncStatus,
  ShareUpdateRequest,
} from "../shared/api";
import { isMemoryDocument } from "../shared/memory";
import { createZipArchive, type ZipArchiveEntry } from "./export";
import type { SkillService } from "./skills";
import { validateSkillId } from "./skills";
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  DEFAULT_MAX_EDITABLE_BYTES,
  protectedPath,
  revision,
  WorkspaceError,
  type WorkspaceService,
} from "./workspace";

const EXPIRATION_PRESET_DURATIONS_MS: Record<
  Exclude<ShareExpirationPreset, "never">,
  number
> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export const VALID_EXPIRATION_PRESETS = new Set<ShareExpirationPreset>([
  "1d",
  "7d",
  "30d",
  "90d",
  "never",
]);

const DEFAULT_FAILED_LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FAILED_LOOKUPS = 15;
const MAX_INCLUDE_FILES = 50;

const contentTypesByExtension: Record<string, string> = {
  ".avif": "image/avif",
  ".bash": "text/plain; charset=utf-8",
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".hledger": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".journal": "text/plain; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".markdown": "text/markdown; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/plain; charset=utf-8",
  ".rem": "text/plain; charset=utf-8",
  ".remind": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".text": "text/plain; charset=utf-8",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".toml": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

interface ShareRow {
  id: string;
  kind: ShareKind;
  target_path: string;
  title: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  expiration_preset: ShareExpirationPreset;
  snapshot_revision: string;
  file_count: number;
  total_bytes: number;
  media_type: string;
  metadata_json: string | null;
}

interface ShareFileRow {
  share_id: string;
  path: string;
  content_text: string | null;
  content_blob: Uint8Array | null;
  media_type: string;
  size_bytes: number;
  modified_at: string;
  editable: number;
}

interface CapturedShareFile {
  path: string;
  contentText: string | null;
  contentBlob: Uint8Array | null;
  mediaType: string;
  sizeBytes: number;
  modifiedAt: string;
  editable: boolean;
}

interface CapturedSnapshot {
  kind: ShareKind;
  targetPath: string;
  title: string;
  snapshotRevision: string;
  mediaType: string;
  metadataJson: string | null;
  files: CapturedShareFile[];
  totalBytes: number;
}

interface FailedLookupState {
  count: number;
  resetAt: number;
}

export interface ShareServiceOptions {
  databasePath?: string | undefined;
  workspaceService: WorkspaceService;
  skillService: SkillService;
  maxEditableBytes?: number | undefined;
  maxDownloadBytes?: number | undefined;
  failedLookupWindowMs?: number | undefined;
  maxFailedLookups?: number | undefined;
}

function fileExtension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash ? path.slice(lastDot).toLowerCase() : "";
}

function inferMediaType(path: string, editable: boolean): string {
  const ext = fileExtension(path);
  const mapped = contentTypesByExtension[ext];
  if (mapped) return mapped;
  return editable ? "text/plain; charset=utf-8" : "application/octet-stream";
}

function extractMarkdownTitle(content: string, fallbackPath: string): string {
  const basename = fallbackPath.split("/").at(-1) ?? fallbackPath;
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (frontmatterMatch?.[1]) {
    try {
      const parsed = YAML.parse(frontmatterMatch[1]);
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (typeof record.title === "string" && record.title.trim()) {
          return record.title.trim();
        }
        if (typeof record.name === "string" && record.name.trim()) {
          return record.name.trim();
        }
      }
    } catch {}
  }
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]?.trim()) {
    return headingMatch[1].trim();
  }
  return basename;
}

function resolveRelativeWorkspacePath(
  relativePath: string,
  fromFilePath: string,
): string {
  const cleanFrom = fromFilePath.replace(/^\/+/, "");
  const fromDirParts = cleanFrom.includes("/")
    ? cleanFrom.split("/").slice(0, -1)
    : [];
  const relClean = relativePath.split("?")[0]?.split("#")[0] ?? relativePath;
  const relParts = relClean.split("/").filter((p) => p !== "" && p !== ".");
  const resultParts = [...fromDirParts];
  for (const part of relParts) {
    if (part === "..") {
      if (resultParts.length === 0) return "";
      resultParts.pop();
    } else {
      resultParts.push(part);
    }
  }
  return resultParts.join("/");
}

function extractIncludedPaths(content: string, filePath: string): string[] {
  const ext = fileExtension(filePath);
  const includes: string[] = [];

  if (ext === ".hledger" || ext === ".journal") {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*include\s+(.+)$/i);
      if (match?.[1]) {
        let target = match[1].trim();
        const commentIdx = target.search(/[;#]/);
        if (commentIdx >= 0) {
          target = target.slice(0, commentIdx).trim();
        }
        target = target.replace(/^["']|["']$/g, "").trim();
        if (target) includes.push(target);
      }
    }
    return includes;
  }

  if (ext === ".rem" || ext === ".remind") {
    const lines = content.split(/\r?\n/);
    let currentStatement = "";
    const flush = (stmt: string) => {
      const trimmed = stmt.trim();
      if (/^INCLUDE(?:\s|\t)/i.test(trimmed)) {
        const target = trimmed
          .slice(7)
          .trim()
          .replace(/^["']|["']$/g, "")
          .trim();
        if (target) includes.push(target);
      }
    };
    for (const rawLine of lines) {
      const trimmedRight = rawLine.replace(/\s+$/, "");
      if (trimmedRight.endsWith("\\")) {
        currentStatement += `${trimmedRight.slice(0, -1)} `;
      } else {
        currentStatement += rawLine;
        flush(currentStatement);
        currentStatement = "";
      }
    }
    if (currentStatement) flush(currentStatement);
    return includes;
  }

  return includes;
}

export function generateShareId(): string {
  return randomBytes(24).toString("base64url");
}

export function computeExpirationIso(
  preset: ShareExpirationPreset,
  nowMs = Date.now(),
): string | null {
  if (preset === "never") return null;
  const durationMs = EXPIRATION_PRESET_DURATIONS_MS[preset];
  return new Date(nowMs + durationMs).toISOString();
}

export class ShareService {
  private readonly db: Database;
  private readonly workspaceService: WorkspaceService;
  private readonly skillService: SkillService;
  private readonly maxEditableBytes: number;
  private readonly maxDownloadBytes: number;
  private readonly failedLookupWindowMs: number;
  private readonly maxFailedLookups: number;
  private readonly failedLookups = new Map<string, FailedLookupState>();

  constructor(options: ShareServiceOptions) {
    this.workspaceService = options.workspaceService;
    this.skillService = options.skillService;
    this.maxEditableBytes =
      options.maxEditableBytes ?? DEFAULT_MAX_EDITABLE_BYTES;
    this.maxDownloadBytes =
      options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.failedLookupWindowMs =
      options.failedLookupWindowMs ?? DEFAULT_FAILED_LOOKUP_WINDOW_MS;
    this.maxFailedLookups =
      options.maxFailedLookups ?? DEFAULT_MAX_FAILED_LOOKUPS;

    const dbPath = options.databasePath?.trim() || ":memory:";
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath, { create: true, strict: true });
    this.initializeSchema();
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA journal_mode = WAL;");
    try {
      this.db.run("PRAGMA auto_vacuum = INCREMENTAL;");
    } catch {}

    this.db.run(`
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_path TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        expiration_preset TEXT NOT NULL,
        snapshot_revision TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 1,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        media_type TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
        metadata_json TEXT
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS share_files (
        share_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_text TEXT,
        content_blob BLOB,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        editable INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (share_id, path),
        FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
      );
    `);

    this.db.run(
      "CREATE INDEX IF NOT EXISTS shares_target_idx ON shares (kind, target_path);",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS shares_expires_idx ON shares (expires_at);",
    );
    this.pruneExpired();
  }

  pruneExpired(nowMs = Date.now()): number {
    const nowIso = new Date(nowMs).toISOString();
    const expiredRows = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .all(nowIso);

    if (expiredRows.length === 0) return 0;

    const deleteFilesStmt = this.db.query(
      "DELETE FROM share_files WHERE share_id = ?",
    );
    const deleteShareStmt = this.db.query("DELETE FROM shares WHERE id = ?");

    const tx = this.db.transaction((rows: Array<{ id: string }>) => {
      for (const row of rows) {
        deleteFilesStmt.run(row.id);
        deleteShareStmt.run(row.id);
      }
    });
    tx(expiredRows);

    try {
      this.db.run("PRAGMA incremental_vacuum(64);");
    } catch {}

    return expiredRows.length;
  }

  private assertNotRateLimited(clientKey: string, nowMs = Date.now()): void {
    const state = this.failedLookups.get(clientKey);
    if (!state) return;
    if (state.resetAt <= nowMs) {
      this.failedLookups.delete(clientKey);
      return;
    }
    if (state.count >= this.maxFailedLookups) {
      throw new WorkspaceError(
        "too many failed share lookups",
        429,
        "rate_limited",
      );
    }
  }

  private recordFailedLookup(clientKey: string, nowMs = Date.now()): void {
    const existing = this.failedLookups.get(clientKey);
    if (!existing || existing.resetAt <= nowMs) {
      this.failedLookups.set(clientKey, {
        count: 1,
        resetAt: nowMs + this.failedLookupWindowMs,
      });
      return;
    }
    existing.count += 1;
  }

  private clearFailedLookups(clientKey: string): void {
    this.failedLookups.delete(clientKey);
  }

  private computeLiveWorkspaceRevision(targetPath: string): string | null {
    if (protectedPath(targetPath) || isMemoryDocument(targetPath)) {
      return null;
    }
    try {
      const downloaded = this.workspaceService.download(targetPath);
      const bytes = readFileSync(downloaded.absolute);
      return revision(bytes);
    } catch {
      return null;
    }
  }

  private computeLiveSkillRevision(skillId: string): string | null {
    try {
      const detailResp = this.skillService.detail(skillId);
      const skill = detailResp.skill;
      const sortedFiles = [...skill.files].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      const hash = createHash("sha256");
      for (const fileEntry of sortedFiles) {
        const fileBytes = this.readSkillFileRawBytes(skillId, fileEntry.path);
        const fileRev = revision(fileBytes);
        hash.update(`${fileEntry.path}\0${fileRev}\n`);
      }
      return `sha256:${hash.digest("hex")}`;
    } catch {
      return null;
    }
  }

  private readSkillFileRawBytes(skillId: string, relPath: string): Uint8Array {
    const activeDir = join(this.skillService.skillsRoot, ...skillId.split("/"));
    const disabledDir = join(
      this.skillService.skillsRoot,
      ".openlia-disabled",
      ...skillId.split("/"),
    );
    const skillDir = existsSync(activeDir)
      ? activeDir
      : existsSync(disabledDir)
        ? disabledDir
        : null;
    if (!skillDir) {
      throw new WorkspaceError("skill not found", 404, "skill_not_found");
    }
    const targetFile = resolve(skillDir, relPath);
    if (!targetFile.startsWith(skillDir + sep) && targetFile !== skillDir) {
      throw new WorkspaceError("invalid skill file path", 403, "invalid_path");
    }
    const info = lstatSync(targetFile);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new WorkspaceError("invalid skill file", 400, "not_a_file");
    }
    return readFileSync(targetFile);
  }

  private captureWorkspaceSnapshot(rawTargetPath: string): CapturedSnapshot {
    const cleanPath = rawTargetPath.trim().replace(/^\/+/, "");
    if (!cleanPath || isMemoryDocument(cleanPath) || protectedPath(cleanPath)) {
      throw new WorkspaceError(
        "workspace path cannot be shared",
        403,
        "protected_path",
      );
    }

    const meta = this.workspaceService.metadata(cleanPath);
    const downloaded = this.workspaceService.download(cleanPath);
    const rawBytes = readFileSync(downloaded.absolute);
    const mainRevision = revision(rawBytes);
    const mediaType = inferMediaType(cleanPath, meta.editable);

    const files: CapturedShareFile[] = [];
    let totalBytes = 0;
    let title = cleanPath.split("/").at(-1) ?? cleanPath;

    if (meta.editable) {
      const fileData = this.workspaceService.read(cleanPath);
      const ext = fileExtension(cleanPath);
      if (ext === ".md" || ext === ".markdown") {
        title = extractMarkdownTitle(fileData.content, cleanPath);
      }
      files.push({
        path: cleanPath,
        contentText: fileData.content,
        contentBlob: null,
        mediaType,
        sizeBytes: fileData.size,
        modifiedAt: fileData.modified_at,
        editable: true,
      });
      totalBytes += fileData.size;

      // Resolve recursive includes for .rem/.remind and .hledger/.journal
      if (
        ext === ".rem" ||
        ext === ".remind" ||
        ext === ".hledger" ||
        ext === ".journal"
      ) {
        const visited = new Set<string>([cleanPath]);
        const queue: Array<{ includeRef: string; fromFile: string }> =
          extractIncludedPaths(fileData.content, cleanPath).map(
            (includeRef) => ({
              includeRef,
              fromFile: cleanPath,
            }),
          );
        let includeCount = 0;

        while (queue.length > 0 && includeCount < MAX_INCLUDE_FILES) {
          const item = queue.shift();
          if (!item) break;

          const candidates = [
            resolveRelativeWorkspacePath(item.includeRef, item.fromFile),
            item.includeRef.replace(/^\/+/, ""),
          ].filter(Boolean);

          for (const candidate of candidates) {
            if (visited.has(candidate)) break;
            if (protectedPath(candidate) || isMemoryDocument(candidate)) {
              continue;
            }
            try {
              const incFile = this.workspaceService.read(candidate);
              visited.add(candidate);
              includeCount += 1;
              const incMediaType = inferMediaType(candidate, true);
              files.push({
                path: candidate,
                contentText: incFile.content,
                contentBlob: null,
                mediaType: incMediaType,
                sizeBytes: incFile.size,
                modifiedAt: incFile.modified_at,
                editable: true,
              });
              totalBytes += incFile.size;

              const nested = extractIncludedPaths(incFile.content, candidate);
              for (const nestedRef of nested) {
                queue.push({ includeRef: nestedRef, fromFile: candidate });
              }
              break;
            } catch {
              // Ignore missing or unreadable include candidate
            }
          }
        }
      }
    } else {
      // Binary artifact
      files.push({
        path: cleanPath,
        contentText: null,
        contentBlob: rawBytes,
        mediaType,
        sizeBytes: downloaded.size,
        modifiedAt: meta.modified_at,
        editable: false,
      });
      totalBytes += downloaded.size;
    }

    if (totalBytes > this.maxDownloadBytes) {
      throw new WorkspaceError(
        "share snapshot exceeds maximum allowed size",
        413,
        "download_too_large",
      );
    }

    return {
      kind: "workspace",
      targetPath: cleanPath,
      title,
      snapshotRevision: mainRevision,
      mediaType,
      metadataJson: null,
      files,
      totalBytes,
    };
  }

  private captureSkillSnapshot(rawSkillId: string): CapturedSnapshot {
    const skillId = validateSkillId(rawSkillId);
    const detailResp = this.skillService.detail(skillId);
    const skill = detailResp.skill;

    const sortedFiles = [...skill.files].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const hash = createHash("sha256");
    const capturedFiles: CapturedShareFile[] = [];
    let totalBytes = 0;

    for (const entry of sortedFiles) {
      const rawBytes = this.readSkillFileRawBytes(skillId, entry.path);
      const fileRev = revision(rawBytes);
      hash.update(`${entry.path}\0${fileRev}\n`);
      totalBytes += rawBytes.byteLength;
      if (totalBytes > this.maxDownloadBytes) {
        throw new WorkspaceError(
          "skill snapshot exceeds maximum allowed size",
          413,
          "download_too_large",
        );
      }

      let contentText: string | null = null;
      let contentBlob: Uint8Array | null = null;
      let isEditable = entry.editable;

      if (
        rawBytes.byteLength <= this.maxEditableBytes &&
        !rawBytes.includes(0)
      ) {
        try {
          contentText = new TextDecoder("utf-8", { fatal: true }).decode(
            rawBytes,
          );
          isEditable = true;
        } catch {
          contentBlob = rawBytes;
          isEditable = false;
        }
      } else {
        contentBlob = rawBytes;
        isEditable = false;
      }

      capturedFiles.push({
        path: entry.path,
        contentText,
        contentBlob,
        mediaType: inferMediaType(entry.path, isEditable),
        sizeBytes: rawBytes.byteLength,
        modifiedAt: entry.modified_at,
        editable: isEditable,
      });
    }

    const compositeRevision = `sha256:${hash.digest("hex")}`;
    const skillMetadata: ShareSkillMetadata = {
      name: skill.name,
      category: skill.category,
      description: skill.description,
      version: skill.version,
      author: skill.author,
      license: skill.license,
      tags: skill.tags ?? [],
      platforms: skill.platforms ?? [],
      prerequisites: skill.prerequisites,
    };

    return {
      kind: "skill",
      targetPath: skill.id,
      title: skill.name || skill.id,
      snapshotRevision: compositeRevision,
      mediaType: "application/x-openlia-skill",
      metadataJson: JSON.stringify(skillMetadata),
      files: capturedFiles,
      totalBytes,
    };
  }

  private toShareSummary(row: ShareRow): ShareSummary {
    const currentRevision =
      row.kind === "workspace"
        ? this.computeLiveWorkspaceRevision(row.target_path)
        : this.computeLiveSkillRevision(row.target_path);

    let status: ShareSyncStatus;
    if (currentRevision === null) {
      status = "source_missing";
    } else if (currentRevision === row.snapshot_revision) {
      status = "up_to_date";
    } else {
      status = "stale";
    }

    let skillMetadata: ShareSkillMetadata | undefined;
    if (row.metadata_json) {
      try {
        skillMetadata = JSON.parse(row.metadata_json) as ShareSkillMetadata;
      } catch {}
    }

    return {
      id: row.id,
      kind: row.kind,
      target_path: row.target_path,
      title: row.title,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
      expiration_preset: row.expiration_preset,
      snapshot_revision: row.snapshot_revision,
      current_revision: currentRevision,
      status,
      file_count: row.file_count,
      total_bytes: row.total_bytes,
      media_type: row.media_type,
      ...(skillMetadata ? { skill_metadata: skillMetadata } : {}),
    };
  }

  listShares(filter?: {
    kind?: string | null | undefined;
    targetPath?: string | null | undefined;
  }): ShareListResponse {
    this.pruneExpired();

    const kindFilter = filter?.kind?.trim();
    const targetFilter = filter?.targetPath?.trim()?.replace(/^\/+/, "");

    let rows: ShareRow[];
    if (kindFilter && targetFilter) {
      rows = this.db
        .query<ShareRow, [string, string]>(
          "SELECT * FROM shares WHERE kind = ? AND target_path = ? ORDER BY created_at DESC",
        )
        .all(kindFilter, targetFilter);
    } else if (kindFilter) {
      rows = this.db
        .query<ShareRow, [string]>(
          "SELECT * FROM shares WHERE kind = ? ORDER BY created_at DESC",
        )
        .all(kindFilter);
    } else if (targetFilter) {
      rows = this.db
        .query<ShareRow, [string]>(
          "SELECT * FROM shares WHERE target_path = ? ORDER BY created_at DESC",
        )
        .all(targetFilter);
    } else {
      rows = this.db
        .query<ShareRow, []>("SELECT * FROM shares ORDER BY created_at DESC")
        .all();
    }

    return {
      schema: 1,
      ok: true,
      shares: rows.map((row) => this.toShareSummary(row)),
    };
  }

  createShare(request: Partial<ShareCreateRequest>): ShareMutationResponse {
    this.pruneExpired();

    const kind = request.kind;
    if (kind !== "workspace" && kind !== "skill") {
      throw new WorkspaceError(
        "share kind must be 'workspace' or 'skill'",
        400,
        "invalid_share_request",
      );
    }
    if (
      typeof request.target_path !== "string" ||
      !request.target_path.trim()
    ) {
      throw new WorkspaceError(
        "target_path is required",
        400,
        "invalid_share_request",
      );
    }

    const preset: ShareExpirationPreset = request.expires_in ?? "30d";
    if (!VALID_EXPIRATION_PRESETS.has(preset)) {
      throw new WorkspaceError(
        "invalid expiration preset",
        400,
        "invalid_share_request",
      );
    }

    const snapshot =
      kind === "workspace"
        ? this.captureWorkspaceSnapshot(request.target_path)
        : this.captureSkillSnapshot(request.target_path);

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = computeExpirationIso(preset, nowMs);
    const id = generateShareId();

    const insertShare = this.db.query(`
      INSERT INTO shares (
        id, kind, target_path, title, created_at, updated_at,
        expires_at, expiration_preset, snapshot_revision,
        file_count, total_bytes, media_type, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFile = this.db.query(`
      INSERT INTO share_files (
        share_id, path, content_text, content_blob,
        media_type, size_bytes, modified_at, editable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      insertShare.run(
        id,
        snapshot.kind,
        snapshot.targetPath,
        snapshot.title,
        nowIso,
        nowIso,
        expiresAt,
        preset,
        snapshot.snapshotRevision,
        snapshot.files.length,
        snapshot.totalBytes,
        snapshot.mediaType,
        snapshot.metadataJson,
      );
      for (const file of snapshot.files) {
        insertFile.run(
          id,
          file.path,
          file.contentText,
          file.contentBlob,
          file.mediaType,
          file.sizeBytes,
          file.modifiedAt,
          file.editable ? 1 : 0,
        );
      }
    });
    tx();

    const createdRow = this.db
      .query<ShareRow, [string]>("SELECT * FROM shares WHERE id = ?")
      .get(id);
    if (!createdRow) {
      throw new WorkspaceError("failed to create share", 500, "request_failed");
    }

    return {
      schema: 1,
      ok: true,
      share: this.toShareSummary(createdRow),
    };
  }

  syncShare(
    shareId: string,
    expiresIn?: ShareExpirationPreset | undefined,
  ): ShareMutationResponse {
    this.pruneExpired();

    const existing = this.db
      .query<ShareRow, [string]>("SELECT * FROM shares WHERE id = ?")
      .get(shareId);
    if (!existing) {
      throw new WorkspaceError("share not found", 404, "share_not_found");
    }

    if (expiresIn !== undefined && !VALID_EXPIRATION_PRESETS.has(expiresIn)) {
      throw new WorkspaceError(
        "invalid expiration preset",
        400,
        "invalid_share_request",
      );
    }

    const snapshot =
      existing.kind === "workspace"
        ? this.captureWorkspaceSnapshot(existing.target_path)
        : this.captureSkillSnapshot(existing.target_path);

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const nextPreset = expiresIn ?? existing.expiration_preset;
    const nextExpiresAt =
      expiresIn !== undefined
        ? computeExpirationIso(expiresIn, nowMs)
        : existing.expires_at;

    const updateShareStmt = this.db.query(`
      UPDATE shares
      SET title = ?,
          updated_at = ?,
          expires_at = ?,
          expiration_preset = ?,
          snapshot_revision = ?,
          file_count = ?,
          total_bytes = ?,
          media_type = ?,
          metadata_json = ?
      WHERE id = ?
    `);
    const deleteFilesStmt = this.db.query(
      "DELETE FROM share_files WHERE share_id = ?",
    );
    const insertFileStmt = this.db.query(`
      INSERT INTO share_files (
        share_id, path, content_text, content_blob,
        media_type, size_bytes, modified_at, editable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      updateShareStmt.run(
        snapshot.title,
        nowIso,
        nextExpiresAt,
        nextPreset,
        snapshot.snapshotRevision,
        snapshot.files.length,
        snapshot.totalBytes,
        snapshot.mediaType,
        snapshot.metadataJson,
        shareId,
      );
      deleteFilesStmt.run(shareId);
      for (const file of snapshot.files) {
        insertFileStmt.run(
          shareId,
          file.path,
          file.contentText,
          file.contentBlob,
          file.mediaType,
          file.sizeBytes,
          file.modifiedAt,
          file.editable ? 1 : 0,
        );
      }
    });
    tx();

    const updated = this.db
      .query<ShareRow, [string]>("SELECT * FROM shares WHERE id = ?")
      .get(shareId);
    if (!updated) {
      throw new WorkspaceError("share not found", 404, "share_not_found");
    }

    return {
      schema: 1,
      ok: true,
      share: this.toShareSummary(updated),
    };
  }

  updateShare(
    shareId: string,
    request: Partial<ShareUpdateRequest>,
  ): ShareMutationResponse {
    this.pruneExpired();

    if (request.action === "sync") {
      return this.syncShare(shareId, request.expires_in);
    }

    const existing = this.db
      .query<ShareRow, [string]>("SELECT * FROM shares WHERE id = ?")
      .get(shareId);
    if (!existing) {
      throw new WorkspaceError("share not found", 404, "share_not_found");
    }

    if (
      !request.expires_in ||
      !VALID_EXPIRATION_PRESETS.has(request.expires_in)
    ) {
      throw new WorkspaceError(
        "invalid share update request",
        400,
        "invalid_share_request",
      );
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = computeExpirationIso(request.expires_in, nowMs);

    this.db
      .query(
        "UPDATE shares SET expires_at = ?, expiration_preset = ?, updated_at = ? WHERE id = ?",
      )
      .run(expiresAt, request.expires_in, nowIso, shareId);

    const updated = this.db
      .query<ShareRow, [string]>("SELECT * FROM shares WHERE id = ?")
      .get(shareId);
    if (!updated) {
      throw new WorkspaceError("share not found", 404, "share_not_found");
    }

    return {
      schema: 1,
      ok: true,
      share: this.toShareSummary(updated),
    };
  }

  deleteShare(shareId: string): ShareDeleteResponse {
    this.pruneExpired();

    const existing = this.db
      .query<{ id: string }, [string]>("SELECT id FROM shares WHERE id = ?")
      .get(shareId);
    if (!existing) {
      throw new WorkspaceError("share not found", 404, "share_not_found");
    }

    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM share_files WHERE share_id = ?").run(shareId);
      this.db.query("DELETE FROM shares WHERE id = ?").run(shareId);
    });
    tx();

    try {
      this.db.run("PRAGMA incremental_vacuum(64);");
    } catch {}

    return {
      schema: 1,
      ok: true,
      id: shareId,
    };
  }

  private lookupActivePublicShareRow(
    shareId: string,
    clientKey: string,
  ): ShareRow {
    const nowMs = Date.now();
    this.assertNotRateLimited(clientKey, nowMs);
    this.pruneExpired(nowMs);

    const cleanId = shareId.trim();
    if (!cleanId) {
      this.recordFailedLookup(clientKey, nowMs);
      throw new WorkspaceError("share not found", 404, "share_not_found");
    }

    const row = this.db
      .query<ShareRow, [string]>("SELECT * FROM shares WHERE id = ?")
      .get(cleanId);
    if (!row) {
      this.recordFailedLookup(clientKey, nowMs);
      throw new WorkspaceError("share not found", 404, "share_not_found");
    }

    this.clearFailedLookups(clientKey);
    return row;
  }

  getPublicShare(shareId: string, clientKey = "global"): PublicShareResponse {
    const row = this.lookupActivePublicShareRow(shareId, clientKey);
    const fileRows = this.db
      .query<ShareFileRow, [string]>(
        "SELECT * FROM share_files WHERE share_id = ? ORDER BY path ASC",
      )
      .all(row.id);

    const files: PublicShareFileEntry[] = fileRows.map((f) => ({
      path: f.path,
      size: f.size_bytes,
      modified_at: f.modified_at,
      media_type: f.media_type,
      editable: Boolean(f.editable),
      ...(f.content_text !== null ? { content: f.content_text } : {}),
    }));

    const primaryFile =
      row.kind === "workspace"
        ? (fileRows.find((f) => f.path === row.target_path) ?? fileRows[0])
        : (fileRows.find((f) => f.path === "SKILL.md") ?? fileRows[0]);

    let skillMetadata: ShareSkillMetadata | undefined;
    if (row.metadata_json) {
      try {
        skillMetadata = JSON.parse(row.metadata_json) as ShareSkillMetadata;
      } catch {}
    }

    return {
      schema: 1,
      ok: true,
      share: {
        id: row.id,
        kind: row.kind,
        target_path: row.target_path,
        title: row.title,
        created_at: row.created_at,
        updated_at: row.updated_at,
        expires_at: row.expires_at,
        expiration_preset: row.expiration_preset,
        snapshot_revision: row.snapshot_revision,
        file_count: row.file_count,
        total_bytes: row.total_bytes,
        media_type: row.media_type,
        editable: primaryFile ? Boolean(primaryFile.editable) : true,
        ...(primaryFile?.content_text !== null &&
        primaryFile?.content_text !== undefined
          ? { content: primaryFile.content_text }
          : {}),
        ...(skillMetadata ? { skill_metadata: skillMetadata } : {}),
        files,
      },
    };
  }

  getPublicShareBinaryFile(
    shareId: string,
    requestedPath?: string | null | undefined,
    clientKey = "global",
  ): {
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
  } {
    const row = this.lookupActivePublicShareRow(shareId, clientKey);
    const targetPath = requestedPath?.trim() || row.target_path;

    const fileRow =
      this.db
        .query<ShareFileRow, [string, string]>(
          "SELECT * FROM share_files WHERE share_id = ? AND path = ?",
        )
        .get(row.id, targetPath) ??
      (requestedPath
        ? null
        : this.db
            .query<ShareFileRow, [string]>(
              "SELECT * FROM share_files WHERE share_id = ? ORDER BY path ASC LIMIT 1",
            )
            .get(row.id));

    if (!fileRow) {
      throw new WorkspaceError("shared file not found", 404, "not_found");
    }

    const bytes =
      fileRow.content_blob !== null
        ? new Uint8Array(fileRow.content_blob)
        : new TextEncoder().encode(fileRow.content_text ?? "");

    const filename = (fileRow.path.split("/").at(-1) ?? "download").replaceAll(
      /["\r\n]/g,
      "",
    );

    return {
      filename,
      mediaType: fileRow.media_type || "application/octet-stream",
      bytes,
    };
  }

  downloadPublicSkillZip(
    shareId: string,
    clientKey = "global",
  ): {
    filename: string;
    zipBytes: Uint8Array;
  } {
    const row = this.lookupActivePublicShareRow(shareId, clientKey);
    if (row.kind !== "skill") {
      throw new WorkspaceError(
        "share is not a skill package",
        400,
        "invalid_share_request",
      );
    }

    const fileRows = this.db
      .query<ShareFileRow, [string]>(
        "SELECT * FROM share_files WHERE share_id = ? ORDER BY path ASC",
      )
      .all(row.id);

    const folderSlug =
      (row.target_path.split("/").at(-1) || row.title || "skill")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "skill";

    const entries: ZipArchiveEntry[] = fileRows.map((fileRow) => {
      const data =
        fileRow.content_blob !== null
          ? new Uint8Array(fileRow.content_blob)
          : new TextEncoder().encode(fileRow.content_text ?? "");
      return {
        path: `${folderSlug}/${fileRow.path}`,
        data,
        mtime: new Date(fileRow.modified_at),
      };
    });

    return {
      filename: `${folderSlug}.zip`,
      zipBytes: createZipArchive(entries),
    };
  }
}
