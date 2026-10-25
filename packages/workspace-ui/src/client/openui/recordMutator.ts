import YAML from "yaml";

export interface ChecklistItem {
  index: number;
  text: string;
  checked: boolean;
  lineIndex: number;
}

export interface ParsedRecordDocument {
  metadata: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
  title: string;
  sections: Record<string, string>;
  checklists: Record<string, ChecklistItem[]>;
}

export function parseMarkdownRecord(content: string): ParsedRecordDocument {
  let metadata: Record<string, unknown> = {};
  let body = content;
  let hasFrontmatter = false;

  if (content.startsWith("---")) {
    const match = content.match(
      /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/,
    );
    if (match && match[1] !== undefined) {
      hasFrontmatter = true;
      body = match[2] ?? "";
      try {
        const parsed = YAML.parse(match[1].trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {}
    }
  }

  const lines = body.split(/\r?\n/);
  let title = "";
  const sections: Record<string, string> = {};
  const checklists: Record<string, ChecklistItem[]> = {};

  let currentHeading: string | null = null;
  let currentLines: string[] = [];
  let inCodeBlock = false;
  let codeFenceChar = "";
  let codeFenceLen = 0;

  const flushSection = () => {
    if (currentHeading !== null) {
      sections[currentHeading] = currentLines.join("\n").trim();
    }
  };

  lines.forEach((line, idx) => {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (inCodeBlock) {
      if (
        fenceMatch &&
        fenceMatch[1] &&
        fenceMatch[1][0] === codeFenceChar &&
        fenceMatch[1].length >= codeFenceLen &&
        line.trim() === fenceMatch[1]
      ) {
        inCodeBlock = false;
        codeFenceChar = "";
        codeFenceLen = 0;
      }
      if (currentHeading !== null) currentLines.push(line);
      return;
    }
    if (fenceMatch && fenceMatch[1] && fenceMatch[1].length > 0) {
      inCodeBlock = true;
      codeFenceChar = fenceMatch[1][0] ?? "";
      codeFenceLen = fenceMatch[1].length;
      if (currentHeading !== null) currentLines.push(line);
      return;
    }

    const h1Match = line.match(/^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (h1Match && h1Match[1] && !title) {
      title = h1Match[1].trim();
      return;
    }

    const h2Match = line.match(/^[ \t]{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (h2Match && h2Match[1]) {
      flushSection();
      currentHeading = h2Match[1].trim();
      currentLines = [];
      if (!checklists[currentHeading]) {
        checklists[currentHeading] = [];
      }
      return;
    }

    if (currentHeading !== null) {
      currentLines.push(line);
      const taskMatch = line.match(/^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/);
      if (taskMatch) {
        const list = checklists[currentHeading] ?? [];
        list.push({
          index: list.length,
          checked: (taskMatch[1] ?? "").toLowerCase() === "x",
          text: (taskMatch[2] ?? "").trim(),
          lineIndex: idx,
        });
        checklists[currentHeading] = list;
      }
    }
  });

  flushSection();

  return {
    metadata,
    body,
    hasFrontmatter,
    title,
    sections,
    checklists,
  };
}

export function extractMarkdownSection(
  bodyOrContent: string,
  heading: string,
): string {
  const parsed = parseMarkdownRecord(bodyOrContent);
  const target = heading.trim().toLowerCase();
  for (const [k, v] of Object.entries(parsed.sections)) {
    if (k.trim().toLowerCase() === target) return v;
  }
  return "";
}

export function extractMarkdownChecklist(
  bodyOrContent: string,
  heading?: string,
): ChecklistItem[] {
  const parsed = parseMarkdownRecord(bodyOrContent);
  if (heading && heading.trim()) {
    const target = heading.trim().toLowerCase();
    for (const [k, items] of Object.entries(parsed.checklists)) {
      if (k.trim().toLowerCase() === target) return items;
    }
    return [];
  }
  const all: ChecklistItem[] = [];
  for (const items of Object.values(parsed.checklists)) {
    for (const item of items) {
      all.push({ ...item, index: all.length });
    }
  }
  return all;
}

export function mutateRecordFrontmatter(
  content: string,
  updates: Record<string, unknown>,
): string {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return content;
  }
  const match = content.match(
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/,
  );

  const document = YAML.parseDocument(match?.[1] ?? "");
  if (
    document.errors.length ||
    (document.contents && !YAML.isMap(document.contents))
  ) {
    throw new Error("Cannot edit invalid or non-mapping YAML frontmatter");
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      document.delete(key);
    } else {
      document.set(key, value);
    }
  }
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const yaml = document.toString().trimEnd().replace(/\r?\n/g, newline);
  if (match) {
    // Only replace YAML; the delimiters, body, and spacing remain byte-for-byte.
    const yamlStart = content.indexOf("\n") + 1;
    return (
      content.slice(0, yamlStart) +
      yaml +
      content.slice(yamlStart + (match[1]?.length ?? 0))
    );
  }
  if (content.startsWith("---"))
    throw new Error("Cannot edit malformed frontmatter");
  return `---${newline}${yaml}${newline}---${newline}${newline}${content}`;
}

export function toggleRecordChecklistItem(
  content: string,
  heading: string | undefined,
  itemIndex: number,
  checked?: boolean,
): string {
  const hasFrontmatter = content.startsWith("---");
  let prefix = "";
  let body = content;

  if (hasFrontmatter) {
    const match = content.match(
      /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?)([\s\S]*)$/,
    );
    if (match && match[1] !== undefined) {
      prefix = match[1];
      body = match[2] ?? "";
    }
  }

  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(newline);
  const item = extractMarkdownChecklist(body, heading)[itemIndex];
  if (!item) return content;
  const line = lines[item.lineIndex];
  if (line === undefined) return content;
  lines[item.lineIndex] = line.replace(
    /^(\s*[-*+]\s+\[)[ xX](\])/,
    `$1${(checked ?? !item.checked) ? "x" : " "}$2`,
  );
  return `${prefix}${lines.join(newline)}`;
}

// Locate structural headings only, never headings inside code examples.
function sectionBounds(lines: string[], heading: string): [number, number] {
  let start = -1;
  let fence = "";
  let fenceLength = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (
        marker?.[1]?.[0] === fence &&
        marker[1].length >= fenceLength &&
        line.trim() === marker[1]
      )
        fence = "";
      continue;
    }
    if (marker?.[1]) {
      fence = marker[1][0]!;
      fenceLength = marker[1].length;
      continue;
    }
    const match = line.match(/^[ \t]{0,3}(#{1,2})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (!match) continue;
    if (start !== -1) return [start, i];
    if (
      match[1] === "##" &&
      match[2]?.trim().toLowerCase() === heading.trim().toLowerCase()
    )
      start = i;
  }
  return [start, lines.length];
}

export function addRecordChecklistItem(
  content: string,
  heading: string,
  itemText: string,
): string {
  const cleanText = itemText.trim().replace(/[\r\n]+/g, " ");
  if (!cleanText) return content;

  const hasFrontmatter = content.startsWith("---");
  let prefix = "";
  let body = content;

  if (hasFrontmatter) {
    const match = content.match(
      /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?)([\s\S]*)$/,
    );
    if (match && match[1] !== undefined) {
      prefix = match[1];
      body = match[2] ?? "";
    }
  }

  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(newline);
  const [sectionStart, sectionEnd] = sectionBounds(lines, heading);

  if (sectionStart === -1) {
    // Section does not exist yet -> append section and checklist item
    const trimmed = body.trimEnd();
    return `${prefix}${trimmed}${newline}${newline}## ${heading.trim()}${newline}- [ ] ${cleanText}${newline}`;
  }

  // Insert before blank lines preceding next section
  let insertAt = sectionEnd;
  while (insertAt > sectionStart + 1 && lines[insertAt - 1]?.trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, `- [ ] ${cleanText}`);
  return `${prefix}${lines.join(newline)}`;
}

export function updateRecordSectionContent(
  content: string,
  heading: string,
  newSectionMarkdown: string,
): string {
  const hasFrontmatter = content.startsWith("---");
  let prefix = "";
  let body = content;

  if (hasFrontmatter) {
    const match = content.match(
      /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?)([\s\S]*)$/,
    );
    if (match && match[1] !== undefined) {
      prefix = match[1];
      body = match[2] ?? "";
    }
  }

  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(newline);
  const [sectionStart, sectionEnd] = sectionBounds(lines, heading);

  const replacementLines = newSectionMarkdown.trim()
    ? [newSectionMarkdown.trim().replace(/\r?\n/g, newline), ""]
    : [""];

  if (sectionStart === -1) {
    const trimmed = body.trimEnd();
    return `${prefix}${trimmed}${newline}${newline}## ${heading.trim()}${newline}${replacementLines.join(newline)}`;
  }

  lines.splice(
    sectionStart + 1,
    sectionEnd - (sectionStart + 1),
    ...replacementLines,
  );
  return `${prefix}${lines.join(newline)}`;
}
