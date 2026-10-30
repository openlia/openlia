import { expect, test } from "bun:test";
import {
  inlineCalendarEventSchema,
  inlineCalendarOccurrences,
  validateCalendarProps,
} from "../shared/calendar";
import { normalizeOpenUIProgram, openUIDiagnostics } from "../shared/openui";
import { describeOpenUI, validateOpenUI } from "../shared/openuiAuthoring";

const event = {
  id: "review",
  title: "Review",
  start: "2026-10-27T09:00:00Z",
  end: "2026-10-27T10:00:00Z",
};

test("inline calendar schema normalizes metadata without fabricating Remind fields", () => {
  const input = inlineCalendarEventSchema.parse({
    ...event,
    agenda: "Review milestones",
    attendees: ["Alice"],
    location: "Office",
  });
  const [occurrence] = inlineCalendarOccurrences([input], "Asia/Ho_Chi_Minh");
  expect(occurrence).toMatchObject({
    ...input,
    allDay: false,
    timezone: "Asia/Ho_Chi_Minh",
    occurrenceId: "inline:review",
    origin: "inline",
  });
  expect(occurrence).not.toHaveProperty("sourcePath");
  expect(occurrence).not.toHaveProperty("sourceLine");
  expect(occurrence).not.toHaveProperty("notifications");
  expect(
    inlineCalendarOccurrences(
      [{ ...input, timezone: "UTC" }],
      "Asia/Ho_Chi_Minh",
    )[0]?.timezone,
  ).toBe("UTC");
});

test("inline calendars accept empty input and exclusive all-day intervals", () => {
  expect(validateCalendarProps({ children: [], events: [] }).success).toBe(
    true,
  );
  expect(
    inlineCalendarEventSchema.safeParse({
      ...event,
      allDay: true,
      start: "2028-02-28",
      end: "2028-03-01",
    }).success,
  ).toBe(true);
  // Compare timed events by instant, not by their textual offsets.
  expect(
    inlineCalendarEventSchema.safeParse({
      ...event,
      start: "2026-10-27T10:00:00+07:00",
      end: "2026-10-27T04:00:00Z",
    }).success,
  ).toBe(true);
});

test("runtime and offline authoring reject the same invalid inline fields", () => {
  for (const invalid of [
    { ...event, id: " " },
    { ...event, title: " " },
    { ...event, end: event.start },
    { ...event, end: "2026-10-27T08:00:00Z" },
    { ...event, start: "2026-10-27T09:00:00" },
    { ...event, start: "2026-02-30T09:00:00Z" },
    { ...event, end: "2026-10-28" },
    { ...event, timezone: "Not/A_Zone" },
    { ...event, allDay: true },
    { ...event, allDay: true, start: "2026-02-30", end: "2026-03-03" },
    { ...event, allDay: true, start: "2026-10-27", end: "2026-10-27" },
    { ...event, sourcePath: "fabricated.rem" },
  ]) {
    expect(
      validateCalendarProps({ children: [], events: [invalid] }).success,
    ).toBe(false);
    const code = `Calendar(children: [], events: ${JSON.stringify([invalid])})`;
    expect(validateOpenUI(code, "openui").valid, code).toBe(false);
  }
});

test("calendar mode, unique IDs, limits, and IANA zones are checked offline", () => {
  for (const extra of [
    { source: "reminders.rem", events: [] },
    { events: [event, event] },
    { events: [event, { ...event, id: " review " }] },
    { events: [], timezone: "Invalid/Zone" },
    {
      events: Array.from({ length: 1001 }, (_, id) => ({
        ...event,
        id: String(id),
      })),
    },
  ]) {
    expect(validateCalendarProps({ children: [], ...extra }).success).toBe(
      false,
    );
    const fields = Object.entries(extra)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ");
    expect(
      openUIDiagnostics(`Calendar(children: [], ${fields})`).length,
    ).toBeGreaterThan(0);
  }
  expect(
    openUIDiagnostics('Calendar(children: [], events: [], source: "x.rem")'),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        component: "Calendar",
        path: "/source",
        message: "Calendar accepts either events or source, not both.",
      }),
    ]),
  );
});

test("resolved and nested inline calendars receive semantic validation", () => {
  const code = `events = ${JSON.stringify([event, event])}
root = Stack(children: [Card(children: [Calendar(children: [], events: events)])])`;
  expect(openUIDiagnostics(code)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ component: "Calendar", path: "/events/1/id" }),
    ]),
  );
});

test("Calendar discovery exposes events without changing existing argument order", () => {
  const description = describeOpenUI("Calendar");
  expect(description).toHaveProperty("positionalOrder", [
    "children",
    "source",
    "timezone",
    "events",
  ]);
  expect(JSON.stringify(description)).toContain("Read-only inline events");
  expect(
    description.recipes?.some((recipe) => recipe.name === "inline-calendar"),
  ).toBe(true);
  for (const code of [
    "Calendar([CalendarMonth()])",
    'Calendar([CalendarMonth()], "reminders.rem", "UTC")',
    "Calendar(children: [], events: [])",
    `Calendar(events: ${JSON.stringify([event])}, children: [CalendarMonth()])`,
  ]) {
    expect(openUIDiagnostics(code), code).toEqual([]);
    expect(normalizeOpenUIProgram(normalizeOpenUIProgram(code))).toBe(
      normalizeOpenUIProgram(code),
    );
  }
});
