import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  terminalChatStatuses,
  chatApprovalChoices,
  type ChatCapabilities,
  type ChatRun,
  type ChatSession,
} from "../shared/chat";

export interface ChatOptions {
  url: string;
  key: string;
  databasePath: string;
  fetch?: typeof fetch;
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Only routing/ownership metadata lives here. Hermes owns all transcripts.
export class ChatService {
  private db: Database | undefined;
  constructor(private readonly options?: ChatOptions) {}

  close() {
    this.db?.close();
    this.db = undefined;
  }

  private store() {
    if (!this.options) throw new ChatError(503, "chat_not_configured");
    if (!this.db) {
      if (this.options.databasePath !== ":memory:")
        mkdirSync(dirname(this.options.databasePath), {
          recursive: true,
          mode: 0o700,
        });
      this.db = new Database(this.options.databasePath, { create: true });
      if (this.options.databasePath !== ":memory:")
        chmodSync(this.options.databasePath, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, root_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_requests (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, run_id TEXT, status TEXT, retry_until REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS chat_requests_session ON chat_requests(session_id);`);
    }
    return this.db;
  }

  private owned(id: string) {
    return Boolean(
      this.store().query("SELECT id FROM chat_sessions WHERE id = ?").get(id),
    );
  }

  private rootId(id: string) {
    const row = this.store()
      .query("SELECT root_id FROM chat_sessions WHERE id = ?")
      .get(id) as { root_id: string } | null;
    return row?.root_id ?? id;
  }

  private register(id: string, root = id) {
    this.store()
      .query("INSERT OR IGNORE INTO chat_sessions VALUES (?, ?)")
      .run(id, this.rootId(root));
  }

  private requireOwned(id: string) {
    if (!this.owned(id)) throw new ChatError(403, "chat_session_read_only");
  }

  private async upstream(path: string, init: RequestInit = {}) {
    if (!this.options) throw new ChatError(503, "chat_not_configured");
    const headers = new Headers({
      Authorization: `Bearer ${this.options.key}`,
      "Content-Type": "application/json",
    });
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.options.url.replace(/\/$/, "")}${path}`,
        {
          ...init,
          headers,
          redirect: "error",
          signal: init.signal ?? AbortSignal.timeout(20_000),
        },
      );
    } catch {
      throw new ChatError(502, "hermes_unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Never return upstream exception text, provider credentials, or headers.
      throw new ChatError(
        response.status >= 500 ? 502 : response.status,
        `hermes_request_failed_${response.status}`,
      );
    }
    return response;
  }

  private async get<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.upstream(path, init)).json() as Promise<T>;
  }

  private async status(runId: string): Promise<ChatRun> {
    const row = this.store()
      .query("SELECT session_id, status FROM chat_requests WHERE run_id = ?")
      .get(runId) as { session_id: string; status: string } | null;
    if (!row) throw new ChatError(404, "chat_run_not_found");
    this.requireOwned(row.session_id);
    let run: ChatRun;
    try {
      run = await this.get<ChatRun>(`/v1/runs/${encodeURIComponent(runId)}`);
    } catch (error) {
      if (!(error instanceof ChatError) || error.status !== 404) throw error;
      // Hermes eventually expires run records. Never let that erase readable history
      // or turn an uncertain run into a fresh dispatch.
      run = {
        run_id: runId,
        session_id: row.session_id,
        status: terminalChatStatuses.has(row.status) ? row.status : "unknown",
      };
    }
    this.store()
      .query("UPDATE chat_requests SET status = ? WHERE run_id = ?")
      .run(run.status, runId);
    // Compaction can rotate the live session ID. Register the Hermes-returned tip.
    if (run.session_id) this.register(run.session_id, row.session_id);
    return run;
  }

  async handle(request: Request): Promise<Response> {
    try {
      this.store();
      const url = new URL(request.url);
      const path = url.pathname.slice("/api/chat".length);
      const method = request.method;
      if (method === "GET" && path === "/capabilities")
        return json(await this.get("/v1/capabilities"));
      if (method === "GET" && path === "/models")
        return json(await this.get("/v1/models"));
      if (method === "GET" && path === "/sessions") {
        const offset = Math.max(
          0,
          Math.min(1_000_000, Number(url.searchParams.get("offset")) || 0),
        );
        const other = url.searchParams.get("other") === "true";
        const result = await this.get<{
          data: ChatSession[];
          has_more: boolean;
        }>(
          `/api/sessions?limit=50&offset=${offset}${other ? "" : "&source=api_server"}`,
        );
        const data = result.data.map((s) => ({
          ...s,
          writable:
            this.owned(s.id) ||
            Boolean(s._lineage_root_id && this.owned(s._lineage_root_id)),
        }));
        for (const s of data)
          if (s.writable) this.register(s.id, s._lineage_root_id ?? s.id);
        return json({
          ...result,
          data: data.filter((s) => (other ? !s.writable : s.writable)),
          next_offset: offset + 50,
        });
      }
      if (method === "POST" && path === "/sessions") {
        const id = `openlia-ui-${crypto.randomUUID()}`;
        const result = await this.get<{ session: ChatSession }>(
          "/api/sessions",
          {
            method: "POST",
            body: JSON.stringify({ id, source: "api_server" }),
          },
        );
        this.register(id);
        return json({ session: { ...result.session, writable: true } }, 201);
      }
      const sessionMatch = path.match(
        /^\/sessions\/([^/]+)(?:\/(messages|run))?$/,
      );
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1] ?? "");
        const resource = sessionMatch[2];
        const upstreamPath = `/api/sessions/${encodeURIComponent(id)}`;
        if (method === "GET" && !resource) {
          const result = await this.get<{ session: ChatSession }>(upstreamPath);
          const writable =
            this.owned(id) ||
            Boolean(
              result.session._lineage_root_id &&
                this.owned(result.session._lineage_root_id),
            );
          if (writable)
            this.register(id, result.session._lineage_root_id ?? id);
          return json({ session: { ...result.session, writable } });
        }
        if (method === "GET" && resource === "messages") {
          const offset = Math.max(
            0,
            Math.min(1_000_000, Number(url.searchParams.get("offset")) || 0),
          );
          return json(
            await this.get(
              `${upstreamPath}/messages?limit=100&offset=${offset}&order=latest`,
            ),
          );
        }
        if (method === "GET" && resource === "run") {
          this.requireOwned(id);
          const row = this.store()
            .query(
              "SELECT run_id FROM chat_requests WHERE session_id IN (SELECT id FROM chat_sessions WHERE root_id = ?) AND run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1",
            )
            .get(this.rootId(id)) as { run_id: string } | null;
          return json({ run: row ? await this.status(row.run_id) : null });
        }
        this.requireOwned(id);
        if (method === "PATCH" && !resource) {
          const body = await this.body(request);
          for (const [key, value] of Object.entries(body)) {
            if (
              key === "title"
                ? typeof value !== "string" || value.length > 200
                : !["pinned", "archived"].includes(key) ||
                  typeof value !== "boolean"
            )
              throw new ChatError(400, "invalid_chat_update");
          }
          return json(
            await this.get(upstreamPath, {
              method,
              body: JSON.stringify(body),
            }),
          );
        }
        if (method === "DELETE" && !resource) {
          const result = await this.get(upstreamPath, { method });
          this.store().query("DELETE FROM chat_sessions WHERE id = ?").run(id);
          return json(result);
        }
        if (method === "POST" && resource === "run") {
          const body = await this.body(request);
          const input = body.input;
          const model = body.model;
          const key = request.headers.get("Idempotency-Key") ?? "";
          if (
            typeof input !== "string" ||
            !input.trim() ||
            input.length > 32_000 ||
            typeof model !== "string" ||
            model.length > 200 ||
            !/^[a-zA-Z0-9_-]{16,100}$/.test(key)
          )
            throw new ChatError(400, "invalid_chat_message");
          const fingerprint = createHash("sha256")
            .update(JSON.stringify([id, input, model, this.options?.key]))
            .digest("hex");
          const old = this.store()
            .query(
              "SELECT fingerprint, run_id, retry_until FROM chat_requests WHERE key = ?",
            )
            .get(key) as {
            fingerprint: string;
            run_id: string | null;
            retry_until: number;
          } | null;
          if (old && old.fingerprint !== fingerprint)
            throw new ChatError(409, "chat_retry_conflict");
          if (old?.run_id) return json(await this.status(old.run_id));
          if (old && Date.now() >= old.retry_until)
            throw new ChatError(
              409,
              "chat_retry_window_expired_inspect_hermes",
            );
          const capabilities = await this.get<{
            features: {
              runs_idempotency?: {
                supported: boolean;
                durable: boolean;
                retention_seconds: number;
              };
            };
          }>("/v1/capabilities");
          const retry = capabilities.features.runs_idempotency;
          if (
            !retry?.supported ||
            !retry.durable ||
            !Number.isFinite(retry.retention_seconds) ||
            retry.retention_seconds <= 60
          )
            throw new ChatError(503, "chat_requires_durable_runs");
          const retryUntil =
            Date.now() +
            Math.min(23 * 3600, retry.retention_seconds - 60) * 1000;
          if (!old) {
            const previous = this.store()
              .query(
                "SELECT run_id FROM chat_requests WHERE session_id IN (SELECT id FROM chat_sessions WHERE root_id = ?) AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'rejected') ORDER BY rowid DESC LIMIT 1",
              )
              .get(this.rootId(id)) as { run_id: string | null } | null;
            if (previous?.run_id) {
              const status = await this.status(previous.run_id);
              if (
                !terminalChatStatuses.has(status.status) ||
                status.status === "unknown"
              )
                throw new ChatError(409, "chat_run_already_active");
            }
          }
          // Persist retry identity before dispatch, including when the acceptance response is lost.
          this.store().transaction(() => {
            const conflicting = this.store()
              .query(
                "SELECT key FROM chat_requests WHERE session_id IN (SELECT id FROM chat_sessions WHERE root_id = ?) AND key != ? AND (status IS NULL OR status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'rejected')) LIMIT 1",
              )
              .get(this.rootId(id), key);
            if (conflicting)
              throw new ChatError(409, "chat_run_already_active");
            this.store()
              .query(
                "INSERT OR IGNORE INTO chat_requests(key, session_id, fingerprint, status, retry_until) VALUES (?, ?, ?, 'dispatching', ?)",
              )
              .run(key, id, fingerprint, retryUntil);
          })();
          let run: ChatRun;
          try {
            run = await this.get<ChatRun>("/v1/runs", {
              method: "POST",
              headers: { "Idempotency-Key": `workspace-ui-${key}` },
              body: JSON.stringify({
                session_id: id,
                input,
                ...(model ? { model } : {}),
              }),
            });
          } catch (error) {
            // A definitive validation/auth refusal did not admit a run. Network failures
            // and 5xx remain uncertain and must reuse the original identity.
            if (
              error instanceof ChatError &&
              [400, 401, 403, 404, 409, 422, 429].includes(error.status)
            ) {
              this.store()
                .query(
                  "UPDATE chat_requests SET status = 'rejected' WHERE key = ?",
                )
                .run(key);
            }
            throw error;
          }
          this.store()
            .query(
              "UPDATE chat_requests SET run_id = ?, status = ? WHERE key = ?",
            )
            .run(run.run_id, run.status, key);
          return json(run, 202);
        }
      }
      const runMatch = path.match(
        /^\/runs\/([^/]+)(?:\/(events|stop|steer|approval))?$/,
      );
      if (runMatch) {
        const id = decodeURIComponent(runMatch[1] ?? "");
        const action = runMatch[2];
        const run = await this.status(id); // Checks local ownership before any proxying.
        if (method === "GET" && !action) return json(run);
        if (method === "GET" && action === "events") {
          const seq = Math.max(
            -1,
            Number(url.searchParams.get("last_seq")) || 0,
          );
          const response = await this.upstream(
            `/v1/runs/${encodeURIComponent(id)}/events?last_seq=${seq}`,
            { signal: request.signal },
          );
          return new Response(response.body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        if (
          method === "POST" &&
          action &&
          ["stop", "steer", "approval"].includes(action)
        ) {
          const body = await this.body(request);
          let value: Record<string, unknown> = {};
          if (action === "steer") {
            if (
              typeof body.input !== "string" ||
              !body.input.trim() ||
              body.input.length > 32_000
            )
              throw new ChatError(400, "invalid_chat_guidance");
            value = { input: body.input };
          } else if (action === "approval") {
            const capabilities =
              await this.get<ChatCapabilities>("/v1/capabilities");
            if (!capabilities.features.run_approval_response)
              throw new ChatError(409, "chat_approval_unsupported");
            if (
              !["once", "session", "always", "deny"].includes(
                String(body.choice),
              )
            )
              throw new ChatError(400, "invalid_chat_approval");
            if (
              typeof body.request_id !== "string" ||
              !body.request_id ||
              body.request_id.length > 256
            )
              throw new ChatError(400, "invalid_chat_approval");
            if (
              run.status !== "waiting_for_approval" ||
              run.approval?.request_id !== body.request_id ||
              !chatApprovalChoices(run.approval).includes(String(body.choice))
            )
              throw new ChatError(409, "chat_approval_stale");
            value = {
              choice: body.choice,
              ...(body.request_id ? { request_id: body.request_id } : {}),
            };
          }
          return json(
            await this.get(`/v1/runs/${encodeURIComponent(id)}/${action}`, {
              method,
              body: JSON.stringify(value),
            }),
          );
        }
      }
      return json({ schema: 1, ok: false, error: "not_found" }, 404);
    } catch (error) {
      return json(
        {
          schema: 1,
          ok: false,
          error:
            error instanceof ChatError ? error.message : "chat_request_failed",
        },
        error instanceof ChatError ? error.status : 502,
      );
    }
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader();
    if (!reader) throw new ChatError(400, "invalid_chat_request");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 140_000) {
          await reader.cancel();
          throw new ChatError(413, "chat_request_too_large");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ChatError) throw error;
      throw new ChatError(400, "invalid_chat_request");
    } finally {
      reader.releaseLock();
    }
  }
}
