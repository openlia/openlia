import type { Meta, StoryObj } from "@storybook/react-vite";
import { openUIRecipes } from "../../shared/openuiRecipes";
import { MarkdownPreview } from "../components/editor/MarkdownPreview";
import { OpenUIDiagnostics } from "../openui/OpenUIDiagnostics";
import { OpenUIErrorBoundary } from "../openui/OpenUIErrorBoundary";
import { storyMockApi } from "./fixtures";

const examplePromptMarkdown = `# Example markdown

This document combines standard Markdown narrative with inline \`openui\` blocks for **Calendar** and **Chart** views.

\`\`\`openui
CalendarMonth(
  title: "October 2026 Schedule",
  timezone: "Asia/Ho_Chi_Minh",
  date: "2026-10-27",
  events: [
    { id: "review", title: "Architecture Review", start: "2026-10-27T09:00:00+07:00", end: "2026-10-27T10:30:00+07:00", location: "Room 302" },
    { id: "freeze", title: "Release Code Freeze", allDay: true, start: "2026-10-28", end: "2026-10-31" }
  ]
)
\`\`\`

## Monthly income vs. expenses

\`\`\`openui
ChartBar(
  title: "Monthly Income vs. Expenses",
  unit: "USD",
  labels: ["Jul", "Aug", "Sep", "Oct"],
  series: [
    { category: "Income", values: [5800, 6200, 6400, 6800] },
    { category: "Expenses", values: [3900, 4100, 4350, 3950] }
  ]
)
\`\`\`

## Net Cashflow & Expense Breakdown

\`\`\`openui
ChartLine(
  title: "Net Monthly Savings",
  unit: "USD",
  labels: ["Jul", "Aug", "Sep", "Oct"],
  values: [1900, 2100, 2050, 2850]
)
\`\`\`

\`\`\`openui
ChartPie(
  title: "October Expense Breakdown",
  unit: "USD",
  slices: [
    { label: "Housing", value: 1800 },
    { label: "Food", value: 850 },
    { label: "Utilities", value: 420 },
    { label: "Transport", value: 310 }
  ]
)
\`\`\`

\`\`\`openui
ChartSankey(
  title: "October Cashflow Allocation",
  unit: "USD",
  nodes: [
    { id: "income", label: "Total Income" },
    { id: "savings", label: "Savings" },
    { id: "expenses", label: "Living Expenses" }
  ],
  links: [
    { source: "income", target: "savings", value: 2850 },
    { source: "income", target: "expenses", value: 3950 }
  ]
)
\`\`\`
`;

const externalFilesMarkdown = `# External Data Sources (\`.rem\` & \`.json\`)

## 1. Remind Calendar (\`source: "./reminders.rem"\`)

\`\`\`openui
CalendarMonth(
  title: "Team Remind Calendar",
  source: "./reminders.rem",
  date: "2026-10-27",
  timezone: "UTC"
)
\`\`\`

## 2. External JSON Calendar & Gantt (\`source: "./events.json"\` & \`"./roadmap.json"\`)

\`\`\`openui
CalendarWeek(
  title: "Week View from events.json",
  source: "./events.json"
)
\`\`\`

\`\`\`openui
CalendarGantt(
  title: "Roadmap from roadmap.json",
  source: "./roadmap.json",
  zoom: "month",
  groupBy: "group"
)
\`\`\`

## 3. External JSON Charts

\`\`\`openui
ChartBar(
  title: "Monthly Income vs. Expenses (from income-expenses.json)",
  unit: "USD",
  source: "./income-expenses.json"
)
\`\`\`

\`\`\`openui
ChartLine(source: "./metrics.json")
\`\`\`

\`\`\`openui
ChartPie(source: "./expenses-pie.json")
\`\`\`

\`\`\`openui
ChartSankey(source: "./flows.json")
\`\`\`
`;

const meta = {
  title: "OpenUI/Markdown Blocks",
  component: MarkdownPreview,
  args: {
    api: storyMockApi,
    currentFilePath: "reports/overview.md",
    content: examplePromptMarkdown,
  },
} satisfies Meta<typeof MarkdownPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ExampleMarkdownDocument: Story = {};

export const ExternalFilesMarkdownDocument: Story = {
  args: {
    content: externalFilesMarkdown,
  },
};

export const AllOpenUIRecipes: Story = {
  args: {
    content: [
      "# Registered OpenUI Recipes",
      ...openUIRecipes.map(
        (recipe) =>
          `## \`${recipe.name}\` (${recipe.components.join(", ")})\n\n\`\`\`openui\n${recipe.code}\n\`\`\``,
      ),
    ].join("\n\n"),
  },
};

export const DiagnosticsAndErrorFallback: Story = {
  render: () => (
    <div className="space-y-6">
      <MarkdownPreview
        api={storyMockApi}
        currentFilePath="reports/broken.md"
        content={[
          "# Document with Invalid OpenUI Block",
          "Valid Markdown paragraphs above and below the broken block continue to render normally.",
          "```openui",
          'ChartBar(source: "conflict.json", labels: ["Jan"], values: [100])',
          "```",
          "```openui",
          "UnknownComponent(foo: 123)",
          "```",
        ].join("\n\n")}
      />
      <OpenUIDiagnostics content='CalendarMonth(title: "Valid")' />
      <OpenUIErrorBoundary uiPath="reports/broken.md" source="ChartBar(...)">
        <p className="text-sm">Error boundary children render when healthy.</p>
      </OpenUIErrorBoundary>
    </div>
  ),
};
