import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChartPanelView } from "../openui/charts/ChartPanel";
import { SankeyDiagramView } from "../openui/charts/SankeyDiagram";
import { CHART_COLORS, CATEGORICAL_COLORS } from "../openui/charts/palette";
import { useState } from "react";
import { expect, waitFor } from "storybook/test";

const meta = {
  title: "Charts/Reusable charts",
  component: ChartPanelView,
  args: {
    kind: "bar",
    title: "Monthly income and spending",
    unit: "USD",
    labels: ["Aug", "Sep", "Oct"],
    colorDomain: ["Income", "Expenses"],
    series: [
      { category: "Income", values: [2000, 2400, 2200] },
      { category: "Expenses", values: [1500, 1700, 1400] },
    ],
  },
  argTypes: {
    kind: { control: "select", options: ["bar", "line", "pie"] },
    title: { control: "text" },
    unit: { control: "text" },
  },
  parameters: {
    componentExports: [
      "openui/charts/ChartPanel.tsx#ChartPanelView",
      "openui/charts/ChartPanel.tsx#ChartPanel",
      "openui/charts/SankeyDiagram.tsx#SankeyDiagramView",
      "openui/charts/SankeyDiagram.tsx#SankeyDiagram",
    ],
    docs: {
      description: {
        component:
          "Reusable, ledger-independent charts. Bar, Line, and Pie reuse upstream OpenUI components; Sankey uses d3-sankey. Exact tables are available to keyboard users.",
      },
    },
  },
} satisfies Meta<typeof ChartPanelView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Bars: Story = {};
export const Lines: Story = {
  args: {
    kind: "line",
    title: "Historical balances",
    series: [
      { category: "Checking", values: [1200, 1500, 1400] },
      { category: "Savings", values: [800, 1000, 1300] },
    ],
    colors: [CHART_COLORS.balance, CHART_COLORS.sky],
  },
};
export const Pie: Story = {
  args: {
    kind: "pie",
    title: "Spending composition",
    labels: ["Food", "Travel", "Utilities"],
    colorDomain: ["Food", "Travel", "Utilities"],
    values: [300, 500, 200],
  },
};
export const RefundBars: Story = {
  args: {
    labels: ["Purchase", "Refund"],
    series: [{ category: "Net expense", values: [100, -20] }],
    title: "Signed changes",
    colors: [CHART_COLORS.expenses],
  },
};
export const InvalidPie: Story = {
  args: {
    kind: "pie",
    labels: ["Refund"],
    values: [-20],
    title: "Negative slices are invalid",
  },
};
export const Empty: Story = { args: { labels: [], series: [] } };
export const ReportError: Story = {
  args: { error: "The source report is unavailable. No totals are inferred." },
};
export const LongLabels: Story = {
  args: {
    labels: [
      "International travel and accommodation",
      "Household operating expenses and subscriptions",
    ],
    series: [{ category: "Expense", values: [3000, 800] }],
  },
};
const nodes = [
  { id: "income", label: "Salary", color: CHART_COLORS.income },
  { id: "pool", label: "Posting group", color: CHART_COLORS.neutral },
  { id: "bank", label: "Bank", color: CHART_COLORS.balance },
  { id: "tax", label: "Tax", color: CHART_COLORS.expenses },
];
const links = [
  { source: "income", target: "pool", value: 1000, exact: "1000.00" },
  { source: "pool", target: "bank", value: 800, exact: "800.00" },
  { source: "pool", target: "tax", value: 200, exact: "200.00" },
];
export const Sankey: Story = {
  render: () => (
    <SankeyDiagramView
      nodes={nodes}
      links={links}
      unit="USD"
      caption="Illustrative posting flow, not a general-purpose allocation of one source to each destination."
    />
  ),
};
export const MissingNode: Story = {
  render: () => (
    <SankeyDiagramView
      nodes={nodes}
      links={[{ source: "missing", target: "bank", value: 1 }]}
    />
  ),
};
export const CyclicGraph: Story = {
  render: () => (
    <SankeyDiagramView
      nodes={nodes}
      links={[...links, { source: "bank", target: "income", value: 100 }]}
    />
  ),
};
export const EmptySankey: Story = {
  render: () => <SankeyDiagramView nodes={[]} links={[]} />,
};

export const FullCategoricalPalette: Story = {
  args: {
    kind: "pie",
    title: "Distinct category colors",
    labels: ["Food", "Rent", "Travel", "Utilities", "Health", "Other"],
    colorDomain: ["Food", "Rent", "Travel", "Utilities", "Health", "Other"],
    values: [300, 900, 250, 150, 100, 80],
  },
  play: async ({ canvasElement }) => {
    // Verify real upstream SVG paints, not only our theme metadata.
    await waitFor(() => {
      const paints = [...canvasElement.querySelectorAll("svg *")].flatMap(
        (element) => {
          const style = getComputedStyle(element);
          return [style.fill, style.stroke];
        },
      );
      for (const hex of CATEGORICAL_COLORS) {
        const value = Number.parseInt(hex.slice(1), 16);
        expect(paints).toContain(
          `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`,
        );
      }
    });
  },
};
export const FilterAndReorderCategories: Story = {
  render: function FilteredCategories() {
    const [filtered, setFiltered] = useState(false);
    const domain = ["Food", "Travel", "Utilities"];
    return (
      <>
        <button
          type="button"
          className="btn btn-sm mb-3"
          onClick={() => setFiltered(!filtered)}
        >
          Toggle filtered / reordered categories
        </button>
        <ChartPanelView
          kind="pie"
          labels={filtered ? ["Utilities", "Food"] : domain}
          values={filtered ? [600, 100] : [300, 500, 200]}
          colorDomain={domain}
          title="Food stays emerald; Utilities stays violet"
        />
      </>
    );
  },
};
