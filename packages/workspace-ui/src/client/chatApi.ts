import type { ChatApi, ChatEvent } from "../shared/chat";

export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(`/api/chat${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ChatApiError(
      response.status,
      payload?.error ?? `Chat request failed (${response.status})`,
    );
  }
  return response.json();
}

// Incremental SSE decoder: handles split UTF-8, CRLF, multi-line data and comments.
export async function readChatEvents(
  response: Response,
  onEvent: (event: ChatEvent) => void,
) {
  if (!response.ok || !response.body)
    throw new Error(`Chat stream unavailable (${response.status})`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      if (buffer.length > 2_000_000) throw new Error("Chat event too large");
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const event: ChatEvent = JSON.parse(data);
        const name = frame
          .split(/\r?\n/)
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim();
        if (!event.event && name) event.event = name;
        if (event.event) onEvent(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const id = encodeURIComponent;
export const httpChatApi: ChatApi = {
  capabilities: () => request("/capabilities"),
  models: () => request("/models"),
  sessions: (offset, other) =>
    request(`/sessions?offset=${offset}&other=${other}`),
  create: () => request("/sessions", "POST", {}),
  session: (session) => request(`/sessions/${id(session)}`),
  update: (session, patch) =>
    request(`/sessions/${id(session)}`, "PATCH", patch),
  delete: (session) => request(`/sessions/${id(session)}`, "DELETE"),
  messages: (session, offset) =>
    request(`/sessions/${id(session)}/messages?offset=${offset}`),
  activeRun: (session) => request(`/sessions/${id(session)}/run`),
  send: (session, input, key, model) =>
    request(`/sessions/${id(session)}/run`, "POST", { input, model }, key),
  run: (run) => request(`/runs/${id(run)}`),
  control: (run, action, body) =>
    request(`/runs/${id(run)}/${action}`, "POST", body),
  events: async (run, seq, signal, onEvent) =>
    readChatEvents(
      await fetch(`/api/chat/runs/${id(run)}/events?last_seq=${seq}`, {
        signal,
      }),
      onEvent,
    ),
};
