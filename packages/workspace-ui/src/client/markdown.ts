const ORIGINAL_MESSAGE_START = "<!-- ORIGINAL MESSAGE START -->";
const ORIGINAL_MESSAGE_END = "<!-- ORIGINAL MESSAGE END -->";

export interface OriginalMessageSections {
  body: string;
  originalMessage: string | null;
}

function markerLine(line: string, marker: string): boolean {
  return line.trim() === marker;
}

function fenceStart(
  line: string,
): { character: string; length: number } | null {
  const match = line.match(/^\s*(`{3,}|~{3,})/);
  const sequence = match?.[1];
  if (!sequence) return null;
  return { character: sequence[0] ?? "", length: sequence.length };
}

function fenceEnd(
  line: string,
  fence: { character: string; length: number },
): boolean {
  const escapedCharacter = fence.character === "`" ? "\\`" : "~";
  const pattern = new RegExp(`^\\s*${escapedCharacter}{${fence.length},}\\s*$`);
  return pattern.test(line);
}

export function extractOriginalMessage(body: string): OriginalMessageSections {
  const lines = body.split(/\r?\n/);
  let fence: { character: string; length: number } | null = null;
  let startIndex = -1;
  let endIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence) {
      if (fenceEnd(line, fence)) fence = null;
      continue;
    }

    const nextFence = fenceStart(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }

    if (startIndex < 0 && markerLine(line, ORIGINAL_MESSAGE_START)) {
      startIndex = index;
      continue;
    }
    if (startIndex >= 0 && markerLine(line, ORIGINAL_MESSAGE_END)) {
      endIndex = index;
      break;
    }
  }

  if (startIndex < 0) {
    return { body, originalMessage: null };
  }

  const messageEnd = endIndex >= 0 ? endIndex : lines.length;
  const before = lines.slice(0, startIndex).join("\n").trimEnd();
  const after =
    endIndex >= 0
      ? lines
          .slice(endIndex + 1)
          .join("\n")
          .trimStart()
      : "";
  const remaining = [before, after].filter(Boolean).join("\n\n");

  return {
    body: remaining,
    originalMessage: lines
      .slice(startIndex + 1, messageEnd)
      .join("\n")
      .trim(),
  };
}

export function diffLines(original: string, draft: string): string[] {
  if (original === draft) return [];

  const before = original.split("\n");
  const after = draft.split("\n");
  const rows: string[] = [];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const previous = before[index];
    const next = after[index];
    if (previous === next) {
      if (previous !== undefined) rows.push(`  ${previous}`);
      continue;
    }
    if (previous !== undefined) rows.push(`- ${previous}`);
    if (next !== undefined) rows.push(`+ ${next}`);
  }
  return rows;
}
