import { expect, test, type Page } from "@playwright/test";

async function story(page: Page, id: string) {
  await page.goto(`/iframe.html?id=${id}&viewMode=story`);
  await expect(page.locator("html")).toHaveAttribute(
    "data-storybook-finished",
    "true",
  );
  await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
}

for (const width of [320, 390, 430, 768]) {
  test(`workspace navigation and documents at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await story(page, "compositions-workspace--mobile-workspace");
    const navigation = page.getByRole("button", {
      name: "Open workspace navigation",
    });
    await expect(navigation).toBeVisible();
    const header = await page.locator(".workspace-header").boundingBox();
    expect(header?.height).toBeLessThan(68);
    await expect(
      page.getByRole("navigation", { name: "Workspace navigation" }),
    ).not.toBeVisible();

    await navigation.click();
    const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    const close = drawer.getByRole("button", {
      name: "Close Workspace navigation",
    });
    await expect(close).toBeFocused();
    await close.press("Shift+Tab");
    await expect(
      drawer.getByRole("button", { name: "Configuration", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expect(navigation).toBeFocused();

    await page.getByRole("button", { name: "Open files drawer" }).click();
    const files = page.getByRole("dialog", { name: "Workspace files" });
    await expect(files).toBeVisible();
    await files.getByRole("button", { name: "notes.md", exact: true }).click();
    await expect(files).not.toBeVisible();
    await expect(
      page.getByRole("article", { name: "Markdown preview" }),
    ).toBeVisible();

    const actions = page.getByRole("button", {
      name: "Document actions",
      exact: true,
    });
    await actions.click();
    const menu = page.getByRole("group", { name: "Document actions" });
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(844);
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(actions).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    if (width < 640) {
      const targets = await page
        .locator(".workspace-document-toolbar button:visible")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getBoundingClientRect().height),
        );
      expect(targets.every((height) => height >= 44)).toBe(true);
    }
  });
}

test("skills use a section selector and a file picker on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await story(page, "skills-library--details");
  await page
    .getByRole("combobox", { name: "Skill section" })
    .selectOption("files");
  await expect(
    page.getByRole("combobox", { name: "Skill file" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Skill actions" }).click();
  await expect(
    page.getByRole("group", { name: "Skill actions" }),
  ).toBeVisible();
  await page.mouse.click(5, 500);
  await expect(
    page.getByRole("group", { name: "Skill actions" }),
  ).not.toBeVisible();
});

test("minions keep selectors and secondary actions out of the content area", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await story(page, "workspace-features--minions");
  await expect(
    page.getByRole("combobox", { name: "Minion section" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Minion actions" }).click();
  await expect(
    page.getByRole("button", { name: "Schedule Heartbeat", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Browse minions" }).click();
  await expect(page.getByRole("dialog", { name: "Minions" })).toBeVisible();
  await page.keyboard.press("Escape");
  const outside = await page
    .locator("button:visible, input:visible, select:visible")
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.top < innerHeight &&
            bounds.bottom > 0 &&
            (bounds.left < -1 || bounds.right > innerWidth + 1)
          );
        })
        .map(
          (element) =>
            element.getAttribute("aria-label") ?? element.textContent,
        ),
    );
  expect(outside).toEqual([]);
});

test("desktop keeps workspace navigation and the file sidebar visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await story(page, "compositions-workspace--local-workspace");
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open workspace navigation" }),
  ).not.toBeVisible();
  await expect(
    page.getByLabel("Workspace files", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1440,
  );
});

test("mobile drawers release the background before opening a creation dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await story(page, "compositions-workspace--mobile-workspace");
  await page.getByRole("button", { name: "Open files drawer" }).click();
  const files = page.getByRole("dialog", { name: "Workspace files" });
  await files.getByRole("button", { name: "+ New File", exact: true }).click();
  await expect(files).not.toBeVisible();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((element) => Boolean(element.closest("[inert]"))),
  ).toBe(false);
});

test("ingestion scope and filters remain usable without a scrolling tab strip", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await story(page, "ingestion-documents--filters");
  await page
    .getByRole("combobox", { name: "Document library view" })
    .selectOption("processing");
  const filters = page.getByRole("button", { name: "Toggle document filters" });
  await filters.click();
  await page
    .getByRole("textbox", { name: "Search documents", exact: true })
    .fill("invoice");
  await filters.click();
  await expect(
    page.getByRole("textbox", { name: "Search documents", exact: true }),
  ).not.toBeVisible();
  await filters.click();
  await expect(
    page.getByRole("textbox", { name: "Search documents", exact: true }),
  ).toHaveValue("invoice");
  await page
    .getByRole("button", { name: "Ingestion tools", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Passwords" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
});

test("usage filters collapse on phones but stay visible on desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await story(page, "workspace-features--usage");
  await expect(
    page.getByRole("combobox", { name: "Period", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Usage filters" }).click();
  await expect(
    page.getByRole("combobox", { name: "Period", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(
    page.getByRole("combobox", { name: "Period", exact: true }),
  ).toBeVisible();
});
