/** Opt-in tests of the actual catalog apps, never a deployed user workspace. */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { FeatureService } from "./features";
import { MinionService } from "./minions";
import { validateOpenUI } from "../shared/openuiAuthoring";

const templates = process.env.OPENLIA_INTEGRATION_TEMPLATES_ROOT;
const personalAppsDeclared =
  templates &&
  ["personal-finance", "personal-health"].some((id) => {
    const manifest = YAML.parse(
      readFileSync(join(templates, "features", id, "feature.yaml"), "utf8"),
    );
    return manifest.domains?.some(
      (domain: { path: string }) => domain.path === `minions/${id}`,
    );
  });

test.skipIf(!personalAppsDeclared)(
  "actual personal apps install empty and support persistent, validated input with triggers off",
  async () => {
    if (!templates)
      throw new Error("Select the integration catalog explicitly");
    if (!Bun.which("hledger"))
      throw new Error(
        "Install native hledger for personal app integration tests",
      );
    const temporary = mkdtempSync(join(tmpdir(), "openlia-personal-apps-"));
    try {
      const workspace = join(temporary, "workspace");
      const features = new FeatureService({
        workspaceRoot: workspace,
        skillsRoot: join(temporary, "skills"),
        featuresRoot: join(templates, "features"),
      });
      const service = new MinionService({ workspaceRoot: workspace });
      for (const id of ["personal-finance", "personal-health"]) {
        const installed = features.install(id);
        expect(installed.minions).toEqual([
          { id, configuration_required: false },
        ]);
        const detail = service.getMinion(id).minion;
        expect(detail.renderable).toBe(true);
        expect(detail.config?.trigger).toEqual({ on_new_entry: false });
        expect(existsSync(join(workspace, `minions/${id}/data`))).toBe(false);
        expect(existsSync(join(temporary, `skills/${id}/SKILL.md`))).toBe(true);
        expect((await service.runMinionHeartbeat(id)).ok).toBe(true);
        expect(existsSync(join(workspace, `minions/${id}/data`))).toBe(false);
      }
      const preview = await service.submitMinionInput("personal-finance", {
        data: {
          date: "2026-10-02",
          description: "Synthetic integration posting",
          amount: "1.01",
          commodity: "USD",
          debit_account: "expenses:test",
          credit_account: "assets:test",
        },
      });
      expect(preview.ok, preview.stderr).toBe(true);
      expect(preview.steps).toHaveLength(1);
      const proposal = JSON.parse(preview.stdout);
      const journal = join(
        workspace,
        "minions/personal-finance/data/journal.hledger",
      );
      expect(existsSync(journal)).toBe(false);
      const confirmed = await service.submitMinionInput("personal-finance", {
        data: {
          action: "confirm",
          proposal_id: proposal.proposal_id,
          confirmation: "POST",
        },
      });
      expect(confirmed.ok, confirmed.stderr).toBe(true);
      expect(readFileSync(journal, "utf8")).toContain("1.01 USD");
      const replay = await service.submitMinionInput("personal-finance", {
        data: {
          action: "confirm",
          proposal_id: proposal.proposal_id,
          confirmation: "POST",
        },
      });
      expect(replay.ok).toBe(false);
      const profile = await service.submitMinionInput("personal-health", {
        data: {
          record_type: "profile",
          person_id: "synthetic-person",
          title: "Synthetic Person",
          relationship_to_user: "self",
        },
      });
      expect(profile.ok, profile.stderr).toBe(true);
      const measurement = await service.submitMinionInput("personal-health", {
        data: {
          record_type: "measurement",
          person_id: "synthetic-person",
          title: "Synthetic value",
          event_date: "2026-10",
          value: "0.10",
          unit: "mg",
        },
      });
      expect(measurement.ok, measurement.stderr).toBe(true);
      expect(measurement.steps).toHaveLength(1);
      const reopened = new MinionService({ workspaceRoot: workspace });
      for (const id of ["personal-finance", "personal-health"]) {
        const detail = reopened.getMinion(id).minion;
        expect(detail.config?.trigger).toEqual({ on_new_entry: false });
        expect(detail.renderable).toBe(true);
        for (const code of Object.values(detail.ui_contents))
          expect(validateOpenUI(code, "openui").valid).toBe(true);
      }
      expect(
        reopened.getMinion("personal-health").minion.ui_contents[
          "dashboard.openui"
        ],
      ).toContain("0.10 mg");
      expect(readFileSync(journal, "utf8").match(/minion-id:/g)).toHaveLength(
        1,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  30_000,
);
