import YAML from "yaml";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown> | null;
  rawYaml: string | null;
  body: string;
}

function parseLenientYaml(raw: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch?.[1] && currentKey && currentList) {
      currentList.push(listMatch[1].trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kvMatch?.[1]) {
      const key = kvMatch[1];
      const rest = kvMatch[2] ?? "";
      currentKey = key;
      const val = rest.trim();
      if (!val) {
        currentList = [];
        result[key] = currentList;
      } else if (val.startsWith("[") && val.endsWith("]")) {
        result[key] = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
        currentList = null;
      } else {
        result[key] = val.replace(/^['"]|['"]$/g, "");
        currentList = null;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function parseMarkdownFrontmatter(content: string): ParsedMarkdown {
  if (!content.startsWith("---")) {
    return { body: content, frontmatter: null, rawYaml: null };
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match?.[1]) {
    return { body: content, frontmatter: null, rawYaml: null };
  }

  const rawYaml = match[1].trim();
  try {
    const parsed = YAML.parse(rawYaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        body: match[2] ?? "",
        frontmatter: parsed as Record<string, unknown>,
        rawYaml,
      };
    }
  } catch {
    const fallback = parseLenientYaml(rawYaml);
    if (fallback) {
      return {
        body: match[2] ?? "",
        frontmatter: fallback,
        rawYaml,
      };
    }
  }

  return { body: content, frontmatter: null, rawYaml: null };
}
