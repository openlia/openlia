import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpClient } from "./browser";

const bind = process.env.OPENLIA_BROWSER_BIND ?? "127.0.0.1";
const port = Number(process.env.OPENLIA_BROWSER_PORT ?? "8932");
const mcpUrl = (
  process.env.OPENLIA_BROWSER_MCP_URL ?? "http://127.0.0.1:8931/mcp"
).replace(/\/+$/, "");
const dataRoot = resolve(
  process.env.OPENLIA_BROWSER_DATA_ROOT ??
    resolve(homedir(), "services", "openlia-browser", "data"),
);
const tokenFile = process.env.OPENLIA_BROWSER_TOKEN_FILE ?? "";
const configuredToken = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
const requireAuth = process.env.OPENLIA_BROWSER_REQUIRE_AUTH === "1";
const supervisePlaywright =
  process.env.OPENLIA_BROWSER_SUPERVISE_PLAYWRIGHT === "1";
const playwrightPort = Number(
  process.env.OPENLIA_BROWSER_PLAYWRIGHT_PORT ?? "8931",
);
const playwrightTokenFile =
  process.env.OPENLIA_BROWSER_PLAYWRIGHT_TOKEN_FILE ?? "";
const maxBodyBytes = 1024 * 1024;
const mcpSessionIdleMs = Number(
  process.env.OPENLIA_BROWSER_MCP_SESSION_IDLE_MS ?? "900000",
);
function positiveFiniteEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive finite number`);
  return value;
}

const browserLeaseTtlMs = positiveFiniteEnv(
  "OPENLIA_BROWSER_LEASE_TTL_MS",
  300_000,
);
const browserLeaseMaxMs = positiveFiniteEnv(
  "OPENLIA_BROWSER_LEASE_MAX_MS",
  1_800_000,
);
const browserQueueTtlMs = positiveFiniteEnv(
  "OPENLIA_BROWSER_QUEUE_TTL_MS",
  1_800_000,
);
const allowedOrigins = new Set(
  (process.env.OPENLIA_BROWSER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const defaultBrowserToolAllowlist = [
  "openlia_browser_session_request",
  "openlia_browser_session_status",
  "openlia_browser_session_touch",
  "openlia_browser_session_release",
  "openlia_browser_session_cancel",
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_hover",
  "browser_tabs",
  "browser_wait_for",
  "browser_take_screenshot",
  "browser_handle_dialog",
  "browser_close",
];
const allowedDownstreamToolNames = new Set(
  (
    process.env.OPENLIA_BROWSER_ALLOWED_TOOLS ??
    defaultBrowserToolAllowlist.join(",")
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const mutatingToolNames = new Set([
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_handle_dialog",
  "browser_close",
]);
const maxCachedOperations = 128;

mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: IncomingMessage): boolean {
  if (!requireAuth) return true;
  const header = request.headers.authorization ?? "";
  return (
    header.startsWith("Bearer ") &&
    constantTimeEqual(header.slice("Bearer ".length), configuredToken)
  );
}

function json(
  response: ServerResponse,
  payload: JsonObject,
  status = 200,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<JsonObject | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBodyBytes) return null;
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

type InteractiveSession = {
  id: string;
  client?: McpClient;
  connectPromise: Promise<McpClient> | undefined;
  activeCalls: number;
  closing: boolean;
  lastSeen: number;
};

type HttpMcpSession = InteractiveSession & {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const httpSessions = new Map<string, HttpMcpSession>();
let playwright: ChildProcess | undefined;
let stopping = false;
let playwrightRestarts = 0;

type QueuedBrowserRequest = {
  ticket: string;
  requestKey: string | undefined;
  purpose: string;
  ttlMs: number;
  queuedAt: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type ActiveBrowserLease = {
  ticket: string;
  token: string;
  requestKey: string | undefined;
  generation: number;
  purpose: string;
  ttlMs: number;
  expiresAt: number;
  hardExpiresAt: number;
  activeCalls: number;
  fenced: boolean;
  expiredPending: boolean;
  releasePending: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  callChain: Promise<void>;
  operationCache: Map<string, CachedBrowserOperation>;
};

type CachedBrowserOperation = {
  argumentsKey: string;
  outcome: "success" | "uncertain";
  result?: unknown;
};

type BrowserLeaseResponse = JsonObject & {
  state: "active" | "queued";
  ticket: string;
  queue_position: number | null;
};

const controlToolNames = new Set([
  "openlia_browser_session_request",
  "openlia_browser_session_status",
  "openlia_browser_session_touch",
  "openlia_browser_session_release",
  "openlia_browser_session_cancel",
]);

const controlTools = [
  {
    name: "openlia_browser_session_request",
    description:
      "Request the shared browser lease without waiting in the MCP call.",
    inputSchema: {
      type: "object",
      properties: {
        purpose: { type: "string", minLength: 1, maxLength: 200 },
        request_key: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["purpose"],
      additionalProperties: false,
    },
  },
  {
    name: "openlia_browser_session_status",
    description: "Return a browser task's lease or queue state.",
    inputSchema: {
      type: "object",
      properties: { ticket: { type: "string" } },
      required: ["ticket"],
      additionalProperties: false,
    },
  },
  {
    name: "openlia_browser_session_touch",
    description: "Extend an active browser task's lease.",
    inputSchema: {
      type: "object",
      properties: { lease: { type: "string" } },
      required: ["lease"],
      additionalProperties: false,
    },
  },
  {
    name: "openlia_browser_session_release",
    description: "Release an active browser task's lease.",
    inputSchema: {
      type: "object",
      properties: { lease: { type: "string" } },
      required: ["lease"],
      additionalProperties: false,
    },
  },
  {
    name: "openlia_browser_session_cancel",
    description: "Cancel a queued browser task or active browser lease.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        lease: { type: "string" },
      },
      additionalProperties: false,
    },
  },
] as const;

function leaseResponse(
  lease: ActiveBrowserLease,
  queuePosition: number | null,
): BrowserLeaseResponse {
  return {
    state: "active",
    ticket: lease.ticket,
    lease: lease.token,
    queue_position: queuePosition,
    purpose: lease.purpose,
    expires_at: lease.expiresAt,
    hard_expires_at: lease.hardExpiresAt,
    generation: lease.generation,
    fenced: lease.fenced,
    expired_pending: lease.expiredPending,
    release_pending: lease.releasePending,
  };
}

function queuedResponse(
  request: QueuedBrowserRequest,
  queuePosition: number,
): BrowserLeaseResponse {
  return {
    state: "queued",
    ticket: request.ticket,
    queue_position: queuePosition,
    purpose: request.purpose,
    queued_at: request.queuedAt,
    queue_expires_at: request.expiresAt,
  };
}

class BrowserLeaseManager {
  private active: ActiveBrowserLease | undefined;
  private queue: QueuedBrowserRequest[] = [];
  private generation = 0;

  request(
    purpose: string,
    requestKey: string | undefined,
  ): BrowserLeaseResponse {
    this.reap();
    if (requestKey !== undefined) {
      if (this.active?.requestKey === requestKey)
        return leaseResponse(this.active, null);
      const queued = this.queue.find((item) => item.requestKey === requestKey);
      if (queued) return queuedResponse(queued, this.queue.indexOf(queued) + 1);
    }
    const ticket = randomUUID();
    if (!this.active && this.queue.length === 0)
      return leaseResponse(
        this.grant(ticket, purpose, browserLeaseTtlMs, requestKey),
        null,
      );
    const now = Date.now();
    const request: QueuedBrowserRequest = {
      ticket,
      requestKey,
      purpose,
      ttlMs: browserLeaseTtlMs,
      queuedAt: now,
      expiresAt: now + browserQueueTtlMs,
      timer: setTimeout(() => this.expireQueued(ticket), browserQueueTtlMs),
    };
    request.timer.unref?.();
    this.queue.push(request);
    return queuedResponse(request, this.queue.length);
  }

  status(ticketValue: unknown): JsonObject {
    if (typeof ticketValue !== "string" || !ticketValue)
      throw new Error("ticket is required");
    this.reap();
    if (this.active?.ticket === ticketValue)
      return leaseResponse(this.active, null);
    const queued = this.queue.find((item) => item.ticket === ticketValue);
    if (queued) return queuedResponse(queued, this.queue.indexOf(queued) + 1);
    return {
      state: "idle",
      ticket: ticketValue,
      lease: null,
      queue_position: null,
    };
  }

  withCall<T>(
    token: string,
    operation: (lease: ActiveBrowserLease) => Promise<T>,
  ): Promise<T> {
    const lease = this.validateCurrent(token);
    const previous = lease.callChain;
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.beginCall(token);
        try {
          return await operation(current);
        } finally {
          this.endCall(current);
        }
      });
    lease.callChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async runMutating<T>(
    lease: ActiveBrowserLease,
    toolName: string,
    operationId: string,
    argumentsKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const cacheKey = `${toolName}\0${operationId}`;
    const cached = lease.operationCache.get(cacheKey);
    if (cached) {
      if (cached.argumentsKey !== argumentsKey)
        throw new Error(
          `operation_id ${operationId} was reused with different arguments; use a new operation_id`,
        );
      if (cached.outcome === "uncertain")
        throw new Error(
          `operation ${toolName}/${operationId} may have had side effects; do not retry, reconcile browser state before choosing a new operation_id`,
        );
      return cached.result as T;
    }
    try {
      const result = await operation();
      this.cacheOperation(lease, cacheKey, {
        argumentsKey,
        outcome: isUncertainToolResult(result) ? "uncertain" : "success",
        result,
      });
      return result;
    } catch (error) {
      this.cacheOperation(lease, cacheKey, {
        argumentsKey,
        outcome: "uncertain",
      });
      throw error;
    }
  }

  private cacheOperation(
    lease: ActiveBrowserLease,
    key: string,
    value: CachedBrowserOperation,
  ): void {
    if (
      !lease.operationCache.has(key) &&
      lease.operationCache.size >= maxCachedOperations
    ) {
      const oldest = lease.operationCache.keys().next().value;
      if (typeof oldest === "string") lease.operationCache.delete(oldest);
    }
    lease.operationCache.set(key, value);
  }

  private beginCall(token: string): ActiveBrowserLease {
    this.reap();
    const lease = this.active;
    if (!token || !lease || lease.token !== token || lease.fenced)
      throw new Error("a valid current browser lease is required");
    if (Date.now() >= lease.expiresAt) {
      this.fence(lease, true);
      if (lease.activeCalls === 0) this.releaseActive(lease);
      throw new Error("browser lease has expired");
    }
    lease.activeCalls += 1;
    this.touchLease(lease);
    return lease;
  }

  private endCall(lease: ActiveBrowserLease): void {
    lease.activeCalls = Math.max(0, lease.activeCalls - 1);
    if (
      this.active === lease &&
      lease.activeCalls === 0 &&
      (lease.fenced || Date.now() >= lease.expiresAt)
    )
      this.releaseActive(lease);
  }

  touch(token: unknown): JsonObject {
    const lease = this.validateCurrent(token);
    this.touchLease(lease);
    return leaseResponse(lease, null);
  }

  release(token: unknown): JsonObject {
    const lease = this.validateCurrent(token);
    lease.releasePending = true;
    this.fence(lease, false);
    const ticket = lease.ticket;
    if (lease.activeCalls === 0) {
      this.releaseActive(lease);
      return { state: "released", ticket, lease: null, queue_position: null };
    }
    return {
      state: "releasing",
      ticket,
      lease: null,
      queue_position: null,
    };
  }

  cancel(ticketValue: unknown, leaseValue: unknown): JsonObject {
    this.reap();
    if (typeof leaseValue === "string" && leaseValue) {
      return this.release(leaseValue);
    }
    if (typeof ticketValue !== "string" || !ticketValue)
      throw new Error("ticket or lease is required");
    if (this.active?.ticket === ticketValue)
      return this.release(this.active.token);
    const request = this.queue.find((item) => item.ticket === ticketValue);
    if (!request) throw new Error("browser task not found");
    this.removeQueued(request);
    return {
      state: "cancelled",
      ticket: ticketValue,
      lease: null,
      queue_position: null,
    };
  }

  health(): JsonObject {
    this.reap();
    const oldest = this.queue[0];
    const oldestWait = oldest ? Math.max(0, Date.now() - oldest.queuedAt) : 0;
    return {
      busy: Boolean(this.active),
      owner: this.active?.ticket ?? null,
      purpose: this.active?.purpose ?? null,
      expires_at: this.active?.expiresAt ?? null,
      hard_expires_at: this.active?.hardExpiresAt ?? null,
      expired_pending: this.active?.expiredPending ?? false,
      release_pending: this.active?.releasePending ?? false,
      queue_length: this.queue.length,
      oldest_wait: oldestWait,
      waiting: this.queue.length,
    };
  }

  private validateCurrent(token: unknown): ActiveBrowserLease {
    this.reap();
    const lease = this.active;
    if (
      typeof token !== "string" ||
      !token ||
      !lease ||
      lease.token !== token ||
      lease.fenced
    )
      throw new Error("a valid current browser lease is required");
    if (Date.now() >= lease.expiresAt) {
      this.fence(lease, true);
      if (lease.activeCalls === 0) this.releaseActive(lease);
      throw new Error("browser lease has expired");
    }
    return lease;
  }

  private grant(
    ticket: string,
    purpose: string,
    ttlMs: number,
    requestKey: string | undefined,
  ): ActiveBrowserLease {
    const now = Date.now();
    const lease: ActiveBrowserLease = {
      ticket,
      token: randomUUID(),
      requestKey,
      generation: ++this.generation,
      purpose,
      ttlMs: Math.min(ttlMs, browserLeaseMaxMs),
      expiresAt: 0,
      hardExpiresAt: now + browserLeaseMaxMs,
      activeCalls: 0,
      fenced: false,
      expiredPending: false,
      releasePending: false,
      timer: undefined,
      callChain: Promise.resolve(),
      operationCache: new Map(),
    };
    lease.expiresAt = Math.min(now + lease.ttlMs, lease.hardExpiresAt);
    this.active = lease;
    this.armLeaseTimer(lease);
    return lease;
  }

  private touchLease(lease: ActiveBrowserLease): void {
    const now = Date.now();
    lease.expiresAt = Math.min(now + lease.ttlMs, lease.hardExpiresAt);
    lease.expiredPending = false;
    this.armLeaseTimer(lease);
  }

  private fence(lease: ActiveBrowserLease, expired: boolean): void {
    lease.fenced = true;
    lease.expiredPending ||= expired;
    lease.operationCache.clear();
  }

  private releaseActive(lease: ActiveBrowserLease): void {
    if (this.active !== lease) return;
    clearTimeout(lease.timer);
    lease.operationCache.clear();
    this.active = undefined;
    this.grantNext();
  }

  private grantNext(): void {
    while (!this.active && this.queue.length) {
      const request = this.queue.shift();
      if (!request) return;
      clearTimeout(request.timer);
      if (request.expiresAt <= Date.now()) continue;
      this.active = this.grant(
        request.ticket,
        request.purpose,
        request.ttlMs,
        request.requestKey,
      );
    }
  }

  private armLeaseTimer(lease: ActiveBrowserLease): void {
    clearTimeout(lease.timer);
    lease.timer = setTimeout(
      () => this.expireActive(lease),
      Math.max(1, lease.expiresAt - Date.now()),
    );
    lease.timer.unref?.();
  }

  private expireActive(lease: ActiveBrowserLease): void {
    if (this.active !== lease || lease.fenced) return;
    if (Date.now() < lease.expiresAt) {
      this.armLeaseTimer(lease);
      return;
    }
    this.fence(lease, true);
    if (lease.activeCalls === 0) this.releaseActive(lease);
  }

  private expireQueued(ticket: string): void {
    const request = this.queue.find((item) => item.ticket === ticket);
    if (!request || request.expiresAt > Date.now()) return;
    this.removeQueued(request);
  }

  private removeQueued(request: QueuedBrowserRequest): void {
    clearTimeout(request.timer);
    this.queue = this.queue.filter((item) => item !== request);
  }

  private reap(): void {
    const now = Date.now();
    for (const request of [...this.queue])
      if (request.expiresAt <= now) this.removeQueued(request);
    if (this.active && this.active.expiresAt <= now) {
      this.fence(this.active, true);
      if (this.active.activeCalls === 0) this.releaseActive(this.active);
    }
  }
}

const browserLeaseManager = new BrowserLeaseManager();

function playwrightToken(): string {
  if (!playwrightTokenFile)
    throw new Error("OPENLIA_BROWSER_PLAYWRIGHT_TOKEN_FILE is required");
  const contents = readFileSync(playwrightTokenFile, "utf8");
  const assignment = contents
    .split(/\r?\n/)
    .find((line) =>
      line.trimStart().startsWith("PLAYWRIGHT_MCP_EXTENSION_TOKEN="),
    );
  const value = (
    assignment ? assignment.slice(assignment.indexOf("=") + 1) : contents
  )
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  if (
    !value ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\0")
  )
    throw new Error("Playwright extension token file is invalid");
  return value;
}

function startPlaywright(): void {
  if (!supervisePlaywright || stopping || playwright) return;
  const token = playwrightToken();
  const executable =
    process.env.OPENLIA_BROWSER_PATH ??
    "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi";
  const profile = process.env.OPENLIA_BROWSER_PROFILE ?? "Profile 1";
  const command =
    process.env.OPENLIA_BROWSER_PLAYWRIGHT_COMMAND ??
    (process.platform === "darwin" ? "/opt/homebrew/bin/npx" : "npx");
  const args = [
    "--yes",
    "@playwright/mcp@0.0.82",
    "--allowed-hosts",
    `localhost:${playwrightPort}`,
    "--host",
    "127.0.0.1",
    "--port",
    String(playwrightPort),
    "--extension",
    "--idle-timeout",
    "0",
    "--shared-browser-context",
    "--profile-dir-name",
    profile,
    "--output-dir",
    resolve(dataRoot, "playwright-output"),
  ];
  playwright = spawn(command, args, {
    cwd: dataRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
      PLAYWRIGHT_MCP_EXECUTABLE_PATH: executable,
    },
    stdio: "inherit",
  });
  const processChild = playwright;
  const child = processChild as unknown as {
    on(event: "error", listener: (error: Error) => void): void;
    on(
      event: "exit",
      listener: (code: number | null, signal: string | null) => void,
    ): void;
  };
  child.on("error", (error) =>
    console.error(`playwright-mcp error: ${error.message}`),
  );
  child.on("exit", (code, signal) => {
    if (playwright === processChild) playwright = undefined;
    if (!stopping) {
      playwrightRestarts += 1;
      setTimeout(
        startPlaywright,
        Math.min(30_000, 1_000 * 2 ** Math.min(playwrightRestarts, 5)),
      );
    }
    console.error(
      `playwright-mcp exited code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
  });
}

function newInteractiveSession(id: string): InteractiveSession {
  return {
    id,
    connectPromise: undefined,
    activeCalls: 0,
    closing: false,
    lastSeen: Date.now(),
  };
}

async function ensureMcp(session: InteractiveSession): Promise<McpClient> {
  if (session.client) {
    await session.client.connect();
    return session.client;
  }
  if (!session.connectPromise) {
    const client = new McpClient(mcpUrl);
    session.connectPromise = client
      .connect()
      .then(() => {
        if (session.closing) {
          client.close();
          throw new Error("MCP session closed while connecting");
        }
        session.client = client;
        return client;
      })
      .catch((error) => {
        client.close();
        throw error;
      })
      .finally(() => {
        session.connectPromise = undefined;
      });
  }
  return session.connectPromise;
}

function controlResult(payload: JsonObject): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function isUncertainToolResult(result: unknown): boolean {
  return isJsonObject(result) && result.isError === true;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isJsonObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? String(value);
}

function augmentTool(tool: JsonObject): JsonObject {
  const name = typeof tool.name === "string" ? tool.name : "";
  const inputSchema = isJsonObject(tool.inputSchema) ? tool.inputSchema : {};
  const properties = isJsonObject(inputSchema.properties)
    ? inputSchema.properties
    : {};
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: inputSchema.type ?? "object",
      properties: {
        ...properties,
        lease: { type: "string" },
        ...(mutatingToolNames.has(name)
          ? { operation_id: { type: "string", minLength: 1, maxLength: 200 } }
          : {}),
      },
      required: [
        ...new Set([
          ...required,
          "lease",
          ...(mutatingToolNames.has(name) ? ["operation_id"] : []),
        ]),
      ],
    },
  };
}

function augmentToolsList(result: unknown): unknown {
  if (!isJsonObject(result) || !Array.isArray(result.tools)) return result;
  const downstreamTools = result.tools
    .filter(isJsonObject)
    .filter(
      (tool) =>
        typeof tool.name === "string" &&
        !controlToolNames.has(tool.name) &&
        allowedDownstreamToolNames.has(tool.name),
    )
    .map(augmentTool);
  return { ...result, tools: [...controlTools, ...downstreamTools] };
}

function safeTaskString(value: unknown, name: string, required: true): string;
function safeTaskString(
  value: unknown,
  name: string,
  required: false,
): string | undefined;
function safeTaskString(
  value: unknown,
  name: string,
  required: boolean,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string")
    throw new Error(
      `${name} must be a non-empty string of 200 characters or fewer`,
    );
  if (value.length > 200)
    throw new Error(
      `${name} must be a non-empty safe string of 200 characters or fewer`,
    );
  const normalized = value.trim();
  if (
    !normalized ||
    Array.from(normalized).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029
      );
    })
  )
    throw new Error(
      `${name} must be a non-empty safe string of 200 characters or fewer`,
    );
  return normalized;
}

function handleControlTool(
  name: string,
  argumentsValue: JsonObject,
): JsonObject {
  switch (name) {
    case "openlia_browser_session_request": {
      if (Object.hasOwn(argumentsValue, "ttl_seconds"))
        throw new Error(
          "ttl_seconds is not accepted; configure the browser lease environment defaults",
        );
      const purpose = safeTaskString(argumentsValue.purpose, "purpose", true);
      const requestKey = safeTaskString(
        argumentsValue.request_key,
        "request_key",
        false,
      );
      return controlResult(browserLeaseManager.request(purpose, requestKey));
    }
    case "openlia_browser_session_status":
      return controlResult(browserLeaseManager.status(argumentsValue.ticket));
    case "openlia_browser_session_touch":
      return controlResult(browserLeaseManager.touch(argumentsValue.lease));
    case "openlia_browser_session_release":
      return controlResult(browserLeaseManager.release(argumentsValue.lease));
    case "openlia_browser_session_cancel":
      return controlResult(
        browserLeaseManager.cancel(argumentsValue.ticket, argumentsValue.lease),
      );
    default:
      throw new Error(`unknown browser control tool: ${name}`);
  }
}

function withBrowserLease<T>(
  session: InteractiveSession,
  token: string,
  operation: (lease: ActiveBrowserLease) => Promise<T>,
): Promise<T> {
  return browserLeaseManager.withCall(token, async (lease) => {
    session.activeCalls += 1;
    try {
      return await operation(lease);
    } finally {
      session.activeCalls -= 1;
    }
  });
}

function closeInteractiveSession(session: InteractiveSession): void {
  if (session.closing) return;
  session.closing = true;
  session.client?.close();
}

async function createHttpMcpSession(): Promise<HttpMcpSession> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      session.id = sessionId;
      httpSessions.set(sessionId, session);
    },
  });
  const server = new McpServer(
    { name: "openlia-browser", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  const session: HttpMcpSession = Object.assign(
    newInteractiveSession(randomUUID()),
    { server, transport },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    session.lastSeen = Date.now();
    const client = await ensureMcp(session);
    return (await client
      .call("tools/list", request.params ?? {}, 90_000, extra.signal)
      .then(augmentToolsList)) as never;
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    session.lastSeen = Date.now();
    const argumentsValue = isJsonObject(request.params.arguments)
      ? request.params.arguments
      : {};
    if (controlToolNames.has(request.params.name))
      return handleControlTool(request.params.name, argumentsValue) as never;
    if (!allowedDownstreamToolNames.has(request.params.name))
      throw new Error(
        `browser tool ${request.params.name} is not allowed by the relay`,
      );
    const lease = argumentsValue.lease;
    if (typeof lease !== "string" || !lease)
      throw new Error("a valid current browser lease is required");
    const operationId = mutatingToolNames.has(request.params.name)
      ? safeTaskString(argumentsValue.operation_id, "operation_id", true)
      : undefined;
    const {
      lease: _lease,
      operation_id: _operationId,
      ...downstreamArguments
    } = argumentsValue;
    const call = () =>
      ensureMcp(session).then((client) =>
        client.callTool(
          request.params.name,
          downstreamArguments,
          90_000,
          extra.signal,
        ),
      );
    return (await withBrowserLease(session, lease, async (activeLease) => {
      if (operationId)
        return browserLeaseManager.runMutating(
          activeLease,
          request.params.name,
          operationId,
          stableJson(downstreamArguments),
          call,
        );
      return call();
    })) as never;
  });
  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) httpSessions.delete(sessionId);
    closeInteractiveSession(session);
    void server.close().catch(() => undefined);
  };
  await server.connect(transport as Transport);
  return session;
}

async function handleStreamableHttp(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    json(response, { ok: false, error: "origin is not allowed" }, 403);
    return;
  }
  const sessionHeader = request.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader)
    ? sessionHeader[0]
    : sessionHeader;
  let parsedBody: JsonObject | undefined;
  if (request.method === "POST") {
    parsedBody = (await body(request)) ?? undefined;
    if (!parsedBody) {
      json(response, { ok: false, error: "invalid MCP request body" }, 400);
      return;
    }
  }
  let session = sessionId ? httpSessions.get(sessionId) : undefined;
  if (!session && request.method === "POST" && isInitializeRequest(parsedBody))
    session = await createHttpMcpSession();
  if (!session) {
    json(
      response,
      {
        ok: false,
        error: sessionId
          ? "MCP session not found"
          : "MCP initialization required",
      },
      sessionId ? 404 : 400,
    );
    return;
  }
  session.lastSeen = Date.now();
  await session.transport.handleRequest(request, response, parsedBody);
}

async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!authorized(request)) {
    json(response, { ok: false, error: "unauthorized" }, 401);
    return;
  }
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  if (url.pathname === "/mcp") {
    await handleStreamableHttp(request, response);
    return;
  }
  if (url.pathname === "/sse" || url.pathname === "/messages") {
    json(
      response,
      {
        ok: false,
        error: "legacy SSE transport is disabled; use /mcp",
        mcp_endpoint: "/mcp",
      },
      410,
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, {
      ok: true,
      service: "openlia-browser",
      mcp_url: mcpUrl,
      mcp_transport: "streamable-http",
      mcp_sessions: httpSessions.size,
      playwright_pid: playwright?.pid ?? null,
      browser_lease: browserLeaseManager.health(),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/info") {
    json(response, {
      ok: true,
      service: "openlia-browser",
      protocol_version: 1,
      mcp_url: mcpUrl,
    });
    return;
  }
  json(response, { ok: false, error: "not found" }, 404);
}

const server = createServer((request, response) => {
  void handler(request, response).catch((error) => {
    if (!response.headersSent)
      json(response, { ok: false, error: String(error) }, 500);
    else response.destroy();
  });
});
const sessionReaper = setInterval(() => {
  if (!Number.isFinite(mcpSessionIdleMs) || mcpSessionIdleMs <= 0) return;
  const cutoff = Date.now() - mcpSessionIdleMs;
  for (const session of httpSessions.values()) {
    if (session.activeCalls === 0 && session.lastSeen < cutoff)
      void session.transport.close().catch(() => undefined);
  }
}, 60_000);
sessionReaper.unref();

server.listen(port, bind, () => {
  console.log(`openlia-browser listening on http://${bind}:${port}`);
  try {
    startPlaywright();
  } catch (error) {
    console.error(
      `playwright-mcp startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

function shutdown(): void {
  stopping = true;
  clearInterval(sessionReaper);
  for (const session of httpSessions.values()) {
    closeInteractiveSession(session);
    void session.transport.close().catch(() => undefined);
  }
  playwright?.kill("SIGTERM");
  playwright = undefined;
  server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
