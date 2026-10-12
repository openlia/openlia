import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceDiagnosticsResponse } from "../shared/api";
import { createWorkspaceHandler } from "./app";
import { revision } from "./workspace";

let root = "";
let handler: ReturnType<typeof createWorkspaceHandler>;

function request(path: string, init?: RequestInit): Promise<Response> {
  return handler(new Request(`http://localhost${path}`, init));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlia-workspace-ui-"));
  handler = createWorkspaceHandler({ workspaceRoot: root });
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("workspace HTTP handler", () => {
  test("serves health and security headers", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: 1,
      ok: true,
      service: "workspace-ui",
    });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "img-src 'self' data: blob:",
    );
  });

  test("lists files while excluding protected paths and symlinks", async () => {
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "readme.md"), "hello");
    writeFileSync(join(root, ".env"), "secret");
    symlinkSync(join(root, "notes", "readme.md"), join(root, "linked.md"));

    const response = await request("/api/workspace/tree");
    const payload = (await response.json()) as {
      entries: Array<{ path: string; kind: string }>;
    };

    expect(payload.entries).toEqual([
      { kind: "directory", path: "notes" },
      expect.objectContaining({ kind: "file", path: "notes/readme.md" }),
    ]);
  });

  test("serves artifacts inline with MIME types and byte ranges", async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 1, 2, 3]);
    writeFileSync(join(root, "sample.pdf"), pdfBytes);
    writeFileSync(join(root, "archive.bin"), new Uint8Array([0, 1, 2, 3]));

    const pdf = await request("/api/workspace/raw?path=sample.pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe(
      'inline; filename="sample.pdf"',
    );
    expect(pdf.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(pdfBytes);

    const range = await request("/api/workspace/raw?path=sample.pdf", {
      headers: { Range: "bytes=2-5" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 2-5/8");
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(
      pdfBytes.slice(2, 6),
    );

    const binary = await request("/api/workspace/raw?path=archive.bin");
    expect(binary.status).toBe(200);
    expect(binary.headers.get("content-type")).toBe("application/octet-stream");
    expect(binary.headers.get("content-disposition")).toBe(
      'attachment; filename="archive.bin"',
    );
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 3]),
    );
  });

  test("returns metadata for binary files without decoding them", async () => {
    writeFileSync(join(root, "sample.png"), new Uint8Array([0, 1, 2]));

    const response = await request("/api/workspace/metadata?path=sample.png");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      editable: false,
      path: "sample.png",
      size: 3,
    });
  });

  test("hides navigator scaffolding while keeping workspace folders visible", async () => {
    mkdirSync(join(root, "calendar"), { recursive: true });
    mkdirSync(join(root, "archive"), { recursive: true });
    writeFileSync(join(root, "calendar", ".gitkeep"), "placeholder");
    writeFileSync(join(root, "calendar", "event-note-template.md"), "template");
    writeFileSync(join(root, "calendar", "event.md"), "event");
    writeFileSync(join(root, "archive", ".DS_Store"), "metadata");
    writeFileSync(join(root, "README.md"), "workspace guide");

    const response = await request("/api/workspace/tree");
    const payload = (await response.json()) as {
      entries: Array<{ path: string; kind: string }>;
    };
    const paths = payload.entries.map((entry) => entry.path);

    expect(paths).toContain("archive");
    expect(paths).toContain("calendar");
    expect(paths).toContain("calendar/event.md");
    expect(paths).toContain("README.md");
    expect(paths).not.toContain("calendar/.gitkeep");
    expect(paths).not.toContain("calendar/event-note-template.md");
    expect(paths).not.toContain("archive/.DS_Store");

    for (const hiddenPath of [
      "calendar/.gitkeep",
      "calendar/event-note-template.md",
    ]) {
      const hiddenResponse = await request(
        `/api/workspace/file?path=${encodeURIComponent(hiddenPath)}`,
      );
      expect(hiddenResponse.status).toBe(403);
    }
  });

  test("persists independent visibility settings and exposes hidden files when disabled", async () => {
    writeFileSync(join(root, "workspace.yaml"), "value: 1\n");
    writeFileSync(join(root, "workspace.schema.json"), '{"type":"object"}');
    writeFileSync(join(root, "assistant-policy.yaml"), "value: 1\n");
    writeFileSync(
      join(root, "assistant-policy.schema.json"),
      '{"type":"object"}',
    );
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(join(root, "tasks", "task-template.md"), "# Task\n");

    const initial = await request("/api/workspace/settings");
    expect(await initial.json()).toEqual({
      hide_configuration_files: true,
      hide_template_schema_files: true,
      schema: 1,
    });
    const hiddenTree = (await (
      await request("/api/workspace/tree")
    ).json()) as {
      entries: Array<{ path: string }>;
    };
    expect(hiddenTree.entries.map((entry) => entry.path)).not.toContain(
      "workspace.yaml",
    );
    expect(hiddenTree.entries.map((entry) => entry.path)).not.toContain(
      "tasks/task-template.md",
    );

    const update = await request("/api/workspace/settings", {
      body: JSON.stringify({
        hide_configuration_files: false,
        hide_template_schema_files: false,
      }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    expect(update.status).toBe(200);

    const visibleTree = (await (
      await request("/api/workspace/tree")
    ).json()) as {
      entries: Array<{ path: string }>;
    };
    const visiblePaths = visibleTree.entries.map((entry) => entry.path);
    expect(visiblePaths).toContain("workspace.yaml");
    expect(visiblePaths).toContain("workspace.schema.json");
    expect(visiblePaths).toContain("assistant-policy.yaml");
    expect(visiblePaths).toContain("tasks/task-template.md");

    const opened = await request("/api/workspace/file?path=workspace.yaml");
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      content: "value: 1\n",
      path: "workspace.yaml",
    });
  });

  test("returns configured system information", async () => {
    const configuredHandler = createWorkspaceHandler({
      systemInfo: {
        hermes_version: "v2026.9.14",
        locho_version: "1.2.0",
        openlia_hash: "abc123",
        openlia_version: "0.1.0",
      },
      workspaceRoot: root,
    });
    const response = await configuredHandler(
      new Request("http://localhost/api/system/info"),
    );
    expect(await response.json()).toEqual({
      hermes_version: "v2026.9.14",
      locho_version: "1.2.0",
      openlia_hash: "abc123",
      openlia_version: "0.1.0",
      schema: 1,
    });
  });

  test("returns validation warnings for invalid visible configuration files", async () => {
    writeFileSync(
      join(root, "workspace.schema.json"),
      '{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}',
    );
    writeFileSync(join(root, "workspace.yaml"), "value: 1\n");
    await request("/api/workspace/settings", {
      body: JSON.stringify({
        hide_configuration_files: false,
        hide_template_schema_files: true,
      }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });

    const response = await request("/api/workspace/file?path=workspace.yaml");
    expect(await response.json()).toMatchObject({
      validation: {
        valid: false,
      },
    });
  });

  test("exposes YAML files as editable documents", async () => {
    const chatPath = join(root, "knowledge", "chatgpt");
    const content = "schema: 1\nsession:\n  platform: chatgpt\n";
    mkdirSync(chatPath, { recursive: true });
    writeFileSync(join(chatPath, "export.yaml"), content);

    const treeResponse = await request("/api/workspace/tree");
    const tree = (await treeResponse.json()) as {
      entries: Array<{ editable?: boolean; kind: string; path: string }>;
    };
    expect(tree.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          editable: true,
          kind: "file",
          path: "knowledge/chatgpt/export.yaml",
        }),
      ]),
    );

    const readResponse = await request(
      "/api/workspace/file?path=knowledge%2Fchatgpt%2Fexport.yaml",
    );
    const document = (await readResponse.json()) as {
      editable: boolean;
      content: string;
    };
    expect(document).toMatchObject({ content, editable: true });

    const writeBody = JSON.stringify({
      content,
      expected_revision: revision(new TextEncoder().encode(content)),
      path: "knowledge/chatgpt/export.yaml",
    });
    const writeResponse = await request("/api/workspace/file", {
      body: writeBody,
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    expect(writeResponse.status).toBe(200);
    expect(await writeResponse.json()).toMatchObject({
      editable: true,
      ok: true,
    });
  });

  test("exposes hledger journal files as editable documents", async () => {
    const finPath = join(root, "finance");
    const content =
      "2026-07-01 Payslip\n    assets:cash  1000 VND\n    income:salary -1000 VND\n";
    mkdirSync(finPath, { recursive: true });
    writeFileSync(join(finPath, "journal.hledger"), content);

    const treeResponse = await request("/api/workspace/tree");
    const tree = (await treeResponse.json()) as {
      entries: Array<{ editable?: boolean; kind: string; path: string }>;
    };
    expect(tree.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          editable: true,
          kind: "file",
          path: "finance/journal.hledger",
        }),
      ]),
    );

    const readResponse = await request(
      "/api/workspace/file?path=finance%2Fjournal.hledger",
    );
    const document = (await readResponse.json()) as {
      editable: boolean;
      content: string;
    };
    expect(document).toMatchObject({ content, editable: true });
  });

  test("reads, writes, and rejects stale revisions", async () => {
    writeFileSync(join(root, "note.md"), "before");
    const readResponse = await request("/api/workspace/file?path=note.md");
    const document = (await readResponse.json()) as {
      revision: string;
      content: string;
    };
    expect(document.content).toBe("before");

    const content = JSON.stringify({
      content: "after",
      expected_revision: document.revision,
      path: "note.md",
    });
    const writeResponse = await request("/api/workspace/file", {
      body: content,
      headers: {
        "Content-Length": String(Buffer.byteLength(content)),
        "Content-Type": "application/json",
      },
      method: "PUT",
    });
    expect(writeResponse.status).toBe(200);
    expect(readFileSync(join(root, "note.md"), "utf8")).toBe("after");

    const stale = JSON.stringify({
      content: "lost",
      expected_revision: document.revision,
      path: "note.md",
    });
    const conflictResponse = await request("/api/workspace/file", {
      body: stale,
      headers: {
        "Content-Length": String(Buffer.byteLength(stale)),
        "Content-Type": "application/json",
      },
      method: "PUT",
    });
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toEqual({
      current_revision: revision(new TextEncoder().encode("after")),
      error: "revision_conflict",
      ok: false,
      schema: 1,
    });
  });

  test("deletes a file, updates the tree, and rejects stale deletes", async () => {
    const path = join(root, "note.md");
    writeFileSync(path, "before");
    const readResponse = await request("/api/workspace/file?path=note.md");
    const document = (await readResponse.json()) as { revision: string };

    const deleteBody = JSON.stringify({
      expected_revision: document.revision,
      path: "note.md",
    });
    const deleteResponse = await request("/api/workspace/file", {
      body: deleteBody,
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({
      ok: true,
      path: "note.md",
      schema: 1,
    });
    expect(() => readFileSync(path)).toThrow();

    const deletedTreeResponse = await request("/api/workspace/tree");
    const deletedTree = (await deletedTreeResponse.json()) as {
      entries: Array<{ path: string }>;
    };
    expect(deletedTree.entries.some((entry) => entry.path === "note.md")).toBe(
      false,
    );

    writeFileSync(path, "changed");
    const staleResponse = await request("/api/workspace/file", {
      body: deleteBody,
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      error: "revision_conflict",
    });
  });

  test("renames a file and rejects collisions and protected names", async () => {
    const originalPath = join(root, "note.md");
    writeFileSync(originalPath, "content");
    const readResponse = await request("/api/workspace/file?path=note.md");
    const doc = (await readResponse.json()) as { revision: string };

    const renameBody = JSON.stringify({
      expected_revision: doc.revision,
      new_name: "renamed.md",
      path: "note.md",
    });
    const renameRes = await request("/api/workspace/rename", {
      body: renameBody,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(renameRes.status).toBe(200);
    const renamePayload = (await renameRes.json()) as {
      ok: boolean;
      path: string;
      previous_path: string;
    };
    expect(renamePayload.ok).toBe(true);
    expect(renamePayload.path).toBe("renamed.md");
    expect(renamePayload.previous_path).toBe("note.md");
    expect(existsSync(join(root, "renamed.md"))).toBe(true);
    expect(existsSync(originalPath)).toBe(false);

    // Collision check
    writeFileSync(join(root, "exists.md"), "already here");
    const conflictBody = JSON.stringify({
      expected_revision: doc.revision,
      new_name: "exists.md",
      path: "renamed.md",
    });
    const conflictRes = await request("/api/workspace/rename", {
      body: conflictBody,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(conflictRes.status).toBe(409);

    // Protected template check
    const templateBody = JSON.stringify({
      expected_revision: doc.revision,
      new_name: "task-template.md",
      path: "renamed.md",
    });
    const templateRes = await request("/api/workspace/rename", {
      body: templateBody,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(templateRes.status).toBe(403);
  });

  test("moves a file into a new folder and validates diagnostics", async () => {
    writeFileSync(join(root, "source.md"), "hello world");
    const readResponse = await request("/api/workspace/file?path=source.md");
    const doc = (await readResponse.json()) as { revision: string };

    const moveBody = JSON.stringify({
      destination_path: "subfolder/moved.md",
      expected_revision: doc.revision,
      source_path: "source.md",
    });
    const moveRes = await request("/api/workspace/move", {
      body: moveBody,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(moveRes.status).toBe(200);
    expect(existsSync(join(root, "subfolder", "moved.md"))).toBe(true);
    expect(existsSync(join(root, "source.md"))).toBe(false);

    // Diagnostics endpoint check
    const diagRes = await request("/api/workspace/diagnostics");
    expect(diagRes.status).toBe(200);
    const diagPayload = (await diagRes.json()) as WorkspaceDiagnosticsResponse;
    expect(diagPayload.schema).toBe(1);
    expect(Array.isArray(diagPayload.issues)).toBe(true);
  });

  test("protects delete requests with authentication and same-origin checks", async () => {
    writeFileSync(join(root, "note.md"), "before");
    const body = JSON.stringify({
      expected_revision: revision(new TextEncoder().encode("before")),
      path: "note.md",
    });

    const originResponse = await request("/api/workspace/file", {
      body,
      headers: {
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
      },
      method: "DELETE",
    });
    expect(originResponse.status).toBe(403);
    expect(await originResponse.json()).toMatchObject({
      error: "origin_not_allowed",
    });

    const protectedResponse = await request("/api/workspace/file", {
      body: JSON.stringify({
        expected_revision: revision(new TextEncoder().encode("secret")),
        path: ".env",
      }),
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    });
    expect(protectedResponse.status).toBe(403);

    const authRoot = mkdtempSync(join(tmpdir(), "openlia-workspace-ui-auth-"));
    try {
      const passwordHash = await Bun.password.hash("test-password", {
        algorithm: "argon2id",
        memoryCost: 32 * 1024,
        timeCost: 2,
      });
      const authHandler = createWorkspaceHandler({
        authRequired: true,
        passwordHash,
        workspaceRoot: authRoot,
      });
      const authResponse = await authHandler(
        new Request("http://localhost/api/workspace/file", {
          body,
          headers: { "Content-Type": "application/json" },
          method: "DELETE",
        }),
      );
      expect(authResponse.status).toBe(401);
    } finally {
      rmSync(authRoot, { force: true, recursive: true });
    }
  });

  test("rejects protected paths and cross-origin writes", async () => {
    const protectedResponse = await request("/api/workspace/file?path=.env");
    expect(protectedResponse.status).toBe(403);
    const passwordProfilesResponse = await request(
      "/api/workspace/file?path=sources/document-passwords.toml",
    );
    expect(passwordProfilesResponse.status).toBe(403);

    const body = JSON.stringify({
      content: "x",
      expected_revision: revision(new Uint8Array()),
      path: "new.txt",
    });
    const originResponse = await request("/api/workspace/file", {
      body,
      headers: {
        "Content-Length": String(Buffer.byteLength(body)),
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
      },
      method: "PUT",
    });
    expect(originResponse.status).toBe(403);
    expect(await originResponse.json()).toMatchObject({
      error: "origin_not_allowed",
    });
  });

  test("protects nested repository and environment metadata", async () => {
    mkdirSync(join(root, "project", ".git"), { recursive: true });
    mkdirSync(join(root, "project"), { recursive: true });
    writeFileSync(join(root, "project", ".git", "config"), "secret");
    writeFileSync(join(root, "project", ".env.local"), "secret");

    mkdirSync(join(root, "project", "Logs"), { recursive: true });
    writeFileSync(join(root, "project", "Logs", "records.txt"), "secret");

    for (const path of [
      "project/.git/config",
      "project/.env.local",
      "project/logs/records.txt",
      "project/Logs/records.txt",
    ]) {
      const response = await request(
        `/api/workspace/file?path=${encodeURIComponent(path)}`,
      );
      expect(response.status).toBe(403);
    }
  });

  test("rejects writes to non-editable file types", async () => {
    const body = JSON.stringify({
      content: "#!/bin/sh\n",
      expected_revision: revision(new Uint8Array()),
      path: "script.sh",
    });
    const response = await request("/api/workspace/file", {
      body,
      headers: {
        "Content-Type": "application/json",
      },
      method: "PUT",
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: "not_editable" });
  });

  test("serves the Vite index and assets without exposing other files", async () => {
    const staticRoot = join(root, "static");
    mkdirSync(join(staticRoot, "assets"), { recursive: true });
    writeFileSync(
      join(staticRoot, "index.html"),
      '<!doctype html><meta name="csp-nonce" content="__OPENLIA_CSP_NONCE__">',
    );
    writeFileSync(join(staticRoot, "assets", "app.js"), "console.log('ok')");
    const staticHandler = createWorkspaceHandler({
      staticRoot,
      workspaceRoot: root,
    });

    const index = await staticHandler(new Request("http://localhost/"));
    const asset = await staticHandler(
      new Request("http://localhost/assets/app.js"),
    );
    const missing = await staticHandler(
      new Request("http://localhost/assets/../note.md"),
    );

    expect(index.status).toBe(200);
    const indexBody = await index.text();
    const indexCsp = index.headers.get("content-security-policy") ?? "";
    const nonce = indexCsp.match(/style-src 'self' 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(indexBody).toContain(`content="${nonce}">`);
    expect(indexBody).not.toContain("__OPENLIA_CSP_NONCE__");
    expect(asset.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(await asset.text()).toContain("console.log");
    expect(missing.status).toBe(404);
  });

  test("protects workspace routes with an Argon2id session", async () => {
    const passwordHash = await Bun.password.hash(
      "correct horse battery staple",
      {
        algorithm: "argon2id",
        memoryCost: 32 * 1024,
        timeCost: 2,
      },
    );
    const authenticatedHandler = createWorkspaceHandler({
      authRequired: true,
      passwordHash,
      workspaceRoot: root,
    });
    const unauthenticated = await authenticatedHandler(
      new Request("http://localhost/api/workspace/tree"),
    );
    expect(unauthenticated.status).toBe(401);

    const wrongLogin = await authenticatedHandler(
      new Request("http://localhost/api/auth/login", {
        body: JSON.stringify({ password: "wrong password" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );
    expect(wrongLogin.status).toBe(401);

    const login = await authenticatedHandler(
      new Request("http://localhost/api/auth/login", {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).not.toContain("Secure");

    const authenticated = await authenticatedHandler(
      new Request("http://localhost/api/workspace/tree", {
        headers: { Cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(authenticated.status).toBe(200);

    const logout = await authenticatedHandler(
      new Request("http://localhost/api/auth/logout", {
        headers: { Cookie: cookie?.split(";")[0] ?? "" },
        method: "POST",
      }),
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const afterLogout = await authenticatedHandler(
      new Request("http://localhost/api/workspace/tree", {
        headers: { Cookie: cookie?.split(";")[0] ?? "" },
      }),
    );
    expect(afterLogout.status).toBe(401);
  });

  test("persists sessions across server instances and invalidates them on password rotation", async () => {
    const sessionDatabasePath = join(root, "auth", "sessions.sqlite");
    const passwordHash = await Bun.password.hash(
      "correct horse battery staple",
      {
        algorithm: "argon2id",
        memoryCost: 32 * 1024,
        timeCost: 2,
      },
    );
    const firstHandler = createWorkspaceHandler({
      authRequired: true,
      passwordHash,
      sessionDatabasePath,
      workspaceRoot: root,
    });
    const login = await firstHandler(
      new Request("http://localhost/api/auth/login", {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const secondHandler = createWorkspaceHandler({
      authRequired: true,
      passwordHash,
      sessionDatabasePath,
      workspaceRoot: root,
    });
    const persisted = await secondHandler(
      new Request("http://localhost/api/workspace/tree", {
        headers: { Cookie: cookie },
      }),
    );
    expect(persisted.status).toBe(200);

    const rotatedHash = await Bun.password.hash("a different password", {
      algorithm: "argon2id",
      memoryCost: 32 * 1024,
      timeCost: 2,
    });
    const rotatedHandler = createWorkspaceHandler({
      authRequired: true,
      passwordHash: rotatedHash,
      sessionDatabasePath,
      workspaceRoot: root,
    });
    const afterRotation = await rotatedHandler(
      new Request("http://localhost/api/workspace/tree", {
        headers: { Cookie: cookie },
      }),
    );
    expect(afterRotation.status).toBe(401);
  });

  test("accepts an HTTPS origin forwarded to an HTTP upstream", async () => {
    const passwordHash = await Bun.password.hash(
      "correct horse battery staple",
      {
        algorithm: "argon2id",
        memoryCost: 32 * 1024,
        timeCost: 2,
      },
    );
    const proxiedHandler = createWorkspaceHandler({
      authRequired: true,
      passwordHash,
      workspaceRoot: root,
    });
    const login = await proxiedHandler(
      new Request("http://workspace-ui:8089/api/auth/login", {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://workspace.example.test",
          "X-Forwarded-Host": "workspace.example.test",
          "X-Forwarded-Proto": "https",
        },
        method: "POST",
      }),
    );

    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("Secure");

    const untrusted = await proxiedHandler(
      new Request("http://workspace-ui:8089/api/auth/login", {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://untrusted.example",
          "X-Forwarded-Host": "workspace.example.test",
          "X-Forwarded-Proto": "https",
        },
        method: "POST",
      }),
    );

    expect(untrusted.status).toBe(403);
    expect(await untrusted.json()).toMatchObject({
      error: "origin_not_allowed",
    });
  });

  test("accepts a configured public origin without forwarded headers", async () => {
    const passwordHash = await Bun.password.hash(
      "correct horse battery staple",
      {
        algorithm: "argon2id",
        memoryCost: 32 * 1024,
        timeCost: 2,
      },
    );
    const configuredHandler = createWorkspaceHandler({
      authRequired: true,
      passwordHash,
      publicOrigin: "https://openlia.example.test",
      workspaceRoot: root,
    });
    const login = await configuredHandler(
      new Request("http://workspace-ui:8089/api/auth/login", {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://openlia.example.test",
        },
        method: "POST",
      }),
    );

    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("Secure");
  });

  test("rejects oversized chunked login requests before password verification", async () => {
    const passwordHash = await Bun.password.hash(
      "correct horse battery staple",
      {
        algorithm: "argon2id",
        memoryCost: 32 * 1024,
        timeCost: 2,
      },
    );
    const authenticatedHandler = createWorkspaceHandler({
      authRequired: true,
      passwordHash,
      workspaceRoot: root,
    });
    const body = new TextEncoder().encode(
      JSON.stringify({ password: "x".repeat(20 * 1024) }),
    );
    const response = await authenticatedHandler(
      new Request("http://localhost/api/auth/login", {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(413);
  });

  test("serves index.html for SPA routes (/files and /file)", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "openlia-ui-static-"));
    try {
      writeFileSync(
        join(staticDir, "index.html"),
        "<!doctype html><html><body>Workspace App</body></html>",
      );
      const spaHandler = createWorkspaceHandler({
        staticRoot: staticDir,
        workspaceRoot: root,
      });

      for (const spaPath of [
        "/",
        "/index.html",
        "/files/notes.md",
        "/files/calendar/event.md",
        "/file/tasks/todo.md",
        "/skills",
        "/git-activity",
        "/migration",
        "/migration/mig-20261011-075346",
      ]) {
        const response = await spaHandler(
          new Request(`http://localhost${spaPath}`),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(await response.text()).toContain("Workspace App");
      }
    } finally {
      rmSync(staticDir, { force: true, recursive: true });
    }
  });

  test("exports workspace and skills as a downloadable zip archive", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "openlia-skills-export-"));
    try {
      writeFileSync(join(root, "notes.md"), "# Hello Notes");
      mkdirSync(join(skillsDir, "test-skill"), { recursive: true });
      writeFileSync(
        join(skillsDir, "test-skill", "SKILL.md"),
        "---\nname: test-skill\n---",
      );

      const customHandler = createWorkspaceHandler({
        skillsRoot: skillsDir,
        workspaceRoot: root,
      });

      const response = await customHandler(
        new Request("http://localhost/api/workspace/export"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/zip");
      expect(response.headers.get("content-disposition")).toMatch(
        /^attachment; filename="openlia-workspace-\d{4}-\d{2}-\d{2}\.zip"$/,
      );

      const zipBytes = new Uint8Array(await response.arrayBuffer());
      const tempZip = join(root, "exported.zip");
      writeFileSync(tempZip, zipBytes);

      const proc = Bun.spawnSync(["unzip", "-l", tempZip]);
      expect(proc.exitCode).toBe(0);
      const output = new TextDecoder().decode(proc.stdout);
      expect(output).toContain("workspace/notes.md");
      expect(output).toContain("skills/test-skill/SKILL.md");
    } finally {
      rmSync(skillsDir, { force: true, recursive: true });
    }
  });

  test("requires authentication for /api/workspace/export when auth is enabled", async () => {
    const authHandler = createWorkspaceHandler({
      authRequired: true,
      passwordHash: await Bun.password.hash("pw", { algorithm: "argon2id" }),
      workspaceRoot: root,
    });

    const response = await authHandler(
      new Request("http://localhost/api/workspace/export"),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "authentication_required",
    });
  });
});
