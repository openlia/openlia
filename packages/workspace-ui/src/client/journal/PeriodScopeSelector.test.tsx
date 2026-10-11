import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PeriodScopeSelector } from "./PeriodScopeSelector";

describe("PeriodScopeSelector", () => {
  it("renders nothing when only 1 or 0 years are available", () => {
    const { container } = render(
      <PeriodScopeSelector
        availableYears={[2026]}
        onScopeChange={vi.fn()}
        scope={{ type: "all" }}
        scopedCount={10}
        totalCount={10}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders year buttons and calls onScopeChange when clicked", () => {
    const onScopeChange = vi.fn();
    render(
      <PeriodScopeSelector
        availableYears={[2026, 2025, 2024]}
        onScopeChange={onScopeChange}
        scope={{ type: "all" }}
        scopedCount={30}
        totalCount={30}
      />,
    );

    expect(
      screen.getByRole("button", { name: "All Time" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2025" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2024" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2025" }));
    expect(onScopeChange).toHaveBeenCalledWith({ type: "year", year: 2025 });
  });

  it("shows active year badge with reset button when year is selected", () => {
    const onScopeChange = vi.fn();
    render(
      <PeriodScopeSelector
        availableYears={[2026, 2025, 2024]}
        onScopeChange={onScopeChange}
        scope={{ type: "year", year: 2025 }}
        scopedCount={12}
        totalCount={30}
      />,
    );

    expect(screen.getByText("12 of 30 txs")).toBeInTheDocument();
    const resetBtn = screen.getByRole("button", { name: /Reset/i });
    expect(resetBtn).toBeInTheDocument();

    fireEvent.click(resetBtn);
    expect(onScopeChange).toHaveBeenCalledWith({ type: "all" });
  });

  it("renders overflow years dropdown when more than 3 years exist", () => {
    const onScopeChange = vi.fn();
    render(
      <PeriodScopeSelector
        availableYears={[2026, 2025, 2024, 2023, 2022]}
        onScopeChange={onScopeChange}
        scope={{ type: "all" }}
        scopedCount={50}
        totalCount={50}
      />,
    );

    expect(screen.getByText("More Years ▾")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2023" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2022" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2023" }));
    expect(onScopeChange).toHaveBeenCalledWith({ type: "year", year: 2023 });
  });
});
