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
        const dashboard = join(destination, "finance-dashboard.openui");
        writeFileSync(
          dashboard,
          readFileSync(dashboard, "utf8").replaceAll(
            "finance/journal.hledger",
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
    test(`${domain} dashboard and record render`, async ({ page }) => {
      await page.goto(`/files/${fixtureName}/${domain}`);
      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/OpenUI Render Error/)).toHaveCount(0);
      if (["travel", "shopping", "monitors", "people"].includes(domain)) {
        await expect(
          page.getByRole("region", { name: `${domain} overview` }),
        ).toBeVisible();
      } else if (domain === "finance") {
        await expect(
          page.getByRole("region", { name: "Finance overview" }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByText("under-review", { exact: true }),
        ).toBeVisible();
      }
      await page.goto(`/files/${fixtureName}/${domain}/fixture.md?view=visual`);
      await expect(
        page.getByRole("heading", { name: `E2E ${domain}`, exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/OpenUI Render Error/)).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Save Properties" }),
      ).toBeVisible();
    });
  }

  test("packing and schedule edits use PUT and survive reload", async ({
    page,
  }) => {
    await page.goto(`/files/${fixtureName}/travel/fixture.md?view=visual`);
    const checkbox = page.getByRole("checkbox", { name: /Travel documents/ });
    const savedPacking = page.waitForResponse(isFileSave);
    // The controlled checkbox reflects the persisted value after the async save.
    await checkbox.click();
    expect((await savedPacking).ok()).toBe(true);
    await expect(checkbox).toBeChecked();
    await page.reload();
    await expect(checkbox).toBeChecked();
    await page.getByRole("button", { name: "Edit Daily itinerary" }).click();
    await page
      .getByLabel("Itinerary Outline")
      .fill("- 2026-11-01 09:00: Flight to Tokyo");
    const savedSchedule = page.waitForResponse(isFileSave);
    await page.getByRole("button", { name: "Save section" }).click();
    expect((await savedSchedule).ok()).toBe(true);
    await page.reload();
    await expect(
      page.getByText("2026-11-01 09:00: Flight to Tokyo", { exact: true }),
    ).toBeVisible();
    await expect(checkbox).toBeChecked();
  });

  test("layout editor gives live schema diagnostics and broken layouts retain a fallback", async ({
    page,
  }) => {
    const layout = `${fixtureName}/travel/trip-record.openui`;
    await page.goto(`/files/${layout}?view=edit`);
    const editor = page.getByRole("textbox", { name: "Code editor" });
    await expect(page.getByLabel("OpenUI diagnostics")).toContainText(
      "OpenUI layout is valid.",
    );
    await editor.fill('root = DomainCollection("unsupported")');
    await expect(page.getByLabel("OpenUI diagnostics")).toContainText(
      "OpenUI layout diagnostics",
    );
    await editor.fill('root = RecordProfile("travel")');
    await expect(page.getByLabel("OpenUI diagnostics")).toContainText(
      "OpenUI layout is valid.",
    );
    // Simulate a broken externally edited layout, then exercise recovery in-browser.
    writeFileSync(
      join(fixtureRoot, "travel/trip-record.openui"),
      "root = UnknownDomainWidget()",
    );
    await page.goto(`/files/${fixtureName}/travel/fixture.md?view=visual`);
    await expect(page.getByText(/OpenUI Render Error/)).toBeVisible();
    await page
      .getByRole("button", { name: /default|fallback/i })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "E2E travel", exact: true }),
    ).toBeVisible();
  });
});
