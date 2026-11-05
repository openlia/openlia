/** Opt-in installation/query tests against an explicitly selected catalog. */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeatureService } from "./features";
import { MinionViewService } from "./minion-views";
import { MinionService } from "./minions";
import { WorkspaceService } from "./workspace";

const templates = process.env.OPENLIA_INTEGRATION_TEMPLATES_ROOT;
const appIds = [
  "calendar",
  "gym-tracker",
  "personal-finance",
  "personal-health",
];
// Automatic CI deliberately uses the production catalog pin, not an unmerged
// companion PR. If ANY app declares views, run the full suite so a missing or
// broken declaration in another app cannot silently downgrade acceptance.
const catalogDeclaresViews = Boolean(
  templates &&
    appIds.some((id) =>
      existsSync(
        join(
          templates,
          "features",
          id,
          "workspace/minions",
          id,
          "data.views.json",
        ),
      ),
    ),
);

test.skipIf(!templates || catalogDeclaresViews)(
  "legacy catalog remains installable without implicitly exposing Minion data",
  async () => {
    if (!templates) throw new Error("Choose a catalog explicitly");
    const root = mkdtempSync(join(tmpdir(), "legacy-data-views-catalog-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const features = new FeatureService({
        workspaceRoot,
        skillsRoot: join(root, "skills"),
        featuresRoot: join(templates, "features"),
      });
      for (const id of appIds) features.install(id);
      const service = new MinionViewService(
        new WorkspaceService({
          workspaceRoot,
          maintainerDatabasePath: ":memory:",
        }),
      );
      const before = readdirSync(root, { recursive: true }).map(String).sort();
      const discovered = service.list();
      expect(discovered.status).toBe("ok");
      for (const app of discovered.minions)
        expect(app.status).toBe("unavailable");
      await expect(
        service.query({
          id: "gym-tracker",
          view: "sessions",
          from: "2026-10-01",
          to: "2026-10-08",
        }),
      ).rejects.toThrow();
      expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(
        before,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!templates || !catalogDeclaresViews)(
  "catalog installs preserve state and all apps expose valid opt-in views",
  async () => {
    if (!templates) throw new Error("Choose a catalog explicitly");
    const root = mkdtempSync(join(tmpdir(), "data-views-catalog-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const features = new FeatureService({
        workspaceRoot,
        skillsRoot: join(root, "skills"),
        featuresRoot: join(templates, "features"),
      });
      for (const id of [
        "calendar",
        "gym-tracker",
        "personal-finance",
        "personal-health",
      ]) {
        features.install(id);
        expect(existsSync(join(workspaceRoot, `minions/${id}/data`))).toBe(
          false,
        );
      }
      const service = new MinionViewService(
        new WorkspaceService({ workspaceRoot }),
      );
      const apps = new MinionService({ workspaceRoot });
      for (const id of [
        "calendar",
        "gym-tracker",
        "personal-finance",
        "personal-health",
      ]) {
        const info = service.describe(id);
        expect(apps.getMinion(id).minion.renderable).toBe(true);
        expect(info.views).toHaveLength(1);
        expect(info.views[0]?.briefing_enabled).toBe(false);
      }
      const app = join(workspaceRoot, "minions/gym-tracker");
      mkdirSync(join(app, "data"));
      writeFileSync(
        join(app, "data/items.json"),
        JSON.stringify([
          {
            item: "Synthetic session",
            date: "2026-10-02",
            status: "completed",
            notes: "PRIVATE",
          },
        ]),
      );
      const query = {
        id: "gym-tracker",
        view: "sessions",
        from: "2026-10-01",
        to: "2026-10-08",
      };
      const result = await service.query(query);
      expect(result.records[0]?.title).toBe("Synthetic session");
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      await expect(
        service.query({ ...query, purpose: "briefing" }),
      ).rejects.toThrow("not enabled");
      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"));
      config.data_views = { briefing: ["sessions"], scopes: {} };
      writeFileSync(join(app, "config.json"), JSON.stringify(config));
      expect(
        (await service.query({ ...query, purpose: "briefing" })).records,
      ).toEqual(result.records);
      const beforeCli = readdirSync(root, { recursive: true })
        .map(String)
        .sort();
      const cli = Bun.spawn([process.execPath, "scripts/minion-views.ts"], {
        env: { ...process.env, OPENLIA_WORKSPACE_ROOT: workspaceRoot },
        stdin: new Blob([JSON.stringify({ action: "query", query })]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const cliResult = JSON.parse(await new Response(cli.stdout).text());
      expect(await cli.exited).toBe(0);
      expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(
        beforeCli,
      );
      expect(cliResult.records).toEqual(result.records);
      expect(cliResult.revision).toBe((await service.query(query)).revision);
      expect(
        readFileSync(
          join(workspaceRoot, "minions/calendar/dashboard.openui"),
          "utf8",
        ),
      ).toContain('source: "data/reminders.rem"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
