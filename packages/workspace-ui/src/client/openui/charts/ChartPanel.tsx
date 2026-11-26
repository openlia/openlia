import { defineComponent, Renderer } from "@openuidev/react-lang";
import { openuiLibrary, ThemeProvider, useTheme } from "@openuidev/react-ui";
import { useEffect, useId, useState } from "react";
import {
  type ChartSeries,
  chartColorSchema,
  chartOpenUIProps,
  type NormalizedChartData,
  type PieSlice,
  parseExternalChartJson,
} from "../../../shared/charts";
import { httpWorkspaceApi } from "../../api";
import { resolveOpenUISourcePath, useOpenLiaOpenUI } from "../context";
import { chartColorsFor, openUIPalette } from "./palette";

export interface ChartPanelViewProps {
  kind: "bar" | "line" | "pie";
  labels: string[];
  series?: ChartSeries[] | undefined;
  values?: number[] | undefined;
  title?: string | undefined;
  unit?: string | undefined;
  caption?: string | undefined;
  variant?: string | undefined;
  exactRows?: string[][] | undefined;
  error?: string | undefined;
  loading?: boolean | undefined;
  sourcePath?: string | undefined;
  onOpenSource?: (() => void) | undefined;
  colors?: string[] | undefined;
  colorDomain?: string[] | undefined;
}

export function ChartPanelView({
  kind,
  labels,
  series = [],
  values = [],
  title = "Chart",
  unit = "",
  caption,
  variant,
  exactRows,
  error,
  loading = false,
  sourcePath,
  onOpenSource,
  colors,
  colorDomain,
}: ChartPanelViewProps) {
  const id = useId();
  const { theme, mode } = useTheme();
  const paletteId = `chart-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const effectiveSeries: ChartSeries[] =
    kind !== "pie" && series.length === 0 && values.length > 0
      ? [{ category: title || unit || "Value", values }]
      : series;
  const keys =
    kind === "pie" ? labels : effectiveSeries.map((item) => item.category);
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
        : effectiveSeries.map((item) => String(item.values[index]))),
    ]);
  const headers = [
    "Category / period",
    ...(kind === "pie"
      ? [unit || "Value"]
      : effectiveSeries.map(
          (item) => `${item.category}${unit ? ` (${unit})` : ""}`,
        )),
  ];
  const tableRows = rows.map((cells, row) => ({
    id: `${cells[0]}:${row}`,
    cells: cells.map((value, column) => ({
      id: `${headers[column]}:${column}`,
      value,
    })),
  }));
  const numbers =
    kind === "pie" ? values : effectiveSeries.flatMap((item) => item.values);
  const invalid =
    numbers.some((value) => !Number.isFinite(value)) ||
    (kind === "pie"
      ? values.length !== labels.length || values.some((value) => value < 0)
      : effectiveSeries.length === 0 ||
        effectiveSeries.some((item) => item.values.length !== labels.length));
  const empty = !labels.length || !numbers.some((value) => value !== 0);
  const pieVariant = variant === "pie" ? "pie" : "donut";
  const barVariant = variant === "stacked" ? "stacked" : "grouped";
  const lineVariant =
    variant === "natural" || variant === "step" ? variant : "linear";
  const program =
    kind === "pie"
      ? `root = PieChart(${JSON.stringify(labels)}, ${JSON.stringify(values)}, ${JSON.stringify(pieVariant)})`
      : `root = ${kind === "bar" ? "BarChart" : "LineChart"}(${JSON.stringify(labels)}, [${effectiveSeries.map((item) => `Series(${JSON.stringify(item.category)}, ${JSON.stringify(item.values)})`).join(",")}], ${JSON.stringify(kind === "bar" ? barVariant : lineVariant)}, "Period / category", ${JSON.stringify(unit)}, 280)`;

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
        aria-busy={loading}
        className="rounded-xl border border-base-content/10 p-4 space-y-3 min-w-0"
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id={id} className="font-semibold">
              {title}
              {unit ? ` · ${unit}` : ""}
            </h3>
            {sourcePath && (
              <p className="text-xs opacity-60">Source: {sourcePath}</p>
            )}
          </div>
          {onOpenSource && (
            <button
              type="button"
              className="btn btn-xs btn-outline"
              onClick={onOpenSource}
            >
              Open JSON source
            </button>
          )}
        </header>
        {caption && <p className="text-xs opacity-70">{caption}</p>}
        {loading ? (
          <p role="status" className="text-sm">
            Loading chart data…
          </p>
        ) : error ? (
          <p role="alert" className="text-error text-sm">
            {error}
          </p>
        ) : invalidColor ? (
          <p role="alert" className="text-error text-sm">
            Chart colors must be opaque hexadecimal colors.
          </p>
        ) : invalid ? (
          <p role="alert" className="text-error text-sm">
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
        {!loading && !error && !invalid && labels.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm">
              Exact data table
            </summary>
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
        )}
      </section>
    </ThemeProvider>
  );
}

export function ChartPanelContainer({
  kind,
  labels,
  series,
  values,
  slices,
  source,
  title,
  unit,
  caption,
  variant,
  exactRows,
  error: propError,
  colors,
  colorDomain,
}: {
  kind: "bar" | "line" | "pie";
  labels?: string[] | null | undefined;
  series?: ChartSeries[] | null | undefined;
  values?: number[] | null | undefined;
  slices?: PieSlice[] | null | undefined;
  source?: string | null | undefined;
  title?: string | null | undefined;
  unit?: string | null | undefined;
  caption?: string | null | undefined;
  variant?: string | null | undefined;
  exactRows?: string[][] | null | undefined;
  error?: string | null | undefined;
  colors?: string[] | null | undefined;
  colorDomain?: string[] | null | undefined;
}) {
  const {
    api = httpWorkspaceApi,
    filePath,
    scope = "workspace",
    onNavigateLink,
  } = useOpenLiaOpenUI();
  const [externalData, setExternalData] = useState<NormalizedChartData | null>(
    null,
  );
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(Boolean(source));

  const resolvedSource = source
    ? resolveOpenUISourcePath(source, filePath, scope)
    : null;
  const resolvedSourcePath = resolvedSource?.path;
  const resolvedSourceScope = resolvedSource?.scope;

  useEffect(() => {
    if (!resolvedSourcePath || !resolvedSourceScope) {
      setExternalData(null);
      setLoadError("");
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError("");
    api
      .loadFile(resolvedSourcePath, resolvedSourceScope)
      .then((file) => {
        if (!active) return;
        const parsed = parseExternalChartJson(kind, file.content);
        setExternalData(parsed);
      })
      .catch((caught) => {
        if (!active) return;
        setExternalData(null);
        setLoadError(
          caught instanceof Error
            ? caught.message
            : "Failed to load chart JSON file.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, kind, resolvedSourcePath, resolvedSourceScope]);

  if (resolvedSource) {
    return (
      <ChartPanelView
        kind={kind}
        labels={externalData?.labels ?? []}
        series={externalData?.series ?? []}
        values={externalData?.values ?? []}
        title={title ?? externalData?.title ?? "Chart"}
        unit={unit ?? externalData?.unit ?? ""}
        caption={caption ?? externalData?.caption}
        variant={variant ?? externalData?.variant}
        exactRows={exactRows ?? externalData?.exactRows}
        colors={colors ?? externalData?.colors}
        colorDomain={colorDomain ?? externalData?.colorDomain}
        error={propError ?? (loadError || undefined)}
        loading={loading}
        sourcePath={resolvedSource.path}
        onOpenSource={
          onNavigateLink ? () => onNavigateLink(resolvedSource.path) : undefined
        }
      />
    );
  }

  const inlineLabels =
    kind === "pie" && !labels && slices
      ? slices.map((s) => s.label)
      : (labels ?? []);
  const inlineValues =
    kind === "pie" && !values && slices
      ? slices.map((s) => s.value)
      : (values ?? []);

  return (
    <ChartPanelView
      kind={kind}
      labels={inlineLabels}
      series={series ?? []}
      values={inlineValues}
      title={title ?? "Chart"}
      unit={unit ?? ""}
      caption={caption ?? undefined}
      variant={variant ?? undefined}
      exactRows={exactRows ?? undefined}
      error={propError ?? undefined}
      colors={colors ?? undefined}
      colorDomain={colorDomain ?? undefined}
    />
  );
}

export const ChartBar = defineComponent({
  name: "ChartBar",
  description:
    "Accessible bar chart panel (grouped or stacked) with units, deterministic colors, and an exact data table. Supports inline labels+series/values or source: '*.json'.",
  props: chartOpenUIProps.ChartBar,
  component: ({ props }) => <ChartPanelContainer kind="bar" {...props} />,
});

export const ChartLine = defineComponent({
  name: "ChartLine",
  description:
    "Accessible line chart panel with units, deterministic colors, and an exact data table. Supports inline labels+series/values or source: '*.json'.",
  props: chartOpenUIProps.ChartLine,
  component: ({ props }) => <ChartPanelContainer kind="line" {...props} />,
});

export const ChartPie = defineComponent({
  name: "ChartPie",
  description:
    "Accessible pie or donut chart panel with units and an exact data table. Supports inline labels+values, slices, or source: '*.json'.",
  props: chartOpenUIProps.ChartPie,
  component: ({ props }) => <ChartPanelContainer kind="pie" {...props} />,
});

export const ChartPanel = defineComponent({
  name: "ChartPanel",
  description:
    "Accessible panel around BarChart, LineChart, or PieChart, with units, exact data table, and inline or external .json source support.",
  props: chartOpenUIProps.ChartPanel,
  component: ({ props }) => <ChartPanelContainer {...props} />,
});
