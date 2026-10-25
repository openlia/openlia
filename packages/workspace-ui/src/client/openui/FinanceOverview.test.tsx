import { Renderer } from "@openuidev/react-lang";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockWorkspaceApi } from "../mockApi";
import { OpenLiaOpenUIProvider } from "./context";
import { openliaLibrary } from "./library";

describe("FinanceOverview", () => {
  it("requires explicit journal scope for records", () => {
    render(
      <OpenLiaOpenUIProvider value={{}}>
        <Renderer
          library={openliaLibrary}
          response="root = FinanceOverview()"
        />
      </OpenLiaOpenUIProvider>,
    );
    expect(screen.getByText(/Journal scope unknown/)).toBeDefined();
    expect(screen.queryByText("Monthly cashflow")).toBeNull();
  });

  it("previews monthly cashflow, currency-separated balances, and account history", async () => {
    const api = createMockWorkspaceApi({
      files: {
        "finance/test.hledger":
          "2026-09-01 Opening\n    assets:bank  1000 USD\n    equity:opening\n\n2026-10-01 Salary\n    assets:bank  200 USD\n    income:salary\n\n2026-10-02 Groceries\n    expenses:food  30 USD\n    assets:bank\n\n2026-10-03 Euro opening\n    assets:bank  50 EUR\n    equity:opening\n",
      },
    });
    render(
      <OpenLiaOpenUIProvider
        value={{
          loadFile: api.loadFile,
          currentRecordContent:
            "---\njournal_path: finance/test.hledger\nledger_account: assets:bank\n---\n# Bank",
        }}
      >
        <Renderer
          library={openliaLibrary}
          response="root = FinanceOverview()"
        />
      </OpenLiaOpenUIProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Reporting currency")).toBeDefined(),
    );
    fireEvent.change(screen.getByLabelText("Reporting currency"), {
      target: { value: "USD" },
    });
    const section = screen.getByRole("region", { name: "Finance overview" });
    expect(section.textContent).toContain("1,170 USD");
    expect(section.textContent).toContain("170 USD");
    expect(section.textContent).toContain("expenses:food: 30 USD");
    expect(screen.getByText("Running balance: assets:bank")).toBeDefined();
    expect(screen.getByText(/not hledger-validated/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Reporting currency"), {
      target: { value: "EUR" },
    });
    expect(section.textContent).toContain("50 EUR");
    expect(section.textContent).not.toContain("1,170 EUR");
  });

  it("does not show financial totals for incomplete includes", async () => {
    const api = createMockWorkspaceApi({
      files: {
        "finance/partial.hledger":
          "include missing.journal\n2026-10-01 Opening\n    assets:bank  100 USD\n    equity:opening\n",
      },
    });
    const load = vi.fn(api.loadFile);
    render(
      <OpenLiaOpenUIProvider value={{ loadFile: load }}>
        <Renderer
          library={openliaLibrary}
          response={'root = FinanceOverview("finance/partial.hledger")'}
        />
      </OpenLiaOpenUIProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Could not load"),
    );
    expect(
      screen.getByText(/Incomplete includes; totals unavailable/),
    ).toBeDefined();
    expect(screen.queryByText("Monthly cashflow")).toBeNull();
  });
});
