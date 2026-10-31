import { expect, test } from "@playwright/test";

test("usage dashboard, filters, and advanced pricing", async ({
  page,
}, testInfo) => {
  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "LLM usage" })).toBeVisible();
  await expect(page.getByText("Estimated cost", { exact: true })).toBeVisible();
  const filters = page.getByRole("button", { name: "Usage filters" });
  if (await filters.isVisible()) await filters.click();
  await page
    .getByRole("combobox", { name: "Period", exact: true })
    .selectOption("all");
  await page
    .getByRole("combobox", { name: "Activity", exact: true })
    .selectOption("ingestion");
  await expect(page).toHaveURL(/activity=ingestion/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "LLM usage" })).toBeVisible();
  if (await filters.isVisible()) await filters.click();
  await expect(
    page.getByRole("combobox", { name: "Period", exact: true }),
  ).toHaveValue("all");
  await expect(
    page.getByRole("combobox", { name: "Activity", exact: true }),
  ).toHaveValue("ingestion");
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("usage.png"),
    fullPage: true,
  });
  const navigation = page.getByRole("button", {
    name: "Open workspace navigation",
  });
  if (await navigation.isVisible()) await navigation.click();
  await page
    .getByRole("button", { name: "Configuration", exact: true })
    .click();
  await page.getByText("Advanced · Pricing overrides", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Observed model", exact: true })
    .selectOption("0");
  await page.getByLabel("Free / no API charge", { exact: true }).check();
  await page
    .getByRole("button", { name: "Save override", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Pricing override saved." }),
  ).toBeVisible();
});
