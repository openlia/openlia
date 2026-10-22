import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PublicShareResponse,
  ShareDeleteResponse,
  ShareListResponse,
  ShareMutationResponse,
} from "../shared/api";
import { createWorkspaceHandler } from "./app";
import { ShareService } from "./shares";
import { SkillService } from "./skills";
import { WorkspaceService } from "./workspace";

describe("ShareService & public share HTTP endpoints", () => {
  let tempDir = "";
  let workspaceRoot = "";
  let skillsRoot = "";
  let sharesDbPath = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openlia-shares-test-"));
    workspaceRoot = join(tempDir, "workspace");
    skillsRoot = join(tempDir, "skills");
    sharesDbPath = join(tempDir, "shares.sqlite");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(skillsRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  function createService(): ShareService {
    const workspaceService = new WorkspaceService({ workspaceRoot });
    const skillService = new SkillService({ skillsRoot });
    return new ShareService({
      databasePath: sharesDbPath,
      skillService,
      workspaceService,
    });
  }

  test("generates 32-char base64url share id and snapshots workspace documents with recursive .rem and .hledger includes", () => {
    mkdirSync(join(workspaceRoot, "calendar"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "calendar", "reminders.rem"),
      'INCLUDE "holidays.rem"\nINCLUDE "../secret/.env"\nREM 2026-10-25 MSG Main Event\n',
    );
    writeFileSync(
      join(workspaceRoot, "calendar", "holidays.rem"),
      "REM 2026-12-25 MSG Christmas\n",
    );
    mkdirSync(join(workspaceRoot, "secret"), { recursive: true });
    writeFileSync(join(workspaceRoot, "secret", ".env"), "SECRET=123\n");

    const service = createService();

    try {
      const created = service.createShare({
        expires_in: "7d",
        kind: "workspace",
        target_path: "calendar/reminders.rem",
      });

      expect(created.share.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(created.share.kind).toBe("workspace");
      expect(created.share.target_path).toBe("calendar/reminders.rem");
      expect(created.share.expiration_preset).toBe("7d");
      expect(created.share.expires_at).not.toBeNull();
      expect(created.share.status).toBe("up_to_date");
      expect(created.share.file_count).toBe(2); // reminders.rem + holidays.rem (.env excluded)

      const publicView = service.getPublicShare(created.share.id, "127.0.0.1");
      expect(publicView.ok).toBe(true);
      expect(publicView.share.files.map((f) => f.path)).toEqual([
        "calendar/holidays.rem",
        "calendar/reminders.rem",
      ]);
      expect(publicView.share.content).toContain("Main Event");
      expect(
        publicView.share.files.find((f) => f.path === "calendar/holidays.rem")
          ?.content,
      ).toContain("Christmas");
    } finally {
      service.close();
    }
  });

  test("detects up_to_date, stale, and source_missing statuses and updates snapshot in place via syncShare", () => {
    mkdirSync(join(workspaceRoot, "projects"), { recursive: true });
    const docPath = join(workspaceRoot, "projects", "roadmap.md");
    writeFileSync(
      docPath,
      "---\ntitle: Q4 Roadmap\n---\n# Initial Roadmap\nVersion 1\n",
    );

    const service = createService();

    try {
      const created = service.createShare({
        expires_in: "30d",
        kind: "workspace",
        target_path: "projects/roadmap.md",
      });
      expect(created.share.title).toBe("Q4 Roadmap");
      expect(created.share.status).toBe("up_to_date");
      const initialRev = created.share.snapshot_revision;

      // Modify live file on disk -> snapshot stays v1, status becomes stale
      writeFileSync(
        docPath,
        "---\ntitle: Q4 Roadmap Updated\n---\n# Updated Roadmap\nVersion 2\n",
      );

      const listStale = service.listShares({
        kind: "workspace",
        targetPath: "projects/roadmap.md",
      });
      expect(listStale.shares[0]?.status).toBe("stale");
      expect(listStale.shares[0]?.snapshot_revision).toBe(initialRev);
      expect(listStale.shares[0]?.current_revision).not.toBe(initialRev);

      // Public view still serves Version 1 snapshot!
      const beforeSyncPublic = service.getPublicShare(
        created.share.id,
        "127.0.0.1",
      );
      expect(beforeSyncPublic.share.content).toContain("Version 1");

      // Explicit sync updates snapshot in place without changing share id
      const synced = service.syncShare(created.share.id);
      expect(synced.share.id).toBe(created.share.id);
      expect(synced.share.status).toBe("up_to_date");
      expect(synced.share.title).toBe("Q4 Roadmap Updated");
      expect(synced.share.snapshot_revision).not.toBe(initialRev);

      const afterSyncPublic = service.getPublicShare(
        created.share.id,
        "127.0.0.1",
      );
      expect(afterSyncPublic.share.content).toContain("Version 2");

      // Delete live file -> status becomes source_missing, public snapshot still works!
      unlinkSync(docPath);
      const listMissing = service.listShares({
        kind: "workspace",
        targetPath: "projects/roadmap.md",
      });
      expect(listMissing.shares[0]?.status).toBe("source_missing");

      const stillAvailablePublic = service.getPublicShare(
        created.share.id,
        "127.0.0.1",
      );
      expect(stillAvailablePublic.share.content).toContain("Version 2");
    } finally {
      service.close();
    }
  });

  test("snapshots skill packages, computes composite revision, and builds downloadable zip archive from snapshot", () => {
    const skillDir = join(skillsRoot, "productivity", "weekly-review");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: Weekly Review\ndescription: Summarize weekly progress\nversion: 1.2.0\ntags:\n  - review\n  - weekly\n---\n# Weekly Review Skill\nRun `scripts/review.py`.\n",
    );
    writeFileSync(
      join(skillDir, "scripts", "review.py"),
      'print("Weekly review")\n',
    );

    const service = createService();

    try {
      const created = service.createShare({
        expires_in: "never",
        kind: "skill",
        target_path: "productivity/weekly-review",
      });
      const share = created.share;
      expect(share.kind).toBe("skill");
      expect(share.expires_at).toBeNull();
      expect(share.expiration_preset).toBe("never");
      expect(share.status).toBe("up_to_date");
      expect(share.file_count).toBe(2);
      expect(share.skill_metadata?.name).toBe("Weekly Review");
      expect(share.skill_metadata?.version).toBe("1.2.0");

      // Modify a nested script -> skill share becomes stale
      writeFileSync(
        join(skillDir, "scripts", "review.py"),
        'print("Updated weekly review")\n',
      );
      const listed = service.listShares({
        kind: "skill",
        targetPath: "productivity/weekly-review",
      });
      expect(listed.shares[0]?.status).toBe("stale");

      // Download zip from snapshot (still contains original script before sync)
      const { filename, zipBytes } = service.downloadPublicSkillZip(
        share.id,
        "127.0.0.1",
      );
      expect(filename).toBe("weekly-review.zip");
      const zipPath = join(tempDir, filename);
      writeFileSync(zipPath, zipBytes);

      const unzipCheck = spawnSync("unzip", ["-l", zipPath], {
        encoding: "utf8",
      });
      expect(unzipCheck.status).toBe(0);
      expect(unzipCheck.stdout).toContain("weekly-review/SKILL.md");
      expect(unzipCheck.stdout).toContain("weekly-review/scripts/review.py");
    } finally {
      service.close();
    }
  });

  test("prunes expired shares automatically and removes snapshot rows", () => {
    writeFileSync(join(workspaceRoot, "note.md"), "# Temporary Note\n");

    const service = createService();

    try {
      const created = service.createShare({
        expires_in: "1d",
        kind: "workspace",
        target_path: "note.md",
      });
      expect(service.listShares().shares).toHaveLength(1);

      // Advance clock past 1 day in pruneExpired
      const futureMs = Date.now() + 2 * 24 * 60 * 60 * 1000;
      const prunedCount = service.pruneExpired(futureMs);
      expect(prunedCount).toBe(1);
      expect(service.listShares().shares).toHaveLength(0);

      expect(() =>
        service.getPublicShare(created.share.id, "127.0.0.1"),
      ).toThrow();
    } finally {
      service.close();
    }
  });

  test("HTTP endpoints enforce auth on /api/shares, allow unauthenticated /api/public/share/* with X-Robots-Tag, and rate-limit brute-force lookups", async () => {
    writeFileSync(
      join(workspaceRoot, "public-doc.md"),
      "---\ntitle: Shared Architecture\n---\n# Shared Content\n",
    );
    writeFileSync(
      join(workspaceRoot, "diagram.png"),
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    const passwordHash = await Bun.password.hash(
      "correct-horse-battery-staple",
      {
        algorithm: "argon2id",
        memoryCost: 32 * 1024,
        timeCost: 2,
      },
    );
    const handler = createWorkspaceHandler({
      authRequired: true,
      passwordHash,
      sessionDatabasePath: join(tempDir, "sessions.sqlite"),
      sharesDatabasePath: sharesDbPath,
      skillsRoot,
      workspaceRoot,
    });

    // 1. Unauthenticated access to /api/shares is rejected with 401
    const unauthList = await handler(
      new Request("http://localhost/api/shares"),
    );
    expect(unauthList.status).toBe(401);

    // 2. Sign in to obtain session cookie
    const loginRes = await handler(
      new Request("http://localhost/api/auth/login", {
        body: JSON.stringify({ password: "correct-horse-battery-staple" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        method: "POST",
      }),
    );
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("openlia_workspace_session=");

    // 3. Create workspace share while authenticated
    const createRes = await handler(
      new Request("http://localhost/api/shares", {
        body: JSON.stringify({
          expires_in: "7d",
          kind: "workspace",
          target_path: "public-doc.md",
        }),
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "http://localhost",
        },
        method: "POST",
      }),
    );
    expect(createRes.status).toBe(201);
    const createdPayload = (await createRes.json()) as ShareMutationResponse;
    const shareId = createdPayload.share.id;
    expect(shareId).toHaveLength(32);

    // Create binary artifact share
    const createBinRes = await handler(
      new Request("http://localhost/api/shares", {
        body: JSON.stringify({
          expires_in: "1d",
          kind: "workspace",
          target_path: "diagram.png",
        }),
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "http://localhost",
        },
        method: "POST",
      }),
    );
    expect(createBinRes.status).toBe(201);
    const binShareId = ((await createBinRes.json()) as ShareMutationResponse)
      .share.id;

    // 4. Public share lookup works WITHOUT session cookie and sets X-Robots-Tag
    const publicRes = await handler(
      new Request(`http://localhost/api/public/share/${shareId}`),
    );
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    const publicPayload = (await publicRes.json()) as PublicShareResponse;
    expect(publicPayload.share.title).toBe("Shared Architecture");
    expect(publicPayload.share.content).toContain("# Shared Content");

    // Public raw artifact works without cookie and sets X-Robots-Tag
    const publicRawRes = await handler(
      new Request(
        `http://localhost/api/public/share/${binShareId}/raw?path=diagram.png`,
      ),
    );
    expect(publicRawRes.status).toBe(200);
    expect(publicRawRes.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(publicRawRes.headers.get("content-type")).toBe("image/png");

    // 5. Update expiration preset via PATCH /api/shares/<share_id>
    const patchRes = await handler(
      new Request(`http://localhost/api/shares/${shareId}`, {
        body: JSON.stringify({ expires_in: "90d" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "http://localhost",
        },
        method: "PATCH",
      }),
    );
    expect(patchRes.status).toBe(200);
    const patchedPayload = (await patchRes.json()) as ShareMutationResponse;
    expect(patchedPayload.share.expiration_preset).toBe("90d");

    // 6. Revoke share via DELETE /api/shares/<share_id>
    const deleteRes = await handler(
      new Request(`http://localhost/api/shares/${shareId}`, {
        headers: {
          Cookie: cookie,
          Origin: "http://localhost",
        },
        method: "DELETE",
      }),
    );
    expect(deleteRes.status).toBe(200);
    const deletedPayload = (await deleteRes.json()) as ShareDeleteResponse;
    expect(deletedPayload.ok).toBe(true);

    const afterDeletePublicRes = await handler(
      new Request(`http://localhost/api/public/share/${shareId}`),
    );
    expect(afterDeletePublicRes.status).toBe(404);

    // 7. Rate-limiting on repeated failed public share lookups
    let rateLimitedStatus = 0;
    for (let i = 0; i < 35; i++) {
      const res = await handler(
        new Request(`http://localhost/api/public/share/nonexistent_${i}`, {
          headers: { "x-forwarded-for": "203.0.113.99" },
        }),
      );
      if (res.status === 429) {
        rateLimitedStatus = 429;
        break;
      }
    }
    expect(rateLimitedStatus).toBe(429);

    // Verify authenticated list still has only the binary share
    const listRes = await handler(
      new Request("http://localhost/api/shares", {
        headers: { Cookie: cookie },
      }),
    );
    expect(listRes.status).toBe(200);
    const listPayload = (await listRes.json()) as ShareListResponse;
    expect(listPayload.shares.map((s) => s.id)).toEqual([binShareId]);
  });
});
