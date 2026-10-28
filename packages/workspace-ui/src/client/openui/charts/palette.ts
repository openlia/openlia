import type { Theme } from "@openuidev/react-ui";

export const CHART_COLORS = {
  income: "#34D399",
  expenses: "#FB923C",
  balance: "#A78BFA",
  sky: "#38BDF8",
  amber: "#FBBF24",
  pink: "#F472B6",
  neutral: "#94A3B8",
};

export const CATEGORICAL_COLORS = [
  CHART_COLORS.income,
  CHART_COLORS.expenses,
  CHART_COLORS.balance,
  CHART_COLORS.sky,
  CHART_COLORS.amber,
  CHART_COLORS.pink,
];

// Upstream samples around a ramp's midpoint: a single raw series is violet,
// two are emerald/orange. Only categorical chart tokens change, not branding
// or sequential heatmap/area ramps.
const defaultPalette = [
  CHART_COLORS.sky,
  CHART_COLORS.amber,
  CHART_COLORS.income,
  CHART_COLORS.balance,
  CHART_COLORS.expenses,
  CHART_COLORS.pink,
];
export const CHART_THEME = {
  barChartPalette: defaultPalette,
  lineChartPalette: defaultPalette,
  pieChartPalette: defaultPalette,
  horizontalBarChartPalette: defaultPalette,
} satisfies Theme;

/** Supply a complete, fixed domain for collision-free first-six categories across filters. */
export function colorForKey(key: string, domain?: string[]): string {
  const position = domain?.indexOf(key) ?? -1;
  if (position >= 0)
    return CATEGORICAL_COLORS[position % CATEGORICAL_COLORS.length] as string;
  // Deterministic identity fallback, independent of order, visible subset, or process state.
  let hash = 2166136261;
  for (const character of key)
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
  return CATEGORICAL_COLORS[(hash >>> 0) % CATEGORICAL_COLORS.length] as string;
}

/** Adapt ordered colors to OpenUI's midpoint-distributed palette without modifying upstream. */
export function openUIPalette(colors: string[]): string[] {
  if (colors.length > 2 && colors.length % 2 === 0)
    return [colors[colors.length - 1] as string, ...colors.slice(0, -1)];
  return [...colors];
}

/** Pie colors must follow upstream's descending-value slice order, not input order. */
export function chartColorsFor(
  keys: string[],
  overrides: string[] | undefined,
  domain: string[] | undefined,
  sortValues?: number[],
): string[] {
  const entries = keys.map((key, index) => ({
    key,
    color: overrides?.[index] ?? colorForKey(key, domain),
    value: sortValues?.[index] || 0,
  }));
  // Cartesian data keys follow JS property enumeration (including numeric series names).
  const ordered = sortValues
    ? entries.sort((a, b) => b.value - a.value)
    : Object.values(
        Object.fromEntries(entries.map((entry) => [entry.key, entry])),
      );
  return ordered.map((entry) => entry.color);
}
