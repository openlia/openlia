import type {
  ChatApi,
  ChatMessage,
  ChatRun,
  ChatSession,
} from "../shared/chat";

export function createChatMock(): ChatApi {
  const sessions: ChatSession[] = [
    {
      id: "demo-chat",
      title: "Getting started with Lia",
      source: "hermes_browser",
      writable: true,
      pinned: true,
    },
  ];
  const messages = new Map<string, ChatMessage[]>([
    [
      "demo-chat",
      [
        {
          id: 1,
          role: "assistant",
          content:
            "Hello! Ask me about your workspace, or start a new conversation.",
        },
      ],
    ],
  ]);
  const runs = new Map<string, ChatRun>();
  const keys = new Map<string, string>();
  const session = (id: string) => {
    const s = sessions.find((s) => s.id === id);
    if (!s) throw new Error("Session not found");
    return s;
  };
  const requireRun = (id: string) => {
    const run = runs.get(id);
    if (!run) throw new Error("Run not found");
    return run;
  };
  return {
    capabilities: async () => ({
      features: {
        session_resources: true,
        run_status: true,
        run_events_sse: true,
        run_stop: true,
        run_steer: true,
        run_approval_response: true,
      },
    }),
    models: async () => ({ data: [{ id: "hermes-agent" }] }),
    sessions: async (_offset, other) => ({
      data: other
        ? [
            {
              id: "telegram-demo",
              title: "Telegram conversation",
              source: "telegram",
              writable: false,
            },
          ]
        : sessions.filter((s) => !s.archived),
      has_more: false,
      next_offset: 50,
    }),
    create: async () => {
      const s: ChatSession = {
        id: crypto.randomUUID(),
        title: "New conversation",
        writable: true,
      };
      sessions.unshift(s);
      messages.set(s.id, []);
      return { session: s };
    },
    session: async (id) => ({ session: session(id) }),
    update: async (id, patch) => {
      Object.assign(session(id), patch);
      return { session: { ...session(id) } };
    },
    delete: async (id) => {
      sessions.splice(sessions.indexOf(session(id)), 1);
      return {};
    },
    messages: async (id, offset) => ({
      data: offset ? [] : [...(messages.get(id) ?? [])],
      session_id: id,
    }),
    activeRun: async (id) => ({
      run:
        [...runs.values()].reverse().find((r) => r.session_id === id) ?? null,
    }),
    send: async (id, input, key) => {
      const previous = keys.get(key);
      if (previous) return requireRun(previous);
      const run: ChatRun = {
        run_id: crypto.randomUUID(),
        session_id: id,
        status: "running",
      };
      keys.set(key, run.run_id);
      runs.set(run.run_id, run);
      const history = messages.get(id) ?? [];
      history.push({ id: crypto.randomUUID(), role: "user", content: input });
      messages.set(id, history);
      setTimeout(() => {
        if (run.status !== "running") return;
        run.status = "completed";
        run.output =
          "This is a mock reply. In a deployed workspace, Lia uses Hermes’ tools and persistent conversation history to help you.";
        history.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: run.output,
        });
      }, 800);
      return { ...run };
    },
    run: async (id) => ({ ...requireRun(id) }),
    control: async (id, action) => {
      if (action === "stop") requireRun(id).status = "cancelled";
      return {};
    },
    events: async (id, _seq, signal, onEvent) => {
      if (signal.aborted) return;
      onEvent({ event: "tool.started", tool: "workspace", seq: 0 });
      const run = requireRun(id);
      if (run.status === "completed")
        onEvent({ event: "message.delta", delta: run.output ?? "", seq: 1 });
    },
  };
}
