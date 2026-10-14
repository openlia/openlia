import type { CalendarEvent } from "./types";

const MONTHS: Record<string, number> = {};
for (const [index, name] of [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
].entries()) {
  MONTHS[name] = index + 1;
  MONTHS[name.slice(0, 3)] = index + 1;
}

const WEEKDAYS: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 0,
  sunday: 0,
};

export function parseInfoClauses(text: string): Record<string, string> {
  const results: Record<string, string> = {};
  const pattern = /INFO\s+"([^":]+):\s*([^"]*)"/gi;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const headerToken = match[1];
    const valToken = match[2];
    if (headerToken && valToken !== undefined) {
      const header = headerToken.trim().toLowerCase();
      const val = valToken.trim().replace(/\\"/g, '"').replace(/\\n/g, "\n");
      results[header] = val;
    }
    match = pattern.exec(text);
  }
  return results;
}

export function parseRemLine(
  statement: string,
  lineNumber: number = 1,
  sourceFile: string = "calendar/reminders.rem",
): CalendarEvent | null {
  const clean = statement.trim();
  if (!clean.toUpperCase().startsWith("REM ")) {
    return null;
  }

  const msgSplit = clean.split(/\b(?:MSG|msg)\b/);
  if (msgSplit.length < 2) {
    return null;
  }

  const remHead = msgSplit[0] ?? "";
  const summary = msgSplit.slice(1).join("MSG").trim();

  const info = parseInfoClauses(remHead);

  // Time: AT HH:MM
  const timeMatch = remHead.match(/\bAT\s+([0-9]{1,2}:[0-9]{2})\b/i);
  const timeStr = timeMatch?.[1] ? timeMatch[1].padStart(5, "0") : undefined;

  // Duration: DURATION H:MM or DURATION M
  const durMatch = remHead.match(/\bDURATION\s+([0-9]+(?::[0-9]{2})?)\b/i);
  let durationMins = 0;
  const durStr = durMatch?.[1];
  if (durStr) {
    if (durStr.includes(":")) {
      const [h, m] = durStr.split(":");
      durationMins = parseInt(h ?? "0", 10) * 60 + parseInt(m ?? "0", 10);
    } else {
      durationMins = parseInt(durStr, 10);
    }
  } else if (timeStr) {
    // Default to 60 minutes if time is specified but duration isn't
    durationMins = 60;
  }

  // Tags: TAG <name>
  const tags: string[] = [];
  const tagPattern = /\bTAG\s+([^\s\\]+)/gi;
  let tagMatch: RegExpExecArray | null = tagPattern.exec(remHead);
  while (tagMatch !== null) {
    if (tagMatch[1]) {
      tags.push(tagMatch[1]);
    }
    tagMatch = tagPattern.exec(remHead);
  }

  // Priority: PRIORITY <num>
  const prioMatch = remHead.match(/\bPRIORITY\s+([0-9]+)\b/i);
  const priority = prioMatch?.[1] ? parseInt(prioMatch[1], 10) : undefined;

  // Date and repeat
  // Only inspect the trigger prefix, never quoted INFO text or clause values.
  const tokens: string[] = [];
  for (const token of remHead.trim().split(/\s+/).slice(1)) {
    const low = token.toLowerCase();
    if (
      !(low in WEEKDAYS) &&
      !(low in MONTHS) &&
      !/^(?:[0-9]+|[0-9]{4}[-/][0-9]{2}[-/][0-9]{2}|\*[0-9]+|[+-][0-9]+)$/.test(
        token,
      )
    )
      break;
    tokens.push(token);
  }
  let dateStr = "";
  let repeatStr: string | undefined;

  for (const token of tokens) {
    if (token.startsWith("*")) {
      repeatStr = token;
      continue;
    }
    // Match ISO date YYYY-MM-DD
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(token)) {
      dateStr = token;
      break;
    }
    // Match YYYY/MM/DD
    if (/^[0-9]{4}\/[0-9]{2}\/[0-9]{2}$/.test(token)) {
      dateStr = token.replace(/\//g, "-");
      break;
    }
  }

  if (!dateStr) {
    // Remind also accepts named-month dates in either order.
    const namedDate = tokens
      .join(" ")
      .match(
        /\b(?:([0-9]{1,2})\s+([a-z]+)|([a-z]+)\s+([0-9]{1,2}))\s+([0-9]{4})\b/i,
      );
    if (namedDate) {
      const day = Number(namedDate[1] ?? namedDate[4]);
      const month = MONTHS[(namedDate[2] ?? namedDate[3] ?? "").toLowerCase()];
      const year = Number(namedDate[5]);
      if (month) {
        const date = new Date(Date.UTC(year, month - 1, day));
        if (
          date.getUTCFullYear() === year &&
          date.getUTCMonth() === month - 1 &&
          date.getUTCDate() === day
        ) {
          dateStr = date.toISOString().slice(0, 10);
        }
      }
    }
  }

  if (!dateStr) {
    for (const token of tokens) {
      const low = token.toLowerCase();
      if (low in WEEKDAYS) {
        dateStr = low;
        break;
      }
    }
  }

  const attendeesVal =
    info.attendees || info.attendee || info.participants || "";
  const attendees = attendeesVal
    ? attendeesVal
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
    : [];

  const location = info.location || info.venue || info.address || undefined;
  let mapUrl =
    info["map-url"] ||
    info.map_url ||
    info.map ||
    info["map-link"] ||
    info.gmap ||
    undefined;

  if (location && !mapUrl) {
    const urlMatch = location.match(/\((https?:\/\/[^)]+)\)/);
    if (urlMatch) {
      mapUrl = urlMatch[1];
    }
  }

  const callUrl =
    info["video-link"] ||
    info.video_link ||
    info["video-url"] ||
    info.call ||
    info["call-link"] ||
    info["call-url"] ||
    info.url ||
    undefined;

  const description =
    info.description ||
    info.agenda ||
    info.details ||
    info.summary ||
    undefined;

  const note =
    info["event-note"] ||
    info.event_note ||
    info.note ||
    info["note-path"] ||
    undefined;

  const id = `${sourceFile}:${lineNumber}:${summary.slice(0, 20).replace(/\s+/g, "_")}`;

  return {
    id,
    summary,
    date: dateStr || "unspecified",
    time: timeStr,
    duration: durationMins,
    attendees,
    location,
    mapUrl,
    callUrl,
    description,
    note,
    tags,
    priority,
    repeat: repeatStr,
    sourceFile,
    lineNumber,
    rawStatement: statement,
  };
}

export function parseRemindFile(
  content: string,
  sourceFile: string = "calendar/reminders.rem",
): { events: CalendarEvent[]; includedFiles: string[] } {
  const events: CalendarEvent[] = [];
  const includedFiles: string[] = [];

  const lines = content.split(/\r?\n/);
  let currentBlock: string[] = [];
  let blockStartLine = 1;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    if (rawLine === undefined) continue;
    const line = rawLine.trimEnd();

    if (currentBlock.length === 0) {
      blockStartLine = idx + 1;
    }

    if (line.endsWith("\\")) {
      currentBlock.push(line.slice(0, -1).trimEnd());
    } else {
      currentBlock.push(line);
      const fullStatement = currentBlock.join(" ").trim();
      currentBlock = [];

      if (!fullStatement || fullStatement.startsWith("#")) {
        continue;
      }

      if (
        fullStatement.toUpperCase().startsWith("INCLUDE ") ||
        fullStatement.toUpperCase().startsWith("INCLUDE\t")
      ) {
        const includePath = fullStatement
          .slice(7)
          .trim()
          .replace(/^["']|["']$/g, "");
        if (includePath) {
          includedFiles.push(includePath);
        }
        continue;
      }

      const event = parseRemLine(fullStatement, blockStartLine, sourceFile);
      if (event) {
        events.push(event);
      }
    }
  }

  return { events, includedFiles };
}

export function formatRemStatement(event: Partial<CalendarEvent>): string {
  const dateStr = event.date || new Date().toISOString().slice(0, 10);
  const tokens = ["REM", dateStr];

  if (event.repeat) {
    tokens.push(`*${event.repeat.replace(/^\*/, "")}`);
  }

  if (event.time) {
    tokens.push("AT", event.time);
  }

  if (event.duration && event.duration > 0) {
    const hours = Math.floor(event.duration / 60);
    const mins = event.duration % 60;
    const durStr =
      hours > 0 && mins > 0
        ? `${hours}:${mins.toString().padStart(2, "0")}`
        : `${event.duration}`;
    tokens.push("DURATION", durStr);
  }

  if (event.priority !== undefined) {
    tokens.push("PRIORITY", event.priority.toString());
  }

  if (event.tags && event.tags.length > 0) {
    for (const tag of event.tags) {
      if (tag.trim()) {
        tokens.push("TAG", tag.trim());
      }
    }
  }

  const infoClauses: string[] = [];

  if (event.location) {
    const cleanLoc = event.location.trim().replace(/"/g, '\\"');
    infoClauses.push(`INFO "Location: ${cleanLoc}"`);
  }

  if (event.mapUrl) {
    const cleanMap = event.mapUrl.trim().replace(/"/g, '\\"');
    infoClauses.push(`INFO "Map-Url: ${cleanMap}"`);
  }

  if (event.callUrl) {
    const cleanCall = event.callUrl.trim().replace(/"/g, '\\"');
    infoClauses.push(`INFO "Video-Link: ${cleanCall}"`);
  }

  if (event.attendees && event.attendees.length > 0) {
    const cleanAtt = event.attendees.join(", ").replace(/"/g, '\\"');
    infoClauses.push(`INFO "Attendees: ${cleanAtt}"`);
  }

  if (event.description) {
    const cleanDesc = event.description
      .trim()
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
    infoClauses.push(`INFO "Description: ${cleanDesc}"`);
  }

  if (event.note) {
    const cleanNote = event.note.trim().replace(/"/g, '\\"');
    infoClauses.push(`INFO "Event-Note: ${cleanNote}"`);
  }

  const cleanSummary = (event.summary || "Untitled Event")
    .trim()
    .replace(/\n/g, " ");

  const lines = [`${tokens.join(" ")} \\`];
  for (const clause of infoClauses) {
    lines.push(`    ${clause} \\`);
  }
  lines.push(`    MSG ${cleanSummary}`);
  return lines.join("\n");
}

export function addEventToFile(
  content: string,
  event: Partial<CalendarEvent>,
): string {
  const remStatement = formatRemStatement(event);
  const trimmed = content.trimEnd();
  return trimmed ? `${trimmed}\n\n${remStatement}\n` : `${remStatement}\n`;
}

export function updateEventInFile(
  content: string,
  originalEvent: CalendarEvent,
  updatedEvent: Partial<CalendarEvent>,
): string {
  const newStatement = formatRemStatement({
    ...originalEvent,
    ...updatedEvent,
  });

  if (originalEvent.rawStatement) {
    const rawNormalized = originalEvent.rawStatement.trim();
    const contentLines = content.split(/\r?\n/);

    // Try finding by statement match
    const wholeContent = content;
    if (wholeContent.includes(rawNormalized)) {
      return wholeContent.replace(rawNormalized, newStatement);
    }

    // Try finding by line number if possible
    if (
      originalEvent.lineNumber &&
      originalEvent.lineNumber > 0 &&
      originalEvent.lineNumber <= contentLines.length
    ) {
      // Find the block starting at lineNumber
      let endLine = originalEvent.lineNumber - 1;
      while (
        endLine < contentLines.length &&
        contentLines[endLine]?.trimEnd().endsWith("\\")
      ) {
        endLine++;
      }
      contentLines.splice(
        originalEvent.lineNumber - 1,
        endLine - originalEvent.lineNumber + 2,
        newStatement,
      );
      return contentLines.join("\n");
    }
  }

  // Fallback to append if original not found
  return addEventToFile(content, updatedEvent);
}

export function deleteEventFromFile(
  content: string,
  event: CalendarEvent,
): string {
  if (event.rawStatement) {
    const raw = event.rawStatement.trim();
    if (content.includes(raw)) {
      return `${content
        .replace(raw, "")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd()}\n`;
    }
  }

  if (event.lineNumber && event.lineNumber > 0) {
    const lines = content.split(/\r?\n/);
    let endLine = event.lineNumber - 1;
    while (endLine < lines.length && lines[endLine]?.trimEnd().endsWith("\\")) {
      endLine++;
    }
    lines.splice(event.lineNumber - 1, endLine - event.lineNumber + 2);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  return content;
}

export function expandEventsForRange(
  events: CalendarEvent[],
  startIso: string,
  endIso: string,
): CalendarEvent[] {
  const result: CalendarEvent[] = [];
  const startDate = new Date(`${startIso}T00:00:00Z`);
  const endDate = new Date(`${endIso}T23:59:59Z`);

  for (const ev of events) {
    const evDateLow = ev.date.toLowerCase();

    // Specific ISO date
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(ev.date)) {
      if (ev.date >= startIso && ev.date <= endIso) {
        result.push(ev);
      }
      continue;
    }

    // Weekday recurrence (mon, tue, wed...)
    if (evDateLow in WEEKDAYS) {
      const targetWeekday = WEEKDAYS[evDateLow];
      const cur = new Date(startDate.getTime());

      while (cur <= endDate) {
        if (cur.getUTCDay() === targetWeekday) {
          const dateStr = cur.toISOString().slice(0, 10);
          result.push({
            ...ev,
            id: `${ev.id}_${dateStr}`,
            date: dateStr,
          });
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
  }

  // Sort by date, time, priority
  return result.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const timeA = a.time || "23:59";
    const timeB = b.time || "23:59";
    if (timeA !== timeB) return timeA.localeCompare(timeB);
    return (a.priority ?? 500) - (b.priority ?? 500);
  });
}
