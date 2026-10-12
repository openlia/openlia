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
import type { WorkspaceFile, WorkspaceTreeResponse } from "../shared/api";
import { createWorkspaceHandler } from "./app";
import { revision } from "./workspace";

let root: string;
let workspaceRoot: string;
let memoriesRoot: string;
let handler: ReturnType<typeof createWorkspaceHandler>;

function request(path: string, init?: RequestInit) {
  return handler(new Request(`http://localhost${path}`, init));
}

function put(path: string, body: object, headers: Record<string, string> = {}) {
  return request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function enable(value = true) {
  const response = await put("/api/workspace/settings", {
    enable_memory_editing: value,
    hide_configuration_files: true,
    hide_template_schema_files: true,
  });
  expect(response.status).toBe(200);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlia-memories-"));
  workspaceRoot = join(root, "workspace");
  memoriesRoot = join(root, "memories");
  mkdirSync(memoriesRoot);
  writeFileSync(join(memoriesRoot, "USER.md"), "# User\n");
  handler = createWorkspaceHandler({ workspaceRoot, memoriesRoot });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("assistant memory files", () => {
  test("gates all file access and persists the setting independently", async () => {
    for (const endpoint of ["file", "metadata", "raw", "download"]) {
      expect(
        (await request(`/api/memory/${endpoint}?name=USER.md`)).status,
      ).toBe(403);
    }
    expect(
      (
        await put("/api/memory/file", {
          name: "USER.md",
          content: "changed",
          expected_revision: revision(new TextEncoder().encode("# User\n")),
        })
      ).status,
    ).toBe(403);
    await enable();
    handler = createWorkspaceHandler({ workspaceRoot, memoriesRoot });
    expect(
      await (await request("/api/workspace/settings")).json(),
    ).toMatchObject({ enable_memory_editing: true });
    await put("/api/workspace/settings", {
      hide_configuration_files: false,
      hide_template_schema_files: true,
    });
    expect(
      await (await request("/api/workspace/settings")).json(),
    ).toMatchObject({ enable_memory_editing: true });
    await enable(false);
    expect((await request("/api/memory/file?name=USER.md")).status).toBe(403);
    expect(readFileSync(join(memoriesRoot, "USER.md"), "utf8")).toBe(
      "# User\n",
    );
  });

  test("migrates old settings without resetting visibility and rejects invalid new values", async () => {
    writeFileSync(
      join(workspaceRoot, "workspace-ui.yaml"),
      "schema: 1\nhide_configuration_files: false\nhide_template_schema_files: false\n",
    );
    expect(await (await request("/api/workspace/settings")).json()).toEqual({
      schema: 1,
      hide_configuration_files: false,
      hide_template_schema_files: false,
      enable_memory_editing: false,
    });
    expect(
      (
        await put("/api/workspace/settings", {
          hide_configuration_files: false,
          hide_template_schema_files: false,
          enable_memory_editing: "yes",
        })
      ).status,
    ).toBe(400);
  });

  test("lists exactly two memory identities and creates a missing file only on save", async () => {
    writeFileSync(join(memoriesRoot, "private.txt"), "not exposed");
    writeFileSync(join(workspaceRoot, "USER.md"), "workspace document");
    await enable();
    const tree = (await (
      await request("/api/workspace/tree")
    ).json()) as WorkspaceTreeResponse;
    expect(
      tree.entries
        .filter((entry) => entry.kind === "file" && entry.source === "memory")
        .map((entry) => entry.path),
    ).toEqual(["@memories/USER.md", "@memories/MEMORY.md"]);
    expect(tree.entries.some((entry) => entry.path === "USER.md")).toBe(true);
    const missing = (await (
      await request("/api/memory/file?name=MEMORY.md")
    ).json()) as WorkspaceFile;
    expect(missing).toMatchObject({
      content: "",
      missing: true,
      editable: true,
      source: "memory",
    });
    expect(existsSync(join(memoriesRoot, "MEMORY.md"))).toBe(false);
    const saved = await put("/api/memory/file", {
      name: "MEMORY.md",
      content: "# Durable notes\n",
      expected_revision: missing.revision,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      missing: false,
      path: "@memories/MEMORY.md",
      source: "memory",
    });
    expect(readFileSync(join(memoriesRoot, "MEMORY.md"), "utf8")).toBe(
      "# Durable notes\n",
    );
    expect(existsSync(join(workspaceRoot, "MEMORY.md"))).toBe(false);
  });

  test("saves the live file and rejects stale revisions after Hermes changes it", async () => {
    await enable();
    const original = (await (
      await request("/api/memory/file?name=USER.md")
    ).json()) as WorkspaceFile;
    writeFileSync(join(memoriesRoot, "USER.md"), "Hermes updated this\n");
    const conflict = await put("/api/memory/file", {
      name: "USER.md",
      content: "draft",
      expected_revision: original.revision,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "revision_conflict" });
    expect(readFileSync(join(memoriesRoot, "USER.md"), "utf8")).toBe(
      "Hermes updated this\n",
    );
    const latest = (await (
      await request("/api/memory/file?name=USER.md")
    ).json()) as WorkspaceFile;
    expect(
      (
        await put("/api/memory/file", {
          name: "USER.md",
          content: "updated profile",
          expected_revision: latest.revision,
        })
      ).status,
    ).toBe(200);
    expect(
      await (await request("/api/memory/download?name=USER.md")).text(),
    ).toBe("updated profile");
  });

  test("rejects arbitrary paths, symlinks, and destructive workspace operations", async () => {
    await enable();
    for (const name of [
      "../USER.md",
      "/USER.md",
      "SOUL.md",
      "AGENTS.md",
      "private.txt",
      "user.md",
    ]) {
      expect(
        (await request(`/api/memory/file?${new URLSearchParams({ name })}`))
          .status,
      ).toBe(400);
      expect(
        (
          await put("/api/memory/file", {
            name,
            content: "bad",
            expected_revision: revision(new Uint8Array()),
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (await request("/api/workspace/file?path=%40memories%2FUSER.md")).status,
    ).toBe(403);
    expect(
      (
        await request("/api/workspace/file", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: "@memories/USER.md",
            expected_revision: "any",
          }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/memory/file", { method: "DELETE" })).status,
    ).toBe(404);
    symlinkSync(join(root, "elsewhere.md"), join(memoriesRoot, "MEMORY.md"));
    expect((await request("/api/memory/file?name=MEMORY.md")).status).toBe(403);
    expect(
      (
        await put("/api/memory/file", {
          name: "MEMORY.md",
          content: "bad",
          expected_revision: revision(new Uint8Array()),
        })
      ).status,
    ).toBe(403);
    rmSync(join(memoriesRoot, "MEMORY.md"), { force: true });
    writeFileSync(join(root, "lock-target"), "must not be replaced");
    symlinkSync(
      join(root, "lock-target"),
      join(memoriesRoot, "MEMORY.md.lock"),
    );
    const missingMemory = (await (
      await request("/api/memory/file?name=MEMORY.md")
    ).json()) as WorkspaceFile;
    expect(
      (
        await put("/api/memory/file", {
          name: "MEMORY.md",
          content: "blocked lock",
          expected_revision: missingMemory.revision,
        })
      ).status,
    ).toBe(403);
    expect(readFileSync(join(root, "lock-target"), "utf8")).toBe(
      "must not be replaced",
    );
  });

  test("enforces authentication, origin checks, content limits, and configured roots", async () => {
    await enable();
    expect(
      (
        await put(
          "/api/memory/file",
          { name: "USER.md", content: "bad", expected_revision: "any" },
          { Origin: "https://elsewhere.test" },
        )
      ).status,
    ).toBe(403);
    handler = createWorkspaceHandler({
      workspaceRoot,
      memoriesRoot,
      maxEditableBytes: 10,
    });
    expect(
      (
        await put("/api/memory/file", {
          name: "USER.md",
          content: "x".repeat(11),
          expected_revision: revision(new TextEncoder().encode("# User\n")),
        })
      ).status,
    ).toBe(413);
    handler = createWorkspaceHandler({
      workspaceRoot,
      memoriesRoot,
      authRequired: true,
      passwordHash: await Bun.password.hash("test-password", {
        algorithm: "argon2id",
      }),
    });
    expect((await request("/api/memory/file?name=USER.md")).status).toBe(401);
    handler = createWorkspaceHandler({ workspaceRoot });
    expect((await request("/api/memory/file?name=USER.md")).status).toBe(503);
  });

  test("rejects enabling memory editing when the memories root is unavailable", async () => {
    const unavailable = createWorkspaceHandler({
      workspaceRoot: join(root, "unavailable-workspace"),
    });
    const response = await unavailable(
      new Request("http://localhost/api/workspace/settings", {
        body: JSON.stringify({
          enable_memory_editing: true,
          hide_configuration_files: true,
          hide_template_schema_files: true,
        }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "memory_unavailable",
    });
    expect(
      await (
        await unavailable(
          new Request("http://localhost/api/workspace/settings"),
        )
      ).json(),
    ).toMatchObject({ enable_memory_editing: false });
  });

  test("keeps the workspace tree available if the live memories root disappears", async () => {
    writeFileSync(join(workspaceRoot, "notes.md"), "workspace note");
    await enable();
    rmSync(memoriesRoot, { force: true, recursive: true });
    const response = await request("/api/workspace/tree");
    expect(response.status).toBe(200);
    const tree = (await response.json()) as WorkspaceTreeResponse;
    expect(tree.entries.some((entry) => entry.path === "notes.md")).toBe(true);
    expect(
      tree.entries.some((entry) => entry.path.startsWith("@memories/")),
    ).toBe(false);
  });

  test("uses Hermes-compatible locks and bounds memory file size", async () => {
    await enable();
    const original = (await (
      await request("/api/memory/file?name=USER.md")
    ).json()) as WorkspaceFile;
    expect(
      (
        await put("/api/memory/file", {
          name: "USER.md",
          content: "x".repeat(1_376),
          expected_revision: original.revision,
        })
      ).status,
    ).toBe(413);
    const emptyMemory = (await (
      await request("/api/memory/file?name=MEMORY.md")
    ).json()) as WorkspaceFile;
    expect(
      (
        await put("/api/memory/file", {
          name: "MEMORY.md",
          content: "x".repeat(2_201),
          expected_revision: emptyMemory.revision,
        })
      ).status,
    ).toBe(413);

    const lockPath = join(memoriesRoot, "USER.md.lock");
    const readyPath = join(root, "lock-ready");
    const script = `
      import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
      import { dlopen, FFIType } from "bun:ffi";
      const lockPath = process.env.LOCK_PATH;
      const readyPath = process.env.READY_PATH;
      const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      const fd = openSync(lockPath, "a+", 0o600);
      libc.symbols.flock(fd, 2);
      writeFileSync(readyPath, "ready");
      await Bun.sleep(250);
      libc.symbols.flock(fd, 8);
      closeSync(fd);
    `;
    const child = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, LOCK_PATH: lockPath, READY_PATH: readyPath },
      stderr: "ignore",
      stdout: "ignore",
    });
    for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt++) {
      await Bun.sleep(10);
    }
    expect(existsSync(readyPath)).toBe(true);
    const started = Date.now();
    const saved = await put("/api/memory/file", {
      name: "USER.md",
      content: "locked write",
      expected_revision: original.revision,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(saved.status).toBe(200);
    await child.exited;
  });
});
