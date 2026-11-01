import { expect, test } from "@playwright/test";

const realWorkspace = process.env.WORKSPACE_UI_E2E_MODE === "real";

test.describe("workspace navigation", () => {
  test.skip(realWorkspace, "Navigation test uses the mock workspace fixture");

  test("switches tabs without reloading the workspace", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "The desktop navigator keeps the document button visible",
    );

    async function expectNotesVisible() {
      const filesButton = page.getByRole("button", {
        exact: true,
        name: "Open files drawer",
      });
      if (await filesButton.isVisible()) {
        await expect(filesButton).toBeVisible();
        await filesButton.click();
      }
      await expect(
        page.getByRole("button", { exact: true, name: "notes.md" }),
      ).toBeVisible();
    }

    let documentRequests = 0;
    page.on("request", (request) => {
      if (request.resourceType() === "document") documentRequests += 1;
    });

    await page.goto("/");
    await expectNotesVisible();

    await page.getByRole("button", { exact: true, name: "Skills" }).click();
    await expect(page).toHaveURL(/\/skills$/);
    await expect(
      page.getByRole("heading", { exact: true, name: "Skills" }),
    ).toBeVisible();
    await expect(
      page.getByText("Loading workspace...", { exact: true }),
    ).not.toBeVisible();

    await page.getByRole("button", { exact: true, name: "Documents" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expectNotesVisible();
    expect(documentRequests).toBe(1);
  });
});
