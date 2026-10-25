import { describe, expect, it } from "vitest";
import {
  contactRecency,
  monitorHealth,
  safeWebURL,
  tripAlerts,
} from "./domainData";
import { loadFinanceJournal } from "./financeData";

describe("domain data", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  it("never infers healthy monitors from missing or future observations", () => {
    expect(monitorHealth({ status: "active" }, now)).toBe("unknown");
    expect(
      monitorHealth(
        {
          status: "active",
          check_frequency: "daily",
          last_checked: "2026-10-26T12:00:00Z",
        },
        now,
      ),
    ).toBe("unknown");
    expect(
      monitorHealth(
        {
          status: "active",
          check_frequency: "daily",
          last_checked: "2026-10-25T10:00:00Z",
        },
        now,
      ),
    ).toBe("healthy");
    expect(
      monitorHealth(
        {
          status: "active",
          check_frequency: "daily",
          last_checked: "2026-10-23T10:00:00Z",
        },
        now,
      ),
    ).toBe("stale");
    expect(monitorHealth({ status: "triggered" }, now)).toBe("alerting");
    expect(monitorHealth({ status: "paused" }, now)).toBe("paused");
  });
  it("does not use modification times for contact recency", () => {
    expect(contactRecency(undefined, now)).toBe("Last contact unknown");
    expect(contactRecency("2026-10-24", now)).toBe("1 day since last contact");
  });
  it("rejects executable and non-web vendor/source URLs", () => {
    expect(safeWebURL("javascript:alert(1)")).toBeUndefined();
    expect(safeWebURL("file:///etc/passwd")).toBeUndefined();
    expect(safeWebURL("https://example.com")).toBe("https://example.com/");
  });
  it("reports incomplete and inverted trip dates", () => {
    expect(tripAlerts({})).toContain("Dates incomplete");
    expect(
      tripAlerts({ start_date: "2026-11-03", end_date: "2026-11-01" }),
    ).toContain("Check date range");
  });
  it("loads transitive journal includes once and reports missing includes", async () => {
    const paths: string[] = [];
    const files: Record<string, string> = {
      "finance/main.hledger":
        "include nested/accounts.journal\ninclude missing.journal",
      "finance/nested/accounts.journal":
        "include ../main.hledger\n2026-10-01 Opening\n    assets:bank  100 USD\n    equity:opening\n",
    };
    const result = await loadFinanceJournal(
      "finance/main.hledger",
      async (path) => {
        paths.push(path);
        const content = files[path];
        if (!content) throw new Error("Missing");
        return { content };
      },
    );
    expect(
      paths.filter((path) => path === "finance/main.hledger"),
    ).toHaveLength(1);
    expect(result.parsed.transactions).toHaveLength(1);
    expect(result.warnings).toEqual(["Could not load finance/missing.journal"]);
  });
  it("reports glob includes without trying to load them", async () => {
    const result = await loadFinanceJournal("finance/*.journal", async () => {
      throw new Error("Must not load");
    });
    expect(result.warnings).toEqual([
      "Unsupported journal path: finance/*.journal",
    ]);
  });
});
