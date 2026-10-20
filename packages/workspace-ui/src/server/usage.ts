import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  UsagePrice,
  UsageRates,
  UsageResponse,
  UsageRow,
  UsageTokens,
} from "../shared/usage";
import { WorkspaceError } from "./workspace";

const tokenKeys = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
] as const;
const rateKeys = tokenKeys.filter((key) => key !== "reasoning_tokens");
const emptyTokens = (): UsageTokens => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
});

// Integer nano-USD arithmetic. Rates are USD / million tokens.
function nanoRate(value: string): bigint {
  if (!/^\d{1,9}(\.\d{1,9})?$/.test(value))
    throw new WorkspaceError("Invalid rates", 400, "invalid_usage_rates");
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
}

export function estimateCost(
  tokens: UsageTokens,
  rates: UsageRates,
): number | null {
  let nano = 0n;
  for (const key of rateKeys) {
    if (!tokens[key]) continue;
    const rate = rates[key];
    if (rate === null) return null;
    nano += (BigInt(Math.trunc(tokens[key])) * nanoRate(rate)) / 1000000n;
  }
  return Number(nano) / 1000000000;
}

function storedRates(value: string | null | undefined): UsageRates | null {
  if (!value) return null;
  try {
    const rates: unknown = JSON.parse(value);
    if (!rates || typeof rates !== "object") return null;
    const result = {} as UsageRates;
    for (const key of rateKeys) {
      const rate = (rates as Record<string, unknown>)[key];
      if (rate !== null && typeof rate !== "string") return null;
      if (typeof rate === "string") nanoRate(rate);
      result[key] = rate;
    }
    return result;
  } catch {
    return null;
  }
}

export class UsageService {
  constructor(private readonly root?: string) {}

  private open(): Database | null {
    if (!this.root || !existsSync(join(this.root, "usage.sqlite"))) return null;
    const db = new Database(join(this.root, "usage.sqlite"));
    db.exec("PRAGMA busy_timeout=3000");
    return db;
  }

  snapshot(reference?: string): UsageResponse {
    const response: UsageResponse = {
      schema: 1,
      available: false,
      started_at: null,
      updated_at: null,
      warning: null,
      timezone: "UTC",
      rows: [],
      prices: [],
    };
    const db = this.open();
    if (!db) return response;
    try {
      const meta = Object.fromEntries(
        (
          db.query("SELECT key,value FROM usage_meta").all() as {
            key: string;
            value: string;
          }[]
        ).map(({ key, value }) => [key, value]),
      );
      response.available = true;
      response.started_at = Number(meta.started_at) || null;
      response.updated_at = Number(meta.updated_at) || null;
      response.warning = meta.collection_error ?? null;
      const models = db
        .query(
          "SELECT provider,model FROM usage_events UNION SELECT provider,model FROM usage_overrides",
        )
        .all() as { provider: string; model: string }[];
      for (const { provider, model } of models) {
        const automatic = db
          .query("SELECT * FROM usage_prices WHERE provider=? AND model=?")
          .get(provider, model) as {
          rates: string | null;
          source: string;
          checked_at: number;
          error: number;
        } | null;
        const override = db
          .query(
            "SELECT rates FROM usage_overrides WHERE provider=? AND model=?",
          )
          .get(provider, model) as { rates: string } | null;
        const automaticRates = storedRates(automatic?.rates);
        const overrideRates = storedRates(override?.rates);
        const corrupt = Boolean(
          (automatic?.rates && !automaticRates) ||
            (override?.rates && !overrideRates),
        );
        const price: UsagePrice = {
          provider,
          model,
          rates: override ? overrideRates : automaticRates,
          automatic_rates: automaticRates,
          source: corrupt
            ? "invalid_cached_rates"
            : override
              ? "custom_override"
              : (automatic?.source ?? "unavailable"),
          overridden: Boolean(override),
          checked_at: automatic?.checked_at ?? null,
          stale: Boolean(
            corrupt ||
              (automatic &&
                (automatic.error ||
                  Date.now() / 1000 - automatic.checked_at > 172800)),
          ),
        };
        response.prices.push(price);
      }
      const sums = tokenKeys
        .map(
          (key) => `SUM(COALESCE(json_extract(tokens,'$.${key}'),0)) AS ${key}`,
        )
        .join(",");
      const hasProviderCost = (
        db.query("PRAGMA table_info(usage_events)").all() as { name: string }[]
      ).some((c) => c.name === "provider_cost");
      const groups = db
        .query(
          `SELECT activity,provider,model,date(timestamp,'unixepoch') AS day,historical,MIN(complete) AS complete,${sums},SUM(fallback_cost) AS fallback_cost,${hasProviderCost ? "SUM(provider_cost)" : "NULL"} AS provider_cost,SUM(${hasProviderCost ? "COALESCE(provider_cost,fallback_cost)" : "fallback_cost"}) AS reported_fallback,COUNT(*)-COUNT(${hasProviderCost ? "COALESCE(provider_cost,fallback_cost)" : "fallback_cost"}) AS missing_cost FROM usage_events ${reference ? "WHERE reference=?" : ""} GROUP BY activity,provider,model,day,historical ORDER BY day DESC LIMIT 20000`,
        )
        .all(...(reference ? [reference] : [])) as (UsageTokens & {
        activity: UsageRow["activity"];
        provider: string;
        model: string;
        day: string;
        historical: number;
        complete: number;
        fallback_cost: number | null;
        provider_cost: number | null;
        reported_fallback: number | null;
        missing_cost: number;
      })[];
      for (const group of groups) {
        const price = response.prices.find(
          (p) => p.provider === group.provider && p.model === group.model,
        );
        const tokens = emptyTokens();
        for (const key of tokenKeys) tokens[key] = group[key];
        const calculated =
          price?.rates &&
          (group.complete || rateKeys.some((k) => tokens[k] > 0))
            ? estimateCost(tokens, price.rates)
            : null;
        response.rows.push({
          ...tokens,
          usage_available: Boolean(
            group.complete || rateKeys.some((k) => tokens[k] > 0),
          ),
          hermes_estimated_cost: group.fallback_cost,
          provider_reported_cost: group.provider_cost,
          activity: group.activity,
          provider: group.provider,
          model: group.model,
          day: group.day,
          historical: Boolean(group.historical),
          complete: Boolean(group.complete),
          cost: calculated ?? group.reported_fallback,
          cost_source:
            calculated !== null
              ? "current_pricing"
              : group.provider_cost !== null
                ? "provider_reported"
                : group.fallback_cost !== null
                  ? "hermes_estimate"
                  : "unavailable",
          partial_cost:
            !group.complete || (calculated === null && group.missing_cost > 0),
        });
      }
      if (groups.length === 20000)
        response.warning = "Showing the most recent 20,000 daily model groups.";
      return response;
    } finally {
      db.close();
    }
  }

  override(body: unknown, reset = false): void {
    if (!body || typeof body !== "object")
      throw new WorkspaceError("Invalid rates", 400, "invalid_usage_rates");
    const input = body as Record<string, unknown>;
    if ("endpoint" in input || "base_url" in input || "route" in input)
      throw new WorkspaceError(
        "Overrides are provider/model-wide",
        400,
        "unsupported_pricing_scope",
      );
    if (
      typeof input.provider !== "string" ||
      !input.provider.trim() ||
      input.provider.length > 256 ||
      typeof input.model !== "string" ||
      !input.model.trim() ||
      input.model.length > 256
    )
      throw new WorkspaceError("Invalid model", 400, "invalid_usage_model");
    const rates = input.rates as Record<string, unknown> | undefined;
    const validated: Record<string, string | null> = {};
    if (!reset)
      for (const key of rateKeys) {
        const rate = rates?.[key];
        if (rate !== null && typeof rate !== "string")
          throw new WorkspaceError("Invalid rates", 400, "invalid_usage_rates");
        if (typeof rate === "string") nanoRate(rate);
        validated[key] = rate;
      }
    const db = this.open();
    if (!db)
      throw new WorkspaceError("Usage unavailable", 503, "usage_unavailable");
    try {
      if (reset)
        db.query(
          "DELETE FROM usage_overrides WHERE provider=? AND model=?",
        ).run(input.provider, input.model);
      else
        db.query("INSERT OR REPLACE INTO usage_overrides VALUES (?,?,?)").run(
          input.provider,
          input.model,
          JSON.stringify(validated),
        );
    } finally {
      db.close();
    }
  }
}
