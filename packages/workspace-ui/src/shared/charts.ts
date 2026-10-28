import { z } from "zod";
export const chartColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);

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
export const chartOpenUIProps = {
  SankeyDiagram: z.object({
    nodes: z.array(sankeyNodeSchema),
    links: z.array(sankeyLinkSchema),
    title: z.string().optional(),
    unit: z.string().optional(),
    caption: z.string().optional(),
    height: z.number().min(180).max(1000).optional(),
  }),
  ChartPanel: z.object({
    kind: z.enum(["bar", "line", "pie"]),
    labels: z.array(z.string()),
    series: z
      .array(z.object({ category: z.string(), values: z.array(z.number()) }))
      .optional(),
    values: z.array(z.number()).optional(),
    title: z.string().optional(),
    unit: z.string().optional(),
    caption: z.string().optional(),
    exactRows: z.array(z.array(z.string())).optional(),
    error: z.string().optional(),
    colors: z
      .array(chartColorSchema)
      .optional()
      .describe(
        "Optional colors in series/slice order; missing entries use identity colors",
      ),
    colorDomain: z
      .array(z.string())
      .optional()
      .describe(
        "Complete stable series/category domain, including hidden categories, for consistent palette assignments",
      ),
  }),
};

/** Fixed-point arithmetic for report totals; chart coordinates alone use Number. */
export function decimal(value: string): { coefficient: bigint; scale: number } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || value.length > 256 || (match[3]?.length ?? 0) > 36)
    throw new Error("Unsupported decimal precision");
  return {
    coefficient: BigInt(`${match[1]}${match[2]}${match[3] ?? ""}`),
    scale: match[3]?.length ?? 0,
  };
}
export function decimalString(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, "0");
  if (scale)
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(
      /\.?0+$/,
      "",
    );
  return `${negative && coefficient !== 0n ? "-" : ""}${digits}`;
}
export function addDecimal(a: string, b: string): string {
  const x = decimal(a);
  const y = decimal(b);
  const scale = Math.max(x.scale, y.scale);
  return decimalString(
    x.coefficient * 10n ** BigInt(scale - x.scale) +
      y.coefficient * 10n ** BigInt(scale - y.scale),
    scale,
  );
}
export function negateDecimal(value: string): string {
  const d = decimal(value);
  return decimalString(-d.coefficient, d.scale);
}
export function chartNumber(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER)
    throw new Error(
      "Values exceed the safe chart coordinate range; use the exact table.",
    );
  return number;
}
export function amountFor(
  values: Record<string, string> | undefined,
  commodity: string,
): string {
  return values && Object.hasOwn(values, commodity)
    ? (values[commodity] ?? "0")
    : "0";
}
