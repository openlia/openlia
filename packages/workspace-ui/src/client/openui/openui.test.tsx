import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { openUIDiagnostics } from "../../shared/openui";
import {
  describeOpenUI,
  openUIAuthoringRequest,
  validateOpenUI,
} from "../../shared/openuiAuthoring";
import { openUIRecipes } from "../../shared/openuiRecipes";
import type { WorkspaceApi } from "../api";
import { MarkdownPreview } from "../components/editor/MarkdownPreview";

function createMockApi(files: Record<string, string> = {}): WorkspaceApi {
  return {
    createFile: vi.fn(),
    deleteDirectory: vi.fn(),
    deleteFile: vi.fn(),
    downloadUrl: (path) => `/api/workspace/download?path=${path}`,
    loadCalendar: vi.fn().mockImplementation(async ({ source }) => ({
      events: [
        {
          agenda: "Review sprint goals",
          allDay: false,
          attendees: ["Alice", "Bob"],
          end: "2026-11-25T10:30:00.000Z",
          id: `${source}:1`,
          location: "Room 101",
          notifications: "off",
          occurrenceId: `${source}:1:2026-11-25T09:00:00.000Z`,
          sourceLine: 1,
          sourcePath: source,
          start: "2026-11-25T09:00:00.000Z",
          timezone: "UTC",
          title: "Remind Standup",
        },
      ],
      revision: "sha256:test",
      schema: 1,
      timezone: "UTC",
    })),
    loadFile: vi.fn().mockImplementation(async (path: string) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return {
        content,
        editable: true,
        modified_at: "2026-11-25T00:00:00Z",
        ok: true,
        path,
        revision: "rev-1",
        schema: 1,
        size: content.length,
      };
    }),
    loadFileMetadata: vi.fn(),
    loadSession: vi.fn(),
    loadTree: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    moveFile: vi.fn(),
    rawUrl: (path) => `/api/workspace/raw?path=${path}`,
    renameFile: vi.fn(),
    saveFile: vi.fn(),
    uploadFile: vi.fn(),
  };
}

describe("OpenUI recipes, normalizer, and authoring validation", () => {
  it("validates every registered recipe with zero diagnostics", () => {
    for (const recipe of openUIRecipes) {
      expect(
        openUIDiagnostics(recipe.code),
        `Recipe '${recipe.name}' failed validation`,
      ).toEqual([]);
    }
  });

  it("exposes Calendar and Chart components in openui_describe", () => {
    const summary = describeOpenUI();
    expect(summary.status).toBe("ok");
    if (summary.status !== "ok" || !("components" in summary)) return;
    for (const name of [
      "Calendar",
      "CalendarMonth",
      "CalendarWeek",
      "CalendarGantt",
      "GanttChart",
      "ChartBar",
      "ChartLine",
      "ChartPie",
      "ChartSankey",
      "SankeyDiagram",
      "ChartPanel",
      "Table",
      "Card",
      "Stack",
      "Tabs",
    ]) {
      expect(summary.components).toContain(name);
      const detail = openUIAuthoringRequest({
        action: "describe",
        component: name,
      });
      expect(detail.status).toBe("ok");
    }
  });

  it("rejects mixed inline data and source on Calendar and Chart components", () => {
    expect(
      openUIDiagnostics(
        'CalendarMonth(source: "schedule.rem", events: [{id: "1", title: "A", start: "2026-11-01", end: "2026-11-02", allDay: true}])',
      ).length,
    ).toBeGreaterThan(0);

    expect(
      openUIDiagnostics(
        'ChartBar(source: "data.json", labels: ["Jan"], values: [10])',
      ).length,
    ).toBeGreaterThan(0);

    expect(
      openUIDiagnostics('ChartBar(source: "invalid.txt")').length,
    ).toBeGreaterThan(0);
  });

  it("validates a Markdown document with CalendarMonth and ChartBar blocks", () => {
    const markdown = [
      "# Example markdown",
      "",
      "```openui",
      'CalendarMonth(title: "November Schedule", timezone: "UTC", events: [{id: "1", title: "Launch", allDay: true, start: "2026-11-10", end: "2026-11-12"}])',
      "```",
      "",
      "## Monthly income vs. expenses",
      "",
      "```openui",
      'ChartBar(title: "Monthly Income vs. Expenses", unit: "USD", labels: ["Jan", "Feb"], series: [{category: "Income", values: [5000, 5200]}, {category: "Expenses", values: [3100, 3300]}])',
      "```",
    ].join("\n");

    const validation = validateOpenUI(markdown, "markdown");
    expect(validation.valid).toBe(true);
    expect(validation.blockCount).toBe(2);
  });
});

describe("MarkdownPreview inline OpenUI rendering", () => {
  it("renders inline CalendarMonth, CalendarWeek, CalendarGantt, ChartBar, ChartLine, ChartPie, and ChartSankey", () => {
    const markdown = [
      "# Example markdown",
      "",
      "```openui",
      'CalendarMonth(title: "Nov 2026 Month", timezone: "UTC", events: [{id: "m1", title: "Month Milestone", allDay: true, start: "2026-11-05", end: "2026-11-06"}])',
      "```",
      "",
      "```openui",
      'CalendarWeek(title: "Nov 2026 Week", timezone: "UTC", events: [{id: "w1", title: "Week Sync", start: "2026-11-05T10:00:00Z", end: "2026-11-05T11:00:00Z"}])',
      "```",
      "",
      "```openui",
      'CalendarGantt(title: "Q4 Gantt", zoom: "month", groupBy: "group", items: [{id: "g1", title: "Phase 1", start: "2026-11-01", end: "2026-11-15", group: "Core"}])',
      "```",
      "",
      "```openui",
      'ChartBar(title: "Monthly Income vs. Expenses", unit: "USD", labels: ["Jan", "Feb"], series: [{category: "Income", values: [6200, 6400]}, {category: "Expenses", values: [4100, 4350]}])',
      "```",
      "",
      "```openui",
      'ChartLine(title: "Revenue Trend", unit: "USD", labels: ["Jan", "Feb"], values: [2100, 2050])',
      "```",
      "",
      "```openui",
      'ChartPie(title: "Budget Split", unit: "USD", slices: [{label: "R&D", value: 4000}, {label: "Ops", value: 2000}])',
      "```",
      "",
      "```openui",
      'ChartSankey(title: "Cashflow Diagram", unit: "USD", nodes: [{id: "rev", label: "Revenue"}, {id: "net", label: "Net Profit"}], links: [{source: "rev", target: "net", value: 2100}])',
      "```",
    ].join("\n");

    render(
      <MarkdownPreview
        content={markdown}
        currentFilePath="reports/summary.md"
      />,
    );

    expect(screen.getByText("Nov 2026 Month")).toBeInTheDocument();
    expect(screen.getByText("Month Milestone")).toBeInTheDocument();
    expect(screen.getByText("Nov 2026 Week")).toBeInTheDocument();
    expect(screen.getByText("Q4 Gantt")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Monthly Income vs\. Expenses/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Revenue Trend/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Budget Split/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Cashflow Diagram/ }),
    ).toBeInTheDocument();
  });

  it("loads external Remind (.rem) and JSON (.json) files for Calendar and Chart views", async () => {
    const api = createMockApi({
      "reports/events.json": JSON.stringify({
        timezone: "UTC",
        events: [
          {
            id: "json-ev-1",
            title: "JSON Conference",
            allDay: true,
            start: "2026-11-12",
            end: "2026-11-14",
          },
        ],
      }),
      "reports/income.json": JSON.stringify([
        { month: "Jan", Income: 7000, Expenses: 4500 },
        { month: "Feb", Income: 7500, Expenses: 4600 },
      ]),
      "reports/flows.json": JSON.stringify({
        title: "External Sankey Flows",
        unit: "USD",
        nodes: [
          { id: "in", label: "Gross Income" },
          { id: "out", label: "Operating Cost" },
        ],
        links: [{ source: "in", target: "out", value: 4500 }],
      }),
    });

    const markdown = [
      "```openui",
      'CalendarMonth(title: "Remind Schedule", source: "./reminders.rem", date: "2026-11-25", timezone: "UTC")',
      "```",
      "",
      "```openui",
      'CalendarMonth(title: "JSON Schedule", source: "./events.json")',
      "```",
      "",
      "```openui",
      'ChartBar(title: "External Income Chart", unit: "USD", source: "./income.json")',
      "```",
      "",
      "```openui",
      'ChartSankey(source: "./flows.json")',
      "```",
    ].join("\n");

    render(
      <MarkdownPreview
        api={api}
        content={markdown}
        currentFilePath="reports/overview.md"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Remind Standup/)).toBeInTheDocument();
      expect(
        screen.getAllByText(/JSON Conference/).length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getByRole("heading", { name: /External Income Chart/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /External Sankey Flows/ }),
      ).toBeInTheDocument();
    });

    expect(api.loadCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ source: "reports/reminders.rem" }),
      "workspace",
    );
  });

  it("supports clicking Gantt rows/titles and drilling down from Week day headers into Day view", () => {
    const markdown = [
      "```openui",
      'CalendarGantt(title: "Sprint Gantt", zoom: "week", timezone: "UTC", date: "2026-10-27", items: [{id: "short-sync", title: "Architecture Review", start: "2026-10-27T09:00:00Z", end: "2026-10-27T10:30:00Z"}])',
      "```",
    ].join("\n");

    render(
      <MarkdownPreview content={markdown} currentFilePath="reports/gantt.md" />,
    );

    expect(
      screen.getByText(/09:00–10:30 · Architecture Review/),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Architecture Review" }),
    );
    expect(
      screen.getByRole("complementary", { name: "Timeline item details" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(
      screen.queryByRole("complementary", { name: "Timeline item details" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Zoom to 2026-10-27" }));
    expect(screen.getByLabelText(/Timeline zoom/)).toHaveValue("day");
  });
});
