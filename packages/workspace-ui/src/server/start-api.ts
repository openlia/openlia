import {
  getRequest,
  getRequestIP,
  setResponseHeader,
} from "@tanstack/react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { createConfiguredWorkspaceHandler } from "./runtime";

type WorkspaceMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface WorkspaceServerRequest {
  body?: unknown;
  method?: WorkspaceMethod;
  path: string;
}

export type JsonValue =
  | boolean
  | JsonValue[]
  | number
  | string
  | { [key: string]: JsonValue }
  | null;

export interface WorkspaceServerResponse {
  payload: JsonValue;
  status: number;
}

const maxServerFunctionBodyBytes = 2 * 1024 * 1024 + 64 * 1024;

function isWorkspaceServerRequest(
  value: unknown,
): value is WorkspaceServerRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    candidate.path.startsWith("/api/") &&
    !candidate.path.startsWith("//") &&
    (candidate.method === undefined ||
      ["DELETE", "GET", "PATCH", "POST", "PUT"].includes(
        candidate.method as string,
      ))
  );
}

let workspaceHandler: ReturnType<typeof createConfiguredWorkspaceHandler>;

function getWorkspaceHandler() {
  if (!workspaceHandler) workspaceHandler = createConfiguredWorkspaceHandler();
  return workspaceHandler;
}

export const workspaceServerRequest = createServerFn({ method: "POST" })
  .validator((value: unknown) => {
    if (!isWorkspaceServerRequest(value)) {
      throw new Error("invalid_workspace_request");
    }
    return value;
  })
  .handler(async ({ data }): Promise<WorkspaceServerResponse> => {
    const incoming = getRequest();
    const headers = new Headers(incoming.headers);
    const method = data.method ?? "GET";
    let body: string | undefined;

    if (data.body !== undefined) {
      body = JSON.stringify(data.body);
      if (
        new TextEncoder().encode(body).byteLength > maxServerFunctionBodyBytes
      ) {
        return {
          payload: {
            error: "request_too_large",
            ok: false,
            schema: 1,
          },
          status: 413,
        };
      }
      headers.set("content-type", "application/json");
    } else {
      headers.delete("content-type");
    }
    headers.delete("content-length");
    headers.delete("host");

    const request = new Request(new URL(data.path, incoming.url).toString(), {
      ...(body === undefined ? {} : { body }),
      headers,
      method,
    });
    const clientKey = getRequestIP() ?? "start-server";
    const response = await getWorkspaceHandler()(request, clientKey);
    const payload = (await response.json().catch(() => null)) as JsonValue;
    const cookie = response.headers.get("set-cookie");
    if (cookie) setResponseHeader("set-cookie", cookie);

    return { payload, status: response.status };
  });
