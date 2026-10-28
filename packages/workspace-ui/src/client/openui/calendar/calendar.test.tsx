import { Renderer } from "@openuidev/react-lang";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  addDays,
  type CalendarEvent,
  dateInZone,
  wallTimeToInstant,
} from "../../../shared/calendar";
import { OpenLiaOpenUIProvider } from "../context";
import { openliaLibrary } from "../library";
import { CalendarView } from "./Calendar";
import { CalendarMonthView } from "./CalendarMonth";
import { CalendarWeekView } from "./CalendarWeek";
import { CalendarEventEditor } from "./CalendarEventEditor";
import { CalendarContext, type CalendarContextValue } from "./context";
import { GanttChartView } from "./GanttChart";
import { monthDays, onDay, timelineCoordinate, weekBlocks } from "./layout";

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "event",
  occurrenceId: "event:1",
  title: "Review",
  start: "2026-10-27T09:00:00.000Z",
  end: "2026-10-27T10:00:00.000Z",
  allDay: false,
  timezone: "UTC",
  sourcePath: "calendar/reminders.rem",
  sourceLine: 1,
  notifications: "off",
  ...overrides,
});
const context = (events: CalendarEvent[]): CalendarContextValue => ({
  events,
  date: "2026-10-27",
  timezone: "UTC",
  loading: false,
  navigate: vi.fn(),
  select: vi.fn(),
});

beforeAll(() => {
  // happy-dom does not implement the browser's native dialog focus trap.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});

describe("calendar dates and layout", () => {
  it("resolves explicit timezone and rejects DST gaps and ambiguous wall times", () => {
    expect(wallTimeToInstant("2026-10-27T09:00", "Asia/Ho_Chi_Minh")).toBe(
      "2026-10-27T02:00:00.000Z",
    );
    expect(() =>
      wallTimeToInstant("2026-03-08T02:30", "America/New_York"),
    ).toThrow("does not exist");
    expect(() =>
      wallTimeToInstant("2026-11-01T01:30", "America/New_York"),
    ).toThrow("occurs twice");
    expect(() => wallTimeToInstant("2026-02-30T12:00", "UTC")).toThrow();
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("uses a full Monday-first grid across year boundaries", () => {
    expect(monthDays("2027-01-15")).toHaveLength(42);
    expect(monthDays("2027-01-15")[0]).toBe("2026-12-28");
  });

  it("measures timeline durations as instants across DST rather than equal civil days", () => {
    const zone = "America/New_York";
    expect(
      (timelineCoordinate("2026-11-02", zone) -
        timelineCoordinate("2026-11-01", zone)) /
        3600000,
    ).toBe(25);
    expect(
      (timelineCoordinate("2026-03-09", zone) -
        timelineCoordinate("2026-03-08", zone)) /
        3600000,
    ).toBe(23);
    expect(timelineCoordinate("2026-11-01T06:30:00Z", zone)).toBe(
      Date.parse("2026-11-01T06:30:00Z"),
    );
  });

  it("keeps all-day ends exclusive and midnight events out of the next day", () => {
    expect(
      onDay(
        event({ allDay: true, start: "2026-10-27", end: "2026-10-29" }),
        "2026-10-29",
        "UTC",
      ),
    ).toBe(false);
    expect(
      onDay(event({ end: "2026-10-28T00:00:00Z" }), "2026-10-28", "UTC"),
    ).toBe(false);
  });

  it("lays out overlapping clusters without compressing unrelated later events", () => {
    const blocks = weekBlocks(
      [
        event(),
        event({
          id: "b",
          start: "2026-10-27T09:30:00Z",
          end: "2026-10-27T10:30:00Z",
        }),
        event({
          id: "c",
          start: "2026-10-27T12:00:00Z",
          end: "2026-10-27T13:00:00Z",
        }),
      ],
      "2026-10-27",
      "UTC",
    );
    expect(blocks.map((block) => block.columns)).toEqual([2, 2, 1]);
    expect(blocks.map((block) => block.column)).toEqual([0, 1, 0]);
  });
});

it("Month exposes overflow events and selection without mutation", () => {
  const value = context(
    Array.from({ length: 5 }, (_, index) =>
      event({ occurrenceId: String(index), title: `Review ${index}` }),
    ),
  );
  render(
    <CalendarContext.Provider value={value}>
      <CalendarMonthView />
    </CalendarContext.Provider>,
  );
  expect(screen.getByText("+2 more")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "09:00 Review 0" }));
  expect(value.select).toHaveBeenCalledWith(value.events[0]);
  fireEvent.click(screen.getByLabelText("Next month"));
  expect(value.navigate).toHaveBeenCalledWith("2026-11-01");
});

it("Week renders overlapping events and an all-day lane", () => {
  const value = context([
    event(),
    event({
      occurrenceId: "all-day",
      title: "Holiday",
      allDay: true,
      start: "2026-10-27",
      end: "2026-10-29",
    }),
  ]);
  render(
    <CalendarContext.Provider value={value}>
      <CalendarWeekView />
    </CalendarContext.Provider>,
  );
  expect(screen.getByText("All day")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Holiday" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "09:00 Review" }));
  expect(value.select).toHaveBeenCalledWith(value.events[0]);
});

it("Gantt shares calendar selection and supports zoom and grouping", () => {
  const value = context([event({ location: "Office" })]);
  render(
    <CalendarContext.Provider value={value}>
      <GanttChartView groupBy="location" />
    </CalendarContext.Provider>,
  );
  expect(screen.getByText("Office")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Timeline zoom"), {
    target: { value: "day" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open Review" }));
  expect(value.select).toHaveBeenCalledWith(value.events[0]);
});

it("Gantt works independently with generic timeline items", () => {
  const today = dateInZone(Date.now(), "UTC");
  render(
    <GanttChartView
      items={[
        {
          id: "trip",
          title: "Trip",
          start: today,
          end: addDays(today, 2),
          group: "Travel",
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Trip" }));
  expect(screen.getByLabelText("Timeline item details")).toHaveTextContent(
    "Trip",
  );
});

it("Gantt day zoom exposes repeated DST hours and preserves actual bar duration", () => {
  const value = {
    ...context([
      event({ start: "2026-11-01T06:30:00Z", end: "2026-11-01T07:30:00Z" }),
    ]),
    date: "2026-11-01",
    timezone: "America/New_York",
  };
  render(
    <CalendarContext.Provider value={value}>
      <GanttChartView zoom="day" />
    </CalendarContext.Provider>,
  );
  expect(screen.getAllByText("01:00")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Open Review" })).toHaveStyle({
    width: "4%",
  });
});

it("appointment drafts expose safety settings before saving; cancel never writes", () => {
  const save = vi.fn();
  const cancel = vi.fn();
  render(
    <CalendarEventEditor
      date="2026-10-27"
      timezone="UTC"
      source="calendar/reminders.rem"
      revision="rev"
      onSave={save}
      onCancel={cancel}
    />,
  );
  expect(screen.getByLabelText("Start")).toHaveValue("2026-10-27T09:00");
  expect(screen.getByLabelText("Appointment timezone")).toHaveValue("UTC");
  for (const checkbox of screen.getAllByRole("checkbox")) {
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
  }
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("appointment editor rejects invalid chronology and preserves draft on save failure", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Calendar changed"));
  render(
    <CalendarEventEditor
      date="2026-10-27"
      timezone="UTC"
      source="calendar/reminders.rem"
      revision="rev"
      onSave={save}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Client review" },
  });
  fireEvent.change(screen.getByLabelText("End"), {
    target: { value: "2026-10-27T08:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save appointment" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "End must be after start",
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("End"), {
    target: { value: "2026-10-27T10:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save appointment" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Calendar changed"),
  );
  expect(screen.getByLabelText("Title")).toHaveValue("Client review");
});

it("OpenUI composes three separate components in template-defined tabs", async () => {
  const api = {
    loadCalendar: vi.fn().mockResolvedValue({
      schema: 1,
      events: [],
      revision: "rev",
      timezone: "UTC",
    }),
    createCalendarEvent: vi.fn(),
  };
  render(
    <OpenLiaOpenUIProvider value={{ calendarApi: api, domainPath: "calendar" }}>
      <Renderer
        library={openliaLibrary}
        response={
          'root = Calendar([Tabs([TabItem("month", "Month", [CalendarMonth()]), TabItem("week", "Week", [CalendarWeek()]), TabItem("timeline", "Timeline", [GanttChart()])])])'
        }
      />
    </OpenLiaOpenUIProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "New appointment" }),
    ).toBeEnabled(),
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Month" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.getByLabelText("Month calendar")).toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Week" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.getByLabelText("Week calendar")).toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Timeline" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.getByLabelText("Event duration timeline")).toBeInTheDocument();
  expect(api.loadCalendar).toHaveBeenCalledTimes(1);
});

it("load errors are visible and prevent appointment creation", async () => {
  render(
    <OpenLiaOpenUIProvider
      value={{
        calendarApi: {
          loadCalendar: vi.fn().mockRejectedValue(new Error("Remind missing")),
          createCalendarEvent: vi.fn(),
        },
      }}
    >
      <CalendarView>
        <CalendarMonthView />
      </CalendarView>
    </OpenLiaOpenUIProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Remind missing");
  expect(
    screen.getByRole("button", { name: "New appointment" }),
  ).toBeDisabled();
});
