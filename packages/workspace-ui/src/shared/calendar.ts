import { z } from "zod";

export const calendarEventSchema = z.object({
  id: z.string(),
  occurrenceId: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  timezone: z.string(),
  agenda: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  location: z.string().optional(),
  group: z.string().optional(),
  notePath: z.string().optional(),
  sourcePath: z.string(),
  sourceLine: z.number(),
  notifications: z.enum(["off", "source-defined"]),
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function dateInZone(
  instant: string | number | Date,
  timezone: string,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function timeInZone(
  instant: string | number | Date,
  timezone: string,
): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function validDate(date: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}

/** Resolve wall time without silently moving nonexistent or ambiguous DST times. */
export function wallTimeToInstant(local: string, timezone: string): string {
  if (
    !validTimezone(timezone) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ||
    !validDate(local.slice(0, 10)) ||
    local.slice(11, 13) > "23" ||
    local.slice(14) > "59"
  ) {
    throw new Error("Enter a valid date, time, and IANA timezone.");
  }
  const wall = Date.parse(`${local}:00Z`);
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = wall + hours * 3600000;
    const rendered = `${dateInZone(sample, timezone)}T${timeInZone(sample, timezone)}:00Z`;
    offsets.add(Date.parse(rendered) - sample);
  }
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter(
      (candidate) =>
        `${dateInZone(candidate, timezone)}T${timeInZone(candidate, timezone)}` ===
        local,
    );
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? "This time occurs twice during a daylight-saving transition. Choose an unambiguous time or use UTC."
        : "This time does not exist during a daylight-saving transition.",
    );
  }
  return new Date(matches[0] as number).toISOString();
}

export const inlineCalendarEventSchema = z
  .object({
    id: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(300),
    start: z
      .string()
      .describe(
        "Offset-bearing ISO timestamp (e.g. 2026-11-03T09:00:00+07:00), or YYYY-MM-DD when allDay is true",
      ),
    end: z
      .string()
      .describe(
        "Must be after start; exclusive YYYY-MM-DD end for all-day events",
      ),
    allDay: z.boolean().optional().describe("Defaults to false"),
    timezone: z
      .string()
      .max(100)
      .optional()
      .describe(
        "IANA appointment timezone; defaults to the configured Calendar timezone (UTC if omitted)",
      ),
    agenda: z.string().max(10000).optional(),
    attendees: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    location: z.string().max(1000).optional(),
    group: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const timestamp = z.iso.datetime({ offset: true });
    for (const field of ["start", "end"] as const) {
      if (
        event.allDay
          ? !validDate(event[field])
          : !timestamp.safeParse(event[field]).success
      )
        context.addIssue({
          code: "custom",
          path: [field],
          message: event.allDay
            ? "All-day events require valid YYYY-MM-DD dates (end is exclusive)."
            : "Timed events require valid ISO timestamps with an explicit UTC offset.",
        });
    }
    if (
      event.allDay
        ? event.end <= event.start
        : Date.parse(event.end) <= Date.parse(event.start)
    )
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "End must be after start.",
      });
    if (event.timezone !== undefined && !validTimezone(event.timezone))
      context.addIssue({
        code: "custom",
        path: ["timezone"],
        message: "Enter a valid IANA appointment timezone.",
      });
  });

export type InlineCalendarEvent = z.infer<typeof inlineCalendarEventSchema>;
export type InlineCalendarOccurrence = Omit<
  CalendarEvent,
  "sourcePath" | "sourceLine" | "notifications" | "notePath"
> & { origin: "inline" };
export type CalendarDisplayEvent = CalendarEvent | InlineCalendarOccurrence;

export function inlineCalendarOccurrences(
  events: InlineCalendarEvent[],
  timezone: string,
): InlineCalendarOccurrence[] {
  return events.map((event) => ({
    ...event,
    origin: "inline",
    occurrenceId: `inline:${event.id}`,
    allDay: event.allDay ?? false,
    timezone: event.timezone ?? timezone,
  }));
}

export function defaultCalendarDate(
  events: Array<{ start: string; allDay?: boolean | undefined }> | undefined,
  timezone: string,
  configuredDate?: string | undefined,
): string {
  const safeZone = validTimezone(timezone) ? timezone : "UTC";
  if (configuredDate && validDate(configuredDate)) {
    return configuredDate;
  }
  if (events && events.length > 0) {
    const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
    const first = sorted[0];
    if (first) {
      if (first.allDay || validDate(first.start)) {
        return first.start.slice(0, 10);
      }
      const parsed = Date.parse(first.start);
      if (Number.isFinite(parsed)) {
        return dateInZone(parsed, safeZone);
      }
    }
  }
  return dateInZone(Date.now(), safeZone);
}

export const timelineItemSchema = z.object({
  id: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  start: z.string().describe("YYYY-MM-DD date or offset-bearing ISO timestamp"),
  end: z
    .string()
    .describe(
      "YYYY-MM-DD date or offset-bearing ISO timestamp at or after start",
    ),
  group: z.string().max(300).optional(),
});

export type TimelineItem = z.infer<typeof timelineItemSchema>;

export const calendarResponseSchema = z.object({
  schema: z.literal(1),
  events: z.array(calendarEventSchema),
  revision: z.string(),
  timezone: z.string(),
});
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;

export const calendarCreateSchema = z
  .object({
    source: z.string().min(1),
    expectedRevision: z.string().min(1),
    requestId: z.string().uuid(),
    title: z.string().trim().min(1).max(300),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).max(100),
    agenda: z.string().max(10000),
    attendees: z.array(z.string().trim().min(1).max(300)).max(100),
    location: z.string().max(1000),
    notifications: z.literal("off"),
    invitations: z.literal("off"),
  })
  .strict();
export type CalendarCreateRequest = z.infer<typeof calendarCreateSchema>;

export interface CalendarRangeRequest {
  source: string;
  from: string;
  to: string;
}

export function isValidCalendarSourcePath(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > 500) return false;
  return /\.(?:rem|remind|json)$/i.test(trimmed);
}

export function isJsonCalendarSource(source: string): boolean {
  return /\.json$/i.test(source.trim());
}

const calendarSourceProp = z
  .string()
  .optional()
  .describe(
    "Workspace-relative or document-relative Remind (.rem/.remind) or JSON (.json) file path. Cannot be combined with inline events/items.",
  );

const calendarTimezoneProp = z
  .string()
  .optional()
  .describe(
    "IANA display timezone (e.g. Asia/Ho_Chi_Minh or UTC); defaults to UTC for inline/JSON events or server timezone for Remind.",
  );

const calendarDateProp = z
  .string()
  .optional()
  .describe(
    "Optional initial YYYY-MM-DD focus date; defaults to the earliest inline event date or today.",
  );

const calendarEventsProp = z
  .array(inlineCalendarEventSchema)
  .max(1000)
  .optional()
  .describe(
    "Read-only inline events. Timed intervals require ISO timestamps with offsets; all-day intervals use YYYY-MM-DD with exclusive end. IDs must be unique and end must be after start.",
  );

function refineCalendarProps(
  props: {
    source?: string | undefined;
    timezone?: string | undefined;
    date?: string | undefined;
    events?: InlineCalendarEvent[] | undefined;
    items?: TimelineItem[] | undefined;
  },
  context: z.RefinementCtx,
) {
  if (
    props.source !== undefined &&
    (props.events !== undefined || props.items !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["source"],
      message:
        "Calendar components accept either source or inline events/items, not both.",
    });
  }
  if (props.source !== undefined && !isValidCalendarSourcePath(props.source)) {
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: "Calendar source must be a .rem, .remind, or .json file path.",
    });
  }
  if (props.timezone !== undefined && !validTimezone(props.timezone)) {
    context.addIssue({
      code: "custom",
      path: ["timezone"],
      message: "Enter a valid IANA display timezone.",
    });
  }
  if (props.date !== undefined && !validDate(props.date)) {
    context.addIssue({
      code: "custom",
      path: ["date"],
      message: "Enter a valid YYYY-MM-DD date.",
    });
  }
  const ids = new Set<string>();
  props.events?.forEach((event, index) => {
    if (ids.has(event.id)) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "id"],
        message: `Duplicate inline event ID: ${event.id}`,
      });
    }
    ids.add(event.id);
  });
}

function createGanttPropsSchema() {
  return z.object({
    title: z.string().optional(),
    items: z
      .array(timelineItemSchema)
      .max(1000)
      .optional()
      .describe(
        "Optional generic timeline items; otherwise uses Calendar events or source file",
      ),
    events: calendarEventsProp,
    source: calendarSourceProp,
    timezone: calendarTimezoneProp,
    date: calendarDateProp,
    zoom: z.enum(["day", "week", "month"]).optional(),
    groupBy: z.enum(["none", "source", "location", "group"]).optional(),
  });
}

export const calendarOpenUIProps = {
  Calendar: z.object({
    children: z.array(z.any()),
    source: calendarSourceProp,
    timezone: calendarTimezoneProp,
    date: calendarDateProp,
    events: calendarEventsProp,
  }),
  CalendarMonth: z.object({
    title: z.string().optional(),
    events: calendarEventsProp,
    source: calendarSourceProp,
    timezone: calendarTimezoneProp,
    date: calendarDateProp,
  }),
  CalendarWeek: z.object({
    title: z.string().optional(),
    events: calendarEventsProp,
    source: calendarSourceProp,
    timezone: calendarTimezoneProp,
    date: calendarDateProp,
  }),
  CalendarGantt: createGanttPropsSchema(),
  GanttChart: createGanttPropsSchema(),
};

function stripNullProps(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    cleaned[key] = value === null ? undefined : value;
  }
  return cleaned;
}

/** OpenUI uses null placeholders when named arguments skip optional positions. */
export function validateCalendarProps(input: unknown) {
  return validateCalendarComponentProps("Calendar", input);
}

export function validateCalendarComponentProps(
  typeName: keyof typeof calendarOpenUIProps,
  input: unknown,
) {
  const schema = calendarOpenUIProps[typeName].superRefine(refineCalendarProps);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return schema.safeParse(input);
  }
  return schema.safeParse(stripNullProps(input as Record<string, unknown>));
}

export interface ParsedExternalCalendarJson {
  timezone?: string | undefined;
  date?: string | undefined;
  title?: string | undefined;
  events: InlineCalendarEvent[];
  items?: TimelineItem[] | undefined;
}

const externalCalendarObjectSchema = z.object({
  timezone: z.string().optional(),
  date: z.string().optional(),
  title: z.string().optional(),
  events: z.array(inlineCalendarEventSchema).max(1000).optional(),
  items: z.array(timelineItemSchema).max(1000).optional(),
});

export function parseExternalCalendarJson(
  rawJson: string,
): ParsedExternalCalendarJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("Calendar JSON file is not valid JSON.");
  }

  if (Array.isArray(parsed)) {
    const asEvents = z
      .array(inlineCalendarEventSchema)
      .max(1000)
      .safeParse(parsed);
    if (asEvents.success) {
      return { events: asEvents.data };
    }
    const asItems = z.array(timelineItemSchema).max(1000).safeParse(parsed);
    if (asItems.success) {
      return {
        events: asItems.data.map((item) => ({
          id: item.id,
          title: item.title,
          start: item.start,
          end: item.end,
          allDay: validDate(item.start) && validDate(item.end),
          ...(item.group ? { group: item.group } : {}),
        })),
        items: asItems.data,
      };
    }
    const firstIssue = asEvents.error.issues[0];
    throw new Error(
      firstIssue
        ? `Invalid calendar event in JSON array (${firstIssue.path.join(".")}): ${firstIssue.message}`
        : "Calendar JSON array must contain valid calendar events or timeline items.",
    );
  }

  const checked = externalCalendarObjectSchema.safeParse(parsed);
  if (!checked.success) {
    const firstIssue = checked.error.issues[0];
    throw new Error(
      firstIssue
        ? `Invalid calendar JSON (${firstIssue.path.join(".")}): ${firstIssue.message}`
        : "Invalid calendar JSON object.",
    );
  }

  const { timezone, date, title, events, items } = checked.data;
  if (timezone !== undefined && !validTimezone(timezone)) {
    throw new Error("Calendar JSON contains an invalid IANA timezone.");
  }
  if (date !== undefined && !validDate(date)) {
    throw new Error("Calendar JSON contains an invalid YYYY-MM-DD date.");
  }
  if (!events && !items) {
    throw new Error(
      "Calendar JSON object must include an 'events' or 'items' array.",
    );
  }
  const normalizedEvents: InlineCalendarEvent[] =
    events ??
    (items ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      start: item.start,
      end: item.end,
      allDay: validDate(item.start) && validDate(item.end),
      ...(item.group ? { group: item.group } : {}),
    }));
  return {
    timezone,
    date,
    title,
    events: normalizedEvents,
    items,
  };
}
