import type { SkillSummary, WorkspaceTreeEntry } from "../shared/api";
import {
  isMemoryDocument,
  memoryDocumentPath,
  memoryFilename,
} from "../shared/memory";

export type ResolvedTarget =
  | {
      kind: "workspace";
      path: string;
      label: string;
      exists?: boolean | undefined;
    }
  | {
      kind: "skill";
      skillId: string;
      skillFile?: string | undefined;
      label: string;
      exists?: boolean | undefined;
    }
  | {
      kind: "git-activity";
      label: string;
      exists?: boolean | undefined;
    }
  | {
      kind: "ingestion";
      sourceId: string;
      versionId?: string | undefined;
      page?: number | undefined;
      label: string;
      exists?: boolean | undefined;
    }
  | null;

export interface GoToSuggestion {
  kind: "workspace" | "skill" | "git-activity" | "ingestion";
  id: string;
  title: string;
  subtitle?: string | undefined;
  badge: string;
  skillFile?: string | undefined;
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

export function parseSkillRemainder(
  remainder: string,
  knownSkillIds?: string[] | undefined,
): { skillId: string; skillFile?: string | undefined } {
  const cleanRemainder = remainder.replace(/^\/+|\/+$/g, "");
  if (!cleanRemainder) {
    return { skillId: "", skillFile: undefined };
  }

  // 1. Try matching against known skill IDs if provided
  if (knownSkillIds && knownSkillIds.length > 0) {
    // Sort longer IDs first so 'productivity/notion' matches before 'productivity'
    const sortedIds = [...knownSkillIds].sort((a, b) => b.length - a.length);
    for (const id of sortedIds) {
      if (cleanRemainder === id) {
        return { skillId: id, skillFile: undefined };
      }
      if (cleanRemainder.startsWith(`${id}/`)) {
        const filePart = cleanRemainder
          .slice(id.length + 1)
          .replace(/^\/+/, "");
        return {
          skillId: id,
          skillFile: filePart || undefined,
        };
      }
    }
  }

  // 2. Heuristic parsing when skill is not in known list
  const parts = cleanRemainder.split("/").filter(Boolean);
  const p0 = parts[0] ?? "";
  const p1 = parts[1] ?? "";

  if (parts.length === 1) {
    return { skillId: p0, skillFile: undefined };
  }

  if (parts.length === 2) {
    // If parts[1] has a file extension, parts[0] is skillId and parts[1] is skillFile
    if (hasFileExtension(p1)) {
      return { skillId: p0, skillFile: p1 };
    }
    // Otherwise, treat as category/skill-name
    return { skillId: `${p0}/${p1}`, skillFile: undefined };
  }

  // parts.length >= 3
  const SKILL_SUBDIRECTORIES = new Set([
    "scripts",
    "templates",
    "references",
    "docs",
    "tests",
    "assets",
    "data",
  ]);

  if (hasFileExtension(p1) || SKILL_SUBDIRECTORIES.has(p1)) {
    return { skillId: p0, skillFile: parts.slice(1).join("/") };
  }
  return {
    skillId: `${p0}/${p1}`,
    skillFile: parts.slice(2).join("/"),
  };
}

function findMatchingWorkspaceFile(
  candidate: string,
  files: WorkspaceTreeEntry[],
): WorkspaceTreeEntry | undefined {
  const clean = candidate.replace(/^\/+/, "");
  if (!clean) return undefined;
  const lowerClean = clean.toLowerCase();

  // 1. Exact path match (case-sensitive)
  const exact = files.find((f) => f.path === clean);
  if (exact) return exact;

  // 2. Exact path match (case-insensitive)
  const exactCi = files.find((f) => f.path.toLowerCase() === lowerClean);
  if (exactCi) return exactCi;

  // 3. Exact basename with extension match (case-sensitive, then case-insensitive)
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

  // 4. Path without extension match (e.g. "goals/career" matching "goals/career.md")
  const pathNoExt = files.find((f) => {
    const withoutExt = f.path.replace(/\.[^/.]+$/, "");
    return withoutExt.toLowerCase() === lowerClean;
  });
  if (pathNoExt) return pathNoExt;

  // 5. Basename stem without extension match (e.g. "career" matching "goals/career.md")
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
    skills?: SkillSummary[] | undefined;
    tree?: WorkspaceTreeEntry[] | undefined;
  },
): ResolvedTarget {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const knownSkillIds = options?.skills?.map((s) => s.id) ?? [];
  const files = options?.tree?.filter((e) => e.kind === "file") ?? [];
  const knownDocPaths = new Set(files.map((e) => e.path));

  // 0. Handle relative paths (e.g. ./sibling.md or ../folder/doc.md)
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    const targetPath = options?.currentFilePath
      ? resolveRelativePath(trimmed, options.currentFilePath)
      : trimmed.replace(/^\.\//, "");
    if (targetPath) {
      const matched = findMatchingWorkspaceFile(targetPath, files);
      const resolvedPath = matched ? matched.path : targetPath;
      return {
        exists: matched ? true : knownDocPaths.size > 0 ? false : undefined,
        kind: "workspace",
        label: resolvedPath,
        path: resolvedPath,
      };
    }
  }

  // 1. Handle openlia:// scheme
  if (trimmed.startsWith("openlia://")) {
    try {
      const url = new URL(trimmed);
      const host = url.host.toLowerCase();
      const rawPath = safeDecode(url.pathname.replace(/^\/+/, ""));
      const querySkillFile = url.searchParams.get("skillFile")?.trim();

      if (host === "workspace" || host === "memory") {
        const path =
          host === "memory"
            ? memoryDocumentPath(rawPath)
            : rawPath.replace(/^\/+/, "");
        if (!path) return null;
        const matched = findMatchingWorkspaceFile(path, files);
        const resolvedPath = matched ? matched.path : path;
        return {
          exists: matched ? true : knownDocPaths.size > 0 ? false : undefined,
          kind: "workspace",
          label: resolvedPath,
          path: resolvedPath,
        };
      }

      if (host === "skills") {
        if (!rawPath && !querySkillFile) return null;
        const { skillId, skillFile } = parseSkillRemainder(
          rawPath,
          knownSkillIds,
        );
        const finalSkillFile = querySkillFile || skillFile;
        if (!skillId) return null;

        const skillExists =
          knownSkillIds.length > 0
            ? knownSkillIds.includes(skillId)
            : undefined;

        const label = finalSkillFile
          ? `${skillId} (${finalSkillFile})`
          : skillId;

        return {
          exists: skillExists,
          kind: "skill",
          label,
          skillFile: finalSkillFile,
          skillId,
        };
      }

      if (host === "git-activity") {
        return {
          exists: true,
          kind: "git-activity",
          label: "Git Activity",
        };
      }

      if (host === "source" || host === "sources" || host === "ingestion") {
        const sourceId = rawPath.split("/")[0] || "";
        if (!sourceId) return null;
        let versionId: string | undefined;
        let page: number | undefined;
        const hash = url.hash.replace(/^#/, "");
        if (hash) {
          const vMatch = hash.match(/^(ver_[A-Za-z0-9_-]+)/);
          if (vMatch) versionId = vMatch[1];
          const pMatch = hash.match(/(?:^|\/)p(\d+)/);
          if (pMatch && pMatch[1]) page = Number.parseInt(pMatch[1], 10);
        }
        return {
          exists: true,
          kind: "ingestion",
          sourceId,
          versionId,
          page,
          label: page ? `Source / ${sourceId} (p. ${page})` : `Source / ${sourceId}`,
        };
      }
    } catch {
      // Continue to fallback parsing
    }
  }

  // 2. Handle HTTP / absolute or relative web URLs
  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsedUrl = new URL(candidate);
      const searchPath =
        parsedUrl.searchParams.get("path") ??
        parsedUrl.searchParams.get("file");
      const searchSkill = parsedUrl.searchParams.get("skill");
      const searchSkillFile = parsedUrl.searchParams.get("skillFile");
      if (searchPath) {
        candidate = searchPath;
      } else if (searchSkill) {
        candidate = `/skills/${searchSkill}${searchSkillFile ? `?skillFile=${searchSkillFile}` : ""}`;
      } else {
        candidate = parsedUrl.pathname + parsedUrl.search;
      }
    } catch {
      // ignore
    }
  }

  // Handle root-relative query parameters (e.g. /?path=... or ?path=...)
  if (candidate.startsWith("/?") || candidate.startsWith("?")) {
    try {
      const searchStr = candidate.startsWith("/?")
        ? candidate.slice(2)
        : candidate.slice(1);
      const searchParams = new URLSearchParams(searchStr);
      const searchPath = searchParams.get("path") ?? searchParams.get("file");
      const searchSkill = searchParams.get("skill");
      const searchSkillFile = searchParams.get("skillFile");
      if (searchPath) {
        candidate = searchPath;
      } else if (searchSkill) {
        candidate = `/skills/${searchSkill}${searchSkillFile ? `?skillFile=${searchSkillFile}` : ""}`;
      }
    } catch {
      // ignore
    }
  }

  if (
    candidate.startsWith("/ingestion/") ||
    candidate.startsWith("ingestion/")
  ) {
    const raw = candidate
      .replace(/^\/?ingestion\//, "")
      .split("?")[0]
      ?.split("#")[0] ?? "";
    if (raw) {
      return {
        exists: true,
        kind: "ingestion",
        sourceId: raw,
        label: `Source / ${raw}`,
      };
    }
  }

  if (candidate.startsWith("/memory/") || candidate.startsWith("memory/")) {
    const name = safeDecode(
      candidate.replace(/^\/?memory\//, "").split("?")[0] ?? "",
    );
    if (!name) return null;
    const path = memoryDocumentPath(name);
    return {
      kind: "workspace",
      path,
      label: `Assistant memory / ${name}`,
      exists: knownDocPaths.has(path),
    };
  }

  // /files/... or /file/... or files/... or file/...
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
    const matched = findMatchingWorkspaceFile(path, files);
    const resolvedPath = matched ? matched.path : path;
    return {
      exists: matched ? true : knownDocPaths.size > 0 ? false : undefined,
      kind: "workspace",
      label: resolvedPath,
      path: resolvedPath,
    };
  }

  // /skills/... or skills/...
  if (
    candidate.startsWith("/skills/") ||
    candidate === "/skills" ||
    candidate.startsWith("skills/") ||
    candidate === "skills"
  ) {
    const withoutPrefix = candidate.replace(/^\/?skills\/?/, "");
    const [pathPart = "", queryPart = ""] = withoutPrefix.split("?");
    const queryParams = new URLSearchParams(queryPart);
    const querySkillFile = queryParams.get("skillFile")?.trim();
    const rawSkillPath = safeDecode(pathPart);

    const { skillId, skillFile } = parseSkillRemainder(
      rawSkillPath,
      knownSkillIds,
    );
    const finalSkillFile = querySkillFile || skillFile;
    if (!skillId) return null;

    const skillExists =
      knownSkillIds.length > 0 ? knownSkillIds.includes(skillId) : undefined;
    const label = finalSkillFile ? `${skillId} (${finalSkillFile})` : skillId;

    return {
      exists: skillExists,
      kind: "skill",
      label,
      skillFile: finalSkillFile,
      skillId,
    };
  }

  // /workspace/... or workspace/...
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

  // Direct match to known skill ID
  if (knownSkillIds.includes(candidate)) {
    return {
      exists: true,
      kind: "skill",
      label: candidate,
      skillId: candidate,
    };
  }

  // Check matching workspace file in tree
  const matchedFile = findMatchingWorkspaceFile(candidate, files);
  if (matchedFile) {
    return {
      exists: true,
      kind: "workspace",
      label: matchedFile.path,
      path: matchedFile.path,
    };
  }

  // Fallback: check if matches any skill name (case-insensitive)
  const matchedSkill = options?.skills?.find(
    (s) =>
      s.name.toLowerCase() === candidate.toLowerCase() ||
      s.id.toLowerCase() === candidate.toLowerCase(),
  );
  if (matchedSkill) {
    return {
      exists: true,
      kind: "skill",
      label: matchedSkill.id,
      skillId: matchedSkill.id,
    };
  }

  // Direct match to git-activity
  if (
    candidate === "/git-activity" ||
    candidate === "git-activity" ||
    candidate === "/git-activity/"
  ) {
    return {
      exists: true,
      kind: "git-activity",
      label: "Git Activity",
    };
  }

  // Generic fallback: if it has a file extension or looks like a file path
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
    skills?: SkillSummary[] | undefined;
    tree?: WorkspaceTreeEntry[] | undefined;
    limit?: number | undefined;
  },
): GoToSuggestion[] {
  const q = query.trim().toLowerCase();
  const limit = options?.limit ?? 10;
  const suggestions: GoToSuggestion[] = [];

  const files = options?.tree?.filter((entry) => entry.kind === "file") ?? [];
  const skills = options?.skills ?? [];

  if (!q) {
    // Show a mix of recent/starter documents and pinned/active skills
    const pinnedSkills = skills.filter((s) => s.pinned);
    const otherSkills = skills.filter((s) => !s.pinned);
    for (const skill of [...pinnedSkills, ...otherSkills].slice(0, 5)) {
      suggestions.push({
        badge: skill.category ? `Skill / ${skill.category}` : "Skill",
        id: skill.id,
        kind: "skill",
        subtitle: skill.description,
        title: skill.name,
      });
    }

    for (const file of files.slice(0, 5)) {
      const parts = file.path.split("/");
      const domain = parts[0] && parts.length > 1 ? parts[0] : "workspace";
      suggestions.push({
        badge: domain,
        id: file.path,
        kind: "workspace",
        title: file.path,
      });
    }

    return suggestions.slice(0, limit);
  }

  // Filter skills
  for (const skill of skills) {
    const matchName = skill.name.toLowerCase().includes(q);
    const matchId = skill.id.toLowerCase().includes(q);
    const matchCategory = skill.category.toLowerCase().includes(q);
    const matchDesc = skill.description.toLowerCase().includes(q);

    if (matchName || matchId || matchCategory || matchDesc) {
      suggestions.push({
        badge: skill.category ? `Skill / ${skill.category}` : "Skill",
        id: skill.id,
        kind: "skill",
        subtitle: skill.description,
        title: skill.name,
      });
    }
    if (suggestions.length >= limit) break;
  }

  // Filter documents
  for (const file of files) {
    if (file.path.toLowerCase().includes(q)) {
      const parts = file.path.split("/");
      const domain = parts[0] && parts.length > 1 ? parts[0] : "workspace";
      suggestions.push({
        badge: domain,
        id: file.path,
        kind: "workspace",
        title: file.path,
      });
    }
    if (suggestions.length >= limit) break;
  }

  // Suggest Git Activity when query matches
  if (
    suggestions.length < limit &&
    q &&
    ("git-activity".includes(q) || "git".includes(q))
  ) {
    suggestions.push({
      badge: "Version Control",
      id: "git-activity",
      kind: "git-activity",
      subtitle: "Background Git history records and commits",
      title: "Git Activity",
    });
  }

  return suggestions.slice(0, limit);
}

export function buildCanonicalWorkspaceUri(path: string): string {
  if (isMemoryDocument(path)) return `openlia://memory/${memoryFilename(path)}`;
  const cleanPath = path.replace(/^\/+/, "");
  return `openlia://workspace/${cleanPath}`;
}

export function buildCanonicalSkillUri(
  skillId: string,
  skillFile?: string | undefined,
): string {
  const cleanSkillId = skillId.replace(/^\/+|\/+$/g, "");
  if (!skillFile) {
    return `openlia://skills/${cleanSkillId}`;
  }
  const cleanFile = skillFile.replace(/^\/+/, "");
  return `openlia://skills/${cleanSkillId}/${cleanFile}`;
}

export function buildWorkspaceLink(path: string, baseOrigin?: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  const origin =
    baseOrigin !== undefined
      ? baseOrigin.replace(/\/+$/, "")
      : typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "";
  return isMemoryDocument(cleanPath)
    ? `${origin}/memory/${encodeURIComponent(memoryFilename(cleanPath))}`
    : `${origin}/files/${cleanPath}`;
}

export function buildSkillLink(
  skillId: string,
  skillFile?: string | undefined,
  baseOrigin?: string,
): string {
  const cleanSkillId = skillId.replace(/^\/+|\/+$/g, "");
  const origin =
    baseOrigin !== undefined
      ? baseOrigin.replace(/\/+$/, "")
      : typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "";
  if (!skillFile) {
    return `${origin}/skills/${cleanSkillId}`;
  }
  const cleanFile = skillFile.replace(/^\/+/, "");
  return `${origin}/skills/${cleanSkillId}/${cleanFile}`;
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
