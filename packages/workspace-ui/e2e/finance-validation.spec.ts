import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { mutateRecordFrontmatter } from "../src/client/openui/recordMutator";

const realWorkspace = process.env.WORKSPACE_UI_E2E_MODE === "real";
const executable = process.env.OPENLIA_HLEDGER_BIN ?? "hledger";
const engine = spawnSync(executable, ["--version"], {
  encoding: "utf8",
  timeout: 2000,
});
const engineAvailable =
  engine.status === 0 && /^hledger\b/.test(engine.stdout.trim());
const packageRoot = resolve(import.meta.dirname, "..");
const name = `finance-validation-e2e-${randomUUID()}`;
const root = join(packageRoot, ".e2e-workspace", name);
const journalPath = `${name}/finance/main.journal`;
const includedPath = `${name}/finance/year.journal`;
const balanced =
  "2026-10-01 Opening\n    assets:bank  100 USD\n    equity:opening\n";
const unbalanced =
  "2026-10-01 Wrong\n    assets:bank  100 USD\n    equity:opening  -90 USD\n";

test.describe("snapshot-based finance validation", () => {
  test.skip(!realWorkspace, "Requires WORKSPACE_UI_E2E_MODE=real");
  test.beforeAll(() => {
    mkdirSync(join(root, "finance"), { recursive: true });
    const source = resolve(
      packageRoot,
      "../../features/personal-finance/workspace/finance",
    );
    for (const file of [
      "finance-template.md",
      "finance-template.schema.json",
      "project-manifest.toml",
      "ui.openui",
    ])
      writeFileSync(
        join(root, "finance", file),
        readFileSync(join(source, file)),
      );
    writeFileSync(
      join(root, "finance/ui.openui"),
      readFileSync(join(source, "ui.openui"), "utf8").replaceAll(
        "finance/main.journal",
        journalPath,
      ),
    );
    const template = readFileSync(join(source, "finance-template.md"), "utf8");
    writeFileSync(
      join(root, "finance/review.md"),
      mutateRecordFrontmatter(
        template.replace(/^# .+$/m, "# Validation fixture"),
        { journal_path: journalPath },
      ),
    );
  });
  test.beforeEach(() => {
    writeFileSync(join(root, "finance/main.journal"), "include year.journal\n");
    writeFileSync(join(root, "finance/year.journal"), balanced);
  });
  test.afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("passes, invalidates an edited include, and rechecks failures without writing journals", async ({
    page,
  }) => {
    test.skip(
      !engineAvailable,
      "Native integration requires an installed hledger binary",
    );
    await page.goto(`/projects/${name}/finance`);
    const card = page.getByRole("region", { name: "Journal validation" });
    await expect(card.getByRole("status")).toHaveText("Not checked");
    await card.getByRole("button", { name: "Check journal" }).click();
    await expect(card.getByRole("status")).toHaveText(
      "hledger check passed for this snapshot",
    );
    await expect(card).toContainText(
      "Preview metrics remain non-authoritative",
    );
    expect(readFileSync(join(root, "finance/main.journal"), "utf8")).toBe(
      "include year.journal\n",
    );
    expect(readFileSync(join(root, "finance/year.journal"), "utf8")).toBe(
      balanced,
    );
    writeFileSync(join(root, "finance/year.journal"), unbalanced);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(card.getByRole("status")).toContainText("stale");
    await card.getByRole("button", { name: "Recheck journal" }).click();
    await expect(card.getByRole("status")).toHaveText(
      "hledger check failed for this snapshot",
    );
    await expect(card).toContainText(includedPath);
    expect(readFileSync(join(root, "finance/year.journal"), "utf8")).toBe(
      unbalanced,
    );
    writeFileSync(join(root, "finance/year.journal"), balanced);
    await card.getByRole("button", { name: "Recheck journal" }).click();
    await expect(card.getByRole("status")).toHaveText(
      "hledger check passed for this snapshot",
    );
  });

  test("blocks unsupported includes instead of validating a partial journal", async ({
    page,
  }) => {
    writeFileSync(join(root, "finance/main.journal"), "include *.journal\n");
    await page.goto(`/projects/${name}/finance`);
    const card = page.getByRole("region", { name: "Journal validation" });
    await card.getByRole("button", { name: "Check journal" }).click();
    await expect(card.getByRole("status")).toHaveText("Journal check blocked");
    await expect(card).toContainText(
      "Only literal, relative plain-journal includes are supported",
    );
    expect(readFileSync(join(root, "finance/main.journal"), "utf8")).toBe(
      "include *.journal\n",
    );
  });

  test("reports an unavailable binary distinctly from a failed journal", async ({
    page,
  }) => {
    test.skip(
      engineAvailable,
      "Unavailable-engine case runs when hledger is not installed/configured",
    );
    await page.goto(`/projects/${name}/finance`);
    const card = page.getByRole("region", { name: "Journal validation" });
    await card.getByRole("button", { name: "Check journal" }).click();
    await expect(card.getByRole("status")).toHaveText("hledger is unavailable");
  });
});
