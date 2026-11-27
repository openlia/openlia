import type { LibraryJSONSchema } from "@openuidev/lang-core";
import { z } from "zod";
import { calendarOpenUIProps } from "./calendar";
import { chartOpenUIProps } from "./charts";
import { tableLayoutSchema, tablePaginationSchema } from "./table";
import upstreamSchema from "./upstreamOpenUISchema.json";

type JSONSchemaDef = NonNullable<LibraryJSONSchema["$defs"]>[string];

// Keep the parser and named-argument normalization independent of React views.
const upstream = upstreamSchema as unknown as LibraryJSONSchema;
export const openliaOpenUISchema: LibraryJSONSchema & {
  properties: Record<string, unknown>;
  $defs: Record<string, JSONSchemaDef>;
} = {
  ...upstream,
  properties: { ...(upstream.properties ?? {}) },
  $defs: { ...(upstream.$defs ?? {}) },
};
for (const [name, props] of Object.entries({
  ...calendarOpenUIProps,
  ...chartOpenUIProps,
})) {
  openliaOpenUISchema.$defs[name] = z.toJSONSchema(
    props,
  ) as unknown as JSONSchemaDef;
  openliaOpenUISchema.properties[name] = { $ref: `#/$defs/${name}` };
}

const upstreamTable = (openliaOpenUISchema.$defs.Table ?? {}) as {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};
openliaOpenUISchema.$defs.Table = {
  ...upstreamTable,
  description:
    "Responsive data table with configurable pagination and long-text layout.",
  properties: {
    ...upstreamTable.properties,
    pagination: z.toJSONSchema(tablePaginationSchema),
    layout: z.toJSONSchema(tableLayoutSchema),
  },
} as unknown as JSONSchemaDef;

export const openUIPropOrder = Object.fromEntries(
  Object.entries(openliaOpenUISchema.$defs).map(([name, schema]) => [
    name,
    Object.keys((schema as { properties?: object }).properties ?? {}),
  ]),
);
