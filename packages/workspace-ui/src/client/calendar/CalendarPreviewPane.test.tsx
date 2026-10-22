import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { CalendarPreviewPane } from "./CalendarPreviewPane";

const SAMPLE_REM_CONTENT = `# OpenLia Calendar
REM 2026-10-15 AT 10:00 DURATION 60 \\
    INFO "Location: Room 101" \\
    INFO "Video-Link: https://meet.google.com/test-meet" \\
    INFO "Attendees: Alice, Bob" \\
    INFO "Description: Review sprint goals" \\
    MSG Sprint Planning Meeting

REM Mon AT 09:00 DURATION 30 MSG Weekly Sync
`;

describe("CalendarPreviewPane", () => {
  test("renders Month view by default and displays event cards", () => {
    render(
      <CalendarPreviewPane
        content={SAMPLE_REM_CONTENT}
        filePath="calendar/reminders.rem"
        fileRevision="root-revision"
      />,
    );

    // Month view is active
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: /Calendars/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Sprint Planning Meeting")).toBeInTheDocument();
  });

  test("switches between Month, Week, and Gantt views", () => {
    render(
      <CalendarPreviewPane
        content={SAMPLE_REM_CONTENT}
        filePath="calendar/reminders.rem"
        fileRevision="root-revision"
      />,
    );

    // Switch to Week view
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Switch to Gantt view
    fireEvent.click(screen.getByRole("button", { name: "Gantt" }));
    expect(screen.getByRole("button", { name: "Gantt" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(/Gantt Schedule/)).toBeInTheDocument();
  });

  test("opens EventModal when clicking an event", () => {
    render(
      <CalendarPreviewPane
        content={SAMPLE_REM_CONTENT}
        filePath="calendar/reminders.rem"
        fileRevision="root-revision"
      />,
    );

    const eventBtn = screen.getByText("Sprint Planning Meeting");
    fireEvent.click(eventBtn);

    // Inspector dialog opens
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Room 101")).toBeInTheDocument();
    expect(screen.getByText("Join Meeting")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  test("surfaces unsupported Remind clauses in the preview", () => {
    render(
      <CalendarPreviewPane
        content="REM Mon OMIT Sat Sun MSG Working Day"
        filePath="calendar/reminders.rem"
        fileRevision="root-revision"
      />,
    );

    expect(
      screen.getByText(
        /OMIT is not fully evaluated by the workspace calendar preview/,
      ),
    ).toBeInTheDocument();
  });

  test("adds a new event and saves it immediately", async () => {
    const saveCalendarFile = vi.fn(
      async (_path: string, _content: string, _revision: string) => ({
        revision: "next-revision",
      }),
    );
    render(
      <CalendarPreviewPane
        content={SAMPLE_REM_CONTENT}
        filePath="calendar/reminders.rem"
        fileRevision="root-revision"
        onSaveCalendarFile={saveCalendarFile}
      />,
    );

    // Click New Event
    fireEvent.click(screen.getByRole("button", { name: "New Event" }));

    expect(
      screen.getByRole("heading", { name: "New Calendar Event" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Target Calendar")).not.toBeInTheDocument();

    const titleInput = screen.getByPlaceholderText(
      /Sprint Planning, Team Standup/,
    );
    fireEvent.change(titleInput, { target: { value: "New Design Review" } });

    fireEvent.click(screen.getByRole("button", { name: "Add Event" }));

    await waitFor(() => expect(saveCalendarFile).toHaveBeenCalledTimes(1));
    const [path, updatedContent, revision] =
      saveCalendarFile.mock.calls[0] ?? [];
    expect(path).toBe("calendar/reminders.rem");
    expect(updatedContent).toContain("MSG New Design Review");
    expect(revision).toBe("root-revision");
  });

  test("loads included calendars and saves new events to the selected source", async () => {
    const includeFiles = {
      "calendar/holiday.rem": {
        content: "REM 2026-10-20 MSG Holiday",
        revision: "holiday-revision",
      },
    };
    const loadCalendarFile = vi.fn(async (path: string) => {
      const file = includeFiles[path as keyof typeof includeFiles];
      if (!file) throw new Error("Not found");
      return file;
    });
    const saveCalendarFile = vi.fn(
      async (_path: string, _content: string, _revision: string) => ({
        revision: "saved",
      }),
    );

    render(
      <CalendarPreviewPane
        content={`INCLUDE holiday.rem\n${SAMPLE_REM_CONTENT}`}
        filePath="calendar/work.rem"
        fileRevision="work-revision"
        onLoadCalendarFile={loadCalendarFile}
        onSaveCalendarFile={saveCalendarFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New Event" }));
    const targetCalendar = await screen.findByLabelText("Target Calendar");
    expect(targetCalendar).toBeInTheDocument();
    fireEvent.change(targetCalendar, {
      target: { value: "calendar/holiday.rem" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/Sprint Planning, Team Standup/),
      {
        target: { value: "Holiday Follow-up" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Event" }));

    await waitFor(() => expect(saveCalendarFile).toHaveBeenCalledTimes(1));
    const [path, updatedContent, revision] =
      saveCalendarFile.mock.calls[0] ?? [];
    expect(path).toBe("calendar/holiday.rem");
    expect(updatedContent).toContain("MSG Holiday Follow-up");
    expect(revision).toBe("holiday-revision");
  });

  test("does not retain included events when switching to that file", async () => {
    const holidayContent = `REM 2026-10-09 MSG Hangul Day
REM 2026-10-12 MSG Sports Day`;
    const loadCalendarFile = vi.fn(async (path: string) => {
      if (path !== "calendar/holiday.rem") throw new Error("Not found");
      return { content: holidayContent, revision: "holiday-revision" };
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const view = render(
        <CalendarPreviewPane
          content={`INCLUDE holiday.rem\nREM 2026-10-13 MSG Root Event`}
          filePath="calendar/reminders.rem"
          fileRevision="root-revision"
          onLoadCalendarFile={loadCalendarFile}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Hangul Day")).toBeInTheDocument();
      });

      view.rerender(
        <CalendarPreviewPane
          content={holidayContent}
          filePath="calendar/holiday.rem"
          fileRevision="holiday-revision"
          onLoadCalendarFile={loadCalendarFile}
        />,
      );

      expect(screen.getAllByText("Hangul Day")).toHaveLength(1);
      expect(screen.getAllByText("Sports Day")).toHaveLength(1);
      expect(screen.queryByText("Root Event")).not.toBeInTheDocument();
      expect(
        consoleError.mock.calls.some((args) =>
          args.some((value) => String(value).includes("same key")),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("edits an included THROUGH occurrence without collapsing its rule", async () => {
    const today = new Date();
    const start = new Date(today.getTime() - 86400000)
      .toISOString()
      .slice(0, 10);
    const end = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
    const loadCalendarFile = vi.fn(async (path: string) => {
      if (path !== "calendar/holiday.rem") throw new Error("Not found");
      return {
        content: `REM ${start} THROUGH ${end} MSG Included Break`,
        revision: "holiday-revision",
      };
    });
    const saveCalendarFile = vi.fn(
      async (_path: string, _content: string, _revision: string) => ({
        revision: "saved-holiday-revision",
      }),
    );

    render(
      <CalendarPreviewPane
        content="INCLUDE holiday.rem"
        filePath="calendar/reminders.rem"
        fileRevision="root-revision"
        onLoadCalendarFile={loadCalendarFile}
        onSaveCalendarFile={saveCalendarFile}
      />,
    );

    const occurrences = await screen.findAllByText("Included Break");
    const occurrence = occurrences[0];
    if (!occurrence) throw new Error("Expected included occurrence");
    fireEvent.click(occurrence);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Included Break"), {
      target: { value: "Updated Included Break" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(saveCalendarFile).toHaveBeenCalledTimes(1));
    const [path, updatedContent, revision] =
      saveCalendarFile.mock.calls[0] ?? [];
    expect(path).toBe("calendar/holiday.rem");
    expect(updatedContent).toContain(`THROUGH ${end}`);
    expect(updatedContent).toContain("MSG Updated Included Break");
    expect(revision).toBe("holiday-revision");
  });

  test("renders a THROUGH holiday as one continuous event in Gantt view", () => {
    const holidayContent = `REM 2026-10-15 THROUGH 2026-10-19 \\
    TAG holiday TAG lina \\
    MSG Lina Autumn Holiday
`;
    render(
      <CalendarPreviewPane
        content={holidayContent}
        filePath="calendar/reminders.rem"
        fileRevision="root-revision"
      />,
    );

    // Switch to Gantt view
    fireEvent.click(screen.getByRole("button", { name: "Gantt" }));

    // In Gantt view, "Lina Autumn Holiday" should appear in the left list and timeline bar
    const matches = screen.getAllByText("Lina Autumn Holiday");
    expect(matches.length).toBeGreaterThanOrEqual(1);

    // Should indicate duration of 5 days (5d) in both row and timeline bar
    expect(screen.getAllByText("5d")).toHaveLength(2);
    expect(screen.getByText("#holiday")).toBeInTheDocument();
  });

  test("filters calendar events by tag", () => {
    const multiTagContent = `REM 2026-10-15 TAG holiday MSG Family Vacation
REM 2026-10-16 AT 10:00 TAG sprint MSG Sprint Meeting
`;
    render(
      <CalendarPreviewPane
        content={multiTagContent}
        filePath="calendar/reminders.rem"
        fileRevision="root-revision"
      />,
    );

    // Both events initially present
    expect(screen.getByText("Family Vacation")).toBeInTheDocument();
    expect(screen.getByText("Sprint Meeting")).toBeInTheDocument();

    // Toggle filter bar
    fireEvent.click(screen.getByLabelText("Filter events"));

    // Click #holiday tag badge
    const holidayTagBtn = screen.getByRole("button", { name: "#holiday" });
    fireEvent.click(holidayTagBtn);

    // Family Vacation remains, Sprint Meeting is filtered out
    expect(screen.getByText("Family Vacation")).toBeInTheDocument();
    expect(screen.queryByText("Sprint Meeting")).not.toBeInTheDocument();

    // Reset filters
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByText("Sprint Meeting")).toBeInTheDocument();
  });

  test("creates a new multi-day THROUGH range event", async () => {
    const saveCalendarFile = vi.fn(
      async (_path: string, _content: string, _revision: string) => ({
        revision: "next-rev",
      }),
    );
    render(
      <CalendarPreviewPane
        content={SAMPLE_REM_CONTENT}
        filePath="calendar/reminders.rem"
        fileRevision="root-revision"
        onSaveCalendarFile={saveCalendarFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New Event" }));

    // Set title
    const titleInput = screen.getByPlaceholderText(
      /Sprint Planning, Team Standup/,
    );
    fireEvent.change(titleInput, { target: { value: "Lina Mid-term Break" } });

    // Enable multi-day range
    const rangeCheckbox = screen.getByLabelText(
      /Multi-day Date Range \(THROUGH\)/,
    );
    fireEvent.click(rangeCheckbox);

    // Start Date & End Date
    const startDateInput = screen.getByLabelText("Start Date *");
    fireEvent.change(startDateInput, { target: { value: "2026-10-15" } });

    const endDateInput = screen.getByLabelText("End Date (Inclusive) *");
    fireEvent.change(endDateInput, { target: { value: "2026-10-19" } });

    // Add tags
    const tagsInput = screen.getByPlaceholderText("holiday school lina");
    fireEvent.change(tagsInput, { target: { value: "holiday school lina" } });

    // Submit
    fireEvent.click(screen.getByRole("button", { name: "Add Event" }));

    await waitFor(() => expect(saveCalendarFile).toHaveBeenCalledTimes(1));
    const [path, updatedContent] = saveCalendarFile.mock.calls[0] ?? [];
    expect(path).toBe("calendar/reminders.rem");
    expect(updatedContent).toContain("2026-10-15 THROUGH 2026-10-19");
    expect(updatedContent).toContain("TAG holiday TAG school TAG lina");
    expect(updatedContent).toContain("MSG Lina Mid-term Break");
  });
});
