import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { InlineCalendarEvent } from "../../../shared/calendar";
import { MarkdownPreview } from "../../components/editor/MarkdownPreview";
import { OpenLiaOpenUIProvider } from "../context";
import { CalendarView } from "./Calendar";
import { CalendarMonthView } from "./CalendarMonth";
import { CalendarWeekView } from "./CalendarWeek";
import { GanttChartView } from "./GanttChart";

const event: InlineCalendarEvent = {
  id: "review",
  title: "Review",
  start: "2026-10-27T09:00:00Z",
  end: "2026-10-27T10:00:00Z",
  agenda: "Review milestones",
  attendees: ["Alice", "Bob"],
  location: "Office",
};
const holiday: InlineCalendarEvent = {
  id: "holiday",
  title: "Holiday",
  allDay: true,
  start: "2026-10-27",
  end: "2026-10-29",
};
const api = () => ({ loadCalendar: vi.fn(), createCalendarEvent: vi.fn() });

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-27T12:00:00Z"));
});
afterEach(() => vi.restoreAllMocks());

it("renders all three views without private capabilities and keeps all-day ends exclusive", () => {
  render(
    <CalendarView events={[event, holiday]}>
      <CalendarMonthView />
      <CalendarWeekView />
      <GanttChartView groupBy="source" />
    </CalendarView>,
  );
  expect(screen.getByText("Inline events · read-only")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByLabelText("Month calendar")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect(screen.getByLabelText("Week calendar")).toBeInTheDocument();
  expect(screen.getByLabelText("Event duration timeline")).toHaveTextContent(
    "Inline events",
  );
  const month = within(screen.getByLabelText("Month calendar"));
  expect(
    within(month.getByRole("cell", { name: "2026-10-28" })).getByRole(
      "button",
      { name: "Holiday" },
    ),
  ).toBeInTheDocument();
  expect(
    within(month.getByRole("cell", { name: "2026-10-29" })).queryByRole(
      "button",
      { name: "Holiday" },
    ),
  ).toBeNull();
});

it("does not read or write the API during inline navigation, selection, or timezone changes", () => {
  const calendarApi = api();
  render(
    <OpenLiaOpenUIProvider value={{ calendarApi, onOpenRecord: vi.fn() }}>
      <CalendarView events={[event, holiday]}>
        <CalendarMonthView />
      </CalendarView>
    </OpenLiaOpenUIProvider>,
  );
  expect(screen.queryByRole("button", { name: "New appointment" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reload calendar" })).toBeNull();
  const timezone = screen.getByLabelText("Display timezone");
  fireEvent.change(timezone, { target: { value: "Asia/Ho_Chi_Minh" } });
  fireEvent.blur(timezone);
  fireEvent.click(screen.getByRole("button", { name: "16:00 Review" }));
  const details = screen.getByRole("region", { name: "Appointment details" });
  expect(details).toHaveTextContent("Review milestones");
  expect(details).toHaveTextContent("Alice, Bob");
  expect(details).toHaveTextContent("Office");
  expect(details).toHaveTextContent("UTC · 2026-10-27 09:00");
  expect(details).not.toHaveTextContent("NOQUEUE");
  expect(details).not.toHaveTextContent("Source:");
  expect(
    within(details).queryByRole("button", { name: "Open calendar source" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  fireEvent.click(screen.getByLabelText("Next month"));
  expect(screen.getByLabelText("Month calendar")).toHaveTextContent(
    "2026-11-01",
  );
  fireEvent.click(screen.getByRole("button", { name: "Today" }));
  expect(
    screen.getByRole("button", { name: "16:00 Review" }),
  ).toBeInTheDocument();
  expect(calendarApi.loadCalendar).not.toHaveBeenCalled();
  expect(calendarApi.createCalendarEvent).not.toHaveBeenCalled();
});

it("treats an empty array as inline data instead of falling back to Remind", () => {
  const calendarApi = api();
  render(
    <OpenLiaOpenUIProvider value={{ calendarApi }}>
      <CalendarView events={[]}>
        <CalendarMonthView />
        <GanttChartView />
      </CalendarView>
    </OpenLiaOpenUIProvider>,
  );
  expect(screen.getByText("No events in this range.")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calendarApi.loadCalendar).not.toHaveBeenCalled();
});

it("keeps navigation and refreshes selected details by ID when inline data changes", () => {
  const view = (events: InlineCalendarEvent[]) => (
    <CalendarView events={events}>
      <CalendarMonthView />
    </CalendarView>
  );
  const { rerender } = render(view([event]));
  fireEvent.click(screen.getByRole("button", { name: "09:00 Review" }));
  rerender(
    view([{ ...event, title: "Updated review", agenda: "Updated agenda" }]),
  );
  expect(
    screen.getByRole("region", { name: "Appointment details" }),
  ).toHaveTextContent("Updated agenda");
  rerender(view([]));
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(view([event]));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByLabelText("Next month"));
  rerender(view([{ ...event, title: "New title" }]));
  expect(screen.getByLabelText("Month calendar")).toHaveTextContent(
    "2026-11-01",
  );
});

it("shows validation errors without attempting a source load", () => {
  const calendarApi = api();
  const { rerender } = render(
    <OpenLiaOpenUIProvider value={{ calendarApi }}>
      <CalendarView source="reminders.rem" events={[]}>
        <CalendarMonthView />
      </CalendarView>
    </OpenLiaOpenUIProvider>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "either events or source",
  );
  rerender(
    <OpenLiaOpenUIProvider value={{ calendarApi }}>
      <CalendarView events={[{ ...event, end: event.start }]}>
        <CalendarMonthView />
      </CalendarView>
    </OpenLiaOpenUIProvider>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "End must be after start",
  );
  expect(calendarApi.loadCalendar).not.toHaveBeenCalled();
});

it("renders named inline arguments through the actual Markdown/OpenUI pipeline", () => {
  render(
    <MarkdownPreview
      content={`# Schedule\n\n\`\`\`openui\nCalendar(events: ${JSON.stringify([event])}, children: [CalendarMonth()])\n\`\`\``}
    />,
  );
  expect(screen.queryByTestId("inline-openui-error")).toBeNull();
  expect(
    screen.getByRole("button", { name: "09:00 Review" }),
  ).toBeInTheDocument();
});

it("preserves inline selection and navigation when the Markdown source is updated", () => {
  const document = (events: InlineCalendarEvent[]) =>
    `# Schedule\n\n\`\`\`openui\nCalendar(events: ${JSON.stringify(events)}, children: [CalendarMonth()])\n\`\`\``;
  const { rerender } = render(<MarkdownPreview content={document([event])} />);
  fireEvent.click(screen.getByRole("button", { name: "09:00 Review" }));
  rerender(
    <MarkdownPreview
      content={document([{ ...event, agenda: "Edited in Markdown" }])}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Appointment details" }),
  ).toHaveTextContent("Edited in Markdown");
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  fireEvent.click(screen.getByLabelText("Next month"));
  rerender(
    <MarkdownPreview
      content={document([{ ...event, title: "Edited title" }])}
    />,
  );
  expect(screen.getByLabelText("Month calendar")).toHaveTextContent(
    "2026-11-01",
  );
});

it("selects events from timeline bars and shares timezone controls with week view", () => {
  render(
    <CalendarView timezone="America/New_York" events={[event, holiday]}>
      <CalendarWeekView />
      <GanttChartView groupBy="location" />
    </CalendarView>,
  );
  expect(screen.getByText("Office")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open Review" }));
  expect(
    screen.getByRole("region", { name: "Appointment details" }),
  ).toHaveTextContent("America/New_York");
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  fireEvent.change(screen.getByLabelText("Timeline zoom"), {
    target: { value: "day" },
  });
  expect(
    screen.getByRole("button", { name: "Open Review" }),
  ).toBeInTheDocument();
});
