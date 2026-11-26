import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ChartPanelContainer,
  ChartPanelView,
} from "../openui/charts/ChartPanel";
import { CHART_COLORS } from "../openui/charts/palette";
import {
  SankeyDiagramContainer,
  SankeyDiagramView,
} from "../openui/charts/SankeyDiagram";

const meta = {
  title: "OpenUI/Charts",
  component: ChartPanelView,
  args: {
    kind: "bar",
    title: "Monthly Income vs. Expenses",
    unit: "USD",
    labels: ["Jul", "Aug", "Sep", "Oct"],
    colorDomain: ["Income", "Expenses"],
    series: [
      { category: "Income", values: [5800, 6200, 6400, 6800] },
      { category: "Expenses", values: [3900, 4100, 4350, 3950] },
    ],
  },
  argTypes: {
    kind: { control: "select", options: ["bar", "line", "pie"] },
    title: { control: "text" },
    unit: { control: "text" },
  },
} satisfies Meta<typeof ChartPanelView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BarChartGrouped: Story = {};

export const BarChartStacked: Story = {
  args: {
    kind: "bar",
    variant: "stacked",
    title: "Quarterly Revenue by Channel (Stacked)",
    unit: "USD",
    labels: ["Q1", "Q2", "Q3", "Q4"],
    series: [
      { category: "Self-Serve", values: [12000, 14500, 16800, 19200] },
      { category: "Enterprise", values: [18000, 21000, 24000, 29000] },
    ],
  },
};

export const BarChartSingleSeries: Story = {
  args: {
    kind: "bar",
    title: "Monthly Net Savings",
    unit: "USD",
    labels: ["Jul", "Aug", "Sep", "Oct"],
    series: [],
    values: [1900, 2100, 2050, 2850],
  },
};

export const BarChartExternalJson: Story = {
  render: () => (
    <ChartPanelContainer
      kind="bar"
      title="Monthly Income vs. Expenses (External .json)"
      unit="USD"
      source="./income-expenses.json"
    />
  ),
};

export const LineChartMultiSeries: Story = {
  args: {
    kind: "line",
    title: "Account Balances Over Time",
    unit: "USD",
    labels: ["Jul", "Aug", "Sep", "Oct"],
    series: [
      { category: "Checking", values: [12000, 14100, 16150, 19000] },
      { category: "Savings", values: [25000, 26500, 28000, 30500] },
    ],
    colors: [CHART_COLORS.balance, CHART_COLORS.sky],
  },
};

export const LineChartExternalJson: Story = {
  render: () => <ChartPanelContainer kind="line" source="./metrics.json" />,
};

export const PieChartDonut: Story = {
  args: {
    kind: "pie",
    variant: "donut",
    title: "Expense Breakdown (Donut)",
    unit: "USD",
    labels: ["Housing", "Food", "Utilities", "Transport", "Healthcare"],
    colorDomain: ["Housing", "Food", "Utilities", "Transport", "Healthcare"],
    values: [1800, 850, 420, 310, 260],
  },
};

export const PieChartStandard: Story = {
  args: {
    kind: "pie",
    variant: "pie",
    title: "Expense Breakdown (Pie)",
    unit: "USD",
    labels: ["Housing", "Food", "Utilities", "Transport", "Healthcare"],
    values: [1800, 850, 420, 310, 260],
  },
};

export const PieChartExternalJson: Story = {
  render: () => <ChartPanelContainer kind="pie" source="./expenses-pie.json" />,
};

const sankeyNodes = [
  { id: "salary", label: "Salary", color: CHART_COLORS.income },
  { id: "consulting", label: "Consulting", color: CHART_COLORS.sky },
  { id: "pool", label: "Monthly Budget Pool", color: CHART_COLORS.neutral },
  { id: "savings", label: "Savings", color: CHART_COLORS.balance },
  { id: "housing", label: "Housing", color: CHART_COLORS.expenses },
  { id: "living", label: "Living Expenses", color: CHART_COLORS.amber },
];

const sankeyLinks = [
  { source: "salary", target: "pool", value: 5800, exact: "5,800.00" },
  { source: "consulting", target: "pool", value: 1000, exact: "1,000.00" },
  { source: "pool", target: "savings", value: 2850, exact: "2,850.00" },
  { source: "pool", target: "housing", value: 1800, exact: "1,800.00" },
  { source: "pool", target: "living", value: 2150, exact: "2,150.00" },
];

export const SankeyDiagramInline: Story = {
  render: () => (
    <SankeyDiagramView
      title="Monthly Cashflow Allocation"
      unit="USD"
      caption="Directed non-negative flow graph with exact values in the collapsible table."
      nodes={sankeyNodes}
      links={sankeyLinks}
    />
  ),
};

export const SankeyDiagramExternalJson: Story = {
  render: () => <SankeyDiagramContainer source="./flows.json" />,
};

export const ChartValidationStates: Story = {
  render: () => (
    <div className="space-y-6">
      <ChartPanelView
        kind="pie"
        title="Negative Pie Slice (Validation Error)"
        labels={["Valid", "Negative"]}
        values={[100, -25]}
      />
      <ChartPanelView
        kind="bar"
        title="Empty Chart State"
        labels={[]}
        series={[]}
      />
      <SankeyDiagramView
        title="Cyclic Sankey Graph (Validation Error)"
        nodes={[
          { id: "a", label: "Node A" },
          { id: "b", label: "Node B" },
        ]}
        links={[
          { source: "a", target: "b", value: 100 },
          { source: "b", target: "a", value: 100 },
        ]}
      />
    </div>
  ),
};
