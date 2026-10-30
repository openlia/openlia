import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { addDays, dateInZone } from "../../../shared/calendar";
import { createMockWorkspaceApi } from "../../mockApi";
import { OpenLiaOpenUIProvider } from "../../openui/context";
import { SharePublicView } from "../../SharePublicView";
import { MarkdownPreview } from "./MarkdownPreview";

const fence = (code: string) => `\`\`\`openui\n${code}\n\`\`\``;

test("renders a Vietnamese menu inline with surrounding Markdown", () => {
  render(
    <MarkdownPreview
      content={`# Thực đơn ngày 29/10/2026\n\nBefore\n\n${fence('Table(title: "Thực đơn", columns: [{key: "dish", label: "Món ăn"}], rows: [{dish: "Phở bò"}])')}\n\nAfter`}
    />,
  );
  expect(screen.getByRole("cell", { name: "Phở bò" })).toBeInTheDocument();
  expect(screen.getByText("After")).toBeInTheDocument();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByTestId("inline-openui-block").closest("pre")).toBeNull();
});

test("isolates invalid blocks, preserves raw source, and recovers after editing", () => {
  const { rerender } = render(
    <MarkdownPreview
      content={`${fence('CardHeader(titel: "Broken")')}\n\n${fence('CardHeader("Healthy")')}`}
    />,
  );
  expect(screen.getByTestId("inline-openui-error")).toHaveTextContent("titel");
  expect(screen.getByText("Healthy")).toBeInTheDocument();
  rerender(
    <MarkdownPreview content={fence('CardHeader(title: "Repaired")')} />,
  );
  expect(screen.queryByTestId("inline-openui-error")).toBeNull();
  expect(screen.getByText("Repaired")).toBeInTheDocument();
});

test("malformed row table literals cannot crash the surrounding document", () => {
  render(
    <MarkdownPreview
      content={`${fence('Table(columns: [{key: "a", label: "A"}], rows: [{a: }])')}\n\nStill visible`}
    />,
  );
  expect(screen.getByTestId("inline-openui-error")).toBeInTheDocument();
  expect(screen.getByText("Still visible")).toBeInTheDocument();
});

test("does not interpret lookalike code fence languages", () => {
  render(
    <MarkdownPreview
      content={'```openui-example\nCardHeader("Source only")\n```'}
    />,
  );
  expect(screen.queryByTestId("inline-openui-block")).toBeNull();
  expect(
    screen.getByText('CardHeader("Source only")').closest("pre"),
  ).not.toBeNull();
});

test.each([
  ["teams/nested/view.md", "teams/nested/reminders.rem"],
  ["view.md", "reminders.rem"],
])("scopes calendar paths to %s", async (path, source) => {
  const loadCalendar = vi.fn().mockRejectedValue(new Error("test unavailable"));
  render(
    <OpenLiaOpenUIProvider
      value={{ calendarApi: { loadCalendar, createCalendarEvent: vi.fn() } }}
    >
      <MarkdownPreview
        currentFilePath={path}
        content={fence("Calendar([CalendarMonth()])")}
      />
    </OpenLiaOpenUIProvider>,
  );
  await waitFor(() =>
    expect(loadCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ source }),
    ),
  );
});

test("chat actions prepare a draft through the supplied callback", () => {
  const onSendChatPrompt = vi.fn();
  render(
    <OpenLiaOpenUIProvider value={{ onSendChatPrompt }}>
      <MarkdownPreview
        content={fence(
          'Button("Review menu", @ToAssistant("Review this menu"))',
        )}
      />
    </OpenLiaOpenUIProvider>,
  );
  expect(onSendChatPrompt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review menu" }));
  expect(onSendChatPrompt).toHaveBeenCalledWith("Review this menu");
});

test("public snapshots render literal blocks without inheriting workspace capabilities", async () => {
  const api = createMockWorkspaceApi({
    files: {
      "menu.md": `# Shared menu\n\n${fence('Table([Col("Dish", ["Phở"])])')}\n\n${fence("Calendar([CalendarMonth()])")}\n\n${fence('Button("Ask privately")')}`,
    },
  });
  const { share } = await api.createShare({
    kind: "workspace",
    target_path: "menu.md",
  });
  const loadCalendar = vi.fn();
  const onSendChatPrompt = vi.fn();
  render(
    <OpenLiaOpenUIProvider
      value={{
        calendarApi: { loadCalendar, createCalendarEvent: vi.fn() },
        onSendChatPrompt,
      }}
    >
      <SharePublicView api={api} shareId={share.id} />
    </OpenLiaOpenUIProvider>,
  );
  expect(await screen.findByRole("cell", { name: "Phở" })).toBeInTheDocument();
  expect(
    await screen.findByText("Calendar API is unavailable in this renderer."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Ask privately" }));
  expect(loadCalendar).not.toHaveBeenCalled();
  expect(onSendChatPrompt).not.toHaveBeenCalled();
});

test("public snapshots render inline calendars without inheriting private calendar APIs", async () => {
  const today = dateInZone(Date.now(), "UTC");
  const events = [
    {
      id: "public-event",
      title: "Shared event",
      allDay: true,
      start: today,
      end: addDays(today, 1),
    },
  ];
  const api = createMockWorkspaceApi({
    files: {
      "schedule.md": fence(
        `Calendar(events: ${JSON.stringify(events)}, children: [CalendarMonth(), CalendarWeek(), GanttChart()])`,
      ),
    },
  });
  const { share } = await api.createShare({
    kind: "workspace",
    target_path: "schedule.md",
  });
  const loadCalendar = vi.fn();
  const createCalendarEvent = vi.fn();
  render(
    <OpenLiaOpenUIProvider
      value={{ calendarApi: { loadCalendar, createCalendarEvent } }}
    >
      <SharePublicView api={api} shareId={share.id} />
    </OpenLiaOpenUIProvider>,
  );
  expect(
    await screen.findByText("Inline events · read-only"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Month calendar")).toBeInTheDocument();
  expect(screen.getByLabelText("Week calendar")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open Shared event" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(loadCalendar).not.toHaveBeenCalled();
  expect(createCalendarEvent).not.toHaveBeenCalled();
});
