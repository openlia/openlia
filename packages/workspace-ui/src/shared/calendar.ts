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
  notePath: z.string().optional(),
  sourcePath: z.string(),
  sourceLine: z.number(),
  notifications: z.enum(["off", "source-defined"]),
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/** Literal calendar data has no Remind source or delivery configuration. */
export const inlineCalendarEventSchema = z
  .object({
    id: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(300),
    start: z
      .string()
      .describe(
        "Offset-bearing ISO timestamp, or YYYY-MM-DD when allDay is true",
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

export const calendarOpenUIProps = {
  Calendar: z
    .object({
      children: z.array(z.any()),
      source: z
        .string()
        .optional()
        .describe(
          "Project-relative Remind file; defaults to reminders.rem when events is omitted. Cannot be combined with events.",
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA display timezone; defaults to calendar timezone (UTC for inline events)",
        ),
      events: z
        .array(inlineCalendarEventSchema)
        .max(1000)
        .optional()
        .describe(
          "Read-only inline events, including an empty array. Timed intervals require ISO timestamps with offsets; all-day intervals use YYYY-MM-DD with exclusive end. IDs must be unique and end must be after start. No API requests; cannot be combined with source.",
        ),
    })
    .superRefine((props, context) => {
      if (props.events !== undefined && props.source !== undefined)
        context.addIssue({
          code: "custom",
          path: ["source"],
          message: "Calendar accepts either events or source, not both.",
        });
      if (props.timezone !== undefined && !validTimezone(props.timezone))
        context.addIssue({
          code: "custom",
          path: ["timezone"],
          message: "Enter a valid IANA display timezone.",
        });
      const ids = new Set<string>();
      props.events?.forEach((event, index) => {
        if (ids.has(event.id))
          context.addIssue({
            code: "custom",
            path: ["events", index, "id"],
            message: `Duplicate inline event ID: ${event.id}`,
          });
        ids.add(event.id);
      });
    }),
  CalendarMonth: z.object({ title: z.string().optional() }),
  CalendarWeek: z.object({ title: z.string().optional() }),
  GanttChart: z.object({
    title: z.string().optional(),
    items: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          start: z.string(),
          end: z.string(),
          group: z.string().optional(),
        }),
      )
      .optional()
      .describe(
        "Optional generic timeline items; otherwise uses Calendar events",
      ),
    zoom: z.enum(["day", "week", "month"]).optional(),
    groupBy: z.enum(["none", "source", "location"]).optional(),
  }),
};

/** OpenUI uses null placeholders when named arguments skip optional positions. */
export function validateCalendarProps(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return calendarOpenUIProps.Calendar.safeParse(input);
  const props = input as Record<string, unknown>;
  return calendarOpenUIProps.Calendar.safeParse({
    ...props,
    source: props.source ?? undefined,
    timezone: props.timezone ?? undefined,
    events: props.events ?? undefined,
  });
}
