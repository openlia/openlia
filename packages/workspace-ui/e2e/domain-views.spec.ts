import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Response } from "@playwright/test";
import { mutateRecordFrontmatter } from "../src/client/openui/recordMutator";

const realWorkspace = process.env.WORKSPACE_UI_E2E_MODE === "real";
const packageRoot = resolve(import.meta.dirname, "..");
const fixtureName = `openui-domain-e2e-${randomUUID()}`;
const fixtureRoot = join(packageRoot, ".e2e-workspace", fixtureName);
const domains = [
  { feature: "travel", domain: "travel", stem: "trip", title: "Travel" },
  { feature: "shopping", domain: "shopping", stem: "item", title: "Shopping" },
  {
    feature: "monitors",
    domain: "monitors",
    stem: "monitor",
    title: "Monitors",
  },
  { feature: "people", domain: "people", stem: "person", title: "People" },
  {
    feature: "decision-analysis",
    domain: "decisions",
    stem: "decision",
    title: "Decisions",
  },
  {
    feature: "personal-finance",
    domain: "finance",
    stem: "finance",
    title: "Finance",
  },
];

function isFileSave(response: Response) {
  const request = response.request();
  return (
    (request.method() === "PUT" &&
      response.url().includes("/api/workspace/file")) ||
    (response.url().includes("/_serverFn/") &&
      Boolean(request.postData()?.includes("/api/workspace/file")) &&
      Boolean(request.postData()?.includes('"s":"PUT"')))
  );
}

test.describe("specialized domain views with real file persistence", () => {
  test.skip(!realWorkspace, "Requires WORKSPACE_UI_E2E_MODE=real");
  test.beforeAll(() => {
    mkdirSync(fixtureRoot, { recursive: true });
    for (const { feature, domain, stem } of domains) {
      const source = resolve(
        packageRoot,
        "../../features",
        feature,
        "workspace",
        domain,
      );
      const destination = join(fixtureRoot, domain);
      cpSync(source, destination, { recursive: true });
      const template = readFileSync(
        join(destination, `${stem}-template.md`),
        "utf8",
      );
      const content = mutateRecordFrontmatter(
        template.replace(/^# .+$/m, `# E2E ${domain}`),
        domain === "finance"
          ? { journal_path: `${fixtureName}/finance/journal.hledger` }
          : {},
      );
      writeFileSync(join(destination, "fixture.md"), content);
      if (domain === "finance") {
        const dashboard = join(destination, "ui.openui");
        writeFileSync(
          dashboard,
          readFileSync(dashboard, "utf8").replaceAll(
            "finance/main.journal",
            `${fixtureName}/finance/journal.hledger`,
          ),
        );
        writeFileSync(
          join(destination, "journal.hledger"),
          "2026-10-01 Opening\n    assets:bank  100 USD\n    equity:opening\n",
        );
      }
    }
  });
  test.afterAll(() => {
    // Only the uniquely named directory owned by this test run is removed.
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  for (const { domain, title } of domains) {
    test(`${domain} mini-project and record markdown preview render`, async ({
      page,
    }) => {
      await page.goto(`/projects/${fixtureName}/${domain}`);
      await expect(
        page.getByRole("heading", { name: title }).first(),
      ).toBeVisible();
      await expect(page.getByText(/OpenUI Render Error/)).toHaveCount(0);
      await page.goto(`/files/${fixtureName}/${domain}/fixture.md`);
      await expect(
        page.getByRole("heading", { name: `E2E ${domain}`, exact: true }),
      ).toBeVisible();
    });
  }

  test("layout editor gives live schema diagnostics", async ({ page }) => {
    const layout = `${fixtureName}/travel/ui.openui`;
    await page.goto(`/files/${layout}?view=edit`);
    const editor = page.getByRole("textbox", { name: "Code editor" });
    await expect(page.getByLabel("OpenUI diagnostics")).toContainText(
      "OpenUI layout is valid.",
    );
    await editor.fill('root = UnknownWidget("unsupported")');
    await expect(page.getByLabel("OpenUI diagnostics")).toContainText(
      "OpenUI layout diagnostics",
    );
    await editor.fill('root = DomainHeader("Travel")');
    await expect(page.getByLabel("OpenUI diagnostics")).toContainText(
      "OpenUI layout is valid.",
    );
  });
});
