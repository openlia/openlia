import { z } from "zod";

export const chartColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);

export const chartSeriesSchema = z.object({
  category: z.string().min(1),
  values: z.array(z.number()),
});
export type ChartSeries = z.infer<typeof chartSeriesSchema>;

export const pieSliceSchema = z.object({
  label: z.string().min(1),
  value: z.number().finite().nonnegative(),
});
export type PieSlice = z.infer<typeof pieSliceSchema>;

export const sankeyNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  colorKey: z.string().min(1).optional(),
  color: chartColorSchema.optional(),
});
export const sankeyLinkSchema = z.object({
  source: z.string(),
  target: z.string(),
  value: z.number().finite().nonnegative(),
  exact: z.string().optional(),
});
export const sankeyDataSchema = z.object({
  nodes: z.array(sankeyNodeSchema).max(200),
  links: z.array(sankeyLinkSchema).max(400),
});
export type SankeyData = z.infer<typeof sankeyDataSchema>;

const chartSourceProp = z
  .string()
  .optional()
  .describe(
    "Workspace-relative or document-relative .json file path containing chart data. Cannot be combined with inline data arrays.",
  );

const chartColorsProp = z
  .array(chartColorSchema)
  .optional()
  .describe(
    "Optional hex colors (#RRGGBB) in series/slice order; missing entries use deterministic identity colors.",
  );

const chartColorDomainProp = z
  .array(z.string())
  .optional()
  .describe(
    "Complete stable series/category domain for consistent palette assignments.",
  );

function createSankeyPropsSchema() {
  return z.object({
    nodes: z.array(sankeyNodeSchema).optional(),
    links: z.array(sankeyLinkSchema).optional(),
    source: chartSourceProp,
    title: z.string().optional(),
    unit: z.string().optional(),
    caption: z.string().optional(),
    height: z.number().min(180).max(1000).optional(),
  });
}

export const chartOpenUIProps = {
  ChartBar: z.object({
    labels: z.array(z.string()).optional(),
    series: z.array(chartSeriesSchema).optional(),
    values: z.array(z.number()).optional(),
    source: chartSourceProp,
    title: z.string().optional(),
    unit: z.string().optional(),
    caption: z.string().optional(),
    variant: z.enum(["grouped", "stacked"]).optional(),
    colors: chartColorsProp,
    colorDomain: chartColorDomainProp,
    exactRows: z.array(z.array(z.string())).optional(),
  }),
  ChartLine: z.object({
    labels: z.array(z.string()).optional(),
    series: z.array(chartSeriesSchema).optional(),
    values: z.array(z.number()).optional(),
    source: chartSourceProp,
    title: z.string().optional(),
    unit: z.string().optional(),
    caption: z.string().optional(),
    variant: z.enum(["linear", "natural", "step"]).optional(),
    colors: chartColorsProp,
    colorDomain: chartColorDomainProp,
    exactRows: z.array(z.array(z.string())).optional(),
  }),
  ChartPie: z.object({
    labels: z.array(z.string()).optional(),
    values: z.array(z.number()).optional(),
    slices: z.array(pieSliceSchema).optional(),
    source: chartSourceProp,
    title: z.string().optional(),
    unit: z.string().optional(),
    caption: z.string().optional(),
    variant: z.enum(["pie", "donut"]).optional(),
    colors: chartColorsProp,
    colorDomain: chartColorDomainProp,
    exactRows: z.array(z.array(z.string())).optional(),
  }),
  ChartSankey: createSankeyPropsSchema(),
  SankeyDiagram: createSankeyPropsSchema(),
  ChartPanel: z.object({
    kind: z.enum(["bar", "line", "pie"]),
    labels: z.array(z.string()).optional(),
    series: z.array(chartSeriesSchema).optional(),
    values: z.array(z.number()).optional(),
    slices: z.array(pieSliceSchema).optional(),
    source: chartSourceProp,
    title: z.string().optional(),
    unit: z.string().optional(),
    caption: z.string().optional(),
    variant: z
      .enum(["grouped", "stacked", "linear", "natural", "step", "pie", "donut"])
      .optional(),
    exactRows: z.array(z.array(z.string())).optional(),
    error: z.string().optional(),
    colors: chartColorsProp,
    colorDomain: chartColorDomainProp,
  }),
};

export function isValidChartSourcePath(source: string): boolean {
  const trimmed = source.trim();
  return Boolean(trimmed && trimmed.length <= 500 && /\.json$/i.test(trimmed));
}

export function validateChartComponentProps(
  typeName: keyof typeof chartOpenUIProps,
  rawProps: unknown,
): string[] {
  if (!rawProps || typeof rawProps !== "object" || Array.isArray(rawProps)) {
    return ["Chart props must be an object."];
  }
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawProps as Record<string, unknown>)) {
    props[k] = v === null ? undefined : v;
  }

  const errors: string[] = [];
  const source = typeof props.source === "string" ? props.source : undefined;

  if (source !== undefined && !isValidChartSourcePath(source)) {
    errors.push("Chart source must be a .json file path.");
  }

  if (typeName === "ChartSankey" || typeName === "SankeyDiagram") {
    const hasInline = props.nodes !== undefined || props.links !== undefined;
    if (source !== undefined && hasInline) {
      errors.push(
        `${typeName} accepts either source or inline nodes/links, not both.`,
      );
    } else if (source === undefined) {
      if (!Array.isArray(props.nodes) || !Array.isArray(props.links)) {
        errors.push(
          `${typeName} requires either source or both nodes and links arrays.`,
        );
      }
    }
    return errors;
  }

  const kind =
    typeName === "ChartBar"
      ? "bar"
      : typeName === "ChartLine"
        ? "line"
        : typeName === "ChartPie"
          ? "pie"
          : (props.kind as "bar" | "line" | "pie" | undefined);

  const hasInline =
    props.labels !== undefined ||
    props.series !== undefined ||
    props.values !== undefined ||
    props.slices !== undefined;

  if (source !== undefined && hasInline) {
    errors.push(
      `${typeName} accepts either source or inline chart data, not both.`,
    );
    return errors;
  }

  if (source === undefined) {
    if (kind === "pie") {
      const hasSlices = Array.isArray(props.slices) && props.slices.length > 0;
      const hasLabelsValues =
        Array.isArray(props.labels) && Array.isArray(props.values);
      if (!hasSlices && !hasLabelsValues) {
        errors.push(
          `${typeName} requires either source, slices, or both labels and values arrays.`,
        );
      } else if (
        hasLabelsValues &&
        (props.labels as unknown[]).length !==
          (props.values as unknown[]).length
      ) {
        errors.push(
          `${typeName} labels and values arrays must have the same length.`,
        );
      }
    } else {
      const hasLabels = Array.isArray(props.labels);
      const hasSeries = Array.isArray(props.series);
      const hasValues = Array.isArray(props.values);
      if (!hasLabels || (!hasSeries && !hasValues)) {
        errors.push(
          `${typeName} requires either source or labels with series (or values).`,
        );
      } else {
        const labelsLen = (props.labels as unknown[]).length;
        if (hasValues && (props.values as unknown[]).length !== labelsLen) {
          errors.push(`${typeName} values length must match labels length.`);
        }
        if (hasSeries) {
          for (const item of props.series as Array<{
            category?: string;
            values?: unknown[];
          }>) {
            if (
              Array.isArray(item?.values) &&
              item.values.length !== labelsLen
            ) {
              errors.push(
                `${typeName} series '${item.category ?? ""}' values length must match labels length.`,
              );
            }
          }
        }
      }
    }
  }

  return errors;
}

export interface NormalizedChartData {
  labels: string[];
  series: ChartSeries[];
  values: number[];
  title?: string | undefined;
  unit?: string | undefined;
  caption?: string | undefined;
  variant?: string | undefined;
  colors?: string[] | undefined;
  colorDomain?: string[] | undefined;
  exactRows?: string[][] | undefined;
}

export function parseExternalChartJson(
  kind: "bar" | "line" | "pie",
  rawJson: string,
): NormalizedChartData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("Chart JSON file is not valid JSON.");
  }

  if (Array.isArray(parsed)) {
    if (kind === "pie") {
      const slicesChecked = z.array(pieSliceSchema).min(1).safeParse(parsed);
      if (!slicesChecked.success) {
        throw new Error(
          "Pie chart JSON array must contain { label: string, value: number } objects.",
        );
      }
      return {
        labels: slicesChecked.data.map((s) => s.label),
        values: slicesChecked.data.map((s) => s.value),
        series: [],
      };
    }

    // Tabular row array for bar / line charts: e.g. [{ month: "Jan", Income: 100, Expenses: 80 }]
    if (
      parsed.length === 0 ||
      typeof parsed[0] !== "object" ||
      parsed[0] === null ||
      Array.isArray(parsed[0])
    ) {
      throw new Error("Chart JSON array must contain row objects.");
    }
    const firstRow = parsed[0] as Record<string, unknown>;
    const keys = Object.keys(firstRow);
    const labelKey =
      keys.find((k) => typeof firstRow[k] === "string") ?? keys[0];
    if (!labelKey) {
      throw new Error("Chart JSON row objects require a label field.");
    }
    const seriesKeys = keys.filter(
      (k) => k !== labelKey && typeof firstRow[k] === "number",
    );
    if (seriesKeys.length === 0) {
      throw new Error(
        "Chart JSON row objects require at least one numeric series field.",
      );
    }
    const labels = parsed.map((row) =>
      String((row as Record<string, unknown>)[labelKey] ?? ""),
    );
    const series: ChartSeries[] = seriesKeys.map((category) => ({
      category,
      values: parsed.map((row) => {
        const val = Number((row as Record<string, unknown>)[category]);
        if (!Number.isFinite(val)) {
          throw new Error(
            `Non-numeric value for series '${category}' in chart JSON.`,
          );
        }
        return val;
      }),
    }));
    return { labels, series, values: [] };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Chart JSON must be an object or array.");
  }

  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title : undefined;
  const unit = typeof obj.unit === "string" ? obj.unit : undefined;
  const caption = typeof obj.caption === "string" ? obj.caption : undefined;
  const variant = typeof obj.variant === "string" ? obj.variant : undefined;
  const colors = Array.isArray(obj.colors)
    ? (obj.colors as string[])
    : undefined;
  const colorDomain = Array.isArray(obj.colorDomain)
    ? (obj.colorDomain as string[])
    : undefined;
  const exactRows = Array.isArray(obj.exactRows)
    ? (obj.exactRows as string[][])
    : undefined;

  if (kind === "pie") {
    if (Array.isArray(obj.slices)) {
      const slicesChecked = z.array(pieSliceSchema).safeParse(obj.slices);
      if (!slicesChecked.success) {
        throw new Error("Invalid slices array in pie chart JSON.");
      }
      return {
        labels: slicesChecked.data.map((s) => s.label),
        values: slicesChecked.data.map((s) => s.value),
        series: [],
        title,
        unit,
        caption,
        variant,
        colors,
        colorDomain,
        exactRows,
      };
    }
    const labelsChecked = z.array(z.string()).safeParse(obj.labels);
    const valuesChecked = z
      .array(z.number().finite().nonnegative())
      .safeParse(obj.values);
    if (
      !labelsChecked.success ||
      !valuesChecked.success ||
      labelsChecked.data.length !== valuesChecked.data.length
    ) {
      throw new Error(
        "Pie chart JSON requires matching 'labels' and non-negative 'values' arrays (or 'slices').",
      );
    }
    return {
      labels: labelsChecked.data,
      values: valuesChecked.data,
      series: [],
      title,
      unit,
      caption,
      variant,
      colors,
      colorDomain,
      exactRows,
    };
  }

  const labelsChecked = z.array(z.string()).safeParse(obj.labels);
  if (!labelsChecked.success) {
    throw new Error("Chart JSON object requires a 'labels' string array.");
  }
  const labels = labelsChecked.data;

  if (Array.isArray(obj.series)) {
    const seriesChecked = z.array(chartSeriesSchema).safeParse(obj.series);
    if (
      !seriesChecked.success ||
      seriesChecked.data.some((s) => s.values.length !== labels.length)
    ) {
      throw new Error(
        "Chart JSON 'series' entries require category names and values arrays matching 'labels' length.",
      );
    }
    return {
      labels,
      series: seriesChecked.data,
      values: [],
      title,
      unit,
      caption,
      variant,
      colors,
      colorDomain,
      exactRows,
    };
  }

  if (Array.isArray(obj.values)) {
    const valuesChecked = z.array(z.number().finite()).safeParse(obj.values);
    if (!valuesChecked.success || valuesChecked.data.length !== labels.length) {
      throw new Error(
        "Chart JSON 'values' array must contain numbers matching 'labels' length.",
      );
    }
    return {
      labels,
      series: [
        {
          category: title || unit || "Value",
          values: valuesChecked.data,
        },
      ],
      values: valuesChecked.data,
      title,
      unit,
      caption,
      variant,
      colors,
      colorDomain,
      exactRows,
    };
  }

  throw new Error(
    "Chart JSON object requires 'labels' and either 'series' or 'values'.",
  );
}

export interface NormalizedSankeyData {
  nodes: SankeyData["nodes"];
  links: SankeyData["links"];
  title?: string | undefined;
  unit?: string | undefined;
  caption?: string | undefined;
  height?: number | undefined;
}

export function parseExternalSankeyJson(rawJson: string): NormalizedSankeyData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("Sankey JSON file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Sankey JSON must be an object with 'nodes' and 'links'.");
  }
  const obj = parsed as Record<string, unknown>;
  const checked = sankeyDataSchema.safeParse({
    nodes: obj.nodes,
    links: obj.links,
  });
  if (!checked.success) {
    throw new Error(
      "Sankey JSON requires valid 'nodes' and non-negative 'links' arrays.",
    );
  }
  return {
    nodes: checked.data.nodes,
    links: checked.data.links,
    title: typeof obj.title === "string" ? obj.title : undefined,
    unit: typeof obj.unit === "string" ? obj.unit : undefined,
    caption: typeof obj.caption === "string" ? obj.caption : undefined,
    height: typeof obj.height === "number" ? obj.height : undefined,
  };
}
