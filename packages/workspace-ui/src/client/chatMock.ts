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
    {
      id: "demo-tools",
      title: "Research with workspace context",
      source: "hermes_browser",
      writable: true,
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
  messages.set("demo-tools", [
    {
      id: "question",
      role: "user",
      content: "Review the project notes and suggest the next steps.",
    },
    { id: "empty", role: "assistant", content: "" },
    {
      id: "calls",
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "read-1",
          function: {
            name: "read_file",
            arguments: "projects/example/overview.md",
          },
        },
        {
          id: "read-2",
          function: {
            name: "read_file",
            arguments: "projects/example/tasks.md",
          },
        },
        {
          id: "search-1",
          function: { name: "search_files", arguments: "next steps" },
        },
      ],
    },
    {
      id: "result-1",
      role: "tool",
      tool_name: "read_file",
      content: "Project overview: prepare a small, testable first release.",
    },
    {
      id: "result-2",
      role: "tool",
      tool_name: "read_file",
      content:
        "Tasks: review scope, verify the prototype, and collect feedback.",
    },
    {
      id: "result-3",
      role: "tool",
      tool_name: "search_files",
      content: "Found the planning checklist.",
    },
    {
      id: "answer",
      role: "assistant",
      content:
        'Here are the next steps:\n\n1. Confirm the scope of the first release.\n2. Test the prototype on desktop and mobile.\n3. Record feedback in the project notes.\n\n```javascript\nconst nextStep = "Review the prototype";\n```',
    },
  ]);
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
