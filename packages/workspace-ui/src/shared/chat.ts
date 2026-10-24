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
  session_id?: string;
  output?: string;
  error?: string;
  approval?: Record<string, unknown>;
  runtime?: { provider?: string; model?: string };
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
