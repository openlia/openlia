import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkspaceDeleteResponse,
  WorkspaceErrorResponse,
  WorkspaceFile,
  WorkspaceTreeResponse,
  WorkspaceWriteResponse,
} from "../shared/api";
import { createWorkspaceHandler } from "./app";
import { AgentService, WorkspaceError, WorkspaceService } from "./workspace";

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

    // Create a directory with files for deleteDirectory tests
    mkdirSync(join(root, "docs", "guides"), { recursive: true });
    writeFileSync(join(root, "docs", "guides", "intro.md"), "# Intro");
    writeFileSync(join(root, "docs", "faq.md"), "# FAQ");

    // Rejects deleting a file as directory
    expect(() => service.deleteDirectory("docs/faq.md")).toThrow(
      WorkspaceError,
    );

    // Rejects deleting non-existent directory
    expect(() => service.deleteDirectory("docs/nonexistent")).toThrow(
      WorkspaceError,
    );

    // Recursively deletes folder and contents
    const deletedDir = service.deleteDirectory("docs");
    expect(deletedDir.deleted).toBe(true);
    expect(deletedDir.path).toBe("docs");
    expect(() => service.readFile("docs/faq.md")).toThrow();
    expect(() => service.readFile("docs/guides/intro.md")).toThrow();
  });

  test("refuses recursive folder deletion when a subtree contains protected paths or symlinks", () => {
    const protectedDirectory = join(root, "repository", ".git");
    mkdirSync(protectedDirectory, { recursive: true });
    writeFileSync(join(protectedDirectory, "config"), "keep");
    expect(() => service.deleteDirectory("repository")).toThrow(WorkspaceError);
    expect(existsSync(join(protectedDirectory, "config"))).toBe(true);

    const outside = mkdtempSync(join(tmpdir(), "openlia-ws-delete-outside-"));
    mkdirSync(join(root, "linked-folder"));
    symlinkSync(outside, join(root, "linked-folder", "outside"), "dir");
    try {
      expect(() => service.deleteDirectory("linked-folder")).toThrow(
        WorkspaceError,
      );
      expect(existsSync(join(root, "linked-folder"))).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a symlink as the workspace root when listing the tree", () => {
    const linkContainer = mkdtempSync(join(tmpdir(), "openlia-ws-root-link-"));
    const linkedRoot = join(linkContainer, "workspace");
    symlinkSync(root, linkedRoot, "dir");
    try {
      const linkedService = new WorkspaceService({ workspaceRoot: linkedRoot });
      expect(() => linkedService.listTree()).toThrow(WorkspaceError);
    } finally {
      rmSync(linkContainer, { recursive: true, force: true });
    }
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

  test("manages skills in separate root via /api/skills and scope parameter", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "openlia-skills-test-"));
    try {
      mkdirSync(join(skillsDir, "weather"), { recursive: true });
      writeFileSync(
        join(skillsDir, "weather", "SKILL.md"),
        "---\nname: weather\ndescription: Weather tool\n---\n# Weather\n",
      );

      const handler = createWorkspaceHandler({
        workspaceRoot: root,
        skillsRoot: skillsDir,
        authRequired: false,
      });

      // GET /api/skills/tree returns skill files with scope: skills
      const skillsTreeRes = await handler(
        new Request("http://127.0.0.1:8089/api/skills/tree"),
      );
      expect(skillsTreeRes.status).toBe(200);
      const skillsTree = (await skillsTreeRes.json()) as WorkspaceTreeResponse;
      expect(skillsTree.ok).toBe(true);
      expect(skillsTree.scope).toBe("skills");
      expect(
        skillsTree.entries.some((entry) => entry.path === "weather/SKILL.md"),
      ).toBe(true);

      // GET /api/workspace/tree?scope=skills also returns skills
      const paramTreeRes = await handler(
        new Request("http://127.0.0.1:8089/api/workspace/tree?scope=skills"),
      );
      expect(paramTreeRes.status).toBe(200);
      const paramTree = (await paramTreeRes.json()) as WorkspaceTreeResponse;
      expect(paramTree.scope).toBe("skills");

      const invalidScopeRes = await handler(
        new Request("http://127.0.0.1:8089/api/workspace/tree?scope=other"),
      );
      expect(invalidScopeRes.status).toBe(400);
      const invalidScopeData =
        (await invalidScopeRes.json()) as WorkspaceErrorResponse;
      expect(invalidScopeData.error).toBe("invalid_scope");

      const mismatchedScopeRes = await handler(
        new Request("http://127.0.0.1:8089/api/skills/tree?scope=workspace"),
      );
      expect(mismatchedScopeRes.status).toBe(400);
      const mismatchedScopeData =
        (await mismatchedScopeRes.json()) as WorkspaceErrorResponse;
      expect(mismatchedScopeData.error).toBe("scope_mismatch");

      // Read skill file
      const readRes = await handler(
        new Request(
          "http://127.0.0.1:8089/api/skills/file?path=weather/SKILL.md",
        ),
      );
      expect(readRes.status).toBe(200);
      const readData = (await readRes.json()) as WorkspaceFile;
      expect(readData.scope).toBe("skills");
      expect(readData.content).toContain("name: weather");

      // Create new file in skills scope
      const createRes = await handler(
        new Request("http://127.0.0.1:8089/api/skills/file/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:8089",
          },
          body: JSON.stringify({
            path: "weather/helper.py",
            content: "def get_temp(): return 72\n",
          }),
        }),
      );
      expect(createRes.status).toBe(200);
      const createdData = (await createRes.json()) as WorkspaceWriteResponse;
      expect(createdData.scope).toBe("skills");

      // Verify file was written to skillsDir and not to workspace root
      expect(
        require("node:fs").existsSync(join(skillsDir, "weather", "helper.py")),
      ).toBe(true);
      expect(
        require("node:fs").existsSync(join(root, "weather", "helper.py")),
      ).toBe(false);

      // Delete directory in skills scope
      const deleteDirRes = await handler(
        new Request("http://127.0.0.1:8089/api/skills/directory", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:8089",
          },
          body: JSON.stringify({
            path: "weather",
          }),
        }),
      );
      expect(deleteDirRes.status).toBe(200);
      const deleteDirData =
        (await deleteDirRes.json()) as WorkspaceDeleteResponse;
      expect(deleteDirData.scope).toBe("skills");
      expect(deleteDirData.deleted).toBe(true);
      expect(existsSync(join(skillsDir, "weather"))).toBe(false);

      // When skillsRoot is not configured, requesting skills returns 404 skills_unavailable
      const noSkillsHandler = createWorkspaceHandler({
        workspaceRoot: root,
        authRequired: false,
      });
      const unavailRes = await noSkillsHandler(
        new Request("http://127.0.0.1:8089/api/skills/tree"),
      );
      expect(unavailRes.status).toBe(404);
      const unavailData = (await unavailRes.json()) as WorkspaceErrorResponse;
      expect(unavailData.error).toBe("skills_unavailable");
    } finally {
      rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  test("manages SOUL.md, AGENTS.md, and memories/ via AgentService and /api/agent", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "openlia-data-test-"));
    try {
      writeFileSync(
        join(dataRoot, "SOUL.md"),
        "# OpenLia Soul\nPersona guidance.\n",
      );
      writeFileSync(
        join(dataRoot, "AGENTS.md"),
        "# OpenLia Agents\nOperating rules.\n",
      );
      mkdirSync(join(dataRoot, "memories"), { recursive: true });
      writeFileSync(
        join(dataRoot, "memories", "MEMORY.md"),
        "# Facts\nLearned conventions.\n",
      );
      writeFileSync(
        join(dataRoot, "memories", "USER.md"),
        "# User\nPreferences.\n",
      );
      writeFileSync(
        join(dataRoot, "config.yaml"),
        "model: gpt-5.6\nsecrets: {}\n",
      );

      const agentService = new AgentService({
        dataRoot,
      });

      // 1. WorkspaceService does NOT list SOUL.md, AGENTS.md, or memories
      const wsTree = service.listTree();
      expect(wsTree.entries.some((e) => e.path === "SOUL.md")).toBe(false);
      expect(wsTree.entries.some((e) => e.path === "AGENTS.md")).toBe(false);
      expect(wsTree.entries.some((e) => e.path === "memories")).toBe(false);

      // 2. AgentService lists SOUL.md, AGENTS.md, and memories/** with correct protection
      const tree = agentService.listTree();
      const soulEntry = tree.entries.find((e) => e.path === "SOUL.md");
      const agentsEntry = tree.entries.find((e) => e.path === "AGENTS.md");
      const memDirEntry = tree.entries.find((e) => e.path === "memories");
      const memFileEntry = tree.entries.find(
        (e) => e.path === "memories/MEMORY.md",
      );
      const userFileEntry = tree.entries.find(
        (e) => e.path === "memories/USER.md",
      );

      expect(soulEntry).toBeDefined();
      expect(soulEntry?.protected).toBe(true);
      expect(soulEntry?.editable).toBe(true);

      expect(agentsEntry).toBeDefined();
      expect(agentsEntry?.protected).toBe(true);
      expect(agentsEntry?.editable).toBe(true);

      expect(memDirEntry).toBeDefined();
      expect(memDirEntry?.kind).toBe("directory");
      expect(memDirEntry?.protected).toBe(true);

      expect(memFileEntry).toBeDefined();
      expect(memFileEntry?.protected).toBeUndefined();
      expect(memFileEntry?.editable).toBe(true);

      expect(userFileEntry).toBeDefined();
      expect(userFileEntry?.protected).toBeUndefined();
      expect(userFileEntry?.editable).toBe(true);

      // Ensure unallowlisted files like config.yaml are omitted
      expect(tree.entries.some((e) => e.path === "config.yaml")).toBe(false);

      // 3. readFile loads SOUL.md and memories/MEMORY.md
      const soulFile = agentService.readFile("SOUL.md");
      expect(soulFile.protected).toBe(true);
      expect(soulFile.content).toContain("Persona guidance.");

      const memoryFile = agentService.readFile("memories/MEMORY.md");
      expect(memoryFile.protected).toBeUndefined();
      expect(memoryFile.content).toContain("Learned conventions.");

      // 4. Access to unallowlisted files is rejected with 403 forbidden_path
      expect(() => agentService.readFile("config.yaml")).toThrow(
        WorkspaceError,
      );
      try {
        agentService.readFile("config.yaml");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).status).toBe(403);
        expect((err as WorkspaceError).code).toBe("forbidden_path");
      }

      // 5. writeFile edits SOUL.md in dataRoot atomically with revision guard
      const updatedSoul = agentService.writeFile(
        "SOUL.md",
        "# OpenLia Soul\nUpdated persona.\n",
        soulFile.revision,
      );
      expect(updatedSoul.protected).toBe(true);
      expect(agentService.readFile("SOUL.md").content).toContain(
        "Updated persona.",
      );

      // 6. writeFile edits memories/USER.md
      const userFile = agentService.readFile("memories/USER.md");
      const updatedUser = agentService.writeFile(
        "memories/USER.md",
        "# User\nUpdated preferences.\n",
        userFile.revision,
      );
      expect(updatedUser.protected).toBeUndefined();
      expect(agentService.readFile("memories/USER.md").content).toContain(
        "Updated preferences.",
      );

      // 7. createFile and deleteFile inside memories/ work
      const createdNote = agentService.createFile(
        "memories/notes.md",
        "# Custom memory note\n",
      );
      expect(createdNote.path).toBe("memories/notes.md");
      expect(existsSync(join(dataRoot, "memories", "notes.md"))).toBe(true);

      agentService.deleteFile("memories/notes.md");
      expect(existsSync(join(dataRoot, "memories", "notes.md"))).toBe(false);

      // 8. deleteFile on protected files is rejected with 403
      expect(() => agentService.deleteFile("SOUL.md")).toThrow(WorkspaceError);
      try {
        agentService.deleteFile("SOUL.md");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).status).toBe(403);
        expect((err as WorkspaceError).code).toBe("protected_file");
      }

      // 9. deleteDirectory on memories/ root is rejected with 403
      expect(() => agentService.deleteDirectory("memories")).toThrow(
        WorkspaceError,
      );
      try {
        agentService.deleteDirectory("memories");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).status).toBe(403);
        expect((err as WorkspaceError).code).toBe("protected_file");
      }

      // 10. renameFile and moveFile on protected files are rejected
      expect(() => agentService.renameFile("SOUL.md", "GHOST.md")).toThrow(
        WorkspaceError,
      );
      expect(() => agentService.moveFile("SOUL.md", "memories")).toThrow(
        WorkspaceError,
      );

      // 11. HTTP API integration via createWorkspaceHandler
      const handler = createWorkspaceHandler({
        workspaceRoot: root,
        dataRoot,
        authRequired: false,
      });

      const httpTree = await handler(
        new Request("http://127.0.0.1:8089/api/agent/tree"),
      );
      expect(httpTree.status).toBe(200);
      const httpTreeData = (await httpTree.json()) as WorkspaceTreeResponse;
      expect(httpTreeData.entries.some((e) => e.path === "SOUL.md")).toBe(true);
      expect(
        httpTreeData.entries.some((e) => e.path === "memories/MEMORY.md"),
      ).toBe(true);

      const httpRead = await handler(
        new Request("http://127.0.0.1:8089/api/agent/file?path=SOUL.md"),
      );
      expect(httpRead.status).toBe(200);
      const httpReadData = (await httpRead.json()) as WorkspaceFile;
      expect(httpReadData.protected).toBe(true);
      expect(httpReadData.content).toContain("Updated persona.");

      const httpBlocked = await handler(
        new Request("http://127.0.0.1:8089/api/agent/file?path=config.yaml"),
      );
      expect(httpBlocked.status).toBe(403);

      const httpDelete = await handler(
        new Request("http://127.0.0.1:8089/api/agent/file", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:8089",
          },
          body: JSON.stringify({ path: "SOUL.md" }),
        }),
      );
      expect(httpDelete.status).toBe(403);
      const httpDeleteData =
        (await httpDelete.json()) as WorkspaceErrorResponse;
      expect(httpDeleteData.error).toBe("protected_file");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
