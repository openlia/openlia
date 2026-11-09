import { Renderer } from "@openuidev/react-lang";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { openUIErrors, normalizeOpenUIProgram } from "../../../shared/openui";
import { openliaLibrary } from "../library";

const columns = [
  { key: "meal", label: "Meal" },
  { key: "details", label: "Details" },
  { key: "recipe", label: "Recipe" },
];

const meals = Array.from({ length: 14 }, (_, index) => ({
  meal: `Meal ${index + 1}`,
  details: `Ingredients for meal ${index + 1}`,
  recipe: "https://youtu.be/example",
}));

function program(
  rows: Array<Record<string, string | number | boolean | null>>,
  options: {
    pagination?: Record<string, unknown>;
    layout?: Record<string, unknown>;
  } = {},
) {
  const optionArgs = [
    options.pagination === undefined
      ? ""
      : `, pagination: ${JSON.stringify(options.pagination)}`,
    options.layout === undefined
      ? ""
      : `, layout: ${JSON.stringify(options.layout)}`,
  ].join("");
  return `Table(title: "Weekly meals", columns: ${JSON.stringify(columns)}, rows: ${JSON.stringify(rows)}${optionArgs})`;
}

function renderTable(
  rows: Array<Record<string, string | number | boolean | null>>,
  options: {
    pagination?: Record<string, unknown>;
    layout?: Record<string, unknown>;
  } = {},
) {
  const source = program(rows, options);
  expect(openUIErrors(source), source).toEqual([]);
  return render(
    <Renderer
      library={openliaLibrary}
      response={normalizeOpenUIProgram(source)}
    />,
  );
}

test("keeps the 10-row default and allows navigation through all rows", () => {
  renderTable(meals);

  expect(screen.getAllByRole("row")).toHaveLength(11);
  expect(screen.getByRole("cell", { name: "Meal 10" })).toBeInTheDocument();
  expect(screen.queryByRole("cell", { name: "Meal 11" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getAllByRole("row")).toHaveLength(5);
  expect(screen.getByRole("cell", { name: "Meal 14" })).toBeInTheDocument();
  expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
});

test("a custom page size or disabled pagination shows all 14 rows", () => {
  const sized = renderTable(meals, { pagination: { pageSize: 14 } });
  expect(screen.getAllByRole("row")).toHaveLength(15);
  expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  sized.unmount();

  renderTable(meals, { pagination: { enabled: false } });
  expect(screen.getAllByRole("row")).toHaveLength(15);
  expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
});

test("showAllOption toggles between the current page and all rows", () => {
  renderTable(meals, {
    pagination: { pageSize: 10, showAllOption: true },
  });

  expect(screen.getAllByRole("row")).toHaveLength(11);
  fireEvent.click(screen.getByRole("button", { name: "Show all rows" }));
  expect(screen.getAllByRole("row")).toHaveLength(15);
  fireEvent.click(screen.getByRole("button", { name: "Show paginated rows" }));
  expect(screen.getAllByRole("row")).toHaveLength(11);
});

test("wraps long content, expands it on request, and only links safe URLs", () => {
  const longText = `Cooking method ${"with care ".repeat(35)}`;
  const rows = [
    {
      meal: "Lunch",
      details: longText,
      recipe: "https://www.youtube.com/watch?v=abc",
    },
    {
      meal: "Dinner",
      details: "Plain URL-like value",
      recipe: "javascript:alert(1)",
    },
  ];
  renderTable(rows, {
    pagination: { enabled: false },
    layout: { wrapText: true, expandLongText: true },
  });

  const link = screen.getByRole("link", { name: "Open YouTube in a new tab" });
  expect(link).toHaveAttribute("href", "https://www.youtube.com/watch?v=abc");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.queryByRole("link", { name: /javascript/i })).toBeNull();
  expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();

  const detailsCell = screen.getByRole("cell", { name: new RegExp(longText) });
  expect(detailsCell).toHaveClass("openlia-openui-table__cell--wrap");
  const expand = screen.getByRole("button", { name: "Show more" });
  fireEvent.click(expand);
  expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

test("supports the existing positional column-table syntax", () => {
  const source = 'Table([Col("Meal", ["Lunch", "Dinner"])])';
  expect(openUIErrors(source)).toEqual([]);
  render(
    <Renderer
      library={openliaLibrary}
      response={normalizeOpenUIProgram(source)}
    />,
  );
  expect(screen.getByRole("cell", { name: "Dinner" })).toBeInTheDocument();
});
