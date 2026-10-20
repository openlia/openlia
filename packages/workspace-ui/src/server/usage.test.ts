import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageService, estimateCost } from "./usage";
import { createWorkspaceHandler } from "./app";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "usage-test-"));
  dirs.push(root);
  const db = new Database(join(root, "usage.sqlite"));
  db.exec(
    `CREATE TABLE usage_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE usage_events(id TEXT PRIMARY KEY,activity TEXT,provider TEXT,model TEXT,timestamp REAL,historical INTEGER,reference TEXT,tokens TEXT,complete INTEGER,fallback_cost REAL);CREATE TABLE usage_prices(provider TEXT,model TEXT,rates TEXT,source TEXT,checked_at REAL,error INTEGER,PRIMARY KEY(provider,model));CREATE TABLE usage_overrides(provider TEXT,model TEXT,rates TEXT,PRIMARY KEY(provider,model));`,
  );
  const rates = {
    input_tokens: "3",
    output_tokens: "15",
    cache_read_tokens: "0.3",
    cache_write_tokens: "3.75",
  };
  const tokens = {
    input_tokens: 200,
    output_tokens: 100,
    cache_read_tokens: 800,
    cache_write_tokens: 0,
    reasoning_tokens: 60,
  };
  db.query(
    "INSERT INTO usage_prices VALUES ('p','model',?,'official_docs_snapshot',?,0)",
  ).run(JSON.stringify(rates), Date.now() / 1000);
  db.query(
    "INSERT INTO usage_events VALUES ('1','hermes','p','model',?,0,'session',?,1,0.5)",
  ).run(Date.now() / 1000, JSON.stringify(tokens));
  db.close();
  return { root, rates, tokens, service: new UsageService(root) };
}
describe("usage estimates", () => {
  test("missing usage is unknown, not known zero", () => {
    const { root, service } = fixture();
    const db = new Database(join(root, "usage.sqlite"));
    db.exec("DELETE FROM usage_events");
    db.query(
      "INSERT INTO usage_events VALUES ('unknown','ingestion','p','model',?,0,'intake','{}',0,NULL)",
    ).run(Date.now() / 1000);
    db.close();
    const row = service.snapshot().rows[0];
    expect(row?.usage_available).toBe(false);
    expect(row?.cost).toBeNull();
    expect(row?.partial_cost).toBe(true);
    const knownZero = new Database(join(root, "usage.sqlite"));
    knownZero.exec(
      'UPDATE usage_events SET complete=1,tokens=\'{"input_tokens":0,"output_tokens":0}\'',
    );
    knownZero.close();
    expect(service.snapshot().rows[0]?.usage_available).toBe(true);
    expect(service.snapshot().rows[0]?.cost).toBe(0);
  });
  test("corrupt automatic and override rates degrade without failing the API", async () => {
    const { root, service } = fixture();
    const db = new Database(join(root, "usage.sqlite"));
    db.exec("UPDATE usage_prices SET rates='not-json'");
    expect(service.snapshot().prices[0]?.stale).toBe(true);
    expect(service.snapshot().prices[0]?.rates).toBeNull();
    expect(service.snapshot().rows[0]?.cost_source).toBe("hermes_estimate");
    db.exec("INSERT INTO usage_overrides VALUES ('p','model','[]')");
    db.close();
    expect(service.snapshot().prices[0]?.source).toBe("invalid_cached_rates");
    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      usageRoot: root,
    });
    const response = await handler(
      new Request("http://localhost/api/workspace/usage"),
    );
    expect(response.status).toBe(200);
  });
  test("pricing scope is explicitly provider/model, and rejects endpoint scopes", () => {
    const { service, rates } = fixture();
    expect(() =>
      service.override({
        provider: "p",
        model: "model",
        endpoint: "https://proxy.invalid",
        rates,
      }),
    ).toThrow("provider/model-wide");
    service.override({ provider: "proxy-a", model: "model", rates });
    service.override({
      provider: "proxy-b",
      model: "model",
      rates: { ...rates, input_tokens: "99" },
    });
    expect(
      service.snapshot().prices.find((p) => p.provider === "proxy-a")?.rates
        ?.input_tokens,
    ).toBe("3");
    expect(
      service.snapshot().prices.find((p) => p.provider === "proxy-b")?.rates
        ?.input_tokens,
    ).toBe("99");
  });
  test("keeps reported and estimated cost separate from recalculated cost", () => {
    const { root, service } = fixture();
    const db = new Database(join(root, "usage.sqlite"));
    db.exec(
      "ALTER TABLE usage_events ADD COLUMN provider_cost REAL; UPDATE usage_events SET provider_cost=0.25",
    );
    db.close();
    const row = service.snapshot().rows[0];
    expect(row?.hermes_estimated_cost).toBe(0.5);
    expect(row?.provider_reported_cost).toBe(0.25);
    expect(row?.cost).toBeCloseTo(0.00234, 9);
    const writable = new Database(join(root, "usage.sqlite"));
    writable.exec("DELETE FROM usage_prices");
    writable.close();
    expect(service.snapshot().rows[0]?.cost).toBe(0.25);
    expect(service.snapshot().rows[0]?.cost_source).toBe("provider_reported");
  });
  test("decimal rates and reasoning subset", () => {
    const { tokens, rates } = fixture();
    expect(estimateCost(tokens, rates)).toBeCloseTo(0.00234, 9);
  });
  test("unknown cache price is unavailable, not free", () => {
    const { tokens, rates } = fixture();
    expect(
      estimateCost(tokens, { ...rates, cache_read_tokens: null }),
    ).toBeNull();
  });
  test("snapshot, reference filtering, override and reset", () => {
    const { service } = fixture();
    expect(service.snapshot().rows[0]?.cost).toBeCloseTo(0.00234, 9);
    expect(service.snapshot("other").rows).toHaveLength(0);
    service.override({
      provider: "p",
      model: "model",
      rates: {
        input_tokens: "0",
        output_tokens: "0",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
      },
    });
    expect(service.snapshot().rows[0]?.cost).toBe(0);
    expect(service.snapshot().prices[0]?.overridden).toBe(true);
    service.override({ provider: "p", model: "model" }, true);
    expect(service.snapshot().prices[0]?.overridden).toBe(false);
  });
  test("falls back to Hermes estimate", () => {
    const { root, service } = fixture();
    const db = new Database(join(root, "usage.sqlite"));
    db.exec("DELETE FROM usage_prices");
    db.close();
    expect(service.snapshot().rows[0]?.cost).toBe(0.5);
    expect(service.snapshot().rows[0]?.cost_source).toBe("hermes_estimate");
  });
  test("rejects negative, nonfinite, missing and invalid rates", () => {
    const { service, rates } = fixture();
    for (const value of ["-1", "NaN", "Infinity", "1e8", 1, undefined])
      expect(() =>
        service.override({
          provider: "p",
          model: "model",
          rates: { ...rates, input_tokens: value },
        }),
      ).toThrow();
  });
  test("missing runtime returns unavailable", () =>
    expect(new UsageService().snapshot().available).toBe(false));
  test("authenticated routes and mutation origin checks", async () => {
    const { root } = fixture();
    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      usageRoot: root,
      authRequired: true,
      passwordHash: await Bun.password.hash("password"),
    });
    expect(
      (await handler(new Request("http://localhost/api/workspace/usage")))
        .status,
    ).toBe(401);
    const open = createWorkspaceHandler({
      workspaceRoot: root,
      usageRoot: root,
    });
    expect(
      (
        await open(
          new Request("http://localhost/api/workspace/usage/override", {
            method: "PUT",
            headers: {
              Origin: "http://evil.invalid",
              "Content-Type": "application/json",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
  });
});
