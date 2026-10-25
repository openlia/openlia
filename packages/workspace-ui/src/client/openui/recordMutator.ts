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
        fenceMatch[1].length >= codeFenceLen
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

  let currentMeta: Record<string, unknown> = {};
  let body = content;

  if (match && match[1] !== undefined) {
    body = match[2] ?? "";
    try {
      const parsed = YAML.parse(match[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        currentMeta = { ...(parsed as Record<string, unknown>) };
      }
    } catch {}
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete currentMeta[key];
    } else {
      currentMeta[key] = value;
    }
  }

  const serializedYaml = YAML.stringify(currentMeta).trim();
  const cleanBody = body.replace(/^\r?\n+/, "");
  return `---\n${serializedYaml}\n---\n\n${cleanBody}`;
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

  const lines = body.split(/\r?\n/);
  const targetHeading = heading?.trim().toLowerCase();
  let currentHeading: string | null = null;
  let currentTaskIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h2Match = line.match(/^[ \t]{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (h2Match && h2Match[1]) {
      currentHeading = h2Match[1].trim().toLowerCase();
      if (targetHeading) {
        currentTaskIndex = 0;
      }
      continue;
    }

    const inMatchingSection =
      !targetHeading || currentHeading === targetHeading;
    if (!inMatchingSection) continue;

    const taskMatch = line.match(/^([ \t]*[-*+][ \t]+\[)([ xX])(\][ \t]+.*)$/);
    if (taskMatch) {
      if (currentTaskIndex === itemIndex) {
        const currentlyChecked = (taskMatch[2] ?? "").toLowerCase() === "x";
        const nextChecked = checked !== undefined ? checked : !currentlyChecked;
        lines[i] = `${taskMatch[1]}${nextChecked ? "x" : " "}${taskMatch[3]}`;
        break;
      }
      currentTaskIndex++;
    }
  }

  return `${prefix}${lines.join("\n")}`;
}

export function addRecordChecklistItem(
  content: string,
  heading: string,
  itemText: string,
): string {
  const cleanText = itemText.trim();
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

  const lines = body.split(/\r?\n/);
  const targetHeading = heading.trim().toLowerCase();
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const h2Match = lines[i]!.match(/^[ \t]{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (h2Match && h2Match[1]) {
      const hText = h2Match[1].trim().toLowerCase();
      if (sectionStart === -1 && hText === targetHeading) {
        sectionStart = i;
      } else if (sectionStart !== -1) {
        sectionEnd = i;
        break;
      }
    }
  }

  if (sectionStart === -1) {
    // Section does not exist yet -> append section and checklist item
    const trimmed = body.trimEnd();
    return `${prefix}${trimmed}\n\n## ${heading.trim()}\n- [ ] ${cleanText}\n`;
  }

  // Insert before blank lines preceding next section
  let insertAt = sectionEnd;
  while (insertAt > sectionStart + 1 && lines[insertAt - 1]?.trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, `- [ ] ${cleanText}`);
  return `${prefix}${lines.join("\n")}`;
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

  const lines = body.split(/\r?\n/);
  const targetHeading = heading.trim().toLowerCase();
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const h2Match = lines[i]!.match(/^[ \t]{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (h2Match && h2Match[1]) {
      const hText = h2Match[1].trim().toLowerCase();
      if (sectionStart === -1 && hText === targetHeading) {
        sectionStart = i;
      } else if (sectionStart !== -1) {
        sectionEnd = i;
        break;
      }
    }
  }

  const replacementLines = newSectionMarkdown.trim()
    ? [newSectionMarkdown.trim(), ""]
    : [""];

  if (sectionStart === -1) {
    const trimmed = body.trimEnd();
    return `${prefix}${trimmed}\n\n## ${heading.trim()}\n${replacementLines.join("\n")}`;
  }

  lines.splice(
    sectionStart + 1,
    sectionEnd - (sectionStart + 1),
    ...replacementLines,
  );
  return `${prefix}${lines.join("\n")}`;
}
