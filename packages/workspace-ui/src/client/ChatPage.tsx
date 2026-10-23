import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { ChatApiError } from "./chatApi";
import {
  terminalChatStatuses,
  type ChatApi,
  type ChatCapabilities,
  type ChatEvent,
  type ChatMessage,
  type ChatRun,
  type ChatSession,
} from "../shared/chat";

function storageGet(key: string) {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function storageSet(key: string, value: string) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* Private browsing / storage quota. */
  }
}
function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content)
    ? message.content
        .map((part) =>
          typeof part === "object" && part && "text" in part
            ? String(part.text)
            : "",
        )
        .join("\n")
    : "";
}
function errorText(error: unknown) {
  const value = error instanceof Error ? error.message : "Chat request failed";
  if (value === "chat_not_configured")
    return "Chat is not configured. Update and recreate the deployment, or set OPENLIA_HERMES_API_URL and API_SERVER_KEY on the Workspace UI server.";
  if (value === "hermes_unavailable")
    return "Cannot reach Hermes. Check that its API server is running, then retry.";
  if (value === "chat_requires_durable_runs")
    return "Hermes must have durable run idempotency enabled before this UI can safely send messages.";
  if (value === "chat_retry_window_expired_inspect_hermes")
    return "The retry safety window has expired. Inspect the saved Hermes conversation before starting a new chat; this message will not be resubmitted automatically.";
  return value.replaceAll("_", " ");
}

export function ChatPage({ api }: { api: ChatApi }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selected, setSelected] = useState<ChatSession | null>(null);
  const [other, setOther] = useState(false);
  const [filter, setFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [older, setOlder] = useState(false);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [features, setFeatures] = useState<ChatCapabilities["features"]>({});
  const [run, setRun] = useState<ChatRun | null>(null);
  const [stream, setStream] = useState("");
  const [activity, setActivity] = useState<ChatEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [following, setFollowing] = useState(true);
  const [archived, setArchived] = useState<ChatSession | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const runRef = useRef(run);
  runRef.current = run;
  const runId = run?.run_id;
  const selectedId = selected?.id;
  const active = run !== null && !terminalChatStatuses.has(run.status);
  const unresolved = run?.status === "unknown";
  const ready = Boolean(
    features.session_resources &&
      features.run_status &&
      features.run_events_sse,
  );

  const list = useCallback(
    async (nextOffset = 0, readOther = other) => {
      const result = await api.sessions(nextOffset, readOther);
      setSessions((current) =>
        nextOffset
          ? [
              ...new Map(
                [...current, ...result.data].map((s) => [s.id, s]),
              ).values(),
            ]
          : result.data,
      );
      setOffset(result.next_offset);
      setHasMore(result.has_more);
      setSelected((current) =>
        current
          ? (result.data.find((s) => s.id === current.id) ?? current)
          : null,
      );
      return result.data;
    },
    [api, other],
  );

  const select = useCallback(
    async (session: ChatSession) => {
      const version = ++generation.current;
      selectedRef.current = session;
      setSelected(session);
      setMessages([]);
      setRun(null);
      setStream("");
      setActivity([]);
      setError("");
      setLoading(true);
      setRename(null);
      setConfirmDelete(false);
      setDraft(storageGet(`chat-draft:${session.id}`));
      setModel(storageGet(`chat-model:${session.id}`));
      setFollowing(true);
      const url = new URL(window.location.href);
      url.searchParams.set("conversation", session.id);
      window.history.replaceState(null, "", url);
      try {
        const [history, state] = await Promise.all([
          api.messages(session.id, 0),
          session.writable
            ? api.activeRun(session.id)
            : Promise.resolve({ run: null }),
        ]);
        if (version !== generation.current) return;
        setMessages(history.data);
        setOlder(history.data.length === 100);
        setRun(state.run);
      } catch (err) {
        if (version === generation.current) setError(errorText(err));
      } finally {
        if (version === generation.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.capabilities(), api.models(), api.sessions(0, other)])
      .then(async ([capabilities, options, result]) => {
        if (cancelled) return;
        setFeatures(capabilities.features);
        setModels(options.data);
        setSessions(result.data);
        setOffset(result.next_offset);
        setHasMore(result.has_more);
        const requested = new URL(window.location.href).searchParams.get(
          "conversation",
        );
        const session =
          result.data.find((s) => s.id === requested) ??
          (requested ? (await api.session(requested)).session : null);
        if (cancelled) return;
        if (session) await select(session);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      generation.current++;
    };
  }, [api, other, select]);

  // Runs are detached from browser subscriptions. Unmounting only disconnects the observer.
  useEffect(() => {
    if (
      !runId ||
      terminalChatStatuses.has(runRef.current?.status ?? "") ||
      !selectedId
    )
      return;
    const controller = new AbortController();
    const id = runId;
    const sessionId = selectedId;
    let lastSeq = -1;
    let settled = false;
    let polling = false;
    const receive = (event: ChatEvent) => {
      if (controller.signal.aborted) return;
      if (event.seq !== undefined) {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
      }
      if (event.event === "message.delta")
        setStream((text) => text + (event.delta ?? ""));
      else if (event.event === "approval.request")
        setRun(
          (current) =>
            current && {
              ...current,
              status: "waiting_for_approval",
              approval: event,
            },
        );
      else if (event.event === "replay.truncated")
        setError(
          "Some live events expired. The saved conversation will be restored when the run finishes.",
        );
      else if (!event.event.startsWith("run."))
        setActivity((current) => [...current.slice(-99), event]);
    };
    const observe = async () => {
      while (!controller.signal.aborted && !settled) {
        try {
          await api.events(id, lastSeq, controller.signal, receive);
        } catch {
          /* Poll status and reconnect; never resubmit a message. */
        }
        if (!controller.signal.aborted && !settled)
          await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    };
    const poll = async () => {
      if (polling || settled || controller.signal.aborted) return;
      polling = true;
      try {
        const status = await api.run(id);
        if (controller.signal.aborted) return;
        if (terminalChatStatuses.has(status.status)) {
          const history = await api.messages(sessionId, 0);
          if (controller.signal.aborted) return;
          setMessages(history.data);
          setOlder(history.data.length === 100);
          setStream("");
          setRun(status);
          settled = true;
          controller.abort();
          void list().catch((err) => setError(errorText(err)));
          if (status.status !== "completed")
            setError(
              status.status === "cancelled"
                ? "Stopped. Any changes already made by tools are not undone."
                : `Run ${status.status}. Check the saved conversation before retrying.`,
            );
        } else setRun(status);
      } catch (err) {
        if (!controller.signal.aborted) setError(errorText(err));
      } finally {
        polling = false;
      }
    };
    void observe();
    void poll();
    const interval = setInterval(() => void poll(), 1500);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
    // Status updates must not restart subscriptions or discard their replay cursor.
  }, [api, runId, selectedId, list]);

  useEffect(() => {
    if (following && pane.current)
      pane.current.scrollTop = pane.current.scrollHeight;
  });

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    act(async () => {
      if (!selected?.writable || !draft.trim() || active || unresolved) return;
      const id = selected.id;
      const input = draft;
      const pendingKey = `chat-pending:${id}`;
      let pending: { input: string; model: string; key: string } | null = null;
      try {
        pending = JSON.parse(storageGet(pendingKey) || "null");
      } catch {
        /* Ignore corrupt local state. */
      }
      if (pending && (pending.input !== input || pending.model !== model))
        throw new Error(
          "The previous message has an uncertain outcome. Retry it unchanged before sending another message.",
        );
      pending ??= { input, model, key: crypto.randomUUID() };
      storageSet(pendingKey, JSON.stringify(pending));
      let next: ChatRun;
      try {
        next = await api.send(id, input, pending.key, model);
      } catch (err) {
        if (
          err instanceof ChatApiError &&
          [400, 401, 403, 404, 422, 429].includes(err.status)
        )
          storageSet(pendingKey, "");
        throw err;
      }
      storageSet(pendingKey, "");
      storageSet(`chat-draft:${id}`, "");
      if (selectedRef.current?.id !== id) return;
      setDraft("");
      setStream("");
      setActivity([]);
      setFollowing(true);
      setRun(next);
      if (terminalChatStatuses.has(next.status)) {
        const history = await api.messages(id, 0);
        if (selectedRef.current?.id === id) setMessages(history.data);
      } else {
        // Presentation only: the next terminal reconciliation reloads Hermes' transcript.
        setMessages((current) => [
          ...current,
          { id: `pending-${next.run_id}`, role: "user", content: input },
        ]);
      }
    });
  const control = (
    action: "stop" | "steer" | "approval",
    body: Record<string, unknown>,
  ) =>
    act(async () => {
      if (!run) return;
      await api.control(run.run_id, action, body);
      setRun(await api.run(run.run_id));
      if (action === "steer") {
        setDraft("");
        if (selected) storageSet(`chat-draft:${selected.id}`, "");
      }
    });
  const visible = [...sessions]
    .filter((s) =>
      (s.title ?? "New conversation")
        .toLowerCase()
        .includes(filter.toLowerCase()),
    )
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const approvalChoices = Array.isArray(run?.approval?.choices)
    ? run.approval.choices.filter((c): c is string => typeof c === "string")
    : ["once", "deny"];

  return (
    <section
      aria-label="Chat"
      className="flex min-h-0 flex-1 flex-col md:flex-row overflow-hidden"
    >
      <aside className="w-full md:w-64 shrink-0 border-b md:border-b-0 md:border-r border-base-content/10 p-3 space-y-3 overflow-auto max-h-56 md:max-h-none">
        <div className="flex gap-2">
          <h1 className="text-lg font-semibold flex-1">Chat</h1>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={busy || !ready}
            onClick={() =>
              void act(async () => {
                const result = await api.create();
                if (other) setOther(false);
                await select(result.session);
                await list(0, false);
              })
            }
          >
            New chat
          </button>
        </div>
        <select
          aria-label="Conversation source"
          className="select select-sm w-full"
          value={other ? "other" : "browser"}
          onChange={(event) => {
            setSelected(null);
            setRun(null);
            setMessages([]);
            const url = new URL(window.location.href);
            url.searchParams.delete("conversation");
            window.history.replaceState(null, "", url);
            setOther(event.target.value === "other");
          }}
        >
          <option value="browser">Workspace chats</option>
          <option value="other">Other Hermes sessions · read-only</option>
        </select>
        <input
          aria-label="Filter loaded chat titles"
          className="input input-sm w-full"
          placeholder="Filter loaded titles…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {visible.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`block w-full text-left rounded-lg p-2 ${selected?.id === s.id ? "bg-primary/15" : "hover:bg-base-200"}`}
            onClick={() => void select(s)}
          >
            <span className="block truncate text-sm">
              {s.pinned ? "★ " : ""}
              {s.title || s.preview || "New conversation"}
            </span>
            <span className="text-xs opacity-50">{s.source ?? "browser"}</span>
          </button>
        ))}
        {!loading && !visible.length && (
          <p className="text-sm opacity-60">No conversations in this page.</p>
        )}
        {hasMore && (
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await list(offset);
              })
            }
          >
            Load more conversations
          </button>
        )}
        <p className="text-xs opacity-50">
          Chats are shared with everyone who can access this workspace. History
          is stored by Hermes.
        </p>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error && (
          <div role="alert" className="m-3 rounded-lg bg-error/10 p-3 text-sm">
            {error}
            <button
              className="btn btn-ghost btn-xs ml-2"
              type="button"
              onClick={() =>
                void act(async () => {
                  if (selected) await select(selected);
                  else {
                    const cap = await api.capabilities();
                    setFeatures(cap.features);
                    await list();
                  }
                })
              }
            >
              Refresh
            </button>
          </div>
        )}
        {archived && (
          <div role="status" className="p-3 text-sm">
            Conversation archived.{" "}
            <button
              type="button"
              className="btn btn-xs"
              onClick={() =>
                void act(async () => {
                  await api.update(archived.id, { archived: false });
                  setArchived(null);
                  await list();
                })
              }
            >
              Undo archive
            </button>
          </div>
        )}
        {unresolved && (
          <p role="alert" className="p-3 bg-warning/10 text-sm">
            The previous run’s outcome is unknown. Inspect Hermes before
            continuing; this conversation is blocked from sending another turn.
          </p>
        )}
        {selected ? (
          <>
            <header className="p-3 border-b border-base-content/10 flex flex-wrap items-center gap-2">
              <h2 className="font-semibold flex-1 truncate">
                {selected.title || "New conversation"}
              </h2>
              <a className="text-xs opacity-60 underline" href="/usage">
                Usage
                {selected.input_tokens !== undefined
                  ? ` · ${selected.input_tokens.toLocaleString()} input / ${selected.output_tokens?.toLocaleString() ?? "unknown"} output tokens`
                  : ""}
                {typeof selected.estimated_cost_usd === "number"
                  ? ` · ~$${selected.estimated_cost_usd.toFixed(4)}`
                  : ""}
              </a>
              {selected.writable && (
                <>
                  <button
                    className="btn btn-ghost btn-xs"
                    type="button"
                    disabled={busy}
                    onClick={() => setRename(selected.title ?? "")}
                  >
                    Rename
                  </button>
                  <button
                    className="btn btn-ghost btn-xs"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api.update(selected.id, {
                          pinned: !selected.pinned,
                        });
                        setSelected({ ...selected, pinned: !selected.pinned });
                        await list();
                      })
                    }
                  >
                    {selected.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    className="btn btn-ghost btn-xs"
                    type="button"
                    disabled={busy || active}
                    onClick={() =>
                      void act(async () => {
                        await api.update(selected.id, { archived: true });
                        setArchived(selected);
                        setSelected(null);
                        await list();
                      })
                    }
                  >
                    Archive
                  </button>
                  <button
                    className="btn btn-ghost btn-xs text-error"
                    type="button"
                    disabled={busy || active}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </button>
                </>
              )}
            </header>
            {rename !== null && (
              <form
                className="p-3 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    const result = await api.update(selected.id, {
                      title: rename,
                    });
                    setSelected({ ...result.session, writable: true });
                    setRename(null);
                    await list();
                  });
                }}
              >
                <input
                  aria-label="Conversation title"
                  className="input input-sm flex-1"
                  maxLength={200}
                  value={rename}
                  onChange={(event) => setRename(event.target.value)}
                />
                <button className="btn btn-sm" disabled={busy} type="submit">
                  Save title
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => setRename(null)}
                >
                  Cancel
                </button>
              </form>
            )}
            {confirmDelete && (
              <div role="alert" className="p-3 bg-error/10 text-sm">
                Permanently delete this Hermes conversation? This cannot be
                undone.
                <button
                  className="btn btn-error btn-xs mx-2"
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void act(async () => {
                      await api.delete(selected.id);
                      storageSet(`chat-draft:${selected.id}`, "");
                      setSelected(null);
                      setConfirmDelete(false);
                      await list();
                    })
                  }
                >
                  Confirm delete
                </button>
                <button
                  className="btn btn-xs"
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            )}
            <div
              ref={pane}
              className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-5"
              onScroll={() => {
                const p = pane.current;
                if (p)
                  setFollowing(
                    p.scrollHeight - p.scrollTop - p.clientHeight < 80,
                  );
              }}
            >
              {older && (
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const history = await api.messages(
                        selected.id,
                        messages.length,
                      );
                      setMessages((current) => [...history.data, ...current]);
                      setOlder(history.data.length === 100);
                      setFollowing(false);
                    })
                  }
                >
                  Load older messages
                </button>
              )}
              {loading && <p role="status">Loading conversation…</p>}
              {messages
                .filter(
                  (m) => m.display_kind !== "hidden" && m.role !== "system",
                )
                .map((m) => (
                  <article
                    key={m.id}
                    className={`max-w-4xl mx-auto p-4 rounded-xl ${m.role === "user" ? "bg-base-200" : ""}`}
                  >
                    <div className="text-xs font-semibold opacity-50 mb-2">
                      {m.role === "user"
                        ? "You"
                        : m.role === "tool"
                          ? m.tool_name || "Tool"
                          : "Lia"}
                    </div>
                    {m.role === "tool" ? (
                      <details>
                        <summary>Tool result</summary>
                        <pre className="whitespace-pre-wrap text-xs overflow-auto">
                          {messageText(m)}
                        </pre>
                      </details>
                    ) : (
                      <ChatMarkdown content={messageText(m)} />
                    )}
                    {m.reasoning && (
                      <details>
                        <summary>Model reasoning</summary>
                        <pre className="whitespace-pre-wrap text-sm">
                          {m.reasoning}
                        </pre>
                      </details>
                    )}
                    {m.tool_calls?.length ? (
                      <details>
                        <summary>Tool calls ({m.tool_calls.length})</summary>
                        <pre className="whitespace-pre-wrap text-xs overflow-auto">
                          {JSON.stringify(m.tool_calls, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs mt-2"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(messageText(m))
                          .catch(() => {})
                      }
                    >
                      Copy
                    </button>
                  </article>
                ))}
              {activity.length > 0 && (
                <details className="max-w-4xl mx-auto text-sm" open={active}>
                  <summary>Agent activity ({activity.length})</summary>
                  {activity.map((event, i) => (
                    <div key={event.seq ?? i} className="p-2">
                      <span className="font-mono text-xs">{event.event}</span>{" "}
                      {String(event.text ?? event.tool ?? event.preview ?? "")}
                    </div>
                  ))}
                </details>
              )}
              {stream && (
                <article className="max-w-4xl mx-auto p-4">
                  <ChatMarkdown content={stream} />
                </article>
              )}
              {active && (
                <p
                  role="status"
                  className="max-w-4xl mx-auto text-sm opacity-60"
                >
                  {run.status.replaceAll("_", " ")}…
                </p>
              )}
              {!messages.length && !loading && !active && (
                <p className="text-center opacity-50 py-12">
                  Start a conversation with Lia.
                </p>
              )}
            </div>
            {!following && (
              <button
                type="button"
                className="btn btn-xs self-center"
                onClick={() => setFollowing(true)}
              >
                Jump to latest
              </button>
            )}
            {active && run.approval && (
              <div role="alert" className="p-3 bg-warning/10 text-sm">
                <strong>Approval requested</strong>
                <pre className="whitespace-pre-wrap">
                  {String(
                    run.approval.command ??
                      run.approval.description ??
                      "Review this action before allowing it.",
                  )}
                </pre>
                {features.run_approval_response &&
                  approvalChoices.map((choice) => (
                    <button
                      key={choice}
                      className="btn btn-sm mr-2"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void control("approval", {
                          choice,
                          ...(run.approval?.request_id
                            ? { request_id: run.approval.request_id }
                            : {}),
                        })
                      }
                    >
                      {choice === "once"
                        ? "Allow once"
                        : choice === "deny"
                          ? "Deny"
                          : `Allow ${choice}`}
                    </button>
                  ))}
              </div>
            )}
            {selected.writable ? (
              <form
                className="p-3 border-t border-base-content/10 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <textarea
                  aria-label="Message Lia"
                  className="textarea w-full min-h-24"
                  maxLength={32000}
                  placeholder={
                    active
                      ? "Write guidance for the running agent…"
                      : "Message Lia…"
                  }
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    storageSet(`chat-draft:${selected.id}`, event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      if (!active && !busy) void send();
                    }
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Hermes model route"
                    className="select select-sm max-w-64"
                    value={model}
                    disabled={active}
                    onChange={(event) => {
                      setModel(event.target.value);
                      storageSet(
                        `chat-model:${selected.id}`,
                        event.target.value,
                      );
                    }}
                  >
                    <option value="">Hermes default</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs opacity-50 flex-1">
                    {run?.runtime?.model
                      ? `Used: ${run.runtime.model}`
                      : "Enter to send · Shift+Enter for a new line"}
                  </span>
                  {active ? (
                    <>
                      {features.run_steer && (
                        <button
                          className="btn btn-sm"
                          type="button"
                          disabled={
                            busy || !draft.trim() || run.status !== "running"
                          }
                          onClick={() =>
                            void control("steer", { input: draft })
                          }
                        >
                          Send guidance
                        </button>
                      )}
                      {features.run_stop && (
                        <button
                          className="btn btn-error btn-sm"
                          type="button"
                          disabled={busy || run.status === "stopping"}
                          onClick={() => void control("stop", {})}
                        >
                          Stop
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      type="submit"
                      disabled={
                        busy || loading || !draft.trim() || !ready || unresolved
                      }
                    >
                      Send
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <p className="p-4 text-sm opacity-60">
                Read-only history from another Hermes interface.
              </p>
            )}
          </>
        ) : (
          <div className="m-auto p-8 text-center max-w-lg">
            <h2 className="text-2xl font-semibold mb-3">Talk to Lia</h2>
            <p className="opacity-60">
              Your workspace, tools, and memories—with conversations saved by
              Hermes. Start a new chat or select one from the sidebar.
            </p>
            {!loading && !ready && !error && (
              <p className="mt-3 text-warning">
                This Hermes server does not advertise the session and run APIs
                required for chat.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
