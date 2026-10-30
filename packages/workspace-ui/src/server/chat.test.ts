import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { ChatRun, ChatSession } from "../shared/chat";
import { createWorkspaceHandler } from "./app";
import { ChatService, type ChatOptions } from "./chat";

let service: ChatService;
let options: ChatOptions;
let calls: {
  path: string;
  method: string;
  body: Record<string, unknown>;
  headers: Headers;
}[];
let sessions: ChatSession[];
let runs: Map<string, ChatRun>;
let admissions: Map<string, ChatRun>;
let lostAcceptance = false;
let upstreamError = false;
let approvalSupported = true;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlia-chat-test-"));
  calls = [];
  sessions = [
    { id: "telegram-1", title: "Personal history", source: "telegram" },
  ];
  runs = new Map();
  admissions = new Map();
  lostAcceptance = false;
  upstreamError = false;
  approvalSupported = true;
  options = {
    url: "http://hermes:8642",
    key: "test-server-secret",
    databasePath: ":memory:",
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const headers = new Headers(init?.headers);
      calls.push({ path: url.pathname + url.search, method, body, headers });
      expect(headers.get("Authorization")).toBe("Bearer test-server-secret");
      if (upstreamError)
        return Response.json(
          { error: "SECRET_PROVIDER_KEY=do-not-leak" },
          { status: 500 },
        );
      if (url.pathname === "/v1/capabilities")
        return Response.json({
          features: {
            session_resources: true,
            run_status: true,
            run_events_sse: true,
            run_approval_response: approvalSupported,
            runs_idempotency: {
              supported: true,
              durable: true,
              retention_seconds: 86400,
            },
          },
        });
      if (url.pathname === "/api/sessions") {
        if (method === "POST") {
          const session = body as ChatSession;
          sessions.push(session);
          return Response.json({ session }, { status: 201 });
        }
        return Response.json({
          data: sessions.filter(
            (s) =>
              !url.searchParams.get("source") ||
              s.source === url.searchParams.get("source"),
          ),
          has_more: false,
        });
      }
      if (url.pathname === "/v1/runs") {
        const key = headers.get("Idempotency-Key")!;
        let run = admissions.get(key);
        if (!run) {
          run = {
            run_id: `run-${admissions.size + 1}`,
            status: "running",
            session_id: String(body.session_id),
          };
          admissions.set(key, run);
          runs.set(run.run_id, run);
        }
        if (lostAcceptance) {
          lostAcceptance = false;
          throw new Error("acceptance response lost");
        }
        return Response.json(run, { status: 202 });
      }
      const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(.+))?$/);
      if (runMatch) {
        const run = runs.get(runMatch[1]!);
        if (!run) return new Response(null, { status: 404 });
        if (runMatch[2] === "events")
          return new Response(
            'id: 0\ndata: {"event":"message.delta","seq":0,"delta":"hello"}\n\n',
            { headers: { "Content-Type": "text/event-stream" } },
          );
        if (runMatch[2] === "stop") run.status = "stopping";
        if (runMatch[2] === "approval") {
          if (
            run.approval?.request_id !== body.request_id ||
            run.status !== "waiting_for_approval"
          )
            return Response.json({}, { status: 409 });
          run.status = "running";
          delete run.approval;
        }
        return Response.json(run);
      }
      if (url.pathname.endsWith("/messages"))
        return Response.json({
          data: [],
          session_id: url.pathname.split("/")[3],
        });
      const session = sessions.find(
        (s) => url.pathname === `/api/sessions/${s.id}`,
      );
      if (session) {
        if (method === "PATCH") Object.assign(session, body);
        return Response.json({ session });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  service = new ChatService(options);
});
afterEach(() => {
  service.close();
  rmSync(root, { recursive: true, force: true });
});

function request(
  path: string,
  method = "GET",
  body?: unknown,
  key = "test-message-key-1234",
) {
  return new Request(`http://localhost/api/chat${path}`, {
    method,
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function create() {
  const response = await service.handle(request("/sessions", "POST", {}));
  expect(response.status).toBe(201);
  return ((await response.json()) as { session: ChatSession }).session.id;
}
async function send(id: string, input = "hello", key?: string) {
  return service.handle(
    request(`/sessions/${id}/run`, "POST", { input, model: "" }, key),
  );
}

async function executions(id: string, offset = 0) {
  return (await (
    await service.handle(request(`/sessions/${id}/runs?offset=${offset}`))
  ).json()) as { data: ChatRun[]; has_more: boolean; next_offset: number };
}

describe("Hermes chat boundary", () => {
  test("returns a useful disabled state without opening a database", async () => {
    expect(
      (await new ChatService().handle(request("/capabilities"))).status,
    ).toBe(503);
    expect(calls).toHaveLength(0);
  });
  test("creates Hermes-owned browser sessions and lists other sources read-only", async () => {
    const id = await create();
    expect(id.startsWith("openlia-ui-")).toBe(true);
    const own = (await (await service.handle(request("/sessions"))).json()) as {
      data: ChatSession[];
    };
    expect(own.data).toHaveLength(1);
    expect(own.data[0]?.writable).toBe(true);
    const other = (await (
      await service.handle(request("/sessions?other=true&offset=50"))
    ).json()) as { data: ChatSession[]; next_offset: number };
    expect(other.data[0]?.id).toBe("telegram-1");
    expect(other.data[0]?.writable).toBe(false);
    expect(other.next_offset).toBe(100);
  });
  test("rejects all mutations of foreign sessions, even when called directly", async () => {
    for (const [method, suffix, body] of [
      ["PATCH", "", { title: "bad" }],
      ["DELETE", "", {}],
      ["POST", "/run", { input: "bad", model: "" }],
    ] as const) {
      expect(
        (
          await service.handle(
            request(`/sessions/telegram-1${suffix}`, method, body),
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (await service.handle(request("/runs/foreign/stop", "POST", {}))).status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });
  test("read-only history uses bounded latest-first pagination", async () => {
    await service.handle(request("/sessions/telegram-1/messages?offset=100"));
    expect(calls[0]?.path).toBe(
      "/api/sessions/telegram-1/messages?limit=100&offset=100&order=latest",
    );
  });
  test("rejects transcript rewrites and arbitrary upstream control fields", async () => {
    const id = await create();
    expect(
      (
        await service.handle(
          request(`/sessions/${id}`, "PATCH", { system_prompt: "override" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await service.handle(
          request(`/sessions/${id}`, "PATCH", { pinned: "true" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await service.handle(
          request(`/sessions/${id}`, "PATCH", { pinned: true }),
        )
      ).status,
    ).toBe(200);
  });
  test("reuses a durable retry identity and never sends browser-supplied history", async () => {
    const id = await create();
    const first = (await (await send(id)).json()) as ChatRun;
    const retry = (await (await send(id)).json()) as ChatRun;
    expect(retry.run_id).toBe(first.run_id);
    expect(admissions.size).toBe(1);
    const dispatch = calls.find((c) => c.path === "/v1/runs")!;
    expect(dispatch.body).toEqual({ session_id: id, input: "hello" });
    expect(dispatch.headers.get("Idempotency-Key")).toBe(
      "workspace-ui-test-message-key-1234",
    );
    expect((await send(id, "changed")).status).toBe(409);
  });
  test("recovers lost acceptance by retrying the same Hermes key", async () => {
    const id = await create();
    lostAcceptance = true;
    expect((await send(id)).status).toBe(502);
    expect(
      (await send(id, "different message", "different-message-key")).status,
    ).toBe(409);
    expect((await send(id)).status).toBe(202);
    expect(admissions.size).toBe(1);
  });
  test("does not redispatch uncertain requests beyond the retry retention window", async () => {
    service.close();
    options.databasePath = join(root, "chat.sqlite");
    service = new ChatService(options);
    const id = await create();
    lostAcceptance = true;
    expect((await send(id)).status).toBe(502);
    const db = new Database(options.databasePath);
    db.query("UPDATE chat_requests SET retry_until = 0").run();
    db.close();
    const before = calls.filter((c) => c.path === "/v1/runs").length;
    expect((await send(id)).status).toBe(409);
    expect(calls.filter((c) => c.path === "/v1/runs")).toHaveLength(before);
  });
  test("expired run records do not hide transcripts or silently allow uncertain runs", async () => {
    const id = await create();
    const run = (await (await send(id)).json()) as ChatRun;
    runs.delete(run.run_id);
    const state = (await (
      await service.handle(request(`/sessions/${id}/run`))
    ).json()) as { run: ChatRun };
    expect(state.run.status).toBe("unknown");
    expect(
      (await service.handle(request(`/sessions/${id}/messages`))).status,
    ).toBe(200);
    expect(
      (await send(id, "new message", "new-message-key-12345")).status,
    ).toBe(409);
  });
  test("expired completed run records retain their safe terminal state", async () => {
    const id = await create();
    const run = (await (await send(id)).json()) as ChatRun;
    runs.get(run.run_id)!.status = "completed";
    await service.handle(request(`/runs/${run.run_id}`));
    runs.delete(run.run_id);
    const state = (await (
      await service.handle(request(`/sessions/${id}/run`))
    ).json()) as { run: ChatRun };
    expect(state.run.status).toBe("completed");
    expect((await send(id, "next", "next-message-key-12345")).status).toBe(202);
  });
  test("failed status and observed time survive server recreation and expired Hermes metadata", async () => {
    service.close();
    options.databasePath = join(root, "chat.sqlite");
    service = new ChatService(options);
    const id = await create();
    const run = (await (await send(id)).json()) as ChatRun;
    Object.assign(runs.get(run.run_id)!, {
      status: "failed",
      error: "SECRET_PROVIDER_KEY=never-cache",
    });
    const observed = (await (
      await service.handle(request(`/runs/${run.run_id}`))
    ).json()) as ChatRun;
    expect(observed.status).toBe("failed");
    expect(observed.status_source).toBe("hermes");
    expect(observed.status_observed_at).toBeNumber();
    service.close();
    runs.delete(run.run_id);
    service = new ChatService(options);
    const reopened = (await (
      await service.handle(request(`/sessions/${id}/run`))
    ).json()) as { run: ChatRun };
    expect(reopened.run.status).toBe("failed");
    expect(reopened.run.status_source).toBe("recorded");
    expect(reopened.run.status_observed_at).toBe(observed.status_observed_at);
    const history = await executions(id);
    expect(history.data[0]?.status).toBe("failed");
    expect(JSON.stringify(history)).not.toContain("SECRET_PROVIDER_KEY");
    expect(history.data[0]).not.toHaveProperty("error");
    expect(history.data[0]).not.toHaveProperty("key");
    expect(history.data[0]).not.toHaveProperty("fingerprint");
    expect(admissions.size).toBe(1);
  });
  test("unconfirmed acceptance is exposed rather than hidden behind an earlier completed run", async () => {
    const id = await create();
    const first = (await (await send(id)).json()) as ChatRun;
    runs.get(first.run_id)!.status = "completed";
    await service.handle(request(`/runs/${first.run_id}`));
    lostAcceptance = true;
    expect(
      (await send(id, "next request", "different-message-key-1234")).status,
    ).toBe(502);
    const state = (await (
      await service.handle(request(`/sessions/${id}/run`))
    ).json()) as { run: ChatRun };
    expect(state.run.run_id).toBe("");
    expect(state.run.status).toBe("unknown");
    expect(state.run.status_source).toBe("unconfirmed");
    const history = await executions(id);
    expect(history.data.map((run: ChatRun) => run.status)).toEqual([
      "unknown",
      "completed",
    ]);
    expect(
      (await send(id, "another request", "another-message-key-1234")).status,
    ).toBe(409);
    expect(admissions.size).toBe(2);
  });
  test("history preserves an earlier failure after a later run completes", async () => {
    const id = await create();
    const first = (await (await send(id)).json()) as ChatRun;
    runs.get(first.run_id)!.status = "failed";
    await service.handle(request(`/runs/${first.run_id}`));
    const second = (await (
      await send(id, "later message", "later-message-key-1234")
    ).json()) as ChatRun;
    runs.get(second.run_id)!.status = "completed";
    await service.handle(request(`/runs/${second.run_id}`));
    const history = await executions(id);
    expect(
      history.data.map((run: ChatRun) => [run.run_id, run.status]),
    ).toEqual([
      [second.run_id, "completed"],
      [first.run_id, "failed"],
    ]);
    expect(
      history.data.every((run: ChatRun) => run.status_source === "recorded"),
    ).toBe(true);
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.path === "/v1/runs",
      ),
    ).toHaveLength(2);
  });
  test("migrates legacy routing metadata without inventing historical timestamps", async () => {
    service.close();
    options.databasePath = join(root, "legacy-chat.sqlite");
    const db = new Database(options.databasePath);
    db.exec(
      "CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, root_id TEXT NOT NULL); CREATE TABLE chat_requests (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, run_id TEXT, status TEXT, retry_until REAL NOT NULL)",
    );
    db.query(
      "INSERT INTO chat_sessions VALUES ('legacy-chat', 'legacy-chat')",
    ).run();
    db.query(
      "INSERT INTO chat_requests VALUES ('legacy-key', 'legacy-chat', 'legacy-fingerprint', 'expired-failed-run', 'failed', 0)",
    ).run();
    db.close();
    service = new ChatService(options);
    const state = (await (
      await service.handle(request("/sessions/legacy-chat/run"))
    ).json()) as { run: ChatRun };
    expect(state.run.status).toBe("failed");
    expect(state.run.status_source).toBe("recorded");
    expect(state.run).not.toHaveProperty("submitted_at");
    expect(state.run).not.toHaveProperty("status_observed_at");
    const history = await executions("legacy-chat");
    expect(history.data).toHaveLength(1);
    expect(history.data[0]?.run_id).toBe("expired-failed-run");
  });
  test("execution history is bounded, locally owned and read-only", async () => {
    service.close();
    options.databasePath = join(root, "chat.sqlite");
    service = new ChatService(options);
    const id = await create();
    const db = new Database(options.databasePath);
    for (let i = 0; i < 53; i++)
      db.query(
        "INSERT INTO chat_requests(key, session_id, fingerprint, run_id, status, retry_until) VALUES (?, ?, 'private-fingerprint', ?, 'failed', 0)",
      ).run(`private-key-${i}`, id, `history-run-${i}`);
    db.close();
    const first = await executions(id);
    expect(first.data).toHaveLength(50);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(50);
    const last = await executions(id, 50);
    expect(last.data).toHaveLength(3);
    expect(last.has_more).toBe(false);
    expect(last.next_offset).toBe(53);
    expect(JSON.stringify(first)).not.toContain("private-key");
    expect(JSON.stringify(first)).not.toContain("private-fingerprint");
    expect(
      (await service.handle(request("/sessions/telegram-1/runs"))).status,
    ).toBe(403);
    expect(calls).toHaveLength(1); // Session creation only; inspection does not dispatch or query all Hermes runs.
  });
  test("prevents two tabs from dispatching overlapping runs", async () => {
    const id = await create();
    const results = await Promise.all([
      send(id),
      send(id, "second", "second-message-key-1234"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(admissions.size).toBe(1);
  });
  test("persists active run associations and adopts Hermes compaction tips", async () => {
    const id = await create();
    const run = (await (await send(id)).json()) as ChatRun;
    runs.get(run.run_id)!.session_id = "compacted-tip";
    const response = await service.handle(request(`/sessions/${id}/run`));
    expect(((await response.json()) as { run: ChatRun }).run.session_id).toBe(
      "compacted-tip",
    );
    sessions.push({ id: "compacted-tip", source: "api_server" });
    const tip = (await (
      await service.handle(request("/sessions/compacted-tip"))
    ).json()) as { session: ChatSession };
    expect(tip.session.writable).toBe(true);
    const activeTip = (await (
      await service.handle(request("/sessions/compacted-tip/run"))
    ).json()) as { run: ChatRun };
    expect(activeTip.run.run_id).toBe(run.run_id);
    expect(
      (await send("compacted-tip", "overlapping", "compaction-message-key"))
        .status,
    ).toBe(409);
  });
  test("proxies reconnect cursors without exposing upstream headers or stopping the run", async () => {
    const id = await create();
    const run = (await (await send(id)).json()) as ChatRun;
    const response = await service.handle(
      request(`/runs/${run.run_id}/events?last_seq=-1`),
    );
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await response.text()).toContain("message.delta");
    expect(calls.at(-1)?.path).toEndWith("last_seq=-1");
    expect(calls.filter((c) => c.path.endsWith("/stop"))).toHaveLength(0);
    expect(response.headers.get("Authorization")).toBeNull();
  });
  test("forwards exact approval request IDs and only allowlisted control fields", async () => {
    const id = await create();
    const run = (await (await send(id)).json()) as ChatRun;
    Object.assign(runs.get(run.run_id)!, {
      status: "waiting_for_approval",
      approval: { request_id: "approval-123", choices: ["once", "deny"] },
    });
    await service.handle(
      request(`/runs/${run.run_id}/approval`, "POST", {
        choice: "once",
        request_id: "approval-123",
        all: true,
        api_key: "ignored",
      }),
    );
    expect(calls.at(-1)?.body).toEqual({
      choice: "once",
      request_id: "approval-123",
    });
    expect(runs.get(run.run_id)?.status).toBe("running");
    expect(
      (
        await service.handle(
          request(`/runs/${run.run_id}/approval`, "POST", {
            choice: "anything",
          }),
        )
      ).status,
    ).toBe(400);
  });
  test("rejects stale, missing, unsupported, and unadvertised approval responses", async () => {
    const id = await create();
    const run = (await (await send(id)).json()) as ChatRun;
    const pending = runs.get(run.run_id)!;
    pending.status = "waiting_for_approval";
    pending.approval = { request_id: "current", choices: ["once", "deny"] };
    for (const [body, status] of [
      [{ choice: "once" }, 400],
      [{ choice: "once", request_id: "stale" }, 409],
      [{ choice: "always", request_id: "current" }, 409],
    ] as const) {
      expect(
        (
          await service.handle(
            request(`/runs/${run.run_id}/approval`, "POST", body),
          )
        ).status,
      ).toBe(status);
    }
    approvalSupported = false;
    expect(
      (
        await service.handle(
          request(`/runs/${run.run_id}/approval`, "POST", {
            choice: "once",
            request_id: "current",
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      calls.filter((call) => call.path.endsWith("/approval")),
    ).toHaveLength(0);
    approvalSupported = true;
    expect(
      (
        await service.handle(
          request(`/runs/${run.run_id}/approval`, "POST", {
            choice: "deny",
            request_id: "current",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await service.handle(
          request(`/runs/${run.run_id}/approval`, "POST", {
            choice: "once",
            request_id: "current",
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      calls.filter((call) => call.path.endsWith("/approval")),
    ).toHaveLength(1);
  });
  test("redacts upstream failures and limits body size", async () => {
    const id = await create();
    upstreamError = true;
    const failed = await service.handle(request("/capabilities"));
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("SECRET_PROVIDER_KEY");
    upstreamError = false;
    expect(
      (
        await service.handle(
          request(`/sessions/${id}`, "PATCH", { title: "x".repeat(150_000) }),
        )
      ).status,
    ).toBe(413);
  });
  test("chat routes reuse authentication and reject cross-origin mutations", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      sharesDatabasePath: ":memory:",
      chat: options,
    });
    const crossOrigin = new Request("http://localhost/api/chat/sessions", {
      method: "POST",
      headers: { Origin: "http://evil.invalid" },
      body: "{}",
    });
    expect((await handler(crossOrigin)).status).toBe(403);
    const authenticated = createWorkspaceHandler({
      workspaceRoot: root,
      sharesDatabasePath: ":memory:",
      authRequired: true,
      passwordHash: await Bun.password.hash("test-password"),
      sessionDatabasePath: ":memory:",
      chat: options,
    });
    expect((await authenticated(request("/capabilities"))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  test("routing survives server recreation without duplicating transcripts", async () => {
    service.close();
    options.databasePath = join(root, "chat.sqlite");
    service = new ChatService(options);
    const id = await create();
    const run = (await (await send(id)).json()) as ChatRun;
    service.close();
    service = new ChatService(options);
    const state = (await (
      await service.handle(request(`/sessions/${id}/run`))
    ).json()) as { run: ChatRun };
    expect(state.run.run_id).toBe(run.run_id);
    const db = new Database(options.databasePath, { readonly: true });
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();
    expect(tables).toEqual([
      { name: "chat_requests" },
      { name: "chat_sessions" },
    ]);
    expect(db.query("SELECT * FROM chat_requests").get()).not.toHaveProperty(
      "input",
    );
    db.close();
  });
});
