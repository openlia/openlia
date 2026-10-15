import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { MonthView } from "./MonthView";
import type { CalendarEvent, CalendarSource } from "./types";

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

function createEvent(id: string): CalendarEvent {
  return {
    id,
    summary: `Event ${id}`,
    date: "2026-10-13",
    duration: 30,
    attendees: [],
    tags: [],
    sourceFile: SOURCE.path,
  };
}

describe("MonthView", () => {
  test("keeps crowded cells readable in compact layouts", () => {
    render(
      <MonthView
        currentDate={new Date("2026-10-15T00:00:00Z")}
        events={[
          createEvent("1"),
          createEvent("2"),
          createEvent("3"),
          createEvent("4"),
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
});
