import { expect, test } from "bun:test";
import {
  extractMarkdownOpenUIBlocks,
  normalizeOpenUIProgram,
  openUIErrors,
} from "../shared/openui";

test("normalization is schema-derived, recursive, and idempotent", () => {
  const source =
    'Card(children: [CardHeader(subtitle: "Notes", title: "Menu"), Table([Col("Dish", ["Phở"])])])';
  const normalized = normalizeOpenUIProgram(source);
  expect(normalized).toContain('CardHeader("Menu", "Notes")');
  expect(normalizeOpenUIProgram(normalized)).toBe(normalized);
  expect(openUIErrors(source)).toEqual([]);
  expect(normalizeOpenUIProgram('root = TextContent("Table(rows: [])")')).toBe(
    'root = TextContent("Table(rows: [])")',
  );
  expect(openUIErrors('// root = fake\nCardHeader(title: "Real")')).toEqual([]);
});

test("upstream column tables and positional row tables remain valid", () => {
  expect(openUIErrors('Table([Col("Label", ["value"])])')).toEqual([]);
  expect(
    openUIErrors(
      'Table([{key: "v", label: "Value"}], [{v: 0}, {v: false}, {v: null}], "Title")',
    ),
  ).toEqual([]);
  expect(
    openUIErrors(
      'Table([{key: "v", label: "Value"}], [{v: 1e+2}, {v: -2.5e-3}])',
    ),
  ).toEqual([]);
});

test("retained custom components validate through the shared catalog", () => {
  for (const source of [
    'Stack([Calendar(children: [CalendarMonth(title: "Month"), CalendarWeek(), GanttChart()])])',
    'Finance(children: [FinanceOverview(), FinanceChart(report: "balances", kind: "bar"), FinanceAccounts()])',
    'ChartPanel(kind: "bar", labels: ["A"], series: [{category: "X", values: [1]}])',
    'SankeyDiagram(nodes: [{id: "a", label: "A"}, {id: "b", label: "B"}], links: [{source: "a", target: "b", value: 1}])',
  ])
    expect(openUIErrors(source), source).toEqual([]);
  expect(
    openUIErrors("Calendar(children: [], source: 12)").length,
  ).toBeGreaterThan(0);
});

test("invalid arguments and malformed literals terminate with diagnostics", () => {
  for (const source of [
    'CardHeader(titel: "typo")',
    'CardHeader(title: "one", title: "two")',
    'CardHeader("one", subtitle: "two")',
    'Table(columns: [{key: "v", label: "V"}], rows: [{v: }])',
    'Table(columns: [{key: "v", label: "V"}], rows: [{v: 1 v: 2}])',
    'Table(columns: [{key: "v", label: "V"}], rows: [{v: "unterminated}])',
    'Table(columns: [{key: "v", label: "V"}], rows: [{v: 1}], typo: "x")',
    "RecordTable()",
    'MetricCard("Active", @CountBy("status"))',
  ])
    expect(openUIErrors(source).length, source).toBeGreaterThan(0);
});

test("fence extraction follows Markdown containers, metadata, and EOF", () => {
  const markdown =
    '---\ntitle: Note\n---\n\n> ```openui example\n> CardHeader("A")\n> ```\n\n````text\n```openui\nnot a block\n```\n````\n\n~~~openui\nCardHeader("B")';
  expect(extractMarkdownOpenUIBlocks(markdown)).toEqual([
    { code: 'CardHeader("A")', startLine: 6, endLine: 7 },
    { code: 'CardHeader("B")', startLine: 16, endLine: 16 },
  ]);
});
