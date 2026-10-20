import { useEffect, useState } from "react";
import type { WorkspaceApi } from "./api";
import type { UsageResponse } from "../shared/usage";
import { usageCost } from "./UsagePage";

export function UsageSummary({
  api,
  reference,
}: {
  api: WorkspaceApi;
  reference: string;
}) {
  const [data, setData] = useState<UsageResponse | null>(null);
  useEffect(() => {
    let active = true;
    setData(null);
    const load = () => {
      void api
        .loadUsage(reference)
        .then((value) => {
          if (active) setData(value);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, reference]);
  if (!data?.rows.length) return null;
  const tokens = data.rows.reduce(
    (n, r) =>
      n +
      r.input_tokens +
      r.output_tokens +
      r.cache_read_tokens +
      r.cache_write_tokens,
    0,
  );
  const cost = data.rows.some((r) => r.cost !== null)
    ? data.rows.reduce((n, r) => n + (r.cost ?? 0), 0)
    : null;
  return (
    <div className="border-b border-base-content/10 bg-base-200/30 px-4 py-2 text-xs text-base-content/70">
      LLM usage:{" "}
      {data.rows.some((r) => r.usage_available)
        ? `${Intl.NumberFormat(undefined, { notation: "compact" }).format(tokens)} tokens`
        : "Unknown tokens"}{" "}
      · estimated {usageCost(cost)}
      {data.rows.some((r) => r.partial_cost || r.cost === null)
        ? " (partial)"
        : ""}{" "}
      <a
        className="link ml-2"
        href={`/usage?period=all&reference=${encodeURIComponent(reference)}`}
      >
        View in Usage →
      </a>
    </div>
  );
}
