import { openuiLibrary } from "@openuidev/react-ui";
import { z } from "zod";
import { calendarOpenUIProps } from "./calendar";
import { chartOpenUIProps } from "./charts";
import { financeOpenUIProps } from "./finance";
import { tableLayoutSchema, tablePaginationSchema } from "./table";

// Keep the server parser and named-argument normalization independent of React views.
const upstream = openuiLibrary.toJSONSchema();
export const openliaOpenUISchema = {
  ...upstream,
  properties: { ...upstream.properties },
  $defs: { ...upstream.$defs },
};
for (const [name, props] of Object.entries({
  ...calendarOpenUIProps,
  ...chartOpenUIProps,
  ...financeOpenUIProps,
})) {
  openliaOpenUISchema.$defs[name] = z.toJSONSchema(
    props,
  ) as (typeof openliaOpenUISchema.$defs)[string];
  openliaOpenUISchema.properties[name] = { $ref: `#/$defs/${name}` };
}

const upstreamTable = openliaOpenUISchema.$defs.Table as {
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
};

export const openUIPropOrder = Object.fromEntries(
  Object.entries(openliaOpenUISchema.$defs).map(([name, schema]) => [
    name,
    Object.keys((schema as { properties?: object }).properties ?? {}),
  ]),
);
