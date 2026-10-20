export type UsageActivity = "hermes" | "ingestion" | "migration";
export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
}
export type UsageRates = Record<
  Exclude<keyof UsageTokens, "reasoning_tokens">,
  string | null
>;
export interface UsagePrice {
  provider: string;
  model: string;
  rates: UsageRates | null;
  automatic_rates: UsageRates | null;
  source: string;
  checked_at: number | null;
  stale: boolean;
  overridden: boolean;
}
export interface UsageRow extends UsageTokens {
  /** False means no token counts were reported, not zero usage. */
  usage_available: boolean;
  hermes_estimated_cost?: number | null;
  provider_reported_cost?: number | null;
  activity: UsageActivity;
  provider: string;
  model: string;
  day: string;
  historical: boolean;
  complete: boolean;
  cost: number | null;
  cost_source:
    | "current_pricing"
    | "hermes_estimate"
    | "provider_reported"
    | "unavailable";
  partial_cost: boolean;
}
export interface UsageResponse {
  schema: 1;
  available: boolean;
  started_at: number | null;
  updated_at: number | null;
  warning: string | null;
  timezone: "UTC";
  rows: UsageRow[];
  prices: UsagePrice[];
}
