import { describe, expect, test } from "vitest";
import {
  extractFilterOptions,
  filterLogicalEvents,
  interpretLogicalEvents,
} from "./eventInterpretation";
import { parseRemindFile } from "./remindParser";

describe("eventInterpretation", () => {
  test("interprets a THROUGH date-range rule as one logical multi-day event", () => {
    const content = `REM 15 Oct 2026 THROUGH 19 Oct 2026 \\
    TAG holiday TAG school TAG lina \\
    MSG Lina — Nghỉ giữa học kỳ I
`;
    const { events: rawEvents } = parseRemindFile(
      content,
      "calendar/holiday.rem",
    );
    expect(rawEvents).toHaveLength(1);

    const logicalEvents = interpretLogicalEvents(
      rawEvents,
      "2026-10-01",
      "2026-10-31",
    );
    expect(logicalEvents).toHaveLength(1);

    const event = logicalEvents[0];
    if (!event) throw new Error("Expected event");
    expect(event.title).toBe("Lina — Nghỉ giữa học kỳ I");
    expect(event.startDate).toBe("2026-10-15");
    expect(event.endDate).toBe("2026-10-19");
    expect(event.durationDays).toBe(5);
    expect(event.allDay).toBe(true);
    expect(event.isRange).toBe(true);
    expect(event.isRecurring).toBe(false);
    expect(event.tags).toEqual(["holiday", "school", "lina"]);
    expect(event.sourceFile).toBe("calendar/holiday.rem");
    expect(event.sourceRule).toContain("REM 15 Oct 2026 THROUGH 19 Oct 2026");
  });

  test("expands recurring rules into distinct occurrence instances", () => {
    const content = "REM Mon AT 09:00 DURATION 30 TAG team MSG Weekly Standup";
    const { events: rawEvents } = parseRemindFile(content);

    const logicalEvents = interpretLogicalEvents(
      rawEvents,
      "2026-10-05",
      "2026-10-19",
    );
    // 2026-10-05, 2026-10-12, 2026-10-19
    expect(logicalEvents).toHaveLength(3);
    expect(logicalEvents.map((e) => e.startDate)).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
    ]);
    expect(logicalEvents.every((e) => e.isRecurring)).toBe(true);
    expect(logicalEvents.every((e) => e.isRange === false)).toBe(true);
    expect(logicalEvents.every((e) => e.allDay === false)).toBe(true);
    expect(logicalEvents.every((e) => e.time === "09:00")).toBe(true);
  });

  test("maintains independence between separate consecutive reminders", () => {
    const content = `REM 2026-10-15 MSG Daily Task A
REM 2026-10-16 MSG Daily Task B
`;
    const { events: rawEvents } = parseRemindFile(content);
    expect(rawEvents).toHaveLength(2);

    const logicalEvents = interpretLogicalEvents(
      rawEvents,
      "2026-10-01",
      "2026-10-31",
    );
    expect(logicalEvents).toHaveLength(2);
    expect(logicalEvents[0]?.title).toBe("Daily Task A");
    expect(logicalEvents[0]?.startDate).toBe("2026-10-15");
    expect(logicalEvents[0]?.endDate).toBe("2026-10-15");
    expect(logicalEvents[0]?.isRange).toBe(false);

    expect(logicalEvents[1]?.title).toBe("Daily Task B");
    expect(logicalEvents[1]?.startDate).toBe("2026-10-16");
    expect(logicalEvents[1]?.endDate).toBe("2026-10-16");
    expect(logicalEvents[1]?.isRange).toBe(false);
  });

  test("filters logical events by tags, people, and search query", () => {
    const content = `REM 2026-10-15 TAG holiday TAG lina MSG Lina Vacation
REM 2026-10-16 AT 10:00 TAG work INFO "Attendees: Alice, Bob" MSG Sprint Review
REM 2026-10-17 AT 14:00 TAG personal INFO "Attendees: Charlie" MSG Family Dinner
`;
    const { events: rawEvents } = parseRemindFile(content);
    const logicalEvents = interpretLogicalEvents(
      rawEvents,
      "2026-10-01",
      "2026-10-31",
    );

    // Tag filter
    const holidayFiltered = filterLogicalEvents(logicalEvents, {
      enabledSources: new Set(),
      selectedTags: new Set(["holiday"]),
      selectedPeople: new Set(),
      searchQuery: "",
    });
    expect(holidayFiltered).toHaveLength(1);
    expect(holidayFiltered[0]?.title).toBe("Lina Vacation");

    // Person filter
    const aliceFiltered = filterLogicalEvents(logicalEvents, {
      enabledSources: new Set(),
      selectedTags: new Set(),
      selectedPeople: new Set(["Alice"]),
      searchQuery: "",
    });
    expect(aliceFiltered).toHaveLength(1);
    expect(aliceFiltered[0]?.title).toBe("Sprint Review");

    // Search query
    const searchFiltered = filterLogicalEvents(logicalEvents, {
      enabledSources: new Set(),
      selectedTags: new Set(),
      selectedPeople: new Set(),
      searchQuery: "dinner",
    });
    expect(searchFiltered).toHaveLength(1);
    expect(searchFiltered[0]?.title).toBe("Family Dinner");
  });

  test("extracts distinct tags and cleaned attendees", () => {
    const content = `REM 2026-10-15 TAG sprint TAG team INFO "Attendees: Alice <alice@work.com>, [[Bob]]" MSG Meeting 1
REM 2026-10-16 TAG team TAG client INFO "Attendees: Bob, Carol" MSG Meeting 2
`;
    const { events: rawEvents } = parseRemindFile(content);
    const logicalEvents = interpretLogicalEvents(
      rawEvents,
      "2026-10-01",
      "2026-10-31",
    );

    const { tags, people } = extractFilterOptions(logicalEvents);
    expect(tags).toEqual(["client", "sprint", "team"]);
    expect(people).toEqual(["Alice", "Bob", "Carol"]);
  });
});
