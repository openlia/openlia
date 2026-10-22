import { existsSync, lstatSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
// The Start server bundle is generated immediately before this launcher is bundled.
// @ts-expect-error The generated Vite server entry has no source declaration.
import startEntry from "../../dist/server/server.js";
import { createConfiguredWorkspaceHandler } from "./runtime";

const bind = process.env.OPENLIA_WORKSPACE_UI_BIND ?? "127.0.0.1";
const port = Number(process.env.OPENLIA_WORKSPACE_UI_PORT ?? "8089");
const clientRoot = resolve(import.meta.dir, "client");
const legacyHandler = createConfiguredWorkspaceHandler();

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function portFromEnvironment(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      "OPENLIA_WORKSPACE_UI_PORT must be an integer between 1 and 65535",
    );
  }
  return value;
}

function clientAsset(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (request.method !== "GET" || !url.pathname.startsWith("/assets/"))
    return undefined;
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return undefined;
  }
  const absolute = resolve(clientRoot, relativePath);
  if (absolute !== clientRoot && !absolute.startsWith(clientRoot + sep)) {
    return undefined;
  }
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return undefined;
  return new Response(Bun.file(absolute), {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type":
        contentTypes[extname(absolute).toLowerCase()] ??
        "application/octet-stream",
    },
  });
}

const server = Bun.serve({
  async fetch(request, instance) {
    const url = new URL(request.url);
    const clientAddress = instance.requestIP(request)?.address;
    if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
      return legacyHandler(
        request,
        instance.requestIP(request)?.address ?? "global",
      );
    }
    if (clientAddress) {
      Object.defineProperty(request, "context", {
        configurable: true,
        value: { clientAddress },
      });
    }
    const assetResponse = clientAsset(request);
    if (assetResponse) return assetResponse;
    const response: Response = await startEntry.fetch(request);
    if (url.pathname === "/share" || url.pathname.startsWith("/share/")) {
      const headers = new Headers(response.headers);
      headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
  hostname: bind,
  port: portFromEnvironment(port),
});

console.log(`workspace-ui listening on ${bind}:${port}`);

export { server };
