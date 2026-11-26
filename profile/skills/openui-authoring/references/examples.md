# OpenUI Markdown Examples

## 1. Inline Calendar & Bar Chart in One Document

````markdown
# Example markdown

```openui
CalendarMonth(
  title: "November 2026 Schedule",
  timezone: "Asia/Ho_Chi_Minh",
  events: [
    { id: "kickoff", title: "Project Kickoff", start: "2026-11-03T09:00:00+07:00", end: "2026-11-03T10:30:00+07:00", location: "Room 302" },
    { id: "release", title: "Release Freeze", allDay: true, start: "2026-11-15", end: "2026-11-18" }
  ]
)
```

## Monthly income vs. expenses

```openui
ChartBar(
  title: "Monthly Income vs. Expenses",
  unit: "USD",
  labels: ["Aug", "Sep", "Oct", "Nov"],
  series: [
    { category: "Income", values: [6200, 6400, 6800, 7100] },
    { category: "Expenses", values: [4100, 4350, 3900, 4200] }
  ]
)
```
````

## 2. External Remind (`.rem`) & External JSON (`.json`) Sources

````markdown
# Operations Dashboard

## Team Calendar (Remind `.rem` source)

```openui
Calendar(
  source: "./reminders.rem",
  timezone: "Asia/Ho_Chi_Minh",
  children: [
    CalendarMonth(title: "Month View"),
    CalendarWeek(title: "Week View"),
    CalendarGantt(title: "Timeline View", zoom: "week")
  ]
)
```

## Quarterly Delivery Roadmap (External JSON source)

```openui
CalendarGantt(
  title: "Q4 Delivery Roadmap",
  source: "./roadmap.json",
  zoom: "month",
  groupBy: "group"
)
```

## Financial Overview (External JSON sources)

```openui
ChartLine(
  title: "Net Cashflow Trend",
  source: "./data/cashflow-trend.json"
)
```

```openui
ChartPie(
  title: "Operating Expenses by Category",
  source: "./data/expenses-pie.json"
)
```

```openui
ChartSankey(
  title: "Revenue Allocation Flows",
  source: "./data/revenue-sankey.json"
)
```
````
