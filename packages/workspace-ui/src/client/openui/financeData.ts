import { resolveRelativePath } from "../openliaLinks";
import {
  extractJournalIncludes,
  parseHledgerJournalWithFiles,
} from "../journal/parser";

// Preview data only: this parser is not an authoritative hledger check. Missing,
// globbed, or unsupported includes must remain visible instead of implying zero.
export async function loadFinanceJournal(
  path: string,
  load: (path: string) => Promise<{ content: string }>,
) {
  const files: Array<{ filePath: string; content: string }> = [];
  const warnings: string[] = [];
  const queue = [path];
  const visited = new Set<string>();
  while (queue.length && visited.size < 50) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);
    if (
      /[?*\[\]]/.test(next) ||
      next.startsWith("/") ||
      next.split("/").includes("..")
    ) {
      warnings.push(`Unsupported journal path: ${next}`);
      continue;
    }
    try {
      const { content } = await load(next);
      files.push({ filePath: next, content });
      for (const include of extractJournalIncludes(content)) {
        queue.push(resolveRelativePath(include, next));
      }
    } catch {
      warnings.push(`Could not load ${next}`);
    }
  }
  if (queue.length) warnings.push("Journal include limit reached");
  return { parsed: parseHledgerJournalWithFiles(files), warnings };
}
