import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceHandler } from "./app";
import { WorkspaceError, WorkspaceService } from "./workspace";

describe("WorkspaceService & HTTP API", () => {
  let root: string;
  let service: WorkspaceService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openlia-ws-test-"));
    service = new WorkspaceService({ workspaceRoot: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("lists text files as editable and binary files as view-only", () => {
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "readme.md"), "# Hello\nWorld\n");
    writeFileSync(join(root, "config.yaml"), "key: value\n");
    writeFileSync(join(root, "plain.txt"), "some text\n");
    writeFileSync(
      join(root, "report.pdf"),
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]),
    );
    writeFileSync(
      join(root, "photo.png"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const tree = service.listTree();
    expect(tree.ok).toBe(true);

    const byPath = new Map(tree.entries.map((e) => [e.path, e]));
    expect(byPath.get("notes")?.kind).toBe("directory");
    expect(byPath.get("notes/readme.md")?.editable).toBe(true);
    expect(byPath.get("config.yaml")?.editable).toBe(true);
    expect(byPath.get("plain.txt")?.editable).toBe(true);
    expect(byPath.get("report.pdf")?.editable).toBe(false);
    expect(byPath.get("photo.png")?.editable).toBe(false);
  });

  test("reads and edits markdown/yaml/txt files with revision guard", () => {
    writeFileSync(join(root, "todo.md"), "# Tasks\n- [ ] Item 1\n");
    const file = service.readFile("todo.md");
    expect(file.editable).toBe(true);
    expect(file.content).toBe("# Tasks\n- [ ] Item 1\n");

    const updated = service.writeFile(
      "todo.md",
      "# Tasks\n- [x] Item 1\n",
      file.revision,
    );
    expect(updated.revision).not.toBe(file.revision);
    expect(service.readFile("todo.md").content).toBe("# Tasks\n- [x] Item 1\n");

    // Stale revision should fail with 409 revision_conflict
    expect(() =>
      service.writeFile("todo.md", "overwrite", file.revision),
    ).toThrow(WorkspaceError);
    try {
      service.writeFile("todo.md", "overwrite", file.revision);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).status).toBe(409);
      expect((err as WorkspaceError).code).toBe("revision_conflict");
    }
  });

  test("enforces view-only on binary files (rejects text read and write)", () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x00]);
    writeFileSync(join(root, "doc.pdf"), pdfBytes);

    expect(() => service.readFile("doc.pdf")).toThrow(WorkspaceError);
    try {
      service.readFile("doc.pdf");
    } catch (err) {
      expect((err as WorkspaceError).status).toBe(415);
      expect((err as WorkspaceError).code).toBe("binary_file");
    }

    const meta = service.readFileMetadata("doc.pdf");
    expect(meta.editable).toBe(false);
    expect(meta.size).toBe(pdfBytes.byteLength);

    expect(() => service.writeFile("doc.pdf", "hacked", meta.revision)).toThrow(
      WorkspaceError,
    );
    try {
      service.writeFile("doc.pdf", "hacked", meta.revision);
    } catch (err) {
      expect((err as WorkspaceError).status).toBe(403);
      expect((err as WorkspaceError).code).toBe("file_not_editable");
    }
  });

  test("creates, renames, moves, uploads, and deletes files", () => {
    const created = service.createFile("folder/note.md", "Hello");
    expect(created.path).toBe("folder/note.md");
    expect(created.editable).toBe(true);

    const renamed = service.renameFile("folder/note.md", "renamed.md");
    expect(renamed.new_path).toBe("folder/renamed.md");

    const moved = service.moveFile("folder/renamed.md", "archive/2026");
    expect(moved.new_path).toBe("archive/2026/renamed.md");

    const uploaded = service.uploadFile(
      "assets/pic.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );
    expect(uploaded.path).toBe("assets/pic.png");
    expect(uploaded.editable).toBe(false);

    const deleted = service.deleteFile("archive/2026/renamed.md");
    expect(deleted.deleted).toBe(true);
    expect(() => service.readFile("archive/2026/renamed.md")).toThrow();
  });

  test("rejects path traversal and symlinks", () => {
    expect(() => service.readFile("../outside.txt")).toThrow(WorkspaceError);
    expect(() => service.readFile("/etc/passwd")).toThrow();

    const outside = mkdtempSync(join(tmpdir(), "openlia-outside-"));
    try {
      const secretFile = join(outside, "secret.txt");
      writeFileSync(secretFile, "top-secret");
      symlinkSync(secretFile, join(root, "escape.txt"));

      expect(() => service.readFile("escape.txt")).toThrow(WorkspaceError);
      const tree = service.listTree();
      expect(tree.entries.find((e) => e.path === "escape.txt")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("HTTP handler serves raw binary inline and enforces CSRF origin", async () => {
    writeFileSync(join(root, "hello.md"), "# Welcome\n");
    writeFileSync(
      join(root, "image.png"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      authRequired: false,
    });

    const rawRes = await handler(
      new Request("http://127.0.0.1:8089/api/workspace/raw?path=image.png"),
    );
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get("content-type")).toBe("image/png");
    expect(rawRes.headers.get("content-disposition")).toContain("inline;");

    // Mutating request without Origin header is rejected with 403
    const badCreate = await handler(
      new Request("http://127.0.0.1:8089/api/workspace/file/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "new.md", content: "hi" }),
      }),
    );
    expect(badCreate.status).toBe(403);

    // Mutating request with matching Origin header succeeds
    const goodCreate = await handler(
      new Request("http://127.0.0.1:8089/api/workspace/file/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8089",
        },
        body: JSON.stringify({ path: "new.md", content: "hi" }),
      }),
    );
    expect(goodCreate.status).toBe(200);
  });
});
