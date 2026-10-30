import {
  MAX_OPENUI_INPUT,
  openUIAuthoringRequest,
} from "../src/shared/openuiAuthoring";

// JSON over stdin only: no workspace reads/writes, network, or evaluation.
try {
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
  const input = await new Blob(chunks).text();
  console.log(JSON.stringify(openUIAuthoringRequest(JSON.parse(input))));
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
