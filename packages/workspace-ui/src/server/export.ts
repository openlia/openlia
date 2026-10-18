import type { Dirent, Stats } from "node:fs";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { MEMORY_FILENAMES } from "../shared/memory";
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  protectedPath,
  WorkspaceError,
} from "./workspace";

export interface ZipArchiveEntry {
  path: string;
  data: Uint8Array;
  mtime?: Date | undefined;
}

export interface ExportArchiveOptions {
  workspaceRoot: string;
  skillsRoot: string;
  memoriesRoot?: string | undefined;
  ingestionRoot?: string | undefined;
  maxDownloadBytes?: number | undefined;
}

const ignoredNoiseBasenames = new Set([
  ".ds_store",
  "desktop.ini",
  "thumbs.db",
]);

const generatedPathParts = new Set([
  ".cache",
  ".curator_backups",
  ".mypy_cache",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "env",
  "node_modules",
  "venv",
  "__pycache__",
]);

function isGeneratedArtifactPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";
  return (
    parts.some((part) => generatedPathParts.has(part)) ||
    basename.endsWith(".pyc") ||
    basename.endsWith(".pyo") ||
    basename.endsWith(".pyd") ||
    basename.endsWith("$py.class") ||
    basename === ".coverage" ||
    basename.startsWith(".coverage.") ||
    basename.endsWith(".egg-info")
  );
}

function isPortableExportExcludedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";
  return (
    isGeneratedArtifactPath(normalized) ||
    normalized === "sources/document-passwords.toml" ||
    basename === ".gitignore" ||
    basename === "agents.md" ||
    basename === "claude.md" ||
    basename === ".cursorrules" ||
    basename === "auth.json" ||
    basename.endsWith("-shm") ||
    basename.endsWith(".lock") ||
    basename.endsWith(".sock") ||
    basename.endsWith(".tmp") ||
    basename.endsWith(".pid") ||
    normalized.includes(".secret") ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".p12") ||
    basename.endsWith(".pfx") ||
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.endsWith(".env") ||
    parts.some(
      (part) =>
        part === ".env" ||
        part.startsWith(".env.") ||
        part === ".git" ||
        part === ".obsidian" ||
        part === ".trash" ||
        part === "browser-profile" ||
        part === "cache" ||
        part === "logs" ||
        part === "mcp-tokens" ||
        part === "pairing" ||
        part === "sessions",
    )
  );
}

function isNoiseFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  return ignoredNoiseBasenames.has(basename) || basename.startsWith("._");
}

function toDosDateTime(dateInput?: Date): { time: number; date: number } {
  const d =
    dateInput instanceof Date && !Number.isNaN(dateInput.getTime())
      ? dateInput
      : new Date();
  const year = Math.max(1980, Math.min(2099, d.getFullYear()));
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);

  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  return { date: dosDate, time: dosTime };
}

export function createZipArchive(entries: ZipArchiveEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const centralDirectoryHeaders: Uint8Array[] = [];
  let currentOffset = 0;

  for (const entry of entries) {
    const normalizedPath = entry.path.replaceAll("\\", "/").replace(/^\/+/, "");
    const nameBytes = new TextEncoder().encode(normalizedPath);
    const dataBytes = entry.data;
    const { date: dosDate, time: dosTime } = toDosDateTime(entry.mtime);

    let compressionMethod = 8; // Deflate
    let compressedBytes: Uint8Array;

    if (dataBytes.length === 0) {
      compressionMethod = 0; // Store
      compressedBytes = dataBytes;
    } else {
      const deflated = deflateRawSync(dataBytes);
      if (deflated.length >= dataBytes.length) {
        compressionMethod = 0; // Store if compression doesn't save space
        compressedBytes = dataBytes;
      } else {
        compressedBytes = deflated;
      }
    }

    const fileCrc = crc32(dataBytes);

    // Local file header (30 bytes + name length)
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true); // Local file header signature
    localView.setUint16(4, 20, true); // Version needed to extract (2.0)
    localView.setUint16(6, 0x0800, true); // General purpose bit flag (bit 11 = UTF-8)
    localView.setUint16(8, compressionMethod, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, fileCrc, true);
    localView.setUint32(18, compressedBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // Extra field length

    parts.push(localHeader, nameBytes, compressedBytes);

    // Central directory header (46 bytes + name length)
    const cdHeader = new Uint8Array(46);
    const cdView = new DataView(cdHeader.buffer);
    cdView.setUint32(0, 0x02014b50, true); // Central directory file header signature
    cdView.setUint16(4, 20, true); // Version made by
    cdView.setUint16(6, 20, true); // Version needed to extract
    cdView.setUint16(8, 0x0800, true); // General purpose bit flag (UTF-8)
    cdView.setUint16(10, compressionMethod, true);
    cdView.setUint16(12, dosTime, true);
    cdView.setUint16(14, dosDate, true);
    cdView.setUint32(16, fileCrc, true);
    cdView.setUint32(20, compressedBytes.length, true);
    cdView.setUint32(24, dataBytes.length, true);
    cdView.setUint16(28, nameBytes.length, true);
    cdView.setUint16(30, 0, true); // Extra field length
    cdView.setUint16(32, 0, true); // File comment length
    cdView.setUint16(34, 0, true); // Disk number start
    cdView.setUint16(36, 0, true); // Internal file attributes
    cdView.setUint32(38, 0o100644 << 16, true); // External file attributes (regular file rw-r--r--)
    cdView.setUint32(42, currentOffset, true); // Relative offset of local header

    centralDirectoryHeaders.push(cdHeader, nameBytes);

    currentOffset +=
      localHeader.length + nameBytes.length + compressedBytes.length;
  }

  const cdOffset = currentOffset;
  let cdSize = 0;
  for (const part of centralDirectoryHeaders) {
    cdSize += part.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
  eocdView.setUint16(4, 0, true); // Disk number
  eocdView.setUint16(6, 0, true); // Disk where central directory starts
  eocdView.setUint16(8, entries.length, true); // Total entries on this disk
  eocdView.setUint16(10, entries.length, true); // Total entries
  eocdView.setUint32(12, cdSize, true); // Size of central directory
  eocdView.setUint32(16, cdOffset, true); // Offset of central directory
  eocdView.setUint16(20, 0, true); // Comment length

  const allParts = [...parts, ...centralDirectoryHeaders, eocd];
  let totalLength = 0;
  for (const part of allParts) {
    totalLength += part.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of allParts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

export function exportArchive(options: ExportArchiveOptions): Uint8Array {
  const workspaceRoot = resolve(options.workspaceRoot);
  const skillsRoot = resolve(options.skillsRoot);
  const maxDownloadBytes =
    options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;

  const entries: ZipArchiveEntry[] = [];
  let totalUncompressedBytes = 0;

  const collectFiles = (rootDir: string, prefix: string): void => {
    if (!existsSync(rootDir)) return;

    const visit = (currentDir: string): void => {
      let dirents: Dirent<string>[] = [];
      try {
        dirents = readdirSync(currentDir, {
          encoding: "utf8",
          withFileTypes: true,
        });
      } catch {
        return;
      }

      for (const entry of dirents) {
        const absolute = join(currentDir, entry.name);
        const relPath = relative(rootDir, absolute).split(sep).join("/");

        if (
          protectedPath(relPath) ||
          isPortableExportExcludedPath(relPath) ||
          isNoiseFile(relPath)
        )
          continue;

        let info: Stats;
        try {
          info = lstatSync(absolute);
        } catch {
          continue;
        }

        if (info.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          visit(absolute);
        } else if (entry.isFile()) {
          totalUncompressedBytes += info.size;
          if (totalUncompressedBytes > maxDownloadBytes) {
            throw new WorkspaceError(
              "export exceeds maximum allowed size",
              413,
              "export_too_large",
            );
          }

          let fileData: Uint8Array;
          try {
            fileData = readFileSync(absolute);
          } catch {
            continue;
          }

          const archivePath = `${prefix}/${relPath}`;
          entries.push({
            data: fileData,
            mtime: info.mtime,
            path: archivePath,
          });
        }
      }
    };

    visit(rootDir);
  };

  const collectMemoryFiles = (rootDir: string | undefined): void => {
    if (!rootDir || !existsSync(rootDir)) return;

    const resolvedRoot = resolve(rootDir);
    for (const name of MEMORY_FILENAMES) {
      const absolute = join(resolvedRoot, name);
      let info: Stats;
      try {
        info = lstatSync(absolute);
      } catch {
        continue;
      }

      if (!info.isFile() || info.isSymbolicLink()) continue;

      totalUncompressedBytes += info.size;
      if (totalUncompressedBytes > maxDownloadBytes) {
        throw new WorkspaceError(
          "export exceeds maximum allowed size",
          413,
          "export_too_large",
        );
      }

      let fileData: Uint8Array;
      try {
        fileData = readFileSync(absolute);
      } catch {
        continue;
      }

      entries.push({
        data: fileData,
        mtime: info.mtime,
        path: `memories/${name}`,
      });
    }
  };

  collectFiles(workspaceRoot, "workspace");
  collectFiles(skillsRoot, "skills");
  collectMemoryFiles(options.memoriesRoot);
  if (options.ingestionRoot) {
    collectFiles(options.ingestionRoot, "ingestion");
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return createZipArchive(entries);
}
