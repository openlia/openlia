import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { UsagePage, UsagePricingOverrides, usageCost } from "./UsagePage";
import { createMockWorkspaceApi } from "./mockApi";
import { buildRouteUrl, parseRoute } from "./route";

beforeEach(() => window.history.replaceState(null, "", "/usage"));
describe("usage dashboard", () => {
  test("missing token reports are visibly unknown", async () => {
    const api = createMockWorkspaceApi();
    const response = await api.loadUsage();
    const row = response.rows[0];
    if (!row) throw new Error("missing fixture");
    api.loadUsage = vi.fn().mockResolvedValue({
      ...response,
      rows: [
        {
          ...row,
          usage_available: false,
          complete: false,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          cost: null,
          partial_cost: true,
        },
      ],
    });
    render(<UsagePage api={api} />);
    expect(
      await screen.findByText("Token counts have not been reported."),
    ).toBeInTheDocument();
    expect(screen.getByText("Unknown", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("Unknown tokens").length).toBeGreaterThan(0);
  });
  test("all-time period survives subsequent filters", async () => {
    render(<UsagePage api={createMockWorkspaceApi()} />);
    await screen.findByText("Estimated cost");
    fireEvent.change(screen.getByLabelText("Period"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("Activity"), {
      target: { value: "migration" },
    });
    expect(new URLSearchParams(window.location.search).get("period")).toBe(
      "all",
    );
    expect(new URLSearchParams(window.location.search).get("activity")).toBe(
      "migration",
    );
  });
  test("formats tiny costs without false zero", () => {
    expect(usageCost(0.000002)).toBe("<$0.0001");
    expect(usageCost(0.0042)).toBe("~$0.0042");
    expect(usageCost(null)).toBe("Unavailable");
    expect(usageCost(0)).toBe("$0.00");
  });
  test("routes support Usage", () => {
    expect(parseRoute("/usage").tab).toBe("usage");
    expect(parseRoute("openlia://usage").tab).toBe("usage");
    expect(buildRouteUrl({ tab: "usage" })).toBe("/usage");
  });
  test("shows estimates, filters, model details and UTC chart", async () => {
    render(<UsagePage api={createMockWorkspaceApi()} />);
    expect(await screen.findByText("Estimated cost")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAccessibleName(/UTC/);
    fireEvent.change(screen.getByLabelText("Activity"), {
      target: { value: "ingestion" },
    });
    expect(window.location.search).toContain("activity=ingestion");
    expect(screen.getByText(/included in output/)).toBeInTheDocument();
  });
  test("empty period does not pretend spend is zero", async () => {
    render(<UsagePage api={createMockWorkspaceApi({ scenario: "empty" })} />);
    expect(
      await screen.findByText("No usage recorded for this period."),
    ).toBeInTheDocument();
  });
  test("missing collector has actionable state", async () => {
    const api = createMockWorkspaceApi();
    const response = await api.loadUsage();
    api.loadUsage = vi.fn().mockResolvedValue({
      ...response,
      available: false,
      rows: [],
      prices: [],
    });
    render(<UsagePage api={api} />);
    expect(
      await screen.findByText("Usage monitoring is not available yet"),
    ).toBeInTheDocument();
  });
  test("historical summary is excluded from current-period totals", async () => {
    const api = createMockWorkspaceApi();
    const response = await api.loadUsage();
    api.loadUsage = vi.fn().mockResolvedValue({
      ...response,
      rows: response.rows.map((r) => ({ ...r, historical: true })),
    });
    render(<UsagePage api={api} />);
    expect(
      await screen.findByText("No usage recorded for this period."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Period"), {
      target: { value: "all" },
    });
    expect(
      await screen.findByText(/Only historical summaries/),
    ).toBeInTheDocument();
  });
  test("advanced free override and reset", async () => {
    const api = createMockWorkspaceApi();
    const save = vi.spyOn(api, "saveUsageOverride");
    render(<UsagePricingOverrides api={api} />);
    await screen.findByLabelText("Observed model");
    fireEvent.change(screen.getByLabelText("Observed model"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByLabelText("Free / no API charge"));
    fireEvent.click(screen.getByRole("button", { name: "Save override" }));
    await screen.findByText("Pricing override saved.");
    expect(save).toHaveBeenCalledWith("anthropic", "claude-sonnet", {
      input_tokens: "0",
      output_tokens: "0",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset to automatic" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith("anthropic", "claude-sonnet", null),
    );
  });
});
