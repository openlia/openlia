import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshot";

async function openFinance(page: Page) {
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page
    .getByRole("complementary", { name: "Mini-projects list" })
    .getByRole("button", { name: /Personal Finance/ })
    .click();
  await expect(
    page.getByRole("region", { name: "Finance workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New account", exact: true }),
  ).toBeEnabled();
}

test.describe("native Finance project", () => {
  test.skip(
    process.env.WORKSPACE_UI_E2E_MODE !== "real",
    "Requires the real workspace backend and native hledger",
  );

  test("navigates, inspects without saving, creates and reopens a mapping without changing journals", async ({
    page,
  }, testInfo) => {
    const title = `Bank B UI ${crypto.randomUUID()}`;
    const journalPaths = [
      "finance/main.journal",
      "finance/payslips-company-A.hledger",
      "finance/bank-B.hledger",
    ];
    const originals = await Promise.all(
      journalPaths.map(async (path) => {
        const response = await page.request.get(
          `/api/workspace/file?${new URLSearchParams({ path })}`,
        );
        expect(response.ok()).toBe(true);
        return response.text();
      }),
    );
    await page.goto("/");
    await expect(
      page.getByRole("navigation", { name: "Workspace navigation" }),
    ).toBeVisible();
    await openFinance(page);
    const finance = page.getByRole("region", { name: "Finance workspace" });
    await finance.getByLabel("From month").fill("2026-09");
    await finance.getByLabel("Through month").fill("2026-10");
    await finance.getByRole("button", { name: "Apply report scope" }).click();
    await expect(
      finance.getByText(/Validated native hledger reports/),
    ).toBeVisible();
    await finance.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect(
      finance.getByRole("region", { name: "Finance overview" }),
    ).toContainText("2000.5");
    const incomeChart = finance.getByRole("img", {
      name: /Income and expenses/,
    });
    const paints = () =>
      incomeChart.locator("svg *").evaluateAll((elements) =>
        elements.flatMap((element) => {
          const style = getComputedStyle(element);
          return [style.fill, style.stroke];
        }),
      );
    await expect.poll(paints).toContain("rgb(52, 211, 153)");
    await expect.poll(paints).toContain("rgb(251, 146, 60)");
    await captureScreenshot(page, testInfo, "finance-overview");
    await finance.getByRole("tab", { name: "Flows", exact: true }).click();
    await expect(
      finance.getByRole("img", { name: /Accounting posting flows/ }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "finance-posting-flows");
    await finance.getByRole("tab", { name: "Spending", exact: true }).click();
    await expect(
      finance.getByRole("img", { name: /Spending by account/ }),
    ).toHaveCount(2);
    await finance.getByRole("tab", { name: "Trends", exact: true }).click();
    await expect(
      finance.getByRole("img", { name: /Net asset\/liability balances/ }),
    ).toBeVisible();
    await finance.getByRole("tab", { name: "Accounts", exact: true }).click();
    const writes: string[] = [];
    page.on("request", (request) => {
      const body = request.postData() ?? "";
      if (
        request.method() === "POST" &&
        body.includes("requestId") &&
        !body.includes("/accounts/validate")
      )
        writes.push(body);
    });
    await finance
      .getByRole("button", { name: "New account", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "New account mapping" });
    await expect(
      dialog.getByLabel("ledger account (schema-required key)"),
    ).toBeVisible();
    await expect(dialog.getByLabel("Ledger scope / main journal")).toHaveValue(
      "finance/main.journal",
    );
    await dialog.getByText("Inspect installed template and schema").click();
    await expect(dialog.locator("pre")).toContainText('"ledger_account"');
    await expect(dialog.getByText(/Does not create a journal/)).toBeVisible();
    await captureScreenshot(page, testInfo, "finance-unsaved-account-contract");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(writes).toHaveLength(0);
    await finance
      .getByRole("button", { name: "New account", exact: true })
      .click();
    await dialog.getByLabel("Display name").fill(title);
    await dialog
      .getByLabel("ledger account (schema-required key)")
      .fill("assets:bank:B");
    await dialog
      .getByLabel("account type (schema-required key)")
      .selectOption({ label: "bank" });
    await dialog
      .getByLabel("institution label (schema-required key)")
      .fill("Bank B (synthetic)");
    await dialog.getByLabel("currencies (schema-required key)").fill("USD");
    await dialog
      .getByRole("button", { name: "Validate draft (no save)", exact: true })
      .click();
    await expect(dialog.getByText(/Current draft conforms/)).toBeVisible();
    expect(writes).toHaveLength(0);
    await dialog
      .getByRole("button", { name: "Save account mapping", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toHaveLength(1);
    const row = finance.getByRole("row").filter({ hasText: title });
    await expect(row).toContainText("Linked — used in journal");
    await expect(row).toContainText("1860.4 USD");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "New account", exact: true }),
    ).toBeEnabled();
    await finance.getByRole("tab", { name: "Accounts", exact: true }).click();
    await finance.getByRole("button", { name: title, exact: true }).click();
    const preview = page.getByRole("article", { name: "Markdown preview" });
    await expect(preview).toContainText(title);
    await expect(preview).toContainText("assets:bank:B");
    await expect(preview).toContainText("Bank B (synthetic)");
    await expect(preview).toContainText("Mapping");
    await captureScreenshot(page, testInfo, "finance-reopened-account");
    // Supplemental integrity checks; UI assertions above establish the actual workflow.
    for (const [index, path] of journalPaths.entries()) {
      const response = await page.request.get(
        `/api/workspace/file?${new URLSearchParams({ path })}`,
      );
      expect(await response.text()).toBe(originals[index]);
    }
  });

  test("allows a future journal path without creating the file or an opening posting", async ({
    page,
  }) => {
    const title = `Future account ${crypto.randomUUID()}`;
    const journal = `finance/future-${crypto.randomUUID()}.journal`;
    await page.goto("/projects/finance");
    await expect(
      page.getByRole("button", { name: "New account", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "New account", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "New account mapping" });
    await dialog.getByLabel("Display name").fill(title);
    await dialog
      .getByLabel("ledger account (schema-required key)")
      .fill("assets:planned");
    await dialog.getByLabel("Ledger scope / main journal").fill(journal);
    await dialog
      .getByRole("button", { name: "Save account mapping", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("tab", { name: "Accounts", exact: true }).click();
    await expect(
      page.getByRole("row").filter({ hasText: title }),
    ).toContainText("Unverified");
    const response = await page.request.get(
      `/api/workspace/file?${new URLSearchParams({ path: journal })}`,
    );
    expect(response.status()).toBe(404);
  });
});
