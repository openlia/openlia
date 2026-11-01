import { expect, test, type Page, type Locator } from "@playwright/test";

async function selectSection(page: Page, section: "input" | "config") {
  const select = page.getByRole("combobox", { name: "Minion section" });
  if (await select.isVisible()) await select.selectOption(section);
  else await page.getByTestId(`minion-tab-${section}`).click();
}

async function scrollToLastMode(
  page: Page,
  toolbar: Locator,
  last: Locator,
  allowFits = false,
) {
  expect(
    await toolbar.evaluate((element) => getComputedStyle(element).overflowX),
  ).toBe("auto");
  if (
    allowFits &&
    (await toolbar.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ))
  ) {
    await expect(
      toolbar.locator("..").getByText("Scroll for more modes", { exact: true }),
    ).toHaveCount(0);
    return;
  }
  await expect
    .poll(() =>
      toolbar.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeGreaterThan(0);
  await expect(
    toolbar.locator("..").getByText("Scroll for more modes", { exact: true }),
  ).toBeVisible();
  await toolbar.scrollIntoViewIfNeeded();
  if (!test.info().project.use.isMobile) {
    await toolbar.hover();
    await page.mouse.wheel(900, 0);
  } else {
    await toolbar.getByRole("button").first().focus();
    await page.keyboard.press("End");
  }
  await expect
    .poll(() => toolbar.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await last.scrollIntoViewIfNeeded();
  const control = await last.boundingBox();
  const viewport = await toolbar.boundingBox();
  expect(control?.x).toBeGreaterThanOrEqual((viewport?.x ?? 0) - 1);
  expect((control?.x ?? 0) + (control?.width ?? 0)).toBeLessThanOrEqual(
    (viewport?.x ?? 0) + (viewport?.width ?? 0) + 1,
  );
  expect(
    await toolbar.evaluate(
      (element) => element.scrollHeight <= element.clientHeight + 1,
    ),
  ).toBe(true);
}

for (const width of [320, 390, 1440]) {
  test(`input and config mode rows scroll independently at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      "/iframe.html?id=workspace-features--minions&viewMode=story",
    );
    await expect(page.getByTestId("minion-openui-dashboard")).toBeVisible();
    if (width === 1440)
      await page.locator(".minion-workspace").evaluate((element) => {
        element.style.width = "390px";
      });
    await selectSection(page, "input");
    const inputModes = page.getByRole("toolbar", {
      name: "Input editor modes",
    });
    const schema = inputModes.getByRole("button", {
      name: "Edit input.schema.json",
      exact: true,
    });
    await scrollToLastMode(page, inputModes, schema);
    await schema.click();
    await expect(schema).toHaveAttribute("aria-pressed", "true");
    const inputSave = page.getByRole("button", {
      name: "Save input.schema.json",
      exact: true,
    });
    await inputSave.scrollIntoViewIfNeeded();
    await expect(inputSave).toBeInViewport({ ratio: 1 });
    expect(
      await inputSave.evaluate(
        (element) => element.closest('[role="toolbar"]') === null,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);

    await selectSection(page, "config");
    const configModes = page.getByRole("toolbar", {
      name: "Config editor modes",
    });
    const configSchema = configModes.getByRole("button", {
      name: "Edit config.schema.json (Packaged Schema)",
      exact: true,
    });
    await scrollToLastMode(page, configModes, configSchema, true);
    await configSchema.click();
    await expect(configSchema).toHaveAttribute("aria-pressed", "true");
    const configSave = page.getByTestId("minion-save-config");
    await expect(configSave).toHaveAccessibleName("Save config.schema.json");
    await configSave.scrollIntoViewIfNeeded();
    await expect(configSave).toBeInViewport({ ratio: 1 });
    expect(
      await configSave.evaluate(
        (element) => element.closest('[role="toolbar"]') === null,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  });
}

test("mode rows stay inline without a scroll cue when all buttons fit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/iframe.html?id=workspace-features--minions&viewMode=story");
  await expect(page.getByTestId("minion-openui-dashboard")).toBeVisible();
  await selectSection(page, "input");
  const toolbar = page.getByRole("toolbar", { name: "Input editor modes" });
  expect(
    await toolbar.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await expect(
    toolbar.locator("..").getByText("Scroll for more modes", { exact: true }),
  ).toHaveCount(0);
});

test("keyboard navigation reveals and activates clipped modes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto(
    "/iframe.html?id=foundations-controls--scrolling-modes&viewMode=story",
  );
  const toolbar = page.getByRole("toolbar", { name: "Example editor modes" });
  const first = toolbar.getByRole("button", {
    name: "Form Preview",
    exact: true,
  });
  const last = toolbar.getByRole("button", {
    name: "Edit input.schema.json",
    exact: true,
  });
  await first.focus();
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await expect
    .poll(() => toolbar.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await expect(last).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await expect
    .poll(() => toolbar.evaluate((element) => element.scrollLeft))
    .toBe(0);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
});
