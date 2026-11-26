import { readFileSync } from "node:fs";
import {
  describeOpenUI,
  MAX_OPENUI_INPUT,
  openUIAuthoringRequest,
  validateOpenUI,
} from "../src/shared/openuiAuthoring";

async function readStdinText(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_OPENUI_INPUT * 6 + 1024)
      throw new Error("Request too large");
    chunks.push(value);
  }
  return new Blob(chunks).text();
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "describe") {
    const component = args[1];
    console.log(JSON.stringify(describeOpenUI(component), null, 2));
  } else if (args[0] === "validate") {
    let format: "markdown" | "openui" = "markdown";
    let filePath: string | undefined;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if ((arg === "--format" || arg === "-f") && args[i + 1]) {
        const val = args[++i];
        if (val !== "markdown" && val !== "openui") {
          throw new Error("--format must be markdown or openui");
        }
        format = val;
      } else if (arg === "--file" && args[i + 1]) {
        filePath = args[++i];
      } else if (arg && !arg.startsWith("-") && !filePath) {
        filePath = arg;
      }
    }
    const content = filePath
      ? readFileSync(filePath, "utf8")
      : await readStdinText();
    if (content.length > MAX_OPENUI_INPUT) {
      throw new Error(
        `content must be a string of at most ${MAX_OPENUI_INPUT} characters`,
      );
    }
    const result = validateOpenUI(content, format);
    console.log(JSON.stringify(result, null, 2));
    if (result.valid === false) {
      process.exitCode = 1;
    }
  } else {
    const input = await readStdinText();
    console.log(JSON.stringify(openUIAuthoringRequest(JSON.parse(input))));
  }
} catch (error) {
  console.log(
    JSON.stringify({
      status: "error",
      validationLevel: "none",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
