import { createConfiguredWorkspaceHandler } from "./runtime";

const bind = process.env.OPENLIA_WORKSPACE_UI_BIND ?? "127.0.0.1";
const port = Number(process.env.OPENLIA_WORKSPACE_UI_PORT ?? "8089");

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      "OPENLIA_WORKSPACE_UI_PORT must be an integer between 1 and 65535",
    );
  }
  return value;
}

const handler = createConfiguredWorkspaceHandler();

const server = Bun.serve({
  fetch(request, instance) {
    const clientAddress = instance.requestIP(request)?.address ?? "global";
    return handler(request, clientAddress);
  },
  hostname: bind,
  port: validatePort(port),
});

console.log(`workspace-ui listening on ${bind}:${port}`);

export { server };
