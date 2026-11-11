import { expect, type Locator, type Page, test } from "@playwright/test";
import { captureScreenshot } from "./screenshot";

const realWorkspace = process.env.WORKSPACE_UI_E2E_MODE === "real";

async function visibleLocator(locator: Locator): Promise<Locator> {
  return locator.locator("visible=true").first();
}

async function switchWorkspaceTab(page: Page, tabName: string): Promise<void> {
  const navMenuBtn = page.getByRole("button", {
    exact: true,
    name: "Open workspace navigation",
  });
  if (await navMenuBtn.isVisible()) {
    await navMenuBtn.click();
  }
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { exact: true, name: tabName })
    .click();
}

async function openFilesContainer(page: Page): Promise<Locator> {
  const filesButton = page.getByRole("button", {
    exact: true,
    name: "Open files drawer",
  });
  if (await filesButton.isVisible()) {
    await filesButton.click();
    const dialog = page.getByRole("dialog", { name: "Workspace files" });
    await expect(dialog).toBeVisible();
    return dialog;
  }
  return page.getByLabel("Workspace files").first();
}

async function openSkillsDrawerIfNeeded(page: Page): Promise<void> {
  const skillsButton = page.getByRole("button", {
    exact: true,
    name: "Open skills drawer",
  });
  if (await skillsButton.isVisible()) {
    await skillsButton.click();
  }
}

test.describe("feature catalog and installation", () => {
  test("signs in, installs personal-finance and personal-health sequentially, preserves state across reload, and verifies installed artifacts", async ({
    page,
  }, testInfo) => {
    // 1. Sign in (when auth gate is active) and open the catalog
    await page.goto(realWorkspace ? "/" : "/?scenario=auth");

    const passwordInput = page.getByLabel("Password");
    await expect(
      passwordInput.or(page.locator(".workspace-header")),
    ).toBeVisible();
    if (await passwordInput.isVisible()) {
      await passwordInput.fill(
        process.env.OPENLIA_WORKSPACE_UI_PASSWORD ??
          "local-playwright-password",
      );
      await page.getByRole("button", { name: "Sign in" }).click();
    }

    await expect(page.locator(".workspace-header")).toBeVisible();
    await switchWorkspaceTab(page, "Catalog");
    await expect(page).toHaveURL(/\/catalog$/);
    await expect(page.getByTestId("catalog-page")).toBeVisible();

    // Verify catalog features and their requirements/distinctions are displayed
    const financeCard = page.getByTestId(
      "catalog-feature-card-personal-finance",
    );
    const healthCard = page.getByTestId("catalog-feature-card-personal-health");

    await expect(financeCard).toBeVisible();
    await expect(healthCard).toBeVisible();

    await expect(
      page.getByTestId("catalog-package-kind-personal-finance"),
    ).toHaveText("Workspace Domains & Skills Package");
    await expect(
      page.getByTestId("catalog-package-kind-personal-health"),
    ).toHaveText("Workspace Domains & Skills Package");

    // Verify declared hledger requirement on personal-finance
    await expect(
      page.getByTestId("catalog-required-tool-personal-finance-hledger"),
    ).toContainText("hledger");

    await captureScreenshot(page, testInfo, "catalog-initial-browse");

    // 2. Install personal-finance and personal-health sequentially
    for (const featureId of ["personal-finance", "personal-health"]) {
      const statusBadge = page.getByTestId(
        `catalog-feature-status-${featureId}`,
      );
      const currentStatus = (await statusBadge.textContent())?.trim();
      if (currentStatus !== "Installed") {
        await page.getByTestId(`catalog-install-${featureId}`).click();
        await expect(page.getByTestId("catalog-install-result")).toBeVisible();
        await expect(
          page.getByTestId(`catalog-install-result-${featureId}`),
        ).toBeVisible();
      }
      await expect(statusBadge).toHaveText("Installed");
      await captureScreenshot(page, testInfo, `catalog-installed-${featureId}`);
    }

    // 3. Reload and verify each feature remains installed
    await page.reload();
    await expect(page.getByTestId("catalog-page")).toBeVisible();
    for (const featureId of ["personal-finance", "personal-health"]) {
      await expect(
        page.getByTestId(`catalog-feature-status-${featureId}`),
      ).toHaveText("Installed");
    }
    await captureScreenshot(page, testInfo, "catalog-after-reload");

    // 4a. Verify installed workspace domains in Documents tab
    await switchWorkspaceTab(page, "Documents");
    const filesContainer = await openFilesContainer(page);
    for (const domainPath of ["finance", "health"]) {
      await expect(
        filesContainer.getByTestId(`workspace-directory-${domainPath}`),
      ).toBeVisible();
    }
    await captureScreenshot(page, testInfo, "catalog-verified-domains");

    // Close mobile files drawer if open before switching tabs
    const closeFilesDrawer = page
      .getByRole("dialog", { name: "Workspace files" })
      .getByRole("button", { name: "Close" });
    if (await closeFilesDrawer.isVisible()) {
      await closeFilesDrawer.click();
    }

    // 4b. Verify personal-finance and personal-health skills in Skills tab
    await switchWorkspaceTab(page, "Skills");
    await expect(page).toHaveURL(/\/skills/);
    await openSkillsDrawerIfNeeded(page);
    await expect(
      await visibleLocator(page.getByTestId("skill-item-personal-finance")),
    ).toBeVisible();
    await expect(
      await visibleLocator(page.getByTestId("skill-item-personal-health")),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "catalog-verified-skills");
  });
});
