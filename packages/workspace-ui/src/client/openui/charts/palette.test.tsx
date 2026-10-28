import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  CHART_COLORS,
  CATEGORICAL_COLORS,
  chartColorsFor,
  colorForKey,
  openUIPalette,
} from "./palette";
import { SankeyDiagramView } from "./SankeyDiagram";

it("keeps category identity through sorting, filtering, and explicit overrides", () => {
  const domain = ["Food", "Travel", "Utilities"];
  expect(chartColorsFor(domain, undefined, domain, [300, 500, 200])).toEqual([
    CHART_COLORS.expenses,
    CHART_COLORS.income,
    CHART_COLORS.balance,
  ]);
  expect(
    chartColorsFor(["Utilities", "Food"], undefined, domain, [600, 100]),
  ).toEqual([CHART_COLORS.balance, CHART_COLORS.income]);
  expect(
    chartColorsFor(
      ["Income", "Expense"],
      [CHART_COLORS.income, CHART_COLORS.expenses],
      undefined,
    ),
  ).toEqual([CHART_COLORS.income, CHART_COLORS.expenses]);
  expect(colorForKey("persistent-account")).toBe(
    colorForKey("persistent-account"),
  );
  expect(
    chartColorsFor(
      ["2026", "2025"],
      [CHART_COLORS.income, CHART_COLORS.expenses],
      undefined,
    ),
  ).toEqual([CHART_COLORS.expenses, CHART_COLORS.income]);
});

it("adapts palettes to the upstream midpoint distribution without mutating them", () => {
  const distributed = (colors: string[], count: number) => {
    const middle = Math.floor(colors.length / 2);
    if (count === 1) return [colors[middle]];
    if (count === 2)
      return [
        colors[Math.max(middle - 1, 0)],
        colors[Math.min(middle + 1, colors.length - 1)],
      ];
    return Array.from(
      { length: count },
      (_, index) =>
        colors[
          (middle + index - Math.floor((count - 1) / 2) + colors.length) %
            colors.length
        ],
    );
  };
  for (let count = 1; count <= CATEGORICAL_COLORS.length; count++) {
    const colors = CATEGORICAL_COLORS.slice(0, count);
    const before = [...colors];
    expect(distributed(openUIPalette(colors), count)).toEqual(colors);
    expect(colors).toEqual(before);
  }
});

it("keeps Sankey colors stable when input order and the visible nodes change", () => {
  const a = { id: "a", label: "A" };
  const b = { id: "b", label: "B" };
  const c = { id: "c", label: "C" };
  const nodes = [a, b, c];
  const ab = { source: "a", target: "b", value: 5 };
  const bc = { source: "b", target: "c", value: 5 };
  const links = [ab, bc];
  const { container, rerender } = render(
    <SankeyDiagramView nodes={nodes} links={links} />,
  );
  const before = container
    .querySelector('[data-color-key="b"]')
    ?.getAttribute("fill");
  rerender(<SankeyDiagramView nodes={[c, b]} links={[bc]} />);
  expect(
    container.querySelector('[data-color-key="b"]')?.getAttribute("fill"),
  ).toBe(before);
});

it("separates SVG gradient IDs for two charts on the same page", () => {
  const nodes = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];
  const links = [{ source: "a", target: "b", value: 1 }];
  const { container } = render(
    <>
      <SankeyDiagramView nodes={nodes} links={links} />
      <SankeyDiagramView nodes={nodes} links={links} />
    </>,
  );
  const ids = [...container.querySelectorAll("linearGradient")].map(
    (gradient) => gradient.id,
  );
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});
