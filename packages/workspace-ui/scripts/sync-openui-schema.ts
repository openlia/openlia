import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openuiLibrary } from "@openuidev/react-ui";

const schemaPath = resolve(
  __dirname,
  "../src/shared/upstreamOpenUISchema.json",
);

const currentObject = openuiLibrary.toJSONSchema();
const shouldWrite =
  process.argv.includes("--write") || process.argv.includes("-w");

if (shouldWrite) {
  writeFileSync(schemaPath, `${JSON.stringify(currentObject, null, 2)}\n`);
  console.log("Updated upstreamOpenUISchema.json successfully.");
} else {
  let existing = "";
  try {
    existing = readFileSync(schemaPath, "utf8");
  } catch {
    console.error(`Missing schema file at ${schemaPath}`);
    process.exit(1);
  }
  let existingObject: unknown;
  try {
    existingObject = JSON.parse(existing);
  } catch {
    console.error(`Invalid JSON in schema file at ${schemaPath}`);
    process.exit(1);
  }
  if (JSON.stringify(existingObject) !== JSON.stringify(currentObject)) {
    console.error(
      "upstreamOpenUISchema.json is out of sync with @openuidev/react-ui.\nRun 'bun run sync:schema' to update it.",
    );
    process.exit(1);
  }
  console.log("upstreamOpenUISchema.json is in sync with @openuidev/react-ui.");
}
