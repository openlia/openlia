import { extractMarkdownOpenUIBlocks, openUIDiagnostics } from "./openui";
import { openUIRecipes } from "./openuiRecipes";
import { openliaOpenUISchema, openUIPropOrder } from "./openuiSchema";

export const MAX_OPENUI_INPUT = 262_144;

export function describeOpenUI(component?: string) {
  const components = Object.keys(openliaOpenUISchema.properties).sort();
  if (!component)
    return {
      status: "ok",
      components,
      guidance:
        "Request a component for its schema, positional order, and tested recipes. Prefer named arguments. Table additionally supports literal columns/rows/title.",
      recipes: openUIRecipes.map(({ name, components }) => ({
        name,
        components,
      })),
    };
  if (!components.includes(component))
    return {
      status: "error",
      code: "unknown-component",
      message: `Unknown component '${component}'. Choose from components.`,
      components,
    };
  const schema = openliaOpenUISchema.$defs[component];
  // Do not recursively expand container child unions into the whole catalog.
  const references = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (
        key === "$ref" &&
        typeof item === "string" &&
        item.startsWith("#/$defs/")
      ) {
        const name = item.slice("#/$defs/".length);
        if (name !== component) references.add(name);
      } else visit(item);
    }
  };
  visit(schema);
  return {
    status: "ok",
    component,
    schema,
    referencedComponents: [...references].sort(),
    referenceGuidance:
      "Resolve #/$defs/Name references with openui_describe(component: Name) as needed.",
    positionalOrder: openUIPropOrder[component],
    recipes: openUIRecipes.filter((recipe) =>
      recipe.components.includes(component),
    ),
    ...(component === "Table"
      ? {
          rowTable: {
            description:
              "Authoring shorthand; normalized before upstream schema validation. Cells must be string, number, boolean, or null. Columns and rows must be literals.",
            columns: "Array<{key: string, label: string}>",
            rows: "Array<Record<string, string | number | boolean | null>>",
            title: "optional string",
          },
        }
      : {}),
  };
}

export function validateOpenUI(content: string, format: "markdown" | "openui") {
  const blocks =
    format === "markdown"
      ? extractMarkdownOpenUIBlocks(content)
      : [{ code: content, startLine: 1, endLine: content.split("\n").length }];
  const results = blocks.map((block, index) => {
    const diagnostics = openUIDiagnostics(block.code);
    return {
      block: index + 1,
      startLine: block.startLine,
      endLine: block.endLine,
      locationScope: "block" as const,
      diagnostics,
    };
  });
  return {
    status: "ok",
    validationLevel: results.length ? "schema" : "none",
    valid: results.length
      ? results.every((block) => !block.diagnostics.length)
      : null,
    blockCount: results.length,
    blocks: results,
    renderingVerified: false,
    note: blocks.length
      ? "Uses the UI normalizer and component schemas. Locations identify the original block, not an exact error column. Does not verify runtime rendering, live data, or capabilities."
      : "No OpenUI fences found; no views were validated.",
  };
}

/** Strict, read-only JSON protocol shared by the CLI and its tests. */
export function openUIAuthoringRequest(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected a JSON object");
  const request = input as Record<string, unknown>;
  if (request.action === "describe") {
    if (
      request.component !== undefined &&
      (typeof request.component !== "string" || request.component.length > 100)
    )
      throw new Error("component must be a string of at most 100 characters");
    return describeOpenUI(request.component as string | undefined);
  }
  if (request.action === "validate") {
    if (
      typeof request.content !== "string" ||
      request.content.length > MAX_OPENUI_INPUT
    )
      throw new Error(
        `content must be a string of at most ${MAX_OPENUI_INPUT} characters`,
      );
    if (request.format !== "markdown" && request.format !== "openui")
      throw new Error("format must be markdown or openui");
    return validateOpenUI(request.content, request.format);
  }
  throw new Error("action must be describe or validate");
}
