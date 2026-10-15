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
});
