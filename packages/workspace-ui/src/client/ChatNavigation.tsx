import { useEffect, useRef, type ReactNode } from "react";
import type { ChatSession } from "../shared/chat";

export function chatSourceLabel(source?: string) {
  if (!source || ["hermes_browser", "browser", "api_server"].includes(source))
    return "Browser";
  if (source === "cli") return "Terminal";
  return source.charAt(0).toUpperCase() + source.slice(1).replaceAll("_", " ");
}

export function ChatNavigation({
  sessions,
  selectedId,
  other,
  filter,
  hasMore,
  loading,
  busy,
  ready,
  drawerOpen,
  onClose,
  onSelect,
  onNew,
  onSource,
  onFilter,
  onMore,
}: {
  sessions: ChatSession[];
  selectedId: string | undefined;
  other: boolean;
  filter: string;
  hasMore: boolean;
  loading: boolean;
  busy: boolean;
  ready: boolean;
  drawerOpen: boolean;
  onClose: () => void;
  onSelect: (session: ChatSession) => void;
  onNew: () => void;
  onSource: (other: boolean) => void;
  onFilter: (value: string) => void;
  onMore: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (drawerOpen) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
      previousFocus.current?.focus();
      previousFocus.current = null;
    }
  }, [drawerOpen]);
  // Closing on resize avoids leaving a modal focus trap over the desktop sidebar.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const resize = () => {
      if (query.matches && drawerOpen) onClose();
    };
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, [drawerOpen, onClose]);
  const content: ReactNode = (
    <>
      <div className="chat-sidebar-heading">
        <h2>Conversations</h2>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !ready}
          onClick={() => {
            onClose();
            onNew();
          }}
        >
          New chat
        </button>
      </div>
      <select
        aria-label="Conversation source"
        className="select select-sm w-full"
        value={other ? "other" : "browser"}
        onChange={(event) => onSource(event.target.value === "other")}
      >
        <option value="browser">Workspace chats</option>
        <option value="other">Other Hermes sessions · read-only</option>
      </select>
      <input
        aria-label="Filter loaded chat titles"
        className="input input-sm w-full"
        placeholder="Filter conversations…"
        value={filter}
        onChange={(event) => onFilter(event.target.value)}
      />
      <div className="chat-session-list">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`chat-session ${selectedId === session.id ? "is-selected" : ""}`}
            aria-current={selectedId === session.id ? "page" : undefined}
            onClick={() => {
              onClose();
              onSelect(session);
            }}
          >
            <span className="chat-session-title">
              {session.pinned ? "★ " : ""}
              {session.title || session.preview || "New conversation"}
            </span>
            <span className="chat-session-source">
              {chatSourceLabel(session.source)}
            </span>
          </button>
        ))}
        {!loading && !sessions.length && (
          <p className="text-sm opacity-60">No conversations in this page.</p>
        )}
        {hasMore && (
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={busy}
            onClick={onMore}
          >
            Load more conversations
          </button>
        )}
      </div>
      <p className="chat-sidebar-note">
        Shared with everyone who can access this workspace. History is saved by
        Hermes.
      </p>
    </>
  );
  return (
    <>
      <aside aria-label="Conversations" className="chat-sidebar">
        {content}
      </aside>
      <dialog
        ref={dialog}
        aria-label="Conversations"
        className="chat-drawer"
        onCancel={onClose}
        onClose={onClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {drawerOpen && (
          <div className="chat-drawer-content">
            <button
              className="btn btn-ghost btn-sm self-end"
              type="button"
              onClick={onClose}
            >
              Close conversations
            </button>
            {content}
          </div>
        )}
      </dialog>
    </>
  );
}
