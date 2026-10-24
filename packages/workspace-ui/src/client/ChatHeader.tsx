import { useEffect, useRef } from "react";
import type { ChatSession } from "../shared/chat";

export function ChatHeader({
  session,
  busy,
  active,
  onOpenConversations,
  onAction,
}: {
  session: ChatSession | null;
  busy: boolean;
  active: boolean;
  onOpenConversations: () => void;
  onAction: (action: "rename" | "pin" | "archive" | "delete") => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        menu.current
      )
        menu.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const action = (name: "rename" | "pin" | "archive" | "delete") => {
    if (menu.current) menu.current.open = false;
    onAction(name);
  };
  return (
    <header className="chat-header">
      <button
        type="button"
        className="chat-open-conversations btn btn-ghost btn-sm"
        aria-label="Open conversations"
        onClick={(event) => {
          event.currentTarget.focus();
          onOpenConversations();
        }}
      >
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </button>
      <h2 title={session?.title || "Chat with Lia"}>
        {session?.title || (session ? "New conversation" : "Chat with Lia")}
      </h2>
      {session && !session.writable && (
        <span className="chat-readonly">Read-only</span>
      )}
      {session && (
        <details
          ref={menu}
          className="chat-options"
          onKeyDown={(event) => {
            if (event.key === "Escape" && menu.current) {
              menu.current.open = false;
              menu.current.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            aria-label="Conversation options"
            className="btn btn-ghost btn-sm"
          >
            •••
          </summary>
          <div className="chat-options-panel">
            {session.writable && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => action("rename")}
                >
                  Rename
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => action("pin")}
                >
                  {session.pinned ? "Unpin" : "Pin"}
                </button>
                <button
                  type="button"
                  disabled={busy || active}
                  onClick={() => action("archive")}
                >
                  Archive
                </button>
                <button
                  type="button"
                  className="text-error"
                  disabled={busy || active}
                  onClick={() => action("delete")}
                >
                  Delete
                </button>
              </>
            )}
            <a href="/usage">View usage</a>
            <p className="chat-usage-note">
              {session.input_tokens !== undefined
                ? `${session.input_tokens.toLocaleString()} input / ${session.output_tokens?.toLocaleString() ?? "unknown"} output tokens`
                : "Token usage unavailable"}
              {typeof session.estimated_cost_usd === "number"
                ? ` · estimated $${session.estimated_cost_usd.toFixed(4)}`
                : ""}
            </p>
          </div>
        </details>
      )}
    </header>
  );
}
