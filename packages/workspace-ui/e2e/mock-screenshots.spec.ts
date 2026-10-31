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

async function openNotes(page: Page) {
  await openFiles(page);
  await page.getByRole("button", { exact: true, name: "notes.md" }).click();
}

test.describe("mock visual catalog", () => {
  test.skip(realWorkspace, "Mock catalog is not used in real-workspace mode");

  test("workspace overview", async ({ page }, testInfo) => {
    await page.goto("/");
    if (testInfo.project.name === "mobile")
      await expect(
        page.getByRole("button", { exact: true, name: "Open files drawer" }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("button", { exact: true, name: "notes.md" }),
      ).toBeVisible();
    await captureScreenshot(page, testInfo, "workspace-overview");
  });

  test("SSR applies a nonce to inline scripts", async ({ page }) => {
    const response = await page.goto("/");
    expect(response).not.toBeNull();
    const csp = response?.headers()["content-security-policy"] ?? "";
    const nonce = csp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    const html = await response?.text();
    expect(html).toContain(`nonce="${nonce}"`);
  });

  test("mobile files drawer", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "Drawer is a mobile interaction",
    );
    await page.goto("/");
    await openFiles(page);
    await expect(
      page.getByRole("dialog", { name: "Workspace files" }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "mobile-files-drawer");
  });

  test("selected document", async ({ page }, testInfo) => {
    await page.goto("/");
    await openNotes(page);
    await expect(
      page.getByRole("article", { name: "Markdown preview" }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "selected-document");
  });

  test("persists route path and params on browser reload", async ({ page }) => {
    await page.goto("/files/notes.md?view=preview&filter=cal");
    await expect(
      page.getByRole("article", { name: "Markdown preview" }),
    ).toBeVisible();
    await expect(page.getByLabel("Find files")).toHaveValue("cal");
    await page.reload();
    await expect(
      page.getByRole("article", { name: "Markdown preview" }),
    ).toBeVisible();
    await expect(page.getByLabel("Find files")).toHaveValue("cal");
  });

  test("edited draft and revision context", async ({ page }, testInfo) => {
    await page.goto("/");
    await openNotes(page);
    await page.getByRole("button", { name: "Edit" }).click();
    const editor = page.getByRole("textbox", { name: "Code editor" });
    await editor.fill("Hello\nThis is a screenshot verification draft.");
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
    await captureScreenshot(page, testInfo, "edited-draft");
  });

  test("filtered tree", async ({ page }, testInfo) => {
    await page.goto("/");
    await openFiles(page);
    await page.getByLabel("Find files").fill("calendar");
    await expect(
      page.getByRole("button", { name: "event.md", exact: true }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "filtered-tree");
  });

  test("empty search result", async ({ page }, testInfo) => {
    await page.goto("/");
    await openFiles(page);
    await page.getByLabel("Find files").fill("does-not-exist");
    await expect(page.getByText(/No files match/)).toBeVisible();
    await captureScreenshot(page, testInfo, "empty-search-result");
  });

  test("authentication gate", async ({ page }, testInfo) => {
    await page.goto("/?scenario=auth");
    await expect(page.getByLabel("Password")).toBeVisible();
    await captureScreenshot(page, testInfo, "authentication-gate");
  });

  test("authenticated workspace", async ({ page }, testInfo) => {
    await page.goto("/?scenario=auth");
    await page.getByLabel("Password").fill("local-playwright-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    if (testInfo.project.name === "mobile")
      await expect(
        page.getByRole("button", { exact: true, name: "Open files drawer" }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("button", { exact: true, name: "notes.md" }),
      ).toBeVisible();
    await captureScreenshot(page, testInfo, "authenticated-workspace");
  });

  test("revision conflict", async ({ page }, testInfo) => {
    await page.goto("/?scenario=conflict");
    await openNotes(page);
    await page.getByRole("button", { name: "Edit" }).click();
    await page
      .getByRole("textbox", { name: "Code editor" })
      .fill("A conflicting draft");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "This file changed after you opened it.",
    );
    await captureScreenshot(page, testInfo, "revision-conflict");
  });

  test("loading state", async ({ page }, testInfo) => {
    await page.goto("/?scenario=loading");
    await expect(
      page.getByText("Loading workspace...", { exact: true }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "loading");
  });

  test("empty workspace", async ({ page }, testInfo) => {
    await page.goto("/?scenario=empty");
    await openFiles(page);
    await expect(page.getByText("No documents yet")).toBeVisible();
    await captureScreenshot(page, testInfo, "empty-workspace");
  });

  test("load error", async ({ page }, testInfo) => {
    await page.goto("/?scenario=error");
    await expect(page.getByRole("alert")).toContainText(
      "Workspace data could not be loaded.",
    );
    await captureScreenshot(page, testInfo, "load-error");
  });

  test("skills catalog overview", async ({ page }, testInfo) => {
    await page.goto("/skills");
    if (testInfo.project.name === "mobile") {
      await page
        .getByRole("button", { exact: true, name: "Open skills drawer" })
        .click();
    }
    await expect(page.getByText(/Skills \(/)).toBeVisible();
    await captureScreenshot(page, testInfo, "skills-overview");
  });

  test("skills selected instruction", async ({ page }, testInfo) => {
    await page.goto("/skills/productivity/notion");
    await expect(
      page.getByRole("heading", { exact: true, level: 1, name: "notion" }),
    ).toBeVisible();
    await expect(
      page.getByRole("article", { name: "Markdown preview" }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "skills-selected-instruction");
  });

  test("frontmatter structured block", async ({ page }, testInfo) => {
    await page.goto("/skills/productivity/notion");
    await expect(page.getByText("NOTION_API_KEY")).toBeVisible();
    await captureScreenshot(page, testInfo, "frontmatter-structured-block");
  });

  test("skills overview subtab", async ({ page }, testInfo) => {
    await page.goto("/skills/productivity/notion");
    if (testInfo.project.name === "mobile")
      await page
        .getByRole("combobox", { name: "Skill section" })
        .selectOption("overview");
    else await page.getByRole("button", { name: "Overview & Details" }).click();
    await expect(
      page.getByRole("heading", { name: "Prerequisites" }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "skills-overview-subtab");
  });

  test("skills auxiliary files subtab", async ({ page }, testInfo) => {
    await page.goto("/skills/deep-research");
    if (testInfo.project.name === "mobile") {
      await page
        .getByRole("combobox", { name: "Skill section" })
        .selectOption("files");
      const files = page.getByRole("combobox", { name: "Skill file" });
      await files.selectOption("templates/report.md");
      await expect(files).toHaveValue("templates/report.md");
    } else {
      await page.getByRole("button", { name: /Files \(/ }).click();
      await expect(
        page.getByRole("button", { name: /templates\/report\.md/ }),
      ).toBeVisible();
    }
    await captureScreenshot(page, testInfo, "skills-auxiliary-files");
  });

  test("skills create modal", async ({ page }, testInfo) => {
    await page.goto("/skills");
    await page
      .getByRole("button", { exact: true, name: "Create New Skill" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Create New Skill" }),
    ).toBeVisible();
    await page
      .getByPlaceholder("e.g. invoice-parser")
      .fill("meeting-summarizer");
    await captureScreenshot(page, testInfo, "skills-create-modal");
  });

  test("journal preview and sankey diagram", async ({ page }, testInfo) => {
    await page.goto("/files/finance/journal.hledger");
    await expect(page.getByText("Money Flow (Sankey Diagram)")).toBeVisible();
    await expect(page.getByText("TOTAL INCOME")).toBeVisible();
    await captureScreenshot(page, testInfo, "journal-sankey-preview");

    // Scroll to timeline and capture timeline view
    const timelineHeading = page.getByRole("button", {
      name: /📅 August 2026/i,
    });
    await expect(timelineHeading).toBeVisible();
    await timelineHeading.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "journal-timeline-view");
  });
});
