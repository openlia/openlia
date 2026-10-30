import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openUIRecipes } from "../src/shared/openuiRecipes";

interface Entry {
  id: string;
  title: string;
  name: string;
  type: string;
}
const index = JSON.parse(
  readFileSync(
    new URL("../.storybook-static/index.json", import.meta.url),
    "utf8",
  ),
) as { entries: Record<string, Entry> };
for (const story of Object.values(index.entries).filter(
  (entry) => entry.type === "story",
)) {
  test(`${story.title} / ${story.name}`, async ({ page }) => {
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        (url.origin !== "http://127.0.0.1:6007" ||
          /^\/(api|_server)\//.test(url.pathname))
      ) {
        requests.push(url.pathname);
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    await expect(page.locator("[data-story-ready]")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-storybook-finished",
      "true",
    );
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-storybook-blocked-request",
    );
    await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
    if (story.id === "openui-inline-markdown--calendar") {
      const month = page.getByRole("region", { name: "Month calendar" });
      await expect(month).toHaveAttribute("aria-busy", "false");
      const table = month.getByRole("table", { name: "Calendar month dates" });
      await expect(table).toHaveCSS("display", "table");
      await expect(table).toHaveCSS("table-layout", "fixed");

      // Long appointment titles must not change the seven column widths.
      await table
        .getByRole("button")
        .first()
        .evaluate((button) => {
          button.textContent = "A very long appointment title ".repeat(20);
        });
      const widths = await table
        .getByRole("columnheader")
        .evaluateAll((cells) =>
          cells.map((cell) => cell.getBoundingClientRect().width),
        );
      expect(widths).toHaveLength(7);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);

      const layout = await table.evaluate((element) => {
        const wrapper = element.parentElement;
        if (!wrapper) throw new Error("Calendar scroll wrapper is missing");
        return {
          table: element.getBoundingClientRect().width,
          wrapper: wrapper.clientWidth,
          overflow: getComputedStyle(wrapper).overflowX,
        };
      });
      expect(layout.table).toBeGreaterThanOrEqual(560);
      expect(layout.table).toBeGreaterThanOrEqual(layout.wrapper - 1);
      expect(layout.overflow).toBe("auto");
    }
    if (story.id === "openui-inline-markdown--authoring-recipes") {
      await expect(page.getByTestId("inline-openui-block")).toHaveCount(
        openUIRecipes.length,
      );
      await expect(page.getByTestId("inline-openui-error")).toHaveCount(0);
      await expect(
        page.getByRole("alert", { name: "OpenUI render error" }),
      ).toHaveCount(0);
      await expect(page.getByRole("cell", { name: "Phở bò" })).toBeVisible();
      await page.getByRole("tab", { name: "Details", exact: true }).click();
      await expect(
        page.getByText("More information", { exact: true }),
      ).toBeVisible();
    }
  });
}
