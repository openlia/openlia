/// <reference lib="dom" />

import { expect, type Locator, type Page, test } from "@playwright/test";

const realWorkspace = process.env.WORKSPACE_UI_E2E_MODE === "real";

async function expectScrollable(container: Locator) {
  await expect
    .poll(() =>
      container.evaluate((element) => {
        element.scrollTop = 0;
        element.scrollTop = 120;
        return element.clientHeight > 0 && element.scrollTop > 0;
      }),
    )
    .toBe(true);
}

async function pasteContent(editor: Locator, content: string) {
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, content);
}

async function expectBoundedWorkspace(page: Page) {
  const metrics = await page.evaluate(() => {
    const layout = document.querySelector<HTMLElement>(".workspace-layout");
    if (!layout) throw new Error("Workspace layout was not found");
    return {
      bodyClientHeight: document.documentElement.clientHeight,
      bodyScrollHeight: document.documentElement.scrollHeight,
      layoutClientHeight: layout.clientHeight,
      layoutScrollHeight: layout.scrollHeight,
    };
  });
  expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(
    metrics.bodyClientHeight + 1,
  );
  expect(metrics.layoutScrollHeight).toBeLessThanOrEqual(
    metrics.layoutClientHeight + 1,
  );
}

test.describe("workspace pane scrolling", () => {
  test.skip(realWorkspace, "Scroll catalog uses the mock workspace fixture");

  test("keeps the skills navigator scrollable", async ({ page }, testInfo) => {
    await page.setViewportSize({
      height: 400,
      width: testInfo.project.name === "desktop" ? 1440 : 390,
    });
    await page.goto("/skills");
    if (testInfo.project.name === "mobile") {
      await page.getByRole("button", { name: "Open skills drawer" }).click();
    }
    const navigator = page.getByRole("complementary", {
      name: "Skills navigator",
    });
    await expect(
      navigator.getByText("apple-notes", { exact: true }),
    ).toBeVisible();
    await expectScrollable(navigator.locator("div.overflow-y-auto"));
    await expectBoundedWorkspace(page);
  });

  test("keeps skill instructions, files and overview scrollable", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      height: testInfo.project.name === "desktop" ? 400 : 700,
      width: testInfo.project.name === "desktop" ? 1440 : 390,
    });
    await page.goto("/skills/deep-research");
    await expect(
      page.getByRole("article", { name: "Markdown preview" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Code editor" });
    await pasteContent(
      editor,
      Array.from({ length: 100 }, (_, index) => `Paragraph ${index + 1}.`).join(
        "\n\n",
      ),
    );
    await expectScrollable(page.locator(".cm-scroller"));
    await expectBoundedWorkspace(page);

    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = page
      .getByRole("article", { name: "Markdown preview" })
      .locator("..");
    await expectScrollable(preview);
    await expectBoundedWorkspace(page);

    if (testInfo.project.name === "desktop") {
      const navigator = page
        .getByRole("complementary", { name: "Skills navigator" })
        .locator("div.overflow-y-auto");
      await expectScrollable(navigator);
      const navigatorTop = await navigator.evaluate(
        (element) => element.scrollTop,
      );
      await preview.evaluate((element) => {
        element.scrollTop += 120;
      });
      expect(await navigator.evaluate((element) => element.scrollTop)).toBe(
        navigatorTop,
      );
    }

    await page.getByRole("button", { name: "Revert", exact: true }).click();
    await page.getByRole("button", { name: "Overview & Details" }).click();
    const overview = page.locator("div.overflow-y-auto").filter({
      has: page.getByRole("heading", { name: "Usage & Telemetry" }),
    });
    await expectScrollable(overview);
    await expectBoundedWorkspace(page);

    await page.getByRole("button", { name: "Files (2)", exact: true }).click();
    await page.getByRole("button", { name: /templates\/report.md/ }).click();
    await pasteContent(
      editor,
      Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`).join("\n"),
    );
    await expectScrollable(page.locator(".cm-scroller"));
    await expectBoundedWorkspace(page);

    await page.setViewportSize({
      height: testInfo.project.name === "desktop" ? 320 : 500,
      width: testInfo.project.name === "desktop" ? 1440 : 390,
    });
    await expectScrollable(
      page.locator("div.overflow-y-auto").filter({ hasText: "Skill Files" }),
    );
    await expectBoundedWorkspace(page);
  });

  test("keeps the file tree and document content independently scrollable", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "Independent pane sizing is covered at the desktop breakpoint",
    );

    await page.setViewportSize({ height: 400, width: 1440 });
    await page.goto("/files/calendar/reminders.rem?view=edit");
    await expect(
      page.getByRole("textbox", { name: "Code editor" }),
    ).toBeVisible();

    for (const directory of ["finance", "projects", "tasks"]) {
      await page.getByRole("button", { exact: true, name: directory }).click();
    }

    const metrics = await page.evaluate(() => {
      const layout = document.querySelector<HTMLElement>(".workspace-layout");
      const navigator = document.querySelector<HTMLElement>(
        ".workspace-navigator > div.overflow-auto",
      );
      const editor = document.querySelector<HTMLElement>(
        ".workspace-codemirror .cm-scroller",
      );

      if (!layout || !navigator || !editor) {
        throw new Error("Workspace scroll containers were not found");
      }

      return {
        bodyClientHeight: document.documentElement.clientHeight,
        bodyScrollHeight: document.documentElement.scrollHeight,
        editorClientHeight: editor.clientHeight,
        editorScrollHeight: editor.scrollHeight,
        layoutClientHeight: layout.clientHeight,
        layoutScrollHeight: layout.scrollHeight,
        navigatorClientHeight: navigator.clientHeight,
        navigatorScrollHeight: navigator.scrollHeight,
      };
    });

    expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(
      metrics.bodyClientHeight + 1,
    );
    expect(metrics.layoutScrollHeight).toBeLessThanOrEqual(
      metrics.layoutClientHeight + 1,
    );
    expect(metrics.navigatorScrollHeight).toBeGreaterThan(
      metrics.navigatorClientHeight,
    );
    expect(metrics.editorScrollHeight).toBeGreaterThan(
      metrics.editorClientHeight,
    );

    const scrollPositions = await page.evaluate(() => {
      const navigator = document.querySelector<HTMLElement>(
        ".workspace-navigator > div.overflow-auto",
      );
      const editor = document.querySelector<HTMLElement>(
        ".workspace-codemirror .cm-scroller",
      );

      if (!navigator || !editor) {
        throw new Error("Workspace scroll containers were not found");
      }

      navigator.scrollTop = 120;
      const navigatorTop = navigator.scrollTop;
      editor.scrollTop = 120;

      return {
        editorTop: editor.scrollTop,
        navigatorTop,
        navigatorTopAfterEditorScroll: navigator.scrollTop,
      };
    });

    expect(scrollPositions.navigatorTop).toBeGreaterThan(0);
    expect(scrollPositions.editorTop).toBeGreaterThan(0);
    expect(scrollPositions.navigatorTopAfterEditorScroll).toBe(
      scrollPositions.navigatorTop,
    );
  });
});
