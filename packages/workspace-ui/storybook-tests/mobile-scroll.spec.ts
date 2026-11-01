import { expect, test, type Page, type Locator } from "@playwright/test";

async function story(page: Page, id: string) {
  await page.goto(`/iframe.html?id=${id}&viewMode=story`);
  await expect(page.locator("html")).toHaveAttribute(
    "data-storybook-finished",
    "true",
  );
}

async function reachEnd(
  page: Page,
  owner: Locator,
  end: Locator,
  edgeOnly = false,
) {
  await owner.hover();
  // Mobile WebKit does not expose wheel input through Playwright.
  if (test.info().project.use.isMobile)
    await owner.evaluate((element) => element.scrollBy(0, 1200));
  else await page.mouse.wheel(0, 1200);
  await expect
    .poll(() => owner.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await owner.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  if (edgeOnly) {
    const bounds = await end.boundingBox();
    const bottom = (bounds?.y ?? 0) + (bounds?.height ?? 0);
    expect(bottom).toBeGreaterThan(80);
    expect(bottom).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);
  } else await expect(end).toBeInViewport({ ratio: 1 });
  const header = await page.locator(".workspace-header").boundingBox();
  expect(header?.y).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 640 },
  { width: 844, height: 390 },
  { width: 390, height: 360 },
]) {
  test(`whole-page scrolling at ${size.width}×${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await story(
      page,
      "documents-reading-and-editing--long-document-with-warnings",
    );
    const document = page.getByRole("region", { name: "Document workspace" });
    expect((await document.boundingBox())?.height).toBeGreaterThan(
      size.height - 80,
    );
    await page.getByText("Template & Schema Warning", { exact: true }).click();
    await expect(
      page.getByText("Validation issue 12: review the required field."),
    ).toBeVisible();
    await reachEnd(
      page,
      document,
      page.getByRole("heading", { name: "End of document", exact: true }),
    );

    await story(page, "skills-library--long-instructions");
    const skill = page.getByRole("region", { name: "Skill workspace" });
    await reachEnd(
      page,
      skill,
      page.getByRole("heading", { name: "End of instructions", exact: true }),
    );

    await story(page, "ingestion-documents--long-inspector");
    const inspector = page.locator(".ingestion-inspector");
    await reachEnd(
      page,
      inspector,
      page.getByText(/End of extracted content/),
      true,
    );
    await inspector.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByRole("button", { name: "Original", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Original document preview" }),
    ).toBeVisible();
    await expect(page.locator(".ingestion-tab-content")).not.toBeVisible();
    await page.getByRole("button", { name: "OCR text", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Original document preview" }),
    ).not.toBeVisible();
    await reachEnd(
      page,
      inspector,
      page.getByText(/End of extracted content/),
      true,
    );
  });

  test(`minion controls scroll away at ${size.width}×${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await story(page, "workspace-features--minions");
    await expect(page.getByTestId("minion-openui-dashboard")).toBeVisible();
    const owner = page.getByRole("region", { name: "Minion workspace" });
    expect((await owner.boundingBox())?.height).toBeGreaterThan(
      size.height - 80,
    );
    await page.getByText("Runtime & triggers", { exact: true }).click();
    await owner.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByTestId("minion-openui-dashboard")).toBeInViewport({
      ratio: 1,
    });
    await expect(
      page.getByRole("button", { name: "Browse minions" }),
    ).not.toBeInViewport();
    expect((await page.locator(".workspace-header").boundingBox())?.y).toBe(0);
  });
}

test("filter sheets do not take height from the document library", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await story(page, "ingestion-documents--library");
  const owner = page.locator(".ingestion-workspace");
  const before = await owner.boundingBox();
  await page.getByRole("button", { name: "Toggle document filters" }).click();
  const sheet = page.getByRole("dialog", { name: "Document filters" });
  await expect(sheet).toBeVisible();
  expect((await owner.boundingBox())?.height).toBe(before?.height);
  await sheet
    .getByRole("textbox", { name: "Search documents", exact: true })
    .fill("invoice");
  await sheet
    .getByRole("button", { name: "Show results", exact: true })
    .click();
  await expect(sheet).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Toggle document filters" }),
  ).toBeFocused();
});

test("the app and file drawer follow the keyboard viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 640 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
  });
  await story(page, "compositions-workspace--mobile-workspace");
  await page.getByRole("button", { name: "Open files drawer" }).click();
  await page.getByRole("searchbox", { name: "Find files" }).focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error("Missing test viewport");
    Object.assign(viewport, { height: 340 });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      page
        .locator(".workspace-app")
        .evaluate((element) => element.clientHeight),
    )
    .toBe(340);
  const drawer = page.getByRole("dialog", { name: "Workspace files" });
  expect((await drawer.boundingBox())?.height).toBe(340);
  await expect(
    page.getByRole("searchbox", { name: "Find files" }),
  ).toBeInViewport({ ratio: 1 });
  await drawer.getByRole("button", { name: "notes.md", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = await page.locator(".cm-scroller").boundingBox();
  expect((editor?.y ?? 0) + (editor?.height ?? 0)).toBeLessThanOrEqual(341);
  expect(editor?.height).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Open files drawer" }).click();
  await page
    .getByRole("dialog", { name: "Workspace files" })
    .getByRole("button", { name: "+ New File", exact: true })
    .click();
  const form = await page
    .getByRole("dialog", { name: "Create New File" })
    .boundingBox();
  expect(form?.y).toBeGreaterThanOrEqual(0);
  expect((form?.y ?? 0) + (form?.height ?? 0)).toBeLessThanOrEqual(340);
});

test("chat keeps space for messages with a multiline composer on short screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 360 });
  await story(page, "chat-conversation--full-conversation");
  await page
    .getByRole("button", { name: "Open conversations", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Getting started with Lia/ })
    .click();
  await page
    .getByRole("textbox", { name: "Message Lia" })
    .fill("A multiline draft\n".repeat(12));
  const messages = await page
    .getByRole("region", { name: "Conversation messages" })
    .boundingBox();
  expect(messages?.height).toBeGreaterThan(80);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeInViewport({ ratio: 1 });
});
