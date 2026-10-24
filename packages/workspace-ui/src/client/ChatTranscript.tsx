import type { ChatMessage } from "../shared/chat";
import { ChatMarkdown } from "./ChatMarkdown";

export function chatMessageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content)
    ? message.content
        .map((part) =>
          typeof part === "object" &&
          part &&
          "text" in part &&
          typeof part.text === "string"
            ? part.text
            : "",
        )
        .filter(Boolean)
        .join("\n")
    : "";
}

export interface ChatTurn {
  id: ChatMessage["id"];
  role: "user" | "assistant";
  messages: ChatMessage[];
}

// Presentation only: keep Hermes' transcript intact, including tool-only turns.
export function groupChatMessages(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.display_kind === "hidden" || message.role === "system")
      continue;
    if (
      message.role !== "tool" &&
      !chatMessageText(message).trim() &&
      !message.tool_calls?.length &&
      !message.reasoning?.trim()
    )
      continue;
    if (message.role === "user") {
      turns.push({ id: message.id, role: "user", messages: [message] });
    } else {
      const previous = turns.at(-1);
      if (previous?.role === "assistant") previous.messages.push(message);
      else
        turns.push({ id: message.id, role: "assistant", messages: [message] });
    }
  }
  return turns;
}

function ToolActivity({ messages }: { messages: ChatMessage[] }) {
  const calls = messages.flatMap((message) => message.tool_calls ?? []);
  const results = messages.filter((message) => message.role === "tool");
  const count = Math.max(calls.length, results.length);
  const reasoning = messages.filter((message) => message.reasoning?.trim());
  if (!count && !reasoning.length) return null;
  return (
    <details className="chat-tool-group">
      <summary>
        {count
          ? `Used ${count} ${count === 1 ? "tool" : "tools"}`
          : "Model reasoning"}
      </summary>
      <div className="chat-tool-items">
        {calls.length > 0 && (
          <details>
            <summary>Tool calls ({calls.length})</summary>
            <pre className="chat-tool-output">
              {JSON.stringify(calls, null, 2)}
            </pre>
          </details>
        )}
        {results.map((result) => (
          <details key={result.id}>
            <summary>
              {result.tool_name?.replaceAll("_", " ") || "Tool result"}
            </summary>
            <pre className="chat-tool-output">{chatMessageText(result)}</pre>
          </details>
        ))}
        {reasoning.map((message) => (
          <details key={message.id}>
            <summary>Model reasoning</summary>
            <pre className="chat-tool-output">{message.reasoning}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}

export function ChatTranscript({ messages }: { messages: ChatMessage[] }) {
  return groupChatMessages(messages).map((turn) => {
    const text = turn.messages
      .filter((message) => message.role !== "tool")
      .map(chatMessageText)
      .filter((value) => value.trim());
    return (
      <article
        key={turn.id}
        aria-label={turn.role === "user" ? "Your message" : "Lia response"}
        className={`chat-turn chat-turn--${turn.role}`}
      >
        <div className="chat-speaker">
          {turn.role === "user" ? "You" : "Lia"}
        </div>
        {turn.role === "assistant" && <ToolActivity messages={turn.messages} />}
        {turn.messages
          .filter(
            (message) =>
              message.role !== "tool" && chatMessageText(message).trim(),
          )
          .map((message) => (
            <ChatMarkdown key={message.id} content={chatMessageText(message)} />
          ))}
        {text.length > 0 && (
          <button
            type="button"
            className="chat-copy btn btn-ghost btn-xs"
            aria-label={
              turn.role === "user" ? "Copy your message" : "Copy Lia response"
            }
            onClick={() =>
              void navigator.clipboard
                ?.writeText(text.join("\n\n"))
                .catch(() => {})
            }
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
            >
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4" />
            </svg>
            <span>Copy</span>
          </button>
        )}
      </article>
    );
  });
}
