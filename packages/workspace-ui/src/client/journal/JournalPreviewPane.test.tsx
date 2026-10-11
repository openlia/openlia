import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JournalPreviewPane } from "./JournalPreviewPane";

describe("JournalPreviewPane", () => {
  const sampleJournal = `; Sample Payslip
2020-08-01 Payslip 2020-08
    assets:cash                                  20618182 VND
    expenses:tax:pit                              2290909 VND
    income:salary:payslip                       -22909091 VND
`;

  it("renders Sankey diagram and highlight cards", () => {
    render(
      <JournalPreviewPane
        content={sampleJournal}
        filePath="finance/journal.hledger"
      />,
    );

    // Sankey section exists
    expect(
      screen.getByRole("region", { name: "Sankey Diagram Flow" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Money Flow (Sankey Diagram)")).toBeInTheDocument();

    // Highlights section exists
    expect(
      screen.getByRole("region", { name: "Journal Highlights" }),
    ).toBeInTheDocument();
    expect(screen.getByText("TOTAL INCOME")).toBeInTheDocument();
    expect(screen.getByText("TOTAL EXPENSES")).toBeInTheDocument();
    expect(screen.getByText("NET RETAINED")).toBeInTheDocument();

    // Transactions breakdown exists
    expect(screen.getByText("Transactions (1)")).toBeInTheDocument();
    expect(screen.getByText("Payslip 2020-08")).toBeInTheDocument();
    expect(screen.getByText("assets:cash")).toBeInTheDocument();
    expect(
      screen.queryByRole("tablist", { name: "Journal currencies" }),
    ).not.toBeInTheDocument();
  });

  it("handles empty journal gracefully", () => {
    render(
      <JournalPreviewPane
        content="; only comments here"
        filePath="finance/journal.hledger"
      />,
    );

    expect(
      screen.getByText("No journal transactions detected"),
    ).toBeInTheDocument();
  });

  it("switches all journal views to a selected currency", () => {
    const multiCurrencyJournal = `2026-10-09 * Banh Mi
    expenses:food:dining                  15,000 VND
    assets:momo:wallet                   -15,000 VND

2026-10-09 * Claude
    expenses:technology:subscriptions      45.50 USD
    liabilities:credit_cards:visa         -45.50 USD

2026-10-08 * JetBrains
    expenses:technology:software           12.00 USD
    liabilities:credit_cards:visa         -12.00 USD

2026-10-07 * Cloudflare
    expenses:technology:hosting             8.99 USD
    liabilities:credit_cards:visa          -8.99 USD
`;

    render(
      <JournalPreviewPane
        content={multiCurrencyJournal}
        filePath="finance/journal.hledger"
      />,
    );

    expect(
      screen.getByRole("tablist", { name: "Journal currencies" }),
    ).toBeInTheDocument();
    expect(screen.getByText("$66.49")).toBeInTheDocument();
    expect(screen.getAllByText("15,000 ₫").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: /^USD$/ }));

    expect(screen.getAllByText("$66.49").length).toBeGreaterThan(0);
    expect(screen.getByText("Transactions (3)")).toBeInTheDocument();
    expect(screen.queryByText("expenses:food:dining")).not.toBeInTheDocument();
    expect(screen.queryByText("15,000 ₫")).not.toBeInTheDocument();
  });

  it("renders monthly cashflow trajectory and supports month scrubbing", () => {
    const multiMonthJournal = `2026-07-01 Payslip 2026-07
    assets:cash                                  60000000 VND
    income:salary:talentnet                     -60000000 VND

2026-07-15 * Phone installment
    expenses:electronics:phone                    5000000 VND
    assets:cash                                 -5000000 VND

2026-08-01 Payslip 2026-08
    assets:cash                                  65000000 VND
    income:salary:talentnet                     -65000000 VND

2026-08-10 * Dining
    expenses:food:dining                          1500000 VND
    assets:cash                                  -1500000 VND
`;

    render(
      <JournalPreviewPane
        content={multiMonthJournal}
        filePath="finance/journal.hledger"
      />,
    );

    // Monthly cashflow section exists
    expect(
      screen.getByRole("region", { name: "Monthly Cashflow Trajectory" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Monthly Cashflow Trajectory")).toBeInTheDocument();

    // Timeline view displays both months
    expect(screen.getByText("August 2026")).toBeInTheDocument();
    expect(screen.getByText("July 2026")).toBeInTheDocument();
    expect(screen.getByText("Transactions (4)")).toBeInTheDocument();

    // Click on August bar button to scrub/filter to August only
    const augBtn = screen.getByRole("button", { name: /Select August 2026/i });
    fireEvent.click(augBtn);

    expect(screen.getByText("Transactions (2)")).toBeInTheDocument();
    expect(screen.getByText("Payslip 2026-08")).toBeInTheDocument();
    expect(screen.queryByText("Payslip 2026-07")).not.toBeInTheDocument();

    // Clicking it again clears the month filter
    fireEvent.click(augBtn);
    expect(screen.getByText("Transactions (4)")).toBeInTheDocument();
    expect(screen.getByText("Payslip 2026-07")).toBeInTheDocument();
  });

  it("filters transactions by type (income, expense)", () => {
    const journal = `2026-08-01 Payslip
    assets:cash                                  65000000 VND
    income:salary:talentnet                     -65000000 VND

2026-08-10 * Dining
    expenses:food:dining                          1500000 VND
    assets:cash                                  -1500000 VND
`;

    render(
      <JournalPreviewPane
        content={journal}
        filePath="finance/journal.hledger"
      />,
    );

    expect(screen.getByText("Transactions (2)")).toBeInTheDocument();

    // Filter to expense
    fireEvent.click(screen.getByRole("button", { name: /^expense$/i }));
    expect(screen.getByText("Transactions (1)")).toBeInTheDocument();
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.queryByText("Payslip")).not.toBeInTheDocument();

    // Filter to income
    fireEvent.click(screen.getByRole("button", { name: /^income$/i }));
    expect(screen.getByText("Transactions (1)")).toBeInTheDocument();
    expect(screen.getByText("Payslip")).toBeInTheDocument();
    expect(screen.queryByText("Dining")).not.toBeInTheDocument();
  });

  it("toggles sort order and view mode", () => {
    const journal = `2026-08-01 Payslip 1
    assets:cash                                  10000000 VND
    income:salary                               -10000000 VND

2026-08-15 Payslip 2
    assets:cash                                  10000000 VND
    income:salary                               -10000000 VND
`;

    render(
      <JournalPreviewPane
        content={journal}
        filePath="finance/journal.hledger"
      />,
    );

    // Toggle sort order
    const sortBtn = screen.getByRole("button", { name: /↓ Newest/i });
    fireEvent.click(sortBtn);
    expect(
      screen.getByRole("button", { name: /↑ Oldest/i }),
    ).toBeInTheDocument();

    // Toggle view mode to compact
    const compactBtn = screen.getByRole("button", { name: "Compact" });
    fireEvent.click(compactBtn);
    expect(compactBtn).toHaveClass("btn-neutral");
  });
});
