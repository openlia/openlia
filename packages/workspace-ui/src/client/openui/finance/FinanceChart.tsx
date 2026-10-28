import { defineComponent } from "@openuidev/react-lang";
import {
  addDecimal,
  amountFor,
  chartNumber,
  negateDecimal,
  type SankeyData,
} from "../../../shared/charts";
import {
  financeOpenUIProps,
  type FinanceReport,
} from "../../../shared/finance";
import { ChartPanelView } from "../charts/ChartPanel";
import { SankeyDiagramView } from "../charts/SankeyDiagram";
import { useFinance } from "./context";
import { CHART_COLORS } from "../charts/palette";
import type { z } from "zod";

export function financeSeries(
  report: FinanceReport,
  currency: string,
  types: string,
  source: "changes" | "balances" = "changes",
  invert = false,
): string[] {
  return report.periods
    .map((_, index) =>
      report[source]
        .filter((row) => types.includes(row.type) && row.type !== "")
        .reduce(
          (total, row) =>
            addDecimal(total, amountFor(row.amounts[index], currency)),
          "0",
        ),
    )
    .map((value) => (invert ? negateDecimal(value) : value));
}
export function hasUnclassifiedAmounts(
  report: FinanceReport,
  currency: string,
): boolean {
  return [...report.changes, ...report.balances].some(
    (row) =>
      !["A", "C", "L", "R", "E", "X"].includes(row.type) &&
      row.amounts.some(
        (amounts) => addDecimal(amountFor(amounts, currency), "0") !== "0",
      ),
  );
}
export type FinanceChartProps = z.infer<typeof financeOpenUIProps.FinanceChart>;
/** Presentation metadata only: account identity is shared across credit/debit nodes. */
export function financeFlowColors(
  nodes: SankeyData["nodes"],
  scope: string,
  accounts: FinanceReport["accounts"] = [],
): SankeyData["nodes"] {
  return nodes.map((node) => {
    const account = node.id.replace(/^(from|to):/, "");
    const type = accounts.find((item) => item.name === account)?.type;
    const color =
      node.color ??
      (node.id.startsWith("transaction:")
        ? CHART_COLORS.neutral
        : type === "R"
          ? CHART_COLORS.income
          : type === "X"
            ? CHART_COLORS.expenses
            : undefined);
    return {
      ...node,
      colorKey: node.colorKey ?? `${scope}:${account}`,
      ...(color ? { color } : {}),
    };
  });
}
export function FinanceChartView({
  report: mode,
  kind,
  title,
}: FinanceChartProps) {
  const finance = useFinance();
  if (!finance) return <p role="alert">FinanceChart must be inside Finance.</p>;
  if (finance.loading) return <p role="status">Loading chart…</p>;
  const report = finance.report;
  const currency = finance.currency;
  if (report?.status !== "ok")
    return (
      <p>
        Charts require a selected, validated journal. No unverified totals are
        shown.
      </p>
    );
  if (currency === null)
    return (
      <p>
        Select one currency / commodity to draw charts. Mixed currencies are
        never summed.
      </p>
    );
  const unit = currency || "(unitless)";
  const scopeCaption = `${report.scope.from} ≤ date < ${report.scope.to}; ${report.scope.journal}; account prefix: ${report.scope.accountPrefix || "all"}; unvalued quantities. Chart coordinates are approximate; tables preserve exact decimals.`;
  if (mode === "flows") {
    if (kind && kind !== "sankey")
      return (
        <p role="alert">
          Posting flows require the Sankey view; no different chart or
          allocation is silently substituted.
        </p>
      );
    const flow = Object.hasOwn(report.flows, currency)
      ? report.flows[currency]
      : undefined;
    if (!flow?.data)
      return (
        <p role="status">
          {flow?.reason ?? "Posting-flow data is unavailable."}
        </p>
      );
    return (
      <SankeyDiagramView
        nodes={financeFlowColors(
          flow.data.nodes,
          report.scope.journal,
          report.accounts,
        )}
        links={flow.data.links}
        title={title ?? "Accounting posting flows"}
        unit={unit}
        caption={`${scopeCaption} ${flow.reason}`}
      />
    );
  }
  if (kind === "sankey")
    return (
      <p role="alert">
        Sankey requires the posting-flows report, not aggregated category
        balances.
      </p>
    );
  if (kind === "pie" && mode !== "spending")
    return (
      <p role="alert">
        Historical balances and income/expense time series are not a
        composition. Use a bar or line chart, not a pie.
      </p>
    );
  if (kind === "line" && mode === "spending")
    return (
      <p role="alert">
        Spending categories are not a time trend. Use a bar or pie chart.
      </p>
    );
  if (hasUnclassifiedAmounts(report, currency))
    return (
      <p role="alert">
        Some accounts lack a native hledger account type. Categorized totals and
        charts are withheld rather than guessed. Add reviewed type declarations
        in the journal; mappings do not change them.
      </p>
    );
  let labels = report.periods;
  let data: { category: string; values: string[] }[];
  if (mode === "income-expenses")
    data = [
      {
        category: "Income (net)",
        values: financeSeries(report, currency, "R", "changes", true),
      },
      {
        category: "Expenses (net)",
        values: financeSeries(report, currency, "X"),
      },
    ];
  else if (mode === "balances")
    data = [
      {
        category: "Assets + signed liabilities",
        values: financeSeries(report, currency, "ACL", "balances"),
      },
    ];
  else {
    const rows = report.changes.filter((row) => row.type === "X");
    labels = rows.map((row) => row.account);
    data = [
      {
        category: "Net spending",
        values: rows.map((row) =>
          row.amounts.reduce(
            (total, values) => addDecimal(total, amountFor(values, currency)),
            "0",
          ),
        ),
      },
    ];
  }
  const selectedKind = kind ?? (mode === "balances" ? "line" : "bar");
  const exactRows = labels.map((label, index) => [
    label,
    ...data.map((item) => item.values[index] ?? "0"),
  ]);
  let error = "";
  let series: { category: string; values: number[] }[] = [];
  try {
    series = data.map((item) => ({
      category: item.category,
      values: item.values.map(chartNumber),
    }));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Chart precision limit";
    series = data.map((item) => ({
      category: item.category,
      values: item.values.map(() => 0),
    }));
  }
  return (
    <ChartPanelView
      kind={selectedKind}
      labels={labels}
      series={series}
      values={series[0]?.values ?? []}
      exactRows={exactRows}
      title={
        title ??
        (mode === "balances"
          ? "Net asset/liability balances (not market-valued net worth)"
          : mode === "spending"
            ? "Spending by account"
            : "Income and expenses")
      }
      unit={unit}
      caption={scopeCaption}
      error={error}
      colors={
        mode === "income-expenses"
          ? [CHART_COLORS.income, CHART_COLORS.expenses]
          : mode === "balances"
            ? [CHART_COLORS.balance]
            : selectedKind === "bar"
              ? [CHART_COLORS.expenses]
              : undefined
      }
      colorDomain={
        mode === "spending" && selectedKind === "pie"
          ? report.accounts
              .filter((account) => account.type === "X")
              .map((account) => account.name)
              .sort()
          : undefined
      }
    />
  );
}
export const FinanceChart = defineComponent({
  name: "FinanceChart",
  description:
    "Binds exact native Finance report data to reusable charts; does not parse journals or invent financial classifications",
  props: financeOpenUIProps.FinanceChart,
  component: ({ props }) => <FinanceChartView {...props} />,
});
