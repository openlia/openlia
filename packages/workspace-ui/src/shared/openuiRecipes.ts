/** Executable documentation: validated and rendered by the authoring tests. */
export const openUIRecipes = [
  {
    name: "table",
    components: ["Table", "Col"],
    code: 'Table(title: "Thực đơn", columns: [{key: "dish", label: "Món ăn"}], rows: [{dish: "Phở bò"}, {dish: "Cơm gà"}])',
  },
  {
    name: "card",
    components: ["Card", "CardHeader", "TextContent"],
    code: 'Card(children: [CardHeader(title: "Summary", subtitle: "Today"), TextContent(text: "Two tasks completed.")])',
  },
  {
    name: "layout",
    components: ["Stack", "Card", "CardHeader", "TextContent"],
    code: 'Stack(children: [Card(children: [CardHeader(title: "Notes"), TextContent(text: "Review the plan.")]), Card(children: [TextContent(text: "Next steps")])], direction: "row", gap: "m", wrap: true)',
  },
  {
    name: "tabs",
    components: ["Tabs", "TabItem", "TextContent"],
    code: 'Tabs(items: [TabItem(value: "summary", trigger: "Summary", content: [TextContent(text: "Overview")]), TabItem(value: "details", trigger: "Details", content: [TextContent(text: "More information")])])',
  },
  {
    name: "bar-chart",
    components: ["ChartPanel"],
    code: 'ChartPanel(kind: "bar", labels: ["Mon", "Tue"], series: [{category: "Walks", values: [2, 3]}], title: "Activity")',
  },
  {
    name: "line-chart",
    components: ["ChartPanel"],
    code: 'ChartPanel(kind: "line", labels: ["Mon", "Tue"], series: [{category: "Walks", values: [2, 3]}])',
  },
  {
    name: "pie-chart",
    components: ["ChartPanel"],
    code: 'ChartPanel(kind: "pie", labels: ["Food", "Travel"], values: [40, 20], title: "Spending")',
  },
  {
    name: "calendar",
    components: ["Calendar", "CalendarMonth", "CalendarWeek", "GanttChart"],
    code: 'Calendar(children: [CalendarMonth(title: "Month"), CalendarWeek(title: "Week"), GanttChart()])',
  },
  {
    name: "finance",
    components: [
      "Finance",
      "FinanceOverview",
      "FinanceChart",
      "FinanceAccounts",
    ],
    code: 'Finance(children: [FinanceOverview(), FinanceChart(report: "balances", kind: "bar"), FinanceAccounts()])',
  },
  {
    name: "sankey",
    components: ["SankeyDiagram"],
    code: 'SankeyDiagram(nodes: [{id: "a", label: "Income"}, {id: "b", label: "Savings"}], links: [{source: "a", target: "b", value: 100}])',
  },
];
