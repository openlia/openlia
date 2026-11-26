import type { CalendarEvent, InlineCalendarEvent } from "../../shared/calendar";
import type { WorkspaceApi } from "../api";

export const storyInlineCalendarEvents: InlineCalendarEvent[] = [
  {
    id: "review",
    title: "Architecture & Design Review",
    start: "2026-10-27T09:00:00Z",
    end: "2026-10-27T10:30:00Z",
    agenda: "Review OpenUI Calendar and Chart integration milestones.",
    attendees: ["Alice", "Bob", "Minh"],
    location: "Room 302",
    group: "Engineering",
  },
  {
    id: "sync",
    title: "Product Sync (Overlapping)",
    start: "2026-10-27T09:30:00Z",
    end: "2026-10-27T11:00:00Z",
    agenda: "Align Q4 release timeline.",
    attendees: ["Linh", "David"],
    location: "Online",
    group: "Product",
  },
  {
    id: "freeze",
    title: "Release Code Freeze",
    allDay: true,
    start: "2026-10-26",
    end: "2026-10-29",
    location: "Global",
    group: "Release",
  },
  {
    id: "demo",
    title: "Stakeholder Demo",
    start: "2026-10-29T14:00:00Z",
    end: "2026-10-29T15:00:00Z",
    location: "Auditorium",
    group: "Product",
  },
];

export const primaryCalendarEvent: CalendarEvent = {
  id: "openlia-ui-story-1",
  occurrenceId: "openlia-ui-story-1:2026-10-27T09:00:00Z",
  title: "Architecture & Design Review",
  start: "2026-10-27T09:00:00Z",
  end: "2026-10-27T10:30:00Z",
  allDay: false,
  timezone: "UTC",
  agenda: "Review scope, decisions, and next steps.",
  attendees: ["Alice", "Bob"],
  location: "Room 302",
  notePath: "notes/design-review.md",
  sourcePath: "reports/reminders.rem",
  sourceLine: 12,
  notifications: "off",
};

const mockFiles: Record<string, string> = {
  "reports/events.json": JSON.stringify(
    {
      timezone: "UTC",
      date: "2026-10-27",
      events: storyInlineCalendarEvents,
    },
    null,
    2,
  ),
  "reports/roadmap.json": JSON.stringify(
    {
      timezone: "UTC",
      date: "2026-10-27",
      items: [
        {
          id: "phase-1",
          title: "Schema & Parser Design",
          start: "2026-10-05",
          end: "2026-10-15",
          group: "Platform",
        },
        {
          id: "phase-2",
          title: "Calendar & Chart Components",
          start: "2026-10-14",
          end: "2026-10-26",
          group: "Frontend",
        },
        {
          id: "phase-3",
          title: "Remind & External JSON Integration",
          start: "2026-10-24",
          end: "2026-10-31",
          group: "Backend",
        },
      ],
    },
    null,
    2,
  ),
  "reports/income-expenses.json": JSON.stringify(
    [
      { month: "Jul", Income: 5800, Expenses: 3900 },
      { month: "Aug", Income: 6200, Expenses: 4100 },
      { month: "Sep", Income: 6400, Expenses: 4350 },
      { month: "Oct", Income: 6800, Expenses: 3950 },
    ],
    null,
    2,
  ),
  "reports/metrics.json": JSON.stringify(
    {
      title: "Cash Reserves Trend (External JSON)",
      unit: "USD",
      labels: ["Jul", "Aug", "Sep", "Oct"],
      series: [
        { category: "Checking", values: [12000, 14100, 16150, 19000] },
        { category: "Savings", values: [25000, 26500, 28000, 30500] },
      ],
    },
    null,
    2,
  ),
  "reports/expenses-pie.json": JSON.stringify(
    {
      title: "Monthly Expense Breakdown (External JSON)",
      unit: "USD",
      slices: [
        { label: "Housing", value: 1800 },
        { label: "Food & Dining", value: 850 },
        { label: "Utilities & Cloud", value: 420 },
        { label: "Transport", value: 310 },
        { label: "Healthcare", value: 260 },
      ],
    },
    null,
    2,
  ),
  "reports/flows.json": JSON.stringify(
    {
      title: "Monthly Cashflow Allocation (External JSON)",
      unit: "USD",
      caption: "Loaded from reports/flows.json",
      nodes: [
        { id: "salary", label: "Salary" },
        { id: "consulting", label: "Consulting" },
        { id: "budget", label: "Monthly Pool" },
        { id: "savings", label: "Savings & Investments" },
        { id: "housing", label: "Housing" },
        { id: "living", label: "Living Expenses" },
      ],
      links: [
        { source: "salary", target: "budget", value: 5800, exact: "5,800.00" },
        {
          source: "consulting",
          target: "budget",
          value: 1000,
          exact: "1,000.00",
        },
        {
          source: "budget",
          target: "savings",
          value: 2850,
          exact: "2,850.00",
        },
        {
          source: "budget",
          target: "housing",
          value: 1800,
          exact: "1,800.00",
        },
        { source: "budget", target: "living", value: 2150, exact: "2,150.00" },
      ],
    },
    null,
    2,
  ),
};

export const storyMockApi: WorkspaceApi = {
  async loadTree() {
    return { schema: 1, ok: true, entries: [], truncated: false };
  },
  async loadSession() {
    return {
      schema: 1,
      auth_provider: "none",
      auth_required: false,
      authenticated: true,
    };
  },
  async login() {
    return { schema: 1, ok: true, authenticated: true };
  },
  async logout() {
    return { schema: 1, ok: true, authenticated: false };
  },
  async loadFile(path: string) {
    const clean = path.replace(/^\/+/, "");
    const content =
      mockFiles[clean] ??
      mockFiles[`reports/${clean.split("/").pop() ?? clean}`];
    if (content === undefined) {
      throw new Error(`Story mock file not found: ${clean}`);
    }
    return {
      schema: 1,
      ok: true,
      path: clean,
      content,
      size: content.length,
      modified_at: "2026-10-27T09:00:00Z",
      revision: "sha256:story-mock",
      editable: true,
    };
  },
  async loadFileMetadata(path: string) {
    return {
      schema: 1,
      ok: true,
      path,
      size: 128,
      modified_at: "2026-10-27T09:00:00Z",
      revision: "sha256:story-mock",
      editable: true,
    };
  },
  async saveFile(path: string, content: string) {
    return {
      schema: 1,
      ok: true,
      path,
      size: content.length,
      modified_at: "2026-10-27T09:00:00Z",
      revision: "sha256:story-saved",
      editable: true,
    };
  },
  async createFile(input) {
    return {
      schema: 1,
      ok: true,
      path: input.path,
      size: (input.content ?? "").length,
      modified_at: "2026-10-27T09:00:00Z",
      revision: "sha256:story-created",
      editable: true,
    };
  },
  async uploadFile(destinationPath: string) {
    return {
      schema: 1,
      ok: true,
      path: destinationPath,
      size: 0,
      modified_at: "2026-10-27T09:00:00Z",
      revision: "sha256:story-uploaded",
      editable: true,
    };
  },
  async renameFile(path: string, newName: string) {
    return { schema: 1, ok: true, old_path: path, new_path: newName };
  },
  async moveFile(sourcePath: string, destinationDir: string) {
    return {
      schema: 1,
      ok: true,
      old_path: sourcePath,
      new_path: `${destinationDir}/${sourcePath.split("/").pop()}`,
    };
  },
  async deleteFile(path: string) {
    return { schema: 1, ok: true, path, deleted: true };
  },
  async deleteDirectory(path: string) {
    return { schema: 1, ok: true, path, deleted: true };
  },
  async loadCalendar({ source }) {
    return {
      schema: 1,
      timezone: "UTC",
      revision: "sha256:story-remind",
      events: [
        {
          ...primaryCalendarEvent,
          sourcePath: source,
        },
        {
          id: `${source}:2`,
          occurrenceId: `${source}:2:2026-10-28`,
          title: "Remind Offsite Workshop",
          start: "2026-10-28",
          end: "2026-10-30",
          allDay: true,
          timezone: "UTC",
          location: "Da Nang",
          sourcePath: source,
          sourceLine: 18,
          notifications: "off",
        },
      ],
    };
  },
  async createCalendarEvent(req) {
    return {
      schema: 1,
      timezone: req.timezone,
      revision: "sha256:story-remind-updated",
      events: [
        primaryCalendarEvent,
        {
          id: `openlia-ui-${req.requestId}`,
          occurrenceId: `openlia-ui-${req.requestId}:${req.start}`,
          title: req.title,
          start: req.start,
          end: req.end,
          allDay: false,
          timezone: req.timezone,
          agenda: req.agenda,
          attendees: req.attendees,
          location: req.location,
          sourcePath: req.source,
          sourceLine: 25,
          notifications: "off",
        },
      ],
    };
  },
  rawUrl(path: string) {
    return `/api/workspace/raw?path=${encodeURIComponent(path)}`;
  },
  downloadUrl(path: string) {
    return `/api/workspace/download?path=${encodeURIComponent(path)}`;
  },
};
