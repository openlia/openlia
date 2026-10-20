import { useCallback, useEffect, useRef, useState } from "react";
import type {
  UsagePrice,
  UsageRates,
  UsageResponse,
  UsageRow,
} from "../shared/usage";
import type { WorkspaceApi } from "./api";

const activities = ["hermes", "ingestion", "migration"] as const;
const labels = {
  hermes: "Hermes",
  ingestion: "Ingestion",
  migration: "Migration",
};
const rateKeys = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;
const rateLabels = ["Input", "Output", "Cache read", "Cache write"];
const count = (n: number) =>
  Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
export function usageCost(n: number | null): string {
  if (n === null) return "Unavailable";
  if (n === 0) return "$0.00";
  if (n < 0.0001) return "<$0.0001";
  return `~$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}
function tokenTotal(row: UsageRow) {
  return (
    row.input_tokens +
    row.output_tokens +
    row.cache_read_tokens +
    row.cache_write_tokens
  );
}
function total(rows: UsageRow[]) {
  return {
    usage_available: rows.some((r) => r.usage_available),
    tokens: rows.reduce((n, r) => n + tokenTotal(r), 0),
    cost: rows.some((r) => r.cost !== null)
      ? rows.reduce((n, r) => n + (r.cost ?? 0), 0)
      : null,
  };
}

function tokensLabel(rows: UsageRow[]): string {
  const summary = total(rows);
  return rows.length && !summary.usage_available
    ? "Unknown tokens"
    : `${count(summary.tokens)} tokens`;
}

function useUsage(api: WorkspaceApi, reference?: string) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await api.loadUsage(reference);
      if (current !== generation.current) return;
      setData(result);
      setError("");
    } catch {
      if (current !== generation.current) return;
      setError(
        "Usage could not be refreshed. Previously loaded data is shown, if available.",
      );
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [api, reference]);
  useEffect(() => {
    setData(null);
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60000);
    return () => {
      ++generation.current;
      clearInterval(timer);
    };
  }, [refresh]);
  return { data, error, loading, refresh };
}

function initialFilters() {
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
  return {
    period: params.get("period") ?? "month",
    activity: params.get("activity") ?? "all",
    model: params.get("model") ?? "all",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    reference: params.get("reference") ?? "",
  };
}

export function UsagePage({ api }: { api: WorkspaceApi }) {
  const [filters, setFilters] = useState(initialFilters);
  const { data, error, loading, refresh } = useUsage(
    api,
    filters.reference || undefined,
  );
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  useEffect(() => {
    const onPop = () => setFilters(initialFilters());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  function filter(key: keyof typeof filters, value: string) {
    // Read the current URL so rapid consecutive changes cannot overwrite a
    // previous filter while React/TanStack are still processing navigation.
    const next = { ...initialFilters(), [key]: value };
    setFilters(next);
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(next)) {
      if (v && (v !== "all" || k === "period")) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    window.history.replaceState(window.history.state, "", url);
  }
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const start =
    filters.period === "today"
      ? today
      : filters.period === "month"
        ? `${today.slice(0, 7)}-01`
        : filters.period === "7" || filters.period === "30"
          ? new Date(now.getTime() - (Number(filters.period) - 1) * 86400000)
              .toISOString()
              .slice(0, 10)
          : filters.period === "custom"
            ? filters.from
            : "";
  const end = filters.period === "custom" ? filters.to : today;
  const base = (data?.rows ?? []).filter(
    (r) =>
      (filters.activity === "all" || r.activity === filters.activity) &&
      (filters.model === "all" ||
        JSON.stringify([r.provider, r.model]) === filters.model),
  );
  const rows = base.filter((r) =>
    r.historical
      ? filters.period === "all"
      : (!start || r.day >= start) && (!end || r.day <= end),
  );
  const stats = total(rows);
  const models = [
    ...new Set(rows.map((r) => JSON.stringify([r.provider, r.model]))),
  ]
    .map((key) => ({
      key,
      rows: rows.filter((r) => JSON.stringify([r.provider, r.model]) === key),
    }))
    .sort((a, b) => (total(b.rows).cost ?? -1) - (total(a.rows).cost ?? -1));
  const unpriced = new Set(
    rows
      .filter((r) => r.cost === null || r.partial_cost)
      .map((r) => `${r.provider}/${r.model}`),
  ).size;
  const days = [
    ...new Set(
      rows
        .filter(
          (r) =>
            !r.historical &&
            (metric === "tokens" ? r.usage_available : r.cost !== null),
        )
        .map((r) => r.day),
    ),
  ]
    .sort()
    .slice(-90);
  const values = days.map((day) =>
    activities.map((activity) => {
      const rs = rows.filter(
        (r) => r.day === day && !r.historical && r.activity === activity,
      );
      return metric === "cost" ? (total(rs).cost ?? 0) : total(rs).tokens;
    }),
  );
  const max = Math.max(
    0.000001,
    ...values.map((v) => v.reduce((a, b) => a + b, 0)),
  );
  const colors = ["fill-primary", "fill-secondary", "fill-accent"];
  return (
    <div className="min-h-0 overflow-auto bg-base-100">
      <div className="mx-auto grid w-full max-w-6xl gap-6 p-5 sm:p-8">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-base-content/10 pb-5">
          <div>
            <p className="workspace-eyebrow">OPENLIA / USAGE</p>
            <h2 className="mt-2 text-3xl font-bold">LLM usage</h2>
            <p className="mt-2 text-sm text-base-content/60">
              A lightweight view of models, tokens, and estimated spend.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-base-content/60">
            <span>
              {data?.updated_at
                ? `Updated ${new Date(data.updated_at * 1000).toLocaleString()}`
                : "Not yet updated"}
            </span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => void refresh()}
              disabled={loading}
              type="button"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>
        {filters.reference && (
          <p className="text-sm text-base-content/60">
            Showing usage for {filters.reference}.{" "}
            <button
              type="button"
              className="link"
              onClick={() => filter("reference", "")}
            >
              Show all usage
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="alert alert-warning">
            {error}
          </p>
        )}
        {data?.warning && <p className="alert alert-warning">{data.warning}</p>}
        {data?.updated_at && Date.now() / 1000 - data.updated_at > 180 && (
          <p className="alert alert-warning">
            Collection is delayed. Last available statistics are shown.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            Period
            <select
              className="select select-bordered"
              value={filters.period}
              onChange={(e) => filter("period", e.target.value)}
            >
              <option value="month">This month</option>
              <option value="today">Today</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="all">All time</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {filters.period === "custom" && (
            <>
              <label className="grid gap-1 text-sm">
                From (UTC)
                <input
                  className="input input-bordered"
                  type="date"
                  value={filters.from}
                  onChange={(e) => filter("from", e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                To (UTC)
                <input
                  className="input input-bordered"
                  type="date"
                  min={filters.from}
                  value={filters.to}
                  onChange={(e) => filter("to", e.target.value)}
                />
              </label>
            </>
          )}
          <label className="grid gap-1 text-sm">
            Activity
            <select
              className="select select-bordered"
              value={filters.activity}
              onChange={(e) => filter("activity", e.target.value)}
            >
              <option value="all">All activities</option>
              {activities.map((a) => (
                <option key={a} value={a}>
                  {labels[a]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-1 text-sm">
            Model
            <select
              className="select select-bordered max-w-xs"
              value={filters.model}
              onChange={(e) => filter("model", e.target.value)}
            >
              <option value="all">All models</option>
              {data?.prices.map((p) => (
                <option
                  key={JSON.stringify([p.provider, p.model])}
                  value={JSON.stringify([p.provider, p.model])}
                >
                  {p.model} / {p.provider}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!data && loading ? (
          <p role="status">Loading usage…</p>
        ) : data && !data.available ? (
          <section className="rounded-xl border border-base-content/10 p-8">
            <h3 className="font-bold">Usage monitoring is not available yet</h3>
            <p className="mt-2 text-sm text-base-content/60">
              The runtime collector creates statistics automatically. Check that
              the runtime image and Workspace UI mounts have been updated.
            </p>
          </section>
        ) : (
          <>
            <section
              className="grid gap-4 sm:grid-cols-2"
              aria-label="Usage summary"
            >
              <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-5">
                <p className="text-sm text-base-content/60">Estimated cost</p>
                <p className="my-2 text-4xl font-bold">
                  {rows.length ? usageCost(stats.cost) : "—"}
                </p>
                {unpriced > 0 && (
                  <p className="text-sm text-warning">
                    Partial estimate · {unpriced} model(s) with incomplete
                    pricing or usage
                  </p>
                )}
                <p className="text-xs text-base-content/60">
                  USD · current pricing, with Hermes estimates as fallback
                </p>
              </div>
              <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-5">
                <p className="text-sm text-base-content/60">Tokens</p>
                <p className="my-2 text-4xl font-bold">
                  {rows.length && !stats.usage_available
                    ? "Unknown"
                    : count(stats.tokens)}
                </p>
                <p className="text-sm text-base-content/60">
                  {stats.usage_available ? (
                    <>
                      Input{" "}
                      {count(
                        rows.reduce(
                          (n, r) =>
                            n +
                            r.input_tokens +
                            r.cache_read_tokens +
                            r.cache_write_tokens,
                          0,
                        ),
                      )}{" "}
                      · Output{" "}
                      {count(rows.reduce((n, r) => n + r.output_tokens, 0))}
                    </>
                  ) : (
                    "Token counts have not been reported."
                  )}
                </p>
                {rows.some((r) => !r.complete) && (
                  <p className="text-sm text-warning">
                    Some usage reports are unavailable.
                  </p>
                )}
              </div>
            </section>
            {!rows.length ? (
              <p className="rounded-xl border border-base-content/10 p-8 text-base-content/60">
                No usage recorded for this period.
              </p>
            ) : (
              <>
                <section className="rounded-xl border border-base-content/10 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-bold">Usage over time</h3>
                    <div className="join">
                      {(["cost", "tokens"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={metric === m}
                          className={`btn btn-sm join-item ${metric === m ? "btn-primary" : "btn-ghost"}`}
                          onClick={() => setMetric(m)}
                        >
                          {m === "cost" ? "Cost" : "Tokens"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {days.length ? (
                    <>
                      <svg
                        className="mt-4 h-48 w-full"
                        viewBox="0 0 900 190"
                        role="img"
                        aria-label={`Daily estimated ${metric}, stacked by activity; dates in UTC`}
                      >
                        {values.map((v, i) => {
                          let y = 170;
                          return (
                            <g key={days[i]}>
                              {v.map((value, j) => {
                                if (value === 0) return null;
                                const height = (value / max) * 150;
                                y -= height;
                                return (
                                  <rect
                                    key={activities[j]}
                                    className={colors[j]}
                                    x={(i * 900) / days.length + 2}
                                    y={y}
                                    width={Math.max(1, 900 / days.length - 4)}
                                    height={height}
                                  >
                                    <title>
                                      {days[i]} ·{" "}
                                      {labels[activities[j] ?? "hermes"]}:{" "}
                                      {metric === "cost"
                                        ? usageCost(value)
                                        : count(value)}
                                    </title>
                                  </rect>
                                );
                              })}
                            </g>
                          );
                        })}
                      </svg>
                      <div className="flex justify-between text-xs text-base-content/50">
                        <span>{days[0]}</span>
                        <span>
                          {days.at(-1)} · UTC
                          {days.length === 90 ? " · latest 90 active days" : ""}
                        </span>
                      </div>
                    </>
                  ) : (
                    <p className="py-6 text-sm text-base-content/60">
                      {rows.some((r) => !r.historical)
                        ? metric === "tokens"
                          ? "Token counts are unknown for this period."
                          : "Cost estimates are unavailable for this period."
                        : "Only historical summaries are available; daily attribution is unknown."}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-4 text-xs text-base-content/60">
                    {activities.map((a, i) => (
                      <span key={a} className="flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className={`inline-block h-2 w-2 rounded-full ${["bg-primary", "bg-secondary", "bg-accent"][i]}`}
                        />
                        {labels[a]}
                      </span>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-base-content/60">
                    Hermes aggregate increases are dated when observed. Missing
                    reports may make bars incomplete.
                  </p>
                </section>
                <section>
                  <h3 className="mb-3 text-lg font-bold">By activity</h3>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {activities.map((a) => {
                      const group = rows.filter((r) => r.activity === a);
                      return (
                        <button
                          key={a}
                          type="button"
                          onClick={() => filter("activity", a)}
                          className="rounded-xl border border-base-content/10 bg-base-200/40 p-4 text-left hover:border-primary/40"
                        >
                          <span className="font-semibold">{labels[a]}</span>
                          <p className="mt-2 text-xl">
                            {group.length ? usageCost(total(group).cost) : "—"}
                          </p>
                          <p className="mt-1 text-xs text-base-content/60">
                            {tokensLabel(group)}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </section>
                <section>
                  <h3 className="mb-3 text-lg font-bold">Models</h3>
                  <div className="grid gap-2">
                    {models.map(({ key, rows: group }) => {
                      const first = group[0];
                      if (!first) return null;
                      const price = data?.prices.find(
                        (p) =>
                          p.provider === first.provider &&
                          p.model === first.model,
                      );
                      return (
                        <details
                          key={key}
                          className="rounded-xl border border-base-content/10 bg-base-200/20 p-4"
                        >
                          <summary className="flex cursor-pointer flex-wrap justify-between gap-3">
                            <span className="min-w-0 break-all font-semibold">
                              {first.model}
                              <span className="ml-2 text-xs font-normal text-base-content/60">
                                {first.provider}
                              </span>
                            </span>
                            <span className="hidden text-xs text-base-content/60 sm:inline">
                              {group.some((r) => r.usage_available) ? (
                                <>
                                  Input{" "}
                                  {count(
                                    group.reduce(
                                      (n, r) =>
                                        n +
                                        r.input_tokens +
                                        r.cache_read_tokens +
                                        r.cache_write_tokens,
                                      0,
                                    ),
                                  )}{" "}
                                  · Output{" "}
                                  {count(
                                    group.reduce(
                                      (n, r) => n + r.output_tokens,
                                      0,
                                    ),
                                  )}{" "}
                                  · Cached{" "}
                                  {count(
                                    group.reduce(
                                      (n, r) => n + r.cache_read_tokens,
                                      0,
                                    ),
                                  )}
                                </>
                              ) : (
                                "Unknown token counts"
                              )}
                            </span>
                            <span>
                              {usageCost(total(group).cost)} ·{" "}
                              {tokensLabel(group)}
                            </span>
                          </summary>
                          <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                            <p className="sm:col-span-2">
                              {activities
                                .map(
                                  (a) =>
                                    `${labels[a]}: ${usageCost(total(group.filter((r) => r.activity === a)).cost)}`,
                                )
                                .join(" · ")}
                            </p>
                            {rateKeys.map((k, i) => (
                              <p key={k}>
                                {rateLabels[i]}:{" "}
                                {group.some((r) => r.usage_available)
                                  ? count(group.reduce((n, r) => n + r[k], 0))
                                  : "Unknown"}{" "}
                                tokens
                              </p>
                            ))}
                            <p>
                              Reasoning:{" "}
                              {group.some((r) => r.usage_available)
                                ? count(
                                    group.reduce(
                                      (n, r) => n + r.reasoning_tokens,
                                      0,
                                    ),
                                  )
                                : "Unknown"}{" "}
                              (included in output)
                            </p>
                            <p>
                              Pricing:{" "}
                              {price?.overridden
                                ? "Custom override"
                                : (price?.source.replaceAll("_", " ") ??
                                  "Unavailable")}
                              {price?.stale ? " · stale" : ""}
                            </p>
                            {group.some(
                              (r) => r.hermes_estimated_cost != null,
                            ) && (
                              <p>
                                Hermes estimate:{" "}
                                {usageCost(
                                  group.reduce(
                                    (n, r) =>
                                      n + (r.hermes_estimated_cost ?? 0),
                                    0,
                                  ),
                                )}
                              </p>
                            )}
                            {group.some(
                              (r) => r.provider_reported_cost != null,
                            ) && (
                              <p>
                                Provider-reported cost:{" "}
                                {usageCost(
                                  group.reduce(
                                    (n, r) =>
                                      n + (r.provider_reported_cost ?? 0),
                                    0,
                                  ),
                                )}{" "}
                                (reported subset)
                              </p>
                            )}
                            {group.some(
                              (r) => r.cost_source === "hermes_estimate",
                            ) && <p>Includes Hermes-provided estimates.</p>}
                            {price?.rates && (
                              <p className="sm:col-span-2">
                                USD / 1M tokens:{" "}
                                {rateKeys
                                  .map(
                                    (k, i) =>
                                      `${rateLabels[i]} ${price.rates?.[k] ?? "unavailable"}`,
                                  )
                                  .join(" · ")}
                              </p>
                            )}
                            {price?.checked_at && (
                              <p>
                                Prices checked:{" "}
                                {new Date(
                                  price.checked_at * 1000,
                                ).toLocaleString()}
                              </p>
                            )}
                            {group.some((r) => r.historical) && (
                              <p>
                                Includes historical summaries without daily
                                attribution.
                              </p>
                            )}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </section>
              </>
            )}
            {base.some((r) => r.historical) && (
              <p className="rounded-xl border border-base-content/10 p-4 text-sm text-base-content/60">
                Historical summary available in “All time”. Earlier Hermes
                aggregates cannot be assigned to individual days.
              </p>
            )}
          </>
        )}
        <footer className="border-t border-base-content/10 pt-4 text-xs leading-5 text-base-content/60">
          Estimates use current pricing and available usage reports. They may
          differ from provider charges. No prompts or responses are collected.
          {data?.started_at && (
            <>
              {" "}
              Monitoring started{" "}
              {new Date(data.started_at * 1000).toLocaleDateString()}.
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

export function UsagePricingOverrides({ api }: { api: WorkspaceApi }) {
  const { data, error, refresh } = useUsage(api);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [rates, setRates] = useState<UsageRates>({
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
  });
  const [free, setFree] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  function select(price: UsagePrice | undefined) {
    if (!price) return;
    setProvider(price.provider);
    setModel(price.model);
    setRates(
      price.rates ?? {
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
      },
    );
    setFree(
      Boolean(price.rates && rateKeys.every((k) => price.rates?.[k] === "0")),
    );
    setMessage("");
  }
  async function save(reset = false) {
    setSaving(true);
    setMessage("");
    try {
      await api.saveUsageOverride(
        provider,
        model,
        reset
          ? null
          : free
            ? {
                input_tokens: "0",
                output_tokens: "0",
                cache_read_tokens: "0",
                cache_write_tokens: "0",
              }
            : rates,
      );
      await refresh();
      if (reset) {
        setRates(
          automatic ?? {
            input_tokens: null,
            output_tokens: null,
            cache_read_tokens: null,
            cache_write_tokens: null,
          },
        );
        setFree(false);
      }
      setMessage(
        reset ? "Automatic pricing restored." : "Pricing override saved.",
      );
    } catch {
      setMessage(
        "Could not save. Use non-negative USD rates with up to 9 decimal places.",
      );
    } finally {
      setSaving(false);
    }
  }
  const automatic = data?.prices.find(
    (p) => p.provider === provider && p.model === model,
  )?.automatic_rates;
  return (
    <details className="rounded-xl border border-base-content/10 p-4">
      <summary className="cursor-pointer font-semibold">
        Advanced · Pricing overrides
      </summary>
      <div className="mt-4 grid gap-4">
        <p className="text-sm text-base-content/60">
          Automatic pricing is used by default. Override only for private
          contracts, custom proxies, or local models. Overrides change displayed
          historical estimates, not provider billing. Overrides apply to every
          endpoint using this provider/model. Use distinct provider identifiers
          for proxies with different prices.
        </p>
        {error && <p role="alert">{error}</p>}
        {!data?.available ? (
          <p className="text-sm">
            Pricing controls become available when the runtime collector starts.
          </p>
        ) : (
          <>
            <label className="grid gap-1 text-sm">
              Observed model
              <select
                className="select select-bordered w-full"
                value={
                  data.prices.some(
                    (p) => p.provider === provider && p.model === model,
                  )
                    ? data.prices.findIndex(
                        (p) => p.provider === provider && p.model === model,
                      )
                    : ""
                }
                disabled={saving}
                onChange={(e) => select(data.prices[Number(e.target.value)])}
              >
                <option value="" disabled>
                  Select a model, or enter a custom model below
                </option>
                {data.prices.map((p, i) => (
                  <option key={JSON.stringify([p.provider, p.model])} value={i}>
                    {p.model} / {p.provider}
                    {p.overridden ? " · custom override" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                Provider
                <input
                  className="input input-bordered"
                  value={provider}
                  maxLength={256}
                  onChange={(e) => setProvider(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Model identifier
                <input
                  className="input input-bordered"
                  value={model}
                  maxLength={256}
                  onChange={(e) => setModel(e.target.value)}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                className="checkbox checkbox-sm"
                type="checkbox"
                checked={free}
                onChange={(e) => setFree(e.target.checked)}
              />
              Free / no API charge
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              {rateKeys.map((k, i) => (
                <label key={k} className="grid gap-1 text-sm">
                  {rateLabels[i]} · USD / 1M tokens
                  <input
                    className="input input-bordered"
                    inputMode="decimal"
                    disabled={free || saving}
                    value={rates[k] ?? ""}
                    placeholder="Unavailable"
                    onChange={(e) =>
                      setRates({ ...rates, [k]: e.target.value || null })
                    }
                  />
                  <span className="text-xs text-base-content/50">
                    Automatic: {automatic?.[k] ?? "unavailable"}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={saving || !provider || !model}
                onClick={() => void save()}
              >
                Save override
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={saving || !provider || !model}
                onClick={() => void save(true)}
              >
                Reset to automatic
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={saving}
                onClick={() => {
                  setProvider("");
                  setModel("");
                  setRates({
                    input_tokens: null,
                    output_tokens: null,
                    cache_read_tokens: null,
                    cache_write_tokens: null,
                  });
                  setFree(false);
                  setMessage("");
                }}
              >
                Cancel
              </button>
            </div>
          </>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </div>
    </details>
  );
}
