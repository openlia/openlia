import type { UsageResponse } from "../shared/usage";

export function mockUsage(): UsageResponse {
  const now = Date.now() / 1000;
  return {
    schema: 1,
    available: true,
    started_at: now - 86400 * 12,
    updated_at: now,
    timezone: "UTC",
    warning: null,
    prices: [
      {
        provider: "anthropic",
        model: "claude-sonnet",
        rates: {
          input_tokens: "3",
          output_tokens: "15",
          cache_read_tokens: "0.3",
          cache_write_tokens: "3.75",
        },
        automatic_rates: {
          input_tokens: "3",
          output_tokens: "15",
          cache_read_tokens: "0.3",
          cache_write_tokens: "3.75",
        },
        source: "official_docs_snapshot",
        checked_at: now,
        stale: false,
        overridden: false,
      },
    ],
    rows: Array.from({ length: 12 }, (_, i) => ({
      activity:
        (["hermes", "ingestion", "migration"] as const)[i % 3] ?? "hermes",
      provider: "anthropic",
      model: "claude-sonnet",
      day: new Date((now - i * 86400) * 1000).toISOString().slice(0, 10),
      historical: false,
      complete: true,
      usage_available: true,
      input_tokens: 100000 + i * 5000,
      output_tokens: 18000,
      cache_read_tokens: 70000,
      cache_write_tokens: 0,
      reasoning_tokens: 2000,
      cost: 0.591 + i * 0.015,
      cost_source: "current_pricing",
      partial_cost: false,
    })),
  };
}
