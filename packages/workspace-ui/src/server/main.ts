import { createConfiguredWorkspaceHandler } from "./runtime";

function portFromEnvironment(value: string | undefined): number {
  const port = Number(value ?? "8089");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      "OPENLIA_WORKSPACE_UI_PORT must be an integer between 1 and 65535",
    );
  }
  return port;
}

const bind = process.env.OPENLIA_WORKSPACE_UI_BIND ?? "127.0.0.1";
const port = portFromEnvironment(process.env.OPENLIA_WORKSPACE_UI_PORT);
const handler = createConfiguredWorkspaceHandler();
const server = Bun.serve({
  fetch(request, instance) {
    if (
      request.method === "GET" &&
      /^\/api\/chat\/runs\/[^/]+\/events$/.test(new URL(request.url).pathname)
    )
      instance.timeout(request, 0);
    return handler(request, instance.requestIP(request)?.address ?? "global");
  },
  hostname: bind,
  port,
});

console.log(`workspace-ui listening on ${bind}:${port}`);

export { server };
