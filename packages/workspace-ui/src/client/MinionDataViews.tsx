import { useEffect, useState } from "react";
import { type MinionView, minionQuerySchema } from "../shared/minionViews";
import type { WorkspaceApi } from "./api";

type Result = {
  revision: string;
  observed_at: string;
  truncated: boolean;
  unknown_dates: number;
  records: {
    id: string;
    title: string;
    fields: Record<string, unknown>;
    source: string;
  }[];
};

/** Read-only dashboard panel backed by the same queries as Hermes. */
export function MinionDataViews({
  id,
  api,
  onNavigateLink,
}: {
  id: string;
  api: Pick<WorkspaceApi, "describeMinionViews" | "queryMinionView">;
  onNavigateLink?: ((href: string) => void) | undefined;
}) {
  const [views, setViews] = useState<MinionView[]>([]);
  const [selected, setSelected] = useState("");
  const [filters, setFilters] = useState("{}");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(
    new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
  );
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setViews([]);
    setSelected("");
    setResult(null);
    setError("");
    const describe = api.describeMinionViews;
    if (!describe) {
      setError("Data view API unavailable.");
      return;
    }
    describe(id)
      .then((value) => {
        if (!active) return;
        setViews(value.views);
        setSelected(value.views[0]?.id ?? "");
      })
      .catch(() => {
        if (active)
          setError("Data views unavailable. This does not mean zero activity.");
      });
    return () => {
      active = false;
    };
  }, [id, api.describeMinionViews]);
  async function query() {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      if (!api.queryMinionView) throw new Error("Data view API unavailable");
      const value = await api.queryMinionView(
        minionQuerySchema.parse({
          id,
          view: selected,
          from,
          to,
          filters: JSON.parse(filters),
          purpose: "interactive",
          limit: 20,
        }),
      );
      setResult(value);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Query unavailable");
    } finally {
      setLoading(false);
    }
  }
  return (
    <section
      className="rounded-xl border border-base-content/15 p-4 space-y-3"
      aria-label="Shared Minion data views"
    >
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">Shared data views</h3>
        <span className="badge badge-xs badge-ghost">Read-only</span>
      </div>
      {error && <p role="alert">{error}</p>}
      {views.length > 0 && (
        <div className="flex flex-wrap gap-2 items-end">
          <label>
            View{" "}
            <select
              aria-label="Data view"
              className="select select-sm"
              value={selected}
              disabled={loading}
              onChange={(event) => {
                setSelected(event.target.value);
                setResult(null);
              }}
            >
              {views.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            From{" "}
            <input
              aria-label="View start date"
              className="input input-sm"
              type="date"
              value={from}
              disabled={loading}
              onChange={(event) => {
                setFrom(event.target.value);
                setResult(null);
              }}
            />
          </label>
          <label>
            Until (exclusive){" "}
            <input
              aria-label="View end date"
              className="input input-sm"
              type="date"
              value={to}
              disabled={loading}
              onChange={(event) => {
                setTo(event.target.value);
                setResult(null);
              }}
            />
          </label>
          <label>
            Scope filters (JSON){" "}
            <input
              aria-label="View scope filters"
              className="input input-sm"
              value={filters}
              disabled={loading}
              onChange={(event) => {
                setFilters(event.target.value);
                setResult(null);
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            onClick={() => void query()}
          >
            {loading ? "Reading…" : "Read view"}
          </button>
        </div>
      )}
      {result && (
        <>
          <p className="text-xs">
            Observed: {result.observed_at} · {result.revision}
            {result.truncated ? " · Additional records omitted" : ""}
          </p>
          {result.unknown_dates > 0 && (
            <p>
              {result.unknown_dates} scoped record(s) have unknown dates; do not
              infer no activity.
            </p>
          )}
          {result.records.length === 0 ? (
            <p>
              No matching records in this successfully read scope and date
              range.
            </p>
          ) : (
            <ul>
              {result.records.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    className="link"
                    onClick={() => onNavigateLink?.(record.source)}
                  >
                    {record.title}
                  </button>
                  <pre className="whitespace-pre-wrap text-xs">
                    {JSON.stringify(record.fields, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
