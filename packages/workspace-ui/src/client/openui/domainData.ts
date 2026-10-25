import type { WorkspaceDomainRecordSummary } from "../../shared/api";

export function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

export function safeWebURL(value: unknown): string | undefined {
  try {
    const url = new URL(text(value));
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function monitorHealth(
  metadata: Record<string, unknown>,
  now = Date.now(),
): string {
  if (metadata.status === "triggered") return "alerting";
  if (metadata.status !== "active") return text(metadata.status) || "unknown";
  const checked = Date.parse(text(metadata.last_checked));
  const intervals: Record<string, number> = {
    hourly: 3600000,
    daily: 86400000,
    weekly: 7 * 86400000,
    monthly: 31 * 86400000,
  };
  const interval = intervals[text(metadata.check_frequency)];
  if (!Number.isFinite(checked) || checked > now || !interval) return "unknown";
  return now - checked > interval ? "stale" : "healthy";
}

export function contactRecency(value: unknown, now = Date.now()): string {
  const timestamp = Date.parse(text(value));
  if (!Number.isFinite(timestamp) || timestamp > now)
    return "Last contact unknown";
  const days = Math.floor((now - timestamp) / 86400000);
  return `${days} ${days === 1 ? "day" : "days"} since last contact`;
}

export function tripAlerts(metadata: Record<string, unknown>): string[] {
  const alerts = Array.isArray(metadata.alerts)
    ? metadata.alerts.filter((item): item is string => typeof item === "string")
    : [];
  if (!metadata.start_date || !metadata.end_date)
    alerts.push("Dates incomplete");
  else if (text(metadata.end_date) < text(metadata.start_date))
    alerts.push("Check date range");
  return alerts;
}

export function purchaseTotals(records: WorkspaceDomainRecordSummary[]) {
  const totals = new Map<
    string,
    {
      budget: number;
      spent: number;
      count: number;
      budgetCount: number;
      spentCount: number;
    }
  >();
  for (const { frontmatter: fm } of records) {
    const currency = text(fm.currency);
    if (!currency) continue;
    const budget = typeof fm.budget === "number" ? fm.budget : undefined;
    const spent =
      fm.status === "purchased" && typeof fm.actual_price === "number"
        ? fm.actual_price
        : undefined;
    if (budget === undefined && spent === undefined) continue;
    const total = totals.get(currency) ?? {
      budget: 0,
      spent: 0,
      count: 0,
      budgetCount: 0,
      spentCount: 0,
    };
    total.budget += budget ?? 0;
    total.spent += spent ?? 0;
    if (budget !== undefined) total.budgetCount++;
    if (spent !== undefined) total.spentCount++;
    total.count++;
    totals.set(currency, total);
  }
  return totals;
}
