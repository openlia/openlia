export interface ChatSession {
  id: string;
  title?: string | null;
  source?: string;
  preview?: string;
  pinned?: boolean;
  archived?: boolean;
  last_active?: number;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: number | null;
  _lineage_root_id?: string;
  writable?: boolean;
}

export interface ChatMessage {
  id: number | string;
  role: string;
  content: string | unknown[] | null;
  tool_calls?: unknown[];
  tool_name?: string;
  reasoning?: string;
  display_kind?: string;
}

export interface ChatRun {
  run_id: string;
  status: string;
  request_id?: string;
  status_source?: "hermes" | "recorded" | "unconfirmed";
  submitted_at?: number;
  status_observed_at?: number;
  session_id?: string;
  output?: string;
  error?: string;
  execution_generation?: number;
  pending_controls?: Record<string, unknown>[];
  approval?: Record<string, unknown>;
  runtime?: { provider?: string; model?: string };
}

export function normalizeChatApproval(
  raw: unknown,
  fallbackGeneration?: number,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const requestId =
    typeof obj.request_id === "string" && obj.request_id
      ? obj.request_id
      : typeof obj.prompt_id === "string" && obj.prompt_id
        ? obj.prompt_id
        : undefined;
  const executionGeneration =
    typeof obj.execution_generation === "number" &&
    Number.isInteger(obj.execution_generation)
      ? obj.execution_generation
      : typeof fallbackGeneration === "number" &&
          Number.isInteger(fallbackGeneration)
        ? fallbackGeneration
        : undefined;
  return {
    ...obj,
    ...(requestId ? { request_id: requestId } : {}),
    ...(executionGeneration !== undefined
      ? { execution_generation: executionGeneration }
      : {}),
  };
}

export function normalizeChatRun(run: ChatRun): ChatRun {
  const fallbackGen =
    typeof run.execution_generation === "number"
      ? run.execution_generation
      : undefined;
  let approval = normalizeChatApproval(run.approval, fallbackGen);
  if (!approval && Array.isArray(run.pending_controls)) {
    const pending = run.pending_controls.find(
      (item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)) &&
        (item.kind === "approval" ||
          (!item.kind &&
            (typeof item.prompt_id === "string" ||
              typeof item.request_id === "string"))),
    );
    if (pending) {
      approval = normalizeChatApproval(pending, fallbackGen);
    }
  }
  if (!approval) return run;
  return {
    ...run,
    status:
      run.status === "running" || run.status === "queued"
        ? "waiting_for_approval"
        : run.status,
    approval,
  };
}

export function normalizeChatEvent(event: ChatEvent): ChatEvent {
  if (
    event.event === "approval.request" ||
    event.event === "approval.settled" ||
    event.event === "approval.responded"
  ) {
    const requestId =
      typeof event.request_id === "string" && event.request_id
        ? event.request_id
        : typeof event.prompt_id === "string" && event.prompt_id
          ? event.prompt_id
          : undefined;
    if (requestId && event.request_id !== requestId) {
      return { ...event, request_id: requestId };
    }
  }
  return event;
}

export function chatApprovalChoices(
  approval?: Record<string, unknown>,
): string[] {
  return Array.isArray(approval?.choices)
    ? [
        ...new Set(
          approval.choices.filter(
            (choice): choice is string =>
              typeof choice === "string" &&
              ["once", "session", "always", "deny"].includes(choice),
          ),
        ),
      ]
    : [];
}

export interface ChatEvent {
  event: string;
  seq?: number;
  run_id?: string;
  delta?: string;
  [key: string]: unknown;
}

export interface ChatCapabilities {
  features: {
    session_resources?: boolean;
    run_status?: boolean;
    run_events_sse?: boolean;
    run_stop?: boolean;
    run_steer?: boolean;
    run_approval_response?: boolean;
    runs_idempotency?: {
      supported: boolean;
      durable: boolean;
      retention_seconds: number;
    };
    [key: string]: unknown;
  };
}

export const terminalChatStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
  "rejected",
]);

export interface ChatApi {
  capabilities(): Promise<ChatCapabilities>;
  models(): Promise<{ data: { id: string }[] }>;
  sessions(
    offset: number,
    other: boolean,
  ): Promise<{ data: ChatSession[]; has_more: boolean; next_offset: number }>;
  create(): Promise<{ session: ChatSession }>;
  session(id: string): Promise<{ session: ChatSession }>;
  update(
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ): Promise<{ session: ChatSession }>;
  delete(id: string): Promise<unknown>;
  messages(
    id: string,
    offset: number,
  ): Promise<{ data: ChatMessage[]; session_id: string }>;
  activeRun(id: string): Promise<{ run: ChatRun | null }>;
  runs(
    id: string,
    offset: number,
  ): Promise<{ data: ChatRun[]; has_more: boolean; next_offset: number }>;
  send(id: string, input: string, key: string, model: string): Promise<ChatRun>;
  run(id: string): Promise<ChatRun>;
  control(
    id: string,
    action: "stop" | "steer" | "approval",
    body: Record<string, unknown>,
  ): Promise<unknown>;
  events(
    id: string,
    lastSeq: number,
    signal: AbortSignal,
    onEvent: (event: ChatEvent) => void,
  ): Promise<void>;
}
