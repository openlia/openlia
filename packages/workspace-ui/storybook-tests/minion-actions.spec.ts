import { expect, test, type Page } from "@playwright/test";

async function openMinion(page: Page) {
  await page.goto("/iframe.html?id=workspace-features--minions&viewMode=story");
  await expect(page.getByTestId("minion-openui-dashboard")).toBeVisible();
}

for (const width of [320, 390, 430]) {
  test(`minion actions share the title row in a ${width}px panel`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 640 });
    await openMinion(page);
    const row = page.locator(".minion-title-row");
    const trigger = row.getByRole("button", {
      name: "Minion actions",
      exact: true,
    });
    await expect(
      row.getByRole("button", { name: "Run Heartbeat", exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: "Ask Lia", exact: true }),
    ).toHaveCount(0);
    const titleBounds = await row.getByRole("heading").boundingBox();
    const triggerBounds = await trigger.boundingBox();
    const rowBounds = await row.boundingBox();
    expect(
      Math.abs(
        (titleBounds?.y ?? 0) +
          (titleBounds?.height ?? 0) / 2 -
          (triggerBounds?.y ?? 0) -
          (triggerBounds?.height ?? 0) / 2,
      ),
    ).toBeLessThan(2);
    expect((triggerBounds?.x ?? 0) + (triggerBounds?.width ?? 0)).toBeCloseTo(
      (rowBounds?.x ?? 0) + (rowBounds?.width ?? 0),
      0,
    );
    expect(triggerBounds?.height).toBeGreaterThanOrEqual(44);
    await trigger.click();
    const menu = page.getByRole("group", {
      name: "Minion actions",
      exact: true,
    });
    for (const name of [
      "Run Heartbeat",
      "Ask Lia",
      "Schedule Heartbeat",
      "Install Deps",
      "Run Tests",
      "Open in Documents",
    ]) {
      await expect(
        menu.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    await menu
      .getByRole("button", { name: "Run Heartbeat", exact: true })
      .click();
    await expect(menu).not.toBeVisible();
    await expect(page.getByTestId("minion-execution-log")).toContainText(
      "[HEARTBEAT]",
    );
  });
}

for (const width of [844, 1440]) {
  test(`wide actions respond to panel width in a ${width}px window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 1000 });
    await openMinion(page);
    const row = page.locator(".minion-title-row");
    const heartbeat = row.getByRole("button", {
      name: "Run Heartbeat",
      exact: true,
    });
    const ask = row.getByRole("button", { name: "Ask Lia", exact: true });
    await expect(heartbeat).toBeVisible();
    await expect(ask).toBeVisible();
    await row.getByRole("button", { name: "Minion actions" }).click();
    const menu = page.getByRole("group", {
      name: "Minion actions",
      exact: true,
    });
    await expect(
      menu.getByRole("button", { name: "Run Heartbeat", exact: true }),
    ).toHaveCount(0);
    await expect(
      menu.getByRole("button", { name: "Ask Lia", exact: true }),
    ).toHaveCount(0);
    await expect(
      menu.getByRole("button", { name: "Schedule Heartbeat", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".minion-workspace").evaluate((element) => {
      element.style.width = "480px";
    });
    await expect(heartbeat).toHaveCount(0);
    await expect(ask).toHaveCount(0);
    expect(await page.evaluate(() => innerWidth)).toBe(width);
    await row.getByRole("heading").evaluate((element) => {
      element.textContent =
        "A very long minion name that should truncate without displacing actions";
    });
    expect(
      await row.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await row.getByRole("button", { name: "Minion actions" }).click();
    await expect(
      menu.getByRole("button", { name: "Run Heartbeat", exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("button", { name: "Ask Lia", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".minion-workspace").evaluate((element) => {
      element.style.removeProperty("width");
    });
    await expect(heartbeat).toBeVisible();
    await expect(ask).toBeVisible();
  });
}

for (const width of [320, 390, 1440]) {
  test(`multiline quick entry grows to eight rows and keeps its action below at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 640 });
    await openMinion(page);
    const input = page.getByRole("textbox", {
      name: "Quick input",
      exact: true,
    });
    await expect(input).toHaveAttribute("rows", "3");
    const initialHeight = await input.evaluate(
      (element) => element.clientHeight,
    );
    await input.fill("First line\nSecond line\nThird line\nFourth line");
    await expect
      .poll(() => input.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(initialHeight);
    const text = Array.from(
      { length: 25 },
      (_, i) => `Pasted line ${i + 1}`,
    ).join("\n");
    await input.fill(text);
    const layout = await input.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      max: parseFloat(getComputedStyle(element).maxHeight),
      content: element.scrollHeight,
      client: element.clientHeight,
    }));
    await expect
      .poll(() =>
        input.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBeGreaterThanOrEqual(layout.max - 1);
    expect(layout.height).toBeLessThanOrEqual(layout.max + 1);
    expect(layout.content).toBeGreaterThan(layout.client);
    await input.press("Enter");
    await expect(input).toHaveValue(`${text}\n`);
    await expect(page.getByTestId("minion-execution-log")).toHaveCount(0);
    const submit = page.getByTestId("minion-run-button");
    await expect(submit).toHaveText("Quick Add");
    await submit.scrollIntoViewIfNeeded();
    const buttonBounds = await submit.boundingBox();
    const inputBounds = await input.boundingBox();
    expect(buttonBounds?.y).toBeGreaterThanOrEqual(
      (inputBounds?.y ?? 0) + (inputBounds?.height ?? 0),
    );
    expect((buttonBounds?.x ?? 0) + (buttonBounds?.width ?? 0)).toBeCloseTo(
      (inputBounds?.x ?? 0) + (inputBounds?.width ?? 0),
      0,
    );
    await submit.click();
    await expect(page.getByTestId("minion-execution-log")).toContainText(
      "Added entry",
    );
    await expect(input).toHaveValue("");
    await expect
      .poll(() => input.evaluate((element) => element.clientHeight))
      .toBe(initialHeight);
    if (width === 1440) {
      await input.fill("Word ".repeat(60));
      await page.locator(".minion-workspace").evaluate((element) => {
        element.style.width = "320px";
      });
      await expect
        .poll(() => input.evaluate((element) => element.clientHeight))
        .toBeGreaterThan(initialHeight);
      await page.locator(".minion-workspace").evaluate((element) => {
        element.style.removeProperty("width");
      });
      await expect
        .poll(() => input.evaluate((element) => element.clientHeight))
        .toBe(initialHeight);
    }
  });
}

test("Ctrl/Cmd+Enter submits the textarea draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await openMinion(page);
  const input = page.getByRole("textbox", { name: "Quick input", exact: true });
  for (const shortcut of ["Control+Enter", "Meta+Enter"]) {
    await input.fill(`First paragraph\n\nSecond paragraph (${shortcut})`);
    await input.press(shortcut);
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("minion-execution-log")).toContainText(
      "Added entry",
    );
  }
});
