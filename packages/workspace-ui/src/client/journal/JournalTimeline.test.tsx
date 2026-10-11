import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JournalTimeline } from "./JournalTimeline";
import { parseHledgerJournal } from "./parser";

describe("JournalTimeline", () => {
  const sampleContent = `2026-07-01 Payslip 2026-07
    assets:cash                                  63710000 VND
    income:salary:talentnet                     -63710000 VND

2026-07-15 * Phone installment
    expenses:electronics:phone                    4970000 VND
    assets:cash                                 -4970000 VND

2026-08-01 Payslip 2026-08
    assets:cash                                  63710000 VND
    income:salary:talentnet                     -63710000 VND

2026-08-10 * Dining
    expenses:food:dining                          1500000 VND
    assets:cash                                  -1500000 VND
`;

  it("renders month milestone headers with transaction rollups", () => {
    const parsed = parseHledgerJournal(sampleContent);
    render(
      <JournalTimeline
        currency="VND"
        order="desc"
        transactions={parsed.transactions}
        viewMode="timeline"
      />,
    );

    expect(screen.getByText("August 2026")).toBeInTheDocument();
    expect(screen.getByText("July 2026")).toBeInTheDocument();

    expect(screen.getByText("Payslip 2026-08")).toBeInTheDocument();
    expect(screen.getByText("Phone installment")).toBeInTheDocument();

    // Check August rollup chips
    const augGroup = screen.getByTestId("month-group-2026-08");
    expect(augGroup).toHaveTextContent("+63.71M ₫ in");
    expect(augGroup).toHaveTextContent("-1.5M ₫ out");
    expect(augGroup).toHaveTextContent("Net: +62.21M ₫");
  });

  it("toggles collapse state of a month section", () => {
    const parsed = parseHledgerJournal(sampleContent);
    render(
      <JournalTimeline
        currency="VND"
        order="desc"
        transactions={parsed.transactions}
        viewMode="timeline"
      />,
    );

    expect(screen.getByText("Payslip 2026-08")).toBeInTheDocument();

    const augHeaderButton = screen.getByRole("button", {
      name: /August 2026/i,
    });
    fireEvent.click(augHeaderButton);

    // Collapsed: transactions under August are hidden
    expect(screen.queryByText("Payslip 2026-08")).not.toBeInTheDocument();
    // July remains visible
    expect(screen.getByText("Payslip 2026-07")).toBeInTheDocument();

    // Re-expanding
    fireEvent.click(augHeaderButton);
    expect(screen.getByText("Payslip 2026-08")).toBeInTheDocument();
  });

  it("calls onSwitchToEdit when line number button is clicked", () => {
    const parsed = parseHledgerJournal(sampleContent);
    const onSwitch = vi.fn();
    render(
      <JournalTimeline
        currency="VND"
        onSwitchToEdit={onSwitch}
        order="desc"
        transactions={parsed.transactions}
      />,
    );
    const lineButtons = screen.getAllByRole("button", { name: /Line \d+/i });
    const firstBtn = lineButtons[0];
    expect(firstBtn).toBeDefined();
    if (firstBtn) {
      fireEvent.click(firstBtn);
    }
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("calls onFilterAccount when account link is clicked", () => {
    const parsed = parseHledgerJournal(sampleContent);
    const onFilterAccount = vi.fn();
    render(
      <JournalTimeline
        currency="VND"
        onFilterAccount={onFilterAccount}
        order="desc"
        transactions={parsed.transactions}
      />,
    );

    const diningAccount = screen.getByRole("button", {
      name: "expenses:food:dining",
    });
    fireEvent.click(diningAccount);
    expect(onFilterAccount).toHaveBeenCalledWith("expenses:food:dining");
  });
});
