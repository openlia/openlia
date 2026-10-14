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
    'REM 15 AT 07:30 INFO "Description: Nop bai thu hoach 2026-10-27 ngay mon" MSG Test',
    'REM AT 07:30 INFO "Location: thu" MSG Test',
    "REM 15 TAG thu MSG Test",
    'REM 31 Feb 2026 INFO "Description: thu" MSG Test',
  ])("does not infer dates or weekdays from metadata: %s", (statement) => {
    const { events } = parseRemindFile(statement);
    expect(events[0]?.date).toBe("unspecified");
    expect(expandEventsForRange(events, "2026-10-01", "2026-10-31")).toEqual(
      [],
    );
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
});
