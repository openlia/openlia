import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createZipArchive, exportArchive } from "./export";
import { WorkspaceError } from "./workspace";

describe("export archive", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let skillsRoot: string;
  let memoriesRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openlia-export-test-"));
    workspaceRoot = join(tempDir, "workspace");
    skillsRoot = join(tempDir, "skills");
    memoriesRoot = join(tempDir, "memories");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(memoriesRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  test("createZipArchive creates valid PKZIP archives verified by unzip", () => {
    const entries = [
      {
        data: new TextEncoder().encode("# Workspace Notes\nSome content"),
        path: "workspace/notes.md",
      },
      {
        data: new TextEncoder().encode("---\nname: my-skill\n---\n# Skill"),
        path: "skills/my-skill/SKILL.md",
      },
      {
        data: new Uint8Array(),
        path: "workspace/empty.txt",
      },
    ];

    const zipBuffer = createZipArchive(entries);
    expect(zipBuffer.length).toBeGreaterThan(0);

    const testZipPath = join(tempDir, "test.zip");
    writeFileSync(testZipPath, zipBuffer);

    const result = spawnSync("unzip", ["-t", testZipPath], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("workspace/notes.md");
    expect(result.stdout).toContain("skills/my-skill/SKILL.md");
    expect(result.stdout).toContain("workspace/empty.txt");
  });

  test("exportArchive gathers files from both workspace and skills with proper prefixes", () => {
    // Workspace files
    writeFileSync(join(workspaceRoot, "notes.md"), "# Notes");
    mkdirSync(join(workspaceRoot, "projects"), { recursive: true });
    writeFileSync(join(workspaceRoot, "projects", "todo.md"), "- task 1");

    // Skills files
    mkdirSync(join(skillsRoot, "web-search"), { recursive: true });
    writeFileSync(
      join(skillsRoot, "web-search", "SKILL.md"),
      "---\nname: web-search\n---",
    );
    mkdirSync(join(skillsRoot, "productivity", "notion"), { recursive: true });
    writeFileSync(
      join(skillsRoot, "productivity", "notion", "SKILL.md"),
      "---\nname: notion\n---",
    );
    writeFileSync(
      join(skillsRoot, ".usage.json"),
      JSON.stringify({ "web-search": { pinned: true } }),
    );
    writeFileSync(join(memoriesRoot, "USER.md"), "# User\n");
    writeFileSync(join(memoriesRoot, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(memoriesRoot, "private.txt"), "not exported");
    writeFileSync(join(memoriesRoot, "USER.md.lock"), "not exported");

    const zipBytes = exportArchive({ memoriesRoot, skillsRoot, workspaceRoot });
    const testZipPath = join(tempDir, "export-verify.zip");
    writeFileSync(testZipPath, zipBytes);

    const listResult = spawnSync("unzip", ["-l", testZipPath], {
      encoding: "utf8",
    });
    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain("workspace/notes.md");
    expect(listResult.stdout).toContain("workspace/projects/todo.md");
    expect(listResult.stdout).toContain("skills/web-search/SKILL.md");
    expect(listResult.stdout).toContain("skills/productivity/notion/SKILL.md");
    expect(listResult.stdout).toContain("skills/.usage.json");
    expect(listResult.stdout).toContain("memories/USER.md");
    expect(listResult.stdout).toContain("memories/MEMORY.md");
    expect(listResult.stdout).not.toContain("memories/private.txt");
    expect(listResult.stdout).not.toContain("memories/USER.md.lock");
  });

  test("exportArchive excludes protected files and system noise", () => {
    // Normal files
    writeFileSync(join(workspaceRoot, "doc.md"), "hello");

    // Protected files
    writeFileSync(join(workspaceRoot, ".env"), "SECRET=123");
    writeFileSync(join(workspaceRoot, ".env.production"), "SECRET=456");
    writeFileSync(join(workspaceRoot, "auth.json"), "{}");
    writeFileSync(join(workspaceRoot, ".gitignore"), "node_modules");
    writeFileSync(join(workspaceRoot, "agents.md"), "# Hermes instructions");
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".git", "config"), "gitconfig");

    // Noise files
    writeFileSync(join(workspaceRoot, ".DS_Store"), "junk");
    writeFileSync(join(workspaceRoot, "Thumbs.db"), "junk");
    writeFileSync(join(workspaceRoot, "._doc.md"), "junk");

    // Generated artifacts
    mkdirSync(join(skillsRoot, ".curator_backups", "snapshot"), {
      recursive: true,
    });
    writeFileSync(
      join(skillsRoot, ".curator_backups", "snapshot", "skills.tar.gz"),
      "old snapshot",
    );
    mkdirSync(join(skillsRoot, "custom", "__pycache__"), {
      recursive: true,
    });
    writeFileSync(
      join(skillsRoot, "custom", "__pycache__", "helper.pyc"),
      "bytecode",
    );
    mkdirSync(join(workspaceRoot, "node_modules", "package"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceRoot, "node_modules", "package", "index.js"),
      "dependency",
    );

    // Symlinks
    const targetFile = join(tempDir, "outside.txt");
    writeFileSync(targetFile, "outside content");
    try {
      symlinkSync(targetFile, join(workspaceRoot, "symlink.txt"));
    } catch {}

    const zipBytes = exportArchive({ skillsRoot, workspaceRoot });
    const testZipPath = join(tempDir, "export-filtered.zip");
    writeFileSync(testZipPath, zipBytes);

    const listResult = spawnSync("unzip", ["-l", testZipPath], {
      encoding: "utf8",
    });
    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain("workspace/doc.md");
    expect(listResult.stdout).not.toContain(".env");
    expect(listResult.stdout).not.toContain("auth.json");
    expect(listResult.stdout).not.toContain(".gitignore");
    expect(listResult.stdout).not.toContain("agents.md");
    expect(listResult.stdout).not.toContain(".git");
    expect(listResult.stdout).not.toContain(".DS_Store");
    expect(listResult.stdout).not.toContain("Thumbs.db");
    expect(listResult.stdout).not.toContain("._doc.md");
    expect(listResult.stdout).not.toContain("symlink.txt");
    expect(listResult.stdout).not.toContain(".curator_backups");
    expect(listResult.stdout).not.toContain("__pycache__");
    expect(listResult.stdout).not.toContain("node_modules");
  });

  test("exportArchive throws export_too_large when exceeding maxDownloadBytes", () => {
    writeFileSync(join(workspaceRoot, "large.txt"), "A".repeat(1024));

    expect(() =>
      exportArchive({
        maxDownloadBytes: 500,
        skillsRoot,
        workspaceRoot,
      }),
    ).toThrowError(WorkspaceError);

    try {
      exportArchive({
        maxDownloadBytes: 500,
        skillsRoot,
        workspaceRoot,
      });
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("export_too_large");
      expect((error as WorkspaceError).status).toBe(413);
    }
  });

  test("exportArchive handles missing or empty directories gracefully", () => {
    const nonExistentSkills = join(tempDir, "does-not-exist");
    writeFileSync(join(workspaceRoot, "note.md"), "only workspace");

    const zipBytes = exportArchive({
      skillsRoot: nonExistentSkills,
      workspaceRoot,
    });
    const testZipPath = join(tempDir, "single.zip");
    writeFileSync(testZipPath, zipBytes);

    const listResult = spawnSync("unzip", ["-l", testZipPath], {
      encoding: "utf8",
    });
    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain("workspace/note.md");
  });

  test("exportArchive includes Ingestion Vault data and excludes transient shm/locks", () => {
    const ingestionRoot = join(tempDir, "ingestion");
    mkdirSync(join(ingestionRoot, "blobs", "src_001", "ver_001"), {
      recursive: true,
    });
    writeFileSync(join(ingestionRoot, "vault.sqlite"), "vault db content");
    writeFileSync(join(ingestionRoot, "vault.sqlite-shm"), "transient shm");
    writeFileSync(join(ingestionRoot, "ingestion.lock"), "lock file");
    writeFileSync(join(workspaceRoot, "shares.sqlite"), "shares db content");
    writeFileSync(join(workspaceRoot, "shares.sqlite-wal"), "shares wal");
    writeFileSync(join(workspaceRoot, "shares.sqlite-shm"), "shares shm");
    writeFileSync(
      join(ingestionRoot, "blobs", "src_001", "ver_001", "original.pdf"),
      "%PDF-1.4 sample",
    );
    writeFileSync(
      join(ingestionRoot, "document-passwords.toml"),
      '[profiles.pin]\npassword = "secret"\n',
    );

    const zipBytes = exportArchive({
      ingestionRoot,
      skillsRoot,
      workspaceRoot,
    });
    const testZipPath = join(tempDir, "export-ingestion.zip");
    writeFileSync(testZipPath, zipBytes);

    const listResult = spawnSync("unzip", ["-l", testZipPath], {
      encoding: "utf8",
    });
    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain("ingestion/vault.sqlite");
    expect(listResult.stdout).toContain(
      "ingestion/blobs/src_001/ver_001/original.pdf",
    );
    expect(listResult.stdout).toContain("ingestion/document-passwords.toml");
    expect(listResult.stdout).not.toContain("vault.sqlite-shm");
    expect(listResult.stdout).not.toContain("ingestion.lock");
    expect(listResult.stdout).not.toContain("shares.sqlite");
    expect(listResult.stdout).not.toContain("shares.sqlite-wal");
    expect(listResult.stdout).not.toContain("shares.sqlite-shm");
  });
});
