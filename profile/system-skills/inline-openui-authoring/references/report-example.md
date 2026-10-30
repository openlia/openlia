# Weekly delivery review

> Illustrative example only. All counts below are fictional, not workspace facts.
> In a real report, link the inspected source records here.

Reporting period: 12–23 October 2026. Snapshot: 24 October 2026.
Units: completed tasks per week. These literal views do not update automatically.

## Conclusion

Completed tasks rose from 8 to 12 across the two weeks. The latest week has no
recorded support-task count: that value is missing, not zero, and is excluded
from the completed-task totals. This example does not establish a longer-term trend.

## Completed tasks

```openui
ChartPanel(kind: "bar", labels: ["12–16 Oct", "19–23 Oct"], series: [{category: "Completed tasks", values: [8, 12]}], title: "Completed tasks per week (count)")
```

## Exact values and gaps

```openui
Table(title: "Weekly task counts", columns: [{key: "week", label: "Week"}, {key: "completed", label: "Completed (count)"}, {key: "support", label: "Support (count)"}], rows: [{week: "12–16 Oct 2026", completed: 8, support: 0}, {week: "19–23 Oct 2026", completed: 12, support: "Not recorded"}])
```

## Next step

Check the missing support-task count before comparing support workload. Preserve
the underlying records; update or create a dated report when new data arrives.
