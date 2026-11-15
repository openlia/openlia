import type { WorkspaceTreeEntry } from "../shared/api";

export type ResolvedTarget = {
  kind: "workspace";
  path: string;
  label: string;
  exists?: boolean | undefined;
} | null;

export interface GoToSuggestion {
  kind: "workspace";
  id: string;
  title: string;
  subtitle?: string | undefined;
  badge: string;
}

const COMMON_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".py",
  ".sh",
  ".bash",
  ".js",
  ".ts",
  ".csv",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".webp",
]);

function hasFileExtension(name: string): boolean {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return false;
  return COMMON_FILE_EXTENSIONS.has(name.slice(dotIndex).toLowerCase());
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function findMatchingWorkspaceFile(
  candidate: string,
  files: WorkspaceTreeEntry[],
): WorkspaceTreeEntry | undefined {
  const clean = candidate.replace(/^\/+/, "");
  if (!clean) return undefined;
  const lowerClean = clean.toLowerCase();

  const exact = files.find((f) => f.path === clean);
  if (exact) return exact;

  const exactCi = files.find((f) => f.path.toLowerCase() === lowerClean);
  if (exactCi) return exactCi;

  const baseMatch = files.find((f) => {
    const base = f.path.split("/").pop();
    return base === clean;
  });
  if (baseMatch) return baseMatch;

  const baseMatchCi = files.find((f) => {
    const base = f.path.split("/").pop();
    return base?.toLowerCase() === lowerClean;
  });
  if (baseMatchCi) return baseMatchCi;

  const pathNoExt = files.find((f) => {
    const withoutExt = f.path.replace(/\.[^/.]+$/, "");
    return withoutExt.toLowerCase() === lowerClean;
  });
  if (pathNoExt) return pathNoExt;

  const stemMatch = files.find((f) => {
    const base = f.path.split("/").pop() ?? "";
    const stem = base.replace(/\.[^/.]+$/, "");
    return stem.toLowerCase() === lowerClean;
  });
  if (stemMatch) return stemMatch;

  return undefined;
}

export function resolveRelativePath(
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
      resultParts.pop();
    } else {
      resultParts.push(part);
    }
  }
  return resultParts.join("/");
}

export function resolveLinkTarget(
  input: string,
  options?: {
    currentFilePath?: string | undefined;
    tree?: WorkspaceTreeEntry[] | undefined;
  },
): ResolvedTarget {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const allEntries = options?.tree ?? [];
  const files = allEntries.filter((e) => e.kind === "file");
  const knownDocPaths = new Set(allEntries.map((e) => e.path));

  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    const targetPath = options?.currentFilePath
      ? resolveRelativePath(trimmed, options.currentFilePath)
      : trimmed.replace(/^\.\//, "");
    if (targetPath) {
      const matched =
        findMatchingWorkspaceFile(targetPath, files) ??
        allEntries.find(
          (e) =>
            e.path === targetPath ||
            e.path.toLowerCase() === targetPath.toLowerCase(),
        );
      const resolvedPath = matched ? matched.path : targetPath;
      return {
        exists: matched ? true : knownDocPaths.size > 0 ? false : undefined,
        kind: "workspace",
        label: resolvedPath,
        path: resolvedPath,
      };
    }
  }

  if (trimmed.startsWith("openlia://")) {
    try {
      const url = new URL(trimmed);
      const host = url.host.toLowerCase();
      const rawPath = safeDecode(url.pathname.replace(/^\/+/, ""));
      if (host === "workspace") {
        const path = rawPath.replace(/^\/+/, "");
        if (!path) return null;
        const matched =
          findMatchingWorkspaceFile(path, files) ??
          allEntries.find(
            (e) =>
              e.path === path || e.path.toLowerCase() === path.toLowerCase(),
          );
        const resolvedPath = matched ? matched.path : path;
        return {
          exists: matched ? true : knownDocPaths.size > 0 ? false : undefined,
          kind: "workspace",
          label: resolvedPath,
          path: resolvedPath,
        };
      }
    } catch {
      // Continue to fallback parsing
    }
  }

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsedUrl = new URL(candidate);
      const searchPath =
        parsedUrl.searchParams.get("path") ??
        parsedUrl.searchParams.get("file");
      if (searchPath) {
        candidate = searchPath;
      } else {
        candidate = parsedUrl.pathname + parsedUrl.search;
      }
    } catch {
      // ignore
    }
  }

  if (candidate.startsWith("/?") || candidate.startsWith("?")) {
    try {
      const searchStr = candidate.startsWith("/?")
        ? candidate.slice(2)
        : candidate.slice(1);
      const searchParams = new URLSearchParams(searchStr);
      const searchPath = searchParams.get("path") ?? searchParams.get("file");
      if (searchPath) {
        candidate = searchPath;
      }
    } catch {
      // ignore
    }
  }

  if (
    candidate.startsWith("/files/") ||
    candidate.startsWith("/file/") ||
    candidate.startsWith("files/") ||
    candidate.startsWith("file/")
  ) {
    const withoutPrefix = candidate.replace(/^\/?files?\//, "");
    const pathPart = withoutPrefix.split("?")[0] ?? "";
    const path = safeDecode(pathPart).replace(/^\/+/, "");
    if (!path) return null;
    const matched =
      findMatchingWorkspaceFile(path, files) ??
      allEntries.find(
        (e) => e.path === path || e.path.toLowerCase() === path.toLowerCase(),
      );
    const resolvedPath = matched ? matched.path : path;
    return {
      exists: matched ? true : knownDocPaths.size > 0 ? false : undefined,
      kind: "workspace",
      label: resolvedPath,
      path: resolvedPath,
    };
  }

  if (
    candidate.startsWith("/workspace/") ||
    candidate.startsWith("workspace/")
  ) {
    const raw = candidate.replace(/^\/?workspace\//, "").replace(/^\/+/, "");
    if (!raw) return null;
    const matched = findMatchingWorkspaceFile(raw, files);
    const resolvedPath = matched ? matched.path : raw;
    return {
      exists: matched ? true : knownDocPaths.size > 0 ? false : undefined,
      kind: "workspace",
      label: resolvedPath,
      path: resolvedPath,
    };
  }

  const matchedFile = findMatchingWorkspaceFile(candidate, files);
  if (matchedFile) {
    return {
      exists: true,
      kind: "workspace",
      label: matchedFile.path,
      path: matchedFile.path,
    };
  }

  if (hasFileExtension(candidate) || candidate.includes("/")) {
    const path = candidate.replace(/^\/+/, "");
    return {
      exists: knownDocPaths.size > 0 ? false : undefined,
      kind: "workspace",
      label: path,
      path,
    };
  }

  return null;
}

export function filterGoToSuggestions(
  query: string,
  options?: {
    tree?: WorkspaceTreeEntry[] | undefined;
    limit?: number | undefined;
  },
): GoToSuggestion[] {
  const q = query.trim().toLowerCase();
  const limit = options?.limit ?? 10;
  const suggestions: GoToSuggestion[] = [];
  const files = options?.tree?.filter((entry) => entry.kind === "file") ?? [];

  if (!q) {
    for (const file of files.slice(0, limit)) {
      const parts = file.path.split("/");
      const domain = parts[0] && parts.length > 1 ? parts[0] : "workspace";
      suggestions.push({
        badge: file.editable ? domain : `${domain} (view only)`,
        id: file.path,
        kind: "workspace",
        title: file.path,
      });
    }
    return suggestions;
  }

  for (const file of files) {
    if (file.path.toLowerCase().includes(q)) {
      const parts = file.path.split("/");
      const domain = parts[0] && parts.length > 1 ? parts[0] : "workspace";
      suggestions.push({
        badge: file.editable ? domain : `${domain} (view only)`,
        id: file.path,
        kind: "workspace",
        title: file.path,
      });
    }
    if (suggestions.length >= limit) break;
  }

  return suggestions;
}

export function buildCanonicalWorkspaceUri(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `openlia://workspace/${cleanPath}`;
}

export function buildWorkspaceLink(path: string, baseOrigin?: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  const origin =
    baseOrigin !== undefined
      ? baseOrigin.replace(/\/+$/, "")
      : typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "";
  return `${origin}/files/${cleanPath}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to textarea fallback
    }
  }
  if (typeof document !== "undefined") {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      textArea.style.top = "-9999px";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const success = document.execCommand("copy");
      document.body.removeChild(textArea);
      return Boolean(success);
    } catch {
      return false;
    }
  }
  return false;
}
