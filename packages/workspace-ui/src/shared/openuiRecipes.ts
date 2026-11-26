export const inlineCalendarMonthExample = `CalendarMonth(
  title: "Product Launch Schedule",
  timezone: "Asia/Ho_Chi_Minh",
  events: [
    {id: "kickoff", title: "Launch Kickoff", start: "2026-11-03T09:00:00+07:00", end: "2026-11-03T10:30:00+07:00", location: "Room 302"},
    {id: "freeze", title: "Code Freeze", allDay: true, start: "2026-11-10", end: "2026-11-12"}
  ]
)`;

export const inlineCalendarExample = `Calendar(
  timezone: "UTC",
  events: [
    {id: "review", title: "Project review", start: "2026-10-27T09:00:00Z", end: "2026-10-27T10:00:00Z", agenda: "Review milestones", attendees: ["Alice", "Bob"], location: "Office"},
    {id: "planning", title: "Planning", start: "2026-10-27T09:30:00Z", end: "2026-10-27T10:30:00Z"},
    {id: "conference", title: "Conference", allDay: true, start: "2026-10-26", end: "2026-10-29"}
  ],
  children: [CalendarMonth(title: "Month"), CalendarWeek(title: "Week"), CalendarGantt(title: "Timeline", groupBy: "location")]
)`;

/** Executable documentation: validated and rendered by the OpenUI tests. */
export const openUIRecipes = [
  {
    name: "calendar-month-inline",
    components: ["CalendarMonth"],
    code: inlineCalendarMonthExample,
  },
  {
    name: "calendar-month-remind",
    components: ["CalendarMonth"],
    code: 'CalendarMonth(title: "Team Calendar", source: "./reminders.rem", timezone: "Asia/Ho_Chi_Minh")',
  },
  {
    name: "calendar-month-json",
    components: ["CalendarMonth"],
    code: 'CalendarMonth(title: "Events", source: "./events.json", timezone: "UTC")',
  },
  {
    name: "calendar-week",
    components: ["CalendarWeek"],
    code: 'CalendarWeek(title: "Sprint Week", timezone: "UTC", events: [{id: "standup", title: "Daily Standup", start: "2026-10-27T09:00:00Z", end: "2026-10-27T09:30:00Z"}])',
  },
  {
    name: "calendar-gantt",
    components: ["CalendarGantt", "GanttChart"],
    code: 'CalendarGantt(title: "Q4 Roadmap", zoom: "month", groupBy: "group", items: [{id: "design", title: "Architecture Design", start: "2026-11-01", end: "2026-11-10", group: "Engineering"}, {id: "qa", title: "Integration Testing", start: "2026-11-10", end: "2026-11-20", group: "QA"}])',
  },
  {
    name: "calendar-multi-view",
    components: [
      "Calendar",
      "CalendarMonth",
      "CalendarWeek",
      "CalendarGantt",
      "GanttChart",
    ],
    code: inlineCalendarExample,
  },
  {
    name: "chart-bar",
    components: ["ChartBar", "ChartPanel"],
    code: 'ChartBar(title: "Monthly Income vs. Expenses", unit: "USD", labels: ["Jan", "Feb", "Mar"], series: [{category: "Income", values: [6200, 6400, 6800]}, {category: "Expenses", values: [4100, 4350, 3900]}])',
  },
  {
    name: "chart-bar-json",
    components: ["ChartBar"],
    code: 'ChartBar(title: "Monthly Income vs. Expenses", source: "./income-expenses.json")',
  },
  {
    name: "chart-line",
    components: ["ChartLine", "ChartPanel"],
    code: 'ChartLine(title: "Weekly Active Users", unit: "users", labels: ["W1", "W2", "W3", "W4"], series: [{category: "Signups", values: [120, 145, 160, 190]}])',
  },
  {
    name: "chart-pie",
    components: ["ChartPie", "ChartPanel"],
    code: 'ChartPie(title: "Expense Breakdown", unit: "USD", labels: ["Housing", "Food", "Transport"], values: [1500, 600, 300])',
  },
  {
    name: "chart-sankey",
    components: ["ChartSankey", "SankeyDiagram"],
    code: 'ChartSankey(title: "Monthly Cashflow", unit: "USD", nodes: [{id: "income", label: "Income"}, {id: "savings", label: "Savings"}, {id: "expenses", label: "Expenses"}], links: [{source: "income", target: "savings", value: 2000}, {source: "income", target: "expenses", value: 4200}])',
  },
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
];
