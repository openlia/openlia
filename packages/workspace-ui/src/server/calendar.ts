import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import {
  addDays,
  calendarCreateSchema,
  type CalendarEvent,
  type CalendarRangeRequest,
  type CalendarResponse,
  dateInZone,
  validDate,
  validTimezone,
  wallTimeToInstant,
} from "../shared/calendar";
import { WorkspaceError, type WorkspaceService } from "./workspace";

const exec = promisify(execFile);
const MAX_DAYS = 100;
const literalDate = "(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+[a-z]{3,9}\\s+\\d{4})";
const literalSpan = new RegExp(
  `^\\s*REM\\s+${literalDate}\\s+THROUGH\\s+${literalDate}\\b`,
  "i",
);

function invalid(message: string): never {
  throw new WorkspaceError(message, 400, "invalid_calendar_request");
}

interface Snapshot {
  files: Map<string, string>;
  revision: string;
  rootRevision: string;
}

/** Native Remind evaluates recurrence. Only literal, confined includes are accepted. */
export class CalendarService {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly timezone = "UTC",
    private readonly binary = process.env.OPENLIA_REMIND_BINARY || "remind",
  ) {}

  private snapshot(source: string): Snapshot {
    if (
      !/^(?:[\w-]+\/)+[\w.-]+\.rem(?:ind)?$/.test(source) ||
      source.includes("..")
    ) {
      invalid(
        "Choose a workspace-relative .rem file inside a calendar folder.",
      );
    }
    const directory = posix.dirname(source);
    const files = new Map<string, string>();
    let bytes = 0;
    let rootRevision = "";
    const visit = (path: string, ancestors: Set<string>) => {
      if (ancestors.has(path)) invalid("Calendar includes contain a cycle.");
      if (files.has(path)) return;
      if (files.size >= 32) invalid("Calendar has too many included files.");
      const file = this.workspace.read(path);
      if (path === source) rootRevision = file.revision;
      bytes += Buffer.byteLength(file.content);
      if (bytes > 2 * 1024 * 1024)
        invalid("Calendar exceeds the evaluation size limit.");
      files.set(path, file.content);
      const next = new Set([...ancestors, path]);
      const lines = file.content.replace(/\\\r?\n/g, " ").split(/\r?\n/);
      for (const line of lines) {
        if (/^\s*(?:[#;]|$)/.test(line)) continue;
        if (/^\s*__EOF__\s*$/i.test(line)) break;
        const include = line.match(
          /^\s*INCLUDE\s+(?:"([^"[\]]+)"|([^\s"[\]]+))\s*$/i,
        );
        if (include) {
          const name = include[1] ?? include[2] ?? "";
          if (
            !/^(?:[\w-]+\/)*[\w.-]+\.rem(?:ind)?$/.test(name) ||
            name.includes("..")
          ) {
            invalid(
              "Calendar includes must name literal .rem files within the calendar folder.",
            );
          }
          visit(`${directory}/${name}`, next);
        } else if (
          !/^\s*(?:REM|OMIT|SET|UNSET|FSET|IF|IFTRIG|ELSE|ENDIF|PUSH-OMIT-CONTEXT|POP-OMIT-CONTEXT|CLEAR-OMIT-CONTEXT|BANNER|EXPR|ERRMSG|EXIT|RETURN|PRESERVE)\b/i.test(
            line,
          )
        ) {
          invalid(
            "Calendar contains a directive not supported by safe UI evaluation (use literal INCLUDE, not DO, SYSINCLUDE, or INCLUDECMD).",
          );
        }
      }
    };
    visit(source, new Set());
    const hash = createHash("sha256");
    for (const [path, content] of [...files].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      hash.update(path).update("\0").update(content).update("\0");
    }
    return { files, revision: `sha256:${hash.digest("hex")}`, rootRevision };
  }

  private range(from: string, to: string) {
    if (
      !validDate(from) ||
      !validDate(to) ||
      from >= to ||
      (Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS ||
      from < "1990-01-01" ||
      to >= "2076-01-01"
    ) {
      invalid(
        "Choose an exclusive-end date range of 1–100 days between 1990 and 2075.",
      );
    }
  }

  private async evaluate(
    source: string,
    snapshot: Snapshot,
    from: string,
    to: string,
  ): Promise<CalendarEvent[]> {
    if (!validTimezone(this.timezone))
      invalid("The configured calendar timezone is invalid.");
    const temporary = mkdtempSync(join(tmpdir(), "openlia-calendar-"));
    const directory = posix.dirname(source);
    try {
      for (const [path, content] of snapshot.files) {
        const destination = join(temporary, posix.relative(directory, path));
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, content, { mode: 0o600 });
      }
      // Monthly JSON is supported by the feature's pinned Remind 05.00.02.
      // -b2 leaves titles unadorned; -r disables RUN/shell(); -q disables queues.
      const firstMonth = `${from.slice(0, 7)}-01`;
      const last = addDays(to, -1);
      const months =
        (Number(last.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
        Number(last.slice(5, 7)) -
        Number(from.slice(5, 7)) +
        1;
      let stdout: string;
      try {
        const result = await exec(
          this.binary,
          [
            "-r",
            "-q",
            "-o",
            "-b2",
            `-ppp${months}`,
            posix.basename(source),
            firstMonth,
          ],
          {
            cwd: temporary,
            timeout: 5000,
            maxBuffer: 4 * 1024 * 1024,
            env: {
              PATH: process.env.PATH,
              TZ: this.timezone,
              HOME: temporary,
              LANG: "C.UTF-8",
            },
          },
        );
        if (result.stderr.trim()) throw new Error("native diagnostics");
        stdout = result.stdout;
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        throw new WorkspaceError(
          missing
            ? "Remind is not installed on the workspace-ui server."
            : "Native Remind evaluation failed or reported diagnostics. Inspect the calendar source; no changes were saved.",
          missing ? 503 : 422,
          missing ? "calendar_unavailable" : "calendar_invalid",
        );
      }
      const calendars: unknown = JSON.parse(stdout);
      if (!Array.isArray(calendars))
        throw new Error("Invalid native calendar output");
      const events = new Map<string, CalendarEvent>();
      const linesByPath = new Map(
        [...snapshot.files].map(([path, content]) => [
          path,
          content.split(/\r?\n/),
        ]),
      );
      for (const calendar of calendars) {
        if (!Array.isArray(calendar.entries))
          throw new Error("Invalid native entries");
        for (const entry of calendar.entries) {
          if (
            entry.passthru ||
            typeof entry.body !== "string" ||
            !validDate(entry.date)
          )
            continue;
          const info: Record<string, string> = entry.info ?? {};
          const sourceName = String(entry.filename ?? "");
          const sourcePath = `${directory}/${sourceName.replace(/^\.\//, "")}`;
          if (!snapshot.files.has(sourcePath))
            throw new Error("Unknown calendar source");
          const allDay = entry.time === undefined;
          // THROUGH is emitted as a daily repetition; coalesce its date-only span.
          const sourceLines = linesByPath.get(sourcePath) ?? [];
          let sourceLine = Number(entry.lineno ?? 1) - 1;
          while (
            sourceLine > 0 &&
            /\\$/.test(sourceLines[sourceLine - 1] ?? "")
          )
            sourceLine--;
          const trigger = sourceLines
            .slice(sourceLine, Number(entry.lineno ?? 1))
            .join(" ");
          const span =
            allDay &&
            entry.rep === 1 &&
            entry.y &&
            entry.m &&
            entry.d &&
            validDate(entry.until) &&
            literalSpan.test(trigger) &&
            !/\b(?:OMIT|SKIP|BEFORE|AFTER|SATISFY)\b/i.test(trigger);
          const date = span
            ? `${entry.y}-${String(entry.m).padStart(2, "0")}-${String(entry.d).padStart(2, "0")}`
            : entry.date;
          const time = `${String(Math.floor((entry.time ?? 0) / 60)).padStart(2, "0")}:${String((entry.time ?? 0) % 60).padStart(2, "0")}`;
          // eventstart identifies the original start of overnight occurrences.
          const localStart = entry.eventstart ?? `${date}T${time}`;
          let start: string;
          try {
            start = allDay
              ? date
              : wallTimeToInstant(localStart, this.timezone);
          } catch {
            throw new WorkspaceError(
              "Native calendar includes an ambiguous or nonexistent local time. Inspect the source timezone.",
              422,
              "calendar_invalid",
            );
          }
          const duration = entry.eventduration ?? entry.duration ?? 0;
          const end = allDay
            ? addDays(span ? entry.until : date, 1)
            : new Date(Date.parse(start) + duration * 60000).toISOString();
          if (
            allDay
              ? start >= to || end <= from
              : dateInZone(start, this.timezone) >= to ||
                dateInZone(end, this.timezone) < from
          )
            continue;
          const tag = String(entry.tags ?? "")
            .split(",")
            .find((item) => item.startsWith("openlia-ui-"));
          const id = tag ?? `${sourcePath}:${entry.lineno}`;
          const occurrenceId = `${id}:${start}`;
          const note = info["event-note"] ?? info.note;
          const notePath = note?.replace(/^openlia:\/\/workspace\//, "");
          let attendees = info.attendees
            ?.split(",")
            .map((name) => name.trim())
            .filter(Boolean);
          if (tag && info["attendees-json"]) {
            try {
              const parsed: unknown = JSON.parse(info["attendees-json"]);
              if (
                Array.isArray(parsed) &&
                parsed.every((name) => typeof name === "string")
              )
                attendees = parsed;
            } catch {
              /* Legacy human-authored entries retain their CSV metadata. */
            }
          }
          events.set(occurrenceId, {
            id,
            occurrenceId,
            title: entry.body,
            start,
            end,
            allDay,
            timezone: validTimezone(info.timezone ?? "")
              ? (info.timezone as string)
              : this.timezone,
            agenda: info.description,
            attendees,
            location: info.location,
            ...(notePath &&
            !notePath.includes("..") &&
            /^[\w./-]+\.md$/.test(notePath)
              ? { notePath }
              : {}),
            sourcePath,
            sourceLine: entry.lineno ?? 1,
            notifications: entry.noqueue ? "off" : "source-defined",
          });
          if (events.size > 10000)
            invalid("Calendar has too many occurrences in this range.");
        }
      }
      return [...events.values()].sort((a, b) =>
        a.start.localeCompare(b.start),
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async load(request: CalendarRangeRequest): Promise<CalendarResponse> {
    this.range(request.from, request.to);
    const snapshot = this.snapshot(request.source);
    return {
      schema: 1,
      timezone: this.timezone,
      revision: snapshot.revision,
      events: await this.evaluate(
        request.source,
        snapshot,
        request.from,
        request.to,
      ),
    };
  }

  async create(input: unknown): Promise<CalendarResponse> {
    const parsed = calendarCreateSchema.safeParse(input);
    if (!parsed.success)
      invalid(
        "Invalid appointment fields. Notification and invitation delivery must remain off.",
      );
    const value = parsed.data;
    if (!validTimezone(value.timezone))
      invalid("Choose a valid IANA timezone.");
    const start = Date.parse(value.start);
    const end = Date.parse(value.end);
    if (
      end <= start ||
      end - start > 7 * 86400000 ||
      start % 60000 ||
      end % 60000
    ) {
      invalid(
        "Appointments need minute-precision times and a positive duration of at most seven days.",
      );
    }
    const from = dateInZone(start, this.timezone);
    const to = addDays(dateInZone(end, this.timezone), 1);
    this.range(from, to);
    const snapshot = this.snapshot(value.source);
    const original = snapshot.files.get(value.source) as string;
    const tag = `openlia-ui-${value.requestId}`;
    const matches = (event: CalendarEvent) =>
      event.id === tag &&
      event.title === value.title &&
      Date.parse(event.start) === start &&
      Date.parse(event.end) === end &&
      event.agenda === value.agenda &&
      event.location === value.location &&
      event.timezone === value.timezone &&
      event.notifications === "off" &&
      JSON.stringify(event.attendees ?? []) === JSON.stringify(value.attendees);
    if (new RegExp(`\\bTAG ${tag}\\b`).test(original)) {
      const replay = await this.load({ source: value.source, from, to });
      const existing = replay.events.find((event) => event.id === tag);
      if (!existing || !matches(existing)) {
        throw new WorkspaceError(
          "This request identifier was already used for another appointment.",
          409,
          "calendar_request_conflict",
        );
      }
      return replay;
    }
    if (snapshot.revision !== value.expectedRevision) {
      throw new WorkspaceError(
        "Calendar changed. Reload before saving.",
        409,
        "revision_conflict",
      );
    }
    if (/^\s*(?:__EOF__|EXIT|RETURN)\b/im.test(original))
      invalid("Cannot append after a calendar end/return directive.");
    // Quoted expression strings prevent Remind interpolation or directive injection.
    const string = (text: string) =>
      JSON.stringify(text).replaceAll("[", "\\x5b").replaceAll("]", "\\x5d");
    const info = (header: string, text: string) =>
      `INFO ${string(`${header}: ${text}`)}`;
    const utc = new Date(start).toISOString().slice(0, 16).replace("T", "@");
    const metadata = [
      info("Description", value.agenda),
      info("Attendees", value.attendees.join(", ")),
      info("Attendees-JSON", JSON.stringify(value.attendees)),
      info("Location", value.location),
      info("Timezone", value.timezone),
    ];
    const line = `REM [tzconvert('${utc}', "UTC")] DURATION ${(end - start) / 60000} NOQUEUE TAG ${tag} ${metadata.join(" ")} MSG [${string(value.title.replaceAll("%", "%%"))}]`;
    const content = `${original}${original.endsWith("\n") ? "" : "\n"}\n# Appointment created in Workspace UI; no queued alerts or invitations.\n${line}\n`;
    snapshot.files.set(value.source, content);
    const events = await this.evaluate(value.source, snapshot, from, to);
    if (!events.some(matches)) {
      invalid(
        "Native Remind did not reproduce the requested appointment fields. Nothing was saved.",
      );
    }
    if (this.snapshot(value.source).revision !== value.expectedRevision) {
      throw new WorkspaceError(
        "Calendar changed. Reload before saving.",
        409,
        "revision_conflict",
      );
    }
    this.workspace.write(value.source, content, snapshot.rootRevision);
    return this.load({ source: value.source, from, to });
  }
}
