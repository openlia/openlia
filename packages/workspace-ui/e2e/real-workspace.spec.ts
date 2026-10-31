import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot } from "./screenshot";

const realWorkspace = process.env.WORKSPACE_UI_E2E_MODE === "real";

async function openFiles(page: Page) {
  await expect(page.locator(".workspace-header")).toBeVisible();
  const filesButton = page.getByRole("button", {
    exact: true,
    name: "Open files drawer",
  });
  if (await filesButton.isVisible()) {
    await filesButton.click();
    await expect(
      page
        .getByRole("dialog", { name: "Workspace files" })
        .getByRole("heading", { exact: true, name: "Files" })
        .first(),
    ).toBeVisible();
  }
}

test.describe("copied workspace visual verification", () => {
  test.skip(
    !realWorkspace,
    "Real workspace suite requires WORKSPACE_UI_E2E_MODE=real",
  );

  test("shows the copied workspace", async ({ page }, testInfo) => {
    await page.goto("/");
    await openFiles(page);
    await expect(
      page.getByRole("button", { name: "README.md", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: ".gitkeep", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "event-note-template.md", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("archive, empty folder")).toBeVisible();
    await captureScreenshot(page, testInfo, "copied-workspace");
  });

  test("filters and opens a copied workspace document", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await openFiles(page);
    await page.getByLabel("Find files").fill("calendar");
    const event = page.getByRole("button", {
      name: "2026-09-23-lunch-marukame-fe-dev-2.md",
      exact: true,
    });
    await expect(event).toBeVisible();
    await event.click();
    await expect(
      page.getByRole("article", { name: "Markdown preview" }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "copied-calendar-document");
  });

  test("does not expose starter templates through search", async ({ page }) => {
    await page.goto("/");
    await openFiles(page);
    await page.getByLabel("Find files").fill("template");
    await expect(page.getByText(/No files match/)).toBeVisible();
  });
});
