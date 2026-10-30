import type { Meta, StoryObj } from "@storybook/react-vite";
import { MarkdownPreview } from "../components/editor/MarkdownPreview";
import { OpenLiaOpenUIProvider } from "../openui/context";
import { OpenUIDiagnostics } from "../openui/OpenUIDiagnostics";
import { OpenUIErrorBoundary } from "../openui/OpenUIErrorBoundary";
import { action, storyData, storyLoader } from "./fixtures";
import { openUIRecipes } from "../../shared/openuiRecipes";

const meta = {
  title: "OpenUI/Inline Markdown",
  loaders: [storyLoader],
  parameters: {
    componentExports: [
      "openui/OpenUIDiagnostics.tsx#OpenUIDiagnostics",
      "openui/OpenUIErrorBoundary.tsx#OpenUIErrorBoundary",
    ],
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const document = (heading: string, code: string) =>
  `# ${heading}\n\nNarrative and interactive views live in one document.\n\n\`\`\`openui\n${code}\n\`\`\`\n\nContinue writing ordinary Markdown here.`;

export const Menu: Story = {
  render: () => (
    <MarkdownPreview
      currentFilePath="family/menu.md"
      content={document(
        "Thực đơn ngày 29/10/2026",
        'Table(title: "Thực đơn", columns: [{key: "meal", label: "Bữa ăn"}, {key: "dish", label: "Món ăn"}], rows: [{meal: "Bữa sáng", dish: "Phở bò"}, {meal: "Bữa trưa", dish: "Cơm gà"}, {meal: "Bữa tối", dish: "Canh rau"}])',
      )}
    />
  ),
};
export const AuthoringRecipes: Story = {
  render: () => (
    <MarkdownPreview
      currentFilePath="examples/recipes.md"
      content={openUIRecipes
        .map((recipe) => document(recipe.name, recipe.code))
        .join("\n\n")}
    />
  ),
};
export const Chart: Story = {
  render: () => (
    <MarkdownPreview
      content={document(
        "Weekly activity",
        'ChartPanel(kind: "bar", labels: ["Mon", "Tue"], series: [{category: "Walks", values: [2, 3]}], title: "Walks")',
      )}
    />
  ),
};
export const Calendar: Story = {
  render: (_args, { loaded }) => (
    <OpenLiaOpenUIProvider value={{ calendarApi: storyData(loaded).api }}>
      <MarkdownPreview
        currentFilePath="calendar/overview.md"
        content={document(
          "Appointments",
          'Calendar(children: [CalendarMonth(title: "Month"), CalendarWeek(title: "Week")])',
        )}
      />
    </OpenLiaOpenUIProvider>
  ),
};
export const Finance: Story = {
  render: (_args, { loaded }) => (
    <OpenLiaOpenUIProvider value={{ financeApi: storyData(loaded).api }}>
      <MarkdownPreview
        currentFilePath="finance/overview.md"
        content={document(
          "Finances",
          'Finance(children: [FinanceOverview(title: "Overview"), FinanceChart(report: "balances", kind: "bar", title: "Balances"), FinanceAccounts(title: "Accounts")])',
        )}
      />
    </OpenLiaOpenUIProvider>
  ),
};
export const InvalidBlock: Story = {
  render: () => (
    <MarkdownPreview
      content={document(
        "An isolated error",
        'Table(columns: [{key: "broken", label: "Broken"}], rows: [{broken: }])',
      )}
    />
  ),
};
export const ValidDiagnostics: Story = {
  render: () => <OpenUIDiagnostics content="CalendarMonth()" />,
};
export const InvalidDiagnostics: Story = {
  render: () => <OpenUIDiagnostics content="UnknownWidget()" />,
};
export const ErrorBoundary: Story = {
  render: () => (
    <OpenUIErrorBoundary
      uiPath="notes.md (openui)"
      onEditUI={action("editDocument")}
    >
      <p>Healthy inline content.</p>
    </OpenUIErrorBoundary>
  ),
};
