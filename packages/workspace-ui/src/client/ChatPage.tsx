import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { ChatApiError } from "./chatApi";
import { ChatTranscript } from "./ChatTranscript";
import { ChatNavigation } from "./ChatNavigation";
import { ChatHeader } from "./ChatHeader";
import { ChatComposer } from "./ChatComposer";
import "./chat.css";
import {
  terminalChatStatuses,
  chatApprovalChoices,
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
  if (value === "chat_approval_unsupported")
    return "This Hermes API cannot accept approvals. Update and recreate both Hermes and Workspace UI; do not disable approval safeguards.";
  if (value === "chat_approval_stale")
    return "This approval is no longer pending. Refresh the conversation and review the current request.";
  return value.replaceAll("_", " ");
}

export function ChatPage({
  api,
  initialPrompt,
  onConsumeInitialPrompt,
}: {
  api: ChatApi;
  initialPrompt?: string | undefined;
  onConsumeInitialPrompt?: (() => void) | undefined;
}) {
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pane = useRef<HTMLElement>(null);
  const generation = useRef(0);
  const controlPending = useRef(false);
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
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () =>
      document.documentElement.style.setProperty(
        "--chat-viewport-height",
        `${viewport.height}px`,
      );
    resize();
    viewport.addEventListener("resize", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      document.documentElement.style.removeProperty("--chat-viewport-height");
    };
  }, []);

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

  useEffect(() => {
    if (!initialPrompt || loading) return;
    if (selected?.writable) {
      setDraft(initialPrompt);
      storageSet(`chat-draft:${selected.id}`, initialPrompt);
      onConsumeInitialPrompt?.();
      return;
    }
    const firstWritable = sessions.find((s) => s.writable);
    if (firstWritable) {
      storageSet(`chat-draft:${firstWritable.id}`, initialPrompt);
      void select(firstWritable).then(() => {
        setDraft(initialPrompt);
        onConsumeInitialPrompt?.();
      });
      return;
    }
    if (ready && !busy) {
      setBusy(true);
      setError("");
      void (async () => {
        try {
          const result = await api.create();
          storageSet(`chat-draft:${result.session.id}`, initialPrompt);
          await select(result.session);
          setDraft(initialPrompt);
          onConsumeInitialPrompt?.();
          await list(0, false);
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      })();
    }
  }, [
    api,
    busy,
    initialPrompt,
    list,
    loading,
    onConsumeInitialPrompt,
    ready,
    select,
    selected,
    sessions,
  ]);

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
      else if (event.event === "approval.responded")
        setRun((current) => {
          if (!current || current.approval?.request_id !== event.request_id)
            return current;
          const next = { ...current, status: "running" };
          delete next.approval;
          return next;
        });
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
  ) => {
    if (controlPending.current) return;
    return act(async () => {
      if (!run) return;
      controlPending.current = true;
      const version = generation.current;
      try {
        await api.control(run.run_id, action, body);
        const status = await api.run(run.run_id);
        if (version !== generation.current) return;
        setRun(status);
        if (action === "steer") {
          setDraft("");
          if (selected) storageSet(`chat-draft:${selected.id}`, "");
        }
      } finally {
        controlPending.current = false;
      }
    });
  };
  const visible = [...sessions]
    .filter((s) =>
      (s.title ?? "New conversation")
        .toLowerCase()
        .includes(filter.toLowerCase()),
    )
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const approvalChoices = chatApprovalChoices(run?.approval);
  const canApprove = Boolean(
    features.run_approval_response &&
      typeof run?.approval?.request_id === "string" &&
      run.approval.request_id &&
      approvalChoices.length,
  );

  return (
    <section aria-label="Chat" className="chat-layout">
      <ChatNavigation
        sessions={visible}
        selectedId={selectedId}
        other={other}
        filter={filter}
        hasMore={hasMore}
        loading={loading}
        busy={busy}
        ready={ready}
        drawerOpen={drawerOpen}
        onClose={closeDrawer}
        onSelect={(session) => void select(session)}
        onNew={() =>
          void act(async () => {
            const result = await api.create();
            if (other) setOther(false);
            await select(result.session);
            await list(0, false);
          })
        }
        onSource={(readOther) => {
          setSelected(null);
          setRun(null);
          setMessages([]);
          const url = new URL(window.location.href);
          url.searchParams.delete("conversation");
          window.history.replaceState(null, "", url);
          setOther(readOther);
        }}
        onFilter={setFilter}
        onMore={() =>
          void act(async () => {
            await list(offset);
          })
        }
      />
      <div className="chat-main">
        <ChatHeader
          session={selected}
          busy={busy}
          active={active}
          onOpenConversations={() => setDrawerOpen(true)}
          onAction={(action) => {
            if (!selected?.writable) return;
            if (action === "rename") setRename(selected.title ?? "");
            else if (action === "delete") setConfirmDelete(true);
            else if (action === "pin")
              void act(async () => {
                await api.update(selected.id, { pinned: !selected.pinned });
                setSelected({ ...selected, pinned: !selected.pinned });
                await list();
              });
            else
              void act(async () => {
                await api.update(selected.id, { archived: true });
                setArchived(selected);
                setSelected(null);
                await list();
              });
          }}
        />
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
            <section
              ref={pane}
              className="chat-transcript"
              aria-label="Conversation messages"
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
              <ChatTranscript messages={messages} />
              {activity.length > 0 && active && (
                <details className="chat-live-activity chat-tool-group">
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
                <article
                  className="chat-turn chat-turn--assistant"
                  aria-label="Lia streaming response"
                >
                  <div className="chat-speaker">Lia</div>
                  <ChatMarkdown content={stream} />
                </article>
              )}
              {active && (
                <p role="status" className="chat-run-status">
                  {run.status.replaceAll("_", " ")}…
                </p>
              )}
              {!messages.length && !loading && !active && (
                <p className="text-center opacity-50 py-12">
                  Start a conversation with Lia.
                </p>
              )}
            </section>
            {!following && (
              <button
                type="button"
                className="chat-jump btn btn-sm"
                onClick={() => setFollowing(true)}
              >
                Jump to latest
              </button>
            )}
            {active && run.status === "waiting_for_approval" && (
              <div role="alert" className="p-3 bg-warning/10 text-sm">
                <strong>Approval requested</strong>
                <pre className="whitespace-pre-wrap">
                  {String(
                    run.approval?.description ??
                      run.approval?.command ??
                      "Review this action before allowing it.",
                  )}
                </pre>
                {run.approval?.description && run.approval.command ? (
                  <pre className="whitespace-pre-wrap">
                    {String(run.approval.command)}
                  </pre>
                ) : null}
                {!canApprove && (
                  <p>
                    This Hermes API cannot provide an actionable approval.
                    Update and recreate both Hermes and Workspace UI, then
                    reopen the conversation. Do not disable approval safeguards.
                  </p>
                )}
                {canApprove &&
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
              <ChatComposer
                draft={draft}
                model={model}
                models={models}
                run={run}
                active={active}
                busy={busy}
                disabled={loading || !ready || unresolved}
                canSteer={Boolean(features.run_steer)}
                canStop={Boolean(features.run_stop)}
                onDraft={(value) => {
                  setDraft(value);
                  storageSet(`chat-draft:${selected.id}`, value);
                }}
                onModel={(value) => {
                  setModel(value);
                  storageSet(`chat-model:${selected.id}`, value);
                }}
                onSend={() => void send()}
                onSteer={() => void control("steer", { input: draft })}
                onStop={() => void control("stop", {})}
              />
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
            {initialPrompt && (
              <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-left text-xs">
                <div className="mb-1 font-semibold uppercase tracking-wider text-primary">
                  Prepared Prompt
                </div>
                <pre className="whitespace-pre-wrap font-mono text-base-content/80">
                  {initialPrompt}
                </pre>
              </div>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm mt-4 chat-empty-conversations"
              onClick={() => setDrawerOpen(true)}
            >
              Browse conversations
            </button>
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
