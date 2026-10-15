import { describe, expect, test } from "vitest";
import {
  addEventToFile,
  deleteEventFromFile,
  expandEventsForRange,
  formatRemStatement,
  parseRemindFile,
  updateEventInFile,
} from "./remindParser";

describe("remindParser", () => {
  test.each([
    "27 OCT 2026",
    "Oct 27 2026",
    "27 October 2026",
    "October 27 2026",
  ])("renders named-month date %s once despite Vietnamese weekday-like metadata", (date) => {
    const { events } = parseRemindFile(`REM ${date} AT 07:30 DURATION 8:00 \\
    INFO "Description: Nop bai thu hoach truoc 30/10/2026." \\
    MSG Hoạt động trải nghiệm STEM`);
    expect(events[0]?.date).toBe("2026-10-27");
    expect(events[0]?.duration).toBe(480);
    expect(
      expandEventsForRange(events, "2026-10-01", "2026-10-31").map(
        (e) => e.date,
      ),
    ).toEqual(["2026-10-27"]);
    expect(expandEventsForRange(events, "2026-11-01", "2026-11-30")).toEqual(
      [],
    );
  });

  test.each([
    'REM 31 Feb 2026 INFO "Description: thu" MSG Test',
  ])("does not infer dates or weekdays from metadata: %s", (statement) => {
    const { events } = parseRemindFile(statement);
    expect(events[0]?.date).toBe("unspecified");
    expect(expandEventsForRange(events, "2026-10-01", "2026-10-31")).toEqual(
      [],
    );
  });

  test("treats a date-less timed reminder as a daily rule", () => {
    const { events } = parseRemindFile(
      'REM AT 07:30 DURATION 30 INFO "Location: thu" MSG Daily',
    );
    expect(
      expandEventsForRange(events, "2026-10-01", "2026-10-03").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  test("expands THROUGH and UNTIL ranges inclusively", () => {
    const content = `REM 15 Oct 2026 THROUGH 19 Oct 2026 MSG Lina Break
REM Fri UNTIL 30 Oct 2026 MSG Friday Class
`;
    const { events } = parseRemindFile(content, "calendar/holiday.rem");

    expect(events[0]?.schedule?.endKeyword).toBe("THROUGH");
    expect(
      expandEventsForRange(events.slice(0, 1), "2026-10-15", "2026-10-19").map(
        (event) => event.date,
      ),
    ).toEqual([
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
    ]);
    expect(
      expandEventsForRange(events.slice(1), "2026-10-01", "2026-11-05").map(
        (event) => event.date,
      ),
    ).toEqual([
      "2026-10-02",
      "2026-10-09",
      "2026-10-16",
      "2026-10-23",
      "2026-10-30",
    ]);
  });

  test("supports interval, multi-weekday, monthly, annual, and FROM rules", () => {
    const content = `REM 2026-10-14 *14 MSG Sprint Planning
REM Mon Wed Fri MSG Gym
REM 15 MSG Monthly Billing
REM Oct 15 MSG Anniversary
REM Mon FROM 2026-10-12 UNTIL 2026-10-26 MSG Bounded Standup
`;
    const { events } = parseRemindFile(content);

    expect(
      expandEventsForRange(events.slice(0, 1), "2026-10-01", "2026-11-30").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-14", "2026-10-28", "2026-11-11", "2026-11-25"]);
    expect(
      expandEventsForRange(events.slice(1, 2), "2026-10-12", "2026-10-18").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-12", "2026-10-14", "2026-10-16"]);
    expect(
      expandEventsForRange(events.slice(2, 3), "2026-10-01", "2026-11-30").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-15", "2026-11-15"]);
    expect(
      expandEventsForRange(events.slice(3, 4), "2026-10-01", "2027-10-31").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-15", "2027-10-15"]);
    expect(
      expandEventsForRange(events.slice(4), "2026-10-01", "2026-10-31").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
  });

  test("does not skip clauses after interval and backward modifiers", () => {
    const { events } = parseRemindFile(
      "REM 2026-10-14 *14 UNTIL 2026-10-28 AT 09:00 MSG Sprint",
    );
    expect(events[0]?.schedule?.endDate).toBe("2026-10-28");
    expect(events[0]?.time).toBe("09:00");
    expect(
      expandEventsForRange(events, "2026-10-01", "2026-11-30").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-14", "2026-10-28"]);

    const backward = parseRemindFile("REM Mon 1 -7 Nov MSG Last Monday")
      .events[0];
    expect(backward?.schedule?.dateSpec).toBe("Mon 1 Nov");
  });

  test("matches native backward and anchored weekday forms", () => {
    const { events } = parseRemindFile("REM Mon 1 -7 Nov MSG Last Monday");
    expect(events[0]?.unsupportedClauses).toBeUndefined();
    expect(
      expandEventsForRange(events, "2026-11-01", "2026-11-30").map(
        (event) => event.date,
      ),
    ).toEqual([]);
    expect(
      expandEventsForRange(events, "2026-10-01", "2026-10-31").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-26"]);

    const anchored = parseRemindFile(
      "REM Mon 2026-10-15 MSG First Monday After Date",
    ).events;
    expect(
      expandEventsForRange(anchored, "2026-10-01", "2026-10-31").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-19"]);

    const multiWeekday = parseRemindFile(
      "REM Mon Tue 1 Oct MSG First Weekday",
    ).events;
    expect(
      expandEventsForRange(multiWeekday, "2026-10-01", "2026-10-31").map(
        (event) => event.date,
      ),
    ).toEqual(["2026-10-05"]);
  });

  test("handles cross-year THROUGH ranges and literal Remind percent escapes", () => {
    const { events } = parseRemindFile(
      "REM 28 Dec 2026 THROUGH 1 Jan 2027 MSG New year 100%%",
    );
    expect(events[0]?.summary).toBe("New year 100%");
    expect(
      expandEventsForRange(events, "2026-12-28", "2027-01-01").map(
        (event) => event.date,
      ),
    ).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
  });

  test("keeps advance warnings on the rule without adding warning-day events", () => {
    const { events } = parseRemindFile(
      "REM 15 Oct 2026 +2 THROUGH 19 Oct 2026 MSG Break",
    );
    expect(events[0]?.schedule?.advanceToken).toBe("+2");
    expect(
      expandEventsForRange(events, "2026-10-13", "2026-10-19").map(
        (event) => event.date,
      ),
    ).toEqual([
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
    ]);
  });

  test("uses the trigger weekday rather than dates inside INFO clauses", () => {
    const { events } = parseRemindFile(
      'REM Mon AT 09:00 INFO "Description: thu 2026-10-27" MSG Weekly',
    );
    expect(events[0]?.date).toBe("mon");
    expect(
      expandEventsForRange(events, "2026-10-01", "2026-10-31").map(
        (e) => e.date,
      ),
    ).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  });

  test("parses single-line and multi-line REM statements with INFO clauses", () => {
    const content = `# Sample Calendar
INCLUDE holidays.rem

REM 2026-10-15 AT 10:00 DURATION 1:30 TAG sprint PRIORITY 100 \\
    INFO "Location: 123 Market St, Room 4" \\
    INFO "Map-Url: https://maps.google.com/?q=123+Market+St" \\
    INFO "Video-Link: https://meet.google.com/abc-defg-hij" \\
    INFO "Attendees: Alice <alice@example.com>, Bob" \\
    INFO "Description: Sprint review and Q4 roadmap" \\
    INFO "Event-Note: calendar/2026-10-15-sprint.md" \\
    MSG Q4 Sprint Review

REM Mon AT 09:00 DURATION 30 TAG recurring MSG Weekly Standup
`;

    const { events, includedFiles } = parseRemindFile(
      content,
      "calendar/reminders.rem",
    );

    expect(includedFiles).toEqual(["holidays.rem"]);
    expect(events.length).toBe(2);

    const ev1 = events[0];
    if (!ev1) throw new Error("Expected ev1 to be defined");
    expect(ev1.summary).toBe("Q4 Sprint Review");
    expect(ev1.date).toBe("2026-10-15");
    expect(ev1.time).toBe("10:00");
    expect(ev1.duration).toBe(90);
    expect(ev1.tags).toEqual(["sprint"]);
    expect(ev1.priority).toBe(100);
    expect(ev1.location).toBe("123 Market St, Room 4");
    expect(ev1.mapUrl).toBe("https://maps.google.com/?q=123+Market+St");
    expect(ev1.callUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(ev1.attendees).toEqual(["Alice <alice@example.com>", "Bob"]);
    expect(ev1.description).toBe("Sprint review and Q4 roadmap");
    expect(ev1.note).toBe("calendar/2026-10-15-sprint.md");

    const ev2 = events[1];
    if (!ev2) throw new Error("Expected ev2 to be defined");
    expect(ev2.summary).toBe("Weekly Standup");
    expect(ev2.date).toBe("mon");
    expect(ev2.time).toBe("09:00");
    expect(ev2.duration).toBe(30);
    expect(ev2.tags).toEqual(["recurring"]);
  });

  test("expands recurring weekday events across a date range", () => {
    const content = `REM Mon AT 09:00 DURATION 30 MSG Team Standup
REM 2026-10-14 AT 14:00 DURATION 60 MSG 1:1 Sync
`;
    const { events } = parseRemindFile(content, "calendar/reminders.rem");
    // Range spanning two weeks: 2026-10-05 (Mon) to 2026-10-19 (Mon)
    const expanded = expandEventsForRange(events, "2026-10-05", "2026-10-19");

    // 2026-10-05 (Mon), 2026-10-12 (Mon), 2026-10-19 (Mon), plus 2026-10-14 (Wed)
    expect(expanded.length).toBe(4);
    expect(expanded.map((e) => e.date)).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-14",
      "2026-10-19",
    ]);
  });

  test("formats Remind statements with proper INFO clauses and escapes", () => {
    const formatted = formatRemStatement({
      summary: "Quarterly Strategy Meeting",
      date: "2026-10-20",
      time: "15:00",
      duration: 60,
      location: "Office Headquarters",
      callUrl: "https://zoom.us/j/123456",
      attendees: ["Carol", "Dave"],
      description: "Discuss H2 goals",
      note: "calendar/2026-10-20-strategy.md",
      tags: ["strategy", "planning"],
    });

    expect(formatted).toContain(
      "REM 2026-10-20 AT 15:00 DURATION 60 TAG strategy TAG planning \\",
    );
    expect(formatted).toContain('INFO "Location: Office Headquarters"');
    expect(formatted).toContain('INFO "Video-Link: https://zoom.us/j/123456"');
    expect(formatted).toContain('INFO "Attendees: Carol, Dave"');
    expect(formatted).toContain('INFO "Description: Discuss H2 goals"');
    expect(formatted).toContain(
      'INFO "Event-Note: calendar/2026-10-20-strategy.md"',
    );
    expect(formatted).toContain("MSG Quarterly Strategy Meeting");

    // Re-parsing round-trip
    const { events } = parseRemindFile(formatted);
    expect(events.length).toBe(1);
    const parsedEv = events[0];
    if (!parsedEv) throw new Error("Expected parsedEv to be defined");
    expect(parsedEv.summary).toBe("Quarterly Strategy Meeting");
    expect(parsedEv.time).toBe("15:00");
    expect(parsedEv.duration).toBe(60);
    expect(parsedEv.callUrl).toBe("https://zoom.us/j/123456");
  });

  test("formats reminders without metadata as multiline blocks", () => {
    const formatted = formatRemStatement({
      summary: "Simple Reminder",
      date: "2026-10-21",
      time: "08:00",
    });

    expect(formatted).toBe(
      ["REM 2026-10-21 AT 08:00 \\", "    MSG Simple Reminder"].join("\n"),
    );
    const { events } = parseRemindFile(formatted);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe("Simple Reminder");
    expect(events[0]?.date).toBe("2026-10-21");
  });

  test("preserves unchanged Remind substitutions and INFO entries", () => {
    const content =
      'REM 2026-10-15 INFO "Location: Office" INFO "Venue: Auditorium" INFO "x_custom: keep" MSG Due %b';
    const { events } = parseRemindFile(content);
    const event = events[0];
    if (!event) throw new Error("Expected event");

    const updated = updateEventInFile(content, event, { location: "Room" });
    expect(updated).toContain('INFO "Location: Room"');
    expect(updated).toContain('INFO "Venue: Auditorium"');
    expect(updated).toContain('INFO "x_custom: keep"');
    expect(updated).toContain("MSG Due %b");
    expect(updated).not.toContain("MSG Due %%b");
  });

  test("allows a one-off date edit without preserving the old date", () => {
    const content = "REM 2026-10-15 MSG One-off";
    const event = parseRemindFile(content).events[0];
    if (!event) throw new Error("Expected event");

    const updated = updateEventInFile(content, event, {
      date: "2026-10-16",
    });
    expect(updated).toContain("REM 2026-10-16");
    expect(updated).not.toContain("REM 2026-10-15");
  });

  test("reports and suppresses reminders inside unsupported conditionals", () => {
    const { events, warnings } = parseRemindFile(
      "IF 0\nREM 2026-10-15 MSG Hidden\nENDIF",
    );
    expect(events).toHaveLength(0);
    expect(warnings.map((warning) => warning.message)).toEqual([
      "IF blocks are not evaluated by the workspace calendar preview.",
      "REM inside an unsupported conditional block is not displayed.",
      "ENDIF is not evaluated by the workspace calendar preview.",
    ]);
  });

  test("adds, updates, and deletes events in file content", () => {
    let content = "# My Calendar\n";
    content = addEventToFile(content, {
      summary: "Initial Meeting",
      date: "2026-10-10",
      time: "10:00",
      duration: 30,
    });

    expect(content).toContain("MSG Initial Meeting");
    const { events } = parseRemindFile(content);
    expect(events.length).toBe(1);
    const firstEvent = events[0];
    if (!firstEvent) throw new Error("Expected firstEvent to be defined");

    // Update
    content = updateEventInFile(content, firstEvent, {
      summary: "Updated Meeting Title",
      duration: 45,
    });
    expect(content).toContain("MSG Updated Meeting Title");
    expect(content).not.toContain("MSG Initial Meeting");

    // Delete
    const { events: updatedEvents } = parseRemindFile(content);
    const updatedEv = updatedEvents[0];
    if (!updatedEv) throw new Error("Expected updatedEv to be defined");
    content = deleteEventFromFile(content, updatedEv);
    expect(content).not.toContain("Updated Meeting Title");
    const { events: finalEvents } = parseRemindFile(content);
    expect(finalEvents.length).toBe(0);
  });

  test("preserves the Remind rule when updating an expanded occurrence", () => {
    const content = `REM 15 Oct 2026 THROUGH 19 Oct 2026 TAG holiday \\
    INFO "Source: openlia://source/holiday" \\
    MSG Lina Break
`;
    const { events } = parseRemindFile(content, "calendar/holiday.rem");
    const occurrence = expandEventsForRange(
      events,
      "2026-10-17",
      "2026-10-17",
    )[0];
    if (!occurrence) throw new Error("Expected expanded occurrence");

    const updated = updateEventInFile(content, occurrence, {
      summary: "Updated Lina Break",
    });
    expect(updated).toContain("REM 15 Oct 2026 THROUGH 2026-10-19");
    expect(updated).toContain('INFO "Source: openlia://source/holiday"');
    expect(updated).toContain("MSG Updated Lina Break");
  });
});
