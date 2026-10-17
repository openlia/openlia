import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { MonthView } from "./MonthView";
import type { CalendarSource, LogicalEvent } from "./types";

const SOURCE: CalendarSource = {
  path: "calendar/reminders.rem",
  name: "reminders",
  color: "#3b82f6",
  bgClass: "bg-primary/15",
  textClass: "text-primary",
  borderClass: "border-primary/40",
  enabled: true,
  isCurrentFile: true,
  eventCount: 4,
};

function createLogicalEvent(
  id: string,
  startDate: string = "2026-10-13",
  endDate: string = "2026-10-13",
): LogicalEvent {
  const isRange = startDate !== endDate;
  return {
    id,
    ruleId: id,
    title: `Event ${id}`,
    startDate,
    endDate,
    allDay: !isRange,
    duration: 30,
    durationDays: isRange ? 5 : 1,
    attendees: [],
    tags: [],
    sourceFile: SOURCE.path,
    sourceRule: `REM ${startDate} MSG Event ${id}`,
    isRange,
    isRecurring: false,
    rawEvent: {
      id,
      summary: `Event ${id}`,
      date: startDate,
      duration: 30,
      attendees: [],
      tags: [],
      sourceFile: SOURCE.path,
    },
  };
}

describe("MonthView", () => {
  test("keeps crowded cells readable in compact layouts", () => {
    render(
      <MonthView
        currentDate={new Date("2026-10-15T00:00:00Z")}
        events={[
          createLogicalEvent("1"),
          createLogicalEvent("2"),
          createLogicalEvent("3"),
          createLogicalEvent("4"),
        ]}
        sources={[SOURCE]}
        onSelectEvent={() => {}}
        onNewEventOnDate={() => {}}
      />,
    );

    const monthGrid = document.querySelector(
      "[data-calendar-month-grid] > div",
    );

    expect(monthGrid).toHaveStyle(
      "grid-template-rows: repeat(5, minmax(7rem, 1fr))",
    );
    expect(screen.getByText("Event 1")).toBeInTheDocument();
    expect(screen.getByText("Event 2")).toBeInTheDocument();
    expect(screen.queryByText("Event 3")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+2 more" })).toBeInTheDocument();

    const eventButton = screen.getByText("Event 1").closest("button");
    expect(eventButton).toHaveClass("shrink-0");
  });

  test("renders multi-day event spanning across week boundaries with continuation cues", () => {
    // 2026-10-15 is Thursday (Week 1), 2026-10-19 is Monday (Week 2)
    const holiday = createLogicalEvent("holiday", "2026-10-15", "2026-10-19");
    holiday.title = "Lina Autumn Break";

    render(
      <MonthView
        currentDate={new Date("2026-10-15T00:00:00Z")}
        events={[holiday]}
        sources={[SOURCE]}
        onSelectEvent={() => {}}
        onNewEventOnDate={() => {}}
      />,
    );

    // Event should be present across both week rows
    const holidayElements = screen.getAllByText("Lina Autumn Break");
    expect(holidayElements).toHaveLength(2);

    // Week 1 segment continues next week (▶)
    expect(screen.getByText("▶")).toBeInTheDocument();
    // Week 2 segment continues from prior week (◀)
    expect(screen.getByText("◀")).toBeInTheDocument();
  });
});
