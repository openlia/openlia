import type { DocumentScope, WorkspaceTreeEntry } from "../shared/api";

export type ResolvedTarget = {
  kind: DocumentScope;
  path: string;
  label: string;
  scope?: DocumentScope | undefined;
  exists?: boolean | undefined;
} | null;

export interface GoToSuggestion {
  kind: DocumentScope;
  id: string;
  title: string;
  subtitle?: string | undefined;
  badge: string;
  scope?: DocumentScope | undefined;
}

const COMMON_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".rem",
  ".remind",
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

function resolveScopedPath(
  path: string,
  scope: DocumentScope,
  entries: WorkspaceTreeEntry[],
): ResolvedTarget {
  const files = entries.filter((entry) => entry.kind === "file");
  const matched =
    findMatchingWorkspaceFile(path, files) ??
    entries.find(
      (entry) =>
        entry.path === path || entry.path.toLowerCase() === path.toLowerCase(),
    );
  const resolvedPath = matched ? matched.path : path;
  return {
    exists: matched ? true : entries.length > 0 ? false : undefined,
    kind: scope,
    scope,
    label: resolvedPath,
    path: resolvedPath,
  };
}

export function resolveLinkTarget(
  input: string,
  options?: {
    currentFilePath?: string | undefined;
    currentScope?: DocumentScope | undefined;
    tree?: WorkspaceTreeEntry[] | undefined;
    skillsTree?: WorkspaceTreeEntry[] | undefined;
    agentTree?: WorkspaceTreeEntry[] | undefined;
  },
): ResolvedTarget {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const workspaceTree = options?.tree ?? [];
  const skillsTree = options?.skillsTree ?? [];
  const agentTree = options?.agentTree ?? [];
  const currentScope = options?.currentScope ?? "workspace";
  const entriesForScope = (scope: DocumentScope) =>
    scope === "skills"
      ? skillsTree
      : scope === "agent"
        ? agentTree
        : workspaceTree;
  const resolvePath = (path: string, scope: DocumentScope) =>
    resolveScopedPath(path, scope, entriesForScope(scope));

  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    const targetPath = options?.currentFilePath
      ? resolveRelativePath(trimmed, options.currentFilePath)
      : trimmed.replace(/^\.\//, "");
    if (targetPath) return resolvePath(targetPath, currentScope);
  }

  if (trimmed.startsWith("openlia://")) {
    try {
      const url = new URL(trimmed);
      const host = url.host.toLowerCase();
      const path = safeDecode(url.pathname.replace(/^\/+/, "")).replace(
        /^\/+|\/+$/g,
        "",
      );
      if (host === "workspace") {
        return path ? resolvePath(path, "workspace") : null;
      }
      if (host === "skills" || host === "skill") {
        return path ? resolvePath(path, "skills") : null;
      }
      if (host === "agent") {
        return path ? resolvePath(path, "agent") : null;
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
      candidate = searchPath ?? parsedUrl.pathname + parsedUrl.search;
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
      if (searchPath) candidate = searchPath;
    } catch {
      // ignore
    }
  }

  if (
    candidate.startsWith("/skills/") ||
    candidate.startsWith("/skill/") ||
    candidate.startsWith("skills/") ||
    candidate.startsWith("skill/")
  ) {
    const withoutPrefix = candidate.replace(/^\/?skills?\//, "");
    const path = safeDecode(withoutPrefix.split("?")[0] ?? "").replace(
      /^\/+|\/+$/g,
      "",
    );
    return path ? resolvePath(path, "skills") : null;
  }

  if (
    candidate.startsWith("/files/") ||
    candidate.startsWith("/file/") ||
    candidate.startsWith("files/") ||
    candidate.startsWith("file/")
  ) {
    const withoutPrefix = candidate.replace(/^\/?files?\//, "");
    const path = safeDecode(withoutPrefix.split("?")[0] ?? "").replace(
      /^\/+|\/+$/g,
      "",
    );
    return path ? resolvePath(path, "workspace") : null;
  }

  if (candidate.startsWith("/agent/") || candidate.startsWith("agent/")) {
    const withoutPrefix = candidate.replace(/^\/?agent\//, "");
    const path = safeDecode(withoutPrefix.split("?")[0] ?? "").replace(
      /^\/+|\/+$/g,
      "",
    );
    return path ? resolvePath(path, "agent") : null;
  }

  if (
    candidate.startsWith("/workspace/") ||
    candidate.startsWith("workspace/")
  ) {
    const path = candidate
      .replace(/^\/?workspace\//, "")
      .replace(/^\/+|\/+$/g, "");
    return path ? resolvePath(path, "workspace") : null;
  }

  const matchedFile = findMatchingWorkspaceFile(
    candidate,
    entriesForScope(currentScope).filter((entry) => entry.kind === "file"),
  );
  if (matchedFile) return resolvePath(matchedFile.path, currentScope);

  if (hasFileExtension(candidate) || candidate.includes("/")) {
    const path = candidate.replace(/^\/+|\/+$/g, "");
    return path ? resolvePath(path, currentScope) : null;
  }

  return null;
}

export function filterGoToSuggestions(
  query: string,
  options?: {
    tree?: WorkspaceTreeEntry[] | undefined;
    skillsTree?: WorkspaceTreeEntry[] | undefined;
    agentTree?: WorkspaceTreeEntry[] | undefined;
    limit?: number | undefined;
  },
): GoToSuggestion[] {
  const q = query.trim().toLowerCase();
  const limit = options?.limit ?? 10;
  const suggestions: GoToSuggestion[] = [];

  const wsFiles = options?.tree?.filter((entry) => entry.kind === "file") ?? [];
  const skFiles =
    options?.skillsTree?.filter((entry) => entry.kind === "file") ?? [];
  const agFiles =
    options?.agentTree?.filter((entry) => entry.kind === "file") ?? [];

  function makeSuggestion(
    file: WorkspaceTreeEntry,
    scope: DocumentScope,
  ): GoToSuggestion {
    const parts = file.path.split("/");
    const domain =
      scope === "skills"
        ? parts[0]
          ? `Skill / ${parts[0]}`
          : "Skill"
        : scope === "agent"
          ? "Agent"
          : parts[0] && parts.length > 1
            ? parts[0]
            : "workspace";
    return {
      badge: file.editable ? domain : `${domain} (view only)`,
      id: file.path,
      kind: scope,
      scope,
      title: file.path,
    };
  }

  const all: Array<{ file: WorkspaceTreeEntry; scope: DocumentScope }> = [
    ...wsFiles.map((file) => ({
      file,
      scope: (file.scope ?? "workspace") as DocumentScope,
    })),
    ...skFiles.map((file) => ({
      file,
      scope: "skills" as DocumentScope,
    })),
    ...agFiles.map((file) => ({
      file,
      scope: "agent" as DocumentScope,
    })),
  ];

  if (!q) {
    for (const item of all.slice(0, limit)) {
      suggestions.push(makeSuggestion(item.file, item.scope));
    }
    return suggestions;
  }

  for (const item of all) {
    if (item.file.path.toLowerCase().includes(q)) {
      suggestions.push(makeSuggestion(item.file, item.scope));
    }
    if (suggestions.length >= limit) break;
  }

  return suggestions;
}

export function buildCanonicalWorkspaceUri(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `openlia://workspace/${cleanPath}`;
}

export function buildCanonicalSkillUri(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `openlia://skills/${cleanPath}`;
}

export function buildCanonicalAgentUri(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  return `openlia://agent/${cleanPath}`;
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

export function buildSkillLink(path: string, baseOrigin?: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  const origin =
    baseOrigin !== undefined
      ? baseOrigin.replace(/\/+$/, "")
      : typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "";
  return `${origin}/skills/${cleanPath}`;
}

export function buildAgentLink(path: string, baseOrigin?: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  const origin =
    baseOrigin !== undefined
      ? baseOrigin.replace(/\/+$/, "")
      : typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "";
  return `${origin}/agent/${cleanPath}`;
}

export function buildDocumentLink(
  path: string,
  scope: DocumentScope,
  baseOrigin?: string,
): string {
  if (scope === "skills") return buildSkillLink(path, baseOrigin);
  if (scope === "agent") return buildAgentLink(path, baseOrigin);
  return buildWorkspaceLink(path, baseOrigin);
}

export function buildCanonicalDocumentUri(
  path: string,
  scope: DocumentScope,
): string {
  if (scope === "skills") return buildCanonicalSkillUri(path);
  if (scope === "agent") return buildCanonicalAgentUri(path);
  return buildCanonicalWorkspaceUri(path);
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
