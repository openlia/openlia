import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MarkdownPreview } from "../components/editor/MarkdownPreview";
import { openUIRecipes } from "../../shared/openuiRecipes";
import {
  openliaOpenUISchema,
  openUIPropOrder,
} from "../../shared/openuiSchema";
import { openliaLibrary } from "./library";

test("the server catalog stays aligned with the actual renderer registry", () => {
  const renderer = openliaLibrary.toJSONSchema();
  expect(Object.keys(renderer.properties ?? {}).sort()).toEqual(
    Object.keys(openliaOpenUISchema.properties).sort(),
  );
  const contract = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(contract);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "$schema" && key !== "description")
        .map(([key, item]) => [key, contract(item)]),
    );
  };
  for (const [name, definition] of Object.entries(renderer.$defs ?? {})) {
    // Renderer descriptions and dialect annotations do not change validation.
    expect(contract(definition), name).toEqual(
      contract(openliaOpenUISchema.$defs[name]),
    );
    expect(
      Object.keys(
        (definition as { properties?: Record<string, unknown> }).properties ??
          {},
      ),
      name,
    ).toEqual(openUIPropOrder[name]);
  }
});

test.each(
  openUIRecipes,
)("recipe $name renders without diagnostics or runtime fallback", (recipe) => {
  const { container } = render(
    <MarkdownPreview
      currentFilePath="examples/overview.md"
      content={`# Recipe\n\nBefore\n\n\`\`\`openui\n${recipe.code}\n\`\`\`\n\nAfter`}
    />,
  );
  expect(screen.getByTestId("inline-openui-block")).toBeInTheDocument();
  expect(screen.queryByTestId("inline-openui-error")).toBeNull();
  expect(
    container.querySelector('[aria-label="OpenUI render error"]'),
  ).toBeNull();
  expect(screen.getByText("After")).toBeInTheDocument();
  if (recipe.name === "table")
    expect(screen.getByRole("cell", { name: "Phở bò" })).toBeInTheDocument();
  if (recipe.name === "tabs") {
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByText("More information")).toBeInTheDocument();
  }
});
