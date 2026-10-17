import type {
  CalendarEvent,
  RemindInfoEntry,
  RemindParseWarning,
  RemindSchedule,
  RemindScheduleKind,
} from "./types";

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

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const CLAUSE_WORDS = new Set([
  "addomit",
  "after",
  "at",
  "before",
  "complete-through",
  "duration",
  "from",
  "info",
  "max-overdue",
  "noqueue",
  "omit",
  "omitfunc",
  "priority",
  "scanfrom",
  "sched",
  "tag",
  "through",
  "timezone",
  "todo",
  "tz",
  "until",
  "warn",
]);

const UNSUPPORTED_CLAUSES = new Set([
  "addomit",
  "after",
  "before",
  "complete-through",
  "max-overdue",
  "noqueue",
  "omit",
  "omitfunc",
  "scanfrom",
  "sched",
  "todo",
  "tz",
  "warn",
]);

interface ParsedDateValue {
  iso: string;
  consumed: number;
}

interface ParsedDateSpec {
  dateSpec: string;
  startDate?: string;
  anchorDate?: string | undefined;
  kind: RemindScheduleKind;
  weekdays: number[];
  dayOfMonth?: number | undefined;
  month?: number | undefined;
  year?: number | undefined;
  anchorDay?: number | undefined;
  invalid: boolean;
}

interface ParsedSchedule {
  schedule: RemindSchedule;
  date: string;
  repeat?: string | undefined;
  infoText: string;
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function toIsoDate(year: number, month: number, day: number): string | null {
  return isValidDate(year, month, day)
    ? `${year.toString().padStart(4, "0")}-${month
        .toString()
        .padStart(2, "0")}-${day.toString().padStart(2, "0")}`
    : null;
}

function tokenize(text: string): string[] {
  return text.match(/\S+/g) ?? [];
}

function stripInfoClauses(text: string): string {
  return text.replace(/INFO\s+"(?:\\.|[^"\\])*"/gi, " ");
}

function decodeRemindText(value: string): string {
  return value.replace(/%%/g, "%");
}

function parseInfoEntries(text: string): RemindInfoEntry[] {
  const entries: RemindInfoEntry[] = [];
  const pattern = /INFO\s+"((?:\\.|[^"\\])*)"/gi;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const raw = match[1] ?? "";
    const colon = raw.indexOf(":");
    if (colon > 0) {
      const header = raw.slice(0, colon).trim().toLowerCase();
      const value = raw
        .slice(colon + 1)
        .trim()
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      entries.push({
        header,
        value,
        raw: match[0],
      });
    }
    match = pattern.exec(text);
  }
  return entries;
}

export function parseInfoClauses(text: string): Record<string, string> {
  const results: Record<string, string> = {};
  for (const entry of parseInfoEntries(text)) {
    results[entry.header] = entry.value;
  }
  return results;
}

function findKeywordOutsideQuotes(text: string, keyword: string): number {
  const pattern = new RegExp(`\\b${keyword}\\b`, "gi");
  let quote = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && quote && !escaped) {
      escaped = true;
      continue;
    }
    if (char === '"' && !escaped) quote = !quote;
    escaped = false;

    if (!quote) {
      pattern.lastIndex = index;
      const match = pattern.exec(text);
      if (match?.index === index) return index;
    }
  }

  return -1;
}

function parseDateAt(tokens: string[], start: number): ParsedDateValue | null {
  const token = tokens[start];
  if (!token) return null;

  const isoMatch = token.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const iso = toIsoDate(year, month, day);
    return iso ? { iso, consumed: 1 } : null;
  }

  const first = tokens[start]?.toLowerCase();
  const second = tokens[start + 1]?.toLowerCase();
  const third = tokens[start + 2]?.toLowerCase();
  if (!first || !second || !third) return null;

  const yearToken = [first, second, third].find((value) =>
    /^\d{4}$/.test(value),
  );
  const monthToken = [first, second, third].find((value) => value in MONTHS);
  const dayToken = [first, second, third].find((value) =>
    /^\d{1,2}$/.test(value),
  );
  if (!yearToken || !monthToken || !dayToken) return null;

  const iso = toIsoDate(
    Number(yearToken),
    MONTHS[monthToken] ?? 0,
    Number(dayToken),
  );
  return iso ? { iso, consumed: 3 } : null;
}

function isDateSpecToken(token: string): boolean {
  const lower = token.toLowerCase();
  return (
    lower in WEEKDAYS ||
    lower in MONTHS ||
    /^\d{1,4}$/.test(token) ||
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(token)
  );
}

function parseDateSpec(tokens: string[]): ParsedDateSpec {
  const dateSpec = tokens.join(" ");
  const weekdays = tokens
    .map((token) => WEEKDAYS[token.toLowerCase()])
    .filter((value): value is number => value !== undefined);
  const monthToken = tokens.find((token) => token.toLowerCase() in MONTHS);
  const month = monthToken ? MONTHS[monthToken.toLowerCase()] : undefined;
  const yearToken = tokens.find((token) => /^\d{4}$/.test(token));
  const year = yearToken ? Number(yearToken) : undefined;
  const dayToken = tokens.find(
    (token) => /^\d{1,2}$/.test(token) && Number(token) >= 1,
  );
  const dayOfMonth = dayToken ? Number(dayToken) : undefined;

  for (let index = 0; index < tokens.length; index++) {
    const parsed = parseDateAt(tokens, index);
    if (parsed) {
      if (weekdays.length > 0) {
        const anchorMonth = Number(parsed.iso.slice(5, 7));
        const anchorDay = Number(parsed.iso.slice(8, 10));
        return {
          dateSpec,
          anchorDate: parsed.iso,
          kind: "weekday",
          weekdays,
          dayOfMonth: dayOfMonth ?? anchorDay,
          month: month ?? anchorMonth,
          year: year ?? Number(parsed.iso.slice(0, 4)),
          anchorDay: dayOfMonth ?? anchorDay,
          invalid: false,
        };
      }
      return {
        dateSpec,
        startDate: parsed.iso,
        kind: "once",
        weekdays,
        dayOfMonth,
        month,
        year,
        anchorDay: weekdays.length > 0 ? dayOfMonth : undefined,
        invalid: false,
      };
    }
  }

  const hasInvalidFullDate = tokens.some((token) =>
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(token),
  );
  if (hasInvalidFullDate || (year !== undefined && month && dayOfMonth)) {
    if (year !== undefined && month && dayOfMonth) {
      const maybeIso = toIsoDate(year, month, dayOfMonth);
      if (maybeIso) {
        return {
          dateSpec,
          startDate: maybeIso,
          kind: "once",
          weekdays,
          dayOfMonth,
          month,
          year,
          anchorDay: weekdays.length > 0 ? dayOfMonth : undefined,
          invalid: false,
        };
      }
    }
    return {
      dateSpec,
      kind: "daily",
      weekdays,
      dayOfMonth,
      month,
      year,
      invalid: true,
    };
  }

  let kind: RemindScheduleKind = "daily";
  if (weekdays.length > 0) kind = "weekday";
  else if (dayOfMonth !== undefined && month === undefined) kind = "monthly";
  else if (month !== undefined || year !== undefined) kind = "yearly";
  else if (dayOfMonth !== undefined) kind = "monthly";

  return {
    dateSpec,
    kind,
    weekdays,
    dayOfMonth,
    month,
    year,
    anchorDay: weekdays.length > 0 ? dayOfMonth : undefined,
    invalid: false,
  };
}

function readClauseDate(
  tokens: string[],
  start: number,
): { date: ParsedDateValue; raw: string } | null {
  const date = parseDateAt(tokens, start);
  if (!date) return null;
  return {
    date,
    raw: tokens.slice(start, start + date.consumed).join(" "),
  };
}

function isClauseStart(token: string | undefined): boolean {
  if (!token) return false;
  const lower = token.toLowerCase();
  return CLAUSE_WORDS.has(lower) || lower === "once" || /^\*\d+$/.test(token);
}

function addUnsupported(unsupported: string[], clause: string): void {
  if (!unsupported.includes(clause)) unsupported.push(clause);
}

function parseSchedule(
  remHead: string,
): ParsedSchedule & { unsupportedClauses: string[] } {
  const withoutInfo = stripInfoClauses(remHead);
  const tokens = tokenize(withoutInfo);
  const dateTokens: string[] = [];
  const preservedClauses: string[] = [];
  const unsupportedClauses: string[] = [];
  let repeat: string | undefined;
  let intervalDays: number | undefined;
  let endDate: string | undefined;
  let endKeyword: "THROUGH" | "UNTIL" | undefined;
  let fromDate: string | undefined;
  let advanceDays: number | undefined;
  let advanceToken: string | undefined;
  let backDays: number | undefined;
  let backToken: string | undefined;

  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    const lower = token.toLowerCase();

    if (lower === "once") {
      preservedClauses.push("ONCE");
      continue;
    }
    if (
      lower === "at" ||
      lower === "duration" ||
      lower === "tag" ||
      lower === "priority"
    ) {
      index++;
      continue;
    }
    if (/^\*\d+$/.test(token)) {
      const days = Number(token.slice(1));
      if (days > 0) {
        repeat = token;
        intervalDays = days;
      }
      continue;
    }
    if (/^\+\+?\d+$/.test(token)) {
      advanceDays = Number(token.replace(/^\+\+?/, ""));
      advanceToken = token;
      preservedClauses.push(token);
      continue;
    }
    if (/^--?\d+$/.test(token)) {
      backDays = Number(token.replace(/^--?/, ""));
      backToken = token;
      preservedClauses.push(token);
      if (backDays !== 7) addUnsupported(unsupportedClauses, token);
      continue;
    }

    if (lower === "through" || lower === "until") {
      const clauseDate = readClauseDate(tokens, index + 1);
      if (clauseDate) {
        endDate = clauseDate.date.iso;
        endKeyword = lower.toUpperCase() as "THROUGH" | "UNTIL";
        index += clauseDate.date.consumed;
      } else {
        addUnsupported(unsupportedClauses, lower.toUpperCase());
        preservedClauses.push(token);
      }
      continue;
    }
    if (lower === "from") {
      const clauseDate = readClauseDate(tokens, index + 1);
      if (clauseDate) {
        fromDate = clauseDate.date.iso;
        index += clauseDate.date.consumed;
      } else {
        addUnsupported(unsupportedClauses, "FROM");
        preservedClauses.push(token);
      }
      continue;
    }
    if (lower === "scanfrom") {
      const clauseDate = readClauseDate(tokens, index + 1);
      const raw = clauseDate
        ? tokens.slice(index, index + 1 + clauseDate.date.consumed).join(" ")
        : token;
      preservedClauses.push(raw);
      addUnsupported(unsupportedClauses, "SCANFROM");
      if (clauseDate) index += clauseDate.date.consumed;
      continue;
    }
    if (lower === "omit") {
      const clauseTokens = [token];
      while (index + 1 < tokens.length && !isClauseStart(tokens[index + 1])) {
        index++;
        clauseTokens.push(tokens[index] ?? "");
      }
      preservedClauses.push(clauseTokens.join(" "));
      addUnsupported(unsupportedClauses, "OMIT");
      continue;
    }
    if (
      lower === "omitfunc" ||
      lower === "sched" ||
      lower === "warn" ||
      lower === "tz" ||
      lower === "timezone" ||
      lower === "max-overdue" ||
      lower === "complete-through"
    ) {
      const clauseDate =
        lower === "complete-through" ? readClauseDate(tokens, index + 1) : null;
      const consumed = clauseDate?.date.consumed ?? 1;
      preservedClauses.push(
        tokens.slice(index, index + 1 + consumed).join(" "),
      );
      addUnsupported(unsupportedClauses, token.toUpperCase());
      index += consumed;
      continue;
    }
    if (UNSUPPORTED_CLAUSES.has(lower)) {
      preservedClauses.push(token.toUpperCase());
      addUnsupported(unsupportedClauses, token.toUpperCase());
      continue;
    }
    if (lower === "addomit") {
      preservedClauses.push(token.toUpperCase());
      addUnsupported(unsupportedClauses, "ADDOMIT");
      continue;
    }
    if (isDateSpecToken(token)) {
      dateTokens.push(token);
      continue;
    }

    preservedClauses.push(token);
    addUnsupported(unsupportedClauses, token.toUpperCase());
  }

  const parsedDate = parseDateSpec(dateTokens);
  const schedule: RemindSchedule = {
    kind: parsedDate.kind,
    dateSpec: parsedDate.dateSpec || undefined,
    startDate: parsedDate.startDate,
    anchorDate: parsedDate.anchorDate,
    endDate,
    endKeyword,
    fromDate,
    repeat,
    intervalDays,
    advanceDays,
    advanceToken,
    backDays,
    backToken,
    weekdays: parsedDate.weekdays,
    dayOfMonth: parsedDate.dayOfMonth,
    month: parsedDate.month,
    year: parsedDate.year,
    anchorDay: parsedDate.anchorDay,
    isRecurring:
      !parsedDate.invalid &&
      (parsedDate.dateSpec.length === 0
        ? unsupportedClauses.length === 0
        : parsedDate.kind !== "once" ||
          repeat !== undefined ||
          endKeyword === "THROUGH"),
    preservedClauses,
    unsupportedClauses,
  };

  let date = parsedDate.startDate ?? "unspecified";
  if (!parsedDate.startDate && parsedDate.weekdays.length > 0) {
    date = WEEKDAY_NAMES[parsedDate.weekdays[0] ?? 0] ?? "unspecified";
  } else if (!parsedDate.startDate && parsedDate.dayOfMonth !== undefined) {
    date = parsedDate.dayOfMonth.toString();
  }
  if (parsedDate.invalid) {
    date = "unspecified";
    addUnsupported(unsupportedClauses, "INVALID DATE");
  }

  return {
    schedule,
    date,
    repeat,
    infoText: withoutInfo,
    unsupportedClauses,
  };
}

export function parseRemLine(
  statement: string,
  lineNumber: number = 1,
  sourceFile: string = "calendar/reminders.rem",
): CalendarEvent | null {
  const clean = statement.trim();
  if (!/^REM(?:\s|$)/i.test(clean)) return null;

  const msgIndex = findKeywordOutsideQuotes(clean, "MSG");
  if (msgIndex < 0) return null;

  const remHead = clean.slice(0, msgIndex).trim();
  const rawSummary = clean.slice(msgIndex + 3).trim();
  const summary = decodeRemindText(rawSummary);
  const rawInfoEntries = parseInfoEntries(remHead);
  const info: Record<string, string> = {};
  for (const entry of rawInfoEntries) info[entry.header] = entry.value;
  const parsed = parseSchedule(remHead);

  const timeMatch = parsed.infoText.match(/\bAT\s+([0-9]{1,2}:[0-9]{2})\b/i);
  const timeStr = timeMatch?.[1] ? timeMatch[1].padStart(5, "0") : undefined;

  const durMatch = parsed.infoText.match(
    /\bDURATION\s+([0-9]+(?::[0-9]{2})?)\b/i,
  );
  let durationMins = 0;
  const durStr = durMatch?.[1];
  if (durStr) {
    if (durStr.includes(":")) {
      const [hours, minutes] = durStr.split(":");
      durationMins =
        parseInt(hours ?? "0", 10) * 60 + parseInt(minutes ?? "0", 10);
    } else {
      durationMins = parseInt(durStr, 10);
    }
  } else if (timeStr) {
    durationMins = 60;
  }

  const tags: string[] = [];
  const tagPattern = /\bTAG\s+([^\s\\]+)/gi;
  let tagMatch: RegExpExecArray | null = tagPattern.exec(parsed.infoText);
  while (tagMatch !== null) {
    if (tagMatch[1]) tags.push(tagMatch[1]);
    tagMatch = tagPattern.exec(parsed.infoText);
  }

  const prioMatch = parsed.infoText.match(/\bPRIORITY\s+([0-9]+)\b/i);
  const priority = prioMatch?.[1] ? parseInt(prioMatch[1], 10) : undefined;

  const attendeesVal =
    info.attendees || info.attendee || info.participants || "";
  const attendees = attendeesVal
    ? attendeesVal
        .split(",")
        .map((attendee) => attendee.trim())
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
    if (urlMatch) mapUrl = urlMatch[1];
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

  const id = `${sourceFile}:${lineNumber}:${summary
    .slice(0, 20)
    .replace(/\s+/g, "_")}`;

  return {
    id,
    summary,
    date: parsed.date,
    endDate: parsed.schedule.endDate,
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
    repeat: parsed.repeat,
    advanceDays: parsed.schedule.advanceDays,
    advanceToken: parsed.schedule.advanceToken,
    schedule: parsed.schedule,
    info,
    rawInfoEntries,
    rawSummary,
    unsupportedClauses:
      parsed.unsupportedClauses.length > 0
        ? parsed.unsupportedClauses
        : undefined,
    sourceFile,
    lineNumber,
    rawStatement: statement,
  };
}

export function parseRemindFile(
  content: string,
  sourceFile: string = "calendar/reminders.rem",
): {
  events: CalendarEvent[];
  includedFiles: string[];
  warnings: RemindParseWarning[];
} {
  const events: CalendarEvent[] = [];
  const includedFiles: string[] = [];
  const warnings: RemindParseWarning[] = [];
  const lines = content.split(/\r?\n/);
  let currentBlock: string[] = [];
  let blockStartLine = 1;
  let conditionalDepth = 0;

  const flushBlock = (fullStatement: string) => {
    if (
      !fullStatement ||
      fullStatement.startsWith("#") ||
      fullStatement.startsWith(";")
    ) {
      return;
    }
    if (/^INCLUDE(?:\s|\t)/i.test(fullStatement)) {
      const includePath = fullStatement
        .slice(7)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (includePath) includedFiles.push(includePath);
      return;
    }

    const command = fullStatement.match(/^([A-Za-z][A-Za-z-]*)\b/)?.[1];
    if (command && /^(?:IF|IFTRIG)$/i.test(command)) {
      conditionalDepth++;
      warnings.push({
        sourceFile,
        lineNumber: blockStartLine,
        message: `${command.toUpperCase()} blocks are not evaluated by the workspace calendar preview.`,
      });
      return;
    }
    if (command && /^(?:ELSEIF?|ENDIF)$/i.test(command)) {
      if (/^ENDIF$/i.test(command))
        conditionalDepth = Math.max(0, conditionalDepth - 1);
      warnings.push({
        sourceFile,
        lineNumber: blockStartLine,
        message: `${command.toUpperCase()} is not evaluated by the workspace calendar preview.`,
      });
      return;
    }
    if (conditionalDepth > 0) {
      if (/^REM(?:\s|$)/i.test(fullStatement)) {
        warnings.push({
          sourceFile,
          lineNumber: blockStartLine,
          message:
            "REM inside an unsupported conditional block is not displayed.",
        });
      }
      return;
    }

    if (!/^REM(?:\s|$)/i.test(fullStatement)) {
      warnings.push({
        sourceFile,
        lineNumber: blockStartLine,
        message: `${command?.toUpperCase() || "This"} directive is not evaluated by the workspace calendar preview.`,
      });
      return;
    }

    const event = parseRemLine(fullStatement, blockStartLine, sourceFile);
    if (!event) {
      if (/^REM(?:\s|$)/i.test(fullStatement)) {
        warnings.push({
          sourceFile,
          lineNumber: blockStartLine,
          message:
            "This REM entry is not displayed because the preview currently supports MSG reminders only.",
        });
      }
      return;
    }
    events.push(event);
    for (const clause of event.unsupportedClauses ?? []) {
      warnings.push({
        sourceFile,
        lineNumber: blockStartLine,
        message: `${clause} is not fully evaluated by the workspace calendar preview.`,
      });
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    if (rawLine === undefined) continue;
    const line = rawLine.trimEnd();
    if (currentBlock.length === 0) blockStartLine = index + 1;

    if (line.endsWith("\\")) {
      currentBlock.push(line.slice(0, -1).trimEnd());
    } else {
      currentBlock.push(line);
      flushBlock(currentBlock.join(" ").trim());
      currentBlock = [];
    }
  }
  if (currentBlock.length > 0) flushBlock(currentBlock.join(" ").trim());

  return { events, includedFiles, warnings };
}

function escapeInfoValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function canonicalInfoHeader(header: string): string {
  return header
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

interface InfoField {
  group: string;
  header: string;
  value: string | undefined;
}

function infoFieldForHeader(
  header: string,
  event: Partial<CalendarEvent>,
): InfoField | null {
  switch (header) {
    case "location":
    case "venue":
    case "address":
      return { group: "location", header: "Location", value: event.location };
    case "map-url":
    case "map_url":
    case "map":
    case "map-link":
    case "gmap":
      return { group: "map", header: "Map-Url", value: event.mapUrl };
    case "video-link":
    case "video_link":
    case "video-url":
    case "call":
    case "call-link":
    case "call-url":
    case "url":
      return { group: "call", header: "Video-Link", value: event.callUrl };
    case "attendees":
    case "attendee":
    case "participants":
      return {
        group: "attendees",
        header: "Attendees",
        value:
          event.attendees && event.attendees.length > 0
            ? event.attendees.join(", ")
            : undefined,
      };
    case "description":
    case "agenda":
    case "details":
    case "summary":
      return {
        group: "description",
        header: "Description",
        value: event.description,
      };
    case "event-note":
    case "event_note":
    case "note":
    case "note-path":
      return { group: "note", header: "Event-Note", value: event.note };
    default:
      return null;
  }
}

function sourceInfoHeader(
  event: Partial<CalendarEvent>,
  group: string,
): string | undefined {
  const aliases: Record<string, string[]> = {
    location: ["location", "venue", "address"],
    map: ["map-url", "map_url", "map", "map-link", "gmap"],
    call: [
      "video-link",
      "video_link",
      "video-url",
      "call",
      "call-link",
      "call-url",
      "url",
    ],
    attendees: ["attendees", "attendee", "participants"],
    description: ["description", "agenda", "details", "summary"],
    note: ["event-note", "event_note", "note", "note-path"],
  };
  return aliases[group]?.find((header) =>
    Object.hasOwn(event.info ?? {}, header),
  );
}

function infoEntriesForEvent(event: Partial<CalendarEvent>): RemindInfoEntry[] {
  if (event.rawInfoEntries) return event.rawInfoEntries;
  return Object.entries(event.info ?? {}).map(([header, value]) => ({
    header,
    value,
    raw: `INFO "${canonicalInfoHeader(header)}: ${escapeInfoValue(value)}"`,
  }));
}

function scheduleTokens(event: Partial<CalendarEvent>): string[] {
  const schedule = event.schedule;
  const targetStartDate =
    event.date || schedule?.startDate || new Date().toISOString().slice(0, 10);
  const targetEndDate =
    event.endDate !== undefined ? event.endDate : schedule?.endDate;

  if (!schedule) {
    const tokens = [targetStartDate];
    if (targetEndDate && targetEndDate !== targetStartDate) {
      tokens.push("THROUGH", targetEndDate);
    }
    if (event.repeat) tokens.push(`*${event.repeat.replace(/^\*/, "")}`);
    return tokens;
  }

  const tokens: string[] = [];
  if (schedule.dateSpec) tokens.push(schedule.dateSpec);
  for (const clause of schedule.preservedClauses ?? []) tokens.push(clause);
  if (schedule.repeat && !tokens.includes(schedule.repeat)) {
    tokens.push(schedule.repeat);
  }
  const endKeyword =
    schedule.endKeyword || (targetEndDate ? "THROUGH" : undefined);
  const endDate = targetEndDate || schedule.endDate;
  if (endKeyword && endDate) {
    tokens.push(endKeyword, endDate);
  }
  if (schedule.fromDate) tokens.push("FROM", schedule.fromDate);
  return tokens;
}

export function formatRemStatement(event: Partial<CalendarEvent>): string {
  const tokens = ["REM", ...scheduleTokens(event)];

  if (event.time) tokens.push("AT", event.time);
  if (event.duration && event.duration > 0) {
    const hours = Math.floor(event.duration / 60);
    const minutes = event.duration % 60;
    const duration =
      hours > 0 && minutes > 0
        ? `${hours}:${minutes.toString().padStart(2, "0")}`
        : `${event.duration}`;
    tokens.push("DURATION", duration);
  }
  if (event.priority !== undefined) {
    tokens.push("PRIORITY", event.priority.toString());
  }
  for (const tag of event.tags ?? []) {
    if (tag.trim()) tokens.push("TAG", tag.trim());
  }

  const infoClauses: string[] = [];
  const addInfo = (header: string, value: string | undefined) => {
    if (value) infoClauses.push(`INFO "${header}: ${escapeInfoValue(value)}"`);
  };
  const emittedInfoGroups = new Set<string>();
  for (const entry of infoEntriesForEvent(event)) {
    const field = infoFieldForHeader(entry.header, event);
    if (!field) {
      infoClauses.push(entry.raw);
      continue;
    }
    const isSourceEntry = sourceInfoHeader(event, field.group) === entry.header;
    if (!isSourceEntry || (field.value && field.value === entry.value)) {
      infoClauses.push(entry.raw);
      emittedInfoGroups.add(field.group);
    } else if (field.value && !emittedInfoGroups.has(field.group)) {
      addInfo(field.header, field.value);
      emittedInfoGroups.add(field.group);
    }
  }

  const fields: InfoField[] = [
    { group: "location", header: "Location", value: event.location },
    { group: "map", header: "Map-Url", value: event.mapUrl },
    { group: "call", header: "Video-Link", value: event.callUrl },
    {
      group: "attendees",
      header: "Attendees",
      value:
        event.attendees && event.attendees.length > 0
          ? event.attendees.join(", ")
          : undefined,
    },
    { group: "description", header: "Description", value: event.description },
    { group: "note", header: "Event-Note", value: event.note },
  ];
  for (const field of fields) {
    if (field.value && !emittedInfoGroups.has(field.group)) {
      addInfo(field.header, field.value);
    }
  }

  const summary = event.summary || "Untitled Event";
  const cleanSummary =
    event.rawSummary && decodeRemindText(event.rawSummary) === summary
      ? event.rawSummary
      : summary.trim().replace(/\n/g, " ").replace(/%/g, "%%");
  const lines = [`${tokens.join(" ")} \\`];
  for (const clause of infoClauses) lines.push(`    ${clause} \\`);
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
  const preserveSchedule =
    originalEvent.schedule?.isRecurring === true ||
    updatedEvent.date === undefined ||
    updatedEvent.date === originalEvent.date;
  const targetSchedule =
    preserveSchedule && originalEvent.schedule
      ? {
          ...originalEvent.schedule,
          endDate:
            updatedEvent.endDate !== undefined
              ? updatedEvent.endDate
              : originalEvent.schedule.endDate,
          startDate:
            updatedEvent.date !== undefined
              ? updatedEvent.date
              : originalEvent.schedule.startDate,
        }
      : undefined;
  const newStatement = formatRemStatement({
    ...originalEvent,
    ...updatedEvent,
    schedule: targetSchedule,
  });

  if (originalEvent.rawStatement) {
    const rawNormalized = originalEvent.rawStatement.trim();
    const contentLines = content.split(/\r?\n/);
    if (content.includes(rawNormalized))
      return content.replace(rawNormalized, newStatement);

    if (
      originalEvent.lineNumber &&
      originalEvent.lineNumber > 0 &&
      originalEvent.lineNumber <= contentLines.length
    ) {
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

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateFromIso(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function dateIsBefore(left: string, right: string): boolean {
  return left < right;
}

function dateIsAfter(left: string, right: string): boolean {
  return left > right;
}

function addDays(value: string, days: number): string {
  const date = dateFromIso(value);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function daysBetween(start: string, end: string): number {
  return Math.round(
    (dateFromIso(end).getTime() - dateFromIso(start).getTime()) / 86400000,
  );
}

function matchesSchedule(date: string, schedule: RemindSchedule): boolean {
  if (schedule.fromDate && dateIsBefore(date, schedule.fromDate)) return false;
  if (schedule.endDate && dateIsAfter(date, schedule.endDate)) return false;

  if (schedule.startDate) {
    if (schedule.repeat && schedule.intervalDays) {
      const elapsed = daysBetween(schedule.startDate, date);
      return elapsed >= 0 && elapsed % schedule.intervalDays === 0;
    }
    if (schedule.endKeyword === "THROUGH" && !schedule.repeat) {
      return !dateIsBefore(date, schedule.startDate);
    }
    return date === schedule.startDate;
  }

  const current = dateFromIso(date);
  const weekday = current.getUTCDay();
  if (schedule.kind === "weekday") {
    if (schedule.backDays === 7) {
      if (!(schedule.weekdays ?? []).includes(weekday)) return false;
      const target = schedule.anchorDate
        ? dateFromIso(schedule.anchorDate)
        : new Date(
            Date.UTC(
              schedule.year ?? current.getUTCFullYear(),
              schedule.month !== undefined
                ? schedule.month - 1
                : current.getUTCMonth() + 1,
              schedule.anchorDay ?? 1,
            ),
          );
      while (target.getUTCDay() !== weekday) {
        target.setUTCDate(target.getUTCDate() + 1);
      }
      target.setUTCDate(target.getUTCDate() - schedule.backDays);
      return isoDate(target) === date;
    }

    if (schedule.anchorDate) {
      const anchor = dateFromIso(schedule.anchorDate);
      if (
        current.getUTCFullYear() !== anchor.getUTCFullYear() ||
        current.getUTCMonth() !== anchor.getUTCMonth()
      ) {
        return false;
      }
    }
    if (
      schedule.month !== undefined &&
      current.getUTCMonth() + 1 !== schedule.month
    ) {
      return false;
    }
    if (
      schedule.year !== undefined &&
      current.getUTCFullYear() !== schedule.year
    ) {
      return false;
    }
    if (schedule.anchorDay !== undefined) {
      const firstCandidate = new Date(
        Date.UTC(
          current.getUTCFullYear(),
          current.getUTCMonth(),
          schedule.anchorDay,
        ),
      );
      if (firstCandidate.getUTCMonth() !== current.getUTCMonth()) return false;
      while (!(schedule.weekdays ?? []).includes(firstCandidate.getUTCDay())) {
        firstCandidate.setUTCDate(firstCandidate.getUTCDate() + 1);
      }
      return isoDate(firstCandidate) === date;
    }
    if (!(schedule.weekdays ?? []).includes(weekday)) return false;
    return true;
  }

  if (schedule.kind === "monthly") {
    return (
      schedule.dayOfMonth === current.getUTCDate() &&
      (schedule.year === undefined ||
        schedule.year === current.getUTCFullYear())
    );
  }

  if (schedule.kind === "annual" || schedule.kind === "yearly") {
    if (
      schedule.year !== undefined &&
      schedule.year !== current.getUTCFullYear()
    ) {
      return false;
    }
    if (
      schedule.month !== undefined &&
      current.getUTCMonth() + 1 !== schedule.month
    ) {
      return false;
    }
    return (
      schedule.dayOfMonth === undefined ||
      schedule.dayOfMonth === current.getUTCDate()
    );
  }

  return true;
}

function expandUsingSchedule(
  event: CalendarEvent,
  startIso: string,
  endIso: string,
): CalendarEvent[] {
  const schedule = event.schedule;
  if (!schedule) return [];
  if (!schedule.isRecurring && !schedule.startDate) return [];

  const result: CalendarEvent[] = [];
  for (
    let current = startIso;
    !dateIsAfter(current, endIso);
    current = addDays(current, 1)
  ) {
    if (!matchesSchedule(current, schedule)) continue;
    result.push({
      ...event,
      id: `${event.id}_${current}`,
      date: current,
    });
  }
  return result;
}

export function expandEventsForRange(
  events: CalendarEvent[],
  startIso: string,
  endIso: string,
): CalendarEvent[] {
  const result: CalendarEvent[] = [];
  for (const event of events) {
    if (event.schedule) {
      result.push(...expandUsingSchedule(event, startIso, endIso));
      continue;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(event.date)) {
      if (event.date >= startIso && event.date <= endIso) result.push(event);
      continue;
    }

    const weekday = WEEKDAYS[event.date.toLowerCase()];
    if (weekday === undefined) continue;
    for (
      let current = dateFromIso(startIso);
      current <= dateFromIso(endIso);
      current.setUTCDate(current.getUTCDate() + 1)
    ) {
      if (current.getUTCDay() === weekday) {
        const date = isoDate(current);
        result.push({ ...event, id: `${event.id}_${date}`, date });
      }
    }
  }

  return result.sort((left, right) => {
    if (left.date !== right.date) return left.date.localeCompare(right.date);
    const timeA = left.time || "23:59";
    const timeB = right.time || "23:59";
    if (timeA !== timeB) return timeA.localeCompare(timeB);
    return (left.priority ?? 500) - (right.priority ?? 500);
  });
}
