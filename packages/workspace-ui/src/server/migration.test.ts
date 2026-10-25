import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { MigrationService } from "./migration";
import { createWorkspaceHandler } from "./app";

describe("MigrationService & endpoints", () => {
  let rootDir: string;
  let workspaceDir: string;
  let migrationsDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "openlia-migration-test-"));
    workspaceDir = join(rootDir, "workspace");
    migrationsDir = join(rootDir, ".openlia", "workspace-migrations");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { force: true, recursive: true });
  });

  function setupMigrationV2(id: string) {
    const migDir = join(migrationsDir, id);
    mkdirSync(migDir, { recursive: true });
    const sqlitePath = join(migDir, "migration.sqlite");
    const db = new Database(sqlitePath);

    db.run(`
      CREATE TABLE migrations (
        id TEXT PRIMARY KEY,
        schema INTEGER NOT NULL,
        state TEXT NOT NULL,
        saved_phase TEXT,
        stop_intent INTEGER NOT NULL DEFAULT 0,
        baseline_manifest TEXT,
        active_revision_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT
      );
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        migration_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        byte_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        encoding TEXT NOT NULL,
        detected_type TEXT NOT NULL,
        eligibility TEXT NOT NULL,
        reason TEXT,
        dependencies TEXT,
        order_index INTEGER NOT NULL
      );
      CREATE TABLE revisions (
        id TEXT PRIMARY KEY,
        migration_id TEXT NOT NULL,
        revision_num INTEGER NOT NULL,
        baseline_hash TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        tree_hash TEXT NOT NULL,
        patch_hash TEXT NOT NULL,
        parent_rev_id TEXT,
        summary TEXT,
        changed_files TEXT,
        findings TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE feedback (
        id TEXT PRIMARY KEY,
        migration_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        target_path TEXT,
        source_id TEXT,
        line_number INTEGER,
        comment TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    db.run(`INSERT INTO migrations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      2,
      "ready_for_review",
      "stopped",
      0,
      "base123",
      "rev-1",
      "2026-10-11T08:00:00Z",
      "2026-10-11T08:30:00Z",
      null,
      "",
    ]);

    db.run(`INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      "src-1",
      id,
      "notes.md",
      "hash1",
      123,
      "utf-8",
      "markdown",
      "eligible",
      null,
      null,
      1,
    ]);

    const changedFiles = JSON.stringify([
      { path: "notes.md", status: "added", additions: 5, deletions: 0 },
    ]);
    db.run(
      `INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rev-1",
        id,
        1,
        "base123",
        "commit123",
        "tree123",
        "patch123",
        null,
        "Initial revision",
        changedFiles,
        null,
        "2026-10-11T08:30:00Z",
      ],
    );

    db.close();
  }

  test("lists migrations including V2 and V1 formats", () => {
    setupMigrationV2("mig-20261011-001");

    // Add a V1 migration
    const v1Dir = join(migrationsDir, "mig-20261011-v1");
    mkdirSync(v1Dir, { recursive: true });
    writeFileSync(
      join(v1Dir, "status.json"),
      JSON.stringify({
        id: "mig-20261011-v1",
        status: "done",
        created_at: "2026-10-11T07:00:00Z",
        plan_summary: { total_files: 10 },
      }),
    );

    const service = new MigrationService({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
    });

    const res = service.list();
    expect(res.schema).toBe(2);
    expect(res.migrations.length).toBe(2);
    expect(res.migrations[0]!.id).toBe("mig-20261011-001");
    expect(res.migrations[0]!.state).toBe("ready_for_review");
    expect(res.migrations[0]!.total_sources).toBe(1);
    expect(res.migrations[0]!.total_revisions).toBe(1);

    expect(res.migrations[1]!.id).toBe("mig-20261011-v1");
    expect(res.migrations[1]!.state).toBe("done");
  });

  test("returns migration detail with sources and revisions", () => {
    setupMigrationV2("mig-20261011-001");

    const service = new MigrationService({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
    });

    const detail = service.detail("mig-20261011-001");
    expect(detail.schema).toBe(2);
    expect(detail.migration.id).toBe("mig-20261011-001");
    expect(detail.sources.length).toBe(1);
    expect(detail.sources[0]!.relative_path).toBe("notes.md");
    expect(detail.revisions.length).toBe(1);
    expect(detail.revisions[0]!.id).toBe("rev-1");
  });

  test("records feedback comments into database", () => {
    setupMigrationV2("mig-20261011-001");

    const service = new MigrationService({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
    });

    const action = service.addFeedback("mig-20261011-001", {
      revision_id: "rev-1",
      comment: "Please revise categorization",
    });
    expect(action.ok).toBe(true);

    const detail = service.detail("mig-20261011-001");
    expect(detail.feedback.length).toBe(1);
    expect(detail.feedback[0]!.comment).toBe("Please revise categorization");
    expect(detail.feedback[0]!.revision_id).toBe("rev-1");
  });

  test("HTTP handler exposes migration endpoints", async () => {
    setupMigrationV2("mig-20261011-001");

    const handler = createWorkspaceHandler({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
    });

    // GET /api/workspace/migration
    const listRes = await handler(
      new Request("http://localhost/api/workspace/migration"),
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { migrations: unknown[] };
    expect(listJson.migrations.length).toBe(1);

    // GET /api/workspace/migration/mig-20261011-001
    const detailRes = await handler(
      new Request("http://localhost/api/workspace/migration/mig-20261011-001"),
    );
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      migration: { id: string };
    };
    expect(detailJson.migration.id).toBe("mig-20261011-001");

    // POST /api/workspace/migration/mig-20261011-001/feedback
    const fbRes = await handler(
      new Request(
        "http://localhost/api/workspace/migration/mig-20261011-001/feedback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            revision_id: "rev-1",
            comment: "Looks promising, but needs changes",
          }),
        },
      ),
    );
    expect(fbRes.status).toBe(200);
    const fbJson = (await fbRes.json()) as { ok: boolean };
    expect(fbJson.ok).toBe(true);

    // Verify feedback is present
    const updatedDetailRes = await handler(
      new Request("http://localhost/api/workspace/migration/mig-20261011-001"),
    );
    const updatedDetailJson = (await updatedDetailRes.json()) as {
      feedback: Array<{ comment: string }>;
    };
    expect(updatedDetailJson.feedback.length).toBe(1);
    expect(updatedDetailJson.feedback[0]!.comment).toBe(
      "Looks promising, but needs changes",
    );
  });

  test("feedback with [CHANGES REQUESTED] transitions migration to revising", () => {
    setupMigrationV2("mig-20261011-001");

    const service = new MigrationService({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
    });

    const action = service.addFeedback("mig-20261011-001", {
      revision_id: "rev-1",
      comment: "[CHANGES REQUESTED] Fix table alignment and rename section",
    });
    expect(action.ok).toBe(true);
    expect(action.state).toBe("revising");

    const detail = service.detail("mig-20261011-001");
    expect(detail.migration.state).toBe("revising");
  });

  test("createTemplateFixMigration creates a fast-track migration in ready_for_review state with proposal diff", async () => {
    // 1. Create a tasks domain with a template and schema
    const tasksDir = join(workspaceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, "record-template.md"),
      "---\n$schema: ./record-template.schema.json\nstatus: null\npriority: null\n---\n# <Task Title>\n\n## Context\nContext notes\n\n## Definition of Done\n- Criteria\n",
    );
    writeFileSync(
      join(tasksDir, "record-template.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["status", "priority"],
        properties: {
          status: { type: ["string", "null"] },
          priority: { type: ["string", "null"] },
        },
      }),
    );

    // 2. Create a live task file with a typo in heading and missing 'priority'
    writeFileSync(
      join(tasksDir, "task-1.md"),
      "---\nstatus: in_progress\n---\n# Implement Auth\n\n## Conteext\nAuthentication notes\n",
    );

    const service = new MigrationService({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
    });

    const result = service.createTemplateFixMigration("tasks/task-1.md");
    expect(result.migration_id).toMatch(/^mig-/);

    // 3. Verify migration detail
    const detail = service.detail(result.migration_id);
    expect(detail.migration.state).toBe("ready_for_review");
    expect(detail.revisions.length).toBe(1);
    expect(detail.revisions[0]!.summary).toContain(
      "Fix template headings and schema conformance for tasks/task-1.md",
    );
    expect(detail.active_diff).toBeDefined();
    expect(detail.active_diff!).toContain("-## Conteext");
    expect(detail.active_diff!).toContain("+## Context");
    expect(detail.active_diff!).toContain("+priority: null");
    expect(detail.active_diff!).toContain("+## Definition of Done");
    expect(detail.active_diff!.endsWith("\n")).toBe(true);
    expect(detail.revisions[0]!.patch_hash).toBe(
      createHash("sha256").update(detail.active_diff!).digest("hex"),
    );
    expect(detail.revisions[0]!.patch_hash).not.toBe(
      createHash("sha256").update(detail.active_diff!.trim()).digest("hex"),
    );
    expect(detail.revisions[0]!.commit_hash).toMatch(/^[a-f0-9]{40}$/);
    expect(detail.revisions[0]!.tree_hash).toMatch(/^[a-f0-9]{40}$/);

    // 4. Test via HTTP handler
    const handler = createWorkspaceHandler({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
      authRequired: false,
    });

    const httpRes = await handler(
      new Request("http://localhost/api/workspace/fix-template-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "tasks/task-1.md" }),
      }),
    );
    expect(httpRes.status).toBe(200);
    const httpJson = (await httpRes.json()) as {
      ok: boolean;
      migration_id: string;
    };
    expect(httpJson.ok).toBe(true);
    expect(httpJson.migration_id).toMatch(/^mig-/);
  });

  test("createTemplateFixMigration strips unrecognized frontmatter when additionalProperties is false and coerces invalid enum values", () => {
    const goalsDir = join(workspaceDir, "goals");
    mkdirSync(goalsDir, { recursive: true });
    writeFileSync(
      join(goalsDir, "goal-template.md"),
      "---\n$schema: ./goal-template.schema.json\nstatus: null\ntarget_completion: null\n---\n# <Goal Title>\n\n## Objective\nOutcome\n",
    );
    writeFileSync(
      join(goalsDir, "goal-template.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["status", "target_completion"],
        additionalProperties: false,
        properties: {
          status: {
            type: ["string", "null"],
            enum: [null, "active", "paused", "completed", "archived"],
          },
          target_completion: { type: ["string", "null"] },
        },
      }),
    );

    writeFileSync(
      join(goalsDir, "menu-note.md"),
      "---\nmenu_date: 2026-10-24\nstatus: draft\n---\n# Family Menu\n\nMenu details\n",
    );

    const service = new MigrationService({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
    });

    const result = service.createTemplateFixMigration("goals/menu-note.md");
    const detail = service.detail(result.migration_id);
    expect(detail.active_diff).toContain("-menu_date: 2026-10-24");
    expect(detail.active_diff).toContain("-status: draft");
    expect(detail.active_diff).toContain("+status: null");
    expect(detail.active_diff).toContain("+target_completion: null");
    expect(detail.active_diff).toContain("+### Preserved Metadata");
    expect(detail.active_diff).toContain("+- `menu_date`: 2026-10-24");
    expect(detail.active_diff).toContain("+## Objective");
  });

  test("createTemplateFixMigration reconciles inbox/daily-briefing records with briefing-template.md and infers date from filename", () => {
    const briefingDir = join(workspaceDir, "inbox", "daily-briefing");
    mkdirSync(briefingDir, { recursive: true });
    writeFileSync(
      join(briefingDir, "briefing-template.md"),
      "---\n$schema: ./briefing.schema.json\ndate: YYYY-MM-DD\n---\n\n# Daily Briefing\n\n## Today\n\n## What Changed\n\n## Important-Urgent Matrix\n",
    );
    writeFileSync(
      join(briefingDir, "briefing.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["date"],
        additionalProperties: false,
        properties: {
          date: {
            oneOf: [
              { const: "YYYY-MM-DD" },
              { type: "string", format: "date" },
            ],
          },
        },
      }),
    );

    writeFileSync(
      join(briefingDir, "2026-10-24.md"),
      "# Daily Briefing\n\n## Today\n\n- Focus item\n",
    );

    const service = new MigrationService({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
    });

    const result = service.createTemplateFixMigration(
      "inbox/daily-briefing/2026-10-24.md",
    );
    const detail = service.detail(result.migration_id);
    expect(detail.active_diff).toContain("+$schema: ./briefing.schema.json");
    expect(detail.active_diff).toContain("+date: 2026-10-24");
    expect(detail.active_diff).toContain("+## What Changed");
    expect(detail.active_diff).toContain("+## Important-Urgent Matrix");
  });

  test("createTemplateFixMigration reconciles knowledge/research records with stray leading dashes, infers status and date, and preserves headings", () => {
    const researchDir = join(workspaceDir, "knowledge", "research");
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(
      join(researchDir, "research-template.md"),
      "---\n$schema: ./research-template.schema.json\nstatus: provisional\ndate: YYYY-MM-DD\n---\n\n# <Research Brief Title>\n\n## Question\n\n## Scope And Decision Relevance\n\n## Executive Summary\n\n## Claims And Evidence\n\n## Evidence Gaps\n\n## Next Checks\n\n## Sources\n",
    );
    writeFileSync(
      join(researchDir, "research-template.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["status", "date"],
        additionalProperties: false,
        properties: {
          status: {
            type: ["string", "null"],
            enum: [
              null,
              "established",
              "provisional",
              "unresolved",
              "archived",
            ],
          },
          date: {
            oneOf: [
              { const: "YYYY-MM-DD" },
              { type: "string", format: "date" },
            ],
          },
        },
      }),
    );

    writeFileSync(
      join(researchDir, "makeup-co-ban.md"),
      "---\n# Research Brief\n\n## Question\n- Research question: Which lipstick?\n- Research status: provisional\n\n## Scope And Decision Relevance\nScope\n\n## Executive Summary\nSummary\n\n## Custom Section Notes\nCustom\n\n## Evidence Gaps\nGaps\n\n## Next Checks\nChecks\n\n## Sources\nSources\n",
    );

    const service = new MigrationService({
      workspaceRoot: workspaceDir,
      migrationsRoot: migrationsDir,
    });

    const result = service.createTemplateFixMigration(
      "knowledge/research/makeup-co-ban.md",
    );
    const detail = service.detail(result.migration_id);
    expect(detail.active_diff).toContain(
      "+$schema: ./research-template.schema.json",
    );
    expect(detail.active_diff).toContain("+status: provisional");
    expect(detail.active_diff).toContain("+## Claims And Evidence");
    // Ensure no orphan '---' inside diff
    expect(detail.active_diff).not.toMatch(/\+---\s*\n\s*\+---/);
  });
});
