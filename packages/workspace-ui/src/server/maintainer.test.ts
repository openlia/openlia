import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceHandler } from "./app";
import { MaintainerService } from "./maintainer/engine";

describe("Workspace Maintainer & Consequential Permissions", () => {
  let root: string;
  let workspaceRoot: string;
  let maintainerDbPath: string;
  let permissionsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openlia-maintainer-test-"));
    workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    maintainerDbPath = join(root, "maintainer", "maintainer.sqlite");
    permissionsPath = join(root, "permissions.yaml");
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  async function createAndSaveFile(
    handler: (req: Request) => Promise<Response>,
    domain: string,
    name: string,
    content: string,
  ) {
    const createRes = await handler(
      new Request("http://localhost/api/workspace/create-file", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ domain, name }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      path: string;
      revision: string;
    };

    const writeRes = await handler(
      new Request("http://localhost/api/workspace/file", {
        method: "PUT",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: created.path,
          content,
          expected_revision: created.revision,
        }),
      }),
    );
    expect(writeRes.status).toBe(200);
    return (await writeRes.json()) as {
      path: string;
      revision: string;
      validation: {
        valid: boolean;
        findings: Array<{
          issue_id: string;
          relative_path: string;
          rule_code: string;
          subject: string;
        }>;
      };
    };
  }

  test("1. Fresh family-menu creation works without workspace.yaml or assistant-policy.yaml", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot,
      maintainerDatabasePath: maintainerDbPath,
      permissionsFilePath: permissionsPath,
    });

    // Ensure neither workspace.yaml nor assistant-policy.yaml exists
    expect(existsSync(join(workspaceRoot, "workspace.yaml"))).toBe(false);
    expect(existsSync(join(workspaceRoot, "assistant-policy.yaml"))).toBe(
      false,
    );

    // Create a family-menu template, manifest, and UI without any registry entry
    mkdirSync(join(workspaceRoot, "family-menu"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "family-menu", "menu-template.md"),
      "---\ntitle: Weekly Menu\nweek: 2026-W44\n---\n# Weekly Menu\n\n## Meals\n\n## Shopping\n",
    );
    writeFileSync(
      join(workspaceRoot, "family-menu", "project-manifest.toml"),
      `version = 1\n[project]\nid = "family-menu"\nname = "Family Menu"\n[data]\ntemplate = "menu-template.md"\n[ui]\nentry = "ui.openui"\n`,
    );
    writeFileSync(
      join(workspaceRoot, "family-menu", "ui.openui"),
      `root = Stack([DomainHeader("Family Menu")])\n`,
    );

    // Create a new file via /api/workspace/create-file in the unregistered family-menu folder
    const createRes = await handler(
      new Request("http://localhost/api/workspace/create-file", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          domain: "family-menu",
          name: "2026-10-26.md",
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createdFile = (await createRes.json()) as {
      path: string;
      content: string;
    };
    expect(createdFile.path).toBe("family-menu/2026-10-26.md");
    expect(createdFile.content).toContain("## Shopping");

    // Project loads and renders cleanly
    const projRes = await handler(
      new Request("http://localhost/api/workspace/project?path=family-menu"),
    );
    expect(projRes.status).toBe(200);
    const projData = (await projRes.json()) as {
      renderable: boolean;
      records: Array<{ path: string }>;
    };
    expect(projData.renderable).toBe(true);
    expect(projData.records.map((r) => r.path)).toContain(
      "family-menu/2026-10-26.md",
    );
  });

  test("2 & 3. Free-form folders without templates/schemas produce zero errors; local templates govern only direct children", async () => {
    mkdirSync(join(workspaceRoot, "random-thoughts"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "random-thoughts", "idea.md"),
      "Just a quick free-form note without frontmatter or level-1 heading.\n",
    );

    mkdirSync(join(workspaceRoot, "projects", "sub"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "projects", "project-template.md"),
      "# Project Title\n\n## Goals\n\n## Milestones\n",
    );
    // Direct child is governed by project-template.md
    writeFileSync(
      join(workspaceRoot, "projects", "alpha.md"),
      "# Alpha Project\n\n## Goals\n",
    );
    // Grandchild in projects/sub is NOT governed by projects/project-template.md
    writeFileSync(
      join(workspaceRoot, "projects", "sub", "scratch.md"),
      "# Sub Scratch\n\nFreeform nested note.\n",
    );

    const maintainer = new MaintainerService({
      workspaceRoot,
      dbPath: maintainerDbPath,
    });
    const audit = maintainer.runWorkspaceAudit();
    expect(audit.scan_state.coverage_status).toBe("complete");

    const openPaths = audit.open_findings.map((f) => f.relative_path);
    expect(openPaths).not.toContain("random-thoughts/idea.md");
    expect(openPaths).not.toContain("projects/sub/scratch.md");
    expect(openPaths).toContain("projects/alpha.md");

    const alphaFinding = audit.open_findings.find(
      (f) => f.relative_path === "projects/alpha.md",
    );
    expect(alphaFinding?.rule_code).toBe("WM-TEMPLATE-SECTION-MISSING");
    expect(alphaFinding?.subject).toBe("Milestones");
    maintainer.close();
  });

  test("4, 5, 6, 7. Advisory saves succeed with findings; file-specific Ignore suppresses only exact file+issue; Restore re-opens; unrelated edits preserve Ignore", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot,
      maintainerDatabasePath: maintainerDbPath,
      permissionsFilePath: permissionsPath,
    });

    mkdirSync(join(workspaceRoot, "family-menu"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "family-menu", "menu-template.md"),
      "# Weekly Menu\n\n## Meals\n\n## Shopping\n",
    );

    // Save 2026-10-26.md missing "## Shopping" -> Save MUST succeed (200) and return advisory finding
    const saved1 = await createAndSaveFile(
      handler,
      "family-menu",
      "2026-10-26.md",
      "# Menu Oct 26\n\n## Meals\n- Pho\n",
    );
    expect(saved1.validation.valid).toBe(false);
    const openFindings1 = saved1.validation.findings.filter(
      (f: any) => f.state === "open",
    );
    expect(openFindings1.length).toBe(1);
    const issueId1 = openFindings1[0]!.issue_id;
    expect(openFindings1[0]!.rule_code).toBe("WM-TEMPLATE-SECTION-MISSING");
    expect(openFindings1[0]!.subject).toBe("Shopping");

    // Save 2026-10-27.md with the same missing section
    await createAndSaveFile(
      handler,
      "family-menu",
      "2026-10-27.md",
      "# Menu Oct 27\n\n## Meals\n- Bun Cha\n",
    );

    // Ignore the finding in 2026-10-26.md ONLY
    const ignoreRes = await handler(
      new Request("http://localhost/api/maintainer/ignore", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          issue_id: issueId1,
          reason: "Eating out this week",
        }),
      }),
    );
    expect(ignoreRes.status).toBe(200);

    // Verify 2026-10-26.md now has valid: true (0 active errors) on read, while 2026-10-27.md still has its warning
    const read1 = await handler(
      new Request(
        "http://localhost/api/workspace/file?path=family-menu/2026-10-26.md",
      ),
    );
    const read1Data = (await read1.json()) as {
      revision: string;
      validation: { valid: boolean; errors: string[]; ignored_count: number };
    };
    expect(read1Data.validation.valid).toBe(true);
    expect(read1Data.validation.errors.length).toBe(0);
    expect(read1Data.validation.ignored_count).toBe(1);

    const read2 = await handler(
      new Request(
        "http://localhost/api/workspace/file?path=family-menu/2026-10-27.md",
      ),
    );
    const read2Data = (await read2.json()) as {
      validation: { valid: boolean; errors: string[] };
    };
    expect(read2Data.validation.valid).toBe(false);
    expect(read2Data.validation.errors.length).toBe(1);

    // Unrelated edit to 2026-10-26.md (adding lines under Meals) preserves the Ignore!
    const write1Edit = await handler(
      new Request("http://localhost/api/workspace/file", {
        method: "PUT",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: "family-menu/2026-10-26.md",
          content: "# Menu Oct 26\n\n## Meals\n- Pho\n- Spring Rolls\n",
          expected_revision: read1Data.revision,
        }),
      }),
    );
    expect(write1Edit.status).toBe(200);
    const saved1Edit = (await write1Edit.json()) as {
      validation: { valid: boolean; errors: string[]; ignored_count: number };
    };
    expect(saved1Edit.validation.valid).toBe(true);
    expect(saved1Edit.validation.ignored_count).toBe(1);

    // Maintainer overview lists issueId1 in ignored_findings and 2026-10-27 in open_findings
    const overviewRes = await handler(
      new Request("http://localhost/api/maintainer/overview"),
    );
    const overview = (await overviewRes.json()) as {
      open_findings: Array<{ relative_path: string }>;
      ignored_findings: Array<{ issue_id: string; relative_path: string }>;
    };
    expect(overview.open_findings.map((f) => f.relative_path)).toEqual([
      "family-menu/2026-10-27.md",
    ]);
    expect(overview.ignored_findings.map((f) => f.issue_id)).toEqual([
      issueId1,
    ]);

    // Restore warning on 2026-10-26.md
    const restoreRes = await handler(
      new Request("http://localhost/api/maintainer/restore", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ issue_id: issueId1 }),
      }),
    );
    expect(restoreRes.status).toBe(200);

    const overviewAfterRestore = (await (
      await handler(new Request("http://localhost/api/maintainer/overview"))
    ).json()) as {
      open_findings: Array<{ issue_id: string }>;
      ignored_findings: Array<{ issue_id: string }>;
    };
    expect(
      overviewAfterRestore.open_findings.map((f) => f.issue_id),
    ).toContain(issueId1);
    expect(overviewAfterRestore.ignored_findings.length).toBe(0);
  });

  test("8 & 9. Instant deterministic fix previews diff, enforces expected_revision, and resolves finding after revalidation", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot,
      maintainerDatabasePath: maintainerDbPath,
      permissionsFilePath: permissionsPath,
    });

    mkdirSync(join(workspaceRoot, "notes"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "notes", "note-template.md"),
      "# Note Title\n\n## Summary\n\n## Action Items\n",
    );

    const saved = await createAndSaveFile(
      handler,
      "notes",
      "meeting.md",
      "# Team Sync\n\n## Summary\nDiscussed roadmap.\n",
    );
    const issueId = saved.validation.findings[0]!.issue_id;

    // Preview fix
    const previewRes = await handler(
      new Request("http://localhost/api/maintainer/fix/preview", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ issue_id: issueId }),
      }),
    );
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      fix_strategy: string;
      deterministically_fixable: boolean;
      current_revision: string;
      after_content: string;
    };
    expect(preview.fix_strategy).toBe("deterministic");
    expect(preview.deterministically_fixable).toBe(true);
    expect(preview.after_content).toContain("## Action Items");

    // Stale expected_revision must be rejected with 409
    const staleApply = await handler(
      new Request("http://localhost/api/maintainer/fix/apply", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          issue_id: issueId,
          expected_revision: "stale-rev-000",
        }),
      }),
    );
    expect(staleApply.status).toBe(409);

    // Valid expected_revision applies fix and resolves finding
    const validApply = await handler(
      new Request("http://localhost/api/maintainer/fix/apply", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          issue_id: issueId,
          expected_revision: preview.current_revision,
        }),
      }),
    );
    expect(validApply.status).toBe(200);
    const applied = (await validApply.json()) as {
      finding: { state: string } | null;
      file_findings: Array<{ state: string }>;
    };
    expect(applied.finding?.state).toBe("resolved");
    expect(
      applied.file_findings.filter((f) => f.state === "open").length,
    ).toBe(0);
  });

  test("10. Broken project UI is reported as renderable: false while preserving record & file access", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot,
      maintainerDatabasePath: maintainerDbPath,
      permissionsFilePath: permissionsPath,
    });

    mkdirSync(join(workspaceRoot, "broken-app"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "broken-app", "project-manifest.toml"),
      `schema = 1\n[project]\nid = "broken-app"\nname = "Broken App"\n[data]\nqueries = [{ name = "bad_q", filter = "status == 'open'" }]\n[ui]\nentry = "missing-ui.openui"\n`,
    );
    writeFileSync(
      join(workspaceRoot, "broken-app", "item.md"),
      "# First Item\n\nStill accessible.\n",
    );

    const projRes = await handler(
      new Request("http://localhost/api/workspace/project?path=broken-app"),
    );
    expect(projRes.status).toBe(200);
    const proj = (await projRes.json()) as {
      renderable: boolean;
      render_errors: string[];
      records: Array<{ path: string }>;
    };
    expect(proj.renderable).toBe(false);
    expect(proj.render_errors.length).toBeGreaterThan(0);
    expect(proj.records.map((r) => r.path)).toContain("broken-app/item.md");
  });

  test("11. Consequential permissions persist in permissions.yaml and govern cron policy", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot,
      maintainerDatabasePath: maintainerDbPath,
      permissionsFilePath: permissionsPath,
      cronRoot: join(root, "cron"),
    });

    const getRes = await handler(
      new Request("http://localhost/api/permissions"),
    );
    expect(getRes.status).toBe(200);
    const initial = (await getRes.json()) as {
      permissions: {
        scheduled_work: {
          run_briefings: string;
          run_audits: string;
          run_monitors: string;
        };
      };
    };
    expect(initial.permissions.scheduled_work.run_audits).toBe("allow");

    // Update permissions to deny scheduled_work
    const putRes = await handler(
      new Request("http://localhost/api/permissions", {
        method: "PUT",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          permissions: {
            destructive: {
              delete_records: "ask",
              overwrite_records: "ask",
            },
            external: {
              send_messages: "ask",
              make_purchases: "deny",
              modify_external_accounts: "deny",
              ingest_external_content: "allow",
            },
            scheduled_work: {
              run_briefings: "deny",
              run_audits: "deny",
              run_monitors: "deny",
            },
          },
        }),
      }),
    );
    expect(putRes.status).toBe(200);
    expect(existsSync(permissionsPath)).toBe(true);

    // Verify cron overview reflects updated permissions.yaml
    const cronRes = await handler(
      new Request("http://localhost/api/cron/jobs"),
    );
    expect(cronRes.status).toBe(200);
    const cronData = (await cronRes.json()) as {
      policy: { enabled: boolean; allowed_actions: string[] };
    };
    expect(cronData.policy.enabled).toBe(false);
    expect(cronData.policy.allowed_actions).toEqual([]);
  });

  test("12 & 13. Editing a template revalidates dependent records; changing a contract rule invalidates stale ignores for that rule", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot,
      maintainerDatabasePath: maintainerDbPath,
      permissionsFilePath: permissionsPath,
    });

    mkdirSync(join(workspaceRoot, "recipes"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "recipes", "recipe-template.md"),
      "---\n$schema: recipe.schema.json\ndifficulty: easy\n---\n# Recipe\n\n## Ingredients\n",
    );
    writeFileSync(
      join(workspaceRoot, "recipes", "recipe.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          difficulty: { type: "string", enum: ["easy", "medium"] },
        },
        required: ["difficulty"],
      }),
    );

    const saved = await createAndSaveFile(
      handler,
      "recipes",
      "pancakes.md",
      "---\ndifficulty: expert\n---\n# Pancakes\n\n## Ingredients\n- Flour\n",
    );
    const enumFinding = saved.validation.findings.find(
      (f) => f.rule_code === "WM-SCHEMA-ENUM",
    )!;
    expect(enumFinding).toBeDefined();

    // User ignores the enum finding under the old contract (["easy", "medium"])
    const ignoreRes = await handler(
      new Request("http://localhost/api/maintainer/ignore", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ issue_id: enumFinding.issue_id }),
      }),
    );
    expect(ignoreRes.status).toBe(200);

    // Now the schema contract changes its enum definition to ["easy", "medium", "hard"]
    // Because the contract fingerprint for difficulty enum changed, the old ignore does NOT suppress the new contract's finding!
    writeFileSync(
      join(workspaceRoot, "recipes", "recipe.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
        },
        required: ["difficulty"],
      }),
    );

    // Re-read pancakes.md -> should report a new open finding because the contract semantics changed
    const readRes = await handler(
      new Request(
        "http://localhost/api/workspace/file?path=recipes/pancakes.md",
      ),
    );
    const readData = (await readRes.json()) as {
      validation: {
        valid: boolean;
        findings: Array<{ issue_id: string; state: string }>;
      };
    };
    expect(readData.validation.valid).toBe(false);
    const openNow = readData.validation.findings.filter(
      (f) => f.state === "open",
    );
    expect(openNow.length).toBe(1);
    expect(openNow[0]!.issue_id).not.toBe(enumFinding.issue_id);
  });
});
