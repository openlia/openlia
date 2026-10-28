import { defineComponent, Renderer } from "@openuidev/react-lang";
import { openuiLibrary, ThemeProvider, useTheme } from "@openuidev/react-ui";
import { useId } from "react";
import { chartColorSchema, chartOpenUIProps } from "../../../shared/charts";
import { chartColorsFor, openUIPalette } from "./palette";
import type { z } from "zod";

export type ChartPanelProps = z.infer<typeof chartOpenUIProps.ChartPanel>;
export function ChartPanelView({
  kind,
  labels,
  series = [],
  values = [],
  title = "Chart",
  unit = "",
  caption,
  exactRows,
  error,
  colors,
  colorDomain,
}: ChartPanelProps) {
  const id = useId();
  const { theme, mode } = useTheme();
  const paletteId = `chart-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const keys = kind === "pie" ? labels : series.map((item) => item.category);
  const orderedColors = chartColorsFor(
    keys,
    colors,
    colorDomain,
    kind === "pie" ? values : undefined,
  );
  const invalidColor = orderedColors.some(
    (color) => !chartColorSchema.safeParse(color).success,
  );
  const palette = openUIPalette(invalidColor ? [] : orderedColors);
  const paletteTheme = {
    ...theme,
    barChartPalette: palette,
    lineChartPalette: palette,
    pieChartPalette: palette,
  };
  const rows =
    exactRows ??
    labels.map((label, index) => [
      label,
      ...(kind === "pie"
        ? [String(values[index])]
        : series.map((item) => String(item.values[index]))),
    ]);
  const headers = [
    "Category / period",
    ...(kind === "pie"
      ? [unit || "Value"]
      : series.map((item) => `${item.category}${unit ? ` (${unit})` : ""}`)),
  ];
  // Positional report-cell identities also distinguish repeated category labels.
  const tableRows = rows.map((cells, row) => ({
    id: `${cells[0]}:${row}`,
    cells: cells.map((value, column) => ({
      id: `${headers[column]}:${column}`,
      value,
    })),
  }));
  const numbers =
    kind === "pie" ? values : series.flatMap((item) => item.values);
  const invalid =
    numbers.some((value) => !Number.isFinite(value)) ||
    (kind === "pie"
      ? values.length !== labels.length || values.some((value) => value < 0)
      : series.some((item) => item.values.length !== labels.length));
  const empty = !labels.length || !numbers.some((value) => value !== 0);
  const program =
    kind === "pie"
      ? `root = PieChart(${JSON.stringify(labels)}, ${JSON.stringify(values)}, "donut")`
      : `root = ${kind === "bar" ? "BarChart" : "LineChart"}(${JSON.stringify(labels)}, [${series.map((item) => `Series(${JSON.stringify(item.category)}, ${JSON.stringify(item.values)})`).join(",")}], "${kind === "bar" ? "grouped" : "linear"}", "Period / category", ${JSON.stringify(unit)}, 280)`;
  return (
    <ThemeProvider
      mode={mode}
      lightTheme={paletteTheme}
      darkTheme={paletteTheme}
      cssSelector={`[data-chart-palette="${paletteId}"]`}
    >
      <section
        data-chart-palette={paletteId}
        aria-labelledby={id}
        className="rounded-xl border border-base-content/10 p-4 space-y-3 min-w-0"
      >
        <h3 id={id} className="font-semibold">
          {title}
          {unit ? ` · ${unit}` : ""}
        </h3>
        {caption && <p className="text-xs opacity-70">{caption}</p>}
        {error ? (
          <p role="alert">{error}</p>
        ) : invalidColor ? (
          <p role="alert">Chart colors must be opaque hexadecimal colors.</p>
        ) : invalid ? (
          <p role="alert">
            Invalid chart data. Series lengths must match; pie slices cannot be
            negative.
          </p>
        ) : empty ? (
          <p role="status">No non-zero data in this scope.</p>
        ) : (
          <div
            className="min-w-0 overflow-x-auto"
            role="img"
            aria-label={`${title}. Exact values are available in the data table.`}
          >
            <div className="min-w-[320px]">
              <Renderer library={openuiLibrary} response={program} />
            </div>
          </div>
        )}
        <details>
          <summary className="cursor-pointer text-sm">Exact data table</summary>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <caption className="sr-only">{title} exact values</caption>
              <thead>
                <tr>
                  {headers.map((header) => (
                    <th key={header} scope="col">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => (
                  <tr key={row.id}>
                    {row.cells.map((cell) => (
                      <td key={cell.id}>{cell.value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </ThemeProvider>
  );
}
export const ChartPanel = defineComponent({
  name: "ChartPanel",
  description:
    "Accessible panel around the existing OpenUI BarChart, LineChart, or PieChart, with units and an exact data table",
  props: chartOpenUIProps.ChartPanel,
  component: ({ props }) => <ChartPanelView {...props} />,
});
