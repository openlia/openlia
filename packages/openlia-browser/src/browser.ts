import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  McpError,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

export type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
};

function resultText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" || item.type === undefined)
    .map((item) => item.text ?? "")
    .join("");
}

export class McpClient {
  readonly baseUrl: string;
  readonly host: string;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private connectPromise: Promise<void> | undefined;
  private controller = new AbortController();
  private closed = false;
  private generation = 0;

  constructor(baseUrl = "http://localhost:8931/mcp") {
    const endpoint = new URL(baseUrl || "http://localhost:8931/mcp");
    if (endpoint.pathname === "/" || endpoint.pathname === "")
      endpoint.pathname = "/mcp";
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/mcp";
    this.baseUrl = endpoint.href.replace(/\/$/, "");
    this.host = `localhost:${endpoint.port || "8931"}`;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("MCP session is closed");
    if (this.client) return;
    if (!this.connectPromise) {
      const generation = ++this.generation;
      this.connectPromise = (async () => {
        const transport = new StreamableHTTPClientTransport(
          new URL(this.baseUrl),
          { requestInit: { headers: { Host: this.host } } },
        );
        const client = new Client(
          { name: "openlia-browser", version: "0.2.0" },
          { capabilities: {} },
        );
        try {
          await client.connect(transport as Transport, {
            signal: this.controller.signal,
            timeout: 15_000,
          });
          if (this.closed || this.generation !== generation) {
            await client.close().catch(() => undefined);
            throw new Error("MCP connection was superseded");
          }
          this.transport = transport;
          this.client = client;
        } catch (error) {
          await transport.close().catch(() => undefined);
          throw error;
        }
      })().finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    timeout = 90_000,
    signal = this.controller.signal,
  ): Promise<unknown> {
    await this.connect();
    const client = this.client;
    const transport = this.transport;
    const generation = this.generation;
    if (!client || !transport) throw new Error("MCP connection failed");
    try {
      if (method === "tools/list")
        return await client.listTools(params, { signal, timeout });
      if (method === "ping") return await client.ping({ signal, timeout });
      return await client.request({ method, params } as never, ResultSchema, {
        signal,
        timeout,
      });
    } catch (error) {
      if (this.isConnectionFailure(error, signal))
        this.invalidate(client, transport, generation);
      throw error;
    }
  }

  async callTool(
    name: string,
    argumentsValue: Record<string, unknown>,
    timeout = 90_000,
    signal = this.controller.signal,
  ): Promise<ToolResult> {
    await this.connect();
    const client = this.client;
    const transport = this.transport;
    const generation = this.generation;
    if (!client || !transport) throw new Error("MCP connection failed");
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await client.callTool(
        { name, arguments: argumentsValue },
        undefined,
        { signal, timeout },
      );
    } catch (error) {
      if (this.isConnectionFailure(error, signal))
        this.invalidate(client, transport, generation);
      throw error;
    }
    if (!result || typeof result !== "object")
      throw new Error(`MCP tool ${name} returned no result`);
    return result as unknown as ToolResult;
  }

  getToolText(result: ToolResult): string {
    return resultText(result);
  }

  close(): void {
    this.closed = true;
    this.generation += 1;
    this.controller.abort();
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    void (async () => {
      await transport?.terminateSession().catch(() => undefined);
      await client?.close().catch(() => undefined);
    })();
  }

  private invalidate(
    client: Client,
    transport: StreamableHTTPClientTransport,
    generation: number,
  ): void {
    if (this.closed || this.generation !== generation || this.client !== client)
      return;
    this.generation += 1;
    this.controller.abort();
    this.client = undefined;
    this.transport = undefined;
    this.controller = new AbortController();
    void (async () => {
      await transport.terminateSession().catch(() => undefined);
      await client
        .close()
        .catch(() => transport.close().catch(() => undefined));
    })();
  }

  private isConnectionFailure(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;
    if (error instanceof StreamableHTTPError) return true;
    if (error instanceof McpError)
      return (
        error.code === ErrorCode.ConnectionClosed &&
        !/cancel/i.test(error.message)
      );
    if (error instanceof TypeError) return true;
    const code =
      error && typeof error === "object"
        ? String(
            (error as { code?: unknown; cause?: { code?: unknown } }).code ??
              (error as { cause?: { code?: unknown } }).cause?.code ??
              "",
          )
        : "";
    return new Set([
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPIPE",
    ]).has(code);
  }
}
